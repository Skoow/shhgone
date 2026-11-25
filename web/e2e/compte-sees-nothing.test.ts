// « Le serveur ne voit rien », compte par passkey (conception 2026-11-22-compte-passkey-design.md
// §14) — CE TEST BLOQUE TOUTE MISE EN LIGNE, et toute activation de SHH_COMPTES=1.
// Vrai binaire Go (SHH_COMPTES=1, origine http://localhost:<port>), authentificateur logiciel
// (e2e/webauthn.ts : ES256 avec PRF, EdDSA sans PRF), calculs de l'appareil faits comme le site
// les fera (moteur WebAssembly : clé de récupération, HKDF des clés et des AD ; WebCrypto :
// enveloppes AES-256-GCM, coffres de src/account/vaults.ts, libellés de src/account/device.ts).
// Le module de compte du site (W1) n'est pas encore adapté : ce test joue l'appareil lui-même,
// sans écran.
//   A : inscription (pseudo vérifié et réservé), connexion par la passkey (enveloppe PRF
//       rouverte), coffre privé rempli de liens repères, deuxième passkey sans PRF, nouvel
//       appareil par la clé de récupération (saisie en minuscules), nouvelle clé, salon créé avec
//       la session, export, tableau de bord.
//   B : inscription puis suppression du compte.
// On fouille ensuite, en octets bruts, base64url/base64 et hex : le dossier de données, stdout et
// stderr, chaque requête et chaque réponse (site et tableau de bord), la mémoire du processus.
// Chaque fouille a son témoin (un repère qu'on sait présent, retrouvé).
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { b64u, unb64u, utf8 } from "../src/engine/pure";
import { loadEngine, type Wasm } from "../src/engine/load";
import { loadSalonEngine } from "../src/salon/engine";
import { scellerEtiquette } from "../src/account/device";
import { sansSortiePrf } from "../src/account/webauthn";
import { priveEnJson, priveVide, profilEnJson, REGLAGES_DEFAUT, sceller } from "../src/account/vaults";
import { solveAltcha } from "./altcha";
import { ClientSalon } from "./salon-client";
import { capturingFetch, findIn, listFiles, needle, scanDir, scanProcessMemory, type Captured, type Needle } from "./scan";
import { startServer, type TestServer } from "./server";
import { Authentificateur, type Passkey } from "./webauthn";

type Bytes = Uint8Array<ArrayBuffer>;
const ADMIN = "JetonAdminRepere_" + randomBytes(32).toString("base64url");
const PSEUDO_A = "LeaRepereQx7"; // tel qu'affiché ; seul p_canon part
const PSEUDO_B = "BobRepereVw2";
const PHOTO_MARQUE = "PhotoRepereHt5wQ";
const ETIQ_PK_A = "iPhoneRepereKz4";
const ETIQ_PK_A2 = "YubiKeyRepereTq8";
const ETIQ_APPAREIL = "AppareilRepereWm3";
const LIEN_RECU = new Uint8Array(randomBytes(32)) as Bytes;
const INVITATION = new Uint8Array(randomBytes(32)) as Bytes;
const alea = (n: number) => new Uint8Array(randomBytes(n)) as Bytes;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const octets = (label: string, b: Uint8Array) => needle(label, b as Bytes);

async function cleAes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** Enveloppe de K_compte : nonce (12) ‖ AES-256-GCM(kek, nonce, K_compte, ad) = 60 octets. */
async function envelopper(kek: Uint8Array, ad: Uint8Array, k: Uint8Array): Promise<Bytes> {
  const iv = alea(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad as Bytes }, await cleAes(kek), k as Bytes));
  const out = new Uint8Array(60) as Bytes;
  out.set(iv);
  out.set(ct, 12);
  return out;
}
async function ouvrirEnv(kek: Uint8Array, ad: Uint8Array, env: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: env.slice(0, 12), additionalData: ad as Bytes }, await cleAes(kek), env.slice(12))) as Bytes;
}

describe("le serveur ne voit rien : compte par passkey", () => {
  let srv: TestServer;
  let web: string; // origine WebAuthn (rp.id localhost)
  let W: Wasm;
  const log: Captured[] = [];
  const logAdmin: Captured[] = [];
  const marked = capturingFetch(log);
  const json = async (method: string, path: string, body?: unknown, session?: string) => {
    const r = await marked(`${srv.origin}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(session ? { "X-Shh-Session": session } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    return { status: r.status, corps: (t ? JSON.parse(t) : {}) as Record<string, any> };
  };
  const admin = (method: "GET" | "POST", path: string, body?: unknown) =>
    capturingFetch(logAdmin)(`${srv.adminOrigin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ADMIN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  // Ce que l'appareil a tiré ou calculé (jamais envoyé, sauf A_r à recup et v_r à inscription/fin).
  type Compte = {
    pseudo: string;
    pCanon: string;
    h: Bytes;
    kCompte: Bytes;
    r: Bytes;
    aR: Bytes;
    kekR: Bytes;
    auth: Authentificateur;
    pk: Passkey;
    sorties: Bytes[];
    kekPrf: Bytes[];
    session: string;
  };
  let A: Compte, B: Compte;
  let r2: Bytes, aR2: Bytes;
  let authA2: Authentificateur;
  let pkA2: Passkey;
  let photo: Bytes;
  const jetons: string[] = [];
  const etat: Record<string, any> = {};
  let ligneB: { credId: Bytes; cose: Bytes; vR: Bytes };

  async function preuve() {
    const r = await marked(`${srv.origin}/api/captcha`);
    const recu = Date.now();
    const { shown_at, ...defi } = (await r.json()) as Record<string, unknown>;
    const p = await solveAltcha(defi);
    await dormir(Math.max(0, recu + 3100 - Date.now()));
    if (p.kind !== "pow") throw new Error("preuve inattendue");
    return { altcha: p.payload, hp: "", shown_at: shown_at as string };
  }

  async function inscrire(pseudo: string, pCanon: string, photoProfil: Uint8Array | null): Promise<Compte> {
    const d = await json("POST", "/api/compte/inscription/debut", await preuve());
    expect(d.status).toBe(200);
    const { etape, options } = d.corps;
    expect(options.user.name).toBe("");
    expect(options.rp.id).toBe("localhost");
    expect((await json("POST", "/api/compte/pseudo/verifier", { etape, p_canon: pCanon })).corps).toEqual({ libre: true });
    const auth = new Authentificateur(-7, true);
    options.user.name = pseudo; // le site met le pseudo dans la feuille du système (Q6) ; jamais envoyé
    const { credential: brut, passkey, sortie } = auth.creer(options, web);
    expect(sortie).not.toBeNull();
    // Comme un navigateur, l'authentificateur rend la sortie PRF au script ; le site la retire.
    expect(JSON.stringify(brut)).toContain(`"results"`);
    const credential = sansSortiePrf(brut);
    const h = unb64u(options.user.id) as Bytes;
    const kCompte = alea(32);
    const r = alea(16);
    const { aR, vR, kekR } = W.cleRecupDerivees(r);
    const kekPrf = W.kekPrf(sortie!) as Bytes;
    const env = await envelopper(kekPrf, W.adEnveloppePrf(h, passkey.id), kCompte);
    const envR = await envelopper(kekR, W.adEnveloppeRecup(h), kCompte);
    const kProfil = await cleAes(W.cleProfilCompte(kCompte));
    const kPrive = await cleAes(W.clePrive(kCompte));
    const kEtiq = await cleAes(W.cleAppareil(kCompte));
    const profil = profilEnJson({ pseudo, photo: photoProfil, langue: "fr", reglages: REGLAGES_DEFAUT, pass: null });
    const f = await json("POST", "/api/compte/inscription/fin", {
      etape,
      credential,
      p_canon: pCanon,
      env: b64u(env),
      v_r: b64u(vR as Bytes),
      env_r: b64u(envR),
      blob_profil: b64u(await sceller("profil", kProfil, h, 1, profil)),
      blob_prive: b64u(await sceller("prive", kPrive, h, 1, priveEnJson(priveVide()))),
      persistante: false,
      etiquette: b64u(await scellerEtiquette(kEtiq, h, ETIQ_APPAREIL)),
      cred_etiquette: b64u(await scellerEtiquette(kEtiq, h, pseudo === PSEUDO_A ? ETIQ_PK_A : ETIQ_PK_A2)),
    });
    expect(f.status).toBe(201);
    expect(f.corps.h).toBe(b64u(h));
    jetons.push(f.corps.session);
    return { pseudo, pCanon, h, kCompte, r, aR: aR as Bytes, kekR: kekR as Bytes, auth, pk: passkey, sorties: [sortie!], kekPrf: [kekPrf], session: f.corps.session };
  }

  beforeAll(async () => {
    srv = await startServer({ comptes: { cle: alea(32), admin: ADMIN } });
    web = srv.origin.replace("127.0.0.1", "localhost");
    W = (await loadEngine()).wasm;
    const sal = await loadSalonEngine();
    const canon = (p: string) => sal.cleUnicite(sal.pseudoValide(p));
    photo = alea(3000);
    for (const o of [0, 1000, 2900 - PHOTO_MARQUE.length]) photo.set(utf8(PHOTO_MARQUE), o);

    // ---- A : inscription, puis connexion par la passkey (PRF : enveloppe rouverte) ------------
    A = await inscrire(PSEUDO_A, canon(PSEUDO_A), photo);
    const cd = await json("POST", "/api/compte/connexion/debut", {});
    expect(cd.corps.options.allowCredentials).toBeUndefined();
    const g = A.auth.obtenir(cd.corps.options, web, A.pk);
    A.sorties.push(g.sortie!);
    const kekEtiq = await cleAes(W.cleAppareil(A.kCompte));
    const cf = await json("POST", "/api/compte/connexion/fin", { etape: cd.corps.etape, credential: sansSortiePrf(g.credential), persistante: true, etiquette: b64u(await scellerEtiquette(kekEtiq, A.h, ETIQ_APPAREIL)) });
    expect(cf.status).toBe(200);
    jetons.push(cf.corps.session);
    const kekC = W.kekPrf(g.sortie!) as Bytes;
    A.kekPrf.push(kekC);
    expect(cf.corps.enveloppes).toHaveLength(1);
    expect(await ouvrirEnv(kekC, W.adEnveloppePrf(A.h, A.pk.id), unb64u(cf.corps.enveloppes[0]))).toEqual(A.kCompte);
    const S = cf.corps.session as string;
    // Enveloppe de plus pour la passkey qui a signé (enveloppes multiples) : seule l'enveloppe part.
    const env2 = await envelopper(kekC, W.adEnveloppePrf(A.h, A.pk.id), A.kCompte);
    expect((await json("POST", "/api/compte/passkeys/enveloppe", { env: b64u(env2) }, S)).corps).toEqual({});

    // ---- Coffre privé : liens repères ----------------------------------------------------------
    const now = Date.now();
    const prive = {
      ...priveVide(),
      recus: [{ id: "recu-1", cree: now, expire: now + 3_600_000, lien: `${srv.origin}/s#${b64u(LIEN_RECU)}`, taille: 10, elements: 1, format: "texte" }],
      rejoints: [{ id: "salon-1", cree: now, expire: now + 3_600_000, invitation: `${srv.origin}/#c${b64u(INVITATION)}`, libelle: "x" }],
    };
    const kPrive = await cleAes(W.clePrive(A.kCompte));
    expect((await json("PUT", "/api/compte/coffre/prive", { if_gen: 1, blob: b64u(await sceller("prive", kPrive, A.h, 2, priveEnJson(prive))) }, S)).corps).toEqual({ gen: 2 });

    // ---- Deuxième passkey, sans PRF (session récente de la connexion) --------------------------
    authA2 = new Authentificateur(-8, false);
    const pd = await json("POST", "/api/compte/passkeys/debut", {}, S);
    expect(pd.status).toBe(200);
    expect(pd.corps.options.excludeCredentials).toHaveLength(1);
    const c2 = authA2.creer(pd.corps.options, web);
    pkA2 = c2.passkey;
    expect(c2.sortie).toBeNull();
    expect((await json("POST", "/api/compte/passkeys/fin", { etape: pd.corps.etape, credential: sansSortiePrf(c2.credential), env: "", etiquette: b64u(await scellerEtiquette(kekEtiq, A.h, ETIQ_PK_A2)) }, S)).corps).toEqual({});
    etat.passkeys = (await json("GET", "/api/compte/passkeys", undefined, S)).corps;

    // ---- Nouvel appareil : la clé de récupération, tapée en minuscules -------------------------
    const tapee = W.cleRecupAffichage(A.r).toLowerCase();
    const r = W.cleRecupLire(utf8(tapee));
    expect(r).toEqual(A.r);
    const rc = await json("POST", "/api/compte/recup", { a_r: b64u(W.cleRecupDerivees(r).aR as Bytes), persistante: false, etiquette: "" });
    expect(rc.status).toBe(200);
    jetons.push(rc.corps.session);
    expect(await ouvrirEnv(A.kekR, W.adEnveloppeRecup(A.h), unb64u(rc.corps.env_r))).toEqual(A.kCompte);
    const SR = rc.corps.session as string;
    // Nouvelle clé de récupération (proposée après usage, Q10) : seul v_r part.
    r2 = alea(16);
    const d2 = W.cleRecupDerivees(r2);
    aR2 = d2.aR as Bytes;
    expect((await json("POST", "/api/compte/recup/renouveler", { v_r: b64u(d2.vR as Bytes), env_r: b64u(await envelopper(d2.kekR, W.adEnveloppeRecup(A.h), A.kCompte)) }, SR)).corps).toEqual({});
    etat.sessions = (await json("GET", "/api/compte/sessions", undefined, SR)).corps;

    // ---- Salon créé avec la session ; export ; tableau de bord ---------------------------------
    await ClientSalon.creer({ origin: web, fetch: marked }, { maxMembers: 4, session: SR }); // origine du WebSocket = SHH_ORIGIN
    etat.export = (await json("GET", "/api/compte/export", undefined, SR)).corps;
    await admin("GET", "/api/comptes");
    await admin("POST", "/api/bannis", { filtre: "", page: 0 });

    // ---- B : inscription puis suppression (session récente) ------------------------------------
    B = await inscrire(PSEUDO_B, canon(PSEUDO_B), null);
    ligneB = { credId: B.pk.id, cose: B.pk.cose, vR: W.cleRecupDerivees(B.r).vR as Bytes };
    expect((await json("POST", "/api/compte/supprimer", {}, B.session)).corps).toEqual({ salons_fermes: 0 });
    expect((await json("GET", "/api/compte", undefined, B.session)).status).toBe(401);
    etat.colonnes = await base((db) => db.prepare("SELECT m.name AS t, p.name AS c, p.type AS ty FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' ORDER BY 1, p.cid").all());
    etat.dates = await base((db) => ({
      comptes: db.prepare("SELECT cree_jour, compte_des, pseudo_jour, vu_mois FROM comptes").all(),
      passkeys: db.prepare("SELECT ajoutee_mois FROM passkeys").all(),
      sessions: db.prepare("SELECT cree_mois, expire_jour FROM sessions").all(),
    }));
  }, 300_000);

  afterAll(async () => {
    await srv?.dispose();
  });

  async function base<T>(f: (db: import("node:sqlite").DatabaseSync) => T): Promise<T> {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(srv.dataDir, "comptes.db"), { readOnly: true });
    try {
      return f(db);
    } finally {
      db.close();
    }
  }

  // --- Repères ------------------------------------------------------------------------------------
  const cleRecup = (label: string, r: Uint8Array) => {
    const t = W.cleRecupAffichage(r);
    return [octets(`${label} (octets)`, r), needle(`${label} (groupée)`, t), needle(`${label} (texte)`, t.replaceAll("-", "")), needle(`${label} (minuscules)`, t.toLowerCase()), needle(`${label} (minuscules, texte)`, t.replaceAll("-", "").toLowerCase())];
  };
  /** Jamais reçus par le serveur : ce qui ouvre un coffre, et ce que l'appareil garde pour lui. */
  const jamaisRecus = (): Needle[] => [
    ...[A, B].flatMap((c) => [
      octets(`K_compte de ${c.pseudo}`, c.kCompte),
      ...cleRecup(`R de ${c.pseudo}`, c.r),
      octets(`KEK_r de ${c.pseudo}`, c.kekR),
      ...c.sorties.map((s, i) => octets(`sortie PRF ${i} de ${c.pseudo}`, s)),
      ...c.kekPrf.map((k, i) => octets(`KEK_prf ${i} de ${c.pseudo}`, k)),
      needle(`pseudo affiché de ${c.pseudo}`, c.pseudo),
    ]),
    ...cleRecup("R2 de A", r2),
    octets("A_r de R2", aR2),
    needle("photo", PHOTO_MARQUE),
    needle("libellé de passkey A", ETIQ_PK_A),
    needle("libellé de passkey A2", ETIQ_PK_A2),
    needle("nom d'appareil", ETIQ_APPAREIL),
    octets("lien reçu", LIEN_RECU),
    octets("invitation", INVITATION),
  ];
  const aR = () => [A, B].map((c) => octets(`A_r de ${c.pseudo}`, c.aR));
  /** AAGUID (modèle du gestionnaire, S84) : vu en direct dans l'enregistrement, jamais gardé ni rendu. */
  const aaguids = () => [octets("AAGUID A", A.auth.aaguid), octets("AAGUID A2", authA2.aaguid), octets("AAGUID B", B.auth.aaguid)];
  const pCanons = () => [A, B].map((c) => needle(`p_canon de ${c.pseudo}`, c.pCanon));
  const jetonsN = () => jetons.map((j, i) => needle(`jeton de session ${i}`, unb64u(j) as Bytes));

  it("disque : aucun repère, ni A_r, ni p_canon, ni jeton ; témoins retrouvés (h, clé publique, coffres)", () => {
    const fichiers = listFiles(srv.dataDir).map((f) => f.slice(srv.dataDir.length + 1));
    expect(fichiers).toContain("comptes.db");
    expect(scanDir(srv.dataDir, [...jamaisRecus(), ...aR(), ...pCanons(), ...jetonsN(), ...aaguids()])).toEqual([]);
    const t = scanDir(srv.dataDir, [octets("h de A", A.h), octets("clé publique de A", A.pk.cose), needle("SHH-PROF1", "SHH-PROF1")]).map((x) => x.slice(x.lastIndexOf(" : ") + 3));
    expect(t).toContain("h de A");
    expect(t).toContain("clé publique de A");
    expect(t).toContain("SHH-PROF1");
  });

  it("base : seulement des BLOB et des INTEGER ; aucune colonne d'AAGUID, de compteur, d'adresse ; dates au jour ou au mois", () => {
    const cols = etat.colonnes as { t: string; c: string; ty: string }[];
    expect(cols.length).toBeGreaterThan(25);
    for (const x of cols) expect(["BLOB", "INTEGER"], `${x.t}.${x.c}`).toContain(x.ty);
    // Seule exception : passkeys.sign_count (schéma 4, conception du compte §6.3), le compteur de
    // signatures WebAuthn qui fait refuser une passkey clonée ; ni identité ni appareil.
    const autorisees = new Set(["passkeys.sign_count"]);
    expect(cols.filter((x) => !autorisees.has(`${x.t}.${x.c}`)).map((x) => x.c).filter((c) => /aaguid|compteur|sign|e_canon|mdp|totp|transport|cle_profil/.test(c))).toEqual([]);
    expect(cols.some((x) => x.t === "passkeys" && x.c === "sign_count" && x.ty === "INTEGER")).toBe(true);
    const jour = (v: number) => v % 86_400 === 0;
    const mois = (v: number) => new Date(v * 1000).toISOString().endsWith("-01T00:00:00.000Z");
    const d = etat.dates as { comptes: any[]; passkeys: any[]; sessions: any[] };
    expect(d.comptes).toHaveLength(1); // B supprimé
    for (const l of d.comptes) expect(jour(l.cree_jour) && jour(l.compte_des) && jour(l.pseudo_jour) && mois(l.vu_mois)).toBe(true);
    expect(d.passkeys).toHaveLength(2);
    for (const l of d.passkeys) expect(mois(l.ajoutee_mois)).toBe(true);
    for (const l of d.sessions) expect(jour(l.expire_jour) && mois(l.cree_mois)).toBe(true);
  });

  it("requêtes et réponses : rien qui ouvre un coffre ; A_r seulement dans recup ; p_canon seulement où il sert ; X-Shh-Session seulement vers /api/compte/* et POST /api/salons", () => {
    const hits: string[] = [];
    for (const r of log) {
      const chemin = new URL(r.url).pathname;
      const ou = `${r.method} ${chemin}`;
      for (const l of findIn(Buffer.from(r.url), [...jamaisRecus(), ...aR(), ...pCanons(), ...jetonsN()])) hits.push(`${ou} URL : ${l}`);
      for (const [k, v] of r.headers) {
        if (k === "x-shh-session") {
          if (!chemin.startsWith("/api/compte") && !(chemin === "/api/salons" && r.method === "POST")) hits.push(`${ou} : X-Shh-Session hors des routes permises`);
          continue;
        }
        for (const l of findIn(Buffer.from(`${k}: ${v}`), [...jamaisRecus(), ...aR(), ...pCanons(), ...jetonsN()])) hits.push(`${ou} en-tête ${k} : ${l}`);
      }
      const corps = [...jamaisRecus(), ...jetonsN()];
      if (chemin !== "/api/compte/recup") corps.push(...aR());
      if (!/^\/api\/compte\/(inscription\/fin|pseudo\/verifier|pseudo)$/.test(chemin)) corps.push(...pCanons());
      if (!/^\/api\/compte\/(inscription|passkeys)\/fin$/.test(chemin)) corps.push(...aaguids());
      for (const l of findIn(r.body, corps)) hits.push(`${ou} corps : ${l}`);
      const rep = Buffer.concat([r.response, Buffer.from(r.responseHeaders)]);
      for (const l of findIn(rep, [...jamaisRecus(), ...aR(), ...pCanons(), ...aaguids()])) hits.push(`${ou} réponse : ${l}`);
      // Aucune sortie PRF dans un credential (le site la retire) : jamais de « results ».
      if (r.body.includes(Buffer.from('"results"'))) hits.push(`${ou} corps : prf.results`);
    }
    expect(hits).toEqual([]);
    // Témoins : l'AAGUID est bien dans l'attestation envoyée (et nulle part gardé) ; A_r est bien parti à recup ; le jeton vers POST /api/salons ; p_canon à inscription/fin.
    expect(log.some((r) => r.url.endsWith("/api/compte/inscription/fin") && findIn(r.body, [octets("AAGUID", A.auth.aaguid)]).length === 1)).toBe(true);
    expect(log.some((r) => r.url.endsWith("/api/compte/recup") && findIn(r.body, [octets("A_r", A.aR)]).length === 1)).toBe(true);
    expect(log.some((r) => r.url.endsWith("/api/salons") && r.method === "POST" && r.headers.some(([k]) => k === "x-shh-session"))).toBe(true);
    expect(log.some((r) => r.url.endsWith("/api/compte/inscription/fin") && findIn(r.body, [needle("p_canon", A.pCanon)]).length === 1)).toBe(true);
  });

  it("passkeys, sessions et export : libellés chiffrés, aucun AAGUID, session par la clé marquée", () => {
    const p = etat.passkeys.passkeys as Record<string, unknown>[];
    expect(p).toHaveLength(2);
    expect(p.map((x) => x.prf).sort()).toEqual([false, true]);
    expect(p.every((x) => typeof x.etiquette === "string" && (x.etiquette as string).length === 86)).toBe(true);
    expect((etat.sessions.sessions as Record<string, unknown>[]).filter((s) => s.par_recup)).toHaveLength(1);
    const x = Buffer.from(JSON.stringify(etat.export));
    expect(findIn(x, [...jamaisRecus(), ...jetonsN(), octets("h de A", A.h)])).toEqual([]);
    expect(etat.export.passkeys).toHaveLength(2);
  });

  it("tableau de bord : jamais un h, un pseudo, un identifiant ou une clé de passkey", () => {
    expect(logAdmin.length).toBe(2);
    const tous = [...jamaisRecus(), ...pCanons(), ...jetonsN(), ...aaguids(), octets("h de A", A.h), octets("cred_id A", A.pk.id), octets("clé publique A", A.pk.cose)];
    for (const r of logAdmin) expect(findIn(Buffer.concat([r.response, Buffer.from(r.responseHeaders)]), tous), r.url).toEqual([]);
    expect(JSON.parse(logAdmin[0]!.response.toString("utf8")).comptes).toBe(1); // témoin : A (B est créé ensuite)
  });

  it("mémoire du processus serveur : ni K_compte, ni R, ni sortie PRF, ni KEK, ni pseudo affiché, ni photo, ni libellé", async () => {
    const res = await scanProcessMemory(srv.pid, jamaisRecus());
    if (!res.ok) {
      const why = `lecture de /proc/${srv.pid}/mem impossible (${res.why})`;
      if (process.env.CI) throw new Error(`[le serveur ne voit rien : compte] fouille mémoire obligatoire en CI : ${why}`);
      console.warn(`[le serveur ne voit rien : compte] fouille mémoire IGNORÉE (hors CI) : ${why}`);
      return;
    }
    expect(res.rwRegions).toBeGreaterThan(0);
    expect(res.hits).toEqual([]);
    // Témoin : la clé publique de A (pages de comptes.db dans le cache de SQLite) est retrouvée.
    const ctl = await scanProcessMemory(srv.pid, [octets("clé publique de A", A.pk.cose)]);
    expect(ctl.ok && ctl.hits).toEqual(["clé publique de A"]);
  });

  it("après suppression puis arrêt : rien de B (h, cred_id, clé publique, v_r) ; stdout et stderr propres", async () => {
    await srv.stop();
    expect(scanDir(srv.dataDir, [octets("h de B", B.h), octets("cred_id de B", ligneB.credId), octets("clé publique de B", ligneB.cose), octets("v_r de B", ligneB.vR)])).toEqual([]);
    expect(scanDir(srv.dataDir, [...jamaisRecus(), ...aR(), ...pCanons(), ...jetonsN()])).toEqual([]);
    expect(scanDir(srv.dataDir, [octets("h de A", A.h)]).length).toBeGreaterThan(0); // témoin
    const tous = [...jamaisRecus(), ...aR(), ...pCanons(), ...jetonsN(), ...aaguids(), octets("h de A", A.h)];
    expect(findIn(srv.stdout(), tous)).toEqual([]);
    expect(findIn(srv.stderr(), tous)).toEqual([]);
    expect(srv.stdout().toString("utf8")).toMatch(/^SHH_LISTENING 127\.0\.0\.1:\d+\nSHH_ADMIN_LISTENING 127\.0\.0\.1:\d+\n$/);
  });

  it("le compte par e-mail n'existe plus : ses routes répondent comme une route inconnue ; ancienne variable SMTP refusée au démarrage", async () => {
    const s2 = await startServer({ comptes: { cle: alea(32) } });
    try {
      const ref = await fetch(`${s2.origin}/api/inconnue`);
      const refCorps = await ref.text();
      for (const r of ["inscription/renvoyer", "connexion", "connexion/totp", "reauth", "oubli/debut", "oubli/fin", "mdp", "email/debut", "totp/debut"]) {
        const w = await fetch(`${s2.origin}/api/compte/${r}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
        expect(w.status, r).toBe(ref.status);
        expect(await w.text(), r).toBe(refCorps);
      }
    } finally {
      await s2.dispose();
    }
    await expect(startServer({ comptes: { cle: alea(32) }, env: { SHH_SMTP_HOST: "smtp.exemple.fr" } })).rejects.toThrow(/SHH_SMTP_HOST/);
  });
});

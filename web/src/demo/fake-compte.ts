// Faux serveur du COMPTE de la démo GitHub Pages (propriétaire, 19 novembre : « démo essayable ») :
// mêmes routes et mêmes réponses que server/internal/api/handlers_compte.go, en mémoire, pour cet
// onglet seulement. Aucun e-mail : le code « envoyé » est gardé ici et montré à l'écran par
// app/demo-hooks.ts (compteCode). Ce qu'il voit est ce que verrait le vrai serveur : l'adresse
// tapée, A_auth (jamais le mot de passe), l'enveloppe de K_compte, les deux coffres chiffrés,
// p_canon ; rien de tout cela ne quitte l'onglet (gardé pour cet onglet par demo/persist.ts).
// Double authentification : vrai TOTP (RFC 6238, HMAC-SHA1 de WebCrypto, pas de 30 s, une fenêtre
// de part et d'autre, rejeu refusé) ; on peut donc utiliser une vraie application.
// Écarts assumés avec la production (démo) : l'adresse est seulement mise en minuscules (pas de
// normalisation complète), ni liste de domaines jetables, ni limites horaires, ni preuve après
// cinq échecs, ni attente de 7 jours (retrait de la double authentification immédiat).

export const MARK = "__SHH_DEMO__";

const CODE_ESSAIS = 5;
const RECENT_MS = 5 * 60_000;
const ETAPE_MS = 15 * 60_000;
const TOTP_PAS_S = 30;

type Bytes = Uint8Array<ArrayBuffer>;

export type CompteDemo = {
  h: string;
  aAuth: string;
  envMdp: string;
  sProfil: string;
  pCanon: string;
  profil: { blob: string; gen: number };
  prive: { blob: string; gen: number };
  totp: string | null; // secret base32 si la double authentification est active
  totpPas: number; // dernier pas TOTP accepté (rejeu refusé)
  creeLe: string;
};
type Etape = {
  sorte: "inscription" | "oubli" | "email" | "totp-connexion" | "totp-activation";
  email: string;
  h: string;
  code: string;
  essais: number;
  fin: number;
  verifie?: boolean;
  secret?: string;
  persistante?: boolean;
  etiquette?: string;
};
type Session = { email: string; sid: string; ajoutee: string; persistante: boolean; etiquette: string; auth: number };

export type InstantaneCompte = {
  v: 1;
  comptes: [string, CompteDemo][];
  sessions: [string, Session][];
  pseudos: string[];
};

export type FauxCompteOpts = {
  now?: () => number;
  /** État retrouvé (rechargement de l'onglet). */
  restore?: InstantaneCompte | null;
  /** Appelé après chaque changement (sauvegarde de l'onglet). */
  onChange?: (s: InstantaneCompte) => void;
};

export type FauxCompte = {
  handle(req: Request): Promise<Response>;
  /** Dernier code « envoyé » (aucun e-mail en démo) et son adresse, montrés à l'écran. */
  dernierCode(): { email: string; code: string } | null;
};

const rnd = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));
const b64u = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s: string): Bytes => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const B64U = /^[A-Za-z0-9_-]*$/;
const jour = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const mois = (ms: number) => new Date(ms).toISOString().slice(0, 7);

class HttpErr extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
const requete = () => new HttpErr(400, "bad_request");

/** Code à six chiffres, uniforme (rejet des tirages au-delà du plus grand multiple de 10⁶). */
function tirerCode(): string {
  const max = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    const v = new DataView(rnd(4).buffer).getUint32(0);
    if (v < max) return String(v % 1_000_000).padStart(6, "0");
  }
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(b: Uint8Array): string {
  let bits = 0,
    val = 0,
    out = "";
  for (const x of b) {
    val = (val << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(val << (5 - bits)) & 31];
  return out;
}
function deBase32(s: string): Bytes {
  let bits = 0,
    val = 0;
  const out: number[] = [];
  for (const c of s) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw requete();
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** HOTP (RFC 4226) du compteur `pas`, par HMAC-SHA1 de WebCrypto. */
async function hotp(secret: string, pas: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", deBase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(pas));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = mac[19]! & 15;
  const v = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(v % 1_000_000).padStart(6, "0");
}

/** Code TOTP juste dans la fenêtre (pas courant ± 1), jamais déjà accepté : son pas, sinon -1. */
export async function verifierTotp(secret: string, code: string, nowMs: number, dejaPas: number): Promise<number> {
  if (!/^\d{6}$/.test(code)) return -1;
  const p = Math.floor(nowMs / 1000 / TOTP_PAS_S);
  for (const d of [0, -1, 1]) {
    const pas = p + d;
    if (pas > dejaPas && (await hotp(secret, pas)) === code) return pas;
  }
  return -1;
}
/** Pour les tests : le code TOTP d'un instant. */
export const codeTotp = (secret: string, nowMs: number) => hotp(secret, Math.floor(nowMs / 1000 / TOTP_PAS_S));

export function createFauxCompte(opts: FauxCompteOpts = {}): FauxCompte {
  const now = opts.now ?? Date.now;
  const comptes = new Map<string, CompteDemo>(opts.restore?.comptes ?? []); // adresse en minuscules → compte
  const sessions = new Map<string, Session>(opts.restore?.sessions ?? []); // jeton → session
  const pseudos = new Set<string>(opts.restore?.pseudos ?? []);
  const etapes = new Map<string, Etape>(); // étapes : en mémoire seulement (perdues au rechargement, comme au redémarrage du serveur)
  let dernier: { email: string; code: string } | null = null;

  const sauver = () => opts.onChange?.({ v: 1, comptes: [...comptes], sessions: [...sessions], pseudos: [...pseudos] });
  const cle = (email: string) => email.trim().toLowerCase();

  function adresse(v: unknown): string {
    if (typeof v !== "string") throw requete();
    const e = v.trim();
    // Forme seulement (démo) : une partie locale, un « @ », un domaine avec un point.
    if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpErr(400, "adresse_invalide");
    return e;
  }
  const chaine = (v: unknown) => {
    if (typeof v !== "string") throw requete();
    return v;
  };
  function octetsB64(v: unknown, n?: number): string {
    if (typeof v !== "string" || !B64U.test(v)) throw requete();
    if (n !== undefined && unb64u(v).length !== n) throw requete();
    return v;
  }
  const booleen = (v: unknown) => {
    if (typeof v !== "boolean") throw requete();
    return v;
  };
  const etiquette = (v: unknown) => {
    const s = chaine(v);
    if (s !== "" && unb64u(octetsB64(s)).length !== 64) throw requete();
    return s;
  };

  function nouvelleEtape(e: Omit<Etape, "code" | "essais" | "fin">, envoyer: boolean): string {
    const jeton = b64u(rnd(32));
    const code = tirerCode();
    etapes.set(jeton, { ...e, code, essais: CODE_ESSAIS, fin: now() + ETAPE_MS });
    if (envoyer) dernier = { email: e.email, code };
    return jeton;
  }
  function etape(jeton: unknown, sortes: Etape["sorte"][]): Etape {
    const e = typeof jeton === "string" ? etapes.get(jeton) : undefined;
    if (!e || !sortes.includes(e.sorte) || e.fin < now()) {
      if (typeof jeton === "string") etapes.delete(jeton);
      throw new HttpErr(404, "not_found");
    }
    return e;
  }
  /** Code juste, ou un essai de moins (5 au plus ; ensuite l'étape disparaît). */
  function verifierCode(jeton: string, e: Etape, code: unknown) {
    if (typeof code === "string" && code === e.code) return;
    e.essais--;
    if (e.essais <= 0) {
      etapes.delete(jeton);
      throw new HttpErr(404, "not_found");
    }
    throw new HttpErr(403, "code_faux", { attempts_left: e.essais });
  }

  function ouvrirSession(email: string, persistante: boolean, etq: string): string {
    const t = b64u(rnd(32));
    sessions.set(t, { email, sid: b64u(rnd(16)), ajoutee: mois(now()), persistante, etiquette: etq, auth: now() });
    return t;
  }
  function ouverture(email: string, persistante: boolean, etq: string) {
    const c = comptes.get(email)!;
    return {
      session: ouvrirSession(email, persistante, etq),
      h: c.h,
      env_mdp: c.envMdp,
      s_profil: c.sProfil,
      blob_profil: c.profil.blob,
      gen_profil: c.profil.gen,
      blob_prive: c.prive.blob,
      gen_prive: c.prive.gen,
    };
  }
  function laSession(req: Request): { jeton: string; s: Session; c: CompteDemo } {
    const jeton = req.headers.get("X-Shh-Session") ?? "";
    const s = sessions.get(jeton);
    const c = s && comptes.get(s.email);
    if (!s || !c) throw new HttpErr(401, "session");
    return { jeton, s, c };
  }
  const recente = (s: Session) => {
    if (now() - s.auth > RECENT_MS) throw new HttpErr(403, "recent");
  };
  /** Double authentification : code exigé si active ; juste et non rejoué. */
  async function exigerTotp(c: CompteDemo, code: unknown) {
    if (c.totp === null) return;
    if (code === "" || code === undefined) throw new HttpErr(403, "totp_requis");
    const pas = await verifierTotp(c.totp, chaine(code), now(), c.totpPas);
    if (pas < 0) throw new HttpErr(403, "totp_faux");
    c.totpPas = pas;
  }
  const fermerSessionsDe = (email: string, sauf?: string) => {
    for (const [t, s] of sessions) if (s.email === email && t !== sauf) sessions.delete(t);
  };

  async function route(req: Request, r: string, b: Record<string, unknown>): Promise<unknown> {
    switch (`${req.method} ${r}`) {
      // --- inscription ---
      case "POST inscription/debut": {
        const email = adresse(b.email);
        chaine(b.langue);
        chaine(b.altcha);
        chaine(b.hp);
        chaine(b.shown_at);
        // Même réponse que l'adresse soit prise ou non (le refus vient après le code juste).
        const h = comptes.get(cle(email))?.h ?? b64u(rnd(16));
        return { h, etape: nouvelleEtape({ sorte: "inscription", email, h }, true) };
      }
      case "POST inscription/renvoyer":
      case "POST oubli/renvoyer": {
        const e = etape(b.etape, r.startsWith("oubli") ? ["oubli"] : ["inscription"]);
        if (cle(chaine(b.email)) !== cle(e.email)) throw new HttpErr(404, "not_found");
        if (e.sorte === "inscription" || comptes.has(cle(e.email))) dernier = { email: e.email, code: e.code };
        return {};
      }
      case "POST inscription/fin": {
        const jeton = chaine(b.etape);
        const e = etape(jeton, ["inscription"]);
        verifierCode(jeton, e, b.code);
        if (comptes.has(cle(e.email))) {
          etapes.delete(jeton);
          throw new HttpErr(409, "deja_inscrit");
        }
        const pCanon = chaine(b.p_canon);
        if (pseudos.has(pCanon)) throw new HttpErr(409, "pseudo_pris");
        const persistante = booleen(b.persistante);
        const etq = etiquette(b.etiquette);
        comptes.set(cle(e.email), {
          h: e.h,
          aAuth: octetsB64(b.a_auth, 32),
          envMdp: octetsB64(b.env_mdp, 60),
          sProfil: octetsB64(b.s_profil, 32),
          pCanon,
          profil: { blob: octetsB64(b.blob_profil), gen: 1 },
          prive: { blob: octetsB64(b.blob_prive), gen: 1 },
          totp: null,
          totpPas: -1,
          creeLe: jour(now()),
        });
        pseudos.add(pCanon);
        etapes.delete(jeton);
        if (dernier?.code === e.code) dernier = null;
        return { session: ouvrirSession(cle(e.email), persistante, etq) };
      }
      // --- connexion ---
      case "POST connexion": {
        const email = cle(adresse(b.email));
        const aAuth = octetsB64(b.a_auth, 32);
        const persistante = booleen(b.persistante);
        const etq = etiquette(b.etiquette);
        const c = comptes.get(email);
        if (!c || c.aAuth !== aAuth) throw new HttpErr(403, "identifiants");
        if (c.totp !== null) {
          const jeton = b64u(rnd(32));
          etapes.set(jeton, { sorte: "totp-connexion", email, h: c.h, code: "", essais: CODE_ESSAIS, fin: now() + ETAPE_MS, persistante, etiquette: etq });
          return { totp_requis: true, etape: jeton };
        }
        return ouverture(email, persistante, etq);
      }
      case "POST connexion/totp": {
        const jeton = chaine(b.etape);
        const e = etape(jeton, ["totp-connexion"]);
        const c = comptes.get(e.email);
        if (!c) throw new HttpErr(404, "not_found");
        const pas = await verifierTotp(c.totp ?? "", chaine(b.code), now(), c.totpPas);
        if (pas < 0) throw new HttpErr(403, "totp_faux");
        c.totpPas = pas;
        etapes.delete(jeton);
        return ouverture(e.email, e.persistante ?? false, e.etiquette ?? "");
      }
      // --- mot de passe oublié ---
      case "POST oubli/debut": {
        const email = adresse(b.email);
        chaine(b.langue);
        const c = comptes.get(cle(email));
        // Adresse inconnue : même réponse, aucun code « envoyé ».
        return { etape: nouvelleEtape({ sorte: "oubli", email, h: c?.h ?? b64u(rnd(16)) }, c !== undefined) };
      }
      case "POST oubli/verifier": {
        const jeton = chaine(b.etape);
        const e = etape(jeton, ["oubli"]);
        verifierCode(jeton, e, b.code);
        const c = comptes.get(cle(e.email));
        if (!c) throw new HttpErr(403, "code_faux", { attempts_left: e.essais });
        if (c.totp !== null && b.totp_perdu !== true) await exigerTotp(c, b.totp);
        e.verifie = true;
        return { h: c.h, gen_prive: c.prive.gen };
      }
      case "POST oubli/fin": {
        const jeton = chaine(b.etape);
        const e = etape(jeton, ["oubli"]);
        if (!e.verifie) throw new HttpErr(404, "not_found");
        const c = comptes.get(cle(e.email))!;
        const blob = octetsB64(b.blob_prive);
        // Le nouveau coffre privé porte gen_prive + 1 dans ses données authentifiées (octets 9 à 16).
        const raw = unb64u(blob);
        if (raw.length < 17 || new DataView(raw.buffer, 9, 8).getBigUint64(0) !== BigInt(c.prive.gen + 1)) throw requete();
        c.aAuth = octetsB64(b.a_auth, 32);
        c.envMdp = octetsB64(b.env_mdp, 60);
        c.prive = { blob, gen: c.prive.gen + 1 };
        fermerSessionsDe(cle(e.email));
        etapes.delete(jeton);
        const o = ouverture(cle(e.email), booleen(b.persistante), etiquette(b.etiquette));
        return { session: o.session, h: o.h, s_profil: o.s_profil, blob_profil: o.blob_profil, gen_profil: o.gen_profil, gen_prive: o.gen_prive };
      }
      case "POST pseudo/libre":
        return { libre: !pseudos.has(chaine(b.p_canon)) };
    }

    // --- routes avec session ---
    const { jeton, s, c } = laSession(req);
    switch (`${req.method} ${r}`) {
      case "GET ": {
        const confirme = jour(Date.parse(c.creeLe) + 7 * 86_400_000);
        const palier = jour(now()) >= confirme ? "confirme" : "neuf";
        return {
          h: c.h,
          cree_le: c.creeLe,
          palier,
          confirme_le: confirme,
          limites: palier === "neuf" ? { salons: 1, places: 4, heures: 24 } : { salons: 3, places: 8, heures: 72 },
          salons_actifs: 0,
          totp: c.totp !== null,
          banni: false,
          recup_jusqu: null,
          retrait_totp_le: null,
          banni_jusqu: null,
          banni_motif: null,
        };
      }
      case "GET coffre/profil":
      case "GET coffre/prive": {
        const v = r.endsWith("profil") ? c.profil : c.prive;
        return { blob: v.blob, gen: v.gen };
      }
      case "PUT coffre/profil":
      case "PUT coffre/prive": {
        const v = r.endsWith("profil") ? c.profil : c.prive;
        if (b.if_gen !== v.gen) throw new HttpErr(409, "conflict", { gen: v.gen });
        v.blob = octetsB64(b.blob);
        v.gen++;
        return { gen: v.gen };
      }
      case "POST pseudo/verifier":
        return { libre: !pseudos.has(chaine(b.p_canon)) || chaine(b.p_canon) === c.pCanon };
      case "POST pseudo": {
        const p = chaine(b.p_canon);
        if (p !== c.pCanon && pseudos.has(p)) throw new HttpErr(409, "pseudo_pris");
        pseudos.delete(c.pCanon);
        pseudos.add((c.pCanon = p));
        return {};
      }
      case "POST sessions/etiquette":
        s.etiquette = etiquette(b.etiquette);
        return {};
      case "POST deconnexion":
        sessions.delete(jeton);
        return {};
      case "POST reauth":
        if (c.aAuth !== octetsB64(b.a_auth, 32)) throw new HttpErr(403, "identifiants");
        await exigerTotp(c, b.totp);
        s.auth = now();
        return {};
      case "POST mdp":
        recente(s);
        c.aAuth = octetsB64(b.a_auth, 32);
        c.envMdp = octetsB64(b.env_mdp, 60);
        fermerSessionsDe(s.email, jeton);
        return {};
      case "POST email/debut": {
        recente(s);
        if (cle(adresse(b.email_actuel)) !== s.email) throw new HttpErr(403, "identifiants");
        const nouveau = adresse(b.email_nouveau);
        if (comptes.has(cle(nouveau))) throw new HttpErr(409, "deja_inscrit");
        return { etape: nouvelleEtape({ sorte: "email", email: nouveau, h: c.h }, true) };
      }
      case "POST email/renvoyer": {
        const e = etape(b.etape, ["email"]);
        dernier = { email: e.email, code: e.code };
        return {};
      }
      case "POST email/fin": {
        recente(s);
        const je = chaine(b.etape);
        const e = etape(je, ["email"]);
        verifierCode(je, e, b.code);
        await exigerTotp(c, b.totp);
        c.aAuth = octetsB64(b.a_auth, 32);
        c.envMdp = octetsB64(b.env_mdp, 60);
        const ancien = s.email,
          nouveau = cle(e.email);
        comptes.delete(ancien);
        comptes.set(nouveau, c);
        for (const v of sessions.values()) if (v.email === ancien) v.email = nouveau;
        etapes.delete(je);
        return {};
      }
      case "POST totp/debut": {
        recente(s);
        const secret = base32(rnd(20));
        const je = b64u(rnd(32));
        etapes.set(je, { sorte: "totp-activation", email: s.email, h: c.h, code: "", essais: CODE_ESSAIS, fin: now() + ETAPE_MS, secret });
        return { etape: je, secret };
      }
      case "POST totp/fin": {
        const je = chaine(b.etape);
        const e = etape(je, ["totp-activation"]);
        const pas = await verifierTotp(e.secret!, chaine(b.code), now(), -1);
        if (pas < 0) throw new HttpErr(403, "totp_faux");
        c.totp = e.secret!;
        c.totpPas = pas;
        etapes.delete(je);
        return {};
      }
      case "POST totp/retirer":
        recente(s);
        c.totp = null;
        c.totpPas = -1;
        return {};
      case "POST totp/annuler-retrait":
        return {};
      case "GET sessions":
        return {
          sessions: [...sessions]
            .filter(([, v]) => v.email === s.email)
            .map(([t, v]) => ({ sid: v.sid, ajoutee: v.ajoutee, etiquette: v.etiquette, courante: t === jeton, persistante: v.persistante })),
        };
      case "POST sessions/fermer":
        for (const [t, v] of sessions) if (v.email === s.email && (b.autres === true ? t !== jeton : v.sid === b.sid)) sessions.delete(t);
        return {};
      case "GET export":
        return {
          cree_le: c.creeLe,
          anciennete_depuis: c.creeLe,
          vu_mois: mois(now()),
          totp: c.totp !== null,
          retrait_totp_le: null,
          recup_jusqu: null,
          banni_jusqu: null,
          banni_motif: null,
          salons_actifs: 0,
          sessions: [...sessions.values()].filter((v) => v.email === s.email).map((v) => ({ ajoutee: v.ajoutee, persistante: v.persistante })),
        };
      case "POST supprimer":
        recente(s);
        pseudos.delete(c.pCanon);
        comptes.delete(s.email);
        fermerSessionsDe(s.email);
        return { salons_fermes: 0 };
      case "GET salons":
        return { salons: [] };
    }
    throw new HttpErr(404, "not_found");
  }

  return {
    async handle(req: Request): Promise<Response> {
      const r = new URL(req.url).pathname.replace(/^.*?\/api\/compte\/?/, "");
      let b: Record<string, unknown> = {};
      try {
        if (req.method !== "GET") {
          const t = await req.text();
          if (t !== "") {
            const v: unknown = JSON.parse(t);
            if (typeof v !== "object" || v === null || Array.isArray(v)) throw requete();
            b = v as Record<string, unknown>;
          }
        }
        const out = await route(req, r, b);
        sauver();
        const status = r === "inscription/fin" ? 201 : 200;
        return new Response(JSON.stringify(out), { status, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        const err = e instanceof HttpErr ? e : e instanceof SyntaxError ? requete() : new HttpErr(500, "internal");
        sauver();
        return new Response(JSON.stringify({ error: err.code, ...err.extra }), { status: err.status, headers: { "Content-Type": "application/json" } });
      }
    },
    dernierCode: () => dernier,
  };
}

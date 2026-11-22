// État du compte sur l'appareil (conception compte §9, §10, §21.2) contre un faux serveur en
// mémoire : inscription, connexion (avec étape TOTP), récupération, pseudo, deux coffres,
// écriture différée du coffre privé, « Rester connecté », déconnexion qui efface tout.
import { randomFillSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB, type FakeIdb } from "../history/fake-idb.test-helper";
import { b64u, unb64u } from "../engine/pure";
import { clesDuCompte, ouvrirEnveloppe } from "./keys";
import { deriverCompte } from "../engine/index";
import { ouvrir, priveDeJson, profilDeJson, REGLAGES_DEFAUT, type Profil } from "./vaults";
import { ouvrirEtiquette } from "./device";
import * as C from "./session.svelte";

const MDP = "correct horse battery";
const CODE = "123456";
const PREUVE = { altcha: "preuve", hp: "", shown_at: "t" };
const profil = (p: Partial<Profil> = {}): Profil => ({ pseudo: "Lea", photo: null, langue: "fr", reglages: { ...REGLAGES_DEFAUT }, pass: null, ...p });

type Compte = { h: Uint8Array; aAuth: string; envMdp: Uint8Array; sProfil: Uint8Array; pCanon: string; coffres: Record<"profil" | "prive", { blob: Uint8Array; gen: number }>; totp: boolean };

/** Faux serveur : routes du compte utilisées par le lot 9, mêmes formes que handlers_compte.go. */
function fauxServeur() {
  const comptes = new Map<string, Compte>(); // e-mail exact → compte
  const etapes = new Map<string, { email: string; h: Uint8Array; sorte: "inscription" | "oubli" | "totp"; verifie?: boolean }>();
  const sessions = new Map<string, string>(); // jeton → e-mail
  const recentes = new Set<string>(); // sessions « récentes » (connexion ou reauth de moins de 5 min)
  const nomDe = new Map<string, string>(); // jeton → étiquette (nom d'appareil chiffré)
  const sid = new Map<string, string>(); // jeton → identifiant montré dans la liste
  const pseudos = new Set<string>();
  const requetes: { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const etiquettes: string[] = [];
  const rnd = (n: number) => randomFillSync(new Uint8Array(n)); // pas crypto.getRandomValues : `tires` ne voit que l'appareil
  const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const err = (status: number, error: string, extra = {}) => ok({ error, ...extra }, status);
  const ouvrirSession = (email: string) => {
    const t = b64u(rnd(32));
    sessions.set(t, email);
    recentes.add(t);
    sid.set(t, b64u(rnd(16)));
    return t;
  };
  const ouverture = (email: string) => {
    const c = comptes.get(email)!;
    return { session: ouvrirSession(email), h: b64u(c.h as Uint8Array<ArrayBuffer>), env_mdp: b64u(c.envMdp as Uint8Array<ArrayBuffer>), s_profil: b64u(c.sProfil as Uint8Array<ArrayBuffer>), blob_profil: b64u(c.coffres.profil.blob as Uint8Array<ArrayBuffer>), gen_profil: c.coffres.profil.gen, blob_prive: b64u(c.coffres.prive.blob as Uint8Array<ArrayBuffer>), gen_prive: c.coffres.prive.gen };
  };
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = { ...(init.headers as Record<string, string>) };
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    requetes.push({ method: init.method ?? "GET", path, headers, body });
    const qui = sessions.get(headers["X-Shh-Session"] ?? "");
    const r = path.replace(/^\/api\/compte\/?/, "");
    switch (`${init.method} ${r}`) {
      case "POST inscription/debut": {
        const e = b64u(rnd(32)), h = rnd(16);
        etapes.set(e, { email: body.email as string, h, sorte: "inscription" });
        return ok({ h: b64u(h), etape: e });
      }
      case "POST inscription/fin": {
        const e = etapes.get(body.etape as string);
        if (!e) return err(404, "not_found");
        if (body.code !== CODE) return err(403, "code_faux", { attempts_left: 4 });
        if (pseudos.has(body.p_canon as string)) return err(409, "pseudo_pris");
        pseudos.add(body.p_canon as string);
        if (body.etiquette) etiquettes.push(body.etiquette as string);
        comptes.set(e.email, { h: e.h, aAuth: body.a_auth as string, envMdp: unb64u(body.env_mdp as string), sProfil: unb64u(body.s_profil as string), pCanon: body.p_canon as string, coffres: { profil: { blob: unb64u(body.blob_profil as string), gen: 1 }, prive: { blob: unb64u(body.blob_prive as string), gen: 1 } }, totp: false });
        etapes.delete(body.etape as string);
        const t = ouvrirSession(e.email);
        if (body.etiquette) nomDe.set(t, body.etiquette as string);
        return ok({ session: t }, 201);
      }
      case "POST connexion": {
        const c = comptes.get(body.email as string);
        if (!c || c.aAuth !== body.a_auth) return err(403, "identifiants");
        if (c.totp) {
          const e = b64u(rnd(32));
          etapes.set(e, { email: body.email as string, h: c.h, sorte: "totp" });
          return ok({ totp_requis: true, etape: e });
        }
        return ok(ouverture(body.email as string));
      }
      case "POST connexion/totp": {
        const e = etapes.get(body.etape as string);
        if (!e || e.sorte !== "totp") return err(404, "not_found");
        if (body.code !== "654321") return err(403, "totp_faux");
        return ok(ouverture(e.email));
      }
      case "POST oubli/debut": {
        const e = b64u(rnd(32));
        etapes.set(e, { email: body.email as string, h: comptes.get(body.email as string)?.h ?? rnd(16), sorte: "oubli" });
        return ok({ etape: e });
      }
      case "POST oubli/verifier": {
        const e = etapes.get(body.etape as string);
        const c = e && comptes.get(e.email);
        if (!e || !c || body.code !== CODE) return err(403, "code_faux", { attempts_left: 4 });
        e.verifie = true;
        return ok({ h: b64u(c.h as Uint8Array<ArrayBuffer>), gen_prive: c.coffres.prive.gen });
      }
      case "POST oubli/fin": {
        const e = etapes.get(body.etape as string);
        if (!e?.verifie) return err(404, "not_found");
        const c = comptes.get(e.email)!;
        const blob = unb64u(body.blob_prive as string);
        if (new DataView(blob.buffer, 9, 8).getBigUint64(0) !== BigInt(c.coffres.prive.gen + 1)) return err(400, "bad_request");
        c.aAuth = body.a_auth as string;
        c.envMdp = unb64u(body.env_mdp as string);
        c.coffres.prive = { blob, gen: c.coffres.prive.gen + 1 };
        for (const [t, m] of sessions) if (m === e.email) sessions.delete(t);
        const o = ouverture(e.email);
        return ok({ session: o.session, h: o.h, s_profil: o.s_profil, blob_profil: o.blob_profil, gen_profil: o.gen_profil, gen_prive: o.gen_prive });
      }
      case "POST pseudo/verifier":
        if (!qui && !(body.etape && etapes.has(body.etape as string))) return err(401, "session");
        return ok({ libre: !pseudos.has(body.p_canon as string) });
      case "POST pseudo/libre":
        return ok({ libre: !pseudos.has(body.p_canon as string) });
      case "POST pseudo": {
        if (!qui) return err(401, "session");
        if (pseudos.has(body.p_canon as string)) return err(409, "pseudo_pris");
        const c = comptes.get(qui)!;
        pseudos.delete(c.pCanon);
        pseudos.add((c.pCanon = body.p_canon as string));
        return ok({});
      }
      case "GET coffre/profil":
      case "GET coffre/prive": {
        if (!qui) return err(401, "session");
        const v = comptes.get(qui)!.coffres[r.slice(7) as "profil" | "prive"];
        return ok({ blob: b64u(v.blob as Uint8Array<ArrayBuffer>), gen: v.gen });
      }
      case "PUT coffre/profil":
      case "PUT coffre/prive": {
        if (!qui) return err(401, "session");
        const v = comptes.get(qui)!.coffres[r.slice(7) as "profil" | "prive"];
        if (body.if_gen !== v.gen) return err(409, "conflict", { gen: v.gen });
        v.blob = unb64u(body.blob as string);
        v.gen++;
        return ok({ gen: v.gen });
      }
      case "GET ": {
        if (!qui) return err(401, "session");
        return ok({ h: b64u(comptes.get(qui)!.h as Uint8Array<ArrayBuffer>), cree_le: "2026-11-14", palier: "neuf", confirme_le: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, salons_actifs: 0, totp: false, banni: false, recup_jusqu: null, retrait_totp_le: null, banni_jusqu: null, banni_motif: null });
      }
      case "POST sessions/etiquette":
        if (!qui) return err(401, "session");
        etiquettes.push(body.etiquette as string);
        nomDe.set(headers["X-Shh-Session"]!, body.etiquette as string);
        return ok({});
      // Lot 13 : paramètres (mêmes formes que handlers_compte.go, lot 5).
      case "POST reauth": {
        if (!qui) return err(401, "session");
        const c = comptes.get(qui)!;
        if (c.aAuth !== body.a_auth) return err(403, "identifiants");
        if (c.totp && body.totp === "") return err(403, "totp_requis");
        if (c.totp && body.totp !== "654321") return err(403, "totp_faux");
        recentes.add(headers["X-Shh-Session"]!);
        return ok({});
      }
      case "POST mdp": {
        if (!qui) return err(401, "session");
        if (!recentes.has(headers["X-Shh-Session"]!)) return err(403, "recent");
        const c = comptes.get(qui)!;
        c.aAuth = body.a_auth as string;
        c.envMdp = unb64u(body.env_mdp as string);
        for (const [t, m] of sessions) if (m === qui && t !== headers["X-Shh-Session"]) sessions.delete(t);
        return ok({});
      }
      case "POST email/debut": {
        if (!qui) return err(401, "session");
        if (!recentes.has(headers["X-Shh-Session"]!)) return err(403, "recent");
        if (body.email_actuel !== qui) return err(403, "identifiants");
        const e = b64u(rnd(32));
        etapes.set(e, { email: body.email_nouveau as string, h: comptes.get(qui)!.h, sorte: "inscription" });
        return ok({ etape: e });
      }
      case "POST email/renvoyer":
        return qui ? ok({}) : err(401, "session");
      case "POST email/fin": {
        if (!qui) return err(401, "session");
        if (!recentes.has(headers["X-Shh-Session"]!)) return err(403, "recent");
        const e = etapes.get(body.etape as string);
        if (!e) return err(404, "not_found");
        if (body.code !== CODE) return err(403, "code_faux", { attempts_left: 4 });
        const c = comptes.get(qui)!;
        c.aAuth = body.a_auth as string;
        c.envMdp = unb64u(body.env_mdp as string);
        comptes.delete(qui);
        comptes.set(e.email, c);
        for (const [t, m] of sessions) if (m === qui) sessions.set(t, e.email);
        etapes.delete(body.etape as string);
        return ok({});
      }
      case "POST totp/debut":
        if (!qui) return err(401, "session");
        if (!recentes.has(headers["X-Shh-Session"]!)) return err(403, "recent");
        etapes.set("totp-activation", { email: qui, h: comptes.get(qui)!.h, sorte: "totp" });
        return ok({ etape: b64u(rnd(32)), secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" });
      case "POST totp/fin":
        if (!qui) return err(401, "session");
        if (body.code !== "654321") return err(403, "totp_faux");
        comptes.get(qui)!.totp = true;
        return ok({});
      case "POST totp/retirer":
        if (!qui) return err(401, "session");
        if (!recentes.has(headers["X-Shh-Session"]!)) return err(403, "recent");
        comptes.get(qui)!.totp = false;
        return ok({});
      case "POST totp/annuler-retrait":
        return qui ? ok({}) : err(401, "session");
      case "GET sessions": {
        if (!qui) return err(401, "session");
        const out = [...sessions].filter(([, m]) => m === qui).map(([t]) => ({ sid: sid.get(t)!, ajoutee: "2026-11", etiquette: nomDe.get(t) ?? "", courante: t === headers["X-Shh-Session"], persistante: false }));
        return ok({ sessions: out });
      }
      case "POST sessions/fermer": {
        if (!qui) return err(401, "session");
        for (const [t, m] of sessions) if (m === qui && (body.autres === true ? t !== headers["X-Shh-Session"] : sid.get(t) === body.sid)) sessions.delete(t);
        return ok({});
      }
      case "GET export":
        if (!qui) return err(401, "session");
        return ok({ cree_le: "2026-11-14", anciennete_depuis: "2026-11-14", vu_mois: "2026-11", totp: comptes.get(qui)!.totp, retrait_totp_le: null, recup_jusqu: null, banni_jusqu: null, banni_motif: null, salons_actifs: 1, sessions: [{ ajoutee: "2026-11", persistante: false }] });
      case "POST supprimer": {
        if (!qui) return err(401, "session");
        if (!recentes.has(headers["X-Shh-Session"]!)) return err(403, "recent");
        const c = comptes.get(qui)!;
        pseudos.delete(c.pCanon);
        comptes.delete(qui);
        for (const [t, m] of sessions) if (m === qui) sessions.delete(t);
        return ok({ salons_fermes: 2 });
      }
      case "POST deconnexion":
        if (!qui) return err(401, "session");
        sessions.delete(headers["X-Shh-Session"]!);
        return ok({});
    }
    return err(404, "not_found");
  }) as unknown as typeof globalThis.fetch;
  return { comptes, sessions, recentes, requetes, etiquettes, fetch };
}

let srv: ReturnType<typeof fauxServeur>;
let idb: FakeIdb;
let planifies: { ms: number; f: () => void; annule: boolean }[];
/** Tableaux de 32 octets tirés par crypto.getRandomValues (K_compte, s_profil) côté appareil. */
let tires: Uint8Array[];
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

/** Vraie dérivation (moteur), gardée par mot de passe et adresse : moins d'Argon2id de 64 Mio par test. */
const derives = new Map<string, { aAuth: Uint8Array; kekMdp: Uint8Array }>();
async function deriver(mdp: string, canon: string) {
  const k = `${mdp}\0${canon}`;
  if (!derives.has(k)) derives.set(k, await deriverCompte(mdp, canon));
  const d = derives.get(k)!;
  return { aAuth: d.aAuth.slice(), kekMdp: d.kekMdp.slice() }; // copies : la session les efface
}

function configurer() {
  C.configurerCompte({
    deriver,
    net: { origin: "https://shh.test", fetch: srv.fetch },
    idb: () => idb,
    agent: () => UA,
    planifier: (ms, f) => {
      const p = { ms, f, annule: false };
      planifies.push(p);
      return () => (p.annule = true);
    },
  });
}

function configurerFetch(fetch: typeof globalThis.fetch) {
  C.configurerCompte({ net: { origin: "https://shh.test", fetch } });
}

beforeEach(() => {
  srv = fauxServeur();
  idb = fakeIndexedDB();
  planifies = [];
  tires = [];
  const real = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
    const out = real(a as never) as T;
    if (a instanceof Uint8Array && a.length === 32) tires.push(a);
    return out;
  });
  configurer();
});
afterEach(async () => {
  await C.seDeconnecter();
  vi.restoreAllMocks();
});

async function inscription(email = "Lea.Dupont@exemple.fr", persistante = false, p = profil()) {
  await C.inscrire(email, "fr", PREUVE);
  await C.confirmer(CODE, MDP, p, persistante);
}

describe("inscription", () => {
  it("le mot de passe ne part jamais ; le compte s'ouvre avec les deux coffres", async () => {
    await inscription();
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.profil?.pseudo).toBe("Lea");
    expect(C.account.prive).toEqual({ salons: [], recus: [], rejoints: [], envois: [] });
    const tout = JSON.stringify(srv.requetes);
    expect(tout).not.toContain(MDP);
    expect(tout).not.toContain(b64u(new TextEncoder().encode(MDP)));
    // Le serveur reçoit l'adresse exacte ; le pseudo seulement en p_canon.
    const fin = srv.requetes.find((r) => r.path.endsWith("inscription/fin"))!;
    expect(fin.body.p_canon).toBe("lea");
    // Le pseudo tel qu'écrit n'est dans aucun champ lisible. Les champs opaques (chiffrés ou
    // aléatoires, en base64url) sont écartés : sur 8 000 caractères au hasard, « Lea » y apparaît
    // une fois sur trente par pur hasard (échec intermittent de la CI, 20 novembre).
    const lisibles = JSON.stringify(srv.requetes, (_k, v) => (typeof v === "string" && /^[A-Za-z0-9_-]{40,}$/.test(v) ? "" : v));
    expect(lisibles).not.toContain("Lea");
    expect(lisibles).toContain('"p_canon":"lea"');
    expect(srv.requetes[0]!.body).toEqual({ email: "lea.dupont@exemple.fr", langue: "fr", ...PREUVE });
  });

  it("l'enveloppe ouvre K_compte, le profil s'ouvre par s_profil, l'étiquette nomme l'appareil", async () => {
    await inscription();
    const c = srv.comptes.get("lea.dupont@exemple.fr")!;
    const { aAuth, kekMdp } = await deriverCompte(MDP, "lea.dupont@exemple.fr"); // calcul neuf, hors cache
    expect(b64u(aAuth)).toBe(c.aAuth);
    const kCompte = await ouvrirEnveloppe(kekMdp, c.h, c.envMdp);
    const k = await clesDuCompte(kCompte, c.sProfil);
    expect(profilDeJson(await ouvrir("profil", k.profil, c.h, c.coffres.profil.blob, 1)).pseudo).toBe("Lea");
    expect(priveDeJson(await ouvrir("prive", k.prive, c.h, c.coffres.prive.blob, 1)).salons).toEqual([]);
    // Le coffre de profil ne s'ouvre pas avec K_prive (le séquestre n'ouvre que le profil).
    await expect(ouvrir("prive", k.profil, c.h, c.coffres.prive.blob, 1)).rejects.toThrow("coffre_illisible");
    expect(await ouvrirEtiquette(k.etiquette, c.h, unb64u(srv.etiquettes[0]!))).toBe("Firefox · ordinateur");
  });

  it("mot de passe trop court, pseudo invalide ou réservé : refus avant toute requête de fin", async () => {
    await C.inscrire("lea@exemple.fr", "fr", PREUVE);
    await expect(C.confirmer(CODE, "court", profil(), false)).rejects.toThrow("mdp_court");
    await expect(C.confirmer(CODE, MDP, profil({ pseudo: "a" }), false)).rejects.toThrow(/pseudo/);
    await expect(C.confirmer(CODE, MDP, profil({ pseudo: "Admin" }), false)).rejects.toThrow("pseudo_reserve");
    expect(srv.requetes.filter((r) => r.path.endsWith("inscription/fin"))).toEqual([]);
  });

  it("code faux : l'erreur du serveur passe (essais restants), l'inscription reste en cours", async () => {
    await C.inscrire("lea@exemple.fr", "fr", PREUVE);
    await expect(C.confirmer("000000", MDP, profil(), false)).rejects.toMatchObject({ code: "code_faux", attemptsLeft: 4 });
    expect(C.account.etat).toBe("absent");
    await C.confirmer(CODE, MDP, profil(), false);
    expect(C.account.etat).toBe("ouvert");
  });

  it("pseudoLibre : pendant l'inscription par l'étape, ensuite par la session ; réservé : jamais libre, sans requête", async () => {
    await C.inscrire("lea@exemple.fr", "fr", PREUVE);
    expect(await C.pseudoLibre("Lea")).toBe(true);
    const n = srv.requetes.length;
    expect(await C.pseudoLibre("Support")).toBe(false);
    expect(srv.requetes.length).toBe(n);
    await C.confirmer(CODE, MDP, profil(), false);
    expect(await C.pseudoLibre("LEA")).toBe(false);
    const last = srv.requetes.at(-1)!;
    expect(last.headers["X-Shh-Session"]).toBeTruthy();
    expect(last.body).toEqual({ p_canon: "lea" });
  });
});

describe("pseudo d'un invité du salon (22 novembre)", () => {
  it("sans session ni salon : pris par un compte → non ; réservé → non sans requête ; libre → oui ; le sien → oui", async () => {
    await inscription();
    const mien = C.account.profil!.pseudo;
    await C.seDeconnecter();
    // Sans session : la requête ne porte ni session ni rien du salon, seulement p_canon.
    expect(await C.pseudoLibreSalon("LEA")).toBe(false);
    const r = srv.requetes.at(-1)!;
    expect(r.path).toBe("/api/compte/pseudo/libre");
    expect(r.headers["X-Shh-Session"]).toBeUndefined();
    expect(r.body).toEqual({ p_canon: "lea" });
    // Sosies (I/l/1, O/0, rn/m, casse) : même clé, donc même réponse.
    for (const p of ["Lea", "lEA", "LeA", "1ea", "Iea"]) expect(await C.pseudoLibreSalon(p), p).toBe(false);
    const n = srv.requetes.length;
    expect(await C.pseudoLibreSalon("Admin")).toBe(false);
    expect(await C.pseudoLibreSalon("ADMlN")).toBe(false);
    expect(srv.requetes.length).toBe(n);
    expect(await C.pseudoLibreSalon("Leo")).toBe(true);
    // Avec la session : son propre pseudo est permis, sans requête.
    await C.seConnecter("Lea.Dupont@exemple.fr", MDP, false);
    const m = srv.requetes.length;
    expect(await C.pseudoLibreSalon(mien.toUpperCase())).toBe(true);
    expect(srv.requetes.length).toBe(m);
  });

  it("serveur sans comptes (404) : libre ; limite (429) et réseau : erreur", async () => {
    configurerFetch(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    expect(await C.pseudoLibreSalon("Leo")).toBe(true);
    configurerFetch(async () => new Response(JSON.stringify({ error: "limit" }), { status: 429 }));
    await expect(C.pseudoLibreSalon("Leo")).rejects.toMatchObject({ status: 429 });
    configurerFetch(async () => {
      throw new TypeError("hors ligne");
    });
    await expect(C.pseudoLibreSalon("Leo")).rejects.toThrow("reseau");
  });

  it("pseudo pris comme invité : retenu en mémoire seulement (rien dans le stockage)", () => {
    C.retenirPseudoInvite("Lucas");
    expect(C.pseudoInviteRetenu()).toBe("Lucas");
    expect(JSON.stringify({ ...localStorage })).not.toContain("Lucas");
  });
});

describe("saisie et état (écrans du lot 10)", () => {
  it("verifierSaisie : erreurs par champ, sans requête, avant tout envoi", async () => {
    expect(await C.verifierSaisie({ email: "Lea@Exemple.fr", mdp: MDP, pseudo: "Lea" })).toEqual({});
    expect(await C.verifierSaisie({ email: "pas une adresse", mdp: MDP, pseudo: "Lea" })).toEqual({ email: "adresse_invalide" });
    expect(await C.verifierSaisie({ email: "léa@exemple.fr" })).toEqual({ email: "adresse_non_ascii" });
    expect(await C.verifierSaisie({ email: "lea@exemple.fr", mdp: "court" })).toEqual({ mdp: "mdp_court" });
    expect(await C.verifierSaisie({ email: "lea@exemple.fr", mdp: "lea@exemple.fr" })).toEqual({ mdp: "mdp_adresse" });
    expect(await C.verifierSaisie({ email: "lea@exemple.fr", pseudo: "a" })).toEqual({ pseudo: "pseudo_longueur" });
    expect(await C.verifierSaisie({ email: "lea@exemple.fr", pseudo: "Admin" })).toEqual({ pseudo: "pseudo_reserve" });
    // Adresse invalide : le mot de passe se vérifie quand même (longueur).
    expect(await C.verifierSaisie({ email: "x", mdp: "court" })).toEqual({ email: "adresse_invalide", mdp: "mdp_court" });
    expect(await C.verifierSaisie({ pseudo: "Lea" })).toEqual({});
    expect(srv.requetes).toEqual([]);
  });

  it("etatCompte : GET /api/compte avec la session ; sans session, erreur", async () => {
    await expect(C.etatCompte()).rejects.toThrow("aucune_session");
    await inscription();
    expect(await C.etatCompte()).toMatchObject({ palier: "neuf", banniJusqu: null });
    expect(srv.requetes.at(-1)!.headers["X-Shh-Session"]).toBeTruthy();
  });
});

describe("connexion et TOTP", () => {
  it("connexion : coffres ouverts ; variante d'adresse acceptée par le même sel", async () => {
    await inscription("lea.dupont@gmail.com");
    await C.seDeconnecter();
    srv.comptes.set("leadupont+x@gmail.com", srv.comptes.get("lea.dupont@gmail.com")!); // le vrai serveur compare e_canon
    await C.seConnecter("LeaDupont+x@GMAIL.com", MDP, false);
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.profil?.pseudo).toBe("Lea");
  });

  it("nom d'appareil : absent de la connexion (K_compte inconnue), posé juste après par sessions/etiquette", async () => {
    await inscription();
    await C.seDeconnecter();
    srv.etiquettes.length = 0;
    await C.seConnecter("lea.dupont@exemple.fr", MDP, false);
    const cx = srv.requetes.find((r) => r.path.endsWith("/connexion"))!;
    expect(cx.body.etiquette).toBe("");
    const et = srv.requetes.filter((r) => r.path.endsWith("sessions/etiquette"));
    expect(et).toHaveLength(1);
    expect(et[0]!.headers["X-Shh-Session"]).toBeTruthy();
    const c = srv.comptes.get("lea.dupont@exemple.fr")!;
    const { kekMdp } = await deriver(MDP, "lea.dupont@exemple.fr");
    const k = await clesDuCompte(await ouvrirEnveloppe(kekMdp, c.h, c.envMdp), c.sProfil);
    expect(await ouvrirEtiquette(k.etiquette, c.h, unb64u(srv.etiquettes[0]!))).toBe("Firefox · ordinateur");
  });

  it("nom d'appareil refusé (réseau, serveur ancien) : la connexion reste ouverte", async () => {
    await inscription();
    await C.seDeconnecter();
    const f = srv.fetch;
    configurerFetch((async (u: string, i: RequestInit) => (u.endsWith("sessions/etiquette") ? new Response('{"error":"not_found"}', { status: 404 }) : f(u, i))) as never);
    await C.seConnecter("lea.dupont@exemple.fr", MDP, false);
    expect(C.account.etat).toBe("ouvert");
  });

  it("mot de passe faux : identifiants, rien d'ouvert", async () => {
    await inscription();
    await C.seDeconnecter();
    await expect(C.seConnecter("lea.dupont@exemple.fr", "mauvais mot de passe", false)).rejects.toMatchObject({ code: "identifiants" });
    expect(C.account.etat).toBe("absent");
  });

  it("étape TOTP : seConnecter rend « totp », validerTotp ouvre", async () => {
    await inscription();
    await C.seDeconnecter();
    srv.comptes.get("lea.dupont@exemple.fr")!.totp = true;
    expect(await C.seConnecter("lea.dupont@exemple.fr", MDP, false)).toBe("totp");
    expect(C.account.etat).toBe("absent");
    await expect(C.validerTotp("111111")).rejects.toMatchObject({ code: "totp_faux" });
    await C.validerTotp("654321");
    expect(C.account.etat).toBe("ouvert");
  });
});

describe("coffres", () => {
  it("ecrireProfil : écrit tout de suite ; fusion si un autre appareil a écrit entre-temps", async () => {
    await inscription();
    const c = srv.comptes.get("lea.dupont@exemple.fr")!;
    // Un autre appareil a écrit (gen 2) : on recopie son coffre tel quel avec un gen plus grand.
    const old = c.coffres.profil.blob;
    await C.ecrireProfil({ langue: "en" });
    expect(c.coffres.profil.gen).toBe(2);
    c.coffres.profil = { blob: old, gen: 1 }; // retour en arrière du serveur
    await expect(C.ecrireProfil({ pseudo: "Zoe" })).rejects.toThrow("coffre_recule");
    expect(C.account.erreur).toBe("coffre_illisible");
  });

  it("ecrirePrive différé : un seul envoi, 2 à 12 min après le premier événement, avec tous les ajouts", async () => {
    await inscription();
    const c = srv.comptes.get("lea.dupont@exemple.fr")!;
    await C.ecrirePrive((p) => ({ ...p, recus: [...p.recus, { id: "r1" }] }), { differe: true });
    await C.ecrirePrive((p) => ({ ...p, recus: [...p.recus, { id: "r2" }] }), { differe: true });
    expect(c.coffres.prive.gen).toBe(1);
    expect(planifies.length).toBe(1);
    expect(planifies[0]!.ms).toBeGreaterThanOrEqual(120_000);
    expect(planifies[0]!.ms).toBeLessThanOrEqual(720_000);
    planifies[0]!.f();
    await vi.waitFor(() => expect(c.coffres.prive.gen).toBe(2));
    expect(C.account.prive?.recus.map((e) => e.id)).toEqual(["r1", "r2"]);
    // Écriture immédiate : part tout de suite.
    await C.ecrirePrive((p) => ({ ...p, salons: [{ id: "s1" }] }), { differe: false });
    expect(c.coffres.prive.gen).toBe(3);
  });

  it("le délai de l'écriture différée est tiré au hasard", async () => {
    await inscription();
    const vus = new Set<number>();
    for (let i = 0; i < 8; i++) {
      await C.ecrirePrive((p) => p, { differe: true });
      vus.add(planifies.at(-1)!.ms);
      planifies.at(-1)!.f();
      await vi.waitFor(() => expect(srv.requetes.at(-1)!.method).toBe("PUT"));
    }
    expect(vus.size).toBeGreaterThan(1);
  });

  it("changerPseudo : p_canon envoyé, puis le profil chiffré porte le nouveau pseudo", async () => {
    await inscription();
    await C.changerPseudo("Zoe");
    expect(srv.requetes.find((r) => r.path.endsWith("/pseudo"))!.body).toEqual({ p_canon: "zoe" });
    expect(C.account.profil?.pseudo).toBe("Zoe");
    expect(srv.comptes.get("lea.dupont@exemple.fr")!.coffres.profil.gen).toBe(2);
  });
});

describe("mot de passe oublié", () => {
  it("profil gardé, coffre privé neuf (gen qui continue), nouveau mot de passe valable", async () => {
    await inscription();
    await C.ecrirePrive((p) => ({ ...p, salons: [{ id: "perdu" }] }), { differe: false });
    await C.seDeconnecter();
    await C.oubli.debut("lea.dupont@exemple.fr", "fr", PREUVE);
    expect(await C.oubli.verifier(CODE, "", false)).toBe("ok");
    await C.oubli.fin("nouveau mot de passe", false);
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.profil?.pseudo).toBe("Lea");
    expect(C.account.prive?.salons).toEqual([]);
    expect(srv.comptes.get("lea.dupont@exemple.fr")!.coffres.prive.gen).toBe(3);
    await C.seDeconnecter();
    await C.seConnecter("lea.dupont@exemple.fr", "nouveau mot de passe", false);
    expect(C.account.etat).toBe("ouvert");
  });
});

describe("session et déconnexion", () => {
  it("par défaut rien n'est écrit dans IndexedDB", async () => {
    await inscription();
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("« Rester connecté » : restaurer après un rechargement rouvre le compte sans mot de passe", async () => {
    await inscription(undefined, true);
    expect([...idb.raw().keys()]).toEqual(["shhdrop-compte"]);
    C._oublierMemoire(); // ce que fait un rechargement de la page
    expect(C.account.etat).toBe("absent");
    await C.restaurer();
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.profil?.pseudo).toBe("Lea");
  });

  it("restaurer avec une session échue : base effacée, état absent", async () => {
    await inscription(undefined, true);
    srv.sessions.clear();
    C._oublierMemoire();
    await C.restaurer();
    expect(C.account.etat).toBe("absent");
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("déconnexion : le serveur oublie la session, shhdrop-compte effacée, K_compte et s_profil mis à zéro", async () => {
    await inscription(undefined, true);
    expect(tires.length).toBeGreaterThanOrEqual(2);
    expect(tires.every((t) => t.some((x) => x !== 0))).toBe(true);
    await C.ecrirePrive((p) => p, { differe: true });
    await C.seDeconnecter();
    expect(srv.sessions.size).toBe(0);
    expect([...idb.raw().keys()]).toEqual([]);
    expect(C.account.etat).toBe("absent");
    expect(C.account.profil).toBeUndefined();
    expect(C.account.prive).toBeUndefined();
    expect(tires.every((t) => t.every((x) => x === 0))).toBe(true);
    expect(planifies[0]!.annule).toBe(true);
  });

  it("déconnexion sans réseau : l'appareil efface quand même tout", async () => {
    await inscription(undefined, true);
    C.configurerCompte({ net: { origin: "https://shh.test", fetch: (async () => Promise.reject(new TypeError("x"))) as unknown as typeof fetch } });
    await C.seDeconnecter();
    expect(C.account.etat).toBe("absent");
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("aucune requête hors de /api/compte/* ; jeton seulement en X-Shh-Session", async () => {
    await inscription(undefined, true);
    await C.ecrireProfil({ langue: "en" });
    await C.seDeconnecter();
    for (const r of srv.requetes) {
      expect(r.path).toMatch(/^\/api\/compte(\/|$)/);
      expect(JSON.stringify(r.body)).not.toMatch(/session/);
    }
  });
});

// Plan du compte, lot 13 : paramètres. Le mot de passe ne quitte jamais l'appareil (seul A_auth
// part) ; l'adresse n'est connue de la page que si elle a été tapée ici (jamais stockée).
describe("paramètres (lot 13)", () => {
  const sansMdp = (...mdps: string[]) => {
    const tout = JSON.stringify(srv.requetes);
    for (const m of mdps) {
      expect(tout).not.toContain(m);
      expect(tout).not.toContain(b64u(new TextEncoder().encode(m)));
    }
  };

  it("confirmerIdentite : A_auth de l'adresse connue ; après un rechargement l'adresse est redemandée, sans requête", async () => {
    await inscription(undefined, true);
    expect(C.adresseConnue()).toBe(true);
    await C.confirmerIdentite(MDP, "");
    const r = srv.requetes.at(-1)!;
    expect([r.path, Object.keys(r.body)]).toEqual(["/api/compte/reauth", ["a_auth", "totp"]]);
    expect(r.body.a_auth).toBe(srv.comptes.get("lea.dupont@exemple.fr")!.aAuth);
    await expect(C.confirmerIdentite("mauvais mot de passe", "")).rejects.toMatchObject({ code: "identifiants" });
    // « Rester connecté » puis rechargement : la page ne connaît plus l'adresse.
    C._oublierMemoire();
    await C.restaurer();
    expect(C.account.etat).toBe("ouvert");
    expect(C.adresseConnue()).toBe(false);
    const n = srv.requetes.length;
    await expect(C.confirmerIdentite(MDP, "")).rejects.toThrow("adresse_requise");
    expect(srv.requetes.length).toBe(n);
    await C.confirmerIdentite(MDP, "", "Lea.Dupont@exemple.fr");
    expect(C.adresseConnue()).toBe(true);
    sansMdp(MDP);
  });

  it("changerMotDePasse : nouvelle enveloppe de K_compte, les autres appareils déconnectés ; refus local avant requête", async () => {
    await inscription();
    const autre = [...srv.sessions.keys()][0]!;
    C._oublierMemoire();
    await C.seConnecter("lea.dupont@exemple.fr", MDP, false);
    expect(srv.sessions.has(autre)).toBe(true);
    const n = srv.requetes.length;
    await expect(C.changerMotDePasse("court")).rejects.toThrow("mdp_court");
    await expect(C.changerMotDePasse("lea.dupont@exemple.fr")).rejects.toThrow("mdp_adresse");
    expect(srv.requetes.length).toBe(n);
    await C.changerMotDePasse("nouveau mot de passe");
    expect(srv.sessions.has(autre)).toBe(false); // le serveur ferme toujours les autres sessions
    expect(C.account.etat).toBe("ouvert");
    const c = srv.comptes.get("lea.dupont@exemple.fr")!;
    const { aAuth, kekMdp } = await deriverCompte("nouveau mot de passe", "lea.dupont@exemple.fr");
    expect(c.aAuth).toBe(b64u(aAuth));
    expect((await ouvrirEnveloppe(kekMdp, c.h, c.envMdp)).length).toBe(32);
    C._oublierMemoire();
    await expect(C.seConnecter("lea.dupont@exemple.fr", MDP, false)).rejects.toMatchObject({ code: "identifiants" });
    await C.seConnecter("lea.dupont@exemple.fr", "nouveau mot de passe", false);
    expect(C.account.profil?.pseudo).toBe("Lea");
    sansMdp(MDP, "nouveau mot de passe");
  });

  it("session plus récente : « recent » passe à l'écran (qui redemande le mot de passe)", async () => {
    await inscription();
    srv.recentes.clear();
    await expect(C.changerMotDePasse("nouveau mot de passe")).rejects.toMatchObject({ code: "recent" });
    await C.confirmerIdentite(MDP, "");
    await C.changerMotDePasse("nouveau mot de passe");
  });

  it("changement d'adresse : adresses exactes, A_auth et enveloppe refaits avec le sel de la nouvelle ; connexion par la nouvelle", async () => {
    await inscription();
    await C.confirmerIdentite(MDP, "", "lea.dupont@exemple.fr");
    await C.changementAdresse.debut("Lea.Nouvelle+x@Exemple.fr", "fr");
    const d = srv.requetes.at(-1)!;
    expect(d.body).toEqual({ email_actuel: "lea.dupont@exemple.fr", email_nouveau: "lea.nouvelle+x@exemple.fr", langue: "fr" });
    await C.renvoyerCode();
    expect(srv.requetes.at(-1)!.body).toMatchObject({ email: "lea.nouvelle+x@exemple.fr" });
    await expect(C.changementAdresse.fin("000000", MDP, "")).rejects.toMatchObject({ code: "code_faux" });
    await C.changementAdresse.fin(CODE, MDP, "");
    const f = srv.requetes.at(-1)!;
    expect(Object.keys(f.body)).toEqual(["etape", "code", "a_auth", "env_mdp", "totp"]);
    const { aAuth } = await deriverCompte(MDP, "lea.nouvelle@exemple.fr"); // sel : adresse canonique
    expect(f.body.a_auth).toBe(b64u(aAuth));
    C._oublierMemoire();
    await C.seConnecter("lea.nouvelle+x@exemple.fr", MDP, false);
    expect(C.account.etat).toBe("ouvert");
    sansMdp(MDP);
  });

  it("double authentification : lien d'ajout sans adresse ni pseudo ; activation par le premier code ; retrait", async () => {
    await inscription();
    const r = await C.totpCommencer();
    expect(r.secret).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
    expect(r.lien).toBe("otpauth://totp/Shhgone?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Shhgone&algorithm=SHA1&digits=6&period=30");
    await expect(C.totpActiver("000000")).rejects.toMatchObject({ code: "totp_faux" });
    await C.totpActiver("654321");
    expect(srv.comptes.get("lea.dupont@exemple.fr")!.totp).toBe(true);
    expect(srv.requetes.at(-1)!.body).toEqual({ etape: expect.any(String), code: "654321" });
    await expect(C.confirmerIdentite(MDP, "")).rejects.toMatchObject({ code: "totp_requis" });
    await C.confirmerIdentite(MDP, "654321");
    await C.totpRetirer();
    expect(srv.comptes.get("lea.dupont@exemple.fr")!.totp).toBe(false);
    await C.totpAnnulerRetrait();
    expect(srv.requetes.at(-1)!.path).toBe("/api/compte/totp/annuler-retrait");
  });

  it("appareils : noms déchiffrés sur l'appareil, « cet appareil » ; déconnecter un appareil ou tous les autres", async () => {
    await inscription();
    C._oublierMemoire();
    await C.seConnecter("lea.dupont@exemple.fr", MDP, false);
    const l = await C.appareils();
    expect(l).toHaveLength(2);
    expect(l.map((a) => a.nom)).toEqual(["Firefox · ordinateur", "Firefox · ordinateur"]);
    expect(l.filter((a) => a.courante)).toHaveLength(1);
    const autre = l.find((a) => !a.courante)!;
    await C.deconnecterAppareil(autre.sid);
    expect(srv.requetes.at(-1)!.body).toEqual({ sid: autre.sid });
    expect(await C.appareils()).toHaveLength(1);
    await C.deconnecterAutres();
    expect(srv.requetes.at(-1)!.body).toEqual({ autres: true });
  });

  it("export : données du serveur, profil et listes, sans adresse, sans jeton ni secret de lien", async () => {
    await inscription(undefined, false, profil({ photo: new Uint8Array([1, 2, 3]) }));
    const gestion = "https://shh.test/#m" + "G".repeat(43);
    const lien = "https://shh.test/#" + "L".repeat(43);
    await C.ecrirePrive((p) => ({ ...p, envois: [{ id: "e1", cree: 1, expire: 2, gestion, taille: 10, elements: 1, ouvertures_max: 1 }], recus: [{ id: "r1", cree: 1, expire: 2, lien, taille: 5, elements: 1, format: "pdf" }] }), { differe: false });
    const texte = await C.exporterDonnees();
    const j = JSON.parse(texte);
    expect(j.serveur).toMatchObject({ cree_le: "2026-11-14", anciennete_depuis: "2026-11-14", salons_actifs: 1 });
    expect(j.profil).toMatchObject({ pseudo: "Lea", photo: b64u(new Uint8Array([1, 2, 3])), langue: "fr" });
    expect(j.listes.envois).toEqual([{ cree: 1, expire: 2, taille: 10, elements: 1, ouvertures_max: 1 }]);
    expect(j.listes.recus).toEqual([{ cree: 1, expire: 2, taille: 5, elements: 1, format: "pdf" }]);
    for (const x of ["lea.dupont", "exemple.fr", "G".repeat(43), "L".repeat(43), "#m", ...srv.sessions.keys()]) expect(texte).not.toContain(x);
  });

  it("réglages de confidentialité écrits dans le coffre de profil ; « Garder les liens » suit sur l'appareil", async () => {
    const regler = vi.fn();
    C.configurerCompte({ historique: { lister: async () => [], importer: async () => undefined, retirer: async () => undefined, retirerCompte: async () => undefined, ecouter: () => () => undefined, regler } });
    await inscription();
    await C.ecrireProfil({ reglages: { ...REGLAGES_DEFAUT, garderRecus: false } });
    expect(regler).toHaveBeenLastCalledWith({ keepReceived: false });
    const c = srv.comptes.get("lea.dupont@exemple.fr")!;
    const k = await clesDuCompte(await ouvrirEnveloppe((await deriverCompte(MDP, "lea.dupont@exemple.fr")).kekMdp, c.h, c.envMdp), c.sProfil);
    expect(profilDeJson(await ouvrir("profil", k.profil, c.h, c.coffres.profil.blob, c.coffres.profil.gen)).reglages.garderRecus).toBe(false);
  });

  it("suppression : après confirmation d'identité, le serveur efface le compte ; l'appareil l'oublie, l'écran de fin reste (account.supprime)", async () => {
    const effacerAppareil = vi.fn(async () => undefined);
    const detruirePartage = vi.fn(async () => undefined);
    C.configurerCompte({ effacerAppareil, detruirePartage });
    await inscription(undefined, true);
    const gestion = "https://shh.test/#m" + "G".repeat(42) + "A";
    await C.ecrirePrive((p) => ({ ...p, envois: [{ id: "e1", cree: 1, expire: Date.now() + 60_000, gestion, taille: 1, elements: 1, ouvertures_max: 1 }] }), { differe: false });
    expect(await C.partagesASupprimer()).toBe(1);
    await C.confirmerIdentite(MDP, "");
    const etapes: string[] = [];
    for await (const p of C.supprimerTout({ effacerAppareil: true })) etapes.push(p.etape);
    expect(etapes).toEqual(["partages", "partages", "compte", "fini"]);
    expect(detruirePartage).toHaveBeenCalledWith(gestion);
    expect(effacerAppareil).toHaveBeenCalled();
    expect(srv.comptes.size).toBe(0);
    expect(C.account.etat).toBe("absent");
    expect(C.account.supprime).toBe(true);
    expect([...idb.raw().keys()]).toEqual([]);
    sansMdp(MDP);
  });

  it("« Rester connecté » coupé sur cet appareil : la copie gardée est effacée, la session reste ouverte", async () => {
    await inscription(undefined, true);
    expect(C.account.persistante).toBe(true);
    expect([...idb.raw().keys()].length).toBeGreaterThan(0);
    await C.arreterResterConnecte();
    expect(C.account.persistante).toBe(false);
    expect([...idb.raw().keys()]).toEqual([]);
    expect(C.account.etat).toBe("ouvert");
    await C.ecrireProfil({ langue: "en" }); // aucune nouvelle copie gardée
    expect([...idb.raw().keys()]).toEqual([]);
  });
});

describe("déconnexion (audit du 18 novembre)", () => {
  it("part avec keepalive ; sans réseau, réessayée jusqu'à ce que le serveur réponde ; jamais réécrite sur l'appareil", async () => {
    await inscription();
    const f = srv.fetch;
    let tentatives = 0;
    const vues: RequestInit[] = [];
    configurerFetch((async (u: string, i: RequestInit) => {
      if (u.endsWith("/deconnexion")) {
        vues.push(i);
        if (++tentatives < 3) throw new TypeError("réseau");
      }
      return f(u, i);
    }) as never);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const p = C.seDeconnecter();
      await vi.advanceTimersByTimeAsync(20_000);
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(C.account.etat).toBe("absent");
    expect(tentatives).toBe(3);
    expect(vues.every((i) => i.keepalive === true)).toBe(true);
  });

  it("autre onglet : un signal de déconnexion efface la mémoire du compte ici ; aucun secret sur le canal", async () => {
    await inscription();
    expect(C.account.etat).toBe("ouvert");
    const arret = C.ecouterAutresOnglets();
    const vus: unknown[] = [];
    const espion = new BroadcastChannel("shh-compte-onglets");
    espion.onmessage = (e) => vus.push(e.data);
    try {
      const autre = new BroadcastChannel("shh-compte-onglets");
      autre.postMessage("deconnexion");
      autre.close();
      await vi.waitFor(() => expect(C.account.etat).toBe("absent"));
      expect(vus).toEqual(["deconnexion"]);
    } finally {
      arret();
      espion.close();
    }
  });
});

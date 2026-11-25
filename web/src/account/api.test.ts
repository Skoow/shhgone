// Couche HTTP du compte (conception compte §8.6 ; conception du compte par passkey §6.4) : routes
// /api/compte/* seulement, jeton de session dans X-Shh-Session et nulle part ailleurs (§8.5),
// aucun secret dans l'URL, JSON strict sans null, credential toujours SANS sortie PRF.
import { describe, expect, it } from "vitest";
import * as A from "./api";
import { b64u } from "../engine/pure";

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown; init: RequestInit };

const B = (n: number, v = 1) => new Uint8Array(n).fill(v);
const S = (n: number, v = 1) => b64u(B(n, v));
const JETON = S(32, 9);
const OPTS = { challenge: S(32), rpId: "shh.test" };
const CEREMONIE = { etape: S(32, 4), options: OPTS };
const COFFRES = { blob_profil: S(4141, 6), gen_profil: 1, blob_prive: S(4141, 7), gen_prive: 2 };
const OUV = { session: S(32, 2), h: S(16, 3), cred_id: S(20, 5), enveloppes: [S(60, 4), S(60, 8)], ...COFFRES };
const RECUP = { session: S(32, 2), h: S(16, 3), env_r: S(60, 4), ...COFFRES };
/** Credential tel qu'un gestionnaire non conforme le rendrait : la sortie PRF doit être retirée. */
const CRED = { id: S(20, 5), rawId: S(20, 5), type: "public-key", response: { clientDataJSON: S(10) }, clientExtensionResults: { prf: { enabled: true, results: { first: S(32, 0xee) } }, hmacGetSecret: { output1: S(32, 0xee) } } };
const CRED_NET = { ...CRED, clientExtensionResults: { prf: { enabled: true } } };
const SORTIE = S(32, 0xee);

const ETAT = { h: S(16, 3), cree_le: "2026-11-14", palier: "neuf", confirme_le: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, salons_actifs: 0, banni: false, banni_id: null, banni_jusqu: null, banni_motif: null };

function net(reply: (s: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const s: Seen = { method: init.method ?? "GET", url, headers: { ...(init.headers as Record<string, string>) }, body: init.body === undefined ? undefined : JSON.parse(init.body as string), init };
    seen.push(s);
    return reply(s);
  }) as unknown as typeof globalThis.fetch;
  return { n: { origin: "https://shh.test", fetch } as A.Net, seen };
}
const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

/** Chaque fonction de l'API, sa route, son corps exact, et la réponse que le serveur donne. */
const CALLS: [string, (n: A.Net) => Promise<unknown>, string, unknown, unknown][] = [
  ["inscriptionDebut", (n) => A.inscriptionDebut(n, { altcha: "x", hp: "", shown_at: "t" }), "POST inscription/debut", { altcha: "x", hp: "", shown_at: "t" }, CEREMONIE],
  [
    "inscriptionFin",
    (n) => A.inscriptionFin(n, { etape: S(32), credential: CRED, pCanon: "lea", env: null, vR: B(32), envR: B(60), blobProfil: B(4141), blobPrive: B(4141), persistante: false, etiquette: B(64), credEtiquette: null }),
    "POST inscription/fin",
    { etape: S(32), credential: CRED_NET, p_canon: "lea", env: "", v_r: S(32), env_r: S(60), blob_profil: S(4141), blob_prive: S(4141), persistante: false, etiquette: S(64), cred_etiquette: "" },
    { session: S(32), h: S(16) },
  ],
  ["connexionDebut", (n) => A.connexionDebut(n), "POST connexion/debut", {}, CEREMONIE],
  ["connexionFin", (n) => A.connexionFin(n, { etape: S(32), credential: CRED, persistante: true, etiquette: null }), "POST connexion/fin", { etape: S(32), credential: CRED_NET, persistante: true, etiquette: "" }, OUV],
  ["recup", (n) => A.recup(n, { aR: B(32, 2), persistante: false, etiquette: null }), "POST recup", { a_r: S(32, 2), persistante: false, etiquette: "" }, RECUP],
  ["reauthDebut", (n) => A.reauthDebut(n, JETON), "POST reauth/debut", {}, CEREMONIE],
  ["reauthFin", (n) => A.reauthFin(n, JETON, S(32), CRED), "POST reauth/fin", { etape: S(32), credential: CRED_NET }, { enveloppes: [] }],
  ["passkeys", (n) => A.passkeys(n, JETON), "GET passkeys", undefined, { passkeys: [{ cred_id: S(20), ajoutee: "2026-11", etiquette: "", be: false, prf: true }] }],
  ["passkeysDebut", (n) => A.passkeysDebut(n, JETON), "POST passkeys/debut", {}, CEREMONIE],
  ["passkeysFin", (n) => A.passkeysFin(n, JETON, { etape: S(32), credential: CRED, env: B(60), etiquette: B(64) }), "POST passkeys/fin", { etape: S(32), credential: CRED_NET, env: S(60), etiquette: S(64) }, {}],
  ["passkeysEnveloppe", (n) => A.passkeysEnveloppe(n, JETON, B(60)), "POST passkeys/enveloppe", { env: S(60) }, {}],
  ["passkeysNommer", (n) => A.passkeysNommer(n, JETON, B(20), B(64)), "POST passkeys/nommer", { cred_id: S(20), etiquette: S(64) }, {}],
  ["passkeysRetirer", (n) => A.passkeysRetirer(n, JETON, B(20)), "POST passkeys/retirer", { cred_id: S(20) }, {}],
  ["recupRenouveler", (n) => A.recupRenouveler(n, JETON, B(32), B(60)), "POST recup/renouveler", { v_r: S(32), env_r: S(60) }, {}],
  ["lireCoffre", (n) => A.lireCoffre(n, JETON, "prive"), "GET coffre/prive", undefined, { blob: S(4141), gen: 3 }],
  ["ecrireCoffre", (n) => A.ecrireCoffre(n, JETON, "profil", 3, B(4141)), "PUT coffre/profil", { if_gen: 3, blob: S(4141) }, { gen: 4 }],
  ["pseudoVerifier", (n) => A.pseudoVerifier(n, { jeton: JETON }, "lea"), "POST pseudo/verifier", { p_canon: "lea" }, { libre: true }],
  ["pseudoVerifier (étape)", (n) => A.pseudoVerifier(n, { etape: S(32) }, "lea"), "POST pseudo/verifier", { etape: S(32), p_canon: "lea" }, { libre: false }],
  ["changerPseudo", (n) => A.changerPseudo(n, JETON, "lea"), "POST pseudo", { p_canon: "lea" }, {}],
  ["deconnexion", (n) => A.deconnexion(n, JETON), "POST deconnexion", {}, {}],
  ["etiquetterSession", (n) => A.etiquetterSession(n, JETON, B(64)), "POST sessions/etiquette", { etiquette: S(64) }, {}],
  ["etat", (n) => A.etat(n, JETON), "GET ", undefined, ETAT],
  ["sessions", (n) => A.sessions(n, JETON), "GET sessions", undefined, { sessions: [{ sid: S(16), ajoutee: "2026-11", etiquette: S(64), courante: true, persistante: false, par_recup: false }] }],
  ["fermerSession", (n) => A.fermerSession(n, JETON, { sid: S(16) }), "POST sessions/fermer", { sid: S(16) }, {}],
  ["fermerAutres", (n) => A.fermerSession(n, JETON, { autres: true }), "POST sessions/fermer", { autres: true }, {}],
  ["exporter", (n) => A.exporter(n, JETON), "GET export", undefined, { cree_le: "2026-11-14", anciennete_depuis: "2026-11-14", vu_mois: "2026-11", banni_jusqu: null, banni_motif: null, salons_actifs: 1, sessions: [{ ajoutee: "2026-11", persistante: true, par_recup: true }], passkeys: [{ ajoutee: "2026-11", be: true, prf: false, cle_pub: S(77) }] }],
  ["supprimer", (n) => A.supprimer(n, JETON), "POST supprimer", {}, { salons_fermes: 2 }],
];
const SANS_SESSION = new Set(["inscriptionDebut", "inscriptionFin", "connexionDebut", "connexionFin", "recup", "pseudoVerifier (étape)"]);

describe("routes et en-têtes", () => {
  it("toutes les requêtes vont à /api/compte*, méthode, chemin et corps exacts, même origine, sans redirection, rien dans l'URL, aucun null", async () => {
    for (const [name, call, route, corps, res] of CALLS) {
      const { n, seen } = net(() => ok(res, name === "inscriptionFin" ? 201 : 200));
      await call(n);
      expect(seen.length, name).toBe(1);
      const s = seen[0]!;
      expect(`${s.method} ${s.url.replace(/^https:\/\/shh\.test\/api\/compte\/?/, "")}`, name).toBe(route);
      expect(s.url, name).not.toContain("?");
      expect(s.init.credentials, name).toBe("same-origin");
      expect(s.init.redirect, name).toBe("error");
      expect(s.body, name).toEqual(corps);
      expect(JSON.stringify(s.body ?? {}), name).not.toContain("null");
      expect(JSON.stringify(s.body ?? {}), name).not.toContain("=");
    }
  });

  it("sortie PRF et hmac-secret : jamais dans une requête, même si le credential les porte", async () => {
    for (const [name, call, , , res] of CALLS) {
      const { n, seen } = net(() => ok(res, name === "inscriptionFin" ? 201 : 200));
      await call(n);
      const t = JSON.stringify(seen[0]!.body ?? {});
      expect(t, name).not.toContain(SORTIE);
      expect(t, name).not.toMatch(/"results"|hmacGetSecret/);
    }
  });

  it("X-Shh-Session seulement sur les routes de session, avec le jeton exact", async () => {
    for (const [name, call, , , res] of CALLS) {
      const { n, seen } = net(() => ok(res));
      await call(n);
      const h = seen[0]!.headers;
      if (SANS_SESSION.has(name)) expect(Object.keys(h).filter((k) => k.toLowerCase() === "x-shh-session"), name).toEqual([]);
      else expect(h["X-Shh-Session"], name).toBe(JETON);
    }
  });

  it("enveloppe de taille fausse : refusée avant la requête", async () => {
    const { n, seen } = net(() => ok({}));
    await expect(A.passkeysEnveloppe(n, JETON, B(59))).rejects.toThrow("enveloppe_invalide");
    expect(seen).toEqual([]);
  });
});

describe("réponses", () => {
  it("cérémonie : étape de 32 octets et options (objet) ; sinon reponse_invalide", async () => {
    expect(await A.connexionDebut(net(() => ok(CEREMONIE)).n)).toEqual({ etape: S(32, 4), options: OPTS });
    for (const bad of [{ etape: S(31), options: OPTS }, { etape: S(32), options: null }, { etape: S(32), options: [] }, { etape: S(32) }])
      await expect(A.connexionDebut(net(() => ok(bad)).n)).rejects.toThrow("reponse_invalide");
  });

  it("connexion : session, h, passkey, 0 à 4 enveloppes de 60 octets, coffres", async () => {
    const o = await A.connexionFin(net(() => ok(OUV)).n, { etape: S(32), credential: CRED, persistante: false, etiquette: null });
    expect(o).toEqual({ session: S(32, 2), h: B(16, 3), credId: B(20, 5), enveloppes: [B(60, 4), B(60, 8)], blobProfil: B(4141, 6), genProfil: 1, blobPrive: B(4141, 7), genPrive: 2 });
    for (const bad of [{ ...OUV, enveloppes: [S(59)] }, { ...OUV, enveloppes: [S(60), S(60), S(60), S(60), S(60)] }, { ...OUV, enveloppes: null }, { ...OUV, cred_id: "" }, { ...OUV, h: S(15) }])
      await expect(A.connexionFin(net(() => ok(bad)).n, { etape: S(32), credential: CRED, persistante: false, etiquette: null })).rejects.toThrow("reponse_invalide");
  });

  it("recup : Env_r de 60 octets ; passkeys : libellé de 64 octets ou aucun", async () => {
    expect(await A.recup(net(() => ok(RECUP)).n, { aR: B(32), persistante: false, etiquette: null })).toMatchObject({ envR: B(60, 4), h: B(16, 3) });
    await expect(A.recup(net(() => ok({ ...RECUP, env_r: S(61) })).n, { aR: B(32), persistante: false, etiquette: null })).rejects.toThrow("reponse_invalide");
    expect(await A.passkeys(net(() => ok({ passkeys: [{ cred_id: S(20), ajoutee: "2026-11", etiquette: S(64, 2), be: true, prf: false }] })).n, JETON)).toEqual([{ credId: B(20), ajoutee: "2026-11", etiquette: B(64, 2), be: true, prf: false }]);
    for (const bad of [{ passkeys: [{ cred_id: S(20), ajoutee: "2026-11", etiquette: S(63), be: true, prf: false }] }, { passkeys: [{ cred_id: S(20), ajoutee: "2026-11-02", etiquette: "", be: true, prf: false }] }, { passkeys: [{ cred_id: S(20), ajoutee: "2026-11", etiquette: "", be: "oui", prf: false }] }, { passkeys: {} }])
      await expect(A.passkeys(net(() => ok(bad)).n, JETON)).rejects.toThrow("reponse_invalide");
  });

  it("appareils, export et suppression décodés ; forme stricte", async () => {
    const ss = await A.sessions(net(() => ok({ sessions: [{ sid: S(16, 7), ajoutee: "2026-11", etiquette: S(64, 8), courante: true, persistante: false, par_recup: true }, { sid: S(16, 9), ajoutee: "2026-10", etiquette: "", courante: false, persistante: true, par_recup: false }] })).n, JETON);
    expect(ss).toEqual([
      { sid: S(16, 7), ajoutee: "2026-11", etiquette: B(64, 8), courante: true, persistante: false, parRecup: true },
      { sid: S(16, 9), ajoutee: "2026-10", etiquette: null, courante: false, persistante: true, parRecup: false },
    ]);
    for (const bad of [{ sessions: [{ sid: S(15), ajoutee: "2026-11", etiquette: "", courante: true, persistante: false, par_recup: false }] }, { sessions: [{ sid: S(16), ajoutee: "2026-11", etiquette: "", courante: true, persistante: false }] }, { sessions: "x" }])
      await expect(A.sessions(net(() => ok(bad)).n, JETON)).rejects.toThrow("reponse_invalide");
    const x = await A.exporter(net(() => ok(CALLS.find((c) => c[0] === "exporter")![4])).n, JETON);
    expect(x).toEqual({ creeLe: "2026-11-14", ancienneteDepuis: "2026-11-14", vuMois: "2026-11", banniJusqu: null, banniMotif: null, salonsActifs: 1, sessions: [{ ajoutee: "2026-11", persistante: true, parRecup: true }], passkeys: [{ ajoutee: "2026-11", be: true, prf: false, clePub: S(77) }] });
    expect(await A.supprimer(net(() => ok({ salons_fermes: 3 })).n, JETON)).toEqual({ salonsFermes: 3 });
    await expect(A.supprimer(net(() => ok({ salons_fermes: -1 })).n, JETON)).rejects.toThrow("reponse_invalide");
  });

  it("GET /api/compte : état décodé (dates ou null, motif, identifiant de bannissement), forme stricte", async () => {
    expect(await A.etat(net(() => ok(ETAT)).n, JETON)).toEqual({ creeLe: "2026-11-14", palier: "neuf", confirmeLe: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, surMesure: false, salonsActifs: 0, banniId: null, banniJusqu: null, banniMotif: null });
    const banni = await A.etat(net(() => ok({ ...ETAT, banni: true, banni_id: "B-ABCD-EFGH-JKMNP", banni_jusqu: "2029-11-14", banni_motif: 6 })).n, JETON);
    expect(banni).toMatchObject({ banniId: "B-ABCD-EFGH-JKMNP", banniJusqu: "2029-11-14", banniMotif: 6 });
    expect(await A.etat(net(() => ok({ ...ETAT, sur_mesure: true, limites: { salons: 2, places: 50, heures: 720 } })).n, JETON)).toMatchObject({ surMesure: true, limites: { salons: 2, places: 50, heures: 720 } });
    for (const bad of [{ ...ETAT, banni_jusqu: 3 }, { ...ETAT, banni_motif: 11 }, { ...ETAT, palier: "or" }, { ...ETAT, banni_id: "X" }])
      await expect(A.etat(net(() => ok(bad)).n, JETON)).rejects.toThrow("reponse_invalide");
  });

  it("réponse mal formée (taille, type) : reponse_invalide", async () => {
    await expect(A.lireCoffre(net(() => ok({ blob: S(10), gen: "3" })).n, JETON, "prive")).rejects.toThrow("reponse_invalide");
    await expect(A.inscriptionDebut(net(() => new Response("pas du json")).n, { altcha: "", hp: "", shown_at: "" })).rejects.toThrow("reponse_invalide");
  });

  it("erreurs du serveur : code, date, gen, Retry-After", async () => {
    const err = async (r: Response) => {
      try {
        await A.lireCoffre(net(() => r).n, JETON, "prive");
      } catch (e) {
        return e as A.CompteError;
      }
      throw new Error("pas d'erreur");
    };
    const id = await err(ok({ error: "identifiants" }, 403));
    expect([id.status, id.code]).toEqual([403, "identifiants"]);
    expect(id).toBeInstanceOf(A.CompteError);
    expect((await err(ok({ error: "banni", jusqu: "2026-11-21" }, 403))).jusqu).toBe("2026-11-21");
    expect((await err(ok({ error: "conflict", gen: 7 }, 409))).gen).toBe(7);
    const lim = await err(new Response(JSON.stringify({ error: "limit" }), { status: 429, headers: { "Retry-After": "120" } }));
    expect([lim.code, lim.retryAfterS]).toEqual(["limit", 120]);
    expect((await err(new Response("", { status: 401 }))).code).toBe("http_401");
  });

  it("coupure réseau : Error(\"reseau\"), sans nouvel essai", async () => {
    let n = 0;
    const f = (async () => (n++, Promise.reject(new TypeError("failed")))) as unknown as typeof fetch;
    await expect(A.deconnexion({ origin: "https://shh.test", fetch: f }, JETON)).rejects.toThrow("reseau");
    expect(n).toBe(1);
  });
});

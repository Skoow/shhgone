// Couche HTTP du compte (conception compte §8.6, §21.6.2 ; serveur : server/internal/api/
// handlers_compte.go). SEUL fichier du compte qui fait des requêtes, et seul fichier du site qui
// écrit l'en-tête X-Shh-Session (source-rules.test.ts) :
// - toutes les routes sont sous /api/compte/ ; le jeton de session ne part vers aucune autre route
//   (ni /api/shares, ni /api/manage, ni les autres routes du salon), sauf POST /api/salons, la
//   création d'un salon (creerSalon, conception §10.4 ; écrans du salon) ;
// - JSON strict : clés exactes, jamais `null` (le serveur le refuse), secrets en base64url sans
//   bourrage ; rien dans l'URL ; sans cookie (credentials: "omit"), sans redirection ;
// - un seul essai : aucune route du compte n'est rejouée d'elle-même (une écriture de
//   coffre ou une connexion ne se renvoient qu'à la demande de l'écran).
// Erreurs : CompteError (code du serveur, date, gen, Retry-After) ; coupure
// réseau : Error("reseau") ; réponse 2xx mal formée : Error("reponse_invalide").
import { b64u, unb64u } from "../engine/pure";
import { sansSortiePrf } from "./webauthn";

export type Net = { origin: string; fetch: typeof fetch };

/** Le serveur du site (même origine) et le fetch du navigateur. */
export function netParDefaut(): Net {
  return { origin: globalThis.location?.origin ?? "", fetch: (...a) => globalThis.fetch(...a) };
}

export class CompteError extends Error {
  readonly jusqu?: string;
  readonly gen?: number;
  readonly retryAfterS?: number;
  /** Refus `palier` d'une création de salon (409) : limites du palier du compte. */
  readonly palier?: { salons: number; places: number; heures: number };
  constructor(
    readonly status: number,
    readonly code: string,
    extra: { jusqu?: string; gen?: number; retryAfterS?: number; palier?: { salons: number; places: number; heures: number } } = {},
  ) {
    super(code);
    Object.assign(this, extra);
  }
}

const invalide = () => new Error("reponse_invalide");
type Obj = Record<string, unknown>;
type Bytes = Uint8Array<ArrayBuffer>;

/** Octets en base64url de longueur exacte (`n`), ou de toute longueur (`n` absent). */
function octets(o: Obj, k: string, n?: number): Bytes {
  const v = o[k];
  if (typeof v !== "string") throw invalide();
  let b: Bytes;
  try {
    b = unb64u(v);
  } catch {
    throw invalide();
  }
  if (n !== undefined && b.length !== n) throw invalide();
  return b;
}
function entier(o: Obj, k: string): number {
  const v = o[k];
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalide();
  return v as number;
}
/** Jeton de session ou d'étape : 32 octets, gardé tel quel (base64url, 43 caractères). */
function jeton(o: Obj, k: string): string {
  octets(o, k, 32);
  return o[k] as string;
}

async function erreur(r: Response): Promise<CompteError> {
  let j: Obj = {};
  try {
    const v: unknown = await r.json();
    if (typeof v === "object" && v !== null) j = v as Obj;
  } catch {
    // corps absent ou non JSON
  }
  const int = (x: unknown) => (Number.isSafeInteger(x) ? (x as number) : undefined);
  const ra = r.headers.get("Retry-After")?.trim() ?? "";
  return new CompteError(r.status, typeof j.error === "string" ? j.error : `http_${r.status}`, {
    jusqu: typeof j.jusqu === "string" ? j.jusqu : undefined,
    gen: int(j.gen),
    retryAfterS: int(j.retry_after_s) ?? (/^\d{1,9}$/.test(ra) ? Number(ra) : undefined),
    palier:
      j.error === "palier" && int(j.salons) !== undefined && int(j.places) !== undefined && int(j.heures) !== undefined
        ? { salons: j.salons as number, places: j.places as number, heures: j.heures as number }
        : undefined,
  });
}

async function appel(n: Net, method: "GET" | "POST" | "PUT", route: string, opts: { session?: string; body?: Obj; keepalive?: boolean } = {}): Promise<Obj> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.session !== undefined) headers["X-Shh-Session"] = opts.session;
  let r: Response;
  try {
    r = await n.fetch(`${n.origin}/api/compte${route === "" ? "" : "/" + route}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
  } catch {
    throw new Error("reseau");
  }
  if (!r.ok) throw await erreur(r);
  let t: string;
  try {
    t = await r.text();
  } catch {
    throw new Error("reseau");
  }
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalide();
    return v as Obj;
  } catch {
    throw invalide();
  }
}

// --- Inscription (conception du compte par passkey §6.4) ------------------------------------------

/** Preuve anti-robot ALTCHA (mêmes champs que POST /api/shares). */
export type Preuve = { altcha: string; hp: string; shown_at: string };

/** Options WebAuthn (JSON niveau 3) et étape qui porte le défi (5 min, usage unique). */
export type Ceremonie = { etape: string; options: Obj };

function ceremonie(o: Obj): Ceremonie {
  const opts = o.options;
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) throw invalide();
  return { etape: jeton(o, "etape"), options: opts as Obj };
}

/** Rien de la sortie PRF ne part : credential nettoyé ici aussi (webauthn.ts l'a déjà fait). */
const cred = (c: Obj) => sansSortiePrf(c);
const opt = (b: Bytes | null) => (b === null ? "" : b64u(b));

export async function inscriptionDebut(n: Net, p: Preuve): Promise<Ceremonie> {
  return ceremonie(await appel(n, "POST", "inscription/debut", { body: { altcha: p.altcha, hp: p.hp, shown_at: p.shown_at } }));
}

export type FinInscription = {
  etape: string;
  credential: Obj;
  pCanon: string;
  /** Enveloppe PRF de la passkey (60 octets) ou null (passkey sans PRF). */
  env: Bytes | null;
  vR: Bytes;
  envR: Bytes;
  blobProfil: Bytes;
  blobPrive: Bytes;
  persistante: boolean;
  /** Nom d'appareil chiffré (64 octets) ou null. */
  etiquette: Bytes | null;
  /** Libellé de la passkey chiffré (64 octets) ou null. */
  credEtiquette: Bytes | null;
};

export async function inscriptionFin(n: Net, b: FinInscription): Promise<{ session: string; h: Bytes }> {
  const o = await appel(n, "POST", "inscription/fin", {
    body: {
      etape: b.etape,
      credential: cred(b.credential),
      p_canon: b.pCanon,
      env: opt(b.env),
      v_r: b64u(b.vR),
      env_r: b64u(b.envR),
      blob_profil: b64u(b.blobProfil),
      blob_prive: b64u(b.blobPrive),
      persistante: b.persistante,
      etiquette: opt(b.etiquette),
      cred_etiquette: opt(b.credEtiquette),
    },
  });
  return { session: jeton(o, "session"), h: octets(o, "h", 16) };
}

// --- Connexion, récupération -------------------------------------------------------------------

/** Enveloppes PRF d'une passkey : 0 à 4, 60 octets chacune. */
function enveloppes(o: Obj, k: string): Bytes[] {
  const l = o[k];
  if (!Array.isArray(l) || l.length > 4) throw invalide();
  return l.map((_, i) => octets(l as unknown as Obj, String(i), 60));
}

export async function connexionDebut(n: Net): Promise<Ceremonie> {
  return ceremonie(await appel(n, "POST", "connexion/debut", { body: {} }));
}

/** Ce que rend une connexion par passkey : enveloppes PRF de la passkey qui a signé (0 à 4). */
export type Ouverture = { session: string; h: Bytes; credId: Bytes; enveloppes: Bytes[]; blobProfil: Bytes; genProfil: number; blobPrive: Bytes; genPrive: number };

export async function connexionFin(n: Net, b: { etape: string; credential: Obj; persistante: boolean; etiquette: Bytes | null }): Promise<Ouverture> {
  const o = await appel(n, "POST", "connexion/fin", { body: { etape: b.etape, credential: cred(b.credential), persistante: b.persistante, etiquette: opt(b.etiquette) } });
  const id = octets(o, "cred_id");
  if (id.length < 1 || id.length > 1023) throw invalide();
  return {
    session: jeton(o, "session"),
    h: octets(o, "h", 16),
    credId: id,
    enveloppes: enveloppes(o, "enveloppes"),
    blobProfil: octets(o, "blob_profil"),
    genProfil: entier(o, "gen_profil"),
    blobPrive: octets(o, "blob_prive"),
    genPrive: entier(o, "gen_prive"),
  };
}

/** Par la clé de récupération : A_r seulement (jamais R ni KEK_r) ; session récente, marquée « par la clé ». */
export type OuvertureRecup = { session: string; h: Bytes; envR: Bytes; blobProfil: Bytes; genProfil: number; blobPrive: Bytes; genPrive: number };

export async function recup(n: Net, b: { aR: Bytes; persistante: boolean; etiquette: Bytes | null }): Promise<OuvertureRecup> {
  const o = await appel(n, "POST", "recup", { body: { a_r: b64u(b.aR), persistante: b.persistante, etiquette: opt(b.etiquette) } });
  return {
    session: jeton(o, "session"),
    h: octets(o, "h", 16),
    envR: octets(o, "env_r", 60),
    blobProfil: octets(o, "blob_profil"),
    genProfil: entier(o, "gen_profil"),
    blobPrive: octets(o, "blob_prive"),
    genPrive: entier(o, "gen_prive"),
  };
}

// --- Réauthentification, passkeys, clé de récupération (session) ------------------------------

export async function reauthDebut(n: Net, session: string): Promise<Ceremonie> {
  return ceremonie(await appel(n, "POST", "reauth/debut", { session, body: {} }));
}

/** Session récente (5 min), liée à la passkey qui a signé ; rend ses enveloppes PRF. */
export async function reauthFin(n: Net, session: string, etape: string, credential: Obj): Promise<Bytes[]> {
  return enveloppes(await appel(n, "POST", "reauth/fin", { session, body: { etape, credential: cred(credential) } }), "enveloppes");
}

/** Une passkey du compte : mois d'ajout, libellé chiffré (ou aucun), synchronisable, avec enveloppe PRF. */
export type PasskeyServeur = { credId: Bytes; ajoutee: string; etiquette: Bytes | null; be: boolean; prf: boolean };

export async function passkeys(n: Net, session: string): Promise<PasskeyServeur[]> {
  const o = await appel(n, "GET", "passkeys", { session });
  if (!Array.isArray(o.passkeys)) throw invalide();
  return o.passkeys.map((v: unknown) => {
    if (typeof v !== "object" || v === null) throw invalide();
    const p = v as Obj;
    const id = octets(p, "cred_id");
    if (id.length < 1 || typeof p.ajoutee !== "string" || !MOIS.test(p.ajoutee) || typeof p.be !== "boolean" || typeof p.prf !== "boolean") throw invalide();
    const e = octets(p, "etiquette");
    if (e.length !== 0 && e.length !== 64) throw invalide();
    return { credId: id, ajoutee: p.ajoutee, etiquette: e.length === 0 ? null : e, be: p.be, prf: p.prf };
  });
}

export async function passkeysDebut(n: Net, session: string): Promise<Ceremonie> {
  return ceremonie(await appel(n, "POST", "passkeys/debut", { session, body: {} }));
}

export async function passkeysFin(n: Net, session: string, b: { etape: string; credential: Obj; env: Bytes | null; etiquette: Bytes | null }): Promise<void> {
  await appel(n, "POST", "passkeys/fin", { session, body: { etape: b.etape, credential: cred(b.credential), env: opt(b.env), etiquette: opt(b.etiquette) } });
}

/**
 * Une enveloppe PRF de plus pour la passkey liée à la session (celle qui a signé la dernière
 * assertion). Session récente exigée : 403 recent ou sans_passkey (reauth d'abord) ; 409
 * enveloppes_max à la cinquième ; la même deux fois : sans effet.
 */
export async function passkeysEnveloppe(n: Net, session: string, env: Bytes): Promise<void> {
  if (env.length !== 60) throw new Error("enveloppe_invalide");
  await appel(n, "POST", "passkeys/enveloppe", { session, body: { env: b64u(env) } });
}

export async function passkeysNommer(n: Net, session: string, credId: Bytes, etiquette: Bytes): Promise<void> {
  await appel(n, "POST", "passkeys/nommer", { session, body: { cred_id: b64u(credId), etiquette: b64u(etiquette) } });
}

/** Session récente ; la dernière passkey : 409 derniere. */
export async function passkeysRetirer(n: Net, session: string, credId: Bytes): Promise<void> {
  await appel(n, "POST", "passkeys/retirer", { session, body: { cred_id: b64u(credId) } });
}

/** Nouvelle clé de récupération (session récente) : v_r et Env_r seulement ; l'ancienne ne sert plus. */
export async function recupRenouveler(n: Net, session: string, vR: Bytes, envR: Bytes): Promise<void> {
  await appel(n, "POST", "recup/renouveler", { session, body: { v_r: b64u(vR), env_r: b64u(envR) } });
}

// --- État du compte (session) --------------------------------------------------------------------

/** GET /api/compte : dates au jour (« 2026-11-14 ») ou null ; motif 1 à 10 ou null ; banniId (« B-… ») ou null. */
export type EtatServeur = {
  creeLe: string;
  palier: "neuf" | "confirme";
  confirmeLe: string | null;
  limites: { salons: number; places: number; heures: number };
  salonsActifs: number;
  banniId: string | null;
  banniJusqu: string | null;
  banniMotif: number | null;
};

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const MOIS = /^\d{4}-\d{2}$/;
function jour(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || !JOUR.test(v)) throw invalide();
  return v;
}
const jourOuNull = (o: Obj, k: string) => (o[k] === null || o[k] === undefined ? null : jour(o, k));
function motif(o: Obj): number | null {
  const m = o.banni_motif;
  if (m === null || m === undefined) return null;
  if (!(Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 10)) throw invalide();
  return m as number;
}

export async function etat(n: Net, session: string): Promise<EtatServeur> {
  const o = await appel(n, "GET", "", { session });
  const l = o.limites;
  if (typeof l !== "object" || l === null || (o.palier !== "neuf" && o.palier !== "confirme")) throw invalide();
  const id = o.banni_id;
  if (id !== null && id !== undefined && (typeof id !== "string" || !/^B-[A-Za-z0-9_-]{1,64}$/.test(id))) throw invalide();
  return {
    creeLe: jour(o, "cree_le"),
    palier: o.palier,
    confirmeLe: jourOuNull(o, "confirme_le"),
    limites: { salons: entier(l as Obj, "salons"), places: entier(l as Obj, "places"), heures: entier(l as Obj, "heures") },
    salonsActifs: entier(o, "salons_actifs"),
    banniId: typeof id === "string" ? id : null,
    banniJusqu: jourOuNull(o, "banni_jusqu"),
    banniMotif: motif(o),
  };
}

// --- Coffres, pseudo, déconnexion (session) ---------------------------------------------------

export async function lireCoffre(n: Net, session: string, sorte: "profil" | "prive"): Promise<{ blob: Bytes; gen: number }> {
  const o = await appel(n, "GET", `coffre/${sorte}`, { session });
  return { blob: octets(o, "blob"), gen: entier(o, "gen") };
}

export async function ecrireCoffre(n: Net, session: string, sorte: "profil" | "prive", ifGen: number, blob: Bytes): Promise<number> {
  return entier(await appel(n, "PUT", `coffre/${sorte}`, { session, body: { if_gen: ifGen, blob: b64u(blob) } }), "gen");
}

/** Pseudo libre ? Pendant l'inscription par l'étape, ensuite par la session. */
export async function pseudoVerifier(n: Net, par: { jeton: string } | { etape: string }, pCanon: string): Promise<boolean> {
  const o = "jeton" in par ? await appel(n, "POST", "pseudo/verifier", { session: par.jeton, body: { p_canon: pCanon } }) : await appel(n, "POST", "pseudo/verifier", { body: { etape: par.etape, p_canon: pCanon } });
  if (typeof o.libre !== "boolean") throw invalide();
  return o.libre;
}

/** Invité d'un salon : pseudo ni pris par un compte, ni réservé, ni interdit ? Sans session ni salon. */
export async function pseudoLibreInvite(n: Net, pCanon: string): Promise<boolean> {
  const o = await appel(n, "POST", "pseudo/libre", { body: { p_canon: pCanon } });
  if (typeof o.libre !== "boolean") throw invalide();
  return o.libre;
}

export async function changerPseudo(n: Net, session: string, pCanon: string): Promise<void> {
  await appel(n, "POST", "pseudo", { session, body: { p_canon: pCanon } });
}

/**
 * Nom d'appareil de la session courante (64 octets chiffrés par K_etiquette). Après une
 * connexion seulement : K_etiquette vient de K_compte, que l'appareil n'ouvre qu'avec la réponse.
 */
export async function etiquetterSession(n: Net, session: string, etiquette: Bytes): Promise<void> {
  await appel(n, "POST", "sessions/etiquette", { session, body: { etiquette: b64u(etiquette) } });
}

/** Déconnexion : `keepalive` pour qu'elle parte même si l'onglet se ferme aussitôt. */
export async function deconnexion(n: Net, session: string): Promise<void> {
  await appel(n, "POST", "deconnexion", { session, body: {}, keepalive: true });
}

// --- Appareils, export, suppression (session) -------------------------------------------------

/** Une session du compte (§8.5) : mois d'ajout, nom chiffré par l'appareil (ou aucun), ouverte par la clé de récupération. */
export type SessionAppareil = { sid: string; ajoutee: string; etiquette: Bytes | null; courante: boolean; persistante: boolean; parRecup: boolean };

export async function sessions(n: Net, session: string): Promise<SessionAppareil[]> {
  const o = await appel(n, "GET", "sessions", { session });
  if (!Array.isArray(o.sessions)) throw invalide();
  return o.sessions.map((v: unknown) => {
    if (typeof v !== "object" || v === null) throw invalide();
    const s = v as Obj;
    octets(s, "sid", 16);
    if (typeof s.ajoutee !== "string" || !MOIS.test(s.ajoutee) || typeof s.courante !== "boolean" || typeof s.persistante !== "boolean" || typeof s.par_recup !== "boolean") throw invalide();
    const e = octets(s, "etiquette");
    if (e.length !== 0 && e.length !== 64) throw invalide();
    return { sid: s.sid as string, ajoutee: s.ajoutee, etiquette: e.length === 0 ? null : e, courante: s.courante, persistante: s.persistante, parRecup: s.par_recup };
  });
}

export async function fermerSession(n: Net, session: string, quoi: { sid: string } | { autres: true }): Promise<void> {
  await appel(n, "POST", "sessions/fermer", { session, body: "sid" in quoi ? { sid: quoi.sid } : { autres: true } });
}

/** GET export (§12.4, conception du compte par passkey §3.6) : ce que le serveur garde du compte. */
export type ExportServeur = {
  creeLe: string;
  ancienneteDepuis: string;
  vuMois: string;
  banniJusqu: string | null;
  banniMotif: number | null;
  salonsActifs: number;
  sessions: { ajoutee: string; persistante: boolean; parRecup: boolean }[];
  passkeys: { ajoutee: string; be: boolean; prf: boolean; clePub: string }[];
};

export async function exporter(n: Net, session: string): Promise<ExportServeur> {
  const o = await appel(n, "GET", "export", { session });
  if (typeof o.vu_mois !== "string" || !MOIS.test(o.vu_mois) || !Array.isArray(o.sessions) || !Array.isArray(o.passkeys)) throw invalide();
  return {
    creeLe: jour(o, "cree_le"),
    ancienneteDepuis: jour(o, "anciennete_depuis"),
    vuMois: o.vu_mois,
    banniJusqu: jourOuNull(o, "banni_jusqu"),
    banniMotif: motif(o),
    salonsActifs: entier(o, "salons_actifs"),
    sessions: o.sessions.map((v: unknown) => {
      const s = v as Obj;
      if (typeof s !== "object" || s === null || typeof s.ajoutee !== "string" || !MOIS.test(s.ajoutee) || typeof s.persistante !== "boolean" || typeof s.par_recup !== "boolean") throw invalide();
      return { ajoutee: s.ajoutee, persistante: s.persistante, parRecup: s.par_recup };
    }),
    passkeys: o.passkeys.map((v: unknown) => {
      const p = v as Obj;
      if (typeof p !== "object" || p === null || typeof p.ajoutee !== "string" || !MOIS.test(p.ajoutee) || typeof p.be !== "boolean" || typeof p.prf !== "boolean") throw invalide();
      octets(p, "cle_pub");
      return { ajoutee: p.ajoutee, be: p.be, prf: p.prf, clePub: p.cle_pub as string };
    }),
  };
}

/** Suppression du compte (session récente) : salons créés fermés par le serveur. */
export async function supprimer(n: Net, session: string): Promise<{ salonsFermes: number }> {
  return { salonsFermes: entier(await appel(n, "POST", "supprimer", { session, body: {} }), "salons_fermes") };
}

// --- Salon ----------------------------------------------------------------------------------

/**
 * Création d'un salon avec la session du compte (conception §10.4 ; SHH_COMPTES=1 l'exige) :
 * POST /api/salons, seule route hors de /api/compte qui reçoit X-Shh-Session. `acces` :
 * K_accès_s, `gestion` : J_gestion (jamais S_gestion, spec salon v3 §15.2), en base64url ;
 * le corps vient de salon/api.ts (CorpsCreation). Refus : 409 palier (CompteError.palier),
 * 403 banni (jusqu), 401 compte_requis, 429 limit, 400 bad_request (preuve anti-robot).
 */
export async function creerSalon(n: Net, session: string, entetes: { acces: string; gestion: string }, corps: Obj): Promise<{ expiresInS: number }> {
  let r: Response;
  try {
    r = await n.fetch(`${n.origin}/api/salons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shh-Session": session, "X-Shh-Access": entetes.acces, "X-Shh-Manage": entetes.gestion },
      body: JSON.stringify(corps),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new Error("reseau");
  }
  if (!r.ok) throw await erreur(r);
  let o: unknown;
  try {
    o = JSON.parse(await r.text());
  } catch {
    throw invalide();
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw invalide();
  return { expiresInS: entier(o as Obj, "expires_in_s") };
}

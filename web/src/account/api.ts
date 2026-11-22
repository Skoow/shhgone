// Couche HTTP du compte (conception compte §8.6, §21.6.2 ; serveur : server/internal/api/
// handlers_compte.go). SEUL fichier du compte qui fait des requêtes, et seul fichier du site qui
// écrit l'en-tête X-Shh-Session (source-rules.test.ts) :
// - toutes les routes sont sous /api/compte/ ; le jeton de session ne part vers aucune autre route
//   (ni /api/shares, ni /api/manage, ni les autres routes du salon), sauf POST /api/salons, la
//   création d'un salon (creerSalon, conception §10.4 ; écrans du salon, plan C-3) ;
// - JSON strict : clés exactes, jamais `null` (le serveur le refuse), secrets en base64url sans
//   bourrage ; rien dans l'URL ; sans cookie (credentials: "omit"), sans redirection ;
// - un seul essai : aucune route du compte n'est rejouée d'elle-même (un code, une écriture de
//   coffre ou une connexion ne se renvoient qu'à la demande de l'écran).
// Erreurs : CompteError (code du serveur, essais restants, date, gen, Retry-After) ; coupure
// réseau : Error("reseau") ; réponse 2xx mal formée : Error("reponse_invalide").
import { b64u, unb64u } from "../engine/pure";

export type Net = { origin: string; fetch: typeof fetch };

/** Le serveur du site (même origine) et le fetch du navigateur. */
export function netParDefaut(): Net {
  return { origin: globalThis.location?.origin ?? "", fetch: (...a) => globalThis.fetch(...a) };
}

export class CompteError extends Error {
  readonly attemptsLeft?: number;
  readonly jusqu?: string;
  readonly gen?: number;
  readonly retryAfterS?: number;
  /** Refus `palier` d'une création de salon (409) : limites du palier du compte. */
  readonly palier?: { salons: number; places: number; heures: number };
  constructor(
    readonly status: number,
    readonly code: string,
    extra: { attemptsLeft?: number; jusqu?: string; gen?: number; retryAfterS?: number; palier?: { salons: number; places: number; heures: number } } = {},
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
    attemptsLeft: int(j.attempts_left),
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

// --- Inscription -----------------------------------------------------------------------------

/** Preuve anti-robot ALTCHA (mêmes champs que POST /api/shares). */
export type Preuve = { altcha: string; hp: string; shown_at: string };

export async function inscriptionDebut(n: Net, b: { email: string; langue: string } & Preuve): Promise<{ h: Bytes; etape: string }> {
  const o = await appel(n, "POST", "inscription/debut", { body: { email: b.email, langue: b.langue, altcha: b.altcha, hp: b.hp, shown_at: b.shown_at } });
  return { h: octets(o, "h", 16), etape: jeton(o, "etape") };
}

export async function inscriptionRenvoyer(n: Net, etape: string, email: string): Promise<void> {
  await appel(n, "POST", "inscription/renvoyer", { body: { etape, email } });
}

export type FinInscription = {
  etape: string;
  code: string;
  aAuth: Bytes;
  envMdp: Bytes;
  sProfil: Bytes;
  pCanon: string;
  blobProfil: Bytes;
  blobPrive: Bytes;
  persistante: boolean;
  /** Nom d'appareil chiffré (64 octets) ou null (aucun). */
  etiquette: Bytes | null;
};

export async function inscriptionFin(n: Net, b: FinInscription): Promise<{ session: string }> {
  const o = await appel(n, "POST", "inscription/fin", {
    body: {
      etape: b.etape,
      code: b.code,
      a_auth: b64u(b.aAuth),
      env_mdp: b64u(b.envMdp),
      s_profil: b64u(b.sProfil),
      p_canon: b.pCanon,
      blob_profil: b64u(b.blobProfil),
      blob_prive: b64u(b.blobPrive),
      persistante: b.persistante,
      etiquette: b.etiquette === null ? "" : b64u(b.etiquette),
    },
  });
  return { session: jeton(o, "session") };
}

// --- Connexion -------------------------------------------------------------------------------

/** Ce que rend une connexion réussie (§21.6.2). */
export type Ouverture = { session: string; h: Bytes; envMdp: Bytes; sProfil: Bytes; blobProfil: Bytes; genProfil: number; blobPrive: Bytes; genPrive: number };

function ouverture(o: Obj): Ouverture {
  return {
    session: jeton(o, "session"),
    h: octets(o, "h", 16),
    envMdp: octets(o, "env_mdp", 60),
    sProfil: octets(o, "s_profil", 32),
    blobProfil: octets(o, "blob_profil"),
    genProfil: entier(o, "gen_profil"),
    blobPrive: octets(o, "blob_prive"),
    genPrive: entier(o, "gen_prive"),
  };
}

export async function connexion(
  n: Net,
  b: { email: string; aAuth: Bytes; persistante: boolean; etiquette: Bytes | null; preuve?: Preuve },
): Promise<Ouverture | { totp: string }> {
  const body: Obj = { email: b.email, a_auth: b64u(b.aAuth), persistante: b.persistante, etiquette: b.etiquette === null ? "" : b64u(b.etiquette) };
  if (b.preuve) Object.assign(body, { altcha: b.preuve.altcha, hp: b.preuve.hp, shown_at: b.preuve.shown_at });
  const o = await appel(n, "POST", "connexion", { body });
  if (o.totp_requis === true) return { totp: jeton(o, "etape") };
  return ouverture(o);
}

export async function connexionTotp(n: Net, etape: string, code: string): Promise<Ouverture> {
  return ouverture(await appel(n, "POST", "connexion/totp", { body: { etape, code } }));
}

// --- Mot de passe oublié ---------------------------------------------------------------------

export async function oubliDebut(n: Net, b: { email: string; langue: string } & Preuve): Promise<{ etape: string }> {
  const o = await appel(n, "POST", "oubli/debut", { body: { email: b.email, langue: b.langue, altcha: b.altcha, hp: b.hp, shown_at: b.shown_at } });
  return { etape: jeton(o, "etape") };
}

export async function oubliRenvoyer(n: Net, etape: string, email: string): Promise<void> {
  await appel(n, "POST", "oubli/renvoyer", { body: { etape, email } });
}

/**
 * `{ h, gen_prive }` : code juste ; `gen_prive` est indispensable (le nouveau coffre privé porte
 * gen_prive + 1 dans ses données authentifiées). `{ attente_jusqu }` : retrait de la double
 * authentification demandé (§21.2.4).
 */
export async function oubliVerifier(n: Net, b: { etape: string; code: string; totp: string; totpPerdu: boolean }): Promise<{ h: Bytes; genPrive: number } | { attenteJusqu: string }> {
  const o = await appel(n, "POST", "oubli/verifier", { body: { etape: b.etape, code: b.code, totp: b.totp, totp_perdu: b.totpPerdu } });
  if (typeof o.attente_jusqu === "string") return { attenteJusqu: o.attente_jusqu };
  return { h: octets(o, "h", 16), genPrive: entier(o, "gen_prive") };
}

export async function oubliFin(
  n: Net,
  b: { etape: string; aAuth: Bytes; envMdp: Bytes; blobPrive: Bytes; persistante: boolean; etiquette: Bytes | null },
): Promise<{ session: string; h: Bytes; sProfil: Bytes; blobProfil: Bytes; genProfil: number; genPrive: number }> {
  const o = await appel(n, "POST", "oubli/fin", {
    body: { etape: b.etape, a_auth: b64u(b.aAuth), env_mdp: b64u(b.envMdp), blob_prive: b64u(b.blobPrive), persistante: b.persistante, etiquette: b.etiquette === null ? "" : b64u(b.etiquette) },
  });
  return { session: jeton(o, "session"), h: octets(o, "h", 16), sProfil: octets(o, "s_profil", 32), blobProfil: octets(o, "blob_profil"), genProfil: entier(o, "gen_profil"), genPrive: entier(o, "gen_prive") };
}

// --- État du compte (session) --------------------------------------------------------------------

/** GET /api/compte (§8.6, §21.6.2) : dates au jour (« 2026-11-14 ») ou null ; motif 1 à 10 ou null. */
export type EtatServeur = {
  creeLe: string;
  palier: "neuf" | "confirme";
  confirmeLe: string | null;
  limites: { salons: number; places: number; heures: number };
  salonsActifs: number;
  totp: boolean;
  recupJusqu: string | null;
  retraitTotpLe: string | null;
  banniJusqu: string | null;
  banniMotif: number | null;
};

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
function jour(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || !JOUR.test(v)) throw invalide();
  return v;
}
const jourOuNull = (o: Obj, k: string) => (o[k] === null ? null : jour(o, k));

export async function etat(n: Net, session: string): Promise<EtatServeur> {
  const o = await appel(n, "GET", "", { session });
  const l = o.limites;
  if (typeof l !== "object" || l === null || (o.palier !== "neuf" && o.palier !== "confirme") || typeof o.totp !== "boolean") throw invalide();
  const m = o.banni_motif;
  if (m !== null && !(Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 10)) throw invalide();
  return {
    creeLe: jour(o, "cree_le"),
    palier: o.palier,
    confirmeLe: jourOuNull(o, "confirme_le"),
    limites: { salons: entier(l as Obj, "salons"), places: entier(l as Obj, "places"), heures: entier(l as Obj, "heures") },
    salonsActifs: entier(o, "salons_actifs"),
    totp: o.totp,
    recupJusqu: jourOuNull(o, "recup_jusqu"),
    retraitTotpLe: jourOuNull(o, "retrait_totp_le"),
    banniJusqu: jourOuNull(o, "banni_jusqu"),
    banniMotif: m as number | null,
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

/** Invité d'un salon (22 novembre) : pseudo ni pris par un compte, ni réservé, ni interdit ? Sans session ni salon. */
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

/** Déconnexion : `keepalive` (audit du 18 novembre) pour qu'elle parte même si l'onglet se ferme aussitôt. */
export async function deconnexion(n: Net, session: string): Promise<void> {
  await appel(n, "POST", "deconnexion", { session, body: {}, keepalive: true });
}

// --- Paramètres (lot 13 ; routes du lot 5, handlers_compte.go) ---------------------------------
// Toutes avec la session ; celles qui changent la sécurité exigent une session « récente » (moins
// de 5 min depuis une connexion ou un reauth) : sinon 403 `recent`, et l'écran redemande le mot
// de passe. Le mot de passe ne part jamais : seulement A_auth et l'enveloppe de K_compte.

/** Session « récente » : A_auth du mot de passe actuel, code de l'application ("" si inactive). */
export async function reauth(n: Net, session: string, aAuth: Bytes, totp: string): Promise<void> {
  await appel(n, "POST", "reauth", { session, body: { a_auth: b64u(aAuth), totp } });
}

/** Nouveau mot de passe ; le serveur ferme toujours les autres sessions. */
export async function changerMdp(n: Net, session: string, aAuth: Bytes, envMdp: Bytes): Promise<void> {
  await appel(n, "POST", "mdp", { session, body: { a_auth: b64u(aAuth), env_mdp: b64u(envMdp) } });
}

/** Adresses exactes ; le code part à la nouvelle seulement (§21.3). */
export async function emailDebut(n: Net, session: string, b: { actuel: string; nouveau: string; langue: string }): Promise<{ etape: string }> {
  const o = await appel(n, "POST", "email/debut", { session, body: { email_actuel: b.actuel, email_nouveau: b.nouveau, langue: b.langue } });
  return { etape: jeton(o, "etape") };
}

export async function emailRenvoyer(n: Net, session: string, etape: string, email: string): Promise<void> {
  await appel(n, "POST", "email/renvoyer", { session, body: { etape, email } });
}

/** A_auth et enveloppe recalculés avec le sel de la NOUVELLE adresse (§6). */
export async function emailFin(n: Net, session: string, b: { etape: string; code: string; aAuth: Bytes; envMdp: Bytes; totp: string }): Promise<void> {
  await appel(n, "POST", "email/fin", { session, body: { etape: b.etape, code: b.code, a_auth: b64u(b.aAuth), env_mdp: b64u(b.envMdp), totp: b.totp } });
}

const BASE32 = /^[A-Z2-7]{16,128}$/;

/** Seule réponse du serveur qui contient le secret TOTP (base32, sans bourrage). */
export async function totpDebut(n: Net, session: string): Promise<{ etape: string; secret: string }> {
  const o = await appel(n, "POST", "totp/debut", { session, body: {} });
  if (typeof o.secret !== "string" || !BASE32.test(o.secret)) throw invalide();
  return { etape: jeton(o, "etape"), secret: o.secret };
}

export async function totpFin(n: Net, session: string, etape: string, code: string): Promise<void> {
  await appel(n, "POST", "totp/fin", { session, body: { etape, code } });
}

export async function totpRetirer(n: Net, session: string): Promise<void> {
  await appel(n, "POST", "totp/retirer", { session, body: {} });
}

/** « Ce n'est pas vous ? Annuler » (§21.2.4) : session, même non récente. */
export async function totpAnnulerRetrait(n: Net, session: string): Promise<void> {
  await appel(n, "POST", "totp/annuler-retrait", { session, body: {} });
}

/** Une session du compte (§8.5) : mois d'ajout, nom chiffré par l'appareil (ou aucun). */
export type SessionAppareil = { sid: string; ajoutee: string; etiquette: Bytes | null; courante: boolean; persistante: boolean };
const MOIS = /^\d{4}-\d{2}$/;

export async function sessions(n: Net, session: string): Promise<SessionAppareil[]> {
  const o = await appel(n, "GET", "sessions", { session });
  if (!Array.isArray(o.sessions)) throw invalide();
  return o.sessions.map((v: unknown) => {
    if (typeof v !== "object" || v === null) throw invalide();
    const s = v as Obj;
    octets(s, "sid", 16);
    if (typeof s.ajoutee !== "string" || !MOIS.test(s.ajoutee) || typeof s.courante !== "boolean" || typeof s.persistante !== "boolean") throw invalide();
    const e = octets(s, "etiquette");
    if (e.length !== 0 && e.length !== 64) throw invalide();
    return { sid: s.sid as string, ajoutee: s.ajoutee, etiquette: e.length === 0 ? null : e, courante: s.courante, persistante: s.persistante };
  });
}

export async function fermerSession(n: Net, session: string, quoi: { sid: string } | { autres: true }): Promise<void> {
  await appel(n, "POST", "sessions/fermer", { session, body: "sid" in quoi ? { sid: quoi.sid } : { autres: true } });
}

/** GET export (§12.4) : ce que le serveur garde du compte, sans adresse. */
export type ExportServeur = {
  creeLe: string;
  ancienneteDepuis: string;
  vuMois: string;
  totp: boolean;
  retraitTotpLe: string | null;
  recupJusqu: string | null;
  banniJusqu: string | null;
  banniMotif: number | null;
  salonsActifs: number;
  sessions: { ajoutee: string; persistante: boolean }[];
};

export async function exporter(n: Net, session: string): Promise<ExportServeur> {
  const o = await appel(n, "GET", "export", { session });
  const m = o.banni_motif;
  if (typeof o.totp !== "boolean" || typeof o.vu_mois !== "string" || !MOIS.test(o.vu_mois) || !Array.isArray(o.sessions)) throw invalide();
  if (m !== null && !(Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 10)) throw invalide();
  return {
    creeLe: jour(o, "cree_le"),
    ancienneteDepuis: jour(o, "anciennete_depuis"),
    vuMois: o.vu_mois,
    totp: o.totp,
    retraitTotpLe: jourOuNull(o, "retrait_totp_le"),
    recupJusqu: jourOuNull(o, "recup_jusqu"),
    banniJusqu: jourOuNull(o, "banni_jusqu"),
    banniMotif: m as number | null,
    salonsActifs: entier(o, "salons_actifs"),
    sessions: o.sessions.map((v: unknown) => {
      const s = v as Obj;
      if (typeof s !== "object" || s === null || typeof s.ajoutee !== "string" || !MOIS.test(s.ajoutee) || typeof s.persistante !== "boolean") throw invalide();
      return { ajoutee: s.ajoutee, persistante: s.persistante };
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

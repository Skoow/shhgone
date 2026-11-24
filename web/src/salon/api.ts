// Routes JSON du salon (serveur : server/internal/api/handlers_salon.go ; « Protocole » du plan
// C-2). Seul fichier du salon qui fait des requêtes HTTP (source-rules.test.ts) ; la création
// avec session passe par account/api.ts (seul fichier qui écrit l'en-tête de session). Règles :
// - secrets en en-tête seulement, en base64url sans bourrage : X-Shh-Access (K_accès_s),
//   X-Shh-Manage (J_gestion = jetonGestion(S_gestion), JAMAIS S_gestion : spec salon v3 §15.2),
//   X-Shh-Membre (jeton de membre) ; rien dans l'adresse ;
// - JSON strict (clés exactes, jamais null) ; sans cookie, sans redirection, un seul essai ;
// - erreurs : SalonError (statut, code du serveur, essais restants, délai) ; coupure réseau :
//   Error("reseau") ; réponse 2xx mal formée : Error("reponse_invalide").
import { b64u, unb64u } from "../engine/pure";

export type Net = { origin: string; fetch: typeof fetch };

export function netParDefaut(): Net {
  return { origin: globalThis.location?.origin ?? "", fetch: (...a) => globalThis.fetch(...a) };
}

export class SalonError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly attemptsLeft?: number,
    readonly retryS?: number,
  ) {
    super(code);
  }
}

type Obj = Record<string, unknown>;
type Bytes = Uint8Array<ArrayBuffer>;
const invalide = () => new Error("reponse_invalide");

function entier(o: Obj, k: string): number {
  const v = o[k];
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalide();
  return v as number;
}
function octets(o: Obj, k: string, n: number): Bytes {
  const v = o[k];
  if (typeof v !== "string") throw invalide();
  let b: Bytes;
  try {
    b = unb64u(v);
  } catch {
    throw invalide();
  }
  if (b.length !== n) throw invalide();
  return b;
}

/** Lit la réponse : objet JSON (2xx), sinon SalonError. */
export async function lireReponse(r: Response): Promise<Obj> {
  let o: unknown = null;
  const t = await r.text().catch(() => "");
  try {
    o = t === "" ? {} : JSON.parse(t);
  } catch {
    o = null;
  }
  if (!r.ok) {
    const e = (o ?? {}) as Obj;
    const code = typeof e.error === "string" ? e.error : "erreur";
    const left = Number.isSafeInteger(e.attempts_left) ? (e.attempts_left as number) : undefined;
    const ra = Number(r.headers.get("Retry-After"));
    const retry = Number.isSafeInteger(e.retry_after_s) ? (e.retry_after_s as number) : Number.isFinite(ra) && ra > 0 ? ra : undefined;
    throw new SalonError(r.status, code, left, retry);
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw invalide();
  return o as Obj;
}

async function appel(n: Net, method: "GET" | "POST", path: string, headers: Record<string, string>, body?: unknown): Promise<Obj> {
  let r: Response;
  try {
    r = await n.fetch(n.origin + "/api/salons" + path, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new Error("reseau");
  }
  return lireReponse(r);
}

/** En-tête d'un secret de 32 octets (base64url, 43 caractères). */
const cle = (b: Uint8Array) => b64u(b as Bytes);

export type Meta = { expiresInS: number; salt: Bytes; kdfOps: number; kdfMem: number };

/** GET /api/salons/meta : secondes restantes, sel et paramètres d'Argon2id (rien sur les présents). */
export async function meta(n: Net, kAcces: Uint8Array): Promise<Meta> {
  const o = await appel(n, "GET", "/meta", { "X-Shh-Access": cle(kAcces) });
  return { expiresInS: entier(o, "expires_in_s"), salt: octets(o, "salt", 16), kdfOps: entier(o, "kdf_ops"), kdfMem: entier(o, "kdf_mem") };
}

export type Entree = {
  jeton: string;
  siege: number;
  seq: number;
  nonce: Bytes;
  expiresInS: number;
  maxMembers: number;
  membersCanDestroy: boolean;
  budgetLeft: number;
  /** Appels audio et vidéo offerts par ce serveur (relais TURN configuré et paiement ouvert : appels réservés à Plus et Pro). */
  appels: boolean;
};

/**
 * POST /api/salons/rejoindre : `K_preuve_s` dans le corps ; créateur : `X-Shh-Manage` =
 * J_gestion (siège 0, sans compter dans les arrivées). Refus : 403 bad_password
 * (attemptsLeft), 404 not_found, 409 full, 429 limit.
 */
export async function rejoindre(n: Net, kAcces: Uint8Array, kPreuve: Uint8Array, jGestion?: Uint8Array): Promise<Entree> {
  const h: Record<string, string> = { "X-Shh-Access": cle(kAcces) };
  if (jGestion) h["X-Shh-Manage"] = cle(jGestion);
  const o = await appel(n, "POST", "/rejoindre", h, { proof: cle(kPreuve) });
  const jeton = o.member_token;
  if (typeof jeton !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(jeton) || typeof o.members_can_destroy !== "boolean") throw invalide();
  const siege = entier(o, "seat");
  if (siege > 9) throw invalide();
  return {
    jeton,
    siege,
    seq: entier(o, "seq"),
    nonce: octets(o, "nonce_arrivee", 16),
    expiresInS: entier(o, "expires_in_s"),
    maxMembers: entier(o, "max_members"),
    membersCanDestroy: o.members_can_destroy,
    budgetLeft: entier(o, "budget_left"),
    appels: o.calls === true,
  };
}

/** GET /api/salons/gestion (créateur) : secondes restantes et sièges occupés ; 404 : le salon n'existe plus. */
export async function gestion(n: Net, jGestion: Uint8Array): Promise<{ expiresInS: number; present: number }> {
  const o = await appel(n, "GET", "/gestion", { "X-Shh-Manage": cle(jGestion) });
  return { expiresInS: entier(o, "expires_in_s"), present: entier(o, "present") };
}

/** POST /api/salons/detruire : créateur (J_gestion) ou membre (jeton) si le salon le permet. */
export async function detruire(n: Net, qui: { jGestion: Uint8Array } | { jeton: string }, signaler = false): Promise<void> {
  const h: Record<string, string> = "jGestion" in qui ? { "X-Shh-Manage": cle(qui.jGestion) } : { "X-Shh-Membre": qui.jeton };
  await appel(n, "POST", "/detruire", h, signaler ? { reason: "report" } : {});
}

/** Identifiants temporaires du relais TURN des appels (rien qui désigne le salon ni le membre). */
export type Relais = { urls: string[]; username: string; credential: string; ttlS: number };

const URL_RELAIS = /^turns?:[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?(\?transport=(udp|tcp))?$/;

/**
 * POST /api/salons/appel : identifiants du relais pour ce membre. Appels réservés aux offres Plus
 * et Pro (24 novembre) : tant qu'ils sont fermés dans le salon, `jetonAnonyme` (Privacy Pass,
 * « Authorization: PrivateToken », jamais un pass ni un compte) les ouvre pour tout le salon.
 * 402 offre_requise : fermés et aucun jeton ; 404 : pas d'appels sur ce serveur ; 429 : trop de demandes.
 */
export async function relaisAppel(n: Net, jeton: string, jetonAnonyme?: string): Promise<Relais> {
  const h: Record<string, string> = { "X-Shh-Membre": jeton };
  if (jetonAnonyme !== undefined) h.Authorization = `PrivateToken token=${jetonAnonyme}`;
  const o = await appel(n, "POST", "/appel", h, {});
  const { urls, username, credential } = o;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 4 || !urls.every((u) => typeof u === "string" && URL_RELAIS.test(u))) throw invalide();
  if (typeof username !== "string" || !/^[0-9]{1,12}:[0-9a-f]{32}$/.test(username) || typeof credential !== "string" || !/^[A-Za-z0-9+/]{27}=$/.test(credential)) throw invalide();
  return { urls: urls as string[], username, credential, ttlS: entier(o, "ttl_s") };
}

/** POST /api/salons/signaler : « Quitter et signaler » (le membre part comme par un 0x03). */
export async function signaler(n: Net, jeton: string): Promise<void> {
  await appel(n, "POST", "/signaler", { "X-Shh-Membre": jeton }, {});
}

export type Preuve = { altcha: string; hp: ""; shown_at: string };

/** POST /api/salons/reglages (créateur) : places et/ou renouvellement (preuve anti-robot). */
export async function reglages(
  n: Net,
  jGestion: Uint8Array,
  r: { maxMembers?: number; renouvelerH?: 1 | 6 | 12 | 24; preuve?: Preuve },
): Promise<{ maxMembers: number; expiresInS: number; depuis: number }> {
  const body: Obj = {};
  if (r.maxMembers !== undefined) body.max_members = r.maxMembers;
  if (r.renouvelerH !== undefined) Object.assign(body, { renouveler_h: r.renouvelerH }, r.preuve ?? {});
  const o = await appel(n, "POST", "/reglages", { "X-Shh-Manage": cle(jGestion) }, body);
  return { maxMembers: entier(o, "max_members"), expiresInS: entier(o, "expires_in_s"), depuis: entier(o, "depuis") };
}

/**
 * POST /api/salons/exclure (créateur) : exclusion d'une arrivée (`seat`, `nonce`) ou nouvelle
 * invitation seule ; nouvelle `K_accès_s'` en en-tête, nouvelle preuve et nouveaux paramètres
 * d'Argon2id dans le corps.
 */
export async function exclure(
  n: Net,
  jGestion: Uint8Array,
  r: { siege?: number; nonce?: Uint8Array; r: number; kAccesNouvelle: Uint8Array; vPreuve: Uint8Array; salt: Uint8Array; kdfOps: number; kdfMem: number },
): Promise<void> {
  const body: Obj = { r: r.r, proof_v: cle(r.vPreuve), salt: b64u(r.salt as Bytes), kdf_ops: r.kdfOps, kdf_mem: r.kdfMem };
  if (r.siege !== undefined && r.nonce) Object.assign(body, { seat: r.siege, nonce_arrivee: b64u(r.nonce as Bytes) });
  await appel(n, "POST", "/exclure", { "X-Shh-Manage": cle(jGestion), "X-Shh-Access-New": cle(r.kAccesNouvelle) }, body);
}

// --- Pièces (plan C-4 ; serveur : handlers_salon_pieces.go) --------------------------------------

/** POST /api/salons/pieces : identifiant de la pièce (16 octets) et jeton d'envoi signé. */
export async function creerPiece(n: Net, jeton: string, bucket: number, vocal: boolean): Promise<{ piece: Bytes; envoi: string }> {
  const o = await appel(n, "POST", "/pieces", { "X-Shh-Membre": jeton }, { bucket, vocal });
  const t = o.upload_token;
  if (typeof t !== "string" || t.length < 20 || /\s/.test(t)) throw invalide();
  return { piece: octets(o, "piece", 16), envoi: t };
}

async function brut(n: Net, method: "GET" | "PUT" | "POST", path: string, headers: Record<string, string>, body?: BodyInit): Promise<Response> {
  try {
    return await n.fetch(n.origin + "/api/salons" + path, { method, headers, body, credentials: "omit", redirect: "error", cache: "no-store" });
  } catch {
    throw new Error("reseau");
  }
}

/** PUT /api/salons/pieces/segments/{n} : segment entier (jeton d'envoi en Bearer). */
export async function envoyerSegment(n: Net, envoi: string, seg: number, corps: Uint8Array<ArrayBuffer>): Promise<void> {
  const r = await brut(n, "PUT", `/pieces/segments/${seg}`, { Authorization: `Bearer ${envoi}`, "Content-Type": "application/octet-stream" }, corps);
  if (r.status !== 204) await lireReponse(r);
}

/** POST /api/salons/pieces/finalize : la pièce est prête (aucun bourrage demandé au serveur). */
export async function finaliserPiece(n: Net, envoi: string): Promise<void> {
  await lireReponse(await brut(n, "POST", "/pieces/finalize", { Authorization: `Bearer ${envoi}`, "Content-Type": "application/json" }, JSON.stringify({ fill_from: 0, fill_to: 0 })));
}

/** GET /api/salons/pieces/segments/{n} : segment chiffré d'une pièce (404 : pièce indisponible). */
export async function lireSegment(n: Net, jeton: string, piece: Uint8Array, seg: number): Promise<Uint8Array<ArrayBuffer>> {
  const r = await brut(n, "GET", `/pieces/segments/${seg}`, { "X-Shh-Membre": jeton, "X-Shh-Piece": b64u(piece as Bytes) });
  if (!r.ok) await lireReponse(r);
  try {
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    throw new Error("reseau");
  }
}

/** Corps de la création (POST /api/salons) ; les en-têtes sont posés par account/api.ts. */
export type CorpsCreation = {
  ttl_hours: 1 | 6 | 12 | 24;
  max_members: number;
  members_can_destroy: boolean;
  salt: string;
  kdf_ops: number;
  kdf_mem: number;
  proof_v: string;
  altcha: string;
  hp: "";
  shown_at: string;
};

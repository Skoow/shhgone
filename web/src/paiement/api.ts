// Couche HTTP du paiement (conception du paiement §2, §5.6 ; serveur :
// server/internal/api/handlers_paiement.go). SEUL fichier du site qui écrit l'en-tête X-Shh-Pass
// (source-rules.test.ts), et seulement vers /api/paiement/* :
// - le pass P (32 octets) part en base64url dans l'en-tête, jamais dans l'adresse ni dans un corps ;
// - credentials: "same-origin" (témoin de préproduction ; le site ne pose aucun cookie et Caddy
//   retire l'en-tête Cookie), sans redirection, rien dans l'adresse ;
// - aucune donnée personnelle : ni nom, ni e-mail ; le pays seul, pour la TVA (jamais gardé par
//   le serveur) ;
// - l'adresse de la page hébergée rendue par le serveur est revérifiée ici contre la liste fermée
//   des prestataires (adresseSure) avant toute redirection.
import { b64u, unb64u } from "../engine/pure";

export type Net = { origin: string; fetch: typeof fetch };

export function netParDefaut(): Net {
  return { origin: globalThis.location?.origin ?? "", fetch: (...a) => globalThis.fetch(...a) };
}

/** Moyens de paiement, noms de l'API. */
export type Moyen = "carte" | "paypal" | "crypto";
export const MOYENS: readonly Moyen[] = ["carte", "paypal", "crypto"];
export type OffrePayante = "plus" | "pro";

/** Régime de TVA du vendeur et taux appliqué par pays (points de base : 2000 = 20 %), pour la note de vente. */
export type Tva = { regime: "franchise" | "france" | "oss"; taux: Readonly<Record<string, number>> };
export type OffreServeur = { moyens: Moyen[]; pays: string[]; bientot: string[]; tva: Tva | null };

/** Régime et taux lus ; null si absents ou mal formés (la note de vente n'est alors pas proposée). */
function tvaDe(o: unknown): Tva | null {
  if (typeof o !== "object" || o === null) return null;
  const { regime, taux } = o as Record<string, unknown>;
  if ((regime !== "franchise" && regime !== "france" && regime !== "oss") || typeof taux !== "object" || taux === null) return null;
  const out: Record<string, number> = {};
  for (const [p, v] of Object.entries(taux)) {
    if (!/^[A-Z]{2}$/.test(p) || !Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 10000) return null;
    out[p] = v as number;
  }
  return { regime, taux: out };
}

/** Pages hébergées permises (conception §4.4), mêmes débuts d'adresse que le serveur. */
export const ORIGINES: readonly string[] = [
  "https://checkout.stripe.com/",
  "https://www.paypal.com/",
  "https://www.sandbox.paypal.com/",
  "https://nowpayments.io/",
  "https://sandbox.nowpayments.io/",
];

/** Adresse de redirection sûre : https, d'un prestataire de la liste, rien après l'origine qui sorte de son chemin. */
export function adresseSure(u: string): boolean {
  if (u.length > 2048 || /[\u0000- \u007f-￿]/.test(u)) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && ORIGINES.some((o) => u.startsWith(o) && u.length > o.length && url.origin + "/" === o);
}

type Obj = Record<string, unknown>;
const estObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const chaines = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

async function appel(n: Net, route: string, init: RequestInit): Promise<Response | null> {
  try {
    return await n.fetch(`${n.origin}/api/paiement${route}`, { ...init, credentials: "same-origin", redirect: "error", cache: "no-store" });
  } catch {
    return null;
  }
}

async function json(r: Response): Promise<Obj | null> {
  try {
    const o: unknown = await r.json();
    return estObj(o) ? o : null;
  } catch {
    return null;
  }
}

/** Offre du serveur ; null : paiement non ouvert sur ce serveur (aucun moyen), injoignable ou démo. */
export async function lireOffre(n: Net = netParDefaut()): Promise<OffreServeur | null> {
  const r = await appel(n, "", { method: "GET" });
  if (r === null || r.status !== 200) return null;
  const o = await json(r);
  if (o === null || o.v !== 1 || !chaines(o.moyens) || !chaines(o.pays) || !chaines(o.bientot)) return null;
  // Paiement fermé sur ce serveur (P6 : 200 sans moyen, plus de 404) : comme une offre absente.
  if (o.moyens.length === 0) return null;
  return {
    moyens: o.moyens.filter((m): m is Moyen => (MOYENS as readonly string[]).includes(m)),
    pays: o.pays.filter((p) => /^[A-Z]{2}$/.test(p)),
    bientot: o.bientot,
    tva: tvaDe(o.tva),
  };
}

export type Demande = { offre: OffrePayante; jours: 30 | 365; renouvelle: boolean; moyen: Moyen; pays: string; renonciation: boolean };
export type ErreurCommande = "refus" | "conflit" | "limite" | "occupe" | "prestataire" | "reseau";
/** Preuve anti-robot ALTCHA (GET /api/captcha résolu), exigée par la commande. */
export type Preuve = { altcha: string; hp: string; shown_at: string };

const entetePass = (pass: Uint8Array<ArrayBuffer>) => {
  if (pass.length !== 32) throw new Error("pass_invalide");
  return { "X-Shh-Pass": b64u(pass) };
};

/** Commande : adresse de la page hébergée du prestataire (déjà vérifiée), ou la raison du refus. */
export async function commander(pass: Uint8Array<ArrayBuffer>, d: Demande, preuve: Preuve, n: Net = netParDefaut()): Promise<{ url: string } | { erreur: ErreurCommande }> {
  const r = await appel(n, "/commande", {
    method: "POST",
    headers: { ...entetePass(pass), "Content-Type": "application/json" },
    body: JSON.stringify({
      offre: d.offre,
      jours: d.jours,
      renouvelle: d.renouvelle,
      moyen: d.moyen,
      pays: d.pays,
      renonciation: d.renonciation,
      altcha: preuve.altcha,
      hp: preuve.hp,
      shown_at: preuve.shown_at,
    }),
  });
  if (r === null) return { erreur: "reseau" };
  if (r.status === 200) {
    const o = await json(r);
    if (o !== null && typeof o.url === "string" && adresseSure(o.url)) return { url: o.url };
    return { erreur: "prestataire" };
  }
  switch (r.status) {
    case 400:
      return { erreur: "refus" };
    case 409:
      return { erreur: "conflit" };
    case 429:
      return { erreur: "limite" };
    case 503:
      return { erreur: "occupe" };
    default:
      return { erreur: "prestataire" };
  }
}

export type EtatPaiement = {
  etat: "attente" | "payee" | "non_aboutie" | "anomalie" | "revoquee" | "inconnue";
  offre: OffrePayante | null;
  /** Dernier jour du pass (AAAA-MM-JJ, UTC), exclu. */
  fin: string | null;
  renouvelle: boolean;
  droits: string[];
};
const ETATS: readonly EtatPaiement["etat"][] = ["attente", "payee", "non_aboutie", "anomalie", "revoquee", "inconnue"];

/** État du pass ; null si le serveur ne répond pas (réessayer plus tard). */
export async function lireEtat(pass: Uint8Array<ArrayBuffer>, n: Net = netParDefaut()): Promise<EtatPaiement | null> {
  const r = await appel(n, "/etat", { method: "POST", headers: entetePass(pass) });
  if (r === null || r.status !== 200) return null;
  const o = await json(r);
  if (
    o === null ||
    o.v !== 1 ||
    !(ETATS as readonly unknown[]).includes(o.etat) ||
    !(o.offre === null || o.offre === "plus" || o.offre === "pro") ||
    !(o.fin === null || (typeof o.fin === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.fin))) ||
    typeof o.renouvelle !== "boolean" ||
    !chaines(o.droits)
  )
    return null;
  return { etat: o.etat as EtatPaiement["etat"], offre: o.offre as OffrePayante | null, fin: o.fin as string | null, renouvelle: o.renouvelle, droits: o.droits };
}

/** Arrêt du renouvellement : « ok », « aucun » (pas d'abonnement en cours) ou « erreur ». */
export async function resilier(pass: Uint8Array<ArrayBuffer>, n: Net = netParDefaut()): Promise<"ok" | "aucun" | "erreur"> {
  const r = await appel(n, "/resilier", { method: "POST", headers: entetePass(pass) });
  if (r?.status === 204) return "ok";
  if (r?.status === 409) return "aucun";
  return "erreur";
}

/**
 * Révocation par le porteur (suppression du compte, conception du paiement §5.6) : « ok » (révoqué,
 * déjà révoqué ou inconnu : le serveur répond pareil), « renouvellement » (arrêter d'abord le
 * renouvellement : resilier) ou « erreur » (réseau, limite, serveur).
 */
export async function revoquer(pass: Uint8Array<ArrayBuffer>, n: Net = netParDefaut()): Promise<"ok" | "renouvellement" | "erreur"> {
  const r = await appel(n, "/revoquer", { method: "POST", headers: entetePass(pass) });
  if (r?.status === 204) return "ok";
  if (r?.status === 409) return "renouvellement";
  return "erreur";
}

// --- Jetons anonymes (conception du paiement §7) ---------------------------------------------

export type CleJetons = { jour: string; offre: OffrePayante; spki: Uint8Array<ArrayBuffer> };

/** Clés publiques d'aujourd'hui à J+7 (S17 : comparées par jetons.ts à celles déjà vues) ; null si indisponibles. */
export async function lireCles(n: Net = netParDefaut()): Promise<{ emetteur: string; cles: CleJetons[] } | null> {
  const r = await appel(n, "/jetons/cles", { method: "GET" });
  if (r === null || r.status !== 200) return null;
  const o = await json(r);
  if (o === null || o.v !== 1 || typeof o.emetteur !== "string" || !Array.isArray(o.cles)) return null;
  const cles: CleJetons[] = [];
  for (const c of o.cles as unknown[]) {
    if (!estObj(c) || typeof c.jour !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.jour) || (c.offre !== "plus" && c.offre !== "pro") || typeof c.spki !== "string") return null;
    let spki: Uint8Array<ArrayBuffer>;
    try {
      spki = unb64u(c.spki);
    } catch {
      return null;
    }
    if (spki.length !== 342) return null;
    cles.push({ jour: c.jour, offre: c.offre, spki });
  }
  return { emetteur: o.emetteur, cles };
}

/**
 * Émission : réponses (signatures aveugles) aux demandes, dans l'ordre ; « aucun » : pass sans
 * jetons disponibles (révoqué, échu, réserve du mois ou du jour épuisée) ; null : autre échec.
 */
export async function emettre(pass: Uint8Array<ArrayBuffer>, requetes: Uint8Array<ArrayBuffer>[], n: Net = netParDefaut()): Promise<{ offre: OffrePayante; reponses: Uint8Array<ArrayBuffer>[] } | "aucun" | null> {
  const r = await appel(n, "/jetons", {
    method: "POST",
    headers: { ...entetePass(pass), "Content-Type": "application/json" },
    body: JSON.stringify({ requetes: requetes.map((x) => b64u(x)) }),
  });
  if (r?.status === 409) return "aucun";
  if (r === null || r.status !== 200) return null;
  const o = await json(r);
  if (o === null || (o.offre !== "plus" && o.offre !== "pro") || !chaines(o.reponses) || o.reponses.length !== requetes.length) return null;
  try {
    return { offre: o.offre, reponses: o.reponses.map((x) => unb64u(x)) };
  } catch {
    return null;
  }
}

/** Défi anti-robot (GET /api/captcha) pour une commande : réponse brute et instant de réception. */
export type Defi = { challenge: Record<string, unknown>; shownAt: string; receivedAt: number };

/**
 * Lit un défi pour `commander` (la page Offres est une page
 * d'information, elle ne doit pas tirer le moteur de chiffrement par transfer/). Même origine
 * seulement (credentials: "same-origin"), sans redirection. « limite » : 429 ; null : autre échec (réseau, réponse mal formée).
 */
export async function lireDefi(n: Net = netParDefaut()): Promise<Defi | "limite" | null> {
  let r: Response;
  try {
    r = await n.fetch(n.origin + "/api/captcha", { method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" });
  } catch {
    return null;
  }
  if (r.status === 429) return "limite";
  if (!r.ok) return null;
  let o: unknown;
  try {
    o = await r.json();
  } catch {
    return null;
  }
  const receivedAt = performance.now();
  if (typeof o !== "object" || o === null) return null;
  const { shown_at, ...challenge } = o as Record<string, unknown>;
  if (typeof shown_at !== "string" || shown_at.length > 512) return null;
  return { challenge, shownAt: shown_at, receivedAt };
}

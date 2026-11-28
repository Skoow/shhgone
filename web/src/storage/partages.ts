// « Mes partages » (spec §33, D42-30) : les partages envoyés et les salons créés sur cet appareil,
// gardés AUTOMATIQUEMENT (aucun interrupteur), chiffrés dans la base IndexedDB `shhdrop-partages`
// (mécanisme de storage/idb.ts). EXCEPTION ÉCRITE à « aucun stockage navigateur » (UI §12.1,
// source-rules.test.ts).
// - Une entrée ne contient que : le lien de gestion (S_gestion), pour un salon son lien
//   d'invitation (« #c<K_lien> » : il n'ouvre rien sans le mot de passe, JAMAIS gardé), le nom du
//   partage (titre du manifeste, déjà nettoyé par le moteur), la taille, le nombre d'éléments,
//   l'heure locale de création, l'échéance, les ouvertures (utilisées / maximum) et l'état.
//   JAMAIS le lien de partage (K_lien d'un envoi), le mot de passe, un nom d'élément ou un contenu :
//   tout champ inconnu est ignoré (`nettoyer`).
// - Chaque entrée est chiffrée AES-256-GCM (WebCrypto), clé créée NON EXTRACTIBLE et gardée dans
//   la même base ; nonce aléatoire de 96 bits à chaque écriture ; l'identifiant (tiré au hasard,
//   sans lien avec le partage) est la donnée associée authentifiée. Honnêtement : la clé est sur le
//   même appareil, ce chiffrement ne protège que d'une lecture naïve du stockage ; la vraie
//   protection est le verrouillage de l'appareil.
// - Entrée terminée (détruite ou échue) retirée 7 jours après sa fin.
// - `origine` : « local » (créée ici) ou « compte » (venue du coffre privé du compte, retirée de
//   l'appareil à la déconnexion).
// - Stockage absent ou refusé : ouvrirPartages rend null et le site marche sans la liste.
// Aucune requête réseau ici (relectures : partages-relecture.ts).
import { TITLE_MAX } from "../limits";
import type { Backend, Rec } from "./idb";

export const PARTAGES_DB = "shhdrop-partages";

export type Sorte = "envoi" | "salon";
export type Origine = "local" | "compte";
/** actif ; epuise : toutes les ouvertures utilisées (téléchargement en cours) ; detruit ; expire. */
export type Etat = "actif" | "epuise" | "detruit" | "expire";

export type Partage = {
  id: string;
  sorte: Sorte;
  origine: Origine;
  /** Envoi : « https://…#m<S_gestion> » ; salon : « https://…/salon#s<S_gestion> ». */
  gestion: string;
  /** Salon : « https://…#c<K_lien> » ; envoi : "" (le lien de partage n'est jamais gardé). */
  invitation: string;
  /** Envoi : titre du partage (TITLE_MAX points de code au plus) ; salon : "". */
  nom: string;
  taille: number;
  elements: number;
  /** Heure locale exacte de la création (jamais envoyée). */
  creeLe: number;
  /** Échéance (ms), d'après le serveur. */
  echeance: number;
  ouvertures: number;
  /** Envoi : 1 au moins ; salon : 0. */
  ouverturesMax: number;
  etat: Etat;
  /** Dernier état connu (création ou dernière relecture réussie). */
  vuLe: number;
  /** Fin observée (détruit, échu) ; 0 tant que le partage est actif. */
  finLe: number;
  /** Détruit depuis ce site (sinon : constaté absent du serveur). */
  detruitIci: boolean;
};
export type NouveauPartage = Pick<Partage, "sorte" | "gestion" | "creeLe" | "echeance"> & Partial<Pick<Partage, "invitation" | "nom" | "taille" | "elements" | "ouverturesMax">>;
export type Patch = Partial<Pick<Partage, "echeance" | "ouvertures" | "ouverturesMax" | "etat" | "vuLe" | "finLe" | "detruitIci">>;

export const GARDE_APRES_FIN_MS = 7 * 86_400_000;

const GESTION_ENVOI = /^https?:\/\/[^#\s]+#m[A-Za-z0-9_-]{43}$/;
const GESTION_SALON = /^https?:\/\/[^#\s]+#s[A-Za-z0-9_-]{43}$/;
const INVITATION = /^https?:\/\/[^#\s]+#c[A-Za-z0-9_-]{43}$/;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f]/;
const ID = /^[A-Za-z0-9_-]{22}$/;
const ETATS: readonly Etat[] = ["actif", "epuise", "detruit", "expire"];
const AAD = "shhdrop/partages/v1/";

const entier = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min;

/** Entrée validée champ par champ, ou null ; tout champ inconnu (mot de passe, lien de partage…) est ignoré. */
export function nettoyer(x: unknown): Partage | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID.test(o.id)) return null;
  if (o.sorte !== "envoi" && o.sorte !== "salon") return null;
  if (o.origine !== "local" && o.origine !== "compte") return null;
  const { gestion, invitation, nom } = o;
  if (typeof gestion !== "string" || typeof invitation !== "string" || typeof nom !== "string") return null;
  if (o.sorte === "envoi") {
    if (!GESTION_ENVOI.test(gestion) || invitation !== "") return null;
    if ([...nom].length > TITLE_MAX || CONTROLES.test(nom)) return null;
  } else if (!GESTION_SALON.test(gestion) || !INVITATION.test(invitation) || nom !== "") return null;
  for (const k of ["taille", "elements", "creeLe", "echeance", "ouvertures", "vuLe", "finLe"]) if (!entier(o[k])) return null;
  if (!entier(o.ouverturesMax, o.sorte === "envoi" ? 1 : 0)) return null;
  if (!ETATS.includes(o.etat as Etat) || typeof o.detruitIci !== "boolean") return null;
  return {
    id: o.id,
    sorte: o.sorte,
    origine: o.origine,
    gestion,
    invitation,
    nom,
    taille: o.taille as number,
    elements: o.elements as number,
    creeLe: o.creeLe as number,
    echeance: o.echeance as number,
    ouvertures: o.ouvertures as number,
    ouverturesMax: o.ouverturesMax as number,
    etat: o.etat as Etat,
    vuLe: o.vuLe as number,
    finLe: o.finLe as number,
    detruitIci: o.detruitIci,
  };
}

/** Ce qui identifie un partage d'un appareil à l'autre : le fragment de son lien de gestion. */
export const cleDe = (p: Pick<Partage, "gestion">): string => p.gestion.slice(p.gestion.lastIndexOf("#"));

// ---------- État affiché, tri ----------

/** État à afficher : un partage actif dont l'échéance est passée est échu (sans requête). */
export function etatVu(p: Partage, now: number): Etat {
  if ((p.etat === "actif" || p.etat === "epuise") && now >= p.echeance) return "expire";
  return p.etat;
}
export const estActif = (p: Partage, now: number): boolean => {
  const e = etatVu(p, now);
  return e === "actif" || e === "epuise";
};
/** Fin de l'entrée (tri, retrait à 7 jours) ; 0 tant qu'elle est active. */
export function finDe(p: Partage, now: number): number {
  if (p.etat === "detruit" || p.etat === "expire") return p.finLe || p.echeance;
  return etatVu(p, now) === "expire" ? p.echeance : 0;
}
/** Fini depuis 7 jours ou plus : à retirer. */
export const perime = (p: Partage, now: number): boolean => {
  const f = finDe(p, now);
  return f > 0 && now - f >= GARDE_APRES_FIN_MS;
};

/** Actifs d'abord, par échéance croissante ; puis terminés, fin la plus récente d'abord. */
export function trier(list: readonly Partage[], now: number): Partage[] {
  return [...list].sort((a, b) => {
    const fa = estActif(a, now);
    const fb = estActif(b, now);
    if (fa !== fb) return fa ? -1 : 1;
    return fa ? a.echeance - b.echeance : finDe(b, now) - finDe(a, now);
  });
}

// ---------- Ouverture ----------

export type Partages = {
  liste(): Promise<Partage[]>;
  get(id: string): Promise<Partage | null>;
  /** Ajoute une entrée de cet appareil ; même lien de gestion déjà gardé : celle-là. */
  ajouter(n: NouveauPartage): Promise<Partage>;
  /** Garde une entrée entière (venue du compte) ; faux si le même lien est déjà là. */
  garder(p: Partage): Promise<boolean>;
  modifier(id: string, patch: Patch): Promise<Partage | null>;
  retirer(id: string): Promise<void>;
};

function idAuHasard(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const aad = (id: string) => new TextEncoder().encode(AAD + id);

/**
 * Ouvre la liste. `backend` null ou toute erreur (IndexedDB absent ou refusé, clé impossible à
 * écrire, WebCrypto absent) : null. `persist` : demandé une fois, au premier ajout (le navigateur
 * est prié de ne pas effacer ce stockage quand la place manque) ; refus ou erreur sans effet.
 */
export async function ouvrirPartages(deps: { backend: Backend | null; now?: () => number; persist?: () => Promise<unknown> }): Promise<Partages | null> {
  const now = deps.now ?? Date.now;
  const b = deps.backend;
  if (b === null) return null;
  let demande = false;
  const persister = () => {
    if (demande || !deps.persist) return;
    demande = true;
    void deps.persist().catch(() => undefined);
  };
  let key: CryptoKey;
  try {
    key = await b.key(await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    // Écriture d'essai : un stockage en lecture seule ou plein se voit tout de suite.
    await b.setFlag("essai", undefined);
  } catch {
    return null;
  }

  async function sceller(p: Partage): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const { id, ...corps } = p;
    const pt = new TextEncoder().encode(JSON.stringify(corps));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(id) }, key, pt));
    pt.fill(0);
    await b!.put(id, { iv, ct });
  }
  async function ouvrir(id: string, r: Rec): Promise<Partage | null> {
    try {
      if (!ID.test(id) || !(r?.iv instanceof Uint8Array) || !(r.ct instanceof Uint8Array)) return null;
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: r.iv, additionalData: aad(id) }, key, r.ct));
      const v = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
      pt.fill(0);
      return nettoyer({ ...v, id });
    } catch {
      return null;
    }
  }
  async function tout(): Promise<Partage[]> {
    const t = now();
    const out: Partage[] = [];
    for (const [id, r] of await b!.all()) {
      const p = await ouvrir(id, r);
      // Illisible (clé perdue, enregistrement abîmé) ou fini depuis 7 jours : retiré.
      if (p === null || perime(p, t)) await b!.del(id).catch(() => undefined);
      else out.push(p);
    }
    return out;
  }

  const s: Partages = {
    liste: async () => trier(await tout(), now()),
    get: async (id) => (await tout()).find((p) => p.id === id) ?? null,
    async ajouter(n) {
      const t = now();
      const p = nettoyer({
        id: idAuHasard(),
        sorte: n.sorte,
        origine: "local",
        gestion: n.gestion,
        invitation: n.invitation ?? "",
        nom: n.nom ?? "",
        taille: n.taille ?? 0,
        elements: n.elements ?? 0,
        creeLe: n.creeLe,
        echeance: n.echeance,
        ouvertures: 0,
        ouverturesMax: n.ouverturesMax ?? 0,
        etat: "actif",
        vuLe: Math.min(t, n.creeLe),
        finLe: 0,
        detruitIci: false,
      });
      if (p === null) throw new Error("entree_invalide");
      const meme = (await tout()).find((x) => cleDe(x) === cleDe(p));
      if (meme) return meme;
      await sceller(p);
      persister();
      return p;
    },
    async garder(x) {
      const p = nettoyer(x);
      if (p === null) throw new Error("entree_invalide");
      if ((await tout()).some((y) => y.id === p.id || cleDe(y) === cleDe(p))) return false;
      await sceller(p);
      return true;
    },
    async modifier(id, patch) {
      const old = await s.get(id);
      if (!old) return null;
      const p = nettoyer({ ...old, ...patch, id: old.id, sorte: old.sorte, origine: old.origine, gestion: old.gestion, invitation: old.invitation, nom: old.nom });
      if (p === null) throw new Error("entree_invalide");
      await sceller(p);
      return p;
    },
    retirer: (id) => b.del(id),
  };
  return s;
}

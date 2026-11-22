// Pass des offres payantes gardés sur cet appareil (conception du paiement §6.1). EXCEPTION
// ÉCRITE à « aucun stockage navigateur » (source-rules.test.ts), comme le compte : base IndexedDB
// `shhdrop-pass`, nommée et lue seulement ici.
// - Chaque pass P (32 octets, tiré par crypto.getRandomValues AVANT la redirection vers le
//   prestataire) est chiffré AES-256-GCM par une clé créée NON EXTRACTIBLE et gardée dans la base
//   (même mécanisme que l'historique, history/store.ts). Honnêtement : la clé est sur le même
//   appareil ; cela ne protège que d'une lecture naïve du stockage.
// - Sans compte, perdre l'appareil (ou effacer les données du site) perd le pass : dit avant le
//   paiement. Le rangement dans le coffre privé du compte vient ensuite (plan, tâche 8).
// - Gardé aussi, ici seulement : le pays déclaré à la commande, pour la note de vente faite sur
//   l'appareil (TVA du pays, conception §9.3) ; il n'est jamais renvoyé au serveur. Rien d'autre :
//   ni prix, ni adresse de page de paiement.
// Apps (D42-20) : trousseau du système à la place, même contenu.
import { idbBackend, type Backend } from "../history/store";
import { b64u, unb64u, utf8 } from "../engine/pure";
import type { Moyen, OffrePayante } from "./api";

export const PASS_DB = "shhdrop-pass";
const AAD = "shhdrop-pass/v1/";

export type PassGarde = {
  id: string;
  pass: Uint8Array<ArrayBuffer>;
  offre: OffrePayante;
  jours: 30 | 365;
  renouvelle: boolean;
  moyen: Moyen;
  /** Commande pas encore confirmée par le serveur (page de retour). */
  enAttente: boolean;
  /** Date de la commande (millisecondes), pour trier ; jamais envoyée. */
  cree: number;
  /** Pays déclaré à la commande (ISO, deux majuscules), pour la note de vente ; jamais envoyé ensuite. */
  pays?: string;
};

/** Pays au bon format, ou undefined. */
export const paysDe = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Z]{2}$/.test(v) ? v : undefined);

/** IndexedDB du navigateur, ou null (refusé : navigation privée de certains navigateurs, cadres). */
export function idbDuNavigateur(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

const base = (idb: IDBFactory): Backend => idbBackend(idb, PASS_DB);

/** Nouveau pass : 32 octets aléatoires. */
export function tirerPass(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(32));
}

const nouvelleCle = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

export async function garder(idb: IDBFactory, g: PassGarde): Promise<void> {
  const b = base(idb);
  const key = await b.key(await nouvelleCle());
  const pt = utf8(JSON.stringify({ p: b64u(g.pass), offre: g.offre, jours: g.jours, renouvelle: g.renouvelle, moyen: g.moyen, en_attente: g.enAttente, cree: g.cree, pays: paysDe(g.pays) }));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(AAD + g.id) }, key, pt));
    await b.put(g.id, { iv, ct });
  } finally {
    pt.fill(0);
  }
}

/** Pass gardés, le plus récent d'abord ; [] si aucune base (rien n'est créé). Un enregistrement illisible est ignoré. */
export async function lirePasses(idb: IDBFactory): Promise<PassGarde[]> {
  const b = base(idb);
  try {
    if (!(await b.exists())) return [];
    const key = await b.key(await nouvelleCle());
    const out: PassGarde[] = [];
    for (const [id, rec] of await b.all()) {
      if (id.startsWith("j:")) continue; // jeton (lireJetons)
      try {
        if (!(rec?.iv instanceof Uint8Array) || !(rec.ct instanceof Uint8Array)) continue;
        const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv, additionalData: utf8(AAD + id) }, key, rec.ct));
        const o = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
        pt.fill(0);
        const pass = typeof o.p === "string" ? unb64u(o.p) : null;
        if (
          pass === null ||
          pass.length !== 32 ||
          (o.offre !== "plus" && o.offre !== "pro") ||
          (o.jours !== 30 && o.jours !== 365) ||
          typeof o.renouvelle !== "boolean" ||
          (o.moyen !== "carte" && o.moyen !== "paypal" && o.moyen !== "crypto") ||
          typeof o.en_attente !== "boolean" ||
          !Number.isSafeInteger(o.cree)
        )
          continue;
        const pays = paysDe(o.pays);
        out.push({ id, pass, offre: o.offre, jours: o.jours, renouvelle: o.renouvelle, moyen: o.moyen, enAttente: o.en_attente, cree: o.cree as number, ...(pays ? { pays } : {}) });
      } catch {
        // enregistrement abîmé : ignoré
      }
    }
    return out.sort((a, c) => c.cree - a.cree);
  } catch {
    return [];
  }
}

export async function oublier(idb: IDBFactory, id: string): Promise<void> {
  await base(idb).del(id);
}

/** Identifiant d'enregistrement : 16 caractères base64url aléatoires (aucun lien avec le pass). */
export function nouvelId(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(12)));
}

// --- Jetons anonymes gardés (conception du paiement §7) ---------------------------------------
// Même base, enregistrements « j: » à part, même chiffrement (donnée authentifiée distincte) :
// un jeton n'est relié à aucun pass dans la base (rien ne dit de quel pass il vient).

const AAD_JETON = "shhdrop-pass/v1/jeton/";

export type JetonGarde = {
  id: string;
  jeton: string;
  offre: OffrePayante;
  /** jour de sa clé (AAAA-MM-JJ, UTC) */
  jour: string;
  /** Heure d'obtention (millisecondes, horloge de l'appareil ; 0 si inconnue) : choisir un jeton
   *  « mûr » (S16, jetons.ts). Gardée ici seulement, jamais envoyée. */
  obtenu: number;
};

export async function garderJeton(idb: IDBFactory, j: Omit<JetonGarde, "id" | "obtenu"> & { obtenu?: number }): Promise<void> {
  const b = base(idb);
  const key = await b.key(await nouvelleCle());
  const id = "j:" + nouvelId();
  const pt = utf8(JSON.stringify({ jeton: j.jeton, offre: j.offre, jour: j.jour, obtenu: j.obtenu ?? 0 }));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(AAD_JETON + id) }, key, pt));
    await b.put(id, { iv, ct });
  } finally {
    pt.fill(0);
  }
}

/** Jetons gardés (illisibles ignorés) ; [] sans base. */
export async function lireJetons(idb: IDBFactory): Promise<JetonGarde[]> {
  const b = base(idb);
  try {
    if (!(await b.exists())) return [];
    const key = await b.key(await nouvelleCle());
    const out: JetonGarde[] = [];
    for (const [id, rec] of await b.all()) {
      if (!id.startsWith("j:")) continue;
      try {
        if (!(rec?.iv instanceof Uint8Array) || !(rec.ct instanceof Uint8Array)) continue;
        const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv, additionalData: utf8(AAD_JETON + id) }, key, rec.ct));
        const o = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
        pt.fill(0);
        if (typeof o.jeton !== "string" || !/^[A-Za-z0-9_-]{472}$/.test(o.jeton) || (o.offre !== "plus" && o.offre !== "pro") || typeof o.jour !== "string") continue;
        // Sans heure (version précédente) : 0, compté comme mûr.
        const obtenu = Number.isSafeInteger(o.obtenu) && (o.obtenu as number) >= 0 ? (o.obtenu as number) : 0;
        out.push({ id, jeton: o.jeton, offre: o.offre, jour: o.jour, obtenu });
      } catch {
        // abîmé : ignoré
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function retirerJeton(idb: IDBFactory, id: string): Promise<void> {
  await base(idb).del(id);
}

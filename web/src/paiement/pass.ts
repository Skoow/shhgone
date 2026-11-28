// Pass des offres payantes gardés sur cet appareil (conception du paiement §6.1). EXCEPTION
// ÉCRITE à « aucun stockage navigateur » (source-rules.test.ts), comme le compte : base IndexedDB
// `shhdrop-pass`, nommée et lue seulement ici.
// - Chaque pass P (32 octets, tiré par crypto.getRandomValues AVANT la redirection vers le
//   prestataire) est chiffré AES-256-GCM par une clé créée NON EXTRACTIBLE et gardée dans la base
//   (même mécanisme que l'historique, history/store.ts). Honnêtement : la clé est sur le même
//   appareil ; cela ne protège que d'une lecture naïve du stockage.
// - Sans compte, perdre l'appareil (ou effacer les données du site) perd le pass : dit avant le
//   paiement. Le rangement dans le coffre privé du compte vient ensuite.
// - Gardé aussi, ici seulement : le pays déclaré à la commande, pour la note de vente faite sur
//   l'appareil (TVA du pays, conception §9.3) ; il n'est jamais renvoyé au serveur. Rien d'autre :
//   ni prix, ni adresse de page de paiement.
// Apps (D42-20) : trousseau du système à la place, même contenu.
import { idbBackend, type Backend } from "../storage/idb";
import { b64u, unb64u, utf8 } from "../engine/pure";
import type { Moyen, OffrePayante } from "./api";

export const PASS_DB = "shhdrop-pass";
const AAD = "shhdrop-pass/v1/";

/**
 * Origine d'un pass : moyen de paiement, ou « offert » (accès offert par l'exploitant depuis le
 * tableau de bord, sans paiement ni note de vente : conception du paiement, « Accès offerts »).
 * Même valeur dans le coffre privé du compte (account/pass.ts) ; les apps la liront telle quelle.
 */
export type OriginePass = Moyen | "offert";
export const ORIGINES_PASS: readonly OriginePass[] = ["carte", "paypal", "crypto", "offert"];

export type PassGarde = {
  id: string;
  pass: Uint8Array<ArrayBuffer>;
  offre: OffrePayante;
  /** Période commandée ; sans objet pour un accès offert (365 : sa vraie fin est lue chez le serveur). */
  jours: 30 | 365;
  renouvelle: boolean;
  moyen: OriginePass;
  /** Commande pas encore confirmée par le serveur (page de retour). */
  enAttente: boolean;
  /** Date de la commande (millisecondes), pour trier ; jamais envoyée. */
  cree: number;
  /** Pays déclaré à la commande (ISO, deux majuscules), pour la note de vente ; jamais envoyé ensuite. */
  pays?: string;
  /**
   * Rangé dans le coffre privé du compte (écriture confirmée par le serveur du compte, ou venu du
   * coffre) : ce pass suit le compte sur cet appareil et le quitte à la déconnexion (« Pass et
   * compte », conception du paiement §6.4). Absent : pas (encore) dans un compte.
   */
  compte?: boolean;
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

/** `garderEtat` : l'état gardé reste (simple marque « rangé dans le compte ») ; sinon il est à relire. */
export async function garder(idb: IDBFactory, g: PassGarde, o: { garderEtat?: boolean } = {}): Promise<void> {
  const b = base(idb);
  const key = await b.key(await nouvelleCle());
  const pt = utf8(JSON.stringify({ p: b64u(g.pass), offre: g.offre, jours: g.jours, renouvelle: g.renouvelle, moyen: g.moyen, en_attente: g.enAttente, cree: g.cree, pays: paysDe(g.pays), ...(g.compte === true ? { compte: true } : {}) }));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(AAD + g.id) }, key, pt));
    await b.put(g.id, { iv, ct });
  } finally {
    pt.fill(0);
  }
  // Pass rangé de nouveau (retour de paiement, compte) : son état gardé est à relire.
  if (!o.garderEtat) await oublierEtat(idb, g.id);
}

/** Pass gardés, le plus récent d'abord ; [] si aucune base (rien n'est créé). Un enregistrement illisible est ignoré. */
export async function lirePasses(idb: IDBFactory): Promise<PassGarde[]> {
  const b = base(idb);
  try {
    if (!(await b.exists())) return [];
    const key = await b.key(await nouvelleCle());
    const out: PassGarde[] = [];
    for (const [id, rec] of await b.all()) {
      if (id.startsWith("j:") || id.startsWith("c:") || id.startsWith("e:")) continue; // jeton, clé vue, état gardé
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
          !(ORIGINES_PASS as readonly unknown[]).includes(o.moyen) ||
          typeof o.en_attente !== "boolean" ||
          !Number.isSafeInteger(o.cree)
        )
          continue;
        const pays = paysDe(o.pays);
        out.push({ id, pass, offre: o.offre, jours: o.jours, renouvelle: o.renouvelle, moyen: o.moyen as OriginePass, enAttente: o.en_attente, cree: o.cree as number, ...(pays ? { pays } : {}), ...(o.compte === true ? { compte: true } : {}) });
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
  await oublierEtat(idb, id);
}

// --- État du pass gardé (signalement) ------------------------------------------
// POST /api/paiement/etat envoie P : redemandé à chaque chargement, il datait le pass à chaque
// visite. L'état lu est gardé chiffré (enregistrement « e:<id du pass> »), avec le jour UTC de sa
// lecture, et resservi ce jour-là seulement ; oublié quand le pass est rangé de nouveau ou oublié,
// et sur un événement qui le change (jetons.ts : émission refusée ; OffersReturn : résiliation).

const AAD_ETAT = "shhdrop-pass/v1/etat/";

export type EtatGarde = { etat: string; offre: OffrePayante | null; fin: string | null; renouvelle: boolean; droits: string[]; /** jour UTC de la lecture */ jour: string };

export async function garderEtat(idb: IDBFactory, id: string, e: EtatGarde): Promise<void> {
  const b = base(idb);
  const key = await b.key(await nouvelleCle());
  const rid = "e:" + id;
  const pt = utf8(JSON.stringify(e));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(AAD_ETAT + rid) }, key, pt));
    await b.put(rid, { iv, ct });
  } finally {
    pt.fill(0);
  }
}

/** État gardé du pass `id`, ou null (absent, illisible). */
export async function lireEtatGarde(idb: IDBFactory, id: string): Promise<EtatGarde | null> {
  const b = base(idb);
  try {
    if (!(await b.exists())) return null;
    const rid = "e:" + id;
    const rec = (await b.all()).find(([k]) => k === rid)?.[1];
    if (!(rec?.iv instanceof Uint8Array) || !(rec.ct instanceof Uint8Array)) return null;
    const key = await b.key(await nouvelleCle());
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv, additionalData: utf8(AAD_ETAT + rid) }, key, rec.ct));
    const o = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    pt.fill(0);
    if (
      typeof o.etat !== "string" ||
      !(o.offre === null || o.offre === "plus" || o.offre === "pro") ||
      !(o.fin === null || typeof o.fin === "string") ||
      typeof o.renouvelle !== "boolean" ||
      !Array.isArray(o.droits) ||
      !o.droits.every((d) => typeof d === "string") ||
      typeof o.jour !== "string"
    )
      return null;
    return { etat: o.etat, offre: o.offre, fin: o.fin, renouvelle: o.renouvelle, droits: o.droits as string[], jour: o.jour };
  } catch {
    return null;
  }
}

export async function oublierEtat(idb: IDBFactory, id: string): Promise<void> {
  const b = base(idb);
  if (await b.exists().catch(() => false)) await b.del("e:" + id).catch(() => undefined);
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

/**
 * Suppression du compte (abonnement perdu) : les pass `ids` (et leur état gardé) quittent cet
 * appareil, avec tous les jetons gardés (rien ne dit de quel pass vient un jeton ; seuls des pass
 * payés en donnent). Une commande en attente, absente de `ids`, reste. Sans base : rien.
 */
export async function oublierAbonnements(idb: IDBFactory, ids: readonly string[]): Promise<void> {
  const b = base(idb);
  if (!(await b.exists().catch(() => false))) return;
  for (const id of ids) await oublier(idb, id);
  for (const [id] of await b.all()) if (id.startsWith("j:")) await b.del(id);
}

/**
 * Le compte quitte cet appareil (déconnexion, démarrage sans session gardée) : les pass rangés
 * dans son coffre (`compte`) partent avec lui ; il les rend à la prochaine connexion. Un pass pas
 * encore rangé (écriture du coffre en échec) ou une commande en attente restent : rien n'est
 * perdu. Plus aucun pass utilisable ici : les jetons partent aussi. Rend le nombre retiré.
 */
export async function retirerPassDuCompte(idb: IDBFactory): Promise<number> {
  const tous = await lirePasses(idb);
  const partent = tous.filter((g) => g.compte === true);
  if (partent.length === 0) return 0;
  for (const g of partent) await oublier(idb, g.id);
  if (!tous.some((g) => g.compte !== true && !g.enAttente)) {
    const b = base(idb);
    for (const [id] of await b.all()) if (id.startsWith("j:")) await b.del(id);
  }
  return partent.length;
}

// --- Clés d'émission vues (S17, conception du paiement §7) -------------------------------------
// Même base, enregistrements « c: » (identifiant aléatoire), même chiffrement : la clé publique
// entière (SPKI, base64url) servie pour un (jour, formule), et `differente` si le serveur en a
// servi une autre pour ce même (jour, formule). Gardées jusqu'au surlendemain de leur jour.

const AAD_CLE = "shhdrop-pass/v1/cle/";

export type CleVue = { id: string; jour: string; offre: OffrePayante; spki: string; differente: boolean };

/** Range une clé vue ; `id` donné : remplace cet enregistrement. */
export async function garderCleVue(idb: IDBFactory, c: Omit<CleVue, "id"> & { id?: string }): Promise<void> {
  const b = base(idb);
  const key = await b.key(await nouvelleCle());
  const id = c.id ?? "c:" + nouvelId();
  const pt = utf8(JSON.stringify({ jour: c.jour, offre: c.offre, spki: c.spki, differente: c.differente }));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(AAD_CLE + id) }, key, pt));
    await b.put(id, { iv, ct });
  } finally {
    pt.fill(0);
  }
}

/** Clés vues (illisibles ignorées) ; [] sans base. */
export async function lireClesVues(idb: IDBFactory): Promise<CleVue[]> {
  const b = base(idb);
  try {
    if (!(await b.exists())) return [];
    const key = await b.key(await nouvelleCle());
    const out: CleVue[] = [];
    for (const [id, rec] of await b.all()) {
      if (!id.startsWith("c:")) continue;
      try {
        if (!(rec?.iv instanceof Uint8Array) || !(rec.ct instanceof Uint8Array)) continue;
        const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv, additionalData: utf8(AAD_CLE + id) }, key, rec.ct));
        const o = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
        pt.fill(0);
        if (typeof o.jour !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.jour) || (o.offre !== "plus" && o.offre !== "pro") || typeof o.spki !== "string" || typeof o.differente !== "boolean") continue;
        out.push({ id, jour: o.jour, offre: o.offre, spki: o.spki, differente: o.differente });
      } catch {
        // abîmé : ignoré
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function retirerCleVue(idb: IDBFactory, id: string): Promise<void> {
  await base(idb).del(id);
}

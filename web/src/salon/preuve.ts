// Preuve de membre du salon (spec §39.13.3, D41-26 ; plan C-5 Task 6). EXCEPTION ÉCRITE à « aucun
// stockage navigateur » (source-rules.test.ts) : seul ce module touche la base IndexedDB
// `shhdrop-salon`. But : un invité qui recharge la page (ou ferme l'onglet) retrouve sa place,
// son pseudonyme et sa couleur en retapant le mot de passe, sans prendre une nouvelle place.
// - Clé : K_m = HKDF(Argon2id(mot de passe, sel_m, paramètres de création) ‖ K_lien,
//   « shhdrop/v2/salon/membre-local ») (moteur), importée NON EXTRACTIBLE dans WebCrypto ;
//   paquet = AES-256-GCM (WebCrypto), nonce aléatoire de 96 bits à chaque écriture, données
//   authentifiées « shhdrop/v2/salon/membre » ‖ index. Décision par défaut (plan C-5 point 7) :
//   AES-256-GCM de WebCrypto au lieu de XChaCha20-Poly1305 de libsodium (retiré du site) ;
//   format local à l'appareil, aucun échange avec le serveur ni avec les apps.
// - Index de l'entrée : HKDF(K_lien, « shhdrop/v2/salon/membre-index »), 16 octets.
// - Contenu (JSON) : jeton de membre, siège, pseudonyme, couleur, K_maître_s COURANTE (réécrite à
//   chaque rotation), S_gestion pour le créateur, et le réglage « silencieux » (v3 §14.4). Jamais un message, une clé MLS ni le mot de
//   passe. `purge_apres` en clair : fin du salon arrondie à l'heure, pour effacer sans mot de
//   passe les entrées de salons finis.
// - Effacée à « Quitter », à l'exclusion, à la fin du salon et quand le serveur refuse le jeton ;
//   toute la base (réglage « silencieux » compris) part avec « Effacer l'historique » (effacerTout).
// Risque résiduel (spec §39.13.3) : une copie du stockage permet d'essayer des mots de passe hors
// ligne ; il faut aussi le lien (K_lien entre dans K_m) et le mot de passe est généré.
import { b64u, unb64u, utf8 } from "../engine/pure";

const BASE = "shhdrop-salon";
const MAGASIN = "preuves";
const AD = "shhdrop/v2/salon/membre";

export type Contenu = { jeton: string; siege: number; pseudo: string; couleur: number; kMaitre: Uint8Array; sGestion?: Uint8Array; silence?: number; appels?: boolean };
type Rec = { sel: Uint8Array; iv: Uint8Array; paquet: Uint8Array; purge_apres: number };

function idb(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function ouvrirBase(): Promise<IDBDatabase | null> {
  const f = idb();
  if (!f) return Promise.resolve(null);
  return new Promise((ok) => {
    let r: IDBOpenDBRequest;
    try {
      r = f.open(BASE, 1);
    } catch {
      return ok(null);
    }
    r.onupgradeneeded = () => r.result.createObjectStore(MAGASIN);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ok(null);
    r.onblocked = () => ok(null);
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await ouvrirBase();
  if (!db) return undefined;
  try {
    return await new Promise<T | undefined>((ok) => {
      const t = db.transaction(MAGASIN, mode);
      const req = f(t.objectStore(MAGASIN));
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(undefined);
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** Clé WebCrypto de K_m (non extractible) ; les octets sont effacés. */
export async function importerCle(km: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey("raw", km, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    km.fill(0);
  }
}

const ad = (index: Uint8Array) => {
  const a = utf8(AD);
  const out = new Uint8Array(a.length + index.length);
  out.set(a);
  out.set(index, a.length);
  return out;
};

/** Écrit (ou réécrit) la preuve ; échec silencieux si le stockage est refusé (rien ne casse). */
export async function ecrire(index: Uint8Array, cle: CryptoKey, sel: Uint8Array, c: Contenu, finMs: number): Promise<void> {
  const clair = utf8(JSON.stringify({ v: 1, jeton: c.jeton, siege: c.siege, pseudo: c.pseudo, couleur: c.couleur, kMaitre: b64u(c.kMaitre as Uint8Array<ArrayBuffer>), ...(c.sGestion ? { sGestion: b64u(c.sGestion as Uint8Array<ArrayBuffer>) } : {}), ...(c.silence ? { silence: c.silence } : {}), ...(c.appels ? { appels: true } : {}) }));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const paquet = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad(index) }, cle, clair));
    const rec: Rec = { sel: sel.slice(), iv, paquet, purge_apres: Math.ceil(finMs / 3_600_000) * 3_600_000 };
    await tx("readwrite", (s) => s.put(rec, b64u(index as Uint8Array<ArrayBuffer>)));
  } finally {
    clair.fill(0);
  }
}

/** Sel de l'entrée de cet index (pour refaire K_m avec le mot de passe), ou null. */
export async function lireSel(index: Uint8Array): Promise<Uint8Array<ArrayBuffer> | null> {
  const rec = (await tx("readonly", (s) => s.get(b64u(index as Uint8Array<ArrayBuffer>)))) as Rec | undefined;
  if (!rec || !(rec.sel instanceof Uint8Array) || rec.sel.length !== 16) return null;
  if (rec.purge_apres < Date.now()) {
    await effacer(index);
    return null;
  }
  return new Uint8Array(rec.sel);
}

/** Ouvre la preuve ; null si elle est absente, illisible (mauvais mot de passe) ou mal formée. */
export async function ouvrir(index: Uint8Array, cle: CryptoKey): Promise<Contenu | null> {
  const rec = (await tx("readonly", (s) => s.get(b64u(index as Uint8Array<ArrayBuffer>)))) as Rec | undefined;
  if (!rec) return null;
  let clair: Uint8Array<ArrayBuffer>;
  try {
    clair = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(rec.iv), additionalData: ad(index) }, cle, new Uint8Array(rec.paquet)));
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(new TextDecoder().decode(clair)) as Record<string, unknown>;
    if (o.v !== 1 || typeof o.jeton !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(o.jeton) || !Number.isInteger(o.siege) || typeof o.pseudo !== "string" || !Number.isInteger(o.couleur) || typeof o.kMaitre !== "string") return null;
    const kMaitre = unb64u(o.kMaitre);
    const sGestion = typeof o.sGestion === "string" ? unb64u(o.sGestion) : undefined;
    if (kMaitre.length !== 32 || (sGestion && sGestion.length !== 32)) return null;
    const silence = Number.isSafeInteger(o.silence) && (o.silence as number) >= -1 ? (o.silence as number) : 0;
    return { jeton: o.jeton, siege: o.siege as number, pseudo: o.pseudo, couleur: o.couleur as number, kMaitre, sGestion, silence, appels: o.appels === true };
  } catch {
    return null;
  } finally {
    clair.fill(0);
  }
}

export async function effacer(index: Uint8Array): Promise<void> {
  await tx("readwrite", (s) => s.delete(b64u(index as Uint8Array<ArrayBuffer>)));
}

/** « Effacer l'historique » (history/live.svelte.ts) : supprime toute la base, toutes les preuves
 *  et le réglage « silencieux » qu'elles portent. Une base tenue par un autre onglet (onblocked)
 *  est supprimée dès qu'il la relâche ; aucune erreur ne remonte. */
export function effacerTout(): Promise<void> {
  const f = idb();
  if (!f) return Promise.resolve();
  return new Promise((ok) => {
    try {
      const r = f.deleteDatabase(BASE);
      r.onsuccess = () => ok();
      r.onerror = () => ok();
      r.onblocked = () => ok();
    } catch {
      ok();
    }
  });
}

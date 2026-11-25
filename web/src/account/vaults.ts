// Les deux coffres du compte (conception compte §21.2, §21.5, §37.2 ; serveur : compte/coffres.go).
// Forme commune, prouvée par engine/vectors/compte-v3.json : « SHH-ACCT1 » (privé, clé K_prive tirée
// de K_compte) ou « SHH-PROF1 » (profil, clé K_profil tirée elle aussi de K_compte : plus de
// séquestre, le serveur ne lit ni l'un ni l'autre) (9) ‖ gen (8, gros-boutiste) ‖ nonce (12) ‖
// AES-256-GCM(clé, nonce, clair, AD = en-tête ‖ h ‖ gen) ; clair = longueur (4) ‖ JSON ‖ zéros,
// au plus petit palier de 4, 16, 64 ou 256 Kio qui le contient.
// - Coffre de profil : pseudo, photo (≤ 64 Ko), langue, réglages, pass ; RIEN d'autre (aucune
//   clé, aucun lien : le serveur peut l'ouvrir). JSON strict `v: 1` ; une version inconnue n'est
//   ni lue ni réécrite (coffre_version : on n'écrase pas un format plus récent).
// - Coffre privé : listes salons, recus, rejoints, envois (entrées à `id` unique ; leur contenu
//   est fixé avec l'historique de l'appareil).
// - Écriture : `if_gen` = gen connu, coffre scellé avec gen + 1 ; 409 → relecture du coffre du
//   serveur, les modifications en attente sont rejouées dessus (fusion), nouvel essai (3 au plus).
//   Un gen plus petit que le plus grand vu est refusé (coffre_recule : retour en arrière du
//   serveur ou rejeu d'un vieux coffre).
import { CompteError } from "./api";
import { b64u, concat, unb64u, utf8 } from "../engine/pure";

type Bytes = Uint8Array<ArrayBuffer>;
export type Sorte = "profil" | "prive";
export const PALIERS = [4096, 16384, 65536, 262144] as const;
const MAGIE: Record<Sorte, string> = { profil: "SHH-PROF1", prive: "SHH-ACCT1" };
const ENTETE = 17;
const SURCOUT = ENTETE + 12 + 16;
/** Photo de profil : 64 Ko au plus (256 × 256, ré-encodée sur l'appareil, salon v3 §7.2). */
export const PHOTO_MAX = 65536;

const illisible = () => new Error("coffre_illisible");

function genOctets(gen: number): Bytes {
  if (!Number.isSafeInteger(gen) || gen < 0) throw new Error("gen_invalide");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(gen));
  return b;
}
const ad = (sorte: Sorte, h: Uint8Array, gen: Bytes) => concat(utf8(MAGIE[sorte]), h, gen);

/** Coffre scellé ; `nonce` seulement pour les vecteurs. JSON trop grand : coffre_trop_grand. */
export async function sceller(sorte: Sorte, cle: CryptoKey, h: Uint8Array, gen: number, json: Uint8Array, nonce?: Uint8Array): Promise<Bytes> {
  const palier = PALIERS.find((p) => 4 + json.length <= p);
  if (palier === undefined) throw new Error("coffre_trop_grand");
  const clair = new Uint8Array(palier);
  new DataView(clair.buffer).setUint32(0, json.length);
  clair.set(json, 4);
  const g = genOctets(gen);
  const iv = (nonce ?? crypto.getRandomValues(new Uint8Array(12))) as Bytes;
  try {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad(sorte, h, g) }, cle, clair));
    return concat(utf8(MAGIE[sorte]), g, iv, ct);
  } finally {
    clair.fill(0);
  }
}

/** JSON du coffre, s'il porte exactement `gen` (celui que donne le serveur) ; sinon coffre_illisible. */
export async function ouvrir(sorte: Sorte, cle: CryptoKey, h: Uint8Array, blob: Uint8Array, gen: number): Promise<Bytes> {
  if (!PALIERS.some((p) => blob.length === p + SURCOUT)) throw illisible();
  const g = genOctets(gen);
  if (new TextDecoder().decode(blob.slice(0, 9)) !== MAGIE[sorte] || !blob.slice(9, 17).every((x, i) => x === g[i])) throw illisible();
  let pt: Bytes;
  try {
    pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(17, 29), additionalData: ad(sorte, h, g) }, cle, blob.slice(29)));
  } catch {
    throw illisible();
  }
  try {
    const n = new DataView(pt.buffer).getUint32(0);
    if (n > pt.length - 4 || !pt.subarray(4 + n).every((x) => x === 0)) throw illisible();
    return pt.slice(4, 4 + n);
  } finally {
    pt.fill(0);
  }
}

// --- Contenu ---------------------------------------------------------------------------------

/**
 * Réglages du compte (§21.15.4 ; ceux de l'appareil seul, comme « Rester connecté », n'y sont pas).
 * `garder_salons` et `garder_recus` (« Garder les liens que j'ouvre ») retirés avec l'historique
 * local des liens (25 novembre, spec §33) : un coffre ancien qui les porte est lu sans erreur
 * (champ inconnu ignoré) et réécrit sans eux.
 */
export type Reglages = { proposerProfil: boolean };
export const REGLAGES_DEFAUT: Reglages = { proposerProfil: true };

export type Profil = { pseudo: string; photo: Uint8Array | null; langue: string; reglages: Reglages; pass: string | null };

/**
 * Entrée d'une liste du coffre privé. Les quatre listes (salons, recus, rejoints, envois) venaient
 * de l'historique local des liens, retiré le 25 novembre (spec §33) : le format les garde, vides
 * (session.svelte.ts vide un coffre ancien à l'ouverture), pour ne pas changer la forme du coffre.
 */
export type EntreePrivee = { id: string } & Record<string, unknown>;
/**
 * `pass` (conception du paiement §6.2, DP-8) : pass des offres payantes, dans le coffre PRIVÉ
 * (ouvert par une passkey ou la clé de récupération, comme le profil) ; écrit seulement s'il
 * en existe (un coffre sans pass garde exactement sa forme d'avant, vecteurs compte-v3.json).
 */
export type CoffrePrive = { salons: EntreePrivee[]; recus: EntreePrivee[]; rejoints: EntreePrivee[]; envois: EntreePrivee[]; pass?: EntreePrivee[] };
const LISTES = ["salons", "recus", "rejoints", "envois"] as const;

export const priveVide = (): CoffrePrive => ({ salons: [], recus: [], rejoints: [], envois: [] });

const LANGUES = ["fr", "en"];
const enc = (v: unknown) => utf8(JSON.stringify(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function lireJson(b: Uint8Array): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  } catch {
    throw illisible();
  }
  if (!isObj(v)) throw illisible();
  if (v.v !== 1) throw new Error(Number.isSafeInteger(v.v) ? "coffre_version" : "coffre_illisible");
  return v;
}

/** JSON du coffre de profil : exactement v, pseudo, photo, langue, reglages, pass. */
export function profilEnJson(p: Profil): Bytes {
  if (typeof p.pseudo !== "string" || p.pseudo === "" || !LANGUES.includes(p.langue)) throw new Error("profil_invalide");
  if (p.photo !== null && p.photo.length > PHOTO_MAX) throw new Error("photo_trop_grande");
  const r = p.reglages;
  return enc({
    v: 1,
    pseudo: p.pseudo,
    photo: p.photo === null ? null : b64u(p.photo as Bytes),
    langue: p.langue,
    reglages: { proposer_profil: r.proposerProfil === true },
    pass: typeof p.pass === "string" ? p.pass : null,
  });
}

/** Coffre de profil lu ; champs facultatifs absents : valeurs par défaut ; champs inconnus ignorés. */
export function profilDeJson(b: Uint8Array): Profil {
  const o = lireJson(b);
  if (typeof o.pseudo !== "string" || o.pseudo === "" || typeof o.langue !== "string" || !LANGUES.includes(o.langue)) throw illisible();
  let photo: Uint8Array | null = null;
  if (o.photo !== undefined && o.photo !== null) {
    if (typeof o.photo !== "string") throw illisible();
    try {
      photo = unb64u(o.photo);
    } catch {
      throw illisible();
    }
    if (photo.length > PHOTO_MAX) throw illisible();
  }
  const r = o.reglages === undefined ? {} : o.reglages;
  if (!isObj(r)) throw illisible();
  const bool = (k: string, d: boolean) => {
    if (r[k] === undefined) return d;
    if (typeof r[k] !== "boolean") throw illisible();
    return r[k] as boolean;
  };
  if (o.pass !== undefined && o.pass !== null && typeof o.pass !== "string") throw illisible();
  return {
    pseudo: o.pseudo,
    photo,
    langue: o.langue,
    reglages: { proposerProfil: bool("proposer_profil", true) },
    pass: typeof o.pass === "string" ? o.pass : null,
  };
}

function liste(v: unknown): EntreePrivee[] {
  if (!Array.isArray(v)) throw illisible();
  const ids = new Set<string>();
  for (const e of v) {
    if (!isObj(e) || typeof e.id !== "string" || e.id === "" || ids.has(e.id)) throw illisible();
    ids.add(e.id);
  }
  return v as EntreePrivee[];
}

export function priveEnJson(p: CoffrePrive): Bytes {
  const o: Record<string, unknown> = { v: 1, salons: liste(p.salons), recus: liste(p.recus), rejoints: liste(p.rejoints), envois: liste(p.envois) };
  if (p.pass !== undefined && p.pass.length > 0) o.pass = liste(p.pass);
  return enc(o);
}

export function priveDeJson(b: Uint8Array): CoffrePrive {
  const o = lireJson(b);
  const out = priveVide();
  for (const k of LISTES) out[k] = liste(o[k]);
  if (o.pass !== undefined) out.pass = liste(o.pass);
  return out;
}

// --- Écritures avec fusion -------------------------------------------------------------------

/** Accès au coffre du serveur (api.ts), pour une session. */
export type Transport = {
  lire(): Promise<{ blob: Uint8Array; gen: number }>;
  /** Nouveau gen ; 409 : CompteError("conflict") avec le gen du serveur. */
  ecrire(ifGen: number, blob: Bytes): Promise<number>;
};

export type Coffre<T> = {
  readonly valeur: T;
  readonly gen: number;
  /** Applique `patch` au contenu courant et l'écrit ; sur 409, relit et rejoue `patch`. */
  ecrire(patch: (v: T) => T): Promise<T>;
  /** Relit le coffre du serveur (gen plus petit que le plus grand vu : coffre_recule). */
  relire(): Promise<T>;
};

const ESSAIS = 3;

export function creerCoffre<T>(o: {
  sorte: Sorte;
  cle: CryptoKey;
  h: Uint8Array;
  transport: Transport;
  versJson: (v: T) => Bytes;
  deJson: (b: Uint8Array) => T;
  valeur: T;
  gen: number;
}): Coffre<T> {
  let valeur = o.valeur;
  let gen = o.gen;
  /** Plus grand gen vu (lu ou écrit) : jamais moins. */
  let vu = o.gen;
  const voir = (g: number) => {
    if (g < vu) throw new Error("coffre_recule");
    vu = g;
  };
  async function relire(): Promise<T> {
    const r = await o.transport.lire();
    voir(r.gen);
    const v = o.deJson(await ouvrir(o.sorte, o.cle, o.h, r.blob, r.gen));
    valeur = v;
    gen = r.gen;
    return v;
  }
  return {
    get valeur() {
      return valeur;
    },
    get gen() {
      return gen;
    },
    relire,
    async ecrire(patch) {
      for (let i = 0; ; i++) {
        const next = patch(valeur);
        const blob = await sceller(o.sorte, o.cle, o.h, gen + 1, o.versJson(next));
        try {
          const g = await o.transport.ecrire(gen, blob);
          if (g !== gen + 1) throw new Error("reponse_invalide");
          voir(g);
          valeur = next;
          gen = g;
          return next;
        } catch (e) {
          if (!(e instanceof CompteError && e.status === 409 && e.code === "conflict") || i + 1 >= ESSAIS) throw e;
          if (e.gen !== undefined) voir(e.gen);
          await relire();
        }
      }
    },
  };
}

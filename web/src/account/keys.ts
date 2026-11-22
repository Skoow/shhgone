// Clés du compte sur l'appareil (conception 2026-11-22-compte-passkey-design.md §5). Aucune
// construction nouvelle : dérivations (HKDF-SHA-256) et AD par le moteur Rust (src/engine/),
// AES-256-GCM et aléa par WebCrypto, comme les vecteurs communs engine/vectors/compte-v3.json
// (rejoués par keys.test.ts).
// - Enveloppe de K_compte : nonce (12) ‖ AES-256-GCM(KEK, nonce, K_compte, AD) = 60 octets ;
//   PRF : KEK_i = HKDF(P_i), AD = « SHH-CENV2 » ‖ h ‖ SHA-256(cred_id) ;
//   récupération : KEK_r = HKDF(R), AD = « SHH-CENV2 » ‖ h ‖ « recup ».
// - K_prive = HKDF(K_compte, « shhdrop/v2/compte/blob »), K_etiquette = HKDF(K_compte,
//   « shhdrop/v2/compte/appareil »), K_profil = HKDF(K_compte, « shhdrop/v3/compte/profil ») :
//   importées NON EXTRACTIBLES dans WebCrypto, octets dérivés mis à zéro aussitôt.
import { adEnveloppePrf, adEnveloppeRecup, cleAppareil, clePrive, cleProfilCompte, kekPrf } from "../engine/index";
import { concat } from "../engine/pure";

type Bytes = Uint8Array<ArrayBuffer>;
export const ENV_LEN = 60;

/** 32 octets aléatoires (K_compte) ; l'appelant les efface après usage. */
export function aleatoire32(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function aes(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as Bytes, "AES-GCM", false, usages);
}

/** Enveloppe de 60 octets ; `nonce` seulement pour les vecteurs (sinon tiré au hasard). */
export async function sceller(kek: Uint8Array, ad: Uint8Array, kCompte: Uint8Array, nonce?: Uint8Array): Promise<Bytes> {
  const iv = (nonce ?? crypto.getRandomValues(new Uint8Array(12))) as Bytes;
  const k = await aes(kek, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad as Bytes }, k, kCompte as Bytes));
  return concat(iv, ct);
}

/** K_compte ; tout défaut (taille, AD, clé, octet changé) : Error("enveloppe_invalide"). */
export async function ouvrir(kek: Uint8Array, ad: Uint8Array, env: Uint8Array): Promise<Bytes> {
  if (env.length !== ENV_LEN) throw new Error("enveloppe_invalide");
  try {
    const k = await aes(kek, ["decrypt"]);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: env.slice(0, 12), additionalData: ad as Bytes }, k, env.slice(12)));
    if (pt.length !== 32) throw new Error();
    return pt;
  } catch {
    throw new Error("enveloppe_invalide");
  }
}

/** Enveloppe PRF de K_compte pour la passkey credId, avec sa sortie PRF P. */
export async function enveloppePrf(p: Uint8Array, h: Uint8Array, credId: Uint8Array, kCompte: Uint8Array, nonce?: Uint8Array): Promise<Bytes> {
  const kek = await kekPrf(p);
  try {
    return await sceller(kek, await adEnveloppePrf(h, credId), kCompte, nonce);
  } finally {
    kek.fill(0);
  }
}

/**
 * Essaie chaque enveloppe PRF de la passkey avec sa sortie P (une même passkey peut en avoir
 * plusieurs : sorties PRF différentes selon l'appareil ou le gestionnaire, conception §17) ;
 * K_compte de la première qui s'ouvre, ou null.
 */
export async function ouvrirEnveloppesPrf(p: Uint8Array, h: Uint8Array, credId: Uint8Array, envs: readonly Uint8Array[]): Promise<Bytes | null> {
  if (envs.length === 0) return null;
  const kek = await kekPrf(p);
  try {
    const ad = await adEnveloppePrf(h, credId);
    for (const e of envs) {
      try {
        return await ouvrir(kek, ad, e);
      } catch {
        // étiquette fausse : sortie PRF différente pour cette enveloppe, on essaie la suivante
      }
    }
    return null;
  } finally {
    kek.fill(0);
  }
}

/** Env_r (60 octets) avec KEK_r. */
export async function enveloppeRecup(kekR: Uint8Array, h: Uint8Array, kCompte: Uint8Array, nonce?: Uint8Array): Promise<Bytes> {
  return sceller(kekR, await adEnveloppeRecup(h), kCompte, nonce);
}

/** K_compte par Env_r ; une étiquette fausse veut dire une base altérée : enveloppe_invalide (§5.4). */
export async function ouvrirRecup(kekR: Uint8Array, h: Uint8Array, envR: Uint8Array): Promise<Bytes> {
  return ouvrir(kekR, await adEnveloppeRecup(h), envR);
}

/** Clés non extractibles des deux coffres et des libellés (appareil, passkey). */
export type ClesCompte = { prive: CryptoKey; profil: CryptoKey; etiquette: CryptoKey };

async function importer(derive: Promise<Uint8Array>): Promise<CryptoKey> {
  const raw = await derive;
  try {
    return await aes(raw, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

export async function clesDuCompte(kCompte: Uint8Array): Promise<ClesCompte> {
  return { prive: await importer(clePrive(kCompte)), profil: await importer(cleProfilCompte(kCompte)), etiquette: await importer(cleAppareil(kCompte)) };
}

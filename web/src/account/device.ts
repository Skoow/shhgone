// Nom d'appareil d'une session (conception compte §8.5) : calculé sur l'appareil à partir du seul
// navigateur et de la sorte d'appareil (« Firefox · ordinateur »), jamais la version ni le système
// précis ; chiffré par K_etiquette avant d'être envoyé (64 octets fixes : le serveur n'en apprend
// pas la longueur) :
//   nonce (12) ‖ AES-256-GCM(K_etiquette, nonce, clair (36), AD = « SHH-CETQ1 » ‖ h),
//   clair = longueur (1) ‖ nom en UTF-8 (35 octets au plus, coupé sur un caractère) ‖ zéros.
// Format défini ici (la conception ne le fixait pas) : à ajouter aux vecteurs communs
// (engine/vectors/compte-v3.json) avant les apps (D42-20).
import { concat, utf8 } from "../engine/pure";

type Bytes = Uint8Array<ArrayBuffer>;
export const ETIQUETTE_LEN = 64;
const CLAIR = ETIQUETTE_LEN - 12 - 16;
const NOM_MAX = CLAIR - 1;
const ad = (h: Uint8Array) => concat(utf8("SHH-CETQ1"), h);

export function nomAppareil(ua: string): string {
  const nav = /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navigateur";
  const sorte = /iPad|Tablet/.test(ua) ? "tablette" : /Mobile|iPhone|Android/.test(ua) ? "téléphone" : "ordinateur";
  return `${nav} · ${sorte}`;
}

function tronquer(nom: string): Bytes {
  let out = new Uint8Array(0);
  for (const ch of nom) {
    const next = concat(out, utf8(ch));
    if (next.length > NOM_MAX) break;
    out = next;
  }
  return out;
}

export async function scellerEtiquette(cle: CryptoKey, h: Uint8Array, nom: string): Promise<Bytes> {
  const n = tronquer(nom);
  const clair = new Uint8Array(CLAIR);
  clair[0] = n.length;
  clair.set(n, 1);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad(h) }, cle, clair));
  return concat(iv, ct);
}

/** Nom d'appareil, ou null si l'étiquette ne s'ouvre pas. */
export async function ouvrirEtiquette(cle: CryptoKey, h: Uint8Array, e: Uint8Array): Promise<string | null> {
  if (e.length !== ETIQUETTE_LEN) return null;
  try {
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: e.slice(0, 12), additionalData: ad(h) }, cle, e.slice(12)));
    const n = pt[0]!;
    if (n > NOM_MAX || !pt.subarray(1 + n).every((x) => x === 0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(pt.subarray(1, 1 + n));
  } catch {
    return null;
  }
}

// --- Téléphone ou ordinateur (décision du 25 novembre, conception du compte §19) -----------------

/** Ce que lit estMobile (injecté par les tests ; par défaut, le navigateur). */
export type Ecran = { matchMedia?: (q: string) => { matches: boolean }; userAgentData?: { mobile?: unknown } | undefined };

const ecranDuNavigateur = (): Ecran => {
  const g = globalThis as { matchMedia?: (q: string) => MediaQueryList; navigator?: { userAgentData?: { mobile?: unknown } } };
  return { matchMedia: typeof g.matchMedia === "function" ? (q) => g.matchMedia!(q) : undefined, userAgentData: g.navigator?.userAgentData };
};

/**
 * Vrai sur un téléphone ou une tablette : passkey de l'appareil (Face ID, empreinte). Faux sur un
 * ordinateur : la passkey est d'abord proposée sur le téléphone (QR du navigateur). Sans reniflage
 * de l'agent : `navigator.userAgentData.mobile` s'il vaut true (Chromium), sinon pointeur
 * principal grossier (doigt), ce qui couvre Safari iOS et les tablettes. Dans le doute :
 * ordinateur (le lien « cet ordinateur » reste offert, et la feuille du navigateur garde ses choix).
 */
export function estMobile(e: Ecran = ecranDuNavigateur()): boolean {
  if (e.userAgentData?.mobile === true) return true;
  try {
    return typeof e.matchMedia === "function" && e.matchMedia("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

// Clé de récupération sur l'appareil (conception 2026-11-22-compte-passkey-design.md §2.2, §3.1,
// §5.1, §5.4). R (16 octets) tirée par crypto.getRandomValues ; codage, contrôle,
// saisie tolérante et dérivations (A_r, v_r, KEK_r) par le moteur Rust (vecteurs
// engine/vectors/compte-v3.json). R ne part jamais : seul A_r part, à la route recup, et v_r à
// l'inscription ou au renouvellement.
import { cleRecupAffichage, cleRecupDerivees, cleRecupLire } from "../engine/index";

type Bytes = Uint8Array<ArrayBuffer>;

/** Nouvelle clé R (16 octets) ; l'appelant l'efface après usage. */
export function nouvelleCle(): Bytes {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Texte affiché : « XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX ». */
export const affichage = (r: Uint8Array): Promise<string> => cleRecupAffichage(r);

/** R lue d'une saisie (minuscules, blancs, tirets, I/L/O tolérés) ; erreurs cle_recup_*. */
export const lire = (saisie: string): Promise<Bytes> => cleRecupLire(saisie);

/** A_r, v_r, KEK_r ; l'appelant efface A_r et KEK_r après usage. */
export const derivees = (r: Uint8Array) => cleRecupDerivees(r);

/** Numéro (1 à 7) du groupe à retaper pour vérifier que la clé est notée (§3.1, écran 4). */
export function groupeAVerifier(): number {
  return 1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 7);
}

/** Même saisie tolérante que le moteur, pour un seul groupe : majuscules, sans blancs ni tirets, I/L → 1, O → 0. */
function normaliser(s: string): string {
  return s
    .replace(/[\s-]+/gu, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** Vrai si `saisie` est le groupe n° `k` (1 à 7) de la clé affichée. */
export function groupeJuste(texte: string, k: number, saisie: string): boolean {
  const g = texte.split("-")[k - 1];
  return g !== undefined && normaliser(saisie) === g;
}

/** Contenu du fichier « Télécharger (.txt) » : la clé et ce qu'elle permet, rien d'autre (ni pseudo, ni adresse du site). */
export function fichierTexte(texte: string, entete: string): string {
  return `${entete}\n\n${texte}\n`;
}

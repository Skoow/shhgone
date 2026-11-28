// Règles du pseudo montrées pendant la saisie (création de compte, page Compte ; 28 novembre).
// Simple affichage : la règle qui fait foi reste celle du moteur (`shhdrop_core::texte::
// pseudo_valide`, engine/core/src/texte.rs : PSEUDO_MIN, PSEUDO_MAX, A-Z a-z 0-9 seulement après
// nettoyage), appliquée par verifierSaisie puis par le serveur. Ces deux fonctions la reprennent
// pour la liste à cocher, et regles-pseudo.test.ts vérifie qu'elles disent la même chose que les
// vecteurs communs (engine/vectors/compte-v3.json, section `pseudo`) et que les bornes sont celles
// du moteur. Aucune requête ici.

/** Bornes du moteur (texte.rs, PSEUDO_MIN et PSEUDO_MAX), en graphèmes. */
export const PSEUDO_MIN = 2;
export const PSEUDO_MAX = 24;

/** Comme le moteur : contrôles et caractères invisibles retirés, espaces au bord retirées, NFC. */
function nettoyer(v: string): string {
  return v
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, "")
    .trim();
}

function graphemes(s: string): number {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  return Seg ? [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].length : [...s].length;
}

export type Regles = { caracteres: boolean; longueur: boolean };

/** Chaque règle tenue ou non par la saisie `v` (vide : aucune n'est tenue). */
export function reglesPseudo(v: string): Regles {
  const p = nettoyer(v);
  const n = graphemes(p);
  return { caracteres: p !== "" && /^[A-Za-z0-9]+$/.test(p), longueur: n >= PSEUDO_MIN && n <= PSEUDO_MAX };
}

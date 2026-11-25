// Trame de points de l'écran d'envoi (direction « La trame » de
// l'accueil) : calculs purs, sans DOM, sans données réelles. La trame ne dit que ce que dit
// l'envoi : la part allumée suit la part des octets confirmés envoyés, jamais plus loin ;
// le mouvement ne vit que si des octets passent vraiment. Le dessin est dans Trame.svelte.
import { rng } from "./decor";

/** Pas de la grille (px CSS), rayon d'un point, largeur de la rampe de chiffrement (colonnes). */
export const GAP = 10;
export const DOT = 2;
export const BAND = 2.5;

export type Grid = { cols: number; rows: number; ox: number; oy: number };

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** Grille centrée dans une boîte `w` × `h` : un point tous les `gap` px, marge d'un demi-pas au moins. */
export function grid(w: number, h: number, gap = GAP): Grid {
  const cols = Math.max(0, Math.floor(w / gap));
  const rows = Math.max(0, Math.floor(h / gap));
  return { cols, rows, ox: (w - (cols - 1) * gap) / 2, oy: (h - (rows - 1) * gap) / 2 };
}

/**
 * Position du front (en colonnes) pour la part envoyée `p` : p = 0, aucune colonne allumée ;
 * p = 1, toutes. Entre les deux, la surface allumée reste à moins de BAND / 2 colonnes de p × cols.
 */
export function front(p: number, cols: number, band = BAND): number {
  return clamp01(p) * (cols + band);
}

/** Allumage de la colonne `col`, lu en son milieu (0 : encore sur l'appareil ; 1 : envoyée), rampe de `band` colonnes derrière le front. */
export function lit(col: number, f: number, band = BAND): number {
  return clamp01((f - col - 0.5) / band);
}

/**
 * Valeur affichée qui rattrape `target` en douceur (constante `tauMs`), sans jamais la dépasser :
 * la trame peut être un peu en retard sur les octets, jamais en avance. Recul (nouvel envoi) : suivi tout de suite.
 */
export function approach(shown: number, target: number, dtMs: number, tauMs = 120): number {
  if (!(target > shown)) return target;
  const next = shown + (target - shown) * (1 - Math.exp(-Math.max(0, dtMs) / tauMs));
  return target - next < 1e-4 ? target : Math.min(target, next);
}

/** Activité (0 à 1) : monte quand des octets passent, retombe à 0 en ~`tauMs` sinon (pause, coupure, attente). */
export function activity(a: number, moving: boolean, dtMs: number, tauMs = 350): number {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return a + ((moving ? 1 : 0) - a) * k;
}

/** Graines décoratives des points (graine fixe : jamais tirées d'un tampon réel), dans [0, 1). */
export function seeds(n: number, seed = 20261119): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.max(0, n));
  for (let i = 0; i < out.length; i++) out[i] = r();
  return out;
}

// Alerte avant la fin du salon : calculée sur l'appareil à partir de l'échéance déjà connue,
// sans aucune trame vers le serveur. Le dernier seuil affiché est gardé avec l'échéance qu'il
// visait (dans la preuve de membre chiffrée) : un rechargement ne le redit pas, un renouvellement
// (nouvelle échéance) remet les seuils à zéro.

/** Seuils d'alerte, en minutes avant la fin. */
export const SEUILS_MIN = [30, 15, 5, 1] as const;

/** Dernier seuil affiché (minutes) et l'échéance (ms) qu'il visait. */
export type Averti = { finMs: number; seuil: number };

/** Écart toléré entre deux calculs de la même échéance (secondes restantes relues du serveur). */
export const MEME_FIN_MS = 60_000;

/**
 * Seuil à afficher maintenant (minutes), ou null. Seul le seuil franchi le plus proche de la fin
 * compte : à l'arrivée avec 12 min restantes, « 15 min » est dit une fois, « 30 min » jamais ; un
 * onglet endormi qui en saute plusieurs n'en dit qu'un.
 */
export function seuilAAfficher(finMs: number, maintenant: number, averti: Averti | null): number | null {
  const reste = finMs - maintenant;
  if (!(reste > 0)) return null;
  let seuil: number | null = null;
  for (const m of SEUILS_MIN) if (reste <= m * 60_000) seuil = m;
  if (seuil === null) return null;
  if (averti && Math.abs(averti.finMs - finMs) <= MEME_FIN_MS && averti.seuil <= seuil) return null;
  return seuil;
}

/** Dernière minute : secondes restantes (1 à 60, arrondies au-dessus), ou null en dehors. */
export function rebours(finMs: number, maintenant: number): number | null {
  const reste = finMs - maintenant;
  return reste > 0 && reste <= 60_000 ? Math.ceil(reste / 1000) : null;
}

/**
 * Pendant la dernière minute, ce que le lecteur d'écran entend : l'alerte « 1 minute », puis
 * « 30 s » et « 10 s » seulement (jamais chaque seconde). Rend les secondes à annoncer, ou 60.
 */
export function palierAnnonce(secondes: number): 60 | 30 | 10 {
  return secondes <= 10 ? 10 : secondes <= 30 ? 30 : 60;
}

/** Averti relu (preuve de membre) : valeur sûre, ou null. */
export function lireAverti(x: unknown): Averti | null {
  if (typeof x !== "object" || x === null) return null;
  const { finMs, seuil } = x as Record<string, unknown>;
  return Number.isSafeInteger(finMs) && (SEUILS_MIN as readonly unknown[]).includes(seuil) ? { finMs: finMs as number, seuil: seuil as number } : null;
}

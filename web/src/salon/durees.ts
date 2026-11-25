// Durées et places proposées à la création et au renouvellement d'un salon, selon les limites
// du compte (conception du compte §11 ; comptes sur mesure, 25 novembre). Sans dépendance : testé
// seul (durees.test.ts).
/**
 * Durées d'un salon, en heures : 1, 6, 12 ou 24 h pour tous ; 3, 7, 14 et 30 jours seulement
 * pour un compte sur mesure (limites du compte, `heures` jusqu'à 720 ; serveur :
 * salon.HeuresLongues). Places : 2 à 10, créateur compris (`max_members`, §39.1) ; jusqu'à 50
 * pour un compte sur mesure (salon.SurMesurePlacesMax).
 */
export type Duree = 1 | 6 | 12 | 24 | 72 | 168 | 336 | 720;
export const DUREES: readonly Duree[] = [1, 6, 12, 24];
export const DUREES_LONGUES: readonly Duree[] = [72, 168, 336, 720];
export const PLACES_MIN = 2;
export const PLACES_MAX = 10;
export const PLACES_SUR_MESURE_MAX = 50;

/** Durées que les limites du compte permettent (`heures` au plus) ; sans limite lue : 1 à 24 h. */
export function dureesPermises(maxHeures?: number): Duree[] {
  if (maxHeures === undefined || !Number.isFinite(maxHeures)) return [...DUREES];
  return [...DUREES, ...DUREES_LONGUES].filter((d) => d <= maxHeures);
}

/** Places au plus que les limites du compte permettent (2 à 50) ; sans limite lue : 10. */
export function placesPermises(maxPlaces?: number): number {
  if (maxPlaces === undefined || !Number.isInteger(maxPlaces)) return PLACES_MAX;
  return Math.max(PLACES_MIN, Math.min(PLACES_SUR_MESURE_MAX, maxPlaces));
}

/** Durée affichée : « 6 h » jusqu'à 24 h, puis en jours (« 3 j »). */
export function dureeEnJours(d: Duree): number | null {
  return d > 24 && d % 24 === 0 ? d / 24 : null;
}

/** Toutes les durées que le serveur connaît (salon.HeuresStandard et salon.HeuresLongues). */
export const TOUTES: readonly number[] = [...DUREES, ...DUREES_LONGUES];

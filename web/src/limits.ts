// Constantes uniques des chiffres affichés par les écrans (benchmark M5) : les textes (fr.ts,
// en.ts) n'écrivent jamais ces nombres en dur, ils les reçoivent d'ici. Les mêmes valeurs
// sont imposées par le serveur ; limits.test.ts les compare au code Go.
import { CONTENT_MAX, MAX_ITEMS, TEXT_MAX, contentMaxOf, type Palier } from "./engine/pure";

/** CONTENT_MAX : exactement 2 Gio de données (spec §29.3) ; TEXT_MAX en points de code. */
export { CONTENT_MAX, MAX_ITEMS, TEXT_MAX };
/** Durées proposées, en heures, comptées à partir de la fin de l'envoi (spec §4). */
export const TTL_HOURS = [1, 6, 12, 24] as const;
export type TtlHours = (typeof TTL_HOURS)[number];
export const TTL_MAX_HOURS = 24;
/** Valeurs par défaut des options (UI §9.3). */
export const TTL_DEFAULT: TtlHours = 12;
export const OPENS_DEFAULT = 1;
/** Ouvertures au choix, de 1 à MAX_OPENS (spec §4) ; 5 (10
 * avant). Le serveur refuse au-delà (share.MaxOpens, même valeur). */
export const MAX_OPENS = 5;
/** Plus grand nombre d'ouvertures qu'un partage existant peut avoir : 10, l'ancienne limite. Sert seulement à vérifier les réponses du serveur, pour qu'un partage créé
 *  avant ce changement s'ouvre encore ; jamais pour en créer un. */
export const OPENS_SEEN_MAX = 10;
/** Mots de passe faux avant destruction (spec §4). */
export const PW_TRIES = 5;
/** Images plus grosses : non lues en mémoire pour le nettoyage des métadonnées (UI §9.2.6). */
export const STRIP_MAX = 50 * 1048576;
/** Longueur maximale d'un nom, en points de code (UI §9.2.4, même borne que cleanName). */
export const NAME_MAX = 120;
/** Nom du partage : longueur maximale en points de code après nettoyage, celle du
 *  moteur (manifest::TITLE_MAX, prouvée par engine/vectors/v2-titre.json). */
export const TITLE_MAX = 80;
/** Partages gratuits créés par jour et par connexion (spec §24 ; limits.CreatesPer64 du serveur). */
export const CREATES_PER_DAY = 3;
/** Même plafond pour tout un réseau (limits.CreatesPer48 du serveur : bloc IPv6 /48). Le serveur
 *  ne dit pas lequel des deux a refusé : le message cite les deux. */
export const CREATES_PER_DAY_NETWORK = 10;
/** Envois en préparation (non finalisés) à la fois par connexion (spec §29.5 ; limits.PendingPer64). */
export const PENDING_MAX = 2;

/**
 * Formules payantes (spec §38.8.1, prix proposés de §38.8.2, TTC, en euros) : présentées par une
 * seule ligne discrète du composeur et une feuille « Bientôt disponible » ; rien n'est en
 * vente tant que les ne sont pas faites. Le nombre d'éléments n'en fait pas
 * partie : MAX_ITEMS vaut pour toutes (D41-17). Aucune n'apporte de sécurité de plus (§38.9.0).
 * Ouvertures et tailles : voir la ci-dessous.
 */
export type PaidTier = "plus" | "pro";
export const PAID: Readonly<Record<PaidTier, { bytes: number; opens: number; ttlDays: readonly number[]; shares: number; month: number; year: number }>> = {
  // :, Plus jusqu'à 3 jours, Pro 7 jours ;
  // ouvertures gratuit 5, Plus 10, Pro 20, et Pro 30 Go (50 avant).
  // shares : partages payants (jetons) par période de 30 jours, sans report (offres.go, JetonsPeriod).
  plus: { bytes: 10 * 1024 ** 3, opens: 10, ttlDays: [2, 3], shares: 30, month: 7, year: 70 },
  pro: { bytes: 30 * 1024 ** 3, opens: 20, ttlDays: [2, 3, 7], shares: 100, month: 20, year: 200 },
};

/**
 * Limites d'un partage selon sa formule (conception du paiement §11) : données au plus, durées
 * proposées (heures) et ouvertures au plus. Mêmes valeurs que le serveur (share.Tier : MaxBucket,
 * TTLAllowed, MaxOpensOf ; limits.test.ts les compare au code Go).
 */
export type Formule = "free" | PaidTier;
export function limitesDe(f: Formule): { contentMax: number; ttlHours: readonly number[]; maxOpens: number; palier: Palier } {
  if (f === "free") return { contentMax: CONTENT_MAX, ttlHours: TTL_HOURS, maxOpens: MAX_OPENS, palier: 0 };
  const palier: Palier = f === "plus" ? 1 : 2;
  return { contentMax: contentMaxOf(palier), ttlHours: [...TTL_HOURS, ...PAID[f].ttlDays.map((d) => d * 24)], maxOpens: PAID[f].opens, palier };
}

/**
 * Durées maximales de capture dans l'interface (caméra et micro maison), en secondes, par
 * formule. Plafonds techniques : l'enregistrement vit
 * en mémoire jusqu'au chiffrement (vidéo à VIDEO_BPS : 5 min ≈ 94 Mo, 30 min ≈ 560 Mo).
 */
export type CaptureTier = "free" | PaidTier;
export const CAPTURE_MAX_S: Readonly<Record<CaptureTier, { video: number; voice: number }>> = {
  free: { video: 5 * 60, voice: 30 * 60 },
  plus: { video: 15 * 60, voice: 2 * 3600 },
  pro: { video: 30 * 60, voice: 2 * 3600 },
};
/** Formule en vigueur : aucune offre payante n'est active, seule la limite gratuite s'applique. */
export const CAPTURE_TIER: CaptureTier = "free";

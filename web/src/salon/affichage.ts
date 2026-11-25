// Type du Blob d'une pièce du salon montrée dans la page : jamais le type
// annoncé par l'expéditeur tel quel. Une adresse blob: hérite de l'origine du site ; un
// « video/… » qui serait en fait text/html ou image/svg+xml, ouvert dans un onglet, s'y
// exécuterait. Mêmes tables que les partages (viewers/blobs.ts, TYPE_SUR).
import { safeBlobType } from "../viewers/blobs";
import type { PieceInfo } from "./conversation";

/** Images montrées dans le salon (jamais SVG, spec §39.5 et UI §12.4). */
export const IMAGES_SURES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Limite de trames du serveur atteinte (0x0B, places-durée : « Doucement, réessayez dans N s ») :
 * secondes à afficher avant que l'envoi en attente reparte tout seul (client.ts), ou null quand
 * il n'y a rien à dire. `jusquaMs` : heure de la nouvelle tentative (null : aucune).
 */
export function ralentiRestant(jusquaMs: number | null, maintenantMs: number): number | null {
  if (jusquaMs === null || maintenantMs >= jusquaMs) return null;
  return Math.max(1, Math.ceil((jusquaMs - maintenantMs) / 1000));
}

/** Type sûr du Blob affiché, ou null : rien n'est montré (seulement « Enregistrer »). */
export function typeAffichage(sorte: PieceInfo["sorte"], mime: string): string | null {
  const m = mime.split(";")[0]!.trim().toLowerCase();
  if (sorte === "image") return IMAGES_SURES.has(m) ? m : null;
  if (sorte === "vocal") return safeBlobType("audio", m);
  if (sorte === "video") return safeBlobType("video", m);
  return null;
}

/**
 * Dernière connexion d'un participant hors ligne (v3 §14.1), dite « vu il y a 12 min » :
 * `derniereMin` est l'heure que le serveur joint déjà à `0x07` et à l'accueil `0x0D` (minutes
 * Unix, arrondies à la minute inférieure ; 0 = inconnue). Rien d'autre n'est lu ni envoyé.
 * Moins d'une minute (ou horloge de l'appareil en retard) : « à l'instant » ; moins d'une heure :
 * minutes ; moins de 24 h : heures ; au-delà : null (l'écran dit le jour et l'heure, §14.1).
 */
export type VuIlYa = { k: "instant" } | { k: "min"; n: number } | { k: "h"; n: number };
export function vuIlYa(derniereMin: number, maintenantMs: number): VuIlYa | null {
  if (!(derniereMin > 0)) return null;
  const min = Math.floor((maintenantMs - derniereMin * 60_000) / 60_000);
  if (min < 1) return { k: "instant" };
  if (min < 60) return { k: "min", n: min };
  if (min < 24 * 60) return { k: "h", n: Math.floor(min / 60) };
  return null;
}

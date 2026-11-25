// Appels réservés aux offres Plus et Pro (conception des
// appels §5.1) : demande des identifiants du relais, avec un jeton anonyme seulement si le serveur
// dit les appels du salon fermés (402). Le portefeuille (pass, jetons) est dans paiement/appel.ts.
import { jetonAppel } from "../paiement/appel";
import { SalonError, type Relais } from "./api";

export { offresAppel } from "../paiement/appel";

/** Message de l'erreur rendue quand les appels du salon sont fermés et qu'aucun jeton n'est disponible (lu par appel.ts). */
export const OFFRE_REQUISE = "offre_requise";

/**
 * Identifiants du relais : d'abord sans jeton (appels peut-être déjà ouverts dans le salon : rien
 * n'est dépensé) ; seulement sur 402, un jeton anonyme, puis la même demande avec lui. Erreur
 * OFFRE_REQUISE sans jeton disponible (ou toujours 402) ; toute autre erreur telle quelle.
 */
export async function relaisReserve(demander: (jetonAnonyme?: string) => Promise<Relais>, jeton: () => Promise<string | null> = () => jetonAppel()): Promise<Relais> {
  try {
    return await demander();
  } catch (e) {
    if (!(e instanceof SalonError && e.status === 402)) throw e;
  }
  const j = await jeton();
  if (j === null) throw new Error(OFFRE_REQUISE);
  try {
    return await demander(j);
  } catch (e) {
    if (e instanceof SalonError && e.status === 402) throw new Error(OFFRE_REQUISE);
    throw e;
  }
}

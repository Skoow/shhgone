// Fonctions en attente d'un autre chantier, derrière un drapeau (rien n'est promis à l'écran).
/**
 * Surveillance de la disparition d'un partage ouvert (spec §41.8, flows/watch.ts) : route
 * GET /api/shares/watch livrée par la (étapes 3c et 7b), serveur et faux serveur de
 * la démo. Vrai : Content lance startWatch. Faux : aucune requête de surveillance ;
 * l'interface se ferme quand même au compte à rebours, au refus d'une lecture ou à la
 * destruction faite ici.
 */
export const WATCH_READY = true;

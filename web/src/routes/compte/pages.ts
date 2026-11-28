// Pages du compte vues par App.svelte : seul point d'entrée du compte
// dans le site. Avec __COMPTES__ seulement ; sans lui (défaut, démo), le greffon shh-comptes
// (vite.config.ts) remplace ce module par pages.off.ts, et rien du compte n'est construit.
export { default as Connexion } from "./Connexion.svelte";
export { default as Inscription } from "./Inscription.svelte";
export { default as Recuperation } from "./Recuperation.svelte";
export { ecouterAutresOnglets, rangerPassDansCompte, restaurer, seDeconnecter, verifierAuRetour } from "../../account/session.svelte";
export { default as Compte } from "./Compte.svelte";
import { account } from "../../account/session.svelte";
/** Session en cours d'ouverture (« Rester connecté » relu au démarrage) : attendre avant de conclure. */
export const ouvertureEnCours = (): boolean => account.etat === "verrouille";
/** Session ouverte sur cet appareil (page Compte, onglets) ; lu dans un effet ou le gabarit. */
export const connecte = (): boolean => account.etat === "ouvert";
/** Compte supprimé depuis cette page : l'écran de fin de la page Compte reste affiché sans session. */
export const supprime = (): boolean => account.supprime;

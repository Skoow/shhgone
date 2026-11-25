// Écrans du salon vus par App.svelte : seul point d'entrée du salon dans le site. Avec
// __SALONS__ seulement (production avec le compte) ; sans lui (démo, site sans compte), le greffon
// shh-salons (vite.config.ts) remplace ce module par pages.off.ts, et rien du salon n'est construit.
export { default as Salon } from "./Salon.svelte";
export { default as SalonNouveau } from "./Nouveau.svelte";

// Point d'entrée des pages d'information (pages séparées). Le HTML
// arrive déjà rempli (rendu au build, en français) ; le script le remplace par la page vivante
// (même texte, ou la langue du navigateur). Les liens vers l'application (accueil, envoi) chargent sa page (router.svelte.ts, setEntry).
import { mount } from "svelte";
import { setEntry } from "../app/router.svelte";
import { effacerAncienHistorique } from "../storage/ancien-historique";
import { langReady } from "../i18n/i18n.svelte";
import { viderSaufAmbiance } from "../ui/ambiance";
import PagesApp from "./PagesApp.svelte";

setEntry("pages");
// Bases retirées (historique des liens, spec §33 ; historique des téléchargements, D42-33) :
// supprimées, sans erreur.
void effacerAncienHistorique();
// Démo GitHub Pages (UI §14.3) : même installation que l'application (bandeau ; titres du site, sans « Démo · »).
if (import.meta.env.MODE === "demo") await (await import("../demo/install")).installDemo(window);
await langReady;

const target = document.getElementById("app");
if (!target) throw new Error("#app introuvable");
viderSaufAmbiance(target); // lumière d'ambiance gardée (ui/ambiance.ts)

export default mount(PagesApp, { target });

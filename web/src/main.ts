import { mount } from "svelte";
import App from "./App.svelte";
import { moveToLinkPage } from "./app/router.svelte";
import { effacerAncienHistorique } from "./storage/ancien-historique";
import { pageReturns } from "./storage/returns";
import { langReady } from "./i18n/i18n.svelte";
import { viderSaufAmbiance } from "./ui/ambiance";

// Ouverture déverrouillée rechargée sous « / » (adresse montrée) : la page « /s » la rouvre, avant
// tout le reste ; rien n'est monté ici (aucun écran affiché un instant).
const moved = moveToLinkPage(location);

// Démo GitHub Pages (UI §14.3) : en production, la condition vaut false à la compilation et le
// module disparaît du build (garde demoGuard de vite.config.ts, scripts/check-dist.mjs).
if (!moved && import.meta.env.MODE === "demo") await (await import("./demo/install")).installDemo(window);

// Retours gardés (D42-22) : entrées échues retirées au démarrage, sans rien créer.
if (!moved) void pageReturns().sweep();
// Historique local des liens retiré (spec §33) : la base d'avant est supprimée, sans erreur.
if (!moved) void effacerAncienHistorique();

// Langue du navigateur : le dictionnaire anglais est lu avant l'affichage (production).
await langReady;

const target = document.getElementById("app");
if (!target) throw new Error("#app introuvable");
// Accueil ou squelette (app.html, U13) écrits au build : remplacés par l'application vivante.
if (!moved) {
  viderSaufAmbiance(target); // lumière d'ambiance gardée (ui/ambiance.ts)
  target.removeAttribute("data-squelette");
}

export default moved ? undefined : mount(App, { target });

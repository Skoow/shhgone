// Point d'entrée de la page « /s » (s.html) : ouverture
// et gestion d'un partage, seules. Ni accueil, ni composeur, ni nettoyage, ni enregistreur : le
// destinataire ne charge que ce qui sert à ouvrir. Les liens vers le reste du site chargent leur
// page (router.svelte.ts, setEntry).
import { mount } from "svelte";
import { setEntry } from "../app/router.svelte";
import { pageReturns } from "../history/returns";
import { langReady } from "../i18n/i18n.svelte";
import OpenApp from "./OpenApp.svelte";

setEntry("s");
// Démo GitHub Pages (UI §14.3) : même installation que l'application (bandeau ; titres du site, sans « Démo · »).
if (import.meta.env.MODE === "demo") await (await import("../demo/install")).installDemo(window);

// Retours gardés (D42-22) : entrées échues retirées au démarrage, sans rien créer.
void pageReturns().sweep();

await langReady;

const target = document.getElementById("app");
if (!target) throw new Error("#app introuvable");

export default mount(OpenApp, { target });

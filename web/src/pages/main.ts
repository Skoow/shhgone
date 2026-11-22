// Point d'entrée des pages d'information (pages séparées, conception du 16 novembre). Le HTML
// arrive déjà rempli (rendu au build, en français) ; le script le remplace par la page vivante
// (même texte, ou la langue du navigateur). Les liens vers l'application (accueil, envoi, Mes
// partages) chargent sa page (router.svelte.ts, setEntry).
import { mount } from "svelte";
import { setEntry } from "../app/router.svelte";
import { probeDownloads } from "../downloads/probe";
import { probeHistory } from "../history/presence.svelte";
import { langReady } from "../i18n/i18n.svelte";
import { viderSaufAmbiance } from "../ui/ambiance";
import PagesApp from "./PagesApp.svelte";

setEntry("pages");
// « Mes partages » dans l'en-tête seulement si l'historique existe sur cet appareil (17 novembre).
void probeHistory();
// « Téléchargements » sans compte seulement si l'historique des téléchargements est activé (22 novembre).
void probeDownloads();
// Démo GitHub Pages (UI §14.3) : même installation que l'application (bandeau ; titres du site, sans « Démo · » depuis le 22 novembre).
if (import.meta.env.MODE === "demo") await (await import("../demo/install")).installDemo(window);
await langReady;

const target = document.getElementById("app");
if (!target) throw new Error("#app introuvable");
viderSaufAmbiance(target); // lumière d'ambiance gardée (ui/ambiance.ts)

export default mount(PagesApp, { target });

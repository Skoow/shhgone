// Rendu des pages d'information au build (pages séparées, conception du 16 novembre), côté
// serveur de build seulement (vite.config.ts, infoPages) : jamais dans le navigateur. Le contenu
// est rendu en français (langue par défaut) ; le script de la page le remplace au montage.
import { render } from "svelte/server";
import { router, type Route } from "../app/router.svelte";
import { INDEXED } from "../app/seo";
import { routeTitle } from "../app/title";
import type { Lang } from "../i18n/format";
import { setLang, t } from "../i18n/i18n.svelte";
import HomeStatic from "./HomeStatic.svelte";
import PagesApp from "./PagesApp.svelte";
import ShellStatic from "./ShellStatic.svelte";

/** Page d'information → fichier HTML écrit au build (l'adresse publique est sans « .html »). */
export const PAGE_FILES: Readonly<Partial<Record<Route["name"], string>>> = {
  securite: "securite.html",
  confidentialite: "confidentialite.html",
  offres: "offres.html",
  conditions: "conditions.html",
  mentions: "mentions-legales.html",
  signaler: "signaler.html",
};

export type Rendered = { body: string; title: string; description: string; path: string | undefined };

export function renderPage(name: Route["name"], lang: Lang = "fr"): Rendered {
  // Langue demandée (français par défaut), quelle que soit celle de l'outil de build (Node se dit
  // anglais) ; l'anglais pour les pages « /en… » (app/langues.ts, 20 novembre).
  void setLang(lang);
  router.current = { name };
  const { body } = render(PagesApp);
  const path = INDEXED[name];
  return {
    body,
    title: routeTitle(name),
    description: t(path !== undefined ? (`seo.${name as keyof typeof INDEXED}` as "seo.home") : "seo.home"),
    path,
  };
}

/** Accueil (18 novembre, référencement) : contenu de « / » écrit dans index.html au build. */
export function renderHome(lang: Lang = "fr"): Rendered {
  void setLang(lang);
  router.current = { name: "home" };
  const { body } = render(HomeStatic);
  // Titre de l'accueil : « landing » (celui d'index.html), « home » étant l'écran d'envoi.
  return { body, title: routeTitle("landing"), description: t("seo.home"), path: INDEXED.home };
}

/** Squelette d'app.html (U13) : la coque seule, sans contenu, en français. */
export function renderShell(): string {
  void setLang("fr");
  router.current = { name: "connexion" }; // écran sans « Retour » ni onglet courant
  return render(ShellStatic).body;
}

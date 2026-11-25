// Barre d'onglets du téléphone (< 768 px) : façon app, jusqu'à la vraie version mobile.
// Seulement avec un compte ouvert (sans compte : menu ☰, ui/MobileMenu.svelte). Visible sur les
// écrans « racine » : accueil, page d'envoi, Téléchargements, Compte, pages d'information, page
// introuvable. Masquée chez le destinataire (ouverture, contenu), sur la gestion, pendant la
// composition (l'étape a sa propre barre d'action), pendant un envoi et sur « Lien prêt ».
import type { Route } from "./router.svelte";

/** `chat` : icône seule (bouton Salon de l'accueil), jamais un onglet. */
export type TabId = "send" | "downloads" | "profile" | "chat";

/**
 * Connecté (25 novembre) : « Nouveau » (le bouton « Nouveau partage » du bas, page d'envoi),
 * Téléchargements, Compte. Plus d'onglet Accueil (la liste de l'historique des liens est
 * retirée, spec §33 ; l'accueil est l'accueil de tous, atteint par le logo).
 */
export const TABS_CONNECTED: readonly { id: TabId; soon: boolean }[] = [
  { id: "send", soon: false },
  { id: "downloads", soon: false },
  { id: "profile", soon: false },
];
/** Sans compte : aucun onglet (aucune barre). */
export const tabsFor = (connected: boolean): readonly { id: TabId; soon: boolean }[] => (connected ? TABS_CONNECTED : []);

/** Chemin d'un onglet. */
export function tabPath(id: TabId): string {
  if (id === "downloads") return "/telechargements";
  if (id === "profile") return "/compte";
  return "/envoyer";
}

const ROOTS: ReadonlySet<Route["name"]> = new Set(["home", "envoyer", "telechargements", "compte", "securite", "confidentialite", "conditions", "mentions", "signaler", "verifier", "contact", "offres", "notfound"]);

/** Une barre d'onglets n'a de sens qu'avec au moins deux onglets qui fonctionnent. */
export function tabBarUseful(tabs: readonly { id?: TabId; soon: boolean }[]): boolean {
  return tabs.filter((t) => !t.soon).length >= 2;
}

/** `useful` : forcé par les tests. */
export function tabBarVisible(o: { supported: boolean; route: Route["name"]; sending: boolean; composing: boolean; connected?: boolean }, useful = tabBarUseful(tabsFor(!!o.connected))): boolean {
  return useful && o.supported && !o.sending && !o.composing && ROOTS.has(o.route);
}

/** Onglet courant : « Nouveau » sur l'accueil et la page d'envoi ; aucun ailleurs. */
export function currentTab(route: Route["name"]): TabId | null {
  if (route === "home" || route === "envoyer") return "send";
  if (route === "telechargements") return "downloads";
  if (route === "compte") return "profile";
  return null;
}

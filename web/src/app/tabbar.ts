// Barre d'onglets du téléphone (< 768 px) : façon app, jusqu'à la vraie version mobile.
// Seulement avec un compte ouvert (sans compte : menu ☰, ui/MobileMenu.svelte). Visible sur les
// écrans « racine » : accueil, page d'envoi, Mes partages, Téléchargements, Compte, pages
// d'information, page introuvable. À droite, « Se déconnecter » (bouton, pas un onglet ; décision
// du propriétaire, 26 novembre : TabBar.svelte). Masquée chez le destinataire (ouverture, contenu), sur la gestion, pendant la
// composition (l'étape a sa propre barre d'action), pendant un envoi et sur « Lien prêt ».
import type { Route } from "./router.svelte";

/** `chat` : icône seule (bouton Salon de l'accueil), jamais un onglet ; `logout` : icône du bouton « Se déconnecter ». */
export type TabId = "send" | "shares" | "downloads" | "profile" | "chat" | "logout";

/**
 * Connecté : « Nouveau » (page d'envoi), Mes partages (26 novembre, D42-30), Téléchargements,
 * Compte. Plus d'onglet Accueil (l'accueil est l'accueil de tous, atteint par le logo).
 */
export const TABS_CONNECTED: readonly { id: TabId; soon: boolean }[] = [
  { id: "send", soon: false },
  { id: "shares", soon: false },
  { id: "downloads", soon: false },
  { id: "profile", soon: false },
];
/** Sans compte : aucun onglet (aucune barre). */
export const tabsFor = (connected: boolean): readonly { id: TabId; soon: boolean }[] => (connected ? TABS_CONNECTED : []);

/** Chemin d'un onglet. */
export function tabPath(id: TabId): string {
  if (id === "shares") return "/envois";
  if (id === "downloads") return "/telechargements";
  if (id === "profile") return "/compte";
  return "/envoyer";
}

const ROOTS: ReadonlySet<Route["name"]> = new Set(["home", "envoyer", "envois", "telechargements", "compte", "securite", "confidentialite", "conditions", "mentions", "signaler", "verifier", "contact", "offres", "notfound"]);

/** Une barre d'onglets n'a de sens qu'avec au moins deux onglets qui fonctionnent. */
export function tabBarUseful(tabs: readonly { id?: TabId; soon: boolean }[]): boolean {
  return tabs.filter((t) => !t.soon).length >= 2;
}

/** `useful` : forcé par les tests. */
export function tabBarVisible(o: { supported: boolean; route: Route["name"]; sending: boolean; composing: boolean; connected?: boolean }, useful = tabBarUseful(tabsFor(!!o.connected))): boolean {
  return useful && o.supported && !o.sending && !o.composing && ROOTS.has(o.route);
}

/** Onglet courant : « Nouveau » sur l'accueil et la page d'envoi, puis chaque page de son onglet ; aucun ailleurs. */
export function currentTab(route: Route["name"]): TabId | null {
  if (route === "home" || route === "envoyer") return "send";
  if (route === "envois") return "shares";
  if (route === "telechargements") return "downloads";
  if (route === "compte") return "profile";
  return null;
}

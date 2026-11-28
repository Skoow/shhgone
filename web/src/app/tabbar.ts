// Barre d'onglets du téléphone (< 768 px) : façon app, jusqu'à la vraie version mobile.
// Seulement avec un compte ouvert (sans compte : menu ☰, ui/MobileMenu.svelte). Visible sur les
// écrans « racine » : accueil, page d'envoi, Mes partages, Mes salons, Compte, pages
// d'information, page introuvable. À droite, « Se déconnecter » (bouton, pas un onglet ; décision
// du propriétaire, 26 novembre : TabBar.svelte). Masquée chez le destinataire (ouverture, contenu), sur la gestion, pendant la
// composition (l'étape a sa propre barre d'action), pendant un envoi et sur « Lien prêt ».
import type { Route } from "./router.svelte";

/** `chat` : icône seule (bouton Salon de l'accueil), jamais un onglet ; `logout` : icône du bouton « Se déconnecter ». */
export type TabId = "send" | "shares" | "rooms" | "profile" | "chat" | "logout";

/**
 * Connecté : « Nouveau » (page d'envoi), Mes partages (26 novembre, D42-30), Mes salons (28 novembre,
 * seulement avec __SALONS__ ; remplace « Fichiers », page Téléchargements retirée, D42-33), Compte.
 * Plus d'onglet Accueil (l'accueil est l'accueil de tous, atteint par le logo).
 */
export const tabsConnected = (salons: boolean = __SALONS__): readonly { id: TabId; soon: boolean }[] => [
  { id: "send", soon: false },
  { id: "shares", soon: false },
  ...(salons ? [{ id: "rooms" as const, soon: false }] : []),
  { id: "profile", soon: false },
];
/** Sans compte : aucun onglet (aucune barre). */
export const tabsFor = (connected: boolean, salons: boolean = __SALONS__): readonly { id: TabId; soon: boolean }[] => (connected ? tabsConnected(salons) : []);

/** Chemin d'un onglet. */
export function tabPath(id: TabId): string {
  if (id === "shares") return "/envois";
  if (id === "rooms") return "/salons";
  if (id === "profile") return "/compte";
  return "/envoyer";
}

const ROOTS: ReadonlySet<Route["name"]> = new Set(["home", "envoyer", "envois", "salons", "compte", "securite", "confidentialite", "conditions", "mentions", "signaler", "verifier", "contact", "offres", "notfound"]);

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
  if (route === "salons") return "rooms";
  if (route === "compte") return "profile";
  return null;
}

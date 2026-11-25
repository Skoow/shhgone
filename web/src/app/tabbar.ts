// Barre d'onglets du téléphone (< 768 px) : façon app, jusqu'à la vraie version mobile.
// Visible seulement sur les écrans « racine » de l'expéditeur : accueil (composeur vide),
// Mes partages, Sécurité, Confidentialité, page introuvable. Masquée chez le destinataire (ouverture,
// contenu), sur la gestion, pendant la composition (l'étape a sa propre barre d'action),
// pendant un envoi et sur « Lien prêt ».
import type { Route } from "./router.svelte";

export type TabId = "send" | "shares" | "downloads" | "chat" | "home" | "profile";

/** Onglets dans l'ordre ; `soon` : pas encore construit (désactivé, « Bientôt »). */
// Sans compte : plus de barre d'onglets sur le site.
// « Envoyer » ramenait à l'accueil, déjà atteint par le logo ; « Téléchargements » ne sert pas sans
// compte (historique de ce seul navigateur, sans lien pour retélécharger). Il ne reste que « Mes
// partages », et une barre d'un seul onglet n'a pas de sens (tabBarUseful) : la navigation passe
// par le menu ☰ (ui/MobileMenu.svelte). Remplace la conception compte §21.15.5 (trois onglets).
export const TABS: readonly { id: TabId; soon: boolean }[] = [
  { id: "shares", soon: false }, // historique « Vos envois » (/envois)
];

/** Connecté (conception compte §21.15.1) : Accueil, Envoyer, Téléchargements, Profil. */
export const TABS_CONNECTED: readonly { id: TabId; soon: boolean }[] = [
  { id: "home", soon: false },
  { id: "send", soon: false },
  { id: "downloads", soon: false },
  { id: "profile", soon: false },
];
export const tabsFor = (connected: boolean) => (connected ? TABS_CONNECTED : TABS);

/** Chemin d'un onglet ; connecté, « Envoyer » mène à la page d'envoi (l'accueil est la liste). */
export function tabPath(id: TabId, connected: boolean): string {
  if (id === "home") return "/";
  if (id === "send") return connected ? "/envoyer" : "/";
  if (id === "downloads") return "/telechargements";
  if (id === "profile") return "/compte/profil";
  return "/envois";
}

const ROOTS: ReadonlySet<Route["name"]> = new Set(["home", "envois", "telechargements", "securite", "confidentialite", "conditions", "mentions", "signaler", "verifier", "contact", "offres", "notfound"]);
/** Connecté : le profil et les paramètres sont aussi des écrans racine. */
const ROOTS_CONNECTED: ReadonlySet<Route["name"]> = new Set([...ROOTS, "profil", "compte"]);

/** Une barre d'onglets n'a de sens qu'avec au moins deux onglets qui fonctionnent. */
export function tabBarUseful(tabs: readonly { id?: TabId; soon: boolean }[]): boolean {
  return tabs.filter((t) => !t.soon).length >= 2;
}

/**
 * Masquée tant qu'un seul onglet fonctionne ;
 * visible depuis que Mes partages fonctionne ; `useful` : forcé par les tests.
 */
export function tabBarVisible(o: { supported: boolean; route: Route["name"]; sending: boolean; composing: boolean; connected?: boolean }, useful = tabBarUseful(tabsFor(!!o.connected))): boolean {
  return useful && o.supported && !o.sending && !o.composing && (o.connected ? ROOTS_CONNECTED : ROOTS).has(o.route);
}

/** Onglet courant : Envoyer sur l'accueil, Mes partages sur /envois ; aucun ailleurs (plus
 *  d'onglet Réglages : langue, nettoyage et liens d'information sont dans le pied de page). */
export function currentTab(route: Route["name"], connected = false): TabId | null {
  if (connected) {
    if (route === "home") return "home";
    if (route === "envoyer") return "send";
    if (route === "telechargements") return "downloads";
    if (route === "profil" || route === "compte") return "profile";
    return null;
  }
  if (route === "home" || route === "envoyer") return "send";
  if (route === "envois") return "shares";
  if (route === "telechargements") return "downloads";
  return null;
}

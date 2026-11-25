import { href, navigate, otherEntry } from "./router.svelte";
// État d'interface partagé entre les écrans et la coque (aucun secret) : composeur rempli ;
// `report` : ouvre la confirmation de signalement du partage affiché (page d'un partage ouvert), sinon null et le lien « Signaler » du pied de page mène à la page « Signaler un abus ».
// `add` : gestes du composeur monté (menu « Partager » de la barre du haut) ; null hors de l'accueil et de la page d'envoi. `pending` : geste choisi ailleurs,
// joué par le composeur à son montage sur la page d'envoi.
export type AddGesture = "fichiers" | "texte" | "vocal" | "media";
// `spot` : depuis l'accueil, « Choisir des fichiers » (drop) ou « Créer sur place »
// (make) : la page d'envoi fait ressortir un instant la zone de dépôt ou les actions.
export const chrome = $state<{ composing: boolean; report: (() => void) | null; add: ((g: AddGesture) => void) | null; pending: AddGesture | null; spot: "drop" | "make" | null }>({
  composing: false,
  spot: null,
  report: null,
  add: null,
  pending: null,
});

/**
 * Geste choisi hors de la page d'envoi (menu « Envoyer », feuille « Nouveau ») : joué par le
 * composeur au montage. Depuis une page d'information (son propre fichier HTML, pages séparées),
 * la mémoire ne survit pas au chargement : le geste passe par l'adresse, « /envoyer?ajout=… »,
 * un mot d'une liste fermée, sans aucune donnée, retiré aussitôt lu (takeGestureFromUrl).
 */
const GESTURES: readonly AddGesture[] = ["fichiers", "texte", "vocal", "media"];
export function goToSend(g: AddGesture): void {
  if (otherEntry("/envoyer")) {
    location.assign(href("/envoyer") + "?ajout=" + g);
    return;
  }
  chrome.pending = g;
  navigate("/envoyer");
}
/** Au démarrage de l'application : « ?ajout=<geste> » exactement, sur /envoyer, puis l'adresse nettoyée. Seuls « fichiers » et « texte » sont joués d'office. */
export function takeGestureFromUrl(loc: Location = location, h: History = history): void {
  const m = /^\?ajout=([a-z]+)$/.exec(loc.search);
  if (m === null) return;
  h.replaceState(h.state, "", loc.pathname);
  const g = m[1] as AddGesture;
  if (!GESTURES.includes(g) || loc.pathname !== href("/envoyer")) return;
  // Micro et caméra : n'importe quel site peut pointer vers cette adresse,
  // et un navigateur qui a déjà l'autorisation allumerait le capteur à la seule visite. Venus de
  // l'adresse, ces deux gestes font seulement ressortir les actions : la personne clique ici.
  if (g === "vocal" || g === "media") chrome.spot = "make";
  else chrome.pending = g;
}

// Attachements de mouvement de l'accueil v3 (UI §9.1, §20.4, §20.6). Styles par CSSOM seulement
// (setProperty, classList : S6), aucune bibliothèque, aucune lecture de mise en page en boucle.
import { reducedMotion } from "./motion";

/** Vrai si le navigateur anime au défilement en CSS (`animation-timeline: view()`). */
export function scrollTimeline(): boolean {
  try {
    return globalThis.CSS?.supports?.("animation-timeline: view()") === true;
  } catch {
    return false;
  }
}

/**
 * Révélation au défilement, repli sans `animation-timeline` (WebKit, Firefox) : `rv-wait` cache
 * l'élément (opacité, translation) jusqu'à son entrée dans l'écran, puis `in` le révèle une fois.
 * Rien en mouvement réduit, ni quand le CSS s'en charge, ni sans IntersectionObserver : le
 * contenu n'est jamais caché si ce code ne tourne pas.
 * Seul un élément encore plus bas que l'écran à la première mesure est caché : un élément déjà
 * visible au chargement ne l'est jamais, et un élément sauté (ancre, défilement rapide), passé
 * au-dessus de l'écran, est révélé tout de suite (audit du 25 novembre).
 */
export function reveal(node: Element): (() => void) | void {
  if (reducedMotion() || scrollTimeline() || typeof IntersectionObserver === "undefined") return;
  let first = true;
  const io = new IntersectionObserver(
    ([e]) => {
      const below = !e!.isIntersecting && e!.boundingClientRect.top > 0;
      if (first) {
        first = false;
        if (below) node.classList.add("rv-wait");
        else io.disconnect();
        return;
      }
      if (below) return;
      node.classList.add("in");
      io.disconnect();
    },
    { rootMargin: "0px 0px 10% 0px" },
  );
  io.observe(node);
  return () => io.disconnect();
}

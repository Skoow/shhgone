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
 */
export function reveal(node: Element): (() => void) | void {
  if (reducedMotion() || scrollTimeline() || typeof IntersectionObserver === "undefined") return;
  node.classList.add("rv-wait");
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e!.isIntersecting) return;
      node.classList.add("in");
      io.disconnect();
    },
    { rootMargin: "0px 0px 10% 0px" },
  );
  io.observe(node);
  return () => io.disconnect();
}

// Lumière d'ambiance gardée au montage (performance) : la page écrite au build
// (accueil, pages d'information) affiche déjà la nuit, l'aurore et le grain. Le script ne les
// recrée plus : il les garde et Aurora.svelte les reprend (échelles exactes, pause), au lieu d'en
// dessiner de nouvelles, que le navigateur comptait comme « plus grand élément » tardif (LCP).

/** Calques de la page écrite, gardés par le point d'entrée et repris une seule fois. */
let gardes: { aurora: HTMLElement } | null = null;

/**
 * Vide `target` sauf ses calques d'ambiance écrits au build (premiers enfants .night, .aurora,
 * .grain), gardés pour Aurora.svelte ; sans eux, vide tout (comportement d'avant).
 */
export function viderSaufAmbiance(target: HTMLElement): void {
  const night = target.querySelector<HTMLElement>(":scope > .night");
  const aurora = target.querySelector<HTMLElement>(":scope > .aurora[data-ambient]");
  const grain = target.querySelector<HTMLElement>(":scope > .grain");
  if (night && aurora && grain) {
    target.replaceChildren(night, aurora, grain);
    gardes = { aurora };
  } else {
    target.replaceChildren();
    gardes = null;
  }
}

/** Calques gardés (une seule fois : le premier Aurora monté les reprend), ou null. */
export function reprendreAmbiance(): { aurora: HTMLElement } | null {
  const g = gardes;
  gardes = null;
  return g;
}

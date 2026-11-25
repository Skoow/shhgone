<script lang="ts">
  // État vide commun (Mes partages, Téléchargements ; passe de finition du 25 novembre) : un
  // dessin au trait dans une pastille, un titre, le texte et l'action, sur une surface à peine
  // levée, bordée d'un filet en pointillés (« rien ici pour l'instant »), alignés à gauche.
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    /** Niveau du titre : h2 dans un écran qui a déjà son h1 ; « p » si ce n'est pas un titre. */
    level?: 2 | "p";
    /** Dessin au trait (SVG), dans la pastille. */
    art?: Snippet;
    /** Texte et action, sous le titre. */
    children?: Snippet;
    [key: `data-${string}`]: unknown;
  };
  let { title, level = 2, art, children, ...rest }: Props = $props();
</script>

<div class="empty" {...rest}>
  {#if art}<span class="art" aria-hidden="true">{@render art()}</span>{/if}
  <div class="tx">
    <svelte:element this={level === 2 ? "h2" : "p"} class="et">{title}</svelte:element>
    {@render children?.()}
  </div>
</div>

<style>
  .empty {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--sp-4) var(--sp-5);
    padding: var(--sp-6);
    border: 1px dashed var(--hair-2);
    border-radius: var(--r-xl);
    background: rgb(255 255 255 / 0.015);
  }
  .art {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: var(--r-lg);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair);
    color: var(--text-3);
  }
  .art :global(svg) {
    width: 32px;
    height: 32px;
  }
  .tx {
    display: grid;
    justify-items: start;
    gap: var(--sp-3);
    min-width: 0;
  }
  .et {
    margin: 0;
    font-size: var(--fs-h3);
    line-height: var(--lh-h3);
    font-weight: 650;
    font-stretch: 104%;
    text-wrap: balance;
  }
  .tx > :global(p) {
    margin: 0;
    max-width: 60ch;
    color: var(--text-2);
  }
  @media (max-width: 559px) {
    .empty {
      grid-template-columns: minmax(0, 1fr);
      padding: var(--sp-5);
    }
  }
  @media (forced-colors: active) {
    .empty {
      border-color: CanvasText;
    }
  }
</style>

<script lang="ts">
  // Une section des paramètres (conception compte §21.15.4) : <section aria-labelledby>, titre
  // --fs-h3, lignes de 56 px (libellé, valeur ou interrupteur, action). Styles communs des
  // sections (.ligne, .val, .note, .form, .raison) donnés ici une fois.
  import type { Snippet } from "svelte";

  type Props = { id: string; titre: string; children: Snippet };
  let { id, titre, children }: Props = $props();
</script>

<section class="sec" aria-labelledby={id}>
  <h2 {id} tabindex="-1">{titre}</h2>
  {@render children()}
</section>

<style>
  .sec {
    display: grid;
    gap: var(--sp-3);
    min-width: 0;
    padding-block: var(--sp-4);
    border-top: 1px solid var(--hair);
  }
  h2 {
    margin: 0;
    scroll-margin-top: calc(64px + var(--sp-5));
    font-size: var(--fs-h3);
    line-height: 1.25;
  }
  h2:focus {
    outline: none;
  }
  .sec :global(.ligne) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-3);
    min-height: 56px;
  }
  .sec :global(.ligne > .lib) {
    display: grid;
    gap: 2px;
    min-width: 0;
    flex: 1 1 12rem;
  }
  .sec :global(.val),
  .sec :global(.note),
  .sec :global(.raison) {
    margin: 0;
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    color: var(--text-2);
  }
  .sec :global(.raison) {
    color: var(--warn);
  }
  .sec :global(.form) {
    display: grid;
    gap: var(--sp-4);
    min-width: 0;
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair);
  }
  .sec :global(.actions) {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
  .sec :global(.ok) {
    margin: 0;
    color: var(--accent);
    font-weight: 560;
  }
  .sec :global(.err) {
    margin: 0;
    color: var(--danger);
  }
</style>

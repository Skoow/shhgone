<script lang="ts">
  // Fenêtre de confirmation Oui / Non (26 novembre : suppression du compte, « Se déconnecter » de la
  // barre du bas et de la ligne du haut). Sur la fenêtre modale de Sheet.svelte (<dialog> natif :
  // focus piégé, Échap, fond inerte ; feuille ancrée en bas sur téléphone). « Non », Échap, la croix
  // et le fond ferment sans rien faire ; « Oui » attend `onyes` (bouton verrouillé pendant ce temps),
  // puis ferme. Le focus revient au bouton d'origine.
  import type { Snippet } from "svelte";
  import Button from "./Button.svelte";
  import Sheet from "./Sheet.svelte";

  type Props = {
    open: boolean;
    title: string;
    /** Texte de la question (ou `children` pour plusieurs paragraphes). */
    message?: string;
    children?: Snippet;
    yesLabel: string;
    noLabel: string;
    danger?: boolean;
    onyes: () => void | Promise<void>;
  };
  let { open = $bindable(false), title, message, children, yesLabel, noLabel, danger = false, onyes }: Props = $props();

  async function oui() {
    await onyes();
    open = false;
  }
</script>

<Sheet bind:open {title}>
  <div class="cd" data-confirm-dialog>
    {#if message}<p class="msg">{message}</p>{/if}
    {#if children}{@render children()}{/if}
    <div class="acts">
      <Button variant="secondary" onpress={() => void (open = false)} data-confirm-no>{noLabel}</Button>
      <Button variant={danger ? "danger" : "primary"} onpress={oui} data-confirm-yes>{yesLabel}</Button>
    </div>
  </div>
</Sheet>

<style>
  .cd {
    display: grid;
    gap: var(--sp-4);
  }
  .msg {
    margin: 0;
    color: var(--text);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--sp-3);
  }
  @media (max-width: 899px) {
    .acts {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
  }
</style>

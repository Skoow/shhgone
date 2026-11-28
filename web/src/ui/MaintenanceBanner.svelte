<script lang="ts">
  // Bandeau de maintenance programmée (D42-32) : discret, sur toutes les pages (AppShell), à
  // l'heure locale du visiteur ; en mode « redémarrage imminent », il dit de réessayer après.
  import { maintenance, texteBandeau } from "../maintenance/etat.svelte";

  const texte = $derived(texteBandeau(maintenance.annonce));
</script>

{#if texte}
  <p class={["maint", { imminente: maintenance.annonce?.imminente === true }]} role="status" data-maintenance-banner>{texte}</p>
{/if}

<style>
  .maint {
    margin: 0;
    padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--line);
    background: var(--surface-2);
    color: var(--text);
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    text-align: center;
  }
  .imminente {
    background: var(--warn-tint);
  }
</style>

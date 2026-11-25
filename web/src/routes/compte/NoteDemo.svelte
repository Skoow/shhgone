<script lang="ts">
  // Démo seulement : la phrase courte de la démo (aucune passkey créée, compte de cet onglet),
  // posée par l'écran juste sous son bouton principal (connexion, inscription, récupération).
  // Hors démo, getDemo() rend null : rien n'est affiché.
  import { getDemo } from "../../app/demo-hooks";
</script>

{#if getDemo()}<p class="note-demo" data-demo-note>{getDemo()!.compteNote}</p>{/if}

<style>
  .note-demo {
    margin: calc(-1 * var(--sp-2)) 0 0;
    color: var(--warn);
    font-size: var(--fs-small);
    line-height: 1.45;
  }
</style>

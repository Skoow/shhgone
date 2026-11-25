<script module lang="ts">
  export const MARK = "__SHH_DEMO__";
</script>

<script lang="ts">
  // Bandeau permanent de la démo (UI §14.3) : en haut de toutes les pages, non fermable.
  // Le texte vit ici, pas dans le dictionnaire de production (check-dist.mjs l'y interdit).
  // « Rien de réel » : les partages de la démo restent chiffrés dans ce navigateur,
  // sur une origine (github.io) partagée par tous les sites GitHub Pages du compte.
  import { getLang } from "../i18n/i18n.svelte";

  const TEXT = {
    fr: "Démo : rien n'est envoyé, le lien ne marche que dans cet onglet. N'y mettez rien de réel.",
    en: "Demo: nothing is sent, the link only works in this tab. Don't put anything real in it.",
  } as const;
</script>

<!-- Une ligne orange fine, sans texte visible ; le texte
     reste lu par les lecteurs d'écran, et « Lien prêt » le redit sous le lien (readyNote). -->
<div class="demo-banner" role="note" data-demo={MARK}>
  <p class="sr-only">{TEXT[getLang()]}</p>
</div>

<style>
  .demo-banner {
    height: 3px;
    background: linear-gradient(90deg, rgb(245 165 36 / 0.25), var(--warn) 18%, #ffb84d 50%, var(--warn) 82%, rgb(245 165 36 / 0.25));
    box-shadow: 0 0 10px rgb(245 165 36 / 0.45);
  }
  @media (forced-colors: active) {
    .demo-banner {
      background: Highlight;
      box-shadow: none;
    }
  }
</style>

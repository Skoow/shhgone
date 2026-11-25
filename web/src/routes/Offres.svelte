<script lang="ts">
  // Offres (page à part, pages séparées) : rythme, cartes courtes (prix, ligne-clé) et comparatif
  // aligné qui porte seul le détail, panneau de paiement à droite, questions
  // (ui/OffersCheckout.svelte, lot 2 de l'audit de design).
  // Retour du prestataire de paiement (/offres/retour, conception du paiement §2 point 5) : même
  // page, l'état du paiement à la place du choix des offres (rendu au navigateur seulement).
  import { t } from "../i18n/i18n.svelte";
  import OffersCheckout from "../ui/OffersCheckout.svelte";
  import OffersReturn from "../ui/OffersReturn.svelte";

  const retour = typeof location !== "undefined" && /\/offres\/retour\/?$/.test(location.pathname);
</script>

<article class="offers" aria-labelledby="offers-title">
  <header class="hd page-card titre-bandeau">
    <h1 id="offers-title" class="title" tabindex="-1" data-large-title>{retour ? t("offers.ret.title") : t("offers.title")}</h1>
    {#if !retour}<p class="lede">{t("offers.lede")}</p>{/if}
  </header>
  {#if retour}<OffersReturn />{:else}<OffersCheckout />{/if}
</article>

<style>
  .offers {
    display: grid;
    gap: var(--sp-5);
    max-width: 72rem;
    padding-block: var(--sp-5) var(--sp-7);
  }
  .hd {
    margin-block-start: clamp(16px, 3vw, 32px);
  }
  /* Grand écran : toute la largeur du contenu, comme l'en-tête pleine largeur (ui/base.css). */
  @media (min-width: 1100px) {
    .offers {
      max-width: none;
      gap: var(--sp-6);
    }
  }
</style>

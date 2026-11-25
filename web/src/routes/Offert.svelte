<script lang="ts">
  // Accès offert (/offres/offert#<pass>, conception du paiement, « Accès offerts ») : écran de
  // l'application (et non des pages séparées) pour avoir le compte sous la main et y ranger le
  // pass. Jamais indexé (app/seo.ts : hors de INDEXED), absent du plan du site.
  import { t } from "../i18n/i18n.svelte";
  import OffersGift, { type CompteOffert } from "../ui/OffersGift.svelte";
  import PageHeader from "../ui/PageHeader.svelte";

  let { compte }: { compte?: CompteOffert } = $props();
</script>

<article class="offert" aria-labelledby="offert-title">
  <PageHeader id="offert-title" size="display" title={t("offers.gift.title")} />
  <OffersGift {compte} />
</article>

<style>
  .offert {
    display: grid;
    gap: var(--sp-5);
    max-width: 72rem;
    padding-block: var(--sp-5) var(--sp-7);
  }
</style>

<script lang="ts">
  // Page d'envoi : un petit cadre qui dit la formule de CE partage (28 novembre : l'offre
  // réellement utilisée, Gratuit, Plus ou Pro, plus « Gratuit » en dur) et ses limites, lues dans
  // les constantes (limitesDe) ; « Voir les offres » mène à /offres. Remplace la bande
  // Gratuit / Plus / Pro et sa feuille « Bientôt disponible ». `newTab` : la liste en cours serait
  // perdue en quittant la page, la page des offres s'ouvre alors dans un nouvel onglet.
  import { followLink, href } from "../app/router.svelte";
  import { formatBytes, formatDuration } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { limitesDe, type Formule } from "../limits";
  import { ArrowRight } from "./Icon";

  let { newTab = false, formule = "free" }: { newTab?: boolean; formule?: Formule } = $props();
  const lang = $derived(getLang());
  const lim = $derived(limitesDe(formule));
  const limits = $derived([formatBytes(lim.contentMax, lang), formatDuration(Math.max(...lim.ttlHours) * 3600, lang), t("options.opens.count", { n: lim.maxOpens })]);
  const nom = $derived(formule === "free" ? t("offers.free") : t(formule === "pro" ? "paid.badge.pro" : "paid.badge.plus"));
  const uid = $props.id();
</script>

<section class="cur" aria-labelledby="{uid}-t" data-current-offer>
  <p class="nm" id="{uid}-t"><span class="k">{t("offers.current")}</span> <b>{nom}</b></p>
  <p class="lim num">{limits.join(" · ")}</p>
  {#if newTab}
    <a class="more" href={href("/offres")} target="_blank" rel="noopener" data-offer-link>{t("offers.strip.more")}<span class="sr-only"> {t("offers.strip.newTab")}</span><ArrowRight size={15} strokeWidth={2} aria-hidden="true" /></a>
  {:else}
    <a class="more" href={href("/offres")} onclick={(e) => followLink(e, "/offres")} data-offer-link>{t("offers.strip.more")}<ArrowRight size={15} strokeWidth={2} aria-hidden="true" /></a>
  {/if}
</section>

<style>
  .cur {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 2px var(--sp-3);
    min-width: 0;
    padding: 10px 14px;
    border-radius: 14px;
    background: rgb(255 255 255 / 0.03);
    box-shadow: inset 0 0 0 1px var(--hair);
  }
  .nm,
  .lim {
    margin: 0;
    min-width: 0;
  }
  .nm {
    font-size: var(--fs-small);
  }
  .k {
    color: var(--text-2);
  }
  .lim {
    grid-column: 1;
    color: var(--text-3);
    font-size: var(--fs-micro);
    overflow-wrap: anywhere;
  }
  .more {
    grid-column: 2;
    grid-row: 1 / span 2;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    padding-inline: 4px;
    border-radius: 8px;
    color: var(--accent);
    font-size: var(--fs-small);
    font-weight: 600;
    text-decoration: none;
  }
  .more:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (forced-colors: active) {
    .cur {
      border: 1px solid CanvasText;
    }
  }
</style>

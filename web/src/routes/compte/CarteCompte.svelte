<script lang="ts">
  // Carte « Votre compte » (conception compte §11, §21.15.3 ; monté seulement avec
  // __COMPTES__) : ancienneté (« Membre »), palier et limites (du
  // serveur, GET /api/compte), abonnement, bannissement avec sa date et son motif. Les limites du
  // palier confirmé (3 salons, 10 places) sont celles du serveur (conception §11), rappelées ici
  // pour un compte récent, qui ne les reçoit pas encore.
  import { account, type EtatServeur } from "../../account/session.svelte";
  import { followLink, href } from "../../app/router.svelte";
  import { getLang, t, type Key } from "../../i18n/i18n.svelte";
  import Banner from "../../ui/Banner.svelte";
  import { jourLong } from "./erreurs";

  type Props = { etat: EtatServeur | null };
  let { etat }: Props = $props();

  /** « 2026-11-14 » → « 1 » (toujours avec l'année). */
  function jourAvecAnnee(iso: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(getLang(), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  }
</script>

<div class="carte" aria-busy={etat === null ? "true" : undefined}>
  <p class="titre">{t("account.card.title")}</p>
  {#if etat}
    <p>{t("account.card.since", { date: jourAvecAnnee(etat.creeLe) })}</p>
    <p class="val">
      {#if etat.palier === "neuf"}
        {t("account.card.neuf", { salons: etat.limites.salons, places: etat.limites.places, heures: etat.limites.heures, date: etat.confirmeLe ? jourLong(etat.confirmeLe) : "" })}
      {:else}
        {t("account.card.confirme", { salons: etat.limites.salons, places: etat.limites.places })}
      {/if}
    </p>
    <p class="plan">
      <span>{account.profil?.pass ? t("account.card.plus") : t("account.card.free")}</span>
      <a class="lien" href={href("/offres")} onclick={(e) => followLink(e, "/offres")}>{t("account.offers")}</a>
    </p>
    {#if etat.banniJusqu}
      <Banner kind="warn">{t("account.banned", { date: jourLong(etat.banniJusqu), motif: t(`report.cat.${etat.banniMotif ?? 10}` as Key) })}</Banner>
    {/if}
  {:else}
    <p class="sq" aria-hidden="true"></p>
    <p class="sq court" aria-hidden="true"></p>
  {/if}
</div>

<style>
  .carte {
    display: grid;
    gap: var(--sp-2);
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--hair);
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .titre {
    font-weight: 600;
  }
  .val {
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: var(--lh-small);
  }
  .plan {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2) var(--sp-4);
  }
  .sq {
    height: 1em;
    border-radius: 6px;
    background: var(--surface-2);
  }
  .sq.court {
    width: 60%;
  }
</style>

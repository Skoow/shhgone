<script lang="ts">
  // Réglages du salon : règle d'effacement (tout participant, v3 §5), puis pour le
  // créateur : places, renouvellement, nouvelle invitation (étapes (a) puis (d) à (h) ; le salon peut raccourcir : dit avant de confirmer, §14.7),
  // destruction ; pour un membre : destruction si le salon le permet ; pour tous : « Quitter »,
  // « Quitter et signaler » (spec §39.5).
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatDuration } from "../../i18n/format";
  import * as S from "../../salon/salon.svelte";
  import { DUREES, PLACES_MAX, PLACES_MIN, type Duree } from "../../salon/creation";
  type Regle = 0 | 1 | 2 | 3;
  import Segmented from "../../ui/Segmented.svelte";
  import Stepper from "../../ui/Stepper.svelte";
  import Button from "../../ui/Button.svelte";
  import InlineConfirm from "../../ui/InlineConfirm.svelte";
  import CopyField from "../../ui/CopyField.svelte";
  import QrCode from "../../ui/QrCode.svelte";

  const vue = S.vue;
  const lang = $derived(getLang());
  const regles = $derived(([1, 2, 3] as const).map((r) => ({ value: r, label: t(`salon.regle.${r}`) })));
  let regle = $state<Regle>((void vue.rev, S.regleCourante()));
  $effect(() => {
    void vue.rev;
    regle = S.regleCourante();
  });
  let places = $state(vue.places);
  let duree = $state<Duree>(24);
  let message = $state("");
  const durees = $derived(DUREES.map((d) => ({ value: d, label: t("salon.new.hours", { n: d }) })));
  const reste = $derived(Math.max(0, (vue.finMs - Date.now()) / 1000));

  function choisir(r: Regle): void {
    regle = r;
    if (r !== S.regleCourante()) S.changerRegle(r);
  }
  function erreur(code: string | null): string {
    if (code === null) return "";
    if (code === "occupied" || code === "limit") return t(`salon.gestion.err.${code}`);
    return t("salon.gestion.err.generique");
  }
</script>

<section class="bloc" aria-labelledby="regle-t">
  <h2 id="regle-t">{t("salon.regle.titre")}</h2>
  <div role="radiogroup" aria-labelledby="regle-t" class="regles">
    {#each regles as r (r.value)}
      <button type="button" role="radio" aria-checked={regle === r.value} onclick={() => choisir(r.value)}>{r.label}</button>
    {/each}
  </div>
  <p class="note">{t("salon.regle.aide")}</p>
  <p class="note">{t("salon.regle.honnete")}</p>
</section>

{#if vue.createur}
  <section class="bloc" aria-labelledby="gestion-t">
    <h2 id="gestion-t">{t("salon.gestion.titre")}</h2>
    <div class="ligne">
      <Stepper label={t("salon.gestion.places")} bind:value={places} min={PLACES_MIN} max={PLACES_MAX} />
      <span class="val">{t("salon.new.places.value", { n: places })}</span>
      <Button variant="secondary" dense onpress={async () => {
          const e = await S.reglerPlaces(places);
          message = e === null ? t("salon.gestion.places.fait") : erreur(e);
        }}>{t("salon.gestion.places.ok")}</Button>
    </div>
    <Segmented label={t("salon.gestion.renouveler.duree")} options={durees} bind:value={duree} columns={4} />
    <InlineConfirm
      label={t("salon.gestion.renouveler")}
      message={t("salon.gestion.renouveler.confirm", { nouvelle: formatDuration(duree * 3600, lang), reste: formatDuration(reste, lang, { coarse: true }) })}
      confirmLabel={t("salon.gestion.renouveler")}
      kind="warn"
      triggerVariant="secondary"
      onconfirm={async () => {
        message = erreur(await S.renouveler(duree));
      }}
    />
    <InlineConfirm
      label={t("salon.invitation.nouvelle")}
      message={t("salon.invitation.confirm")}
      confirmLabel={t("salon.invitation.nouvelle")}
      kind="warn"
      triggerVariant="secondary"
      onconfirm={async () => {
        message = erreur(await S.exclureSiege());
      }}
    />
    {#if message}<p class="note" role="status">{message}</p>{/if}
  </section>
{/if}

{#if vue.createur && vue.nouvelleInvitation}
  <!-- Nouvelle invitation (§39.13) : affichée ici, jamais placée dans la barre d'adresse. -->
  <section class="bloc" aria-labelledby="invitation-t">
    <h2 id="invitation-t">{t("salon.invitation.titre")}</h2>
    <p class="note">{t("salon.invitation.note")}</p>
    <CopyField label={t("salon.ready.link")} value={vue.nouvelleInvitation.lien} />
    <div class="qr"><QrCode text={vue.nouvelleInvitation.lien} label={t("salon.ready.link")} /></div>
    <CopyField label={t("salon.ready.password")} value={vue.nouvelleInvitation.mdp} whole />
    <p class="note">{t("salon.ready.password.hint")}</p>
    <div><Button variant="ghost" dense onpress={() => {
        vue.nouvelleInvitation = null;
      }}>{t("salon.invitation.masquer")}</Button></div>
  </section>
{/if}

<section class="bloc fin">
  {#if vue.createur || vue.membresPeuventDetruire}
    <InlineConfirm label={t("salon.gestion.detruire")} message={t("salon.gestion.detruire.confirm")} confirmLabel={t("salon.gestion.detruire")} kind="danger" triggerVariant="danger" onconfirm={async () => void (await S.detruire())} />
  {/if}
  <InlineConfirm label={t("salon.room.quit")} message={t("salon.room.quit.confirm")} confirmLabel={t("salon.room.quit")} kind="danger" triggerVariant="secondary" onconfirm={S.quitter} />
  <InlineConfirm label={t("report.room.confirm")} message={t("report.room.body")} confirmLabel={t("report.room.confirm")} kind="danger" triggerVariant="ghost" onconfirm={async () => void (await S.quitterEtSignaler())} />
</section>

<style>
  .bloc {
    display: grid;
    gap: var(--sp-3);
    margin-top: var(--sp-5);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .regles {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .regles button {
    min-height: 44px;
    padding: 0 var(--sp-3);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    background: var(--surface-1);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .regles button[aria-checked="true"] {
    border-color: var(--accent);
    background: var(--accent-tint);
  }
  .regles button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .ligne {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
  }
  .val {
    color: var(--text-2);
  }
  .note {
    margin: 0;
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .qr {
    justify-self: start;
    max-width: 220px;
  }
  .fin {
    justify-items: start;
  }
</style>

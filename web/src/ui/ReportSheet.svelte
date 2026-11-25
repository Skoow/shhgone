<script lang="ts">
  // Signaler (UI §9.10 ; conception compte §21.10, §21.15.7). Deux étapes,
  // sans aucun texte libre, pièce ni adresse :
  // 1. « Que se passe-t-il ? » : dix catégories (codes fixes 1 à 10, mêmes dans les apps), vrais
  //    boutons radio d'un seul groupe (flèches, tabulation unique, lecteurs d'écran : le
  //    navigateur). Catégorie facultative : « Autre »
  //    est choisi d'avance, « Continuer » n'est jamais bloqué.
  // 2. Rappel de la catégorie (« Modifier »), ce qui va se passer, PHAROS en bandeau pour les codes
  //    1 et 2 (la phrase des autorités reste pour les autres), « Signaler » (partage, une voix :)
  //    ou « Quitter et signaler » (salon, avec ses écrans C-5) ; focus sur « Annuler ».
  // Rien ne part avant le bouton de l'étape 2 : `onconfirm(catégorie)` fait la requête.
  import { tick } from "svelte";
  import { CATEGORIES, CATEGORIE_AUTRE, type Categorie } from "../index";
  import { href } from "../app/router.svelte";
  import { t, type Key } from "../i18n/i18n.svelte";
  import Banner from "./Banner.svelte";
  import Button from "./Button.svelte";
  import { Check, Flag } from "./Icon";
  import Sheet from "./Sheet.svelte";

  type Props = {
    open: boolean;
    /** Ce qu'on signale : un partage ouvert (détruit), ou un salon (quitté). */
    sorte: "partage" | "salon";
    /** Signale avec la catégorie ; rend un message d'erreur, ou null si la feuille peut se fermer. */
    onconfirm: (categorie: Categorie) => Promise<string | null>;
  };
  let { open = $bindable(false), sorte, onconfirm }: Props = $props();
  const uid = $props.id();
  let etape = $state<1 | 2>(1);
  let choix = $state<Categorie>(CATEGORIE_AUTRE);
  let error = $state("");
  let annuler: HTMLButtonElement | undefined = $state();
  let groupe: HTMLDivElement | undefined = $state();

  const nom = (c: Categorie) => t(`report.cat.${c}` as Key);
  const aide = (c: Categorie) => (c === CATEGORIE_AUTRE ? "" : t(`report.cat.${c}.help` as Key));
  const autorites = $derived(choix === 1 || choix === 2);

  async function continuer() {
    error = "";
    etape = 2;
    await tick();
    annuler?.focus();
  }
  async function modifier() {
    error = "";
    etape = 1;
    await tick();
    groupe?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }
  async function confirm() {
    error = "";
    const e = await onconfirm(choix);
    if (e === null) open = false;
    else error = e;
  }
  function reset() {
    error = "";
    etape = 1;
    choix = CATEGORIE_AUTRE;
  }
</script>

<Sheet bind:open title={t("report.title")} onclose={reset}>
  <div class="report">
    {#if etape === 1}
      <p id="{uid}-q" class="q">{t("report.question")}</p>
      <div class="cats" role="radiogroup" aria-labelledby="{uid}-q" bind:this={groupe}>
        {#each CATEGORIES as c (c)}
          <label class={["cat", { on: choix === c }]}>
            <input type="radio" name="{uid}-cat" value={String(c)} checked={choix === c} onchange={() => (choix = c)} />
            <span class="txt">
              <span class="nom" data-nom>{nom(c)}</span>
              {#if aide(c)}<span class="aide">{aide(c)}</span>{/if}
            </span>
            <span class="coche" aria-hidden="true">{#if choix === c}<Check size={18} strokeWidth={2.2} />{/if}</span>
          </label>
        {/each}
      </div>
      <div class="actions">
        <Button onpress={continuer}>{t("report.continue")}</Button>
        <Button variant="ghost" onpress={() => void (open = false)}>{t("common.cancel")}</Button>
      </div>
    {:else}
      <p class="rappel">
        <span class="choisi">{nom(choix)}</span>
        <span aria-hidden="true">·</span>
        <button type="button" class="mod" onclick={modifier}>{t("report.change")}</button>
      </p>
      <p class="body">{t(sorte === "partage" ? "report.share.body" : "report.room.body")}</p>
      {#if autorites}
        <Banner kind="warn">
          {t("report.pharos.a")}<a href="https://www.internet-signalement.gouv.fr/" target="_blank" rel="noopener noreferrer">{t("report.pharos.link")}</a>{t("report.pharos.b")}<a
            href={href("/signaler")}
            target="_blank"
            rel="noopener noreferrer">{t("report.pharos.page")}</a
          >{t("report.pharos.c")}
        </Banner>
      {:else}
        <p class="body">{t("report.authorities")}</p>
      {/if}
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <div class="actions">
        <Button variant="danger" onpress={confirm}>
          {#snippet icon()}<Flag size={18} />{/snippet}
          {t(sorte === "partage" ? "report.confirm" : "report.room.confirm")}
        </Button>
        <Button variant="ghost" bind:el={annuler} onpress={() => void (open = false)}>{t("common.cancel")}</Button>
      </div>
    {/if}
  </div>
</Sheet>

<style>
  .report {
    display: grid;
    gap: var(--sp-4);
  }
  .q {
    margin: 0;
    font-size: var(--fs-body);
    font-weight: 600;
  }
  .cats {
    display: grid;
    gap: var(--sp-1);
  }
  .cat {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: 56px;
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-md);
    border: 1px solid transparent;
    cursor: pointer;
  }
  .cat input {
    position: absolute;
    opacity: 0;
    inset: 0;
    margin: 0;
    cursor: pointer;
  }
  .cat:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .cat.on {
    background: var(--accent-tint);
    border-color: var(--accent);
  }
  @media (hover: hover) {
    .cat:not(.on):hover {
      background: rgb(255 255 255 / 0.05);
    }
  }
  .txt {
    flex: 1;
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .nom {
    font-size: var(--fs-body);
    font-weight: 560;
  }
  .aide {
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    color: var(--text-2);
  }
  .coche {
    flex: none;
    width: 22px;
    height: 22px;
    display: inline-grid;
    place-items: center;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    color: var(--accent);
  }
  .cat.on .coche {
    border-color: var(--accent);
  }
  .rappel {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2);
  }
  .choisi {
    font-weight: 600;
  }
  .mod {
    min-height: 44px;
    padding: 0 var(--sp-1);
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-weight: 560;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .body {
    margin: 0;
    color: var(--text-2);
    max-width: 60ch;
  }
  .report :global(.banner a) {
    color: inherit;
    font-weight: 600;
    text-underline-offset: 3px;
  }
  .err {
    margin: 0;
    color: var(--danger);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
  @media (forced-colors: active) {
    .cat.on {
      border-color: Highlight;
    }
  }
</style>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { BUILD_ID } from "../app/build";
  import { chrome } from "../app/chrome.svelte";
  import { getDemo } from "../app/demo-hooks";
  import { currentPath, followLink, href, navigate, router } from "../app/router.svelte";
  import { SOURCE_URL } from "../routes/pages/content";
  import { t } from "../i18n/i18n.svelte";
  import Aurora from "./Aurora.svelte";
  import EnglishLink from "./EnglishLink.svelte";
  import { ChevronLeft } from "./Icon";
  import LiveRegion from "./LiveRegion.svelte";
  import Logo from "./Logo.svelte";
  import TabBar from "./TabBar.svelte";
  import TopNav from "./TopNav.svelte";
  import MobileMenu from "./MobileMenu.svelte";
  import { accountFlag } from "../app/account-flag.svelte";
  import { presence } from "../history/presence.svelte";

  type Props = {
    children: Snippet;
    /** Emplacement du bandeau de démo (vide hors démo). */
    banner?: Snippet;
    /** Vrai pendant un envoi : le pied reste affiché mais ses liens sont désactivés, pour
     *  qu'aucun clic ne quitte la page et coupe l'envoi. */
    busy?: boolean;
    /** Barre d'onglets du téléphone (app/tabbar.ts) ; rendue sous 768 px seulement (CSS). */
    tabs?: boolean;
  };
  let { children, banner, busy = false, tabs = false }: Props = $props();
  // Démo GitHub Pages seulement (null en production) : phrase de l'hébergeur au pied de page.
  const demo = getDemo();

  // Téléphone : la page réserve la hauteur de la barre d'onglets (base.css, html.has-tabbar).
  $effect(() => {
    document.documentElement.classList.toggle("has-tabbar", tabs);
    return () => document.documentElement.classList.remove("has-tabbar");
  });

  let main: HTMLElement | undefined = $state();
  let sentinel: HTMLElement | undefined = $state();
  let scrolled = $state(false);
  // Hauteur du bandeau collant (varie avec la largeur et la taille du texte) : l'en-tête se colle dessous.
  let bannerH = $state(0);

  // Verre de l'en-tête seulement une fois la page défilée (UI §5.4).
  $effect(() => {
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => (scrolled = !entry!.isIntersecting));
    io.observe(sentinel);
    return () => io.disconnect();
  });

  // Après un changement d'écran, le focus va au contenu, sauf si l'écran l'a déjà pris (son titre).
  let first = true;
  $effect(() => {
    void router.current;
    if (first) {
      first = false;
      return;
    }
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
  });

  // Lien d'évitement : pas de « #contenu » dans l'adresse (le « # » est réservé aux clés).
  function skip(e: MouseEvent) {
    e.preventDefault();
    main?.focus();
  }

  // Lien désactivé pendant l'envoi : annoncé comme tel, avec sa raison, et GARDÉ dans le parcours
  // clavier comme la langue et le nettoyage (audit M22 : sur « Lien prêt », Tab sautait les liens
  // mais pas les boutons ; un élément désactivé reste trouvable, sa raison se lit).
  const off = $derived(busy ? { "aria-disabled": "true" as const, "aria-describedby": "foot-busy", title: t("foot.busy") } : {});

  // Téléphone (< 900 px), en-tête d'écran natif : retour en haut à gauche sur les pages
  // secondaires de l'expéditeur, et le grand titre de l'écran qui se réduit dans la barre une
  // fois défilé (titre marqué data-large-title, sinon le h1 de l'écran). Sur ordinateur, rien ne change.
  // Pages d'information : leur propre fichier HTML (pages séparées) ; en-tête ordinaire (logo,
  // menu), pas de « Retour » comme un écran de l'application (retours du 16 novembre).
  const BACK: ReadonlySet<string> = new Set(["notfound", "manage", "envois", "telechargements"]);
  // Pied de page sur toutes les pages, ordinateur et téléphone, composeur compris (retours du
  // 11 novembre) ; sur ordinateur, le composeur tient dans l'écran et le pied est juste dessous.
  type FootLink = { label: string; path?: string; url?: string; soon?: boolean; report?: boolean };
  const footCols = $derived<{ id: string; title: string; links: FootLink[] }[]>([
    // Plus d'« Envoyer », de « Mes partages » ni de « Salon bientôt » (retours du 16 novembre) ;
    // plus d'« Offres » (17 novembre : l'en-tête et le menu y mènent). Colonne « Produit »
    // seulement avec un compte (Téléchargements, retours du 15 novembre, comme le menu ☰), ou sans
    // compte si l'historique des téléchargements est activé sur cet appareil (22 novembre).
    ...(accountFlag.connected || presence.downloads ? [{ id: "product", title: t("foot.product"), links: [{ label: t("foot.downloads"), path: "/telechargements" }] }] : []),
    {
      id: "trust",
      title: t("foot.trust"),
      links: [
        { label: t("shell.security"), path: "/securite" },
        { label: t("shell.privacy"), path: "/confidentialite" },
        // « Open source sur GitHub » ; la licence (AGPL-3.0) est dite sur GitHub, plus dans le pied
        // (décision du propriétaire du 17 novembre).
        { label: t("foot.source"), url: SOURCE_URL },
        { label: t("foot.report"), path: "/signaler", report: true },
      ],
    },
    {
      id: "legal",
      title: t("foot.legal"),
      links: [
        { label: t("foot.terms"), path: "/conditions" },
        { label: t("foot.notice"), path: "/mentions-legales" },
      ],
    },
  ]);
  // « Envoyer » (/) n'est la page courante que sur l'accueil : un partage ouvert a aussi « / » pour chemin.
  const pathHere = (p: string) => (router.current.name !== "notfound" && currentPath() === href(p) && (p !== "/" || router.current.name === "home") ? "page" : undefined);
  // « Mes partages » et « Téléchargements » sont des onglets racine quand la barre d'onglets est là : pas de Retour.
  const back = $derived(BACK.has(router.current.name) && !(tabs && (router.current.name === "envois" || router.current.name === "telechargements")));
  let small = $state("");
  let raf = 0;
  function measure() {
    raf = 0;
    // Le premier titre affiché (un écran caché, comme le composeur pendant l'envoi, ne compte pas).
    const shown = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.getClientRects().length > 0);
    const marked = shown("main [data-large-title]");
    if (router.current.name === "home" && !marked) return void (small = "");
    const el = marked ?? shown("main h1");
    const bar = document.querySelector<HTMLElement>("header.top");
    const hidden = !!el && !!bar && el.getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom;
    small = hidden ? (el!.textContent ?? "").trim() : "";
  }
  const queue = () => {
    if (!raf) raf = requestAnimationFrame(measure);
  };
  $effect(() => {
    void router.current;
    queue();
    return () => cancelAnimationFrame(raf);
  });
  function goBack() {
    navigate("/", { back: true });
  }
</script>

<Aurora />

<a class="skip" href="#contenu" onclick={skip}>{t("shell.skip")}</a>

<EnglishLink />

{#if banner}
  <div class="banner-slot" bind:clientHeight={bannerH}>{@render banner()}</div>
{/if}

<div bind:this={sentinel} class="sentinel" aria-hidden="true"></div>

<svelte:window onscroll={queue} onresize={queue} />

<header class={["top", { scrolled, tabs, "has-back": back }]} style:--banner-h={banner ? `${bannerH}px` : undefined}>
  <div class="bar wrap">
    {#if back}
      <button type="button" class="back" onclick={goBack}><ChevronLeft size={24} strokeWidth={2} aria-hidden="true" /><span class="back-t">{t("shell.back")}</span></button>
    {/if}
    <p class={["small", { on: small !== "" }]} aria-hidden="true">{small}</p>
    <!-- Pendant un envoi et sur « Lien prêt » : désactivé comme le pied (audit I2). -->
    <a class="logo" href={href("/")} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/"))} aria-label={t("shell.home")} {...off}>
      <!-- Logo « Trame » (scripts/gen-logo.mjs) ; l'introduction ne se joue que sur l'accueil, une fois par chargement. -->
      <Logo />
    </a>
    <!-- Ordinateur et tablette (≥ 768 px, refonte du 12 novembre) : menus et actions. -->
    <TopNav {busy} />
    <!-- Téléphone (< 768 px, retours du 15 novembre) : menu ☰ à la place de la barre d'onglets. -->
    <MobileMenu {busy} />
  </div>
</header>

<main id="contenu" tabindex="-1" bind:this={main} class="wrap">
  {@render children()}
</main>

<footer class={["foot", { busy }]} data-foot>
  <div class="wrap foot-in">
    {#if busy}
      <!-- Envoi en cours : la raison des liens désactivés, lue par les lecteurs d'écran (aria-describedby)
           et en bulle au survol ; plus de bandeau visible (propriétaire, 21 novembre). -->
      <p id="foot-busy" class="sr-only" data-foot-busy>{t("foot.busy")}</p>
    {/if}
    <div class="brand">
      <a class="foot-logo" href={href("/")} aria-label={t("shell.home")} {...off} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/"))}><Logo /></a>
      <p class="tag">{t("foot.tagline")}</p>
    </div>
    <nav class={["cols", { two: footCols.length === 2 }]} aria-label={t("shell.nav")}>
      {#each footCols as col (col.id)}
        <div class="col">
          <p class="ch" id="foot-{col.id}">{col.title}</p>
          <ul aria-labelledby="foot-{col.id}">
            {#each col.links as l (l.label)}
              <li>
                {#if l.soon}
                  <span class="off">{l.label} <span class="soon">{t("foot.soon")}</span></span>
                {:else if busy}
                  <!-- Envoi en cours : lien aria-disabled, raison lue (foot-busy), toujours atteignable au clavier (audit M22) ; clic et Entrée sans effet (preventDefault), pointeur neutralisé en CSS. -->
                  <a class="fl" href={l.url ?? href(l.path ?? "/")} {...off} onclick={(e) => e.preventDefault()}>{l.report && chrome.report ? t("content.report") : l.label}</a>
                {:else if l.report && chrome.report}
                  <!-- Partage ouvert : la confirmation de signalement de CE partage (même action qu'avant). -->
                  <button type="button" class="fl" aria-haspopup="dialog" onclick={() => chrome.report?.()} data-report-share>{t("content.report")}</button>
                {:else if l.url}
                  <a class="fl" href={l.url} target="_blank" rel="noopener noreferrer">{l.label}<span class="sr-only"> {t("foot.external")}</span></a>
                {:else if l.path}
                  <a class="fl" href={href(l.path)} aria-current={pathHere(l.path)} onclick={(e) => followLink(e, l.path!)}>{l.label}</a>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>
    <!-- Proposition B2 retenue (propriétaire, 18 novembre) : trois colonnes resserrées, sans le
         bloc « À propos » (la phrase de la marque le dit déjà). -->
    <div class="base">
      <!-- Retours UI9 : le nom en bas à gauche, « © 2026 » à côté (plus de mention « aucune publicité »). -->
      <p class="sig"><span class="wm" translate="no">Shhgone</span><span>{t("foot.copy")}</span></p>
      {#if demo}<p class="host" data-demo-host>{demo.hostNote}</p>{/if}
      <p class="num" data-build>{t("foot.version", { v: BUILD_ID })}</p>
    </div>
  </div>
</footer>

{#if tabs}<TabBar />{/if}

<LiveRegion />

<style>
  .wrap {
    width: 100%;
    /* Grands écrans : la largeur disponible sert (accueil et composeur), jusqu'à 1 520 px. */
    max-width: 1520px;
    margin-inline: auto;
    padding-inline: max(var(--sp-4), env(safe-area-inset-left)) max(var(--sp-4), env(safe-area-inset-right));
  }
  @media (min-width: 600px) {
    .wrap {
      padding-inline: max(var(--sp-5), env(safe-area-inset-left)) max(var(--sp-5), env(safe-area-inset-right));
    }
  }
  @media (min-width: 1024px) {
    .wrap {
      padding-inline: max(40px, env(safe-area-inset-left)) max(40px, env(safe-area-inset-right));
    }
  }

  .skip {
    position: absolute;
    inset-block-start: var(--sp-2);
    inset-inline-start: var(--sp-2);
    z-index: 100;
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r-md);
    background: var(--surface-3);
    color: var(--text);
    transform: translateY(-200%);
  }
  .skip:focus-visible {
    transform: none;
  }

  /* Bandeau de démo collé en haut ; l'en-tête (.top) se colle juste dessous. */
  .banner-slot {
    position: sticky;
    inset-block-start: 0;
    z-index: 11;
    /* App installée (barre d'état translucide sur iOS) : rien sous l'encoche. */
    padding-top: env(safe-area-inset-top, 0px);
    background: var(--bg);
  }
  @media (max-height: 500px) and (orientation: landscape) {
    .banner-slot {
      position: static;
    }
  }

  .sentinel {
    position: absolute;
    inset-block-start: 0;
    height: 1px;
    width: 1px;
  }

  .top {
    position: sticky;
    inset-block-start: var(--banner-h, 0px);
    z-index: 10;
    padding-top: env(safe-area-inset-top, 0px);
    transition:
      background-color var(--dur-base) var(--ease-out),
      box-shadow var(--dur-base) var(--ease-out);
  }
  .banner-slot ~ .top {
    padding-top: 0;
  }
  /* Retours UI5 : sur téléphone, un peu d'air au-dessus du logo, en plus de la
     zone sûre (sur ordinateur, la barre de 64 px les centre déjà). */
  @media (max-width: 899px) {
    .top,
    .banner-slot ~ .top {
      padding-top: calc(env(safe-area-inset-top, 0px) + var(--sp-2));
    }
    .banner-slot ~ .top {
      padding-top: var(--sp-2);
    }
  }
  /* Verre mobile (§5.4) : le contenu défile dessous, le flou est donc justifié (K6). */
  .top.scrolled {
    background: var(--glass);
    -webkit-backdrop-filter: blur(20px) saturate(1.2);
    backdrop-filter: blur(20px) saturate(1.2);
    box-shadow: 0 1px 0 var(--hair);
  }
  /* Téléphone (retours du 15 novembre) : le texte de la page se lisait encore sous le logo et
     sous « Retour » ; fond presque plein, le flou ne sert plus qu'au bord. */
  @media (max-width: 899px) {
    .top.scrolled {
      background: color-mix(in srgb, var(--bg) 96%, transparent);
    }
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .top.scrolled {
      background: var(--surface-1);
    }
  }
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .top.scrolled {
      background: var(--surface-1);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
      box-shadow: 0 1px 0 var(--line-strong);
    }
  }
  @media (max-height: 500px) and (orientation: landscape) {
    .top {
      position: static;
    }
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    min-height: 64px;
    gap: var(--sp-3);
  }

  .logo {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--text);
    text-decoration: none;
    border-radius: var(--r-sm);
  }
  .logo[aria-disabled="true"] {
    cursor: not-allowed;
  }
  /* Page courte : le pied de page descend en bas de l'écran au lieu de laisser une bande vide
     dessous (propriétaire, 21 novembre). */
  :global(#app:has(> footer[data-foot])) {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
  }
  main {
    flex: 1 0 auto;
    min-height: 60dvh;
    padding-block: var(--sp-5);
  }
  main:focus {
    outline: none;
  }
  /* Accueil : sa dernière section (la FAQ, plaque en relief) touche le pied de page ; sinon une
     bande du fond de page restait entre les deux, comme une couture ratée (revue du 19 novembre). */
  main:has(> :global(.home)) {
    padding-block-end: 0;
  }
  main:has(> :global(.home)) + .foot {
    margin-block-start: 0;
  }

  /* Pied de page (retours UI7) : lueur discrète de la DA sous un filet supérieur lumineux (le
     grain de l'aurore passe dessous), marque à gauche au même bord intérieur que l'en-tête,
     colonnes hiérarchisées, liens JAMAIS soulignés (retours UI8) : survol et focus par la couleur,
     anneau de focus au clavier. */
  /* Pied de page : bord droit, sans filet (propriétaire, 19 novembre, 4 : ni coins arrondis ni
     filet menthe). */
  .foot {
    position: relative;
    /* Son propre fond seulement (décision du propriétaire du 16 novembre) : le fond de la page
       (aurore, trame) ne se mélange plus à son papier peint ; la lueur et les pictos restent. */
    z-index: 1;
    isolation: isolate;
    margin-block-start: var(--sp-8);
    padding-block: var(--sp-6) calc(var(--sp-4) + env(safe-area-inset-bottom));
    background:
      radial-gradient(60% 120% at 12% 0%, rgb(95 227 181 / 0.07), transparent 70%),
      radial-gradient(50% 90% at 88% 100%, rgb(95 227 181 / 0.04), transparent 70%),
      linear-gradient(to bottom, rgb(255 255 255 / 0.025), rgb(7 8 12 / 0.55))
      var(--bg);
  }
  /* Papier peint maison (retours UI7) : petits pictos Shhgone répétés (cadenas, clé, fichier,
     onde, points de la Trame), fichier statique mis en cache (CSP : ni data: ni style inline),
     à très faible contraste et fondu vers le haut ; retiré en contraste renforcé ou forcé. */
  .foot::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: url(../assets/motif.svg) 0 0 / 180px 180px repeat;
    opacity: 0.045;
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 45%);
    mask-image: linear-gradient(to bottom, transparent, #000 45%);
  }
  .foot-in {
    display: grid;
    grid-template-columns: minmax(14rem, 1.4fr) minmax(0, 2fr);
    gap: var(--sp-5) var(--sp-6);
  }
  .brand {
    display: grid;
    align-content: start;
    justify-items: start;
    gap: var(--sp-3);
  }
  .foot-logo {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    color: var(--text);
    border-radius: var(--r-sm);
  }
  .tag {
    margin: 0;
    max-width: 30ch;
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    text-wrap: pretty;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-5) var(--sp-6);
  }
  .cols.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .ch {
    margin: 0 0 var(--sp-3);
    color: var(--text-3);
    font-size: var(--fs-micro);
    font-weight: 640;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .col ul {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fl,
  .off {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 40px;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .fl {
    position: relative;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--fs-small);
    text-align: start;
    text-decoration: none;
    cursor: pointer;
    transition:
      color var(--dur-fast) var(--ease-out),
      translate var(--dur-base) var(--ease-out);
  }
  /* Cible d'appui de 44 px (audit M21) : 40 px dessinés, 2 px de plus de chaque côté, invisibles. */
  .fl::after {
    content: "";
    position: absolute;
    inset: -2px 0;
  }
  .fl:hover,
  .fl:focus-visible {
    color: var(--text);
  }
  /* Page courante : couleur d'accent, sans trait. */
  .fl[aria-current="page"] {
    color: var(--accent);
  }
  @media (hover: hover) {
    .fl:hover {
      translate: 2px 0;
    }
  }
  /* Clavier : anneau net autour du lien (jamais de soulignement, retours UI8). */
  .fl:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 6px;
    padding-inline: 4px;
    margin-inline: -4px;
  }
  .off {
    color: var(--text-3);
  }
  .soon {
    padding: 1px 8px;
    border-radius: var(--r-pill);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: var(--fs-micro);
  }
  /* Envoi en cours : liens et réglages désactivés (raison lue par les lecteurs d'écran, et en bulle). */
  .foot [aria-disabled="true"] {
    color: var(--text-disabled);
    cursor: not-allowed;
  }
  .foot a[aria-disabled="true"] {
    pointer-events: none;
  }
  /* Bas du pied (17 novembre) : plus bas, le nom à gauche plus gros que la version, à droite. */
  .base {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-1) var(--sp-4);
    /* Ligne au plus près du nom et de la version (propriétaire, 18 novembre). */
    padding-block-start: var(--sp-2);
    border-block-start: 1px solid var(--hair);
    color: var(--text-3);
    font-size: var(--fs-micro);
  }
  .base p {
    margin: 0;
  }
  .base .host {
    color: var(--text-2);
  }
  /* Version : discrète, plus petite que le nom. */
  .base [data-build] {
    font-size: 0.625rem;
    letter-spacing: 0.02em;
    opacity: 0.8;
  }
  .sig {
    display: inline-flex;
    align-items: baseline;
    gap: var(--sp-2);
  }
  .wm {
    color: var(--text-2);
    font-size: var(--fs-body);
    font-weight: 650;
  }
  /* Téléphone et tablette (retours du propriétaire du 15 novembre) : un seul bloc centré, plus
     de colonnes. Marque et phrase, puis tous les liens à la suite ; les intitulés de colonne
     restent pour les lecteurs d'écran (chaque liste garde son nom) ; « À propos » redisait la
     phrase de la marque : retiré ici. */
  @media (max-width: 899px) {
    .foot {
      padding-block-start: var(--sp-6);
    }
    .foot-in {
      grid-template-columns: 1fr;
      justify-items: center;
      gap: var(--sp-5);
      text-align: center;
    }
    .brand {
      justify-items: center;
    }
    .tag {
      max-width: 34ch;
    }
    /* Une seule grille de deux colonnes, chaque lien centré dans la sienne, comme la marque et la
       phrase au-dessus (17 novembre) ; les listes partagent les mêmes colonnes. */
    .cols,
    .cols.two {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
      width: min(100%, 22rem);
      text-align: center;
    }
    .col li {
      display: flex;
      justify-content: center;
    }
    .ch {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .col ul {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      column-gap: var(--sp-4);
    }
    .fl,
    .off {
      min-height: 44px;
    }
    .base {
      justify-self: stretch;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl {
      transition: none;
    }
    .fl:hover {
      translate: none;
    }
  }
  @media (prefers-contrast: more), (forced-colors: active) {
    .foot {
      background: none;
      border-block-start: 1px solid var(--line-strong);
    }
    .foot::after {
      display: none;
    }
  }

  .back,
  .small {
    display: none;
  }
  /* ---------- Téléphone : en-tête d'écran natif ---------- */
  @media (max-width: 899px) {
    .bar {
      position: relative;
      flex-wrap: nowrap;
      min-height: 52px;
    }
    /* Retour à la place du logo. */
    .has-back .logo {
      display: none;
    }
    .back {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      min-height: 44px;
      margin-inline-start: -10px;
      padding: 0 var(--sp-2) 0 4px;
      border: 0;
      border-radius: var(--r-md);
      background: transparent;
      color: var(--accent);
      font: inherit;
      font-size: var(--fs-body);
      font-weight: 560;
      cursor: pointer;
    }
    .back:active {
      opacity: 0.6;
    }
    .back:focus-visible {
      outline: 2px solid var(--accent);
    }
    .small {
      display: none;
      position: absolute;
      inset-inline: 104px;
      margin: 0;
      overflow: hidden;
      font-size: var(--fs-body);
      font-weight: 620;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0;
      transform: translateY(6px);
      transition:
        opacity 180ms var(--ease-out),
        transform 220ms var(--ease-out);
      pointer-events: none;
    }
    .small.on {
      opacity: 1;
      transform: none;
    }
    /* Téléphone seulement : la tablette a la barre du haut complète. */
    @media (max-width: 767px) {
      .small {
        display: block;
      }
    }
    .small.on ~ .logo {
      opacity: 0;
      pointer-events: none;
    }
    main {
      padding-block: var(--sp-3) var(--sp-6);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .small {
      transition: none;
    }
  }
  @media (forced-colors: active) {
    .top.scrolled {
      background: Canvas;
    }
  }
</style>

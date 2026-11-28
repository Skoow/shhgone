<script lang="ts">
  // Menu du téléphone (< 768 px) : remplace la barre
  // d'onglets du bas sur le site. Motif disclosure (bouton aria-expanded qui montre une liste de
  // liens, pas un role="menu"), comme les menus de TopNav. Échap ferme et rend le focus au bouton ;
  // un clic ailleurs ou un changement d'écran le ferme. « Téléchargements » n'y figure qu'avec un
  // compte : sans compte, l'historique des téléchargements ne vit que dans ce navigateur et ne
  // permet de rien retélécharger (le lien n'est jamais gardé), il n'a pas sa place dans le menu.
  import { currentPath, followLink, href, router } from "../app/router.svelte";
  import { accountFlag } from "../app/account-flag.svelte";
  import { presence } from "../downloads/presence.svelte";
  import { t } from "../i18n/i18n.svelte";
  import { announce } from "./announce";
  import { ChevronDown, ChevronRight, Clock, Compass, Download, MessagesSquare, Server, ShieldCheck, Tag, User } from "./Icon";
  import { allerSection } from "./section";
  import type { Component } from "svelte";

  let { busy = false }: { busy?: boolean } = $props();

  let open = $state(false);
  /** Entrée à sous-menu dépliée (son chemin) ; toutes repliées à chaque ouverture du menu. */
  let deplie = $state<string | null>(null);
  let wrap: HTMLElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();
  const uid = $props.id();

  // Les écrans du site, chacun avec son icône ; puis le compte (seulement avec __COMPTES__) :
  // « Se connecter » et « Créer un compte », ou, connecté, « Mon compte » seul (25 novembre :
  // plus de « Nouveau partage » ici, c'est le bouton du bas ; plus d'« Accueil », c'est le logo ;
  // connecté, « Se déconnecter » est dans la barre du bas, 26 novembre). « Mes partages » en tête
  // (D42-30), avec ou sans compte. Confidentialité, Conditions, Signaler…
  // restent dans le pied de page.
  // `subs` : sections de l'accueil sous une entrée (Sécurité : « Comment ça marche », « Ce que voit
  // le serveur », comme le menu Sécurité de l'ordinateur, TopNav.svelte ; ui/section.ts).
  type Sub = { id: string; label: string; icon: Component; section: string; faq?: boolean };
  type Link = { label: string; path: string; icon: Component; soon?: string; subs?: Sub[]; page?: string };
  const links = $derived<Link[]>([
    { label: t("nav.shares"), path: "/envois", icon: Clock },
    // « Téléchargements » sans compte seulement si l'historique est activé ici.
    ...(accountFlag.connected || presence.downloads ? [{ label: t("foot.downloads"), path: "/telechargements", icon: Download }] : []),
    // Salon : la création ; « bientôt » seulement sans __SALONS__ (démo, site sans compte).
    __SALONS__ ? { label: t("nav.room"), path: "/salon/nouveau", icon: MessagesSquare } : { label: t("nav.room"), path: "", icon: MessagesSquare, soon: t("tabs.soon.chat") },
    {
      label: t("nav.security"),
      path: "/securite",
      icon: ShieldCheck,
      page: t("nav.sec.page.t"),
      subs: [
        { id: "how", label: t("nav.sec.how.t"), icon: Compass, section: "comment" },
        { id: "server", label: t("nav.sec.server.t"), icon: Server, section: "serveur" },
      ],
    },
    { label: t("nav.offers"), path: "/offres", icon: Tag },
    // Compte pas encore ouvert (D8) : « Se connecter » visible, bientôt.
    ...(__COMPTES__ ? [] : [{ label: t("account.login.title"), path: "", icon: User, soon: t("nav.login.soon") }]),
  ]);
  const account = $derived<Link[]>(__COMPTES__ && accountFlag.connected ? [{ label: t("nav.menu.myAccount"), path: "/compte", icon: User }] : []);
  const here = (p: string) => (currentPath() === href(p) && (p !== "/" || router.current.name === "home") ? "page" : undefined);

  function versSection(s: Sub) {
    close();
    void allerSection(s.section, s.faq);
  }

  function close(focusBack = false) {
    if (!open) return;
    open = false;
    if (focusBack) button?.focus();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    }
  }
  // Clic ailleurs : ferme, sans voler le focus.
  $effect(() => {
    if (!open) return;
    const down = (e: Event) => {
      if (!wrap?.contains(e.target as Node)) open = false;
    };
    // Clavier : le focus qui sort du menu le ferme (la page derrière est
    // voilée : on n'y tabule pas à l'aveugle), et Échap le ferme où que soit le focus.
    const sorti = (e: FocusEvent) => {
      const vers = e.relatedTarget as Node | null;
      if (vers && !wrap?.contains(vers)) open = false;
    };
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", down, true);
    wrap?.addEventListener("focusout", sorti);
    window.addEventListener("keydown", touche);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      wrap?.removeEventListener("focusout", sorti);
      window.removeEventListener("keydown", touche);
    };
  });
  // Changement d'écran ou envoi qui commence : menu fermé.
  $effect(() => {
    void router.current;
    void busy;
    open = false;
  });
</script>

<div class="mm" bind:this={wrap} onkeydown={onKey} role="presentation">
  <button
    bind:this={button}
    type="button"
    class="mm-b"
    aria-expanded={open}
    aria-controls="{uid}-menu"
    aria-label={open ? t("nav.menu.close") : t("nav.menu.open")}
    aria-disabled={busy ? "true" : undefined}
    aria-describedby={busy ? "foot-busy" : undefined}
    onclick={() => {
      if (busy) return;
      open = !open;
      deplie = null;
    }}
    data-menu-button
  >
    <!-- Trois traits qui deviennent une croix. -->
    <span class="burger" aria-hidden="true"><span></span><span></span><span></span></span>
  </button>
  <!-- Voile sous le menu ouvert : la page s'assombrit ; un appui dessus ferme. -->
  {#if open}<div class="mm-scrim" aria-hidden="true"></div>{/if}
  <nav class="mm-p" id="{uid}-menu" aria-label={t("nav.label")} hidden={!open} data-menu>
    <ul class="mm-list">
      {#each links as l, i (l.label)}
        <li style:--i={i}>
          {#if l.soon}
            <button type="button" class="mm-l soon" aria-disabled="true" aria-describedby="{uid}-soon-{i}" onclick={() => announce(l.soon!)}>
              <span class="mm-ic" aria-hidden="true"><l.icon size={20} strokeWidth={1.9} /></span>
              <span class="mm-t">{l.label}</span><span class="mm-soon">{t("foot.soon")}</span>
            </button>
            <span id="{uid}-soon-{i}" class="sr-only">{l.soon}</span>
          {:else}
            {#if l.subs}
              <!-- Accordéon : replié à l'ouverture du menu, déplié au toucher (aria-expanded) ; la
                   page de l'entrée devient la dernière ligne de la liste. -->
              <button
                type="button"
                class="mm-l"
                aria-expanded={deplie === l.path}
                aria-controls="{uid}-sub-{i}"
                onclick={() => (deplie = deplie === l.path ? null : l.path)}
                data-mm-toggle
              >
                <span class="mm-ic" aria-hidden="true"><l.icon size={20} strokeWidth={1.9} /></span>
                <span class="mm-t">{l.label}</span>
                <span class="mm-chev" aria-hidden="true"><ChevronDown size={18} strokeWidth={1.9} /></span>
              </button>
              <ul class="mm-sub" id="{uid}-sub-{i}" hidden={deplie !== l.path}>
                {#each l.subs as s (s.id)}
                  <li>
                    <button type="button" class="mm-l mm-s" onclick={() => versSection(s)} data-mm-sec={s.id}>
                      <span class="mm-ic" aria-hidden="true"><s.icon size={16} strokeWidth={1.9} /></span>
                      <span class="mm-t">{s.label}</span>
                    </button>
                  </li>
                {/each}
                <li>
                  <a
                    class="mm-l mm-s"
                    href={href(l.path)}
                    aria-current={here(l.path)}
                    onclick={(e) => {
                      close();
                      followLink(e, l.path);
                    }}
                    data-mm-page
                  >
                    <span class="mm-ic" aria-hidden="true"><l.icon size={16} strokeWidth={1.9} /></span>
                    <span class="mm-t">{l.page ?? l.label}</span>
                  </a>
                </li>
              </ul>
            {:else}
              <a
                class="mm-l"
                href={href(l.path)}
                aria-current={here(l.path)}
                onclick={(e) => {
                  close();
                  followLink(e, l.path);
                }}
              >
                <span class="mm-ic" aria-hidden="true"><l.icon size={20} strokeWidth={1.9} /></span>
                <span class="mm-t">{l.label}</span>
                <ChevronRight size={18} strokeWidth={1.9} aria-hidden="true" />
              </a>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
    {#if __COMPTES__}
      <!-- Compte : seulement si le compte est construit (__COMPTES__). -->
      <div class="mm-acct" style:--i={links.length}>
        <p class="mm-h">{t("nav.menu.account")}</p>
        {#if accountFlag.connected}
          <ul class="mm-list">
            {#each account as l (l.label)}
              <li>
                <a
                  class="mm-l"
                  href={href(l.path)}
                  aria-current={here(l.path)}
                  onclick={(e) => {
                    close();
                    followLink(e, l.path);
                  }}
                >
                  <span class="mm-ic" aria-hidden="true"><l.icon size={20} strokeWidth={1.9} /></span>
                  <span class="mm-t">{l.label}</span>
                  <ChevronRight size={18} strokeWidth={1.9} aria-hidden="true" />
                </a>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="mm-auth">
            <a
              class="mm-in"
              href={href("/compte/connexion")}
              onclick={(e) => {
                close();
                followLink(e, "/compte/connexion");
              }}>{t("account.login.title")}</a
            >
            <a
              class="mm-up"
              href={href("/compte/inscription")}
              onclick={(e) => {
                close();
                followLink(e, "/compte/inscription");
              }}>{t("nav.menu.signup")}</a
            >
          </div>
        {/if}
      </div>
    {/if}
  </nav>
</div>

<style>
  .mm {
    display: none;
  }
  @media (max-width: 767px) {
    .mm {
      display: block;
      margin-inline-start: auto;
    }
  }
  .mm-b {
    display: inline-grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-inline-end: -10px;
    border: 0;
    border-radius: var(--r-md);
    background: transparent;
    color: var(--text);
    cursor: pointer;
  }
  /* ☰ → ✕ : le trait du milieu s'efface, les deux autres pivotent vers le centre ; un léger
     rebond à l'arrivée. Mouvement réduit : la croix apparaît sans transition. */
  .burger {
    position: relative;
    display: block;
    width: 22px;
    height: 16px;
  }
  .burger span {
    position: absolute;
    left: 0;
    top: calc(50% - 1px);
    width: 100%;
    height: 2px;
    border-radius: 2px;
    background: currentColor;
    transition:
      transform 360ms cubic-bezier(0.34, 1.56, 0.64, 1),
      opacity 200ms var(--ease-out),
      width 260ms var(--ease-out);
  }
  .burger span:nth-child(1) {
    transform: translateY(-7px);
  }
  .burger span:nth-child(2) {
    width: 70%;
    left: auto;
    right: 0;
  }
  .burger span:nth-child(3) {
    transform: translateY(7px);
  }
  .mm-b[aria-expanded="true"] .burger span:nth-child(1) {
    transform: translateY(0) rotate(45deg);
  }
  .mm-b[aria-expanded="true"] .burger span:nth-child(2) {
    opacity: 0;
    width: 0;
  }
  .mm-b[aria-expanded="true"] .burger span:nth-child(3) {
    transform: translateY(0) rotate(-45deg);
  }
  .mm-b[aria-expanded="true"] {
    color: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .burger span {
      transition: none;
    }
  }
  @media (forced-colors: active) {
    .burger span {
      background: ButtonText;
    }
  }
  .mm-b[aria-disabled="true"] {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .mm-b:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Panneau sous l'en-tête, pleine largeur, fond plein : rien ne transparaît dessous. Ouverture
      : le panneau glisse et s'éclaire, les entrées arrivent l'une après l'autre. */
  .mm-p {
    position: absolute;
    inset-inline: 0;
    inset-block-start: 100%;
    max-height: calc(100dvh - 72px);
    overflow-y: auto;
    padding: var(--sp-3) max(var(--sp-4), env(safe-area-inset-left)) calc(var(--sp-5) + env(safe-area-inset-bottom, 0px));
    background:
      radial-gradient(120% 60% at 100% 0%, rgb(95 227 181 / 0.08), transparent 60%),
      linear-gradient(180deg, var(--surface-1), var(--bg));
    border-block-end: 1px solid var(--line-strong);
    border-radius: 0 0 var(--r-xl) var(--r-xl);
    box-shadow: 0 28px 60px rgb(0 0 0 / 0.55);
  }
  .mm-p[hidden] {
    display: none;
  }
  .mm-scrim {
    position: absolute;
    inset-inline: 0;
    inset-block-start: 100%;
    height: 100dvh;
    background: rgb(4 6 10 / 0.62);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }
  @media (prefers-reduced-motion: no-preference) {
    .mm-scrim {
      animation: mm-fade 220ms var(--ease-out) both;
    }
  }
  @keyframes mm-fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .mm-p:not([hidden]) {
      animation: mm-in 260ms var(--ease-out) both;
    }
    .mm-p:not([hidden]) :is(.mm-list > li, .mm-acct) {
      animation: mm-item 320ms var(--ease-out) both;
      animation-delay: calc(40ms + var(--i, 0) * 35ms);
    }
  }
  @keyframes mm-in {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
  }
  @keyframes mm-item {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .mm-list {
    display: grid;
    gap: 2px;
  }
  .mm-l {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    min-height: 52px;
    padding: 0 var(--sp-2);
    border: 0;
    border-radius: var(--r-md);
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--fs-body);
    font-weight: 560;
    text-align: start;
    text-decoration: none;
    cursor: pointer;
  }
  .mm-l:active {
    background: rgb(255 255 255 / 0.05);
  }
  .mm-l :global(svg:last-child) {
    color: var(--text-3);
  }
  .mm-ic {
    display: grid;
    place-items: center;
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 11px;
    background: rgb(255 255 255 / 0.05);
    box-shadow: inset 0 0 0 1px var(--hair);
    color: var(--mint);
  }
  .mm-t {
    flex: 1 1 auto;
    min-width: 0;
  }
  .mm-l[aria-current="page"] {
    background: rgb(95 227 181 / 0.08);
    color: var(--accent);
  }
  .mm-l.soon {
    color: var(--text-2);
    cursor: default;
  }
  .mm-l.soon .mm-ic {
    color: var(--text-3);
  }
  .mm-soon {
    padding: 2px 8px;
    border-radius: var(--r-pill);
    background: rgb(95 227 181 / 0.12);
    color: var(--mint);
    font-size: var(--fs-micro);
    font-weight: 600;
  }
  /* Sections de l'accueil sous « Sécurité » : en retrait, plus petites. */
  .mm-sub:not([hidden]) {
    display: grid;
    gap: 2px;
    padding-inline-start: 26px;
  }
  /* Chevron de l'accordéon : tourne quand la liste est dépliée. */
  .mm-chev {
    display: grid;
    color: var(--text-3);
    transition: transform var(--dur-base) var(--ease-out);
  }
  [aria-expanded="true"] .mm-chev {
    transform: rotate(180deg);
  }
  [aria-expanded="true"] .mm-chev :global(svg) {
    color: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .mm-chev {
      transition: none;
    }
  }
  .mm-s {
    min-height: 44px;
    color: var(--text-2);
    font-size: var(--fs-small);
  }
  .mm-s .mm-ic {
    width: 28px;
    height: 28px;
    border-radius: 9px;
  }
  .mm-acct {
    margin-block-start: var(--sp-3);
    padding-block-start: var(--sp-3);
    border-block-start: 1px solid var(--hair);
  }
  .mm-h {
    margin: 0 0 var(--sp-2);
    padding-inline: var(--sp-2);
    /* Casse de phrase (audit du 25 novembre : plus de capitales espacées). */
    color: var(--text-3);
    font-size: var(--fs-small);
    font-weight: 600;
  }
  .mm-auth {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-2);
  }
  .mm-in,
  .mm-up {
    display: grid;
    place-items: center;
    min-height: 48px;
    padding-inline: var(--sp-2);
    border-radius: var(--r-pill);
    font-weight: 600;
    text-align: center;
    text-decoration: none;
  }
  .mm-in {
    background: var(--text);
    color: var(--bg);
  }
  .mm-up {
    box-shadow: inset 0 0 0 1px var(--line-strong);
    color: var(--text);
  }
  :is(.mm-l, .mm-in, .mm-up):focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (forced-colors: active) {
    .mm-p,
    .mm-in,
    .mm-up {
      border: 1px solid CanvasText;
    }
  }
</style>

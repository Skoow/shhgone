<script lang="ts">
  // Barre du haut, ordinateur et tablette : menus « Partager » et
  // « Sécurité » en motif disclosure (bouton aria-expanded qui montre une liste de liens ou de
  // boutons, pas un role="menu"), « Salon » bientôt, « Offres » ; à droite « Mes partages »
  // (D42-30) puis le compte : « Se connecter », ou, connecté, « Mon compte » et « Se déconnecter »
  // à la place de « Se connecter » (confirmation Oui / Non ; décision du propriétaire, 26 novembre). Clavier : Entrée et Espace ouvrent, flèches haut et bas parcourent, Échap ferme
  // et rend le focus au bouton, Tab hors du menu le ferme ; un clic ailleurs le ferme aussi.
  // Souris (pointeur fin qui survole) : le survol ouvre après un court délai d'intention et
  // referme après un délai de grâce (pour glisser du bouton au panneau) ; d'un menu ouvert à
  // l'autre, la bascule est immédiate. Un clic sur un menu ouvert au survol le garde ouvert.
  // Le survol ne déplace jamais le focus. Tactile : clic ou toucher seulement.
  // Téléphone (< 768 px) : rien de tout ça, la barre d'onglets du bas tient la navigation.
  import { flushSync, type Component } from "svelte";
  import { chrome, goToSend, type AddGesture } from "../app/chrome.svelte";
  import { currentPath, followLink, href, router } from "../app/router.svelte";
  import { formatBytes } from "../i18n/format";
  import { getLang, t } from "../i18n/i18n.svelte";
  import { CONTENT_MAX } from "../limits";
  import { announce } from "./announce";
  import AddIcon from "./AddIcon.svelte";
  import { ChevronDown, Compass, EyeOff, Flag, LogOut, Server, ShieldCheck, Upload } from "./Icon";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { allerSection } from "./section";
  import { accountFlag } from "../app/account-flag.svelte";

  let { busy = false }: { busy?: boolean } = $props();

  let confirmerSortie = $state(false);
  async function deconnecter() {
    await accountFlag.logout?.();
    announce(t("account.logout.done"));
  }

  type MenuId = "share" | "security";
  let open = $state<MenuId | null>(null);
  /** Ouvert au survol (se referme quand la souris s'en va) ou au clic et au clavier (reste). */
  let byHover = false;
  let wrap: HTMLElement | undefined = $state();
  const uid = $props.id();

  const off = $derived(busy ? { "aria-disabled": "true" as const, "aria-describedby": "foot-busy" } : {});
  // Relue à chaque changement de route (router.current) : l'adresse seule n'est pas réactive.
  const here = (p: string) => (void router.current, currentPath() === href(p) ? "page" : undefined);

  function items(id: MenuId): HTMLElement[] {
    return [...(document.getElementById(`${uid}-${id}`)?.querySelectorAll<HTMLElement>("[data-nav-item]") ?? [])];
  }
  function button(id: MenuId): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(`[aria-controls="${uid}-${id}"]`);
  }
  function toggle(id: MenuId) {
    stopTimers();
    if (busy) return;
    // Ouvert au survol : le clic le garde ouvert (il ne se refermera plus en partant).
    if (open === id && byHover) byHover = false;
    else {
      open = open === id ? null : id;
      byHover = false;
    }
  }
  function openAt(id: MenuId, which: "first" | "last") {
    stopTimers();
    if (busy) return;
    byHover = false;
    flushSync(() => (open = id));
    const list = items(id);
    (which === "first" ? list[0] : list[list.length - 1])?.focus();
  }
  function close(focusBack = false) {
    stopTimers();
    const was = open;
    open = null;
    if (focusBack && was) button(was)?.focus();
  }
  function onButtonKey(e: KeyboardEvent, id: MenuId) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openAt(id, "first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(id, "last");
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    }
  }
  function onPanelKey(e: KeyboardEvent, id: MenuId) {
    const list = items(id);
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (k: number) => {
      e.preventDefault();
      list[(k + list.length) % list.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
  }
  // Survol à la souris : délai d'intention à l'ouverture, délai de grâce à la fermeture.
  const HOVER_OPEN_MS = 100;
  const HOVER_CLOSE_MS = 250;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  function stopTimers() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = undefined;
  }
  /** Souris sur un appareil qui survole vraiment ; le tactile et le stylet n'ouvrent qu'au toucher. */
  function hovers(e: PointerEvent): boolean {
    return e.pointerType === "mouse" && !busy && (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? false);
  }
  /** Focus dans le panneau ouvert (navigation au clavier en cours) : le survol n'y touche pas. */
  function focusIn(id: MenuId): boolean {
    return !!document.getElementById(`${uid}-${id}`)?.contains(document.activeElement);
  }
  function onEnter(e: PointerEvent, id: MenuId) {
    if (!hovers(e)) return;
    stopTimers();
    if (open === id) return;
    if (open && focusIn(open)) return;
    const show = () => {
      open = id;
      byHover = true;
    };
    if (open) show();
    else openTimer = setTimeout(show, HOVER_OPEN_MS);
  }
  function onLeave(e: PointerEvent, id: MenuId) {
    if (e.pointerType !== "mouse") return;
    clearTimeout(openTimer);
    openTimer = undefined;
    if (open !== id || !byHover) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (open === id && byHover && !focusIn(id)) open = null;
    }, HOVER_CLOSE_MS);
  }
  $effect(() => stopTimers);
  // Survol : complément de la souris, le bouton reste l'élément interactif (clic, clavier).
  const hoverOf = (id: MenuId) => (node: HTMLElement) => {
    const enter = (e: PointerEvent) => onEnter(e, id);
    const leave = (e: PointerEvent) => onLeave(e, id);
    node.addEventListener("pointerenter", enter);
    node.addEventListener("pointerleave", leave);
    return () => {
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
    };
  };
  const keysOf = (id: MenuId) => (node: HTMLElement) => {
    const h = (e: KeyboardEvent) => onPanelKey(e, id);
    node.addEventListener("keydown", h);
    return () => node.removeEventListener("keydown", h);
  };
  function onFocusOut(e: FocusEvent, id: MenuId) {
    const next = e.relatedTarget as Node | null;
    const box = document.getElementById(`${uid}-${id}`)?.parentElement;
    if (open === id && (!next || !box?.contains(next))) close();
  }
  // Clic ailleurs : ferme, sans voler le focus. Échap ferme aussi un menu ouvert au survol
  // quand le focus est ailleurs (dans la barre, les touches du bouton et du panneau s'en chargent).
  $effect(() => {
    if (!open) return;
    const down = (e: Event) => {
      if (!wrap?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !wrap?.contains(document.activeElement)) close();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", esc);
    };
  });
  // Changement d'écran : menus fermés.
  $effect(() => {
    void router.current;
    stopTimers();
    open = null;
  });

  /** Geste du composeur : direct s'il est monté (accueil, page d'envoi), sinon par la page d'envoi. */
  function share(g: AddGesture) {
    close();
    if (chrome.add) chrome.add(g);
    else {
      goToSend(g);
    }
  }
  /** Section de l'accueil (ui/section.ts). */
  function section(id: string, faq = false) {
    close();
    return allerSection(id, faq);
  }

  type Item = { id: string; icon: Component<{ size?: number; strokeWidth?: number }> | null; add?: "media" | "voice" | "note"; tint: string; title: string; desc: string; run?: () => void; path?: string };
  const shareItems = $derived<Item[]>([
    { id: "fichiers", icon: Upload, tint: "mint", title: t("nav.share.fichiers.t"), desc: t("nav.share.fichiers.d", { size: formatBytes(CONTENT_MAX, getLang()) }), run: () => share("fichiers") },
    { id: "texte", icon: null, add: "note", tint: "blue", title: t("nav.share.texte.t"), desc: t("nav.share.texte.d"), run: () => share("texte") },
    { id: "vocal", icon: null, add: "voice", tint: "cyan", title: t("nav.share.vocal.t"), desc: t("nav.share.vocal.d"), run: () => share("vocal") },
    { id: "media", icon: null, add: "media", tint: "amber", title: t("nav.share.media.t"), desc: t("nav.share.media.d"), run: () => share("media") },
  ]);
  const secItems = $derived<Item[]>([
    { id: "how", icon: Compass, tint: "mint", title: t("nav.sec.how.t"), desc: t("nav.sec.how.d"), run: () => void section("comment") },
    { id: "server", icon: Server, tint: "blue", title: t("nav.sec.server.t"), desc: t("nav.sec.server.d"), run: () => void section("serveur") },
    { id: "page", icon: ShieldCheck, tint: "cyan", title: t("nav.sec.page.t"), desc: t("nav.sec.page.d"), path: "/securite" },
    { id: "privacy", icon: EyeOff, tint: "blue", title: t("nav.sec.privacy.t"), desc: t("nav.sec.privacy.d"), path: "/confidentialite" },
    { id: "report", icon: Flag, tint: "amber", title: t("nav.sec.report.t"), desc: t("nav.sec.report.d"), path: "/signaler" },
  ]);
</script>

{#snippet entry(it: Item)}
  <span class="it-ic {it.tint}" aria-hidden="true">
    {#if it.icon}<it.icon size={18} strokeWidth={1.9} />{:else if it.add}<AddIcon id={it.add} size={18} />{/if}
  </span>
  <span class="it-tx"><span class="it-t">{it.title}</span><span class="it-d">{it.desc}</span></span>
{/snippet}

{#snippet menu(id: MenuId, label: string, list: Item[])}
  <div class="dd" onfocusout={(e) => onFocusOut(e, id)} {@attach hoverOf(id)}>
    <button
      type="button"
      class={["nl", "dd-b", { on: open === id }]}
      aria-expanded={open === id}
      aria-controls="{uid}-{id}"
      onclick={() => toggle(id)}
      onkeydown={(e) => onButtonKey(e, id)}
      {...off}
    >
      {label}<ChevronDown size={15} strokeWidth={2} aria-hidden="true" />
    </button>
    <div class={["panel", id]} id="{uid}-{id}" hidden={open !== id}>
      <!-- Flèches, Début, Fin, Échap : délégués à la liste (les entrées sont des liens et des boutons). -->
      <ul {@attach keysOf(id)}>
        {#each list as it (it.id)}
          <li>
            {#if it.path}
              <a class="it" href={href(it.path)} aria-current={here(it.path)} data-nav-item {...off} onclick={(e) => {
                  close();
                  followLink(e, it.path!);
                }}>{@render entry(it)}</a
              >
            {:else}
              <button type="button" class="it" data-nav-item onclick={it.run}>{@render entry(it)}</button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/snippet}

<nav class="topnav" aria-label={t("nav.label")} bind:this={wrap}>
  <ul class="main">
    <li>{@render menu("share", t("nav.share"), shareItems)}</li>
    <li>
      {#if __SALONS__}
        <!-- Salon : création, compte exigé (la page mène à la connexion sans session). -->
        <a class="nl room" href={href("/salon/nouveau")} aria-current={here("/salon/nouveau")} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/salon/nouveau"))} {...off}>{t("nav.room")}</a>
      {:else}
        <button type="button" class="nl room" aria-disabled="true" aria-describedby="{uid}-room" onclick={() => announce(t("tabs.soon.chat"))}>
          {t("nav.room")}<span class="soon">{t("foot.soon")}</span>
        </button>
        <span id="{uid}-room" class="sr-only">{t("tabs.soon.chat")}</span>
      {/if}
    </li>
    <li>{@render menu("security", t("nav.security"), secItems)}</li>
    <li>
      <a class="nl" href={href("/offres")} aria-current={here("/offres")} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/offres"))} {...off}>{t("nav.offers")}</a>
    </li>
  </ul>
  <div class="acts">
    <a class="btn ghost" href={href("/envois")} aria-current={here("/envois")} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/envois"))} {...off} data-nav-shares>{t("nav.shares")}</a>
    {#if __SALONS__}
      <!-- « Mes salons » (28 novembre) : les salons créés, à côté de « Mes partages ». -->
      <a class="btn ghost" href={href("/salons")} aria-current={here("/salons")} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/salons"))} {...off} data-nav-rooms>{t("nav.rooms")}</a>
    {/if}
    {#if __COMPTES__}
      <!-- Compte : « Se connecter », ou « Mon compte » et « Se déconnecter » une fois connecté. -->
      {#if accountFlag.connected}
        <a class="btn ghost" href={href("/compte")} aria-current={here("/compte")} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/compte"))} {...off}>{t("nav.menu.myAccount")}</a>
        {#if accountFlag.logout}
          <button type="button" class="btn ghost out" aria-haspopup="dialog" onclick={() => (busy ? undefined : (confirmerSortie = true))} {...off} data-nav-logout>
            <LogOut size={18} strokeWidth={1.8} aria-hidden="true" />{t("account.logout")}
          </button>
        {/if}
      {:else}
        <a class="btn ghost" href={href("/compte/connexion")} aria-current={here("/compte/connexion")} onclick={(e) => (busy ? e.preventDefault() : followLink(e, "/compte/connexion"))} {...off}>{t("account.login.title")}</a>
      {/if}
    {:else}
      <!-- Compte pas encore ouvert (décision D8) : « Se connecter » visible, bientôt, comme le Salon
            ; un clic l'annonce, rien ne s'ouvre. -->
      <button type="button" class="btn ghost login-soon" aria-disabled="true" aria-describedby="{uid}-login" data-login-soon onclick={() => announce(t("nav.login.soon"))}>
        {t("account.login.title")}<span class="soon">{t("foot.soon")}</span>
      </button>
      <span id="{uid}-login" class="sr-only">{t("nav.login.soon")}</span>
    {/if}
    <!-- Plus de bouton « Partager » : le lien se partage
         depuis « Lien prêt », où il est créé ; la page d'envoi reste dans « Envoyer ». -->
  </div>
</nav>
{#if __COMPTES__}
  <ConfirmDialog bind:open={confirmerSortie} title={t("account.logout.confirm.title")} message={t("account.logout.confirm")} yesLabel={t("account.logout")} noLabel={t("common.cancel")} onyes={deconnecter} />
{/if}

<style>
  .topnav {
    display: none;
  }
  @media (min-width: 768px) {
    .topnav {
      display: flex;
      flex: 1 1 auto;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-4);
      min-width: 0;
      margin-inline-start: var(--sp-5);
    }
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Liens principaux : une capsule discrète qui les tient ensemble ; écritures blanches. */
  .main {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border-radius: var(--r-pill);
    background: rgb(255 255 255 / 0.025);
    box-shadow: inset 0 0 0 1px rgb(150 175 255 / 0.12);
  }
  .main > li {
    position: relative;
  }
  .nl {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--r-pill);
    background: transparent;
    color: #fff;
    font: inherit;
    font-size: 0.9375rem;
    font-weight: 560;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out);
  }
  .nl:hover,
  .nl.on {
    background: rgb(255 255 255 / 0.08);
  }
  /* Page en cours : fond menthe très léger et un trait menthe sous le mot. */
  .nl[aria-current="page"] {
    background: rgb(95 227 181 / 0.1);
  }
  .nl[aria-current="page"]::after {
    content: "";
    position: absolute;
    inset-inline: 14px;
    inset-block-end: 4px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .dd-b :global(svg) {
    color: rgb(255 255 255 / 0.7);
    transition: transform var(--dur-base) var(--ease-out);
  }
  .dd-b.on :global(svg) {
    transform: rotate(180deg);
    color: var(--accent);
  }
  /* Salon « bientôt » (sans __SALONS__) : un bouton qui l'annonce. Avec __SALONS__, l'entrée est
     un lien ordinaire : même couleur et même curseur que les autres (plus de « interdit »). */
  button.room[aria-disabled="true"] {
    color: var(--text-2);
  }
  .login-soon {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: not-allowed;
  }
  /* Le clic annonce « bientôt » (les autres boutons désactivés ne réagissent pas). */
  .btn.login-soon[aria-disabled="true"] {
    pointer-events: auto;
    color: var(--text-2);
  }
  .soon {
    padding: 1px 7px;
    border-radius: var(--r-pill);
    background: rgb(95 227 181 / 0.1);
    box-shadow: inset 0 0 0 1px rgb(95 227 181 / 0.28);
    color: var(--accent);
    font-size: 0.6875rem;
    font-weight: 600;
  }
  .nl:focus-visible,
  .btn:focus-visible,
  .it:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  [aria-disabled="true"] {
    cursor: not-allowed;
  }
  a[aria-disabled="true"] {
    color: var(--text-disabled);
  }

  /* Panneau : verre sombre, entrées à tuile teintée. */
  .panel {
    position: absolute;
    inset-block-start: calc(100% + 10px);
    inset-inline-start: -8px;
    z-index: 30;
    width: 360px;
    padding: 8px;
    border-radius: 18px;
    background: #0c1222;
    box-shadow:
      inset 0 0 0 1px rgb(150 175 255 / 0.16),
      inset 0 1px 0 rgb(255 255 255 / 0.06),
      0 24px 48px -24px rgb(0 0 0 / 0.7);
    transform-origin: 24px 0;
  }
  .panel:not([hidden]) {
    animation: drop 220ms var(--ease-out) both;
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.98);
    }
  }
  .panel ul {
    display: grid;
    gap: 2px;
  }
  .it {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: start;
    text-decoration: none;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-out);
  }
  .it:hover,
  .it:focus-visible {
    background: rgb(255 255 255 / 0.05);
  }
  .it-ic {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    transition: transform 360ms var(--ease-settle);
  }
  .it:hover .it-ic {
    transform: translateY(-1px) scale(1.05);
  }
  .it-tx {
    display: grid;
    gap: 1px;
    min-width: 0;
  }
  .it-t {
    font-size: 0.9375rem;
    font-weight: 620;
  }
  .it-d {
    color: var(--text-2);
    font-size: 0.8125rem;
    line-height: 1.35;
  }
  .mint {
    background: rgb(95 227 181 / 0.12);
    color: var(--accent);
  }
  .blue {
    background: rgb(92 128 255 / 0.16);
    color: #9db4ff;
  }
  .cyan {
    background: rgb(62 193 245 / 0.13);
    color: #7fd6f8;
  }
  .amber {
    background: rgb(245 185 64 / 0.13);
    color: #f5c96b;
  }

  .acts {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .btn {
    display: inline-flex;
    align-items: center;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 12px;
    font-size: 0.9375rem;
    font-weight: 620;
    text-decoration: none;
    white-space: nowrap;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      transform var(--dur-press) var(--ease-out);
  }
  .btn.ghost {
    border: 1px solid rgb(150 175 255 / 0.26);
    color: #fff;
  }
  .btn.out {
    gap: 6px;
    background: none;
    font-family: inherit;
    cursor: pointer;
  }
  .btn.ghost:hover {
    border-color: rgb(150 175 255 / 0.5);
    background: rgb(255 255 255 / 0.04);
  }
  .btn.solid {
    background: var(--sig-blue);
    color: #fff;
    box-shadow:
      inset 0 1px 0 rgb(255 255 255 / 0.2),
      0 8px 24px -10px rgb(51 102 255 / 0.8);
  }
  .btn.solid:hover {
    background: var(--sig-blue-hover);
  }
  .btn:active {
    transform: scale(0.97);
  }
  .btn[aria-disabled="true"] {
    background: transparent;
    border: 1px solid var(--hair-2);
    box-shadow: none;
    pointer-events: none;
  }
  /* Tablette : tout tient sur une ligne ; la pastille « bientôt » devient un point (la raison
     reste lue, aria-describedby). */
  @media (max-width: 1023px) {
    .nl {
      padding: 0 8px;
      font-size: 0.875rem;
    }
    .btn {
      padding: 0 12px;
      font-size: 0.875rem;
    }
    .soon {
      width: 7px;
      height: 7px;
      padding: 0;
      overflow: hidden;
      color: transparent;
      background: var(--accent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .panel:not([hidden]) {
      animation: none;
    }
    .nl,
    .it,
    .it-ic,
    .btn,
    .dd-b :global(svg) {
      transition: none;
    }
  }
  @media (forced-colors: active) {
    .panel {
      border: 1px solid CanvasText;
    }
    .btn {
      border: 1px solid ButtonText;
    }
  }
</style>

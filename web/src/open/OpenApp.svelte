<script lang="ts">
  // Page « /s » : ouverture et gestion d'un partage,
  // reprises telles quelles de l'application (App.svelte) : le lien est lu par l'écran au moment
  // où il se monte, puis le « # » est retiré de l'adresse et de l'historique (UI §12.1, spec §32).
  import { getDemo } from "../app/demo-hooks";
  import { inAppBrowser, isStandalone, isSupported } from "../app/env";
  import { guardFileDrop, reloadIfRestored } from "../app/lifecycle";
  import { readLink, readShare, scrubAddressBar, type LinkState, type ShareTake } from "../app/link";
  import { href, router, shownPath } from "../app/router.svelte";
  import { applySeo } from "../app/seo";
  import { setScreenTitle } from "../app/title";
  import { watchKeyboard } from "../app/viewport";
  import { getLang } from "../i18n/i18n.svelte";
  import Manage from "../routes/Manage.svelte";
  import Open from "../routes/Open.svelte";
  import Unsupported from "../routes/Unsupported.svelte";
  import { watchOpenGrant } from "../session/open-grant";
  import { loadDownloads } from "../downloads/live.svelte";
  import AppShell from "../ui/AppShell.svelte";

  const supported = isSupported(globalThis);
  const demo = getDemo();

  reloadIfRestored(window);
  // « Téléchargements » sans compte seulement si l'historique est activé : lecture seule.
  if (supported) void loadDownloads().catch(() => undefined);
  // Page d'un partage : la clé est déjà retirée de l'adresse, une actualisation par le geste
  // « tirer vers le bas » perdrait l'écran verrouillé (base.css : no-pull).
  if (typeof document !== "undefined") document.documentElement.classList.add("no-pull");

  const inApp = () => inAppBrowser(navigator.userAgent, isStandalone(window)) !== null;
  function scrubHere(): void {
    // « /s » n'est plus montré une fois le lien lu : l'adresse devient « / ».
    if (!scrubAddressBar(history, shownPath(location.pathname))) scrubAddressBar(history, href("/"));
  }
  const takeShare = (): ShareTake => readShare(location.href);
  function takeManage(): LinkState {
    const l = readLink(location.href, "m");
    if (!inApp()) scrubHere();
    return l;
  }
  // Un nouveau lien collé sur la même page (navigation de fragment) remonte l'écran.
  let linkGen = $state(0);
  let lastRoute = router.current;
  $effect(() => {
    lastRoute = router.current;
  });
  function onHashChange() {
    if (!supported || location.hash === "") return;
    const same = router.current === lastRoute;
    lastRoute = router.current;
    if (same) linkGen++;
  }

  // Ici, un fichier déposé ne fait jamais naviguer l'onglet (UI §9.2.2).
  $effect(() => guardFileDrop(window, () => false));
  $effect(() => {
    void getLang();
    const name = router.current.name;
    setScreenTitle(supported ? name : "unsupported");
    applySeo(supported ? name : "unsupported");
  });
  $effect(() => watchKeyboard(window, (open) => document.documentElement.classList.toggle("kbd-open", open)));
  // Entrée d'onglet (K_lien) effacée après 30 min sans activité.
  $effect(() => watchOpenGrant(window));
</script>

<svelte:window onhashchange={onHashChange} />

{#snippet demoBanner()}
  {#if demo}<demo.Banner />{/if}
{/snippet}

<AppShell banner={demo ? demoBanner : undefined}>
  {#if !supported}
    <Unsupported />
  {:else if router.current.name === "manage"}
    {#key linkGen}<Manage take={takeManage} />{/key}
  {:else}
    {#key linkGen}<Open take={takeShare} />{/key}
  {/if}
</AppShell>

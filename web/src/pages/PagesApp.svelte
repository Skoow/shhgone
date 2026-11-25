<script lang="ts">
  // Pages d'information servies par leur propre fichier HTML (pages séparées) : Sécurité, Confidentialité, Offres, Conditions, Mentions légales, Signaler.
  // Seulement la coque (en-tête, menu, pied) et la page : ni composeur, ni moteur de chiffrement,
  // ni compte, ni salon. Le même composant sert au rendu du build (contenu déjà écrit dans le
  // HTML, pour les moteurs de recherche et l'affichage avant le script) et au navigateur.
  import { getDemo } from "../app/demo-hooks";
  import { inAppBrowser, isStandalone } from "../app/env";
  import { scrubAddressBar } from "../app/link";
  import { href, router } from "../app/router.svelte";
  import { applySeo } from "../app/seo";
  import { setScreenTitle } from "../app/title";
  import { getLang } from "../i18n/i18n.svelte";
  import InfoPage from "../routes/InfoPage.svelte";
  import Offres from "../routes/Offres.svelte";
  import type { InfoName } from "../routes/pages/content";
  import AppShell from "../ui/AppShell.svelte";

  const demo = getDemo();
  const name = $derived(router.current.name);

  // Comme l'application (App.svelte, UI §12.1) : un « # » (la place des clés) n'est jamais gardé
  // dans l'adresse ni l'historique d'une page d'information ; retiré au chargement et s'il est
  // collé ensuite. Navigateur intégré (S4) : laissé, comme dans l'application.
  function scrub(): void {
    if (location.hash === "" || inAppBrowser(navigator.userAgent, isStandalone(window)) !== null) return;
    if (!scrubAddressBar(history, location.pathname)) scrubAddressBar(history, href("/"));
  }
  $effect(scrub);

  $effect(() => {
    void getLang();
    setScreenTitle(name);
    applySeo(name);
  });
</script>

<svelte:window onhashchange={scrub} />

{#snippet demoBanner()}
  {#if demo}<demo.Banner />{/if}
{/snippet}

<AppShell banner={demo ? demoBanner : undefined}>
  {#if name === "offres"}
    <Offres />
  {:else}
    <InfoPage name={name as InfoName} />
  {/if}
</AppShell>

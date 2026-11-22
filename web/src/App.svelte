<script lang="ts">
  import { untrack } from "svelte";
  import { getDemo } from "./app/demo-hooks";
  import { inAppBrowser, isStandalone, isSupported } from "./app/env";
  import { guardFileDrop, reloadIfRestored } from "./app/lifecycle";
  import { scrubAddressBar } from "./app/link";
  import { href, LINK_ROUTES, moveToLinkPage, navigate, PAGE_ROUTES, router } from "./app/router.svelte";
  import { accountFlag } from "./app/account-flag.svelte";
  import { applySeo } from "./app/seo";
  import { setScreenTitle } from "./app/title";
  import { getLang } from "./i18n/i18n.svelte";
  import { watchKeyboard } from "./app/viewport";
  import { watchOpenGrant } from "./session/open-grant";
  import { loadHistory } from "./history/live.svelte";
  import { loadDownloads } from "./downloads/live.svelte";
  import Downloads from "./routes/Downloads.svelte";
  import History from "./routes/History.svelte";
  import NotFound from "./routes/NotFound.svelte";
  import SendFlow from "./routes/SendFlow.svelte";
  import Unsupported from "./routes/Unsupported.svelte";
  import PageRedirect from "./pages/PageRedirect.svelte";
  import AppShell from "./ui/AppShell.svelte";
  import { chrome, takeGestureFromUrl } from "./app/chrome.svelte";
  import { tabBarVisible } from "./app/tabbar";
  // Pages du compte (plan du compte, lot 10) : seulement si __COMPTES__ (drapeau de construction,
  // faux par défaut et dans la démo). Sans lui, match() ne rend jamais ces routes et le greffon
  // shh-comptes remplace ce module par pages.off.ts : rien du compte dans le site (check-dist.mjs).
  import { Accueil, Connexion, Inscription, Parametres, Recuperation, Profil, connecte, ecouterAutresOnglets, restaurer, seDeconnecter, supprime, verifierAuRetour } from "./routes/compte/pages";
  // Écrans du salon (plan C-3) : seulement si __SALONS__ (site avec compte, hors démo) ; sans lui,
  // le greffon shh-salons remplace ce module par pages.off.ts (aucun écran, aucun client).
  import { Salon, SalonNouveau } from "./routes/salon/pages";

  // UI §9 : vérifié une fois, avant toute route. Sans ces capacités, aucune route ne démarre
  // (ni lecture du lien, ni requête).
  const supported = isSupported(globalThis);

  // Démo GitHub Pages seulement (UI §14.3) : bandeau permanent ; null en production.
  const demo = getDemo();
  // Geste choisi sur une page d'information (« /envoyer?ajout=texte ») : rejoué par le composeur.
  takeGestureFromUrl();

  // Task 17 : vrai pendant un envoi et sur « Lien prêt » (langue figée, dépôt de fichier ignoré).
  let sending = $state(false);

  // Téléphone : barre d'onglets sur les écrans racine de l'expéditeur seulement (app/tabbar.ts).
  // Accueil connecté (plan du compte, lot 12) : seulement avec __COMPTES__ et une session ouverte ;
  // sans compte (et dans tout build public), l'accueil reste l'accueil actuel.
  const connected = $derived(__COMPTES__ && connecte());
  const tabs = $derived(tabBarVisible({ supported, route: router.current.name, sending, composing: chrome.composing, connected }));

  // « Tirer pour actualiser » (téléphone) bloqué seulement quand il ferait perdre la liste en
  // cours ou un envoi (décision du propriétaire du 17 novembre, base.css : no-pull).
  $effect(() => {
    document.documentElement.classList.toggle("no-pull", chrome.composing || sending);
    return () => document.documentElement.classList.remove("no-pull");
  });

  // « Mes partages » dans l'en-tête et le menu seulement s'il y a des partages (17 novembre) :
  // lecture de l'historique de l'appareil, sans rien créer (live.svelte.ts, presence).
  if (supported) void loadHistory().catch(() => undefined);
  // « Téléchargements » sans compte seulement si l'historique est activé (22 novembre) : lecture
  // seule, rien n'est créé s'il n'a jamais été activé ici.
  if (supported) void loadDownloads().catch(() => undefined);

  // UI §12.2 : une page restaurée du cache « page précédente » est rechargée.
  reloadIfRestored(window);

  /**
   * UI §12.1, spec §32 : l'ouverture et la gestion ont leur page, « /s » (s.html, 16 novembre).
   * Une ouverture déverrouillée rechargée sous « / » y retourne (moveToLinkPage). Toute autre
   * route (accueil avec un « # », dont l'ancienne forme de lien refusée depuis le 18 novembre,
   * 404, hors base de démo) : un « # » non vide est retiré de l'adresse.
   */
  const inApp = () => inAppBrowser(navigator.userAgent, isStandalone(window)) !== null;
  function scrubHere(): void {
    // Chemin non nu (« //x », « \ ») : repli sur l'accueil plutôt que garder le « # ».
    if (!scrubAddressBar(history, location.pathname)) scrubAddressBar(history, href("/"));
  }

  function onRoute(): void {
    if (LINK_ROUTES.has(router.current.name)) {
      moveToLinkPage(location);
      return;
    }
    // Salon : la page lit elle-même le « #c… » (invitation) puis le retire de la barre.
    if (router.current.name === "salon") return;
    if (location.hash !== "" && !inApp()) scrubHere();
  }
  $effect(() => {
    void router.current;
    if (supported) untrack(onRoute);
  });
  // « # » collé dans la barre : un lien part vers « /s », tout autre « # » est retiré.
  function onHashChange() {
    if (supported && location.hash !== "") onRoute();
  }

  // UI §9.2.2 : hors de l'accueil, un fichier déposé ne fait jamais naviguer l'onglet. Sur
  // l'accueil, Home reçoit le dépôt (voile pleine page), sauf pendant un envoi.
  // Accueil connecté : pas de composeur, donc aucun dépôt reçu là (le fichier ne fait jamais naviguer).
  $effect(() => guardFileDrop(window, () => supported && ((router.current.name === "home" && !connected) || router.current.name === "envoyer") && !sending));

  // Titre de l'onglet par route et par langue (scan UX B9) ; l'accueil (SendFlow) tient le sien.
  $effect(() => {
    void getLang();
    const name = router.current.name;
    if (!supported) setScreenTitle("unsupported");
    else if (name === "home" && connected) setScreenTitle("inbox");
    else if (name !== "home" && name !== "envoyer") setScreenTitle(name);
    // Référencement : description, canonique et noindex par route (app/seo.ts).
    applySeo(supported ? name : "unsupported");
  });

  // UI §9 : clavier virtuel ouvert → classe kbd-open sur <html> (barres collées dans le flux).
  $effect(() => watchKeyboard(window, (open) => document.documentElement.classList.toggle("kbd-open", open)));
  // Entrée d'onglet (K_lien) effacée après 30 min sans activité, sur tous les écrans (audit web D2).
  $effect(() => watchOpenGrant(window));
  // « Rester connecté » (conception compte §9) : la session gardée sur cet appareil est rouverte
  // au démarrage ; échue ou fermée ailleurs, elle est oubliée. Seulement avec __COMPTES__.
  if (__COMPTES__ && supported) {
    restaurer().catch(() => undefined);
    // Audit du 18 novembre : déconnexion faite dans un autre onglet, session fermée ailleurs.
    ecouterAutresOnglets();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void verifierAuRetour();
    });
  }
  // « Se déconnecter » du menu (18 novembre) : la coque n'importe rien du compte ; elle appelle ceci.
  if (__COMPTES__)
    accountFlag.logout = async () => {
      await seDeconnecter();
      navigate("/compte/connexion");
    };
</script>

<svelte:window onhashchange={onHashChange} />

{#snippet demoBanner()}
  {#if demo}<demo.Banner />{/if}
{/snippet}

<!-- Pied de page sur toutes les pages (retours du 11 novembre) ; pendant un envoi, ses liens et
     réglages sont désactivés (busy). Ordinateur : le composeur tient dans l'écran, le pied dessous. -->
<AppShell banner={demo ? demoBanner : undefined} busy={sending} {tabs}>
  {#if !supported}
    <Unsupported />
  {:else if router.current.name === "notfound"}
    <NotFound />
  {:else if router.current.name === "home" && connected}
    <Accueil />
  {:else if router.current.name === "home" || router.current.name === "envoyer"}
    <!-- Accueil, puis composeur dès le premier élément (UI §9.1, §9.2) ; « /envoyer » : composeur
         même vide (retours DROP). Un seul SendFlow pour les deux : passer de l'un à l'autre garde
         la liste. -->
    <SendFlow sendPage={router.current.name === "envoyer"} onbusy={(b) => (sending = b)} />
  {:else if LINK_ROUTES.has(router.current.name)}
    <!-- Ouverture rechargée sous « / » : la page part vers « /s » (onRoute), rien n'est affiché ici. -->
  {:else if router.current.name === "envois"}
    <History />
  {:else if router.current.name === "telechargements"}
    <Downloads />
  {:else if router.current.name === "inscription"}
    <Inscription />
  {:else if router.current.name === "recuperation"}
    <Recuperation />
  {:else if router.current.name === "compte" && (connected || (__COMPTES__ && supprime()))}
    <!-- Paramètres et profil (lot 13) : avec une session ouverte seulement (et l'écran de fin
         d'une suppression faite ici, alors que la session n'existe plus). -->
    <Parametres />
  {:else if router.current.name === "profil" && connected}
    <Profil />
  {:else if (router.current.name === "connexion" || router.current.name === "compte" || router.current.name === "profil")}
    <!-- /compte et /compte/profil sans session : la connexion (conception §12.4) ; /compte/connexion
         avec session : la même page dit « connecté ». -->
    <Connexion />
  {:else if router.current.name === "salon"}
    <Salon />
  {:else if router.current.name === "salonnouveau"}
    <SalonNouveau />
  {:else if PAGE_ROUTES.has(router.current.name)}
    <!-- Pages d'information : leur propre fichier HTML (pages séparées, 16 novembre). Le serveur
         le sert déjà à cette adresse ; si ce script arrive quand même ici (ancien serveur), il
         recharge l'adresse pour obtenir ce fichier, une fois. -->
    <PageRedirect />
  {/if}
</AppShell>

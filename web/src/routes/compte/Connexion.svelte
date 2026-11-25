<script lang="ts">
  // Connexion (/compte/connexion, et /compte ou /compte/profil sans session ; conception du compte
  // par passkey §3.2, §3.3, §5.3, §5.5). Page montée seulement si __COMPTES__ (App.svelte).
  // « Se connecter avec une passkey » : la cérémonie est chargée à l'ouverture de la page, le clic
  // appelle navigator.credentials.get sans requête avant (Safari). La passkey connecte le compte ;
  // si elle n'ouvre pas les données sur cet appareil (pas de PRF, ou sortie PRF différente) et que
  // l'appareil n'en garde aucune clé, la clé de récupération est demandée UNE fois, avec la raison
  // (jamais de repli silencieux) ; l'enveloppe de la passkey est alors réparée.
  // Compte banni : la connexion reste permise (exporter, supprimer), avec la date, le motif et
  // l'identifiant B-… à donner pour un recours (§7.4).
  // Sur ordinateur (décision du 25 novembre, conception §18) : le téléphone d'abord (QR du
  // navigateur, parcours « hybride »), puis « Utiliser une passkey de cet ordinateur » (« local »).
  import { tick, untrack } from "svelte";
  import { account, annulerCle, cleRequise, estMobile, etatCompte, ouvrirAvecCle, passkeysDisponibles, preparerConnexion, seConnecter, seDeconnecter, type Parcours } from "../../account/session.svelte";
  import { followLink, href, navigate, suite } from "../../app/router.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import { KeyRound, User } from "../../ui/Icon";
  import TextField from "../../ui/TextField.svelte";
  import Cadre from "./Cadre.svelte";
  import Case from "./Case.svelte";
  import IndiceQr from "./IndiceQr.svelte";
  import NoteDemo from "./NoteDemo.svelte";
  import { annulee, erreur, jourLong } from "./erreurs";

  // Seul paramètre lu dans l'adresse : « ?suite=salon » (suite(), router.svelte.ts).
  const apres = suite(location.search);
  const dispo = passkeysDisponibles();
  const mobile = estMobile();

  let vue = $state<"form" | "cle" | "connecte">(account.etat === "ouvert" ? "connecte" : "form");
  let rester = $state(false);
  let cle = $state("");
  let errCle = $state("");
  let bandeau = $state<{ kind: "info" | "danger"; texte: string } | null>(null);
  let banni = $state<{ date: string; motif: number | null; id: string } | null>(null);
  let envoi = $state(false);
  let elCle: HTMLInputElement | undefined = $state();

  // Cérémonie chargée d'avance, rechargée avant son échéance (5 min au serveur).
  function preparer() {
    if (!dispo || account.etat === "ouvert") return;
    preparerConnexion().catch(() => undefined); // échec : rechargée au clic
  }
  $effect(() =>
    untrack(() => {
      preparer();
      const m = setInterval(preparer, 240_000);
      return () => {
        clearInterval(m);
        // Page quittée pendant que la clé de récupération est demandée : la session ouverte par la
        // passkey (qui n'ouvre pas les données ici) est fermée au serveur.
        if (cleRequise()) void annulerCle();
      };
    }),
  );

  // « Rester connecté » : la session gardée est rouverte au démarrage (App.svelte, restaurer()).
  $effect(() => {
    if (account.etat === "ouvert" && vue === "form" && !envoi) vue = "connecte";
  });

  const versInscription = apres === "salon" ? "/compte/inscription?suite=salon" : "/compte/inscription";
  const versCle = apres === "salon" ? "/compte/recuperation?suite=salon" : "/compte/recuperation";
  const MOTIFS = ["report.cat.1", "report.cat.2", "report.cat.3", "report.cat.4", "report.cat.5", "report.cat.6", "report.cat.7", "report.cat.8", "report.cat.9", "report.cat.10"] as const;

  async function ouvert() {
    cle = "";
    banni = null;
    try {
      const e = await etatCompte();
      if (e.banniJusqu) banni = { date: e.banniJusqu, motif: e.banniMotif, id: e.banniId ?? "" };
    } catch {
      // état indisponible (réseau) : la session est ouverte, rien d'autre à dire ici
    }
    vue = "connecte";
    announce(t("account.connected"));
  }

  // Le geste : aucune requête avant navigator.credentials.get.
  async function connecter(parcours: Parcours = mobile ? "defaut" : "hybride") {
    if (envoi) return;
    bandeau = null;
    envoi = true;
    try {
      const r = await seConnecter(rester, parcours);
      if (r === "cle_requise") {
        vue = "cle";
        announce(t("account.fallback.body"));
        await tick();
        elCle?.focus();
      } else await ouvert();
    } catch (e) {
      if (!annulee(e)) bandeau = { kind: "danger", texte: erreur(e, "connexion").texte };
      preparer();
    } finally {
      envoi = false;
    }
  }

  async function ouvrir() {
    errCle = "";
    bandeau = null;
    envoi = true;
    try {
      await ouvrirAvecCle(cle);
      await ouvert();
    } catch (e) {
      const x = erreur(e, "cle");
      if (x.champ === "cle") {
        errCle = x.texte;
        await tick();
        elCle?.focus();
      } else bandeau = { kind: "danger", texte: x.texte };
    } finally {
      envoi = false;
    }
  }

  async function annuler() {
    await annulerCle();
    cle = "";
    vue = "form";
    preparer();
  }

  async function deconnecter() {
    await seDeconnecter();
    banni = null;
    vue = "form";
    bandeau = { kind: "info", texte: t("account.loggedOut") };
    preparer();
  }
</script>

<Cadre forme="panneaux" titre={t("account.login.title")}>
  {#if bandeau}<Banner kind={bandeau.kind}>{bandeau.texte}</Banner>{/if}
  {#if account.erreur === "coffre_illisible" && bandeau?.texte !== t("account.err.coffre")}<Banner kind="danger">{t("account.err.coffre")}</Banner>{/if}

  {#if vue === "connecte"}
    <p class="note" data-connecte>{t("account.connected")}</p>
    {#if account.cleLocale}<p class="note" data-cle-locale>{t("account.localKey")}</p>{/if}
    {#if banni}
      <Banner kind="warn">{t("account.banned", { date: jourLong(banni.date), motif: t(MOTIFS[(banni.motif ?? 10) - 1] ?? "report.cat.10"), id: banni.id })}</Banner>
    {/if}
    <div class="actions">
      <Button onpress={() => navigate(apres === "salon" && __SALONS__ ? "/salon/nouveau" : "/")}>{t("account.continue")}</Button>
      <Button variant="secondary" onpress={deconnecter}>{t("account.logout")}</Button>
    </div>
  {:else if vue === "cle"}
    <p class="note" data-repli>{t("account.fallback.body")}</p>
    <form novalidate onsubmit={(e) => e.preventDefault()}>
      <TextField label={t("account.key.field")} hint={t("account.key.field.hint")} autocomplete="off" autocapitalize="characters" spellcheck="false" error={errCle || undefined} bind:value={cle} bind:el={elCle} oninput={() => (errCle = "")} />
      <Button type="submit" onpress={ouvrir}>{envoi ? t("account.verifying") : t("account.key.open")}</Button>
    </form>
    <div class="actions"><Button variant="ghost" onpress={annuler}>{t("common.cancel")}</Button></div>
  {:else if !dispo}
    <p class="note" data-sans-passkey>{t("account.nopasskey")}</p>
    <ul class="liens"><li><a href={href(versCle)} onclick={(e) => followLink(e, versCle)}>{t("account.login.key")}</a></li></ul>
  {:else}
    <!-- « Rester connecté » sous le bouton ; les deux autres chemins
         en boutons secondaires, après un séparateur « ou ». -->
    <form novalidate class="connexion" onsubmit={(e) => e.preventDefault()}>
      {#if !mobile}<IndiceQr texte={t("account.login.phone.how")} />{/if}
      <Button type="submit" onpress={() => connecter()}>{envoi ? t("account.verifying") : mobile ? t("account.login.passkey") : t("account.login.phone")}</Button>
      <NoteDemo />
      <Case label={t("account.stay")} bind:checked={rester} />
      {#if !mobile}<button type="button" class="discret" onclick={() => void connecter("local")} data-ici>{t("account.login.here")}</button>{/if}
    </form>
    <p class="ou" aria-hidden="true"><span>{t("account.login.or")}</span></p>
    <ul class="autres">
      <li><a class="autre" href={href(versCle)} onclick={(e) => followLink(e, versCle)} data-cle><KeyRound size={18} strokeWidth={2} aria-hidden="true" />{t("account.login.key")}</a></li>
      <li><a class="autre" href={href(versInscription)} onclick={(e) => followLink(e, versInscription)} data-create><User size={18} strokeWidth={2} aria-hidden="true" />{t("account.login.create")}</a></li>
    </ul>
  {/if}
</Cadre>

<style>
  /* « Rester connecté » sous le bouton, au bord gauche de la colonne (panneau de droite). */
  .connexion {
    gap: var(--sp-3);
  }
  .connexion :global(.case) {
    justify-self: start;
  }
  /* Séparateur « ou » et boutons secondaires (.ou, .autres, .autre) : Cadre.svelte. */
</style>

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
  import { tick, untrack } from "svelte";
  import { account, annulerCle, cleRequise, etatCompte, ouvrirAvecCle, passkeysDisponibles, preparerConnexion, seConnecter, seDeconnecter } from "../../account/session.svelte";
  import { followLink, href, navigate, suite } from "../../app/router.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import { KeyRound, User } from "../../ui/Icon";
  import TextField from "../../ui/TextField.svelte";
  import Cadre from "./Cadre.svelte";
  import Case from "./Case.svelte";
  import { annulee, erreur, jourLong } from "./erreurs";

  // Seul paramètre lu dans l'adresse : « ?suite=salon » (suite(), router.svelte.ts).
  const apres = suite(location.search);
  const dispo = passkeysDisponibles();

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
  async function connecter() {
    bandeau = null;
    envoi = true;
    try {
      const r = await seConnecter(rester);
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

<Cadre titre={t("account.login.title")}>
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
    <!-- 24 novembre (propriétaire) : « Rester connecté » sous le bouton ; les deux autres chemins
         en boutons secondaires, après un séparateur « ou ». -->
    <form novalidate class="connexion" onsubmit={(e) => e.preventDefault()}>
      <Button type="submit" onpress={connecter}>{envoi ? t("account.verifying") : t("account.login.passkey")}</Button>
      <Case label={t("account.stay")} bind:checked={rester} />
    </form>
    <p class="ou" aria-hidden="true"><span>{t("account.login.or")}</span></p>
    <ul class="autres">
      <li><a class="autre" href={href(versCle)} onclick={(e) => followLink(e, versCle)} data-cle><KeyRound size={18} strokeWidth={2} aria-hidden="true" />{t("account.login.key")}</a></li>
      <li><a class="autre" href={href(versInscription)} onclick={(e) => followLink(e, versInscription)} data-create><User size={18} strokeWidth={2} aria-hidden="true" />{t("account.login.create")}</a></li>
    </ul>
  {/if}
</Cadre>

<style>
  /* « Rester connecté » centré sous le bouton (24 novembre). */
  .connexion {
    gap: var(--sp-3);
  }
  .connexion :global(.case) {
    justify-self: center;
  }
  /* Séparateur « ou » : deux filets et le mot au milieu. */
  .ou {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin: 0;
    color: var(--text-3);
    font-size: var(--fs-small);
  }
  .ou::before,
  .ou::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--hair-2);
  }
  .autres {
    display: grid;
    gap: var(--sp-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* Liens en forme de bouton secondaire, icône à gauche, texte centré. */
  .autre {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 48px;
    padding: 0 20px;
    border: 1px solid var(--hair-2);
    border-radius: 12px;
    background: rgb(255 255 255 / 0.045);
    box-shadow: var(--edge-hi);
    color: var(--text);
    font-size: 0.9375rem;
    font-weight: 560;
    text-decoration: none;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .autre :global(svg) {
    color: var(--accent);
  }
  @media (hover: hover) {
    .autre:hover {
      background: rgb(255 255 255 / 0.08);
      border-color: rgb(233 236 242 / 0.2);
    }
  }
  .autre:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (forced-colors: active) {
    .autre {
      border-color: ButtonText;
    }
  }
</style>

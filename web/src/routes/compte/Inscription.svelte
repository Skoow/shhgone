<script lang="ts">
  // Inscription (/compte/inscription ; conception du compte par passkey §3.1, §5.2). Page montée
  // seulement si __COMPTES__ (App.svelte).
  // 1. Pseudo (vérifié pendant la saisie : icône dans le champ, rond, coche ou croix ; la raison
  //    d'un refus sous le champ ; réservé à l'étape) ;
  //    la preuve anti-robot et inscription/debut partent dès l'ouverture : le clic sur « Créer
  //    avec une passkey » appelle navigator.credentials.create sans aucune requête avant (Safari).
  //    Anti-robot invisible (décision du 26 novembre) : le bouton garde son texte ; un clic avant la
  //    fin du calcul ne lance rien et dit « Vérification en cours… », puis « Vérification terminée »
  //    (annoncé) : un deuxième clic lance la cérémonie (jamais d'attente entre un clic et la feuille).
  //    La création vaut acceptation des conditions (phrase sous le bouton).
  // 2. (seulement si le gestionnaire annonce PRF sans l'avoir rendu) deuxième confirmation.
  // 3. Clé de récupération : « Copier », « Télécharger (.txt) », « Je l'ai notée » ; rien n'est envoyé.
  // 4. Un groupe de la clé à retaper, « Terminer » : inscription/fin ; le compte n'existe qu'ici.
  // Annuler la feuille de passkey n'affiche rien et ne crée rien. Page quittée après la création
  // de la passkey sans « Terminer » : le gestionnaire est prié de l'oublier (signalUnknownCredential).
  // Sur ordinateur (décision du 25 novembre, conception §18) : la passkey est demandée sur le
  // téléphone (QR du navigateur, parcours « hybride »), avec un repli discret « Garder le compte
  // sur cet ordinateur » ; si elle est restée sur l'ordinateur, « Ajouter mon téléphone » est
  // proposé à la fin (ajout de passkey standard, aucun transfert de clé). Téléphone : inchangé.
  // Le chemin qui a marché la dernière fois sur cet ordinateur (lu sur l'appareil, jamais envoyé ;
  // décision du 26 novembre) est proposé d'abord.
  import { tick, untrack } from "svelte";
  import { creationsFermees, texteBandeau } from "../../maintenance/etat.svelte";
  import { abandonnerInscription, account, ajouterPasskey, estMobile, cleAffichee, creerPasskey, deuxiemeGeste, deuxiemeGesteAjout, inscriptionPrete, parcoursRetenu, passkeyCreee, passkeysDisponibles, preparerAjout, preparerInscription, pseudoInviteRetenu, pseudoLibre, terminerInscription, verifierSaisie, type Parcours, type ParcoursRetenu } from "../../account/session.svelte";
  import { followLink, href, navigate, suite } from "../../app/router.svelte";
  import { getDemo } from "../../app/demo-hooks";
  import { getLang, t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import { User } from "../../ui/Icon";
  import TextField from "../../ui/TextField.svelte";
  import Cadre from "./Cadre.svelte";
  import Case from "./Case.svelte";
  import NoteDemo from "./NoteDemo.svelte";
  import CleRecup from "./CleRecup.svelte";
  import IndiceQr from "./IndiceQr.svelte";
  import { annulee, codeDe, erreur } from "./erreurs";
  import { obtenirPreuve } from "./preuve";
  import VerifCle from "./VerifCle.svelte";

  // Seul paramètre lu dans l'adresse : « ?suite=salon » (suite(), router.svelte.ts).
  const apres = suite(location.search);
  const dispo = passkeysDisponibles();
  const mobile = estMobile();
  /** Sur ordinateur : le chemin proposé d'abord (téléphone par QR, sauf si « cet ordinateur » a marché la dernière fois). */
  let prefere = $state<ParcoursRetenu>("hybride");
  const autre = $derived<ParcoursRetenu>(prefere === "local" ? "hybride" : "local");
  if (!mobile) void parcoursRetenu().then((p) => void (p && etape === "saisie" && (prefere = p)));
  /** Où est la passkey créée (lu sur l'appareil) : sert à proposer « Ajouter mon téléphone ». */
  let ou = $state<"telephone" | "ici">("ici");
  /** « Ajouter mon téléphone » après la création : non proposé, proposé, deuxième geste, fait (avec ou sans PRF). */
  let tel = $state<"non" | "propose" | "second" | "ajoute" | "sans_prf">("non");

  let etape = $state<"saisie" | "second" | "cle" | "verif" | "fini" | "echec">("saisie");
  let pseudo = $state(pseudoInviteRetenu() ?? "");
  let errPseudo = $state("");
  let libre = $state<boolean | null>(null);
  // Vérification en cours (de la frappe à la réponse) : rond qui tourne dans le champ.
  let verif = $state(false);
  let bandeau = $state("");
  let pret = $state(false);
  /** Clic avant la fin de la préparation (preuve anti-robot, inscription/debut) : « Vérification en cours… ». */
  let attentePreuve = $state(false);
  let rester = $state(false);
  let gardee = $state(false);
  /** Clé copiée ou téléchargée (CleRecup) : gardé ici, « Revoir la clé » ne le perd pas. */
  let cleSauvee = $state(false);
  let texte = $state("");
  let orpheline = $state(false);
  let pseudoCree = $state("");
  let elPseudo: HTMLInputElement | undefined = $state();

  // Cérémonie chargée d'avance, rechargée sans bruit avant son échéance (5 min au serveur).
  let minuterie: ReturnType<typeof setInterval> | undefined;
  let enPreparation = false;
  async function preparer() {
    if (enPreparation || etape !== "saisie") return;
    enPreparation = true;
    try {
      await preparerInscription(await obtenirPreuve());
      pret = true;
      if (attentePreuve) {
        attentePreuve = false;
        announce(t("account.robot.ready"));
      }
      if (pseudo) void verifierPseudo(pseudo);
    } catch (e) {
      attentePreuve = false;
      bandeau = erreur(e, "inscription").texte;
    } finally {
      enPreparation = false;
    }
  }
  $effect(() =>
    untrack(() => {
      if (!dispo) return;
      void preparer();
      minuterie = setInterval(() => {
        if (etape === "saisie" && !inscriptionPrete()) {
          pret = false;
          void preparer();
        }
      }, 15_000);
      return () => {
        clearInterval(minuterie);
        // Passkey créée, compte pas encore enregistré : le gestionnaire l'oublie (R11).
        if (etape === "second" || etape === "cle" || etape === "verif") void abandonnerInscription();
      };
    }),
  );

  // Disponibilité du pseudo pendant la frappe (500 ms après la dernière touche).
  let attente: ReturnType<typeof setTimeout> | undefined;
  async function verifierPseudo(v: string) {
    libre = null;
    verif = true;
    try {
      const r = await verifierSaisie({ pseudo: v });
      if (v !== pseudo) return;
      if (r.pseudo) {
        errPseudo = erreur(new Error(r.pseudo), "inscription").texte;
        return;
      }
      if (!inscriptionPrete()) return;
      try {
        const l = await pseudoLibre(v);
        if (v === pseudo) libre = l;
      } catch {
        // vérification indisponible (réseau) : redite au clic par le serveur
      }
    } finally {
      if (v === pseudo) verif = false;
    }
  }
  function tape() {
    errPseudo = "";
    libre = null;
    clearTimeout(attente);
    const v = pseudo;
    verif = v.trim() !== "";
    if (verif) attente = setTimeout(() => void verifierPseudo(v), 500);
  }
  // Pseudo refusé (invalide ou déjà pris) : la raison sous le champ, reliée à lui (aria-invalid,
  // aria-describedby, annoncée) ; l'icône dans le champ ne fait que la montrer.
  const errAffichee = $derived(errPseudo || (libre === false ? t("account.pseudo.taken") : ""));
  const etatPseudo = $derived(errAffichee ? "ko" : verif ? "verif" : libre === true ? "ok" : undefined);
  $effect(() => () => clearTimeout(attente));

  async function focusPseudo() {
    await tick();
    elPseudo?.focus();
  }

  // Le geste : aucune requête avant navigator.credentials.create. Ordinateur : téléphone d'abord
  // (« hybride ») ; « Garder le compte sur cet ordinateur » : « local ».
  let enCreation = false;
  async function creer(parcours: Parcours = mobile ? "defaut" : prefere) {
    if (enCreation) return;
    // Pas encore prête : rien n'est lancé (une cérémonie après une attente serait refusée par Safari).
    if (!pret || !inscriptionPrete()) {
      attentePreuve = true;
      pret = false;
      void preparer(); // sans effet si elle est déjà en cours
      return;
    }
    bandeau = "";
    if (libre === false) {
      errPseudo = t("account.pseudo.taken");
      return focusPseudo();
    }
    enCreation = true;
    try {
      const r = await creerPasskey(pseudo, getLang(), parcours);
      ou = mobile ? "ici" : passkeyCreee();
      texte = cleAffichee();
      cleSauvee = false;
      pseudoCree = pseudo;
      etape = r === "second" ? "second" : "cle";
    } catch (e) {
      if (annulee(e)) return;
      const x = erreur(e, "inscription");
      if (x.champ === "pseudo") {
        errPseudo = x.texte;
        return focusPseudo();
      }
      bandeau = x.texte;
      announce(bandeau);
    } finally {
      enCreation = false;
    }
  }

  async function second() {
    try {
      await deuxiemeGeste();
    } catch (e) {
      if (!annulee(e)) bandeau = erreur(e, "inscription").texte;
      return;
    }
    etape = "cle";
  }

  async function terminer() {
    bandeau = "";
    try {
      await terminerInscription(rester);
    } catch (e) {
      bandeau = erreur(e, "inscription").texte;
      announce(bandeau);
      // Étape échue ou pseudo pris entre-temps : il faut recommencer avec une nouvelle passkey.
      if (["not_found", "pseudo_pris", "aucune_etape"].includes(codeDe(e))) {
        orpheline = !(await abandonnerInscription());
        etape = "echec";
      }
      return;
    }
    gardee = rester;
    etape = "fini";
    announce(t("account.created"));
    // Passkey restée sur l'ordinateur : « Ajouter mon téléphone » (cérémonie chargée avant le clic ;
    // la session neuve est récente pendant 5 min, sinon l'offre reste dans Paramètres → Passkeys).
    if (!mobile && ou === "ici") tel = (await preparerAjout().catch(() => "echec")) === "pret" ? "propose" : "non";
  }

  // Geste « Ajouter mon téléphone » : aucune requête avant navigator.credentials.create.
  async function ajouterTelephone() {
    bandeau = "";
    try {
      const r = await ajouterPasskey(t("account.phone.name"), "hybride");
      if (r === "second") return void (tel = "second");
      tel = r === "ajoutee" ? "ajoute" : "sans_prf";
    } catch (e) {
      if (!annulee(e)) {
        bandeau = erreur(e, "parametres").texte;
        announce(bandeau);
      }
      tel = (await preparerAjout().catch(() => "echec")) === "pret" ? "propose" : "non";
      return;
    }
    announce(t("account.phone.added"));
  }
  async function secondTelephone() {
    try {
      tel = (await deuxiemeGesteAjout()) ? "ajoute" : "sans_prf";
    } catch (e) {
      bandeau = erreur(e, "parametres").texte;
      return;
    }
    announce(t("account.phone.added"));
  }

  function recommencer() {
    bandeau = "";
    orpheline = false;
    pret = false;
    etape = "saisie";
    void preparer();
  }
  const versConnexion = apres === "salon" ? "/compte/connexion?suite=salon" : "/compte/connexion";
  // Barre d'étapes (Cadre) : à partir de la passkey créée ; ni sur la saisie ni après un échec.
  const ETAPE_NUM = { second: 1, cle: 2, verif: 3, fini: 4 } as const;
  const numero = $derived(etape in ETAPE_NUM ? ETAPE_NUM[etape as keyof typeof ETAPE_NUM] : undefined);
  const titre = $derived(etape === "fini" ? t("account.created") : etape === "cle" ? t("account.key.title") : etape === "verif" ? t("account.verify.title") : t("account.signup.title"));
</script>

<Cadre forme="panneaux" {titre} etape={numero} sous={etape === "saisie" ? t("account.signup.sub") : undefined} sousRedit>
  {#if bandeau}<Banner kind="danger">{bandeau}</Banner>{/if}

  {#if !dispo}
    <p class="note" data-sans-passkey>{t("account.nopasskey")}</p>
  {:else if etape === "saisie"}
    <form novalidate onsubmit={(e) => e.preventDefault()}>
      <TextField label={t("account.pseudo")} hint={t("account.pseudo.hint")} autocomplete="username" autocapitalize="off" spellcheck="false" maxlength={64} error={errAffichee || undefined} status={etatPseudo} bind:value={pseudo} bind:el={elPseudo} oninput={tape} />
      <!-- « Disponible » : la coche dans le champ, et ce texte pour les lecteurs d'écran seulement
           (région présente dès l'affichage, pour être annoncée). -->
      <p class="sr-only" role="status" data-dispo>{etatPseudo === "ok" ? t("account.pseudo.free") : ""}</p>
      {#if !mobile && prefere === "hybride"}<IndiceQr texte={t("account.signup.phone.how")} />{/if}
      <!-- Redémarrage annoncé (D42-32) : aucune inscription d'ici la fin de la maintenance (la passkey resterait orpheline). -->
      {#if creationsFermees()}<p class="note" id="inscription-fermee" data-maintenance>{texteBandeau()}</p>{/if}
      <Button type="submit" busy={attentePreuve} disabled={creationsFermees()} aria-describedby={creationsFermees() ? "inscription-fermee" : undefined} onpress={() => creer()}>{attentePreuve ? t("account.robot.wait") : (getDemo()?.signupPasskey ?? (mobile ? t("account.signup.passkey") : prefere === "local" ? t("account.signup.here") : t("account.signup.phone")))}</Button>
      <p class="sr-only" role="status" data-attente-preuve>{attentePreuve ? t("account.robot.wait") : ""}</p>
      <NoteDemo />
      <p class="legal" data-legal>
        {t("account.signup.legal.a")}<a class="lien-t" href={href("/conditions")} target="_blank" rel="noopener noreferrer">{t("account.signup.legal.link")}</a>{t("account.signup.legal.b")}
      </p>
      {#if !mobile}<button type="button" class="discret" onclick={() => void creer(autre)} data-autre={autre}>{autre === "local" ? t("account.signup.here") : t("account.signup.phone")}</button>{/if}
    </form>
    <!-- Même forme que les autres chemins de « Se connecter » (séparateur « ou », bouton secondaire). -->
    <p class="ou" aria-hidden="true"><span>{t("account.login.or")}</span></p>
    <ul class="autres">
      <li><a class="autre" href={href(versConnexion)} onclick={(e) => followLink(e, versConnexion)} data-have><User size={18} strokeWidth={2} aria-hidden="true" />{t("account.signup.have")}</a></li>
    </ul>
  {:else if etape === "second"}
    <p class="note">{t("account.second.body")}</p>
    <div class="actions">
      <Button onpress={second}>{t("account.second.go")}</Button>
      <Button variant="ghost" onpress={() => void (etape = "cle")}>{t("account.second.skip")}</Button>
    </div>
  {:else if etape === "cle"}
    <CleRecup {texte} avertissement={t("account.key.notyet")} bind:sauvee={cleSauvee} onnotee={() => void (etape = "verif")} />
  {:else if etape === "verif"}
    <VerifCle {texte} bouton={t("account.verify.done")} onjuste={terminer} onrevoir={() => void (etape = "cle")}>
      <Case label={t("account.stay")} bind:checked={rester} />
    </VerifCle>
  {:else if etape === "echec"}
    {#if orpheline}<p class="note" data-orpheline>{t("account.signup.orphan", { pseudo: pseudoCree })}</p>{/if}
    <div class="actions"><Button onpress={recommencer}>{t("account.restart")}</Button></div>
  {:else}
    <p class="note" data-session-note>{gardee ? t("account.created.session.gardee") : t("account.created.session.memoire")}</p>
    {#if account.cleLocale}<p class="note" data-cle-locale>{ou === "telephone" ? t("account.phone.noprf.created") : t("account.localKey")}</p>{/if}
    {#if tel === "propose"}
      <div class="tel" data-ajout-telephone>
        <p class="note">{t("account.phone.offer")}</p>
        <IndiceQr texte={t("account.phone.how")} />
        <div class="actions"><Button onpress={ajouterTelephone}>{t("account.phone.add")}</Button></div>
      </div>
    {:else if tel === "second"}
      <p class="note">{t("account.second.body")}</p>
      <div class="actions"><Button onpress={secondTelephone}>{t("account.second.go")}</Button></div>
    {:else if tel === "ajoute" || tel === "sans_prf"}
      <p class="ok" role="status" data-telephone-ajoute>{t("account.phone.added")}</p>
      {#if tel === "sans_prf"}<p class="note" data-telephone-sans-prf>{t("account.phone.noprf")}</p>{/if}
    {/if}
    <div class="actions">
      <Button variant={tel === "propose" ? "secondary" : "primary"} onpress={() => navigate(apres === "salon" && __SALONS__ ? "/salon/nouveau" : "/")}>{tel === "propose" ? t("account.phone.later") : t("account.continue")}</Button>
    </div>
  {/if}
</Cadre>

<style>
  .tel {
    display: grid;
    gap: var(--sp-4);
    padding-top: var(--sp-4);
    border-top: 1px solid var(--hair-2);
  }
  .ok {
    margin: 0;
    color: var(--accent);
    font-weight: 560;
  }
  .legal {
    margin: calc(-1 * var(--sp-2)) 0 0;
    color: var(--text-2);
    font-size: var(--fs-small);
    line-height: 1.5;
    text-wrap: pretty;
  }
</style>

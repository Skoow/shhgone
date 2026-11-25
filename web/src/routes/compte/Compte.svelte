<script lang="ts">
  // Compte (/compte ; conception compte §21.15.3, §21.15.4) : Profil et Paramètres réunis en une
  // page (25 novembre ; « /compte/profil » y mène, app/router.svelte.ts). Monté seulement avec
  // __COMPTES__ et une session ouverte (App.svelte, pages.ts).
  // Sections, dans l'ordre : Profil (photo, pseudo, carte « Votre compte » avec l'abonnement),
  // Passkeys, Clé de récupération, Appareils, Confidentialité, Vos données ; puis
  // « Se déconnecter » (seul endroit du site) et « Supprimer le compte » (écran dédié, sans
  // changer l'adresse). Pas de choix de langue : elle suit le navigateur (detectLang). Aucun
  // pseudo dans le titre de l'onglet ni dans l'adresse de la page.
  // Profil : photo facultative, ré-encodée SUR L'APPAREIL (256 × 256, 64 Ko au plus, sans
  // métadonnées), rangée dans le coffre de profil ; le nom du fichier n'est ni gardé ni montré.
  // Pseudo obligatoire, unique parmi les comptes : règle du salon sur l'appareil, puis
  // « Disponible » / « Déjà pris » ; « Enregistrer » (3 fois par an au plus).
  import { untrack } from "svelte";
  import { account, changerPseudo, ecrireProfil, etatCompte, pseudoLibre, seDeconnecter, verifierSaisie, type EtatServeur } from "../../account/session.svelte";
  import { followLink, href, navigate } from "../../app/router.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import AvatarPicker from "../../ui/AvatarPicker.svelte";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import { reducedMotion } from "../../ui/motion";
  import PseudoField from "../../ui/PseudoField.svelte";
  import Cadre from "./Cadre.svelte";
  import CarteCompte from "./CarteCompte.svelte";
  import { codeDe, erreur, jourLong } from "./erreurs";
  import Appareils from "./sections/Appareils.svelte";
  import Confidentialite from "./sections/Confidentialite.svelte";
  import Donnees from "./sections/Donnees.svelte";
  import Passkeys from "./sections/Passkeys.svelte";
  import Recuperation from "./sections/Recuperation.svelte";
  import Section from "./sections/Section.svelte";
  import Supprimer from "./Supprimer.svelte";

  /** Au-delà, la carte « Votre compte » dit l'échec au lieu d'attendre sans fin (réseau bloqué). */
  const DELAI_ETAT_MS = 15_000;

  let etat = $state.raw<EtatServeur | null>(null);
  let erreurEtat = $state("");
  let vue = $state<"page" | "supprimer">("page");

  let pseudo = $state(account.profil?.pseudo ?? "");
  let photo = $state.raw<Uint8Array | null>(account.profil?.photo ?? null);
  let errPseudo = $state<string | undefined>(undefined);
  let errPhoto = $state("");
  let ok = $state("");
  let el: HTMLInputElement | undefined = $state();

  async function chargerEtat(): Promise<void> {
    erreurEtat = "";
    let minuterie: ReturnType<typeof setTimeout> | undefined;
    const delai = new Promise<never>((_, ko) => {
      minuterie = setTimeout(() => ko(Object.assign(new Error("reseau"), { code: "reseau" })), DELAI_ETAT_MS);
    });
    try {
      etat = await Promise.race([etatCompte(), delai]);
    } catch (e) {
      erreurEtat = erreur(e, "parametres").texte;
    } finally {
      clearTimeout(minuterie);
    }
  }
  $effect(() => untrack(() => void chargerEtat()));

  const actuel = () => account.profil?.pseudo ?? "";

  async function verifier(p: string): Promise<string> {
    if (p.trim() === actuel()) return "";
    const r = await verifierSaisie({ pseudo: p });
    if (r.pseudo) return r.pseudo;
    return (await pseudoLibre(p)) ? "libre" : "pris";
  }

  async function enregistrer() {
    errPseudo = undefined;
    ok = "";
    if (pseudo.trim() === actuel()) return;
    try {
      await changerPseudo(pseudo);
    } catch (e) {
      const c = codeDe(e);
      // Prochain changement possible (3 par an au plus) : date tirée de l'attente.
      const apres = (e as { retryAfterS?: number }).retryAfterS ?? 0;
      errPseudo = c === "limit" ? t("account.profile.limit", { date: jourLong(new Date(Date.now() + apres * 1000).toISOString().slice(0, 10)) }) : erreur(e, "parametres").texte;
      announce(errPseudo);
      el?.focus();
      return;
    }
    ok = t("account.profile.saved");
    announce(ok);
  }

  async function photoChangee(p: Uint8Array | null) {
    errPhoto = "";
    try {
      await ecrireProfil({ photo: p });
    } catch (e) {
      photo = account.profil?.photo ?? null; // rien n'a été écrit : l'aperçu revient au coffre
      errPhoto = erreur(e, "parametres").texte;
    }
  }

  async function deconnecter() {
    await seDeconnecter();
    navigate("/compte/connexion");
  }

  // Sommaire (ordinateur) : mêmes sections, même ordre ; le titre de la section reçoit le focus.
  const SOMMAIRE = [
    ["sec-profil", "account.section.profile"],
    ["sec-passkeys", "account.section.passkeys"],
    ["sec-recovery", "account.section.recovery"],
    ["sec-devices", "account.section.devices"],
    ["sec-privacy", "account.section.privacy"],
    ["sec-data", "account.section.data"],
  ] as const;
  function aller(id: string) {
    const h = document.getElementById(id);
    if (!h) return;
    h.scrollIntoView?.({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    h.focus({ preventScroll: true });
  }
  function versSupprimer() {
    vue = "supprimer";
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  }
</script>

{#if vue === "supprimer"}
  <Supprimer {etat} onretour={() => void (vue = "page")} />
{:else}
  <Cadre forme="large" titre={t("account.page.title")}>
    {#if account.erreur === "coffre_illisible"}<Banner kind="danger">{t("account.err.coffre")}</Banner>{/if}

    <div class="corps">
      <!-- Ordinateur : sommaire collant à gauche (boutons : le « # » de l'adresse est réservé aux clés). -->
      <nav class="sommaire" aria-label={t("info.toc")}>
        <ul>
          {#each SOMMAIRE as [id, cle] (id)}
            <li><button type="button" onclick={() => aller(id)}>{t(cle)}</button></li>
          {/each}
        </ul>
      </nav>
      <div class="secs">
        <Section id="sec-profil" titre={t("account.section.profile")}>
          <div class="profil">
            <AvatarPicker grand bind:photo initiale={pseudo.trim()} onchange={photoChangee} />
            {#if errPhoto}<p class="err" role="alert">{errPhoto}</p>{/if}
            <form novalidate onsubmit={(e) => e.preventDefault()}>
              <PseudoField bind:value={pseudo} {verifier} error={errPseudo} bind:el onsaisie={() => ((errPseudo = undefined), (ok = ""))} />
              {#if ok}<p class="ok" role="status">{ok}</p>{/if}
              <div class="actions"><Button type="submit" variant="secondary" onpress={enregistrer}>{t("account.profile.save")}</Button></div>
            </form>
          </div>
          <CarteCompte {etat} erreur={erreurEtat} onretry={() => void chargerEtat()} />
          <p class="note">
            {t("account.profile.privacy")}
            <a class="lien" href={href("/securite")} onclick={(e) => followLink(e, "/securite")}>{t("account.profile.more")}</a>
          </p>
        </Section>
        <Passkeys />
        <Recuperation />
        <Appareils />
        <Confidentialite />
        <Donnees />
        <div class="fin">
          <Button variant="secondary" onpress={deconnecter}>{t("account.logout")}</Button>
          {#if account.cleLocale}<p class="raison" data-deconnexion-cle>{t("account.logout.localKey")}</p>{/if}
          <Button variant="danger" onpress={versSupprimer}>{t("account.delete")}</Button>
        </div>
      </div>
    </div>
  </Cadre>
{/if}

<style>
  .secs {
    display: grid;
    min-width: 0;
  }
  .profil {
    display: grid;
    gap: var(--sp-4);
    min-width: 0;
  }
  form {
    display: grid;
    gap: var(--sp-3);
    min-width: 0;
  }
  .note .lien {
    display: inline;
    min-height: 0;
  }
  /* Téléphone et tablette : une colonne, sans sommaire. Ordinateur : sommaire collant, sections
     sur 46 rem au plus. */
  .sommaire {
    display: none;
  }
  @media (min-width: 1024px) {
    .corps {
      display: grid;
      grid-template-columns: 13rem minmax(0, 46rem);
      gap: var(--sp-7);
      align-items: start;
    }
    .sommaire {
      display: block;
      position: sticky;
      top: calc(64px + var(--sp-5));
    }
    .sommaire ul {
      display: grid;
      gap: var(--sp-1);
      margin: 0;
      padding: var(--sp-4) 0 0;
      list-style: none;
    }
    .sommaire button {
      width: 100%;
      min-height: 40px;
      padding: 0 var(--sp-3);
      border: 0;
      border-radius: var(--r-md);
      background: none;
      color: var(--text-2);
      font: inherit;
      font-size: var(--fs-small);
      font-weight: 560;
      text-align: start;
      cursor: pointer;
      transition:
        background-color var(--dur-fast) var(--ease-out),
        color var(--dur-fast) var(--ease-out);
    }
    .sommaire button:hover {
      background: rgb(255 255 255 / 0.05);
      color: var(--text);
    }
    .sommaire button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
  }
  .fin {
    display: grid;
    gap: var(--sp-3);
    padding-top: var(--sp-5);
    border-top: 1px solid var(--hair);
  }
  .raison {
    margin: 0;
    color: var(--warn);
    font-size: var(--fs-small);
  }
</style>

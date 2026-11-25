<script lang="ts">
  // Paramètres (/compte ; conception compte §21.15.4).
  // Monté seulement avec __COMPTES__ et une session ouverte (App.svelte, pages.ts).
  // Sections dans l'ordre (conception du compte par passkey §3.5) : Profil (avec ancienneté et
  // limites), Passkeys, Clé de récupération, Appareils, Confidentialité, Abonnement, Langue, Vos
  // données ; puis « Se déconnecter » et « Supprimer le compte » (écran dédié, sans changer
  // l'adresse de la page). Aucun pseudo dans le titre de l'onglet ni dans l'adresse de la page.
  import { untrack } from "svelte";
  import { account, ecrireProfil, etatCompte, seDeconnecter, type EtatServeur } from "../../account/session.svelte";
  import { followLink, href, navigate } from "../../app/router.svelte";
  import { getLang, setLang, t } from "../../i18n/i18n.svelte";
  import type { Lang } from "../../i18n/format";
  import Avatar from "../../ui/Avatar.svelte";
  import Banner from "../../ui/Banner.svelte";
  import Button from "../../ui/Button.svelte";
  import { ChevronRight } from "../../ui/Icon";
  import { reducedMotion } from "../../ui/motion";
  import Segmented from "../../ui/Segmented.svelte";
  import Cadre from "./Cadre.svelte";
  import CarteCompte from "./CarteCompte.svelte";
  import { erreur } from "./erreurs";
  import Abonnement from "./sections/Abonnement.svelte";
  import Appareils from "./sections/Appareils.svelte";
  import Confidentialite from "./sections/Confidentialite.svelte";
  import Donnees from "./sections/Donnees.svelte";
  import Passkeys from "./sections/Passkeys.svelte";
  import Recuperation from "./sections/Recuperation.svelte";
  import Section from "./sections/Section.svelte";
  import Supprimer from "./Supprimer.svelte";

  let etat = $state.raw<EtatServeur | null>(null);
  let bandeau = $state("");
  let vue = $state<"liste" | "supprimer">("liste");
  let langue = $state<Lang>(getLang());

  async function recharger(): Promise<void> {
    try {
      etat = await etatCompte();
      bandeau = "";
    } catch (e) {
      bandeau = erreur(e, "parametres").texte;
    }
  }
  $effect(() => untrack(() => void recharger()));

  // Langue : appliquée tout de suite, gardée dans le coffre de profil (§21.15.4 point 8).
  $effect(() => {
    const l = langue;
    untrack(() => {
      if (l === getLang()) return;
      void setLang(l);
      if (account.profil && account.profil.langue !== l) void ecrireProfil({ langue: l }).catch(() => undefined);
    });
  });

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
    ["sec-plan", "account.section.plan"],
    ["sec-lang", "account.section.lang"],
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
  <Supprimer {etat} onretour={() => void (vue = "liste")} />
{:else}
  <Cadre forme="large" titre={t("account.settings.title")}>
    {#if bandeau}<Banner kind="danger">{bandeau}</Banner>{/if}
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
        <a class="profil" href={href("/compte/profil")} onclick={(e) => followLink(e, "/compte/profil")}>
          <Avatar photo={account.profil?.photo ?? null} name={account.profil?.pseudo ?? ""} size={44} />
          <span class="pn"><bdi>{account.profil?.pseudo ?? ""}</bdi><span class="val">{t("account.profile.open")}</span></span>
          <ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" />
        </a>
        <CarteCompte {etat} />
      </Section>
      <Passkeys />
      <Recuperation />
      <Appareils />
      <Confidentialite />
      <Abonnement />
      <Section id="sec-lang" titre={t("account.section.lang")}>
        <Segmented
          label={t("account.lang.label")}
          options={[
            { value: "fr", label: "Français" },
            { value: "en", label: "English" },
          ]}
          bind:value={langue}
        />
      </Section>
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
  .profil {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-height: 56px;
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r-lg);
    color: var(--text);
    text-decoration: none;
    background: rgb(255 255 255 / 0.035);
    box-shadow: inset 0 0 0 1px var(--hair);
  }
  .profil:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  @media (hover: hover) {
    .profil:hover {
      background: rgb(255 255 255 / 0.06);
    }
  }
  .pn {
    flex: 1;
    display: grid;
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .val {
    font-weight: 400;
    color: var(--text-2);
    font-size: var(--fs-small);
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

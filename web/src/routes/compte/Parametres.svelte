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
  function versSupprimer() {
    vue = "supprimer";
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  }
</script>

{#if vue === "supprimer"}
  <Supprimer {etat} onretour={() => void (vue = "liste")} />
{:else}
  <Cadre titre={t("account.settings.title")}>
    {#if bandeau}<Banner kind="danger">{bandeau}</Banner>{/if}
    {#if account.erreur === "coffre_illisible"}<Banner kind="danger">{t("account.err.coffre")}</Banner>{/if}

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
  </Cadre>
{/if}

<style>
  .secs {
    display: grid;
    min-width: 0;
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

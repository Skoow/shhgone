<script lang="ts">
  // Confidentialité (conception compte §21.5, §21.7, §21.9, §21.15.4 point 6 ; plan, lot 13 ; monté
  // seulement avec __COMPTES__). Deux réglages du compte, écrits dans le coffre de profil :
  // proposer pseudo et photo dans les salons, garder les liens ouverts (« Garder les salons que je
  // rejoins », lu nulle part, retiré le 24 novembre).
  // Deux réglages de cet appareil : l'historique des téléchargements (downloads/, jamais envoyé) et
  // « Rester connecté » (seulement coupé d'ici : la durée de la session est fixée par le serveur à
  // la connexion).
  import { untrack } from "svelte";
  import { account, arreterResterConnecte, ecrireProfil, REGLAGES_DEFAUT, type Reglages } from "../../../account/session.svelte";
  import { downloads, loadDownloads, setDownloadsEnabled } from "../../../downloads/live.svelte";
  import { t } from "../../../i18n/i18n.svelte";
  import { announce } from "../../../ui/announce";
  import Switch from "../../../ui/Switch.svelte";
  import { erreur } from "../erreurs";
  import Section from "./Section.svelte";

  const uid = $props.id();
  let global = $state("");
  const r = $derived(account.profil?.reglages ?? REGLAGES_DEFAUT);
  $effect(() => untrack(() => void loadDownloads().catch(() => undefined)));

  async function regler(k: keyof Reglages, v: boolean) {
    global = "";
    try {
      await ecrireProfil({ reglages: { ...r, [k]: v } });
      announce(t("account.privacy.saved"));
    } catch (e) {
      global = erreur(e, "parametres").texte;
    }
  }
</script>

<Section id="sec-privacy" titre={t("account.section.privacy")}>
  <div class="sws">
    <Switch label={t("account.privacy.propose")} hint={t("account.privacy.propose.hint")} checked={r.proposerProfil} disabled={!account.profil} onchange={(v) => regler("proposerProfil", v)} />
    <Switch label={t("account.privacy.links")} checked={r.garderRecus} disabled={!account.profil} onchange={(v) => regler("garderRecus", v)} />
    <Switch label={t("account.privacy.downloads")} hint={t("downloads.keep.hint")} checked={downloads.enabled} onchange={(v) => void setDownloadsEnabled(v)} />
    <Switch label={t("account.privacy.stay")} checked={account.persistante} disabled={!account.persistante} reason="{uid}-stay" onchange={(v) => void (v ? undefined : arreterResterConnecte())} />
    {#if !account.persistante}<p id="{uid}-stay" class="note">{t("account.privacy.stay.off")}</p>{/if}
  </div>
  {#if global}<p class="err" role="alert">{global}</p>{/if}
</Section>

<style>
  .sws {
    display: grid;
    gap: var(--sp-2);
  }
</style>

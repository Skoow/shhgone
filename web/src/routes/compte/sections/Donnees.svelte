<script lang="ts">
  // Vos données (conception compte §12.4, §21.15.4 point 10 ; monté seulement avec
  // __COMPTES__). « Exporter mes données » : fichier JSON fait SUR L'APPAREIL (account/
  // session.svelte.ts : données du serveur, profil, listes sans leurs secrets, jamais l'adresse),
  // enregistré par un lien blob: local. « Effacer les données de cet appareil » : historique et
  // téléchargements gardés ici (le compte n'est pas touché). Effacement après 13 mois pleins sans connexion (au plus tard au début du 14e mois).
  import { exporterDonnees } from "../../../account/session.svelte";
  import { clearDownloads } from "../../../downloads/live.svelte";
  import { clearHistory } from "../../../history/live.svelte";
  import { t } from "../../../i18n/i18n.svelte";
  import { announce } from "../../../ui/announce";
  import Button from "../../../ui/Button.svelte";
  import { Download } from "../../../ui/Icon";
  import InlineConfirm from "../../../ui/InlineConfirm.svelte";
  import { clickDownload } from "../../../viewers/save";
  import { erreur } from "../erreurs";
  import Section from "./Section.svelte";

  let global = $state("");

  async function exporter() {
    global = "";
    let json: string;
    try {
      json = await exporterDonnees();
    } catch (e) {
      global = erreur(e, "parametres").texte;
      return;
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    try {
      clickDownload(url, `shhgone-compte-${new Date().toISOString().slice(0, 10)}.json`);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    announce(t("account.data.exported"));
  }
  async function effacer() {
    await clearHistory().catch(() => undefined);
    await clearDownloads().catch(() => undefined);
    announce(t("account.data.cleared"));
  }
</script>

<Section id="sec-data" titre={t("account.section.data")}>
  <div class="actions">
    <Button variant="secondary" onpress={exporter}>
      {#snippet icon()}<Download size={18} strokeWidth={1.75} />{/snippet}
      {t("account.data.export")}
    </Button>
  </div>
  <p class="note">{t("account.data.export.note")}</p>
  {#if global}<p class="err" role="alert">{global}</p>{/if}
  <div class="actions">
    <InlineConfirm label={t("account.data.clear")} message={t("account.data.clear.confirm")} confirmLabel={t("account.data.clear.yes")} kind="danger" triggerVariant="ghost" onconfirm={effacer} />
  </div>
  <p class="note">{t("account.data.inactive")}</p>
</Section>

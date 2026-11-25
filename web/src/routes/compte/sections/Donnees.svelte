<script lang="ts">
  // Vos données (conception compte §12.4, §21.15.4 point 10 ; monté seulement avec __COMPTES__).
  // « Effacer les données de cet appareil » : retours gardés, preuves des salons, téléchargements
  // (storage/appareil.ts ; le compte n'est pas touché). Effacement du compte après 13 mois pleins
  // sans connexion (au plus tard au début du 14e mois). « Exporter mes données » retiré le
  // 25 novembre (décision du propriétaire ; spec §33, registre).
  import { effacerDonneesAppareil } from "../../../storage/appareil";
  import { t } from "../../../i18n/i18n.svelte";
  import { announce } from "../../../ui/announce";
  import InlineConfirm from "../../../ui/InlineConfirm.svelte";
  import Section from "./Section.svelte";

  async function effacer() {
    await effacerDonneesAppareil();
    announce(t("account.data.cleared"));
  }
</script>

<Section id="sec-data" titre={t("account.section.data")}>
  <p class="note">{t("account.data.inactive")}</p>
  <div class="actions">
    <InlineConfirm label={t("account.data.clear")} message={t("account.data.clear.confirm")} confirmLabel={t("account.data.clear.yes")} kind="danger" triggerVariant="ghost" onconfirm={effacer} />
  </div>
</Section>

<script lang="ts">
  // Abonnement (conception compte §21.15.4 point 7, R5 ; monté seulement avec
  // __COMPTES__) : état du pass (rangé dans le coffre de profil, séquestré), « Voir les offres ».
  import { account } from "../../../account/session.svelte";
  import { followLink, href } from "../../../app/router.svelte";
  import { t } from "../../../i18n/i18n.svelte";
  import Section from "./Section.svelte";
</script>

<Section id="sec-plan" titre={t("account.section.plan")}>
  <div class="ligne">
    <div class="lib"><span>{account.profil?.pass ? t("account.card.plus") : t("account.card.free")}</span></div>
    <a class="lien" href={href("/offres")} onclick={(e) => followLink(e, "/offres")}>{t("account.offers")}</a>
  </div>
  <p class="note">{t("account.plan.note")}</p>
</Section>

<script lang="ts">
  // « Salon prêt » (spec §39.6, plan C-3 points 1 et 2) : lien d'invitation (Copier, QR), mot de
  // passe (Copier) à donner par un autre moyen, lien de gestion derrière un bouton avec
  // l'avertissement de l'exigence C-3 36, puis « Entrer dans le salon ». Les liens sont
  // affichés, jamais placés dans la barre d'adresse.
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatDuration } from "../../i18n/format";
  import { vue, versExplication } from "../../salon/salon.svelte";
  import Cadre from "../compte/Cadre.svelte";
  import CopyField from "../../ui/CopyField.svelte";
  import QrCode from "../../ui/QrCode.svelte";
  import Button from "../../ui/Button.svelte";
  import Banner from "../../ui/Banner.svelte";

  let gestion = $state(false);
  const reste = $derived(Math.max(0, (vue.finMs - Date.now()) / 1000));
</script>

{#if vue.pret}
  <Cadre titre={t("salon.ready.title")} sous={t("salon.ready.sub", { duree: formatDuration(reste, getLang(), { coarse: true }) })}>
    <CopyField label={t("salon.ready.link")} value={vue.pret.lien} />
    <div class="qr"><QrCode text={vue.pret.lien} label={t("salon.ready.link")} /></div>
    <div class="mdp">
      <CopyField label={t("salon.ready.password")} value={vue.pret.mdp} whole />
      <p class="note">{t("salon.ready.password.hint")}</p>
    </div>
    <!-- Historique désactivé (par défaut, avec ou sans compte : 24 novembre, B) ou indisponible :
         le lien de gestion n'est gardé nulle part, il est montré d'emblée pour être gardé à la main.
         Gardé dans l'historique : derrière un bouton, comme avant. -->
    {#if gestion || !vue.pret.garde}
      <div class="gestion" data-manage>
        <CopyField label={t("salon.ready.manage")} value={vue.pret.gestion} />
        {#if !vue.pret.garde}<p class="note">{t("salon.ready.manage.keep")}</p>{/if}
        <Banner kind="warn">{t("salon.manage.warn")}</Banner>
      </div>
    {:else}
      <div><Button variant="ghost" onpress={() => {
            gestion = true;
          }}>{t("salon.ready.manage.show")}</Button></div>
    {/if}
    <div class="actions"><Button onpress={versExplication}>{t("salon.ready.enter")}</Button></div>
  </Cadre>
{/if}

<style>
  .qr {
    width: min(100%, 12rem);
  }
  .mdp,
  .gestion {
    display: grid;
    gap: var(--sp-2);
  }
</style>

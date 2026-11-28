<script lang="ts">
  // « Salon prêt » (spec §39.6) : lien d'invitation (Copier, QR), mot de
  // passe (Copier) à donner par un autre moyen, puis « Entrer dans le salon ». Les liens sont
  // affichés, jamais placés dans la barre d'adresse. Le salon est gardé d'office dans « Mes
  // partages » (D42-30 : lien de gestion et lien d'invitation, jamais le mot de passe) ; le lien de
  // gestion n'est montré, avec l'avertissement, que si l'appareil ne peut rien garder.
  import { untrack } from "svelte";
  import { accountFlag } from "../../app/account-flag.svelte";
  import { href } from "../../app/router.svelte";
  import { garderPartage } from "../../storage/partages.svelte";
  import { t, getLang } from "../../i18n/i18n.svelte";
  import { formatDuration } from "../../i18n/format";
  import { vue, versExplication } from "../../salon/salon.svelte";
  import Cadre from "../compte/Cadre.svelte";
  import CopyField from "../../ui/CopyField.svelte";
  import QrCode from "../../ui/QrCode.svelte";
  import Button from "../../ui/Button.svelte";
  import Banner from "../../ui/Banner.svelte";

  const reste = $derived(Math.max(0, (vue.finMs - Date.now()) / 1000));

  let garde = $state<"attente" | "oui" | "non">("attente");
  $effect(() => {
    untrack(() => {
      const p = vue.pret;
      if (!p) return;
      void garderPartage({ sorte: "salon", gestion: p.gestion, invitation: p.lien, creeLe: Date.now(), echeance: Math.round(vue.finMs) }).then((id) => (garde = id ? "oui" : "non"));
    });
  });
</script>

{#if vue.pret}
  <Cadre titre={t("salon.ready.title")} sous={t("salon.ready.sub", { duree: formatDuration(reste, getLang(), { coarse: true }) })}>
    <CopyField label={t("salon.ready.link")} value={vue.pret.lien} />
    <div class="qr"><QrCode text={vue.pret.lien} label={t("salon.ready.link")} /></div>
    <div class="mdp">
      <CopyField label={t("salon.ready.password")} value={vue.pret.mdp} whole />
      <p class="note">{t("salon.ready.password.hint")}</p>
    </div>
    {#if garde === "non"}
      <div class="gestion" data-manage>
        <CopyField label={t("salon.ready.manage")} value={vue.pret.gestion} />
        <p class="note">{t("salon.ready.manage.keep")}</p>
        <Banner kind="warn">{t("salon.manage.warn")}</Banner>
      </div>
    {:else}
      <!-- Nouvel onglet : quitter cette page fermerait le salon dans cet onglet. -->
      <div class="gestion" data-kept={garde === "oui" ? "" : undefined}>
        <p class="ligne">
          {t("salon.ready.kept.before")}<a href={href("/envois")} target="_blank" rel="noopener" data-shares-link>{t("nav.shares")}<span class="sr-only"> {t("salon.ready.kept.newTab")}</span></a>{t("ready.kept.after")}
        </p>
        {#if !accountFlag.connected}<p class="note" data-kept-device>{t("ready.kept.device")}</p>{/if}
      </div>
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
  .ligne {
    margin: 0;
  }
  .ligne a {
    color: var(--accent);
    font-weight: 600;
    text-underline-offset: 0.2em;
  }
</style>

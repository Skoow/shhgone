<script lang="ts">
  // Clé de récupération montrée une fois (conception du compte par passkey §3.1, écran 3 ; §3.5,
  // nouvelle clé). Monté seulement avec __COMPTES__. Sept groupes en chasse fixe, « Copier »,
  // « Télécharger (.txt) » (fichier fait sur l'appareil : la clé et une phrase, ni pseudo ni
  // adresse du site), puis « Je l'ai notée ». Rien n'est envoyé ici.
  import { fichierTexte } from "../../account/session.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import Button from "../../ui/Button.svelte";
  import { copyText } from "../../ui/clipboard";
  import { Copy, Download } from "../../ui/Icon";
  import { clickDownload } from "../../viewers/save";

  type Props = { texte: string; onnotee: () => void; avertissement?: string };
  let { texte, onnotee, avertissement }: Props = $props();

  async function copier() {
    announce((await copyText(texte)) === "copied" ? t("account.key.copied") : t("account.key.manual"));
  }
  function telecharger() {
    const url = URL.createObjectURL(new Blob([fichierTexte(texte, t("account.key.file"))], { type: "text/plain;charset=utf-8" }));
    try {
      clickDownload(url, "shhgone-cle-de-recuperation.txt");
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  }
</script>

<p class="note">{t("account.key.body")}</p>
<p class="cle" data-cle translate="no">
  {#each texte.split("-") as g, i (i)}<span class="g">{g}</span>{/each}
</p>
<p class="note">{t("account.key.store")}</p>
{#if avertissement}<p class="note warn" data-pas-encore>{avertissement}</p>{/if}
<div class="actions">
  <Button variant="secondary" onpress={copier}>
    {#snippet icon()}<Copy size={18} strokeWidth={1.75} aria-hidden="true" />{/snippet}
    {t("account.key.copy")}
  </Button>
  <Button variant="secondary" onpress={telecharger}>
    {#snippet icon()}<Download size={18} strokeWidth={1.75} aria-hidden="true" />{/snippet}
    {t("account.key.download")}
  </Button>
  <Button onpress={onnotee}>{t("account.key.noted")}</Button>
</div>

<style>
  .cle {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--sp-2) var(--sp-3);
    padding: var(--sp-4);
    border-radius: var(--r-lg);
    background: rgb(255 255 255 / 0.04);
    box-shadow: inset 0 0 0 1px var(--hair);
    font-family: var(--font-mono);
    font-size: 1.15rem;
    letter-spacing: 0.06em;
    overflow-wrap: anywhere;
  }
  .warn {
    color: var(--warn);
  }
</style>

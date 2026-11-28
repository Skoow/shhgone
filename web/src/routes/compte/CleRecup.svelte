<script lang="ts">
  // Clé de récupération montrée une fois (conception du compte par passkey §3.1, écran 3 ; §3.5,
  // nouvelle clé). Monté seulement avec __COMPTES__. Sept groupes en chasse fixe, « Copier »,
  // « Télécharger (.txt) » (fichier fait sur l'appareil : la clé et une phrase, ni pseudo ni
  // adresse du site), puis « Je l'ai notée ». Rien n'est envoyé ici. Demande du propriétaire
  // (25 novembre) : « Je l'ai notée » reste grisé (aria-disabled, focalisable) tant que ni
  // « Copier » ni « Télécharger » n'a servi ; cliqué quand même, une phrase courte dit pourquoi
  // (role=status, annoncée) et le focus va sur « Copier ». 28 novembre (essais) : troisième geste
  // « Je l'ai recopiée à la main », pour qui la note sur papier sans passer par le presse-papiers ;
  // une phrase dit dès l'arrivée ce que le bouton attend.
  import { tick } from "svelte";
  import { fichierTexte } from "../../account/session.svelte";
  import { t } from "../../i18n/i18n.svelte";
  import { announce } from "../../ui/announce";
  import Button from "../../ui/Button.svelte";
  import { copyText } from "../../ui/clipboard";
  import { Copy, Download } from "../../ui/Icon";
  import { clickDownload } from "../../viewers/save";

  /** `sauvee` : « Copier » ou « Télécharger » a servi (gardé par l'écran : « Revoir la clé » ne le perd pas). */
  type Props = { texte: string; onnotee: () => void; avertissement?: string; sauvee?: boolean };
  let { texte, onnotee, avertissement, sauvee = $bindable(false) }: Props = $props();

  let rappel = $state(false);
  let elCopier: HTMLButtonElement | undefined = $state();

  async function notee() {
    if (sauvee) return onnotee();
    rappel = true;
    announce(t("account.key.first"));
    await tick();
    elCopier?.focus();
  }

  async function copier() {
    sauvee = true;
    rappel = false;
    announce((await copyText(texte)) === "copied" ? t("account.key.copied") : t("account.key.manual"));
  }
  function recopiee() {
    sauvee = true;
    rappel = false;
  }
  function telecharger() {
    sauvee = true;
    rappel = false;
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
<!-- Juste au-dessus de « Copier » (qui prend le focus) : visible sans défiler sur téléphone. -->
<p class="note rappel" role="status" data-rappel>{rappel ? t("account.key.first") : ""}</p>
<div class="actions">
  <Button variant="secondary" onpress={copier} bind:el={elCopier}>
    {#snippet icon()}<Copy size={18} strokeWidth={1.75} aria-hidden="true" />{/snippet}
    {t("account.key.copy")}
  </Button>
  <Button variant="secondary" onpress={telecharger}>
    {#snippet icon()}<Download size={18} strokeWidth={1.75} aria-hidden="true" />{/snippet}
    {t("account.key.download")}
  </Button>
  <Button variant="ghost" onpress={recopiee} data-recopiee>{t("account.key.byhand")}</Button>
  <Button softDisabled={!sauvee} onpress={notee}>{t("account.key.noted")}</Button>
</div>
{#if !sauvee && !rappel}<p class="note" data-attente>{t("account.key.waiting")}</p>{/if}

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
  .rappel {
    color: var(--warn);
  }
  .rappel:empty {
    display: none;
  }
  .warn {
    color: var(--warn);
  }
</style>

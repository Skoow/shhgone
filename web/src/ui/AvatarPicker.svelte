<script lang="ts">
  // Photo de profil, facultative (conception compte §12.1, §21.15.3) : « Ajouter une photo »
  // ouvre le choix de fichier du système ; l'image est ré-encodée SUR L'APPAREIL (avatar.ts :
  // carré pris au centre, 256 × 256, 64 Kio au plus, sans métadonnées) ; aperçu rond ; « Retirer ».
  // Rien ne part d'ici : l'écran range les octets dans le coffre de profil.
  import { t } from "../i18n/i18n.svelte";
  import { announce } from "./announce";
  import { reencoder } from "./avatar";
  import Button from "./Button.svelte";
  import { Camera } from "./Icon";

  type Props = {
    photo?: Uint8Array | null;
    initiale?: string;
    /** Profil (§21.15.3) : avatar de 96 px centré, au lieu de 64 px en ligne. */
    grand?: boolean;
    /** Après chaque changement (ajout, retrait) ; l'écran range les octets dans le coffre de profil. */
    onchange?: (p: Uint8Array | null) => void | Promise<void>;
    /** Libellé de l'écran qui l'emploie (salon : « Photo pour ce salon ») ; « Photo de profil » sinon. */
    libelle?: string;
  };
  let { photo = $bindable(null), initiale = "", grand = false, onchange, libelle }: Props = $props();
  const px = $derived(grand ? 96 : 64);
  const uid = $props.id();
  let input: HTMLInputElement | undefined = $state();
  let erreur = $state("");

  // Aperçu : adresse blob: locale (img-src blob: de la CSP), libérée au changement.
  const url = $derived(photo ? URL.createObjectURL(new Blob([photo as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })) : null);
  $effect(() => {
    const u = url;
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  });

  async function choisi(e: Event) {
    const i = e.currentTarget as HTMLInputElement;
    const f = i.files?.[0];
    i.value = ""; // le même fichier peut être choisi à nouveau
    if (!f) return;
    try {
      photo = await reencoder(f);
      erreur = "";
      announce(t("account.photo.added"));
      await onchange?.(photo);
    } catch {
      erreur = t("account.photo.err");
    }
  }
  async function retirer() {
    photo = null;
    erreur = "";
    announce(t("account.photo.removed"));
    await onchange?.(null);
  }
</script>

<div class={["av", { grand }]} style:--px="{px}px" role="group" aria-labelledby="{uid}-l" aria-describedby="{uid}-h{erreur ? ` ${uid}-e` : ''}">
  <p id="{uid}-l" class="l">{libelle ?? t("account.photo")} <span class="opt">· {t("account.photo.optional")}</span></p>
  <div class="ligne">
    <span class="rond" aria-hidden={url ? undefined : "true"}>
      {#if url}<img src={url} alt={t("account.photo.preview")} width={px} height={px} />{:else}<span class="ini">{initiale.slice(0, 1).toUpperCase()}</span>{/if}
    </span>
    <div class="btns">
      <Button variant="secondary" dense onpress={() => input?.click()}>
        {#snippet icon()}<Camera size={18} strokeWidth={1.75} />{/snippet}
        {photo ? t("account.photo.change") : t("account.photo.add")}
      </Button>
      {#if photo}<Button variant="ghost" dense onpress={retirer}>{t("account.photo.remove")}</Button>{/if}
    </div>
  </div>
  <input bind:this={input} class="sr-only" type="file" accept="image/*" tabindex="-1" aria-hidden="true" onchange={choisi} />
  <p id="{uid}-h" class="hint">{t("account.photo.hint")}</p>
  {#if erreur}<p id="{uid}-e" class="err" role="alert">{erreur}</p>{/if}
</div>

<style>
  .av {
    display: grid;
    gap: var(--sp-2);
  }
  .l {
    margin: 0;
    font-size: var(--fs-small);
    line-height: var(--lh-small);
    font-weight: 600;
    color: var(--text-2);
  }
  .opt {
    font-weight: 400;
    color: var(--text-3);
  }
  .ligne {
    display: flex;
    align-items: center;
    gap: var(--sp-4);
    flex-wrap: wrap;
  }
  .rond {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px);
    height: var(--px);
    border-radius: 50%;
    overflow: hidden;
    background: var(--surface-3);
    box-shadow: inset 0 0 0 1px var(--hair-2);
  }
  .rond img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ini {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--text-2);
  }
  .grand .ligne {
    flex-direction: column;
    justify-content: center;
  }
  .grand .l,
  .grand .hint,
  .grand .err {
    text-align: center;
  }
  .grand .ini {
    font-size: 2.25rem;
  }
  .btns {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
  }
  .hint,
  .err {
    margin: 0;
    font-size: var(--fs-small);
    line-height: var(--lh-small);
  }
  .hint {
    color: var(--text-3);
  }
  .err {
    color: var(--danger);
  }
</style>

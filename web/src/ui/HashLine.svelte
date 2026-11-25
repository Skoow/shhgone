<script lang="ts">
  // Empreinte SHA-256 d'un fichier, en petit sur sa
  // propre ligne, sous le type et la taille, alignée sur le nom, au même endroit chez l'expéditeur (calculée sur son appareil)
  // et chez le destinataire (lue dans le manifeste chiffré, donc celle de l'expéditeur).
  // Sélectionnée d'un toucher pour la copier, entière au survol ; coupée par « … » si la place
  // manque. `sum` : hexadécimal, « erreur », ou null (calcul en cours).
  import { t } from "../i18n/i18n.svelte";

  let { sum }: { sum: string | "erreur" | null } = $props();
  const hex = $derived(sum && sum !== "erreur" ? sum : undefined);
</script>

<span class="hash" data-sha256={hex} title={hex}
  ><span class="hk">SHA-256</span> {sum === null ? t("compose.hash.computing") : sum === "erreur" ? t("compose.hash.failed") : sum}</span
>

<style>
  /* Toute une ligne du bloc .meta (flex qui passe à la ligne), toujours la dernière. */
  .hash {
    display: block;
    order: 9;
    flex: 0 0 100%;
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-overflow: ellipsis;
    user-select: all;
  }
  .hk {
    color: var(--text-2);
    user-select: none;
  }
</style>

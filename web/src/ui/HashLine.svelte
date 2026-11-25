<script lang="ts">
  // Empreinte SHA-256 d'un fichier, au même endroit chez l'expéditeur (calculée sur son appareil)
  // et chez le destinataire (lue dans le manifeste chiffré, donc celle de l'expéditeur).
  // Repliée dans « Détails » (audit du 25 novembre : utile à quelques-uns, bruit pour tous) ;
  // ouverte, sur sa propre ligne, sélectionnée d'un toucher pour la copier, entière au survol,
  // coupée par « … » si la place manque. `sum` : hexadécimal, « erreur », ou null (calcul en
  // cours) ; `name` : nom du fichier, pour les lecteurs d'écran (plusieurs « Détails » par page).
  import { t } from "../i18n/i18n.svelte";

  let { sum, name = "" }: { sum: string | "erreur" | null; name?: string } = $props();
  const hex = $derived(sum && sum !== "erreur" ? sum : undefined);
</script>

<details class="hash" data-sha256={hex}>
  <summary
    >{t("compose.hash.details")}{#if name}<span class="sr-only">{" · "}<bdi>{name}</bdi></span>{/if}</summary
  >
  <span class="hv" title={hex}
    ><span class="hk">SHA-256</span> {sum === null ? t("compose.hash.computing") : sum === "erreur" ? t("compose.hash.failed") : sum}</span
  >
</details>

<style>
  /* Toute une ligne du bloc .meta (flex qui passe à la ligne), toujours la dernière. */
  .hash {
    display: block;
    order: 9;
    flex: 0 0 100%;
    min-width: 0;
    color: var(--text-3);
    font-size: 0.75rem;
  }
  summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 24px;
    list-style: none;
    cursor: pointer;
    color: var(--text-3);
    font-weight: 560;
  }
  /* Toucher : cible de 44 px (règle du téléphone), sans agrandir la ligne (marges négatives). */
  @media (pointer: coarse) {
    summary {
      min-height: 44px;
      min-width: 44px;
      margin-block: -10px;
    }
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary::after {
    content: "";
    width: 5px;
    height: 5px;
    border-inline-end: 1.5px solid currentColor;
    border-block-end: 1.5px solid currentColor;
    transform: rotate(-45deg);
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .hash[open] summary::after {
    transform: rotate(45deg);
  }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  @media (hover: hover) {
    summary:hover {
      color: var(--text-2);
    }
  }
  .hv {
    display: block;
    min-width: 0;
    overflow: hidden;
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
  @media (prefers-reduced-motion: reduce) {
    summary::after {
      transition: none;
    }
  }
</style>

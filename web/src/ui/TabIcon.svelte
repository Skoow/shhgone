<script lang="ts">
  // Icônes maison de la barre d'onglets (24 × 24, trait 1,8) ; « chat » sert aussi
  // au bouton Salon de l'accueil.
  import type { TabId } from "../app/tabbar";
  let { id, size = 22 }: { id: TabId; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  {#if id === "send"}
    <!-- « Nouveau » : un plus (nouveau partage). -->
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  {:else if id === "shares"}
    <!-- « Partages » : une horloge (ce qui s'efface à son heure). -->
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  {:else if id === "logout"}
    <!-- log-out -->
    <path d="M9.5 20H6.5A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4h3" />
    <path d="m16 16.5 4.5-4.5L16 7.5" />
    <path d="M20.5 12H9.5" />
  {:else if id === "profile"}
    <circle cx="12" cy="8.5" r="3.75" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  {:else if id === "downloads"}
    <path d="M12 4v10.5" />
    <path d="m7.5 10 4.5 4.5 4.5-4.5" />
    <path d="M4.5 15.5v2A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-2" />
  {:else}
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v4a2.5 2.5 0 0 1-2.5 2.5H9.5L6 16v-3.1a2.5 2.5 0 0 1-2-2.4z" />
    <path d="M19 9a2.5 2.5 0 0 1 1 2v3.5a2.5 2.5 0 0 1-2 2.4V20l-3.5-3H12a2.5 2.5 0 0 1-2.2-1.3" />
  {/if}
</svg>

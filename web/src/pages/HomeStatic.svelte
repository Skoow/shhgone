<script lang="ts">
  // Accueil rendu au build (référencement) : la coque et l'accueil sans composeur,
  // écrits dans index.html pour les moteurs de recherche et l'affichage avant le script. Le script
  // de la page (src/main.ts) remplace ce contenu au montage par l'application vivante.
  import Home from "../routes/Home.svelte";
  import AppShell from "../ui/AppShell.svelte";
</script>

<AppShell>
  <Home />
</AppShell>

<script lang="ts">
  // Squelette des pages de l'application : la coque sans
  // contenu, écrite dans app.html au build (« /envoyer », « /envois », compte, salon, 404). Avant
  // l'arrivée du script, la page montre déjà la nuit, l'aurore et le logo au lieu d'un écran vide ;
  // tout ce qui a du texte ou ne marcherait qu'avec le script est caché (base.css,
  // #app[data-squelette]). Le script le remplace au montage (main.ts), en gardant l'ambiance.
  import AppShell from "../ui/AppShell.svelte";
</script>

<AppShell>{""}</AppShell>

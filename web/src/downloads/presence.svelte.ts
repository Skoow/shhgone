// « Téléchargements » (menu ☰, pied de page) sans compte : montré seulement si l'historique des
// téléchargements est activé sur cet appareil (UI §26). Module léger, sans dépendance : l'en-tête
// et le menu des pages d'information le lisent sans charger le moteur. L'application le pose
// d'après downloads/live.svelte.ts ; les pages d'information lisent le seul drapeau « on » de la
// base des téléchargements, sans clé ni création (downloads/probe.ts).
export const presence = $state({ downloads: false });

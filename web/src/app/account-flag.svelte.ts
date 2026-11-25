// Compte ouvert sur cet appareil, vu par la coque (en-tête, menu, pied, onglets) : un seul
// booléen, posé par history/live.svelte.ts (setAccountPrefs). Module à part pour que la coque des
// pages d'information n'emporte ni l'historique, ni le client d'envoi, ni le moteur (pages
// séparées). `logout` : « Se déconnecter » du menu, posé par
// App.svelte avec __COMPTES__ (la coque n'importe rien du compte, source-rules.test.ts).
export const accountFlag = $state<{ connected: boolean; logout: null | (() => Promise<void>) }>({ connected: false, logout: null });

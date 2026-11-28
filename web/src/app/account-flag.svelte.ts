// Compte ouvert sur cet appareil, vu par la coque (en-tête, menu, pied, onglets) : un seul
// booléen, posé par la session du compte (account/session.svelte.ts). Module à part pour que la
// coque des pages d'information n'emporte ni le compte, ni le client d'envoi, ni le moteur (pages
// séparées ; source-rules.test.ts : la coque n'importe rien du compte). `logout` : « Se
// déconnecter » de la barre du bas (téléphone) et de la ligne du haut (ordinateur), posé par
// App.svelte avec __COMPTES__ (26 novembre) ; null ailleurs (pages d'information : la coque
// montre alors « Mon compte » seul).
export const accountFlag = $state<{ connected: boolean; logout: null | (() => Promise<void>) }>({ connected: false, logout: null });

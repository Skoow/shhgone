// Suppression totale du compte (conception compte §21.12 ; « suppression simplifiée »). On
// supprime ce dont la personne est l'auteur ou l'admin, et rien de plus n'est promis :
// (1) POST /api/compte/supprimer : le serveur ferme les salons créés (lien compte ↔ salon), efface
//     les lignes, les deux coffres et l'empreinte du pseudo ;
// (2) l'appareil oublie le compte, et efface aussi ses données si la personne l'a demandé.
// Les partages créés ne sont pas détruits ici : depuis le retrait de l'historique local des liens
// (25 novembre, spec §33), ni l'appareil ni le compte ne gardent leurs liens de gestion. Ils
// s'effacent à leur échéance, ou plus tôt par leur lien de gestion. L'écran le dit.
// Fonctions pures et dépendances injectées : session.svelte.ts les branche.

export type Progres = { etape: "compte" } | { etape: "fini"; salonsFermes: number };

export type DepsSuppression = {
  /** Vérifications avant toute suppression (attente après une récupération) ; rejette pour arrêter. */
  avant: () => Promise<void>;
  /** POST supprimer ; rend le nombre de salons fermés. */
  supprimerCompte: () => Promise<number>;
  /** L'appareil oublie le compte (session, copie gardée). */
  oublierCompte: () => Promise<void>;
  /** Effacement des données de l'appareil (storage/appareil.ts), si demandé. */
  effacerAppareil: () => Promise<void>;
};

export async function* supprimerTout(o: { effacerAppareil: boolean }, d: DepsSuppression): AsyncGenerator<Progres> {
  await d.avant();
  yield { etape: "compte" };
  const salonsFermes = await d.supprimerCompte();
  await d.oublierCompte();
  if (o.effacerAppareil) await d.effacerAppareil();
  yield { etape: "fini", salonsFermes };
}

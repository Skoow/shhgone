// Historique local des liens retiré le 25 novembre (spec §33, décision D-H3) : la base
// `shhdrop-history` d'un appareil qui l'avait activé (liens de gestion, liens reçus, salons,
// chiffrés sous une clé gardée dans la même base) est supprimée au démarrage, clé comprise.
// Aucune base absente n'est créée (deleteDatabase ne crée rien) ; une base tenue par un autre
// onglet est supprimée dès qu'il la relâche ; aucune erreur ne remonte.
export const ANCIEN_HISTORIQUE = "shhdrop-history";

export function effacerAncienHistorique(idb: Pick<IDBFactory, "deleteDatabase"> | undefined = globalThis.indexedDB): Promise<void> {
  if (!idb) return Promise.resolve();
  return new Promise((ok) => {
    try {
      const r = idb.deleteDatabase(ANCIEN_HISTORIQUE);
      r.onsuccess = () => ok();
      r.onerror = () => ok();
      r.onblocked = () => ok();
    } catch {
      ok(); // navigation privée stricte, stockage refusé
    }
  });
}

// Bases retirées, supprimées au démarrage (application, pages d'information, « /s »), clé comprise :
// - `shhdrop-history` : historique local des liens, retiré le 25 novembre (spec §33, décision
//   D-H3 : liens de gestion, liens reçus, salons, chiffrés sous une clé gardée dans la même base) ;
// - `shhdrop-telechargements` : historique des fichiers reçus (page « Téléchargements »), retiré le
//   28 novembre (D42-33 : noms, tailles et heures des fichiers enregistrés, chiffrés de même).
// Aucune base absente n'est créée (deleteDatabase ne crée rien) ; une base tenue par un autre
// onglet est supprimée dès qu'il la relâche ; aucune erreur ne remonte.
export const ANCIEN_HISTORIQUE = "shhdrop-history";
export const ANCIENS_TELECHARGEMENTS = "shhdrop-telechargements";
export const BASES_RETIREES: readonly string[] = [ANCIEN_HISTORIQUE, ANCIENS_TELECHARGEMENTS];

function supprimer(idb: Pick<IDBFactory, "deleteDatabase">, nom: string): Promise<void> {
  return new Promise((ok) => {
    try {
      const r = idb.deleteDatabase(nom);
      r.onsuccess = () => ok();
      r.onerror = () => ok();
      r.onblocked = () => ok();
    } catch {
      ok(); // navigation privée stricte, stockage refusé
    }
  });
}

export async function effacerAncienHistorique(idb: Pick<IDBFactory, "deleteDatabase"> | undefined = globalThis.indexedDB): Promise<void> {
  if (!idb) return;
  await Promise.all(BASES_RETIREES.map((n) => supprimer(idb, n)));
}

// « Téléchargements » sans compte (menu, pied de page) seulement si l'historique des
// téléchargements est activé sur cet appareil (décision du propriétaire du 22 novembre, UI §26).
// Module léger pour les pages d'information : ni clé, ni store.ts, ni moteur. Rien n'est créé ni
// écrit ; aucune requête réseau.
import { presence } from "../history/presence.svelte";

const DOWNLOADS_DB = "shhdrop-telechargements";

/**
 * Pages d'information : vrai si la base des téléchargements existe ET porte le drapeau « on »
 * (historique activé par la personne). Rien n'est créé ni écrit : base ouverte seulement si elle
 * existe, création annulée sinon ; seule la valeur `flag:on` du magasin `meta` est lue.
 */
export async function probeDownloads(idb: Pick<IDBFactory, "databases" | "open"> | undefined = globalThis.indexedDB): Promise<void> {
  try {
    const dbs = (await idb?.databases?.()) ?? [];
    if (!idb || !dbs.some((d) => d.name === DOWNLOADS_DB)) return;
    const on = await new Promise<unknown>((ok) => {
      const r = idb.open(DOWNLOADS_DB);
      r.onupgradeneeded = () => {
        r.transaction?.abort(); // la base n'existait plus : ne pas la créer vide
        ok(undefined);
      };
      r.onerror = () => ok(undefined);
      r.onblocked = () => ok(undefined);
      r.onsuccess = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("meta")) {
          d.close();
          return ok(undefined);
        }
        const g = d.transaction("meta", "readonly").objectStore("meta").get("flag:on");
        g.onsuccess = () => {
          d.close();
          ok(g.result);
        };
        g.onerror = () => {
          d.close();
          ok(undefined);
        };
      };
    });
    if (on === true) presence.downloads = true;
  } catch {
    // Navigation privée, stockage refusé : rien à montrer.
  }
}

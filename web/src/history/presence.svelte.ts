// « Mes partages » n'est montré que s'il y a quelque chose dedans. Module léger, sans dépendance : l'en-tête et le menu des pages d'information le
// lisent sans charger l'historique ni le moteur. Rien n'est écrit : on lit seulement.
//  - Accueil, envoi, page « /s » : l'historique de l'appareil est lu (live.svelte.ts) et pose
//    `any` d'après ses entrées.
//  - Pages d'information : seule l'existence de la base de l'historique est vérifiée
//    (indexedDB.databases(), sans l'ouvrir ni la créer) ; une base vide compte comme « quelque
//    chose » (rare : la liste dit alors qu'elle est vide).
//  - « Téléchargements » (menu ☰, pied de page) sans compte : seulement si l'historique des
//    téléchargements est activé sur cet appareil (`downloads`, UI §26). L'application le pose d'après
//    downloads/live.svelte.ts ; les pages d'information lisent le seul drapeau « on » de la base
//    des téléchargements, sans clé ni création (downloads/probe.ts, seul module avec store.ts à
//    nommer cette base).
export const presence = $state({ any: false, downloads: false });

const HISTORY_DB = "shhdrop-history";

/**
 * Pages d'information : vrai si la base de l'historique existe ET contient au moins une entrée
 * (relecture : une base restée vide, après « Ne pas garder » ou « Effacer
 * l'historique », ne montre plus « Mes partages »). Les entrées sont chiffrées : on ne fait que
 * les compter, sans clé. Rien n'est créé : la base n'est ouverte que si elle existe, et une
 * création (base supprimée entre-temps) est annulée.
 */
export async function probeHistory(idb: Pick<IDBFactory, "databases" | "open"> | undefined = globalThis.indexedDB): Promise<void> {
  try {
    const dbs = (await idb?.databases?.()) ?? [];
    if (!idb || !dbs.some((d) => d.name === HISTORY_DB)) return;
    const n = await new Promise<number>((ok) => {
      const r = idb.open(HISTORY_DB);
      r.onupgradeneeded = () => {
        r.transaction?.abort(); // la base n'existait plus : ne pas la créer vide
        ok(0);
      };
      r.onerror = () => ok(0);
      r.onblocked = () => ok(0);
      r.onsuccess = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("entries")) {
          d.close();
          return ok(0);
        }
        const c = d.transaction("entries", "readonly").objectStore("entries").count();
        c.onsuccess = () => {
          d.close();
          ok(c.result);
        };
        c.onerror = () => {
          d.close();
          ok(0);
        };
      };
    });
    if (n > 0) presence.any = true;
  } catch {
    // Navigation privée, stockage refusé : rien à montrer.
  }
}

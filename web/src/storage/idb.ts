// Stockage chiffré de l'appareil : accès à une base IndexedDB (ou à la mémoire, pour la démo et
// les tests) qui garde des enregistrements déjà chiffrés et leur clé WebCrypto non extractible.
// Utilisé par les retours sur un partage ouvert (storage/returns.ts), l'historique des
// téléchargements (downloads/store.ts), le pass des offres (paiement/pass.ts) et la session du
// compte (account/persist.ts), chacun dans sa propre base. Aucune requête réseau ici.

/** Enregistrement chiffré tel qu'il est stocké. */
export type Rec = { iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> };

/** Accès au stockage (IndexedDB, ou mémoire pour la démo et les tests). */
export type Backend = {
  /** La base existe déjà (sans la créer : une simple visite n'écrit rien). */
  exists(): Promise<boolean>;
  /** Clé déjà gardée, sinon `fresh` est gardée (atomique) ; rend celle qui fait foi. */
  key(fresh: CryptoKey): Promise<CryptoKey>;
  all(): Promise<[string, Rec][]>;
  put(id: string, rec: Rec): Promise<void>;
  del(id: string): Promise<void>;
  clear(): Promise<void>;
  flag(name: string): Promise<unknown>;
  setFlag(name: string, v: unknown): Promise<void>;
  /** Supprime toute la base (clé comprise) ; une écriture suivante la recrée. */
  drop(): Promise<void>;
};

// ---------- IndexedDB ----------

const META = "meta";
const ENTRIES = "entries";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, ko) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error ?? new Error("idb"));
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((ok, ko) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => ko(tx.error ?? new Error("idb"));
    tx.onabort = () => ko(tx.error ?? new Error("idb"));
  });
}

/** Base `name` (chaque usage a la sienne, même mécanisme). */
export function idbBackend(idb: IDBFactory, name: string): Backend {
  let opened: Promise<IDBDatabase> | undefined;
  /**
   * Un autre onglet supprime ou fait monter la base : on lâche la connexion (sinon sa
   * suppression resterait bloquée et toutes les ouvertures suivantes attendraient) ; la
   * prochaine opération rouvre (relecture, A).
   */
  const yieldOn = (d: IDBDatabase) => {
    d.onversionchange = () => {
      d.close();
      opened = undefined;
    };
    return d;
  };
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((ok, ko) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
        if (!d.objectStoreNames.contains(ENTRIES)) d.createObjectStore(ENTRIES);
      };
      r.onsuccess = () => ok(yieldOn(r.result));
      r.onerror = () => ko(r.error ?? new Error("idb"));
      r.onblocked = () => ko(new Error("idb_bloquee"));
    }).catch((e: unknown) => {
      opened = undefined; // échec passager (base occupée) : la prochaine opération rouvre
      throw e;
    }));
  async function write(store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
    const tx = (await db()).transaction(store, "readwrite");
    const end = done(tx);
    fn(tx.objectStore(store));
    await end;
  }
  return {
    async exists() {
      if (opened) return true;
      // Ouverture sans création : une base neuve voit sa création annulée (rien n'est écrit).
      const found = await new Promise<IDBDatabase | null>((ok, ko) => {
        const r = idb.open(name, 1);
        let fresh = false;
        r.onupgradeneeded = () => {
          fresh = true;
          r.transaction?.abort();
        };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => (fresh ? ok(null) : ko(r.error ?? new Error("idb")));
        r.onblocked = () => ko(new Error("idb_bloquee"));
      });
      if (found === null) return false;
      opened = Promise.resolve(yieldOn(found));
      return true;
    },
    async key(fresh) {
      // Lecture et écriture dans la même transaction : deux onglets ouverts en même temps
      // gardent la même clé (sinon l'un ne relirait plus les entrées de l'autre).
      const tx = (await db()).transaction(META, "readwrite");
      const end = done(tx);
      const s = tx.objectStore(META);
      let k: CryptoKey = fresh;
      const g = s.get("key");
      g.onsuccess = () => {
        if (g.result instanceof CryptoKey) k = g.result;
        else s.put(fresh, "key");
      };
      await end;
      return k;
    },
    async all() {
      const tx = (await db()).transaction(ENTRIES, "readonly");
      const s = tx.objectStore(ENTRIES);
      const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return keys.map((k, i) => [String(k), vals[i] as Rec]);
    },
    put: (id, rec) => write(ENTRIES, (s) => s.put(rec, id)),
    del: (id) => write(ENTRIES, (s) => s.delete(id)),
    clear: () => write(ENTRIES, (s) => s.clear()),
    async flag(name) {
      const tx = (await db()).transaction(META, "readonly");
      return req(tx.objectStore(META).get("flag:" + name));
    },
    setFlag: (name, v) => write(META, (s) => (v === undefined ? s.delete("flag:" + name) : s.put(v, "flag:" + name))),
    async drop() {
      const was = opened;
      opened = undefined;
      (await was?.catch(() => null))?.close();
      await new Promise<void>((ok, ko) => {
        const r = idb.deleteDatabase(name);
        r.onsuccess = () => ok();
        r.onerror = () => ko(r.error ?? new Error("idb"));
        r.onblocked = () => ok(); // un autre onglet la tient : supprimée à sa fermeture
      });
    },
  };
}

/** Démo (origine partagée de GitHub Pages : aucun IndexedDB) et tests : en mémoire seulement. */
export function memoryBackend(): Backend & { raw(): Map<string, Rec> } {
  let k: CryptoKey | undefined;
  const m = new Map<string, Rec>();
  const flags = new Map<string, unknown>();
  return {
    raw: () => m,
    exists: async () => k !== undefined,
    key: async (fresh) => (k ??= fresh),
    all: async () => [...m],
    put: async (id, rec) => void m.set(id, rec),
    del: async (id) => void m.delete(id),
    clear: async () => m.clear(),
    flag: async (n) => flags.get(n),
    setFlag: async (n, v) => void (v === undefined ? flags.delete(n) : flags.set(n, v)),
    drop: async () => {
      m.clear();
      flags.clear();
      k = undefined;
    },
  };
}

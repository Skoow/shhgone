// Historique de l'appareil (spec §33, §33.1 ; UI §9.6 ; conception compte §21.7, §21.8).
// EXCEPTION ÉCRITE à « aucun stockage navigateur » (UI §12.1, source-rules.test.ts) : seul ce
// module touche IndexedDB et les secrets stockés.
// - Quatre sortes d'entrées (`sorte`) : envoi (« Lien prêt »), recu (partage ouvert), salon_cree,
//   salon_rejoint ; `origine` : local (créée sur cet appareil) ou compte (reçue du coffre privé
//   d'un compte, retirée à la déconnexion, §37.11 A-G8). Une entrée d'avant (sans ces champs) se
//   relit en envoi local.
// - Exception écrite de la conception compte §21.8 : une entrée reçue ou de salon garde son lien
//   (« #<K_lien> », « #c<K_lien> »). Il ne suffit jamais seul : le mot de passe reste nécessaire
//   et n'est JAMAIS gardé. Un envoi ne garde que son lien de gestion, jamais son lien de partage.
// - Chaque entrée est chiffrée AES-256-GCM (WebCrypto) avec une clé créée NON EXTRACTIBLE et
//   gardée dans IndexedDB ; nonce aléatoire de 96 bits à chaque écriture ; l'identifiant
//   (tiré au hasard, sans lien avec le partage) est la donnée associée authentifiée.
//   Honnêtement (spec §33) : la clé est sur le même appareil ; ce chiffrement ne protège que
//   d'une lecture naïve du stockage. La vraie protection est le verrouillage de l'appareil.
// - Une entrée ne contient que : le lien de gestion (S_gestion), l'heure locale de création,
//   la taille, le nombre d'éléments, l'échéance, le maximum d'ouvertures, les ouvertures
//   observées, l'état et le nom du partage (`label` :
//   celui du manifeste, renommable ici sans changer ce que voit le destinataire ; chiffré comme
//   le reste de l'entrée). JAMAIS K_lien, le lien de partage, le mot de passe, un nom d'élément
//   ou un contenu : tout champ inconnu est ignoré (`clean`).
// - Entrée terminée (détruite ou expirée) retirée 7 jours après sa fin.
// - Stockage absent ou refusé : openHistory rend null et le site marche sans historique.
// Aucune requête réseau ici (relectures : poll.ts).

import { TITLE_MAX } from "../limits";

export type HistoryState = "ready" | "draining" | "gone" | "expired";
export type Opening = { count: number; between: [number, number] };
export type Sorte = "envoi" | "recu" | "salon_cree" | "salon_rejoint";
export type Origine = "local" | "compte";
/** Sorte dominante d'un partage reçu (icône) : familles de ui/formats.ts ; "" hors reçu. */
export const FORMATS = ["pdf", "doc", "sheet", "slides", "text", "code", "archive", "image", "video", "audio", "exec", "disk", "font", "book", "note", "file"] as const;
export type HistoryEntry = {
  id: string;
  sorte: Sorte;
  origine: Origine;
  /** Envoi : lien de gestion « https://…/s#m<S_gestion> » ; salon créé : « https://…/salon#s<S_gestion> » ; chiffré au repos ; "" sinon. */
  manage: string;
  /** Reçu : lien « https://…/s#<K_lien> » ; salon : invitation « https://…/#c<K_lien> » ; "" pour un envoi. */
  link: string;
  /**
   * Libellé local d'un salon (64 caractères au plus) ; envoi : titre du partage (* TITLE_MAX points de code au plus, déjà nettoyé par le moteur) ; "" sinon.
   */
  label: string;
  /** Reçu : sorte dominante (FORMATS) ; "" sinon. */
  format: string;
  /** Heure locale exacte de la création, de l'ouverture ou de l'entrée (jamais envoyée). */
  createdAt: number;
  sizeBytes: number;
  itemsCount: number;
  /** Échéance (ms), d'après le serveur. */
  expiresAt: number;
  maxOpens: number;
  /** Dernier compteur d'ouvertures connu. */
  opensUsed: number;
  /** Changements du compteur observés entre deux relectures (spec §33). */
  opens: Opening[];
  state: HistoryState;
  /** Dernier état connu (création ou dernière relecture réussie). */
  lastSeenAt: number;
  /** Fin observée (détruit, expiré) ; 0 tant que le partage est actif. */
  endedAt: number;
  /** Détruit depuis cet appareil (sinon : constaté absent du serveur). */
  destroyedHere: boolean;
};
export type NewEntry = Pick<HistoryEntry, "manage" | "createdAt" | "sizeBytes" | "itemsCount" | "expiresAt" | "maxOpens"> &
  Partial<Pick<HistoryEntry, "sorte" | "link" | "label" | "format">>;
export type Patch = Partial<Omit<HistoryEntry, "id" | "sorte" | "origine" | "manage" | "link" | "createdAt" | "sizeBytes" | "itemsCount">>;

export const HISTORY_KEEP_GONE_MS = 7 * 86_400_000;

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

const MANAGE_LINK = /^https?:\/\/[^#\s]+#m[A-Za-z0-9_-]{43}$/;
const SHARE_LINK = /^https?:\/\/[^#\s]+#[A-Za-z0-9_-]{43}$/;
const ROOM_LINK = /^https?:\/\/[^#\s]+#c[A-Za-z0-9_-]{43}$/;
/** Lien de gestion d'un salon créé ici (« #s<S_gestion> »), chiffré au repos. */
const ROOM_MANAGE_LINK = /^https?:\/\/[^#\s]+#s[A-Za-z0-9_-]{43}$/;
const SORTES: readonly Sorte[] = ["envoi", "recu", "salon_cree", "salon_rejoint"];
const LABEL_MAX = 64;
/** Nom d'un envoi : TITLE_MAX (limits.ts) points de code au plus ; ni commande C0, DEL ni C1. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const ID = /^[A-Za-z0-9_-]{22}$/;
const STATES: readonly HistoryState[] = ["ready", "draining", "gone", "expired"];
const AAD = "shhdrop/history/v1/";

// ---------- IndexedDB ----------

const DB = "shhdrop-history";
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

/** Base `name` (l'historique par défaut ; history/returns.ts a la sienne, même mécanisme). */
export function idbBackend(idb: IDBFactory, name = DB): Backend {
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

// ---------- Validation : seuls les champs connus, bien typés ----------

const int = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min;

/**
 * Entrée validée champ par champ, ou null. Tout champ inconnu (mot de passe, noms, contenu…) est
 * ignoré. Lien selon la sorte : envoi → lien de gestion seulement ; reçu → lien de partage
 * seulement ; salon → invitation « #c » seulement. Sans sorte ni origine (entrée d'avant le lot
 * 11) : envoi local.
 */
export function cleanEntry(x: unknown): HistoryEntry | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID.test(o.id)) return null;
  const sorte = o.sorte === undefined ? "envoi" : o.sorte;
  const origine = o.origine === undefined ? "local" : o.origine;
  if (!SORTES.includes(sorte as Sorte) || (origine !== "local" && origine !== "compte")) return null;
  const manage = o.manage ?? "";
  const link = o.link ?? "";
  const label = o.label ?? "";
  const format = o.format ?? "";
  if (typeof manage !== "string" || typeof link !== "string" || typeof label !== "string" || typeof format !== "string") return null;
  if (sorte === "envoi") {
    if (!MANAGE_LINK.test(manage) || link !== "" || format !== "") return null;
    if ([...label].length > TITLE_MAX || CONTROLS.test(label)) return null;
  } else {
    // Salon créé : son lien de gestion (S_gestion) peut être gardé ; aucune autre sorte n'en a.
    if (manage !== "" && !(sorte === "salon_cree" && ROOM_MANAGE_LINK.test(manage))) return null;
    if (sorte === "recu" ? !SHARE_LINK.test(link) || label !== "" || !(FORMATS as readonly string[]).includes(format) : !ROOM_LINK.test(link) || format !== "") return null;
    if (label.length > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) return null;
  }
  for (const k of ["createdAt", "sizeBytes", "itemsCount", "expiresAt", "opensUsed", "lastSeenAt", "endedAt"]) if (!int(o[k])) return null;
  if (!int(o.maxOpens, sorte === "envoi" ? 1 : 0)) return null;
  if (!STATES.includes(o.state as HistoryState) || typeof o.destroyedHere !== "boolean" || !Array.isArray(o.opens)) return null;
  const opens: Opening[] = [];
  for (const p of o.opens.slice(-32)) {
    const q = p as Record<string, unknown> | null;
    const b = q?.between;
    if (!q || !int(q.count, 1) || !Array.isArray(b) || b.length !== 2 || !int(b[0]) || !int(b[1])) return null;
    opens.push({ count: q.count as number, between: [b[0] as number, b[1] as number] });
  }
  return {
    id: o.id,
    sorte: sorte as Sorte,
    origine: origine as Origine,
    manage,
    link,
    label,
    format,
    createdAt: o.createdAt as number,
    sizeBytes: o.sizeBytes as number,
    itemsCount: o.itemsCount as number,
    expiresAt: o.expiresAt as number,
    maxOpens: o.maxOpens as number,
    opensUsed: o.opensUsed as number,
    opens,
    state: o.state as HistoryState,
    lastSeenAt: o.lastSeenAt as number,
    endedAt: o.endedAt as number,
    destroyedHere: o.destroyedHere,
  };
}

/** Ce qui identifie le partage ou le salon d'une entrée, d'un appareil à l'autre : son lien. */
export const linkKey = (e: Pick<HistoryEntry, "sorte" | "manage" | "link">): string => (e.sorte === "envoi" ? e.manage.slice(e.manage.lastIndexOf("#")) : e.link.slice(e.link.lastIndexOf("#")));

// ---------- État affiché, tri ----------

/** État à afficher : un partage actif dont l'échéance est passée est expiré (sans requête). */
export function effectiveState(e: HistoryEntry, now: number): HistoryState {
  if ((e.state === "ready" || e.state === "draining") && now >= e.expiresAt) return "expired";
  return e.state;
}
export const isActive = (e: HistoryEntry, now: number) => {
  const s = effectiveState(e, now);
  return s === "ready" || s === "draining";
};
/** Fin de l'entrée (pour le tri et le retrait à 7 jours). */
export function endOf(e: HistoryEntry, now: number): number {
  if (e.state === "gone" || e.state === "expired") return e.endedAt || e.expiresAt;
  return effectiveState(e, now) === "expired" ? e.expiresAt : 0;
}

/** UI §9.6.2 : en cours d'effacement, puis actifs par échéance croissante, puis terminés (fin la plus récente d'abord). */
export function sortEntries(list: readonly HistoryEntry[], now: number): HistoryEntry[] {
  const rank = (e: HistoryEntry) => ({ draining: 0, ready: 1, gone: 2, expired: 2 })[effectiveState(e, now)];
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) < 2) return a.expiresAt - b.expiresAt;
    return endOf(b, now) - endOf(a, now);
  });
}

// ---------- Ouverture ----------

export type History = {
  list(): Promise<HistoryEntry[]>;
  get(id: string): Promise<HistoryEntry | null>;
  /** Ajoute une entrée de cet appareil ; même lien (gestion, partage, invitation) déjà gardé : celle-là. */
  add(e: NewEntry): Promise<HistoryEntry>;
  /** Garde une entrée entière (venue du compte) ; faux si une entrée du même lien est déjà là. */
  put(e: HistoryEntry): Promise<boolean>;
  update(id: string, patch: Patch): Promise<HistoryEntry | null>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  enabled(): Promise<boolean>;
  setEnabled(v: boolean): Promise<void>;
};

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const aad = (id: string) => new TextEncoder().encode(AAD + id);

/**
 * Ouvre l'historique. `backend` null ou toute erreur (IndexedDB absent, refusé, écriture de la
 * clé impossible, WebCrypto absent) : null, le site marche sans historique.
 */
export async function openHistory(deps: { backend: Backend | null; now?: () => number; persist?: () => Promise<unknown> }): Promise<History | null> {
  const now = deps.now ?? Date.now;
  // (« Mes partages » doit retrouver mes liens d'une visite à l'autre) :
  // à la première entrée gardée, le navigateur est prié de ne pas effacer ce stockage quand la
  // place manque (navigator.storage.persist). Une fois par ouverture, jamais attendu ; un refus
  // ou une erreur ne change rien (l'historique marche comme avant). Pas à la simple visite :
  // Firefox peut poser la question, elle n'a de sens qu'une fois un partage gardé.
  let askedPersist = false;
  const askPersist = () => {
    if (askedPersist || !deps.persist) return;
    askedPersist = true;
    void deps.persist().catch(() => undefined);
  };
  const b = deps.backend;
  if (b === null) return null;
  let key: CryptoKey;
  try {
    const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    key = await b.key(fresh);
  } catch {
    return null;
  }

  async function seal(e: HistoryEntry): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const { id, ...body } = e;
    const pt = new TextEncoder().encode(JSON.stringify(body));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(id) }, key, pt));
    pt.fill(0);
    await b!.put(id, { iv, ct });
  }
  async function open(id: string, r: Rec): Promise<HistoryEntry | null> {
    try {
      if (!ID.test(id) || !(r?.iv instanceof Uint8Array) || !(r.ct instanceof Uint8Array)) return null;
      const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: r.iv, additionalData: aad(id) }, key, r.ct));
      const v = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
      pt.fill(0);
      return cleanEntry({ ...v, id });
    } catch {
      return null;
    }
  }
  async function all(): Promise<HistoryEntry[]> {
    const t = now();
    const out: HistoryEntry[] = [];
    for (const [id, r] of await b!.all()) {
      const e = await open(id, r);
      const end = e ? endOf(e, t) : 0;
      // Illisible (clé perdue, enregistrement abîmé) ou terminé depuis 7 jours : retiré.
      if (e === null || (end > 0 && t - end >= HISTORY_KEEP_GONE_MS)) await b!.del(id).catch(() => undefined);
      else out.push(e);
    }
    return out;
  }

  const h: History = {
    list: async () => sortEntries(await all(), now()),
    async get(id) {
      return (await all()).find((e) => e.id === id) ?? null;
    },
    async add(n) {
      const t = now();
      const e = cleanEntry({
        id: randomId(),
        sorte: n.sorte ?? "envoi",
        origine: "local",
        manage: n.manage,
        link: n.link ?? "",
        label: n.label ?? "",
        format: n.format ?? "",
        createdAt: n.createdAt,
        sizeBytes: n.sizeBytes,
        itemsCount: n.itemsCount,
        expiresAt: n.expiresAt,
        maxOpens: n.maxOpens,
        opensUsed: 0,
        opens: [],
        state: "ready",
        lastSeenAt: Math.min(t, n.createdAt),
        endedAt: 0,
        destroyedHere: false,
      });
      if (e === null) throw new Error("entree_invalide");
      const same = (await all()).find((x) => linkKey(x) === linkKey(e));
      if (same) return same;
      await seal(e);
      askPersist();
      return e;
    },
    async put(x) {
      const e = cleanEntry(x);
      if (e === null) throw new Error("entree_invalide");
      if ((await all()).some((y) => y.id === e.id || linkKey(y) === linkKey(e))) return false;
      await seal(e);
      return true;
    },
    async update(id, patch) {
      const old = await h.get(id);
      if (!old) return null;
      const e = cleanEntry({ ...old, ...patch, id: old.id, sorte: old.sorte, origine: old.origine, manage: old.manage, link: old.link });
      if (e === null) throw new Error("entree_invalide");
      await seal(e);
      return e;
    },
    remove: (id) => b.del(id),
    clear: () => b.clear(),
    // « Garder dans mon historique » : désactivé par défaut, activé
    // seulement par un geste de la personne (setEnabled(true)) : drapeau « on ». L'ancien drapeau
    // « off » (activé par défaut) ne vaut plus rien et part au premier choix.
    // Les entrées déjà gardées restent : elles portent des liens de gestion, seul moyen de
    // supprimer ces partages ; « Effacer l'historique » ou « Oublier » les retire.
    enabled: async () => (await b.flag("on")) === true,
    async setEnabled(v) {
      await b.setFlag("on", v ? true : undefined);
      await b.setFlag("off", undefined);
    },
  };
  // Écriture d'essai : un stockage en lecture seule ou plein se voit tout de suite.
  try {
    await b.setFlag("probe", undefined);
  } catch {
    return null;
  }
  return h;
}

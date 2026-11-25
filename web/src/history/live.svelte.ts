// État partagé de l'historique de l'appareil pour les écrans (accueil, « Vos envois », « Lien
// prêt », ouverture d'un partage). `entries` : les envois seulement (« Vos envois », bandeau de
// l'accueil) ; `all` : toutes les sortes (envois, partages reçus, salons ; conception compte §21.7).
// Ouvre le stockage une seule fois : IndexedDB en production, mémoire dans la démo (origine
// partagée de GitHub Pages : rien n'y est écrit) ; indisponible → `status: "unavailable"` et
// le site marche sans historique. Lire l'historique ne fait AUCUNE requête réseau ; les
// relectures passent par `refreshShare` (poll.ts : visible, 5 min, gigue).
import { accountFlag } from "../app/account-flag.svelte";
import { getDemo } from "../app/demo-hooks";
import { cleanTitle, destroyShare, fetchMeta, shareStatus } from "../index";
import { destroyedPatch, missingPatch, pollHistory, statusPatch, type PollError, type Poller, type RefreshResult, type Status } from "./poll";
import { presence } from "./presence.svelte";
import { pageReturns } from "./returns";
import { effacerTout as effacerPreuves } from "../salon/preuve";
import { effectiveState, idbBackend, linkKey, memoryBackend, openHistory, type Backend, type History, type HistoryEntry, type NewEntry } from "./store";

export type ShareInfo = {
  busy?: boolean;
  /** Dernière relecture échouée : l'entrée montre son dernier état connu, « non mis à jour ». */
  error?: PollError;
  retryAfterS?: number;
  /** Relecture refusée (moins de 5 min) : prochaine relecture possible à cette heure. */
  nextAt?: number;
  destroyError?: PollError;
};

export const shares = $state({
  status: "idle" as "idle" | "loading" | "ready" | "unavailable",
  /** Envois seulement (sorte « envoi »). */
  entries: [] as HistoryEntry[],
  /** Toutes les entrées de l'appareil (envois, reçus, salons), triées comme l'historique. */
  all: [] as HistoryEntry[],
  /**
   * « Garder dans mon historique » de cet appareil (envois et salons créés) : désactivé par
   * défaut (comme les téléchargements) ; la personne l'active.
   */
  enabled: false,
  info: {} as Record<string, ShareInfo>,
  /**
   * Compte ouvert sur cet appareil (posé par account/session.svelte.ts, jamais lu du stockage) :
   * la case « Garder dans mon accueil » suit alors son réglage « Garder les liens que j'ouvre ».
   * null : sans compte, elle suit « Garder dans mon historique » de l'appareil.
   */
  account: null as null | { keepReceived: boolean },
});

/** Case « Garder » de la page d'ouverture d'un partage : cochée selon le réglage (§21.7). */
// Sans compte : décochée (relecture) : garder un lien reçu
// garde sa clé sur l'appareil, qui peut être partagé ; la personne coche si elle le veut.
// Avec un compte : son réglage « garder les reçus ».
export const keepReceivedDefault = (): boolean => (shares.account ? shares.account.keepReceived : false);
/**
 * « Garder dans mon historique » de « Lien prêt » (envoi) et de la création d'un salon : le réglage
 * de l'appareil, désactivé par défaut, AVEC OU SANS compte (le lien de
 * gestion resterait sur un appareil peut-être partagé ; « Lien prêt » et « Salon prêt » le montrent
 * alors). La personne l'active elle-même ; avec un compte, ce qui est gardé suit ensuite son coffre.
 */
export const keepSentDefault = (): boolean => shares.enabled;
export function setAccountPrefs(p: { keepReceived: boolean } | null): void {
  shares.account = p;
  accountFlag.connected = p !== null;
}

/**
 * Ajout, retrait ou renommage (titre d'un envoi) d'une entrée par un geste sur cet
 * appareil (synchronisation du compte).
 */
export type LocalChange = { kind: "add" | "remove" | "rename"; entry: HistoryEntry };
const listeners = new Set<(c: LocalChange) => void>();
/** Écoute les ajouts et retraits faits sur cet appareil ; rend l'arrêt. */
export function onLocalChange(f: (c: LocalChange) => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}
function notify(c: LocalChange): void {
  for (const f of [...listeners])
    try {
      f(c);
    } catch {
      // un auditeur en échec ne bloque pas l'historique
    }
}

function backend(): Backend | null {
  if (getDemo()) return memoryBackend();
  try {
    const idb = globalThis.indexedDB;
    return idb ? idbBackend(idb) : null;
  } catch {
    return null; // accès refusé (certains navigateurs en navigation privée, cadres)
  }
}

let chosen: Backend | null | undefined;
const theBackend = () => (chosen === undefined ? (chosen = backend()) : chosen);

/** Stockage persistant (store.ts, askPersist) : absent de certains navigateurs, alors rien. */
const persistStorage = async (): Promise<unknown> => globalThis.navigator?.storage?.persist?.();

let opening: Promise<History | null> | undefined;
/**
 * Ouvre l'historique, en le créant au besoin (clé, base) : seulement pour y écrire. Un échec
 * n'est pas gardé (relecture : un premier échec passager, base occupée par un
 * autre onglet par exemple, empêchait de garder tout envoi suivant dans cet onglet) : le prochain
 * appel réessaie.
 */
function store(): Promise<History | null> {
  return (opening ??= openHistory({ backend: theBackend(), persist: persistStorage })
    .catch(() => null)
    .then((h) => {
      if (h === null) opening = undefined;
      return h;
    }));
}
/**
 * Ouvre sans rien créer : une simple visite (accueil, « Vos envois ») n'écrit rien dans le
 * navigateur tant qu'aucun partage n'a été gardé. « absent » : aucun historique encore.
 */
async function peek(): Promise<History | null | "absent"> {
  if (opening) return opening;
  const b = theBackend();
  if (!b) return null;
  try {
    if (!(await b.exists())) return "absent";
  } catch {
    return null;
  }
  return store();
}

let poller: Poller | undefined;
async function getPoller(): Promise<Poller | null> {
  const h = await store();
  if (!h) return null;
  return (poller ??= pollHistory(h, {
    manageStatus: (m) => shareStatus(m, location.origin),
    manageDestroy: (m) => destroyShare(m, location.origin),
    shareMeta: (l) => fetchMeta(l, location.origin),
    now: () => Date.now(),
    visible: () => document.visibilityState === "visible",
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
  }));
}

async function reload(h: History): Promise<void> {
  const list = await h.list();
  shares.all = list;
  presence.any = list.length > 0;
  shares.entries = list.filter((e) => e.sorte === "envoi");
}

/** Lecture locale (aucune requête). Sans effet si déjà lue, sauf `force`. */
export async function loadHistory(force = false): Promise<History | null> {
  if (shares.status === "ready" && !force) return opening ?? null;
  if (shares.status === "idle") shares.status = "loading";
  const h = await peek();
  if (h === "absent") {
    shares.entries = [];
    shares.all = [];
    presence.any = false;
    shares.enabled = false; // aucune base : jamais activé sur cet appareil
    shares.status = "ready";
    return null;
  }
  if (!h) {
    shares.status = "unavailable";
    return null;
  }
  try {
    const [, enabled] = await Promise.all([reload(h), h.enabled()]);
    shares.enabled = enabled;
    shares.status = "ready";
    return h;
  } catch {
    shares.status = "unavailable";
    return null;
  }
}

/** « Lien prêt » : garde le partage (lien de gestion et mesures, jamais le lien ni le mot de passe). */
export async function recordShare(e: NewEntry): Promise<string | null> {
  const h = await store();
  if (!h) {
    shares.status = "unavailable";
    return null;
  }
  try {
    const got = await h.add(e);
    await reload(h);
    notify({ kind: "add", entry: got });
    return got.id;
  } catch {
    return null;
  }
}

/**
 * Partage ouvert avec « Garder » coché (conception compte §21.7) : son lien (K_lien), le nombre
 * d'éléments, la taille, la sorte dominante et l'échéance ; JAMAIS le mot de passe, un nom ni un
 * contenu (cleanEntry les ignore de toute façon).
 */
export async function recordReceived(r: { link: string; expiresAt: number; itemsCount: number; sizeBytes: number; format: string }): Promise<string | null> {
  return recordShare({ sorte: "recu", manage: "", link: r.link, format: r.format, createdAt: Date.now(), sizeBytes: r.sizeBytes, itemsCount: r.itemsCount, expiresAt: r.expiresAt, maxOpens: 0 });
}

/**
 * Renomme un envoi sur cet appareil (titre du partage) : nettoyé par le moteur comme
 * à l'envoi (cleanTitle) ; vide ou rien que des invisibles : plus de titre. Ne change PAS ce que
 * voit le destinataire (le manifeste chiffré est figé). Rend l'entrée, ou null.
 */
export async function renameShare(id: string, raw: string): Promise<HistoryEntry | null> {
  const h = await store();
  if (!h) return null;
  try {
    const old = await h.get(id);
    if (!old || old.sorte !== "envoi") return null;
    const label = (await cleanTitle(raw)) ?? "";
    if (label === old.label) return old;
    const e = await h.update(id, { label });
    await reload(h);
    if (e) notify({ kind: "rename", entry: e });
    return e;
  } catch {
    return null;
  }
}

export async function forgetShare(id: string): Promise<void> {
  const h = await store();
  if (!h) return;
  const e = await h.get(id).catch(() => null);
  await h.remove(id).catch(() => undefined);
  delete shares.info[id];
  await reload(h).catch(() => undefined);
  if (e) notify({ kind: "remove", entry: e });
}

/** « Oublier ce partage sur cet appareil » : l'entrée reçue de ce lien (K_lien) part aussi. */
export async function forgetReceived(key: string): Promise<void> {
  const h = await peek();
  if (!h || h === "absent") return;
  const list = await h.list().catch(() => [] as HistoryEntry[]);
  for (const e of list) if (e.sorte === "recu" && linkKey(e) === "#" + key) await forgetShare(e.id);
}

/** Entrées venues du coffre privé d'un compte (origine « compte ») : gardées, sans signal. */
export async function importEntries(list: readonly HistoryEntry[]): Promise<void> {
  const h = await store();
  if (!h) return;
  for (const e of list) await h.put(e).catch(() => false);
  await reload(h).catch(() => undefined);
}

/** Retire des entrées (retirées du compte ailleurs), sans signal. */
export async function dropEntries(ids: readonly string[]): Promise<void> {
  const h = await peek();
  if (!h || h === "absent") return;
  for (const id of ids) await h.remove(id).catch(() => undefined);
  await reload(h).catch(() => undefined);
}

/** Déconnexion (§37.11 A-G8) : les entrées venues du compte partent ; celles de l'appareil restent. */
export async function dropAccountEntries(): Promise<void> {
  const h = await peek();
  if (!h || h === "absent") return;
  const list = await h.list().catch(() => [] as HistoryEntry[]);
  await dropEntries(list.filter((e) => e.origine === "compte").map((e) => e.id));
}

/** Toutes les entrées de l'appareil (lecture locale, aucune requête) ; aucun historique : []. */
export async function allEntries(): Promise<HistoryEntry[]> {
  const h = await peek();
  if (!h || h === "absent") return [];
  return h.list().catch(() => []);
}

export async function clearHistory(): Promise<void> {
  // D42-22 : les retours gardés (octrois chiffrés, history/returns.ts) partent aussi, en
  // parallèle et au plus 2 s : une base tenue par un autre onglet ne bloque jamais
  // l'effacement de l'historique (relecture, A).
  // Les preuves de membre du salon (salon/preuve.ts, réglage « silencieux » compris) partent aussi,
  // au plus 2 s de même (restes du salon, spec salon v3 §16).
  const returns = Promise.race([Promise.all([pageReturns().clear(), effacerPreuves()]).then(() => undefined), new Promise<void>((ok) => setTimeout(ok, 2000))]);
  const h = await store();
  if (h) {
    await h.clear();
    shares.info = {};
    await reload(h);
  }
  await returns;
}

export async function setHistoryEnabled(v: boolean): Promise<void> {
  const h = await store();
  if (!h) return;
  await h.setEnabled(v).catch(() => undefined);
  shares.enabled = v;
}

/** Marque un partage détruit ailleurs sur ce site (« Lien prêt », Supprimer). */
export async function markDestroyed(id: string): Promise<void> {
  const h = await store();
  if (!h) return;
  await h.update(id, destroyedPatch(Date.now())).catch(() => undefined);
  await reload(h).catch(() => undefined);
}

export type ManagedResult = { kind: "status"; status: Status } | { kind: "missing" } | { kind: "destroyed" };
/** Secret de gestion d'un lien `…#m<S_gestion>` (la base du chemin peut différer : démo). */
const secretOf = (manage: string) => manage.slice(manage.lastIndexOf("#m"));

/**
 * Vue de gestion `#m…` : reporte une relecture ou une
 * destruction sur l'entrée d'historique du même partage, si elle existe. Aucune requête,
 * aucune entrée créée, et aucun historique créé s'il n'y en a pas encore (peek).
 */
export function syncManaged(manage: string, r: ManagedResult): Promise<void> {
  // L'une après l'autre : une relecture encore en cours n'écrase pas une destruction qui suit.
  return (syncing = syncing.then(() => syncOne(manage, r)));
}
let syncing: Promise<void> = Promise.resolve();
async function syncOne(manage: string, r: ManagedResult): Promise<void> {
  try {
    const h = await peek();
    if (!h || h === "absent") return;
    const key = secretOf(manage);
    const e = (await h.list()).find((x) => x.sorte === "envoi" && secretOf(x.manage) === key);
    if (!e) return;
    const t = Date.now();
    const cur = effectiveState(e, t);
    if (r.kind !== "destroyed" && (cur === "gone" || cur === "expired")) return; // fin déjà notée
    await h.update(e.id, r.kind === "status" ? statusPatch(e, r.status, t) : r.kind === "missing" ? missingPatch(e, t) : destroyedPatch(t));
    delete shares.info[e.id];
    await reload(h);
  } catch {
    // Historique illisible : la vue de gestion marche sans lui.
  }
}

function apply(id: string, r: RefreshResult): void {
  const info: ShareInfo = {};
  if (r.kind === "error") {
    info.error = r.error;
    info.retryAfterS = r.retryAfterS;
  } else if (r.kind === "skipped" && r.reason === "fresh") info.nextAt = r.nextAt;
  shares.info[id] = info;
}

/** « Actualiser », carte dépliée : au plus une fois toutes les 5 min, après une gigue. */
export async function refreshShare(id: string): Promise<RefreshResult | null> {
  const p = await getPoller();
  if (!p) return null;
  shares.info[id] = { ...shares.info[id], busy: true };
  const r = await p.refreshOne(id);
  apply(id, r);
  const h = await store();
  if (h) await reload(h).catch(() => undefined);
  return r;
}

/** Affichage de « Vos envois » : relit les partages actifs dont l'état date de plus de 5 min. */
export async function refreshAll(): Promise<void> {
  const p = await getPoller();
  const h = await store();
  if (!p || !h) return;
  await p.start();
  await reload(h).catch(() => undefined);
}
export function stopRefresh(): void {
  poller?.stop();
}

/** Détruire : en un geste, depuis la carte. */
export async function destroyFromHistory(id: string): Promise<boolean> {
  const p = await getPoller();
  if (!p) return false;
  const r = await p.destroy(id);
  const h = await store();
  if (h) await reload(h).catch(() => undefined);
  if (r.kind === "error") {
    shares.info[id] = { ...shares.info[id], destroyError: r.error };
    return false;
  }
  shares.info[id] = {};
  return true;
}

// État partagé de l'historique des téléchargements pour les écrans (contenu reçu, page
// /telechargements). Ouvre le stockage une fois : IndexedDB en production, mémoire dans la
// démo (origine partagée de GitHub Pages : rien n'y est écrit) ; indisponible → `status:
// "unavailable"`. Désactivé par défaut : tant que
// la personne ne l'a pas activé, rien n'est créé ni écrit (ni base, ni clé, ni entrée) ; une
// simple visite ou un fichier enregistré n'écrivent rien. Aucune requête réseau.
import { getDemo } from "../app/demo-hooks";
import { presence } from "../history/presence.svelte";
import { memoryBackend, type Backend } from "../history/store";
import { downloadsIdb, openDownloads, type DownloadEntry, type Downloads, type NewDownload } from "./store";

export const downloads = $state({
  status: "idle" as "idle" | "loading" | "ready" | "unavailable",
  entries: [] as DownloadEntry[],
  /** « Garder l'historique » : désactivé par défaut (remplace l'« activé » de R12). */
  enabled: false,
});

function backend(): Backend | null {
  if (getDemo()) return memoryBackend();
  try {
    const idb = globalThis.indexedDB;
    return idb ? downloadsIdb(idb) : null;
  } catch {
    return null; // accès refusé (navigation privée de certains navigateurs, cadres)
  }
}

let chosen: Backend | null | undefined;
const theBackend = () => (chosen === undefined ? (chosen = backend()) : chosen);
let opening: Promise<Downloads | null> | undefined;
/** Ouvre en créant au besoin (clé, base) : seulement pour activer, ou écrire une fois activé. */
function store(): Promise<Downloads | null> {
  return (opening ??= openDownloads({ backend: theBackend() }).catch(() => null));
}

async function reload(d: Downloads): Promise<void> {
  downloads.entries = await d.list();
}

/** Lecture locale, sans rien créer si aucune base n'existe encore. */
export async function loadDownloads(): Promise<void> {
  if (downloads.status === "idle") downloads.status = "loading";
  const b = theBackend();
  if (!b) return void (downloads.status = "unavailable");
  try {
    if (!opening && !(await b.exists())) {
      downloads.entries = [];
      downloads.enabled = presence.downloads = false; // aucune base : jamais activé sur cet appareil
      downloads.status = "ready";
      return;
    }
    const d = await store();
    if (!d) return void (downloads.status = "unavailable");
    const [list, enabled] = await Promise.all([d.list(), d.enabled()]);
    downloads.entries = list;
    // « Téléchargements » dans le menu et le pied de page sans compte : seulement activé.
    downloads.enabled = presence.downloads = enabled;
    downloads.status = "ready";
  } catch {
    downloads.status = "unavailable";
  }
}

/** La base existe (ouverte ici, ou déjà sur l'appareil), sans la créer. */
async function hasBase(): Promise<boolean> {
  const b = theBackend();
  return !!b && (opening !== undefined || (await b.exists().catch(() => false)));
}

/**
 * Après un enregistrement réussi (afterSave) : rien si l'historique est désactivé ou
 * indisponible. Sans base (jamais activé), rien n'est ouvert : ni base ni clé créées.
 */
export async function recordDownload(e: NewDownload): Promise<void> {
  if (!(await hasBase())) return;
  const d = await store();
  if (!d) return;
  try {
    if (!(await d.add(e))) return;
    if (downloads.status === "ready") await reload(d);
  } catch {
    // historique illisible : le fichier est enregistré quand même
  }
}

export async function removeDownload(id: string): Promise<void> {
  if (!(await hasBase())) return;
  const d = await store();
  if (!d) return;
  await d.remove(id).catch(() => undefined);
  await reload(d).catch(() => undefined);
}

export async function clearDownloads(): Promise<void> {
  if (!(await hasBase())) return void (downloads.entries = []);
  const d = await store();
  if (!d) return;
  await d.clear().catch(() => undefined);
  await reload(d).catch(() => undefined);
}

/** Activer crée la base ; désactiver l'efface (rien n'est créé s'il n'y avait rien). */
export async function setDownloadsEnabled(v: boolean): Promise<void> {
  if (!v && !(await hasBase())) {
    downloads.enabled = presence.downloads = false;
    downloads.entries = [];
    return;
  }
  const d = await store();
  if (!d) return;
  await d.setEnabled(v).catch(() => undefined);
  downloads.enabled = presence.downloads = await d.enabled().catch(() => v);
  await reload(d).catch(() => undefined);
}

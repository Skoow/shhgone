// @vitest-environment happy-dom
// Historique des téléchargements DÉSACTIVÉ PAR DÉFAUT (
// 2026, remplace l'« activé » de R12 ; P3). Tant que la personne ne l'a
// pas activé elle-même, rien n'est créé sur l'appareil (ni base, ni clé, ni entrée), même après
// des fichiers enregistrés. L'écran du contenu reçu (seul écran où l'on enregistre, avec ou sans
// compte) le dit et propose « Les garder 30 jours » ; activé, « Ne pas garder » le désactive et
// efface tout, et une phrase le dit. Vraie base IndexedDB simulée (chemin de production).
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGone } from "../flows/gone.svelte";
import { fakeIndexedDB } from "../storage/fake-idb.test-helper";
import { presence } from "./presence.svelte";
import { probeDownloads } from "./probe";
import { setLang } from "../i18n/i18n.svelte";
import type { Opened } from "../index";
import { DOWNLOADS_DB, downloadsIdb, openDownloads } from "./store";

vi.mock("../app/demo-hooks", () => ({ getDemo: () => null }));
const idb = fakeIndexedDB();
(globalThis as { indexedDB?: unknown }).indexedDB = idb;
const live = await import("./live.svelte");
const { default: Content } = await import("../routes/Content.svelte");

const NNBSP = "\u202f";
const NBSP = "\u00a0";
const entry = (name: string) => ({ name, sizeBytes: 3, format: { family: "text" as const, label: "TXT" }, source: "partage" as const, savedAt: Date.now() });
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

function opened(): Opened {
  return {
    manifest: { v: 2, rights: "enregistrer", items: [{ kind: "file", name: "a.txt", mime: "text/plain", size: 3, offset: 0 }] },
    safeName: () => "a.txt",
    previewKind: () => "text",
    isRiskyFile: () => false,
    item: async () => new Uint8Array(0),
    saveItem: async () => undefined,
    done: async () => undefined,
    wipe: () => undefined,
    destroy: async () => undefined,
    watch: () => new Promise(() => undefined),
    grant: "",
    opensLeft: 0,
    lastOpen: false,
  } as unknown as Opened;
}
let app: Record<string, unknown> | null = null;
const show = async () => {
  app = mount(Content as never, { target: document.body, props: { opened: opened(), expired: false, onend: () => undefined, gone: createGone({ finish: () => undefined, revokeAll: () => undefined }) } }) as Record<string, unknown>;
  await settle();
};
/** La fausse fabrique avec indexedDB.databases() (liste des bases existantes). */
const withDatabases = () =>
  ({ databases: async () => [...idb.raw().keys()].map((name) => ({ name, version: 1 })), open: (n: string) => idb.open(n) }) as unknown as Pick<IDBFactory, "databases" | "open">;
const line = () => document.querySelector("[data-downloads-notice]");
const say = () => line()!.textContent!.replace(/[ \n\t]+/g, " ").trim();
const press = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent!.trim() === label)!.click();

beforeEach(() => setLang("fr"));
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
});

describe("historique des téléchargements : désactivé par défaut", () => {
  it("jamais activé : fichiers enregistrés, lecture, désactivation, effacement : aucune base n'est créée sur l'appareil", async () => {
    await live.loadDownloads();
    expect(live.downloads.enabled).toBe(false);
    expect(presence.downloads).toBe(false); // pas de « Téléchargements » dans le menu sans compte
    await show();
    await live.recordDownload(entry("secret.txt"));
    await live.recordDownload(entry("autre.txt"));
    await live.setDownloadsEnabled(false);
    await live.clearDownloads();
    await live.loadDownloads();
    expect(live.downloads.entries).toEqual([]);
    expect([...idb.raw().keys()]).toEqual([]); // ni base, ni clé, ni drapeau
    // L'écran le dit (fr et en), avec le geste pour activer.
    expect(say()).toBe(`Les noms des fichiers enregistrés ne sont pas gardés sur cet appareil. Les garder 30${NNBSP}jours`);
    setLang("en");
    flushSync();
    expect(say()).toBe(`The names of saved files are not kept on this device. Keep them for 30${NBSP}days`);
  });

  it("activé par la personne : noté ; « Ne pas garder » désactive, efface tout et le dit ; plus rien n'est noté ensuite", async () => {
    await show();
    press("Les garder 30 jours");
    await settle();
    expect(live.downloads.enabled).toBe(true);
    expect(presence.downloads).toBe(true); // « Téléchargements » dans le menu et le pied de page sans compte
    // Pages d'information : le même drapeau, lu sans clé ni création.
    presence.downloads = false;
    await probeDownloads(withDatabases());
    expect(presence.downloads).toBe(true);
    expect(say()).toBe(`Fichiers enregistrés notés dans Téléchargements, sur cet appareil (30${NNBSP}jours). Ne pas garder`);
    await live.recordDownload(entry("premier.txt"));
    await live.recordDownload(entry("second.txt"));
    await live.loadDownloads();
    expect(live.downloads.entries.map((e) => e.name).sort()).toEqual(["premier.txt", "second.txt"]);
    setLang("en");
    flushSync();
    expect(say()).toBe(`Saved files are listed in Downloads on this device (30${NBSP}days). Don't keep`);
    setLang("fr");
    flushSync();
    press("Ne pas garder");
    await settle();
    expect(live.downloads.enabled).toBe(false);
    expect(presence.downloads).toBe(false); // lien retiré
    await probeDownloads(withDatabases());
    expect(presence.downloads).toBe(false);
    expect(live.downloads.entries).toEqual([]);
    expect(say()).toBe(`Historique des téléchargements désactivé et effacé. Les garder 30${NNBSP}jours`);
    await live.recordDownload(entry("troisieme.txt"));
    const raw = (await openDownloads({ backend: downloadsIdb(idb) }))!;
    expect(await raw.list()).toEqual([]);
    expect([...(idb.raw().get(DOWNLOADS_DB)?.get("entries")?.keys() ?? [])]).toEqual([]);
  });
});

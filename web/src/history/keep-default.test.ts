// @vitest-environment happy-dom
// Cases « Garder » : décochées par défaut (le lien et sa clé, ou le lien de gestion,
// resteraient sur un appareil peut-être partagé) ; avec un compte, son réglage (reçus) ou activée
// (envois, l'historique suit le coffre du compte).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB } from "./fake-idb.test-helper";

let live: typeof import("./live.svelte");
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", fakeIndexedDB());
  live = await import("./live.svelte");
});
afterEach(() => {
  live.setAccountPrefs(null);
  vi.unstubAllGlobals();
});

describe("keepReceivedDefault", () => {
  it("sans compte : décochée, même historique activé", () => {
    live.setAccountPrefs(null);
    live.shares.enabled = true;
    expect(live.keepReceivedDefault()).toBe(false);
  });
  it("avec un compte : son réglage", () => {
    live.setAccountPrefs({ keepReceived: true });
    expect(live.keepReceivedDefault()).toBe(true);
    live.setAccountPrefs({ keepReceived: false });
    expect(live.keepReceivedDefault()).toBe(false);
  });
});

describe("keepSentDefault : historique des envois", () => {
  it("sans compte, appareil neuf : désactivé, et la lecture ne crée aucune base", async () => {
    expect(live.shares.enabled).toBe(false);
    await live.loadHistory(true);
    expect(live.shares.status).toBe("ready");
    expect(live.shares.enabled).toBe(false);
    expect(live.keepSentDefault()).toBe(false);
  });
  it("sans compte : activé par la personne, gardé d'une visite à l'autre ; puis désactivé", async () => {
    await live.setHistoryEnabled(true);
    expect(live.keepSentDefault()).toBe(true);
    vi.resetModules(); // nouvelle visite, même stockage
    live = await import("./live.svelte");
    await live.loadHistory(true);
    expect(live.shares.enabled).toBe(true);
    expect(live.keepSentDefault()).toBe(true);
    await live.setHistoryEnabled(false);
    expect(live.keepSentDefault()).toBe(false);
  });
  it("base existante sans choix (un partage reçu gardé) : désactivé", async () => {
    await live.recordReceived({ link: "https://x.test/s#" + "A".repeat(43), expiresAt: Date.now() + 3600_000, itemsCount: 1, sizeBytes: 1, format: "text" });
    await live.loadHistory(true);
    expect(live.shares.all).toHaveLength(1);
    expect(live.shares.enabled).toBe(false);
    expect(live.keepSentDefault()).toBe(false);
  });
  it("avec un compte aussi : désactivé par défaut ; activé par la personne, activé", async () => {
    for (const keepReceived of [false, true]) {
      live.setAccountPrefs({ keepReceived });
      expect(live.keepSentDefault()).toBe(false);
    }
    await live.loadHistory(true);
    expect(live.keepSentDefault()).toBe(false);
    await live.setHistoryEnabled(true);
    expect(live.keepSentDefault()).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { probeDownloads } from "../downloads/probe";
import { presence, probeHistory } from "./presence.svelte";

/** Fausse fabrique IndexedDB : `count` entrées dans « entries » ; `created` : la base n'existait plus. */
function fake(names: string[], count: number, opts: { created?: boolean; stores?: string[] } = {}) {
  const log = { aborted: 0, closed: 0 };
  const factory = {
    databases: async () => names.map((name) => ({ name, version: 1 })),
    open: () => {
      const r: Record<string, unknown> = {};
      queueMicrotask(() => {
        if (opts.created) {
          r.transaction = { abort: () => log.aborted++ };
          (r.onupgradeneeded as () => void)();
          return;
        }
        const stores = opts.stores ?? ["meta", "entries"];
        r.result = {
          objectStoreNames: { contains: (n: string) => stores.includes(n) },
          close: () => log.closed++,
          transaction: () => ({
            objectStore: () => {
              const c: Record<string, unknown> = { result: count };
              queueMicrotask(() => (c.onsuccess as () => void)());
              return { count: () => c };
            },
          }),
        };
        (r.onsuccess as () => void)();
      });
      return r;
    },
  };
  return { factory: factory as unknown as Pick<IDBFactory, "databases" | "open">, log };
}

describe("« Mes partages » seulement s'il y a des partages (17 novembre)", () => {
  it("pages d'information : vrai seulement si la base existe ET contient une entrée (18 novembre)", async () => {
    presence.any = false;
    await probeHistory(fake(["autre"], 3).factory);
    expect(presence.any).toBe(false);
    const empty = fake(["shhdrop-history"], 0);
    await probeHistory(empty.factory);
    expect(presence.any).toBe(false); // base vide (« Ne pas garder », « Effacer ») : rien
    expect(empty.log.closed).toBe(1);
    await probeHistory(fake(["shhdrop-history"], 0, { stores: [] }).factory);
    expect(presence.any).toBe(false);
    await probeHistory(fake(["shhdrop-history"], 2).factory);
    expect(presence.any).toBe(true);
  });
  it("base supprimée entre-temps : sa création est annulée, rien à montrer", async () => {
    presence.any = false;
    const f = fake(["shhdrop-history"], 0, { created: true });
    await probeHistory(f.factory);
    expect(f.log.aborted).toBe(1);
    expect(presence.any).toBe(false);
  });
  it("stockage refusé ou absent : rien à montrer, aucune erreur", async () => {
    presence.any = false;
    await probeHistory({ databases: async () => Promise.reject(new Error("refusé")), open: () => { throw new Error("x"); } } as unknown as Pick<IDBFactory, "databases" | "open">);
    await probeHistory(undefined);
    expect(presence.any).toBe(false);
  });
});

describe("« Téléchargements » sans compte seulement si l'historique est activé (22 novembre)", () => {
  it("pages d'information : base absente, ou stockage refusé : rien à montrer, rien de créé", async () => {
    presence.downloads = false;
    const f = fake(["shhdrop-history"], 3);
    await probeDownloads(f.factory);
    expect(presence.downloads).toBe(false);
    await probeDownloads(undefined);
    await probeDownloads({ databases: async () => { throw new Error("refus"); }, open: () => { throw new Error("refus"); } } as never);
    expect(presence.downloads).toBe(false);
    // Base supprimée entre-temps : sa création est annulée.
    const gone = fake(["shhdrop-telechargements"], 0, { created: true });
    await probeDownloads(gone.factory);
    expect(gone.log.aborted).toBe(1);
    expect(presence.downloads).toBe(false);
  });
});

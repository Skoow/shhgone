// @vitest-environment happy-dom
// Vue de gestion `#m…` et historique : un partage détruit ou
// relu depuis `#m…` met à jour son entrée d'historique si elle existe ; aucune entrée n'est
// créée, et une simple visite ne crée pas d'historique.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB, type FakeIdb } from "./fake-idb.test-helper";

const MANAGE = "https://x.test/s#m" + "A".repeat(43);
const OTHER = "https://x.test/s#m" + "B".repeat(43);
let idb: FakeIdb;
let live: typeof import("./live.svelte");

beforeEach(async () => {
  vi.resetModules();
  idb = fakeIndexedDB();
  vi.stubGlobal("indexedDB", idb);
  live = await import("./live.svelte");
});
afterEach(() => vi.unstubAllGlobals());

async function seed(manage = MANAGE) {
  const now = Date.now();
  await live.recordShare({ manage, createdAt: now - 60_000, sizeBytes: 10, itemsCount: 1, expiresAt: now + 3600_000, maxOpens: 3 });
  return live.shares.entries.find((e) => e.manage === manage)!;
}

describe("syncManaged : #m… → entrée d'historique existante", () => {
  it("destruction réussie : l'entrée passe à « détruit ici » ; l'autre ne bouge pas", async () => {
    await seed();
    const other = await seed(OTHER);
    await live.syncManaged(MANAGE, { kind: "destroyed" });
    const e = live.shares.entries.find((x) => x.manage === MANAGE)!;
    expect(e.state).toBe("gone");
    expect(e.destroyedHere).toBe(true);
    expect(e.endedAt).toBeGreaterThan(0);
    expect(live.shares.entries.find((x) => x.id === other.id)).toEqual(other);
  });

  it("relecture : ouvertures, échéance et état mis à jour (ouverture notée entre deux relectures)", async () => {
    const before = await seed();
    await live.syncManaged(MANAGE, { kind: "status", status: { opensUsed: 2, maxOpens: 3, expiresInS: 1800, state: "draining" } });
    const e = live.shares.entries.find((x) => x.id === before.id)!;
    expect(e.opensUsed).toBe(2);
    expect(e.state).toBe("draining");
    expect(e.opens).toHaveLength(1);
    expect(e.opens[0]!.count).toBe(2);
    expect(Math.abs(e.expiresAt - (Date.now() + 1800_000))).toBeLessThan(5_000);
    expect(e.lastSeenAt).toBeGreaterThan(before.lastSeenAt);
  });

  it("partage absent du serveur : « terminé », pas « détruit ici »", async () => {
    await seed();
    await live.syncManaged(MANAGE, { kind: "missing" });
    const e = live.shares.entries[0]!;
    expect(e.state).toBe("gone");
    expect(e.destroyedHere).toBe(false);
  });

  it("aucune entrée correspondante : rien n'est créé", async () => {
    await seed(OTHER);
    await live.syncManaged(MANAGE, { kind: "destroyed" });
    expect(live.shares.entries.map((e) => e.manage)).toEqual([OTHER]);
    expect(live.shares.entries[0]!.state).toBe("ready");
  });

  it("aucun historique encore : rien n'est écrit dans le navigateur", async () => {
    await live.syncManaged(MANAGE, { kind: "destroyed" });
    await live.syncManaged(MANAGE, { kind: "status", status: { opensUsed: 0, maxOpens: 1, expiresInS: 60, state: "ready" } });
    expect(idb.raw().size).toBe(0);
  });

  it("même partage, lien de gestion sous une autre base (démo /shhdrop/) : reconnu", async () => {
    await seed("https://x.test/shhdrop/#m" + "A".repeat(43));
    await live.syncManaged(MANAGE, { kind: "destroyed" });
    expect(live.shares.entries[0]!.state).toBe("gone");
  });
});

describe("syncManaged : ordre", () => {
  it("relecture reportée pendant l'écriture d'une destruction : l'entrée reste « détruit ici »", async () => {
    await seed();
    const b = live.syncManaged(MANAGE, { kind: "destroyed" });
    const a = live.syncManaged(MANAGE, { kind: "status", status: { opensUsed: 1, maxOpens: 3, expiresInS: 600, state: "ready" } });
    await Promise.all([a, b]);
    expect(live.shares.entries[0]!.state).toBe("gone");
    expect(live.shares.entries[0]!.destroyedHere).toBe(true);
  });
});

describe("D42-22 : « Effacer l'historique » efface aussi les retours gardés", () => {
  it("la base shhdrop-returns disparaît avec l'historique", async () => {
    await seed();
    const { pageReturns, RETURNS_DB } = await import("./returns");
    await pageReturns().save({ tag: "T".repeat(22), grant: "G".repeat(54), expiresAt: Date.now() + 3600_000 });
    expect(idb.raw().has(RETURNS_DB)).toBe(true);
    await live.clearHistory();
    expect(idb.raw().has(RETURNS_DB)).toBe(false);
  });
});

// Restes du salon (spec salon v3 §16, confidentialité, moyenne) : les preuves de membre (base à part
// de salon/preuve.ts, avec le réglage « silencieux » qu'elles contiennent) partent aussi.
describe("« Effacer l'historique » efface aussi les preuves de membre du salon", () => {
  it("la base des preuves disparaît avec l'historique ; plus aucune preuve lisible", async () => {
    await seed();
    const preuve = await import("../salon/preuve");
    const index = new Uint8Array(16).fill(7);
    const cle = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await preuve.ecrire(index, cle, new Uint8Array(16).fill(1), { jeton: "J".repeat(43), siege: 2, pseudo: "Renard", couleur: 1, kMaitre: new Uint8Array(32), silence: -1 }, Date.now() + 3600_000);
    expect(await preuve.ouvrir(index, cle)).not.toBeNull();
    const avant = [...idb.raw().keys()];
    await live.clearHistory();
    const disparues = avant.filter((n) => !idb.raw().has(n));
    expect(disparues.length).toBeGreaterThan(0);
    expect(await preuve.lireSel(index)).toBeNull();
    expect(await preuve.ouvrir(index, cle)).toBeNull();
  });

  it("une base des preuves bloquée ne bloque pas l'effacement (au plus 2 s)", async () => {
    await seed();
    vi.resetModules();
    vi.doMock("../salon/preuve", () => ({ effacerTout: () => new Promise<void>(() => undefined) }));
    live = await import("./live.svelte");
    vi.useFakeTimers();
    try {
      let done = false;
      const p = live.clearHistory().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(2100);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.doUnmock("../salon/preuve");
    }
  });
});

describe("relecture (A) : « Effacer l'historique » ne se bloque jamais sur les retours", () => {
  it("historique effacé d'abord ; retours bloqués (base tenue ailleurs) : fini au plus tard 2 s après", async () => {
    await seed();
    const { pageReturns } = await import("./returns");
    vi.spyOn(pageReturns(), "clear").mockReturnValue(new Promise<void>(() => undefined));
    vi.useFakeTimers();
    try {
      let done = false;
      const p = live.clearHistory().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(100);
      expect(live.shares.entries).toEqual([]); // l'historique n'attend pas les retours
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Conception compte §21.7, §21.8 : partages reçus gardés sur l'appareil (lien,
// jamais le mot de passe), retirés par « Oublier ce partage sur cet appareil » ; « Vos envois »
// (shares.entries) ne voit que les envois ; entrées du compte importées et retirées à la
// déconnexion ; chaque ajout ou retrait local est signalé (synchronisation du compte).
describe("partages reçus", () => {
  const KEY = "k".repeat(43);
  const LINK = "https://x.test/#" + KEY;
  const received = () => ({ link: LINK, expiresAt: Date.now() + 3600_000, itemsCount: 2, sizeBytes: 300, format: "image" });

  it("recordReceived : entrée « recu » locale dans shares.all, jamais dans shares.entries (envois)", async () => {
    await seed();
    await live.recordReceived(received());
    expect(live.shares.entries.map((e) => e.sorte)).toEqual(["envoi"]);
    const r = live.shares.all.find((e) => e.sorte === "recu")!;
    expect(r).toMatchObject({ link: LINK, origine: "local", itemsCount: 2, sizeBytes: 300, format: "image", manage: "" });
    expect(live.shares.all).toHaveLength(2);
  });

  it("forgetReceived(clé) : l'entrée de ce lien part, les autres restent", async () => {
    await seed();
    await live.recordReceived(received());
    await live.forgetReceived(KEY);
    expect(live.shares.all.map((e) => e.sorte)).toEqual(["envoi"]);
  });

  it("chaque ajout ou retrait local est signalé ; importer() n'est pas signalé (venu du compte)", async () => {
    const seen: string[] = [];
    const stop = live.onLocalChange((c) => seen.push(`${c.kind}:${c.entry.sorte}`));
    await seed();
    await live.recordReceived(received());
    await live.forgetReceived(KEY);
    const env = live.shares.entries[0]!;
    await live.forgetShare(env.id);
    await live.importEntries([{ ...env, id: "C".repeat(22), origine: "compte" }]);
    stop();
    await live.recordReceived(received());
    expect(seen).toEqual(["add:envoi", "add:recu", "remove:recu", "remove:envoi"]);
    expect(live.shares.entries.map((e) => e.origine)).toEqual(["compte"]);
  });

  it("dropAccountEntries : seules les entrées venues du compte partent ; celles de l'appareil restent", async () => {
    const env = await seed();
    await live.importEntries([{ ...env, id: "C".repeat(22), origine: "compte", manage: OTHER }]);
    expect(live.shares.entries).toHaveLength(2);
    await live.dropAccountEntries();
    expect(live.shares.entries.map((e) => e.id)).toEqual([env.id]);
  });
});

describe("ouverture de l'historique : un échec passager n'est pas gardé (relecture)", () => {
  it("premier essai refusé (base occupée) : le partage suivant est quand même gardé", async () => {
    idb.failOpen = true;
    const now = Date.now();
    const first = await live.recordShare({ manage: MANAGE, createdAt: now, sizeBytes: 1, itemsCount: 1, expiresAt: now + 3600_000, maxOpens: 1 });
    expect(first).toBeNull();
    idb.failOpen = false;
    const second = await live.recordShare({ manage: OTHER, createdAt: now, sizeBytes: 1, itemsCount: 1, expiresAt: now + 3600_000, maxOpens: 1 });
    expect(second).not.toBeNull();
    expect(live.shares.entries.map((e) => e.manage)).toEqual([OTHER]);
  });
});

// Renommer un envoi : nettoyé par le vrai moteur (WebAssembly lu sur le disque),
// gardé sur l'appareil, signalé au compte (« rename ») ; un reçu ne se renomme pas.
describe("renameShare : titre d'un envoi sur cet appareil", () => {
  it("nettoyé par le moteur comme à l'envoi ; vide : plus de titre ; signal « rename » ; reçu refusé", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const wasm = join(dirname(fileURLToPath(import.meta.url)), "../engine/pkg/shhdrop_wasm_bg.wasm");
    vi.stubGlobal("fetch", async () => new Response(readFileSync(wasm)));
    const e = await seed();
    expect(e.label).toBe("");
    const seen: { kind: string; label: string }[] = [];
    live.onLocalChange((c) => seen.push({ kind: c.kind, label: c.entry.label }));
    const r = await live.renameShare(e.id, "  Contrat ‮ Dupont​  ");
    expect(r!.label).toBe("Contrat Dupont");
    expect(live.shares.entries[0]!.label).toBe("Contrat Dupont");
    // Même nom : rien n'est réécrit ni signalé.
    await live.renameShare(e.id, "Contrat Dupont");
    expect(seen).toEqual([{ kind: "rename", label: "Contrat Dupont" }]);
    expect((await live.renameShare(e.id, " ​ "))!.label).toBe("");
    expect(seen.at(-1)).toEqual({ kind: "rename", label: "" });
    // Trop long après nettoyage : le moteur ne garde rien (le champ borne à 80).
    expect((await live.renameShare(e.id, "a".repeat(81)))!.label).toBe("");
    // Entrée inconnue : null.
    expect(await live.renameShare("z".repeat(22), "x")).toBeNull();
    // Un partage reçu ne porte pas de titre.
    const now = Date.now();
    await live.recordReceived({ link: "https://x.test/s#" + "C".repeat(43), expiresAt: now + 3600_000, itemsCount: 1, sizeBytes: 1, format: "file" });
    const recu = live.shares.all.find((x) => x.sorte === "recu")!;
    expect(await live.renameShare(recu.id, "x")).toBeNull();
  });
});

describe("managedSummary : contexte de la vue de gestion, lu sur l'appareil", () => {
  it("entrée du même partage : nom, éléments et taille ; une autre : null", async () => {
    const now = Date.now();
    await live.recordShare({ manage: MANAGE, label: "Contrat", createdAt: now, sizeBytes: 2048, itemsCount: 3, expiresAt: now + 3600_000, maxOpens: 1 });
    expect(await live.managedSummary("https://x.test/shhdrop/#m" + "A".repeat(43))).toEqual({ label: "Contrat", itemsCount: 3, sizeBytes: 2048 });
    expect(await live.managedSummary(OTHER)).toBeNull();
  });
  it("aucun historique encore : null, et rien n'est écrit dans le navigateur", async () => {
    expect(await live.managedSummary(MANAGE)).toBeNull();
    expect(idb.raw().size).toBe(0);
  });
});

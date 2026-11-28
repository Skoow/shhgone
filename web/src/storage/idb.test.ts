// Accès au stockage chiffré de l'appareil (storage/idb.ts) et effacement de l'ancien historique
// des liens (storage/ancien-historique.ts, retiré le 25 novembre, spec §33).
import { describe, expect, it } from "vitest";
import { ANCIEN_HISTORIQUE, ANCIENS_TELECHARGEMENTS, effacerAncienHistorique } from "./ancien-historique";
import { fakeIndexedDB } from "./fake-idb.test-helper";
import { idbBackend, memoryBackend } from "./idb";

const cle = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const rec = () => ({ iv: new Uint8Array(12), ct: new Uint8Array([1, 2, 3]) });

describe("storage/idb : base IndexedDB", () => {
  it("exists : faux tant que rien n'est gardé, et la vérification ne crée aucune base", async () => {
    const idb = fakeIndexedDB();
    expect(await idbBackend(idb, "shh-test").exists()).toBe(false);
    expect(idb.raw().has("shh-test")).toBe(false);
    await idbBackend(idb, "shh-test").put("a", rec());
    expect(await idbBackend(idb, "shh-test").exists()).toBe(true);
  });
  it("la clé gardée fait foi : un second chargement rend la même ; non extractible", async () => {
    const idb = fakeIndexedDB();
    const k1 = await idbBackend(idb, "shh-test").key(await cle());
    const k2 = await idbBackend(idb, "shh-test").key(await cle());
    expect(k2).toBe(k1);
    expect(k1.extractable).toBe(false);
  });
  it("put, all, del, clear, drapeaux, drop", async () => {
    const b = idbBackend(fakeIndexedDB(), "shh-test");
    await b.put("a", rec());
    await b.put("b", rec());
    expect((await b.all()).map(([k]) => k).sort()).toEqual(["a", "b"]);
    await b.del("a");
    expect((await b.all()).map(([k]) => k)).toEqual(["b"]);
    await b.setFlag("on", true);
    expect(await b.flag("on")).toBe(true);
    await b.clear();
    expect(await b.all()).toEqual([]);
    await b.drop();
    expect(await b.exists()).toBe(false);
  });
  it("mémoire (démo, tests) : même contrat", async () => {
    const b = memoryBackend();
    expect(await b.exists()).toBe(false);
    await b.key(await cle());
    await b.put("x", rec());
    expect(b.raw().size).toBe(1);
    await b.drop();
    expect(await b.exists()).toBe(false);
  });
});

describe("ancien historique des liens (retiré le 25 novembre)", () => {
  it("la base shhdrop-history d'avant est supprimée au démarrage, clé et entrées comprises", async () => {
    const idb = fakeIndexedDB();
    const ancienne = idbBackend(idb, ANCIEN_HISTORIQUE);
    await ancienne.key(await cle());
    await ancienne.put("entree", rec());
    expect(idb.raw().has(ANCIEN_HISTORIQUE)).toBe(true);
    await effacerAncienHistorique(idb);
    expect(idb.raw().has(ANCIEN_HISTORIQUE)).toBe(false);
  });
  it("l'historique des téléchargements retiré (D42-33) : sa base est supprimée au démarrage, clé et entrées comprises", async () => {
    const idb = fakeIndexedDB();
    const ancienne = idbBackend(idb, ANCIENS_TELECHARGEMENTS);
    await ancienne.key(await cle());
    await ancienne.put("entree", rec());
    await ancienne.setFlag("on", true);
    const partages = idbBackend(idb, "shhdrop-partages");
    await partages.put("garde", rec());
    await effacerAncienHistorique(idb);
    expect(idb.raw().has(ANCIENS_TELECHARGEMENTS)).toBe(false);
    // Les autres bases restent (Mes partages).
    expect(idb.raw().has("shhdrop-partages")).toBe(true);
  });
  it("aucune base : rien n'est créé, aucune erreur ; IndexedDB absent ou qui lève : aucune erreur", async () => {
    const idb = fakeIndexedDB();
    await effacerAncienHistorique(idb);
    expect(idb.raw().size).toBe(0);
    await expect(effacerAncienHistorique(undefined)).resolves.toBeUndefined();
    const casse = {
      deleteDatabase: () => {
        throw new DOMException("refus", "SecurityError");
      },
    };
    await expect(effacerAncienHistorique(casse)).resolves.toBeUndefined();
  });
});

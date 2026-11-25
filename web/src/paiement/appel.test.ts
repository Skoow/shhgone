// Appels réservés aux offres Plus et Pro : pass payé lu sur l'appareil seulement
// (aucune requête), jeton anonyme pris du portefeuille.
import { describe, expect, it } from "vitest";
import { fakeIndexedDB } from "../storage/fake-idb.test-helper";
import { jetonAppel, offresAppel } from "./appel";
import { garder, garderEtat, garderJeton, lireJetons, nouvelId, tirerPass, type PassGarde } from "./pass";

const MAINTENANT = new Date("2026-11-24T10:00:00Z");

async function pass(idb: IDBFactory, p: Partial<PassGarde> = {}): Promise<string> {
  const id = nouvelId();
  await garder(idb, { id, pass: tirerPass(), offre: "plus", jours: 30, renouvelle: true, moyen: "carte", enAttente: false, cree: 1, ...p });
  return id;
}

describe("offresAppel : lu sur l'appareil seulement", () => {
  it("sans pass (ni base) : aucune offre ; sans IndexedDB : aucune", async () => {
    expect(await offresAppel(fakeIndexedDB(), MAINTENANT)).toEqual([]);
    expect(await offresAppel(null, MAINTENANT)).toEqual([]);
  });

  it("pass Plus et Pro payés : les deux ; pass en attente : rien", async () => {
    const idb = fakeIndexedDB();
    await pass(idb, { enAttente: true });
    expect(await offresAppel(idb, MAINTENANT)).toEqual([]);
    await pass(idb, { offre: "pro" });
    await pass(idb);
    expect(await offresAppel(idb, MAINTENANT)).toEqual(["plus", "pro"]);
  });

  it("état gardé : échu, révoqué ou sans le droit d'appel → ne compte pas ; payé → compte", async () => {
    const idb = fakeIndexedDB();
    const id = await pass(idb);
    const etat = { etat: "payee", offre: "plus" as const, fin: "2026-12-20", renouvelle: true, droits: ["partage_plus", "appel_audio", "appel_video"], jour: "2026-11-24" };
    await garderEtat(idb, id, etat);
    expect(await offresAppel(idb, MAINTENANT)).toEqual(["plus"]);
    await garderEtat(idb, id, { ...etat, fin: "2026-11-24" });
    expect(await offresAppel(idb, MAINTENANT)).toEqual([]);
    await garderEtat(idb, id, { ...etat, etat: "revoquee" });
    expect(await offresAppel(idb, MAINTENANT)).toEqual([]);
    await garderEtat(idb, id, { ...etat, droits: ["partage_plus"] });
    expect(await offresAppel(idb, MAINTENANT)).toEqual([]);
  });

  it("commande en attente sur l'appareil, déjà dite payée par le serveur (état gardé) : compte", async () => {
    const idb = fakeIndexedDB();
    const id = await pass(idb, { enAttente: true });
    await garderEtat(idb, id, { etat: "attente", offre: "plus", fin: null, renouvelle: false, droits: [], jour: "2026-11-24" });
    expect(await offresAppel(idb, MAINTENANT)).toEqual([]);
    await garderEtat(idb, id, { etat: "payee", offre: "plus", fin: "2026-12-20", renouvelle: true, droits: ["partage_plus", "appel_audio", "appel_video"], jour: "2026-11-24" });
    expect(await offresAppel(idb, MAINTENANT)).toEqual(["plus"]);
  });
});

describe("jetonAppel", () => {
  it("jeton gardé de la formule : retiré du portefeuille ; sans pass ou sans IndexedDB : null", async () => {
    expect(await jetonAppel(fakeIndexedDB())).toBeNull();
    expect(await jetonAppel(null)).toBeNull();
    const idb = fakeIndexedDB();
    await pass(idb);
    const jour = new Date().toISOString().slice(0, 10);
    await garderJeton(idb, { jeton: "J".repeat(472), offre: "plus", jour, obtenu: 0 });
    expect(await jetonAppel(idb)).toBe("J".repeat(472));
    expect(await lireJetons(idb)).toEqual([]);
  });
});

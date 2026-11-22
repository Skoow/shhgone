// Portefeuille de jetons (conception du paiement §7) : formules disponibles d'après le serveur,
// jeton gardé d'abord, sinon un lot obtenu en aveugle (signé ici par node:crypto, RSA brut sur la
// clé de test des vecteurs), gardé chiffré ; jetons d'une clé trop vieille jetés. S16 : lot
// demandé en avance, à une heure tirée au hasard, et jetons « mûrs » dépensés d'abord.
import { constants, createPrivateKey, privateDecrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { b64u, unb64u } from "../engine/pure";
import { fakeIndexedDB } from "../history/fake-idb.test-helper";
import type { Net } from "./api";
import {
  DELAI_MAX_MS,
  DELAI_MIN_MS,
  JETONS_PAR_LOT,
  MUR_MS,
  clesVerifiees,
  delaiAleatoire,
  formulesDisponibles,
  jetonValable,
  planifierReapprovisionnement,
  prendreJeton,
  reapprovisionner,
  refusCles,
} from "./jetons";
import { garder, garderJeton, lireClesVues, lireJetons, lirePasses, nouvelId, tirerPass } from "./pass";

const PP = JSON.parse(readFileSync(new URL("../../../engine/vectors/privacypass.json", import.meta.url), "utf8"));
const sk = createPrivateKey({ key: Buffer.from(PP.sk_pkcs8_hex, "hex"), format: "der", type: "pkcs8" });
const MAINTENANT = new Date("2026-11-20T10:00:00Z");
const rep = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

const SPKI = b64u(Buffer.from(PP.spki_hex, "hex") as unknown as Uint8Array<ArrayBuffer>);
/** Une autre clé (342 octets) : le vecteur, un octet du module changé. */
const AUTRE = (() => {
  const b = Buffer.from(PP.spki_hex, "hex");
  b[200]! ^= 1;
  return b64u(b as unknown as Uint8Array<ArrayBuffer>);
})();
type Cle = { jour: string; offre: "plus" | "pro"; spki: string };
const CLES: Cle[] = [{ jour: "2026-11-20", offre: "plus", spki: SPKI }];

function serveur(etat: "payee" | "revoquee" = "payee", reserve = 30, cles: Cle[] = CLES) {
  const appels: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    appels.push(`${init.method} ${path}`);
    if (path === "/api/paiement/etat") return rep({ v: 1, etat, offre: "plus", fin: "2026-12-20", renouvelle: true, droits: [] });
    if (path === "/api/paiement/jetons/cles") return rep({ v: 1, emetteur: PP.issuer_name, cles });
    if (path === "/api/paiement/jetons") {
      const { requetes } = JSON.parse(init.body as string) as { requetes: string[] };
      if (reserve < requetes.length) return rep({ error: "aucun_jeton" }, 409);
      reserve -= requetes.length;
      return rep({ offre: "plus", reponses: requetes.map((r) => b64u(new Uint8Array(privateDecrypt({ key: sk, padding: constants.RSA_NO_PADDING }, unb64u(r).slice(3))))) });
    }
    return rep({ error: "not_found" }, 404);
  }) as unknown as typeof globalThis.fetch;
  return { n: { origin: "https://shh.test", fetch } as Net, appels };
}

async function avecPass(idb: IDBFactory) {
  await garder(idb, { id: nouvelId(), pass: tirerPass(), offre: "plus", jours: 30, renouvelle: true, moyen: "carte", enAttente: false, cree: 1 });
}

describe("portefeuille de jetons", () => {
  it("aucun pass : aucune formule, aucune requête", async () => {
    const { n, appels } = serveur();
    expect(await formulesDisponibles(fakeIndexedDB(), n, MAINTENANT)).toEqual([]);
    expect(appels).toEqual([]);
  });

  it("pass payé : Plus disponible ; révoqué : rien", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    expect(await formulesDisponibles(idb, serveur().n, MAINTENANT)).toEqual(["plus"]);
    expect(await formulesDisponibles(idb, serveur("revoquee").n, MAINTENANT)).toEqual([]);
  });

  it("un lot obtenu en aveugle, un jeton rendu, les autres gardés puis pris d'abord", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    const { n, appels } = serveur();
    const j1 = await prendreJeton(idb, "plus", n, MAINTENANT);
    expect(j1).toMatch(/^[A-Za-z0-9_-]{472}$/);
    expect(appels.filter((a) => a.endsWith("/api/paiement/jetons"))).toHaveLength(1);
    expect(await lireJetons(idb)).toHaveLength(JETONS_PAR_LOT - 1);
    const j2 = await prendreJeton(idb, "plus", n, MAINTENANT);
    expect(j2).not.toBe(j1);
    expect(appels.filter((a) => a.endsWith("/api/paiement/jetons"))).toHaveLength(1); // pris dans le portefeuille
    expect(await lireJetons(idb)).toHaveLength(JETONS_PAR_LOT - 2);
    // Pro : aucun pass Pro.
    await expect(prendreJeton(idb, "pro", n, MAINTENANT)).rejects.toThrow("aucun_jeton");
  });

  it("réserve épuisée : aucun_jeton ; jeton d'une clé d'avant-hier jeté", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    await expect(prendreJeton(idb, "plus", serveur("payee", 0).n, MAINTENANT)).rejects.toThrow("aucun_jeton");
    await garderJeton(idb, { jeton: "A".repeat(472), offre: "plus", jour: "2026-11-18" });
    await expect(prendreJeton(idb, "plus", serveur("payee", 0).n, MAINTENANT)).rejects.toThrow("aucun_jeton");
    expect(await lireJetons(idb)).toEqual([]);
    expect(jetonValable("2026-11-19", MAINTENANT)).toBe(true);
    expect(jetonValable("2026-11-20", MAINTENANT)).toBe(true);
    expect(jetonValable("2026-11-18", MAINTENANT)).toBe(false);
  });
});

// S16 (conception du paiement §7, §15) : l'émission ne doit pas précéder la dépense de quelques
// secondes. Réapprovisionnement programmé à une heure aléatoire, jetons mûrs dépensés d'abord.
describe("S16 : émission en avance, à une heure aléatoire", () => {
  const emissions = (appels: string[]) => appels.filter((a) => a.endsWith("/api/paiement/jetons")).length;
  const plus = (ms: number) => new Date(MAINTENANT.getTime() + ms);

  it("réapprovisionner : réserve vide → un lot gardé entier ; réserve non vide → aucune requête", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    const { n, appels } = serveur();
    expect(await reapprovisionner(idb, "plus", n, MAINTENANT)).toBe(JETONS_PAR_LOT);
    const gardes = await lireJetons(idb);
    expect(gardes).toHaveLength(JETONS_PAR_LOT);
    expect(gardes.every((j) => j.obtenu === MAINTENANT.getTime() && j.jour === "2026-11-20")).toBe(true);
    expect(await reapprovisionner(idb, "plus", n, MAINTENANT)).toBe(0);
    expect(emissions(appels)).toBe(1);
    // Sans pass Pro : rien, aucune émission.
    expect(await reapprovisionner(idb, "pro", n, MAINTENANT)).toBe(0);
    expect(emissions(appels)).toBe(1);
  });

  it("aucun pass, ou réserve du serveur épuisée : rien gardé, aucune erreur", async () => {
    const { n, appels } = serveur();
    expect(await reapprovisionner(fakeIndexedDB(), "plus", n, MAINTENANT)).toBe(0);
    expect(appels.filter((a) => a.includes("/jetons"))).toEqual([]);
    const idb = fakeIndexedDB();
    await avecPass(idb);
    expect(await reapprovisionner(idb, "plus", serveur("payee", 0).n, MAINTENANT)).toBe(0);
    expect(await lireJetons(idb)).toEqual([]);
  });

  it("dépense après un réapprovisionnement : aucune émission au moment du partage", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    const { n, appels } = serveur();
    await reapprovisionner(idb, "plus", n, MAINTENANT);
    for (let i = 0; i < JETONS_PAR_LOT; i++) await prendreJeton(idb, "plus", n, plus(MUR_MS + i));
    expect(emissions(appels)).toBe(1);
  });

  it("jeton mûr (obtenu au moins MUR_MS avant) dépensé avant un jeton frais ; à maturité égale, le plus près d'expirer", async () => {
    const idb = fakeIndexedDB();
    const t = MAINTENANT.getTime();
    await garderJeton(idb, { jeton: "F".repeat(472), offre: "plus", jour: "2026-11-20", obtenu: t - 1_000 });
    await garderJeton(idb, { jeton: "M".repeat(472), offre: "plus", jour: "2026-11-20", obtenu: t - MUR_MS });
    await garderJeton(idb, { jeton: "V".repeat(472), offre: "plus", jour: "2026-11-19", obtenu: t - 2 * MUR_MS });
    const { n, appels } = serveur();
    expect(await prendreJeton(idb, "plus", n, MAINTENANT)).toBe("V".repeat(472));
    expect(await prendreJeton(idb, "plus", n, MAINTENANT)).toBe("M".repeat(472));
    // Plus aucun jeton mûr : le frais est dépensé (jamais d'attente imposée au partage).
    expect(await prendreJeton(idb, "plus", n, MAINTENANT)).toBe("F".repeat(472));
    expect(appels).toEqual([]);
  });

  it("jeton gardé par une version précédente (sans heure d'obtention) : compté comme mûr", async () => {
    const idb = fakeIndexedDB();
    await garderJeton(idb, { jeton: "A".repeat(472), offre: "plus", jour: "2026-11-20" });
    expect((await lireJetons(idb))[0]!.obtenu).toBe(0);
  });

  it("délai tiré au hasard par crypto.getRandomValues, dans [DELAI_MIN_MS, DELAI_MAX_MS)", () => {
    expect(delaiAleatoire(new Uint32Array([0]))).toBe(DELAI_MIN_MS);
    expect(delaiAleatoire(new Uint32Array([0xffffffff]))).toBeLessThan(DELAI_MAX_MS);
    expect(delaiAleatoire(new Uint32Array([0x80000000]))).toBe(DELAI_MIN_MS + (DELAI_MAX_MS - DELAI_MIN_MS) / 2);
    expect(DELAI_MIN_MS).toBeGreaterThanOrEqual(MUR_MS);
    const vus = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const d = delaiAleatoire();
      expect(d).toBeGreaterThanOrEqual(DELAI_MIN_MS);
      expect(d).toBeLessThan(DELAI_MAX_MS);
      vus.add(d);
    }
    expect(vus.size).toBeGreaterThan(1);
  });

  it("planifier : une seule minuterie par offre, délai aléatoire, réapprovisionne au déclenchement ; annulable", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    const { n, appels } = serveur();
    const minuteries: { f: () => void; ms: number; annulee: boolean }[] = [];
    const minuteur = (f: () => void, ms: number) => {
      const m = { f, ms, annulee: false };
      minuteries.push(m);
      return () => {
        m.annulee = true;
      };
    };
    let fini: Promise<unknown> | undefined;
    const o = { n, minuteur, horloge: () => MAINTENANT, apres: (p: Promise<unknown>) => void (fini = p) };
    const annuler = planifierReapprovisionnement(idb, "plus", o);
    planifierReapprovisionnement(idb, "plus", o); // déjà planifiée : rien de plus
    expect(minuteries).toHaveLength(1);
    expect(minuteries[0]!.ms).toBeGreaterThanOrEqual(DELAI_MIN_MS);
    expect(minuteries[0]!.ms).toBeLessThan(DELAI_MAX_MS);
    expect(emissions(appels)).toBe(0); // rien avant l'heure tirée
    minuteries[0]!.f();
    await fini;
    expect(emissions(appels)).toBe(1);
    expect(await lireJetons(idb)).toHaveLength(JETONS_PAR_LOT);
    // Après le déclenchement, une nouvelle planification est possible ; annulée, elle ne part pas.
    const annuler2 = planifierReapprovisionnement(idb, "plus", o);
    expect(minuteries).toHaveLength(2);
    annuler2();
    expect(minuteries[1]!.annulee).toBe(true);
    annuler(); // sans effet sur une minuterie déjà partie
  });
});

// S17 (conception du paiement §7, §15) : clés publiées 7 jours à l'avance ; l'appareil garde
// celles qu'il a vues et refuse une clé différente pour un (jour, formule) déjà vu.
describe("S17 : même clé pour tous, vérifiée par l'appareil", () => {
  const emissions = (appels: string[]) => appels.filter((a) => a.endsWith("/api/paiement/jetons")).length;

  it("clés vues gardées (chiffrées, avec le pass) ; la même clé ensuite : acceptée", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    const cles = [...CLES, { jour: "2026-11-27", offre: "pro" as const, spki: AUTRE }];
    const v = await clesVerifiees(idb, serveur("payee", 30, cles).n, MAINTENANT);
    expect(v?.refusees).toEqual([]);
    expect(v?.cles.map((c) => `${c.jour}/${c.offre}`)).toEqual(["2026-11-20/plus", "2026-11-27/pro"]);
    expect((await lireClesVues(idb)).map((c) => `${c.jour}/${c.offre}/${c.differente}`).sort()).toEqual(["2026-11-20/plus/false", "2026-11-27/pro/false"]);
    // Sur « disque » : chiffré (ni la clé ni le jour en clair).
    const disque = JSON.stringify([...idb.raw().values()].flatMap((s) => [...s.values()].flatMap((m) => [...m.entries()])), (_k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString("latin1") : x));
    expect(disque).not.toContain("2026-11-27");
    expect(disque).not.toContain(SPKI.slice(0, 40));
    expect((await clesVerifiees(idb, serveur("payee", 30, cles).n, MAINTENANT))?.refusees).toEqual([]);
    expect(await lirePasses(idb)).toHaveLength(1); // les enregistrements de clés ne sont pas des pass
  });

  it("clé différente pour un (jour, formule) déjà vu : refusée, ni émission ni dépense sous elle, même si le serveur revient ensuite à l'ancienne", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    await clesVerifiees(idb, serveur().n, MAINTENANT);
    await garderJeton(idb, { jeton: "A".repeat(472), offre: "plus", jour: "2026-11-20", obtenu: 1 });
    const { n, appels } = serveur("payee", 30, [{ jour: "2026-11-20", offre: "plus", spki: AUTRE }]);
    const v = await clesVerifiees(idb, n, MAINTENANT);
    expect(v?.refusees).toEqual([{ jour: "2026-11-20", offre: "plus" }]);
    expect(v?.cles).toEqual([]);
    // Écran : avertissement et formule Plus retirée aujourd'hui (lu sur l'appareil, aucune requête).
    const avant = appels.length;
    expect(await refusCles(idb, MAINTENANT)).toEqual({ avertir: true, formules: ["plus"] });
    expect(await refusCles(idb, new Date("2026-11-21T10:00:00Z"))).toEqual({ avertir: true, formules: [] });
    expect(await refusCles(fakeIndexedDB(), MAINTENANT)).toEqual({ avertir: false, formules: [] });
    expect(appels.length).toBe(avant);
    await expect(prendreJeton(idb, "plus", n, MAINTENANT)).rejects.toThrow("cle_differente");
    expect(await reapprovisionner(idb, "plus", n, MAINTENANT)).toBe(0);
    expect(emissions(appels)).toBe(0);
    expect(await lireJetons(idb)).toHaveLength(1); // gardé, jamais dépensé
    // Retour à l'ancienne clé : toujours refusée (le serveur s'est contredit pour ce jour).
    const s2 = serveur();
    expect((await clesVerifiees(idb, s2.n, MAINTENANT))?.refusees).toEqual([{ jour: "2026-11-20", offre: "plus" }]);
    await expect(prendreJeton(idb, "plus", s2.n, MAINTENANT)).rejects.toThrow("cle_differente");
    expect(emissions(s2.appels)).toBe(0);
  });

  it("clé jamais vue alors qu'un autre jour a été vu : rien à comparer, acceptée ; clés d'avant la veille oubliées", async () => {
    const idb = fakeIndexedDB();
    await avecPass(idb);
    await clesVerifiees(idb, serveur().n, MAINTENANT);
    const demain = new Date("2026-11-21T10:00:00Z");
    const v = await clesVerifiees(idb, serveur("payee", 30, [{ jour: "2026-11-21", offre: "plus", spki: AUTRE }]).n, demain);
    expect(v?.refusees).toEqual([]);
    expect((await lireClesVues(idb)).map((c) => c.jour).sort()).toEqual(["2026-11-20", "2026-11-21"]);
    await clesVerifiees(idb, serveur("payee", 30, []).n, new Date("2026-11-22T10:00:00Z"));
    expect((await lireClesVues(idb)).map((c) => c.jour)).toEqual(["2026-11-21"]);
  });

  it("sans pass : rien n'est gardé ni créé", async () => {
    const idb = fakeIndexedDB();
    expect((await clesVerifiees(idb, serveur().n, MAINTENANT))?.refusees).toEqual([]);
    expect(await lireClesVues(idb)).toEqual([]);
    expect(idb.raw().size).toBe(0);
  });
});

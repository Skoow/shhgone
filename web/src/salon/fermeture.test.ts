import { describe, expect, it } from "vitest";
import { lireAverti, palierAnnonce, rebours, seuilAAfficher } from "./fermeture";

const MIN = 60_000;
const FIN = 10_000_000_000;
const a = (reste: number) => FIN - reste;

describe("alerte avant la fin du salon", () => {
  it("rien tant qu'il reste plus de 30 min", () => {
    expect(seuilAAfficher(FIN, a(30 * MIN + 1), null)).toBeNull();
    expect(seuilAAfficher(FIN, a(6 * 60 * MIN), null)).toBeNull();
  });

  it("chaque seuil au moment où il est franchi", () => {
    expect(seuilAAfficher(FIN, a(30 * MIN), null)).toBe(30);
    expect(seuilAAfficher(FIN, a(15 * MIN), { finMs: FIN, seuil: 30 })).toBe(15);
    expect(seuilAAfficher(FIN, a(5 * MIN), { finMs: FIN, seuil: 15 })).toBe(5);
    expect(seuilAAfficher(FIN, a(1 * MIN), { finMs: FIN, seuil: 5 })).toBe(1);
  });

  it("un seuil déjà affiché ne l'est plus (rechargement compris)", () => {
    expect(seuilAAfficher(FIN, a(29 * MIN), { finMs: FIN, seuil: 30 })).toBeNull();
    expect(seuilAAfficher(FIN, a(14 * MIN), { finMs: FIN, seuil: 15 })).toBeNull();
    expect(seuilAAfficher(FIN, a(10_000), { finMs: FIN, seuil: 1 })).toBeNull();
    // Échéance recalculée à quelques secondes près : c'est la même.
    expect(seuilAAfficher(FIN + 2000, a(14 * MIN), { finMs: FIN, seuil: 15 })).toBeNull();
  });

  it("arrivée tardive : seul le seuil franchi le plus proche est dit", () => {
    expect(seuilAAfficher(FIN, a(12 * MIN), null)).toBe(15);
    expect(seuilAAfficher(FIN, a(3 * MIN), null)).toBe(5);
    expect(seuilAAfficher(FIN, a(30_000), null)).toBe(1);
    // Onglet endormi de 20 à 3 min : « 5 min » seulement, pas « 15 min » en plus.
    expect(seuilAAfficher(FIN, a(3 * MIN), { finMs: FIN, seuil: 30 })).toBe(5);
  });

  it("rien une fois l'échéance passée", () => {
    expect(seuilAAfficher(FIN, FIN, null)).toBeNull();
    expect(seuilAAfficher(FIN, FIN + 1, null)).toBeNull();
    expect(seuilAAfficher(0, 1, null)).toBeNull();
  });

  it("renouvellement : la nouvelle échéance remet les seuils à zéro", () => {
    const fin2 = FIN + 50 * MIN;
    expect(seuilAAfficher(fin2, a(10 * MIN), { finMs: FIN, seuil: 15 })).toBeNull();
    expect(seuilAAfficher(fin2, fin2 - 30 * MIN, { finMs: FIN, seuil: 15 })).toBe(30);
  });

  it("dernière minute : compte à rebours à la seconde", () => {
    expect(rebours(FIN, a(MIN + 1))).toBeNull();
    expect(rebours(FIN, a(MIN))).toBe(60);
    expect(rebours(FIN, a(41_200))).toBe(42);
    expect(rebours(FIN, a(1))).toBe(1);
    expect(rebours(FIN, FIN)).toBeNull();
  });

  it("lecteur d'écran : seulement 1 min, 30 s et 10 s", () => {
    const vus = new Set<number>();
    for (let s = 60; s >= 1; s--) vus.add(palierAnnonce(s));
    expect([...vus]).toEqual([60, 30, 10]);
    expect(palierAnnonce(31)).toBe(60);
    expect(palierAnnonce(30)).toBe(30);
    expect(palierAnnonce(11)).toBe(30);
    expect(palierAnnonce(10)).toBe(10);
  });

  it("averti relu : valeurs inattendues refusées", () => {
    expect(lireAverti({ finMs: FIN, seuil: 15 })).toEqual({ finMs: FIN, seuil: 15 });
    for (const x of [null, 3, "x", { finMs: FIN }, { finMs: FIN, seuil: 7 }, { finMs: 1.5, seuil: 5 }, { finMs: "1", seuil: 5 }]) expect(lireAverti(x)).toBeNull();
  });
});

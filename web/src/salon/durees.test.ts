import { describe, expect, it } from "vitest";
import { DUREES, DUREES_LONGUES, PLACES_MAX, PLACES_SUR_MESURE_MAX, TOUTES, dureeEnJours, dureesPermises, placesPermises } from "./durees";

// Durées et places proposées selon les limites du compte (GET /api/compte, `limites`) : un
// compte ordinaire (24 h, 10 places au plus) ne voit rien de plus qu'avant ; un compte sur mesure
// voit les durées longues et les places que ses limites permettent, jamais au-delà.
describe("durées et places proposées", () => {
  it("compte ordinaire : 1, 6, 12, 24 h ; neuf : 4 places, confirmé : 10", () => {
    expect(dureesPermises(24)).toEqual([1, 6, 12, 24]);
    expect(dureesPermises(undefined)).toEqual([1, 6, 12, 24]);
    expect(dureesPermises(Number.NaN)).toEqual([1, 6, 12, 24]);
    expect(placesPermises(4)).toBe(4);
    expect(placesPermises(10)).toBe(10);
    expect(placesPermises(undefined)).toBe(PLACES_MAX);
  });

  it("compte sur mesure : durées longues jusqu'à sa limite, places jusqu'à 50", () => {
    expect(dureesPermises(720)).toEqual([1, 6, 12, 24, 72, 168, 336, 720]);
    expect(dureesPermises(7 * 24)).toEqual([1, 6, 12, 24, 72, 168]);
    expect(dureesPermises(10 * 24)).toEqual([1, 6, 12, 24, 72, 168]); // 10 jours : 7 au plus
    expect(dureesPermises(2 * 24)).toEqual([1, 6, 12, 24]);
    expect(dureesPermises(24 * 3)).toContain(72);
    expect(placesPermises(50)).toBe(50);
    expect(placesPermises(37)).toBe(37);
  });

  it("jamais au-delà des bornes du serveur, quoi que dise la réponse", () => {
    expect(dureesPermises(100_000)).toEqual([...TOUTES]);
    expect(placesPermises(999)).toBe(PLACES_SUR_MESURE_MAX);
    expect(placesPermises(1)).toBe(2);
    expect(placesPermises(2.5)).toBe(PLACES_MAX);
    expect(dureesPermises(0)).toEqual([]);
  });

  it("affichage : heures jusqu'à 24 h, jours ensuite", () => {
    expect(DUREES.map(dureeEnJours)).toEqual([null, null, null, null]);
    expect(DUREES_LONGUES.map(dureeEnJours)).toEqual([3, 7, 14, 30]);
  });
});

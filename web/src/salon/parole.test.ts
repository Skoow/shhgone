// « Qui parle » : niveau efficace et hystérésis (sans navigateur).
import { describe, expect, it } from "vitest";
import { Parole, niveau } from "./parole";

const onde = (amp: number, n = 512) => Uint8Array.from({ length: n }, (_, i) => Math.round(128 + amp * 127 * Math.sin(i / 3)));

describe("parole", () => {
  it("niveau : silence 0, onde pleine ≈ 0,7, vide 0", () => {
    expect(niveau(onde(0))).toBe(0);
    expect(niveau(onde(1))).toBeGreaterThan(0.65);
    expect(niveau(onde(1))).toBeLessThan(0.75);
    expect(niveau(new Uint8Array())).toBe(0);
  });

  it("parle au-dessus du seuil, se tait seulement après la tenue sous 70 % du seuil", () => {
    const p = new Parole(0.04, 450);
    expect(p.mesure(0.01, 0)).toBe(false);
    expect(p.mesure(0.05, 100)).toBe(true);
    expect(p.parle).toBe(true);
    // Entre deux syllabes : au-dessus de 70 % du seuil, rien ne change.
    expect(p.mesure(0.03, 200)).toBe(false);
    expect(p.mesure(0.01, 300)).toBe(false);
    expect(p.mesure(0.01, 700)).toBe(false);
    expect(p.parle).toBe(true);
    // Une reprise remet la tenue à zéro.
    expect(p.mesure(0.06, 720)).toBe(false);
    expect(p.mesure(0.0, 800)).toBe(false);
    expect(p.mesure(0.0, 1260)).toBe(true);
    expect(p.parle).toBe(false);
  });
});

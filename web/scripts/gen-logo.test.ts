// Logo « Trame » et marque « S qui s'efface » (scripts/gen-logo.mjs) : sorties à jour, géométrie tenue.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error module .mjs sans déclarations
import { MARK, MARK_SMALL, OUTPUTS, build, mark, sGeom } from "./gen-logo.mjs";
// @ts-expect-error module .mjs sans déclarations
import { ico } from "./gen-icons.mjs";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
type Dot = [number, number, number];

/** Points du S : rayons décroissants, écarts croissants et positifs (aucun point ne touche son voisin). */
function checkTrail(dots: Dot[]) {
  let last = Infinity, lastGap = -Infinity;
  for (let i = 0; i < dots.length; i++) {
    const [x, y, r] = dots[i]!;
    expect(r).toBeLessThan(last);
    last = r;
    if (i > 0) {
      const [px, py, pr] = dots[i - 1]!;
      const gap = Math.hypot(x - px, y - py) - r - pr;
      expect(gap).toBeGreaterThan(0.2);
      expect(gap).toBeGreaterThan(lastGap - 0.25); // l'écart grandit (à l'écart près de la dérive)
      lastGap = gap;
    }
  }
}

describe("gen-logo", () => {
  it("les fichiers commités sont ceux que produit le générateur", () => {
    for (const [rel, gen] of Object.entries(OUTPUTS as Record<string, () => string>))
      expect(readFileSync(join(web, rel), "utf8"), rel).toBe(gen());
  });

  it("trame légère : 6 tranches, une soixantaine de points (« gone »), rien d'autre qu'arcs et déplacements ; le S à part", () => {
    const b = build();
    expect(b.dots).toHaveLength(6);
    expect(b.count).toBeGreaterThan(50);
    expect(b.count).toBeLessThan(70);
    for (const d of b.dots) expect(d).toMatch(/^(M[-\d. ]+a[-\d. ]+a[-\d. ]+)+$/);
    checkTrail(b.capDots);
  });

  it("mot-symbole « Shhgone » : S capitale + « hh » pleins (3 lettres), « gone » en trame, nommé Shhgone", () => {
    const b = build();
    expect(b.cap.match(/M/g)).toHaveLength(1); // S : 1 tracé, à part (bouts arrondis)
    expect(b.head.match(/M/g)).toHaveLength(4); // h : 2 chacun
    const svg = (OUTPUTS as Record<string, () => string>)["public/logo.svg"]!();
    expect(svg).toContain('aria-label="Shhgone"');
    expect(svg).not.toMatch(/shhdrop/i);
  });

  it("S : épine continue (deux arcs exacts), le reste repris par le fantôme de la gomme", () => {
    const g = sGeom(MARK);
    expect(g.solid).toMatch(/^M[-\d. ]+A[-\d. ]+A[-\d. ]+$/);
    const end = g.solid.split(" ").slice(-2).join(" ");
    expect(g.rest.startsWith(`M${end}A`)).toBe(true);
    // S tracé jusqu'au bout (coupe au-delà d'un demi-tour de la panse basse) : grand arc.
    const plein = sGeom({ ...MARK, cut: 150, n: 2, r0: 1, r1: 0.5, drift: 0, ext: 1 });
    expect(plein.solid.split("A")[2]!.split(" ")[3]).toBe("1");
  });

  it("marque : S dans la tuile (marge ≥ 2 u), points qui s'effacent, variante 16 px à trois points plus gros", () => {
    for (const [conf, n] of [[MARK, 6], [MARK_SMALL, 3]] as const) {
      const m = mark(conf === MARK_SMALL);
      const dots = m.geom.dots as Dot[];
      expect(dots).toHaveLength(n);
      checkTrail(dots);
      for (const [x, y, r] of dots) {
        expect(x - r).toBeGreaterThanOrEqual(2);
        expect(x + r).toBeLessThanOrEqual(30);
        expect(y + r).toBeLessThanOrEqual(30);
      }
      // Bornes du trait : dans la tuile, marge de 2 u au moins.
      expect(conf.cx - conf.rx - conf.W / 2).toBeGreaterThanOrEqual(2);
      expect(m.geom.top).toBeGreaterThanOrEqual(2);
      expect(m.geom.bottom).toBeLessThanOrEqual(30);
    }
    expect(MARK_SMALL.r1).toBeGreaterThanOrEqual(1.25); // ≥ 0,6 px à 16 px
  });

  it("un seul S : l'initiale du mot et la marque ont les mêmes proportions (à l'échelle du trait près)", () => {
    const b = build();
    // Mêmes arcs : rayons de l'initiale = rayons de la marque × (5 / 4).
    const arcs = (d: string) => [...d.matchAll(/A([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const k = 5 / MARK.W;
    for (const [[a, b2], [c, d]] of arcs(b.cap).map((x, i) => [x, arcs(mark().stroke)[i]!] as const)) {
      expect(a).toBeCloseTo(c! * k, 2);
      expect(b2).toBeCloseTo(d! * k, 2);
    }
    expect(b.capAlpha).toEqual(mark().geom.alpha);
  });

  it("favicon.ico : en-tête ICO, entrées 16 et 32 en PNG", () => {
    const buf = readFileSync(join(web, "public", "favicon.ico"));
    expect([buf.readUInt16LE(0), buf.readUInt16LE(2), buf.readUInt16LE(4)]).toEqual([0, 1, 2]);
    expect([buf[6], buf[22]]).toEqual([16, 32]);
    const off = buf.readUInt32LE(6 + 12);
    expect(buf.subarray(off, off + 4).toString("latin1")).toBe("\x89PNG");
    const one = ico([{ size: 16, data: Buffer.from("x") }]);
    expect(one.readUInt32LE(18)).toBe(22);
  });
});

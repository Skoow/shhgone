// Contour de temps (audit du 25 novembre) : filet discret, encoches en coupures (masque) qui ne
// dépassent jamais du bord de la carte (plus de petit trait clair sous la carte de suivi).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/ui/TimeRim.svelte", "utf8");
const css = src.slice(src.indexOf("<style>"));

describe("TimeRim : filet discret", () => {
  it("temps restant : menthe atténuée, trait fin (plus de menthe pleine de 2 px)", () => {
    const time = /\n {2}\.time \{[^}]*\}/.exec(css)![0];
    expect(time).toMatch(/color-mix\(in oklab, var\(--accent\) \d{2}%, transparent\)/);
    expect(Number(/stroke-width: ([\d.]+)/.exec(time)![1])).toBeLessThan(2);
  });
  it("encoches : coupures du filet par un masque, aucun trait dessiné par-dessus le bord", () => {
    expect(src).toMatch(/<mask id="\{uid\}-cut"/);
    expect(src).toMatch(/mask=\{notchDash \? `url\(#\$\{uid\}-cut\)` : undefined\}/);
    expect(src).not.toMatch(/class="notch"/);
    expect(css).not.toMatch(/seal-light/);
  });
});

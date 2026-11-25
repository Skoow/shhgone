// Zoom permis sur téléphone (WCAG 1.4.4 ; rétabli, qui
// remplace le blocage) : aucune page ne limite l'agrandissement, aucun script ne
// refuse le pincement.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "pkg" ? [] : sources(p);
    return /\.(ts|svelte)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

describe("zoom permis", () => {
  it("les trois pages : viewport sans maximum-scale ni user-scalable", () => {
    for (const f of ["index.html", "page.html", "s.html"]) {
      const html = readFileSync(join(process.cwd(), f), "utf8");
      expect(html, f).toMatch(/name="viewport"\s+content="width=device-width, initial-scale=1, viewport-fit=cover/);
      expect(html, f).not.toMatch(/maximum-scale|user-scalable|minimum-scale/);
    }
  });

  it("aucun script ne refuse le pincement (gesturestart)", () => {
    for (const f of sources(join(process.cwd(), "src"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/gesturestart|gesturechange/);
    }
  });
});

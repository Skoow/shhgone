// Barre du haut et raccords des sections de l'accueil (retours du 25 novembre) : le lien « Salon »
// n'a plus de curseur « interdit », les écritures de la barre sont blanches, et une section droite
// posée sous une section en biais a son filet le long de la coupe (jamais un trait droit dessous).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nav = readFileSync("src/ui/TopNav.svelte", "utf8");
const navCss = nav.slice(nav.indexOf("<style>"));
const base = readFileSync("src/ui/base.css", "utf8");

describe("barre du haut", () => {
  it("Salon : aucune règle qui vise la classe .room seule (le lien garde le curseur des autres)", () => {
    expect(navCss).not.toMatch(/\n {2}\.room \{/);
    expect(navCss).not.toMatch(/\.room[^{]*\{[^}]*not-allowed/);
    // « interdit » seulement pour ce qui est désactivé (bientôt, envoi en cours).
    for (const m of navCss.matchAll(/([^{}]+)\{[^}]*cursor: not-allowed/g)) expect(m[1]).toMatch(/aria-disabled|login-soon/);
  });
  it("écritures blanches", () => {
    const nl = /\n {2}\.nl \{[^}]*\}/.exec(navCss)![0];
    expect(nl).toMatch(/color: #fff;/);
  });
});

describe("raccords des sections", () => {
  it("une section droite sous un biais : filet tourné, dans les deux sens de pente", () => {
    expect(base).toMatch(/\.fondu-biais:not\(\.fondu-biais-inv\) \+ \.fondu\.filet:not\(\.fondu-biais\)::after \{[^}]*rotate: -1\.72deg/);
    expect(base).toMatch(/\.fondu-biais-inv \+ \.fondu\.filet:not\(\.fondu-biais\)::after \{[^}]*top: calc\(-1 \* var\(--pente\)\);[^}]*rotate: 1\.72deg/);
    expect(base).toMatch(/\.fondu-biais:not\(\.fondu-biais-inv\) \+ \.fondu\.filet:not\(\.fondu-biais\)::after \{\s*rotate: -2\.86deg/);
  });
});

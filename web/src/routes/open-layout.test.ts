// Écran d'ouverture (audit du 25 novembre) : le mot de passe puis « Déverrouiller » d'abord ; le
// coût d'ouverture en information neutre sous le bouton (plus d'encadré jaune) ; « Garder ce
// partage » replié dans « Options » ; une pastille d'état au lieu du contour menthe plein.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/routes/Open.svelte", "utf8");
const css = src.slice(src.indexOf("<style>"));
const at = (s: string) => {
  const i = src.indexOf(s);
  expect(i, s).toBeGreaterThan(-1);
  return i;
};

describe("ouverture : ordre et ton", () => {
  it("champ, puis bouton, puis coût d'ouverture, puis options repliées", () => {
    expect(at('id="shh-unlock"')).toBeLessThan(at('class="cta dock"'));
    expect(at('class="cta dock"')).toBeLessThan(at('id="open-cost"'));
    expect(at('id="open-cost"')).toBeLessThan(at("data-open-options"));
    expect(at("data-open-options")).toBeLessThan(at("<Case "));
    expect(src.slice(at("data-open-options"), at("</details>"))).toContain("<Case ");
  });
  it("le coût d'ouverture n'est plus en jaune d'alerte", () => {
    const cost = /\n {2}\.cost \{[^}]*\}/.exec(css)![0];
    expect(cost).not.toMatch(/--warn/);
  });
  it("pastille d'état sur l'écran verrouillé et sur la barre du contenu", () => {
    expect(src.match(/<StateChip state="ready" \/>/g)).toHaveLength(2);
  });
});

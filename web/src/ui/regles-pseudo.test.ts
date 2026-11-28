// Règles du pseudo affichées pendant la saisie : mêmes bornes que le moteur (texte.rs) et même
// verdict que les vecteurs communs (compte-v3.json, section `pseudo`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PSEUDO_MAX, PSEUDO_MIN, reglesPseudo } from "./regles-pseudo";

const racine = new URL("../../../", import.meta.url);
const vecteurs = JSON.parse(readFileSync(new URL("engine/vectors/compte-v3.json", racine), "utf8")) as { pseudo: { label: string; entree_hex: string; error?: string }[] };

describe("règles du pseudo", () => {
  it("bornes : celles du moteur (PSEUDO_MIN, PSEUDO_MAX de texte.rs)", () => {
    const rs = readFileSync(new URL("engine/core/src/texte.rs", racine), "utf8");
    expect(rs).toContain(`pub const PSEUDO_MIN: usize = ${PSEUDO_MIN};`);
    expect(rs).toContain(`pub const PSEUDO_MAX: usize = ${PSEUDO_MAX};`);
  });

  it("vecteurs communs : une erreur du moteur est une règle non tenue ; un pseudo accepté tient les deux", () => {
    expect(vecteurs.pseudo.length).toBeGreaterThan(20);
    for (const c of vecteurs.pseudo) {
      const v = new TextDecoder().decode(Uint8Array.from(c.entree_hex.match(/../g) ?? [], (h) => parseInt(h, 16)));
      const r = reglesPseudo(v);
      if (c.error === "pseudo_longueur") expect(r.longueur, c.label).toBe(false);
      else if (c.error === "pseudo_caracteres") expect(r.caracteres, c.label).toBe(false);
      else if (c.error === undefined) expect(r, c.label).toEqual({ caracteres: true, longueur: true });
    }
  });

  it("saisie en cours : vide, trop court, accent, trop long, valide", () => {
    expect(reglesPseudo("")).toEqual({ caracteres: false, longueur: false });
    expect(reglesPseudo("a")).toEqual({ caracteres: true, longueur: false });
    expect(reglesPseudo("Léa")).toEqual({ caracteres: false, longueur: true });
    expect(reglesPseudo("a".repeat(25))).toEqual({ caracteres: true, longueur: false });
    expect(reglesPseudo("  Lea42 ")).toEqual({ caracteres: true, longueur: true });
  });
});

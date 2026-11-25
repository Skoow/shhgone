import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error script Node sans types
import { module, teinter } from "../../scripts/emojis.mjs";
import { GROUPES, TEINTABLES } from "./emojis.gen";
import { loadSalonEngine } from "./engine";

const SRC = readFileSync(new URL("../../../engine/salon/data/emoji-test-15.0.txt", import.meta.url), "utf8");

describe("émojis du sélecteur", () => {
  it("emojis.gen.ts est celui que donne la source commitée du moteur (node scripts/emojis.mjs)", () => {
    expect(readFileSync(new URL("./emojis.gen.ts", import.meta.url), "utf8")).toBe(module(SRC));
  });
  it("9 groupes, sans « Component » ni teinte de peau ; chaque émoji est une réaction admise par le moteur", async () => {
    expect(GROUPES.map((g) => g.nom)).toEqual(["Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"]);
    const eng = await loadSalonEngine();
    const tous = GROUPES.flatMap((g) => g.e);
    expect(tous.some((e) => /[\u{1F3FB}-\u{1F3FF}]/u.test(e))).toBe(false);
    // Le moteur refuse toute réaction qui n'est pas une séquence de sa liste.
    for (const e of [...tous, ...[...TEINTABLES].slice(0, 40).map((i) => teinter(tous[i], 0x1f3fd))])
      expect(() => eng.encoder({ id: new Uint8Array(16), heureMs: 0, regle: 0, message: { k: "reaction", cible: new Uint8Array(16), emoji: e } }), e).not.toThrow();
  });
});

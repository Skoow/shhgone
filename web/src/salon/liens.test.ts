// Liens du salon (liens.ts) : lecture du fragment, et détection d'un lien de gestion dans un texte
// tapé ou collé dans la conversation (32 : il ne part jamais dans un message).
import { describe, expect, it } from "vitest";
import { b64u } from "../engine/pure";
import { lienGestionDans, lienSalon } from "./liens";

const cle = new Uint8Array(32).map((_, i) => i * 7 + 1);
const gestion = lienSalon("https://shhgone.test", "s", cle);
const invitation = lienSalon("https://shhgone.test", "c", cle);

describe("lienGestionDans", () => {
  it("trouve le lien de gestion seul, entouré de texte, ou sans l'origine", () => {
    for (const t of [gestion, `  ${gestion}\n`, `voici ${gestion} merci`, gestion.slice(gestion.indexOf("#")), "/salon" + gestion.slice(gestion.indexOf("#"))]) {
      expect(lienGestionDans(t)).toEqual(cle);
    }
  });

  it("ignore l'invitation, un texte ordinaire, un fragment trop court ou trop long, une autre longueur", () => {
    const frag = gestion.slice(gestion.indexOf("#") + 2);
    for (const t of [invitation, "bonjour", "#s" + frag.slice(1), "#s" + frag + "A", "#salon", "x#s" + b64u(new Uint8Array(31) as Uint8Array<ArrayBuffer>)]) {
      expect(lienGestionDans(t)).toBeNull();
    }
  });

  it("deux liens de gestion : le premier", () => {
    const autre = lienSalon("https://shhgone.test", "s", new Uint8Array(32).fill(9));
    expect(lienGestionDans(`${gestion} ${autre}`)).toEqual(cle);
  });
});

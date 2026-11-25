// Pages bilingues : adresses « /en… », langue fixée par l'adresse, liens internes
// qui restent dans la langue affichée ; rien de tout cela dans la démo.
import { describe, expect, it } from "vitest";
import { langueDeLAdresse } from "../i18n/i18n.svelte";
import { PAGES_BILINGUES, cheminEn, langueDuChemin } from "./langues";
import { href, match } from "./router.svelte";

describe("pages bilingues", () => {
  it("adresse anglaise de chaque page bilingue", () => {
    expect(cheminEn("en", "/")).toBe("/en");
    expect(cheminEn("en", "/securite")).toBe("/en/securite");
    expect(cheminEn("fr", "/securite")).toBe("/securite");
    for (const p of PAGES_BILINGUES) expect(langueDuChemin(cheminEn("en", p))).toEqual({ lang: "en", chemin: p });
  });

  it("langue de l'adresse : /en… anglais, version française français, le reste null", () => {
    expect(langueDuChemin("/en")).toEqual({ lang: "en", chemin: "/" });
    expect(langueDuChemin("/en/offres")).toEqual({ lang: "en", chemin: "/offres" });
    expect(langueDuChemin("/securite.html")).toEqual({ lang: "fr", chemin: "/securite" });
    expect(langueDuChemin("/")).toEqual({ lang: "fr", chemin: "/" });
    for (const p of ["/en/", "/en/envoyer", "/en/en", "/en/securite.html", "/envoyer", "/s", "/compte", "/offres/retour", "/enx"]) expect(langueDuChemin(p), p).toBeNull();
    expect(langueDeLAdresse("/en/securite", "/", true)).toBe("en");
    expect(langueDeLAdresse("/securite", "/", true)).toBe("fr");
    expect(langueDeLAdresse("/envoyer", "/", true)).toBeNull();
    expect(langueDeLAdresse("/en/securite", "/", false)).toBeNull(); // démo, vitest
  });

  it("routeur : /en… donne la même route, /en/autre est introuvable, sans pages bilingues aussi", () => {
    const m = (p: string, b = true) => match(p, "", "/", false, false, false, b).name;
    expect(m("/en")).toBe("home");
    expect(m("/en/securite")).toBe("securite");
    expect(m("/en/mentions-legales")).toBe("mentions");
    expect(m("/en/offres")).toBe("offres");
    expect(m("/en/envoyer")).toBe("notfound");
    expect(m("/en/s")).toBe("notfound");
    expect(m("/en", false)).toBe("notfound");
  });

  it("liens internes : version anglaise des seules pages bilingues", () => {
    expect(href("/securite", "en", true)).toBe("/en/securite");
    expect(href("/", "en", true)).toBe("/en");
    expect(href("/envoyer", "en", true)).toBe("/envoyer");
    expect(href("/securite", "fr", true)).toBe("/securite");
    expect(href("/securite", "en", false)).toBe("/securite");
  });
});

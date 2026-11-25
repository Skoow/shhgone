// @vitest-environment happy-dom
// Limite de téléchargement du partage (403 egress_limit) : texte fixe choisi par le
// client, en français et en anglais, sur la page d'état et dans la ligne d'un téléchargement.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { setLang } from "../i18n/i18n.svelte";
import Invalid from "./Invalid.svelte";

let app: Record<string, unknown> | null = null;
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
  setLang("fr");
});

describe("limite de téléchargement du partage", () => {
  it("textes", () => {
    expect(fr["egress"]).toBe("Ce partage a atteint sa limite de téléchargement.");
    expect(en["egress"]).toBe("This share has reached its download limit.");
    expect(fr["dl.fail.egress"]).toBe(fr["egress"]);
    expect(en["dl.fail.egress"]).toBe(en["egress"]);
    expect(fr["egress.hint"]).toMatch(/expéditeur/u);
    expect(en["egress.hint"]).toMatch(/sender/u);
  });
  for (const lang of ["fr", "en"] as const)
    it(`page d'état « egress » (${lang}) : titre et explication, aucun bouton Réessayer`, () => {
      setLang(lang);
      const d = lang === "fr" ? fr : en;
      app = mount(Invalid as never, { target: document.body, props: { kind: "egress" } }) as Record<string, unknown>;
      flushSync();
      expect(document.querySelector("[data-invalid=egress] h1")!.textContent!.trim()).toBe(d["egress"]);
      expect(document.body.textContent).toContain(d["egress.hint"]);
      expect([...document.querySelectorAll("button")].some((b) => /Réessayer|Try again/u.test(b.textContent!))).toBe(false);
    });
});

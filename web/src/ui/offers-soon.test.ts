// @vitest-environment happy-dom
// Offres (décisions du 24 novembre) : les appels sont inclus dans Plus et Pro mais pas encore
// disponibles, et le départ du compte à rebours à la première ouverture n'est pas encore codé :
// les deux sont dits « bientôt (pas encore disponible) », en français et en anglais.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { setLang } from "../i18n/i18n.svelte";
import OffersStrip from "./OffersStrip.svelte";

let app: Record<string, unknown> | null = null;
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
  setLang("fr");
});

describe("offres : ce qui n'existe pas encore est dit « bientôt »", () => {
  it("textes FR et EN", () => {
    expect(fr["offers.calls.soon"]).toBe("bientôt (pas encore disponible)");
    expect(en["offers.calls.soon"]).toBe("soon (not available yet)");
    expect(fr["offers.adds.first"]).toMatch(/^Bientôt \(pas encore disponible\) : le compte à rebours pourra démarrer/u);
    expect(en["offers.adds.first"]).toMatch(/^Coming soon \(not available yet\): the countdown will be able to start/u);
  });

  for (const lang of ["fr", "en"] as const)
    it(`cartes de l'accueil (${lang}) : appels « Inclus » + « bientôt (pas encore disponible) » pour Plus et Pro, « Non inclus » en gratuit`, () => {
      setLang(lang);
      const d = lang === "fr" ? fr : en;
      app = mount(OffersStrip as never, { target: document.body, props: { cards: true } }) as Record<string, unknown>;
      flushSync();
      for (const x of ["plus", "pro"]) {
        const c = document.querySelector(`[data-calls="${x}"]`)!;
        expect(c.textContent!.replace(/\s+/g, " ").trim()).toBe(`${d["offers.calls.label"]} ${d["offers.calls.yes"]} ${d["offers.calls.soon"]}`);
      }
      expect(document.querySelector('[data-calls="free"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe(`${d["offers.calls.label"]} ${d["offers.calls.no"]}`);
    });
});

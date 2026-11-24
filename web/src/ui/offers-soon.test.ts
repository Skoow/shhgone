// @vitest-environment happy-dom
// Offres (décisions du 24 novembre) : les appels audio et vidéo sont inclus dans Plus et Pro et
// disponibles (réservés à ces offres, conception des appels §5.1) : « Inclus », sans « bientôt ».
// Le départ du compte à rebours à la première ouverture n'est pas encore codé : il reste dit
// « bientôt (pas encore disponible) », en français et en anglais.
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

describe("offres : les appels sont inclus, la première ouverture est « bientôt »", () => {
  it("textes FR et EN", () => {
    expect("offers.calls.soon" in fr).toBe(false);
    expect("offers.calls.soon" in en).toBe(false);
    expect(fr["offers.adds.first"]).toMatch(/^Bientôt \(pas encore disponible\) : le compte à rebours pourra démarrer/u);
    expect(en["offers.adds.first"]).toMatch(/^Coming soon \(not available yet\): the countdown will be able to start/u);
  });

  for (const lang of ["fr", "en"] as const)
    it(`cartes de l'accueil (${lang}) : appels « Inclus » pour Plus et Pro, sans « bientôt » ; « Non inclus » en gratuit`, () => {
      setLang(lang);
      const d = lang === "fr" ? fr : en;
      app = mount(OffersStrip as never, { target: document.body, props: { cards: true } }) as Record<string, unknown>;
      flushSync();
      for (const x of ["plus", "pro"]) {
        const c = document.querySelector(`[data-calls="${x}"]`)!;
        expect(c.textContent!.replace(/\s+/g, " ").trim()).toBe(`${d["offers.calls.label"]} ${d["offers.calls.yes"]}`);
        expect(c.textContent).not.toMatch(/bientôt|soon/iu);
      }
      expect(document.querySelector('[data-calls="free"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe(`${d["offers.calls.label"]} ${d["offers.calls.no"]}`);
    });
});

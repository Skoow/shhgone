// @vitest-environment happy-dom
// « Salon prêt » et l'historique (décision du 24 novembre, B) : l'historique est désactivé par
// défaut, avec ou sans compte ; le lien de gestion n'est alors gardé nulle part, il est montré
// d'emblée (avec l'avertissement) pour être gardé à la main. Gardé dans l'historique : derrière
// « Afficher le lien de gestion », comme avant.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { fr } from "../../i18n/fr";
import { vue } from "../../salon/salon.svelte";
import Pret from "./Pret.svelte";

const GESTION = "https://x.example/salon#s" + "g".repeat(43);
let app: Record<string, unknown> | null = null;
function montrer(garde: boolean) {
  setLang("fr");
  vue.finMs = Date.now() + 3600_000;
  vue.pret = { lien: "https://x.example/salon#c" + "c".repeat(43), mdp: "Abcdef-1234", gestion: GESTION, garde };
  app = mount(Pret as never, { target: document.body }) as Record<string, unknown>;
  flushSync();
}
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  vue.pret = null;
  document.body.innerHTML = "";
});

describe("Salon prêt : lien de gestion", () => {
  it("historique désactivé (par défaut) : lien de gestion montré d'emblée, avec l'explication et l'avertissement", () => {
    montrer(false);
    const m = document.querySelector("[data-manage]")!;
    expect(m.textContent).toContain(GESTION);
    expect(m.textContent).toContain(fr["salon.ready.manage.keep"]);
    expect(m.textContent).toContain(fr["salon.manage.warn"]);
    expect([...document.querySelectorAll("button")].some((b) => b.textContent?.includes(fr["salon.ready.manage.show"]))).toBe(false);
  });

  it("gardé dans l'historique : derrière « Afficher le lien de gestion »", () => {
    montrer(true);
    expect(document.querySelector("[data-manage]")).toBeNull();
    expect(document.body.textContent).not.toContain(GESTION);
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes(fr["salon.ready.manage.show"]))!;
    b.click();
    flushSync();
    expect(document.querySelector("[data-manage]")!.textContent).toContain(GESTION);
    expect(document.querySelector("[data-manage]")!.textContent).not.toContain(fr["salon.ready.manage.keep"]);
  });
});

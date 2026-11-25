// @vitest-environment happy-dom
// « Salon prêt » et l'historique : l'historique est désactivé par
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
function montrer() {
  setLang("fr");
  vue.finMs = Date.now() + 3600_000;
  vue.pret = { lien: "https://x.example/salon#c" + "c".repeat(43), mdp: "Abcdef-1234", gestion: GESTION };
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
  // Historique des liens retiré (25 novembre, spec §33) : le lien de gestion n'est gardé nulle
  // part, il est toujours montré d'emblée.
  it("lien de gestion montré d'emblée, avec l'explication et l'avertissement", () => {
    montrer();
    const m = document.querySelector("[data-manage]")!;
    expect(m.textContent).toContain(GESTION);
    expect(m.textContent).toContain(fr["salon.ready.manage.keep"]);
    expect(m.textContent).toContain(fr["salon.manage.warn"]);
  });
});

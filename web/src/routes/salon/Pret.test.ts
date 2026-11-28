// @vitest-environment happy-dom
// « Salon prêt » et « Mes partages » (spec §33, D42-30) : le salon est gardé d'office (lien de
// gestion et lien d'invitation, jamais le mot de passe) ; l'écran dit seulement « Retrouvez ce
// salon dans Mes partages ». L'appareil ne peut rien garder : le lien de gestion est montré
// d'emblée, avec l'avertissement, pour être gardé à la main.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { fr } from "../../i18n/fr";
import { vue } from "../../salon/salon.svelte";
import { memoryBackend } from "../../storage/idb";
import { configurerPartages, tousLesPartages } from "../../storage/partages.svelte";
import Pret from "./Pret.svelte";

const GESTION = "https://x.example/salon#s" + "g".repeat(43);
const LIEN = "https://x.example/salon#c" + "c".repeat(43);
const MDP = "Abcdef-1234";
let app: Record<string, unknown> | null = null;
async function montrer() {
  setLang("fr");
  vue.finMs = Date.now() + 3600_000;
  vue.pret = { lien: LIEN, mdp: MDP, gestion: GESTION };
  app = mount(Pret as never, { target: document.body }) as Record<string, unknown>;
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
}
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  vue.pret = null;
  document.body.innerHTML = "";
  configurerPartages(undefined);
});

describe("Salon prêt : Mes partages", () => {
  it("gardé : « Retrouvez ce salon dans Mes partages » (nouvel onglet), aucun lien de gestion affiché ; l'entrée n'a ni mot de passe", async () => {
    configurerPartages(memoryBackend());
    await montrer();
    expect(document.querySelector("[data-manage]")).toBeNull();
    expect(document.body.textContent).not.toContain(GESTION);
    const k = document.querySelector("[data-kept]")!;
    expect(k.textContent).toContain("Retrouvez ce salon dans Mes partages");
    const a = k.querySelector<HTMLAnchorElement>("a[data-shares-link]")!;
    expect(a.getAttribute("href")).toBe("/envois");
    expect(a.target).toBe("_blank");
    expect(k.textContent).toContain(fr["ready.kept.device"]);
    const [p] = await tousLesPartages();
    expect(p).toMatchObject({ sorte: "salon", gestion: GESTION, invitation: LIEN, origine: "local" });
    expect(JSON.stringify(p)).not.toContain(MDP);
  });

  it("stockage refusé : lien de gestion montré d'emblée, avec l'explication et l'avertissement", async () => {
    configurerPartages(null);
    await montrer();
    const m = document.querySelector("[data-manage]")!;
    expect(m.textContent).toContain(GESTION);
    expect(m.textContent).toContain(fr["salon.ready.manage.keep"]);
    expect(m.textContent).toContain(fr["salon.manage.warn"]);
  });
});

// @vitest-environment happy-dom
// Choix de la photo (AvatarPicker) : un seul libellé, celui de l'écran qui l'emploie (restes du
// salon, point 8 : la page d'explication affichait « Photo pour ce salon (facultative) » puis
// « Photo de profil · Facultative »).
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import AvatarPicker from "./AvatarPicker.svelte";

let app: Record<string, unknown> | null = null;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
});

describe("AvatarPicker", () => {
  it("libellé par défaut : « Photo de profil · Facultative », nom du groupe", () => {
    setLang("fr");
    app = mount(AvatarPicker, { target: document.body, props: {} });
    flushSync();
    const g = document.querySelector('[role="group"]')!;
    const l = document.getElementById(g.getAttribute("aria-labelledby")!)!;
    expect(l.textContent!.replace(/\s+/g, " ").trim()).toBe("Photo de profil · Facultative");
  });

  it("libellé donné (salon) : seul affiché, une seule fois", () => {
    setLang("fr");
    app = mount(AvatarPicker, { target: document.body, props: { libelle: "Photo pour ce salon" } });
    flushSync();
    const texte = document.body.textContent!;
    expect(texte).not.toContain("Photo de profil");
    expect(texte.split("Photo pour ce salon").length - 1).toBe(1);
    const g = document.querySelector('[role="group"]')!;
    expect(document.getElementById(g.getAttribute("aria-labelledby")!)!.textContent).toContain("Photo pour ce salon");
    expect(texte).toContain("Facultative");
  });
});

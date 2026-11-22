// @vitest-environment happy-dom
// Photo de profil (conception compte §21.15.3, salon v3 §7.2) : ré-encodage sur l'appareil en
// 256 × 256, carré pris au centre, 64 Ko au plus, sans métadonnées (le canevas ne recopie que les
// pixels) ; qualité baissée jusqu'à tenir ; image illisible : message, rien de gardé.
// Choix de la photo (AvatarPicker) : un seul libellé, celui de l'écran qui l'emploie (restes du
// salon, point 8 : la page d'explication affichait « Photo pour ce salon (facultative) » puis
// « Photo de profil · Facultative »).
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import { AVATAR_MAX, AVATAR_PX, carreCentre, reencoder } from "./avatar";
import AvatarPicker from "./AvatarPicker.svelte";

describe("avatar", () => {
  it("carré au centre : paysage, portrait, carré", () => {
    expect(carreCentre(400, 300)).toEqual({ sx: 50, sy: 0, s: 300 });
    expect(carreCentre(300, 500)).toEqual({ sx: 0, sy: 100, s: 300 });
    expect(carreCentre(256, 256)).toEqual({ sx: 0, sy: 0, s: 256 });
  });
  it("256 × 256, JPEG, qualité baissée jusqu'à 64 Ko au plus", async () => {
    const qualites: number[] = [];
    const draw = vi.fn();
    const out = await reencoder(new Blob(["x"]), {
      decoder: async () => ({ width: 1000, height: 800, close: () => undefined }),
      toile: (w, h) => {
        expect([w, h]).toEqual([AVATAR_PX, AVATAR_PX]);
        return { dessiner: draw, encoder: async (type, q) => (expect(type).toBe("image/jpeg"), qualites.push(q), new Uint8Array(q > 0.7 ? AVATAR_MAX + 1 : 30_000)) };
      },
    });
    expect(out.length).toBe(30_000);
    expect(qualites[0]).toBeGreaterThan(0.7);
    expect(qualites.at(-1)).toBeLessThanOrEqual(0.7);
    expect(draw).toHaveBeenCalledWith(expect.anything(), { sx: 100, sy: 0, s: 800 });
  });
  it("trop lourde même à la plus basse qualité, ou illisible : photo_illisible", async () => {
    const toile = () => ({ dessiner: () => undefined, encoder: async () => new Uint8Array(AVATAR_MAX + 1) });
    await expect(reencoder(new Blob(["x"]), { decoder: async () => ({ width: 10, height: 10, close: () => undefined }), toile })).rejects.toThrow("photo_illisible");
    await expect(reencoder(new Blob(["x"]), { decoder: async () => Promise.reject(new Error("x")), toile })).rejects.toThrow("photo_illisible");
  });
});

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

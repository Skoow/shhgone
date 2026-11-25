import { describe, expect, it } from "vitest";
import { ralentiRestant, typeAffichage, vuIlYa } from "./affichage";

describe("salon : limite de trames (0x0B)", () => {
  it("secondes restantes arrondies au-dessus, au moins 1 ; rien avant ni après", () => {
    expect(ralentiRestant(null, 1_000)).toBeNull();
    expect(ralentiRestant(5_000, 5_000)).toBeNull();
    expect(ralentiRestant(5_000, 6_000)).toBeNull();
    expect(ralentiRestant(5_000, 4_999)).toBe(1);
    expect(ralentiRestant(5_000, 0)).toBe(5);
    expect(ralentiRestant(5_000, 100)).toBe(5);
  });
});

describe("salon : type du Blob affiché", () => {
  it("jamais le type annoncé s'il n'est pas dans la table sûre", () => {
    for (const bad of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript"]) {
      expect(typeAffichage("image", bad)).toBeNull();
      // Vidéo et vocal : type par défaut de la visionneuse, jamais le type piégé.
      expect(typeAffichage("video", bad)).toBe("video/mp4");
      expect(typeAffichage("vocal", bad)).toBe("audio/mp4");
      expect(typeAffichage("fichier", bad)).toBeNull();
    }
  });
  it("types sûrs gardés, paramètres et casse ignorés", () => {
    expect(typeAffichage("image", "image/png")).toBe("image/png");
    expect(typeAffichage("image", "image/heic")).toBeNull(); // hors de la liste du salon
    expect(typeAffichage("video", "VIDEO/WEBM")).toBe("video/webm");
    expect(typeAffichage("vocal", "audio/webm;codecs=opus")).toBe("audio/webm");
    expect(typeAffichage("vocal", "audio/ogg")).toBe("audio/ogg");
  });
});

describe("salon : « vu il y a » (dernière connexion de 0x07, v3 §14.1)", () => {
  const M = 29_000_000; // minutes Unix
  const a = (min: number, s = 0) => (M + min) * 60_000 + s * 1000;
  it("inconnue (0) : rien", () => {
    expect(vuIlYa(0, a(5))).toBeNull();
  });
  it("moins d'une minute, ou horloge de l'appareil en retard : à l'instant", () => {
    expect(vuIlYa(M, a(0, 59))).toEqual({ k: "instant" });
    expect(vuIlYa(M, a(-3))).toEqual({ k: "instant" });
  });
  it("minutes, puis heures, puis le jour et l'heure (null)", () => {
    expect(vuIlYa(M, a(1))).toEqual({ k: "min", n: 1 });
    expect(vuIlYa(M, a(12, 30))).toEqual({ k: "min", n: 12 });
    expect(vuIlYa(M, a(59, 59))).toEqual({ k: "min", n: 59 });
    expect(vuIlYa(M, a(60))).toEqual({ k: "h", n: 1 });
    expect(vuIlYa(M, a(23 * 60 + 59))).toEqual({ k: "h", n: 23 });
    expect(vuIlYa(M, a(24 * 60))).toBeNull();
  });
});

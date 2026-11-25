import { describe, expect, it } from "vitest";
import { ralentiRestant, typeAffichage } from "./affichage";

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

describe("salon : type du Blob affiché (audit du 20 novembre)", () => {
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

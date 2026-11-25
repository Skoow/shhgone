// Audit du 25 novembre : plus de libellés en capitales espacées (Sommaire, Confiance, Légal,
// Compte) ; casse de phrase. Le sélecteur Photo / Vidéo de la caméra garde ses capitales
// (convention des appareils photo).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("libellés en casse de phrase", () => {
  for (const f of ["src/ui/AppShell.svelte", "src/ui/MobileMenu.svelte", "src/routes/InfoPage.svelte"])
    it(f, () => {
      const s = readFileSync(f, "utf8");
      expect(s).not.toMatch(/text-transform:\s*uppercase/);
      expect(s).not.toMatch(/letter-spacing:\s*0\.0[5-9]em/);
    });
});

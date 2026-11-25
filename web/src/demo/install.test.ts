// @vitest-environment happy-dom
// installDemo : fetch détourné pour /api seulement, titre inchangé, crochets des écrans.
import { describe, expect, it, vi } from "vitest";
import { getDemo } from "../app/demo-hooks";
import { setLang } from "../i18n/i18n.svelte";

describe("installDemo", async () => {
  const sent: string[] = [];
  const realFetch = vi.fn(async (input: RequestInfo | URL) => {
    sent.push(input instanceof Request ? input.url : String(input));
    return new Response("site");
  });
  window.fetch = realFetch as typeof fetch;
  document.title = "Shhgone";
  setLang("fr");
  expect(getDemo()).toBeNull();
  const { installDemo } = await import("./install");
  await installDemo(window);

  it("/api/* de l'origine → faux serveur ; le reste → réseau", async () => {
    const cap = await (await window.fetch("/api/captcha")).json();
    expect(cap).toMatchObject({ algorithm: "SHA-256" });
    expect(cap).not.toHaveProperty("fallback");
    expect((await window.fetch(`${location.origin}/API/x`)).status).toBe(404);
    expect(await (await window.fetch("/assets/a.js")).text()).toBe("site");
    expect(await (await window.fetch("https://ailleurs.test/api/captcha")).text()).toBe("site");
    expect(sent).toEqual([`${location.origin}/assets/a.js`, "https://ailleurs.test/api/captcha"]);
  });

  it("titre de l'onglet laissé tel quel, sans « Démo · »", async () => {
    document.title = "Ouvrir";
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe("Ouvrir");
  });

  it("crochets : preuve factice, phrase de « Lien invalide » et écarts dans la langue courante", async () => {
    const d = getDemo()!;
    expect(await d.solveCaptcha({})).toEqual({ kind: "pow", payload: "demo" });
    setLang("fr");
    expect(d.invalidLinkNote).toBe("(normal en démo : un partage n'existe que dans l'onglet qui l'a créé)");
    expect(d.signupPasskey).toBe("Simuler la passkey");
    expect(d.securityGaps).toContain("frame-ancestors");
    expect(d.securityGaps).toContain("GitHub reçoit votre adresse IP");
    expect(d.hostNote).toBe("Démo hébergée par GitHub, qui voit votre adresse IP.");
    setLang("en");
    expect(d.invalidLinkNote).toBe("(expected in the demo: a share only exists in the tab that created it)");
    expect(d.signupPasskey).toBe("Simulate the passkey");
    expect(d.securityGaps).toContain("HSTS");
    expect(d.securityGaps).toContain("GitHub receives your IP address");
    expect(d.hostNote).toBe("Demo hosted by GitHub, which sees your IP address.");
  });

  it("openAsRecipient : charge /s#<43> dans le même onglet ; refuse un autre lien", () => {
    const d = getDemo()!;
    const assign = vi.spyOn(location, "assign").mockImplementation(() => undefined);
    try {
      const key = "A".repeat(43);
      d.openAsRecipient(`${location.origin}/s#${key}`);
      expect(assign.mock.calls).toEqual([[`/s#${key}`]]);
      for (const bad of [`https://ailleurs.test/s#${key}`, `${location.origin}/s#m${key}`, `${location.origin}/s?x=1#${key}`, `${location.origin}/#${key}`, `${location.origin}/s/abc#${key}`, `${location.origin}/s#court`])
        expect(() => d.openAsRecipient(bad), bad).toThrow("lien_invalide");
      expect(assign).toHaveBeenCalledTimes(1);
    } finally {
      assign.mockRestore();
    }
  });

  it("aucun stockage navigateur", () => {
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

describe("Trusted Types décrits tels qu'ils sont", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/demo/install.ts", "utf8");
  const meta = readFileSync("scripts/demo-meta.mjs", "utf8");
  it("la démo exige Trusted Types (balise meta), comme la production : jamais « absent »", () => {
    expect(meta).toContain("require-trusted-types-for 'script'");
    expect(src).not.toMatch(/Trusted Types[\s\u202f]*:[\s\u202f]*absent/i);
    expect(src).not.toMatch(/Trusted Types:\s*missing/i);
  });
});

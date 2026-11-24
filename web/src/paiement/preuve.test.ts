// Preuve d'une commande sans le moteur (revue du 21 novembre) : défi lu par paiement/api,
// champs rendus au plus tôt 3,1 s après la réception, 429 → LimiteDefi.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../captcha/pow", () => ({ solvePow: vi.fn(async () => ({ kind: "pow", payload: "PREUVE" })) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("preuve d'une commande", () => {
  it("défi lu une fois, champs rendus après le délai minimal du serveur", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ algorithm: "SHA-256", challenge: "c", salt: "s", signature: "x", maxnumber: 10, shown_at: "JETON" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { obtenirPreuve, preparerPreuve } = await import("./preuve");
    const t0 = performance.now();
    preparerPreuve();
    preparerPreuve(); // une seule lecture
    const p = await obtenirPreuve();
    expect(p).toEqual({ altcha: "PREUVE", hp: "", shown_at: "JETON" });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(3000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/\/api\/captcha$/);
  }, 10_000);

  it("429 : LimiteDefi ; réseau coupé : erreur réseau", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    const m = await import("./preuve");
    await expect(m.obtenirPreuve()).rejects.toBeInstanceOf(m.LimiteDefi);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("coupé");
    }));
    await expect(m.obtenirPreuve()).rejects.toThrow("reseau");
  });
});

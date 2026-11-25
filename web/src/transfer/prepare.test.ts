// Défi anti-robot récupéré à l'avance (pré-calcul, UI §9.4.2, Q2).
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCaptcha, proofForm } from "./prepare";

afterEach(() => vi.useRealTimers());

const ORIGIN = "https://srv.test";
const salt = (expires: number) => `${"a".repeat(24)}.${"b".repeat(16)}.0?expires=${expires}&`;
const challenge = (extra: Record<string, unknown> = {}) => ({
  algorithm: "SHA-256",
  challenge: "c",
  maxNumber: 1,
  salt: salt(1_800_000_120),
  signature: "g",
  shown_at: "jeton",
  ...extra,
});
const net = (body: unknown, date?: string) => {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify(body), { status: 200, headers: date === undefined ? {} : { Date: date } });
  }) as typeof fetch;
  return { calls, net: { fetch: f, retryDelayMs: 1 } };
};

describe("prepareCaptcha", () => {
  it("GET /api/captcha ; défi sans shown_at ; sans en-tête Date : expiresAt = performance.now() + 120 s", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const s = net(challenge());
    const t = performance.now();
    const p = await prepareCaptcha(ORIGIN, s.net);
    expect(s.calls).toEqual(["GET https://srv.test/api/captcha"]);
    expect(p.challenge).toEqual({ algorithm: "SHA-256", challenge: "c", maxNumber: 1, salt: salt(1_800_000_120), signature: "g" });
    expect(p.expiresAt).toBe(t + 120_000); // « expires= » ignoré : aucune heure du serveur à comparer
    // shown_at et l'instant de réception restent internes.
    expect(Object.keys(p).sort()).toEqual(["challenge", "expiresAt"]);
    expect(Object.isFrozen(p)).toBe(true);
  });
  it("en-tête Date : validité = min(120 s, expires − Date), toujours sur l'horloge du client", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    const t = performance.now();
    const at = (expires: number, date: string) => prepareCaptcha(ORIGIN, net(challenge({ salt: salt(expires) }), date).net);
    const date = new Date(1_800_000_000_000).toUTCString(); // heure du serveur, sans rapport avec celle du client
    expect((await at(1_800_000_060, date)).expiresAt).toBe(t + 60_000);
    expect((await at(1_800_000_600, date)).expiresAt).toBe(t + 120_000); // plafond : durée de vie d'un défi
    expect((await at(1_799_999_990, date)).expiresAt).toBe(t - 10_000); // déjà périmé selon le serveur
    expect((await at(1_800_000_060, "pas une date")).expiresAt).toBe(t + 120_000);
    expect((await prepareCaptcha(ORIGIN, net(challenge({ salt: "s" }), date).net)).expiresAt).toBe(t + 120_000);
  });
  it("origine invalide : aucune requête ; réponse sans shown_at → erreur", async () => {
    const s = net(challenge());
    await expect(prepareCaptcha("https://srv.test/", s.net)).rejects.toThrow("origine_invalide");
    expect(s.calls).toEqual([]);
    await expect(prepareCaptcha(ORIGIN, net(challenge({ shown_at: undefined })).net)).rejects.toThrow("reponse_invalide");
  });
});

// Routes du compte (inscription/debut, oubli/debut, connexion après 5 échecs) : mêmes champs anti-robot que POST /api/shares, rendus au plus tôt 3,1 s après la
// réception du défi (le serveur refuse avant 3 s), et une seule fois par défi.
describe("proofForm", () => {
  it("champs { altcha, hp, shown_at } ; attend CAPTCHA_MIN_MS depuis la réception ; usage unique", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout"] });
    const s = net(challenge());
    const p = await prepareCaptcha(ORIGIN, s.net);
    let done: unknown = null;
    const f = proofForm(p, ORIGIN, { kind: "pow", payload: "preuve" }).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    await f;
    expect(done).toEqual({ altcha: "preuve", hp: "", shown_at: "jeton" });
    await expect(proofForm(p, ORIGIN, { kind: "pow", payload: "preuve" })).rejects.toThrow("preuve_invalide");
  });
  it("autre origine, preuve d'une autre sorte : refus", async () => {
    const p = await prepareCaptcha(ORIGIN, net(challenge()).net);
    await expect(proofForm(p, "https://autre.test", { kind: "pow", payload: "x" })).rejects.toThrow("preuve_invalide");
    const q = await prepareCaptcha(ORIGIN, net(challenge()).net);
    await expect(proofForm(q, ORIGIN, { kind: "recaptcha", token: "t" } as never)).rejects.toThrow("preuve_invalide");
  });
});

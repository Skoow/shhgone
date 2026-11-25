import { describe, expect, it } from "vitest";
import { detruire, exclure, gestion, meta, reglages, rejoindre, SalonError, signaler, type Net } from "./api";
import { creerSalon } from "../account/api";
import { CompteError } from "../account/api";

type Vu = { url: string; init: RequestInit };
function net(status: number, body: unknown, headers: Record<string, string> = {}): { n: Net; vus: Vu[] } {
  const vus: Vu[] = [];
  const n: Net = {
    origin: "https://shhgone.test",
    fetch: async (url, init) => {
      vus.push({ url: String(url), init: init ?? {} });
      return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers });
    },
  };
  return { n, vus };
}
const k32 = new Uint8Array(32).fill(1);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const h = (v: Vu) => v.init.headers as Record<string, string>;

describe("salon/api", () => {
  it("meta : X-Shh-Access seul, même origine, sans redirection", async () => {
    const { n, vus } = net(200, { expires_in_s: 3600, salt: b64(new Uint8Array(16).fill(2)), kdf_ops: 3, kdf_mem: 67108864 });
    const m = await meta(n, k32);
    expect(m).toMatchObject({ expiresInS: 3600, kdfOps: 3, kdfMem: 67108864 });
    expect(m.salt.length).toBe(16);
    expect(vus[0]!.url).toBe("https://shhgone.test/api/salons/meta");
    expect(h(vus[0]!)).toEqual({ "X-Shh-Access": b64(k32) });
    expect(vus[0]!.init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error" });
  });
  it("rejoindre : preuve dans le corps ; créateur : X-Shh-Manage = jeton de gestion", async () => {
    const rep = { member_token: "T".repeat(43), seat: 0, seq: 4, nonce_arrivee: b64(new Uint8Array(16).fill(3)), expires_in_s: 60, max_members: 4, members_can_destroy: false, budget_left: 10 };
    const { n, vus } = net(200, rep);
    const e = await rejoindre(n, k32, new Uint8Array(32).fill(5), new Uint8Array(32).fill(6));
    expect(e).toMatchObject({ jeton: "T".repeat(43), siege: 0, seq: 4, maxMembers: 4, membersCanDestroy: false });
    expect(h(vus[0]!)["X-Shh-Manage"]).toBe(b64(new Uint8Array(32).fill(6)));
    expect(JSON.parse(String(vus[0]!.init.body))).toEqual({ proof: b64(new Uint8Array(32).fill(5)) });
  });
  it("réponse mal formée : reponse_invalide ; erreur : SalonError avec essais et délai", async () => {
    await expect(rejoindre(net(200, { seat: 0 }).n, k32, k32)).rejects.toThrow("reponse_invalide");
    const e = await rejoindre(net(403, { error: "bad_password", attempts_left: 4 }).n, k32, k32).catch((x) => x);
    expect(e).toBeInstanceOf(SalonError);
    expect(e).toMatchObject({ status: 403, code: "bad_password", attemptsLeft: 4 });
    const l = await meta(net(429, { error: "limit", retry_after_s: 30 }, { "Retry-After": "30" }).n, k32).catch((x) => x);
    expect(l).toMatchObject({ code: "limit", retryS: 30 });
    const coupe: Net = { origin: "", fetch: async () => Promise.reject(new TypeError("x")) };
    await expect(meta(coupe, k32)).rejects.toThrow("reseau");
  });
  it("gestion, détruire, signaler, réglages, exclure", async () => {
    let r = net(200, { expires_in_s: 10, present: 2 });
    expect(await gestion(r.n, k32)).toEqual({ expiresInS: 10, present: 2 });
    r = net(200, {});
    await detruire(r.n, { jeton: "J".repeat(43) }, true);
    expect(h(r.vus[0]!)).toMatchObject({ "X-Shh-Membre": "J".repeat(43) });
    expect(JSON.parse(String(r.vus[0]!.init.body))).toEqual({ reason: "report" });
    await detruire(r.n, { jGestion: k32 });
    expect(h(r.vus[1]!)).toMatchObject({ "X-Shh-Manage": b64(k32) });
    await signaler(r.n, "J".repeat(43));
    expect(r.vus[2]!.url).toMatch(/\/signaler$/);
    r = net(200, { max_members: 5, expires_in_s: 3600, depuis: 0 });
    expect(await reglages(r.n, k32, { maxMembers: 5 })).toEqual({ maxMembers: 5, expiresInS: 3600, depuis: 0 });
    expect(JSON.parse(String(r.vus[0]!.init.body))).toEqual({ max_members: 5 });
    r = net(200, {});
    await exclure(r.n, k32, { siege: 2, nonce: new Uint8Array(16), r: 1, kAccesNouvelle: new Uint8Array(32).fill(9), vPreuve: k32, salt: new Uint8Array(16), kdfOps: 3, kdfMem: 67108864 });
    expect(h(r.vus[0]!)["X-Shh-Access-New"]).toBe(b64(new Uint8Array(32).fill(9)));
    expect(JSON.parse(String(r.vus[0]!.init.body))).toMatchObject({ seat: 2, r: 1, kdf_ops: 3 });
  });
});

describe("account/api creerSalon", () => {
  it("POST /api/salons avec X-Shh-Session et les en-têtes du salon", async () => {
    const { n, vus } = net(201, { expires_in_s: 86400 });
    expect(await creerSalon(n, "S".repeat(43), { acces: "A", gestion: "G" }, { ttl_hours: 24 })).toEqual({ expiresInS: 86400 });
    expect(vus[0]!.url).toBe("https://shhgone.test/api/salons");
    expect(h(vus[0]!)).toMatchObject({ "X-Shh-Session": "S".repeat(43), "X-Shh-Access": "A", "X-Shh-Manage": "G" });
  });
  it("refus palier : limites du palier", async () => {
    const e = await creerSalon(net(409, { error: "palier", salons: 1, places: 4, heures: 24 }).n, "S", { acces: "A", gestion: "G" }, {}).catch((x) => x);
    expect(e).toBeInstanceOf(CompteError);
    expect(e.palier).toEqual({ salons: 1, places: 4, heures: 24 });
  });
});

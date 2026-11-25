// @vitest-environment happy-dom
// « Mes partages » (/envois) sans compte : filtre « Reçus » ajouté aux
// filtres existants, mêmes lignes que l'accueil (InboxRow) ; aucune requête au chargement pour
// les reçus ; les envois gardent leurs cartes et leurs compteurs.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";

vi.mock("../app/demo-hooks", () => ({ getDemo: () => ({}) }));
const net = vi.hoisted(() => ({
  meta: vi.fn(async () => ({ expiresInS: 1800, opensLeft: 1 })),
  status: vi.fn(async () => ({ opensUsed: 0, maxOpens: 1, expiresInS: 1800, state: "ready" })),
}));
vi.mock("../index", async (orig) => ({ ...(await orig<typeof import("../index")>()), fetchMeta: net.meta, shareStatus: net.status }));

const live = await import("../history/live.svelte");
const { default: History } = await import("./History.svelte");

const NNBSP = "\u202f";
const T = new Date(2026, 10, 14, 16, 0).getTime();
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
let app: Record<string, unknown> | null = null;
const radio = (name: string) => [...document.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((i) => i.closest("label")!.textContent!.trim() === name)!;

beforeEach(async () => {
  setLang("fr");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
  await live.clearHistory();
  net.meta.mockClear();
});
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("Mes partages : filtre « Reçus »", () => {
  it("filtres Actifs, Terminés, Tous, Reçus ; « Reçus » montre les partages ouverts ici, sans requête ; compteurs des envois seuls", async () => {
    await live.recordShare({ manage: "https://x.test/#m" + "m".repeat(43), createdAt: T - 60_000, sizeBytes: 10, itemsCount: 1, expiresAt: T + 3600_000, maxOpens: 1 });
    await live.recordReceived({ link: "https://x.test/#" + "a".repeat(43), expiresAt: T + 3600_000, itemsCount: 2, sizeBytes: 2048, format: "image" });
    app = mount(History as never, { target: document.body }) as Record<string, unknown>;
    await settle();
    expect([...document.querySelectorAll("[role=radiogroup] label")].map((l) => l.textContent!.trim())).toEqual(["Actifs", "Terminés", "Tous", "Reçus"]);
    expect(document.querySelector("[data-counts]")!.textContent).toContain(`1${NNBSP}actif`);
    expect(document.querySelectorAll("[data-inbox-row]")).toHaveLength(0);
    radio("Reçus").click();
    await settle();
    const rows = document.querySelectorAll("[data-inbox-row]");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector("bdi")!.textContent).toBe(`Partage reçu · 2${NNBSP}éléments · 2${NNBSP}Ko`);
    expect(net.meta).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain("a".repeat(43));
  });

  it("aucun reçu : message propre au filtre", async () => {
    await live.recordShare({ manage: "https://x.test/#m" + "m".repeat(43), createdAt: T - 60_000, sizeBytes: 10, itemsCount: 1, expiresAt: T + 3600_000, maxOpens: 1 });
    app = mount(History as never, { target: document.body }) as Record<string, unknown>;
    await settle();
    radio("Reçus").click();
    await settle();
    expect(document.body.textContent).toContain("Aucun partage reçu gardé sur cet appareil.");
  });
});

describe("Mes partages : historique des envois désactivé par défaut", () => {
  it("sans compte ni choix : « L'historique est désactivé » ; « L'activer » le garde pour les envois suivants", async () => {
    await live.setHistoryEnabled(false);
    app = mount(History as never, { target: document.body }) as Record<string, unknown>;
    await settle();
    expect(document.querySelector("[data-history-empty] h2")!.textContent).toBe("L'historique est désactivé");
    expect(document.body.textContent).toContain("Par défaut, vos envois ne sont pas gardés sur cet appareil");
    const on = [...document.querySelectorAll("button")].find((b) => b.textContent!.trim() === "L'activer pour les prochains envois")!;
    on.click();
    await settle();
    expect(live.shares.enabled).toBe(true);
    expect(document.querySelector("[data-history-empty] h2")!.textContent).toBe("Aucun partage pour l'instant");
    await live.setHistoryEnabled(false);
  });
  it("avec un compte aussi : « désactivé » tant que la personne ne l'active pas", async () => {
    await live.setHistoryEnabled(false);
    live.setAccountPrefs({ keepReceived: true });
    app = mount(History as never, { target: document.body }) as Record<string, unknown>;
    await settle();
    expect(document.querySelector("[data-history-empty] h2")!.textContent).toBe("L'historique est désactivé");
    const on = [...document.querySelectorAll("button")].find((b) => b.textContent!.trim() === "L'activer pour les prochains envois")!;
    on.click();
    await settle();
    expect(document.querySelector("[data-history-empty] h2")!.textContent).toBe("Aucun partage pour l'instant");
    await live.setHistoryEnabled(false);
    live.setAccountPrefs(null);
  });
});

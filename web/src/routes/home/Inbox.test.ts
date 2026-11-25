// @vitest-environment happy-dom
// Accueil connecté (conception compte §21.7, §21.15.1) : une seule liste lue sur
// l'appareil, sans requête au chargement ; filtres Tout / Salons / Reçus / Envoyés ; tri par
// activité ; « Expiré » ; « Rouvrir ici compte une ouverture » ; retrait au clavier ; relecture
// d'une entrée au plus une fois toutes les 5 min ; état vide, bandeaux de récupération et de coffre.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";

vi.mock("../../app/demo-hooks", () => ({ getDemo: () => ({}) }));
const net = vi.hoisted(() => ({
  meta: vi.fn(async () => ({ expiresInS: 1800, opensLeft: 1 })),
  status: vi.fn(async () => ({ opensUsed: 0, maxOpens: 1, expiresInS: 1800, state: "ready" })),
}));
vi.mock("../../index", async (orig) => ({ ...(await orig<typeof import("../../index")>()), fetchMeta: net.meta, shareStatus: net.status }));
const said = vi.hoisted(() => [] as string[]);
vi.mock("../../ui/announce", async (orig) => ({ ...(await orig<typeof import("../../ui/announce")>()), announce: (s: string) => void said.push(s) }));

const live = await import("../../history/live.svelte");
const { default: Inbox } = await import("./Inbox.svelte");

const NNBSP = "\u202f";
const H = 3600_000;
const T = new Date(2026, 10, 14, 16, 0).getTime();
const KEY = (c: string) => c.repeat(43);
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};
let app: Record<string, unknown> | null = null;
const show = async (props: Record<string, unknown> = {}) => {
  app = mount(Inbox as never, { target: document.body, props: { profile: { pseudo: "Léa", photo: null }, ...props } }) as Record<string, unknown>;
  await settle();
};
const text = () => document.body.textContent!.replace(/[ \n\t]+/g, " ");
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-inbox-row]")];
const titles = () => rows().map((r) => r.querySelector("bdi")!.textContent);
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent!.trim()) === name)!;
const radio = (name: string) => [...document.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((i) => i.closest("label")!.textContent!.trim() === name)!;

async function seed() {
  vi.setSystemTime(T - 3 * H);
  await live.recordShare({ manage: "https://x.test/#m" + KEY("m"), createdAt: Date.now(), sizeBytes: 10, itemsCount: 3, expiresAt: T + 6 * H, maxOpens: 1 });
  vi.setSystemTime(T - 2 * H);
  await live.recordReceived({ link: "https://x.test/#" + KEY("a"), expiresAt: T + 4 * H, itemsCount: 6, sizeBytes: 148_897_792, format: "image" });
  vi.setSystemTime(T - 1 * H);
  await live.recordReceived({ link: "https://x.test/#" + KEY("b"), expiresAt: T - 1000, itemsCount: 1, sizeBytes: 2048, format: "pdf" });
  await live.importEntries([
    {
      id: "R".repeat(22),
      sorte: "salon_rejoint",
      origine: "compte",
      manage: "",
      link: "https://x.test/#c" + KEY("r"),
      label: "Équipe",
      format: "",
      createdAt: T - 30 * 60_000,
      sizeBytes: 0,
      itemsCount: 0,
      expiresAt: T + 2 * H,
      maxOpens: 0,
      opensUsed: 0,
      opens: [],
      state: "ready",
      lastSeenAt: T - 30 * 60_000,
      endedAt: 0,
      destroyedHere: false,
    },
  ]);
  vi.setSystemTime(T);
}

beforeEach(async () => {
  setLang("fr");
  said.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
  await live.clearHistory();
  net.meta.mockClear();
  net.status.mockClear();
});
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("accueil connecté", () => {
  it("aucune requête au chargement ; en-tête : avatar (Profil), « Accueil », recherche", async () => {
    await seed();
    const f = vi.spyOn(globalThis, "fetch");
    await show();
    expect(f).not.toHaveBeenCalled();
    expect(net.meta).not.toHaveBeenCalled();
    expect(net.status).not.toHaveBeenCalled();
    expect(document.querySelector("h1")!.textContent).toBe("Accueil");
    expect(button("Profil").textContent!.trim()).toBe("L");
    expect(button("Rechercher")).toBeTruthy();
    expect(rows()).toHaveLength(4);
    f.mockRestore();
  });

  it("tri par activité (la plus récente d'abord), les entrées finies à la fin, atténuées", async () => {
    await seed();
    await show();
    expect(titles()).toEqual([
      "Équipe · rejoint le 14 nov.",
      `Partage reçu · 6${NNBSP}éléments · 142${NNBSP}Mo`,
      `Votre partage · 3${NNBSP}éléments`,
      `Partage reçu · 1${NNBSP}élément · 2${NNBSP}Ko`,
    ]);
    expect(rows()[3]!.getAttribute("data-ended")).toBe("true");
    expect(rows()[3]!.textContent).toContain("Expiré");
  });

  it("filtres Tout / Salons / Reçus / Envoyés (groupe radio) ; changement annoncé", async () => {
    await seed();
    await show();
    const group = document.querySelector("[role=radiogroup]")!;
    expect([...group.querySelectorAll("label")].map((l) => l.textContent!.trim())).toEqual(["Tout", "Salons", "Reçus", "Envoyés"]);
    radio("Reçus").click();
    await settle();
    expect(rows().map((r) => r.dataset.sorte)).toEqual(["recu", "recu"]);
    expect(said).toContain(`2${NNBSP}partages reçus`);
    radio("Salons").click();
    await settle();
    expect(rows().map((r) => r.dataset.sorte)).toEqual(["salon_rejoint"]);
    expect(said).toContain(`1${NNBSP}salon`);
    radio("Envoyés").click();
    await settle();
    expect(rows().map((r) => r.dataset.sorte)).toEqual(["envoi"]);
  });

  it("reçu venu d'un autre appareil : « Rouvrir ici compte une ouverture » sur la ligne et dans le détail", async () => {
    await live.importEntries([
      { id: "Z".repeat(22), sorte: "recu", origine: "compte", manage: "", link: "https://x.test/#" + KEY("z"), label: "", format: "file", createdAt: T - H, sizeBytes: 10, itemsCount: 1, expiresAt: T + H, maxOpens: 0, opensUsed: 0, opens: [], state: "ready", lastSeenAt: T - H, endedAt: 0, destroyedHere: false },
    ]);
    await show();
    expect(rows()[0]!.textContent).toContain("Rouvrir ici compte une ouverture");
    rows()[0]!.querySelector("button")!.click();
    await settle();
    const d = document.querySelector("[data-inbox-detail]")!;
    expect(d.textContent).toContain("Rouvrir ici compte une ouverture");
    expect(button("Rouvrir")).toBeTruthy();
  });

  it("retirer de la liste au clavier : la ligne part, c'est annoncé", async () => {
    await seed();
    await show();
    const ended = rows()[3]!;
    ended.querySelector<HTMLButtonElement>("[data-remove]")!.click();
    await settle();
    expect(rows()).toHaveLength(3);
    expect(said).toContain("Retiré de la liste.");
  });

  it("« Actualiser » d'un reçu : au plus une relecture toutes les 5 min", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(T - 10 * 60_000);
    await live.recordReceived({ link: "https://x.test/#" + KEY("a"), expiresAt: T + 4 * H, itemsCount: 6, sizeBytes: 10, format: "image" });
    vi.setSystemTime(T);
    app = mount(Inbox as never, { target: document.body, props: { profile: { pseudo: "Léa", photo: null } } }) as Record<string, unknown>;
    // Attentes explicites (et non un temps fixe) : l'historique est déchiffré par WebCrypto, en
    // temps réel ; sous charge, un délai fixe de faux minuteurs finissait avant lui. vi.waitFor
    // avance les faux minuteurs à chaque essai (pause aléatoire de 0,5 à 4 s avant la relecture).
    await vi.waitFor(() => {
      flushSync();
      expect(rows()).toHaveLength(1);
    });
    const id = live.shares.all[0]!.id;
    rows()[0]!.querySelector("button")!.click();
    flushSync();
    // Première relecture : faite, et finie (lastSeenAt écrit) avant le second appui.
    button("Actualiser").click();
    await vi.waitFor(() => expect(net.meta).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(live.shares.info[id]).toEqual({}), { timeout: 10_000 });
    // Second appui moins de 5 min après : refusé (« trop tôt », nextAt dans 5 min), sans requête.
    flushSync();
    button("Actualiser").click();
    await vi.waitFor(() => expect(live.shares.info[id]?.nextAt).toBe(live.shares.all[0]!.lastSeenAt + 5 * 60_000), { timeout: 10_000 });
    expect(live.shares.all[0]!.lastSeenAt).toBeGreaterThanOrEqual(T);
    expect(net.meta).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await settle();
  });

  it("état vide exact, avec « Envoyer quelque chose » et « Créer un salon »", async () => {
    await show();
    const e = document.querySelector("[data-inbox-empty]")!;
    expect(e.textContent).toContain("Rien pour l'instant");
    expect(e.textContent!.replace(/\s+/g, " ")).toContain("Les liens que vous ouvrez, les salons que vous rejoignez et vos envois apparaissent ici. Les messages s'affichent dans le salon, pas ici.");
    expect(button("Envoyer quelque chose")).toBeTruthy();
    expect(button("Créer un salon")).toBeTruthy();
  });

  it("après une récupération par e-mail : bandeau d'information exact ; coffre illisible : bandeau d'erreur", async () => {
    await show({ recovered: true, vaultError: true });
    expect(text()).toContain("Votre clé de récupération a servi. Si elle a pu être vue, créez-en une nouvelle dans les paramètres.");
    expect(text()).toContain("Vos données chiffrées ne s'ouvrent pas sur cet appareil. Reconnectez-vous.");
  });

  it("recherche locale sur les libellés et titres (aucune requête) ; Échap ferme", async () => {
    await seed();
    await show();
    button("Rechercher").click();
    flushSync();
    const input = document.querySelector<HTMLInputElement>("input[type=search]")!;
    expect(document.activeElement).toBe(input);
    input.value = "équipe";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(titles()).toEqual(["Équipe · rejoint le 14 nov."]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(document.querySelector("input[type=search]")).toBeNull();
    expect(rows()).toHaveLength(4);
    expect(net.meta).not.toHaveBeenCalled();
  });

  it("« Nouveau » ouvre la feuille : Envoyer des fichiers, Écrire une note, Créer un salon", async () => {
    await show();
    button("Nouveau").click();
    flushSync();
    const d = document.querySelector("dialog")!;
    expect([...d.querySelectorAll("[data-new-item]")].map((b) => b.textContent!.replace(/\s+/g, " ").trim().split(" · ")[0])).toEqual(["Envoyer des fichiers", "Écrire une note", "Créer un salon"]);
  });
});

// @vitest-environment happy-dom
// Suivi de l'expéditeur (UI §9.6.4, §9.6.5) : relecture toutes les 60 s page visible, heure de
// la dernière lecture ; une relecture en vol ne fait pas réapparaître un partage
// supprimé.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";

const status = vi.fn();
const destroy = vi.fn();
vi.mock("../index", async (orig) => ({
  ...(await orig<typeof import("../index")>()),
  shareStatus: (...a: unknown[]) => status(...a),
  destroyShare: (...a: unknown[]) => destroy(...a),
}));
const sync = vi.fn();
const summary = vi.fn();
vi.mock("../history/live.svelte", () => ({ syncManaged: (...a: unknown[]) => sync(...a), managedSummary: (...a: unknown[]) => summary(...a) }));
const { default: Manage } = await import("./Manage.svelte");

const LINK = "https://x.test/#m" + "B".repeat(43);
const S = { opensUsed: 0, maxOpens: 1, expiresInS: 3600, state: "ready" };
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  flushSync();
};
let app: Record<string, unknown> | null = null;
beforeEach(() => {
  setLang("fr");
  // happy-dom : pas d'animation (la dissolution est sautée, comme sans Web Animations).
  (Element.prototype as unknown as { animate?: unknown }).animate = undefined;
});
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  status.mockReset();
  destroy.mockReset();
  sync.mockReset();
  summary.mockReset();
});
const show = () => {
  app = mount(Manage as never, { target: document.body, props: { take: () => ({ kind: "m", link: LINK }) } }) as Record<string, unknown>;
  flushSync();
};
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

describe("Manage", () => {
  beforeEach(() => summary.mockResolvedValue(null));

  // Audit du 25 novembre : le contexte du partage en tête, la pastille d'état, et « Supprimer
  // maintenant » en bouton secondaire (contour corail), confirmation gardée.
  it("contexte lu dans l'historique de l'appareil (nom, éléments, taille) ; rien sans entrée", async () => {
    status.mockResolvedValue(S);
    summary.mockResolvedValue({ label: "Photos du week-end", itemsCount: 3, sizeBytes: 3_984_588 });
    show();
    await settle();
    expect(summary).toHaveBeenCalledWith(LINK);
    expect(document.querySelector("[data-manage-context]")!.textContent!.replace(/[ \n\t]+/g, " ").trim()).toBe("Photos du week-end · 3\u202féléments · 3,8\u202fMo");
    void unmount(app!);
    app = null;
    document.body.innerHTML = "";
    summary.mockResolvedValue(null);
    show();
    await settle();
    expect(document.querySelector("[data-manage-context]")).toBeNull();
  });

  it("pastille d'état ; « Supprimer maintenant » en contour corail, puis confirmation", async () => {
    status.mockResolvedValue(S);
    show();
    await settle();
    expect(document.querySelector("[data-state-chip]")!.textContent!.trim()).toBe("Actif");
    const del = button("Supprimer maintenant");
    expect(del.classList.contains("danger-line")).toBe(true);
    expect(del.classList.contains("danger")).toBe(false);
    del.click();
    await settle();
    expect(destroy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Supprimer ce partage pour tout le monde");
  });

  it("M13 : heure de la dernière lecture affichée ; relue toutes les 60 s page visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 9, 41, 0));
    status.mockResolvedValue(S);
    show();
    await settle();
    expect(status).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-read-at]")!.textContent).toContain("9\u202fh\u202f41");
    vi.setSystemTime(new Date(2026, 10, 11, 9, 42, 0));
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(status).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-read-at]")!.textContent).toContain("9\u202fh\u202f43");
  });

  it("relecture en vol pendant « Supprimer maintenant » : l'écran reste « Supprimé »", async () => {
    status.mockResolvedValueOnce(S);
    show();
    await settle();
    let late!: (s: typeof S) => void;
    status.mockReturnValueOnce(new Promise((r) => (late = r)));
    destroy.mockResolvedValue(undefined);
    button("Actualiser").click();
    await settle();
    button("Supprimer maintenant").click();
    await settle();
    [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Supprimer").at(-1)!.click();
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(document.querySelector("h1")!.textContent).toBe("Supprimé");
    late(S);
    await settle();
    expect(document.querySelector("h1")!.textContent).toBe("Supprimé");
  });

  it("historique local : relecture, destruction et partage absent reportés sur l'entrée du même lien", async () => {
    status.mockResolvedValueOnce(S);
    show();
    await settle();
    expect(sync).toHaveBeenLastCalledWith(LINK, { kind: "status", status: S });
    destroy.mockResolvedValue(undefined);
    button("Supprimer maintenant").click();
    await settle();
    [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Supprimer").at(-1)!.click();
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    expect(sync).toHaveBeenLastCalledWith(LINK, { kind: "destroyed" });
  });

  it("historique local : partage introuvable à la relecture → « absent » ; échec réseau → rien", async () => {
    status.mockRejectedValueOnce(new Error("reseau"));
    show();
    await settle();
    expect(sync).not.toHaveBeenCalled();
    const { NotFoundError } = await import("../index");
    status.mockRejectedValueOnce(new NotFoundError());
    button("Actualiser").click();
    await settle();
    expect(sync).toHaveBeenLastCalledWith(LINK, { kind: "missing" });
  });

  it("destruction refusée (réseau) : l'historique n'est pas touché", async () => {
    status.mockResolvedValueOnce(S);
    show();
    await settle();
    sync.mockReset();
    destroy.mockRejectedValue(new Error("reseau"));
    button("Supprimer maintenant").click();
    await settle();
    [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Supprimer").at(-1)!.click();
    await settle();
    expect(sync).not.toHaveBeenCalled();
  });
});

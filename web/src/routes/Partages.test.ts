// @vitest-environment happy-dom
// Page « Mes partages » (/envois ; spec §33, D42-30) : vide (et sans rien créer sur l'appareil),
// pleine (état, ouvertures, échéance, taille, nom), « Supprimer » par le lien de gestion,
// « Retirer de la liste », salon (« Gérer le salon », « Copier l'invitation ») ; la phrase sur
// la perte de la gestion sans compte ; stockage refusé dit à l'écran.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB } from "../storage/fake-idb.test-helper";

const MANAGE = "https://x.example/s#m" + "m".repeat(43);
const SALON_G = "https://x.example/salon#s" + "s".repeat(43);
const SALON_I = "https://x.example/salon#c" + "c".repeat(43);
let svelte: typeof import("svelte");
let app: Record<string, unknown> | null = null;
const net = vi.hoisted(() => ({ destroyShare: vi.fn(), shareStatus: vi.fn() }));
const copies: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", fakeIndexedDB());
  net.destroyShare.mockReset().mockResolvedValue(undefined);
  net.shareStatus.mockReset();
  copies.length = 0;
  vi.doMock("../index", async (orig) => ({ ...(await orig<typeof import("../index")>()), ...net }));
  vi.doMock("../ui/clipboard", () => ({ copyText: async (s: string) => (copies.push(s), "copied") }));
  svelte = await import("svelte");
  (await import("../i18n/i18n.svelte")).setLang("fr");
});
afterEach(() => {
  if (app) void svelte.unmount(app);
  app = null;
  document.body.innerHTML = "";
  vi.doUnmock("../index");
  vi.doUnmock("../ui/clipboard");
  vi.unstubAllGlobals();
});
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  svelte.flushSync();
};
async function page() {
  const P = (await import("./Partages.svelte")).default;
  app = svelte.mount(P as never, { target: document.body }) as Record<string, unknown>;
  await settle();
}
const texte = () => document.body.textContent!.replace(/\s+/g, " ");
const bouton = (re: RegExp, root: ParentNode = document) => [...root.querySelectorAll("button")].find((b) => re.test(b.textContent!.replace(/\s+/g, " ").trim()))!;
const click = async (b: HTMLElement) => {
  b.click();
  await settle();
};

describe("Mes partages", () => {
  it("vide : explication, lien d'envoi, phrase sur la perte sans compte ; aucune base créée", async () => {
    const idb = globalThis.indexedDB as unknown as ReturnType<typeof fakeIndexedDB>;
    await page();
    expect(document.querySelector("[data-shares-empty]")).not.toBeNull();
    expect(texte()).toContain("Aucun partage pour l'instant");
    expect(document.querySelector("[data-shares-device]")!.textContent).toContain("Sans compte, cette liste n'existe que dans ce navigateur");
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("plein : envoi (nom, ouvertures, éléments, taille, échéance) et salon ; Supprimer, Retirer, Gérer, Copier l'invitation", async () => {
    const { garderPartage, tousLesPartages } = await import("../storage/partages.svelte");
    const now = Date.now();
    await garderPartage({ sorte: "envoi", gestion: MANAGE, creeLe: now, echeance: now + 3 * 3600_000, ouverturesMax: 3, taille: 2048, elements: 2, nom: "Devis" });
    await garderPartage({ sorte: "salon", gestion: SALON_G, invitation: SALON_I, creeLe: now, echeance: now + 24 * 3600_000 });
    await page();
    const cards = [...document.querySelectorAll("[data-share-card]")];
    expect(cards.map((c) => c.getAttribute("data-sorte"))).toEqual(["envoi", "salon"]);
    const [e, s] = cards as HTMLElement[];
    expect(e!.textContent).toContain("Devis");
    expect(e!.textContent).toContain("Ouvert 0 / 3");
    expect(e!.textContent).toContain("2 éléments");
    expect(e!.textContent).toContain("S'efface dans");
    expect(e!.textContent).toContain("Actif");
    expect(texte()).toContain("2 actifs · 0 terminé");
    // Jamais affiché : le lien de gestion d'un envoi.
    expect(document.body.textContent).not.toContain("m".repeat(43));
    // Salon : sa page de gestion, et l'invitation copiée.
    expect(s!.querySelector<HTMLAnchorElement>("a[data-room-manage]")!.getAttribute("href")).toBe(SALON_G);
    await click(bouton(/^Copier l'invitation$/, s));
    expect(copies).toEqual([SALON_I]);
    expect(s!.textContent).toContain("Le mot de passe du salon n'est pas gardé");
    // Supprimer (confirmation sur place) : par le lien de gestion seul.
    await click(bouton(/^Supprimer$/, e));
    await click(bouton(/^Supprimer$/, e));
    expect(net.destroyShare).toHaveBeenCalledWith(MANAGE, location.origin);
    await vi.waitFor(() => expect(document.querySelector("[data-share-card][data-sorte=envoi]")!.getAttribute("data-state")).toBe("detruit"));
    expect(document.querySelector("[data-share-card][data-sorte=envoi]")!.textContent).toContain("Détruit");
    // Fini : « Retirer de la liste » sans confirmation.
    await click(bouton(/^Retirer de la liste$/, document.querySelector("[data-share-card][data-sorte=envoi]")!));
    expect((await tousLesPartages()).map((p) => p.sorte)).toEqual(["salon"]);
  });

  it("Supprimer sans réseau : l'erreur est dite, l'état reste", async () => {
    net.destroyShare.mockRejectedValue(new Error("reseau"));
    const { garderPartage } = await import("../storage/partages.svelte");
    await garderPartage({ sorte: "envoi", gestion: MANAGE, creeLe: Date.now(), echeance: Date.now() + 3600_000, ouverturesMax: 1, taille: 1, elements: 1 });
    await page();
    const e = document.querySelector<HTMLElement>("[data-share-card]")!;
    expect(e.textContent).toContain("Partage sans nom");
    await click(bouton(/^Supprimer$/, e));
    await click(bouton(/^Supprimer$/, e));
    expect(document.querySelector("[data-stale]")!.textContent).toContain("connexion impossible");
    expect(e.getAttribute("data-state")).toBe("actif");
  });

  it("stockage refusé : dit à l'écran", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await page();
    expect(document.querySelector("[data-shares-unavailable]")).not.toBeNull();
  });
});

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
    // Partie « Partages de fichiers » et son état vide ; pas de partie « Salons » sur un site sans
    // salons (__SALONS__ faux ici) tant qu'aucun salon n'est dans la liste.
    expect([...document.querySelectorAll("[data-shares-part]")].map((x) => x.getAttribute("data-shares-part"))).toEqual(["envoi"]);
    expect(document.querySelector("[data-shares-empty=envoi]")).not.toBeNull();
    expect(texte()).toContain("Aucun partage de fichiers");
    expect(document.querySelector<HTMLAnchorElement>("[data-shares-empty=envoi] a")!.getAttribute("href")).toBe("/envoyer");
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
    // Deux parties, dans cet ordre, rien de mélangé : titre, compteur ; chaque carte dans la sienne.
    const parties = [...document.querySelectorAll<HTMLElement>("[data-shares-part]")];
    expect(parties.map((x) => x.querySelector("h2")!.textContent!.replace(/\s+/g, " ").trim())).toEqual(["Partages de fichiers 1", "Salons 1"]);
    expect(parties[0]!.querySelectorAll("[data-share-card]")).toHaveLength(1);
    expect(parties[0]!.querySelector("[data-share-card]")!.getAttribute("data-sorte")).toBe("envoi");
    expect(parties[1]!.querySelector("[data-share-card]")!.getAttribute("data-sorte")).toBe("salon");
    expect(parties[0]!.querySelector("[data-counts]")!.textContent).toContain("1\u202factif · 0\u202fterminé");
    // Icône du type (bulles : salon ; fichier : partage), et le type dit en texte.
    expect(cards.map((c) => c.querySelector("[data-share-icon]")!.getAttribute("data-share-icon"))).toEqual(["fichier", "salon"]);
    for (const c of cards) expect(c.querySelector("[data-share-icon]")!.getAttribute("aria-hidden")).toBe("true");
    expect(cards[0]!.querySelector("h3")!.textContent).toBe("Partage de fichiers\u202f: Devis");
    expect(cards[1]!.querySelector("h3")!.textContent).toBe("Salon");
    const [e, s] = cards as HTMLElement[];
    expect(e!.textContent).toContain("Devis");
    expect(e!.textContent).toContain("Ouvert 0 / 3");
    expect(e!.textContent).toContain("2 éléments");
    expect(e!.textContent).toContain("S'efface dans");
    expect(e!.textContent).toContain("Actif");

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

  it("salons seuls : la partie « Partages de fichiers » dit son état vide, la partie « Salons » liste le salon", async () => {
    const { garderPartage } = await import("../storage/partages.svelte");
    const now = Date.now();
    await garderPartage({ sorte: "salon", gestion: SALON_G, invitation: SALON_I, creeLe: now, echeance: now + 3600_000 });
    await page();
    expect([...document.querySelectorAll("[data-shares-part]")].map((x) => x.getAttribute("data-shares-part"))).toEqual(["envoi", "salon"]);
    expect(document.querySelector("[data-shares-part=envoi] [data-shares-empty=envoi]")).not.toBeNull();
    expect(document.querySelector("[data-shares-part=salon] [data-share-card][data-sorte=salon]")).not.toBeNull();
    expect(document.querySelector("[data-shares-part=salon] [data-shares-empty]")).toBeNull();
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

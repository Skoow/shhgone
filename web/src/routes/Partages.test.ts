// @vitest-environment happy-dom
// « Mes partages » (/envois) et « Mes salons » (/salons) (spec §33, D42-30 ; deux pages depuis le
// 28 novembre) : vide (sans rien créer sur l'appareil), sous-titre « ce que vous avez créé »,
// lignes (étiquette En cours / Terminé, « Se termine le 29 nov. (12 h 14) »), « Supprimer le
// partage » par le lien de gestion, « Retirer de la liste », « Retirer » un terminé, « Effacer
// l'historique » (Oui / Non, garde les actifs), salon (« Gérer le salon », « Copier
// l'invitation ») ; la phrase sur la perte sans compte ; stockage refusé dit à l'écran.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB } from "../storage/fake-idb.test-helper";

const MANAGE = "https://x.example/s#m" + "m".repeat(43);
const MANAGE2 = "https://x.example/s#m" + "n".repeat(43);
const MANAGE3 = "https://x.example/s#m" + "o".repeat(43);
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
async function page(sorte: "envoi" | "salon" = "envoi") {
  const P = (await import("./Partages.svelte")).default;
  app = svelte.mount(P as never, { target: document.body, props: { sorte } }) as Record<string, unknown>;
  await settle();
}
const texte = () => document.body.textContent!.replace(/\s+/g, " ");
const bouton = (re: RegExp, root: ParentNode = document) => [...root.querySelectorAll("button")].find((b) => re.test(b.textContent!.replace(/\s+/g, " ").trim()))!;
const click = async (b: HTMLElement) => {
  b.click();
  await settle();
};
const cartes = () => [...document.querySelectorAll<HTMLElement>("[data-share-card]")];
/** « 29 nov. (12 h 14) » à l'heure locale, comme la page. */
const jourHeure = (ms: number) => {
  const d = new Date(Math.round(ms / 60_000) * 60_000);
  return `${d.getDate()} ${new Intl.DateTimeFormat("fr", { month: "short" }).format(d)} (${d.getHours()} h ${String(d.getMinutes()).padStart(2, "0")})`;
};

describe("Mes partages", () => {
  it("vide : sous-titre (ce que vous avez envoyé), explication, lien d'envoi, phrase sur la perte sans compte ; aucune base créée", async () => {
    const idb = globalThis.indexedDB as unknown as ReturnType<typeof fakeIndexedDB>;
    await page();
    expect(document.querySelector("h1")!.textContent).toBe("Mes partages");
    expect(texte()).toContain("Les partages que vous avez envoyés. Jamais ceux que vous avez reçus.");
    expect(document.querySelector("[data-shares-empty=envoi]")).not.toBeNull();
    expect(texte()).toContain("Aucun partage de fichiers");
    expect(document.querySelector<HTMLAnchorElement>("[data-shares-empty=envoi] a")!.getAttribute("href")).toBe("/envoyer");
    expect(document.querySelector("[data-shares-device]")!.textContent).toContain("Sans compte, cette liste n'existe que dans ce navigateur");
    expect(document.querySelector("[data-history-clear]")).toBeNull();
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("une page par sorte : les salons ne sont jamais dans Mes partages, ni les envois dans Mes salons", async () => {
    const { garderPartage } = await import("../storage/partages.svelte");
    const now = Date.now();
    await garderPartage({ sorte: "envoi", gestion: MANAGE, creeLe: now, echeance: now + 3600_000, ouverturesMax: 1, taille: 1, elements: 1, nom: "Devis" });
    await garderPartage({ sorte: "salon", gestion: SALON_G, invitation: SALON_I, creeLe: now, echeance: now + 3600_000 });
    await page("envoi");
    expect(cartes().map((c) => c.getAttribute("data-sorte"))).toEqual(["envoi"]);
    svelte.unmount(app!);
    app = null;
    await page("salon");
    expect(document.querySelector("h1")!.textContent).toBe("Mes salons");
    expect(texte()).toContain("Les salons que vous avez créés. Jamais ceux où l'on vous a invité.");
    expect(cartes().map((c) => c.getAttribute("data-sorte"))).toEqual(["salon"]);
  });

  it("envoi en cours : étiquette « En cours », « Se termine le … (… h …) », ouvertures, taille ; « Supprimer le partage » le dit pour tout le monde", async () => {
    const { garderPartage } = await import("../storage/partages.svelte");
    const now = Date.now();
    const echeance = now + 3 * 3600_000;
    await garderPartage({ sorte: "envoi", gestion: MANAGE, creeLe: now, echeance, ouverturesMax: 3, taille: 2048, elements: 2, nom: "Devis" });
    await page();
    const [e] = cartes();
    expect(e!.querySelector("[data-share-icon]")!.getAttribute("data-share-icon")).toBe("fichier");
    expect(e!.querySelector("h3")!.textContent).toBe("Devis");
    const tag = e!.querySelector("[data-share-tag]")!;
    expect(tag.getAttribute("data-share-tag")).toBe("en-cours");
    expect(tag.textContent).toBe("En cours");
    expect(e!.querySelector("[data-share-end]")!.textContent).toBe(`Se termine le ${jourHeure(echeance)}`);
    expect(e!.textContent).toContain("Ouvert 0 / 3");
    expect(e!.textContent).toContain("2\u202féléments");
    // Plus de « s'efface dans » ni de « créé le ».
    expect(texte()).not.toMatch(/S'efface dans|Créé le/);
    // Jamais affiché : le lien de gestion d'un envoi.
    expect(document.body.textContent).not.toContain("m".repeat(43));
    // Supprimer le partage (confirmation sur place) : pour tout le monde, par le lien de gestion seul.
    await click(bouton(/^Supprimer le partage$/, e));
    expect(texte()).toContain("Supprimer ce partage pour tout le monde ? Plus personne ne pourra l'ouvrir.".replace(/\s+/g, " "));
    await click(bouton(/^Supprimer$/, e));
    expect(net.destroyShare).toHaveBeenCalledWith(MANAGE, location.origin);
    await vi.waitFor(() => expect(cartes()[0]!.getAttribute("data-state")).toBe("detruit"));
    const fini = cartes()[0]!;
    expect(fini.querySelector("[data-share-tag]")!.textContent).toBe("Terminé");
    expect(fini.querySelector("[data-share-end]")!.textContent).toMatch(/^Terminé le \d+ \S+ \(\d+ h \d\d\)$/);
    expect(fini.textContent).toContain("Supprimé depuis ce site.");
  });

  it("« Retirer de la liste » d'un partage en cours : il continue (confirmation qui le dit), seulement retiré d'ici", async () => {
    const { garderPartage, tousLesPartages } = await import("../storage/partages.svelte");
    const now = Date.now();
    await garderPartage({ sorte: "envoi", gestion: MANAGE, creeLe: now, echeance: now + 3600_000, ouverturesMax: 1, taille: 1, elements: 1 });
    await page();
    const e = cartes()[0]!;
    expect(e.textContent).toContain("Partage sans nom");
    await click(bouton(/^Retirer de la liste$/, e));
    expect(texte()).toContain("Il continue jusqu'à son échéance pour ceux qui ont le lien");
    await click(bouton(/^Retirer$/, e));
    expect(net.destroyShare).not.toHaveBeenCalled();
    expect(await tousLesPartages()).toEqual([]);
  });

  it("terminés : « Retirer » un par un ; « Effacer l'historique » (Oui / Non) retire tous les terminés et garde les actifs", async () => {
    const { garderPartage, noterDetruit, tousLesPartages } = await import("../storage/partages.svelte");
    const now = Date.now();
    const a = await garderPartage({ sorte: "envoi", gestion: MANAGE, creeLe: now, echeance: now + 3600_000, ouverturesMax: 1, taille: 1, elements: 1, nom: "Actif" });
    const b = await garderPartage({ sorte: "envoi", gestion: MANAGE2, creeLe: now, echeance: now + 3600_000, ouverturesMax: 1, taille: 1, elements: 1, nom: "Fini 1" });
    const c = await garderPartage({ sorte: "envoi", gestion: MANAGE3, creeLe: now, echeance: now + 3600_000, ouverturesMax: 1, taille: 1, elements: 1, nom: "Fini 2" });
    await garderPartage({ sorte: "salon", gestion: SALON_G, invitation: SALON_I, creeLe: now, echeance: now - 1000 });
    await noterDetruit(b!);
    await noterDetruit(c!);
    await page();
    expect(document.querySelector("[data-counts]")!.textContent).toContain("1 actif · 2 terminés");
    // Un terminé : « Retirer » (nom accessible « Retirer de la liste »), sans confirmation.
    const fini = cartes().find((x) => x.textContent!.includes("Fini 2"))!;
    const retirer = fini.querySelector<HTMLButtonElement>("[data-share-remove]")!;
    expect(retirer.textContent!.trim()).toBe("Retirer");
    expect(retirer.getAttribute("aria-label")).toBe("Retirer de la liste");
    await click(retirer);
    expect((await tousLesPartages()).map((p) => p.id).sort()).toEqual([a, b, (await tousLesPartages()).find((p) => p.sorte === "salon")!.id].sort());
    // Effacer l'historique : « Non » ne fait rien ; « Oui » retire les terminés de cette page.
    const zone = document.querySelector<HTMLElement>("[data-history-clear]")!;
    await click(bouton(/^Effacer l'historique$/, zone));
    expect(texte()).toContain("Retirer de la liste le seul élément terminé ? Ceux en cours restent.".replace(/\s+/g, " "));
    await click(bouton(/^Non$/, zone));
    expect(await tousLesPartages()).toHaveLength(3);
    await click(bouton(/^Effacer l'historique$/, document.querySelector<HTMLElement>("[data-history-clear]")!));
    await click(bouton(/^Oui$/, document.querySelector<HTMLElement>("[data-history-clear]")!));
    // L'actif reste ; le salon terminé (autre page) aussi.
    expect((await tousLesPartages()).map((p) => p.sorte + ":" + (p.nom || "salon")).sort()).toEqual(["envoi:Actif", "salon:salon"]);
    expect(cartes().map((x) => x.querySelector("h3")!.textContent)).toEqual(["Actif"]);
    expect(document.querySelector("[data-history-clear]")).toBeNull();
    expect(net.destroyShare).not.toHaveBeenCalled();
  });

  it("Mes salons : « Gérer le salon » (page du créateur), « Copier l'invitation », étiquette et date de fin", async () => {
    const { garderPartage } = await import("../storage/partages.svelte");
    const now = Date.now();
    const echeance = now + 24 * 3600_000;
    await garderPartage({ sorte: "salon", gestion: SALON_G, invitation: SALON_I, creeLe: now, echeance });
    await page("salon");
    const s = cartes()[0]!;
    expect(s.querySelector("[data-share-icon]")!.getAttribute("data-share-icon")).toBe("salon");
    expect(s.querySelector("h3")!.textContent).toBe("Salon");
    expect(s.querySelector("[data-share-tag]")!.textContent).toBe("En cours");
    expect(s.querySelector("[data-share-end]")!.textContent).toBe(`Se termine le ${jourHeure(echeance)}`);
    expect(s.querySelector<HTMLAnchorElement>("a[data-room-manage]")!.getAttribute("href")).toBe(SALON_G);
    expect(s.querySelector("a[data-room-manage]")!.textContent).toBe("Gérer le salon");
    await click(bouton(/^Copier l'invitation$/, s));
    expect(copies).toEqual([SALON_I]);
    expect(s.textContent).toContain("Le mot de passe du salon n'est pas gardé");
    expect(document.querySelector<HTMLAnchorElement>("[data-shares-page=salon] .ph a, [data-shares-page=salon] header a")).toBeNull();
  });

  it("Supprimer sans réseau : l'erreur est dite, l'état reste", async () => {
    net.destroyShare.mockRejectedValue(new Error("reseau"));
    const { garderPartage } = await import("../storage/partages.svelte");
    await garderPartage({ sorte: "envoi", gestion: MANAGE, creeLe: Date.now(), echeance: Date.now() + 3600_000, ouverturesMax: 1, taille: 1, elements: 1 });
    await page();
    const e = cartes()[0]!;
    await click(bouton(/^Supprimer le partage$/, e));
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

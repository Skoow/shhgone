// @vitest-environment happy-dom
// « Lien prêt » : les garde-fous (avertissement à la fermeture, confirmation de « Nouveau
// partage », confirmation du Retour et des menus) ne servent qu'à ne pas perdre le lien et le
// mot de passe avant de les avoir copiés. Ils tombent dès que les deux l'ont été (copie de chacun,
// « Copier le lien et le mot de passe » ou « Envoyer vers une app » réussis) ; une copie refusée
// ou un partage annulé ne comptent pas. Rien n'est stocké.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB } from "../storage/fake-idb.test-helper";
import { NOTHING_COPIED, confirmLeave, noteCopy, secured, warnOnUnload } from "./ready-copies";

describe("ready-copies : logique", () => {
  it("rien de copié : avertissement et confirmation", () => {
    expect(secured(NOTHING_COPIED)).toBe(false);
    expect(warnOnUnload(NOTHING_COPIED, false)).toBe(true);
    expect(confirmLeave(NOTHING_COPIED)).toBe(true);
  });
  it("le lien seul, ou le mot de passe seul : toujours avertissement et confirmation", () => {
    for (const c of [noteCopy(NOTHING_COPIED, "link"), noteCopy(NOTHING_COPIED, "password")]) {
      expect(secured(c)).toBe(false);
      expect(warnOnUnload(c, false)).toBe(true);
      expect(confirmLeave(c)).toBe(true);
    }
    expect(noteCopy(NOTHING_COPIED, "link")).toEqual({ link: true, password: false, manage: false });
    expect(noteCopy(NOTHING_COPIED, "password")).toEqual({ link: false, password: true, manage: false });
  });
  it("les deux (l'un puis l'autre, ou ensemble), gestion gardée : plus rien ; une copie ne s'oublie pas", () => {
    const kept = noteCopy(NOTHING_COPIED, "manage");
    const one = noteCopy(noteCopy(kept, "password"), "link");
    const both = noteCopy(kept, "both");
    for (const c of [one, both, noteCopy(both, "link"), noteCopy(both, "password")]) {
      expect(c).toEqual({ link: true, password: true, manage: true });
      expect(warnOnUnload(c, false)).toBe(false);
      expect(confirmLeave(c)).toBe(false);
    }
  });
  // D42-30 : la gestion gardée dans « Mes partages » compte ; sans elle (stockage refusé), le
  // lien de gestion est à copier comme le lien et le mot de passe.
  it("lien et mot de passe copiés, gestion ni gardée ni copiée : toujours avertissement et confirmation", () => {
    const c = noteCopy(NOTHING_COPIED, "both");
    expect(c).toEqual({ link: true, password: true, manage: false });
    expect(secured(c)).toBe(false);
    expect(warnOnUnload(c, false)).toBe(true);
    expect(confirmLeave(c)).toBe(true);
    expect(secured(noteCopy(c, "manage"))).toBe(true);
  });
  it("fini (Nouveau partage, Supprimer) : plus d'avertissement, même sans copie", () => {
    expect(warnOnUnload(NOTHING_COPIED, true)).toBe(false);
  });
});

// ---------- Composant ----------
let svelte: typeof import("svelte");
let Ready: unknown;
let clip: "copied" | "manual";
let shared: "shared" | "cancelled";
const copies: string[] = [];
const mounted: Record<string, unknown>[] = [];
const LINK = "https://x.example/s#" + "k".repeat(43);
const PW = "Abcdef-1234";
const props = (over: Record<string, unknown> = {}) => ({
  result: { link: LINK, manage: "https://x.example/s#m" + "m".repeat(43), expiresInS: 3600, password: PW },
  summary: "1 élément",
  ttlHours: 1,
  maxOpens: 1,
  itemsCount: 1,
  sizeBytes: 10,
  ondone: () => undefined,
  onforget: () => undefined,
  onnew: () => undefined,
  ...over,
});
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  svelte.flushSync();
};
const show = async (p = props()) => {
  mounted.push(svelte.mount(Ready as never, { target: document.body, props: p }) as Record<string, unknown>);
  await settle();
};
const armed = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};
const button = (re: RegExp, root: ParentNode = document) => [...root.querySelectorAll("button")].find((b) => re.test((b.textContent ?? "").replace(/\s+/g, " ").trim()))!;
const copyIn = (cls: "lien" | "mdp") => button(/^Copi/, document.querySelector(`.ticket .${cls}`)!);
const marks = () => [...document.querySelectorAll(".ticket [data-ready-copied]")].map((m) => m.closest(".cell")!.classList.contains("lien") ? "lien" : "mdp");
const click = async (b: HTMLButtonElement) => {
  b.click();
  await settle();
};
/** « Nouveau partage » : confirmation demandée (InlineConfirm) ou départ direct. */
const newShare = () => button(/^Nouveau partage/, document.querySelector(".ready .done")!);

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", fakeIndexedDB());
  clip = "copied";
  shared = "shared";
  copies.length = 0;
  vi.doMock("../ui/clipboard", () => ({
    copyText: async (s: string) => {
      if (clip === "copied") copies.push(s);
      return clip;
    },
  }));
  vi.doMock("../ui/native", async (orig) => ({ ...(await orig<typeof import("../ui/native")>()), canShareLink: () => true, shareText: async () => shared }));
  svelte = await import("svelte");
  (await import("../i18n/i18n.svelte")).setLang("fr");
  Ready = (await import("./Ready.svelte")).default;
});
afterEach(() => {
  while (mounted.length) void svelte.unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.doUnmock("../ui/clipboard");
  vi.doUnmock("../ui/native");
  vi.unstubAllGlobals();
});

describe("Lien prêt : copié ou non", () => {
  it("à l'arrivée : plus de phrase au-dessus des boutons, « Copier » avant « Partager », mot de passe visible, temps restant ; avertissement armé, aucune coche ; « Nouveau partage » discret", async () => {
    await show();
    expect(document.querySelector("[data-ready-works]")).toBeNull();
    const send = [...document.querySelectorAll(".send .btn")].map((b) => b.textContent!.trim());
    expect(send[0]).toMatch(/^Copier le lien et le mot de passe/);
    expect(send[1]).toMatch(/^Partager/);
    expect(document.querySelector("[data-masked]")).toBeNull(); // mot de passe visible dès l'arrivée
    expect(document.querySelector("[data-ready-left]")!.textContent).toMatch(/^\(dans \d+\u202f(h|min)\)$/);
    expect(armed()).toBe(true);
    expect(marks()).toEqual([]);
    expect(newShare().className).toMatch(/\bghost\b/);
    expect(document.querySelector(".ready .done .btn.primary")).toBeNull();
  });

  it("le lien seul : sa coche ; toujours l'avertissement et la confirmation (texte clair, « Continuer »)", async () => {
    const ondone = vi.fn();
    await show(props({ ondone }));
    await click(copyIn("lien"));
    expect(copies).toEqual([LINK]);
    expect(marks()).toEqual(["lien"]);
    expect(armed()).toBe(true);
    await click(newShare());
    expect(ondone).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Vous n'avez pas encore copié le lien et le mot de passe. Ils ne pourront plus être affichés. Continuer ?");
    await click(button(/^Continuer$/));
    expect(ondone).toHaveBeenCalledTimes(1);
    expect(armed()).toBe(false);
  });

  it("le lien puis le mot de passe : deux coches, plus d'avertissement, « Nouveau partage » sans confirmation ; onsecured une fois", async () => {
    const ondone = vi.fn();
    const onsecured = vi.fn();
    await show(props({ ondone, onsecured }));
    await click(copyIn("lien"));
    await click(copyIn("mdp"));
    expect(copies).toEqual([LINK, PW]);
    expect(marks()).toEqual(["lien", "mdp"]);
    expect(armed()).toBe(false);
    expect(onsecured).toHaveBeenCalledTimes(1);
    await click(copyIn("lien"));
    expect(onsecured).toHaveBeenCalledTimes(1);
    await click(newShare());
    expect(ondone).toHaveBeenCalledTimes(1);
  });

  it("« Copier le lien et le mot de passe » : les deux d'un coup", async () => {
    const onsecured = vi.fn();
    await show(props({ onsecured }));
    await click(button(/^Copier le lien et le mot de passe$/, document.querySelector(".ready .send")!));
    expect(copies).toEqual([`Lien : ${LINK}\nMot de passe : ${PW}`]);
    expect(marks()).toEqual(["lien", "mdp"]);
    expect(armed()).toBe(false);
    expect(onsecured).toHaveBeenCalledTimes(1);
  });

  it("« Envoyer vers une app » : annulé ne compte pas ; réussi vaut pour les deux", async () => {
    await show();
    await click(button(/^Partager$/, document.querySelector(".ready .send")!));
    shared = "cancelled";
    await click(button(/^Envoyer vers une app$/));
    expect(marks()).toEqual([]);
    expect(armed()).toBe(true);
    shared = "shared";
    await click(button(/^Envoyer vers une app$/));
    expect(marks()).toEqual(["lien", "mdp"]);
    expect(armed()).toBe(false);
  });

  it("presse-papier refusé (copie à la main) : rien ne compte, on ne peut pas la constater", async () => {
    clip = "manual";
    await show();
    await click(copyIn("lien"));
    await click(copyIn("mdp"));
    await click(button(/^Copier le lien et le mot de passe$/, document.querySelector(".ready .send")!));
    expect(marks()).toEqual([]);
    expect(armed()).toBe(true);
  });

  it("secrets oubliés (result à null, sortie confirmée par la garde) : plus d'avertissement, même sans copie", async () => {
    const p = liveProps();
    await show(p as never);
    expect(armed()).toBe(true);
    p.result = null;
    await settle();
    expect(armed()).toBe(false);
  });
});

// D42-30 : le partage est gardé d'office dans « Mes partages » ; plus de lien de gestion affiché.
describe("Lien prêt : Mes partages", () => {
  const MANAGE = "https://x.example/s#m" + "m".repeat(43);
  it("gardé : « Retrouvez ce partage dans Mes partages », lien vers /envois, aucun lien de gestion ; l'entrée n'a ni lien ni mot de passe", async () => {
    await show(props({ result: { link: LINK, manage: MANAGE, expiresInS: 3600, password: PW, title: "Devis" }, maxOpens: 2, itemsCount: 3, sizeBytes: 4096 }));
    expect(document.querySelector("[data-manage]")).toBeNull();
    expect(document.body.textContent).not.toContain(MANAGE);
    const k = document.querySelector("[data-kept]")!;
    expect(k.textContent!.replace(/\s+/g, " ")).toContain("Retrouvez ce partage dans Mes partages.");
    expect(k.querySelector("a[data-shares-link]")!.getAttribute("href")).toBe("/envois");
    expect(k.querySelector("[data-kept-device]")!.textContent).toContain("effacer les données du site fait perdre sa gestion");
    const { tousLesPartages } = await import("../storage/partages.svelte");
    const [p] = await tousLesPartages();
    expect(p).toMatchObject({ sorte: "envoi", gestion: MANAGE, nom: "Devis", elements: 3, taille: 4096, ouverturesMax: 2 });
    expect(JSON.stringify(p)).not.toContain(PW);
    expect(JSON.stringify(p)).not.toContain("k".repeat(43));
  });

  it("stockage refusé : lien de gestion montré, et la garde de sortie l'attend aussi", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const ondone = vi.fn();
    const onsecured = vi.fn();
    await show(props({ ondone, onsecured }));
    const m = document.querySelector("[data-manage]")!;
    expect(m.textContent).toContain("Ce navigateur ne peut rien garder");
    await click(button(/^Copier le lien et le mot de passe$/, document.querySelector(".ready .send")!));
    expect(armed()).toBe(true);
    expect(onsecured).not.toHaveBeenCalled();
    await click(newShare());
    expect(document.body.textContent).toContain("Vous n'avez pas encore copié le lien, le mot de passe et le lien de gestion.");
    await click(button(/^Annuler$/));
    await click(button(/^Copi/, m as HTMLElement));
    expect(armed()).toBe(false);
    expect(onsecured).toHaveBeenCalledTimes(1);
  });

  it("Supprimer : l'entrée de Mes partages est notée détruite", async () => {
    vi.doMock("../index", async (orig) => ({ ...(await orig<typeof import("../index")>()), destroyShare: async () => undefined }));
    try {
      vi.resetModules();
      svelte = await import("svelte");
      (await import("../i18n/i18n.svelte")).setLang("fr");
      Ready = (await import("./Ready.svelte")).default;
      await show();
      await click(button(/^Supprimer ce partage/));
      await click(button(/^Supprimer$/));
      const { tousLesPartages } = await import("../storage/partages.svelte");
      await vi.waitFor(async () => expect((await tousLesPartages())[0]).toMatchObject({ etat: "detruit", detruitIci: true }));
    } finally {
      vi.doUnmock("../index");
    }
  });
});

/** Props réactives (un objet $state n'est pas disponible ici : un accesseur suffit, lu à l'événement). */
function liveProps() {
  const base = props();
  let result: unknown = base.result;
  return Object.defineProperty({ ...base }, "result", {
    get: () => result,
    set: (v) => (result = v),
    enumerable: true,
  }) as Omit<ReturnType<typeof props>, "result"> & { result: unknown };
}

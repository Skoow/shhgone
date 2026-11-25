// @vitest-environment happy-dom
// Barre du haut, ordinateur et tablette : menus déroulants en motif
// « disclosure » (bouton aria-expanded, liste de liens ou boutons), clavier (Entrée, Échap,
// flèches, Tab), fermeture au clic extérieur ; « Envoyer ▾ » ouvre les gestes du composeur.
import { presence } from "../history/presence.svelte";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chrome } from "../app/chrome.svelte";
import { setLang } from "../i18n/i18n.svelte";
import TopNav from "./TopNav.svelte";

let c: Record<string, unknown> | null = null;
function show(props: Record<string, unknown> = {}) {
  c = mount(TopNav as never, { target: document.body, props }) as Record<string, unknown>;
  flushSync();
}
const btn = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.textContent!.trim() === name)!;
const panel = (b: HTMLButtonElement) => document.getElementById(b.getAttribute("aria-controls")!)!;
const key = (el: Element, k: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  flushSync();
};

beforeEach(() => setLang("fr"));
afterEach(() => {
  if (c) void unmount(c);
  c = null;
  document.body.innerHTML = "";
  chrome.add = null;
});

describe("TopNav", () => {
  it("menus, Salon bientôt, Offres, Mes partages (s'il y a des partages) ; plus de bouton « Partager »", () => {
    presence.any = true;
    show();
    const nav = document.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Menu principal");
    for (const n of ["Envoyer", "Sécurité"]) {
      const b = btn(n);
      expect(b.getAttribute("aria-expanded")).toBe("false");
      expect(panel(b).hidden).toBe(true);
    }
    const room = [...nav.querySelectorAll("button")].find((b) => b.textContent!.includes("Salon"))!;
    expect(room.getAttribute("aria-disabled")).toBe("true");
    expect(room.textContent).toContain("bientôt");
    const links = [...document.querySelectorAll("a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")]);
    expect(links).toEqual(expect.arrayContaining([["Offres", "/offres"], ["Mes partages", "/envois"]]));
    const named = (n: string) => [...nav.querySelectorAll("a, button")].filter((e) => e.textContent!.trim() === n);
    expect(named("Partager")).toHaveLength(0);
  });

  it("sans partage sur l'appareil : pas de « Mes partages »", () => {
    presence.any = false;
    show();
    expect([...document.querySelectorAll("a")].map((a) => a.textContent!.trim())).not.toContain("Mes partages");
  });

  it("Envoyer : quatre gestes, chacun avec icône, titre et une ligne", () => {
    show();
    btn("Envoyer").click();
    flushSync();
    expect(btn("Envoyer").getAttribute("aria-expanded")).toBe("true");
    const items = [...panel(btn("Envoyer")).querySelectorAll("[data-nav-item]")];
    expect(items.map((i) => i.querySelector(".it-t")!.textContent)).toEqual(["Fichiers", "Note", "Vocal", "Photo ou vidéo"]);
    for (const i of items) {
      expect(i.querySelector(".it-ic svg")).not.toBeNull();
      expect(i.querySelector(".it-d")!.textContent!.length).toBeGreaterThan(5);
    }
    expect(items[0]!.querySelector(".it-d")!.textContent).toContain("2 Go");
  });

  it("Sécurité : comment ça marche, ce que voit le serveur et les pages existantes", () => {
    show();
    btn("Sécurité").click();
    flushSync();
    const p = panel(btn("Sécurité"));
    const titles = [...p.querySelectorAll(".it-t")].map((e) => e.textContent);
    expect(titles).toEqual(["Comment ça marche", "Ce que voit le serveur", "Sécurité en détail", "Confidentialité", "Signaler un abus"]);
    const hrefs = [...p.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/securite", "/confidentialite", "/signaler"]));
    expect(hrefs.some((h) => h?.includes("#"))).toBe(false);
  });

  it("clavier : flèche bas ouvre et va au premier élément, flèches et Échap ; le focus revient au bouton", () => {
    show();
    const b = btn("Envoyer");
    b.focus();
    key(b, "ArrowDown");
    expect(b.getAttribute("aria-expanded")).toBe("true");
    const items = [...panel(b).querySelectorAll<HTMLElement>("[data-nav-item]")];
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key(items[1]!, "ArrowUp");
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, "ArrowUp");
    expect(document.activeElement).toBe(items[3]);
    key(items[3]!, "Escape");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(b);
  });

  it("un seul menu ouvert ; clic extérieur et sortie au Tab ferment", () => {
    show();
    btn("Envoyer").click();
    flushSync();
    btn("Sécurité").click();
    flushSync();
    expect(btn("Envoyer").getAttribute("aria-expanded")).toBe("false");
    expect(btn("Sécurité").getAttribute("aria-expanded")).toBe("true");
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    flushSync();
    expect(btn("Sécurité").getAttribute("aria-expanded")).toBe("false");
    btn("Sécurité").click();
    flushSync();
    const p = panel(btn("Sécurité"));
    p.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    flushSync();
    expect(btn("Sécurité").getAttribute("aria-expanded")).toBe("false");
  });

  it("un geste du menu Envoyer passe au composeur monté (chrome.add) et ferme le menu", () => {
    const add = vi.fn();
    chrome.add = add;
    show();
    btn("Envoyer").click();
    flushSync();
    const items = [...panel(btn("Envoyer")).querySelectorAll<HTMLButtonElement>("[data-nav-item]")];
    items[0]!.click();
    items[1]!.click();
    flushSync();
    expect(add.mock.calls).toEqual([["fichiers"], ["texte"]]);
    expect(btn("Envoyer").getAttribute("aria-expanded")).toBe("false");
  });

  it("pendant un envoi : menus et liens désactivés, raison donnée", () => {
    show({ busy: true });
    for (const a of document.querySelectorAll("a")) expect(a.getAttribute("aria-disabled")).toBe("true");
    for (const b of document.querySelectorAll("button[aria-expanded]")) expect(b.getAttribute("aria-disabled")).toBe("true");
    btn("Envoyer").click();
    flushSync();
    expect(btn("Envoyer").getAttribute("aria-expanded")).toBe("false");
  });

  it("anglais", () => {
    setLang("en");
    show();
    expect(btn("Send")).toBeDefined();
    expect(btn("Share")).toBeUndefined();
    expect(btn("Security")).toBeDefined();
  });
});

// Souris sur PC : le survol ouvre (délai d'intention), referme (délai de grâce), bascule d'un
// menu à l'autre ; clic et clavier restent ; le tactile et les appareils sans survol n'ouvrent
// qu'au clic.
describe("TopNav au survol", () => {
  let fine = true;
  const dd = (name: string) => btn(name).parentElement!;
  const ptr = (el: Element, type: "pointerenter" | "pointerleave", pointerType = "mouse") => {
    el.dispatchEvent(new PointerEvent(type, { pointerType }));
    flushSync();
  };
  const wait = (ms: number) => {
    vi.advanceTimersByTime(ms);
    flushSync();
  };
  const expanded = (name: string) => btn(name).getAttribute("aria-expanded");
  beforeEach(() => {
    fine = true;
    vi.useFakeTimers();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: fine && q === "(hover: hover) and (pointer: fine)", media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ouvre après le délai d'intention, pas en traversant la barre ; sans voler le focus", () => {
    show();
    const before = document.activeElement;
    ptr(dd("Envoyer"), "pointerenter");
    wait(60);
    expect(expanded("Envoyer")).toBe("false");
    ptr(dd("Envoyer"), "pointerleave");
    wait(500);
    expect(expanded("Envoyer")).toBe("false");
    ptr(dd("Envoyer"), "pointerenter");
    wait(100);
    expect(expanded("Envoyer")).toBe("true");
    expect(panel(btn("Envoyer")).hidden).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it("délai de grâce : glisser du bouton au panneau garde le menu, partir le ferme", () => {
    show();
    ptr(dd("Envoyer"), "pointerenter");
    wait(100);
    ptr(dd("Envoyer"), "pointerleave");
    wait(150);
    expect(expanded("Envoyer")).toBe("true");
    ptr(dd("Envoyer"), "pointerenter");
    wait(1000);
    expect(expanded("Envoyer")).toBe("true");
    ptr(dd("Envoyer"), "pointerleave");
    wait(249);
    expect(expanded("Envoyer")).toBe("true");
    wait(1);
    expect(expanded("Envoyer")).toBe("false");
  });

  it("un seul menu : d'un bouton à l'autre, bascule immédiate", () => {
    show();
    ptr(dd("Envoyer"), "pointerenter");
    wait(100);
    ptr(dd("Envoyer"), "pointerleave");
    ptr(dd("Sécurité"), "pointerenter");
    expect(expanded("Envoyer")).toBe("false");
    expect(expanded("Sécurité")).toBe("true");
    wait(1000);
    expect(expanded("Sécurité")).toBe("true");
  });

  it("clic après survol : le menu reste ouvert, même en partant ; un second clic le ferme", () => {
    show();
    ptr(dd("Envoyer"), "pointerenter");
    wait(100);
    btn("Envoyer").click();
    flushSync();
    expect(expanded("Envoyer")).toBe("true");
    ptr(dd("Envoyer"), "pointerleave");
    wait(1000);
    expect(expanded("Envoyer")).toBe("true");
    btn("Envoyer").click();
    flushSync();
    expect(expanded("Envoyer")).toBe("false");
  });

  it("clic pendant le délai d'intention : ouvre une fois, le minuteur ne referme rien", () => {
    show();
    ptr(dd("Envoyer"), "pointerenter");
    wait(40);
    btn("Envoyer").click();
    flushSync();
    wait(1000);
    expect(expanded("Envoyer")).toBe("true");
  });

  it("clavier après survol : flèche bas va au premier élément, Échap ferme et rend le focus", () => {
    show();
    ptr(dd("Sécurité"), "pointerenter");
    wait(100);
    const b = btn("Sécurité");
    b.focus();
    key(b, "ArrowDown");
    const items = [...panel(b).querySelectorAll<HTMLElement>("[data-nav-item]")];
    expect(document.activeElement).toBe(items[0]);
    // Focus dans le panneau : la souris qui part ne le referme pas.
    ptr(dd("Sécurité"), "pointerleave");
    wait(1000);
    expect(expanded("Sécurité")).toBe("true");
    key(items[0]!, "Escape");
    expect(expanded("Sécurité")).toBe("false");
    expect(document.activeElement).toBe(b);
  });

  it("Échap ferme un menu ouvert au survol quand le focus est ailleurs, sans le déplacer", () => {
    show();
    ptr(dd("Envoyer"), "pointerenter");
    wait(100);
    key(document.body, "Escape");
    expect(expanded("Envoyer")).toBe("false");
    expect(document.activeElement).toBe(document.body);
  });

  it("clic ailleurs ferme un menu ouvert au survol", () => {
    show();
    ptr(dd("Envoyer"), "pointerenter");
    wait(100);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    flushSync();
    expect(expanded("Envoyer")).toBe("false");
  });

  it("changement d'écran : ferme et annule un survol en attente", async () => {
    const { navigate } = await import("../app/router.svelte");
    show();
    ptr(dd("Envoyer"), "pointerenter");
    wait(100);
    navigate("/envois");
    flushSync();
    expect(expanded("Envoyer")).toBe("false");
    ptr(dd("Sécurité"), "pointerenter");
    wait(50);
    navigate("/");
    flushSync();
    wait(1000);
    expect(expanded("Sécurité")).toBe("false");
  });

  it("tactile, stylet ou appareil sans survol fin : rien au survol, le toucher ouvre", () => {
    show();
    ptr(dd("Envoyer"), "pointerenter", "touch");
    ptr(dd("Envoyer"), "pointerenter", "pen");
    wait(1000);
    expect(expanded("Envoyer")).toBe("false");
    fine = false;
    ptr(dd("Envoyer"), "pointerenter");
    wait(1000);
    expect(expanded("Envoyer")).toBe("false");
    btn("Envoyer").click();
    flushSync();
    expect(expanded("Envoyer")).toBe("true");
  });

  it("pendant un envoi : le survol n'ouvre rien", () => {
    show({ busy: true });
    ptr(dd("Envoyer"), "pointerenter");
    wait(1000);
    expect(expanded("Envoyer")).toBe("false");
  });
});

// Conception compte §21.15.1 : connecté, « Mes partages » devient « Accueil » ;
// sans compte, rien ne change.
describe("TopNav connecté", () => {
  it("« Accueil » (vers /) à la place de « Mes partages » tant qu'un compte est ouvert", async () => {
    const { setAccountPrefs } = await import("../history/live.svelte");
    const links = () => [...document.querySelectorAll<HTMLAnchorElement>(".acts a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")]);
    presence.any = true;
    show();
    expect(links()[0]).toEqual(["Mes partages", "/envois"]);
    setAccountPrefs({ keepReceived: true });
    flushSync();
    expect(links()[0]).toEqual(["Accueil", "/"]);
    setAccountPrefs(null);
    flushSync();
    expect(links()[0]).toEqual(["Mes partages", "/envois"]);
  });
});

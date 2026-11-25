// @vitest-environment happy-dom
// Référencement : pages publiques indexées (description, canonique), le reste « noindex » ;
// démo jamais indexée ; l'adresse canonique ne contient jamais de fragment.
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import { applySeo } from "./seo";

const ENV = { origin: "https://shhdrop.app", base: "/", demo: false };
const robots = () => document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content;
const desc = () => document.head.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? "";
const canon = () => document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute("href") ?? null;

describe("applySeo", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    setLang("fr");
    history.replaceState(null, "", "/#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
  it("pages publiques : index, description propre, canonique sans fragment", () => {
    for (const [name, path] of [["home", "/"], ["securite", "/securite"], ["confidentialite", "/confidentialite"], ["offres", "/offres"], ["conditions", "/conditions"], ["mentions", "/mentions-legales"]] as const) {
      applySeo(name, document, ENV);
      expect(robots(), name).toBe("index, follow");
      expect(canon(), name).toBe("https://shhdrop.app" + path);
      expect(desc().length, name).toBeGreaterThan(40);
      expect(desc().length, name).toBeLessThanOrEqual(160);
    }
  });
  it("pages privées : noindex, pas de canonique", () => {
    for (const name of ["envoyer", "open", "manage", "notfound", "signaler", "unsupported", "compte", "inscription", "connexion", "recuperation", "profil", "offert"] as const) {
      applySeo("home", document, ENV);
      applySeo(name, document, ENV);
      expect(robots(), name).toBe("noindex");
      expect(canon(), name).toBeNull();
    }
  });
  it("démo : rien d'indexé ; base du chemin respectée ailleurs", () => {
    applySeo("home", document, { ...ENV, demo: true });
    expect(robots()).toBe("noindex");
    expect(canon()).toBeNull();
    applySeo("securite", document, { origin: "https://x.example", base: "/Shhdrop/", demo: false });
    expect(canon()).toBe("https://x.example/Shhdrop/securite");
  });
  it("anglais : description traduite", () => {
    setLang("en");
    applySeo("home", document, ENV);
    expect(desc()).toMatch(/^Send files/);
  });
  it("pages bilingues : canonique dans la langue affichée, hreflang fr, en et x-default", () => {
    const alt = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="alternate"]')].map((l) => [l.hreflang, l.getAttribute("href")]);
    const B = { ...ENV, bilingue: true };
    applySeo("securite", document, B);
    expect(canon()).toBe("https://shhdrop.app/securite");
    expect(alt()).toEqual([["fr", "https://shhdrop.app/securite"], ["en", "https://shhdrop.app/en/securite"], ["x-default", "https://shhdrop.app/securite"]]);
    setLang("en");
    applySeo("home", document, B);
    expect(canon()).toBe("https://shhdrop.app/en");
    expect(alt()).toEqual([["fr", "https://shhdrop.app/"], ["en", "https://shhdrop.app/en"], ["x-default", "https://shhdrop.app/"]]);
    applySeo("envoyer", document, B);
    expect(alt()).toEqual([]);
    expect(canon()).toBeNull();
    applySeo("home", document, { ...B, demo: true });
    expect(alt()).toEqual([]);
  });
});

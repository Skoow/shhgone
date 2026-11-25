// @vitest-environment happy-dom
// Bandeau « English version » (bandeau en haut de page, U10) : seulement sur la version française d'une page
// bilingue, pour un navigateur anglophone, et jamais dans la démo.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import EnglishLink from "./EnglishLink.svelte";

let c: Record<string, unknown> | null = null;
function lien(props: Record<string, unknown>): string | null {
  c = mount(EnglishLink as never, { target: document.body, props: { bilingue: true, base: "/", ...props } }) as Record<string, unknown>;
  flushSync();
  return document.querySelector("[data-english-link]")?.getAttribute("href") ?? null;
}
afterEach(() => {
  if (c) unmount(c);
  c = null;
  document.body.innerHTML = "";
});

describe("EnglishLink", () => {
  it("navigateur anglophone sur une page française bilingue : lien vers /en…", () => {
    setLang("fr");
    expect(lien({ chemin: "/", navigateur: ["en-US"] })).toBe("/en");
    unmount(c!);
    expect(lien({ chemin: "/securite", navigateur: ["de", "en-GB", "fr"] })).toBe("/en/securite");
    expect(document.querySelector("[data-english-link]")?.getAttribute("lang")).toBe("en");
  });
  it("aucun lien : navigateur français, autre page, page anglaise, démo", () => {
    setLang("fr");
    expect(lien({ chemin: "/", navigateur: ["fr-FR", "en"] })).toBeNull();
    unmount(c!);
    expect(lien({ chemin: "/envoyer", navigateur: ["en-US"] })).toBeNull();
    unmount(c!);
    expect(lien({ chemin: "/securite", navigateur: ["en-US"], bilingue: false })).toBeNull();
    unmount(c!);
    setLang("en");
    expect(lien({ chemin: "/en/securite", navigateur: ["en-US"] })).toBeNull();
    setLang("fr");
  });
  // Bandeau en haut de page, dans le flux (jamais flottant), zones
  // de 44 px, fermable ; la fermeture tient pour la vie de la page (en mémoire seulement).
  // Dernier test du fichier : la fermeture est un état du module.
  it("bandeau dans le flux, fermable, et qui ne revient pas", () => {
    setLang("fr");
    expect(lien({ chemin: "/", navigateur: ["en-US"] })).toBe("/en");
    const bar = document.querySelector<HTMLElement>("[data-english-bar]")!;
    expect(bar.getAttribute("role")).toBe("region");
    expect(bar.getAttribute("lang")).toBe("en");
    const close = document.querySelector<HTMLButtonElement>("[data-english-close]")!;
    expect(close.getAttribute("aria-label")).toBe("Close");
    close.click();
    flushSync();
    expect(document.querySelector("[data-english-bar]")).toBeNull();
    unmount(c!);
    expect(lien({ chemin: "/securite", navigateur: ["en-US"] })).toBeNull();
  });
});

describe("EnglishLink : styles", () => {
  it("bandeau dans le flux (pas de position fixe), hauteur ≥ 44 px, lien et croix de 44 px", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/ui/EnglishLink.svelte", "utf8");
    const css = /<style>([\s\S]*)<\/style>/.exec(src)![1]!;
    expect(css).not.toMatch(/position:\s*(fixed|sticky)/);
    expect(css).toMatch(/\.en-bar \{[^}]*min-height: 48px/);
    expect(css).toMatch(/\.en-link \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.fermer \{[^}]*width: 44px;[^}]*height: 44px/);
  });
});

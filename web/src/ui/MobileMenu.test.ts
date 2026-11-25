// @vitest-environment happy-dom
// Menu du téléphone : sous « Sécurité », les sections de l'accueil « Comment ça marche » et
// « Ce que voit le serveur » (comme le menu Sécurité de l'ordinateur), qui ferment le menu et
// mènent à la section (ui/section.ts).
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";

const S = vi.hoisted(() => ({ allerSection: vi.fn() }));
vi.mock("./section", () => S);
const { default: MobileMenu } = await import("./MobileMenu.svelte");

let c: Record<string, unknown> | null = null;
beforeEach(() => {
  setLang("fr");
  S.allerSection.mockReset();
  S.allerSection.mockResolvedValue(undefined);
  c = mount(MobileMenu as never, { target: document.body, props: {} }) as Record<string, unknown>;
  flushSync();
});
afterEach(() => {
  if (c) void unmount(c);
  c = null;
  document.body.innerHTML = "";
});

describe("MobileMenu", () => {
  it("sections de l'accueil sous « Sécurité » : la section voulue, menu fermé", () => {
    const b = document.querySelector<HTMLButtonElement>("[data-menu-button]")!;
    b.click();
    flushSync();
    expect(b.getAttribute("aria-expanded")).toBe("true");
    const how = document.querySelector<HTMLButtonElement>('[data-mm-sec="how"]')!;
    const server = document.querySelector<HTMLButtonElement>('[data-mm-sec="server"]')!;
    expect(how.textContent!.trim()).toBe("Comment ça marche");
    expect(server.textContent!.trim()).toBe("Ce que voit le serveur");
    how.click();
    flushSync();
    expect(S.allerSection).toHaveBeenLastCalledWith("comment", undefined);
    expect(b.getAttribute("aria-expanded")).toBe("false");
    b.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('[data-mm-sec="server"]')!.click();
    flushSync();
    expect(S.allerSection).toHaveBeenLastCalledWith("faq-server", true);
  });
});

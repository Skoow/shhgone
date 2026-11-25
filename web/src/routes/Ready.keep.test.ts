// @vitest-environment happy-dom
// « Lien prêt » et l'historique des envois : avec ou sans compte, « Garder dans
// mon historique » est désactivé par défaut ; le lien de gestion est alors montré à l'écran (seul
// moyen de suivre ou de supprimer le partage plus tard), et rien n'est gardé. Activé par la
// personne : l'entrée est gardée, le réglage vaut pour l'envoi suivant (comportement d'avant).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB } from "../history/fake-idb.test-helper";

// Modules neufs à chaque test (historique de l'appareil vide) : svelte avec eux, sinon le
// composant et `mount` viendraient de deux exemplaires différents.
let svelte: typeof import("svelte");
let live: typeof import("../history/live.svelte");
let Ready: unknown;
const mounted: Record<string, unknown>[] = [];
const MANAGE = "https://x.example/s#m" + "m".repeat(43);
const props = (manage = MANAGE) => ({
  result: { link: "https://x.example/s#" + "k".repeat(43), manage, expiresInS: 3600, password: "Abcdef-1234" },
  summary: "1 élément",
  ttlHours: 1,
  maxOpens: 1,
  itemsCount: 1,
  sizeBytes: 10,
  ondone: () => undefined,
  onforget: () => undefined,
  onnew: () => undefined,
});
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  svelte.flushSync();
};
const show = async (p = props()) => {
  mounted.push(svelte.mount(Ready as never, { target: document.body, props: p }) as Record<string, unknown>);
  await settle();
};
const sw = () => document.querySelector<HTMLButtonElement>("[data-keep] [role=switch]")!;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", fakeIndexedDB());
  svelte = await import("svelte");
  (await import("../i18n/i18n.svelte")).setLang("fr");
  live = await import("../history/live.svelte");
  Ready = (await import("./Ready.svelte")).default;
});
afterEach(() => {
  while (mounted.length) void svelte.unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Lien prêt : « Garder dans mon historique »", () => {
  it("sans compte : désactivé par défaut ; lien de gestion montré ; rien n'est gardé", async () => {
    await show();
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().disabled).toBe(false);
    expect(document.querySelector("[data-manage]")!.textContent).toContain(MANAGE);
    expect(document.querySelector("[data-keep][data-kept]")).toBeNull();
    expect(await live.allEntries()).toEqual([]);
  });

  it("activé par la personne : gardé, lien de gestion replié ; l'envoi suivant est gardé d'office", async () => {
    await show();
    sw().click();
    await settle();
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-manage]")).toBeNull();
    expect(document.querySelector("[data-keep][data-kept]")).not.toBeNull();
    expect((await live.allEntries()).map((e) => e.manage)).toEqual([MANAGE]);
    while (mounted.length) void svelte.unmount(mounted.pop()!);
    const NEXT = "https://x.example/s#m" + "n".repeat(43);
    await show(props(NEXT));
    expect(sw().getAttribute("aria-checked")).toBe("true");
    expect((await live.allEntries()).map((e) => e.manage).sort()).toEqual([MANAGE, NEXT].sort());
  });

  it("désactivé de nouveau : l'entrée part, le lien de gestion revient", async () => {
    await live.setHistoryEnabled(true);
    await show();
    expect((await live.allEntries())).toHaveLength(1);
    sw().click();
    await settle();
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector("[data-manage]")!.textContent).toContain(MANAGE);
    expect(await live.allEntries()).toEqual([]);
    expect(live.shares.enabled).toBe(false);
  });

  it("avec un compte aussi (B) : désactivé par défaut, lien de gestion montré, rien n'est gardé", async () => {
    live.setAccountPrefs({ keepReceived: true });
    await show();
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector("[data-manage]")!.textContent).toContain(MANAGE);
    expect(await live.allEntries()).toEqual([]);
    live.setAccountPrefs(null);
  });
});

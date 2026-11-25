// @vitest-environment happy-dom
// Carte de « Mes partages » : l'heure de la dernière lecture du serveur est dite telle
// quelle, avec le rythme des relectures ; jamais « à l'instant » à côté d'un compteur qui peut
// dater de 5 minutes.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import type { HistoryEntry } from "../history/store";
import ShareCard from "./ShareCard.svelte";

const T = new Date(2026, 10, 12, 18, 58, 30).getTime();
const entry = (o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "a".repeat(22),
  sorte: "envoi",
  origine: "local",
  link: "",
  label: "",
  format: "",
  manage: "https://x.example/#m" + "b".repeat(43),
  createdAt: T - 120_000,
  sizeBytes: 1000,
  itemsCount: 1,
  expiresAt: T + 3600_000,
  maxOpens: 2,
  opensUsed: 0,
  opens: [],
  state: "ready",
  lastSeenAt: T - 20_000,
  endedAt: 0,
  destroyedHere: false,
  ...o,
});

let c: Record<string, unknown> | null = null;
afterEach(() => {
  if (c) void unmount(c);
  c = null;
  document.body.innerHTML = "";
});
const render = (e: HistoryEntry, now: number, compact: boolean) => {
  c = mount(ShareCard as never, { target: document.body, props: { entry: e, now, compact, onrefresh: async () => undefined, ondestroy: async () => false, onremove: () => undefined } }) as Record<string, unknown>;
  flushSync();
  return document.querySelector("[data-seen]")?.textContent ?? "";
};

describe("ShareCard : dernière lecture", () => {
  it("heure réelle de la lecture et rythme des relectures, en français et en anglais ; jamais « à l'instant »", () => {
    setLang("fr");
    const fr = render(entry(), T, true);
    expect(fr).toBe("État lu à 18\u202fh\u202f58 · relu au plus toutes les 5\u202fmin");
    expect(fr).not.toMatch(/instant/);
    void unmount(c!);
    setLang("en");
    const en = render(entry(), T, true);
    expect(en).toMatch(/^Status read at 6:58\sPM · re-read at most every 5 min$/);
    expect(en).not.toMatch(/just now/);
  });

  it("lecture d'un autre jour : la date est dite aussi", () => {
    setLang("fr");
    expect(render(entry({ lastSeenAt: T - 26 * 3600_000 }), T, true)).toMatch(/^État lu le 11\snov\. à 16\sh\s58 · /);
  });
});

// Titre du partage : en tête de la carte, texte brut isolé ; renommer sur cet appareil
// seulement (l'écran le dit) ; sans `onrename` (accueil), pas de renommage.
describe("ShareCard : titre du partage", () => {
  const mountCard = (e: HistoryEntry, onrename?: (s: string) => Promise<boolean>, compact = false) => {
    c = mount(ShareCard as never, { target: document.body, props: { entry: e, now: T, compact, onrefresh: async () => undefined, ondestroy: async () => false, onremove: () => undefined, onrename } }) as Record<string, unknown>;
    flushSync();
  };

  it("affiché en tête, en texte brut (bdi), et nomme la carte ; sans titre : aucune ligne", () => {
    setLang("fr");
    mountCard(entry({ label: "<img src=x> Contrat" }), undefined, true);
    const name = document.querySelector("[data-share-title]")!;
    expect(name.querySelector("bdi")!.textContent).toBe("<img src=x> Contrat");
    expect(document.querySelector("img")).toBeNull();
    const card = document.querySelector("[data-share-card]")!;
    expect(card.getAttribute("aria-labelledby")!.split(" ")[0]).toBe(name.id);
    void unmount(c!);
    document.body.innerHTML = "";
    mountCard(entry(), undefined, true);
    expect(document.querySelector("[data-share-title]")).toBeNull();
  });

  it("renommer : champ prérempli, 80 caractères au plus, l'aide dit que le destinataire ne voit pas le changement", async () => {
    setLang("fr");
    const calls: string[] = [];
    mountCard(entry({ label: "Ancien" }), async (s) => (calls.push(s), true));
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Renommer")!;
    btn.click();
    flushSync();
    const form = document.querySelector("[data-rename]")!;
    const input = form.querySelector("input")!;
    expect(input.value).toBe("Ancien");
    expect(input.getAttribute("maxlength")).toBe("80");
    expect(form.textContent).toContain("le destinataire voit toujours le nom choisi à l'envoi");
    input.value = "Nouveau";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    [...form.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Enregistrer le nom")!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(calls).toEqual(["Nouveau"]);
    expect(document.querySelector("[data-rename]")).toBeNull();
  });

  it("renommage refusé : message, le champ reste ; sans onrename : pas de bouton", async () => {
    setLang("fr");
    mountCard(entry(), async () => false);
    [...document.querySelectorAll("button")].find((b) => b.textContent!.trim() === "Renommer")!.click();
    flushSync();
    [...document.querySelectorAll<HTMLButtonElement>("[data-rename] button")].find((b) => b.textContent!.trim() === "Enregistrer le nom")!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(document.querySelector("[data-rename] [role=alert]")!.textContent).toBe("Le nom n'a pas pu être modifié.");
    void unmount(c!);
    document.body.innerHTML = "";
    mountCard(entry());
    expect([...document.querySelectorAll("button")].some((b) => b.textContent!.trim() === "Renommer")).toBe(false);
  });
});

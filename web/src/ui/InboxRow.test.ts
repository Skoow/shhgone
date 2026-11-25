// @vitest-environment happy-dom
// Ligne de l'accueil (conception compte §21.15.1) : pastille selon la sorte, titre (<bdi>),
// sous-titre (« S'efface dans … », « Expiré », « Détruit »), heure ou date de la dernière activité,
// puces « Créé par vous » et « Rouvrir ici compte une ouverture » ; entrée finie atténuée, avec
// « Retirer de la liste » au clavier. Aucun lien ni secret dans le DOM.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import type { HistoryEntry } from "../history/store";
import InboxRow from "./InboxRow.svelte";

const NNBSP = "\u202f";
const NOW = new Date(2026, 10, 14, 16, 0).getTime();
const KEY = "k".repeat(43);
const entry = (o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: "a".repeat(22),
  sorte: "recu",
  origine: "local",
  manage: "",
  link: "https://x.example/#" + KEY,
  label: "",
  format: "image",
  createdAt: new Date(2026, 10, 14, 9, 41).getTime(),
  sizeBytes: 148_897_792,
  itemsCount: 6,
  expiresAt: NOW + (4 * 3600 + 12 * 60) * 1000,
  maxOpens: 0,
  opensUsed: 0,
  opens: [],
  state: "ready",
  lastSeenAt: NOW,
  endedAt: 0,
  destroyedHere: false,
  ...o,
});

let c: Record<string, unknown> | null = null;
beforeEach(() => setLang("fr"));
afterEach(() => {
  if (c) void unmount(c);
  c = null;
  document.body.innerHTML = "";
});
function render(e: HistoryEntry, extra: Record<string, unknown> = {}) {
  const ul = document.createElement("ul");
  document.body.append(ul);
  const onopen = vi.fn();
  const onremove = vi.fn();
  c = mount(InboxRow as never, { target: ul, props: { entry: e, now: NOW, onopen, onremove, ...extra } }) as Record<string, unknown>;
  flushSync();
  const li = ul.querySelector("li")!;
  return { li, text: li.textContent!.replace(/[\s\u00a0]+/g, " ").trim(), onopen, onremove };
}

describe("InboxRow", () => {
  it("partage reçu : titre, temps restant, heure du jour ; ouvrir au toucher ; aucun lien dans la page", () => {
    const { li, text, onopen } = render(entry());
    expect(li.querySelector("bdi")!.textContent).toBe(`Partage reçu · 6${NNBSP}éléments · 142${NNBSP}Mo`);
    expect(text).toContain("S'efface dans 4 h 12");
    expect(text).toContain("9 h 41");
    expect(li.querySelector("[data-format]")).not.toBeNull();
    expect(li.getAttribute("data-ended")).toBeNull();
    li.querySelector<HTMLButtonElement>("button")!.click();
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(li.querySelector("[data-remove]")).toBeNull();
  });

  it("« Rouvrir ici compte une ouverture » seulement pour un reçu venu d'un autre appareil", () => {
    expect(render(entry({ origine: "compte" })).text).toContain("Rouvrir ici compte une ouverture");
    unmount(c!);
    document.body.innerHTML = "";
    expect(render(entry()).text).not.toContain("Rouvrir ici");
  });

  it("échéance passée : « Expiré », atténuée, « Retirer de la liste » au clavier", () => {
    const { li, text, onremove } = render(entry({ expiresAt: NOW - 1000, createdAt: new Date(2026, 10, 12, 8, 0).getTime() }));
    expect(text).toContain("Expiré");
    expect(text).not.toContain("S'efface");
    expect(text).toContain("12 nov.");
    expect(li.getAttribute("data-ended")).toBe("true");
    const rm = li.querySelector<HTMLButtonElement>("[data-remove]")!;
    expect(rm.getAttribute("aria-label")).toBe("Retirer de la liste");
    rm.click();
    expect(onremove).toHaveBeenCalledTimes(1);
  });

  it("détruit (constaté par une relecture) : « Détruit »", () => {
    expect(render(entry({ state: "gone", endedAt: NOW - 10 })).text).toContain("Détruit");
  });

  it("votre envoi : « Votre partage · 3 éléments », flèche d'envoi ; salon créé : « Créé par vous »", () => {
    const a = render(entry({ sorte: "envoi", link: "", format: "", manage: "https://x.example/#m" + "m".repeat(43), itemsCount: 3, maxOpens: 1 }));
    expect(a.li.querySelector("bdi")!.textContent).toBe(`Votre partage · 3${NNBSP}éléments`);
    expect(a.li.querySelector("[data-sent]")).not.toBeNull();
    unmount(c!);
    document.body.innerHTML = "";
    // Titre du partage : à la place du nombre d'éléments, en texte brut (bdi).
    const t = render(entry({ sorte: "envoi", link: "", format: "", manage: "https://x.example/#m" + "m".repeat(43), itemsCount: 3, maxOpens: 1, label: "<b>Contrat</b>" }));
    expect(t.li.querySelector("bdi")!.textContent).toBe("<b>Contrat</b>");
    expect(t.li.querySelector("b")).toBeNull();
    unmount(c!);
    document.body.innerHTML = "";
    const b = render(entry({ sorte: "salon_cree", link: "https://x.example/#c" + "r".repeat(43), label: "Équipe", format: "", itemsCount: 0, sizeBytes: 0, createdAt: new Date(2026, 10, 14, 10, 5).getTime() }));
    expect(b.li.querySelector("bdi")!.textContent).toBe("Équipe · créé le 14 nov.");
    expect(b.text).toContain("Créé par vous");
    expect(b.li.querySelector("[data-room]")).not.toBeNull();
    unmount(c!);
    document.body.innerHTML = "";
    const d = render(entry({ sorte: "salon_rejoint", link: "https://x.example/#c" + "r".repeat(43), label: "", format: "", itemsCount: 0, sizeBytes: 0 }));
    expect(d.li.querySelector("bdi")!.textContent).toBe("Salon · rejoint le 14 nov.");
  });
});

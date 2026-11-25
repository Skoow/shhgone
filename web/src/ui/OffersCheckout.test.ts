// @vitest-environment happy-dom
// Page Offres (lot 2 de l'audit de design) : cartes courtes (prix, ligne-clé), comparatif aligné
// qui porte le détail (chiffres lus dans PAID et limits.ts, aucune durée de vidéo par offre tant que
// la capture n'applique que la limite gratuite), panneau de paiement (récapitulatif seulement une
// fois l'offre choisie, bouton inactif sans choix), questions en deux colonnes. Paiement fermé ici
// (aucun serveur) : rien n'est demandé.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes } from "../i18n/format";
import { setLang } from "../i18n/i18n.svelte";
import { CONTENT_MAX, CREATES_PER_DAY, MAX_OPENS, PAID } from "../limits";
import OffersCheckout from "./OffersCheckout.svelte";

let app: Record<string, unknown> | null = null;
const n = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
beforeEach(() => {
  setLang("fr");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Offres : cartes, comparatif, panneau de paiement, questions", () => {
  it("cartes : prix et ligne-clé ; Plus mis en avant ; Gratuit sans choix", () => {
    app = mount(OffersCheckout as never, { target: document.body }) as Record<string, unknown>;
    flushSync();
    expect([...document.querySelectorAll("[data-tier]")].map((c) => c.getAttribute("data-tier"))).toEqual(["free", "plus", "pro"]);
    expect(n(document.querySelector('[data-tier="free"] .key')!.textContent)).toBe(n(`${formatBytes(CONTENT_MAX, "fr")} · 24 h · ${MAX_OPENS} ouvertures`));
    expect(n(document.querySelector('[data-tier="pro"] .key')!.textContent)).toBe(n(`${formatBytes(PAID.pro.bytes, "fr")} · 7 jours · ${PAID.pro.opens} ouvertures`));
    expect(document.querySelectorAll(".badge")).toHaveLength(1);
    expect(document.querySelector('[data-tier="plus"] .badge')!.textContent).toBe("Conseillé");
    expect(document.querySelector('[data-tier="free"] input')).toBeNull();
    // Le détail n'est plus dans les cartes : seulement dans le comparatif.
    expect(document.querySelector("[data-tier] [data-calls]")).toBeNull();
  });

  it("comparatif : colonnes Gratuit, Plus, Pro ; chiffres de limits.ts ; pas de durée de vidéo par offre", () => {
    app = mount(OffersCheckout as never, { target: document.body }) as Record<string, unknown>;
    flushSync();
    const rows = [...document.querySelectorAll(".cmp tbody tr:not(.grp)")].map((r) => [...r.children].map((c) => n(c.textContent)));
    expect(rows).toEqual([
      ["Taille par partage", ...[CONTENT_MAX, PAID.plus.bytes, PAID.pro.bytes].map((b) => n(formatBytes(b, "fr")))],
      ["Durée au plus", "24 h", "3 jours", "7 jours"],
      ["Ouvertures au plus", String(MAX_OPENS), String(PAID.plus.opens), String(PAID.pro.opens)],
      ["Partages inclus", `${CREATES_PER_DAY} par jour`, `${PAID.plus.shares} par 30 jours`, `${PAID.pro.shares} par 30 jours`],
      ["Appels audio et vidéo", "Non inclus", "Inclus", "Inclus"],
      ["Chiffrement de bout en bout", "Identique", "Identique", "Identique"],
    ]);
    expect([...document.querySelectorAll(".cmp thead th[scope=col]")].map((t) => n(t.textContent))).toEqual(["Ce qui change", "Gratuit", "Plus", "Pro"]);
    expect(document.querySelector(".cmp")!.textContent).not.toMatch(/vidéo filmée/iu);
  });

  it("panneau : récapitulatif après le choix seulement, bouton inactif ; questions en deux colonnes", () => {
    app = mount(OffersCheckout as never, { target: document.body }) as Record<string, unknown>;
    flushSync();
    expect(document.querySelector("[data-summary]")).toBeNull();
    const pay = document.querySelector<HTMLButtonElement>("[data-pay]")!;
    expect(pay.disabled).toBe(true);
    expect(document.querySelector("[data-waiver]")).not.toBeNull();
    (document.querySelector('[data-tier="plus"] .big') as HTMLElement).click();
    flushSync();
    const sum = document.querySelector("[data-summary]")!;
    expect(n(sum.querySelector(".st")!.textContent)).toBe(n(`Plus · Mensuel · ${PAID.plus.month} € / mois`));
    expect(sum.querySelectorAll(".adds li")).toHaveLength(4);
    expect(pay.disabled).toBe(true);
    expect(document.querySelector("[data-waiver]")!.closest("[data-summary]")).toBe(sum);
    const cols = [...document.querySelectorAll(".ofaq .qa > div")];
    expect(cols.map((c) => c.querySelectorAll("details").length)).toEqual([3, 3]);
  });
});

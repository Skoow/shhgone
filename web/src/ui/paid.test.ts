// @vitest-environment happy-dom
// Tâche UP : mot de passe toujours généré, choix payants verrouillés, ligne « Avec Plus » au
// dépassement de taille, pages d'erreur (D41-15, D41-16, D41-17).
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOptions } from "../flows/options.svelte";
import { setScreenTitle } from "../app/title";
import { setLang } from "../i18n/i18n.svelte";
import { CONTENT_MAX, generatePassword } from "../index";
import ErrorPage from "../routes/ErrorPage.svelte";
import Options from "../routes/Options.svelte";
import CapacityGauge from "./CapacityGauge.svelte";

const mounted: Record<string, unknown>[] = [];
function show(C: unknown, props: Record<string, unknown>) {
  const c = mount(C as never, { target: document.body, props }) as Record<string, unknown>;
  mounted.push(c);
  flushSync();
  return c;
}
const text = () => document.body.textContent!.replace(/[  ]/g, " ");
beforeEach(() => setLang("fr"));
afterEach(() => {
  while (mounted.length) void unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("options : mot de passe généré seulement, aucun choix payant", () => {
  function opts() {
    const options = createOptions({ generate: generatePassword });
    show(Options, { options, unviewable: [] });
    return { options };
  }
  it("aucune saisie de mot de passe ; plus de mot de passe dans les options (montré sous le lien, sur « Lien prêt »)", () => {
    const { options } = opts();
    // Seul champ de texte : le nom du partage, jamais un mot de passe.
    const fields = [...document.querySelectorAll("input[type=text], input:not([type]), input[type=password]")];
    expect(fields.filter((f) => !f.closest("[data-share-name]"))).toHaveLength(0);
    expect(fields.map((f) => f.getAttribute("type"))).not.toContain("password");
    expect(text()).not.toContain("Écrire mon propre");
    expect(text()).not.toContain(options.password);
    const labels = [...document.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(labels).not.toContain("Générer un autre");
    // Toujours généré, 11 caractères, prêt pour l'envoi.
    expect(options.password).toHaveLength(11);
  });
  it("Aucun choix payant verrouillé dans les options, ni coffre", () => {
    opts();
    expect(document.querySelectorAll("[data-locked]")).toHaveLength(0);
    expect(text()).not.toMatch(/jours|première ouverture|Jusqu'à 50|copie chiffrée/);
  });
});

describe("dépassement de 2 Go : l'erreur seule, les espaces Plus et Pro sont à côté de la jauge (retours OPT)", () => {
  it("au-delà de 2 Go : « Trop gros », sans ligne « Avec Plus » en doublon", () => {
    show(CapacityGauge, { bytes: CONTENT_MAX + 1, count: 2, head: true });
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Trop gros");
    expect(document.querySelector("[data-upsell]")).toBeNull();
  });
});

describe("pages d'erreur (FR, EN) : titre d'onglet, action claire", () => {
  const cases = [
    ["notfound", "Cette page n'existe pas.", "Page introuvable · Shhgone", "This page does not exist."],
    ["offline", "Vous êtes hors ligne.", "Hors ligne · Shhgone", "You are offline."],
    ["server", "Le serveur a un problème.", "Erreur du serveur · Shhgone", "The server has a problem."],
    ["limit", "Trop de demandes rapprochées.", "Trop de demandes · Shhgone", "Too many requests in a row."],
    ["unsupported", "Ce navigateur ne permet pas de chiffrer en sécurité.", "Navigateur non pris en charge · Shhgone", "This browser cannot encrypt safely."],
    ["maintenance", "Shhgone est en maintenance.", "Maintenance · Shhgone", "Shhgone is under maintenance."],
  ] as const;
  it.each(cases)("%s", (kind, fr, title, en) => {
    setLang("fr");
    setScreenTitle("open");
    const c = show(ErrorPage, { kind, onretry: () => undefined });
    expect(document.querySelector("h1")!.textContent).toBe(fr);
    expect(document.activeElement).toBe(document.querySelector("h1"));
    expect(document.title).toBe(title);
    setLang("en");
    flushSync();
    expect(document.querySelector("h1")!.textContent).toBe(en);
    void unmount(c);
    mounted.pop();
    expect(document.title).toBe("Open a share · Shhgone"); // rendu à l'écran d'avant
  });
  it("429 : compte à rebours de Retry-After, « Réessayer » activé à zéro", () => {
    vi.useFakeTimers();
    const onretry = vi.fn();
    show(ErrorPage, { kind: "limit", retryAfterS: 3, onretry });
    const btn = () => [...document.querySelectorAll("button")].find((b) => b.textContent!.includes("Réessayer"))!;
    expect(text()).toContain("Vous pourrez réessayer dans 3 s.");
    expect(btn().disabled).toBe(true);
    vi.advanceTimersByTime(3100);
    flushSync();
    expect(text()).toContain("Vous pouvez réessayer.");
    expect(btn().disabled).toBe(false);
    btn().click();
    expect(onretry).toHaveBeenCalledTimes(1);
  });
  it("hors ligne : le retour du réseau relance d'office", () => {
    const onretry = vi.fn();
    show(ErrorPage, { kind: "offline", onretry });
    window.dispatchEvent(new Event("online"));
    expect(onretry).toHaveBeenCalledTimes(1);
  });
  it("introuvable : lien vers l'accueil ; navigateur non pris en charge : aucune action trompeuse", () => {
    show(ErrorPage, { kind: "notfound" });
    expect(document.querySelector("a")!.textContent).toBe("Retour à l'accueil");
    while (mounted.length) void unmount(mounted.pop()!);
    document.body.innerHTML = "";
    show(ErrorPage, { kind: "unsupported" });
    expect(document.querySelectorAll("a, button")).toHaveLength(0);
  });
});

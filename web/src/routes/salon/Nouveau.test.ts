// @vitest-environment happy-dom
// « /salon/nouveau » : sans session, la vitrine fictive du salon (aucun moteur, aucune requête),
// « Créer un compte » et « J'ai déjà un compte » (« ?suite=salon »), la ligne « rejoindre sans
// compte » (D42-26 (2)) ; avec une session, le formulaire de création, sans vitrine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { fr } from "../../i18n/fr";
import { en } from "../../i18n/en";
import { attendre, demonter, monter } from "../compte/pages.test-helper";

const C = vi.hoisted(() => ({ etatCompte: vi.fn() }));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
const E = vi.hoisted(() => ({ loadSalonEngine: vi.fn() }));
vi.mock("../../salon/engine", async (orig) => ({ ...(await orig<object>()), ...E }));
const { account } = await import("../../account/session.svelte");
const { default: Nouveau } = await import("./Nouveau.svelte");

const texte = () => document.body.textContent!;
let fetchs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLang("fr");
  fetchs = vi.fn(() => Promise.reject(new Error("aucune requête attendue")));
  vi.stubGlobal("fetch", fetchs);
  C.etatCompte.mockReset();
  C.etatCompte.mockResolvedValue({ limites: { salons: 1, places: 4, heures: 24 } });
  E.loadSalonEngine.mockReset();
});
afterEach(() => {
  demonter();
  vi.unstubAllGlobals();
  account.etat = "absent";
});

describe("Salon, sans session : vitrine et bloc d'action", () => {
  it("titre, vitrine fictive résumée (détail masqué), deux actions vers l'inscription et la connexion, rejoindre sans compte", async () => {
    await monter(Nouveau);
    const h1 = document.querySelector("h1")!;
    expect(h1.textContent).toBe(fr["salon.vitrine.title"]);
    expect(h1.closest(".titre-bandeau")).not.toBeNull();
    expect(document.activeElement).toBe(h1);

    const v = document.querySelector("[data-vitrine]")!;
    expect(v.getAttribute("aria-label")).toBe(fr["salon.vitrine.label"]);
    expect(v.querySelector(".sr-only")!.textContent).toBe(fr["salon.vitrine.resume"]);
    const detail = v.querySelector(".ecran")!;
    expect(detail.getAttribute("aria-hidden")).toBe("true");
    // Rien de focalisable dans la vitrine.
    expect(v.querySelectorAll("a, button, input, textarea, select, [tabindex]")).toHaveLength(0);
    // Tout ce qu'elle doit montrer.
    expect(v.querySelector("[data-apercu]")!.textContent).toBe(fr["salon.vitrine.apercu"]);
    const vt = v.textContent!;
    for (const nom of ["Camille", "Noé", "Inès"]) expect(vt).toContain(nom);
    expect(new Set([...v.querySelectorAll(".msg")].map((m) => [...m.classList].find((c) => /^c\d$/.test(c)))).size).toBeGreaterThanOrEqual(4);
    // Photos de profil : images locales du dépôt (aucun service externe), pas d'initiales.
    expect(v.querySelectorAll(".membres .pastille")).toHaveLength(4);
    const photos = [...v.querySelectorAll<HTMLImageElement>(".membres .pastille img")];
    expect(photos).toHaveLength(4);
    for (const i of photos) expect(i.getAttribute("src")).not.toMatch(/^(https?:)?\/\//);
    // Présence : pastille verte (en ligne) ou rouge (hors ligne), toujours dite en texte.
    expect(v.querySelectorAll(".membres .point.hors")).toHaveLength(1);
    expect(v.querySelectorAll(".membres .point.en")).toHaveLength(3);
    expect(vt).toContain(fr["salon.room.seen.min"].replace("{n}", "12"));
    expect(vt).toContain(fr["salon.vitrine.m1"]);
    expect(v.querySelectorAll(".vocal .onde i").length).toBeGreaterThan(10);
    for (const k of ["salon.vitrine.photo", "salon.vitrine.pdf", "salon.vitrine.zip"] as const) expect(vt).toContain(fr[k]);
    expect(v.querySelector("[data-ecrit]")!.textContent).toContain("Noé écrit…");
    expect(v.querySelector("[data-appels] .badge")!.textContent).toBe(fr["salon.appel.badge"]);
    // L'échéance n'est dite qu'à un endroit : l'en-tête (pas de bandeau « se ferme dans » en plus).
    // En-tête compact (comme le vrai salon) : en ligne, places libres, échéance (forme longue ;
    // la forme courte « 15 min » ne sert que sur téléphone).
    const statut = [...v.querySelectorAll(".statut > span:not(.sep)")].map((e) => e.querySelector(".long")?.textContent ?? e.textContent);
    expect(statut.map((x) => x!.replace(/\s+/g, " ").trim())).toEqual(["3 en ligne", "2 places libres", "s'efface dans 15 min"]);
    expect(v.querySelector("[data-fin]")).toBeNull();
    expect(vt).not.toContain(fr["salon.fin.alerte.other"].replace("{n}", "15"));

    const ins = document.querySelector<HTMLAnchorElement>("a[data-inscription]")!;
    const cnx = document.querySelector<HTMLAnchorElement>("a[data-connexion]")!;
    expect(ins.textContent).toBe("Créer un compte");
    expect(ins.getAttribute("href")).toBe("/compte/inscription?suite=salon");
    expect(cnx.textContent).toBe("J'ai déjà un compte");
    expect(cnx.getAttribute("href")).toBe("/compte/connexion?suite=salon");
    for (const k of ["salon.vitrine.join.titre", "salon.vitrine.join.badge", "salon.vitrine.join.texte"] as const) expect(texte()).toContain(fr[k]);
    for (const k of ["salon.vitrine.p1", "salon.vitrine.p2", "salon.vitrine.p3", "salon.vitrine.p4"] as const) expect(texte()).toContain(fr[k]);

    // Aucune requête, aucun moteur, aucun formulaire de création.
    await attendre();
    expect(fetchs).not.toHaveBeenCalled();
    expect(E.loadSalonEngine).not.toHaveBeenCalled();
    expect(C.etatCompte).not.toHaveBeenCalled();
    expect(document.querySelector(".form")).toBeNull();
  });

  it("en anglais : mêmes éléments, textes anglais", async () => {
    setLang("en");
    await monter(Nouveau);
    expect(document.querySelector("h1")!.textContent).toBe(en["salon.vitrine.title"]);
    expect(document.querySelector("[data-vitrine]")!.getAttribute("aria-label")).toBe(en["salon.vitrine.label"]);
    expect(document.querySelector("a[data-connexion]")!.textContent).toBe(en["salon.vitrine.login"]);
    expect(texte()).toContain(en["salon.room.typing.un"].replace("{nom}", "Noé"));
    for (const k of ["salon.vitrine.join.titre", "salon.vitrine.join.badge", "salon.vitrine.join.texte"] as const) expect(texte()).toContain(en[k]);
  });
});

describe("Salon, avec une session : l'écran de création", () => {
  it("formulaire de création, ni vitrine ni bloc d'action", async () => {
    vi.stubGlobal("__COMPTES__", true);
    account.etat = "ouvert";
    await monter(Nouveau);
    expect(document.querySelector("h1")!.textContent).toBe(fr["salon.new.title"]);
    expect(document.querySelector("[data-vitrine]")).toBeNull();
    expect(document.querySelector("[data-salon-entree]")).toBeNull();
    expect(document.querySelector(".form")).not.toBeNull();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent!.includes(fr["salon.new.create"]))).toBe(true);
    expect(C.etatCompte).toHaveBeenCalled();
  });
});

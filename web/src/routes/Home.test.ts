// @vitest-environment happy-dom
import { MAX_OPENS, PAID, PW_TRIES, TTL_HOURS } from "../limits";
import { formatDuration } from "../i18n/format";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import Home from "./Home.svelte";

let c: Record<string, unknown> | null = null;
function show(props: Record<string, unknown> = {}) {
  c = mount(Home as never, { target: document.body, props }) as Record<string, unknown>;
  flushSync();
}

beforeEach(() => setLang("fr"));
/** Nom lu par les lecteurs d'écran : le texte hors des parties aria-hidden (K8). */
function title(h1: Element): string {
  const c = h1.cloneNode(true) as Element;
  c.querySelectorAll('[aria-hidden="true"]').forEach((e) => e.remove());
  return c.textContent!.trim();
}
afterEach(() => {
  if (c) void unmount(c);
  c = null;
  document.body.innerHTML = "";
});

describe("Home (UI §9.1)", () => {
  it("lot 2 : chiffres clés et vie d'un lien lus dans limits.ts, aucun nom d'algorithme ; lien en deux, ce que voit le serveur ; vérification", () => {
    show();
    const n = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    // Plus de bande de chiffres clés : chaque chiffre n'est dit qu'une fois (offres, vie d'un lien).
    expect(document.querySelector(".stats")).toBeNull();
    expect(document.body.textContent).not.toMatch(/AES|GCM|ne voit rien/u);
    const rules = n(document.querySelector(".life .rules")!.textContent);
    for (const h of TTL_HOURS) expect(rules).toContain(n(formatDuration(h * 3600, "fr")));
    expect(rules).toContain(`à ${MAX_OPENS}.`);
    expect(rules).toContain(`après ${PW_TRIES} mots de passe faux`);
    // Après la dernière ouverture, le contenu reste jusqu'à l'échéance (pages « Confidentialité ») :
    // jamais « effacé après l'ouverture ».
    expect(rules).toContain("Le contenu chiffré reste jusqu'à l'échéance");
    expect(document.querySelector(".life .track")!.getAttribute("aria-hidden")).toBe("true");
    expect([...document.querySelectorAll(".sees .sv-col li")].map((l) => l.textContent)).toEqual([
      "des données chiffrées", "leur taille approximative", "l'échéance, au quart d'heure près", "les ouvertures et les essais restants",
      "votre adresse IP", "l'heure des envois et des ouvertures",
      "le contenu", "les noms des fichiers", "le mot de passe", "la clé",
    ]);
    const links = [...document.querySelectorAll(".tcards a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://github.com/Skoow/shhgone", "/verifier"]);
    expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
    // Mini-schémas de « Comment ça marche » : animés en CSS seulement, aucun SMIL.
    expect(document.querySelectorAll("#comment animate, #comment animateTransform")).toHaveLength(0);
  });

  it("accueil : sur-titre, titre, phrase, deux boutons, méta, infographie, composeur, sections", () => {
    show();
    const h1 = document.querySelector("h1")!;
    expect(title(h1)).toBe("Un lien, un mot de passe, puis ça s'efface.");
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(h1.getAttribute("tabindex")).toBe("-1");
    expect(h1.classList.contains("compact")).toBe(false);
    // Plus de sur-titre. Cadre d'envoi (« Le chiffré ») :
    // « Choisir des fichiers », puis Photo ou vidéo, Vocal, Salon.
    expect(document.querySelector("[data-eyebrow]")).toBeNull();
    expect(document.querySelector("[data-ctas] [data-pick]")).not.toBeNull();
    expect([...document.querySelectorAll("[data-ctas] [data-make]")].map((b) => b.getAttribute("data-make"))).toEqual(["media", "vocal", "room"]);
    expect(document.querySelectorAll("[data-ctas] button")).toHaveLength(4);
    expect(document.querySelector("[data-room]")).toBeNull();
    expect(document.querySelector("[data-more]")).toBeNull();
    // Phrase : les fonctions moins visibles mises en avant.
    const lede = document.querySelector("[data-lede]")!;
    expect(lede.textContent).toMatch(/^Vos fichiers, mais aussi des messages vocaux, des notes et bientôt un salon de discussion\u202f: /);
    expect([...lede.querySelectorAll("b.hl")].map((b) => b.textContent)).toEqual(["messages vocaux", "notes", "salon de discussion"]);
    const pick = document.querySelector<HTMLButtonElement>("[data-pick]")!;
    expect(pick.textContent!.trim()).toBe("Choisir des fichiers");
    expect(pick.querySelector("svg")).not.toBeNull();
    expect(document.querySelector("[data-ctas] .bx-s")!.textContent).toMatch(/^200\séléments · 2\sGo au total$/);
    expect(document.querySelector('[data-make="room"]')!.textContent).toContain("bientôt");
    const meta = [...document.querySelectorAll("[data-meta] li")].map((l) => l.textContent!.trim());
    expect(meta).toEqual(["Gratuit", "Partage sans compte", "Effacement automatique"]);
    expect(document.querySelector("[data-demo]")).not.toBeNull();
    const a = [...document.querySelectorAll("a")].find((x) => x.textContent?.trim() === "Tous les détails de sécurité")!;
    expect(a.getAttribute("href")).toBe("/securite");
    expect([...document.querySelectorAll("a")].some((x) => x.getAttribute("href")?.includes("#"))).toBe(false);
    // Sections sous le pli, chacune titrée.
    const h2 = [...document.querySelectorAll("h2")].map((h) => h.textContent!.trim());
    expect(h2).toEqual([
      "Comment ça marche",
      "La vie d'un lien",
      "Ce qui reste hors de notre portée",
      "Vous n'avez pas à nous croire sur parole.",
      "Offres",
      "Vos questions",
    ]);
    // « Comment ça marche » : l'infographie seule (sept étapes), titrée par le h2 de la section ;
    // plus de frise en quatre étapes qui disait la même chose.
    expect(document.querySelector("[data-how-card]")).toBeNull();
    expect(document.querySelector(".hero [data-demo]")).toBeNull();
    expect(document.querySelector("#comment [data-demo]")!.getAttribute("aria-labelledby")).toBe("how-title");
    const priv = [...document.querySelectorAll("[data-priv-card]")];
    expect(priv).toHaveLength(3);
    expect(priv.map((c) => c.querySelector("h3")!.textContent!.trim())).toEqual(["Aucune identité demandée", "Fichiers nettoyés", "Salon éphémère bientôt"]);
    // Questions : seulement ce qui n'est dit nulle part ailleurs sur la page.
    expect([...document.querySelectorAll("#faq details")].map((d) => d.id)).toEqual(["faq-lost", "faq-copy"]);
    expect(document.getElementById("serveur")!.querySelector("h2")!.id).toBe("priv-title");
    for (const c of [...document.querySelectorAll("[data-priv-card]")]) expect(c.querySelector(".tile-ic svg")).not.toBeNull();

    // Le lien en deux : l'adresse au serveur,
    // la clé après le « # » dans le navigateur ; un exemple, jamais une vraie clé.
    expect(document.querySelector("[data-key-note] figcaption")!.textContent).toMatch(/^La clé du lien est après le «\s#\s»/);
    expect([...document.querySelectorAll("[data-offer]")].map((o) => o.getAttribute("data-offer"))).toEqual(["free", "plus", "pro"]);
    // Prix prévu et sens de chaque chiffre dans les cartes (lus dans PAID).
    const card = (x: string) => document.querySelector(`[data-offer="${x}"]`)!;
    const norm = (s: string | null | undefined) => (s ?? "").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
    expect(norm(card("free").querySelector("[data-price]")!.textContent)).toBe("0 € sans abonnement");
    expect(norm(card("plus").querySelector("[data-price]")!.textContent)).toBe(`${PAID.plus.month} € / mois ou ${PAID.plus.year} € / an`);
    expect([...card("pro").querySelectorAll(".dk")].map((d) => d.textContent)).toEqual(["Taille par partage", "Durée au plus", "Ouvertures au plus", "Appels audio et vidéo"]);
    expect(norm(card("pro").querySelectorAll(".dv")[2]!.textContent)).toBe(String(PAID.pro.opens));
    // Appels : absents de l'offre gratuite, inclus dans Plus et Pro (disponibles et réservés à ces
    // offres : plus de « bientôt »).
    expect(norm(card("free").querySelector("[data-calls] .dv")!.textContent)).toBe("Non inclus");
    for (const x of ["plus", "pro"]) expect(norm(card(x).querySelector("[data-calls] .dv")!.textContent)).toBe("Inclus");
    expect(document.querySelectorAll("details[name=faq]")).toHaveLength(2);
    expect(document.querySelector('[data-slot="compose"]')).toBeNull(); // composeur : page d'envoi seulement
  });

  it("compact (page d'envoi) : plus le slogan de l'accueil, un h1 « Nouveau partage » pour les lecteurs d'écran (« Votre envoi » est le titre visible) ; phrase et schéma retirés", () => {
    show({ compact: true });
    const h1 = document.querySelector("h1")!;
    expect(h1.textContent).toBe("Nouveau partage");
    expect(h1.classList.contains("sr-only")).toBe(true);
    expect(h1.id).toBe("hero-title");
    // Les trois assurances sont dans le cadre de dépôt du composeur (ui/Assurances.svelte).
    expect(document.querySelector("[data-assure]")).toBeNull();
    expect(document.querySelector("[data-demo]")).toBeNull();
    expect(document.querySelector("[data-pick]")).toBeNull();
    expect(document.querySelector("[data-eyebrow]")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
  });

  it("le composeur fourni remplace l'emplacement réservé", () => {
    const children = createRawSnippet(() => ({ render: () => `<div id="composeur">c</div>` }));
    show({ children });
    expect(document.getElementById("composeur")).not.toBeNull();
    expect(document.querySelector('[data-slot="compose"] #composeur')).not.toBeNull();
  });

  it("titre (K1, K8) : phrase entière lisible, copie mot par mot cachée, respiration avant « puis »", () => {
    show();
    const h1 = document.querySelector("h1")!;
    expect(h1.querySelector(".sr-only")!.textContent).toBe("Un lien, un mot de passe, puis ça s'efface.");
    const copy = h1.querySelector('[aria-hidden="true"]')!;
    const words = [...copy.querySelectorAll<HTMLElement>(".w")];
    expect(words.map((w) => w.textContent)).toEqual(["Un", "lien,", "un", "mot", "de", "passe,", "puis", "ça", "s'efface."]);
    // Titre affiché d'emblée dans son état final : aucun délai d'entrée par mot.
    expect(words.map((w) => w.style.getPropertyValue("--d"))).toEqual(words.map(() => ""));
    // « plus rien. » (« La trame » ; « puis » reste plein) : chaque lettre a son rang, qui décale son
    // effacement en trame de points.
    const letters = [...copy.querySelectorAll<HTMLElement>(".l")];
    expect(letters.map((l) => l.textContent).join("")).toBe("ças'efface.");
    // Figé : « p » en trame serrée, « lus » blanc, « rie » menthe, « n. » qui s'envole.
    expect(letters.map((l) => [...l.classList].find((c) => /^s\d$/.test(c)))).toEqual(["s1", "s1", "s2", "s2", "s2", "s3", "s3", "s3", "s4", "s4", "s4"]);
  });

  it("plus d'entrée animée (accueil écrit au build, affiché avant le script)", () => {
    show();
    expect(document.querySelector(".home")!.classList.contains("reveal")).toBe(false);
  });


  it("« Choisir des fichiers » ouvre le sélecteur du composeur (onpick) ; Photo ou vidéo, Vocal, Salon appellent onmake ; plus de carte de dépôt sur l'accueil", () => {
    const onfiles = vi.fn();
    const onmake = vi.fn();
    const onpick = vi.fn();
    show({ onfiles, onmake, onpick });
    // Plus de sélecteur propre à l'accueil : le composeur tient le seul champ fichier.
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    (document.querySelector("[data-pick]") as HTMLButtonElement).click();
    expect(onpick).toHaveBeenCalledTimes(1);
    for (const g of ["media", "vocal", "room"]) (document.querySelector(`[data-make="${g}"]`) as HTMLButtonElement).click();
    expect(onmake.mock.calls).toEqual([["media"], ["vocal"], ["room"]]);
    // Ni « Commencer », ni carte « Glissez vos fichiers ici » : doublons des deux boutons du héros.
    expect([...document.querySelectorAll("button")].some((b) => b.textContent!.trim().startsWith("Commencer"))).toBe(false);
    expect(document.querySelector('[data-slot="compose"]')).toBeNull();
    expect(onfiles).not.toHaveBeenCalled();
  });

  it("dépôt : les fichiers vont à onfiles, les dossiers sont remis à part (refusés, pas aplatis)", async () => {
    const onfiles = vi.fn();
    show({ onfiles });
    const a = new File(["a"], "a.txt");
    const dir = new File([], "Vacances");
    const items = [
      { kind: "file", getAsFile: () => a, webkitGetAsEntry: () => ({ isDirectory: false, name: "a.txt" }) },
      { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true, name: dir.name }) },
    ];
    const e = new Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], items, files: [] } });
    window.dispatchEvent(e as unknown as Event);
    await Promise.resolve();
    expect(e.defaultPrevented).toBe(true);
    expect(onfiles).toHaveBeenCalledWith([a], "depot", ["Vacances"]);
  });

  it("démo (GitHub Pages, hors d'Europe) : jamais « Europe », en français comme en anglais", () => {
    vi.stubEnv("MODE", "demo");
    try {
      show();
      expect(document.body.textContent).not.toMatch(/Europe/);
      if (c) void unmount(c);
      document.body.innerHTML = "";
      setLang("en");
      show();
      expect(document.body.textContent).not.toMatch(/Europe/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("anglais", () => {
    setLang("en");
    show();
    expect(title(document.querySelector("h1")!)).toBe("One link, one password, then it's gone.");
    expect(document.querySelector("#hero-make")!.textContent).toBe("Or create something here");
    expect([...document.querySelectorAll("[data-lede] b.hl")].map((b) => b.textContent)).toEqual(["voice messages", "notes", "chat room"]);
    expect(document.querySelector("[data-pick]")!.textContent!.trim()).toBe("Choose files");
    expect([...document.querySelectorAll("[data-meta] li")].map((l) => l.textContent!.trim())).toEqual(["Free", "Share without an account", "Erased automatically"]);
  });
});

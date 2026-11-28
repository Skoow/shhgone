// @vitest-environment happy-dom
// Nom du partage : champ des options, « Lien prêt »,
// page de contenu du destinataire (dans la page d'ouverture). Texte de l'expéditeur, hostile :
// toujours en texte brut, isolé par <bdi>, jamais dans le titre de l'onglet.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGone } from "../flows/gone.svelte";
import { createOptions, sendTitle, titleTooLong } from "../flows/options.svelte";
import { setLang } from "../i18n/i18n.svelte";
import { TITLE_MAX, generatePassword, type Opened } from "../index";
import Content from "./Content.svelte";
import Options from "./Options.svelte";
import Ready from "./Ready.svelte";

const mounted: Record<string, unknown>[] = [];
function show(C: unknown, props: Record<string, unknown>) {
  const c = mount(C as never, { target: document.body, props }) as Record<string, unknown>;
  mounted.push(c);
  flushSync();
  return c;
}
beforeEach(() => setLang("fr"));
afterEach(() => {
  while (mounted.length) void unmount(mounted.pop()!);
  document.body.innerHTML = "";
  document.title = "";
  vi.restoreAllMocks();
});

// Texte hostile : balises, inversion de sens (déjà retirée par le moteur à la lecture, mais
// l'affichage ne doit pas en dépendre).
const HOSTILE = '<img src=x onerror="alert(1)"> Rapport ‮T4';

describe("options : nom du partage", () => {
  it("vide par défaut ; trop long au-delà de TITLE_MAX points de code après NFC ; blancs seuls : rien n'est passé au moteur", () => {
    const o = createOptions({ generate: generatePassword });
    expect(o.title).toBe("");
    expect(sendTitle(o)).toEqual({});
    o.title = "  \t ";
    expect(sendTitle(o)).toEqual({});
    o.title = " Photos ";
    expect(sendTitle(o)).toEqual({ title: " Photos " }); // nettoyé par le moteur, pas ici
    expect(TITLE_MAX).toBe(80);
    expect(titleTooLong("a".repeat(80))).toBe(false);
    expect(titleTooLong("😀".repeat(80))).toBe(false); // 160 unités UTF-16, 80 points de code
    expect(titleTooLong("a".repeat(81))).toBe(true);
    // U+0344 devient deux points de code en NFC : compté après NFC, comme le moteur.
    expect(titleTooLong("-".repeat(79) + "̈́")).toBe(true);
    o.title = "a".repeat(81);
    expect(o.titleTooLong).toBe(true);
    o.title = 5 as unknown as string;
    expect(o.title).toBe("");
  });

  it("champ en tête des options : libellé, aide, 80 caractères au plus, saisie gardée dans les options", () => {
    const options = createOptions({ generate: generatePassword });
    show(Options, { options, unviewable: [] });
    const block = document.querySelector("[data-share-name]")!;
    expect(block).not.toBeNull();
    // Avant les réglages de durée et d'ouvertures.
    expect(document.querySelector(".opts .block")).toBe(block);
    const input = block.querySelector("input")!;
    expect(block.querySelector("label")!.textContent).toBe("Nom du partage (facultatif)");
    expect(block.textContent).toContain("Vu par le destinataire, chiffré comme le reste.");
    expect(input.getAttribute("maxlength")).toBe("80");
    expect(input.getAttribute("autocomplete")).toBe("off");
    input.value = "Photos du week-end";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(options.title).toBe("Photos du week-end");
    expect(block.querySelector("[role=alert]")).toBeNull();
    // Feuille du téléphone : le même champ.
    while (mounted.length) void unmount(mounted.pop()!);
    show(Options, { options, unviewable: [], compact: true });
    expect(document.querySelector<HTMLInputElement>("[data-share-name] input")!.value).toBe("Photos du week-end");
  });

  it("nom trop long (saisie collée hors du champ) : erreur sous le champ", () => {
    const options = createOptions({ generate: generatePassword });
    options.title = "-".repeat(79) + "̈́";
    show(Options, { options, unviewable: [] });
    expect(document.querySelector("[data-share-name] [role=alert]")!.textContent).toMatch(/^80\scaractères au plus pour le nom du partage\.$/);
  });

  it("résumé de l'ordinateur (part summary) : pas de champ", () => {
    const options = createOptions({ generate: generatePassword });
    show(Options, { options, unviewable: [], part: "summary" });
    expect(document.querySelector("[data-share-name]")).toBeNull();
  });
});

const readyProps = (title?: string) => ({
  result: { link: "https://x.example/s#" + "k".repeat(43), manage: "https://x.example/s#m" + "m".repeat(43), expiresInS: 3600, password: "Abcdef-1234", ...(title === undefined ? {} : { title }) },
  summary: "1 élément",
  ttlHours: 1,
  maxOpens: 1,
  itemsCount: 1,
  sizeBytes: 10,
  ondone: () => undefined,
  onforget: () => undefined,
  onnew: () => undefined,
});

describe("Lien prêt : nom du partage", () => {
  it("sous le titre « Lien prêt » (28 novembre), en texte brut isolé (bdi), jamais dans le titre de l'onglet", () => {
    show(Ready, readyProps(HOSTILE));
    const name = document.querySelector(".hd-tx [data-ready-name]")!;
    expect(name.previousElementSibling!.id).toBe("ready-title");
    const bdi = name.querySelector("bdi")!;
    expect(bdi.textContent).toBe(HOSTILE);
    expect(name.querySelector("img")).toBeNull();
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect(name.textContent).toContain("Nom du partage");
    expect(document.title).not.toContain("Rapport");
  });

  it("sans nom : aucune ligne", () => {
    show(Ready, readyProps());
    expect(document.querySelector("[data-ready-name]")).toBeNull();
    expect(document.querySelector("[data-ready-facts]")!.firstElementChild!.classList.contains("active")).toBe(true);
  });
});

function opened(title?: string): Opened {
  return {
    manifest: { v: 2, rights: "enregistrer", ...(title === undefined ? {} : { title }), items: [{ kind: "text", name: "note", mime: "text/plain", size: 5, offset: 0, text: "Salut" }] },
    safeName: () => "note",
    previewKind: () => "text",
    isRiskyFile: () => false,
    item: async () => new Uint8Array(0),
    saveItem: async () => undefined,
    done: async () => undefined,
    wipe: () => undefined,
    destroy: async () => undefined,
    watch: () => new Promise(() => undefined),
    grant: "",
    opensLeft: 0,
    lastOpen: false,
  } as unknown as Opened;
}
const contentProps = (title?: string) => ({
  opened: opened(title),
  expired: false,
  onend: () => undefined,
  gone: createGone({ finish: () => undefined, revokeAll: () => undefined }),
});

describe("Contenu (page d'ouverture, après le déverrouillage) : nom du partage", () => {
  it("titre de la page, en texte brut isolé (bdi) ; « Contenu » reste dit aux lecteurs d'écran ; pas dans l'onglet", () => {
    show(Content, contentProps(HOSTILE));
    const h1 = document.querySelector("h1")!;
    expect(h1.hasAttribute("data-share-title")).toBe(true);
    expect(h1.querySelector("bdi")!.textContent).toBe(HOSTILE);
    expect(h1.querySelector("img")).toBeNull();
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect(h1.querySelector(".sr-only")!.textContent).toContain("Contenu");
    expect(document.title).not.toContain("Rapport");
  });

  it("sans nom : « Contenu »", () => {
    show(Content, contentProps());
    const h1 = document.querySelector("h1")!;
    expect(h1.textContent!.trim()).toBe("Contenu");
    expect(h1.hasAttribute("data-share-title")).toBe(false);
  });
});

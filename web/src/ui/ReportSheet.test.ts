// @vitest-environment happy-dom
// Signalement avec catégories (conception compte §21.10, §21.15.7) :
// catégorie facultative, « Autre » par défaut).
// Dix catégories dans l'ordre fixe des codes 1 à 10, en boutons radio natifs d'un même groupe
// (flèches du clavier données par le navigateur) ; aucune requête avant « Signaler » ;
// PHAROS en bandeau pour les codes 1 et 2 ; focus sur « Annuler » à l'étape de confirmation.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import ReportSheet from "./ReportSheet.svelte";

const NOMS = [
  "Terrorisme",
  "Abus sexuels sur mineurs",
  "Contenu sexuel non consenti",
  "Violence ou menaces",
  "Haine ou discrimination",
  "Harcèlement",
  "Piratage ou logiciel malveillant",
  "Arnaque",
  "Données personnelles exposées",
  "Autre",
];

let app: Record<string, unknown> | null = null;
async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}
async function ouvrir(props: Record<string, unknown>) {
  app = mount(ReportSheet as never, { target: document.body, props: { open: true, ...props } }) as Record<string, unknown>;
  await settle();
}
const dlg = () => document.querySelector("dialog")!;
const texte = () => dlg().textContent!.replace(/\s+/g, " ");
const radios = () => [...dlg().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
function bouton(nom: string): HTMLButtonElement {
  const b = [...dlg().querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") ?? x.textContent!.trim()) === nom);
  if (!b) throw new Error(`bouton « ${nom} » absent : ${[...dlg().querySelectorAll("button")].map((x) => x.textContent!.trim()).join(" | ")}`);
  return b as HTMLButtonElement;
}
async function presser(nom: string) {
  bouton(nom).click();
  await settle();
}
function choisir(n: number) {
  radios()[n - 1]!.click();
  flushSync();
}

beforeEach(() => {
  setLang("fr");
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
});
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
});

describe("ReportSheet", () => {
  it("étape 1 : « Que se passe-t-il ? », dix catégories dans l'ordre, avec leur aide ; un seul groupe radio ; « Autre » choisi par défaut", async () => {
    await ouvrir({ sorte: "partage", onconfirm: vi.fn() });
    expect(texte()).toContain("Que se passe-t-il ?");
    const r = radios();
    expect(r).toHaveLength(10);
    expect(r.map((x) => x.labels![0]!.querySelector("[data-nom]")!.textContent!.trim())).toEqual(NOMS);
    expect(new Set(r.map((x) => x.name)).size).toBe(1); // même nom : les flèches passent d'une catégorie à l'autre
    expect(dlg().querySelector('[role="radiogroup"]')!.getAttribute("aria-labelledby")).toBeTruthy();
    expect(r.map((x) => x.value)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(r.find((x) => x.checked)!.value).toBe("10");
    expect(texte()).toContain("Apologie, menaces ou propagande terroriste");
    expect(texte()).toContain("Adresse, documents d'identité, photos privées d'un tiers");
    // Aucun texte libre, aucune pièce, aucune adresse.
    expect(dlg().querySelectorAll("textarea, input:not([type=radio]), select")).toHaveLength(0);
    expect(bouton("Continuer").getAttribute("aria-disabled")).not.toBe("true");
  });

  it("aucune requête avant « Signaler » ; la catégorie choisie part ; « Annuler » a le focus à l'étape 2", async () => {
    const onconfirm = vi.fn(async () => null);
    await ouvrir({ sorte: "partage", onconfirm });
    choisir(6);
    await presser("Continuer");
    expect(onconfirm).not.toHaveBeenCalled();
    expect(texte()).toContain("Harcèlement");
    expect(texte()).toContain("Chaque personne qui a ouvert ce partage compte pour une voix. Il est supprimé pour tout le monde quand la moitié des ouvertures permises l'ont signalé. Nous ne voyons pas le contenu et ne gardons que la catégorie, sans rien qui vous identifie.");
    expect(document.activeElement).toBe(bouton("Annuler"));
    await presser("Signaler");
    expect(onconfirm).toHaveBeenCalledExactlyOnceWith(6);
  });

  it("catégorie facultative : « Continuer » sans choisir envoie « Autre » (10)", async () => {
    const onconfirm = vi.fn(async () => null);
    await ouvrir({ sorte: "partage", onconfirm });
    await presser("Continuer");
    await presser("Signaler");
    expect(onconfirm).toHaveBeenCalledExactlyOnceWith(10);
  });

  it("PHAROS : bandeau pour les codes 1 et 2 seulement (deux liens, noopener noreferrer) ; phrase des autorités gardée pour les autres", async () => {
    const onconfirm = vi.fn(async () => null);
    await ouvrir({ sorte: "partage", onconfirm });
    for (const n of [1, 2, 3, 6, 10]) {
      choisir(n);
      await presser("Continuer");
      const banner = dlg().querySelector(".banner.warn");
      if (n <= 2) {
        expect(banner, `catégorie ${n}`).not.toBeNull();
        expect(banner!.textContent!.replace(/\s+/g, " ")).toContain("Vous pouvez aussi le signaler aux autorités : PHAROS, internet-signalement.gouv.fr. Plus de détails sur la page Signaler un abus.");
        const liens = [...banner!.querySelectorAll("a")];
        expect(liens.map((a) => a.getAttribute("href"))).toEqual(["https://www.internet-signalement.gouv.fr/", "/signaler"]);
        for (const a of liens) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      } else {
        expect(banner, `catégorie ${n}`).toBeNull();
        expect(texte()).toContain("Pour un contenu illégal, vous pouvez aussi le signaler aux autorités (en France : PHAROS, internet-signalement.gouv.fr).");
      }
      await presser("Modifier");
      expect(radios().find((x) => x.checked)!.value).toBe(String(n)); // le choix est gardé
    }
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it("salon : « Quitter et signaler » et son texte", async () => {
    const onconfirm = vi.fn(async () => null);
    await ouvrir({ sorte: "salon", onconfirm });
    choisir(8);
    await presser("Continuer");
    expect(texte()).toContain("Vous quitterez le salon. Nous ne voyons pas les messages ; nous comptons ce signalement pour ce salon, sans rien qui vous identifie.");
    await presser("Quitter et signaler");
    expect(onconfirm).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("échec : message affiché, la feuille reste ouverte", async () => {
    const onconfirm = vi.fn(async () => "Connexion impossible : le partage n'a pas été détruit.");
    await ouvrir({ sorte: "partage", onconfirm });
    choisir(4);
    await presser("Continuer");
    await presser("Signaler");
    expect(dlg().querySelector("[role=alert]")!.textContent).toContain("Connexion impossible");
    expect(dlg().open).toBe(true);
  });
});

// @vitest-environment happy-dom
// Pseudo du compte (conception compte §21.5, §21.15.2 ; liste de règles du 28 novembre) : règles
// cochées pendant la frappe, sans requête ; vérification 400 ms après la dernière frappe, seulement
// quand les règles sont tenues ; « Disponible » ou « Déjà pris » (erreur reliée au champ) ; petit
// carré dans le champ (vide, rond, coche, croix) ; une réponse en retard (frappe suivante) est ignorée.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/i18n.svelte";
import PseudoField from "./PseudoField.svelte";

let c: Record<string, unknown> | undefined;
beforeEach(() => {
  setLang("fr");
  vi.useFakeTimers();
});
afterEach(() => {
  if (c) void unmount(c);
  c = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});
function show(verifier: (p: string) => Promise<string>) {
  const v = vi.fn(verifier);
  c = mount(PseudoField as never, { target: document.body, props: { verifier: v } }) as Record<string, unknown>;
  flushSync();
  return { input: document.querySelector("input")!, v };
}
const type = (i: HTMLInputElement, s: string) => {
  i.value = s;
  i.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
};
const settle = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  flushSync();
};
const status = () => document.querySelector("[data-pseudo-status]")?.textContent?.trim() ?? "";
const carre = () => document.querySelector("[data-field-status]")!.getAttribute("data-field-status");
const regle = (id: string) => document.querySelector(`[data-regle=${id}]`)!.getAttribute("data-etat");

describe("PseudoField", () => {
  it("vide : règles affichées, rien coché ni barré, carré vide ; plus de paragraphe d'aide", () => {
    const { input } = show(async () => "libre");
    expect(document.querySelector("label")!.textContent).toBe("Pseudo");
    expect(carre()).toBe("vide");
    expect([regle("caracteres"), regle("longueur"), regle("disponible")]).toEqual(["neutre", "neutre", "neutre"]);
    const regles = [...document.querySelectorAll("[data-pseudo-regles] li")].map((l) => l.textContent!.replace(/\s+/g, " ").trim());
    expect(regles[0]).toContain("Lettres sans accent et chiffres seulement (A-Z, 0-9)");
    expect(regles[1]).toContain("De 2 à 24 caractères");
    expect(regles[2]).toContain("Disponible");
    expect(regles[3]).toBe("Vu par les membres de vos salons. 3 changements par an au plus.");
    expect(document.body.textContent).not.toContain("Lettres et chiffres sans accent (A-Z, 0-9). Vu par");
    // Les règles décrivent le champ.
    expect(input.getAttribute("aria-describedby")).toContain(document.querySelector("[data-pseudo-regles]")!.id);
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
  it("frappe : règles cochées ou barrées tout de suite, état dit en texte ; aucune requête tant qu'elles ne sont pas tenues", async () => {
    const { input, v } = show(async () => "libre");
    type(input, "L");
    expect([regle("caracteres"), regle("longueur")]).toEqual(["ok", "ko"]);
    expect(document.querySelector("[data-regle=longueur]")!.textContent).toContain("non respectée");
    expect(carre()).toBe("ko");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    type(input, "Lé");
    expect([regle("caracteres"), regle("longueur")]).toEqual(["ko", "ok"]);
    await settle(1000);
    expect(v).not.toHaveBeenCalled();
  });
  it("vérification 400 ms après la dernière frappe, une seule fois ; rond puis coche verte, « Disponible »", async () => {
    const { input, v } = show(async () => "libre");
    type(input, "Le");
    await settle(200);
    type(input, "Lea");
    expect(carre()).toBe("verif");
    expect(regle("disponible")).toBe("verif");
    await settle(399);
    expect(v).not.toHaveBeenCalled();
    await settle(1);
    expect(v).toHaveBeenCalledTimes(1);
    expect(v).toHaveBeenCalledWith("Lea");
    expect(status()).toBe("Disponible");
    expect(carre()).toBe("ok");
    expect([regle("caracteres"), regle("longueur"), regle("disponible")]).toEqual(["ok", "ok", "ok"]);
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
  it("« Déjà pris » : croix, erreur reliée au champ", async () => {
    const { input } = show(async () => "pris");
    type(input, "Lea");
    await settle(400);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(carre()).toBe("ko");
    expect(regle("disponible")).toBe("ko");
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids.map((id) => document.getElementById(id)!.textContent).join(" ")).toContain("Déjà pris");
  });
  it("refus du moteur : messages exacts (§39.4)", async () => {
    for (const [code, msg] of [["pseudo_ecritures", "Une seule écriture à la fois."], ["pseudo_reserve", "Ce pseudo est réservé."]]) {
      const { input } = show(async () => code!);
      type(input, "Admin");
      await settle(400);
      expect(input.getAttribute("aria-invalid"), code).toBe("true");
      expect(document.body.textContent, code).toContain(msg);
      void unmount(c!);
      c = undefined;
      document.body.innerHTML = "";
    }
  });
  it("« plus tard » (aucune étape encore) : rien n'est affirmé", async () => {
    const { input } = show(async () => "plus_tard");
    type(input, "Lea");
    await settle(400);
    expect(status()).toBe("La disponibilité sera vérifiée à l'étape suivante.");
    expect(regle("disponible")).toBe("neutre");
    expect(carre()).toBe("attente");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
  it("réponse en retard d'une frappe précédente : ignorée", async () => {
    let first!: (v: string) => void;
    let n = 0;
    const { input } = show((p) => (n++ === 0 ? new Promise<string>((r) => (first = r)) : Promise.resolve(p === "Leo" ? "libre" : "pris")));
    type(input, "Lea");
    await settle(400);
    type(input, "Leo");
    await settle(400);
    expect(status()).toBe("Disponible");
    first("pris");
    await settle(0);
    expect(status()).toBe("Disponible");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("pseudo avec accents (essais du 28 novembre)", () => {
  it("« Léa » : « Utiliser « Lea » » proposé ; un geste le pose et le vérifie", async () => {
    const { input, v } = show(async () => "libre");
    type(input, "Léa");
    const b = document.querySelector<HTMLButtonElement>("[data-sans-accent]")!;
    expect(b.textContent).toBe("Utiliser « Lea » (sans accent)");
    b.click();
    flushSync();
    expect(input.value).toBe("Lea");
    await settle(400);
    expect(v).toHaveBeenCalledWith("Lea");
    expect(document.querySelector("[data-sans-accent]")).toBeNull();
    // Un caractère qui n'a pas d'équivalent sans accent : rien de proposé.
    type(input, "Lea_!");
    expect(document.querySelector("[data-sans-accent]")).toBeNull();
  });
});

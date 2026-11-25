// Aides des tests des pages du compte : montage, saisie, boutons, attente. Le module de compte
// et la preuve anti-robot sont remplacés par des doubles dans chaque test (vi.mock).
import { flushSync, mount, unmount } from "svelte";

let app: Record<string, unknown> | null = null;
export async function monter(C: unknown, props: Record<string, unknown> = {}): Promise<void> {
  app = mount(C as never, { target: document.body, props }) as Record<string, unknown>;
  await attendre();
}
export function demonter(): void {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
}
export async function attendre(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync();
}
export function champ(label: string): HTMLInputElement {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent!.trim() === label);
  if (!l) throw new Error(`champ « ${label} » absent`);
  return document.getElementById(l.htmlFor)! as HTMLInputElement;
}
export function saisir(label: string, v: string): void {
  const i = champ(label);
  i.value = v;
  i.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}
export function cocher(label: string): void {
  champ(label).click();
  flushSync();
}
export function bouton(nom: string): HTMLButtonElement {
  const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") ?? x.textContent!.trim()) === nom);
  if (!b) throw new Error(`bouton « ${nom} » absent : ${[...document.querySelectorAll("button")].map((x) => x.textContent!.trim()).join(" | ")}`);
  return b as HTMLButtonElement;
}
export async function presser(nom: string): Promise<void> {
  bouton(nom).click();
  await attendre();
}
/** Message d'erreur relié au champ (aria-describedby). */
export function erreurDe(label: string): string {
  const i = champ(label);
  if (i.getAttribute("aria-invalid") !== "true") return "";
  return (i.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id))
    .filter((e) => e?.classList.contains("err"))
    .map((e) => e!.textContent!.trim())
    .join(" ");
}
export const PREUVE = { altcha: "preuve", hp: "", shown_at: "t" };

/** « Je l'ai notée » (CleRecup) : copie d'abord la clé si le bouton attend encore (grisé). */
export async function noterCle(): Promise<void> {
  if (bouton("Je l'ai notée").getAttribute("aria-disabled") === "true") await presser("Copier");
  await presser("Je l'ai notée");
}

/**
 * Sorte d'appareil vue par estMobile (account/device.ts) : pointeur grossier pour un téléphone,
 * fin pour un ordinateur (décision du 25 novembre, conception du compte §18). Avant monter().
 */
export function appareil(sorte: "telephone" | "ordinateur"): void {
  const coarse = sorte === "telephone";
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: q === "(pointer: coarse)" ? coarse : false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
}

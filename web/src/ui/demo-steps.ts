import type { Key } from "../i18n/i18n.svelte";
// Infographie de l'accueil (SecureDemo.svelte, refonte du 12 novembre) : rythme et étapes.
/** Durée la plus longue d'une étape (borne des tests et des attentes). */
export const STEP_MS = 5500;
/** Durée la plus courte d'une étape. */
export const STEP_MIN_MS = 2500;
/**
 * Durée d'une étape selon la quantité de texte affichée sous la scène (titre et description ;
 * propriétaire, 20 novembre : « adapter la vitesse à la quantité de texte », puis « 9 s trop
 * long ») : 1 s, plus 30 ms par caractère (environ 33 caractères par seconde), comptés à partir du
 * moment où la description s'affiche (descA, en lettres : reperesEtape), entre 2,5 et 5,5 s ;
 * au moins la frappe du journal de l'étape (lettres) plus 1 s, pour lire la ligne finie.
 */
export function dureeEtape(texte: string, lettres = 0, descA = 0): number {
  return Math.min(STEP_MS, Math.max(STEP_MIN_MS, descA * TYPE_MS + 1000 + [...texte].length * 30, lettres * TYPE_MS + 1000));
}
/**
 * Repères de l'étape n, en lettres tapées depuis son début (synchronisation du 24 novembre : la
 * scène, le journal et le cadre du dessous suivent la même horloge) :
 * - late : début de la ligne de l'attaquant (il apparaît dans la scène à ce moment), ou null ;
 * - desc : début de l'état de la dernière ligne (« ✓ … » ou « ✕ … ») : la description de l'étape
 *   s'affiche alors dans le cadre du dessous, et les étiquettes « ✕ » de la scène avec elle.
 * La durée de lecture de la description (dureeEtape, troisième argument) part de desc.
 */
export function reperesEtape(n: number, t: (k: Key) => string): { late: number | null; desc: number } {
  let k = 0;
  let late: number | null = null;
  let desc = 0;
  for (const l of LOG) {
    if (l.n !== n) continue;
    if (l.late) {
      k += PAUSE;
      late = k;
    }
    k += [...t(l.text)].length;
    desc = k;
    k += [...`✓ ${t(l.st)}`].length;
  }
  return { late, desc };
}
/** Lettres tapées dans le journal pendant l'étape n (texte et état de ses lignes, pause comprise). */
export function lettresEtape(n: number, t: (k: Key) => string): number {
  let k = 0;
  for (const l of LOG) {
    if (l.n !== n) continue;
    if (l.late) k += PAUSE;
    k += [...t(l.text)].length + [...`✓ ${t(l.st)}`].length;
  }
  return k;
}
/** Frappe du journal : une lettre toutes les 35 ms (18 novembre). */
export const TYPE_MS = 35;
/** Pause avant la ligne de l'attaquant, en lettres (8 × 35 ms ≈ 0,3 s). */
export const PAUSE = 8;
/** Lignes du journal tapé (SecureDemo.svelte) : étape, texte, état et ton. */
export type Line = { n: number; text: Key; st: Key; tone: "ok" | "atk" | "end"; late?: boolean };
export const LOG: readonly Line[] = [
  { n: 1, text: "demo.log.drop", st: "demo.st.ready", tone: "ok" },
  { n: 2, text: "demo.log.seal", st: "demo.st.ok", tone: "ok" },
  { n: 3, text: "demo.log.send", st: "demo.st.ok", tone: "ok" },
  { n: 3, text: "demo.log.intercept", st: "demo.unreadable", tone: "atk", late: true },
  { n: 4, text: "demo.log.server", st: "demo.unreadable", tone: "ok" },
  { n: 4, text: "demo.log.search", st: "demo.st.nothing", tone: "atk", late: true },
  { n: 5, text: "demo.log.link", st: "demo.st.ok", tone: "ok" },
  { n: 6, text: "demo.log.open", st: "demo.st.ok", tone: "ok" },
  { n: 7, text: "demo.log.erase", st: "demo.st.done", tone: "end" },
];
/** Étapes, dans l'ordre (textes demo.sN.t et demo.sN.d). */
export const STEPS = [1, 2, 3, 4, 5, 6, 7] as const;

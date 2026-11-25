// Son de nouveau message et mode silencieux (spec v3 §14.4). Son original synthétisé
// dans l'appareil (Web Audio : oscillateur en balayage descendant, enveloppe courte, environ
// 150 ms, volume modéré) : aucun fichier son, aucune ressource tierce, aucun son existant repris.

/** « Toujours » silencieux (pas d'échéance). */
export const SILENCE_TOUJOURS = -1;
/** Au plus un son toutes les 2 s. */
export const SON_INTERVALLE_MS = 2000;

/**
 * Faut-il jouer le son pour `n` nouveaux messages d'autres participants ? Jamais en silencieux
 * (jusqu'à l'échéance, ou toujours), jamais si la conversation est affichée, au premier plan et
 * déjà en bas (le message se voit), au plus un son toutes les 2 s.
 */
export function doitSonner(o: { n: number; silence: number; maintenant: number; dernier: number; visible: boolean; enBas: boolean }): boolean {
  if (o.n <= 0) return false;
  if (o.silence === SILENCE_TOUJOURS || o.silence > o.maintenant) return false;
  if (o.visible && o.enBas) return false;
  return o.maintenant - o.dernier >= SON_INTERVALLE_MS;
}

/** Échéance du silence choisi : « toujours », 1 h ou 8 h. */
export function finSilence(choix: "toujours" | 1 | 8, maintenant: number): number {
  return choix === "toujours" ? SILENCE_TOUJOURS : maintenant + choix * 3_600_000;
}

let ctx: AudioContext | null = null;

/** Joue le son ; sans effet si Web Audio manque ou si le navigateur l'empêche (sans geste). */
export function jouer(): void {
  try {
    const AC = globalThis.AudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1800, t0);
    osc.frequency.exponentialRampToValueAtTime(220, t0 + 0.15);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.16);
  } catch {
    // Pas de son : rien d'autre à faire.
  }
}

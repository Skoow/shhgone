<script lang="ts">
  // Capsule de scellement (UI §7.3, §20.4 ; direction « La trame ») :
  // verre statique, encoche au milieu du bord haut, trait qui part de l'encoche et suit les
  // octets envoyés, noms brouillés en proportion (couche aria-hidden, vrais noms en liste
  // masquée, K9), trame de points (Trame.svelte) qui suit les mêmes octets, pourcentage.
  // Pas de pourcentage avant l'envoi (rien n'est encore mesuré). La lumière fait le tour du
  // trait à la finalisation (begin(), D2) sans rien dire de « prêt » ; le cadenas ne se ferme et
  // le mot n'apparaît qu'en mode « sealed », c'est-à-dire après la résolution de createShare.
  import { midSplitName } from "./midname";
  import type { Category } from "../flows/kinds";
  import { scramble } from "./decor";
  import { File, FileArchive, FileText, Film, Image, Music, Type } from "./Icon";
  import { capPath, reducedMotion } from "./motion";
  import Trame from "./Trame.svelte";
  import "./seal.css";

  type Mode = "spin" | "progress" | "paused" | "offline" | "final" | "sealed" | "error" | "cancelled";
  type Props = {
    mode: Mode;
    /** Part des octets envoyés (0 à 1). */
    progress: number;
    /** Pourcentage affiché (entier inférieur, jamais 100 avant le dernier octet). */
    percent: number;
    summary: string;
    names: { name: string; category: Category }[];
    /** « En image, ce que le serveur reçoit » : montrée seulement quand aucun nom n'est lisible. */
    caption?: string;
    more: string;
    sealedLabel: string;
  };
  let { mode, progress, percent, summary, names, more, sealedLabel, caption }: Props = $props();
  const split = (name: string, i: number) => midSplitName(scramble(name, kOf(i), 7 + i * 31));

  const ICONS: Record<Category, typeof File> = { texte: Type, photos: Image, videos: Film, audio: Music, documents: FileText, archives: FileArchive, autres: File };

  let w = $state(0);
  let h = $state(0);
  const d = $derived(w > 0 && h > 0 ? capPath(w - 2, h - 2, 31) : "");

  // Progression dessinée une fois par image au plus (UI §7.6), quel que soit le rythme de onBytes.
  let drawn = $state(0);
  let frame = 0;
  $effect(() => {
    const target = progress;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => (drawn = target));
    return () => cancelAnimationFrame(frame);
  });
  const p = $derived(mode === "sealed" || mode === "final" ? 1 : Math.min(1, Math.max(0, drawn)));
  const kOf = (i: number) => Math.min(1, Math.max(0, p * 1.35 - i * 0.08));
  const allScrambled = $derived(names.every((_, i) => kOf(i) >= 1));
  const lightRuns = $derived(mode === "final" || mode === "sealed");

  let root: HTMLDivElement | undefined = $state();
  let running: Animation[] = [];

  function skip() {
    for (const a of running) a.finish();
  }

  /** Joue des pistes (fill « both » : l'état final reste affiché) ; un appui ou une touche les termine. */
  async function run(tracks: [Element | null | undefined, Keyframe[], KeyframeAnimationOptions][]): Promise<void> {
    const anims = tracks.filter(([el]) => el).map(([el, k, o]) => el!.animate(k, { fill: "both", ...o }));
    running.push(...anims);
    const opts = { capture: true, passive: true } as const;
    addEventListener("pointerdown", skip, opts);
    addEventListener("keydown", skip, opts);
    try {
      await Promise.allSettled(anims.map((a) => a.finished));
    } finally {
      removeEventListener("pointerdown", skip, opts);
      removeEventListener("keydown", skip, opts);
    }
  }
  const animates = () => !!root && !reducedMotion() && typeof root.animate === "function";

  /**
   * Fermeture, première partie (640 ms, K3), jouée PENDANT la finalisation :
   * une lumière fait le tour du trait, qui s'épaissit. Rien
   * n'y dit « prêt » : cadenas ouvert, aucun mot. Un échec l'arrête (`stop`).
   */
  let playing: Promise<void> | undefined;
  function play(): Promise<void> {
    if (!animates()) return Promise.resolve();
    const q = (s: string) => root!.querySelector<Element>(s);
    return run([
      [q(".flash"), [{ strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: -100, opacity: 0 }], { duration: 640, easing: "cubic-bezier(0.65, 0, 0.35, 1)" }],
      [q(".bar"), [{ strokeWidth: 2 }, { strokeWidth: 3 }], { duration: 640, easing: "ease-out" }],
    ]);
  }

  /** Début de la fermeture, pendant la finalisation (une seule fois). */
  export function begin(): void {
    playing ??= play();
  }

  /** Finalisation en échec : fermeture arrêtée, capsule rendue telle qu'avant. */
  export function stop(): void {
    for (const a of running) a.cancel();
    running = [];
    playing = undefined;
  }

  /**
   * Fin de la fermeture, une fois le serveur d'accord (mode « sealed ») : fin du tour de lumière
   * s'il dure encore, puis l'anse du cadenas tombe et le mot monte (280 ms). Rend la main ensuite.
   */
  export async function close(): Promise<void> {
    begin();
    await playing;
    if (!animates()) return;
    const q = (s: string) => root!.querySelector<Element>(s);
    await run([
      [q(".shackle"), [{ transform: "translateY(-4.5px)" }, { transform: "translateY(0.5px)", offset: 0.75 }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(0.3, 0, 0.2, 1)" }],
      [q(".lockbox"), [{ boxShadow: "0 0 0 0 rgb(95 227 181 / 0.5)" }, { boxShadow: "0 0 0 12px rgb(95 227 181 / 0)" }], { duration: 320, delay: 120, easing: "ease-out", fill: "none" }],
      [q(".sealed-word"), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 280, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }],
    ]);
  }
</script>

<div bind:this={root} class={["capsule", mode]} style:--p={p} bind:clientWidth={w} bind:clientHeight={h} data-capsule>
  <div class="head">
    <span class="lockbox" aria-hidden="true">
      <svg class="lock" viewBox="0 0 24 24" width="20" height="20" focusable="false">
        <path class="shackle" d="M7.5 11V7.5a4.5 4.5 0 0 1 9 0V11" />
        <rect class="body" x="4" y="11" width="16" height="10" rx="2.5" />
        <path class="hole" d="M12 15v2" />
      </svg>
    </span>
    <span class="summary num">{summary}</span>
  </div>

  <ul class="names" aria-hidden="true">
    {#each names as n, i (i)}
      {@const Ic = ICONS[n.category]}
      <li style:--k={kOf(i)}>
        <Ic size={18} strokeWidth={1.75} />
        <span class="nm" translate="no"><span class="h">{split(n.name, i).head}</span><span class="tl">{split(n.name, i).tail}</span></span>
      </li>
    {/each}
    {#if more}<li class="more">{more}</li>{/if}
  </ul>
  <ul class="sr-only">
    {#each names as n, i (i)}<li translate="no">{n.name}</li>{/each}
    {#if more}<li>{more}</li>{/if}
  </ul>

  <Trame {mode} {progress} />

  <div class="foot">
    {#if caption && allScrambled}<p class="veil-cap">{caption}</p>{/if}
    <div class="figure num" aria-hidden="true">
      {#if mode === "sealed"}
        <span class="sealed-word">{sealedLabel}</span>
      {:else if mode !== "spin"}
        {percent}<span class="pct">%</span>
      {/if}
    </div>
  </div>

  <svg class="line" aria-hidden="true" focusable="false">
    {#if d}
      <g transform="translate(1 1)">
        <path class="track" {d} pathLength="100" />
        <path class="bar" {d} pathLength="100" style:stroke-dasharray={mode === "spin" ? null : `${p * 100} 100`} />
        {#if lightRuns}<path class="flash" {d} pathLength="100" />{/if}
      </g>
    {/if}
  </svg>
  <span class="notch" aria-hidden="true"></span>
</div>

<style>
  .capsule {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    gap: var(--sp-4);
    min-height: 320px;
    padding: var(--sp-5);
    border-radius: var(--r-2xl);
    background: var(--vessel);
    box-shadow: var(--e-vessel), var(--edge-hi);
    view-transition-name: capsule;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
  }
  .lockbox {
    flex: none;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 1px solid var(--hair-2);
    border-radius: var(--r-md);
    color: var(--accent);
  }
  .lock {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
    overflow: visible;
  }
  /* Anse levée : cadenas ouvert tant que le serveur n'a pas confirmé. */
  .shackle {
    transform: translateY(-4.5px);
  }
  .sealed .shackle {
    transform: none;
  }
  .sealed .lockbox {
    border-color: var(--accent);
    background: var(--accent-tint);
  }
  .paused .lockbox,
  .cancelled .lockbox {
    color: var(--text-3);
  }
  .offline .lockbox {
    color: var(--warn);
  }
  .error .lockbox {
    color: var(--danger);
  }
  .summary {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    /* Le résumé ne se coupe jamais au milieu (« 8 éléments · / 61 Ko »). */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .names {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    align-content: start;
    gap: var(--sp-2);
    min-width: 0;
  }
  .names li {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    color: var(--text-2);
  }
  /* Brouillage sans flou (lisibilité) : les lettres changent, la ligne pâlit un peu. */
  .names .nm {
    display: flex;
    min-width: 0;
    white-space: nowrap;
    opacity: calc(1 - var(--k) * 0.3);
  }
  .names .h {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .names .tl {
    flex: none;
    white-space: pre;
  }
  .names .more {
    padding-left: calc(18px + var(--sp-3));
    font-size: var(--fs-small);
  }
  .foot {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--sp-4);
    min-width: 0;
    /* Hauteur du chiffre réservée : rien ne saute quand le pourcentage apparaît. */
    min-height: calc(var(--fs-figure) * var(--lh-figure));
  }
  /* Posée sous la trame, jamais sur des noms lisibles (scan UX, envoi). */
  .veil-cap {
    max-width: 60%;
    margin: 0;
    font-size: var(--fs-small);
    color: var(--text-2);
  }
  .figure {
    margin-left: auto;
    font-size: var(--fs-figure);
    line-height: var(--lh-figure);
    font-weight: var(--fw-figure);
    font-stretch: var(--wd-figure);
    letter-spacing: var(--ls-figure);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .paused .figure,
  .cancelled .figure {
    color: var(--text-2);
  }
  .pct {
    margin-left: 2px;
    font-size: 0.36em;
    vertical-align: top;
    color: var(--text-2);
  }
  .sealed-word {
    display: inline-block;
    font-size: 0.6em;
    color: var(--accent);
  }
  .line {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    fill: none;
  }
  .track {
    stroke: var(--hair-2);
    stroke-width: 1;
  }
  .bar {
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    transition:
      stroke var(--dur-fast) var(--ease-out),
      stroke-dasharray var(--dur-base) var(--ease-out);
  }
  .spin .bar {
    stroke-dasharray: 8 92;
    animation: seal-spin 1.6s linear infinite;
  }
  .paused .bar,
  .cancelled .bar {
    stroke: var(--text-3);
  }
  .offline .bar {
    stroke: var(--warn);
    animation: seal-pulse 1.6s ease-in-out infinite;
  }
  .error .bar {
    stroke: var(--danger);
  }
  .sealed .bar {
    stroke-width: 3;
  }
  .flash {
    stroke: var(--seal-light);
    stroke-width: 3;
    stroke-linecap: round;
    stroke-dasharray: 14 86;
    stroke-dashoffset: -100;
    opacity: 0;
  }
  .notch {
    position: absolute;
    top: -1px;
    left: calc(50% - 1px);
    width: 2px;
    height: 10px;
    background: var(--line-strong);
  }
  .sealed .notch {
    background: var(--accent);
  }
  @media (max-width: 559px) {
    .capsule {
      min-height: 280px;
      gap: var(--sp-3);
      padding: var(--sp-4);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar {
      transition: none;
    }
    .spin .bar,
    .offline .bar {
      animation: none;
    }
  }
  @media (forced-colors: active) {
    .track {
      stroke: GrayText;
    }
    .bar {
      stroke: Highlight;
      stroke-width: 4;
    }
  }
</style>

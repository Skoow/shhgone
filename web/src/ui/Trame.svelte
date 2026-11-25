<script lang="ts">
  // Trame de l'envoi : bande de points dessinée sur un <canvas>, dans la
  // direction « La trame » de l'accueil. Colonnes encore sur l'appareil : points pâles ; rampe
  // derrière le front : points menthe qui se brouillent (chaque bloc est chiffré juste avant
  // d'être envoyé) ; colonnes envoyées : trame menthe qui coule vers la droite tant que des
  // octets passent vraiment. La part allumée suit `progress` (octets confirmés), jamais au-delà
  // (ui/trame.ts, testé) ; avant l'envoi, une vague traverse la bande sans rien allumer.
  // Coût par image : quelques centaines de cercles, aucun calcul lourd ; la boucle s'arrête dès
  // que rien ne bouge (pause, erreur, prêt) et n'existe pas en mouvement réduit (dessin figé à
  // chaque changement). Purement décoratif : aria-hidden, masqué en couleurs forcées.
  import { reducedMotion } from "./motion";
  import { DOT, GAP, activity, approach, front, grid, lit, seeds, type Grid } from "./trame";

  type Mode = "spin" | "progress" | "paused" | "offline" | "final" | "sealed" | "error" | "cancelled";
  type Props = { mode: Mode; progress: number };
  let { mode, progress }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let w = $state(0);
  let h = $state(0);

  // État du dessin, hors réactivité : seule la boucle le lit et l'écrit.
  let ctx: CanvasRenderingContext2D | null = null;
  let g: Grid = { cols: 0, rows: 0, ox: 0, oy: 0 };
  let seed: Float32Array = new Float32Array(0);
  let col = { dot: "#E9ECF2", accent: "#5FE3B5", warn: "#F2C46D", danger: "#FF8A80", mute: "#8A93A4" };
  let cur: Mode = "spin";
  let target = 0;
  let shown = 0;
  let act = 0;
  let movedAt = -Infinity;
  let last = 0;
  let raf = 0;

  const TAU = Math.PI * 2;
  // Modes qui bougent sans octets : attente (clés, vérification), confirmation du serveur, coupure.
  const live = (m: Mode) => m === "spin" || m === "final" || m === "offline";

  $effect(() => {
    if (!canvas || w <= 0 || h <= 0) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    g = grid(w, h);
    if (seed.length !== g.cols * g.rows) seed = seeds(g.cols * g.rows);
    const css = getComputedStyle(canvas);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    col = { dot: v("--text", col.dot), accent: v("--accent", col.accent), warn: v("--warn", col.warn), danger: v("--danger", col.danger), mute: v("--text-3", col.mute) };
    kick();
  });

  $effect(() => {
    const p = mode === "final" || mode === "sealed" ? 1 : Math.min(1, Math.max(0, progress || 0));
    if (p > target) movedAt = performance.now();
    target = p;
    cur = mode;
    kick();
  });

  $effect(() => () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  });

  function kick() {
    if (!raf && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    const dt = last ? Math.min(100, now - last) : 16;
    last = now;
    const still = reducedMotion();
    const moving = cur === "progress" && now - movedAt < 450;
    shown = still ? target : approach(shown, target, dt);
    act = still ? 0 : activity(act, moving, dt);
    draw(still ? 0 : now, still);
    // Envoi : la boucle vit tant que des octets passent (ou que la trame les rattrape), puis se fige.
    if (!still && (live(cur) || moving || shown < target || act > 0.01)) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function draw(t: number, still: boolean) {
    const c = ctx;
    if (!c) return;
    c.clearRect(0, 0, w, h);
    const { cols, rows, ox, oy } = g;
    const m = cur;
    const f = front(shown, cols);
    // Vague d'attente (clés, vérification) : traverse la bande en 2,4 s sans rien allumer.
    const wave = ((t / 2400) % 1) * (cols + 16) - 8;
    let painted = "";
    for (let i = 0; i < cols; i++) {
      const L = m === "spin" ? 0 : lit(i, f);
      const x0 = ox + i * GAP;
      for (let r = 0; r < rows; r++) {
        const s = seed[r * cols + i] ?? 0;
        let x = x0;
        let y = oy + r * GAP;
        let rad = DOT;
        let a: number;
        let fill = col.accent;
        if (m === "spin") {
          const d = i - wave;
          a = 0.11 + (still ? 0 : Math.exp(-(d * d) / 18) * (0.3 + 0.25 * s));
          rad = DOT * 0.8;
          fill = col.dot;
        } else if (L <= 0) {
          // Encore sur l'appareil : petits points pâles.
          a = 0.12;
          rad = DOT * 0.8;
          fill = m === "cancelled" ? col.mute : col.dot;
        } else if (m === "cancelled") {
          a = 0.3;
          fill = col.mute;
        } else if (L < 1) {
          // Rampe de chiffrement derrière le front.
          a = 0.8 + 0.2 * (1 - L);
          rad = DOT * (1 + 0.25 * (1 - L));
          if (m === "offline") {
            fill = col.warn;
            a = still ? 0.9 : 0.6 + 0.35 * Math.sin(t / 320);
          } else if (m === "error") {
            fill = col.danger;
            a = 0.9;
          } else if (m === "paused") {
            fill = col.mute;
            a = 0.7;
          } else if (!still) {
            const j = (1 - L) * 2.2 * act;
            x += Math.sin(t * 0.013 + s * 40) * j;
            y += Math.cos(t * 0.011 + s * 57) * j;
          }
        } else if (m === "paused" || m === "offline" || m === "error") {
          a = 0.36;
        } else if (m === "sealed") {
          a = 0.74 + 0.1 * s;
        } else if (m === "final") {
          // Tout est parti ; le serveur confirme : respiration lente, sans flux.
          a = 0.6 + 0.08 * s + (still ? 0 : 0.12 * Math.sin(t / 480 - i * 0.16));
        } else {
          // Envoyée : la trame coule vers la droite (le serveur) tant que des octets passent.
          a = 0.5 + 0.1 * s + 0.3 * act * (0.5 + 0.5 * Math.sin(TAU * (i / 10 - t / 760) + s * 2));
        }
        c.globalAlpha = a;
        if (fill !== painted) c.fillStyle = painted = fill; // couleur relue seulement quand elle change
        c.beginPath();
        c.arc(x, y, rad, 0, TAU);
        c.fill();
      }
    }
    c.globalAlpha = 1;
  }
</script>

<div class="trame" aria-hidden="true" bind:clientWidth={w} bind:clientHeight={h} data-trame>
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .trame {
    position: relative;
    height: 90px;
    min-width: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    /* Calque à part : redessiner la trame ne repeint ni le verre ni sa grande ombre floue. */
    will-change: transform;
  }
  @media (max-width: 559px) {
    .trame {
      height: 63px;
    }
  }
  @media (forced-colors: active) {
    .trame {
      display: none;
    }
  }
</style>

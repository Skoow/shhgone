// Logo « Trame » (mot-symbole Shhgone, nom affiché) et marque « S qui s'efface »
// (favicon et icônes), construits à la règle et au compas.
// Aucune image générée : chaque tracé est calculé ici, puis écrit dans src/ui/logo-paths.ts,
// public/logo.svg et public/favicon.svg. Les PNG et l'ICO viennent de scripts/gen-icons.mjs.
// Déterministe : le test régénère les sorties et les compare octet pour octet.
//
// Construction (unité u, ligne de base y = 0, axe y vers le bas) :
//   bas-de-casse monoline : hauteur d'x 24, ascendante 34, descendante 10, trait 5 (centré sur l'axe) ;
//   rondes : axe r 10,1 (débord optique 0,6) ; arches de h et r : r 9,5 centrées à y = −12 ;
//   S capitale (initiale) : voir sGeom ; approches 5 / 4,5 / 4,5 / 3 / 3 / 3,5.
//   g : panse du o, fût droit jusqu'à la ligne de base, crochet r 10,1 centré sur la ligne de base
//   (0° à 160°) ; n : fût d'x et arche du h ; e : panse du o, barre à mi-hauteur, ouverture de 0° à 40°.
//   « shh » plein ; « gone » échantillonné sur une grille au pas du trait (5 u), origine propre à
//   chaque lettre (centre des panses, fût du n), points dont le rayon décroît de 2,5 à 1,5 u en x.
//   S qui s'efface (initiale et marque) : épine en deux demi-ellipses superposées, tracée pleine du
//   terminal haut (−30°) jusqu'à −40° sur la panse basse, puis le reste de la courbe se défait en
//   points dont le rayon décroît et l'écart grandit (raison 1,4), qui s'écartent peu à peu de l'épine.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const X = 24, ASC = 34, DESC = 10, W = 5, HW = W / 2, RO = 10.1, RA = 9.5, OV = 0.6;
const GAPS = [5.0, 4.5, 4.5, 3.0, 3.0, 3.5];
const HOOK = 160, E_OPEN = 40;
const PITCH = 5, R_MAX = 2.5, R_MIN = 1.5, BUCKETS = 6;

const f = (v) => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};
const P = (x, y) => `${f(x)} ${f(y)}`;
const rad = (d) => (d * Math.PI) / 180;
const ring = (cx, cy, r) => `M${P(cx - r, cy)}A${f(r)} ${f(r)} 0 1 1 ${P(cx + r, cy)}A${f(r)} ${f(r)} 0 1 1 ${P(cx - r, cy)}`;

const dot = ([x, y, r]) => `M${P(x - r, y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0`;

/**
 * S qui s'efface. Épine : demi-ellipse haute (centre cx, cyU) parcourue de a0 à 90° en sens
 * inverse (par le haut et la gauche), puis demi-ellipse basse (centre cx, cyU + 2 ry) de −90° à a1.
 * Tracé plein jusqu'à cut (sur la panse basse) ; au-delà, n points sur la courbe (prolongée de ext
 * à sa tangente), rayons de r0 à r1, écarts entre bords en progression géométrique de raison k,
 * ajustés pour finir au bout ; chaque point s'écarte de l'épine (côté intérieur) de drift · t².
 * Renvoie le tracé plein (arcs exacts), le reste de l'épine (fantôme de la gomme) et les points.
 */
export function sGeom({ cx, cyU, rx, ry, rxU = rx, ryU = ry, W, a0 = -30, cut = -40, a1 = 160, n, r0, r1, k = 1.4, drift, ext, fade = 0 }) {
  // Panse haute (rxU, ryU) un peu plus petite que la basse, comme un S dessiné : jonction en (cx, cyU + ryU).
  const cyL = cyU + ryU + ry;
  const pu = (d) => [cx + rxU * Math.cos(rad(d)), cyU + ryU * Math.sin(rad(d))];
  const pl = (d) => [cx + rx * Math.cos(rad(d)), cyL + ry * Math.sin(rad(d))];
  const A = (large, sweep, p, a = rx, b = ry) => `A${f(a)} ${f(b)} 0 ${large} ${sweep} ${P(...p)}`;
  const solid = `M${P(...pu(a0))}${A(1, 0, pu(90), rxU, ryU)}${A(cut + 90 > 180 ? 1 : 0, 1, pl(cut))}`;
  const rest = `M${P(...pl(cut))}${A(a1 - cut > 180 ? 1 : 0, 1, pl(a1))}`;
  // Reste de l'épine échantillonné (abscisse curviligne), puis prolongé à la tangente.
  const STEPS = 2400, pts = [];
  for (let i = 0; i <= STEPS; i++) pts.push(pl(cut + ((a1 - cut) * i) / STEPS));
  const [ex, ey] = pts[STEPS], [px, py] = pts[STEPS - 1], tl = Math.hypot(ex - px, ey - py);
  pts.push([ex + ((ex - px) / tl) * ext, ey + ((ey - py) / tl) * ext]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = (s) => {
    let i = 1;
    while (i < pts.length - 1 && len[i] < s) i++;
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], m = Math.hypot(x1 - x0, y1 - y0), u = (s - len[i - 1]) / m;
    return [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, (y1 - y0) / m, -(x1 - x0) / m];
  };
  const radii = Array.from({ length: n }, (_, j) => r0 + ((r1 - r0) * j) / (n - 1));
  const weights = radii.map((_, j) => k ** j);
  const gap = (len.at(-1) - W / 2 - radii.reduce((a, r) => a + 2 * r, 0)) / weights.reduce((a, b) => a + b, 0);
  const dots = [], alpha = [];
  let s = W / 2;
  radii.forEach((r, j) => {
    s += weights[j] * gap + r;
    const [x, y, nx, ny] = at(s), t = j / (n - 1), off = drift * t * t;
    dots.push([x + nx * off, y + ny * off, r]);
    // Les points pâlissent vers la fin : opacité de 1 à 1 − fade.
    alpha.push(Math.round((1 - fade * t * t) * 100) / 100);
    s += r;
  });
  return { solid, rest, dots, alpha, gap, width: 2 * rx + W, top: cyU - ryU - W / 2, bottom: cyL + ry + W / 2 };
}

/**
 * LE S (un seul dessin pour l'icône et l'initiale du mot). Toutes les mesures sont
 * des multiples de l'épaisseur du trait W : l'icône et l'initiale ne diffèrent que par l'échelle.
 */
export const S_FORME = { rx: 1.76, ry: 1.4, rxU: 1.66, ryU: 1.27, n: 6, r0: 0.46, r1: 0.2, k: 1.4, drift: 0.36, ext: 0.8, fade: 0.8 };
/** Paramètres de sGeom pour un S de trait W, centre horizontal cx, bas du trait (hors points) à `bas`. */
export function sAt(W, cx, bas, forme = S_FORME) {
  const m = (v) => v * W;
  const ry = m(forme.ry), ryU = m(forme.ryU);
  return { cx, cyU: bas - W / 2 - ry - ry - ryU, rx: m(forme.rx), ry, rxU: m(forme.rxU), ryU, W, n: forme.n, r0: m(forme.r0), r1: m(forme.r1), k: forme.k, drift: m(forme.drift), ext: m(forme.ext), fade: forme.fade };
}
/** Marque (repère 32 × 32) : le S, trait 4, centré en (16, 16) (hauteur du trait 2 ryU + 2 ry + W). */
const MW = 4;
const MH = 2 * S_FORME.ryU * MW + 2 * S_FORME.ry * MW + MW;
export const MARK = sAt(MW, 16, 16 + MH / 2);
/** 16 px seulement (favicon.ico) : même S (mêmes panses), trait un peu plus épais et trois points plus gros, pour rester net. */
export const MARK_SMALL = { ...MARK, W: 4.6, n: 3, r0: 2.0, r1: 1.4, k: 1.5, drift: 0.8, ext: 2.2, fade: 0.55 };

// Lettres, tracées directement à leur abscisse x0 (chemins absolus).
const L = {
  // S capitale : LE S de la marque (S_FORME), au trait du mot (5), posé sur la ligne de base (+ débord).
  S(x0) {
    const g = sGeom(sAt(W, x0 + HW + S_FORME.rx * W, OV));
    return { d: g.solid, rest: g.rest, dots: g.dots, alpha: g.alpha, w: g.width };
  },
  h(x0) {
    const s = x0 + HW;
    return { d: `M${P(s, -ASC)}V0M${P(s, -X / 2)}A${f(RA)} ${f(RA)} 0 0 1 ${P(s + 2 * RA, -X / 2)}V0`, w: 2 * RA + W };
  },
  o(x0) {
    return { d: ring(x0 + HW + RO, -X / 2, RO), w: 2 * (HW + RO) };
  },
  g(x0) {
    const c = x0 + HW + RO, end = [c + RO * Math.cos(rad(HOOK)), RO * Math.sin(rad(HOOK))];
    return { d: `${ring(c, -X / 2, RO)}M${P(c + RO, -X)}V0A${f(RO)} ${f(RO)} 0 0 1 ${P(...end)}`, w: 2 * (HW + RO) };
  },
  n(x0) {
    const s = x0 + HW;
    return { d: `M${P(s, -X)}V0M${P(s, -X / 2)}A${f(RA)} ${f(RA)} 0 0 1 ${P(s + 2 * RA, -X / 2)}V0`, w: 2 * RA + W };
  },
  e(x0) {
    const c = x0 + HW + RO, end = [c + RO * Math.cos(rad(E_OPEN)), -X / 2 + RO * Math.sin(rad(E_OPEN))];
    return { d: `M${P(c - RO, -X / 2)}H${f(c + RO)}A${f(RO)} ${f(RO)} 0 1 0 ${P(...end)}`, w: 2 * (HW + RO) };
  },
};

export function build() {
  const xs = [];
  // Les derniers points du S dérivent un peu à gauche du trait : le mot commence assez loin pour
  // qu'aucun ne sorte du cadre (bord gauche du point le plus à gauche sur x = 0).
  const pad = Math.max(0, -Math.min(...L.S(0).dots.map(([px, , r]) => px - r)));
  let x = pad;
  const parts = [..."Shhgone"].map((ch, i) => {
    xs.push(x);
    const g = L[ch](x);
    x += g.w + (GAPS[i] ?? 0);
    return g;
  });
  const width = xs[6] + parts[6].w;
  const [XG, XO, XN, XE] = [xs[3], xs[4], xs[5], xs[6]];
  const CG = XG + HW + RO, CO = XO + HW + RO, SN = XN + HW, CE = XE + HW + RO, tol = HW + 0.3;
  const deg = (px, py, cx, cy) => ((Math.atan2(py - cy, px - cx) * 180) / Math.PI + 360) % 360;
  const onRing = (px, py, cx, cy, r) => Math.abs(Math.hypot(px - cx, py - cy) - r) <= tol;

  const inG = (px, py) =>
    onRing(px, py, CG, -X / 2, RO) ||
    (Math.abs(px - (CG + RO)) <= tol && py >= -X && py <= 0) ||
    (py > 0 && onRing(px, py, CG, 0, RO) && deg(px, py, CG, 0) <= HOOK);
  const inO = (px, py) => onRing(px, py, CO, -X / 2, RO);
  const inN = (px, py) =>
    (Math.abs(px - SN) <= tol && py >= -X && py <= 0) ||
    (onRing(px, py, SN + RA, -X / 2, RA) && deg(px, py, SN + RA, -X / 2) >= 180) ||
    (Math.abs(px - (SN + 2 * RA)) <= tol && py >= -X / 2 && py <= 0);
  const inE = (px, py) =>
    (Math.abs(py + X / 2) <= tol && Math.abs(px - CE) <= RO) ||
    (onRing(px, py, CE, -X / 2, RO) && !(deg(px, py, CE, -X / 2) > 0 && deg(px, py, CE, -X / 2) < E_OPEN));

  const pts = [];
  for (const [inside, ox, oy] of [[inG, CG, -X / 2], [inO, CO, -X / 2], [inN, SN, -X / 2], [inE, CE, -X / 2]])
    for (let j = -8; j <= 8; j++)
      for (let i = -8; i <= 8; i++) {
        const px = ox + i * PITCH, py = oy + j * PITCH;
        if (inside(px, py) && !pts.some(([a, b]) => Math.abs(a - px) < 0.3 && Math.abs(b - py) < 0.3)) pts.push([px, py]);
      }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const buckets = Array.from({ length: BUCKETS }, () => "");
  for (const [px, py] of pts) {
    const t = (px - XG) / (width - XG);
    const r = R_MAX - (R_MAX - R_MIN) * t;
    const k = Math.min(BUCKETS - 1, Math.floor(t * BUCKETS));
    buckets[k] += dot([px, py, r]);
  }
  const top = -ASC, bottom = DESC + R_MIN + 0.2;
  return {
    viewBox: `0 ${f(top)} ${f(width)} ${f(bottom - top)}`,
    // Initiale à part (bouts arrondis, comme la marque) ; « hh » au trait du mot.
    cap: parts[0].d,
    head: parts.slice(1, 3).map((p) => p.d).join(""),
    tail: parts[0].rest + parts.slice(3).map((p) => p.d).join(""),
    dots: buckets,
    count: pts.length,
    capDots: parts[0].dots,
    capAlpha: parts[0].alpha,
  };
}

/** Points qui pâlissent : un tracé par point, avec son opacité. */
const fading = (dots, alpha) => dots.map((p, i) => ({ d: dot(p), o: alpha[i] }));
const fadingSvg = (l, fill) => l.map(({ d, o }) => `<path d="${d}" fill="${fill}"${o < 1 ? ` fill-opacity="${o}"` : ""}/>`).join("");

/** Marque « S qui s'efface » : tracé plein et points qui pâlissent (repère 32 × 32). */
export function mark(small = false) {
  const g = sGeom(small ? MARK_SMALL : MARK);
  return { stroke: g.solid, width: (small ? MARK_SMALL : MARK).W, dots: fading(g.dots, g.alpha), geom: g };
}

export const COLORS = { bg: "#0B0D12", text: "#E9ECF2", accent: "#5FE3B5" };

/** Favicon / icône : S clair qui s'efface en points menthe, sur tuile sombre (lisible sur onglet clair comme sombre). */
export function iconSvg(size, { rounded = true, scale = 1, small = false } = {}) {
  // Grandes icônes : marque réduite autour du centre (16, 16), marge « maskable ».
  const off = 16 - 16 * scale;
  const rx = rounded ? 7 : 0;
  const m = mark(small);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">` +
    `<rect width="32" height="32" rx="${rx}" fill="${COLORS.bg}"/>` +
    `<g transform="translate(${f(off)} ${f(off)}) scale(${f(scale)})">` +
    `<path d="${m.stroke}" fill="none" stroke="${COLORS.text}" stroke-width="${f(m.width)}" stroke-linecap="round"/>` +
    `${fadingSvg(m.dots, COLORS.accent)}</g></svg>\n`
  );
}

export function logoSvg() {
  const b = build();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.viewBox}" role="img" aria-label="Shhgone">` +
    `<path d="${b.cap}" fill="none" stroke="${COLORS.text}" stroke-width="${W}" stroke-linecap="round"/>` +
    `<path d="${b.head}" fill="none" stroke="${COLORS.text}" stroke-width="${W}"/>` +
    fadingSvg(fading(b.capDots, b.capAlpha), COLORS.accent) +
    `<path d="${b.dots.join("")}" fill="${COLORS.accent}"/></svg>\n`
  );
}

export function pathsTs() {
  const b = build();
  return (
    "// Généré par scripts/gen-logo.mjs : ne pas modifier à la main.\n" +
    `// Initiale S (même dessin que la marque) ; trame : ${b.count} points de « gone » en ${b.dots.length} tranches.\n` +
    `export const LOGO_VIEWBOX = ${JSON.stringify(b.viewBox)};\n` +
    `export const LOGO_STROKE = ${W};\n` +
    `export const LOGO_CAP = ${JSON.stringify(b.cap)};\n` +
    `export const LOGO_CAP_DOTS: readonly { d: string; o: number }[] = ${JSON.stringify(fading(b.capDots, b.capAlpha))};\n` +
    `export const LOGO_HEAD = ${JSON.stringify(b.head)};\n` +
    `export const LOGO_TAIL = ${JSON.stringify(b.tail)};\n` +
    `export const LOGO_DOTS: readonly string[] = ${JSON.stringify(b.dots)};\n` +
    `export const MARK_STROKE = ${JSON.stringify(mark().stroke)};\n` +
    `export const MARK_WIDTH = ${mark().width};\n` +
    `export const MARK_DOTS: readonly { d: string; o: number }[] = ${JSON.stringify(mark().dots)};\n`
  );
}

export const OUTPUTS = {
  "src/ui/logo-paths.ts": pathsTs,
  "public/logo.svg": logoSvg,
  "public/favicon.svg": () => iconSvg(32),
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const web = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const [rel, gen] of Object.entries(OUTPUTS)) writeFileSync(join(web, rel), gen());
  console.log("gen-logo :", Object.keys(OUTPUTS).join(", "));
}

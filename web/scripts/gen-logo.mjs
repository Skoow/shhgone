// Logo « Trame » (mot-symbole Shhgone, nom affiché depuis le 12 novembre) et marque « S qui s'efface »
// (favicon et icônes, choisie par le propriétaire le 21 novembre), construits à la règle et au compas.
// Aucune image générée : chaque tracé est calculé ici, puis écrit dans src/ui/logo-paths.ts,
// public/logo.svg et public/favicon.svg. Les PNG et l'ICO viennent de scripts/gen-icons.mjs.
// Déterministe : le test régénère les sorties et les compare octet pour octet.
//
// Construction (unité u, ligne de base y = 0, axe y vers le bas) :
//   bas-de-casse monoline : hauteur d'x 24, ascendante 34, descendante 10, trait 5 (centré sur l'axe) ;
//   rondes : axe r 10,1 (débord optique 0,6) ; arches de h et r : r 9,5 centrées à y = −12 ;
//   S capitale (initiale, 21 novembre) : voir sGeom ; approches 5 / 4,5 / 4,5 / 3 / 3 / 3,5.
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
export function sGeom({ cx, cyU, rx, ry, W, a0 = -30, cut = -40, a1 = 160, n, r0, r1, k = 1.4, drift, ext }) {
  const cyL = cyU + 2 * ry;
  const pu = (d) => [cx + rx * Math.cos(rad(d)), cyU + ry * Math.sin(rad(d))];
  const pl = (d) => [cx + rx * Math.cos(rad(d)), cyL + ry * Math.sin(rad(d))];
  const A = (large, sweep, p) => `A${f(rx)} ${f(ry)} 0 ${large} ${sweep} ${P(...p)}`;
  const solid = `M${P(...pu(a0))}${A(1, 0, pu(90))}${A(cut + 90 > 180 ? 1 : 0, 1, pl(cut))}`;
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
  const dots = [];
  let s = W / 2;
  radii.forEach((r, j) => {
    s += weights[j] * gap + r;
    const [x, y, nx, ny] = at(s), t = j / (n - 1), off = drift * t * t;
    dots.push([x + nx * off, y + ny * off, r]);
    s += r;
  });
  return { solid, rest, dots, gap, width: 2 * rx + W };
}

/** Marque (repère 32 × 32, centrée en 16, 16) ; « small » : variante 16 px (3 points plus gros, trait plus épais). */
export const MARK = { cx: 16, cyU: 10.7, rx: 6.7, ry: 5.3, W: 4.4, n: 6, r0: 1.9, r1: 0.8, drift: 1.4, ext: 3 };
export const MARK_SMALL = { ...MARK, W: 4.8, cut: -35, n: 3, r0: 2.0, r1: 1.35, k: 1.5, drift: 0.8, ext: 2.2 };

// Lettres, tracées directement à leur abscisse x0 (chemins absolus).
const L = {
  // S capitale : même dessin que la marque, trait du mot (5), rayons des points ceux de la trame (2,5 à 1,5).
  S(x0) {
    const rx = 8.8, ry = 7;
    const g = sGeom({ cx: x0 + HW + rx, cyU: OV - HW - 3 * ry, rx, ry, W, n: 6, r0: R_MAX, r1: R_MIN, drift: 1.8, ext: 4 });
    return { d: g.solid, rest: g.rest, dots: g.dots, w: g.width };
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
  let x = 0;
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
    head: parts.slice(0, 3).map((p) => p.d).join(""),
    tail: parts[0].rest + parts.slice(3).map((p) => p.d).join(""),
    dots: [parts[0].dots.map(dot).join(""), ...buckets],
    count: pts.length,
    capDots: parts[0].dots,
  };
}

/** Marque « S qui s'efface » : tracé plein et points (repère 32 × 32). */
export function mark(small = false) {
  const g = sGeom(small ? MARK_SMALL : MARK);
  return { stroke: g.solid, width: (small ? MARK_SMALL : MARK).W, dots: g.dots.map(dot).join(""), geom: g };
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
    `<path d="${m.dots}" fill="${COLORS.accent}"/></g></svg>\n`
  );
}

export function logoSvg() {
  const b = build();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.viewBox}" role="img" aria-label="Shhgone">` +
    `<path d="${b.head}" fill="none" stroke="${COLORS.text}" stroke-width="${W}"/>` +
    `<path d="${b.dots.join("")}" fill="${COLORS.accent}"/></svg>\n`
  );
}

export function pathsTs() {
  const b = build();
  return (
    "// Généré par scripts/gen-logo.mjs : ne pas modifier à la main.\n" +
    `// Trame : points du S, puis ${b.count} points de « gone » en ${b.dots.length - 1} tranches (de gauche à droite).\n` +
    `export const LOGO_VIEWBOX = ${JSON.stringify(b.viewBox)};\n` +
    `export const LOGO_STROKE = ${W};\n` +
    `export const LOGO_HEAD = ${JSON.stringify(b.head)};\n` +
    `export const LOGO_TAIL = ${JSON.stringify(b.tail)};\n` +
    `export const LOGO_DOTS: readonly string[] = ${JSON.stringify(b.dots)};\n` +
    `export const MARK_STROKE = ${JSON.stringify(mark().stroke)};\n` +
    `export const MARK_WIDTH = ${mark().width};\n` +
    `export const MARK_DOTS = ${JSON.stringify(mark().dots)};\n`
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

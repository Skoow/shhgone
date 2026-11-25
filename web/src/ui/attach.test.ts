// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reveal } from "./attach";

// Faux IntersectionObserver : le test décide de chaque mesure.
type Cb = (e: { isIntersecting: boolean; boundingClientRect: { top: number } }[]) => void;
let last: { cb: Cb; disconnected: boolean } | null = null;
class FakeIO {
  s: { cb: Cb; disconnected: boolean };
  constructor(cb: Cb) {
    this.s = { cb, disconnected: false };
    last = this.s;
  }
  observe() {}
  disconnect() {
    this.s.disconnected = true;
  }
}
const see = (isIntersecting: boolean, top: number) => last!.cb([{ isIntersecting, boundingClientRect: { top } }]);

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIO);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("CSS", { supports: () => false });
  last = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("révélation au défilement (repli sans animation-timeline)", () => {
  it("jamais caché avant la première mesure (aucun « rv-wait » posé d'office)", () => {
    const el = document.createElement("div");
    reveal(el);
    expect(el.classList.contains("rv-wait")).toBe(false);
  });
  it("déjà visible au chargement : jamais caché, plus observé", () => {
    const el = document.createElement("div");
    reveal(el);
    see(true, 100);
    expect(el.classList.contains("rv-wait")).toBe(false);
    expect(last!.disconnected).toBe(true);
  });
  it("au-dessus de l'écran à la première mesure (ancre) : jamais caché", () => {
    const el = document.createElement("div");
    reveal(el);
    see(false, -400);
    expect(el.classList.contains("rv-wait")).toBe(false);
  });
  it("plus bas que l'écran : caché, puis révélé une fois à son entrée", () => {
    const el = document.createElement("div");
    reveal(el);
    see(false, 2000);
    expect(el.classList.contains("rv-wait")).toBe(true);
    expect(el.classList.contains("in")).toBe(false);
    see(true, 500);
    expect(el.classList.contains("in")).toBe(true);
    expect(last!.disconnected).toBe(true);
  });
  it("sauté par-dessus (passé au-dessus sans entrer) : révélé tout de suite", () => {
    const el = document.createElement("div");
    reveal(el);
    see(false, 2000);
    see(false, -300);
    expect(el.classList.contains("in")).toBe(true);
  });
});

describe("révélation en CSS (animation-timeline: view())", () => {
  const css = readFileSync("src/ui/base.css", "utf8");
  it("rien n'est appliqué avant l'entrée dans l'écran (forwards, jamais both ni backwards)", () => {
    const rule = /\.rv \{[^}]*animation: rv-in[^;]*;/.exec(css)![0];
    expect(rule).toMatch(/forwards/);
    expect(rule).not.toMatch(/both|backwards/);
  });
  it("tout visible à l'impression et sur l'élément visé par l'ancre", () => {
    const print = css.slice(css.indexOf("@media print"));
    expect(print).toMatch(/\.rv \{\s*animation: none !important/);
    expect(print).toMatch(/\.rv-wait \{\s*opacity: 1 !important/);
    expect(css).toMatch(/\.rv:target,\s*:target \.rv \{\s*animation: none/);
  });
});

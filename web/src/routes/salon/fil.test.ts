// Mise en page du fil (fil.ts) : séparateur du jour, séries d'un même auteur, albums,
// « Nouveaux messages » qui coupe la série, messages système qui la coupent aussi.
import { describe, expect, it } from "vitest";
import type { Bulle, Element, Systeme } from "../../salon/conversation";
import { rangs, SERIE_MS, sorteJour } from "./fil";

const H = new Date(2026, 10, 25, 21, 0).getTime();
const MIN = 60_000;
let n = 0;
function b(siege: number, ms: number, x: Partial<Bulle> = {}): Bulle {
  n++;
  return { k: "bulle", cle: `k${n}`, id: `i${n}`, seq: n, local: null, siege, moi: siege === 0, texte: `t${n}`, cite: null, modifie: false, retire: false, heureMs: ms, regle: 0, epoque: 0, etat: "envoye", echec: null, attendus: [], recus: [], vus: [], ouverts: [], telecharges: [], heures: { recu: new Map(), vu: new Map(), ouvert: new Map(), telecharge: new Map() }, envoyeMs: null, reactions: [], piece: null, ...x } as Bulle;
}
const sys = (): Systeme => ({ k: "sys", cle: `s${++n}`, quoi: "arrivee", siege: 1 });
const qui = (x: Bulle) => `${x.moi}:${x.siege}`;
const resume = (l: ReturnType<typeof rangs>) => l.map((r) => (r.k === "msg" || r.k === "album" ? `${r.k}${r.k === "album" ? r.items.length : ""}:${r.premier ? "P" : ""}${r.dernier ? "D" : ""}` : r.k));

describe("fil.ts : rangs", () => {
  it("séparateur du jour au premier message, puis à chaque changement de jour", () => {
    const l = rangs([b(1, H - 24 * 60 * MIN), b(1, H), b(1, H + MIN)], new Map(), qui);
    expect(l.map((r) => r.k)).toEqual(["jour", "msg", "jour", "msg", "msg"]);
    expect(new Set(l.map((r) => r.cle)).size).toBe(l.length); // clés uniques (bloc à clé)
  });

  it("premier jour : avant les lignes système qui ouvrent le fil", () => {
    const l = rangs([sys(), sys(), b(1, H)], new Map(), qui);
    expect(l.map((r) => r.k)).toEqual(["jour", "sys", "sys", "msg"]);
  });

  it("série : même auteur, à moins de 5 min ; premier et dernier marqués", () => {
    const l = rangs([b(1, H), b(1, H + MIN), b(1, H + 2 * MIN), b(0, H + 3 * MIN), b(1, H + 4 * MIN)], new Map(), qui);
    expect(resume(l)).toEqual(["jour", "msg:P", "msg:", "msg:D", "msg:PD", "msg:PD"]);
  });

  it("au-delà de 5 min, une nouvelle série commence", () => {
    const l = rangs([b(1, H), b(1, H + SERIE_MS + 1)], new Map(), qui);
    expect(resume(l)).toEqual(["jour", "msg:PD", "msg:PD"]);
  });

  it("un message système et « Nouveaux messages » coupent la série", () => {
    const a = b(1, H);
    const c = b(1, H + MIN);
    const d = b(1, H + 2 * MIN);
    const l = rangs([a, sys(), c, d], new Map(), qui, d.cle);
    expect(resume(l)).toEqual(["jour", "msg:PD", "sys", "msg:PD", "nouveaux", "msg:PD"]);
  });

  it("album : les photos qui le suivent y entrent, l'album compte pour un dans la série", () => {
    const t = b(1, H);
    const p1 = b(1, H + MIN);
    const p2 = b(1, H + MIN);
    const p3 = b(1, H + MIN);
    const l = rangs([t, p1, p2, p3, b(1, H + 2 * MIN)], new Map([[p1.cle, "debut"], [p2.cle, "suite"], [p3.cle, "suite"]]), qui);
    expect(resume(l)).toEqual(["jour", "msg:P", "album3:", "msg:D"]);
    const al = l.find((r) => r.k === "album");
    expect(al?.k === "album" && al.items.map((x) => x.cle)).toEqual([p1.cle, p2.cle, p3.cle]);
  });

  it("auteur différent (siège redonné : nom figé différent) : nouvelle série", () => {
    const l = rangs([b(1, H), b(1, H + MIN)] as Element[], new Map(), (x) => x.cle);
    expect(resume(l)).toEqual(["jour", "msg:PD", "msg:PD"]);
  });
});

describe("fil.ts : sorteJour", () => {
  it("aujourd'hui, hier, une date de l'année, une autre année", () => {
    expect(sorteJour(H - 60 * MIN, H)).toBe("today");
    expect(sorteJour(H - 24 * 60 * MIN, H)).toBe("yesterday");
    expect(sorteJour(H - 3 * 24 * 60 * MIN, H)).toBe("date");
    expect(sorteJour(new Date(2025, 0, 3).getTime(), H)).toBe("annee");
  });
});

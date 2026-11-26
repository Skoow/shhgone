// Mise en page du fil du salon, comme une application de messagerie : séparateur du jour
// (« Aujourd'hui », « Hier », la date), séries de messages d'un même auteur (nom et photo sur le
// premier seulement, espacement serré), albums de photos. Calculé sur l'appareil à partir du fil
// local (conversation.ts) ; rien n'est envoyé ni déduit au-delà de l'heure et de l'auteur que
// chaque message porte déjà. Fonctions pures, sans état.
import type { Bulle, Element, Systeme } from "../../salon/conversation";

/** Au-delà de cet écart, deux messages du même auteur ne font plus une série. */
export const SERIE_MS = 5 * 60_000;

export type Rang =
  | { k: "jour"; cle: string; ms: number }
  | { k: "nouveaux"; cle: "nouveaux" }
  | { k: "sys"; cle: string; e: Systeme }
  | { k: "msg"; cle: string; e: Bulle; premier: boolean; dernier: boolean }
  | { k: "album"; cle: string; items: Bulle[]; premier: boolean; dernier: boolean };

/** Jour local (année, mois, jour) d'une heure en ms. */
export function jourDe(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Rangs du fil, dans l'ordre : `albums` dit quelles photos font un album (début, suite),
 * `auteur` donne l'identité affichée d'un message (siège et nom figé), `nouveaux` la clé du
 * premier message non lu (le séparateur « Nouveaux messages » vient avant lui et coupe la série).
 */
export function rangs(elements: readonly Element[], albums: ReadonlyMap<string, "debut" | "suite">, auteur: (b: Bulle) => string, nouveaux: string | null = null): Rang[] {
  const out: Rang[] = [];
  let jour: string | null = null;
  // Dernier message (ou album) posé, pour la série en cours ; null après une coupure.
  let prec: { r: Extract<Rang, { k: "msg" | "album" }>; qui: string; ms: number } | null = null;
  for (const e of elements) {
    if (e.k === "sys") {
      out.push({ k: "sys", cle: e.cle, e });
      prec = null;
      continue;
    }
    const al = albums.get(e.cle);
    if (al === "suite" && prec?.r.k === "album" && e.cle !== nouveaux) {
      prec.r.items.push(e);
      prec.ms = e.heureMs;
      continue;
    }
    const j = jourDe(e.heureMs);
    if (j !== jour) {
      // Premier jour : avant les lignes système qui ouvrent le fil (arrivées), qui n'ont pas d'heure.
      out.splice(jour === null ? 0 : out.length, 0, { k: "jour", cle: `j-${e.cle}`, ms: e.heureMs });
      jour = j;
      prec = null;
    }
    if (e.cle === nouveaux) {
      out.push({ k: "nouveaux", cle: "nouveaux" });
      prec = null;
    }
    const qui = auteur(e);
    const suite: boolean = prec !== null && prec.qui === qui && e.heureMs - prec.ms <= SERIE_MS && e.heureMs >= prec.ms - SERIE_MS;
    if (suite) prec!.r.dernier = false;
    const r: Extract<Rang, { k: "msg" | "album" }> = al === "debut" ? { k: "album", cle: `a-${e.cle}`, items: [e], premier: !suite, dernier: true } : { k: "msg", cle: e.cle, e, premier: !suite, dernier: true };
    out.push(r);
    prec = { r, qui, ms: e.heureMs };
  }
  return out;
}

/** Libellé du séparateur du jour : « today », « yesterday », ou la date (avec l'année si autre). */
export function sorteJour(ms: number, maintenantMs: number): "today" | "yesterday" | "date" | "annee" {
  const auj = new Date(maintenantMs);
  if (jourDe(ms) === jourDe(maintenantMs)) return "today";
  if (jourDe(ms) === jourDe(new Date(auj.getFullYear(), auj.getMonth(), auj.getDate() - 1, 12).getTime())) return "yesterday";
  return new Date(ms).getFullYear() === auj.getFullYear() ? "date" : "annee";
}

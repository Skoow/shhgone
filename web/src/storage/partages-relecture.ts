// Relecture de l'état des envois de « Mes partages » (spec §33.1). Ce que voit le serveur : un
// GET /api/manage/status par relecture, avec le seul secret de gestion. Pour que la page ne soit pas
// une salve de requêtes qui relierait en direct les partages d'une même connexion :
// - seulement à l'affichage de « Mes partages », page visible, jamais en arrière-plan ;
// - au plus une fois toutes les 5 min par partage (la création compte comme un état connu) ;
// - l'un après l'autre, chacun après une gigue de 0,5 à 4 s.
// Reste visible au serveur, en direct : une même connexion interroge plusieurs partages (§18.18).
// Salons : pas relus (il faudrait le moteur du salon) ; leur échéance gardée fait foi, et leur
// page de gestion (« #s ») dit l'état réel.
import { LimitError, NotFoundError } from "../index";
import { estActif, etatVu, type Partage, type Partages, type Patch } from "./partages";

export const RELECTURE_MIN_MS = 5 * 60_000;
export const GIGUE_MIN_MS = 500;
export const GIGUE_MAX_MS = 4000;

export type Etat = { opensUsed: number; maxOpens: number; expiresInS: number; state: string };
export type ErreurRelecture = "reseau" | "limite" | "serveur";
export type DepsRelecture = {
  etat: (gestion: string) => Promise<Etat>;
  detruire: (gestion: string) => Promise<void>;
  now: () => number;
  visible: () => boolean;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export function erreurDe(e: unknown): ErreurRelecture {
  if (e instanceof LimitError) return "limite";
  if (e instanceof Error && e.message === "reseau") return "reseau";
  return "serveur";
}
const introuvable = (e: unknown) => e instanceof NotFoundError || (e instanceof Error && e.message === "lien_invalide");

/** Relecture réussie à l'heure `t`. */
export const patchEtat = (s: Etat, t: number): Patch => ({
  ouvertures: s.opensUsed,
  ouverturesMax: Math.max(1, s.maxOpens),
  echeance: t + Math.max(0, s.expiresInS) * 1000,
  etat: s.state === "draining" ? "epuise" : "actif",
  vuLe: t,
});
/** Absent du serveur à l'heure `t` : échu si l'échéance est passée, sinon effacé. */
export function patchAbsent(p: Partage, t: number): Patch {
  const echu = t >= p.echeance;
  return { etat: echu ? "expire" : "detruit", finLe: echu ? p.echeance : t, vuLe: t };
}
export const patchDetruit = (t: number): Patch => ({ etat: "detruit", detruitIci: true, finLe: t, vuLe: t });

export function relecteur(s: Pick<Partages, "get" | "liste" | "modifier">, d: DepsRelecture) {
  const tente = new Map<string, number>();
  const pauseJusqua = new Map<string, number>();
  let passe: { off: boolean } | null = null;

  async function une(p: Partage, jeton: { off: boolean }): Promise<ErreurRelecture | null> {
    if (jeton.off || !d.visible()) return null;
    const t0 = d.now();
    if (p.sorte !== "envoi" || !estActif(p, t0)) return null;
    if (t0 < Math.max(p.vuLe, tente.get(p.id) ?? 0) + RELECTURE_MIN_MS || t0 < (pauseJusqua.get(p.id) ?? 0)) return null;
    await d.sleep(Math.round(GIGUE_MIN_MS + d.random() * (GIGUE_MAX_MS - GIGUE_MIN_MS)));
    if (jeton.off || !d.visible()) return null;
    let e: Etat;
    try {
      e = await d.etat(p.gestion);
    } catch (err) {
      const t = d.now();
      if (introuvable(err)) {
        tente.set(p.id, t);
        await s.modifier(p.id, patchAbsent(p, t));
        return null;
      }
      const m = erreurDe(err);
      // Une coupure réseau n'a pas atteint le serveur : un nouvel essai reste permis.
      if (m !== "reseau") tente.set(p.id, t);
      if (err instanceof LimitError) pauseJusqua.set(p.id, t + err.retryAfterS * 1000);
      return m;
    }
    const t = d.now();
    tente.set(p.id, t);
    const cur = (await s.get(p.id)) ?? p;
    if (etatVu(cur, t) === "detruit") return null; // détruit pendant la relecture
    await s.modifier(p.id, patchEtat(e, t));
    return null;
  }

  return {
    /** Relit les envois actifs, l'un après l'autre ; rend les erreurs par identifiant. */
    async relire(): Promise<Record<string, ErreurRelecture>> {
      if (passe) passe.off = true;
      const jeton = (passe = { off: false });
      const erreurs: Record<string, ErreurRelecture> = {};
      for (const p of await s.liste()) {
        if (jeton.off) break;
        const e = await une(p, jeton);
        if (e) erreurs[p.id] = e;
      }
      return erreurs;
    },
    arreter(): void {
      if (passe) passe.off = true;
      passe = null;
    },
    /** « Supprimer » : geste de la personne (ni gigue ni limite). Rend l'erreur, ou null. */
    async detruire(id: string): Promise<ErreurRelecture | null> {
      const p = await s.get(id);
      if (!p) return null;
      if (p.sorte !== "envoi") return "serveur"; // salon : par sa page de gestion
      try {
        await d.detruire(p.gestion);
      } catch (err) {
        if (!(err instanceof NotFoundError)) return erreurDe(err);
      }
      await s.modifier(id, patchDetruit(d.now()));
      return null;
    },
  };
}
export type Relecteur = ReturnType<typeof relecteur>;

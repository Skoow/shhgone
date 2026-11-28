// Suivi en direct de l'état des envois de « Mes partages » (décision du propriétaire, 28 novembre :
// le compteur d'ouvertures se met à jour tout de suite, sans attendre ni recharger ; remplace la
// relecture « au plus toutes les 5 min, avec gigue » de la spec §33.1). Tant que la page est
// affichée et visible : une seule surveillance (POST /api/manage/surveiller) pour tous les envois
// actifs (40 au plus, les plus récents), relancée dès sa réponse. Le serveur répond dès qu'une
// ouverture est consommée ou qu'un partage disparaît, sinon après 25 s. Page cachée ou quittée :
// la surveillance est coupée. Ce que voit le serveur : une même connexion suit ses partages
// ensemble (§18.18), accepté par le propriétaire.
// Salons : pas suivis (il faudrait le moteur du salon) ; leur échéance gardée fait foi, et leur
// page de gestion (« #s ») dit l'état réel.
import { LimitError, NotFoundError } from "../index";
import { estActif, etatVu, type Partage, type Partages, type Patch } from "./partages";

/** Envois suivis ensemble (serveur : surveillerMax). */
export const SUIVI_MAX = 40;
/** Pause après une erreur réseau ou serveur, avant de relancer la surveillance. */
export const PAUSE_ERREUR_MS = 5000;

export type Etat = { opensUsed: number; maxOpens: number; expiresInS: number; state: string };
export type ErreurRelecture = "reseau" | "limite" | "serveur";
export type DepsRelecture = {
  /** Surveillance : rend les états, dans l'ordre, dès qu'un diffère de celui donné (ou après 25 s). */
  surveiller: (suivis: { gestion: string; opensUsed: number; state: string }[], signal: AbortSignal) => Promise<Etat[]>;
  detruire: (gestion: string) => Promise<void>;
  now: () => number;
  visible: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Appelé après chaque changement écrit (la page relit la liste). */
  change?: () => void;
};

export function erreurDe(e: unknown): ErreurRelecture {
  if (e instanceof LimitError) return "limite";
  if (e instanceof Error && e.message === "reseau") return "reseau";
  return "serveur";
}

/** État lu à l'heure `t`. */
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

/** État connu d'une entrée, tel que le serveur l'écrit. */
const connu = (p: Partage) => ({ gestion: p.gestion, opensUsed: p.ouvertures, state: p.etat === "epuise" ? "draining" : "ready" });

export function relecteur(s: Pick<Partages, "get" | "liste" | "modifier">, d: DepsRelecture) {
  let passe: AbortController | null = null;
  const erreurs: Record<string, ErreurRelecture> = {};

  /** Une réponse : chaque état qui diffère est écrit (le dernier état connu reste sinon). */
  async function appliquer(suivis: Partage[], etats: Etat[]): Promise<boolean> {
    const t = d.now();
    let ecrit = false;
    for (let i = 0; i < suivis.length; i++) {
      const p = suivis[i]!;
      const e = etats[i]!;
      delete erreurs[p.id];
      const cur = (await s.get(p.id)) ?? p;
      if (etatVu(cur, t) === "detruit") continue; // supprimé ici entre-temps
      if (e.state === "absent") {
        await s.modifier(p.id, patchAbsent(cur, t));
        ecrit = true;
      } else if (e.opensUsed !== cur.ouvertures || (e.state === "draining") !== (cur.etat === "epuise") || Math.max(1, e.maxOpens) !== cur.ouverturesMax) {
        await s.modifier(p.id, patchEtat(e, t));
        ecrit = true;
      }
    }
    return ecrit;
  }

  async function boucle(ctl: AbortController): Promise<void> {
    while (!ctl.signal.aborted && d.visible()) {
      const t = d.now();
      const suivis = (await s.liste()).filter((p) => p.sorte === "envoi" && estActif(p, t)).slice(0, SUIVI_MAX);
      if (suivis.length === 0) return;
      try {
        const etats = await d.surveiller(suivis.map(connu), ctl.signal);
        if (ctl.signal.aborted) return;
        if (await appliquer(suivis, etats)) d.change?.();
      } catch (err) {
        if (ctl.signal.aborted) return;
        const m = erreurDe(err);
        for (const p of suivis) erreurs[p.id] = m;
        d.change?.();
        await d.sleep(err instanceof LimitError ? Math.max(PAUSE_ERREUR_MS, err.retryAfterS * 1000) : PAUSE_ERREUR_MS);
      }
    }
  }

  return {
    /** Erreurs de la dernière surveillance, par identifiant (l'entrée garde son dernier état connu). */
    erreurs: (): Record<string, ErreurRelecture> => ({ ...erreurs }),
    /** Suit les envois actifs tant que la page est visible ; une seule boucle à la fois. */
    suivre(): Promise<void> {
      passe?.abort();
      const ctl = (passe = new AbortController());
      return boucle(ctl);
    },
    arreter(): void {
      passe?.abort();
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

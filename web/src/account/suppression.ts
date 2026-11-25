// Suppression totale du compte (conception compte §21.12 ;
// « suppression simplifiée »). On supprime ce dont la personne est l'auteur ou
// l'admin, et rien de plus n'est promis :
// (1) partages créés : chaque secret de gestion connu (coffre privé ET historique de l'appareil)
//     est rejoué par POST /api/manage/destroy, un par un, SANS le jeton de session (aucun lien
//     compte ↔ partage n'est ajouté côté serveur ; le serveur voit en direct une même connexion
//     détruire N partages, S80) ; un échec n'arrête pas les autres et est compté ;
// (2) salons rejoints : départ de chaque salon où une preuve de membre existe. Aucune n'est encore
//     gardée sur l'appareil (écrans du salon, C-5) : rien à faire aujourd'hui ;
// (3) POST /api/compte/supprimer : le serveur ferme les salons créés (lien compte ↔ salon), efface
//     les lignes, les deux coffres, le séquestre et l'empreinte du pseudo ;
// (4) l'appareil oublie le compte, et efface aussi ses données si la personne l'a demandé.
// Un partage absent des deux listes (appareil sans historique, coffre perdu par une récupération)
// ne peut pas être retrouvé : il s'efface à son échéance. L'écran le dit.
// Fonctions pures et dépendances injectées : session.svelte.ts les branche.
import { NotFoundError } from "../index";
import { effectiveState, type HistoryEntry } from "../history/store";
import type { CoffrePrive } from "./vaults";

export type Progres =
  | { etape: "partages"; fait: number; total: number; echecs: number }
  | { etape: "compte" }
  | { etape: "fini"; salonsFermes: number; partagesDetruits: number; partagesEchoues: number };

export type DepsSuppression = {
  /** Vérifications avant toute destruction (attente après une récupération) ; rejette pour arrêter. */
  avant: () => Promise<void>;
  /** Liens de gestion à détruire (partagesConnus). */
  partages: () => Promise<string[]>;
  /** Détruit un partage par son lien de gestion (destroyShare : X-Shh-Manage seulement). */
  detruire: (lien: string) => Promise<void>;
  /** POST supprimer ; rend le nombre de salons fermés. */
  supprimerCompte: () => Promise<number>;
  /** L'appareil oublie le compte (session, copie gardée, entrées venues du compte). */
  oublierCompte: () => Promise<void>;
  /** Effacement des données de l'appareil (historique, téléchargements), si demandé. */
  effacerAppareil: () => Promise<void>;
};

const GESTION = /^https?:\/\/[^#\s]+#m([A-Za-z0-9_-]{43})$/;

/**
 * Liens de gestion des partages encore vivants que l'appareil connaît : coffre privé puis
 * historique local, sans doublon (même secret), sans ceux que l'appareil sait finis ou échus.
 * Jamais un partage reçu ni un salon.
 */
export function partagesConnus(prive: CoffrePrive | undefined, local: readonly HistoryEntry[], now: number): string[] {
  const out: string[] = [];
  const vus = new Set<string>();
  const ajouter = (lien: unknown) => {
    if (typeof lien !== "string") return;
    const m = GESTION.exec(lien);
    if (!m || vus.has(m[1]!)) return;
    vus.add(m[1]!);
    out.push(lien);
  };
  for (const v of prive?.envois ?? []) if (typeof v.expire === "number" && v.expire > now) ajouter(v.gestion);
  for (const e of local) {
    if (e.sorte !== "envoi") continue;
    const s = effectiveState(e, now);
    if (s === "gone" || s === "expired") continue;
    ajouter(e.manage);
  }
  return out;
}

export async function* supprimerTout(o: { effacerAppareil: boolean }, d: DepsSuppression): AsyncGenerator<Progres> {
  await d.avant();
  const liens = await d.partages();
  let fait = 0;
  let echecs = 0;
  yield { etape: "partages", fait, total: liens.length, echecs };
  for (const l of liens) {
    try {
      await d.detruire(l);
    } catch (e) {
      // Déjà disparu (détruit ailleurs, échu) : rien de plus à faire, il compte comme détruit.
      if (!(e instanceof NotFoundError)) echecs++;
    }
    fait++;
    yield { etape: "partages", fait, total: liens.length, echecs };
  }
  yield { etape: "compte" };
  const salonsFermes = await d.supprimerCompte();
  await d.oublierCompte();
  if (o.effacerAppareil) await d.effacerAppareil();
  yield { etape: "fini", salonsFermes, partagesDetruits: fait - echecs, partagesEchoues: echecs };
}

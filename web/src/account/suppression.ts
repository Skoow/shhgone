// Suppression totale du compte (conception compte §21.12 ; « suppression simplifiée » ; décision
// du propriétaire du 28 novembre : supprimer le compte supprime toujours l'abonnement aussi). On
// supprime ce dont la personne est l'auteur ou l'admin, et rien de plus n'est promis. Ordre :
// (a) pour chaque pass connu (coffre privé et appareil, abonnements.ts) : arrêt du renouvellement
//     chez le prestataire (POST /api/paiement/resilier ; pas pour un accès offert), sinon la
//     personne resterait prélevée ;
// (b) révocation du pass sur le serveur (POST /api/paiement/revoquer) : il ne marche plus nulle
//     part, y compris sur ses autres appareils. Un échec de (a) ou (b) arrête TOUT avant la
//     suppression du compte (ErreurAbonnement : « Réessayer » ; les deux appels sont idempotents) ;
// (c) POST /api/compte/supprimer : le serveur ferme les salons créés, efface les lignes, les deux
//     coffres (et le pass qu'y était rangé) et l'empreinte du pseudo ;
// (d) l'appareil oublie le compte et les pass traités (et ses jetons), puis efface TOUTES ses
//     autres données du site (décision du propriétaire, 28 novembre : plus de case ; l'appareil
//     revient à zéro, Mes partages créés sans compte compris ; une commande en attente reste).
// Les requêtes de pass (a, b) sont celles du paiement, sans en-tête de session : le serveur ne
// relie pas pass et compte en base ; leur succession dans le temps est dite dans la conception du
// paiement (§5.6). Les partages créés ne sont pas détruits : ils s'effacent à leur échéance, ou
// plus tôt par leur lien de gestion. L'écran le dit.
// Fonctions pures et dépendances injectées : session.svelte.ts les branche.
import type { PassGarde } from "../paiement/pass";

export type Progres = { etape: "abonnement" } | { etape: "compte" } | { etape: "fini"; salonsFermes: number };

/** (a) ou (b) a échoué (réseau, serveur, limite) : rien n'est supprimé, l'écran propose « Réessayer ». */
export class ErreurAbonnement extends Error {
  constructor() {
    super("abonnement");
  }
}

export type DepsSuppression = {
  /** Vérifications avant toute suppression (attente après une récupération) ; rejette pour arrêter. */
  avant: () => Promise<void>;
  /** Pass connus (coffre privé et appareil, sans doublon ni commande en attente). */
  passes: () => Promise<PassGarde[]>;
  resilier: (pass: Uint8Array<ArrayBuffer>) => Promise<"ok" | "aucun" | "erreur">;
  revoquer: (pass: Uint8Array<ArrayBuffer>) => Promise<"ok" | "renouvellement" | "erreur">;
  /** POST supprimer ; rend le nombre de salons fermés. */
  supprimerCompte: () => Promise<number>;
  /** L'appareil oublie le compte (session, copie gardée). */
  oublierCompte: () => Promise<void>;
  /** Pass traités (identifiants de l'appareil) et jetons : effacés de l'appareil. */
  oublierPass: (ids: readonly string[]) => Promise<void>;
  /** Effacement de toutes les données du site sur cet appareil (storage/appareil.ts), toujours. */
  effacerAppareil: () => Promise<void>;
};

export async function* supprimerTout(d: DepsSuppression): AsyncGenerator<Progres> {
  await d.avant();
  const passes = await d.passes();
  if (passes.length > 0) {
    yield { etape: "abonnement" };
    for (const g of passes) {
      if (g.moyen !== "offert" && (await d.resilier(g.pass)) === "erreur") throw new ErreurAbonnement();
      if ((await d.revoquer(g.pass)) !== "ok") throw new ErreurAbonnement();
    }
  }
  yield { etape: "compte" };
  const salonsFermes = await d.supprimerCompte();
  await d.oublierCompte();
  if (passes.length > 0) await d.oublierPass(passes.map((g) => g.id)).catch(() => undefined);
  await d.effacerAppareil();
  yield { etape: "fini", salonsFermes };
}

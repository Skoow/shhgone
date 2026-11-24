// Appels des salons réservés aux offres Plus et Pro (décision du propriétaire, 24 novembre ;
// conception des appels §5.1) : ce que le portefeuille de cet appareil en sait. Le serveur ouvre
// les appels d'un salon, pour tous ses membres et jusqu'à sa fin, contre un jeton anonyme
// (Privacy Pass, jetons.ts) : jamais le pass, jamais un compte. Utilisé par salon/appel-offre.ts.
//
// - `offresAppel` : formules dont un pass payé est gardé sur CET appareil, lues sur l'appareil
//   seulement (aucune requête : entrer dans un salon ne date pas le pass pour le serveur). Sert
//   à l'écran (« Réservé aux offres Plus et Pro » sans pass).
// - `jetonAppel` : un jeton, demandé seulement quand le serveur a répondu que les appels sont
//   fermés (402) ; d'abord un jeton gardé, sinon un lot obtenu tout de suite (écart résiduel S16
//   de la conception du paiement §7, écrit) ; puis réapprovisionnement à une heure tirée au hasard.
// Apps (D42-20) : mêmes règles, rien de propre au navigateur.
import type { OffrePayante } from "./api";
import { planifierReapprovisionnement, prendreJeton } from "./jetons";
import { idbDuNavigateur, lireEtatGarde, lirePasses } from "./pass";

/** Formules (Plus, Pro) dont un pass payé est gardé ici ; un pass connu échu, non payé, sans le droit ou en attente ne compte pas. */
export async function offresAppel(idb: IDBFactory | null = idbDuNavigateur(), maintenant: Date = new Date()): Promise<OffrePayante[]> {
  if (idb === null) return [];
  const auj = maintenant.toISOString().slice(0, 10);
  const out = new Set<OffrePayante>();
  for (const g of await lirePasses(idb)) {
    if (g.enAttente) continue;
    const e = await lireEtatGarde(idb, g.id).catch(() => null);
    // État gardé (au plus d'un jour) : il fait foi ; sans état, le serveur tranchera.
    if (e !== null && (e.etat !== "payee" || e.fin === null || e.fin <= auj || !e.droits.includes("appel_audio"))) continue;
    out.add(g.offre);
  }
  return (["plus", "pro"] as const).filter((o) => out.has(o));
}

/** Un jeton anonyme d'une formule qui comprend les appels, retiré du portefeuille ; null sans pass ni jeton. */
export async function jetonAppel(idb: IDBFactory | null = idbDuNavigateur()): Promise<string | null> {
  if (idb === null) return null;
  for (const o of await offresAppel(idb)) {
    try {
      const j = await prendreJeton(idb, o);
      planifierReapprovisionnement(idb, o);
      return j;
    } catch {
      // aucune réserve pour cette formule (révoqué, épuisé, clé refusée) : la suivante
    }
  }
  return null;
}

// Offres rangées dans le coffre privé du compte (pass Plus ou Pro payé, ou accès offert ;
// conception du paiement §6.2), pour la confirmation de la suppression du compte. Lecture
// LOCALE seulement : le pass du coffre et, s'il existe, l'état gardé chiffré sur cet appareil
// (paiement/pass.ts, lireEtatGarde) pour la date de fin ; aucune requête (POST /etat enverrait le
// pass et le daterait). Un pass que l'état gardé dit fini, révoqué ou non payé n'est pas compté ;
// sans état gardé ici, la date de fin n'est pas connue (null) : l'écran le dit.
import type { EtatGarde } from "../paiement/pass";
import { passDeEntree } from "./pass";
import type { CoffrePrive } from "./vaults";

export type Abonnement = { offre: "plus" | "pro"; /** `fin` du serveur, « AAAA-MM-JJ » UTC, exclue (dernier jour valable : la veille), ou null s'il n'est pas connu ici */ fin: string | null; renouvelle: boolean; offert: boolean };

export async function abonnementsDuCompte(prive: CoffrePrive | undefined, etatGarde: (id: string) => Promise<EtatGarde | null>, aujourdhui: string): Promise<Abonnement[]> {
  const out: Abonnement[] = [];
  for (const e of prive?.pass ?? []) {
    const g = passDeEntree(e);
    if (g === null) continue;
    const etat = await etatGarde(g.id).catch(() => null);
    if (etat !== null && (etat.etat !== "payee" || (etat.fin !== null && etat.fin <= aujourdhui))) continue;
    out.push({ offre: etat?.offre ?? g.offre, fin: etat?.fin ?? null, renouvelle: g.moyen !== "offert" && (etat?.renouvelle ?? g.renouvelle), offert: g.moyen === "offert" });
  }
  return out;
}

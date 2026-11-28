// Offres du compte (pass Plus ou Pro payé, ou accès offert ; conception du paiement §6.2) : pass
// rangés dans le coffre privé du compte ET pass de cet appareil (base des pass, paiement/pass.ts), réunis par
// leurs octets. Pour la carte « Votre compte » et la suppression du compte. Lecture LOCALE
// seulement : la date de fin vient de l'état gardé chiffré sur cet appareil (paiement/pass.ts,
// lireEtatGarde) ; aucune requête (POST /etat enverrait le pass et le daterait, et, faite depuis
// la page Compte, rapprocherait le pass du compte). Une commande encore en attente sur
// l'appareil n'est pas une offre. Un pass que l'état gardé dit fini, révoqué ou non payé n'est pas
// compté ; sans état gardé ici, la date de fin n'est pas connue (null) : l'écran le dit.
import type { EtatGarde, PassGarde } from "../paiement/pass";
import { passDeEntree } from "./pass";
import type { CoffrePrive } from "./vaults";

export type Abonnement = { /** identifiant du pass (appareil, sinon coffre) */ id: string; offre: "plus" | "pro"; /** `fin` du serveur, « AAAA-MM-JJ » UTC, exclue (dernier jour valable : la veille), ou null s'il n'est pas connu ici */ fin: string | null; renouvelle: boolean; /** renouvellement commandé, puis arrêté : « ne sera pas renouvelé » */ arrete: boolean; offert: boolean };

const meme = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Pass connus du compte et de l'appareil, sans doublon (même octets : l'enregistrement de
 * l'appareil, dont l'identifiant porte l'état gardé) ; commandes en attente exclues.
 */
export function passConnus(prive: CoffrePrive | undefined, ici: readonly PassGarde[]): PassGarde[] {
  const out = ici.filter((g) => !g.enAttente);
  for (const e of prive?.pass ?? []) {
    const g = passDeEntree(e);
    if (g !== null && !out.some((x) => meme(x.pass, g.pass))) out.push(g);
  }
  return out;
}

export async function abonnementsDe(connus: readonly PassGarde[], etatGarde: (id: string) => Promise<EtatGarde | null>, aujourdhui: string): Promise<Abonnement[]> {
  const out: Abonnement[] = [];
  for (const g of connus) {
    const etat = await etatGarde(g.id).catch(() => null);
    if (etat !== null && (etat.etat !== "payee" || (etat.fin !== null && etat.fin <= aujourdhui))) continue;
    const offert = g.moyen === "offert";
    const renouvelle = !offert && (etat?.renouvelle ?? g.renouvelle);
    out.push({ id: g.id, offre: etat?.offre ?? g.offre, fin: etat?.fin ?? null, renouvelle, arrete: !offert && g.renouvelle && !renouvelle, offert });
  }
  // Pro d'abord, puis la fin la plus lointaine (la carte montre la première).
  return out.sort((a, b) => (a.offre === b.offre ? (b.fin ?? "").localeCompare(a.fin ?? "") : a.offre === "pro" ? -1 : 1));
}

// Formules payantes détenues sur cet appareil, sans le moteur de chiffrement (la page Offres,
// page d'information, la lit pour marquer « votre offre » ; check-dist interdit le moteur
// dans ces pages). Réexportée par jetons.ts.
import { lireEtat, netParDefaut, type Net, type OffrePayante } from "./api";
import { garder, garderEtat, lireEtatGarde, lirePasses, type EtatGarde } from "./pass";

const jour = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Formules payantes utilisables sur cet appareil : pass gardés que le serveur dit payés et non
 * échus. Aucune requête sans pass gardé. L'état de chaque pass (POST /etat, qui envoie P) est
 * demandé au plus une fois par jour UTC : gardé chiffré sur l'appareil (pass.ts, garderEtat) et
 * resservi le même jour, sauf événement qui l'a oublié (pass rangé de nouveau ou oublié, émission
 * refusée, résiliation). Sans cela, chaque chargement datait le pass pour le serveur.
 */
export async function formulesDisponibles(idb: IDBFactory, n: Net = netParDefaut(), maintenant: Date = new Date()): Promise<OffrePayante[]> {
  const out = new Set<OffrePayante>();
  const auj = jour(maintenant);
  for (const g of await lirePasses(idb)) {
    const garde = await lireEtatGarde(idb, g.id);
    let e: EtatGarde | null = garde !== null && garde.jour === auj ? garde : null;
    if (e === null) {
      const lu = await lireEtat(g.pass, n);
      if (lu !== null) {
        e = { ...lu, jour: auj };
        await garderEtat(idb, g.id, e).catch(() => undefined);
      }
    }
    if (e?.etat === "payee" && g.enAttente) {
      // Paiement confirmé alors que la page de retour a été fermée avant (crypto, webhook
      // tardif) : la commande n'est plus en attente, sans quoi ni jeton (reapprovisionner), ni
      // appel, ni rangement dans le compte ne la prendraient. garder()
      // oublie l'état gardé : il est rangé de nouveau.
      await garder(idb, { ...g, enAttente: false }).catch(() => undefined);
      await garderEtat(idb, g.id, e).catch(() => undefined);
    }
    if (e?.etat === "payee" && e.offre !== null && e.fin !== null && e.fin > auj) out.add(e.offre);
  }
  return (["plus", "pro"] as const).filter((x) => out.has(x));
}


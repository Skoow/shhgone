// « Effacer les données de cet appareil » (page Compte, suppression du compte) : ce que le site
// garde dans ce navigateur, hors session du compte (account/persist.ts, oubliée à part) :
// - les retours gardés sur les partages ouverts (storage/returns.ts, D42-22) ;
// - les preuves de membre des salons et leur réglage « silencieux » (salon/preuve.ts) ;
// - « Mes partages » (storage/partages.svelte.ts) : les liens de gestion gardés ici partent ;
//   sans compte, la gestion de ces partages est alors perdue (l'écran le dit) ;
// - les bases retirées (ancien historique des liens, historique des téléchargements retiré par
//   D42-33), s'il en restait (storage/ancien-historique.ts).
// Chaque part au mieux, au plus 2 s : une base tenue par un autre onglet ne bloque jamais le reste.
import { effacerTout as effacerPreuves } from "../salon/preuve";
import { effacerAncienHistorique } from "./ancien-historique";
import { effacerPartages } from "./partages.svelte";
import { pageReturns } from "./returns";

const auPlus = (p: Promise<unknown>, ms = 2000) => Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((ok) => setTimeout(ok, ms))]);

export async function effacerDonneesAppareil(): Promise<void> {
  await Promise.all([auPlus(pageReturns().clear()), auPlus(effacerPreuves()), auPlus(effacerAncienHistorique()), auPlus(effacerPartages())]);
}

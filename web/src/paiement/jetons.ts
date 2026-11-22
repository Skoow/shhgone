// Portefeuille de jetons anonymes de cet appareil (conception du paiement §7, §11) : une formule
// payante est disponible quand un pass payé (état « payee » chez le serveur) est gardé ici ; un
// partage payant dépense un jeton, obtenu en aveugle (moteur Rust, Privacy Pass) : le serveur
// signe sans voir le jeton, puis l'accepte sans savoir de quel pass il vient.
//
// Règles :
// - jetons demandés par petits lots (JETONS_PAR_LOT) et gardés chiffrés à côté du pass (pass.ts) ;
//   un jeton n'est valable que le jour de sa clé et le lendemain (S9) : les plus vieux sont jetés ;
// - S16 (heure d'émission) : un lot est demandé EN AVANCE, à une heure tirée au hasard
//   (planifierReapprovisionnement, appelé après chaque dépense : la réserve est refaite pour le
//   partage suivant), et un partage dépense d'abord un jeton « mûr », obtenu au moins MUR_MS
//   avant. Écart résiduel, assumé (attendre ferait attendre la personne) : réserve vide au moment
//   d'un partage (premier partage payant, ou après deux jours sans, ou réserve vidée avant l'heure
//   tirée) → lot demandé tout de suite, émission et dépense à quelques secondes d'écart. Pas de
//   réapprovisionnement au simple chargement de la page : un jeton vit deux jours au plus et
//   chaque jeton jeté est un partage payé perdu (réserve de 30 par période pour Plus) ;
// - l'état secret de chaque demande (nonce, facteur d'aveuglement) ne quitte jamais cette
//   fonction et est mis à zéro ;
// - aucun réseau ici (source-rules.test.ts) : tout passe par api.ts.
// Apps (D42-20) : rien de propre au navigateur. Mêmes routes et format de jeton ; l'heure
// d'obtention est locale (jamais envoyée) ; la minuterie devient celle de l'app (au premier plan).
import { b64u } from "../engine/pure";
import { jetonFinaliser, jetonPreparer } from "./moteur";
import { emettre, lireCles, lireEtat, netParDefaut, type Net, type OffrePayante } from "./api";
import { garderJeton, lireJetons, lirePasses, retirerJeton } from "./pass";

/** Jetons demandés par requête (au plus 5 côté serveur). */
export const JETONS_PAR_LOT = 3;
/** Réserve visée : en dessous, un réapprovisionnement programmé demande un lot. */
export const RESERVE_MIN = 1;
/** Âge à partir duquel un jeton gardé est « mûr » (dépensé en priorité, S16). */
export const MUR_MS = 5 * 60_000;
/** Délai du réapprovisionnement programmé, tiré au hasard dans [min, max). */
export const DELAI_MIN_MS = 5 * 60_000;
export const DELAI_MAX_MS = 30 * 60_000;

const jour = (d: Date) => d.toISOString().slice(0, 10);
/** Un jeton de la clé du jour `j` est encore accepté aujourd'hui (son jour ou le lendemain). */
export function jetonValable(j: string, maintenant: Date = new Date()): boolean {
  const veille = new Date(maintenant.getTime() - 86_400_000);
  return j === jour(maintenant) || j === jour(veille);
}

/** Délai aléatoire (crypto.getRandomValues) dans [DELAI_MIN_MS, DELAI_MAX_MS). */
export function delaiAleatoire(u: Uint32Array = crypto.getRandomValues(new Uint32Array(1))): number {
  return DELAI_MIN_MS + Math.floor((u[0]! / 2 ** 32) * (DELAI_MAX_MS - DELAI_MIN_MS));
}

/**
 * Formules payantes utilisables sur cet appareil : pass gardés que le serveur dit payés et non
 * échus. Aucune requête sans pass gardé.
 */
export async function formulesDisponibles(idb: IDBFactory, n: Net = netParDefaut(), maintenant: Date = new Date()): Promise<OffrePayante[]> {
  const out = new Set<OffrePayante>();
  for (const g of await lirePasses(idb)) {
    const e = await lireEtat(g.pass, n);
    if (e?.etat === "payee" && e.offre !== null && e.fin !== null && e.fin > jour(maintenant)) out.add(e.offre);
  }
  return (["plus", "pro"] as const).filter((x) => out.has(x));
}

/** Un lot de jetons de la formule `offre`, obtenu en aveugle avec un pass payé ; null sinon. */
async function obtenirLot(idb: IDBFactory, offre: OffrePayante, n: Net, maintenant: Date): Promise<{ jetons: string[]; jour: string } | null> {
  const passes = (await lirePasses(idb)).filter((g) => g.offre === offre && !g.enAttente);
  if (passes.length === 0) return null; // aucune requête sans pass
  const cles = await lireCles(n);
  const cle = cles?.cles.find((c) => c.offre === offre && c.jour === jour(maintenant));
  if (!cles || !cle) return null;
  for (const g of passes) {
    const demandes = [];
    for (let i = 0; i < JETONS_PAR_LOT; i++) demandes.push(await jetonPreparer(cle.spki, cles.emetteur));
    try {
      const rep = await emettre(
        g.pass,
        demandes.map((d) => d.requete),
        n,
      );
      if (rep === "aucun" || rep === null || rep.offre !== offre) continue;
      const jetons: string[] = [];
      for (let i = 0; i < demandes.length; i++) jetons.push(b64u(await jetonFinaliser(cle.spki, cles.emetteur, demandes[i]!.etat, rep.reponses[i]!)));
      return { jetons, jour: cle.jour };
    } finally {
      for (const d of demandes) d.etat.fill(0);
    }
  }
  return null;
}

// Réapprovisionnement en cours, par base et par formule : une dépense l'attend plutôt que de
// demander un second lot en même temps.
const enCours = new WeakMap<IDBFactory, Map<OffrePayante, Promise<number>>>();

/**
 * Réapprovisionnement (S16) : si la réserve de jetons valables de `offre` est sous RESERVE_MIN,
 * un lot est demandé et gardé entier (aucun n'est dépensé tout de suite). Rend le nombre de
 * jetons obtenus ; 0 sans pass payé de cette formule, réserve suffisante ou échec (jamais d'erreur).
 */
export function reapprovisionner(idb: IDBFactory, offre: OffrePayante, n: Net = netParDefaut(), maintenant: Date = new Date()): Promise<number> {
  let parOffre = enCours.get(idb);
  if (!parOffre) enCours.set(idb, (parOffre = new Map()));
  const deja = parOffre.get(offre);
  if (deja) return deja;
  const m = parOffre;
  const p = (async () => {
    try {
      const reserve = (await lireJetons(idb)).filter((j) => j.offre === offre && jetonValable(j.jour, maintenant));
      if (reserve.length >= RESERVE_MIN) return 0;
      const lot = await obtenirLot(idb, offre, n, maintenant);
      if (lot === null) return 0;
      for (const j of lot.jetons) await garderJeton(idb, { jeton: j, offre, jour: lot.jour, obtenu: maintenant.getTime() });
      return lot.jetons.length;
    } catch {
      return 0;
    } finally {
      m.delete(offre);
    }
  })();
  m.set(offre, p);
  return p;
}

export type Minuteur = (f: () => void, ms: number) => () => void;
const minuteurParDefaut: Minuteur = (f, ms) => {
  const id = setTimeout(f, ms);
  return () => clearTimeout(id);
};
const planifiees = new WeakMap<IDBFactory, Map<OffrePayante, () => void>>();

/**
 * Programme un réapprovisionnement de `offre` à une heure tirée au hasard (delaiAleatoire), tant
 * que l'application reste ouverte ; une seule minuterie par formule. Rend de quoi l'annuler.
 */
export function planifierReapprovisionnement(
  idb: IDBFactory,
  offre: OffrePayante,
  o: { n?: Net; minuteur?: Minuteur; horloge?: () => Date; apres?: (p: Promise<number>) => void } = {},
): () => void {
  let parOffre = planifiees.get(idb);
  if (!parOffre) planifiees.set(idb, (parOffre = new Map()));
  const deja = parOffre.get(offre);
  if (deja) return deja;
  const m = parOffre;
  const arreter = (o.minuteur ?? minuteurParDefaut)(() => {
    if (m.get(offre) === annuler) m.delete(offre);
    const p = reapprovisionner(idb, offre, o.n ?? netParDefaut(), (o.horloge ?? (() => new Date()))());
    o.apres?.(p);
  }, delaiAleatoire());
  const annuler = () => {
    if (m.get(offre) !== annuler) return;
    m.delete(offre);
    arreter();
  };
  m.set(offre, annuler);
  return annuler;
}

/**
 * Un jeton de la formule `offre` (base64url, 472 caractères), retiré du portefeuille : d'abord un
 * jeton gardé mûr, puis le plus près d'expirer ; sinon (réserve vide, écart résiduel S16) un lot
 * obtenu tout de suite, dont le reste est gardé. Erreur « aucun_jeton » si aucun n'est disponible
 * (pas de pass, réserve du serveur épuisée, révoqué).
 */
export async function prendreJeton(idb: IDBFactory, offre: OffrePayante, n: Net = netParDefaut(), maintenant: Date = new Date()): Promise<string> {
  await enCours.get(idb)?.get(offre);
  const t = maintenant.getTime();
  const candidats = [];
  for (const j of await lireJetons(idb)) {
    if (!jetonValable(j.jour, maintenant)) {
      await retirerJeton(idb, j.id).catch(() => undefined);
      continue;
    }
    if (j.offre === offre) candidats.push(j);
  }
  const mur = (j: { obtenu: number }) => (t - j.obtenu >= MUR_MS ? 0 : 1);
  candidats.sort((a, b) => mur(a) - mur(b) || (a.jour < b.jour ? -1 : a.jour > b.jour ? 1 : 0) || a.obtenu - b.obtenu);
  const pris = candidats[0];
  if (pris) {
    await retirerJeton(idb, pris.id);
    return pris.jeton;
  }
  const lot = await obtenirLot(idb, offre, n, maintenant);
  if (lot === null) throw new Error("aucun_jeton");
  for (const j of lot.jetons.slice(1)) await garderJeton(idb, { jeton: j, offre, jour: lot.jour, obtenu: t });
  return lot.jetons[0]!;
}

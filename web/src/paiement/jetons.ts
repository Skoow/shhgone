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
import { emettre, lireCles, lireEtat, netParDefaut, type CleJetons, type Net, type OffrePayante } from "./api";
import {
  garder,
  garderCleVue,
  garderEtat,
  garderJeton,
  lireClesVues,
  lireEtatGarde,
  lireJetons,
  lirePasses,
  nouvelId,
  oublierEtat,
  retirerCleVue,
  retirerJeton,
  type CleVue,
  type EtatGarde,
} from "./pass";

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
      // appel, ni rangement dans le compte ne la prendraient (revue du 25 novembre). garder()
      // oublie l'état gardé : il est rangé de nouveau.
      await garder(idb, { ...g, enAttente: false }).catch(() => undefined);
      await garderEtat(idb, g.id, e).catch(() => undefined);
    }
    if (e?.etat === "payee" && e.offre !== null && e.fin !== null && e.fin > auj) out.add(e.offre);
  }
  return (["plus", "pro"] as const).filter((x) => out.has(x));
}

export type ClesVerifiees = { emetteur: string; cles: CleJetons[]; refusees: { jour: string; offre: OffrePayante }[] };

/**
 * S17 : clés servies par GET /api/paiement/jetons/cles (aujourd'hui à J+7), comparées à celles
 * que cet appareil a déjà vues. Une clé différente pour un (jour, formule) déjà vu est refusée,
 * et ce (jour, formule) le reste (même si le serveur revient ensuite à l'ancienne) : ni émission
 * ni dépense sous lui. Une clé jamais vue est gardée (rien à comparer). Avec un pass gardé
 * seulement (sinon rien n'est écrit : la base n'est pas créée). Null : clés indisponibles.
 * Limite écrite (§7, §15) : un serveur qui donne à cet appareil ses propres clés dès le premier
 * contact n'est pas détecté ici ; seul un second chemin (une autre personne, les apps) le peut.
 */
export async function clesVerifiees(idb: IDBFactory, n: Net = netParDefaut(), maintenant: Date = new Date()): Promise<ClesVerifiees | null> {
  const servies = await lireCles(n);
  if (servies === null) return null;
  if ((await lirePasses(idb)).length === 0) return { emetteur: servies.emetteur, cles: servies.cles, refusees: [] };
  const veille = jour(new Date(maintenant.getTime() - 86_400_000));
  const vues = new Map<string, CleVue>();
  for (const v of await lireClesVues(idb)) {
    if (v.jour < veille) await retirerCleVue(idb, v.id).catch(() => undefined);
    else vues.set(`${v.jour}/${v.offre}`, v);
  }
  const cles: CleJetons[] = [];
  const refusees: ClesVerifiees["refusees"] = [];
  for (const c of servies.cles) {
    const spki = b64u(c.spki);
    const v = vues.get(`${c.jour}/${c.offre}`);
    if (v === undefined) {
      const nv: CleVue = { id: "c:" + nouvelId(), jour: c.jour, offre: c.offre, spki, differente: false };
      await garderCleVue(idb, nv);
      vues.set(`${c.jour}/${c.offre}`, nv); // la même réponse ne peut pas en donner deux
      cles.push(c);
    } else if (!v.differente && v.spki === spki) cles.push(c);
    else {
      if (!v.differente) {
        v.differente = true;
        await garderCleVue(idb, v);
      }
      // Déjà acceptée plus haut dans cette même réponse : retirée aussi.
      const i = cles.findIndex((x) => x.jour === c.jour && x.offre === c.offre);
      if (i >= 0) cles.splice(i, 1);
      if (!refusees.some((r) => r.jour === c.jour && r.offre === c.offre)) refusees.push({ jour: c.jour, offre: c.offre });
    }
  }
  return { emetteur: servies.emetteur, cles, refusees };
}

/** (jour, formule) refusés par S17, d'après les clés vues sur cet appareil (aucune requête). */
async function refuseesLocales(idb: IDBFactory): Promise<Set<string>> {
  return new Set((await lireClesVues(idb)).filter((v) => v.differente).map((v) => `${v.jour}/${v.offre}`));
}

/**
 * S17, pour l'écran : formules dont la clé d'aujourd'hui est refusée sur cet appareil, et s'il
 * reste un refus (avertissement). Lu sur l'appareil seulement, aucune requête.
 */
export async function refusCles(idb: IDBFactory, maintenant: Date = new Date()): Promise<{ avertir: boolean; formules: OffrePayante[] }> {
  const veille = jour(new Date(maintenant.getTime() - 86_400_000));
  const r = (await lireClesVues(idb)).filter((v) => v.differente && v.jour >= veille);
  return { avertir: r.length > 0, formules: (["plus", "pro"] as const).filter((o) => r.some((v) => v.offre === o && v.jour === jour(maintenant))) };
}

/**
 * Un lot de jetons de la formule `offre`, obtenu en aveugle avec un pass payé ; null sinon.
 * Erreur « cle_differente » si la clé du jour est refusée (S17).
 */
async function obtenirLot(idb: IDBFactory, offre: OffrePayante, n: Net, maintenant: Date): Promise<{ jetons: string[]; jour: string } | null> {
  const passes = (await lirePasses(idb)).filter((g) => g.offre === offre && !g.enAttente);
  if (passes.length === 0) return null; // aucune requête sans pass
  const cles = await clesVerifiees(idb, n, maintenant);
  if (cles?.refusees.some((r) => r.offre === offre && r.jour === jour(maintenant))) throw new Error("cle_differente");
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
      // Refus (révoqué, échu, réserve épuisée) : l'état gardé de ce pass n'est plus sûr.
      if (rep === "aucun") await oublierEtat(idb, g.id).catch(() => undefined);
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
      const refusees = await refuseesLocales(idb);
      const reserve = (await lireJetons(idb)).filter((j) => j.offre === offre && jetonValable(j.jour, maintenant) && !refusees.has(`${j.jour}/${j.offre}`));
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
  const refusees = await refuseesLocales(idb); // S17 : jamais dépensé sous une clé refusée
  const candidats = [];
  for (const j of await lireJetons(idb)) {
    if (!jetonValable(j.jour, maintenant)) {
      await retirerJeton(idb, j.id).catch(() => undefined);
      continue;
    }
    if (j.offre === offre && !refusees.has(`${j.jour}/${j.offre}`)) candidats.push(j);
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

// État de « Mes partages » pour les écrans (pages /envois et /salons, « Lien prêt », « Salon prêt ») et pour
// la synchronisation du compte (account/session.svelte.ts). Ouvre le stockage une seule fois :
// IndexedDB en production (base PARTAGES_DB), mémoire dans la démo (origine partagée de
// GitHub Pages : rien n'y est écrit) ; indisponible → `statut: "indisponible"`, et « Lien prêt »
// montre alors le lien de gestion. Une simple visite de « Mes partages » ne crée rien ; le premier
// envoi (ou salon) crée la base. Lire la liste ne fait aucune requête ; le suivi en direct passe
// par partages-relecture.ts (page affichée et visible).
import { getDemo } from "../app/demo-hooks";
import { destroyShare, watchShares } from "../index";
import { idbBackend, memoryBackend, type Backend } from "./idb";
import { PARTAGES_DB, estActif, ouvrirPartages, type NouveauPartage, type Partage, type Partages, type Sorte } from "./partages";
import { patchDetruit, relecteur, type ErreurRelecture, type Relecteur } from "./partages-relecture";

export const mesPartages = $state({
  statut: "attente" as "attente" | "lecture" | "pret" | "indisponible",
  liste: [] as Partage[],
  /** Dernière relecture ou suppression échouée, par identifiant : l'entrée garde son dernier état connu. */
  erreurs: {} as Record<string, ErreurRelecture>,
});

/** Ajout ou retrait fait sur cet appareil (synchronisation du compte). */
export type Changement = { sorte: "ajout" | "retrait"; partage: Partage };
const auditeurs = new Set<(c: Changement) => void>();
export function surChangement(f: (c: Changement) => void): () => void {
  auditeurs.add(f);
  return () => void auditeurs.delete(f);
}
function signaler(c: Changement): void {
  for (const f of [...auditeurs])
    try {
      f(c);
    } catch {
      // un auditeur en échec ne bloque pas la liste
    }
}

function choisir(): Backend | null {
  if (getDemo()) return memoryBackend();
  try {
    const idb = globalThis.indexedDB;
    return idb ? idbBackend(idb, PARTAGES_DB) : null;
  } catch {
    return null; // accès refusé (navigation privée stricte, cadres)
  }
}
let choisi: Backend | null | undefined;
const backend = () => (choisi === undefined ? (choisi = choisir()) : choisi);

/** Tests : remplace le stockage (null : indisponible) et oublie l'ouverture en cours. */
export function configurerPartages(b: Backend | null | undefined): void {
  choisi = b;
  ouverture = undefined;
  relect = undefined;
  mesPartages.statut = "attente";
  mesPartages.liste = [];
  mesPartages.erreurs = {};
}

const persister = async (): Promise<unknown> => globalThis.navigator?.storage?.persist?.();

let ouverture: Promise<Partages | null> | undefined;
/** Ouvre en créant au besoin (clé, base) : seulement pour écrire. Un échec n'est pas gardé. */
function stock(): Promise<Partages | null> {
  return (ouverture ??= ouvrirPartages({ backend: backend(), persist: persister })
    .catch(() => null)
    .then((s) => {
      if (s === null) ouverture = undefined;
      return s;
    }));
}
/** Ouvre sans rien créer ; « absent » : aucune base encore sur cet appareil. */
async function lireSansCreer(): Promise<Partages | null | "absent"> {
  if (ouverture) return ouverture;
  const b = backend();
  if (!b) return null;
  try {
    if (!(await b.exists())) return "absent";
  } catch {
    return null;
  }
  return stock();
}

async function recharger(s: Partages): Promise<void> {
  mesPartages.liste = await s.liste();
}

/** Lecture locale (aucune requête). */
export async function chargerPartages(): Promise<void> {
  if (mesPartages.statut === "attente") mesPartages.statut = "lecture";
  const s = await lireSansCreer();
  if (s === "absent") {
    mesPartages.liste = [];
    mesPartages.statut = "pret";
    return;
  }
  if (!s) return void (mesPartages.statut = "indisponible");
  try {
    await recharger(s);
    mesPartages.statut = "pret";
  } catch {
    mesPartages.statut = "indisponible";
  }
}

/**
 * « Lien prêt », « Salon prêt » : garde le partage (lien de gestion et mesures ; jamais le lien de
 * partage ni le mot de passe). Rend l'identifiant, ou null si l'appareil ne peut rien garder.
 */
export async function garderPartage(n: NouveauPartage): Promise<string | null> {
  const s = await stock();
  if (!s) {
    mesPartages.statut = "indisponible";
    return null;
  }
  try {
    const p = await s.ajouter(n);
    await recharger(s);
    mesPartages.statut = "pret";
    signaler({ sorte: "ajout", partage: p });
    return p.id;
  } catch {
    return null;
  }
}

/** « Retirer de la liste » : sur cet appareil (et dans le compte) ; le partage n'est pas détruit. */
export async function retirerPartage(id: string): Promise<void> {
  const s = await stock();
  if (!s) return;
  const p = await s.get(id).catch(() => null);
  await s.retirer(id).catch(() => undefined);
  delete mesPartages.erreurs[id];
  await recharger(s).catch(() => undefined);
  if (p) signaler({ sorte: "retrait", partage: p });
}

/**
 * « Effacer l'historique » (Mes partages, Mes salons ; 28 novembre) : retire de la liste les
 * entrées TERMINÉES de la sorte donnée (détruites ou échues), sur cet appareil et dans le compte ;
 * les entrées en cours restent. Rien n'est détruit sur le serveur (une entrée terminée n'y existe
 * plus). Rend le nombre d'entrées retirées.
 */
export async function retirerTermines(sorte: Sorte, now = Date.now()): Promise<number> {
  const s = await stock();
  if (!s) return 0;
  const finis = (await s.liste().catch(() => [] as Partage[])).filter((p) => p.sorte === sorte && !estActif(p, now));
  for (const p of finis) {
    await s.retirer(p.id).catch(() => undefined);
    delete mesPartages.erreurs[p.id];
    signaler({ sorte: "retrait", partage: p });
  }
  await recharger(s).catch(() => undefined);
  return finis.length;
}

/** « Supprimer » sur « Lien prêt » : l'entrée du même partage est notée détruite. */
export async function noterDetruit(id: string): Promise<void> {
  const s = await stock();
  if (!s) return;
  await s.modifier(id, patchDetruit(Date.now())).catch(() => undefined);
  await recharger(s).catch(() => undefined);
}

let relect: Relecteur | undefined;
async function relecteurPret(): Promise<Relecteur | null> {
  const s = await stock();
  if (!s) return null;
  return (relect ??= relecteur(s, {
    surveiller: (suivis, signal) => watchShares(suivis.map((x) => ({ manage: x.gestion, opensUsed: x.opensUsed, state: x.state })), location.origin, signal),
    detruire: (g) => destroyShare(g, location.origin),
    now: () => Date.now(),
    visible: () => document.visibilityState === "visible",
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    change: () => {
      void stock().then((st) => {
        if (st && relect) mesPartages.erreurs = relect.erreurs();
        return st ? recharger(st) : undefined;
      });
    },
  }));
}

/** Affichage de « Mes partages » (page visible) : suit les envois actifs en direct jusqu'à arreterRelecture. */
export async function relirePartages(): Promise<void> {
  if (mesPartages.liste.length === 0) return; // rien à suivre : aucune base ouverte ni créée
  const r = await relecteurPret();
  if (!r) return;
  await r.suivre();
}
export function arreterRelecture(): void {
  relect?.arreter();
}

/** « Supprimer » : détruit le partage pour tout le monde. Rend vrai si c'est fait. */
export async function detruirePartage(id: string): Promise<boolean> {
  const r = await relecteurPret();
  const s = await stock();
  if (!r || !s) return false;
  const e = await r.detruire(id);
  if (e) mesPartages.erreurs[id] = e;
  else delete mesPartages.erreurs[id];
  await recharger(s).catch(() => undefined);
  return e === null;
}

// ---------- Compte (account/session.svelte.ts) ----------

/** Toutes les entrées (lecture locale) ; aucune base : []. */
export async function tousLesPartages(): Promise<Partage[]> {
  const s = await lireSansCreer();
  if (!s || s === "absent") return [];
  return s.liste().catch(() => []);
}

/** Entrées venues du coffre privé du compte (origine « compte ») : gardées, sans signal. */
export async function importerPartages(list: readonly Partage[]): Promise<void> {
  if (list.length === 0) return;
  const s = await stock();
  if (!s) return;
  for (const p of list) await s.garder(p).catch(() => false);
  await recharger(s).catch(() => undefined);
}

/** Retire des entrées (retirées du compte ailleurs), sans signal. */
export async function retirerPartages(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const s = await lireSansCreer();
  if (!s || s === "absent") return;
  for (const id of ids) await s.retirer(id).catch(() => undefined);
  await recharger(s).catch(() => undefined);
}

/** Déconnexion : les entrées venues du compte partent ; celles créées ici restent. */
export async function retirerPartagesDuCompte(): Promise<void> {
  const list = await tousLesPartages();
  await retirerPartages(list.filter((p) => p.origine === "compte").map((p) => p.id));
}

/** « Effacer les données de cet appareil » : toute la liste, clé comprise. */
export async function effacerPartages(): Promise<void> {
  await backend()?.drop();
  ouverture = undefined;
  relect = undefined;
  mesPartages.liste = [];
  mesPartages.erreurs = {};
}

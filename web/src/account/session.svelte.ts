// Le compte sur cet appareil (conception 2026-11-22-compte-passkey-design.md §3, §5, §9 ;
// conception du compte §9, §10, §21.2 pour ce qu'elle ne remplace pas). Seul
// détenteur du jeton de session et de K_compte (règle de §37.3, source-rules.test.ts) ; les
// écrans n'importent que ce module, derrière __COMPTES__.
// - Passkey : navigator.credentials seulement dans navigateur.ts (via webauthn.ts), avec des options chargées AVANT
//   le clic (preparerInscription, preparerConnexion, preparerReauth, preparerAjout : Safari annule
//   une cérémonie précédée d'une requête). Ni la sortie PRF, ni la clé de récupération R, ni
//   K_compte ne partent : seulement les enveloppes (60 octets), A_r (route recup), v_r.
// - K_compte s'ouvre par une enveloppe PRF de la passkey (toutes essayées), sinon par la clé
//   locale de l'appareil (persist.ts), sinon par la clé de récupération, demandée une fois avec
//   la raison à l'écran (jamais de repli silencieux, §5.5). Obtenue autrement que par une
//   enveloppe alors qu'une sortie PRF existe : enveloppe réparée (reparation.ts) ; sinon la clé
//   reste gardée sur l'appareil (persist.ts, même sans « Rester connecté »).
// - Deux coffres (vaults.ts), chiffrés par des clés tirées de K_compte : profil (pseudo, photo,
//   langue, réglages, pass) et privé (liens, salons). Le service ne lit ni l'un ni l'autre.
//   L'écriture du coffre privé après un événement de partage ou de salon est différée de 2 à 12
//   min, tirées au hasard (§37.11 A-G2).
// - Pseudo : règle et p_canon du module du salon (src/salon/engine.ts), chargé seulement ici.
// - Déconnexion : le serveur oublie la session (au mieux) ; l'appareil efface la base de
//   persist.ts (session gardée ET clé locale), K_compte et le clair des coffres.
// - Historique de l'appareil (sync.ts) : fusion avec le coffre privé à l'ouverture, puis chaque
//   ajout ou retrait part dans l'écriture différée. Déconnexion, session échue, ou démarrage sans
//   session gardée : les entrées venues du compte sont retirées de l'appareil (§37.11 A-G8).
import * as api from "./api";
import { synchroniserPass } from "./pass";
import { netParDefaut, type Ceremonie, type Net, type Preuve } from "./api";
import { aleatoire32, clesDuCompte, enveloppePrf, enveloppeRecup, ouvrirEnveloppesPrf, ouvrirRecup, type ClesCompte } from "./keys";
import { creerCoffre, ouvrir, priveDeJson, priveEnJson, priveVide, profilDeJson, profilEnJson, sceller, type Coffre, type CoffrePrive, type Profil, type Sorte } from "./vaults";
import { nomAppareil, ouvrirEtiquette, scellerEtiquette } from "./device";
import { effacer, idbDuNavigateur, lire, lireCle, oublierSession, sauver, sauverCle } from "./persist";
import { reparer, type Lien, type Resultat } from "./reparation";
import * as recupCle from "./recup";
import { creer, obtenir, optionsAssertion, optionsCreation, passkeysDisponibles, prfApresCreation, signalerInconnue, type Creation, type Parcours } from "./webauthn";
import { b64u, unb64u } from "../engine/pure";
import { entreePrf } from "../engine/index";
import { loadSalonEngine, type SalonEngine } from "../salon/engine";
import { allEntries, dropAccountEntries, dropEntries, importEntries, onLocalChange, setAccountPrefs } from "../history/live.svelte";
import type { HistoryEntry } from "../history/store";
import { ajouterEntree, fusionner, renommerEntree, retirerEntree } from "./sync";
import { partagesConnus, supprimerTout as suppression, type Progres } from "./suppression";
import { clearDownloads } from "../downloads/live.svelte";
import { clearHistory } from "../history/live.svelte";
import { destroyShare } from "../index";

export type { Profil, Reglages, CoffrePrive } from "./vaults";
export { REGLAGES_DEFAUT } from "./vaults";
export { CompteError, type Preuve, type EtatServeur } from "./api";
export type { Progres } from "./suppression";
export { passkeysDisponibles };
export { estMobile } from "./device";
export type { Parcours };

type Bytes = Uint8Array<ArrayBuffer>;
type PseudoMoteur = Pick<SalonEngine, "pseudoValide" | "cleUnicite" | "pseudoReserve">;

type Deps = {
  net: Net;
  idb: () => IDBFactory | null;
  agent: () => string;
  /** Lance `f` dans `ms` ; rend l'annulation. */
  planifier: (ms: number, f: () => void) => () => void;
  salon: () => Promise<PseudoMoteur>;
  /** E_prf du moteur (32 octets). */
  ePrf: () => Promise<Uint8Array>;
  /** Historique de l'appareil (history/live.svelte.ts). */
  historique: Historique;
  /** Suppression du compte : destruction d'un partage par son lien de gestion, effacement de l'appareil. */
  detruirePartage: (lienGestion: string) => Promise<void>;
  effacerAppareil: () => Promise<void>;
  maintenant: () => number;
  /** RP ID des passkeys (hôte du site) : signalUnknownCredential. */
  rpId: () => string;
};

/** Ce que la session voit de l'historique de l'appareil. */
export type Historique = {
  lister(): Promise<HistoryEntry[]>;
  importer(es: readonly HistoryEntry[]): Promise<void>;
  retirer(ids: readonly string[]): Promise<void>;
  retirerCompte(): Promise<void>;
  ecouter(f: (c: { kind: "add" | "remove" | "rename"; entry: HistoryEntry }) => void): () => void;
  regler(p: { keepReceived: boolean } | null): void;
};

const defaut = (): Deps => ({
  net: netParDefaut(),
  idb: idbDuNavigateur,
  agent: () => globalThis.navigator?.userAgent ?? "",
  planifier: (ms, f) => {
    const t = setTimeout(f, ms);
    return () => clearTimeout(t);
  },
  salon: loadSalonEngine,
  ePrf: entreePrf,
  historique: { lister: allEntries, importer: importEntries, retirer: dropEntries, retirerCompte: dropAccountEntries, ecouter: onLocalChange, regler: setAccountPrefs },
  // Même origine que la page (démo : base du dépôt) ; secret de gestion seul, jamais le jeton de session.
  detruirePartage: (l) => destroyShare(l, globalThis.location?.origin ?? ""),
  effacerAppareil: async () => {
    await clearHistory().catch(() => undefined);
    await clearDownloads().catch(() => undefined);
  },
  maintenant: () => Date.now(),
  rpId: () => globalThis.location?.hostname ?? "",
});
let deps: Deps = defaut();

/** Tests : remplace les accès au réseau, au stockage, à l'horloge et aux moteurs. */
export function configurerCompte(d: Partial<Deps>): void {
  deps = { ...deps, ...d };
}

// --- État visible des écrans -----------------------------------------------------------------

class EtatCompte {
  /** absent : aucune session ; verrouille : session gardée, coffres en cours d'ouverture ; ouvert. */
  etat = $state<"absent" | "verrouille" | "ouvert">("absent");
  profil = $state.raw<Profil | undefined>(undefined);
  prive = $state.raw<CoffrePrive | undefined>(undefined);
  /** Coffre illisible (mauvaise clé, gen plus petit que le dernier vu) : bandeau de §12.4. */
  erreur = $state.raw<"coffre_illisible" | undefined>(undefined);
  /** Session ouverte par la clé de récupération, pas encore renouvelée (Q10 : bandeau). */
  recupere = $state(false);
  /** « Rester connecté » : la session est gardée sur cet appareil (persist.ts). */
  persistante = $state(false);
  /** Les données s'ouvrent ici grâce à une clé gardée sur l'appareil (§5.5 : dit à l'écran). */
  cleLocale = $state(false);
  /** Le compte vient d'être supprimé depuis cette page : l'écran de fin reste affiché. */
  supprime = $state(false);
}
export const account = new EtatCompte();

// --- Secrets en mémoire ----------------------------------------------------------------------

type Ouverte = {
  jeton: string;
  h: Bytes;
  kCompte: Bytes;
  cles: ClesCompte;
  persistante: boolean;
  /** Passkey liée à la session (connexion, réauthentification), ou null (clé de récupération). */
  credId: Bytes | null;
  profil: Coffre<Profil>;
  prive: Coffre<CoffrePrive>;
};
let ouverte: Ouverte | null = null;

/** Cérémonie chargée d'avance (5 min au serveur ; refaite au-delà de 4 min 30). */
type Prete = Ceremonie & { recue: number };
const VALIDITE_MS = 270_000;
let inscription: (Prete & { ePrf: Uint8Array }) | null = null;
let connexionPrete: Prete | null = null;
let reauthPrete: Prete | null = null;
let ajoutPret: Prete | null = null;
let ePrfCache: Uint8Array | null = null;
let salonCharge: PseudoMoteur | null = null;

/** Inscription en cours, passkey créée : rien n'existe encore côté serveur. */
type Creee = { etape: string; h: Bytes; c: Creation; parcours: Parcours; prf: Bytes | null; affiche: string; pCanon: string; profil: Profil; kCompte: Bytes; r: Bytes; texte: string };
let creee: Creee | null = null;
/** Ajout de passkey en cours (deuxième geste attendu pour la sortie PRF). */
let ajoutEnCours: { etape: string; c: Creation; nom: string; parcours: Parcours } | null = null;
/** Connexion par passkey dont les données ne s'ouvrent pas ici : clé de récupération attendue. */
let cleAttendue: { ouv: api.Ouverture; prf: Bytes | null; persistante: boolean } | null = null;
/** Nouvelle clé de récupération montrée, pas encore enregistrée. */
let nouvelleCle: { r: Bytes; texte: string } | null = null;

let attente: { patches: ((p: CoffrePrive) => CoffrePrive)[]; annuler: () => void } | null = null;
let arreterEcoute: (() => void) | null = null;

const fraiche = (p: Prete | null): p is Prete => p !== null && deps.maintenant() - p.recue < VALIDITE_MS;

function oublierEtapes(): void {
  creee?.kCompte.fill(0);
  creee?.r.fill(0);
  creee?.prf?.fill(0);
  cleAttendue?.prf?.fill(0);
  nouvelleCle?.r.fill(0);
  creee = cleAttendue = nouvelleCle = ajoutEnCours = null;
  inscription = connexionPrete = reauthPrete = ajoutPret = null;
}

/** Efface tout ce que la page tient du compte (ce que fait aussi un rechargement). */
function oublierMemoire(): void {
  attente?.annuler();
  attente = null;
  arreterEcoute?.();
  arreterEcoute = null;
  ouverte?.kCompte.fill(0);
  ouverte = null;
  oublierEtapes();
  account.etat = "absent";
  account.profil = account.prive = account.erreur = undefined;
  account.recupere = false;
  account.persistante = false;
  account.cleLocale = false;
}
/** Tests : simule un rechargement de la page. */
export const _oublierMemoire = oublierMemoire;

const illisibles = new Set(["coffre_illisible", "coffre_recule", "coffre_version", "enveloppe_invalide"]);

/** Session échue (401) : l'appareil oublie la session ; coffre illisible : signalé à l'écran. */
async function garde<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof api.CompteError && e.status === 401) await oublierAppareil();
    else if (e instanceof Error && illisibles.has(e.message)) account.erreur = "coffre_illisible";
    throw e;
  }
}

async function oublierAppareil(): Promise<void> {
  oublierMemoire();
  const idb = deps.idb();
  if (idb) await effacer(idb).catch(() => undefined);
  await oublierHistoriqueDuCompte();
}

/** Entrées venues du compte retirées de l'appareil ; la page ne suit plus le réglage du compte. */
async function oublierHistoriqueDuCompte(): Promise<void> {
  deps.historique.regler(null);
  await deps.historique.retirerCompte().catch(() => undefined);
}

/**
 * Fusion de l'historique de l'appareil et du coffre privé (sync.ts), puis écoute des ajouts et
 * retraits faits ici (écriture différée). Au mieux : un échec laisse la session ouverte.
 */
async function synchroniser(o: Ouverte): Promise<void> {
  const h = deps.historique;
  h.regler({ keepReceived: o.profil.valeur.reglages.garderRecus });
  arreterEcoute = h.ecouter((c) => {
    if (ouverte !== o) return;
    const f = (p: CoffrePrive) => (c.kind === "add" ? ajouterEntree(p, c.entry) : c.kind === "rename" ? renommerEntree(p, c.entry) : retirerEntree(p, c.entry));
    void ecrirePrive(f, { differe: true }).catch(() => undefined);
  });
  try {
    const local = await h.lister();
    const r = fusionner(local, o.prive.valeur, { now: Date.now() });
    if (r.retirer.length > 0) await h.retirer(r.retirer);
    if (r.importer.length > 0) await h.importer(r.importer);
    if (r.coffre !== null && ouverte === o) {
      // Sur 409, la fusion est refaite sur le coffre relu.
      await ecrireTout(o, [(p) => fusionner(local, p, { now: Date.now() }).coffre ?? p]);
    }
  } catch {
    // Historique illisible ou coffre refusé : la session reste ouverte ; la prochaine connexion refusionne.
  }
  // Pass des offres payantes (conception du paiement §6.2) : appareil ↔ coffre privé.
  try {
    const idb = deps.idb();
    if (idb && ouverte === o) {
      const patch = await synchroniserPass(idb, o.prive.valeur);
      if (patch && ouverte === o) await ecrireTout(o, [patch]);
    }
  } catch {
    // Au mieux, comme l'historique : la prochaine connexion recommence.
  }
}

async function memoriser(o: Ouverte): Promise<void> {
  const idb = deps.idb();
  // Session oubliée entre-temps (déconnexion ici ou dans un autre onglet) : jamais réécrite.
  if (!o.persistante || !idb || ouverte !== o) return;
  await sauver(idb, { jeton: o.jeton, h: o.h, kCompte: o.kCompte, credId: o.credId, parRecup: account.recupere, genProfil: o.profil.gen, genPrive: o.prive.gen }).catch(() => undefined);
}

function transport(jeton: string, sorte: Sorte) {
  return {
    lire: () => api.lireCoffre(deps.net, jeton, sorte),
    ecrire: (ifGen: number, blob: Bytes) => api.ecrireCoffre(deps.net, jeton, sorte, ifGen, blob),
  };
}

type Source<T> = { blob: Uint8Array; gen: number } | { relire: number } | { valeur: T; gen: number };

/** Ouvre la session : coffres déjà lus, à relire (`relire`) ou déjà en clair (`valeur`). */
async function ouvrirSession(s: { jeton: string; h: Bytes; kCompte: Bytes; persistante: boolean; credId: Bytes | null; recupere: boolean; cleLocale: boolean; profil: Source<Profil>; prive: Source<CoffrePrive> }): Promise<void> {
  const cles = await clesDuCompte(s.kCompte);
  const coffre = async <T>(sorte: Sorte, src: Source<T>, versJson: (v: T) => Bytes, deJson: (b: Uint8Array) => T, vide: T) => {
    const gen = "relire" in src ? src.relire : src.gen;
    const valeur = "valeur" in src ? src.valeur : "blob" in src ? deJson(await ouvrir(sorte, cles[sorte], s.h, src.blob, src.gen)) : vide;
    const c = creerCoffre<T>({ sorte, cle: cles[sorte], h: s.h, transport: transport(s.jeton, sorte), versJson, deJson, valeur, gen });
    if ("relire" in src) await c.relire();
    return c;
  };
  const profil = await coffre<Profil>("profil", s.profil, profilEnJson, profilDeJson, undefined as unknown as Profil);
  const prive = await coffre<CoffrePrive>("prive", s.prive, priveEnJson, priveDeJson, priveVide());
  oublierMemoire();
  ouverte = { jeton: s.jeton, h: s.h, kCompte: s.kCompte, cles, persistante: s.persistante, credId: s.credId, profil, prive };
  account.persistante = s.persistante;
  account.profil = profil.valeur;
  account.prive = prive.valeur;
  account.etat = "ouvert";
  account.supprime = false;
  account.recupere = s.recupere;
  account.cleLocale = s.cleLocale;
  const o = ouverte;
  await memoriser(o);
  await synchroniser(o);
}

async function etiquette(cle: CryptoKey, h: Uint8Array, nom?: string): Promise<Bytes> {
  return scellerEtiquette(cle, h, nom ?? nomAppareil(deps.agent()));
}

/** Nom d'appareil de la session, au mieux (K_etiquette n'est connue qu'après la réponse). */
async function nommerSession(o: Ouverte): Promise<void> {
  await etiquette(o.cles.etiquette, o.h)
    .then((e) => api.etiquetterSession(deps.net, o.jeton, e))
    .catch(() => undefined);
}

async function salon(): Promise<PseudoMoteur> {
  return (salonCharge ??= await deps.salon());
}
async function ePrf(): Promise<Uint8Array> {
  return (ePrfCache ??= await deps.ePrf());
}

/** Pseudo affiché et p_canon ; réservé : Error("pseudo_reserve") ; règle du salon (§39.4). */
function pseudoCanonDe(s: PseudoMoteur, p: string): { affiche: string; pCanon: string } {
  const affiche = s.pseudoValide(p);
  const pCanon = s.cleUnicite(affiche);
  if (s.pseudoReserve(pCanon)) throw new Error("pseudo_reserve");
  return { affiche, pCanon };
}
async function pseudoCanon(p: string): Promise<{ affiche: string; pCanon: string }> {
  return pseudoCanonDe(await salon(), p);
}

// --- Saisie (écrans) ----------------------------------------------------------------------------

/**
 * Vérifie sur l'appareil, sans requête, le pseudo saisi : pseudo_longueur, pseudo_caracteres,
 * pseudo_ecritures, pseudo_reserve. Objet vide : rien à redire.
 */
export async function verifierSaisie(s: { pseudo?: string }): Promise<Partial<Record<"pseudo", string>>> {
  if (s.pseudo === undefined) return {};
  try {
    await pseudoCanon(s.pseudo);
    return {};
  } catch (e) {
    if (e instanceof Error) return { pseudo: e.message };
    throw e;
  }
}

// --- Inscription (§3.1, §5.2) -----------------------------------------------------------------

/**
 * Charge la cérémonie d'inscription (preuve anti-robot faite par l'écran) avant le clic, ainsi que
 * E_prf et la règle du pseudo : le clic sur « Créer avec une passkey » n'attend plus aucune requête.
 */
export async function preparerInscription(preuve: Preuve): Promise<void> {
  const [c, e] = await Promise.all([api.inscriptionDebut(deps.net, preuve), ePrf(), salon()]);
  inscription = { ...c, recue: deps.maintenant(), ePrf: e };
}

/** La cérémonie d'inscription est chargée et encore valable. */
export function inscriptionPrete(): boolean {
  return inscription !== null && fraiche(inscription);
}

/**
 * Geste « Créer avec une passkey » : navigator.credentials.create tout de suite (aucune requête
 * avant). « cle » : la clé de récupération est prête (cleAffichee) ; « second » : le gestionnaire
 * annonce PRF sans l'avoir rendu, un deuxième geste est nécessaire (deuxiemeGeste). Annulation :
 * Error("annule"), rien n'est créé. `parcours` (§18) : « hybride » sur ordinateur (passkey sur le
 * téléphone, QR), « local » (« cet ordinateur »), « defaut » sur téléphone ou tablette.
 */
export async function creerPasskey(pseudo: string, langue: string, parcours: Parcours = "defaut"): Promise<"cle" | "second"> {
  const ins = inscription;
  if (!ins || !fraiche(ins) || !salonCharge) throw new Error("aucune_etape");
  const { affiche, pCanon } = pseudoCanonDe(salonCharge, pseudo);
  const user = ins.options.user as { id?: unknown } | undefined;
  const h = typeof user?.id === "string" ? unb64u(user.id) : new Uint8Array(0);
  if (h.length !== 16) throw new Error("reponse_invalide");
  const c = await creer(optionsCreation(ins.options, affiche, ins.ePrf, parcours));
  const profil: Profil = { pseudo: affiche, photo: null, langue, reglages: { proposerProfil: true, garderRecus: true }, pass: null };
  const r = recupCle.nouvelleCle();
  creee?.kCompte.fill(0);
  creee = { etape: ins.etape, h, c, parcours, prf: c.prf, affiche, pCanon, profil, kCompte: aleatoire32(), r, texte: await recupCle.affichage(r) };
  return c.prf === null && c.prfAnnonce ? "second" : "cle";
}

/**
 * Où est la passkey de l'inscription en cours (§18) : « telephone » (autre appareil, par QR),
 * « ici » (cet appareil), d'après ce que dit le navigateur, sinon d'après le parcours demandé.
 * Lu localement, jamais envoyé ; sert à proposer « Ajouter mon téléphone » après la création.
 */
export function passkeyCreee(): "telephone" | "ici" {
  if (!creee) throw new Error("aucune_etape");
  const a = creee.c.attachement;
  if (a === "cross-platform") return "telephone";
  if (a === "platform") return "ici";
  return creee.parcours === "hybride" ? "telephone" : "ici";
}

/** Deuxième geste (§3.1, 2 bis) : la sortie PRF de la passkey créée ; faux si toujours absente. */
export async function deuxiemeGeste(): Promise<boolean> {
  const c = creee;
  if (!c) throw new Error("aucune_etape");
  c.prf = await prfApresCreation(c.c.rpId, c.c.credId, await ePrf(), c.parcours);
  return c.prf !== null;
}

/** Texte de la clé de récupération de l'inscription en cours (montré une fois, jamais envoyé). */
export function cleAffichee(): string {
  if (!creee) throw new Error("aucune_etape");
  return creee.texte;
}

/**
 * « Terminer » (§3.1, écran 4) : enveloppes, coffres et libellés faits ici, puis inscription/fin.
 * Le compte n'existe qu'à partir d'ici. Erreur du serveur (pseudo_pris, étape échue…) :
 * l'inscription reste en cours.
 */
export async function terminerInscription(persistante: boolean): Promise<void> {
  const c = creee;
  if (!c) throw new Error("aucune_etape");
  const h = c.h;
  const { aR, vR, kekR } = await recupCle.derivees(c.r);
  try {
    const cles = await clesDuCompte(c.kCompte);
    const env = c.prf ? await enveloppePrf(c.prf, h, c.c.credId, c.kCompte) : null;
    const envR = await enveloppeRecup(kekR, h, c.kCompte);
    const blobProfil = await sceller("profil", cles.profil, h, 1, profilEnJson(c.profil));
    const blobPrive = await sceller("prive", cles.prive, h, 1, priveEnJson(priveVide()));
    const r = await api.inscriptionFin(deps.net, {
      etape: c.etape,
      credential: c.c.credential,
      pCanon: c.pCanon,
      env,
      vR,
      envR,
      blobProfil,
      blobPrive,
      persistante,
      etiquette: await etiquette(cles.etiquette, h),
      credEtiquette: await etiquette(cles.etiquette, h),
    });
    if (r.h.some((x, i) => x !== h[i])) throw new Error("reponse_invalide");
    const kCompte = c.kCompte;
    const avecPrf = c.prf !== null;
    c.r.fill(0);
    c.prf?.fill(0);
    creee = null;
    inscription = null;
    // Passkey sans PRF : le premier appareil garde K_compte (§5.5).
    if (!avecPrf) await garderCle(h, kCompte);
    await ouvrirSession({ jeton: r.session, h, kCompte, persistante, credId: c.c.credId, recupere: false, cleLocale: !avecPrf, profil: { blob: blobProfil, gen: 1 }, prive: { valeur: priveVide(), gen: 1 } });
  } finally {
    aR.fill(0);
    kekR.fill(0);
  }
}

/**
 * Inscription abandonnée après la création de la passkey (R11) : le gestionnaire l'oublie
 * (signalUnknownCredential) là où c'est possible ; vrai si c'est fait, faux si l'écran doit dire
 * de la supprimer à la main.
 */
export async function abandonnerInscription(): Promise<boolean> {
  const c = creee;
  oublierEtapes();
  if (!c) return true;
  return signalerInconnue(c.c.rpId, c.c.credId);
}

async function garderCle(h: Uint8Array, kCompte: Uint8Array): Promise<void> {
  const idb = deps.idb();
  if (idb) await sauverCle(idb, { h, kCompte }).catch(() => undefined);
}

// --- Connexion (§3.2, §3.3, §5.3) --------------------------------------------------------------

/** Charge la cérémonie de connexion avant le clic (à l'ouverture de la page). */
export async function preparerConnexion(): Promise<void> {
  const [c] = await Promise.all([api.connexionDebut(deps.net), ePrf()]);
  connexionPrete = { ...c, recue: deps.maintenant() };
}

/**
 * Geste « Se connecter avec une passkey » : navigator.credentials.get tout de suite (cérémonie
 * chargée d'avance ; sinon chargée maintenant, ce que Safari peut refuser). « ouvert » ; ou
 * « cle_requise » : la passkey a connecté le compte mais n'ouvre pas les données sur cet appareil
 * (pas de PRF, ou sortie PRF différente) et l'appareil n'en garde aucune clé : ouvrirAvecCle.
 * `parcours` (§18) : « hybride » sur ordinateur (passkey du téléphone, QR), « local », « defaut ».
 */
export async function seConnecter(persistante: boolean, parcours: Parcours = "defaut"): Promise<"ouvert" | "cle_requise"> {
  let c = connexionPrete;
  connexionPrete = null;
  if (!fraiche(c)) c = { ...(await api.connexionDebut(deps.net)), recue: deps.maintenant() };
  const a = await obtenir(optionsAssertion(c.options, await ePrf(), parcours));
  const ouv = await api.connexionFin(deps.net, { etape: c.etape, credential: a.credential, persistante, etiquette: null });
  const parEnveloppe = a.prf ? await ouvrirEnveloppesPrf(a.prf, ouv.h, ouv.credId, ouv.enveloppes) : null;
  let kCompte: Bytes | null = parEnveloppe;
  const idb = deps.idb();
  if (!kCompte && idb) kCompte = await lireCle(idb, ouv.h);
  if (!kCompte) {
    cleAttendue?.prf?.fill(0);
    cleAttendue = { ouv, prf: a.prf, persistante };
    return "cle_requise";
  }
  try {
    await garde(() => ouvrirSession({ jeton: ouv.session, h: ouv.h, kCompte: kCompte!, persistante, credId: ouv.credId, recupere: false, cleLocale: parEnveloppe === null, profil: { blob: ouv.blobProfil, gen: ouv.genProfil }, prive: { blob: ouv.blobPrive, gen: ouv.genPrive } }));
  } catch (e) {
    kCompte.fill(0);
    a.prf?.fill(0);
    throw e;
  }
  const o = ouverte!;
  await nommerSession(o);
  // Clé locale, sortie PRF sans enveloppe qui s'ouvre : réparation (session liée et récente).
  if (parEnveloppe === null && a.prf) {
    const res = await reparer({ h: o.h, kCompte: o.kCompte, lien: { credId: ouv.credId, prf: a.prf, enveloppes: ouv.enveloppes }, poser: (env) => api.passkeysEnveloppe(deps.net, o.jeton, env) });
    if (res === "posee" || res === "deja") account.cleLocale = false;
  }
  a.prf?.fill(0);
  return "ouvert";
}

/** Une connexion par passkey attend la clé de récupération (raison dite à l'écran). */
export function cleRequise(): boolean {
  return cleAttendue !== null;
}

/** Renonce à la clé de récupération après une connexion par passkey : la session ouverte au serveur est fermée. */
export async function annulerCle(): Promise<void> {
  const c = cleAttendue;
  cleAttendue = null;
  c?.prf?.fill(0);
  if (c) await revoquer(c.ouv.session);
}

/**
 * Clé de récupération tapée (§3.3 c, §3.4, §5.4) : contrôle local (erreurs cle_recup_*, sans
 * requête), puis recup avec A_r seulement. Après une connexion par passkey dont les données ne
 * s'ouvraient pas : la clé doit être celle du même compte (sinon cle_autre_compte), l'enveloppe
 * de la passkey est réparée par sa session (liée et récente), qui est ensuite fermée ; la session
 * gardée est celle de la clé (marquée « par la clé de récupération » pour les autres appareils).
 * Si aucune enveloppe ne marche après, la clé reste gardée sur l'appareil (§5.5).
 */
export async function ouvrirAvecCle(saisie: string, persistanteSeule = false): Promise<Resultat | "recup"> {
  const r = await recupCle.lire(saisie);
  const att = cleAttendue;
  const persistante = att ? att.persistante : persistanteSeule;
  const { aR, kekR, vR } = await recupCle.derivees(r);
  r.fill(0);
  vR.fill(0);
  let o: api.OuvertureRecup;
  try {
    o = await api.recup(deps.net, { aR, persistante, etiquette: null });
  } finally {
    aR.fill(0);
  }
  let kCompte: Bytes;
  try {
    if (att && o.h.some((x, i) => x !== att.ouv.h[i])) {
      await revoquer(o.session);
      throw new Error("cle_autre_compte");
    }
    kCompte = await ouvrirRecup(kekR, o.h, o.envR);
  } finally {
    kekR.fill(0);
  }
  let res: Resultat | "recup" = "recup";
  if (att) {
    cleAttendue = null;
    res = await reparer({ h: o.h, kCompte, lien: { credId: att.ouv.credId, prf: att.prf, enveloppes: att.ouv.enveloppes }, poser: (env) => api.passkeysEnveloppe(deps.net, att.ouv.session, env) });
    att.prf?.fill(0);
    await revoquer(att.ouv.session);
  }
  const cleGardee = att !== null && res !== "posee" && res !== "deja";
  if (cleGardee) await garderCle(o.h, kCompte);
  try {
    await garde(() => ouvrirSession({ jeton: o.session, h: o.h, kCompte, persistante, credId: null, recupere: true, cleLocale: cleGardee, profil: { blob: o.blobProfil, gen: o.genProfil }, prive: { blob: o.blobPrive, gen: o.genPrive } }));
  } catch (e) {
    kCompte.fill(0);
    throw e;
  }
  await nommerSession(ouverte!);
  return res;
}

// --- Réauthentification (session récente, 5 min) --------------------------------------------------

/** Charge la cérémonie de réauthentification avant le clic (écran qui en aura besoin). */
export async function preparerReauth(): Promise<void> {
  const o = ouverteOuErreur();
  const [c] = await Promise.all([garde(() => api.reauthDebut(deps.net, o.jeton)), ePrf()]);
  reauthPrete = { ...c, recue: deps.maintenant() };
}

/** Assertion de réauthentification ; rend la passkey qui a signé (la session lui est liée). */
async function reauthLien(o: Ouverte): Promise<Lien> {
  let c = reauthPrete;
  reauthPrete = null;
  if (!fraiche(c)) c = { ...(await garde(() => api.reauthDebut(deps.net, o.jeton))), recue: deps.maintenant() };
  const a = await obtenir(optionsAssertion(c.options, await ePrf()));
  const envs = await garde(() => api.reauthFin(deps.net, o.jeton, c.etape, a.credential));
  if (ouverte === o) o.credId = a.credId;
  return { credId: a.credId, prf: a.prf, enveloppes: envs };
}

/**
 * Geste « Confirmer avec une passkey » : la session devient récente (5 min) et liée à la passkey
 * qui a signé ; au passage, son enveloppe PRF est réparée si besoin.
 */
export async function confirmerParPasskey(): Promise<void> {
  const o = ouverteOuErreur();
  const l = await reauthLien(o);
  try {
    const res = await reparer({ h: o.h, kCompte: o.kCompte, lien: l, poser: (env) => api.passkeysEnveloppe(deps.net, o.jeton, env) });
    if (res === "posee" || res === "deja") account.cleLocale = false;
  } finally {
    l.prf?.fill(0);
  }
}

// --- Passkeys du compte (§3.5) ----------------------------------------------------------------------

/** Une passkey vue par l'écran : libellé déchiffré ICI (null : aucun ou illisible). */
export type PasskeyVue = { id: string; ajoutee: string; nom: string | null; synchronisable: boolean; ouvre: boolean; courante: boolean };

export async function listePasskeys(): Promise<PasskeyVue[]> {
  const o = ouverteOuErreur();
  const l = await garde(() => api.passkeys(deps.net, o.jeton));
  const courante = o.credId ? b64u(o.credId) : "";
  return Promise.all(
    l.map(async (p) => ({ id: b64u(p.credId), ajoutee: p.ajoutee, nom: p.etiquette ? await ouvrirEtiquette(o.cles.etiquette, o.h, p.etiquette) : null, synchronisable: p.be, ouvre: p.prf, courante: b64u(p.credId) === courante })),
  );
}

/** Charge la cérémonie d'ajout (session récente) avant le clic ; « recent » : confirmerParPasskey d'abord. */
export async function preparerAjout(): Promise<"pret" | "recent"> {
  const o = ouverteOuErreur();
  try {
    const [c] = await Promise.all([garde(() => api.passkeysDebut(deps.net, o.jeton)), ePrf()]);
    ajoutPret = { ...c, recue: deps.maintenant() };
    return "pret";
  } catch (e) {
    if (e instanceof api.CompteError && e.status === 403 && e.code === "recent") return "recent";
    throw e;
  }
}

/**
 * Geste « Créer la passkey » (après preparerAjout) : « ajoutee », ou « second » (sortie PRF
 * annoncée mais pas rendue : finirAjout après un deuxième geste). Ajoutée sur cet appareil avec PRF :
 * elle ouvre les données ici (enveloppe téléversée). « Ajouter mon téléphone » (§18) : parcours
 * « hybride » (QR du navigateur) ; c'est le même ajout standard, aucun transfert de clé : la sortie
 * PRF de la passkey du téléphone, si elle revient par le QR, sert à poser son enveloppe ; sinon la
 * passkey est ajoutée sans enveloppe (repli §5.5 sur le téléphone) : « sans_prf ».
 */
export async function ajouterPasskey(nom: string, parcours: Parcours = "defaut"): Promise<"ajoutee" | "sans_prf" | "second"> {
  ouverteOuErreur();
  const p = ajoutPret;
  ajoutPret = null;
  if (!fraiche(p)) throw new Error("aucune_etape");
  const c = await creer(optionsCreation(p.options, account.profil?.pseudo ?? "", await ePrf(), parcours));
  ajoutEnCours = { etape: p.etape, c, nom, parcours };
  if (c.prf === null && c.prfAnnonce) return "second";
  const avec = c.prf !== null;
  await finirAjout(c.prf);
  return avec ? "ajoutee" : "sans_prf";
}

/** Fin de l'ajout ; `prf` : sortie obtenue (création ou deuxième geste), ou null. */
async function finirAjout(prf: Bytes | null): Promise<void> {
  const o = ouverteOuErreur();
  const a = ajoutEnCours;
  if (!a) throw new Error("aucune_etape");
  try {
    const env = prf ? await enveloppePrf(prf, o.h, a.c.credId, o.kCompte) : null;
    const nom = a.nom.trim() === "" ? nomAppareil(deps.agent()) : a.nom.trim();
    const et = await scellerEtiquette(o.cles.etiquette, o.h, nom);
    await garde(() => api.passkeysFin(deps.net, o.jeton, { etape: a.etape, credential: a.c.credential, env, etiquette: et }));
    ajoutEnCours = null;
  } finally {
    prf?.fill(0);
  }
}

/** Deuxième geste de l'ajout ; sans sortie PRF (refus, gestionnaire) : la passkey est ajoutée sans enveloppe. */
export async function deuxiemeGesteAjout(): Promise<boolean> {
  const a = ajoutEnCours;
  if (!a) throw new Error("aucune_etape");
  let prf: Bytes | null = null;
  try {
    prf = await prfApresCreation(a.c.rpId, a.c.credId, await ePrf(), a.parcours);
  } catch (e) {
    if (!(e instanceof Error && e.message === "annule")) throw e;
  }
  const avec = prf !== null;
  await finirAjout(prf);
  return avec;
}

export async function nommerPasskey(id: string, nom: string): Promise<void> {
  const o = ouverteOuErreur();
  const e = await scellerEtiquette(o.cles.etiquette, o.h, nom.trim());
  await garde(() => api.passkeysNommer(deps.net, o.jeton, unb64u(id), e));
}

/** Retrait (session récente : 403 recent → confirmerParPasskey ; la dernière : 409 derniere). Vrai si le gestionnaire a été prévenu. */
export async function retirerPasskey(id: string): Promise<boolean> {
  const o = ouverteOuErreur();
  const credId = unb64u(id);
  await garde(() => api.passkeysRetirer(deps.net, o.jeton, credId));
  if (o.credId && b64u(o.credId) === id) o.credId = null;
  return signalerInconnue(deps.rpId(), credId);
}

// --- Nouvelle clé de récupération (§3.5, Q10) ------------------------------------------------------

/** Tire une nouvelle clé (montrée une fois) ; rien n'est envoyé avant enregistrerNouvelleCle. */
export async function preparerNouvelleCle(): Promise<string> {
  nouvelleCle?.r.fill(0);
  const r = recupCle.nouvelleCle();
  nouvelleCle = { r, texte: await recupCle.affichage(r) };
  return nouvelleCle.texte;
}

/** Enregistre la nouvelle clé (session récente : 403 recent → confirmerParPasskey) ; l'ancienne ne sert plus. */
export async function enregistrerNouvelleCle(): Promise<void> {
  const o = ouverteOuErreur();
  const n = nouvelleCle;
  if (!n) throw new Error("aucune_etape");
  const { aR, vR, kekR } = await recupCle.derivees(n.r);
  aR.fill(0);
  try {
    const envR = await enveloppeRecup(kekR, o.h, o.kCompte);
    await garde(() => api.recupRenouveler(deps.net, o.jeton, vR, envR));
  } finally {
    kekR.fill(0);
  }
  n.r.fill(0);
  nouvelleCle = null;
  account.recupere = false;
  await memoriser(o);
}

export { groupeAVerifier, groupeJuste, fichierTexte } from "./recup";

// --- État du compte ---------------------------------------------------------------------------

/** GET /api/compte : palier, dates, bannissement. */
export async function etatCompte(): Promise<api.EtatServeur> {
  const o = ouverteOuErreur();
  return garde(() => api.etat(deps.net, o.jeton));
}

// --- Pseudo ----------------------------------------------------------------------------------

/** Pseudo libre parmi les comptes ? Réservé : false, sans requête. Règle non tenue : erreur pseudo_*. */
export async function pseudoLibre(p: string): Promise<boolean> {
  let canon: string;
  try {
    canon = (await pseudoCanon(p)).pCanon;
  } catch (e) {
    if (e instanceof Error && e.message === "pseudo_reserve") return false;
    throw e;
  }
  if (ouverte) {
    const jeton = ouverte.jeton;
    return garde(() => api.pseudoVerifier(deps.net, { jeton }, canon));
  }
  if (inscription) return api.pseudoVerifier(deps.net, { etape: inscription.etape }, canon);
  throw new Error("aucune_session");
}

/**
 * Pseudo pris pour un salon hors du compte (invité, ou compte sans « Proposer mon pseudo ») :
 * libre si aucun AUTRE compte ne l'a et qu'il n'est ni réservé ni interdit. Le sien est toujours permis. Requête sans session ni salon.
 */
export async function pseudoLibreSalon(p: string): Promise<boolean> {
  let canon: string;
  try {
    canon = (await pseudoCanon(p)).pCanon;
  } catch (e) {
    if (e instanceof Error && e.message === "pseudo_reserve") return false;
    throw e;
  }
  const mien = ouverte ? account.profil?.pseudo : undefined;
  if (mien) {
    const k = await pseudoCanon(mien).then((x) => x.pCanon, () => null);
    if (k === canon) return true;
  }
  try {
    return await api.pseudoLibreInvite(deps.net, canon);
  } catch (e) {
    // Serveur sans comptes ouverts (route absente) : aucun pseudo de compte à protéger.
    if (e instanceof api.CompteError && e.status === 404) return true;
    throw e;
  }
}

/**
 * Dernier pseudo pris comme invité dans un salon de cet onglet (mémoire seulement, jamais écrit) :
 * proposé comme pseudo du compte s'il en crée un (« il garde son pseudo s'il est libre »).
 */
let pseudoInvite: string | null = null;
export function retenirPseudoInvite(p: string): void {
  pseudoInvite = p;
}
export function pseudoInviteRetenu(): string | null {
  return pseudoInvite;
}

/** Change le pseudo (une fois par 24 h, serveur), puis l'écrit dans le coffre de profil. */
export async function changerPseudo(p: string): Promise<void> {
  const o = ouverteOuErreur();
  const { affiche, pCanon } = await pseudoCanon(p);
  await garde(() => api.changerPseudo(deps.net, o.jeton, pCanon));
  await ecrireProfil({ pseudo: affiche });
}

// --- Salon ----------------------------------------------------------------------------------

/**
 * Crée un salon avec la session ouverte (conception §10.4) : en-têtes du salon (K_accès_s,
 * J_gestion, base64url) et corps faits par l'écran de création (salon/api.ts, CorpsCreation).
 * Sans session : Error("aucune_session").
 */
export async function creerSalon(entetes: { acces: string; gestion: string }, corps: Record<string, unknown>): Promise<{ expiresInS: number }> {
  const o = ouverteOuErreur();
  return garde(() => api.creerSalon(deps.net, o.jeton, entetes, corps));
}

/** Pseudo et photo du compte à proposer à l'entrée d'un salon (réglage « Proposer mon pseudo et ma photo »), ou null. */
export function profilPourSalon(): { pseudo: string; photo: Uint8Array | null } | null {
  const p = account.profil;
  if (!ouverte || !p || !p.reglages.proposerProfil) return null;
  return { pseudo: p.pseudo, photo: p.photo };
}

// --- Coffres ---------------------------------------------------------------------------------

function ouverteOuErreur(): Ouverte {
  if (!ouverte) throw new Error("aucune_session");
  return ouverte;
}

export async function ecrireProfil(patch: Partial<Profil>): Promise<void> {
  const o = ouverteOuErreur();
  const v = await garde(() => o.profil.ecrire((v) => ({ ...v, ...patch })));
  if (ouverte !== o) return;
  account.profil = v;
  // « Garder les liens que j'ouvre » : la case de la page d'ouverture suit le réglage du compte.
  if (patch.reglages) deps.historique.regler({ keepReceived: v.reglages.garderRecus });
  await memoriser(o);
}

/** Délai d'une écriture différée : 2 à 12 min, tiré par crypto.getRandomValues. */
function delai(): number {
  const r = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return 120_000 + Math.floor((r / 2 ** 32) * 600_001);
}

/**
 * Modifie le coffre privé. `differe` (événement de partage ou de salon) : la modification attend
 * 2 à 12 min ; celles qui arrivent entre-temps partent avec elle (le délai n'est pas relancé). Une
 * écriture immédiate emporte aussi celles qui attendaient. Déconnexion avant l'échéance :
 * modifications abandonnées (elles restent dans l'historique de l'appareil, fusionné à la
 * connexion suivante).
 */
export async function ecrirePrive(patch: (p: CoffrePrive) => CoffrePrive, opts: { differe: boolean }): Promise<void> {
  const o = ouverteOuErreur();
  if (opts.differe) {
    attente ??= { patches: [], annuler: deps.planifier(delai(), () => void vider().catch(() => undefined)) };
    attente.patches.push(patch);
    return;
  }
  const avant = prendreAttente();
  await ecrireTout(o, [...avant, patch]);
}

function prendreAttente(): ((p: CoffrePrive) => CoffrePrive)[] {
  const a = attente;
  attente = null;
  a?.annuler();
  return a?.patches ?? [];
}

async function vider(): Promise<void> {
  const o = ouverte;
  const ps = prendreAttente();
  if (o && ps.length > 0) await ecrireTout(o, ps);
}

async function ecrireTout(o: Ouverte, ps: ((p: CoffrePrive) => CoffrePrive)[]): Promise<void> {
  const v = await garde(() => o.prive.ecrire((p) => ps.reduce((acc, f) => f(acc), p)));
  if (ouverte === o) account.prive = v;
  await memoriser(o);
}

/**
 * Pass de l'appareil absents du coffre privé (accès offert rangé alors qu'une session est
 * ouverte : /offres/offert) : écrits tout de suite, comme à l'ouverture d'une session
 * (synchroniser). true : session ouverte, ils y sont ; false : aucune session (ils partiront à la
 * prochaine connexion). Erreur du coffre : rendue à l'appelant.
 */
export async function rangerPassDansCompte(): Promise<boolean> {
  const o = ouverte;
  const idb = deps.idb();
  if (!o || !idb) return false;
  const patch = await synchroniserPass(idb, o.prive.valeur);
  if (patch && ouverte === o) await ecrireTout(o, [patch]);
  return ouverte === o;
}

// --- Rechargement, déconnexion ----------------------------------------------------------------

/** Au démarrage : rouvre une session gardée (« Rester connecté ») ; sinon rien. Session échue : oubliée. */
export async function restaurer(): Promise<void> {
  if (ouverte) return;
  const idb = deps.idb();
  const s = idb ? await lire(idb) : null;
  // Aucune session gardée : rien d'un compte ne reste dans l'historique de l'appareil (onglet
  // fermé sans se déconnecter, session en mémoire seulement).
  if (!s) return oublierHistoriqueDuCompte();
  account.etat = "verrouille";
  const local = idb ? await lireCle(idb, s.h) : null;
  const cleLocale = local !== null;
  local?.fill(0);
  try {
    await ouvrirSession({ jeton: s.jeton, h: s.h as Bytes, kCompte: s.kCompte as Bytes, persistante: true, credId: s.credId as Bytes | null, recupere: s.parRecup, cleLocale, profil: { relire: s.genProfil }, prive: { relire: s.genPrive } });
  } catch (e) {
    s.kCompte.fill(0);
    // Session échue ou fermée ailleurs : cas attendu, l'appareil oublie la session sans erreur.
    if (e instanceof api.CompteError && e.status === 401) return oublierAppareil();
    if (e instanceof Error && illisibles.has(e.message)) account.erreur = "coffre_illisible";
    account.etat = "absent"; // réseau : la session gardée reste, un prochain restaurer() réessaie
    throw e;
  }
}

/**
 * Déconnexion : l'appareil oublie tout (clé locale comprise : la clé de récupération sera
 * redemandée là où la passkey n'ouvre pas les données), même si le serveur ne répond pas ; les
 * autres onglets du site aussi (BroadcastChannel). Sans réseau, la révocation de la session est
 * réessayée trois fois dans la minute ; le jeton n'est jamais réécrit sur l'appareil pour cela.
 */
export async function seDeconnecter(): Promise<void> {
  const jeton = ouverte?.jeton;
  const enAttente = cleAttendue?.ouv.session;
  await oublierAppareil();
  annoncerDeconnexion();
  for (const j of [jeton, enAttente]) if (j !== undefined) await revoquer(j);
}
/** Vrai si la révocation est faite ou inutile (refus du serveur) ; faux sans réseau (réessayée en arrière-plan). */
async function revoquer(jeton: string): Promise<boolean> {
  try {
    await api.deconnexion(deps.net, jeton);
    return true;
  } catch (e) {
    if (!(e instanceof api.CompteError)) void reessayerRevocation(jeton);
    return e instanceof api.CompteError;
  }
}
async function reessayerRevocation(jeton: string): Promise<void> {
  for (let essai = 1; essai <= 3; essai++) {
    await new Promise((r) => setTimeout(r, 5_000 * essai));
    try {
      await api.deconnexion(deps.net, jeton);
      return;
    } catch (e) {
      if (e instanceof api.CompteError) return;
    }
  }
}

// Autres onglets : une déconnexion ici efface la mémoire du compte partout sur ce site ; aucun
// secret ne passe sur le canal (un simple signal).
const CANAL = "shh-compte-onglets";
function canal(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(CANAL) : null;
  } catch {
    return null;
  }
}
function annoncerDeconnexion(): void {
  const c = canal();
  c?.postMessage("deconnexion");
  c?.close();
}
/** Écoute les déconnexions faites dans un autre onglet ; rend l'arrêt. */
export function ecouterAutresOnglets(): () => void {
  const c = canal();
  if (!c) return () => undefined;
  c.onmessage = (e) => {
    if (e.data === "deconnexion" && ouverte) oublierMemoire();
  };
  return () => c.close();
}
/** Retour sur l'onglet : une session fermée ailleurs ou échue est vue tout de suite (401). */
export async function verifierAuRetour(): Promise<void> {
  if (!ouverte) return;
  await etatCompte().catch(() => undefined);
}

// --- Appareils, export, « Rester connecté » ----------------------------------------------------------

/** Un appareil connecté (§8.5) : nom déchiffré ICI (null : aucun, ou illisible). */
export type Appareil = { sid: string; ajoutee: string; nom: string | null; courante: boolean; persistante: boolean; parRecup: boolean };

export async function appareils(): Promise<Appareil[]> {
  const o = ouverteOuErreur();
  const l = await garde(() => api.sessions(deps.net, o.jeton));
  return Promise.all(l.map(async (s) => ({ sid: s.sid, ajoutee: s.ajoutee, nom: s.etiquette ? await ouvrirEtiquette(o.cles.etiquette, o.h, s.etiquette) : null, courante: s.courante, persistante: s.persistante, parRecup: s.parRecup })));
}

export async function deconnecterAppareil(sid: string): Promise<void> {
  const o = ouverteOuErreur();
  await garde(() => api.fermerSession(deps.net, o.jeton, { sid }));
}

export async function deconnecterAutres(): Promise<void> {
  const o = ouverteOuErreur();
  await garde(() => api.fermerSession(deps.net, o.jeton, { autres: true }));
}

/**
 * « Exporter mes données » (§12.4, §21.15.4 point 10 ; conception du compte par passkey §3.6) :
 * fichier JSON fait SUR L'APPAREIL. Données du serveur (GET export), profil déchiffré, et listes
 * du coffre privé SANS leurs secrets (ni lien de gestion, ni lien de partage ou d'invitation, ni
 * identifiant). Jamais le jeton ni la clé de récupération.
 */
export async function exporterDonnees(): Promise<string> {
  const o = ouverteOuErreur();
  const x = await garde(() => api.exporter(deps.net, o.jeton));
  const p = o.profil.valeur;
  const prive = o.prive.valeur;
  const sans = (l: CoffrePrive["envois"], garder: readonly string[]) => l.map((v) => Object.fromEntries(garder.filter((k) => k in v).map((k) => [k, v[k]])));
  return JSON.stringify(
    {
      format: "shhgone-export-compte",
      v: 2,
      exporte_le: new Date(deps.maintenant()).toISOString().slice(0, 10),
      serveur: {
        cree_le: x.creeLe,
        anciennete_depuis: x.ancienneteDepuis,
        derniere_connexion_mois: x.vuMois,
        banni_jusqu: x.banniJusqu,
        banni_motif: x.banniMotif,
        salons_actifs: x.salonsActifs,
        appareils: x.sessions.map((s) => ({ ajoutee: s.ajoutee, persistante: s.persistante, par_cle_de_recuperation: s.parRecup })),
        passkeys: x.passkeys.map((k) => ({ ajoutee: k.ajoutee, synchronisable: k.be, ouvre_les_donnees: k.prf, cle_publique: k.clePub })),
      },
      profil: { pseudo: p.pseudo, photo: p.photo === null ? null : b64u(p.photo as Bytes), langue: p.langue, reglages: p.reglages, pass: p.pass },
      listes: {
        envois: sans(prive.envois, ["cree", "expire", "taille", "elements", "ouvertures_max"]),
        recus: sans(prive.recus, ["cree", "expire", "taille", "elements", "format"]),
        salons: sans(prive.salons, ["cree", "expire", "libelle"]),
        rejoints: sans(prive.rejoints, ["cree", "expire", "libelle"]),
      },
    },
    null,
    2,
  );
}

/**
 * Coupe « Rester connecté » sur cet appareil : la session gardée (persist.ts) est effacée, la
 * session reste ouverte jusqu'au rechargement ; une clé locale de l'appareil reste (§5.5).
 */
export async function arreterResterConnecte(): Promise<void> {
  const o = ouverteOuErreur();
  o.persistante = false;
  account.persistante = false;
  const idb = deps.idb();
  if (idb) await oublierSession(idb).catch(() => undefined);
}

// --- Suppression totale (suppression.ts) ----------------------------------------------------------

/** Liens de gestion des partages encore vivants que cet appareil ou le coffre privé connaît. */
async function liensASupprimer(o: Ouverte): Promise<string[]> {
  const local = await deps.historique.lister().catch(() => [] as HistoryEntry[]);
  return partagesConnus(o.prive.valeur, local, deps.maintenant());
}

/** Nombre de partages connus qui seront détruits (texte de confirmation). */
export async function partagesASupprimer(): Promise<number> {
  return (await liensASupprimer(ouverteOuErreur())).length;
}

/**
 * Supprime le compte (§21.12, §3.6) : après confirmerParPasskey (session récente). Progression
 * pour l'écran ; à la fin, chaque passkey du compte est signalée inconnue au gestionnaire là où
 * l'API existe.
 */
export function supprimerTout(opts: { effacerAppareil: boolean }): AsyncGenerator<Progres> {
  const o = ouverteOuErreur();
  let ids: Bytes[] = [];
  return suppression(opts, {
    avant: async () => {
      ids = (await garde(() => api.passkeys(deps.net, o.jeton))).map((p) => p.credId);
    },
    partages: () => liensASupprimer(o),
    detruire: (l) => deps.detruirePartage(l),
    supprimerCompte: async () => (await garde(() => api.supprimer(deps.net, o.jeton))).salonsFermes,
    oublierCompte: async () => {
      account.supprime = true; // avant que la session disparaisse : l'écran de fin reste monté
      await oublierAppareil();
      for (const id of ids) await signalerInconnue(deps.rpId(), id);
    },
    effacerAppareil: () => deps.effacerAppareil(),
  });
}

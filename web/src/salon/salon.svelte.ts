// État du salon pour les écrans : relie le client (client.ts), le fil
// (conversation.ts) et les étapes de l'interface (lien, mot de passe, explication, salon prêt,
// conversation, fin). Une seule session de salon par page, en mémoire seulement : rien n'est
// gardé dans le stockage du navigateur (hors l'historique local chiffré, sur demande : lien
// d'invitation, pour le créateur, lien de gestion, jamais le mot de passe). Les secrets
// (K_lien, S_gestion, clés) sont effacés à `oublier` (fin, départ, exclusion, page quittée).
import { generatePassword, passwordKey } from "../engine/index";
import { loadSalonEngine, type ClesSalon, type Regle, type SalonEngine } from "./engine";
import * as api from "./api";
import { SvelteSet } from "svelte/reactivity";
import { ClientSalon, type EvClient, type Fin } from "./client";
import { Conversation, type Bulle, type PieceInfo } from "./conversation";
import { Appel } from "./appel";
import { offresAppel, relaisReserve } from "./appel-offre";
import { AFFICHE_MAX, PIECE_MAX, causeLecture, envoyerPiece, lectureDefinitive, lirePiece } from "./pieces";
import { IMAGES_SURES, typeAffichage } from "./affichage";
import { previewable } from "../media/dimensions";
import { stripMetadata } from "../media/strip";
import { clickDownload, REVOKE_AFTER_MS } from "../viewers/save";
import { preparer, oublier as oublierPreparation, type Duree } from "./creation";
import { lienGestionDans, lienSalon } from "./liens";
import { captcha as captchaDuServeur, ctx as transferCtx } from "../transfer/api";
import { CAPTCHA_MIN_MS } from "../transfer/client";
import { solvePow } from "../captcha/pow";
import { allEntries, recordShare } from "../history/live.svelte";
import { b64u } from "../engine/pure";
import { lireFragment } from "./liens";
import { exclure } from "./exclusion";
import * as preuve from "./preuve";
import { finSilence } from "./son";
import { MEME_FIN_MS, seuilAAfficher, type Averti } from "./fermeture";
import { createZip, zipName, ZIP_BLOB_MAX_SMALL } from "../zip/store-zip";
import { cleMembreLocal, indexMembre } from "../engine/index";
import { KDF_CREATE } from "../engine/pure";

/**
 * Lien de gestion gardé dans l'historique local pour ce lien d'invitation (entrée `salon_cree`) : S_gestion, ou undefined. Jamais ailleurs dans le stockage du navigateur.
 */
async function gestionGardee(kLien: Uint8Array): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const frag = "#c" + b64u(kLien as Uint8Array<ArrayBuffer>);
  const e = (await allEntries().catch(() => [])).find((x) => x.sorte === "salon_cree" && x.link.endsWith(frag) && x.manage !== "");
  const f = e ? lireFragment(e.manage.slice(e.manage.lastIndexOf("#"))) : null;
  return f?.sorte === "s" ? f.cle : undefined;
}
import { creerSalon as creerAvecSession, profilPourSalon, CompteError } from "../account/session.svelte";

export type Etape = "vide" | "chargement" | "motdepasse" | "explication" | "pret" | "conversation" | "fin" | "gestion";
export type ErreurEntree = { code: "bad_password"; essais: number } | { code: "introuvable" | "complet" | "limite" | "reseau" | "serveur" | "indisponible"; retryS?: number };

/** Ce que les écrans lisent (réactif). `rev` change à chaque événement du fil. */
export const vue = $state({
  etape: "vide" as Etape,
  rev: 0,
  erreur: null as ErreurEntree | null,
  /** Échéance du salon (ms, horloge de l'appareil). */
  finMs: 0,
  places: 0,
  createur: false,
  /**
   * Salon prêt (créateur) : lien d'invitation, mot de passe, lien de gestion (affichés, jamais
   * gardés ici). `garde` : le lien de gestion est réellement dans l'historique de l'appareil ; faux
   * (historique désactivé, par défaut, ou indisponible) : « Salon prêt » le montre d'emblée.
   */
  pret: null as { lien: string; mdp: string; gestion: string; garde: boolean } | null,
  /** Créateur, après une exclusion ou « Nouveau lien d'invitation » : la nouvelle invitation (affichée, jamais gardée en clair). */
  nouvelleInvitation: null as { lien: string; mdp: string } | null,
  /** Lien de gestion ouvert seul (« #s… ») : sièges occupés, ou null. */
  gestionSeule: null as { present: number } | null,
  monPseudo: null as string | null,
  /** Silencieux (v3 §14.4) : 0 = son actif, -1 = toujours, sinon échéance (ms). Gardé dans la preuve de membre chiffrée. */
  silence: 0,
  connexion: "connexion" as "connexion" | "ouvert" | "coupe",
  dansLeGroupe: false,
  /** Envoi retenu par le moteur depuis cet instant, ou null. */
  attenteDepuis: null as number | null,
  /** Limite de trames du serveur (0x0B) : heure où l'envoi en attente repart (affichage seulement). */
  ralentiJusqua: null as number | null,
  fin: null as Fin | null,
  /** Heure (ms, horloge de l'appareil) où cette page a vu le salon se terminer, ou null : affichage seulement. */
  finLe: null as number | null,
  membresPeuventDetruire: false,
  /** Créateur délogé : « Reprendre la main ici » est proposé (le lien lui-même n'est pas dans cet état : reprendreLaMain). */
  reprise: false,
  /** Le serveur offre les appels audio et vidéo (relais TURN configuré et paiement ouvert). */
  appels: false,
  /**
   * Appels réservés aux offres Plus et Pro : un pass payé est gardé sur cet appareil
   * (lecture locale, salon/appel-offre.ts). Faux : lancer un appel explique « Réservé aux offres
   * Plus et Pro » sans rien demander ; rejoindre un appel en cours reste ouvert à tous.
   */
  offreAppel: false,
  /** « Appel audio » ou « Appel vidéo » touché sans offre sur cet appareil : l'explication est affichée. */
  appelReserve: false,
  /**
   * Lien de gestion collé dans la conversation (32), jamais envoyé : « proposee »
   * (membre : retrouver les droits ?), « deja » (déjà créateur), « autre » (pas ce salon),
   * « horsligne », « fait », ou null. Le secret lui-même n'est jamais dans cet état.
   */
  gestionCollee: null as "proposee" | "deja" | "autre" | "horsligne" | "erreur" | "fait" | null,
  /**
   * Créateur délogé (écran de fin) : « possible » si le lien de gestion est encore sur l'appareil
   * (historique local, ou lien de gestion ouvert dans cet onglet) ; « lien » sinon (il faut
   * rouvrir le lien de gestion) ; null hors de ce cas.
   */
  detruireFin: null as "possible" | "lien" | null,
  /** Alerte de fin en cours (minutes restantes), aussi montrée dans l'appel ; null sinon. */
  alerteFin: null as number | null,
});

/**
 * Créateur délogé : lien d'invitation pour reprendre la main. Hors de l'état réactif (app/link.ts :
 * une clé de lien n'y va jamais) ; oublié avec le salon (oublier).
 */
let lienReprise: string | null = null;
/**
 * S_gestion encore sur l'appareil pour ce lien d'invitation : historique local, sinon lien de
 * gestion ouvert seul dans cet onglet (« #s », gardé en mémoire). Copie à mettre à zéro, ou undefined.
 */
async function gestionLocale(kLien: Uint8Array): Promise<Uint8Array<ArrayBuffer> | undefined> {
  return (await gestionGardee(kLien).catch(() => undefined)) ?? gestionColle?.slice();
}

/**
 * Créateur délogé (35) : « Détruire le salon » depuis l'écran de fin, avec le lien de
 * gestion encore sur l'appareil (relu à la demande, jamais gardé pour cela) ; seul J_gestion part.
 * Rend vrai si le salon est détruit.
 */
export async function detruireApresDelogement(): Promise<boolean> {
  const f = lienReprise ? lireFragment(lienReprise.slice(lienReprise.lastIndexOf("#"))) : null;
  if (!f) return false;
  const g = await gestionLocale(f.cle);
  f.cle.fill(0);
  if (!g) {
    vue.detruireFin = "lien";
    return false;
  }
  const eng = s?.eng ?? (await loadSalonEngine().catch(() => null));
  if (!eng) {
    g.fill(0);
    return false;
  }
  const j = eng.jetonGestion(g);
  g.fill(0);
  try {
    await api.detruire(net(), { jGestion: j });
    vue.fin = "detruit";
    vue.finLe = Date.now();
    vue.reprise = false;
    vue.detruireFin = null;
    lienReprise = null;
    return true;
  } catch {
    return false;
  } finally {
    j.fill(0);
  }
}

/** « Reprendre la main ici » : rouvre le lien d'invitation (mot de passe redemandé). */
export function reprendreLaMain(): void {
  const l = lienReprise;
  lienReprise = null;
  if (l) location.assign(l);
}

type Session = {
  eng: SalonEngine;
  kLien: Uint8Array<ArrayBuffer>;
  cles?: ClesSalon;
  meta?: api.Meta;
  client?: ClientSalon;
  conv?: Conversation;
  /** Appel audio ou vidéo du salon (un seul à la fois). */
  appel?: Appel;
  sGestion?: Uint8Array<ArrayBuffer>;
  /** S_gestion venu d'un lien de gestion collé (pas de l'historique) : abandonné si le serveur le refuse. */
  gestionColle?: boolean;
  /** K_lien de l'invitation d'origine, gardé après une rotation pour la preuve de membre. */
  lienOrigine?: Uint8Array<ArrayBuffer>;
  couleur?: number;
  /** Notre photo pour ce salon (pièce chiffrée, v3 §7.2), annoncée dans notre profil. */
  avatar?: { r: Uint8Array; piece: Uint8Array; palier: number } | null;
  /** Preuve de membre (D41-26) : index et clé locale (non extractible), tirés de l'invitation d'origine. */
  preuve?: { index: Uint8Array<ArrayBuffer>; cle: CryptoKey | null; sel: Uint8Array<ArrayBuffer> | null };
  /** K_maître_s courante (réécrite à chaque rotation) : seulement pour la preuve de membre. */
  kMaitre?: Uint8Array<ArrayBuffer>;
  /** Dernière alerte de fin affichée (gardée dans la preuve de membre : pas de doublon au rechargement). */
  averti?: Averti | null;
  /** Heure où l'alerte de fin quitte l'appel (ms). */
  alerteJusqua?: number;
  /** Arrête la minuterie des alertes de fin. */
  arretAlerte?: () => void;
  stop: (() => void)[];
};
let s: Session | undefined;

const net = (): api.Net => api.netParDefaut();
const ouvrirWS = (url: string) => new WebSocket(url) as unknown as import("./client").WsLike;

/** Le fil courant (null avant l'entrée). */
export function conversation(): Conversation | null {
  return s?.conv ?? null;
}
/** Appel du salon (état lu après `vue.rev`), ou null hors d'un salon. */
export function appel(): Appel | null {
  return s?.appel ?? null;
}
export function moteur(): SalonEngine | null {
  return s?.eng ?? null;
}

/** Oublie tout (secrets mis à zéro, WebSocket fermé). */
export function oublier(): void {
  if (!s) return;
  for (const f of s.stop) f();
  s.appel?.fermer();
  s.client?.fermer();
  if (!s.client) s.cles?.free();
  s.kLien.fill(0);
  s.sGestion?.fill(0);
  s = undefined;
  oublierPieces();
  Object.assign(vue, { etape: "vide", erreur: null, pret: null, nouvelleInvitation: null, gestionSeule: null, monPseudo: null, silence: 0, dansLeGroupe: false, attenteDepuis: null, ralentiJusqua: null, createur: false, reprise: false, appels: false, offreAppel: false, appelReserve: false, gestionCollee: null, detruireFin: null, alerteFin: null });
  lienReprise = null;
  oublierGestionCollee();
}

// --- Invité : lien, mot de passe -----------------------------------------------------------------

/** Lien « #c… » lu : secondes restantes et paramètres du mot de passe (meta), sans rien révéler de plus. */
export async function ouvrirInvitation(kLien: Uint8Array<ArrayBuffer>): Promise<void> {
  oublier();
  vue.etape = "chargement";
  const eng = await loadSalonEngine().catch(() => null);
  if (!eng) {
    vue.erreur = { code: "reseau" };
    vue.etape = "vide";
    return;
  }
  s = { eng, kLien: kLien.slice(), stop: [] };
  const acces = eng.cleAcces(kLien);
  try {
    s.meta = await api.meta(net(), acces.k);
    s.sGestion = await gestionGardee(kLien);
    // Lien de gestion ouvert juste avant dans cet onglet (« #s » seul, 32).
    if (!s.sGestion && gestionColle) {
      s.sGestion = gestionColle.slice();
      s.gestionColle = true;
    }
    const index = await indexMembre(kLien);
    s.preuve = { index, cle: null, sel: await preuve.lireSel(index) };
    vue.finMs = Date.now() + s.meta.expiresInS * 1000;
    vue.etape = "motdepasse";
  } catch (e) {
    vue.erreur = erreurEntree(e);
    vue.etape = "vide";
  } finally {
    acces.k.fill(0);
    acces.v.fill(0);
  }
}

function erreurEntree(e: unknown): ErreurEntree {
  if (e instanceof api.SalonError) {
    if (e.code === "bad_password") return { code: "bad_password", essais: e.attemptsLeft ?? 0 };
    if (e.code === "not_found") return { code: "introuvable" };
    if (e.code === "full") return { code: "complet" };
    if (e.code === "limit") return { code: "limite", retryS: e.retryS };
    return { code: e.status >= 500 ? "serveur" : "indisponible" };
  }
  return { code: "reseau" };
}

/** Mot de passe tapé : Argon2id, `rejoindre` (une place est prise), WebSocket ; puis la page d'explication. */
export async function deverrouiller(mdp: string): Promise<boolean> {
  const x = s;
  if (!x?.meta) return false;
  vue.erreur = null;
  let kMdp: Uint8Array | undefined;
  try {
    kMdp = await passwordKey(mdp.normalize("NFC"), x.meta.salt, { ops: x.meta.kdfOps, mem: x.meta.kdfMem });
    x.cles?.free();
    x.cles = x.eng.clesSalon(x.kLien, kMdp);
    const d = deps(x.eng);
    // Preuve de membre (D41-26) : même place, même pseudonyme, sans `rejoindre`.
    if (x.preuve?.sel && (await reprendreParLaPreuve(x, mdp, x.preuve.sel))) return true;
    x.kMaitre = x.eng.cleMaitre(x.kLien, kMdp) as Uint8Array<ArrayBuffer>;
    // Créateur revenu (32) : siège 0 avec J_gestion, rôle rendu dès le Commit qui
    // l'ajoute ; il ne fonde pas de groupe (les membres en ligne l'ajoutent ; sinon, groupe orphelin).
    const o = { kLien: x.kLien, cles: x.cles, sGestion: x.sGestion };
    let entree;
    try {
      entree = await ClientSalon.rejoindre(d, o);
    } catch (e) {
      // Lien de gestion collé d'un AUTRE salon : refusé (400) ; on entre comme simple membre.
      if (!x.gestionColle || !(e instanceof api.SalonError) || e.code !== "bad_request") throw e;
      x.sGestion?.fill(0);
      x.sGestion = o.sGestion = undefined;
      x.gestionColle = false;
      entree = await ClientSalon.rejoindre(d, o);
    }
    demarrer(x, ClientSalon.ouvrir(d, o, entree), entree);
    vue.etape = "explication";
    // Preuve illisible avec le bon mot de passe (paquet abîmé) : effacée ; une neuve est préparée.
    if (x.preuve) {
      if (x.preuve.sel) await preuve.effacer(x.preuve.index);
      void preparerPreuve(x, mdp);
    }
    return true;
  } catch (e) {
    vue.erreur = erreurEntree(e);
    if (vue.erreur.code === "introuvable") vue.etape = "vide";
    return false;
  } finally {
    kMdp?.fill(0);
  }
}

// --- Lien de gestion seul (« #s… », 32) ------------------------------------------------

/** S_gestion d'un lien de gestion ouvert seul, gardé en mémoire pour l'invitation ouverte ensuite. */
let gestionColle: Uint8Array<ArrayBuffer> | undefined;

/**
 * Lien de gestion ouvert seul : il ne fait entrer personne (spec v3 §15.2). La page dit l'état du
 * salon (sièges occupés, échéance), propose de le détruire, et garde S_gestion EN MÉMOIRE pour
 * l'invitation ouverte ensuite dans cet onglet (le créateur y retrouve son rôle).
 */
export async function ouvrirGestion(sG: Uint8Array<ArrayBuffer>): Promise<void> {
  oublier();
  vue.etape = "chargement";
  const eng = await loadSalonEngine().catch(() => null);
  if (!eng) {
    vue.erreur = { code: "reseau" };
    vue.etape = "vide";
    return;
  }
  const j = eng.jetonGestion(sG);
  try {
    const g = await api.gestion(net(), j);
    oublierGestion();
    gestionColle = sG.slice();
    vue.gestionSeule = { present: g.present };
    vue.finMs = Date.now() + g.expiresInS * 1000;
    vue.etape = "gestion";
  } catch (e) {
    vue.erreur = erreurEntree(e);
    vue.etape = "vide";
  } finally {
    j.fill(0);
  }
}

/** « Détruire le salon » depuis le lien de gestion seul. */
export async function detruireParGestion(): Promise<boolean> {
  if (!gestionColle) return false;
  const eng = await loadSalonEngine().catch(() => null);
  if (!eng) return false;
  const j = eng.jetonGestion(gestionColle);
  try {
    await api.detruire(net(), { jGestion: j });
    oublierGestion();
    vue.gestionSeule = null;
    vue.fin = "detruit";
    vue.finLe = Date.now();
    vue.etape = "fin";
    return true;
  } catch {
    return false;
  } finally {
    j.fill(0);
  }
}

/** Page quittée : le lien de gestion collé est oublié (mis à zéro). */
export function oublierGestion(): void {
  gestionColle?.fill(0);
  gestionColle = undefined;
}

function deps(eng: SalonEngine) {
  return { net: net(), eng, ouvrirWS };
}

// --- Créateur -------------------------------------------------------------------------------------

export type ErreurCreation =
  | { code: "palier"; salons: number; places: number; heures: number }
  | { code: "banni"; jusqu: string }
  | { code: "compte_requis" | "limite" | "reseau" | "serveur" | "occupe" | "robot"; retryS?: number };

/**
 * Crée le salon (compte exigé, conception §10.4) : clés et mot de passe tirés ici, preuve
 * anti-robot, création avec la session, entrée comme créateur (siège 0, il fonde le groupe),
 * puis « Salon prêt ». `garder` : lien d'invitation et lien de gestion dans l'historique local
 * chiffré (puis le coffre du compte). Rend l'erreur, ou null.
 */
export async function creer(o: { ttlHours: Duree; maxMembers: number; membersCanDestroy: boolean; garder: boolean; onEtape?: (e: "cles" | "robot" | "envoi") => void }): Promise<ErreurCreation | null> {
  oublier();
  const eng = await loadSalonEngine().catch(() => null);
  if (!eng) return { code: "reseau" };
  const mdp = generatePassword();
  o.onEtape?.("cles");
  let p: Awaited<ReturnType<typeof preparer>> | undefined;
  try {
    p = await preparer(eng, mdp, o);
    o.onEtape?.("robot");
    const origin = location.origin;
    const cap = await captchaDuServeur(transferCtx(origin));
    const preuve = await solvePow(cap.challenge);
    // Le serveur refuse une création moins de 3 s après le défi (même règle que les partages).
    // (receivedAt : horloge monotone de la page, comme la validité du défi, transfer/api.ts).
    await new Promise((r) => setTimeout(r, Math.max(0, cap.receivedAt + CAPTCHA_MIN_MS - performance.now())));
    o.onEtape?.("envoi");
    if (preuve.kind !== "pow") return { code: "robot" };
    const r = await creerAvecSession(p.entetes, { ...p.corps, altcha: preuve.payload, hp: "", shown_at: cap.shownAt });
    const lien = lienSalon(origin, "c", p.kLien, import.meta.env.BASE_URL);
    const gestion = lienSalon(origin, "s", p.sGestion, import.meta.env.BASE_URL);
    const garde =
      o.garder &&
      (await recordShare({ sorte: "salon_cree", manage: gestion, link: lien, label: "", createdAt: Date.now(), sizeBytes: 0, itemsCount: 0, expiresAt: Date.now() + r.expiresInS * 1000, maxOpens: 0 })) !== null;
    s = { eng, kLien: p.kLien, cles: p.cles, sGestion: p.sGestion, kMaitre: p.kMaitre, preuve: { index: await indexMembre(p.kLien), cle: null, sel: null }, stop: [] };
    void preparerPreuve(s, mdp);
    const d = deps(eng);
    const entree = await ClientSalon.rejoindre(d, { kLien: p.kLien, cles: p.cles, sGestion: p.sGestion });
    demarrer(s, ClientSalon.ouvrir(d, { kLien: p.kLien, cles: p.cles, sGestion: p.sGestion, creerGroupe: true }, entree), entree);
    vue.pret = { lien, mdp, gestion, garde };
    vue.etape = "pret";
    return null;
  } catch (e) {
    if (p && !s) oublierPreparation(p);
    if (e instanceof CompteError) {
      if (e.code === "palier" && e.palier) return { code: "palier", ...e.palier };
      if (e.code === "banni") return { code: "banni", jusqu: e.jusqu ?? "" };
      if (e.code === "compte_requis" || e.code === "aucune_session") return { code: "compte_requis" };
      if (e.code === "limit") return { code: "limite", retryS: e.retryAfterS };
      if (e.code === "busy") return { code: "occupe", retryS: e.retryAfterS };
      if (e.code === "bad_request") return { code: "robot" };
      return { code: e.status >= 500 ? "serveur" : "reseau" };
    }
    if (e instanceof Error && e.message === "aucune_session") return { code: "compte_requis" };
    return { code: "reseau" };
  }
}

/** Salon prêt → page d'explication et pseudonyme (le créateur ne retape pas le mot de passe). */
export function versExplication(): void {
  if (vue.etape === "pret") vue.etape = "explication";
}

/** Pseudonyme proposé (compte : réglage « Proposer mon pseudo et ma photo »). */
/** Photo du compte proposée pour ce salon (même réglage), ou null. */
export function photoProposee(): Uint8Array | null {
  return (__COMPTES__ && profilPourSalon()?.photo) || null;
}

export function pseudoPropose(): string {
  return (__COMPTES__ && profilPourSalon()?.pseudo) || "";
}

// --- Conversation -------------------------------------------------------------------------------

function demarrer(x: Session, c: ClientSalon, e: api.Entree): void {
  x.client = c;
  x.conv = new Conversation(c.siege, (p) => x.eng.cleUnicite(p));
  x.conv.surChangement(() => vue.rev++);
  vue.finMs = Date.now() + e.expiresInS * 1000;
  vue.places = e.maxMembers;
  vue.createur = c.createur;
  vue.membresPeuventDetruire = e.membersCanDestroy;
  vue.fin = null;
  vue.finLe = null;
  vue.appels = e.appels;
  vue.appelReserve = false;
  // Lecture locale seulement (aucune requête) : un pass payé est-il gardé sur cet appareil ?
  if (e.appels)
    void offresAppel()
      .then((l) => {
        if (s === x) vue.offreAppel = l.length > 0;
      })
      .catch(() => undefined);
  x.appel?.fermer();
  x.appel = nouvelAppel(x, c);
  x.stop.push(c.ecouter((ev) => surEvenement(x, ev)));
  x.arretAlerte?.();
  const minuterie = setInterval(() => alerteFin(x), 1000);
  x.arretAlerte = () => clearInterval(minuterie);
  x.stop.push(x.arretAlerte);
  alerteFin(x);
}

/** Durée de l'alerte de fin dans l'appel (elle reste dans la conversation). */
const ALERTE_APPEL_MS = 60_000;

/**
 * Alerte avant la fin (30, 15, 5 et 1 min) : ligne du salon dans la conversation et rappel dans
 * l'appel, calculés sur l'appareil (aucune trame).
 */
function alerteFin(x: Session): void {
  if (s !== x || !x.client || !x.conv) return;
  const maintenant = Date.now();
  if (vue.alerteFin !== null && (maintenant >= (x.alerteJusqua ?? 0) || !x.averti || Math.abs(x.averti.finMs - vue.finMs) > MEME_FIN_MS)) vue.alerteFin = null;
  const m = seuilAAfficher(vue.finMs, maintenant, x.averti ?? null);
  if (m === null) return;
  x.averti = { finMs: Math.round(vue.finMs), seuil: m };
  x.alerteJusqua = maintenant + ALERTE_APPEL_MS;
  vue.alerteFin = m;
  x.conv.fermeture(m);
  ecrirePreuve(x);
}

/**
 * « Appel audio » ou « Appel vidéo » (aucun appel en cours) : réservés aux offres Plus et Pro.
 * Sans pass payé sur cet appareil, l'explication est affichée et rien n'est demandé (ni micro,
 * ni réseau) ; sinon l'appel est lancé (un jeton anonyme l'ouvre au besoin, appel-offre.ts).
 */
export async function lancerAppel(video: boolean): Promise<void> {
  // Relu sur l'appareil si la première lecture (demarrer) n'a rien trouvé ou n'est pas finie.
  if (!vue.offreAppel) vue.offreAppel = (await offresAppel().catch(() => [])).length > 0;
  if (!vue.offreAppel) {
    vue.appelReserve = true;
    return;
  }
  vue.appelReserve = false;
  await s?.appel?.rejoindre(video);
}

// Onglet fermé ou quitté (aussi vers le cache de retour arrière) : on raccroche en le disant,
// au lieu de laisser les autres attendre 40 s qu'on soit compté absent.
if (typeof addEventListener === "function") addEventListener("pagehide", () => s?.appel?.quitter());

/** Appel branché sur ce client : messages chiffrés par le salon, média par le relais seulement (appel.ts). */
function nouvelAppel(x: Session, c: ClientSalon): Appel {
  return new Appel({
    moi: c.siege,
    envoyer: (m) => x.client?.appel(m) ?? false,
    relais: () => relaisReserve((j) => api.relaisAppel(net(), c.jeton, j)),
    media: (o) =>
      navigator.mediaDevices.getUserMedia({
        audio: o.audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
        video: o.video ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: o.face } : false,
      }),
    pair: (cfg) => new RTCPeerConnection(cfg),
    flux: () => new MediaStream(),
    alea: () => crypto.getRandomValues(new Uint8Array(16)),
    maintenant: () => Date.now(),
    plusTard: (ms, f) => {
      const t = setTimeout(f, ms);
      return () => clearTimeout(t);
    },
    change: () => vue.rev++,
  });
}

function surEvenement(x: Session, ev: EvClient): void {
  const c = x.client!;
  const conv = x.conv!;
  switch (ev.k) {
    case "liste":
      conv.liste(
        ev.annonces.map((a) => a.siege),
        ev.createur,
      );
      for (const a of ev.annonces) if (a.derniereMin > 0) conv.presenceDe(a.siege, { enLigne: false, derniereMin: a.derniereMin });
      break;
    case "arrivee":
    case "reprise":
      conv.arrivee(ev.siege);
      break;
    case "depart":
      conv.depart(ev.siege);
      x.appel?.parti(ev.siege);
      break;
    case "exclusion":
      if (ev.siege !== undefined) {
        conv.depart(ev.siege, true);
        // Exclu : sa connexion d'appel est coupée aussitôt.
        x.appel?.parti(ev.siege);
      }
      break;
    case "presence":
      conv.presenceDe(ev.siege, { enLigne: ev.enLigne, derniereMin: ev.derniereMin });
      break;
    case "membres":
      conv.groupe(ev);
      vue.dansLeGroupe = c.dansLeGroupe();
      // Les nouveaux venus ne lisent rien d'avant leur arrivée : chacun leur redit son profil.
      if (vue.monPseudo && ev.ajoutes.some((s2) => s2 !== c.siege)) envoyerProfil(x);
      break;
    case "groupe":
      vue.dansLeGroupe = ev.dansLeGroupe;
      break;
    case "message": {
      const m = ev.enveloppe.message;
      if (m.k === "appel_present" || m.k === "appel_fin" || m.k === "appel_signal") {
        x.appel?.recu(ev.siege, m);
        // Un appel sonne : l'explication « Réservé aux offres » touchée avant n'a plus lieu d'être.
        if (m.k === "appel_present") vue.appelReserve = false;
        break;
      }
      const r = conv.message(ev.seq, ev.siege, ev.epoque, ev.enveloppe);
      if (r) c.accuser("recu", [r.recu]);
      // Notre pseudonyme pris par un siège arrivé avant : retour au champ.
      if (conv.pseudoRefuse && vue.etape === "conversation") {
        vue.monPseudo = null;
        vue.etape = "explication";
      }
      break;
    }
    case "efface": {
      // Message effacé : sa pièce quitte aussi la mémoire de la page (URL révoquée, v3 §5).
      const b = conv.elements.find((e) => e.k === "bulle" && e.seq === ev.cible);
      if (b?.k === "bulle") liberer(b.cle);
      conv.efface(ev.cible);
      break;
    }
    case "chiffre":
      conv.chiffre(ev.local, ev.id);
      break;
    case "accepte": {
      conv.accepte(ev.local, ev.seq);
      const p = profilsEnVol.get(ev.local);
      if (p) {
        profilsEnVol.delete(ev.local);
        conv.monProfil(p.pseudo, p.couleur, ev.seq);
      }
      break;
    }
    case "echec":
      conv.echec(ev.local, ev.code);
      break;
    case "attente":
      vue.attenteDepuis = ev.depuisMs;
      break;
    case "ralenti":
      vue.ralentiJusqua = Date.now() + ev.secondes * 1000;
      break;
    case "connexion":
      vue.connexion = ev.etat;
      break;
    case "reglages":
      vue.finMs = Date.now() + ev.secondes * 1000;
      vue.places = ev.places;
      break;
    case "rotation":
      conv.invitationChangee();
      void preuveRotation(x, ev.kMaitre).finally(() => ev.kMaitre.fill(0));
      break;
    case "renouvellement":
      for (const cle of conv.renouveler(ev.depart)) liberer(cle);
      fichiersOuverts.clear();
      break;
    case "nouvelleEntree":
      conv.changerDeSiege(ev.siege);
      // Nouveau siège : l'appel en cours est quitté (les paires sont nommées par siège).
      x.appel?.fermer();
      x.appel = nouvelAppel(x, c);
      ecrirePreuve(x);
      if (vue.monPseudo) envoyerProfil(x);
      break;
    case "fin":
      vue.fin = ev.raison;
      vue.finLe = Date.now();
      vue.etape = "fin";
      x.appel?.fermer();
      // Créateur délogé (35) : pas de reconnexion d'elle-même ; « Reprendre la main ici »
      // rouvre le lien d'invitation (mot de passe redemandé, lien de gestion relu dans l'historique).
      lienReprise = ev.raison === "remplace" && x.sGestion ? lienSalon(location.origin, "c", x.kLien, import.meta.env.BASE_URL) : null;
      vue.reprise = lienReprise !== null;
      // « Détruire le salon » proposé si le lien de gestion est encore sur l'appareil.
      vue.detruireFin = null;
      if (lienReprise) {
        const k = x.kLien.slice();
        void gestionLocale(k)
          .then((g) => {
            if (s === x && vue.reprise) vue.detruireFin = g ? "possible" : "lien";
            g?.fill(0);
          })
          .finally(() => k.fill(0));
      }
      // Secrets effacés tout de suite ; ce qui est à l'écran reste jusqu'à ce que la personne parte
      // (sauf exclusion : tout disparaît, spec §39.13.1b).
      x.client = undefined;
      // Place perdue pour de bon (sauf délogé : la place existe encore) : preuve effacée.
      if (ev.raison !== "remplace" && x.preuve) void preuve.effacer(x.preuve.index);
      x.kMaitre?.fill(0);
      x.kLien.fill(0);
      x.sGestion?.fill(0);
      if (ev.raison === "exclu") {
        x.conv = new Conversation(0, () => "");
      }
      break;
  }
  vue.rev++;
}

function envoyerProfil(x: Session): void {
  if (!x.client || !x.conv || !vue.monPseudo) return;
  x.couleur ??= x.conv.couleurLibre();
  const pseudo = vue.monPseudo;
  const couleur = x.couleur;
  const avatar = x.avatar ?? null;
  x.client.envoyer({ k: "profil", pseudo, couleur, avatar }, 0, undefined, (local) => {
    profilsEnVol.set(local, { pseudo, couleur });
    x.conv!.monProfil(pseudo, couleur);
    x.conv!.avatars.set(x.client!.siege, avatar);
  });
}
/** Nos messages `profil` en attente de leur rang (numéro local → contenu). */
const profilsEnVol = new Map<number, { pseudo: string; couleur: number }>();

/** Erreur du pseudonyme (règles du moteur, unicité dans le salon), ou null s'il est valable. */
export function verifierPseudo(p: string): { code: "longueur" | "caracteres" | "ecritures" | "pris" | "invalide" } | { ok: string } {
  const x = s;
  if (!x) return { code: "invalide" };
  let net2: string;
  try {
    net2 = x.eng.pseudoValide(p);
  } catch (e) {
    const m = (e as Error).message;
    return { code: m === "pseudo_longueur" ? "longueur" : m === "pseudo_caracteres" ? "caracteres" : m === "pseudo_ecritures" ? "ecritures" : "invalide" };
  }
  if (x.conv?.pseudoPris(net2)) return { code: "pris" };
  return { ok: net2 };
}

/** « Entrer dans le salon » : pseudonyme annoncé (chiffré) aux membres, puis la conversation. */
/** Clé locale de la preuve (un Argon2id de plus, sel neuf) ; écrite quand le pseudonyme est accepté. */
async function preparerPreuve(x: Session, mdp: string): Promise<void> {
  if (!x.preuve) return;
  const sel = crypto.getRandomValues(new Uint8Array(16));
  const kArgon = await passwordKey(mdp.normalize("NFC"), sel, KDF_CREATE).catch(() => null);
  if (!kArgon || s !== x) {
    kArgon?.fill(0);
    return;
  }
  const cle = await preuve.importerCle(await cleMembreLocal(kArgon, origineLien(x)));
  kArgon.fill(0);
  x.preuve.cle = cle;
  x.preuve.sel = sel;
  ecrirePreuve(x);
}
/** K_lien de l'invitation d'origine (l'index et K_m en viennent, même après une rotation). */
function origineLien(x: Session): Uint8Array {
  return x.lienOrigine ?? x.kLien;
}
function ecrirePreuve(x: Session): void {
  const c = x.client;
  if (!x.preuve?.cle || !x.preuve.sel || !c || !vue.monPseudo || !x.kMaitre) return;
  void preuve.ecrire(x.preuve.index, x.preuve.cle, x.preuve.sel, { jeton: c.jeton, siege: c.siege, pseudo: vue.monPseudo, couleur: x.couleur ?? 0, kMaitre: x.kMaitre, sGestion: x.sGestion, silence: vue.silence, appels: vue.appels, averti: x.averti ?? null }, vue.finMs);
}

/** Mode silencieux (v3 §14.4) : « toujours », 1 h, 8 h, ou null pour réactiver le son. */
export function silencieux(choix: "toujours" | 1 | 8 | null): void {
  vue.silence = choix === null ? 0 : finSilence(choix, Date.now());
  if (s) ecrirePreuve(s);
}
/** Rotation reçue (ou faite) : la preuve garde la NOUVELLE K_maître_s (spec §39.13.3). */
async function preuveRotation(x: Session, kMaitre: Uint8Array): Promise<void> {
  x.kMaitre?.fill(0);
  x.kMaitre = kMaitre.slice();
  ecrirePreuve(x);
}
async function reprendreParLaPreuve(x: Session, mdp: string, sel: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const kArgon = await passwordKey(mdp.normalize("NFC"), sel, KDF_CREATE);
  const cle = await preuve.importerCle(await cleMembreLocal(kArgon, x.kLien));
  kArgon.fill(0);
  const c = await preuve.ouvrir(x.preuve!.index, cle);
  if (!c) return false;
  x.preuve!.cle = cle;
  x.kMaitre = c.kMaitre as Uint8Array<ArrayBuffer>;
  x.couleur = c.couleur;
  x.averti = c.averti ?? null;
  if (c.sGestion) x.sGestion = c.sGestion as Uint8Array<ArrayBuffer>;
  const cles = x.eng.clesDepuisMaitre(c.kMaitre);
  x.cles?.free();
  x.cles = cles;
  const client = ClientSalon.reprendre(deps(x.eng), { kLien: x.kLien, cles, jeton: c.jeton, siege: c.siege, sGestion: x.sGestion });
  demarrer(x, client, { jeton: c.jeton, siege: c.siege, seq: 0, nonce: new Uint8Array(16), expiresInS: Math.max(0, (vue.finMs - Date.now()) / 1000), maxMembers: vue.places, membersCanDestroy: false, budgetLeft: 0, appels: c.appels === true });
  vue.monPseudo = c.pseudo;
  vue.silence = c.silence ?? 0;
  envoyerProfil(x);
  vue.etape = "conversation";
  return true;
}

export function entrer(pseudo: string): boolean {
  const x = s;
  const v = verifierPseudo(pseudo);
  if (!x || !("ok" in v)) return false;
  vue.monPseudo = v.ok;
  if (x.conv) x.conv.pseudoRefuse = false;
  envoyerProfil(x);
  vue.etape = "conversation";
  ecrirePreuve(x);
  return true;
}

/** Règle d'effacement des nouveaux messages (C-5 : réglable par tout participant ; 5 min par défaut). */
export function regleCourante(): Regle {
  return s?.conv?.regle ?? 2;
}

/** Tout participant change la règle d'effacement (v3 §5) : message chiffré `regle`, ligne chez tous. */
export function changerRegle(r: Regle): void {
  const x = s;
  if (!x?.client || !x.conv || r < 1) return;
  x.client.envoyer({ k: "regle", regle: r }, 0);
  x.conv.regleLocale(r);
}

/** État d'effacement d'un message à l'écran (moteur : `etatEffacement`), compte à rebours local seulement. */
export function effacement(b: Bulle, maintenantMs: number): { etat: "visible" } | { etat: "rebours"; finMs: number } | { etat: "efface" } {
  const x = s;
  if (!x || b.regle === 0) return { etat: "visible" };
  const vuMs = x.conv?.vuLe.get(b.cle) ?? null;
  try {
    return x.eng.etatEffacement({ regle: b.regle, maintenantMs, vuParMoiMs: vuMs, effaceParServeur: false });
  } catch {
    return { etat: "visible" };
  }
}

// --- Lien de gestion collé dans la conversation (32) -----------------------------------

/** Secret du lien de gestion collé, en attente du choix de la personne (mémoire seulement). */
let gestionEnAttente: Uint8Array<ArrayBuffer> | undefined;
function oublierGestionCollee(): void {
  gestionEnAttente?.fill(0);
  gestionEnAttente = undefined;
}

/**
 * Texte tapé ou collé dans la saisie : s'il contient un lien de gestion, rien ne part (ni message,
 * ni « écrit ») ; le secret reste en mémoire le temps que la personne choisisse, la saisie est
 * vidée par l'écran. Rend vrai si le texte a été intercepté. Jamais gardé ailleurs : ni historique,
 * ni stockage ; la preuve de membre ne le reçoit que si les droits sont rendus.
 */
export function intercepterLienGestion(texte: string): boolean {
  const cle = lienGestionDans(texte);
  if (!cle) return false;
  oublierGestionCollee();
  if (vue.createur || !s?.client) {
    cle.fill(0);
    vue.gestionCollee = "deja";
  } else {
    gestionEnAttente = cle;
    vue.gestionCollee = "proposee";
  }
  return true;
}

/** « Annuler » (ou fermeture) : le secret collé est mis à zéro. */
export function annulerGestionCollee(): void {
  oublierGestionCollee();
  vue.gestionCollee = null;
}

/**
 * « Retrouver mes droits de créateur » : siège 0 avec J_gestion (seul envoyé au serveur), ancienne
 * place rendue, rôle rendu dès le Commit qui l'ajoute (client.reprendreLeRole). Un lien d'un autre
 * salon (400) ne change rien.
 */
export async function reprendreDroits(): Promise<void> {
  const x = s;
  const cle = gestionEnAttente;
  gestionEnAttente = undefined;
  if (!x?.client || !cle) {
    cle?.fill(0);
    vue.gestionCollee = null;
    return;
  }
  try {
    await x.client.reprendreLeRole(cle);
    if (s !== x) return;
    x.sGestion?.fill(0);
    x.sGestion = cle.slice();
    x.gestionColle = true;
    vue.createur = true;
    vue.gestionCollee = "fait";
    ecrirePreuve(x);
  } catch (e) {
    vue.gestionCollee = e instanceof api.SalonError && e.code === "bad_request" ? "autre" : (e as Error).message === "hors_ligne" ? "horsligne" : "erreur";
  } finally {
    cle.fill(0);
  }
}

export function envoyerTexte(texte: string, cite: string | null): void {
  const x = s;
  if (!x?.client || !x.conv) return;
  // Exigence C-3 32 : un lien de gestion ne part jamais dans un message.
  if (lienGestionDans(texte)) throw new Error("lien_gestion");
  const t = x.eng.nettoyerTexte(texte);
  const regle = regleCourante();
  const message = cite ? { k: "reponse" as const, cible: hexOctets(cite), x: t } : { k: "texte" as const, x: t };
  x.client.envoyer(message, regle, undefined, (local) => x.conv!.envoye(local, { sorte: cite ? "reponse" : "texte", texte: t, cite }, regle));
}

export function modifier(b: Bulle, texte: string): void {
  const x = s;
  if (!x?.client || !x.conv || !b.id || !b.moi) return;
  if (lienGestionDans(texte)) throw new Error("lien_gestion");
  const t = x.eng.nettoyerTexte(texte);
  x.client.envoyer({ k: "modif", cible: hexOctets(b.id), x: t }, b.regle);
  x.conv.modifierLocal(b.id, t);
}

export function retirer(b: Bulle): void {
  const x = s;
  if (!x?.client || !x.conv || !b.id || !b.moi || b.seq === null) return;
  x.client.retirerPourTous(b.seq, hexOctets(b.id), b.regle);
  liberer(b.cle);
  x.conv.retirerLocal(b.id);
}

// --- Pièces -------------------------------------------------------------------------

/** Fichiers ouverts ou enregistrés ici (écran « Fichiers » : « Nouveau » sinon), en mémoire seulement. */
export const fichiersOuverts = new SvelteSet<string>();
/** Avatars masqués pour soi (v3 §7.2 : une photo peut être choquante), en mémoire seulement. */
export const masques = new SvelteSet<number>();
/** Adresses blob: des pièces affichées (clé de la bulle → URL), révoquées à l'effacement. */
export const pieces = $state({ urls: {} as Record<string, string>, erreurs: {} as Record<string, string>, lecture: {} as Record<string, true>, aConfirmer: [] as File[], avertissement: "" });
/**
 * Pièces déjà en clair en mémoire (clé de bulle) : nos fichiers d'origine et chaque pièce lue
 * (affichée ou enregistrée). « Enregistrer » et « Télécharger (N) » s'en servent sans relire le
 * serveur : chaque membre ne télécharge une pièce qu'une fois (429 budget au-delà, définitif).
 * Oubliées avec l'adresse blob: (`liberer`).
 */
const originaux = new Map<string, Blob>();
/** Lectures en cours (clé de bulle) : un second clic attend la même lecture au lieu d'en lancer une autre. */
const lectures = new Map<string, Promise<Blob>>();

/** Pièce en clair : déjà en mémoire, lecture en cours, ou lue du serveur (puis gardée). */
function lire(x: Session, b: Bulle, max: number): Promise<Blob> {
  const deja = originaux.get(b.cle);
  if (deja) return Promise.resolve(deja);
  const enCours = lectures.get(b.cle);
  if (enCours) return enCours;
  const l: Promise<Blob> = lirePiece(net(), x.client!.jeton, b.piece!.ref!, max)
    .then((blob) => {
      // Pièce retirée ou effacée pendant la lecture (liberer) : rien n'est gardé.
      if (s === x && lectures.get(b.cle) === l) {
        originaux.set(b.cle, blob);
        delete pieces.erreurs[b.cle];
      }
      return blob;
    })
    .finally(() => {
      if (lectures.get(b.cle) !== l) return;
      lectures.delete(b.cle);
      delete pieces.lecture[b.cle];
    });
  lectures.set(b.cle, l);
  pieces.lecture[b.cle] = true;
  return l;
}
let pieceLocale = 0;
let fileDesEnvois: Promise<void> = Promise.resolve();

const MIME = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,80}$/;

function liberer(cle: string): void {
  const u = pieces.urls[cle];
  if (u) URL.revokeObjectURL(u);
  delete pieces.urls[cle];
  originaux.delete(cle);
  lectures.delete(cle);
  delete pieces.lecture[cle];
}
function oublierPieces(): void {
  for (const k of Object.keys(pieces.urls)) liberer(k);
  originaux.clear();
  lectures.clear();
  pieces.lecture = {};
  accusesPiece.clear();
  pieces.aConfirmer = [];
  pieces.erreurs = {};
}

function sorteDe(mime: string): PieceInfo["sorte"] {
  if (IMAGES_SURES.has(mime)) return "image";
  if (mime.startsWith("video/")) return "video";
  return "fichier";
}

/**
 * Fichiers choisis (sélecteur, glisser-déposer, coller) : nettoyés comme les partages
 * (stripMetadata), puis envoyés un par un, chacun dans son message. Ceux dont le nettoyage a
 * échoué (ou protégés) attendent « Envoyer tel quel » (`telQuel`), dans `pieces.aConfirmer`.
 */
export async function envoyerFichiers(fichiers: File[], telQuel = false): Promise<void> {
  const x = s;
  if (!x?.client || !x.conv) return;
  pieces.avertissement = "";
  for (const f of fichiers) {
    if (f.size > PIECE_MAX) {
      pieces.avertissement = "trop_gros";
      continue;
    }
    const mime = MIME.test(f.type) ? f.type : "application/octet-stream";
    let nom: string;
    try {
      nom = x.eng.nettoyerNom(f.name) || "fichier";
    } catch {
      nom = "fichier";
    }
    let donnees: Blob = f;
    if (!telQuel) {
      const r = await stripMetadata(f, mime, nom).catch(() => ({ state: "echec" as const, reason: "" }));
      if (r.state === "nettoye") donnees = r.data;
      else if (r.state === "echec" || r.state === "protege") {
        pieces.aConfirmer = [...pieces.aConfirmer, f];
        continue;
      }
    }
    envoyerBlob(x, donnees, { nom, mime, sorte: sorteDe(mime), dureeMs: null, vocal: false });
  }
}

/** « Envoyer tel quel » des fichiers qui n'ont pas pu être nettoyés ; ou abandon. */
export function confirmerTelQuel(oui: boolean): void {
  const f = pieces.aConfirmer;
  pieces.aConfirmer = [];
  if (oui) void envoyerFichiers(f, true);
}

/** Vocal enregistré ici (enregistreur du site, métadonnées déjà retirées). */
export function envoyerVocal(v: { blob: Blob; mime: string; ext: string; ms: number }): void {
  const x = s;
  if (!x?.client) return;
  envoyerBlob(x, v.blob, { nom: `vocal.${v.ext}`, mime: MIME.test(v.mime) ? v.mime.split(";")[0]! : "audio/webm", sorte: "vocal", dureeMs: Math.round(v.ms), vocal: true });
}

function envoyerBlob(x: Session, donnees: Blob, p: { nom: string; mime: string; sorte: PieceInfo["sorte"]; dureeMs: number | null; vocal: boolean }): void {
  const conv = x.conv!;
  const local = --pieceLocale;
  conv.pieceEnvoi(local, { nom: p.nom, mime: p.mime, taille: donnees.size, sorte: p.sorte, dureeMs: p.dureeMs });
  const cle = `l${local}`;
  originaux.set(cle, donnees);
  const type = typeAffichage(p.sorte, p.mime);
  if (type) pieces.urls[cle] = URL.createObjectURL(new Blob([donnees], { type }));
  // Une pièce à la fois (le serveur admet deux envois non finalisés par connexion).
  fileDesEnvois = fileDesEnvois.then(async () => {
    const c = x.client;
    if (!c || s !== x) return;
    try {
      const ref = await envoyerPiece(net(), c.jeton, donnees, { nom: p.nom, mime: p.mime, vocal: p.vocal, progres: (f) => conv.progresPiece(local, f) });
      conv.progresPiece(local, 1, ref);
      c.envoyer({ k: "piece", r: ref.r, piece: ref.piece, palier: ref.palier, nom: p.nom, mime: p.mime, taille: donnees.size, sorte: p.sorte, dureeMs: p.dureeMs }, 0, ref.piece, (l) => {
        conv.rattacher(local, l);
      });
    } catch (e) {
      const code = e instanceof api.SalonError ? (e.code === "limit" ? `limite:${e.retryS ?? 0}` : e.code) : (e as Error).message;
      conv.echec(local, code);
    }
  });
}

/**
 * Pièce à afficher (image, vocal, vidéo) : relue du serveur et déchiffrée, adresse blob: d'un
 * type sûr seulement ; rien d'autre n'est jamais montré dans la page (UI §12.4).
 */
export async function afficherPiece(b: Bulle): Promise<void> {
  const x = s;
  const p = b.piece;
  if (!x?.client || !p?.ref || pieces.urls[b.cle]) return;
  const mime = typeAffichage(p.sorte, p.mime);
  if (!mime || p.taille > (p.sorte === "video" ? PIECE_MAX : AFFICHE_MAX)) return;
  // Plafond de sortie, budget de lecture ou image déjà refusée à l'affichage : aucun nouvel essai.
  if (lectureDefinitive(pieces.erreurs[b.cle]) || pieces.erreurs[b.cle] === "apercu") return;
  try {
    const blob = await lire(x, b, p.sorte === "video" ? PIECE_MAX : AFFICHE_MAX);
    if (s !== x) return;
    // Image aux dimensions démesurées ou illisibles (bombe de décompression) : jamais décodée
    // d'office ; elle reste en mémoire pour « Enregistrer » (aucune seconde lecture du serveur).
    if (p.sorte === "image" && !(await previewable(blob))) {
      pieces.erreurs[b.cle] = "apercu";
      return;
    }
    // Deux appels pour la même lecture : une seule adresse blob:.
    if (s !== x || pieces.urls[b.cle] || !originaux.has(b.cle)) return;
    pieces.urls[b.cle] = URL.createObjectURL(new Blob([blob], { type: mime }));
  } catch (e) {
    pieces.erreurs[b.cle] = causeLecture(e);
  }
}

/** « Enregistrer » : le fichier, sous son nom nettoyé, en octets bruts (jamais ouvert par la page). */
export async function enregistrerPiece(b: Bulle): Promise<void> {
  const x = s;
  const p = b.piece;
  if (!x?.client || !p) return;
  if (lectureDefinitive(pieces.erreurs[b.cle]) && !originaux.has(b.cle)) return; // refus définitif : aucun nouvel essai
  try {
    const blob = originaux.get(b.cle) ?? (p.ref ? await lire(x, b, PIECE_MAX) : null);
    if (!blob) return;
    const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
    let nom = "fichier";
    try {
      nom = x.eng.nettoyerNom(p.nom) || nom;
    } catch {
      // nom refusé par le moteur : nom neutre
    }
    clickDownload(url, nom);
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
    accuserPiece(b, "piece_telechargee");
  } catch (e) {
    pieces.erreurs[b.cle] = causeLecture(e);
  }
}

/**
 * « Télécharger (N) » (v3 §14.3) : une seule archive .zip faite sur l'appareil (module zip
 * existant : stockée, sans compression ni métadonnée, noms nettoyés par le moteur puis par
 * zipName). 200 Mio au plus (l'archive est assemblée en mémoire). Chaque fichier envoie son
 * accusé « Téléchargé ». Rend null, ou le code d'erreur.
 */
export async function telechargerArchive(bs: Bulle[]): Promise<"trop_gros" | "lecture" | "indisponible" | "sortie" | "relu" | null> {
  const x = s;
  if (!x?.client || bs.length === 0) return "lecture";
  const choisies = bs.filter((b) => b.piece && !b.retire && (b.piece.ref || originaux.has(b.cle)));
  if (choisies.reduce((n, b) => n + b.piece!.taille, 0) > ZIP_BLOB_MAX_SMALL) return "trop_gros";
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const z = createZip({
    write: async (c) => void parts.push(c.slice()),
    close: async () => undefined,
    abort: async () => void (parts.length = 0),
  });
  const pris = new Set<string>();
  // Refus définitif déjà reçu pour une pièce choisie : aucun nouvel essai.
  const refusee = choisies.find((b) => lectureDefinitive(pieces.erreurs[b.cle]) && !originaux.has(b.cle));
  if (refusee) return pieces.erreurs[refusee.cle] as "sortie" | "relu";
  let courante: Bulle | undefined;
  try {
    for (const b of choisies) {
      courante = b;
      const p = b.piece!;
      const blob = await lire(x, b, PIECE_MAX);
      const octets = new Uint8Array(await blob.arrayBuffer());
      let nom = "fichier";
      try {
        nom = x.eng.nettoyerNom(p.nom) || nom;
      } catch {
        // nom refusé par le moteur : nom neutre
      }
      await z.add(zipName(nom, pris), octets.length, (async function* () {
        yield octets;
      })());
    }
    await z.finish();
  } catch (e) {
    await z.abort().catch(() => undefined);
    const c = causeLecture(e);
    if (lectureDefinitive(c) && courante) pieces.erreurs[courante.cle] = c;
    return c;
  }
  const url = URL.createObjectURL(new Blob(parts, { type: "application/zip" }));
  parts.length = 0;
  clickDownload(url, "salon.zip");
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  for (const b of choisies) {
    fichiersOuverts.add(b.cle);
    accuserPiece(b, "piece_telechargee");
  }
  return null;
}

/** Notre photo pour ce salon (ré-encodée 256 × 256 par ui/avatar.ts) : envoyée chiffrée, puis annoncée. */
export async function choisirAvatar(photo: Uint8Array | null): Promise<void> {
  const x = s;
  if (!x?.client) return;
  if (!photo) x.avatar = null;
  else x.avatar = await envoyerPiece(net(), x.client.jeton, new Blob([photo as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }), { nom: "avatar.jpg", mime: "image/jpeg", vocal: false });
  if (vue.monPseudo) envoyerProfil(x);
}

/** Avatar d'un siège (profil) : adresse blob: (image/jpeg seulement), ou null. */
/** Octets d'une photo de profil, au plus (v3 §7.2). */
const AVATAR_MAX = 65536;

export async function avatarDe(siege: number): Promise<void> {
  const x = s;
  const cle = `avatar:${siege}`;
  const ref = x?.conv?.avatars.get(siege);
  if (!x?.client || !ref || pieces.urls[cle]) return;
  try {
    const blob = await lirePiece(net(), x.client.jeton, ref, AVATAR_MAX);
    if (s === x && blob.size <= AVATAR_MAX && (await previewable(blob)) && s === x) pieces.urls[cle] = URL.createObjectURL(new Blob([blob], { type: "image/jpeg" }));
  } catch {
    // avatar indisponible : l'initiale reste
  }
}

export function reagir(b: Bulle, emoji: string): void {
  const x = s;
  if (!x?.client || !x.conv || !b.id || b.retire) return;
  x.client.envoyer({ k: "reaction", cible: hexOctets(b.id), emoji }, b.regle);
  x.conv.reagirLocal(b.id, emoji);
}

/** Message déjà vu sur cet appareil (affiché 1 s, page visible). */
export function estVu(b: Bulle): boolean {
  return s?.conv?.vuLe.has(b.cle) === true;
}
/** Accusés de pièce déjà envoyés (clé de bulle + sorte) : une fois chacun. */
const accusesPiece = new Set<string>();
/**
 * Accusé « Ouvert » ou « Téléchargé » d'une pièce reçue (v3 §14.2) :
 * « Ouvert » = contenu affiché ou lu dans l'application (image affichée dans un message vu, vocal ou
 * vidéo lancés) ; le site n'a pas de visionneuse de documents (seulement « Enregistrer »).
 */
export function accuserPiece(b: Bulle, sorte: "piece_ouverte" | "piece_telechargee"): void {
  const x = s;
  if (!x?.client || b.moi || !b.id || !b.piece) return;
  const k = `${b.cle}:${sorte}`;
  if (accusesPiece.has(k)) return;
  accusesPiece.add(k);
  x.client.accuser(sorte, [hexOctets(b.id)]);
}

/** Message affiché 1 s, page visible : accusé « vu » (chiffré) et, règles 1 à 3, lecture au serveur. */
export function vu(b: Bulle): void {
  const x = s;
  if (!x?.client || b.moi || !b.id) return;
  x.conv?.marquerVu(b.cle, Date.now());
  x.client.accuser("vu", [hexOctets(b.id)]);
  if (b.piece?.sorte === "image" && pieces.urls[b.cle]) accuserPiece(b, "piece_ouverte");
  if (b.regle !== 0 && b.seq !== null) x.client.lu(b.seq);
}

// --- Codes, gestion, fin ---------------------------------------------------------------

/** Code de vérification d'un siège (5 groupes de 5 chiffres), ou null hors du groupe. */
export function code(siege: number): string | null {
  return s?.client?.empreinte(siege) ?? null;
}
/** « J'ai comparé ce code » : gardé sur cet appareil, en mémoire, jusqu'au prochain changement. */
export function verifier(siege: number, oui: boolean): void {
  const c = code(siege);
  if (!s?.conv || !c) return;
  if (oui) s.conv.verifies.set(siege, c);
  else s.conv.verifies.delete(siege);
  vue.rev++;
}
export function verifie(siege: number): boolean {
  const c = code(siege);
  return c !== null && s?.conv?.verifies.get(siege) === c;
}

/** Destruction (créateur : J_gestion ; membre : si le salon le permet). Rend vrai si faite. */
export async function detruire(signaler = false): Promise<boolean> {
  const x = s;
  if (!x?.client) return false;
  const j = x.client.jetonGestion();
  try {
    await api.detruire(net(), j ? { jGestion: j } : { jeton: x.client.jeton }, signaler);
    return true;
  } catch {
    return false;
  } finally {
    j?.fill(0);
  }
}

/**
 * Créateur : exclut `siege` (ou change seulement l'invitation) ; la nouvelle invitation est
 * affichée et, si le salon est dans l'historique, gardée comme l'ancienne (lien de gestion
 * inchangé). Rend le code d'erreur, ou null.
 */
export async function exclureSiege(siege?: number): Promise<string | null> {
  const x = s;
  if (!x?.client || !x.sGestion) return "forbidden";
  try {
    const inv = await exclure(net(), x.eng, x.client, siege);
    const lien = lienSalon(location.origin, "c", inv.kLien, import.meta.env.BASE_URL);
    vue.nouvelleInvitation = { lien, mdp: inv.mdp };
    if (await gestionGardee(x.kLien).catch(() => undefined)) {
      const gestion = lienSalon(location.origin, "s", x.sGestion, import.meta.env.BASE_URL);
      await recordShare({ sorte: "salon_cree", manage: gestion, link: lien, label: "", createdAt: Date.now(), sizeBytes: 0, itemsCount: 0, expiresAt: vue.finMs, maxOpens: 0 });
    }
    x.lienOrigine ??= x.kLien;
    x.kLien = inv.kLien;
    return null;
  } catch (e) {
    return e instanceof api.SalonError ? e.code : "reseau";
  }
}

/** « Quitter et signaler » (spec §39.5) : le serveur fait partir le membre et compte le signalement. */
export async function quitterEtSignaler(): Promise<boolean> {
  const x = s;
  if (!x?.client) return false;
  try {
    await api.signaler(net(), x.client.jeton);
  } catch {
    return false;
  }
  x.client.arreter("quitte");
  return true;
}

/** Créateur : nombre de places (2 à 10, jamais sous les présents). Rend le code d'erreur, ou null. */
export async function reglerPlaces(n: number): Promise<string | null> {
  const x = s;
  const j = x?.client?.jetonGestion();
  if (!j) return "forbidden";
  try {
    const r = await api.reglages(net(), j, { maxMembers: n });
    vue.places = r.maxMembers;
    return null;
  } catch (e) {
    return e instanceof api.SalonError ? e.code : "reseau";
  } finally {
    j.fill(0);
  }
}

/**
 * Créateur : renouvellement (1, 6, 12 ou 24 h depuis maintenant, conversation effacée pour tous,
 * groupe recréé ; compte comme une création : preuve anti-robot). Rend le code d'erreur, ou null.
 */
export async function renouveler(h: Duree): Promise<string | null> {
  const x = s;
  if (!x?.client) return "forbidden";
  const cap = await captchaDuServeur(transferCtx(location.origin)).catch(() => null);
  if (!cap) return "reseau";
  const p = await solvePow(cap.challenge).catch(() => null);
  if (!p || p.kind !== "pow") return "robot";
  await new Promise((r) => setTimeout(r, Math.max(0, cap.receivedAt + CAPTCHA_MIN_MS - performance.now())));
  const j = x.client.jetonGestion();
  if (!j) return "forbidden";
  try {
    const r = await api.reglages(net(), j, { renouvelerH: h, preuve: { altcha: p.payload, hp: "", shown_at: cap.shownAt } });
    vue.finMs = Date.now() + r.expiresInS * 1000;
    return null;
  } catch (e) {
    return e instanceof api.SalonError ? e.code : "reseau";
  } finally {
    j.fill(0);
  }
}

let dernierEcrit = 0;
/** « En train d'écrire » : au plus toutes les 4 s pendant la frappe. */
export function ecrit(): void {
  const t = Date.now();
  if (t - dernierEcrit < 4_000) return;
  dernierEcrit = t;
  s?.client?.ecrit();
}

/** « Quitter le salon » : `0x03`, secrets effacés. */
export function quitter(): void {
  s?.client?.quitter();
}

/** Reconnexion tout de suite (onglet revenu, réseau revenu). */
export function reveiller(): void {
  s?.client?.reveiller();
}

const hexOctets = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));


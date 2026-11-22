// Le compte sur cet appareil (conception compte §9, §10, §21.2 ; plan du compte, lot 9). Seul
// détenteur du jeton de session, de K_compte et de s_profil (règle de §37.3,
// source-rules.test.ts) ; les écrans n'importent que ce module, derrière __COMPTES__.
// - Le mot de passe ne quitte jamais l'appareil : seul A_auth (Argon2id puis HKDF, moteur Rust)
//   part ; KEK_mdp n'ouvre ou ne ferme que l'enveloppe de K_compte, ici.
// - Par défaut tout est en mémoire (un rechargement redemande le mot de passe) ; « Rester
//   connecté » : persist.ts (sa base IndexedDB, chiffrée, clé non extractible).
// - Deux coffres (vaults.ts) : profil (pseudo, photo, langue, réglages, pass ; séquestré : le
//   serveur peut le rouvrir) et privé (secrets : par le mot de passe seulement). L'écriture du
//   coffre privé après un événement de partage ou de salon est différée de 2 à 12 min, tirées au
//   hasard (§37.11 A-G2 : une écriture juste après l'événement les relierait en direct).
// - Pseudo : règle et p_canon du module du salon (src/salon/engine.ts), chargé seulement ici.
// - Déconnexion : le serveur oublie la session (au mieux : sans réseau, l'appareil efface quand
//   même) ; l'appareil efface la base de persist.ts, K_compte, s_profil et le clair des coffres.
// - Historique de l'appareil (lot 11, sync.ts) : à l'ouverture, fusion avec le coffre privé
//   (écriture immédiate, liée à la connexion que le serveur voit déjà) ; ensuite chaque ajout ou
//   retrait fait sur l'appareil part dans l'écriture différée. Déconnexion, session échue, ou
//   démarrage sans session gardée : les entrées venues du compte sont retirées de l'appareil,
//   celles de l'appareil restent (§37.11 A-G8).
import * as api from "./api";
import { synchroniserPass } from "./pass";
import { netParDefaut, type Net, type Preuve } from "./api";
import { aleatoire32, clesDeKCompte, clesDuCompte, ouvrirEnveloppe, scellerEnveloppe, type ClesCompte } from "./keys";
import { creerCoffre, ouvrir, priveDeJson, priveEnJson, priveVide, profilDeJson, profilEnJson, sceller, type Coffre, type CoffrePrive, type Profil, type Sorte } from "./vaults";
import { nomAppareil, scellerEtiquette } from "./device";
import { effacer, idbDuNavigateur, lire, sauver } from "./persist";
import { b64u } from "../engine/pure";
import { deriverCompte, motDePasseValide, normaliserAdresse, type Adresse } from "../engine/index";
import { loadSalonEngine, type SalonEngine } from "../salon/engine";
import { allEntries, dropAccountEntries, dropEntries, importEntries, onLocalChange, setAccountPrefs } from "../history/live.svelte";
import type { HistoryEntry } from "../history/store";
import { ajouterEntree, fusionner, renommerEntree, retirerEntree } from "./sync";
import { partagesConnus, supprimerTout as suppression, type Progres } from "./suppression";
import { clearDownloads } from "../downloads/live.svelte";
import { clearHistory } from "../history/live.svelte";
import { destroyShare } from "../index";
import { ouvrirEtiquette } from "./device";

export type { Profil, Reglages, CoffrePrive, EntreePrivee } from "./vaults";
export { REGLAGES_DEFAUT } from "./vaults";
export { CompteError, type Preuve, type EtatServeur } from "./api";
export type { Progres } from "./suppression";

type Bytes = Uint8Array<ArrayBuffer>;
type PseudoMoteur = Pick<SalonEngine, "pseudoValide" | "cleUnicite" | "pseudoReserve">;

type Deps = {
  net: Net;
  idb: () => IDBFactory | null;
  agent: () => string;
  /** Lance `f` dans `ms` ; rend l'annulation. */
  planifier: (ms: number, f: () => void) => () => void;
  salon: () => Promise<PseudoMoteur>;
  /** A_auth et KEK_mdp (Argon2id du moteur) ; l'appelant efface les deux. */
  deriver: typeof deriverCompte;
  /** Historique de l'appareil (history/live.svelte.ts). */
  historique: Historique;
  /** Suppression du compte (lot 13) : destruction d'un partage par son lien de gestion, effacement de l'appareil. */
  detruirePartage: (lienGestion: string) => Promise<void>;
  effacerAppareil: () => Promise<void>;
  maintenant: () => number;
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
  deriver: deriverCompte,
  historique: { lister: allEntries, importer: importEntries, retirer: dropEntries, retirerCompte: dropAccountEntries, ecouter: onLocalChange, regler: setAccountPrefs },
  // Même origine que la page (démo : base du dépôt) ; secret de gestion seul, jamais le jeton de session.
  detruirePartage: (l) => destroyShare(l, globalThis.location?.origin ?? ""),
  effacerAppareil: async () => {
    await clearHistory().catch(() => undefined);
    await clearDownloads().catch(() => undefined);
  },
  maintenant: () => Date.now(),
});
let deps: Deps = defaut();

/** Tests : remplace les accès au réseau, au stockage, à l'horloge et au moteur du salon. */
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
  /** Session ouverte par « Mot de passe oublié » (§21.2.3) : bandeau de l'accueil (§21.15.1). */
  recupere = $state(false);
  /** « Rester connecté » : la session est gardée sur cet appareil (persist.ts). */
  persistante = $state(false);
  /**
   * Le compte vient d'être supprimé depuis cette page : l'écran de fin (« Compte supprimé. »)
   * reste affiché alors que la session n'existe plus. Remis à faux à l'ouverture d'une session.
   */
  supprime = $state(false);
}
export const account = new EtatCompte();

// --- Secrets en mémoire ----------------------------------------------------------------------

type Ouverte = {
  jeton: string;
  h: Bytes;
  kCompte: Bytes;
  sProfil: Bytes;
  cles: ClesCompte;
  persistante: boolean;
  profil: Coffre<Profil>;
  prive: Coffre<CoffrePrive>;
  /**
   * Adresse du compte, seulement si elle a été tapée dans CETTE page (inscription, connexion,
   * récupération, confirmation d'identité) : mémoire seulement, jamais gardée sur l'appareil ni
   * dans un coffre. Elle donne le sel d'A_auth pour une confirmation d'identité (lot 13) ; après
   * un rechargement (« Rester connecté »), l'écran la redemande.
   */
  adresse?: Adresse;
};
let ouverte: Ouverte | null = null;
let inscription: { h: Bytes; etape: string; adresse: Adresse } | null = null;
let totp: { etape: string; kek: Bytes; persistante: boolean; adresse: Adresse } | null = null;
let emailEnCours: { etape: string; nouvelle: Adresse } | null = null;
let totpEnCours: string | null = null;
let oubliEnCours: { etape: string; adresse: Adresse; h?: Bytes; genPrive?: number } | null = null;
let attente: { patches: ((p: CoffrePrive) => CoffrePrive)[]; annuler: () => void } | null = null;
let arreterEcoute: (() => void) | null = null;

/** Efface tout ce que la page tient du compte (ce que fait aussi un rechargement). */
function oublierMemoire(): void {
  attente?.annuler();
  attente = null;
  arreterEcoute?.();
  arreterEcoute = null;
  if (ouverte) {
    ouverte.kCompte.fill(0);
    ouverte.sProfil.fill(0);
  }
  totp?.kek.fill(0);
  ouverte = inscription = totp = oubliEnCours = emailEnCours = totpEnCours = null;
  account.etat = "absent";
  account.profil = account.prive = account.erreur = undefined;
  account.recupere = false;
  account.persistante = false;
}
/** Tests : simule un rechargement de la page. */
export const _oublierMemoire = oublierMemoire;

const illisibles = new Set(["coffre_illisible", "coffre_recule", "coffre_version", "enveloppe_invalide"]);

/** Session échue (401) : l'appareil oublie tout ; coffre illisible : signalé à l'écran. */
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
async function synchroniser(o: Ouverte, recuperation: boolean): Promise<void> {
  const h = deps.historique;
  h.regler({ keepReceived: o.profil.valeur.reglages.garderRecus });
  arreterEcoute = h.ecouter((c) => {
    if (ouverte !== o) return;
    const f = (p: CoffrePrive) => (c.kind === "add" ? ajouterEntree(p, c.entry) : c.kind === "rename" ? renommerEntree(p, c.entry) : retirerEntree(p, c.entry));
    void ecrirePrive(f, { differe: true }).catch(() => undefined);
  });
  try {
    const local = await h.lister();
    const r = fusionner(local, o.prive.valeur, { now: Date.now(), recuperation });
    if (r.retirer.length > 0) await h.retirer(r.retirer);
    if (r.importer.length > 0) await h.importer(r.importer);
    if (r.coffre !== null && ouverte === o) {
      // Sur 409, la fusion est refaite sur le coffre relu.
      await ecrireTout(o, [(p) => fusionner(local, p, { now: Date.now(), recuperation }).coffre ?? p]);
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
  await sauver(idb, { jeton: o.jeton, h: o.h, kCompte: o.kCompte, sProfil: o.sProfil, genProfil: o.profil.gen, genPrive: o.prive.gen }).catch(() => undefined);
}

function transport(jeton: string, sorte: Sorte) {
  return {
    lire: () => api.lireCoffre(deps.net, jeton, sorte),
    ecrire: (ifGen: number, blob: Bytes) => api.ecrireCoffre(deps.net, jeton, sorte, ifGen, blob),
  };
}

/** Ouvre la session : coffres déjà lus (profil, privé) ou à relire (`null`). */
async function ouvrirSession(s: {
  jeton: string;
  h: Bytes;
  kCompte: Bytes;
  sProfil: Bytes;
  persistante: boolean;
  profil: { blob: Uint8Array; gen: number } | { relire: number };
  prive: { blob: Uint8Array; gen: number } | { relire: number } | { valeur: CoffrePrive; gen: number };
  /** Après « Mot de passe oublié » : tout l'historique de l'appareil revient dans le coffre neuf. */
  recuperation?: boolean;
  /** Adresse tapée dans cette page (mémoire seulement). */
  adresse?: Adresse;
}): Promise<void> {
  const cles = await clesDuCompte(s.kCompte, s.sProfil);
  const coffre = async <T>(sorte: Sorte, src: { blob: Uint8Array; gen: number } | { relire: number } | { valeur: T; gen: number }, versJson: (v: T) => Bytes, deJson: (b: Uint8Array) => T, vide: T) => {
    const gen = "relire" in src ? src.relire : src.gen;
    const valeur = "valeur" in src ? src.valeur : "blob" in src ? deJson(await ouvrir(sorte, cles[sorte], s.h, src.blob, src.gen)) : vide;
    const c = creerCoffre<T>({ sorte, cle: cles[sorte], h: s.h, transport: transport(s.jeton, sorte), versJson, deJson, valeur, gen });
    if ("relire" in src) await c.relire();
    return c;
  };
  const profil = await coffre<Profil>("profil", s.profil, profilEnJson, profilDeJson, undefined as unknown as Profil);
  const prive = await coffre<CoffrePrive>("prive", s.prive, priveEnJson, priveDeJson, priveVide());
  oublierMemoire();
  ouverte = { jeton: s.jeton, h: s.h, kCompte: s.kCompte, sProfil: s.sProfil, cles, persistante: s.persistante, profil, prive, adresse: s.adresse };
  account.persistante = s.persistante;
  account.profil = profil.valeur;
  account.prive = prive.valeur;
  account.etat = "ouvert";
  account.supprime = false;
  account.recupere = s.recuperation === true;
  const o = ouverte;
  await memoriser(o);
  await synchroniser(o, s.recuperation === true);
}

async function etiquette(cle: CryptoKey, h: Uint8Array): Promise<Bytes> {
  return scellerEtiquette(cle, h, nomAppareil(deps.agent()));
}

/** Pseudo affiché et p_canon ; réservé : Error("pseudo_reserve") ; règle du salon (§39.4). */
async function pseudoCanon(p: string): Promise<{ affiche: string; pCanon: string }> {
  const s = await deps.salon();
  const affiche = s.pseudoValide(p);
  const pCanon = s.cleUnicite(affiche);
  if (s.pseudoReserve(pCanon)) throw new Error("pseudo_reserve");
  return { affiche, pCanon };
}

// --- Saisie (écrans) ----------------------------------------------------------------------------

/**
 * Vérifie sur l'appareil, sans requête, ce que l'écran a saisi : codes d'erreur par champ
 * (adresse_invalide, adresse_non_ascii ; mdp_court, mdp_long, mdp_adresse ; pseudo_longueur,
 * pseudo_caracteres, pseudo_ecritures, pseudo_reserve). Objet vide : rien à redire. Mêmes règles
 * que confirmer() et oubli.fin() (moteur), dites avant d'envoyer un code.
 */
/**
 * Pseudo provisoire tiré à l'inscription (« Membre » ou « Member » et 6 chiffres, 20 novembre) :
 * le vrai pseudo est demandé à la première entrée dans un salon, ou dans le profil. Personne ne
 * peut le choisir (verifierSaisie le dit réservé).
 */
export const estPseudoProvisoire = (p: string | undefined | null): boolean => !!p && /^(Membre|Member)\d{6}$/u.test(p);

/** Vrai si le compte ouvert a encore son pseudo provisoire. */
/** Forme des pseudos provisoires, quelle que soit la casse : refusée à la saisie (audit du 20 novembre). */
const formeProvisoire = (p: string) => /^(membre|member)\d{6}$/iu.test(p.trim());

export function pseudoAChoisir(): boolean {
  // Réglage « Proposer mon pseudo et ma photo » coupé : le pseudo d'un salon reste à part du
  // compte (audit du 20 novembre), il ne devient pas celui du compte.
  return !!ouverte && account.profil?.reglages.proposerProfil === true && estPseudoProvisoire(account.profil.pseudo);
}

export async function verifierSaisie(s: { email?: string; mdp?: string; pseudo?: string }): Promise<Partial<Record<"email" | "mdp" | "pseudo", string>>> {
  const out: Partial<Record<"email" | "mdp" | "pseudo", string>> = {};
  const code = (e: unknown) => {
    if (e instanceof Error) return e.message;
    throw e;
  };
  let adresse: Adresse | null = null;
  if (s.email !== undefined)
    try {
      adresse = await normaliserAdresse(s.email);
    } catch (e) {
      out.email = code(e);
    }
  if (s.mdp !== undefined) {
    try {
      // Adresse invalide ou absente : la règle de longueur se vérifie quand même (adresse neutre).
      await motDePasseValide(s.mdp, adresse ?? { canon: "", exacte: "" });
    } catch (e) {
      out.mdp = code(e);
    }
  }
  if (s.pseudo !== undefined) {
    try {
      // Forme des pseudos provisoires refusée quelle que soit la casse (audit du 20 novembre) :
      // l'unicité ignore la casse, « membre123456 » bloquerait le pseudo provisoire d'un autre.
      if (formeProvisoire(s.pseudo)) throw new Error("pseudo_reserve");
      await pseudoCanon(s.pseudo);
    } catch (e) {
      out.pseudo = code(e);
    }
  }
  return out;
}

// --- Inscription -----------------------------------------------------------------------------

/** Étape 1 : envoie le code (toujours la même réponse, que l'adresse ait un compte ou non). */
export async function inscrire(email: string, langue: string, preuve: Preuve): Promise<void> {
  const adresse = await normaliserAdresse(email);
  const r = await api.inscriptionDebut(deps.net, { email: adresse.exacte, langue, ...preuve });
  inscription = { h: r.h, etape: r.etape, adresse };
}

export async function renvoyerCode(): Promise<void> {
  if (inscription) return api.inscriptionRenvoyer(deps.net, inscription.etape, inscription.adresse.exacte);
  if (oubliEnCours) return api.oubliRenvoyer(deps.net, oubliEnCours.etape, oubliEnCours.adresse.exacte);
  if (emailEnCours && ouverte) {
    const { jeton } = ouverte;
    const e = emailEnCours;
    return garde(() => api.emailRenvoyer(deps.net, jeton, e.etape, e.nouvelle.exacte));
  }
  throw new Error("aucune_etape");
}

/**
 * Étape 2 : code reçu. Tire K_compte et s_profil, construit les deux coffres (gen 1), calcule
 * p_canon, puis `inscription/fin`. Refus avant toute requête : mdp_court, mdp_long, mdp_adresse,
 * pseudo_* (règle du salon), pseudo_reserve. Erreur du serveur (code_faux, pseudo_pris,
 * deja_inscrit, banni…) : l'inscription reste en cours (nouvel essai possible).
 */
export async function confirmer(code: string, mdp: string, profil: Profil, persistante: boolean): Promise<void> {
  const ins = inscription;
  if (!ins) throw new Error("aucune_etape");
  await motDePasseValide(mdp, ins.adresse);
  const { affiche, pCanon } = await pseudoCanon(profil.pseudo);
  const p: Profil = { ...profil, pseudo: affiche };
  const { aAuth, kekMdp } = await deps.deriver(mdp, ins.adresse.canon);
  const kCompte = aleatoire32();
  const sProfil = aleatoire32();
  let garde_ = false;
  try {
    const cles = await clesDuCompte(kCompte, sProfil);
    const envMdp = await scellerEnveloppe(kekMdp, ins.h, kCompte);
    const blobProfil = await sceller("profil", cles.profil, ins.h, 1, profilEnJson(p));
    const blobPrive = await sceller("prive", cles.prive, ins.h, 1, priveEnJson(priveVide()));
    const r = await api.inscriptionFin(deps.net, { etape: ins.etape, code, aAuth, envMdp, sProfil, pCanon, blobProfil, blobPrive, persistante, etiquette: await etiquette(cles.etiquette, ins.h) });
    await ouvrirSession({ jeton: r.session, h: ins.h, kCompte, sProfil, persistante, profil: { blob: blobProfil, gen: 1 }, prive: { valeur: priveVide(), gen: 1 }, adresse: ins.adresse });
    garde_ = true;
  } finally {
    aAuth.fill(0);
    kekMdp.fill(0);
    if (!garde_) {
      kCompte.fill(0);
      sProfil.fill(0);
    }
  }
}

// --- Connexion -------------------------------------------------------------------------------

async function apresOuverture(o: api.Ouverture, kek: Bytes, persistante: boolean, adresse: Adresse): Promise<void> {
  const kCompte = await garde(() => ouvrirEnveloppe(kek, o.h, o.envMdp));
  try {
    await garde(() => ouvrirSession({ jeton: o.session, h: o.h, kCompte, sProfil: o.sProfil, persistante, profil: { blob: o.blobProfil, gen: o.genProfil }, prive: { blob: o.blobPrive, gen: o.genPrive }, adresse }));
  } catch (e) {
    kCompte.fill(0);
    o.sProfil.fill(0);
    throw e;
  }
  // Nom d'appareil, au mieux : un échec (réseau, serveur) ne ferme pas la session ouverte ; la
  // liste des appareils montrera seulement une ligne sans nom.
  const ouv = ouverte;
  if (ouv) await etiquette(ouv.cles.etiquette, ouv.h).then((e) => api.etiquetterSession(deps.net, ouv.jeton, e)).catch(() => undefined);
}

/**
 * Connexion : « ouvert », ou « totp » (code de l'application à donner à validerTotp). Le nom
 * d'appareil n'est pas dans la connexion (K_compte, qui le chiffre, n'est connue qu'après la
 * réponse) : il part juste après, par sessions/etiquette.
 */
export async function seConnecter(email: string, mdp: string, persistante: boolean, preuve?: Preuve): Promise<"ouvert" | "totp"> {
  const adresse = await normaliserAdresse(email);
  const { aAuth, kekMdp } = await deps.deriver(mdp, adresse.canon);
  let gardeKek = false;
  try {
    const r = await api.connexion(deps.net, { email: adresse.exacte, aAuth, persistante, etiquette: null, preuve });
    if ("totp" in r) {
      totp?.kek.fill(0);
      totp = { etape: r.totp, kek: kekMdp, persistante, adresse };
      gardeKek = true;
      return "totp";
    }
    await apresOuverture(r, kekMdp, persistante, adresse);
    return "ouvert";
  } finally {
    aAuth.fill(0);
    if (!gardeKek) kekMdp.fill(0);
  }
}

export async function validerTotp(code: string): Promise<void> {
  const t = totp;
  if (!t) throw new Error("aucune_etape");
  const r = await api.connexionTotp(deps.net, t.etape, code); // erreur : l'étape reste (5 essais)
  totp = null;
  try {
    await apresOuverture(r, t.kek, t.persistante, t.adresse);
  } finally {
    t.kek.fill(0);
  }
}

// --- Mot de passe oublié (§21.2.3) -------------------------------------------------------------

export const oubli = {
  /** Adresse EXACTE du compte ; toujours la même réponse. */
  async debut(email: string, langue: string, preuve: Preuve): Promise<void> {
    const adresse = await normaliserAdresse(email);
    const r = await api.oubliDebut(deps.net, { email: adresse.exacte, langue, ...preuve });
    oubliEnCours = { etape: r.etape, adresse };
  },
  /** « ok » : passer au nouveau mot de passe ; `{ attenteJusqu }` : retrait de la double authentification demandé. */
  async verifier(code: string, codeTotp: string, totpPerdu: boolean): Promise<"ok" | { attenteJusqu: string }> {
    const o = oubliEnCours;
    if (!o) throw new Error("aucune_etape");
    const r = await api.oubliVerifier(deps.net, { etape: o.etape, code, totp: codeTotp, totpPerdu });
    if ("attenteJusqu" in r) return r;
    o.h = r.h;
    o.genPrive = r.genPrive;
    return "ok";
  },
  /**
   * Nouveau mot de passe : nouveau K_compte, nouveau coffre privé vide (gen qui continue) ; le
   * profil est rendu par le séquestre. Toutes les autres sessions sont fermées par le serveur.
   */
  async fin(mdp: string, persistante: boolean): Promise<void> {
    const o = oubliEnCours;
    if (!o?.h || o.genPrive === undefined) throw new Error("aucune_etape");
    await motDePasseValide(mdp, o.adresse);
    const { aAuth, kekMdp } = await deps.deriver(mdp, o.adresse.canon);
    const kCompte = aleatoire32();
    let garde_ = false;
    try {
      const k = await clesDeKCompte(kCompte);
      const envMdp = await scellerEnveloppe(kekMdp, o.h, kCompte);
      const gen = o.genPrive + 1;
      const blobPrive = await sceller("prive", k.prive, o.h, gen, priveEnJson(priveVide()));
      const r = await api.oubliFin(deps.net, { etape: o.etape, aAuth, envMdp, blobPrive, persistante, etiquette: await etiquette(k.etiquette, o.h) });
      if (r.genPrive !== gen || r.h.some((x, i) => x !== o.h![i])) throw new Error("reponse_invalide");
      await garde(() => ouvrirSession({ jeton: r.session, h: r.h, kCompte, sProfil: r.sProfil, persistante, profil: { blob: r.blobProfil, gen: r.genProfil }, prive: { valeur: priveVide(), gen }, recuperation: true, adresse: o.adresse }));
      garde_ = true;
    } finally {
      aAuth.fill(0);
      kekMdp.fill(0);
      if (!garde_) kCompte.fill(0);
    }
  },
};

// --- État du compte ---------------------------------------------------------------------------

/** GET /api/compte : palier, dates, double authentification, bannissement, attente de récupération. */
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
 * libre si aucun AUTRE compte ne l'a et qu'il n'est ni réservé ni interdit (décision du
 * propriétaire, 22 novembre). Le sien est toujours permis. Requête sans session ni salon.
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
  if (mien && !estPseudoProvisoire(mien)) {
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
  if (formeProvisoire(p)) throw new Error("pseudo_reserve");
  const { affiche, pCanon } = await pseudoCanon(p);
  await garde(() => api.changerPseudo(deps.net, o.jeton, pCanon));
  await ecrireProfil({ pseudo: affiche });
}

// --- Salon ----------------------------------------------------------------------------------

/**
 * Crée un salon avec la session ouverte (conception §10.4) : en-têtes du salon (K_accès_s,
 * J_gestion, base64url) et corps faits par l'écran de création (salon/api.ts, CorpsCreation).
 * Le secret de gestion entre ensuite au coffre par l'historique de l'appareil (entrée
 * `salon_cree`, sync.ts, écriture différée). Sans session : Error("aucune_session").
 */
export async function creerSalon(entetes: { acces: string; gestion: string }, corps: Record<string, unknown>): Promise<{ expiresInS: number }> {
  const o = ouverteOuErreur();
  return garde(() => api.creerSalon(deps.net, o.jeton, entetes, corps));
}

/** Pseudo et photo du compte à proposer à l'entrée d'un salon (réglage « Proposer mon pseudo et ma photo »), ou null. */
export function profilPourSalon(): { pseudo: string; photo: Uint8Array | null } | null {
  const p = account.profil;
  if (!ouverte || !p || !p.reglages.proposerProfil) return null;
  return { pseudo: estPseudoProvisoire(p.pseudo) ? "" : p.pseudo, photo: p.photo };
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
 * connexion suivante, lot 11).
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
  try {
    await ouvrirSession({ jeton: s.jeton, h: s.h as Bytes, kCompte: s.kCompte as Bytes, sProfil: s.sProfil as Bytes, persistante: true, profil: { relire: s.genProfil }, prive: { relire: s.genPrive } });
  } catch (e) {
    s.kCompte.fill(0);
    s.sProfil.fill(0);
    // Session échue ou fermée ailleurs : cas attendu, l'appareil l'oublie sans erreur.
    if (e instanceof api.CompteError && e.status === 401) return oublierAppareil();
    if (e instanceof Error && illisibles.has(e.message)) account.erreur = "coffre_illisible";
    account.etat = "absent"; // réseau : la session gardée reste, un prochain restaurer() réessaie
    throw e;
  }
}

/**
 * Déconnexion : l'appareil oublie tout, même si le serveur ne répond pas ; les autres onglets du
 * site aussi (audit du 18 novembre, BroadcastChannel). Sans réseau, la révocation de la session
 * est réessayée trois fois dans la minute (la session reste sinon valable côté serveur jusqu'à son
 * échéance) ; le jeton n'est jamais réécrit sur l'appareil pour cela.
 */
export async function seDeconnecter(): Promise<void> {
  const jeton = ouverte?.jeton;
  await oublierAppareil();
  annoncerDeconnexion();
  if (jeton === undefined) return;
  if (!(await revoquer(jeton))) void reessayerRevocation(jeton); // en arrière-plan : l'écran n'attend pas
}
/** Vrai si la révocation est faite ou inutile (refus du serveur, 401) ; faux sans réseau. */
async function revoquer(jeton: string): Promise<boolean> {
  try {
    await api.deconnexion(deps.net, jeton);
    return true;
  } catch (e) {
    return e instanceof api.CompteError;
  }
}
async function reessayerRevocation(jeton: string): Promise<void> {
  for (let essai = 1; essai <= 3; essai++) {
    await new Promise((r) => setTimeout(r, 5_000 * essai));
    if (await revoquer(jeton)) return;
  }
}

// Autres onglets (audit du 18 novembre) : une déconnexion ici efface la mémoire du compte partout
// sur ce site ; aucun secret ne passe sur le canal (un simple signal).
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
/**
 * Retour sur l'onglet (audit du 18 novembre) : une session fermée depuis un autre appareil ou
 * échue est vue tout de suite (401 → l'appareil oublie tout), sans attendre une action.
 */
export async function verifierAuRetour(): Promise<void> {
  if (!ouverte) return;
  await etatCompte().catch(() => undefined);
}

// --- Paramètres (plan, lot 13 ; conception compte §21.15.4) --------------------------------------
// Les changements de sécurité demandent une session « récente » (serveur) : l'écran confirme
// d'abord l'identité (mot de passe, et code de l'application si elle est active). Le mot de passe
// ne quitte jamais l'appareil : seulement A_auth et l'enveloppe de K_compte.

/** L'adresse du compte a été tapée dans cette page (sinon : l'écran la demande). */
export function adresseConnue(): boolean {
  return ouverte?.adresse !== undefined;
}

/**
 * Rend la session « récente » (reauth). `email` : l'adresse tapée à l'écran (exigée si la page ne
 * la connaît pas : Error("adresse_requise"), sans requête). Réussite : l'adresse est retenue
 * en mémoire pour la suite (changement de mot de passe ou d'adresse).
 */
export async function confirmerIdentite(mdp: string, codeTotp: string, email?: string): Promise<void> {
  const o = ouverteOuErreur();
  const adresse = email !== undefined && email.trim() !== "" ? await normaliserAdresse(email) : o.adresse;
  if (!adresse) throw new Error("adresse_requise");
  const { aAuth, kekMdp } = await deps.deriver(mdp, adresse.canon);
  try {
    await garde(() => api.reauth(deps.net, o.jeton, aAuth, codeTotp));
    if (ouverte === o) o.adresse = adresse;
  } finally {
    aAuth.fill(0);
    kekMdp.fill(0);
  }
}

/** Nouveau mot de passe : nouvelle enveloppe de K_compte ; le serveur ferme TOUJOURS les autres sessions. */
export async function changerMotDePasse(nouveau: string): Promise<void> {
  const o = ouverteOuErreur();
  if (!o.adresse) throw new Error("adresse_requise");
  await motDePasseValide(nouveau, o.adresse);
  const { aAuth, kekMdp } = await deps.deriver(nouveau, o.adresse.canon);
  try {
    const envMdp = await scellerEnveloppe(kekMdp, o.h, o.kCompte);
    await garde(() => api.changerMdp(deps.net, o.jeton, aAuth, envMdp));
  } finally {
    aAuth.fill(0);
    kekMdp.fill(0);
  }
}

/** Changement d'adresse (§21.3, R21) : code à la nouvelle adresse seulement ; mot de passe redemandé (le sel change). */
export const changementAdresse = {
  /** Après confirmerIdentite avec l'adresse ACTUELLE exacte. */
  async debut(nouvelle: string, langue: string): Promise<void> {
    const o = ouverteOuErreur();
    if (!o.adresse) throw new Error("adresse_requise");
    const n = await normaliserAdresse(nouvelle);
    const actuelle = o.adresse.exacte;
    const r = await garde(() => api.emailDebut(deps.net, o.jeton, { actuel: actuelle, nouveau: n.exacte, langue }));
    emailEnCours = { etape: r.etape, nouvelle: n };
  },
  /** Code reçu, mot de passe (A_auth et enveloppe refaits avec le sel de la nouvelle adresse), code de l'application ("" si inactive). */
  async fin(code: string, mdp: string, codeTotp: string): Promise<void> {
    const o = ouverteOuErreur();
    const e = emailEnCours;
    if (!e) throw new Error("aucune_etape");
    await motDePasseValide(mdp, e.nouvelle);
    const { aAuth, kekMdp } = await deps.deriver(mdp, e.nouvelle.canon);
    try {
      const envMdp = await scellerEnveloppe(kekMdp, o.h, o.kCompte);
      await garde(() => api.emailFin(deps.net, o.jeton, { etape: e.etape, code, aAuth, envMdp, totp: codeTotp }));
      emailEnCours = null;
      if (ouverte === o) o.adresse = e.nouvelle;
    } finally {
      aAuth.fill(0);
      kekMdp.fill(0);
    }
  },
};

/**
 * Activation de la double authentification : secret rendu une fois par le serveur, lien d'ajout
 * construit ici, SANS adresse ni pseudo dans le libellé (§8.4 : l'application se synchronise
 * souvent dans un nuage). Le QR est dessiné sur l'appareil.
 */
export async function totpCommencer(): Promise<{ secret: string; lien: string }> {
  const o = ouverteOuErreur();
  const r = await garde(() => api.totpDebut(deps.net, o.jeton));
  totpEnCours = r.etape;
  return { secret: r.secret, lien: `otpauth://totp/Shhgone?secret=${r.secret}&issuer=Shhgone&algorithm=SHA1&digits=6&period=30` };
}

/** Premier code juste : la double authentification est active. */
export async function totpActiver(code: string): Promise<void> {
  const o = ouverteOuErreur();
  const etape = totpEnCours;
  if (!etape) throw new Error("aucune_etape");
  await garde(() => api.totpFin(deps.net, o.jeton, etape, code));
  totpEnCours = null;
}

export async function totpRetirer(): Promise<void> {
  const o = ouverteOuErreur();
  await garde(() => api.totpRetirer(deps.net, o.jeton));
}

export async function totpAnnulerRetrait(): Promise<void> {
  const o = ouverteOuErreur();
  await garde(() => api.totpAnnulerRetrait(deps.net, o.jeton));
}

/** Un appareil connecté (§8.5) : nom déchiffré ICI (null : aucun, ou illisible). */
export type Appareil = { sid: string; ajoutee: string; nom: string | null; courante: boolean; persistante: boolean };

export async function appareils(): Promise<Appareil[]> {
  const o = ouverteOuErreur();
  const l = await garde(() => api.sessions(deps.net, o.jeton));
  return Promise.all(l.map(async (s) => ({ sid: s.sid, ajoutee: s.ajoutee, nom: s.etiquette ? await ouvrirEtiquette(o.cles.etiquette, o.h, s.etiquette) : null, courante: s.courante, persistante: s.persistante })));
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
 * « Exporter mes données » (§12.4, §21.15.4 point 10) : fichier JSON fait SUR L'APPAREIL. Données
 * du serveur (GET export, sans adresse), profil déchiffré, et listes du coffre privé SANS leurs
 * secrets : ni lien de gestion, ni lien de partage ou d'invitation, ni identifiant (un fichier
 * exporté traîne souvent dans un dossier de téléchargements ; un lien de gestion y suffirait à
 * détruire un partage). Jamais l'adresse ni le jeton.
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
      v: 1,
      exporte_le: new Date(deps.maintenant()).toISOString().slice(0, 10),
      serveur: {
        cree_le: x.creeLe,
        anciennete_depuis: x.ancienneteDepuis,
        derniere_connexion_mois: x.vuMois,
        double_authentification: x.totp,
        retrait_double_authentification_le: x.retraitTotpLe,
        attente_apres_recuperation_jusqu: x.recupJusqu,
        banni_jusqu: x.banniJusqu,
        banni_motif: x.banniMotif,
        salons_actifs: x.salonsActifs,
        appareils: x.sessions,
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
 * Coupe « Rester connecté » sur cet appareil : la copie gardée (persist.ts) est effacée, la
 * session reste ouverte jusqu'au rechargement. L'activer ne se fait qu'à la connexion : le serveur
 * fixe la durée de la session à ce moment-là (aucune route pour la changer ensuite).
 */
export async function arreterResterConnecte(): Promise<void> {
  const o = ouverteOuErreur();
  o.persistante = false;
  account.persistante = false;
  const idb = deps.idb();
  if (idb) await effacer(idb).catch(() => undefined);
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
 * Supprime le compte (§21.12) : après confirmerIdentite (session récente). Progression pour
 * l'écran ; refus avant toute destruction pendant l'attente d'après une récupération.
 */
export function supprimerTout(opts: { effacerAppareil: boolean }): AsyncGenerator<Progres> {
  const o = ouverteOuErreur();
  return suppression(opts, {
    avant: async () => {
      const e = await garde(() => api.etat(deps.net, o.jeton));
      if (e.recupJusqu) throw new api.CompteError(403, "attente", { jusqu: e.recupJusqu });
    },
    partages: () => liensASupprimer(o),
    detruire: (l) => deps.detruirePartage(l),
    supprimerCompte: async () => (await garde(() => api.supprimer(deps.net, o.jeton))).salonsFermes,
    oublierCompte: () => {
      account.supprime = true; // avant que la session disparaisse : l'écran de fin reste monté
      return oublierAppareil();
    },
    effacerAppareil: () => deps.effacerAppareil(),
  });
}

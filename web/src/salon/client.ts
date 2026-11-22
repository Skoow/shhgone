// Client du salon (plan C-3, Task 3) : WebSocket du serveur (« Protocole » du plan C-2) et moteur
// MLS (salon/engine.ts), sans aucune vue. Seul fichier du site qui ouvre un WebSocket
// (source-rules.test.ts). Il suit le contrat de l'appelant du moteur (engine/salon/src/groupe.rs)
// et les exigences C-3 de la spec salon v3 §3.6.1 :
// - accueil : `0x0D` → `remplacerAnnonces` avant toute trame, KeyPackage publié hors du groupe ;
//   `0x02`/`0x0A` → `annoncer` ; `0x03` → `marquerParti` ; `0x09` → `marquerExclu` ; `0x01` →
//   `recevoirTrame` (siège attesté) ; l'arrivant y passe tout dès sa création (exigence 6) ;
// - fin du rattrapage : pong du ping envoyé après l'accueil (exigence 20) ; avant lui, personne
//   n'est ajouté ; ajouts et retraits faits par le plus petit siège en ligne du groupe ;
// - arrivant en attente : KeyPackage republié à chaque `0x07` en ligne, `0x02`, `0x0A` (15),
//   au plus toutes les 5 s ; `attente_pleine` ou retard (`epoque_perdue`) → reprise (6, C-2 5) ;
// - envoi : une seule trame `0x01` en vol, réglée par `0x0F` (rang), `0x0B` (mêmes octets après
//   le délai) ou `0x0C` (échec) ; refus du moteur (`commit_en_cours`, `retrait_en_attente`) :
//   le message attend, il ne part jamais par un autre chemin (23) ; volatils refusés : `ecrit`
//   abandonné, accusés regroupés avec les suivants ;
// - accusés `recu`/`vu` groupés, une trame au plus toutes les 2,5 s (19) ; `0x05` pour une trame
//   des règles 1 à 3 qui ne donne aucun message lisible (14), et pour un message vu ;
// - renouvellement MLS après 100 trames envoyées ou 1 h (12) ;
// - fermetures : 1001, 1011, 4006, coupure → reconnexion avec `depuis` (1 s, 2 s… 30 s) ;
//   4004 → nouvelle entrée par `rejoindre` (16) ; 4005 → arrêt sans reconnexion (35) ; 4002 ou
//   `0x05` raison 5 → exclusion ; `0x05` raisons 1, 2, 7 → fin du salon ;
// - groupe orphelin (17, plan C-3 point 6) : le créateur hors du groupe recrée le groupe à la fin
//   du rattrapage si aucun autre siège n'est en ligne, sinon 10 s plus tard sans Welcome.
// Secrets : K_lien et S_gestion gardés en mémoire de la page seulement, mis à zéro à `fermer` ;
// K_accès_s, K_preuve_s et J_gestion mis à zéro après chaque requête (exigences 5, 33).
import * as api from "./api";
import { DEPUIS_REPRISE, RAISONS_FIN, accueil, lire, lu, ping, PREND_UN_RANG, quitter, retirer as retirerTrame, trame as trameClient, type Enregistrement } from "./protocole";
import type { Annonce, ClesSalon, EnveloppeEnvoi, Evenement, Message, Regle, Salon, SalonEngine } from "./engine";

/** Ce que le client attend d'un WebSocket (celui du navigateur, ou un faux en test). */
export type WsLike = {
  binaryType: string;
  readonly readyState: number;
  send(b: Uint8Array<ArrayBuffer>): void;
  close(code?: number): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type Horloge = {
  maintenant(): number;
  plus_tard(ms: number, f: () => void): () => void;
};

export type Deps = {
  net: api.Net;
  eng: SalonEngine;
  /** WebSocket vers `url` (navigateur : celui de la page, créé par salon.svelte.ts). */
  ouvrirWS(url: string): WsLike;
  horloge?: Horloge;
  /** Octets aléatoires (ping). */
  alea?(n: number): Uint8Array<ArrayBuffer>;
};

/** Pourquoi le salon s'arrête pour cet appareil. */
export type Fin = "expire" | "detruit" | "exclu" | "remplace" | "interrompu" | "quitte" | "introuvable";

/** Événements du client, dans l'ordre où ils arrivent. */
export type EvClient =
  | { k: "liste"; createur: number; annonces: { siege: number; nonce: Uint8Array; derniereMin: number }[]; seq: number }
  | { k: "arrivee" | "reprise"; siege: number; seq: number }
  | { k: "depart"; siege: number; seq: number }
  | { k: "exclusion"; siege: number | undefined; seq: number; r: number }
  | { k: "presence"; siege: number; enLigne: boolean; derniereMin: number }
  | { k: "message"; seq: number; siege: number; recuMs: number; epoque: number; enveloppe: EnveloppeRecue }
  | { k: "membres"; ajoutes: number[]; retires: number[]; createurRevenu: boolean; membres: number[] }
  | { k: "efface"; cible: number }
  | { k: "reglages"; depart: number; secondes: number; places: number }
  | { k: "groupe"; dansLeGroupe: boolean }
  | { k: "connexion"; etat: "connexion" | "ouvert" | "coupe" }
  | { k: "chiffre"; local: number; id: Uint8Array }
  | { k: "accepte"; local: number; id: Uint8Array; seq: number }
  | { k: "echec"; local: number; code: string }
  | { k: "attente"; depuisMs: number | null }
  | { k: "nouvelleEntree"; siege: number }
  /** Salon renouvelé (0x10) : tout ce qui est de rang ≤ `depart` est effacé, le groupe est recréé. */
  | { k: "renouvellement"; depart: number }
  /** Invitation changée : groupe refondé ; `kMaitre` (K_maître_s', SECRET : copie à effacer) pour la preuve de membre. */
  | { k: "rotation"; kMaitre: Uint8Array }
  | { k: "fin"; raison: Fin };

/** Enveloppe lue (types du moteur). */
export type EnveloppeRecue = Extract<Evenement, { type: "message" }>["enveloppe"];

const ATTENTE_KP_MS = 5_000;
const ORPHELIN_MS = 10_000;
const ACCUSES_MS = 2_500;
const RENOUVELER_TRAMES = 100;
const RENOUVELER_MS = 3_600_000;
const RECONNEXION_MAX_MS = 30_000;
/** Délai d'une trame en vol sans réponse : le WebSocket est jugé mort et rouvert. */
const ENVOI_MS = 30_000;

const horlogeParDefaut: Horloge = {
  maintenant: () => Date.now(),
  plus_tard: (ms, f) => {
    const t = setTimeout(f, ms);
    return () => clearTimeout(t);
  },
};
const aleaParDefaut = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const deHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const egal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Trame à envoyer ; `att` : le message d'origine (rechiffré après une reprise ou une nouvelle entrée). */
type EnVol = { octets: Uint8Array<ArrayBuffer>; local?: number; id?: Uint8Array; att?: EnAttente; volatile: boolean; envoye: boolean; relance?: () => void; garde?: () => void };
type EnAttente = { local: number; e: EnveloppeEnvoi; piece?: Uint8Array; depuis: number };

export class ClientSalon {
  #siege: number;
  /** Siège de ce membre (il peut changer après une nouvelle entrée, 4004). */
  get siege(): number {
    return this.#siege;
  }
  /** Créateur : ce client détient S_gestion (dès l'entrée, ou repris par `reprendreLeRole`). */
  get createur(): boolean {
    return this.#sGestion !== undefined;
  }
  #deps: Required<Deps>;
  #cles: ClesSalon;
  #kLien: Uint8Array<ArrayBuffer>;
  #sGestion: Uint8Array<ArrayBuffer> | undefined;
  #jeton: string;
  #nonce: Uint8Array;
  #salon: Salon | undefined;
  #ws: WsLike | undefined;
  #ecouteurs = new Set<(e: EvClient) => void>();
  #presence = new Map<number, boolean>();
  #annonces = new Map<number, Uint8Array>();
  #kps = new Map<number, Uint8Array>();
  #dernierSeq = 0;
  #depart = 0;
  #rattrape = false;
  #ping: Uint8Array | undefined;
  #kpMs = -Infinity;
  /** Trames reçues avant notre entrée (rejouées par le moteur) : règle et heure de réception. */
  #regles = new Map<number, { regle: Regle; recuMs: number }>();
  #file: EnVol[] = [];
  #enVol: EnVol | undefined;
  #boite: EnAttente[] = [];
  #local = 0;
  #recus = new Set<string>();
  #vus = new Set<string>();
  #ouverts = new Set<string>();
  #telecharges = new Set<string>();
  #accusesTimer: (() => void) | undefined;
  #envoyees = 0;
  #commitMs: number;
  #essais = 0;
  #reconnexion: (() => void) | undefined;
  #orphelin: (() => void) | undefined;
  #perdues = new Set<number>();
  #fini = false;
  /** Plus grand numéro `r` d'exclusion ou de rotation vu (0x09). */
  #dernierR = 0;
  /** Rotation de l'invitation préparée par le créateur, en attente de son envoi ou de son écho. */
  #rotation: { r: number; cles: ClesSalon; cle: Uint8Array; kLien: Uint8Array; envoyee: boolean } | undefined;
  /** Faux après une rotation reçue : l'ancien lien n'ouvre plus le salon (pas de nouvelle entrée par lui). */
  #lienValide = true;
  #attenteNotee = false;
  #reglages: { depart: number; secondes: number; places: number } | undefined;

  private constructor(deps: Deps, cles: ClesSalon, kLien: Uint8Array, sGestion: Uint8Array | undefined, e: api.Entree) {
    this.#deps = { horloge: horlogeParDefaut, alea: aleaParDefaut, ...deps };
    this.#cles = cles;
    this.#kLien = kLien.slice();
    this.#sGestion = sGestion?.slice();
    this.#jeton = e.jeton;
    this.#siege = e.siege;
    this.#nonce = e.nonce;
    this.#commitMs = this.#deps.horloge.maintenant();
    // Rien de rang ≤ celui de notre entrée ne nous concerne (renouvellements d'avant compris).
    this.#depart = e.seq;
  }

  /**
   * Entre dans le salon : `rejoindre` (K_accès_s, K_preuve_s ; créateur : J_gestion), puis
   * l'état MLS (`creerGroupe` : création du salon, le créateur fonde le groupe), puis le
   * WebSocket. `cles` reste au client (libéré par `fermer`). Rend aussi l'entrée du serveur.
   */
  static async entrer(deps: Deps, o: { kLien: Uint8Array; cles: ClesSalon; sGestion?: Uint8Array; creerGroupe?: boolean }): Promise<{ client: ClientSalon; entree: api.Entree }> {
    const entree = await ClientSalon.rejoindre(deps, o);
    return { client: ClientSalon.ouvrir(deps, o, entree), entree };
  }

  /** `rejoindre` seul (le mot de passe est vérifié, une place est prise) ; `ouvrir` ensuite. */
  static async rejoindre(deps: Deps, o: { kLien: Uint8Array; cles: ClesSalon; sGestion?: Uint8Array }): Promise<api.Entree> {
    const entree = await ClientSalon.#rejoindre(deps, o.kLien, o.cles, o.sGestion);
    if ((o.sGestion !== undefined) !== (entree.siege === 0)) throw new Error("reponse_invalide");
    return entree;
  }

  /**
   * Retour par la preuve de membre (D41-26) : même jeton, même siège, nouvelle identité. Aucun
   * `rejoindre` (aucun essai de mot de passe compté) : l'accueil demande une reprise (`0x0A`,
   * nouveau `nonce_arrivée`) ; l'état MLS naît au 0x0D qui suit. Jeton refusé (4004 : place
   * libérée, serveur redémarré) : nouvelle entrée par `rejoindre`, comme d'habitude.
   */
  static reprendre(deps: Deps, o: { kLien: Uint8Array; cles: ClesSalon; jeton: string; siege: number; sGestion?: Uint8Array }): ClientSalon {
    const e: api.Entree = { jeton: o.jeton, siege: o.siege, seq: 0, nonce: new Uint8Array(16), expiresInS: 0, maxMembers: 0, membersCanDestroy: false, budgetLeft: 0, appels: false };
    const c = new ClientSalon(deps, o.cles, o.kLien, o.sGestion, e);
    c.#repriseBase = true;
    c.#connecter(DEPUIS_REPRISE);
    return c;
  }
  /** Reprise : le 0x10 de l'accueil donne l'état courant (aucun renouvellement à appliquer). */
  #repriseBase = false;

  /** État MLS et WebSocket d'une entrée déjà faite (`rejoindre`). */
  static ouvrir(deps: Deps, o: { kLien: Uint8Array; cles: ClesSalon; sGestion?: Uint8Array; creerGroupe?: boolean }, entree: api.Entree): ClientSalon {
    const c = new ClientSalon(deps, o.cles, o.kLien, o.sGestion, entree);
    c.#salon = deps.eng.Salon.creer(entree.siege, entree.nonce, o.cles, o.creerGroupe === true, o.sGestion);
    c.#connecter(BigInt(entree.seq));
    return c;
  }

  static async #rejoindre(deps: Deps, kLien: Uint8Array, cles: ClesSalon, sGestion: Uint8Array | undefined): Promise<api.Entree> {
    const acces = deps.eng.cleAcces(kLien);
    const kPreuve = cles.kPreuve();
    const j = sGestion ? deps.eng.jetonGestion(sGestion) : undefined;
    try {
      return await api.rejoindre(deps.net, acces.k, kPreuve, j);
    } finally {
      acces.k.fill(0);
      acces.v.fill(0);
      kPreuve.fill(0);
      j?.fill(0);
    }
  }

  /** Abonnement aux événements ; rend le désabonnement. */
  ecouter(f: (e: EvClient) => void): () => void {
    this.#ecouteurs.add(f);
    return () => this.#ecouteurs.delete(f);
  }

  /** Membres du groupe au dernier événement `membres` émis (différence à l'écho de notre Commit). */
  #membresVus: number[] = [];

  #emettre(e: EvClient): void {
    if (e.k === "membres") this.#membresVus = e.membres;
    for (const f of [...this.#ecouteurs]) f(e);
  }

  /** Sièges du groupe MLS (vide hors du groupe). */
  membres(): number[] {
    return this.#salon?.membres() ?? [];
  }
  dansLeGroupe(): boolean {
    return this.#salon?.epoque() !== undefined;
  }
  /** Code de vérification d'un siège du groupe (5 groupes de 5 chiffres), ou null. */
  empreinte(siege: number): string | null {
    try {
      return this.#salon?.empreinte(siege) ?? null;
    } catch {
      return null;
    }
  }
  /** `nonce_arrivée` courant d'un siège (exclusion : le serveur refuse un siège réattribué). */
  nonceDe(siege: number): Uint8Array | undefined {
    return this.#annonces.get(siege)?.slice();
  }
  enLigne(siege: number): boolean {
    return this.#presence.get(siege) === true;
  }
  get reglages() {
    return this.#reglages;
  }

  // --- WebSocket -------------------------------------------------------------------------------

  #connecter(depuis: bigint): void {
    if (this.#fini) return;
    this.#rattrape = false;
    this.#presence.clear();
    this.#emettre({ k: "connexion", etat: "connexion" });
    const url = this.#deps.net.origin.replace(/^http/, "ws") + "/api/salons/ws";
    let ws: WsLike;
    try {
      ws = this.#deps.ouvrirWS(url);
    } catch {
      this.#planifierReconnexion();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      ws.send(accueil(this.#jeton, depuis));
    };
    ws.onmessage = (ev) => {
      if (this.#ws !== ws || !(ev.data instanceof ArrayBuffer)) return;
      const r = lire(new Uint8Array(ev.data));
      if (r) this.#recevoir(r);
    };
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      this.#ferme(ev.code);
    };
    ws.onerror = () => undefined;
  }

  #envoyerWS(b: Uint8Array<ArrayBuffer>): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(b);
      return true;
    } catch {
      return false;
    }
  }

  #ferme(code: number): void {
    this.#arreterVol();
    this.#orphelin?.();
    this.#orphelin = undefined;
    if (this.#fini) return;
    this.#emettre({ k: "connexion", etat: "coupe" });
    if (code === 4005) return this.#terminer("remplace");
    if (code === 4002) return this.#terminer("exclu");
    if (code === 4004) return void this.#nouvelleEntree();
    if (code === 1000) {
      // Fin annoncée par 0x05 (déjà traitée) ; sinon coupure normale : on revient.
      if (this.#fini) return;
    }
    if (code === 4001 || code === 4003) this.#essais = Math.max(this.#essais, 3);
    this.#planifierReconnexion();
  }

  #planifierReconnexion(): void {
    if (this.#fini || this.#reconnexion) return;
    const ms = Math.min(RECONNEXION_MAX_MS, 1000 * 2 ** this.#essais);
    this.#essais++;
    this.#reconnexion = this.#deps.horloge.plus_tard(ms, () => {
      this.#reconnexion = undefined;
      this.#connecter(this.#salon ? BigInt(this.#dernierSeq) : DEPUIS_REPRISE);
    });
  }

  /** Reconnexion tout de suite (retour de l'onglet au premier plan, réseau revenu). */
  reveiller(): void {
    if (this.#fini || this.#ws) return;
    this.#reconnexion?.();
    this.#reconnexion = undefined;
    this.#essais = 0;
    this.#connecter(this.#salon ? BigInt(this.#dernierSeq) : DEPUIS_REPRISE);
  }

  /** Jeton refusé (4004 : place libérée, redémarrage du serveur) : nouvelle entrée par `rejoindre`. */
  async #nouvelleEntree(): Promise<void> {
    // Après une rotation reçue, l'ancien lien n'ouvre plus le salon : seule la nouvelle invitation.
    if (!this.#lienValide) return this.#terminer("introuvable");
    try {
      const e = await ClientSalon.#rejoindre(this.#deps, this.#kLien, this.#cles, this.#sGestion);
      if (this.#fini) return;
      this.#jeton = e.jeton;
      this.#nonce = e.nonce;
      this.#siege = e.siege;
      this.#salon?.free();
      this.#annonces.clear();
      this.#kps.clear();
      this.#regles.clear();
      this.#dernierSeq = 0;
      this.#depart = 0;
      this.#reprendreLaFile();
      // Après un redémarrage du serveur, plus rien du groupe n'existe : le créateur le refonde.
      this.#salon = this.#deps.eng.Salon.creer(e.siege, e.nonce, this.#cles, false, this.#sGestion);
      this.#emettre({ k: "nouvelleEntree", siege: e.siege });
      this.#emettre({ k: "groupe", dansLeGroupe: false });
      this.#connecter(BigInt(e.seq));
    } catch (x) {
      const code = x instanceof api.SalonError ? x.code : "";
      if (code === "not_found" || code === "bad_password") this.#terminer("introuvable");
      else if (code === "full") this.#terminer("introuvable");
      else this.#planifierReconnexion();
    }
  }

  // --- Réception -------------------------------------------------------------------------------

  #recevoir(r: Enregistrement): void {
    if (PREND_UN_RANG.has(r.type)) {
      if (r.seq <= this.#dernierSeq) return; // rang déjà vu (le moteur l'ignore aussi)
      this.#dernierSeq = r.seq;
    }
    switch (r.type) {
      case 0x0d:
        return this.#liste(r);
      case 0x01:
        return this.#trame(r.seq, r.siege, r.recuMs, r.trame);
      case 0x02:
      case 0x0a:
        this.#annonces.set(r.siege, r.nonce);
        this.#salon?.annoncer(r.siege, r.nonce);
        this.#emettre({ k: r.type === 0x02 ? "arrivee" : "reprise", siege: r.siege, seq: r.seq });
        this.#republierKp();
        return;
      case 0x03:
        this.#annonces.delete(r.siege);
        this.#kps.delete(r.siege);
        this.#salon?.marquerParti(r.siege);
        this.#emettre({ k: "depart", siege: r.siege, seq: r.seq });
        this.#retirerPartis();
        return;
      case 0x09:
        if (r.siege !== undefined) {
          this.#annonces.delete(r.siege);
          this.#kps.delete(r.siege);
        }
        this.#salon?.marquerExclu(r.siege, r.r);
        this.#dernierR = Math.max(this.#dernierR, r.r);
        this.#emettre({ k: "exclusion", siege: r.siege, seq: r.seq, r: r.r });
        this.#retirerPartis();
        this.#essayerRotation();
        return;
      case 0x07:
        this.#presence.set(r.siege, r.enLigne);
        this.#emettre({ k: "presence", siege: r.siege, enLigne: r.enLigne, derniereMin: r.derniereMin });
        if (r.enLigne && r.siege !== this.siege) this.#republierKp();
        this.#ajouterEnAttente();
        return;
      case 0x08:
        if (this.#ping && egal(r.ping, this.#ping)) {
          this.#ping = undefined;
          this.#finRattrapage();
        }
        return;
      case 0x05:
        if (r.raison === RAISONS_FIN.exclu) return this.#terminer("exclu");
        if (r.raison === RAISONS_FIN.remplace) return this.#terminer("remplace");
        if (r.raison === RAISONS_FIN.expire) return this.#terminer("expire");
        if (r.raison === RAISONS_FIN.detruit) return this.#terminer("detruit");
        if (r.raison === RAISONS_FIN.interrompu) return this.#terminer("interrompu");
        return; // RAISONS_FIN.lent : trop lent, la fermeture 4006 suit (reconnexion)
      case 0x0b:
        return this.#limite(r.secondes);
      case 0x0c:
        return this.#reponse(null, "plein");
      case 0x0f:
        return this.#reponse(r.seq, null);
      case 0x0e:
        this.#emettre({ k: "efface", cible: r.cible });
        return;
      case 0x10: {
        this.#reglages = { depart: r.depart, secondes: r.secondes, places: r.places };
        // Renouvellement (spec 2026-11-13, exigence C-3 22) : seulement s'il est postérieur à notre
        // entrée (un 0x10 d'accueil peut redire un renouvellement d'avant notre jeton).
        const nouveau = r.depart > this.#depart && !this.#repriseBase;
        if (this.#repriseBase) this.#depart = Math.max(this.#depart, r.depart);
        if (nouveau) this.#depart = r.depart;
        this.#emettre({ k: "reglages", depart: r.depart, secondes: r.secondes, places: r.places });
        if (nouveau) this.#recreerLeGroupe(r.depart);
        return;
      }
    }
  }

  #liste(r: Extract<Enregistrement, { type: 0x0d }>): void {
    this.#annonces.clear();
    for (const a of r.annonces) this.#annonces.set(a.siege, a.nonce);
    const moi = r.annonces.find((a) => a.siege === this.siege);
    if (!this.#salon) {
      // Reprise : identité neuve au nonce que le serveur vient d'annoncer pour ce siège.
      if (!moi) return;
      this.#nonce = moi.nonce;
      this.#salon = this.#deps.eng.Salon.creer(this.siege, this.#nonce, this.#cles, false, this.#sGestion);
      this.#kpMs = -Infinity;
    }
    this.#salon.remplacerAnnonces(r.createur, r.annonces.map((a): Annonce => ({ siege: a.siege, nonce: a.nonce })));
    this.#essais = 0;
    this.#emettre({ k: "connexion", etat: "ouvert" });
    this.#emettre({ k: "liste", createur: r.createur, annonces: r.annonces, seq: r.seq });
    if (!this.dansLeGroupe()) this.#publierKp(true);
    // Fin du rattrapage : pong de ce ping (exigence 20).
    this.#ping = this.#deps.alea(8);
    this.#envoyerWS(ping(this.#ping));
  }

  #finRattrapage(): void {
    this.#rattrape = true;
    this.#repriseBase = false;
    // Trame en vol perdue avec l'ancien WebSocket : renvoyée telle quelle (un doublon est sans effet).
    this.#pousser();
    this.#ajouterEnAttente();
    this.#retirerPartis();
    this.#vider();
    this.#planifierOrphelin();
  }

  #trame(seq: number, siege: number, recuMs: number, trame: Uint8Array): void {
    if (!this.#salon) return;
    let regle: Regle = 0;
    try {
      regle = this.#deps.eng.lireEnTete(trame).regle;
    } catch {
      regle = 0;
    }
    const avant = this.dansLeGroupe();
    if (!avant) this.#regles.set(seq, { regle, recuMs });
    let ev: Evenement;
    try {
      ev = this.#salon.recevoirTrame(this.#cles, trame, seq, siege);
    } catch (e) {
      this.#erreurTrame(seq, siege, (e as Error).message, regle);
      return;
    }
    if (!avant && ev.type === "ignore") return; // gardée par le moteur, rejouée à l'entrée
    this.#evenement(seq, siege, recuMs, ev, regle);
  }

  #erreurTrame(seq: number, siege: number, code: string, regle: Regle): void {
    if (regle !== 0 && siege !== this.siege) this.#envoyerWS(lu(seq));
    if (code === "salon_casse") return this.#terminer("interrompu");
    if (code === "attente_pleine") return this.#reprendre();
    if ((code === "epoque_perdue" || code === "mls_invalide") && this.dansLeGroupe()) {
      // Retard sur le groupe, ou groupe refondé sans nous (exigence 17) : seulement si cela
      // touche au moins deux expéditeurs (un message très ancien, ou une trame abîmée, d'un seul
      // siège ne prouve rien), ou le seul autre membre.
      this.#perdues.add(siege);
      if (this.#perdues.size >= 2 || this.membres().filter((s) => s !== this.siege).length <= 1) this.#reprendre();
    }
  }

  #evenement(seq: number, siege: number, recuMs: number, ev: Evenement, regle: Regle): void {
    if (ev.type !== "ignore") this.#perdues.clear();
    switch (ev.type) {
      case "message": {
        // Rotation de l'invitation : C-5 (le secret n'est jamais gardé ici).
        if (ev.enveloppe.message.k === "rotation") {
          // Le moteur ne l'a rendue que du créateur, à l'époque courante, pour le `r` du dernier
          // 0x09, sans siège exclu dans l'arbre (exigence 24 (f)) : nouvelles clés, groupe refondé.
          const cle = ev.enveloppe.message.cle;
          try {
            this.#adopter(this.#deps.eng.clesDepuisMaitre(cle), cle, null);
          } finally {
            cle.fill(0);
          }
          return;
        }
        this.#emettre({ k: "message", seq, siege: ev.deSiege, recuMs, epoque: ev.epoque, enveloppe: ev.enveloppe });
        return;
      }
      case "keyPackage":
        this.#kps.set(siege, ev.octets);
        this.#ajouterSiMoi(siege);
        return;
      case "commitAccepte":
        this.#commitMs = this.#deps.horloge.maintenant();
        if (ev.welcome) this.#mettre(ev.welcome, { volatile: false });
        {
          // Notre Commit fusionné : arrivées et départs tirés de la différence des membres.
          const apres = this.membres();
          const avant = this.#membresVus;
          this.#emettre({ k: "membres", ajoutes: apres.filter((s) => !avant.includes(s)), retires: avant.filter((s) => !apres.includes(s)), createurRevenu: ev.createurRevenu, membres: apres });
        }
        this.#ajouterEnAttente();
        this.#retirerPartis();
        this.#vider();
        return;
      case "commitPerdu":
        this.#emettre({ k: "membres", ajoutes: ev.ajoutes, retires: ev.retires, createurRevenu: ev.createurRevenu, membres: this.membres() });
        for (const s of ev.ajoutes) this.#kps.delete(s);
        this.#ajouterEnAttente();
        this.#retirerPartis();
        this.#vider();
        return;
      case "membres":
        for (const s of ev.ajoutes) this.#kps.delete(s);
        this.#emettre({ k: "membres", ajoutes: ev.ajoutes, retires: ev.retires, createurRevenu: ev.createurRevenu, membres: this.membres() });
        this.#ajouterEnAttente();
        this.#vider();
        return;
      case "entree": {
        this.#orphelin?.();
        this.#orphelin = undefined;
        this.#emettre({ k: "groupe", dansLeGroupe: true });
        // Notre entrée : les membres déjà là ne sont pas des « arrivées » (aucune ligne « a rejoint »).
        this.#emettre({ k: "membres", ajoutes: [], retires: [], createurRevenu: false, membres: this.membres() });
        for (const r of ev.rejoues) {
          const rg = this.#regles.get(r.seq) ?? { regle: 0 as Regle, recuMs: 0 };
          if ("erreur" in r) this.#erreurTrame(r.seq, -1, r.erreur, rg.regle);
          else this.#evenement(r.seq, -1, rg.recuMs, r.evenement, rg.regle);
        }
        this.#regles.clear();
        this.#ajouterEnAttente();
        this.#vider();
        return;
      }
      case "rotationAcceptee": {
        // Créateur : les membres ont accepté sa rotation ; il refonde à son tour (exigence 24 (f)).
        const rot = this.#rotation;
        if (!rot || rot.r !== ev.n) return;
        this.#rotation = undefined;
        this.#adopter(rot.cles, rot.cle, rot.kLien);
        rot.cle.fill(0);
        return;
      }
      case "rotationARenvoyer":
        // Un Commit, un départ ou une reprise est passé entre l'envoi et l'écho : la même clé,
        // le même numéro, une fois les sièges à retirer retirés (exigence 24 (e)).
        if (this.#rotation?.r === ev.n) {
          this.#rotation.envoyee = false;
          this.#retirerPartis();
          this.#essayerRotation();
        }
        return;
      case "ignore":
        // Trame des règles 1 à 3 sans message lisible pour nous (Commit, écho, rejeu) : lue.
        if (regle !== 0 && siege !== this.siege) this.#envoyerWS(lu(seq));
        return;
    }
  }

  // --- Groupe ---------------------------------------------------------------------------------

  #publierKp(forcer = false): void {
    const s = this.#salon;
    if (!s || this.dansLeGroupe()) return;
    const t = this.#deps.horloge.maintenant();
    if (!forcer && t - this.#kpMs < ATTENTE_KP_MS) return;
    this.#kpMs = t;
    try {
      this.#mettre(s.keyPackage(this.#cles), { volatile: false });
    } catch {
      // Identité de l'arrivant refusée (moteur) : rien à republier.
    }
  }

  #republierKp(): void {
    if (this.#rattrape && !this.dansLeGroupe()) this.#publierKp();
  }

  /** Plus petit siège en ligne du groupe, hors de `sauf`. */
  #premierEnLigne(sauf: number[] = []): number | undefined {
    const m = this.membres().filter((s) => !sauf.includes(s) && this.#presence.get(s) === true);
    return m.length ? Math.min(...m) : undefined;
  }

  #ajouterSiMoi(arrivant: number): void {
    const s = this.#salon;
    const kp = this.#kps.get(arrivant);
    if (!s || !kp || !this.#rattrape || !this.membres().includes(this.siege)) return;
    if (this.#premierEnLigne([arrivant]) !== this.siege) return;
    let commit: Uint8Array;
    try {
      commit = s.ajouter(this.#cles, kp);
    } catch (e) {
      const m = (e as Error).message;
      if (m === "deja_membre" || m === "commit_refuse") this.#kps.delete(arrivant);
      return;
    }
    this.#mettre(commit, { volatile: false });
  }

  #ajouterEnAttente(): void {
    // Reprise : la nouvelle feuille d'un siège déjà membre est à ajouter aussi ; le moteur tranche.
    for (const a of [...this.#kps.keys()]) this.#ajouterSiMoi(a);
  }

  #retirerPartis(): void {
    const s = this.#salon;
    if (!s || !this.#rattrape || !this.dansLeGroupe()) return;
    const partis = s.aRetirer();
    if (partis.length === 0 || this.#premierEnLigne(partis) !== this.siege) return;
    let commit: Uint8Array;
    try {
      commit = s.retirer(this.#cles, partis[0]!);
    } catch {
      return; // commit_en_cours : rejoué à son écho
    }
    this.#mettre(commit, { volatile: false });
  }

  #planifierOrphelin(): void {
    this.#orphelin?.();
    this.#orphelin = undefined;
    if (!this.createur || this.dansLeGroupe()) return;
    const autres = [...this.#presence].some(([s, en]) => en && s !== this.siege);
    if (!autres) return this.#refonder();
    this.#orphelin = this.#deps.horloge.plus_tard(ORPHELIN_MS, () => {
      this.#orphelin = undefined;
      if (!this.dansLeGroupe() && this.#ws) this.#refonder();
    });
  }

  /** Groupe orphelin (exigence 17) : le créateur fonde un groupe neuf sous sa clé de rôle. */
  #refonder(): void {
    if (!this.#sGestion || this.dansLeGroupe()) return;
    this.#salon?.free();
    this.#salon = this.#deps.eng.Salon.creer(this.siege, this.#nonce, this.#cles, true, this.#sGestion);
    this.#salon.remplacerAnnonces(
      0,
      [...this.#annonces].map(([siege, nonce]) => ({ siege, nonce })),
    );
    this.#emettre({ k: "groupe", dansLeGroupe: true });
    this.#emettre({ k: "membres", ajoutes: [this.siege], retires: [], createurRevenu: false, membres: this.membres() });
    this.#ajouterEnAttente();
  }

  /**
   * Renouvellement du salon (exigence C-3 22, v3 §14.7) : le serveur a effacé Commits, Welcomes et
   * KeyPackages ; l'état MLS est jeté et un `Salon` neuf repart (même siège, même nonce, liste des
   * membres gardée). Le créateur fonde le nouveau groupe (sa clé de rôle, donc son code, ne change
   * pas) ; les autres publient un KeyPackage (nouvelle identité : nouveau code). Nos messages pas
   * encore acceptés repartent sous le nouveau groupe.
   */
  #recreerLeGroupe(depart: number): void {
    this.#salon?.free();
    this.#kps.clear();
    this.#regles.clear();
    this.#perdues.clear();
    this.#arreterVol();
    this.#reprendreLaFile();
    this.#emettre({ k: "renouvellement", depart });
    const fonder = this.createur && this.#sGestion !== undefined;
    this.#salon = this.#deps.eng.Salon.creer(this.siege, this.#nonce, this.#cles, fonder, this.#sGestion);
    this.#salon.remplacerAnnonces(
      0,
      [...this.#annonces].map(([siege, nonce]) => ({ siege, nonce })),
    );
    this.#emettre({ k: "groupe", dansLeGroupe: this.dansLeGroupe() });
    this.#emettre({ k: "membres", ajoutes: [], retires: [], createurRevenu: false, membres: this.membres() });
    if (!this.dansLeGroupe()) this.#publierKp(true);
    else this.#ajouterEnAttente();
    this.#vider();
  }

  // --- Exclusion et rotation de l'invitation (exigences 24, 25 ; spec §39.13) ---------------------

  /** Plus grand `r` vu : le prochain `POST exclure` prend un numéro plus grand. */
  get dernierR(): number {
    return this.#dernierR;
  }

  /**
   * Créateur, juste AVANT `POST exclure` : la nouvelle invitation (clés tirées de K_lien' et
   * K_mdp', K_maître_s' = `cle`, K_lien'). La clé part dans un message `rotation` seulement après
   * le 0x09 de ce numéro et le retrait de l'exclu (moteur : époque courante, aucun siège à
   * retirer), jamais le lien ni le mot de passe (exigence 25). `annuler` si la requête échoue.
   */
  preparerRotation(r: number, cles: ClesSalon, cle: Uint8Array, kLien: Uint8Array): void {
    this.annulerRotation();
    this.#rotation = { r, cles, cle: cle.slice(), kLien: kLien.slice(), envoyee: false };
  }
  annulerRotation(): void {
    const rot = this.#rotation;
    if (!rot) return;
    this.#rotation = undefined;
    rot.cle.fill(0);
    rot.kLien.fill(0);
    rot.cles.free();
  }

  #essayerRotation(): void {
    const rot = this.#rotation;
    const s = this.#salon;
    if (!rot || rot.envoyee || !s || !this.dansLeGroupe() || !this.#rattrape || this.#dernierR < rot.r) return;
    if (s.aRetirer().length > 0) return this.#retirerPartis();
    let t: Uint8Array;
    try {
      t = s.envoyer(this.#cles, { heureMs: this.#deps.horloge.maintenant(), regle: 0, message: { k: "rotation", n: rot.r, cle: rot.cle } }).trame;
    } catch {
      return; // commit_en_cours, retrait_en_attente, rotation_refusee : à l'événement suivant
    }
    rot.envoyee = true;
    this.#mettre(t, { volatile: false });
  }

  /**
   * Nouvelles clés du salon (rotation reçue, ou écho accepté chez le créateur) : groupe refondé
   * sous elles (même identité, mêmes codes), trames suivantes sous la nouvelle K_trame. Nos
   * messages pas encore acceptés repartent sous le nouveau groupe. `kLien` : celui de la
   * nouvelle invitation (créateur) ; null chez un membre, qui ne la connaît pas.
   */
  #adopter(cles: ClesSalon, kMaitre: Uint8Array, kLien: Uint8Array | null): void {
    const s = this.#salon;
    if (!s) return cles.free();
    this.#arreterVol();
    this.#reprendreLaFile();
    this.#kps.clear();
    this.#regles.clear();
    this.#salon = s.refonder(cles);
    this.#cles.free();
    this.#cles = cles;
    if (kLien) {
      this.#kLien.fill(0);
      this.#kLien = kLien.slice();
      this.#lienValide = true;
    } else this.#lienValide = false;
    this.#emettre({ k: "rotation", kMaitre: kMaitre.slice() });
    this.#emettre({ k: "groupe", dansLeGroupe: this.dansLeGroupe() });
    this.#emettre({ k: "membres", ajoutes: [], retires: [], createurRevenu: false, membres: this.membres() });
    if (!this.dansLeGroupe()) this.#publierKp(true);
    else this.#ajouterEnAttente();
    this.#pousser();
  }

  /** Reprise (nouvelle identité au même siège, aucun rattrapage) : retard, attente pleine. */
  #reprendre(): void {
    if (this.#fini) return;
    this.#perdues.clear();
    this.#salon?.free();
    this.#salon = undefined;
    this.#kps.clear();
    this.#regles.clear();
    const ws = this.#ws;
    this.#ws = undefined;
    this.#arreterVol();
    this.#reprendreLaFile();
    this.#emettre({ k: "groupe", dansLeGroupe: false });
    try {
      ws?.close(1000);
    } catch {
      // déjà fermé
    }
    this.#connecter(DEPUIS_REPRISE);
  }

  /**
   * Nouvelle identité (reprise, nouvelle entrée) : les trames de l'ancienne ne servent plus
   * (Commits, KeyPackages, volatils jetés) ; nos messages pas encore acceptés repartent dans la
   * boîte, en tête, pour être chiffrés de nouveau (même identifiant : un doublon est ignoré).
   */
  #reprendreLaFile(): void {
    const remis = this.#file.filter((f) => f.att !== undefined).map((f) => ({ ...f.att!, e: { ...f.att!.e, id: f.id } }));
    this.#file = [];
    this.#boite.unshift(...remis);
  }

  // --- Envoi ----------------------------------------------------------------------------------

  /**
   * Message à envoyer : rendu dans la boîte, chiffré dès que le moteur le permet (exigence 23).
   * Rend son numéro local ; la suite arrive en événements `chiffre`, `accepte`, `echec`.
   */
  envoyer(message: Message, regle: Regle, piece?: Uint8Array, avant?: (local: number) => void): number {
    const local = ++this.#local;
    this.#boite.push({ local, e: { heureMs: this.#deps.horloge.maintenant(), regle, message }, piece, depuis: this.#deps.horloge.maintenant() });
    // L'appelant affiche le message (numéro local) avant les événements `chiffre` et `accepte`.
    avant?.(local);
    this.#vider();
    return local;
  }

  /** « En train d'écrire » : volatile, abandonné si le moteur refuse pour l'instant. */
  ecrit(): void {
    if (!this.dansLeGroupe() || !this.#rattrape) return;
    this.#volatil({ k: "ecrit" });
  }

  /** Message d'un appel (présence, fin, signalisation) : volatile ; faux si le moteur refuse pour l'instant. */
  appel(m: Extract<Message, { k: "appel_present" | "appel_fin" | "appel_signal" }>): boolean {
    if (!this.dansLeGroupe() || !this.#rattrape) return false;
    return this.#volatil(m);
  }

  /** Accusés `recu`/`vu`/`piece_ouverte`/`piece_telechargee` (identifiants de 16 octets), groupés par périodes de 2,5 s. */
  accuser(sorte: "recu" | "vu" | "piece_ouverte" | "piece_telechargee", ids: Uint8Array[]): void {
    const s = sorte === "recu" ? this.#recus : sorte === "vu" ? this.#vus : sorte === "piece_ouverte" ? this.#ouverts : this.#telecharges;
    for (const id of ids) s.add(hex(id));
    if (sorte === "vu") for (const id of ids) this.#recus.delete(hex(id));
    if (!this.#accusesTimer) this.#accusesTimer = this.#deps.horloge.plus_tard(ACCUSES_MS, () => this.#accuserMaintenant());
  }

  #accuserMaintenant(): void {
    this.#accusesTimer = undefined;
    if (!this.dansLeGroupe() || !this.#rattrape) {
      if (this.#accusesEnAttente() > 0) this.#accusesTimer = this.#deps.horloge.plus_tard(ACCUSES_MS, () => this.#accuserMaintenant());
      return;
    }
    for (const [sorte, set] of [
      ["vu", this.#vus],
      ["recu", this.#recus],
      ["piece_ouverte", this.#ouverts],
      ["piece_telechargee", this.#telecharges],
    ] as const) {
      if (set.size === 0) continue;
      // 3 900 octets de JSON au plus (JSON_MAX) : 100 identifiants par trame tiennent largement.
      const ids = [...set].slice(0, 100);
      if (this.#volatil({ k: sorte, ids: ids.map(deHex) })) for (const i of ids) set.delete(i);
    }
    if (this.#accusesEnAttente() > 0) this.#accusesTimer = this.#deps.horloge.plus_tard(ACCUSES_MS, () => this.#accuserMaintenant());
  }
  #accusesEnAttente(): number {
    return this.#recus.size + this.#vus.size + this.#ouverts.size + this.#telecharges.size;
  }

  /** Volatile chiffré maintenant ou abandonné : rend vrai s'il part. */
  #volatil(m: Message): boolean {
    const s = this.#salon;
    if (!s) return false;
    try {
      const { trame } = s.envoyer(this.#cles, { heureMs: this.#deps.horloge.maintenant(), regle: 0, message: m });
      this.#mettre(trame, { volatile: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Lecture d'une trame des règles 1 à 3 (message affiché, page visible, 1 s). */
  lu(seq: number): void {
    this.#envoyerWS(lu(seq));
  }

  /** Retire pour tous un de nos messages : message chiffré `retrait`, puis `0x02` de sa trame. */
  retirerPourTous(seq: number, id: Uint8Array, regle: Regle): void {
    this.envoyer({ k: "retrait", cible: id }, regle);
    this.#envoyerWS(retirerTrame(seq));
  }

  /** Chiffre ce que la boîte peut : dans l'ordre, et s'arrête au premier refus du moteur. */
  #vider(): void {
    this.#essayerRotation();
    const s = this.#salon;
    while (s && this.#boite.length > 0 && this.dansLeGroupe() && this.#rattrape) {
      const m = this.#boite[0]!;
      let r: { trame: Uint8Array; id: Uint8Array };
      try {
        r = s.envoyer(this.#cles, m.e);
      } catch (e) {
        const code = (e as Error).message;
        if (code === "commit_en_cours" || code === "retrait_en_attente") {
          if (code === "retrait_en_attente") this.#retirerPartis();
          this.#noterAttente(m.depuis);
          return;
        }
        this.#boite.shift();
        this.#emettre({ k: "echec", local: m.local, code });
        continue;
      }
      this.#boite.shift();
      this.#emettre({ k: "chiffre", local: m.local, id: r.id });
      this.#mettre(r.trame, { volatile: false, local: m.local, id: r.id, piece: m.piece, att: m });
    }
    if (this.#boite.length === 0 && this.#attenteNotee) {
      this.#attenteNotee = false;
      this.#emettre({ k: "attente", depuisMs: null });
    }
    if (this.#boite.length > 0 && !this.dansLeGroupe()) this.#noterAttente(this.#boite[0]!.depuis);
  }

  #noterAttente(depuis: number): void {
    if (this.#attenteNotee) return;
    this.#attenteNotee = true;
    this.#emettre({ k: "attente", depuisMs: depuis });
  }

  #mettre(t: Uint8Array, o: { volatile: boolean; local?: number; id?: Uint8Array; piece?: Uint8Array; att?: EnAttente }): void {
    this.#file.push({ octets: trameClient(t, o.piece), local: o.local, id: o.id, att: o.att, volatile: o.volatile, envoye: false });
    // Volatiles compris : ils avancent le même compteur MLS (spec v3 §3.6.1, renouvellement).
    this.#envoyees++;
    this.#pousser();
    this.#renouvelerSiBesoin();
  }

  #renouvelerSiBesoin(): void {
    const s = this.#salon;
    if (!s || !this.dansLeGroupe() || !this.#rattrape) return;
    const t = this.#deps.horloge.maintenant();
    if (this.#envoyees < RENOUVELER_TRAMES && t - this.#commitMs < RENOUVELER_MS) return;
    let c: Uint8Array;
    try {
      c = s.renouveler(this.#cles);
    } catch {
      return;
    }
    this.#envoyees = 0;
    this.#commitMs = t;
    this.#file.push({ octets: trameClient(c), volatile: false, envoye: false });
    this.#pousser();
  }

  /** Envoie la trame suivante si aucune n'est en vol (exigence 20). */
  #pousser(): void {
    if (this.#enVol || !this.#rattrape || !this.#ws) return;
    const f = this.#file.shift();
    if (!f) return;
    this.#enVol = f;
    f.envoye = true;
    if (!this.#envoyerWS(f.octets)) {
      this.#file.unshift(f);
      this.#enVol = undefined;
      return;
    }
    // Sans réponse en 30 s : la connexion est jugée morte, rouverte (la trame repart après).
    f.garde = this.#deps.horloge.plus_tard(ENVOI_MS, () => {
      if (this.#enVol !== f) return;
      const ws = this.#ws;
      this.#ws = undefined;
      try {
        ws?.close(1000);
      } catch {
        // déjà fermé
      }
      this.#ferme(1001);
    });
  }

  #arreterVol(): void {
    const f = this.#enVol;
    if (!f) return;
    f.relance?.();
    f.garde?.();
    this.#enVol = undefined;
    // Non volatile : renvoyée après la reconnexion (mêmes octets) ; volatile : abandonnée.
    if (!f.volatile) this.#file.unshift(f);
  }

  #reponse(seq: number | null, erreur: string | null): void {
    const f = this.#enVol;
    if (!f) return;
    f.garde?.();
    f.relance?.();
    this.#enVol = undefined;
    if (f.local !== undefined) {
      if (seq !== null) this.#emettre({ k: "accepte", local: f.local, id: f.id!, seq });
      else this.#emettre({ k: "echec", local: f.local, code: erreur ?? "plein" });
    }
    this.#pousser();
  }

  #limite(secondes: number): void {
    const f = this.#enVol;
    if (!f) return;
    f.garde?.();
    f.relance?.();
    // Mêmes octets après le délai (relecture Task 16 du plan C-2) ; le 0x0B ne désigne pas la
    // trame refusée : c'est la seule en vol.
    f.relance = this.#deps.horloge.plus_tard((secondes + 1) * 1000, () => {
      f.relance = undefined;
      if (this.#enVol !== f) return;
      this.#envoyerWS(f.octets);
    });
  }

  /**
   * Exigence C-3 32 : créateur revenu sans `S_gestion`, qui colle son lien de gestion dans la
   * conversation. `rejoindre` avec J_gestion (siège 0, sans compter dans les arrivées ; un
   * S_gestion d'un autre salon : 400, rien ne change ici) ; puis l'ancienne place est rendue
   * (`0x03` sur l'ancienne connexion) et le client repart au siège 0, état MLS neuf sous la clé de
   * rôle : le rôle est rendu dès le Commit qui l'ajoute (ou il refonde un groupe orphelin). Seul
   * J_gestion part au serveur ; S_gestion reste en mémoire du client comme à l'entrée.
   * Exige une connexion ouverte (sinon l'ancienne place ne pourrait pas être rendue).
   */
  async reprendreLeRole(sGestion: Uint8Array): Promise<void> {
    if (this.#fini || this.#sGestion !== undefined || !this.#lienValide) throw new Error("etat_invalide");
    if (sGestion.length !== 32) throw new Error("argument_invalide");
    if (this.#ws?.readyState !== 1) throw new Error("hors_ligne");
    const e = await ClientSalon.#rejoindre(this.#deps, this.#kLien, this.#cles, sGestion);
    if (this.#fini) return;
    if (e.siege !== 0) throw new Error("reponse_invalide");
    // Ancienne place rendue : départ annoncé, ancienne connexion fermée (son onclose est ignoré).
    this.#envoyerWS(quitter());
    const ws = this.#ws;
    this.#ws = undefined;
    try {
      ws?.close(1000);
    } catch {
      // déjà fermé
    }
    this.#reconnexion?.();
    this.#reconnexion = undefined;
    this.#orphelin?.();
    this.#orphelin = undefined;
    this.#arreterVol();
    this.#sGestion = sGestion.slice() as Uint8Array<ArrayBuffer>;
    this.#jeton = e.jeton;
    this.#nonce = e.nonce;
    this.#siege = e.siege;
    this.#salon?.free();
    this.#annonces.clear();
    this.#kps.clear();
    this.#regles.clear();
    this.#dernierSeq = 0;
    this.#depart = e.seq;
    this.#reprendreLaFile();
    this.#salon = this.#deps.eng.Salon.creer(e.siege, e.nonce, this.#cles, false, this.#sGestion);
    this.#emettre({ k: "nouvelleEntree", siege: e.siege });
    this.#emettre({ k: "groupe", dansLeGroupe: false });
    this.#connecter(BigInt(e.seq));
  }

  // --- Départ, fin ----------------------------------------------------------------------------

  /** « Quitter » : `0x03`, puis fermeture locale (le serveur ferme en 1000). */
  quitter(): void {
    this.#envoyerWS(quitter());
    this.#terminer("quitte");
  }

  /** Arrêt demandé par l'écran (« Quitter et signaler » fait par la route HTTP) : secrets effacés. */
  arreter(raison: Fin): void {
    this.#terminer(raison);
  }

  #terminer(raison: Fin): void {
    if (this.#fini) return;
    this.#fini = true;
    this.#emettre({ k: "fin", raison });
    this.fermer();
  }

  get fini(): boolean {
    return this.#fini;
  }

  /** Jeton de membre (signalement, destruction par un membre) : en mémoire seulement. */
  get jeton(): string {
    return this.#jeton;
  }

  /** J_gestion (créateur) pour une route de gestion ; à mettre à zéro après usage. */
  jetonGestion(): Uint8Array | null {
    return this.#sGestion ? this.#deps.eng.jetonGestion(this.#sGestion) : null;
  }

  /** Ferme tout et efface les secrets gardés (K_lien, S_gestion, clés, état MLS). */
  fermer(): void {
    this.#fini = true;
    this.#reconnexion?.();
    this.#orphelin?.();
    this.#accusesTimer?.();
    this.annulerRotation();
    this.#arreterVol();
    const ws = this.#ws;
    this.#ws = undefined;
    try {
      ws?.close(1000);
    } catch {
      // déjà fermé
    }
    this.#salon?.free();
    this.#salon = undefined;
    this.#cles.free();
    this.#kLien.fill(0);
    this.#sGestion?.fill(0);
    this.#file = [];
    this.#boite = [];
    this.#kps.clear();
  }
}

// Fil de la conversation, calculé sur l'appareil à partir des événements du
// client (client.ts) : rien n'est demandé au serveur. Pur : aucun réseau, aucun moteur (la clé
// d'unicité des pseudonymes est donnée par l'appelant : `cleUnicite` du moteur). Règles (spec
// salon v3 §3.6.1, 9, 10, 11, 34 ; §4, §6, §7.1, §14.1, §14.2) :
// - un identifiant de message déjà vu : le premier en ordre `seq` gagne, les doublons sont
//   ignorés ; `modif` et `retrait` ne valent que de l'auteur du message visé ;
// - accusés `recu`/`vu` comptés une fois par siège, parmi les lecteurs attendus (membres du
//   groupe à la réception, expéditeur exclu) ;
// - pseudonymes : unicité par `cleUnicite` ; en double, le premier en ordre `seq` le garde,
//   l'autre siège est affiché « Participant N » ; si c'est soi, `pseudoRefuse` le dit à l'écran ;
//   sauf entre deux membres déjà là à notre arrivée : leurs profils
//   nous sont redits dans un ordre que nous n'avons pas vu naître, un tricheur pourrait parler
//   avant le vrai titulaire ; aucun des deux ne garde alors le pseudonyme (ligne « en double ») ;
// - un siège à la fois ajouté et retiré par le même Commit (reprise, ou clé substituée) : « le
//   code de vérification de X a changé », sauf pour le créateur revenu (même clé de rôle) ;
// - réponse : la citation est lue du message local, sinon « indisponible ».
import type { Regle } from "./engine";
import type { EnveloppeRecue } from "./client";

export type Sorte = "texte" | "reponse";
/** État d'un de nos messages : en attente du moteur ou du serveur, accepté, refusé. */
export type EtatEnvoi = "envoi" | "envoye" | "echec";

/** Nom et couleur de l'ancien occupant d'un siège libéré, figés à son départ. */
export type Fige = { pseudo: string | null; couleur: number };

export type Bulle = {
  fige?: Fige;
  k: "bulle";
  /** Clé stable (identifiant en hexadécimal, ou « l<n> » avant le chiffrement). */
  cle: string;
  id: string | null;
  seq: number | null;
  local: number | null;
  siege: number;
  moi: boolean;
  texte: string;
  /** Réponse : identifiant (hexadécimal) du message cité. */
  cite: string | null;
  modifie: boolean;
  retire: boolean;
  heureMs: number;
  regle: Regle;
  epoque: number | null;
  etat: EtatEnvoi;
  echec: string | null;
  /** Lecteurs attendus (sièges), accusés reçus et vus. */
  attendus: number[];
  recus: number[];
  vus: number[];
  /** Pièces (v3 §14.2) : sièges qui l'ont ouverte (affichée ou lue) et téléchargée. */
  ouverts: number[];
  telecharges: number[];
  /**
   * Fiche « Infos » (v3 §14.2), nos messages seulement : heure de chaque accusé par siège (heure
   * d'envoi de l'accusé, donnée par l'appareil du lecteur ; la première reçue compte).
   */
  heures: Heures;
  /** Nos messages : heure où le serveur a accepté l'envoi (cet appareil), ou null. */
  envoyeMs: number | null;
  /** Réactions : émoji → sièges, dans l'ordre d'arrivée. */
  reactions: { emoji: string; sieges: number[] }[];
  /** Pièce : fichier, image, vidéo ou vocal ; null pour un texte. */
  piece: PieceInfo | null;
};

export type Heures = { recu: Map<number, number>; vu: Map<number, number>; ouvert: Map<number, number>; telecharge: Map<number, number> };
const heuresVides = (): Heures => ({ recu: new Map(), vu: new Map(), ouvert: new Map(), telecharge: new Map() });
/** Une ligne de la fiche « Infos » : un lecteur attendu et l'heure (ms) de chaque accusé, ou null. */
export type LigneInfos = { siege: number; recu: number | null; vu: number | null; ouvert: number | null; telecharge: number | null };

/** Pièce d'un message : ce que dit le message chiffré (nom nettoyé par le moteur à l'affichage). */
export type PieceInfo = {
  nom: string;
  mime: string;
  taille: number;
  sorte: "fichier" | "image" | "video" | "vocal";
  dureeMs: number | null;
  /** Référence chiffrée (graine, identifiant, palier) ; null tant que notre envoi n'est pas fini. */
  ref: { r: Uint8Array; piece: Uint8Array; palier: number } | null;
  /** Envoi en cours (0 à 1), chez l'expéditeur seulement. */
  progres: number | null;
};

export type Systeme = { fige?: Fige } & (
  | { k: "sys"; cle: string; quoi: "arrivee" | "depart" | "retour" | "exclusion" | "code" | "createur" | "double"; siege: number }
  | { k: "sys"; cle: string; quoi: "pseudo"; siege: number; avant: string; apres: string }
  | { k: "sys"; cle: string; quoi: "regle"; siege: number; regle: Regle }
  | { k: "sys"; cle: string; quoi: "renouvellement" | "invitation"; siege: number }
  | { k: "sys"; cle: string; quoi: "fermeture"; siege: number; minutes: number }
);

export type Element = Bulle | Systeme;
type SansCle<T> = T extends unknown ? Omit<T, "cle"> : never;

export type Profil = { pseudo: string | null; couleur: number; seq: number };
export type Presence = { enLigne: boolean; derniereMin: number };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const COULEURS = 10;
/** Exigence 27 : « quelques secondes » d'écart toléré (un Commit de retrait est en route). */
export const ECART_MS = 8000;

export class Conversation {
  readonly elements: Element[] = [];
  readonly profils = new Map<number, Profil>();
  readonly presence = new Map<number, Presence>();
  /** Sièges présents (annonces du serveur) et membres du groupe chiffré. */
  presents = new Set<number>();
  membres: number[] = [];
  /** « Écrit » : siège → fin de l'indication (ms, horloge de l'appareil). */
  readonly ecrit = new Map<number, number>();
  /** Notre pseudonyme refusé (déjà pris par un siège antérieur) : l'écran renvoie au champ. */
  pseudoRefuse = false;
  createurSiege = 0;
  #parId = new Map<string, Bulle>();
  #parLocal = new Map<number, Bulle>();
  #n = 0;
  #changement: () => void = () => undefined;

  constructor(
    public moi: number,
    private readonly cleUnicite: (p: string) => string,
    private readonly maintenant: () => number = () => Date.now(),
  ) {}

  /** Appelé après chaque changement (l'état des écrans s'y abonne). */
  surChangement(f: () => void): void {
    this.#changement = f;
  }
  #change(): void {
    this.#changement();
  }

  bulle(id: string): Bulle | undefined {
    return this.#parId.get(id);
  }

  /** Nom affiché d'un siège : son pseudonyme accepté, sinon « Participant N » (N = siège + 1). */
  nom(siege: number): { pseudo: string | null; numero: number } {
    return { pseudo: this.profils.get(siege)?.pseudo ?? null, numero: siege + 1 };
  }

  // Le serveur redonne un siège libéré (départ, exclusion) au prochain arrivant : les messages et
  // lignes de l'ancien occupant gardent SON nom et SA couleur, figés à son départ, jamais ceux du
  // suivant (sinon un message serait attribué à quelqu'un d'autre). Gardé sur l'élément lui-même :
  // l'écran en fait des copies.
  /** Nom de l'auteur d'un élément du fil (figé si son siège a été libéré depuis). */
  nomDe(e: Element): { pseudo: string | null; numero: number } {
    return e.fige ? { pseudo: e.fige.pseudo, numero: e.siege + 1 } : this.nom(e.siege);
  }
  couleurDe(e: Element): number {
    return e.fige?.couleur ?? this.couleur(e.siege);
  }
  // Écart entre le groupe et le serveur (v3) : un siège encore dans le groupe chiffré
  // (`membres`) mais absent de la liste du serveur depuis plus de ECART_MS. Le nom gardé est celui
  // de l'ancien occupant (son profil est oublié à son départ).
  readonly #ecart = new Map<number, { depuis: number; pseudo: string | null }>();
  #suivreEcart(): void {
    for (const s of [...this.#ecart.keys()]) if (!this.membres.includes(s) || this.presents.has(s)) this.#ecart.delete(s);
    for (const s of this.membres) if (s !== this.moi && !this.presents.has(s) && !this.#ecart.has(s)) this.#ecart.set(s, { depuis: this.maintenant(), pseudo: this.profils.get(s)?.pseudo ?? null });
  }
  /** Sièges à signaler « encore dans le groupe chiffré » (plus de ECART_MS d'écart). */
  encoreDansLeGroupe(): { siege: number; pseudo: string | null; numero: number }[] {
    const t = this.maintenant();
    return [...this.#ecart].filter(([, e]) => t - e.depuis > ECART_MS).map(([siege, e]) => ({ siege, pseudo: e.pseudo, numero: siege + 1 }));
  }
  #liberer(siege: number): void {
    // Écart noté AVANT d'oublier le profil : l'alerte garde le nom de l'ancien occupant.
    this.#suivreEcart();
    const f: Fige = { pseudo: this.profils.get(siege)?.pseudo ?? null, couleur: this.couleur(siege) };
    for (const e of this.elements) if (e.siege === siege && !e.fige) e.fige = f;
    this.profils.delete(siege);
    this.avatars.delete(siege);
    this.presence.delete(siege);
    this.verifies.delete(siege);
  }
  couleur(siege: number): number {
    return this.profils.get(siege)?.couleur ?? siege % COULEURS;
  }

  /** Plus petit indice de couleur libre parmi les présents (§39.4 point 5). */
  couleurLibre(): number {
    const prises = new Set([...this.profils].filter(([s]) => s !== this.moi && this.presents.has(s)).map(([, p]) => p.couleur));
    for (let i = 0; i < COULEURS; i++) if (!prises.has(i)) return i;
    return this.moi % COULEURS;
  }

  /** Clés d'unicité déjà prises par les autres présents (contrôle pendant la saisie du pseudonyme). */
  pseudoPris(p: string): boolean {
    let k: string;
    try {
      k = this.cleUnicite(p);
    } catch {
      return false;
    }
    if (this.#contestes.has(k)) return true; // disputé entre deux anciens (P1) : personne ne le prend
    for (const [s, pr] of this.profils) if (s !== this.moi && this.presents.has(s) && pr.pseudo !== null && this.cleUnicite(pr.pseudo) === k) return true;
    return false;
  }

  #sys(e: SansCle<Systeme>): void {
    this.elements.push({ ...e, cle: `s${++this.#n}` } as Systeme);
  }

  // --- Annonces du serveur, groupe ---------------------------------------------------------------

  liste(sieges: number[], createur: number): void {
    // Membres déjà là à notre arrivée (première liste seulement ; une reprise n'y touche pas).
    this.#anciens ??= new Set(sieges.filter((s) => s !== this.moi));
    this.presents = new Set(sieges);
    this.createurSiege = createur;
    this.#suivreEcart();
    this.#change();
  }
  arrivee(siege: number): void {
    this.presents.add(siege);
    this.#suivreEcart();
    this.#change();
  }
  depart(siege: number, exclusion = false): void {
    if (this.presents.delete(siege) || exclusion) this.#sys({ k: "sys", quoi: exclusion ? "exclusion" : "depart", siege });
    this.#liberer(siege);
    this.ecrit.delete(siege);
    this.#change();
  }
  /**
   * Notre siège change (nouvelle entrée ; créateur qui retrouve ses droits, 32) :
   * l'ancien est rendu sans ligne (le départ annoncé ensuite n'en ajoute pas), son profil oublié
   * (notre pseudonyme n'y est plus « pris ») ; les messages de l'ancien occupant du nouveau siège
   * gardent son nom et sa couleur (figés). Notre profil est renvoyé par l'appelant.
   */
  changerDeSiege(siege: number): void {
    if (siege === this.moi) return;
    const ancien = this.moi;
    this.presents.delete(ancien);
    this.#liberer(ancien);
    this.#liberer(siege);
    this.moi = siege;
    this.presents.add(siege);
    this.#change();
  }
  presenceDe(siege: number, p: Presence): void {
    this.presence.set(siege, p);
    this.#change();
  }

  /** Commit fusionné : arrivées, départs, reprises, créateur revenu (34). */
  groupe(e: { ajoutes: number[]; retires: number[]; createurRevenu: boolean; membres: number[] }): void {
    this.membres = e.membres;
    this.#suivreEcart();
    if (e.createurRevenu) this.#sys({ k: "sys", quoi: "createur", siege: this.createurSiege });
    for (const s of e.ajoutes) {
      if (s === this.moi) continue;
      if (e.retires.includes(s)) {
        this.#sys({ k: "sys", quoi: "retour", siege: s });
        if (!(e.createurRevenu && s === this.createurSiege)) {
          this.#sys({ k: "sys", quoi: "code", siege: s });
          this.verifies.delete(s);
        }
      } else this.#sys({ k: "sys", quoi: "arrivee", siege: s });
    }
    this.#change();
  }

  /** Le serveur a effacé la trame de rang `cible` (règles 1 à 3) : le message quitte l'écran. */
  efface(cible: number): void {
    const i = this.elements.findIndex((x) => x.k === "bulle" && x.seq === cible);
    if (i < 0) return;
    const b = this.elements[i] as Bulle;
    this.elements.splice(i, 1);
    if (b.id) this.#parId.delete(b.id);
    this.#change();
  }

  // --- Nos messages ------------------------------------------------------------------------------

  /** Message envoyé par nous : affiché tout de suite, en attente. */
  envoye(local: number, m: { sorte: Sorte; texte: string; cite?: string | null }, regle: Regle): void {
    const b: Bulle = {
      k: "bulle",
      cle: `l${local}`,
      id: null,
      seq: null,
      local,
      siege: this.moi,
      moi: true,
      texte: m.texte,
      cite: m.cite ?? null,
      modifie: false,
      retire: false,
      heureMs: this.maintenant(),
      regle,
      epoque: null,
      etat: "envoi",
      echec: null,
      attendus: this.membres.filter((s) => s !== this.moi),
      recus: [],
      vus: [],
      ouverts: [],
      telecharges: [],
      heures: heuresVides(),
      envoyeMs: null,
      reactions: [],
      piece: null,
    };
    this.elements.push(b);
    this.#parLocal.set(local, b);
    this.#change();
  }
  chiffre(local: number, id: Uint8Array): void {
    const b = this.#parLocal.get(local);
    if (!b) return;
    b.id = hex(id);
    this.#parId.set(b.id, b);
    b.attendus = this.membres.filter((s) => s !== this.moi);
    this.#change();
  }
  accepte(local: number, seq: number): void {
    const b = this.#parLocal.get(local);
    if (!b) return;
    b.seq = seq;
    b.etat = "envoye";
    b.envoyeMs ??= this.maintenant();
    // Expéditeur : son compte à rebours local part de l'envoi (v3 §5, `vuParMoiMs`).
    if (!this.vuLe.has(b.cle)) this.vuLe.set(b.cle, this.maintenant());
    this.#parLocal.delete(local);
    this.#change();
  }
  echec(local: number, code: string): void {
    const b = this.#parLocal.get(local);
    if (!b) return;
    b.etat = "echec";
    b.echec = code;
    this.#change();
  }
  /** Notre modification ou notre retrait, appliqués tout de suite chez nous. */
  modifierLocal(id: string, texte: string): void {
    const b = this.#parId.get(id);
    if (!b || !b.moi || b.retire) return;
    b.texte = texte;
    b.modifie = true;
    this.#change();
  }
  retirerLocal(id: string): void {
    const b = this.#parId.get(id);
    if (!b || !b.moi) return;
    this.#retirer(b);
  }
  reagirLocal(id: string, emoji: string): void {
    const b = this.#parId.get(id);
    if (b) this.#reaction(b, this.moi, emoji);
  }

  // --- Messages reçus ----------------------------------------------------------------------------

  /**
   * Message déchiffré (événement `message` du client). Rend ce que l'appelant doit accuser :
   * `recu` (identifiant à accuser) pour un texte ou une réponse d'un autre siège, sinon null.
   */
  message(seq: number, siege: number, epoque: number, env: EnveloppeRecue): { recu: Uint8Array } | null {
    const m = env.message;
    const id = hex(env.id);
    const autre = siege !== this.moi;
    if (this.#regleSeq === 0 && env.regle >= 1 && (m.k === "texte" || m.k === "reponse")) this.regle = env.regle;
    switch (m.k) {
      case "texte":
      case "reponse": {
        if (this.#parId.has(id)) return null; // doublon : le premier en ordre seq gagne
        this.ecrit.delete(siege);
        const b: Bulle = {
          k: "bulle",
          cle: id,
          id,
          seq,
          local: null,
          siege,
          moi: !autre,
          texte: m.x,
          cite: m.k === "reponse" ? hex(m.cible) : null,
          modifie: false,
          retire: false,
          heureMs: env.heureMs,
          regle: env.regle,
          epoque,
          etat: "envoye",
          echec: null,
          attendus: this.membres.filter((s) => s !== siege),
          recus: [],
          vus: [],
          ouverts: [],
          telecharges: [],
          heures: heuresVides(),
          envoyeMs: null,
          reactions: [],
          piece: null,
        };
        this.elements.push(b);
        this.#parId.set(id, b);
        this.#change();
        return autre ? { recu: env.id } : null;
      }
      case "modif": {
        const b = this.#parId.get(hex(m.cible));
        if (!b || b.siege !== siege || b.retire) return null; // auteur seul
        b.texte = m.x;
        b.modifie = true;
        this.#change();
        return null;
      }
      case "retrait": {
        const b = this.#parId.get(hex(m.cible));
        if (!b || b.siege !== siege) return null;
        this.#retirer(b);
        return null;
      }
      case "reaction": {
        const b = this.#parId.get(hex(m.cible));
        if (b) this.#reaction(b, siege, m.emoji);
        return null;
      }
      case "recu":
      case "vu": {
        for (const i of m.ids) {
          const b = this.#parId.get(hex(i));
          if (!b || !b.moi || !b.attendus.includes(siege)) continue;
          if (!b.recus.includes(siege)) b.recus.push(siege);
          if (m.k === "vu" && !b.vus.includes(siege)) b.vus.push(siege);
          noter(b.heures.recu, siege, env.heureMs);
          if (m.k === "vu") noter(b.heures.vu, siege, env.heureMs);
        }
        this.#change();
        return null;
      }
      case "piece_ouverte":
      case "piece_telechargee": {
        // Accusés d'une pièce (v3 §14.2) : de nos pièces seulement, d'un lecteur attendu. Ouvrir
        // ou télécharger vaut aussi « reçu » et « vu ».
        for (const i of m.ids) {
          const b = this.#parId.get(hex(i));
          if (!b || !b.moi || !b.piece || !b.attendus.includes(siege)) continue;
          const l = m.k === "piece_ouverte" ? b.ouverts : b.telecharges;
          if (!l.includes(siege)) l.push(siege);
          if (!b.recus.includes(siege)) b.recus.push(siege);
          if (!b.vus.includes(siege)) b.vus.push(siege);
          noter(m.k === "piece_ouverte" ? b.heures.ouvert : b.heures.telecharge, siege, env.heureMs);
          noter(b.heures.recu, siege, env.heureMs);
          noter(b.heures.vu, siege, env.heureMs);
        }
        this.#change();
        return null;
      }
      case "ecrit":
        if (autre) {
          this.ecrit.set(siege, this.maintenant() + 6_000);
          this.#change();
        }
        return null;
      case "piece": {
        if (this.#parId.has(id)) return null;
        const b = this.#nouvelle(id, seq, siege, epoque, env, "", null);
        b.piece = { nom: m.nom, mime: m.mime, taille: m.taille, sorte: m.sorte, dureeMs: m.dureeMs, ref: { r: m.r, piece: m.piece, palier: m.palier }, progres: null };
        this.elements.push(b);
        this.#parId.set(id, b);
        this.#change();
        return autre ? { recu: env.id } : null;
      }
      case "profil":
        this.#profil(seq, siege, m.pseudo, m.couleur);
        this.avatars.set(siege, m.avatar);
        return null;
      case "regle":
        // Règle d'effacement du salon (v3 §5) : tout participant la change ; elle vaut pour les
        // messages envoyés ensuite (chacun garde la sienne). La plus récente en ordre seq gagne.
        if (seq > this.#regleSeq && m.regle >= 1) {
          this.#regleSeq = seq;
          this.regle = m.regle;
          this.#sys({ k: "sys", quoi: "regle", siege, regle: m.regle });
          this.#change();
        }
        return null;
      default:
        return null; // depart, rotation, inconnu
    }
  }

  /**
   * Règle d'effacement des prochains messages : celle du dernier message
   * `regle` lu, sinon celle du dernier message reçu, sinon 5 min (défaut de l'écran).
   */
  regle: Regle = 2;
  #regleSeq = 0;

  /** Notre changement de règle, appliqué tout de suite chez nous (l'écho n'est pas relu). */
  regleLocale(r: Regle): void {
    this.regle = r;
    this.#regleSeq = Number.MAX_SAFE_INTEGER - 1;
    this.#sys({ k: "sys", quoi: "regle", siege: this.moi, regle: r });
    this.#change();
  }

  /** Instant où cet appareil a vu chaque message (compte à rebours local, `etatEffacement`). */
  readonly vuLe = new Map<string, number>();
  marquerVu(cle: string, ms: number): void {
    if (!this.vuLe.has(cle)) this.vuLe.set(cle, ms);
    this.#change();
  }

  /** Membres présents à notre arrivée, et pseudonymes qu'ils se sont disputés (P1) : clés d'unicité. */
  #anciens: Set<number> | null = null;
  readonly #contestes = new Set<string>();

  /** Codes de vérification comparés ici (siège → code vérifié), annulés quand le code change. */
  readonly verifies = new Map<number, string>();

  /** Invitation changée (rotation) : ligne chez tous ; les codes restent (refonder). */
  invitationChangee(): void {
    this.#sys({ k: "sys", quoi: "invitation", siege: this.createurSiege });
    this.#change();
  }

  /** Alerte du salon lui-même avant sa fin (calculée sur l'appareil, fermeture.ts). */
  fermeture(minutes: number): void {
    this.#sys({ k: "sys", quoi: "fermeture", siege: this.moi, minutes });
    this.#change();
  }

  /** Renouvellement (0x10) : tout ce qui est de rang ≤ départ quitte l'écran ; les codes sont à revérifier. */
  renouveler(depart: number): string[] {
    const partis: string[] = [];
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const e = this.elements[i]!;
      if (e.k === "bulle" && e.seq !== null && e.seq <= depart) {
        this.elements.splice(i, 1);
        if (e.id) this.#parId.delete(e.id);
        partis.push(e.cle);
      }
    }
    this.verifies.clear();
    this.#sys({ k: "sys", quoi: "renouvellement", siege: this.createurSiege });
    this.#change();
    return partis;
  }

  #nouvelle(id: string, seq: number, siege: number, epoque: number, env: EnveloppeRecue, texte: string, cite: string | null): Bulle {
    return {
      k: "bulle",
      cle: id,
      id,
      seq,
      local: null,
      siege,
      moi: siege === this.moi,
      texte,
      cite,
      modifie: false,
      retire: false,
      heureMs: env.heureMs,
      regle: env.regle,
      epoque,
      etat: "envoye",
      echec: null,
      attendus: this.membres.filter((s) => s !== siege),
      recus: [],
      vus: [],
      ouverts: [],
      telecharges: [],
      heures: heuresVides(),
      envoyeMs: null,
      reactions: [],
      piece: null,
    };
  }

  /** Avatar annoncé par chaque siège (profil), ou null : initiale sur sa couleur (v3 §7.2). */
  readonly avatars = new Map<number, { r: Uint8Array; piece: Uint8Array; palier: number } | null>();

  /** Notre pièce en cours d'envoi (numéro local négatif, tant qu'elle n'est pas chiffrée). */
  pieceEnvoi(local: number, p: Omit<PieceInfo, "ref" | "progres">): void {
    this.envoye(local, { sorte: "texte", texte: "" }, 0);
    const b = this.#parLocal.get(local)!;
    b.piece = { ...p, ref: null, progres: 0 };
    this.#change();
  }
  progresPiece(local: number, f: number, ref?: PieceInfo["ref"]): void {
    const b = this.#parLocal.get(local);
    if (!b?.piece) return;
    b.piece.progres = f;
    if (ref) b.piece.ref = ref;
    this.#change();
  }
  /** Le message de la pièce part : son numéro local devient celui du client. */
  rattacher(ancien: number, local: number): void {
    const b = this.#parLocal.get(ancien);
    if (!b) return;
    this.#parLocal.delete(ancien);
    b.local = local;
    if (b.piece) b.piece.progres = null;
    this.#parLocal.set(local, b);
  }

  #retirer(b: Bulle): void {
    b.retire = true;
    b.texte = "";
    b.reactions = [];
    b.piece = null; // la pièce quitte aussi l'écran (sa trame et sa pièce quittent le serveur)
    this.#change();
  }

  /** Une réaction par siège : une nouvelle remplace la sienne, la même la retire. */
  #reaction(b: Bulle, siege: number, emoji: string): void {
    if (b.retire) return;
    const avant = b.reactions.find((r) => r.sieges.includes(siege));
    if (avant) avant.sieges = avant.sieges.filter((s) => s !== siege);
    if (avant?.emoji !== emoji) {
      const r = b.reactions.find((x) => x.emoji === emoji);
      if (r) r.sieges.push(siege);
      else b.reactions.push({ emoji, sieges: [siege] });
    }
    b.reactions = b.reactions.filter((r) => r.sieges.length > 0);
    this.#change();
  }

  /**
   * Notre profil, appliqué chez nous (l'écho de notre propre message n'est pas relu par le
   * moteur) : rang inconnu tant que le serveur ne l'a pas accepté (`seq` absent : après tous les
   * autres), puis le rang de notre trame (`0x0F`), pour la même règle d'unicité que chez les autres.
   */
  monProfil(pseudo: string, couleur: number, seq = Number.MAX_SAFE_INTEGER): void {
    const avant = this.profils.get(this.moi);
    if (avant && avant.seq < seq && avant.pseudo === pseudo) return;
    this.profils.delete(this.moi);
    this.#profil(seq, this.moi, pseudo, couleur);
    if (avant?.pseudo && avant.pseudo !== pseudo && this.profils.get(this.moi)?.pseudo === pseudo) this.#sys({ k: "sys", quoi: "pseudo", siege: this.moi, avant: avant.pseudo, apres: pseudo });
  }

  #profil(seq: number, siege: number, pseudo: string, couleur: number): void {
    const avant = this.profils.get(siege);
    if (avant && avant.seq >= seq) return;
    let k: string;
    try {
      k = this.cleUnicite(pseudo);
    } catch {
      return;
    }
    // Unicité : déjà pris par un autre siège présent, annoncé avant → refusé.
    let pris = false;
    let titulaire = -1;
    for (const [s, p] of this.profils)
      if (s !== siege && this.presents.has(s) && p.pseudo !== null && p.seq < seq && this.cleUnicite(p.pseudo) === k) {
        pris = true;
        titulaire = s;
      }
    // P1 : deux membres déjà là à notre arrivée se disputent un pseudonyme → aucun ne le garde.
    const ancien = (x: number) => this.#anciens?.has(x) === true;
    if (ancien(siege) && ((pris && ancien(titulaire)) || this.#contestes.has(k))) {
      const nouveau = !this.#contestes.has(k);
      this.#contestes.add(k);
      const t = pris ? this.profils.get(titulaire) : undefined;
      if (t) this.profils.set(titulaire, { ...t, pseudo: null });
      this.profils.set(siege, { pseudo: null, couleur: Number.isInteger(couleur) && couleur >= 0 && couleur < COULEURS ? couleur : siege % COULEURS, seq });
      if (nouveau) this.#sys({ k: "sys", quoi: "double", siege });
      this.#change();
      return;
    }
    const accepte = pris ? null : pseudo;
    if (siege === this.moi) this.pseudoRefuse = pris;
    this.profils.set(siege, { pseudo: accepte, couleur: Number.isInteger(couleur) && couleur >= 0 && couleur < COULEURS ? couleur : siege % COULEURS, seq });
    if (avant?.pseudo && accepte && avant.pseudo !== accepte) this.#sys({ k: "sys", quoi: "pseudo", siege, avant: avant.pseudo, apres: accepte });
    this.#change();
  }

  // --- Lecture -----------------------------------------------------------------------------------

  /** Sièges qui écrivent en ce moment (hors soi). */
  ecrivent(): number[] {
    const t = this.maintenant();
    return [...this.ecrit].filter(([s, fin]) => fin > t && s !== this.moi).map(([s]) => s);
  }

  /** Coches d'un de nos messages : envoyé (une), reçu par tous (deux), vu par tous (deux, couleur). */
  /** Fiche « Infos » d'un de nos messages : envoi, puis chaque lecteur attendu ; null sinon. */
  infos(b: Bulle): { envoyeMs: number | null; lecteurs: LigneInfos[] } | null {
    if (!b.moi) return null;
    const h = (m: Map<number, number>, s: number) => m.get(s) ?? null;
    return { envoyeMs: b.envoyeMs, lecteurs: b.attendus.map((s) => ({ siege: s, recu: h(b.heures.recu, s), vu: h(b.heures.vu, s), ouvert: h(b.heures.ouvert, s), telecharge: h(b.heures.telecharge, s) })) };
  }
  coche(b: Bulle): "attente" | "envoye" | "recu" | "vu" | "echec" {
    if (b.etat === "echec") return "echec";
    if (b.etat === "envoi") return "attente";
    if (b.attendus.length > 0 && b.attendus.every((s) => b.vus.includes(s))) return "vu";
    if (b.attendus.length > 0 && b.attendus.every((s) => b.recus.includes(s))) return "recu";
    return "envoye";
  }
}

const PONCTUATION_FINALE = ".,;:!?)]»’'";
/** Découpes déjà faites (un texte reçu ne change pas) : le fil est redessiné à chaque événement. */
const decoupes = new Map<string, readonly { lien: boolean; t: string }[]>();
const DECOUPES_MAX = 2000;

/**
 * Morceaux d'un texte : liens `https?://` cliquables, le reste en texte (aucun Markdown, §39.5).
 * Coût linéaire et résultat gardé (une longue ponctuation finale coûtait
 * un temps quadratique, recalculé pour chaque bulle à chaque changement du fil).
 */
export function morceaux(texte: string): readonly { lien: boolean; t: string }[] {
  const deja = decoupes.get(texte);
  if (deja) return deja;
  const r = Object.freeze(decouper(texte));
  if (decoupes.size >= DECOUPES_MAX) decoupes.delete(decoupes.keys().next().value!);
  decoupes.set(texte, r);
  return r;
}

function decouper(texte: string): { lien: boolean; t: string }[] {
  const out: { lien: boolean; t: string }[] = [];
  const re = /https?:\/\/[^\s<>"]+/g;
  let i = 0;
  for (const m of texte.matchAll(re)) {
    let u = m[0];
    // Ponctuation finale laissée au texte (« voir https://x.fr. »).
    let k = u.length;
    while (k > 0 && PONCTUATION_FINALE.includes(u[k - 1]!)) k--;
    u = u.slice(0, k);
    if (m.index! > i) out.push({ lien: false, t: texte.slice(i, m.index) });
    let valide = false;
    try {
      const p = new URL(u);
      valide = (p.protocol === "https:" || p.protocol === "http:") && p.hostname !== "";
    } catch {
      valide = false;
    }
    out.push({ lien: valide, t: u });
    i = m.index! + u.length;
  }
  if (i < texte.length) out.push({ lien: false, t: texte.slice(i) });
  return out.filter((x) => x.t !== "");
}

/** Première heure d'un accusé pour ce siège (les suivantes ne la changent pas). */
function noter(m: Map<number, number>, siege: number, ms: number): void {
  if (!m.has(siege) && Number.isSafeInteger(ms)) m.set(siege, ms);
}

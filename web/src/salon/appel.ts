// Appels audio et vidéo du salon (conception : docs/superpowers/specs/2026-11-20-appels-design.md).
//
// - Maillage : une connexion WebRTC par paire de participants (6 au plus), sans serveur de
//   média. Entre deux sièges, le plus petit numéro propose (offre), l'autre répond : jamais deux
//   offres croisées.
// - Toujours par le relais TURN (`iceTransportPolicy: "relay"`) : aucun participant ne voit
//   l'adresse IP d'un autre (spec §39.3.1). Défense en profondeur : tout candidat qui n'est pas
//   « typ relay » est jeté, à l'envoi comme à la réception, dans le SDP comme en candidat seul.
// - Chiffrement de bout en bout par DTLS-SRTP (celui du navigateur, aucune crypto à nous) :
//   l'empreinte DTLS de chacun voyage dans l'offre et la réponse, qui sont des messages du
//   salon, chiffrés et signés par MLS. Le relais et le serveur ne voient que du chiffré, et un
//   intermédiaire ne peut pas substituer sa propre empreinte.
// - Signalisation : messages volatils `appel_present` (entrée, puis toutes les 15 s),
//   `appel_fin`, `appel_signal` (offre et réponse en morceaux, candidats). Rien n'est gardé.
// - Un seul appel par salon : si deux personnes en lancent un en même temps, le plus petit
//   identifiant l'emporte et l'autre s'y rallie.
//
// Ce fichier ne touche ni au réseau ni au DOM : tout passe par `DepsAppel` (tests : appel.test.ts).
import type { Message } from "./engine";
import type { Relais } from "./api";

export type MessageAppel = Extract<Message, { k: "appel_present" | "appel_fin" | "appel_signal" }>;

/** Participants d'un appel, au plus (maillage : chacun envoie son flux à tous les autres). */
export const APPEL_MAX = 6;
/** Présence redite à cet intervalle ; un participant muet plus de `PRESENCE_PERDUE_MS` est retiré. */
export const PRESENCE_MS = 15_000;
export const PRESENCE_PERDUE_MS = 40_000;
/** Octets d'un morceau d'offre ou de réponse (le moteur en accepte 3 600 ; marge pour l'échappement JSON des fins de ligne). */
export const MORCEAU = 3_000;
const MORCEAUX_MAX = 8;
/** Débit vidéo envoyé à chaque participant, au plus (bits par seconde). */
const DEBIT_VIDEO = 500_000;
/** File d'envoi : rafale puis cadence, sous la limite du serveur pour les trames volatiles (30 puis 2 par seconde). */
const RAFALE = 12;
const PAR_SECONDE = 1.5;
/** Un message qui ne part pas (moteur occupé) est réessayé, puis abandonné après ce délai. */
const ABANDON_MS = 20_000;
const REESSAIS_PAIRE = 3;

export type DepsAppel = {
  moi: number;
  /** Chiffre et envoie un message d'appel ; faux si le moteur refuse pour l'instant. */
  envoyer(m: MessageAppel): boolean;
  /** Identifiants temporaires du relais TURN. */
  relais(): Promise<Relais>;
  /** Micro et/ou caméra (au moins l'un des deux) ; `face` : caméra de face (« user ») ou de dos (« environment »). */
  media(o: { audio: boolean; video: boolean; face: Face }): Promise<MediaStream>;
  pair(config: RTCConfiguration): RTCPeerConnection;
  /** Partage d'écran (getDisplayMedia) ; absent : le navigateur ne le permet pas (Safari sur iPhone). */
  ecran?: () => Promise<MediaStream>;
  flux(): MediaStream;
  alea(): Uint8Array;
  maintenant(): number;
  plusTard(ms: number, f: () => void): () => void;
  /** L'état affiché a changé. */
  change(): void;
};

export type Participant = { siege: number; video: boolean; flux: MediaStream | null; lien: "connexion" | "lie" | "coupe" };
/** « perdu » : le micro s'est arrêté en cours d'appel (débranché, autorisation retirée). */
export type ErreurAppel = "micro" | "relais" | "complet" | "perdu";
export type Face = "user" | "environment";

type Paire = {
  pc: RTCPeerConnection;
  offre: boolean;
  flux: MediaStream;
  audio?: RTCRtpSender;
  video?: RTCRtpSender;
  /** Candidats reçus avant la description distante. */
  attente: RTCIceCandidateInit[];
  distante: boolean;
  lien: Participant["lien"];
  /** Création (horloge des dépendances) : une offre ne la remplace pas avant OFFRE_INTERVALLE_MS. */
  debut: number;
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const deHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const ASCII = /^[\x20-\x7e\r\n]+$/;

/** SDP sans candidat autre que « relay » (aucune adresse d'un participant), fins de ligne CRLF. */
export function filtrerSdp(sdp: string): string {
  return (
    sdp
      .split(/\r?\n/)
      .filter((l) => l !== "" && !(l.startsWith("a=candidate:") && !candidatRelais(l.slice(2))))
      .join("\r\n") + "\r\n"
  );
}

/**
 * Vrai pour un candidat ICE du relais seulement : le type lu à sa place (8e champ :
 * « candidate:<fondation> <composante> <transport> <priorité> <adresse> <port> typ relay »),
 * jamais « typ relay » glissé ailleurs dans la ligne (revue du 21 novembre).
 */
export function candidatRelais(c: string): boolean {
  return /^candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ relay( |$)/.test(c);
}

/** Offre acceptable : exactement une ligne m=audio et une m=video, rien d'autre (revue du 21 novembre). */
export function offreSaine(sdp: string): boolean {
  const m = sdp.split(/\r?\n/).filter((l) => l.startsWith("m="));
  return m.length === 2 && m.filter((l) => l.startsWith("m=audio ")).length === 1 && m.filter((l) => l.startsWith("m=video ")).length === 1;
}

/** Une connexion établie n'est pas refaite sur une simple offre ; une en cours, au plus toutes les 10 s. */
const OFFRE_INTERVALLE_MS = 10_000;


export class Appel {
  readonly #d: DepsAppel;
  /** Identifiant (hex) de l'appel en cours dans le salon, connu de nous ; null : aucun. */
  #id: string | null = null;
  /** Sièges qui ont déjà fait basculer l'appel vers un identifiant plus petit. */
  #bascules = new Set<number>();
  #dans = false;
  #entree = false;
  #presents = new Map<number, { vu: number; video: boolean; essais: number }>();
  #paires = new Map<number, Paire>();
  #morceaux = new Map<string, { n: number; parts: string[] }>();
  /** Candidats d'un siège arrivés avant son offre (l'ordre d'arrivée n'est pas garanti). */
  #tot = new Map<number, RTCIceCandidateInit[]>();
  #local: MediaStream | null = null;
  #relais: Relais | null = null;
  #file: { m: MessageAppel; depuis: number }[] = [];
  #jetons = RAFALE;
  #jetonsA = 0;
  #videur: (() => void) | null = null;
  #tic: (() => void) | null = null;
  #dernierePresence = 0;
  micro = true;
  camera = false;
  /** Caméra de face ou de dos (téléphone) ; l'image de face est montrée en miroir. */
  face: Face = "user";
  /** Partage d'écran en cours : l'écran remplace la caméra pour les autres, puis la caméra revient. */
  ecran = false;
  #ecranPiste: MediaStreamTrack | null = null;
  #fluxEcran: MediaStream | null = null;
  erreur: ErreurAppel | null = null;

  constructor(d: DepsAppel) {
    this.#d = d;
    this.#jetonsA = d.maintenant();
  }

  /** « aucun » : pas d'appel ; « sonne » : un appel a lieu sans nous ; « entree » : on demande le micro et le relais ; « dans » : on y est. */
  get etat(): "aucun" | "sonne" | "entree" | "dans" {
    if (this.#entree) return "entree";
    if (this.#dans) return "dans";
    return this.#presents.size > 0 ? "sonne" : "aucun";
  }
  get local(): MediaStream | null {
    return this.#local;
  }
  /** Les autres participants, par numéro de siège. */
  get participants(): Participant[] {
    return [...this.#presents.entries()]
      .sort(([a], [b]) => a - b)
      .map(([siege, p]) => {
        const x = this.#paires.get(siege);
        return { siege, video: p.video, flux: x?.flux ?? null, lien: x?.lien ?? "connexion" };
      });
  }

  // --- Actions ------------------------------------------------------------------------------------

  /** Lance un appel ou rejoint celui en cours. `video` : caméra allumée dès l'entrée. */
  async rejoindre(video: boolean): Promise<void> {
    if (this.#dans || this.#entree) return;
    this.erreur = null;
    if (this.#presents.size >= APPEL_MAX - 1) {
      this.erreur = "complet";
      this.#d.change();
      return;
    }
    this.#entree = true;
    this.#d.change();
    let flux: MediaStream;
    try {
      flux = await this.#d.media({ audio: true, video, face: this.face });
    } catch {
      this.#entree = false;
      this.erreur = "micro";
      this.#d.change();
      return;
    }
    try {
      this.#relais = await this.#d.relais();
    } catch {
      for (const t of flux.getTracks()) t.stop();
      this.#entree = false;
      this.erreur = "relais";
      this.#d.change();
      return;
    }
    this.#local = flux;
    this.micro = true;
    this.camera = flux.getVideoTracks().length > 0;
    for (const t of flux.getTracks()) this.#surveiller(t);
    this.#entree = false;
    this.#dans = true;
    if (this.#id === null) this.#adopter(hex(this.#d.alea()));
    this.#annoncer(true);
    for (const s of this.#presents.keys()) if (this.#d.moi < s) void this.#offrir(s);
    this.#veiller();
    this.#d.change();
  }

  /** Raccroche : les autres continuent sans nous. */
  quitter(): void {
    if (!this.#dans) return;
    this.#tot.clear();
    this.#file = [];
    if (this.#id) this.#d.envoyer({ k: "appel_fin", appel: deHex(this.#id) });
    this.#dans = false;
    for (const s of [...this.#paires.keys()]) this.#fermer(s);
    this.#lacher();
    if (this.#presents.size === 0) {
      this.#id = null;
      this.#bascules.clear();
    }
    this.#d.change();
  }

  /** Fin du salon ou départ de la page : tout est fermé, rien n'est gardé. */
  fermer(): void {
    this.quitter();
    this.#presents.clear();
    this.#id = null;
    this.#bascules.clear();
    this.#tic?.();
    this.#tic = null;
    this.#videur?.();
    this.#videur = null;
  }

  basculerMicro(): void {
    if (!this.#local) return;
    this.micro = !this.micro;
    for (const t of this.#local.getAudioTracks()) t.enabled = this.micro;
    this.#d.change();
  }

  /** Allume ou éteint la caméra (éteinte : la piste est arrêtée, le voyant de l'appareil s'éteint). */
  async basculerCamera(): Promise<void> {
    const local = this.#local;
    if (!local || !this.#dans) return;
    if (this.camera) {
      for (const t of local.getVideoTracks()) {
        t.onended = null;
        t.stop();
        local.removeTrack(t);
      }
      this.camera = false;
      if (!this.ecran) for (const p of this.#paires.values()) void p.video?.replaceTrack(null).catch(() => {});
    } else {
      let piste: MediaStreamTrack | undefined;
      try {
        piste = (await this.#d.media({ audio: false, video: true, face: this.face })).getVideoTracks()[0];
      } catch {
        piste = undefined;
      }
      if (!piste) {
        this.erreur = "micro";
        this.#d.change();
        return;
      }
      if (this.#local !== local || !this.#dans) {
        piste.stop();
        return;
      }
      local.addTrack(piste);
      this.#surveiller(piste);
      this.camera = true;
      if (!this.ecran) for (const p of this.#paires.values()) void p.video?.replaceTrack(piste).catch(() => {});
    }
    this.#annoncer(true);
    this.#d.change();
  }

  /**
   * Caméra de face ↔ de dos (téléphone). La nouvelle image est obtenue avant d'arrêter l'ancienne :
   * si l'autre caméra est refusée ou absente, rien ne change.
   */
  async retournerCamera(): Promise<void> {
    const local = this.#local;
    if (!local || !this.#dans || !this.camera) return;
    const face: Face = this.face === "user" ? "environment" : "user";
    let piste: MediaStreamTrack | undefined;
    try {
      piste = (await this.#d.media({ audio: false, video: true, face })).getVideoTracks()[0];
    } catch {
      piste = undefined;
    }
    if (!piste) return;
    if (this.#local !== local || !this.#dans || !this.camera) {
      piste.stop();
      return;
    }
    for (const t of local.getVideoTracks()) {
      t.onended = null;
      t.stop();
      local.removeTrack(t);
    }
    local.addTrack(piste);
    this.#surveiller(piste);
    this.face = face;
    if (!this.ecran) for (const p of this.#paires.values()) void p.video?.replaceTrack(piste).catch(() => {});
    this.#d.change();
  }

  /** Le navigateur permet-il de partager l'écran ? */
  get ecranPossible(): boolean {
    return this.#d.ecran !== undefined;
  }
  /** Flux de l'écran partagé (aperçu local), ou null. */
  get fluxEcran(): MediaStream | null {
    return this.#fluxEcran;
  }

  /**
   * Partage d'écran : l'écran remplace la caméra pour les autres (même connexion chiffrée, même
   * relais), le temps du partage. Refusé ou annulé dans le sélecteur du navigateur : rien ne
   * change. Fin par « Arrêter », par le navigateur (bouton « Arrêter le partage »), ou en raccrochant.
   */
  async partagerEcran(): Promise<void> {
    const ecran = this.#d.ecran;
    if (!ecran || !this.#dans || this.ecran) return;
    let piste: MediaStreamTrack | undefined;
    try {
      piste = (await ecran()).getVideoTracks()[0];
    } catch {
      piste = undefined;
    }
    if (!piste) return;
    if (!this.#dans || this.ecran) {
      piste.stop();
      return;
    }
    this.#ecranPiste = piste;
    this.#fluxEcran = this.#d.flux();
    this.#fluxEcran.addTrack(piste);
    this.ecran = true;
    piste.onended = () => this.arreterEcran();
    for (const p of this.#paires.values()) void p.video?.replaceTrack(piste).catch(() => {});
    this.#annoncer(true);
    this.#d.change();
  }

  /** Fin du partage d'écran : la caméra revient si elle était allumée, sinon plus d'image. */
  arreterEcran(): void {
    const piste = this.#ecranPiste;
    if (!piste) return;
    piste.onended = null;
    piste.stop();
    this.#ecranPiste = null;
    this.#fluxEcran = null;
    this.ecran = false;
    const cam = this.#local?.getVideoTracks()[0] ?? null;
    for (const p of this.#paires.values()) void p.video?.replaceTrack(cam).catch(() => {});
    this.#annoncer(true);
    this.#d.change();
  }

  /**
   * Une piste locale qui s'arrête d'elle-même (micro débranché, caméra prise par une autre app,
   * autorisation retirée) : sans micro, on quitte l'appel en le disant ; sans caméra, on continue
   * en audio et les autres le savent.
   */
  #surveiller(t: MediaStreamTrack): void {
    t.onended = () => {
      const local = this.#local;
      if (!local || !this.#dans || !local.getTracks().includes(t)) return;
      if (t.kind === "audio") {
        this.erreur = "perdu";
        this.quitter();
        return;
      }
      local.removeTrack(t);
      this.camera = local.getVideoTracks().length > 0;
      if (!this.camera && !this.ecran) for (const p of this.#paires.values()) void p.video?.replaceTrack(null).catch(() => {});
      this.#annoncer(true);
      this.#d.change();
    };
  }

  // --- Événements du salon --------------------------------------------------------------------------

  /** Un siège a quitté le salon ou en a été exclu : sa connexion est fermée aussitôt. */
  parti(siege: number): void {
    if (!this.#presents.delete(siege) && !this.#paires.has(siege)) return;
    this.#fermer(siege);
    this.#finSiVide();
    this.#d.change();
  }

  /** Message d'appel déchiffré, venu du siège `siege` (authentifié par MLS). */
  recu(siege: number, m: MessageAppel): void {
    if (siege === this.#d.moi) return;
    const id = hex(m.appel);
    if (m.k === "appel_present") return this.#present(siege, id, m.video);
    if (id !== this.#id) return;
    if (m.k === "appel_fin") return this.parti(siege);
    if (!this.#dans || m.pour !== this.#d.moi || !this.#presents.has(siege)) return;
    if (m.sorte === "glace") return this.#glace(siege, m.x);
    const cle = `${siege}:${m.sorte}`;
    if (m.i === 0) this.#morceaux.set(cle, { n: m.n, parts: [] });
    const a = this.#morceaux.get(cle);
    if (!a || a.n !== m.n || a.parts.length !== m.i || m.n > MORCEAUX_MAX) {
      this.#morceaux.delete(cle);
      return;
    }
    a.parts.push(m.x);
    if (a.parts.length < a.n) return;
    this.#morceaux.delete(cle);
    const sdp = filtrerSdp(a.parts.join(""));
    if (m.sorte === "offre") {
      // Offres en rafale (revue du 21 novembre) : une connexion établie ou trop récente n'est pas
      // refaite ; sinon chaque offre remplaçait la précédente et saturait notre file d'envoi.
      const p = this.#paires.get(siege);
      if (p && (p.lien === "lie" || this.#d.maintenant() - p.debut < OFFRE_INTERVALLE_MS)) return;
      if (!offreSaine(sdp)) return;
      void this.#repondre(siege, sdp);
    }
    else void this.#reponse(siege, sdp);
  }

  #present(siege: number, id: string, video: boolean): void {
    if (this.#id === null) this.#adopter(id);
    else if (id !== this.#id) {
      // Deux appels lancés en même temps : le plus petit identifiant l'emporte. Seulement tant
      // qu'aucune connexion n'est établie, et une fois par siège (revue du 21 novembre : des
      // identifiants toujours plus petits démontaient sinon toutes les connexions de tous, en
      // boucle) ; ensuite, l'appel concurrent est ignoré.
      const lie = [...this.#paires.values()].some((p) => p.lien === "lie");
      if (id > this.#id || this.#bascules.has(siege) || lie) return;
      this.#bascules.add(siege);
      for (const s of [...this.#paires.keys()]) this.#fermer(s);
      this.#presents.clear();
      this.#adopter(id);
      if (this.#dans) this.#annoncer(true);
    }
    const avant = this.#presents.get(siege);
    this.#presents.set(siege, { vu: this.#d.maintenant(), video, essais: avant?.essais ?? 0 });
    if (this.#dans) {
      // Un nouveau venu ne sait pas encore qui est là : on se redit aussitôt.
      if (!avant) this.#annoncer(false);
      if (!this.#paires.has(siege) && this.#d.moi < siege && this.#paires.size < APPEL_MAX - 1) void this.#offrir(siege);
    }
    this.#veiller();
    this.#d.change();
  }

  // --- Connexions -------------------------------------------------------------------------------

  #paire(siege: number, offre: boolean): Paire | null {
    const r = this.#relais;
    if (!r) return null;
    this.#fermer(siege);
    const pc = this.#d.pair({
      iceServers: [{ urls: r.urls, username: r.username, credential: r.credential }],
      iceTransportPolicy: "relay",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    const p: Paire = { pc, offre, flux: this.#d.flux(), attente: [], distante: false, lien: "connexion", debut: this.#d.maintenant() };
    this.#paires.set(siege, p);
    const id = this.#id;
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (!c || !c.candidate || !candidatRelais(c.candidate) || this.#paires.get(siege) !== p || !id) return;
      const x = JSON.stringify({ c: c.candidate, m: c.sdpMid ?? null, l: c.sdpMLineIndex ?? null });
      if (ASCII.test(x)) this.#mettre({ k: "appel_signal", appel: deHex(id), pour: siege, sorte: "glace", i: 0, n: 1, x });
    };
    pc.ontrack = (e) => {
      // Une piste par sorte au plus : une offre piégée ne fait pas empiler des pistes.
      const k = e.track.kind;
      if ((k !== "audio" && k !== "video") || p.flux.getTracks().some((t) => t.kind === k)) return;
      p.flux.addTrack(e.track);
      this.#d.change();
    };
    pc.onconnectionstatechange = () => {
      if (this.#paires.get(siege) !== p) return;
      const s = pc.connectionState;
      if (s === "connected") {
        p.lien = "lie";
        const pr = this.#presents.get(siege);
        if (pr) pr.essais = 0;
        this.#borner(p);
      } else if (s === "failed" || s === "closed") {
        this.#fermer(siege);
        const pr = this.#presents.get(siege);
        // Le plus petit siège reprend la main : trois reprises rapides, puis une à chaque présence redite (15 s).
        if (s === "failed" && pr && this.#dans && this.#d.moi < siege && pr.essais < REESSAIS_PAIRE) {
          pr.essais++;
          this.#d.plusTard(2_000, () => {
            if (this.#dans && this.#presents.has(siege) && !this.#paires.has(siege)) void this.#offrir(siege);
          });
        }
      } else if (s === "disconnected") p.lien = "coupe";
      this.#d.change();
    };
    return p;
  }

  /** Débit vidéo borné : le relais porte tout le trafic. */
  #borner(p: Paire): void {
    const s = p.video;
    if (!s) return;
    try {
      const q = s.getParameters();
      if (!q.encodings || q.encodings.length === 0) q.encodings = [{}];
      q.encodings[0]!.maxBitrate = DEBIT_VIDEO;
      void s.setParameters(q).catch(() => {});
    } catch {
      // Navigateur sans réglage du débit : la résolution demandée (640 × 360) le borne déjà.
    }
  }

  async #offrir(siege: number): Promise<void> {
    const p = this.#paire(siege, true);
    if (!p) return;
    try {
      const a = this.#local?.getAudioTracks()[0] ?? "audio";
      const v = this.#ecranPiste ?? this.#local?.getVideoTracks()[0] ?? "video";
      p.audio = p.pc.addTransceiver(a, { direction: "sendrecv" }).sender;
      p.video = p.pc.addTransceiver(v, { direction: "sendrecv" }).sender;
      await p.pc.setLocalDescription(await p.pc.createOffer());
      if (this.#paires.get(siege) !== p) return;
      this.#decrire(siege, "offre", p.pc.localDescription?.sdp ?? "");
    } catch {
      if (this.#paires.get(siege) === p) this.#fermer(siege);
    }
  }

  async #repondre(siege: number, sdp: string): Promise<void> {
    // Seul le plus petit siège propose : une offre venue d'un siège plus grand est ignorée.
    if (siege > this.#d.moi) return;
    const tot = this.#tot.get(siege) ?? [];
    const p = this.#paire(siege, false);
    if (!p) return;
    p.attente = tot;
    try {
      await p.pc.setRemoteDescription({ type: "offer", sdp });
      if (this.#paires.get(siege) !== p) return;
      p.distante = true;
      for (const t of p.pc.getTransceivers()) {
        const sorte = t.receiver.track.kind;
        t.direction = "sendrecv";
        if (sorte === "audio" && !p.audio) {
          p.audio = t.sender;
          await t.sender.replaceTrack(this.#local?.getAudioTracks()[0] ?? null);
        } else if (sorte === "video" && !p.video) {
          p.video = t.sender;
          await t.sender.replaceTrack(this.#ecranPiste ?? this.#local?.getVideoTracks()[0] ?? null);
        }
      }
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      if (this.#paires.get(siege) !== p) return;
      this.#decrire(siege, "reponse", p.pc.localDescription?.sdp ?? "");
      await this.#vider(p);
    } catch {
      if (this.#paires.get(siege) === p) this.#fermer(siege);
    }
  }

  async #reponse(siege: number, sdp: string): Promise<void> {
    const p = this.#paires.get(siege);
    if (!p || !p.offre || p.distante) return;
    try {
      p.distante = true;
      await p.pc.setRemoteDescription({ type: "answer", sdp });
      await this.#vider(p);
    } catch {
      if (this.#paires.get(siege) === p) this.#fermer(siege);
    }
  }

  #glace(siege: number, x: string): void {
    const p = this.#paires.get(siege);
    let o: unknown;
    try {
      o = JSON.parse(x);
    } catch {
      return;
    }
    if (!o || typeof o !== "object") return;
    const { c, m, l } = o as { c?: unknown; m?: unknown; l?: unknown };
    if (typeof c !== "string" || !candidatRelais(c)) return;
    if (m !== null && typeof m !== "string") return;
    if (l !== null && !(Number.isInteger(l) && (l as number) >= 0 && (l as number) < 16)) return;
    const cand: RTCIceCandidateInit = { candidate: c, sdpMid: m as string | null, sdpMLineIndex: l as number | null };
    if (!p) {
      const t = this.#tot.get(siege) ?? [];
      if (t.length < 64) t.push(cand);
      this.#tot.set(siege, t);
      return;
    }
    if (!p.distante || p.pc.remoteDescription === null) {
      if (p.attente.length < 64) p.attente.push(cand);
      return;
    }
    void p.pc.addIceCandidate(cand).catch(() => {});
  }

  async #vider(p: Paire): Promise<void> {
    const a = p.attente;
    p.attente = [];
    for (const c of a) await p.pc.addIceCandidate(c).catch(() => {});
  }

  #decrire(siege: number, sorte: "offre" | "reponse", brut: string): void {
    const id = this.#id;
    const sdp = filtrerSdp(brut);
    if (!id || !ASCII.test(sdp)) return this.#fermer(siege);
    const n = Math.ceil(sdp.length / MORCEAU);
    if (n > MORCEAUX_MAX) return this.#fermer(siege);
    for (let i = 0; i < n; i++) this.#mettre({ k: "appel_signal", appel: deHex(id), pour: siege, sorte, i, n, x: sdp.slice(i * MORCEAU, (i + 1) * MORCEAU) });
  }

  #adopter(id: string): void {
    this.#id = id;
  }

  #fermer(siege: number): void {
    this.#tot.delete(siege);
    // Ce qui restait à envoyer à ce siège ne sert plus (une offre ou une réponse remplacée).
    this.#file = this.#file.filter((f) => !(f.m.k === "appel_signal" && f.m.pour === siege));
    const p = this.#paires.get(siege);
    if (!p) return;
    this.#paires.delete(siege);
    this.#morceaux.delete(`${siege}:offre`);
    this.#morceaux.delete(`${siege}:reponse`);
    p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = null;
    try {
      p.pc.close();
    } catch {
      // déjà fermée
    }
    for (const t of p.flux.getTracks()) t.stop();
  }

  #lacher(): void {
    for (const t of this.#local?.getTracks() ?? []) {
      t.onended = null;
      t.stop();
    }
    this.#local = null;
    this.#relais = null;
    this.micro = true;
    this.camera = false;
    this.face = "user";
    if (this.#ecranPiste) {
      this.#ecranPiste.onended = null;
      this.#ecranPiste.stop();
    }
    this.#ecranPiste = null;
    this.#fluxEcran = null;
    this.ecran = false;
  }

  #finSiVide(): void {
    if (this.#presents.size === 0 && !this.#dans) {
      this.#id = null;
      this.#bascules.clear();
      this.#tic?.();
      this.#tic = null;
    }
  }

  // --- Présence et file d'envoi ---------------------------------------------------------------------

  #annoncer(force: boolean): void {
    if (!this.#dans || !this.#id) return;
    const t = this.#d.maintenant();
    if (!force && t - this.#dernierePresence < 1_000) return;
    this.#dernierePresence = t;
    // Une présence en file suffit : la plus récente remplace l'ancienne, en tête de file (elle
    // dit que nous sommes là : jamais retardée derrière la signalisation, revue du 21 novembre).
    this.#file = this.#file.filter((f) => f.m.k !== "appel_present");
    this.#file.unshift({ m: { k: "appel_present", appel: deHex(this.#id), video: this.camera || this.ecran }, depuis: t });
    this.#pousser();
  }

  /** Toutes les 5 s tant qu'un appel est connu : présence redite, participants muets retirés. */
  #veiller(): void {
    if (this.#tic || this.#id === null) return;
    const tour = () => {
      this.#tic = null;
      const t = this.#d.maintenant();
      let change = false;
      for (const [s, p] of [...this.#presents]) {
        if (t - p.vu > PRESENCE_PERDUE_MS) {
          this.#presents.delete(s);
          this.#fermer(s);
          change = true;
        }
      }
      if (this.#dans && t - this.#dernierePresence >= PRESENCE_MS) this.#annoncer(true);
      this.#finSiVide();
      if (change) this.#d.change();
      if (this.#id !== null) this.#tic = this.#d.plusTard(5_000, tour);
    };
    this.#tic = this.#d.plusTard(5_000, tour);
  }

  #mettre(m: MessageAppel): void {
    this.#file.push({ m, depuis: this.#d.maintenant() });
    this.#pousser();
  }

  #pousser(): void {
    if (this.#videur) return;
    const t = this.#d.maintenant();
    this.#jetons = Math.min(RAFALE, this.#jetons + ((t - this.#jetonsA) / 1000) * PAR_SECONDE);
    this.#jetonsA = t;
    while (this.#file.length > 0) {
      const f = this.#file[0]!;
      if (t - f.depuis > ABANDON_MS) {
        this.#file.shift();
        continue;
      }
      if (this.#jetons < 1 || !this.#d.envoyer(f.m)) {
        // Cadence atteinte ou moteur occupé (Commit en cours) : on réessaie un peu plus tard, dans l'ordre.
        this.#videur = this.#d.plusTard(400, () => {
          this.#videur = null;
          this.#pousser();
        });
        return;
      }
      this.#jetons--;
      this.#file.shift();
    }
  }
}

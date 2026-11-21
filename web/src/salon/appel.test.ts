// Appels du salon : logique sans navigateur (faux RTCPeerConnection, faux flux, horloge à la main).
import { describe, it, expect } from "vitest";
import { Appel, APPEL_MAX, MORCEAU, PRESENCE_PERDUE_MS, candidatRelais, filtrerSdp, type DepsAppel, type MessageAppel } from "./appel";

type Piste = { kind: "audio" | "video"; enabled: boolean; arretee: boolean; face?: string; onended: (() => void) | null; stop(): void };
const piste = (kind: "audio" | "video", face?: string): Piste => ({
  kind,
  enabled: true,
  arretee: false,
  face,
  onended: null,
  stop() {
    this.arretee = true;
  },
});
class FauxFlux {
  pistes: Piste[] = [];
  constructor(p: Piste[] = []) {
    this.pistes = p;
  }
  getTracks = () => [...this.pistes];
  getAudioTracks = () => this.pistes.filter((p) => p.kind === "audio");
  getVideoTracks = () => this.pistes.filter((p) => p.kind === "video");
  addTrack = (p: Piste) => void this.pistes.push(p);
  removeTrack = (p: Piste) => void (this.pistes = this.pistes.filter((x) => x !== p));
}

const HOTE = "candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host";
const RELAIS = "candidate:2 1 udp 41885439 203.0.113.9 49152 typ relay raddr 0.0.0.0 rport 0";

class FauxPC {
  static toutes: FauxPC[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  connectionState = "new";
  fermee = false;
  candidats: RTCIceCandidateInit[] = [];
  transceivers: { sender: { track: unknown; replaceTrack(t: unknown): Promise<void>; getParameters(): { encodings: { maxBitrate?: number }[] }; setParameters(p: unknown): Promise<void>; debit?: number }; receiver: { track: { kind: string } }; direction: string }[] = [];
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly config: RTCConfiguration) {
    FauxPC.toutes.push(this);
  }
  #transceiver(kind: string, track: unknown, direction: string) {
    const t = {
      sender: {
        track,
        debit: undefined as number | undefined,
        async replaceTrack(x: unknown) {
          t.sender.track = x;
        },
        getParameters: () => ({ encodings: [{}] as { maxBitrate?: number }[] }),
        async setParameters(p: unknown) {
          t.sender.debit = (p as { encodings: { maxBitrate?: number }[] }).encodings[0]?.maxBitrate;
        },
      },
      receiver: { track: { kind } },
      direction,
    };
    this.transceivers.push(t);
    return t;
  }
  addTransceiver(t: string | Piste, init: { direction: string }) {
    return this.#transceiver(typeof t === "string" ? t : t.kind, typeof t === "string" ? null : t, init.direction);
  }
  getTransceivers = () => this.transceivers;
  #sdp(role: string) {
    // Un SDP plus long qu'un morceau, avec un candidat d'hôte qui ne doit jamais partir.
    const lignes = ["v=0", `a=setup:${role}`, "a=fingerprint:sha-256 AA:BB", "m=audio 9 UDP/TLS/RTP/SAVPF 111", `a=${HOTE}`, `a=${RELAIS}`, "m=video 9 UDP/TLS/RTP/SAVPF 96"];
    for (let i = 0; lignes.join("\r\n").length < MORCEAU + 500; i++) lignes.push(`a=rtpmap:${i} codec/90000`);
    return lignes.join("\r\n") + "\r\n";
  }
  createOffer = async () => ({ type: "offer", sdp: this.#sdp("actpass") });
  createAnswer = async () => ({ type: "answer", sdp: this.#sdp("active") });
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.onicecandidate?.({ candidate: { candidate: HOTE, sdpMid: "0", sdpMLineIndex: 0 } });
    this.onicecandidate?.({ candidate: { candidate: RELAIS, sdpMid: "0", sdpMLineIndex: 0 } });
    this.onicecandidate?.({ candidate: null });
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === "offer") {
      this.#transceiver("audio", null, "recvonly");
      this.#transceiver("video", null, "recvonly");
    }
  }
  async addIceCandidate(c: RTCIceCandidateInit) {
    this.candidats.push(c);
  }
  close() {
    this.fermee = true;
  }
  etat(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

/** Salon de test : chaque message envoyé arrive chez tous les autres, comme par le serveur. */
class Monde {
  t = 1_000_000;
  minuteries: { a: number; f: () => void; morte: boolean }[] = [];
  appels = new Map<number, Appel>();
  envoyes: { de: number; m: MessageAppel }[] = [];
  pcs = new Map<number, FauxPC[]>();
  refuseMedia = new Set<number>();
  refuseRelais = new Set<number>();
  refuseFace = new Set<string>();
  moteurOccupe = false;
  /** Sièges dont plus rien ne sort (onglet fermé sans prévenir). */
  muets = new Set<number>();
  locaux = new Map<number, FauxFlux[]>();
  ids = new Map<number, number>();

  membre(siege: number): Appel {
    const d: DepsAppel = {
      moi: siege,
      envoyer: (m) => {
        if (this.moteurOccupe) return false;
        if (this.muets.has(siege)) return true;
        this.envoyes.push({ de: siege, m });
        for (const [s, a] of this.appels) if (s !== siege) a.recu(siege, m);
        return true;
      },
      relais: async () => {
        if (this.refuseRelais.has(siege)) throw new Error("reseau");
        return { urls: ["turn:turn.example:3478?transport=udp"], username: "1:00", credential: "x", ttlS: 60 };
      },
      media: async (o) => {
        if (this.refuseMedia.has(siege)) throw new Error("NotAllowedError");
        if (o.video && this.refuseFace.has(o.face)) throw new Error("OverconstrainedError");
        const f = new FauxFlux([...(o.audio ? [piste("audio")] : []), ...(o.video ? [piste("video", o.face)] : [])]);
        this.locaux.set(siege, [...(this.locaux.get(siege) ?? []), f]);
        return f as unknown as MediaStream;
      },
      pair: (c) => {
        const pc = new FauxPC(c);
        this.pcs.set(siege, [...(this.pcs.get(siege) ?? []), pc]);
        return pc as unknown as RTCPeerConnection;
      },
      flux: () => new FauxFlux() as unknown as MediaStream,
      alea: () => new Uint8Array(16).fill(this.ids.get(siege) ?? siege + 1),
      maintenant: () => this.t,
      plusTard: (ms, f) => {
        const m = { a: this.t + ms, f, morte: false };
        this.minuteries.push(m);
        return () => void (m.morte = true);
      },
      change: () => {},
    };
    const a = new Appel(d);
    this.appels.set(siege, a);
    return a;
  }
  /** Avance l'horloge en déclenchant les minuteries échues, dans l'ordre. */
  async avancer(ms: number) {
    const fin = this.t + ms;
    for (;;) {
      const m = this.minuteries.filter((x) => !x.morte && x.a <= fin).sort((x, y) => x.a - y.a)[0];
      if (!m) break;
      m.morte = true;
      this.t = Math.max(this.t, m.a);
      m.f();
      await pause();
    }
    this.t = fin;
    await pause();
  }
  pc(siege: number): FauxPC {
    const l = this.pcs.get(siege) ?? [];
    return l[l.length - 1]!;
  }
}
const pause = () => new Promise<void>((r) => setTimeout(r, 0));

describe("filtre des candidats", () => {
  it("ne garde que le relais, dans un SDP comme pour un candidat seul", () => {
    const sdp = filtrerSdp(`v=0\na=${HOTE}\r\na=candidate:3 1 udp 1 198.51.100.4 1 typ srflx raddr 10.0.0.1 rport 1\r\na=${RELAIS}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`);
    expect(sdp).toBe(`v=0\r\na=${RELAIS}\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`);
    expect(candidatRelais(RELAIS)).toBe(true);
    expect(candidatRelais(HOTE)).toBe(false);
    expect(candidatRelais("candidate:1 1 udp 1 10.0.0.1 1 typ relayed")).toBe(false);
    // « typ relay » glissé ailleurs dans la ligne : refusé (revue du 21 novembre).
    expect(candidatRelais("candidate:1 1 udp 1 10.0.0.5 9 typ host x typ relay")).toBe(false);
    expect(filtrerSdp("v=0\r\na=candidate:1 1 udp 1 10.0.0.5 9 typ host x typ relay\r\n")).toBe("v=0\r\n");
  });
});

describe("appel à deux", () => {
  it("le premier lance, le second voit l'appel et le rejoint ; le plus petit siège propose, tout passe par le relais", async () => {
    const w = new Monde();
    const a = w.membre(0);
    const b = w.membre(1);
    expect(a.etat).toBe("aucun");
    await a.rejoindre(false);
    expect(a.etat).toBe("dans");
    expect(b.etat).toBe("sonne");
    expect(b.participants.map((p) => p.siege)).toEqual([0]);
    expect(w.pcs.size).toBe(0); // personne à joindre : aucune connexion ouverte

    await b.rejoindre(true);
    await w.avancer(10_000);
    expect(b.etat).toBe("dans");
    expect(a.participants.map((p) => [p.siege, p.video])).toEqual([[1, true]]);
    expect(b.participants.map((p) => [p.siege, p.video])).toEqual([[0, false]]);

    // Une connexion de chaque côté, en mode relais seulement.
    expect(w.pcs.get(0)?.length).toBe(1);
    expect(w.pcs.get(1)?.length).toBe(1);
    for (const s of [0, 1]) {
      expect(w.pc(s).config.iceTransportPolicy).toBe("relay");
      expect(w.pc(s).config.iceServers?.[0]?.urls).toEqual(["turn:turn.example:3478?transport=udp"]);
    }
    // Le siège 0 a proposé, le siège 1 a répondu.
    expect(w.pc(0).localDescription?.type).toBe("offer");
    expect(w.pc(1).localDescription?.type).toBe("answer");
    expect(w.pc(1).remoteDescription?.type).toBe("offer");
    expect(w.pc(0).remoteDescription?.type).toBe("answer");
    // Offre et réponse en plusieurs morceaux, recollées à l'identique moins les candidats d'hôte.
    const offre = w.envoyes.filter((e) => e.de === 0 && e.m.k === "appel_signal" && e.m.sorte === "offre");
    expect(offre.length).toBeGreaterThan(1);
    expect(w.pc(1).remoteDescription?.sdp).toBe(filtrerSdp(w.pc(0).localDescription!.sdp));
    // Aucune adresse d'hôte n'a quitté un appareil, ni n'a été donnée à une connexion.
    for (const e of w.envoyes) if (e.m.k === "appel_signal") expect(e.m.x).not.toContain("192.168.1.20");
    for (const s of [0, 1]) {
      expect(w.pc(s).remoteDescription?.sdp).not.toContain("typ host");
      expect(w.pc(s).candidats.map((c) => c.candidate)).toEqual([RELAIS]);
    }
    // Les pistes locales sont envoyées : micro des deux côtés, caméra du siège 1 seulement.
    expect(w.pc(0).transceivers.map((t) => (t.sender.track as Piste | null)?.kind ?? null)).toEqual(["audio", null]);
    expect(w.pc(1).transceivers.map((t) => (t.sender.track as Piste | null)?.kind ?? null)).toEqual(["audio", "video"]);
    expect(w.pc(1).transceivers.every((t) => t.direction === "sendrecv")).toBe(true);

    // Connexion établie : débit vidéo borné.
    w.pc(0).etat("connected");
    await pause();
    expect(a.participants[0]?.lien).toBe("lie");
    expect(w.pc(0).transceivers[1]?.sender.debit).toBe(500_000);
  });

  it("raccrocher prévient l'autre, ferme la connexion et éteint micro et caméra", async () => {
    const w = new Monde();
    const a = w.membre(0);
    const b = w.membre(1);
    await a.rejoindre(true);
    await b.rejoindre(false);
    await w.avancer(5_000);
    const pistes = w.locaux.get(0)![0]!.getTracks();
    a.quitter();
    expect(a.etat).toBe("sonne"); // l'autre y est encore
    expect(pistes.every((p) => p.arretee)).toBe(true);
    expect(w.pc(0).fermee).toBe(true);
    expect(w.pc(1).fermee).toBe(true);
    expect(b.participants).toEqual([]);
    expect(b.etat).toBe("dans");
    b.quitter();
    expect(b.etat).toBe("aucun");
    expect(a.etat).toBe("aucun");
  });

  it("micro coupé : la piste reste mais n'envoie rien ; caméra : piste arrêtée puis redemandée", async () => {
    const w = new Monde();
    const a = w.membre(0);
    const b = w.membre(1);
    await a.rejoindre(true);
    await b.rejoindre(false);
    await w.avancer(5_000);
    a.basculerMicro();
    expect(a.micro).toBe(false);
    expect(w.locaux.get(0)![0]!.getAudioTracks()[0]!.enabled).toBe(false);
    const cam = w.locaux.get(0)![0]!.getVideoTracks()[0]!;
    await a.basculerCamera();
    expect(a.camera).toBe(false);
    expect(cam.arretee).toBe(true);
    expect(w.pc(0).transceivers[1]?.sender.track).toBe(null);
    await w.avancer(2_000);
    expect(b.participants[0]?.video).toBe(false);
    await a.basculerCamera();
    await w.avancer(2_000);
    expect(a.camera).toBe(true);
    expect((w.pc(0).transceivers[1]?.sender.track as Piste).kind).toBe("video");
    expect(b.participants[0]?.video).toBe(true);
  });
});

describe("appareils (ajouts du 21 novembre)", () => {
  async function deux() {
    const w = new Monde();
    const a = w.membre(0);
    const b = w.membre(1);
    await a.rejoindre(true);
    await b.rejoindre(false);
    await w.avancer(5_000);
    return { w, a, b };
  }

  it("retourner la caméra : de face puis de dos, l'ancienne image arrêtée, la nouvelle envoyée", async () => {
    const { w, a } = await deux();
    const avant = w.locaux.get(0)![0]!.getVideoTracks()[0]!;
    expect([a.face, avant.face]).toEqual(["user", "user"]);
    await a.retournerCamera();
    const apres = w.locaux.get(0)![0]!.getVideoTracks()[0]!;
    expect(a.face).toBe("environment");
    expect(apres.face).toBe("environment");
    expect(avant.arretee).toBe(true);
    expect(w.locaux.get(0)![0]!.getVideoTracks()).toHaveLength(1);
    expect(w.pc(0).transceivers[1]?.sender.track).toBe(apres);
    // La caméra rallumée plus tard reprend le même côté.
    await a.basculerCamera();
    await a.basculerCamera();
    expect(w.locaux.get(0)![0]!.getVideoTracks()[0]!.face).toBe("environment");
  });

  it("autre caméra absente ou refusée, ou caméra éteinte : rien ne change", async () => {
    const { w, a } = await deux();
    const cam = w.locaux.get(0)![0]!.getVideoTracks()[0]!;
    w.refuseFace.add("environment");
    await a.retournerCamera();
    expect(a.face).toBe("user");
    expect(cam.arretee).toBe(false);
    expect(w.pc(0).transceivers[1]?.sender.track).toBe(cam);
    w.refuseFace.clear();
    await a.basculerCamera();
    const demandes = w.locaux.get(0)!.length;
    await a.retournerCamera();
    expect(w.locaux.get(0)!.length).toBe(demandes);
    expect(a.face).toBe("user");
  });

  it("caméra arrêtée d'elle-même : l'appel continue en audio et l'autre le sait", async () => {
    const { w, a, b } = await deux();
    const cam = w.locaux.get(0)![0]!.getVideoTracks()[0]!;
    cam.onended?.();
    await w.avancer(2_000);
    expect(a.etat).toBe("dans");
    expect(a.camera).toBe(false);
    expect(w.pc(0).transceivers[1]?.sender.track).toBe(null);
    expect(b.participants[0]?.video).toBe(false);
  });

  it("micro arrêté de lui-même : on quitte l'appel en le disant, tout est éteint", async () => {
    const { w, a, b } = await deux();
    const pistes = w.locaux.get(0)![0]!.getTracks();
    pistes.find((p) => p.kind === "audio")!.onended?.();
    expect([a.etat, a.erreur]).toEqual(["sonne", "perdu"]);
    expect(pistes.every((p) => p.arretee)).toBe(true);
    expect(w.envoyes.some((e) => e.de === 0 && e.m.k === "appel_fin")).toBe(true);
    expect(b.participants).toEqual([]);
  });

  it("une piste arrêtée par nous (raccrocher) ne déclenche rien après coup", async () => {
    const { w, a } = await deux();
    const pistes = w.locaux.get(0)![0]!.getTracks();
    a.quitter();
    expect(pistes.every((p) => p.onended === null)).toBe(true);
    expect(a.erreur).toBe(null);
  });
});

describe("cas limites", () => {
  it("micro refusé ou relais indisponible : pas d'appel, rien ne reste allumé", async () => {
    const w = new Monde();
    const a = w.membre(0);
    w.refuseMedia.add(0);
    await a.rejoindre(false);
    expect([a.etat, a.erreur]).toEqual(["aucun", "micro"]);
    w.refuseMedia.clear();
    w.refuseRelais.add(0);
    await a.rejoindre(true);
    expect([a.etat, a.erreur]).toEqual(["aucun", "relais"]);
    expect(w.locaux.get(0)![0]!.getTracks().every((p) => p.arretee)).toBe(true);
    expect(w.envoyes).toEqual([]);
  });

  it("deux appels lancés en même temps : tous se rallient au plus petit identifiant", async () => {
    const w = new Monde();
    const a = w.membre(0);
    const b = w.membre(1);
    w.ids.set(0, 9);
    w.ids.set(1, 3);
    // Aucun des deux n'a encore entendu l'autre.
    w.appels.delete(1);
    await a.rejoindre(false);
    w.appels.delete(0);
    w.appels.set(1, b);
    await b.rejoindre(false);
    w.appels.set(0, a);
    await w.avancer(20_000);
    expect(a.participants.map((p) => p.siege)).toEqual([1]);
    expect(b.participants.map((p) => p.siege)).toEqual([0]);
    const presences = w.envoyes.filter((e) => e.m.k === "appel_present").slice(-2);
    expect(presences.map((e) => e.m.appel[0])).toEqual([3, 3]);
    expect(w.pc(0).remoteDescription?.type).toBe("answer");
  });

  it("une offre d'un siège plus grand, un signal pour un autre siège ou d'un autre appel sont ignorés", async () => {
    const w = new Monde();
    const a = w.membre(0);
    await a.rejoindre(false);
    const id = (w.envoyes[0]!.m as { appel: Uint8Array }).appel;
    a.recu(4, { k: "appel_present", appel: id, video: false });
    await pause();
    const avant = w.pcs.get(0)!.length; // le siège 0 a proposé au siège 4
    a.recu(4, { k: "appel_signal", appel: id, pour: 0, sorte: "offre", i: 0, n: 1, x: "v=0\r\n" });
    a.recu(4, { k: "appel_signal", appel: id, pour: 2, sorte: "reponse", i: 0, n: 1, x: "v=0\r\n" });
    a.recu(4, { k: "appel_signal", appel: new Uint8Array(16).fill(7), pour: 0, sorte: "reponse", i: 0, n: 1, x: "v=0\r\n" });
    a.recu(7, { k: "appel_signal", appel: id, pour: 0, sorte: "reponse", i: 0, n: 1, x: "v=0\r\n" }); // siège hors de l'appel
    // Morceaux dans le désordre : jetés.
    a.recu(4, { k: "appel_signal", appel: id, pour: 0, sorte: "reponse", i: 1, n: 2, x: "b" });
    // Candidat qui n'est pas du relais, ou mal formé : jeté.
    a.recu(4, { k: "appel_signal", appel: id, pour: 0, sorte: "glace", i: 0, n: 1, x: JSON.stringify({ c: HOTE, m: "0", l: 0 }) });
    a.recu(4, { k: "appel_signal", appel: id, pour: 0, sorte: "glace", i: 0, n: 1, x: "{" });
    await pause();
    expect(w.pcs.get(0)!.length).toBe(avant);
    expect(w.pc(0).remoteDescription).toBe(null);
    expect(w.pc(0).candidats).toEqual([]);
  });

  it("un siège qui quitte le salon ou en est exclu est coupé aussitôt ; un participant muet est retiré", async () => {
    const w = new Monde();
    const a = w.membre(0);
    const b = w.membre(1);
    const c = w.membre(2);
    await a.rejoindre(false);
    await b.rejoindre(false);
    await c.rejoindre(false);
    await w.avancer(10_000);
    expect(a.participants.map((p) => p.siege)).toEqual([1, 2]);
    const versB = w.pcs.get(0)![0]!;
    a.parti(1);
    expect(versB.fermee).toBe(true);
    expect(a.participants.map((p) => p.siege)).toEqual([2]);
    // Le siège 2 se tait (onglet fermé sans prévenir) : retiré après le délai.
    w.muets.add(2);
    await w.avancer(PRESENCE_PERDUE_MS + 6_000);
    expect(a.participants.map((p) => p.siege)).toEqual([1]); // le siège 1, toujours là, s'est redit
    expect(w.pcs.get(0)!.find((p) => !p.fermee && p !== versB)).toBeDefined();
  });

  it("appel complet à 6 : le septième est refusé sans rien allumer", async () => {
    const w = new Monde();
    const a = w.membre(9);
    const id = new Uint8Array(16).fill(1);
    for (let s = 0; s < APPEL_MAX - 1; s++) a.recu(s, { k: "appel_present", appel: id, video: false });
    await a.rejoindre(true);
    expect([a.etat, a.erreur]).toEqual(["sonne", "complet"]);
    expect(w.locaux.size).toBe(0);
  });

  it("connexion perdue : le plus petit siège propose de nouveau, trois fois vite, puis au rythme des présences", async () => {
    const w = new Monde();
    const a = w.membre(0);
    const b = w.membre(1);
    await a.rejoindre(false);
    await b.rejoindre(false);
    await w.avancer(3_000);
    for (let i = 0; i < 4; i++) {
      w.pc(0).etat("failed");
      await w.avancer(2_500);
    }
    expect(w.pcs.get(0)!.length).toBe(4); // la première et trois reprises rapides
    // Ensuite : une reprise à chaque présence redite par l'autre, pas plus souvent.
    await w.avancer(20_000);
    expect(w.pcs.get(0)!.length).toBe(5);
    expect(b.etat).toBe("dans");
  });

  it("moteur occupé : les messages attendent, dans l'ordre, sans dépasser la cadence du serveur", async () => {
    const w = new Monde();
    const a = w.membre(0);
    w.moteurOccupe = true;
    await a.rejoindre(false);
    expect(w.envoyes).toEqual([]);
    w.moteurOccupe = false;
    await w.avancer(1_000);
    expect(w.envoyes.map((e) => e.m.k)).toEqual(["appel_present"]);
    // Cinq arrivées d'un coup : plus de messages que la rafale permise, étalés ensuite.
    const id = (w.envoyes[0]!.m as { appel: Uint8Array }).appel;
    for (let s = 1; s <= 5; s++) a.recu(s, { k: "appel_present", appel: id, video: false });
    await pause();
    await pause();
    expect(w.envoyes.length).toBeLessThanOrEqual(13);
    await w.avancer(30_000);
    const offres = w.envoyes.filter((e) => e.m.k === "appel_signal" && e.m.sorte === "offre" && e.m.i === 0);
    expect(offres.map((e) => (e.m as { pour: number }).pour).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("membre malveillant (revue du 21 novembre)", () => {
  /** Monde à trois en appel et connectés : A (0), V (1), H (2). */
  async function aTrois() {
    const w = new Monde();
    const a = w.membre(0);
    const v = w.membre(1);
    const h = w.membre(2);
    await a.rejoindre(false);
    await v.rejoindre(false);
    await h.rejoindre(false);
    await w.avancer(5_000);
    for (const l of w.pcs.values()) for (const pc of l) if (!pc.fermee) pc.etat("connected");
    await pause();
    return { w, a, v, h };
  }

  it("offres en boucle d'un plus petit siège : la connexion établie n'est pas refaite, la victime reste dans l'appel", async () => {
    const { w, v, h } = await aTrois();
    const id = (w.envoyes.find((e) => e.m.k === "appel_present")!.m as { appel: Uint8Array }).appel;
    const avant = w.pcs.get(1)!.length;
    const offre = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
    for (let i = 0; i < 120; i++) {
      v.recu(0, { k: "appel_signal", appel: id, pour: 1, sorte: "offre", i: 0, n: 1, x: offre });
      await w.avancer(500);
    }
    expect(w.pcs.get(1)!.length).toBe(avant);
    expect(h.participants.map((p) => p.siege)).toContain(1);
    // La présence de V est partie régulièrement malgré l'attaque.
    const presences = w.envoyes.filter((e) => e.de === 1 && e.m.k === "appel_present").length;
    expect(presences).toBeGreaterThanOrEqual(4);
  }, 20_000);

  it("identifiants d'appel toujours plus petits : aucune connexion démontée", async () => {
    const { w, a } = await aTrois();
    const ouvertes = () => [...w.pcs.values()].flat().filter((p) => !p.fermee).length;
    const avant = ouvertes();
    await w.avancer(11_000);
    for (let i = 0; i < 60; i++) {
      const id = new Uint8Array(16);
      id[15] = 59 - i; // toujours plus petit
      a.recu(5, { k: "appel_present", appel: id, video: false });
      await w.avancer(500);
    }
    expect(ouvertes()).toBe(avant);
  }, 20_000);

  it("offre piégée (749 lignes m=) : refusée, aucune connexion créée", async () => {
    const w = new Monde();
    const v = w.membre(1);
    await v.rejoindre(false);
    const id = (w.envoyes[0]!.m as { appel: Uint8Array }).appel;
    v.recu(0, { k: "appel_present", appel: id, video: false });
    const avant = w.pcs.get(1)?.length ?? 0;
    const x = Array.from({ length: 300 }, () => "m=video 9 UDP/TLS/RTP/SAVPF 96").join("\r\n");
    const n = Math.ceil(x.length / 3000);
    for (let i = 0; i < n; i++) v.recu(0, { k: "appel_signal", appel: id, pour: 1, sorte: "offre", i, n, x: x.slice(i * 3000, (i + 1) * 3000) });
    await pause();
    expect(w.pcs.get(1)?.length ?? 0).toBe(avant);
  });
});

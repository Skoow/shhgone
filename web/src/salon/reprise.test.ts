// Salons persistants (conception du salon v3 §5.2) : reprise côté client après un redémarrage du
// serveur. Le serveur arrêté ferme le WebSocket en 1001 ; s'il a retrouvé le salon, le client
// revient avec son jeton et son dernier rang, sans `rejoindre` ni nouvel état MLS (même groupe,
// aucune refondation). Repli gardé pour un salon réellement perdu : 4004 → `rejoindre` → nouvel
// état MLS (le créateur refondra le groupe). Faux WebSocket, fausse horloge, faux moteur : seul
// le client (client.ts) est éprouvé ici ; le parcours réel est dans e2e/salon-reprise.test.ts.
import { describe, expect, it } from "vitest";
import { ClientSalon, type Deps, type EvClient, type Horloge, type WsLike } from "./client";
import type { Entree } from "./api";
import type { ClesSalon, SalonEngine } from "./engine";

const JETON = "A".repeat(43);
const NONCE0 = new Uint8Array(16).fill(1);
const NONCE1 = new Uint8Array(16).fill(2);

class FauxWS implements WsLike {
  binaryType = "";
  readyState = 0;
  envoyes: Uint8Array[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(b: Uint8Array): void {
    this.envoyes.push(b.slice());
  }
  close(): void {
    this.readyState = 3;
  }
  ouvrir(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  recevoir(b: Uint8Array): void {
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
  fermer(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Horloge à la main : chaque minuterie est gardée, déclenchée par `tout()`. */
function horloge() {
  const attentes: (() => void)[] = [];
  const h: Horloge = {
    maintenant: () => 0,
    plus_tard: (_ms, f) => {
      attentes.push(f);
      return () => attentes.splice(attentes.indexOf(f) >>> 0, 1);
    },
  };
  return { h, tout: () => attentes.splice(0).forEach((f) => f()) };
}

function u64(b: Uint8Array, o: number, v: number): void {
  new DataView(b.buffer).setBigUint64(o, BigInt(v));
}

/** 0x0D au rang seq : créateur 0, sièges et nonces, dernière connexion 0. */
function liste(seq: number, sieges: [number, Uint8Array][]): Uint8Array {
  const b = new Uint8Array(11 + 25 * sieges.length);
  b[0] = 0x0d;
  u64(b, 1, seq);
  b[10] = sieges.length;
  sieges.forEach(([s, n], i) => {
    b[11 + 25 * i] = s;
    b.set(n, 12 + 25 * i);
  });
  return b;
}

/** 0x01 au rang seq : siège, heure, trame (4 140 octets). */
function trame(seq: number, siege: number): Uint8Array {
  const b = new Uint8Array(9 + 1 + 8 + 4140);
  b[0] = 0x01;
  u64(b, 1, seq);
  b[9] = siege;
  return b;
}

function pong(p: Uint8Array): Uint8Array {
  const b = new Uint8Array(17);
  b[0] = 0x08;
  b.set(p, 9);
  return b;
}

/** Faux moteur : un Salon déjà dans le groupe (époque 3) ou hors du groupe (nouvelle entrée). */
function moteur() {
  const crees: { siege: number; fonder: boolean }[] = [];
  const recues: number[] = [];
  const eng = {
    Salon: {
      creer(siege: number, _nonce: Uint8Array, _c: ClesSalon, fonder: boolean) {
        const dansLeGroupe = crees.length === 0; // le premier : déjà membre du groupe
        crees.push({ siege, fonder });
        return {
          annoncer() {},
          remplacerAnnonces() {},
          marquerParti() {},
          marquerExclu() {},
          aRetirer: () => [],
          membres: () => (dansLeGroupe ? [0, 1] : []),
          epoque: () => (dansLeGroupe ? 3 : undefined),
          keyPackage: () => {
            throw new Error("commit_en_cours");
          },
          recevoirTrame(_c: ClesSalon, _t: Uint8Array, seq: number) {
            recues.push(seq);
            return { type: "ignore" };
          },
          empreinte: () => "",
          free() {},
        };
      },
    },
    lireEnTete: () => ({ volatile: false, regle: 0 }),
    cleAcces: () => ({ k: new Uint8Array(32), v: new Uint8Array(32) }),
    jetonGestion: () => new Uint8Array(32),
  } as unknown as SalonEngine;
  return { eng, crees, recues };
}

const cles = { kPreuve: () => new Uint8Array(32), free() {} } as unknown as ClesSalon;
const entree: Entree = { jeton: JETON, siege: 1, seq: 2, nonce: NONCE1, expiresInS: 3600, maxMembers: 4, membersCanDestroy: false, budgetLeft: 0, appels: false };

function banc(rejoindre?: () => Response) {
  const { h, tout } = horloge();
  const sockets: FauxWS[] = [];
  const appels: string[] = [];
  const m = moteur();
  const deps: Deps = {
    net: {
      origin: "https://shhgone.test",
      fetch: (async (url: string) => {
        appels.push(String(url));
        if (!rejoindre) throw new Error("aucun appel attendu");
        return rejoindre();
      }) as typeof fetch,
    },
    eng: m.eng,
    ouvrirWS: () => {
      const ws = new FauxWS();
      sockets.push(ws);
      return ws;
    },
    horloge: h,
    alea: (n) => new Uint8Array(n).fill(7),
  };
  const c = ClientSalon.ouvrir(deps, { kLien: new Uint8Array(32), cles }, entree);
  const evs: EvClient[] = [];
  c.ecouter((e) => evs.push(e));
  return { c, sockets, appels, m, evs, tout };
}

/** depuis de l'accueil (51 octets) envoyé sur ce WebSocket. */
function depuis(ws: FauxWS): bigint {
  const a = ws.envoyes[0]!;
  expect(a.length).toBe(51);
  return new DataView(a.buffer, a.byteOffset).getBigUint64(43);
}

/** Accueil du serveur au rang seq, puis pong du ping de fin de rattrapage. */
function accueillir(ws: FauxWS, seq: number): void {
  ws.recevoir(liste(seq, [[0, NONCE0], [1, NONCE1]]));
  const p = ws.envoyes.find((b) => b[0] === 0x04);
  expect(p).toBeDefined();
  ws.recevoir(pong(p!.slice(1)));
}

describe("reprise après un redémarrage du serveur", () => {
  it("salon retrouvé : même jeton, depuis = dernier rang, même groupe, aucun rejoindre", () => {
    const b = banc();
    const ws1 = b.sockets[0]!;
    ws1.ouvrir();
    expect(depuis(ws1)).toBe(2n);
    accueillir(ws1, 2);
    ws1.recevoir(trame(3, 0));
    ws1.recevoir(trame(4, 0));
    expect(b.m.recues).toEqual([3, 4]);
    // Arrêt du serveur : 1001, reconnexion planifiée.
    ws1.fermer(1001);
    b.tout();
    const ws2 = b.sockets[1]!;
    expect(ws2).toBeDefined();
    ws2.ouvrir();
    expect(new TextDecoder().decode(ws2.envoyes[0]!.slice(0, 43))).toBe(JETON);
    expect(depuis(ws2)).toBe(4n);
    accueillir(ws2, 4);
    ws2.recevoir(trame(5, 0)); // historique d'après la coupure, puis direct
    expect(b.m.recues).toEqual([3, 4, 5]);
    expect(b.appels).toEqual([]); // aucun rejoindre
    expect(b.m.crees).toHaveLength(1); // aucun nouvel état MLS : même groupe, pas de refondation
    expect(b.c.dansLeGroupe()).toBe(true);
    expect(b.evs.some((e) => e.k === "nouvelleEntree")).toBe(false);
    expect(b.c.siege).toBe(1);
  });

  it("salon perdu (4004) : repli par rejoindre et nouvel état MLS", async () => {
    const nouveau = "B".repeat(43);
    const corps = { member_token: nouveau, seat: 2, seq: 1, nonce_arrivee: btoa(String.fromCharCode(...new Uint8Array(16).fill(3))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), expires_in_s: 3600, max_members: 4, members_can_destroy: false, budget_left: 0 };
    const b = banc(() => new Response(JSON.stringify(corps), { status: 200, headers: { "Content-Type": "application/json" } }));
    const ws1 = b.sockets[0]!;
    ws1.ouvrir();
    accueillir(ws1, 2);
    ws1.fermer(4004);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(b.appels.some((u) => u.endsWith("/api/salons/rejoindre"))).toBe(true);
    expect(b.m.crees).toHaveLength(2);
    expect(b.m.crees[1]).toEqual({ siege: 2, fonder: false });
    expect(b.evs.some((e) => e.k === "nouvelleEntree")).toBe(true);
    const ws2 = b.sockets[1]!;
    ws2.ouvrir();
    expect(new TextDecoder().decode(ws2.envoyes[0]!.slice(0, 43))).toBe(nouveau);
    expect(depuis(ws2)).toBe(1n);
  });
});

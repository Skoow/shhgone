// Client de PRODUCTION du salon (web/src/salon/client.ts, plan C-3 Task 3) contre le vrai binaire
// Go (SHH_SALONS=1) et le vrai module du salon, sous Node : création (preparer), entrée, trois
// membres qui échangent des messages chiffrés dans les deux sens, accusés, reconnexion avec
// `depuis` sans perte ni doublon, reprise (nouvelle identité au même siège), départ. Les
// parcours par l'interface, dans de vrais navigateurs : web/ui-e2e/salon.spec.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passwordKey, generatePassword } from "../src/engine";
import { loadSalonEngine, type SalonEngine } from "../src/salon/engine";
import { ClientSalon, type EvClient, type WsLike } from "../src/salon/client";
import { preparer } from "../src/salon/creation";
import * as api from "../src/salon/api";
import { envoyerPiece, lirePiece } from "../src/salon/pieces";
import { exclure } from "../src/salon/exclusion";
import { solveAltcha } from "./altcha";
import { startServer, type TestServer } from "./server";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Membre = { c: ClientSalon; evs: EvClient[]; ws: () => WsLike | undefined };

function deps(srv: TestServer, eng: SalonEngine, garde: { ws?: WsLike }) {
  return {
    net: { origin: srv.origin, fetch: (...a: Parameters<typeof fetch>) => fetch(...a) },
    eng,
    ouvrirWS: (url: string) => {
      const ws = new WebSocket(url, { headers: { Origin: srv.origin } } as never) as unknown as WsLike;
      garde.ws = ws;
      return ws;
    },
  };
}

async function attendre(m: Membre, pred: (e: EvClient) => boolean, ms = 30_000): Promise<EvClient> {
  const fin = Date.now() + ms;
  for (;;) {
    const e = m.evs.find(pred);
    if (e) return e;
    if (Date.now() > fin) throw new Error(`attente dépassée (siège ${m.c.siege}) : ${JSON.stringify(m.evs.map((x) => x.k))}`);
    await dormir(20);
  }
}
const texteRecu = (x: string) => (e: EvClient) => e.k === "message" && e.enveloppe.message.k === "texte" && e.enveloppe.message.x === x;

describe("salon : client de production, vrai serveur", () => {
  let srv: TestServer;
  let eng: SalonEngine;
  const membres: Membre[] = [];
  let kLien: Uint8Array;
  let mdp: string;

  beforeAll(async () => {
    srv = await startServer({ salons: true });
    eng = await loadSalonEngine();
  });
  afterAll(async () => {
    for (const m of membres) m.c.fermer();
    await srv?.dispose();
  });

  async function membre(o: { kLien: Uint8Array; mdp: string; sGestion?: Uint8Array; creerGroupe?: boolean; cles?: ReturnType<SalonEngine["clesSalon"]> }): Promise<Membre> {
    let cles = o.cles;
    if (!cles) {
      const acces = eng.cleAcces(o.kLien);
      const meta = await api.meta({ origin: srv.origin, fetch }, acces.k);
      const kMdp = await passwordKey(o.mdp, meta.salt, { ops: meta.kdfOps, mem: meta.kdfMem });
      cles = eng.clesSalon(o.kLien, kMdp);
      kMdp.fill(0);
    }
    const garde: { ws?: WsLike } = {};
    const evs: EvClient[] = [];
    const { client } = await ClientSalon.entrer(deps(srv, eng, garde), { kLien: o.kLien, cles, sGestion: o.sGestion, creerGroupe: o.creerGroupe });
    client.ecouter((e) => evs.push(e));
    const m = { c: client, evs, ws: () => garde.ws };
    membres.push(m);
    return m;
  }

  it("création, puis deux invités ajoutés au groupe, messages dans tous les sens", async () => {
    mdp = generatePassword();
    const p = await preparer(eng, mdp, { ttlHours: 1, maxMembers: 4, membersCanDestroy: false });
    kLien = p.kLien.slice();
    secret.sGestion = p.sGestion.slice();
    const cap = await (await fetch(srv.origin + "/api/captcha")).json();
    const recu = Date.now();
    const { shown_at, fallback: _f, ...defi } = cap;
    const preuve = await solveAltcha(defi);
    await dormir(Math.max(0, recu + 3100 - Date.now()));
    const r = await fetch(srv.origin + "/api/salons", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shh-Access": p.entetes.acces, "X-Shh-Manage": p.entetes.gestion },
      body: JSON.stringify({ ...p.corps, altcha: (preuve as { payload: string }).payload, hp: "", shown_at }),
    });
    expect(r.status).toBe(201);
    const a = await membre({ kLien, mdp, sGestion: p.sGestion, creerGroupe: true, cles: p.cles });
    expect(a.c.siege).toBe(0);
    await attendre(a, (e) => e.k === "connexion" && e.etat === "ouvert");
    const b = await membre({ kLien, mdp });
    expect(b.c.siege).toBe(1);
    await attendre(b, (e) => e.k === "groupe" && e.dansLeGroupe);
    const c = await membre({ kLien, mdp });
    await attendre(c, (e) => e.k === "groupe" && e.dansLeGroupe);
    for (const m of [a, b, c]) {
      const deadline = Date.now() + 20_000;
      while (JSON.stringify(m.c.membres()) !== "[0,1,2]") {
        if (Date.now() > deadline) throw new Error(`membres ${JSON.stringify(m.c.membres())}`);
        await dormir(20);
      }
    }
    const l = a.c.envoyer({ k: "texte", x: "bonjour de A" }, 2);
    const acc = (await attendre(a, (e) => e.k === "accepte" && e.local === l)) as Extract<EvClient, { k: "accepte" }>;
    expect(acc.seq).toBeGreaterThan(0);
    const mb = (await attendre(b, texteRecu("bonjour de A"))) as Extract<EvClient, { k: "message" }>;
    expect(mb.siege).toBe(0);
    expect(mb.seq).toBe(acc.seq);
    await attendre(c, texteRecu("bonjour de A"));
    b.c.envoyer({ k: "texte", x: "réponse de B" }, 2);
    c.c.envoyer({ k: "reaction", cible: mb.enveloppe.id, emoji: "👍" }, 2);
    await attendre(a, texteRecu("réponse de B"));
    await attendre(a, (e) => e.k === "message" && e.enveloppe.message.k === "reaction");
    // Accusés groupés (2,5 s) : « vu » de B chez A.
    b.c.accuser("vu", [mb.enveloppe.id]);
    await attendre(a, (e) => e.k === "message" && e.enveloppe.message.k === "vu" && e.siege === 1, 10_000);
  });

  it("pièce (plan C-4) : fichier chiffré par le moteur, lié à sa trame, relu octet pour octet ; vocal", async () => {
    const [a, b] = membres;
    const net = { origin: srv.origin, fetch: (...x: Parameters<typeof fetch>) => fetch(...x) };
    // 70 000 octets : deux morceaux, palier 16 ; nom et type dans le message chiffré seulement.
    const contenu = new Uint8Array(70_000);
    for (let i = 0; i < contenu.length; i += 65536) crypto.getRandomValues(contenu.subarray(i, Math.min(contenu.length, i + 65536)));
    const ref = await envoyerPiece(net, a!.c.jeton, new Blob([contenu]), { nom: "rapport.pdf", mime: "application/pdf", vocal: false });
    expect(ref.palier).toBe(16);
    a!.c.envoyer({ k: "piece", r: ref.r, piece: ref.piece, palier: ref.palier, nom: "rapport.pdf", mime: "application/pdf", taille: contenu.length, sorte: "fichier", dureeMs: null }, 0, ref.piece);
    const m = (await attendre(b!, (e) => e.k === "message" && e.enveloppe.message.k === "piece")) as Extract<EvClient, { k: "message" }>;
    const p = m.enveloppe.message as Extract<typeof m.enveloppe.message, { k: "piece" }>;
    expect(p.nom).toBe("rapport.pdf");
    const lu = new Uint8Array(await (await lirePiece(net, b!.c.jeton, p)).arrayBuffer());
    expect(lu).toEqual(contenu);
    // Vocal : le plus petit vocal non vide prend le palier 16 (1 048 880 o) ; la réserve de départ
    // d'un participant (décision du 19 novembre) le fait passer tout de suite, sans attendre.
    const voix = new Uint8Array(4000).fill(7);
    const rv = await envoyerPiece(net, a!.c.jeton, new Blob([voix]), { nom: "vocal.webm", mime: "audio/webm", vocal: true });
    expect(rv.palier).toBe(16);
    expect(new Uint8Array(await (await lirePiece(net, b!.c.jeton, rv)).arrayBuffer())).toEqual(voix);
    // Le second, aussitôt : la réserve est vide, 429 avec le délai (au rythme d'une voix).
    const e = await envoyerPiece(net, a!.c.jeton, new Blob([voix]), { nom: "vocal.webm", mime: "audio/webm", vocal: true }).catch((x) => x);
    expect(e).toMatchObject({ status: 429, code: "limit" });
  });

  it("reconnexion : rattrapage avec `depuis`, ni perte ni doublon", async () => {
    const [a, b] = membres;
    b!.ws()!.close(1000);
    await dormir(100);
    for (let i = 0; i < 5; i++) a!.c.envoyer({ k: "texte", x: `pendant la coupure ${i}` }, 2);
    for (let i = 0; i < 5; i++) await attendre(b!, texteRecu(`pendant la coupure ${i}`), 40_000);
    for (let i = 0; i < 5; i++) expect(b!.evs.filter(texteRecu(`pendant la coupure ${i}`))).toHaveLength(1);
  });

  it("départ : le siège parti est retiré du groupe, l'envoi continue", async () => {
    const [a, b, c] = membres;
    c!.c.quitter();
    await attendre(a!, (e) => e.k === "depart" && e.siege === 2);
    a!.c.envoyer({ k: "texte", x: "après le départ" }, 2);
    await attendre(b!, texteRecu("après le départ"), 40_000);
    expect(a!.c.membres()).toEqual([0, 1]);
  });

  it("créateur revenu sur un autre appareil : l'ancien est délogé (4005, sans reconnexion), le rôle est rendu", async () => {
    const [a, b] = membres;
    const sGestion = (a!.c as unknown as { jetonGestion(): Uint8Array | null }).jetonGestion();
    expect(sGestion).not.toBeNull(); // le client garde S_gestion (le jeton en est tiré à la demande)
    sGestion!.fill(0);
    // S_gestion est celui de la création : relu depuis la préparation gardée par le test.
    const a2 = await membre({ kLien, mdp, sGestion: secret.sGestion });
    expect(a2.c.siege).toBe(0);
    await attendre(a!, (e) => e.k === "fin" && e.raison === "remplace");
    await attendre(b!, (e) => e.k === "membres" && e.createurRevenu, 30_000);
    await attendre(a2, (e) => e.k === "groupe" && e.dansLeGroupe, 30_000);
    a2.c.envoyer({ k: "texte", x: "de retour" }, 2);
    await attendre(b!, texteRecu("de retour"), 30_000);
    await dormir(1500);
    expect(a!.c.fini).toBe(true);
  });
});

describe("salon : renouvellement (exigence C-3 22)", () => {
  let srv: TestServer;
  let eng: SalonEngine;
  const fermer: ClientSalon[] = [];
  beforeAll(async () => {
    srv = await startServer({ salons: true });
    eng = await loadSalonEngine();
  });
  afterAll(async () => {
    for (const c of fermer) c.fermer();
    await srv?.dispose();
  });

  async function preuve() {
    const cap = await (await fetch(srv.origin + "/api/captcha")).json();
    const recu = Date.now();
    const { shown_at, fallback: _f, ...defi } = cap;
    const p = await solveAltcha(defi);
    await dormir(Math.max(0, recu + 3100 - Date.now()));
    return { altcha: (p as { payload: string }).payload, hp: "" as const, shown_at };
  }

  it("le créateur renouvelle : tout est effacé, le groupe MLS est recréé, la conversation reprend", async () => {
    const mdp = generatePassword();
    const p = await preparer(eng, mdp, { ttlHours: 1, maxMembers: 4, membersCanDestroy: false });
    const r = await fetch(srv.origin + "/api/salons", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shh-Access": p.entetes.acces, "X-Shh-Manage": p.entetes.gestion },
      body: JSON.stringify({ ...p.corps, ...(await preuve()) }),
    });
    expect(r.status).toBe(201);
    const net = { origin: srv.origin, fetch: (...x: Parameters<typeof fetch>) => fetch(...x) };
    const mk = async (o: { cles: ReturnType<SalonEngine["clesSalon"]>; sGestion?: Uint8Array; creerGroupe?: boolean }) => {
      const evs: EvClient[] = [];
      const garde: { ws?: WsLike } = {};
      const { client } = await ClientSalon.entrer(deps(srv, eng, garde), { kLien: p.kLien, ...o });
      client.ecouter((e) => evs.push(e));
      fermer.push(client);
      return { c: client, evs, ws: () => garde.ws };
    };
    const a = await mk({ cles: p.cles, sGestion: p.sGestion, creerGroupe: true });
    const acces = eng.cleAcces(p.kLien);
    const meta = await api.meta(net, acces.k);
    const kMdp = await passwordKey(mdp, meta.salt, { ops: meta.kdfOps, mem: meta.kdfMem });
    const b = await mk({ cles: eng.clesSalon(p.kLien, kMdp) });
    await attendre(b, (e) => e.k === "groupe" && e.dansLeGroupe);
    a.c.envoyer({ k: "texte", x: "avant" }, 2);
    await attendre(b, texteRecu("avant"));
    const codeA = b.c.empreinte(0);
    const j = a.c.jetonGestion()!;
    const reg = await api.reglages(net, j, { renouvelerH: 6, preuve: await preuve() });
    j.fill(0);
    expect(reg.depuis).toBeGreaterThan(0);
    await attendre(a, (e) => e.k === "renouvellement");
    await attendre(b, (e) => e.k === "renouvellement");
    // B rentre dans le groupe neuf ; le code du créateur ne change pas (clé de rôle).
    const fin = Date.now() + 30_000;
    while (JSON.stringify(b.c.membres()) !== "[0,1]") {
      if (Date.now() > fin) throw new Error(`membres ${JSON.stringify(b.c.membres())}`);
      await dormir(20);
    }
    expect(b.c.empreinte(0)).toBe(codeA);
    a.c.envoyer({ k: "texte", x: "après le renouvellement" }, 2);
    await attendre(b, texteRecu("après le renouvellement"), 30_000);
  });
});

describe("salon : exclusion et nouvelle invitation (exigences 24, 25)", () => {
  let srv: TestServer;
  let eng: SalonEngine;
  const fermer: ClientSalon[] = [];
  beforeAll(async () => {
    srv = await startServer({ salons: true });
    eng = await loadSalonEngine();
  });
  afterAll(async () => {
    for (const c of fermer) c.fermer();
    await srv?.dispose();
  });

  it("le créateur exclut C : C ne reçoit plus rien, le groupe est refondé, l'ancienne invitation est morte, la nouvelle fait entrer", async () => {
    const net = { origin: srv.origin, fetch: (...x: Parameters<typeof fetch>) => fetch(...x) };
    const mdp = generatePassword();
    const p = await preparer(eng, mdp, { ttlHours: 1, maxMembers: 5, membersCanDestroy: false });
    const cap = await (await fetch(srv.origin + "/api/captcha")).json();
    const recu = Date.now();
    const { shown_at, fallback: _f, ...defi } = cap;
    const pv = await solveAltcha(defi);
    await dormir(Math.max(0, recu + 3100 - Date.now()));
    const rc = await fetch(srv.origin + "/api/salons", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shh-Access": p.entetes.acces, "X-Shh-Manage": p.entetes.gestion },
      body: JSON.stringify({ ...p.corps, altcha: (pv as { payload: string }).payload, hp: "", shown_at }),
    });
    expect(rc.status).toBe(201);
    const mk = async (kLien: Uint8Array, o: { cles?: ReturnType<SalonEngine["clesSalon"]>; mdp?: string; sGestion?: Uint8Array; creerGroupe?: boolean }) => {
      let cles = o.cles;
      if (!cles) {
        const acces = eng.cleAcces(kLien);
        const meta = await api.meta(net, acces.k);
        const kMdp = await passwordKey(o.mdp!, meta.salt, { ops: meta.kdfOps, mem: meta.kdfMem });
        cles = eng.clesSalon(kLien, kMdp);
      }
      const evs: EvClient[] = [];
      const garde: { ws?: WsLike } = {};
      const { client } = await ClientSalon.entrer(deps(srv, eng, garde), { kLien, cles, sGestion: o.sGestion, creerGroupe: o.creerGroupe });
      client.ecouter((e) => evs.push(e));
      fermer.push(client);
      return { c: client, evs, ws: () => garde.ws };
    };
    const membres = async (m: Membre, s: number[]) => {
      const fin = Date.now() + 30_000;
      while (JSON.stringify(m.c.membres()) !== JSON.stringify(s)) {
        if (Date.now() > fin) throw new Error(`siège ${m.c.siege} : membres ${JSON.stringify(m.c.membres())}`);
        await dormir(20);
      }
    };
    const a = await mk(p.kLien, { cles: p.cles, sGestion: p.sGestion, creerGroupe: true });
    const b = await mk(p.kLien, { mdp });
    const c = await mk(p.kLien, { mdp });
    await membres(a, [0, 1, 2]);
    await membres(c, [0, 1, 2]);
    const codeB = a.c.empreinte(1);
    const inv = await exclure(net, eng, a.c, 2);
    // C : exclu tout de suite (0x05 raison 5 ou 4002), plus rien ensuite.
    await attendre(c, (e) => e.k === "fin" && e.raison === "exclu");
    // A et B : rotation reçue, groupe refondé sous les nouvelles clés, sans C.
    await attendre(a, (e) => e.k === "rotation");
    await attendre(b, (e) => e.k === "rotation");
    await membres(a, [0, 1]);
    await membres(b, [0, 1]);
    expect(a.c.empreinte(1)).toBe(codeB); // codes gardés à travers la refondation (refonder)
    a.c.envoyer({ k: "texte", x: "après l'exclusion" }, 2);
    await attendre(b, texteRecu("après l'exclusion"), 30_000);
    expect(c.evs.some(texteRecu("après l'exclusion"))).toBe(false);
    // L'ancienne invitation n'ouvre plus rien (404 identique à un salon inconnu).
    const ancien = eng.cleAcces(p.kLien);
    await expect(api.meta(net, ancien.k)).rejects.toMatchObject({ status: 404 });
    // La nouvelle fait entrer D, ajouté au groupe refondé ; D lit la suite.
    const d = await mk(inv.kLien, { mdp: inv.mdp });
    await membres(d, [0, 1, d.c.siege]);
    b.c.envoyer({ k: "texte", x: "bienvenue D" }, 2);
    await attendre(d, texteRecu("bienvenue D"), 30_000);
  });
});

const secret: { sGestion: Uint8Array } = { sGestion: new Uint8Array(32) };

describe("salon : lien de gestion collé dans la conversation (exigence C-3 32)", () => {
  let srv: TestServer;
  let eng: SalonEngine;
  const fermer: ClientSalon[] = [];
  beforeAll(async () => {
    srv = await startServer({ salons: true });
    eng = await loadSalonEngine();
  });
  afterAll(async () => {
    for (const c of fermer) c.fermer();
    await srv?.dispose();
  });

  it("créateur revenu sans S_gestion : simple membre ; un lien d'un autre salon est refusé ; le sien rend le rôle au siège 0 et libère l'ancienne place", async () => {
    const net = { origin: srv.origin, fetch: (...x: Parameters<typeof fetch>) => fetch(...x) };
    const mdp = generatePassword();
    const p = await preparer(eng, mdp, { ttlHours: 1, maxMembers: 5, membersCanDestroy: false });
    const cap = await (await fetch(srv.origin + "/api/captcha")).json();
    const recu = Date.now();
    const { shown_at, fallback: _f, ...defi } = cap;
    const pv = await solveAltcha(defi);
    await dormir(Math.max(0, recu + 3100 - Date.now()));
    const rc = await fetch(srv.origin + "/api/salons", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shh-Access": p.entetes.acces, "X-Shh-Manage": p.entetes.gestion },
      body: JSON.stringify({ ...p.corps, altcha: (pv as { payload: string }).payload, hp: "", shown_at }),
    });
    expect(rc.status).toBe(201);
    const cles = async () => {
      const acces = eng.cleAcces(p.kLien);
      const meta = await api.meta(net, acces.k);
      const kMdp = await passwordKey(mdp, meta.salt, { ops: meta.kdfOps, mem: meta.kdfMem });
      return eng.clesSalon(p.kLien, kMdp);
    };
    const mk = async (o: { cles: ReturnType<SalonEngine["clesSalon"]>; sGestion?: Uint8Array; creerGroupe?: boolean }) => {
      const evs: EvClient[] = [];
      const garde: { ws?: WsLike } = {};
      const { client } = await ClientSalon.entrer(deps(srv, eng, garde), { kLien: p.kLien, ...o });
      client.ecouter((e) => evs.push(e));
      fermer.push(client);
      return { c: client, evs, ws: () => garde.ws };
    };
    const membres = async (m: Membre, s: number[]) => {
      const fin = Date.now() + 30_000;
      while (JSON.stringify(m.c.membres()) !== JSON.stringify(s)) {
        if (Date.now() > fin) throw new Error(`siège ${m.c.siege} : membres ${JSON.stringify(m.c.membres())}`);
        await dormir(20);
      }
    };
    const sGestion = p.sGestion.slice();
    const a = await mk({ cles: p.cles, sGestion: p.sGestion, creerGroupe: true });
    const b = await mk({ cles: await cles() });
    await membres(b, [0, 1]);
    // Le créateur ferme la page ; il revient sans son lien de gestion : simple membre, siège 2.
    a.c.fermer();
    const a2 = await mk({ cles: await cles() });
    expect(a2.c.createur).toBe(false);
    expect(a2.c.siege).toBe(2);
    await attendre(a2, (e) => e.k === "groupe" && e.dansLeGroupe, 30_000);
    await attendre(a2, (e) => e.k === "connexion" && e.etat === "ouvert");
    // Lien de gestion d'un AUTRE salon (secret au hasard) : 400, rien ne change.
    await expect(a2.c.reprendreLeRole(crypto.getRandomValues(new Uint8Array(32)))).rejects.toMatchObject({ code: "bad_request" });
    expect(a2.c.createur).toBe(false);
    expect(a2.c.siege).toBe(2);
    // Le bon : siège 0, rôle rendu (createurRevenu chez B), l'ancienne place (2) est rendue.
    await a2.c.reprendreLeRole(sGestion);
    expect(a2.c.createur).toBe(true);
    expect(a2.c.siege).toBe(0);
    await attendre(a2, (e) => e.k === "nouvelleEntree" && e.siege === 0);
    await attendre(b, (e) => e.k === "depart" && e.siege === 2, 30_000);
    await attendre(b, (e) => e.k === "membres" && e.createurRevenu, 30_000);
    await membres(b, [0, 1]);
    const fin = Date.now() + 30_000;
    while (!a2.c.dansLeGroupe()) {
      if (Date.now() > fin) throw new Error("créateur pas rentré dans le groupe");
      await dormir(20);
    }
    a2.c.envoyer({ k: "texte", x: "créateur de retour" }, 2);
    await attendre(b, texteRecu("créateur de retour"), 30_000);
    // Droits rendus : le créateur peut de nouveau exclure (retrait d'un membre présent, rotation).
    const inv = await exclure(net, eng, a2.c, 1);
    expect(inv.kLien.length).toBe(32);
    await attendre(b, (e) => e.k === "fin" && e.raison === "exclu", 30_000);
  });
});

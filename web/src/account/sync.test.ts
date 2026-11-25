// Synchronisation de l'historique de l'appareil avec le coffre privé (conception compte §21.8,
// §37.11 A-G2 et A-G8) contre le faux serveur du compte par passkey
// (passkey.test-helper.ts) : fusion à l'ouverture, écriture différée de 2 à 12 min après un
// événement, entrées « compte » retirées à la déconnexion (celles de l'appareil restent).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unb64u } from "../engine/pure";
import { fakeIndexedDB, type FakeIdb } from "../history/fake-idb.test-helper";
import { linkKey, type HistoryEntry } from "../history/store";
import { cleRecupDerivees, cleRecupLire } from "../engine/index";
import { clesDuCompte, ouvrirRecup } from "./keys";
import { ouvrir, priveDeJson, type CoffrePrive } from "./vaults";
import { deCoffre, fusionner, renommerEntree, versCoffre } from "./sync";
import { configurerNavigateur } from "./webauthn";
import { FauxAuthentificateur, fauxServeur } from "./passkey.test-helper";
import * as C from "./session.svelte";

const PREUVE = { altcha: "preuve", hp: "", shown_at: "t" };
const T0 = Date.now();
const H = 3600_000;

let n = 0;
function entree(o: Partial<HistoryEntry> = {}): HistoryEntry {
  const c = String.fromCharCode(65 + (n++ % 26));
  const sorte = o.sorte ?? "recu";
  return {
    id: (c + "id").repeat(8).slice(0, 22),
    sorte,
    origine: "local",
    manage: sorte === "envoi" ? "https://shh.test/#m" + c.repeat(43) : "",
    link: sorte === "envoi" ? "" : sorte === "recu" ? "https://shh.test/#" + c.repeat(43) : "https://shh.test/#c" + c.repeat(43),
    label: sorte.startsWith("salon") ? "Équipe" : "",
    format: sorte === "recu" ? "image" : "",
    createdAt: T0 - H,
    sizeBytes: sorte === "envoi" || sorte === "recu" ? 1234 : 0,
    itemsCount: sorte === "envoi" || sorte === "recu" ? 3 : 0,
    expiresAt: T0 + 6 * H,
    maxOpens: sorte === "envoi" ? 2 : 0,
    opensUsed: 0,
    opens: [],
    state: "ready",
    lastSeenAt: T0 - H,
    endedAt: 0,
    destroyedHere: false,
    ...o,
  };
}

/** Historique de l'appareil en mémoire, au port attendu par la session. */
function fauxHistorique(init: HistoryEntry[] = []) {
  let list = [...init];
  const ecoutes = new Set<(c: { kind: "add" | "remove"; entry: HistoryEntry }) => void>();
  const f = {
    reglages: undefined as unknown,
    get list() {
      return list;
    },
    emettre(kind: "add" | "remove", entry: HistoryEntry) {
      if (kind === "add") list.push(entry);
      else list = list.filter((e) => e.id !== entry.id);
      for (const g of ecoutes) g({ kind, entry });
    },
    port: {
      lister: async () => list.map((e) => ({ ...e })),
      importer: async (es: readonly HistoryEntry[]) => {
        for (const e of es) if (!list.some((x) => linkKey(x) === linkKey(e))) list.push({ ...e });
      },
      retirer: async (ids: readonly string[]) => void (list = list.filter((e) => !ids.includes(e.id))),
      retirerCompte: async () => void (list = list.filter((e) => e.origine !== "compte")),
      ecouter: (g: (c: { kind: "add" | "remove"; entry: HistoryEntry }) => void) => {
        ecoutes.add(g);
        return () => void ecoutes.delete(g);
      },
      regler: (p: unknown) => void (f.reglages = p),
    },
  };
  return f;
}

let srv: ReturnType<typeof fauxServeur>;
let idb: FakeIdb;
let planifies: { ms: number; f: () => void; annule: boolean }[];
/** Clé de récupération de l'inscription : le test ouvre le coffre du serveur comme un appareil. */
let cle = "";
function appareil(h: ReturnType<typeof fauxHistorique>) {
  C._oublierMemoire(); // autre appareil : rien en mémoire
  C.configurerCompte({ historique: h.port });
}

/** Coffre privé tel que le serveur le garde, ouvert avec la clé de récupération (comme un appareil). */
async function coffreDuServeur(): Promise<CoffrePrive> {
  const c = [...srv.comptes.values()][0]!;
  const { kekR } = await cleRecupDerivees(await cleRecupLire(cle));
  const k = await clesDuCompte(await ouvrirRecup(kekR, c.h, unb64u(c.envR)));
  return priveDeJson(await ouvrir("prive", k.prive, c.h, c.coffres.prive.blob, c.coffres.prive.gen));
}
const liens = (p: CoffrePrive) => [...p.envois.map((e) => e.gestion), ...p.recus.map((e) => e.lien), ...p.salons.map((e) => e.invitation), ...p.rejoints.map((e) => e.invitation)];
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  srv = fauxServeur();
  idb = fakeIndexedDB();
  planifies = [];
  const auth = new FauxAuthentificateur({ prf: "creation" }); // passkey synchronisée : la même sur chaque appareil
  configurerNavigateur(() => auth.navigateur());
  C.configurerCompte({
    net: { origin: "https://shh.test", fetch: srv.fetch },
    idb: () => idb,
    agent: () => "Firefox",
    planifier: (ms, f) => {
      const p = { ms, f, annule: false };
      planifies.push(p);
      return () => (p.annule = true);
    },
  });
});
afterEach(async () => {
  await C.seDeconnecter();
  configurerNavigateur(null);
  vi.restoreAllMocks();
});

async function inscription(h: ReturnType<typeof fauxHistorique>) {
  appareil(h);
  await C.preparerInscription(PREUVE);
  await C.creerPasskey("Lea", "fr");
  cle = C.cleAffichee();
  await C.terminerInscription(false);
  await settle();
}
describe("format des entrées du coffre privé", () => {
  it("aller-retour pour les quatre sortes ; jamais de mot de passe, de nom ni d'état de relecture", () => {
    for (const sorte of ["envoi", "recu", "salon_cree", "salon_rejoint"] as const) {
      const e = entree({ sorte });
      const { liste, valeur } = versCoffre(e);
      expect(liste).toBe({ envoi: "envois", recu: "recus", salon_cree: "salons", salon_rejoint: "rejoints" }[sorte]);
      expect(Object.keys(valeur).sort()).toEqual(
        { envoi: ["id", "gestion", "cree", "expire", "taille", "elements", "ouvertures_max"], recu: ["id", "lien", "cree", "expire", "taille", "elements", "format"], salon_cree: ["id", "invitation", "libelle", "cree", "expire"], salon_rejoint: ["id", "invitation", "libelle", "cree", "expire"] }[sorte].sort(),
      );
      const back = deCoffre(liste, valeur, T0)!;
      expect(back).toMatchObject({ id: e.id, sorte, origine: "compte", manage: e.manage, link: e.link, label: e.label, format: e.format, createdAt: e.createdAt, expiresAt: e.expiresAt, state: "ready" });
    }
    expect(deCoffre("recus", { id: "x".repeat(22), lien: "https://shh.test/#m" + "a".repeat(43), cree: 1, expire: 2, taille: 1, elements: 1, format: "image" }, T0)).toBeNull();
    expect(deCoffre("recus", { id: "x".repeat(22), lien: "https://shh.test/#" + "a".repeat(43), cree: 1, expire: 2, taille: 1, elements: 1, format: "image", mot_de_passe: "x" }, T0)).not.toHaveProperty("mot_de_passe");
  });

  // Nom du partage : `libelle` d'un envoi, seulement s'il y en a un ; entrée d'avant
  // (sans libellé) relue sans titre ; renommage : seul le libellé de l'entrée du même lien change.
  it("envoi : titre du partage dans le coffre (libelle), aller-retour, renommage", () => {
    const e = entree({ sorte: "envoi", label: "Contrat Dupont" });
    const { liste, valeur } = versCoffre(e);
    expect(valeur.libelle).toBe("Contrat Dupont");
    expect(deCoffre(liste, valeur, T0)!.label).toBe("Contrat Dupont");
    const sans = versCoffre(entree({ sorte: "envoi" })).valeur;
    expect(sans).not.toHaveProperty("libelle");
    expect(deCoffre("envois", sans, T0)!.label).toBe("");
    // Mal formé (trop long, commande) : entrée refusée à la relecture, comme toute entrée mal formée.
    expect(deCoffre("envois", { ...valeur, libelle: "a".repeat(81) }, T0)).toBeNull();
    expect(deCoffre("envois", { ...valeur, libelle: "a\u0000" }, T0)).toBeNull();
    expect(deCoffre("envois", { ...valeur, libelle: 5 }, T0)).toBeNull();
    const autre = entree({ sorte: "envoi" });
    const p: CoffrePrive = { salons: [], recus: [], rejoints: [], envois: [valeur, versCoffre(autre).valeur] };
    const r = renommerEntree(p, { ...e, label: "Contrat signé" });
    expect(r.envois.map((v) => v.libelle)).toEqual(["Contrat signé", undefined]);
    expect(r.envois[0]).toEqual({ ...valeur, libelle: "Contrat signé" });
    // Titre retiré : plus de libellé ; entrée absente du coffre : ajoutée.
    expect(renommerEntree(p, { ...e, label: "" }).envois[0]).not.toHaveProperty("libelle");
    const neuve = entree({ sorte: "envoi", label: "Neuve" });
    expect(renommerEntree(p, neuve).envois.map((v) => v.libelle)).toEqual(["Contrat Dupont", undefined, "Neuve"]);
  });

  it("fusion : appareil → coffre (sans doublon), coffre → appareil (origine compte), retraits et entrées finies depuis 7 jours", () => {
    const loc = entree({ sorte: "recu" });
    const commun = entree({ sorte: "envoi" });
    const ailleurs = entree({ sorte: "salon_rejoint" });
    const vieux = entree({ sorte: "recu", expiresAt: T0 - 8 * 24 * H });
    const retireAilleurs = entree({ sorte: "recu", origine: "compte" });
    const coffre: CoffrePrive = { salons: [], recus: [versCoffre(vieux).valeur], rejoints: [versCoffre(ailleurs).valeur], envois: [versCoffre({ ...commun, id: "Z".repeat(22) }).valeur] };
    const r = fusionner([loc, commun, retireAilleurs], coffre, { now: T0 });
    expect(r.importer.map((e) => [e.link, e.origine])).toEqual([[ailleurs.link, "compte"]]);
    expect(r.retirer).toEqual([retireAilleurs.id]);
    expect(liens(r.coffre!).sort()).toEqual([loc.link, commun.manage, ailleurs.link].sort());
    // Rien à changer : pas d'écriture.
    expect(fusionner([], { salons: [], recus: [], rejoints: [], envois: [] }, { now: T0 }).coffre).toBeNull();
  });
});

describe("synchronisation de la session", () => {
  it("inscription sur un appareil qui a déjà un historique : ses entrées entrent dans le coffre privé, chiffrées", async () => {
    const a = fauxHistorique([entree({ sorte: "recu" }), entree({ sorte: "envoi" })]);
    await inscription(a);
    const p = await coffreDuServeur();
    expect(liens(p).sort()).toEqual([a.list[0]!.link, a.list[1]!.manage].sort());
    // Le serveur ne voit que le coffre chiffré : aucun lien en clair dans une requête.
    expect(JSON.stringify(srv.requetes)).not.toContain(a.list[0]!.link.slice(-43));
    expect(a.reglages).toEqual({ keepReceived: true });
  });

  it("connexion sur un autre appareil : entrées du compte reçues (origine compte), les siennes ajoutées au coffre", async () => {
    const a = fauxHistorique([entree({ sorte: "recu" })]);
    await inscription(a);
    const b = fauxHistorique([entree({ sorte: "salon_rejoint" })]);
    appareil(b);
    await C.seConnecter(false);
    await settle();
    expect(b.list.map((e) => e.origine).sort()).toEqual(["compte", "local"]);
    expect(C.account.recupere).toBe(false);
    expect(b.list.find((e) => e.origine === "compte")).toMatchObject({ id: a.list[0]!.id, link: a.list[0]!.link });
    expect(liens(await coffreDuServeur()).sort()).toEqual([a.list[0]!.link, b.list[0]!.link].sort());
  });

  it("événement de partage connecté : écriture du coffre différée de 2 à 12 min, retraits aussi", async () => {
    const a = fauxHistorique();
    await inscription(a);
    const puts = () => srv.requetes.filter((r) => r.method === "PUT" && r.path.endsWith("coffre/prive")).length;
    const avant = puts();
    const e = entree({ sorte: "recu" });
    a.emettre("add", e);
    await settle();
    expect(puts()).toBe(avant);
    expect(planifies).toHaveLength(1);
    expect(planifies[0]!.ms).toBeGreaterThanOrEqual(120_000);
    expect(planifies[0]!.ms).toBeLessThanOrEqual(720_000);
    planifies[0]!.f();
    await settle();
    expect(puts()).toBe(avant + 1);
    expect(liens(await coffreDuServeur())).toEqual([e.link]);
    a.emettre("remove", e);
    await settle();
    expect(planifies).toHaveLength(2);
    planifies[1]!.f();
    await settle();
    expect(liens(await coffreDuServeur())).toEqual([]);
  });

  it("une entrée retirée du compte sur un autre appareil part de celui-ci à la connexion suivante", async () => {
    const a = fauxHistorique([entree({ sorte: "recu" })]);
    await inscription(a);
    const b = fauxHistorique();
    appareil(b);
    await C.seConnecter(false);
    await settle();
    expect(b.list).toHaveLength(1);
    // Retirée sur A (« Retirer de la liste »), écrite dans le coffre.
    appareil(a);
    await C.seConnecter(false);
    await settle();
    a.emettre("remove", a.list[0]!);
    await settle();
    planifies.at(-1)!.f();
    await settle();
    appareil(b);
    await C.seConnecter(false);
    await settle();
    expect(b.list).toEqual([]);
  });

  it("déconnexion : entrées venues du compte retirées de l'appareil, les siennes restent ; plus d'écoute", async () => {
    const a = fauxHistorique([entree({ sorte: "recu" })]);
    await inscription(a);
    const b = fauxHistorique([entree({ sorte: "envoi" })]);
    appareil(b);
    await C.seConnecter(false);
    await settle();
    expect(b.list).toHaveLength(2);
    await C.seDeconnecter();
    expect(b.list.map((e) => e.origine)).toEqual(["local"]);
    expect(b.reglages).toBeNull();
    b.emettre("add", entree({ sorte: "recu" }));
    await settle();
    expect(planifies).toHaveLength(0);
  });

  it("au démarrage sans session gardée : les entrées d'une session précédente ne restent pas sur l'appareil", async () => {
    const b = fauxHistorique([entree({ sorte: "recu", origine: "compte" }), entree({ sorte: "envoi" })]);
    appareil(b);
    await C.restaurer();
    expect(b.list.map((e) => e.origine)).toEqual(["local"]);
  });

  it("clé de récupération sur un nouvel appareil : le coffre existant est rouvert (rien de perdu), les entrées de l'appareil y entrent", async () => {
    const a = fauxHistorique([entree({ sorte: "recu" })]);
    await inscription(a);
    const b = fauxHistorique([entree({ sorte: "envoi" })]);
    appareil(b);
    expect(await C.ouvrirAvecCle(cle)).toBe("recup");
    await settle();
    expect(C.account.recupere).toBe(true); // bandeau : nouvelle clé proposée (Q10)
    expect(b.list.map((e) => e.origine).sort()).toEqual(["compte", "local"]);
    expect(liens(await coffreDuServeur()).sort()).toEqual([a.list[0]!.link, b.list.find((e) => e.origine === "local")!.manage].sort());
  });
});

// Relectures de « Mes partages » (spec §33.1) : page visible seulement, au plus une fois toutes
// les 5 min par partage, une gigue de 0,5 à 4 s avant chaque requête, l'un après l'autre ;
// absent du serveur → effacé ou échu ; « Supprimer » par le lien de gestion seul.
import { describe, expect, it, vi } from "vitest";
import { LimitError, NotFoundError } from "../index";
import { memoryBackend } from "./idb";
import { ouvrirPartages, type NouveauPartage } from "./partages";
import { GIGUE_MAX_MS, GIGUE_MIN_MS, RELECTURE_MIN_MS, relecteur, type DepsRelecture } from "./partages-relecture";

const T0 = Date.UTC(2026, 10, 26, 9, 0);
const G = (c: string) => "https://shhgone.test/s#m" + c.repeat(43);
const envoi = (c: string, o: Partial<NouveauPartage> = {}): NouveauPartage => ({ sorte: "envoi", gestion: G(c), creeLe: T0, echeance: T0 + 86_400_000, ouverturesMax: 3, taille: 10, elements: 1, ...o });

async function monter(o: Partial<DepsRelecture> = {}) {
  let now = T0;
  const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => now }))!;
  const sleeps: number[] = [];
  const d: DepsRelecture = {
    etat: vi.fn(async () => ({ opensUsed: 1, maxOpens: 3, expiresInS: 3600, state: "ready" })),
    detruire: vi.fn(async () => undefined),
    now: () => now,
    visible: () => true,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...o,
  };
  return { s, d, r: relecteur(s, d), sleeps, avancer: (ms: number) => (now += ms) };
}

describe("relecture de Mes partages", () => {
  it("création récente : aucune requête avant 5 min ; ensuite une, après la gigue", async () => {
    const m = await monter();
    const p = await m.s.ajouter(envoi("a"));
    await m.r.relire();
    expect(m.d.etat).not.toHaveBeenCalled();
    m.avancer(RELECTURE_MIN_MS);
    await m.r.relire();
    expect(m.d.etat).toHaveBeenCalledWith(G("a"));
    expect(m.sleeps).toEqual([Math.round(GIGUE_MIN_MS + 0.5 * (GIGUE_MAX_MS - GIGUE_MIN_MS))]);
    expect(await m.s.get(p.id)).toMatchObject({ ouvertures: 1, echeance: T0 + RELECTURE_MIN_MS + 3600_000, vuLe: T0 + RELECTURE_MIN_MS });
    await m.r.relire();
    expect(m.d.etat).toHaveBeenCalledTimes(1); // relu il y a moins de 5 min
  });

  it("page cachée : rien ; salons : jamais relus", async () => {
    const m = await monter({ visible: () => false });
    await m.s.ajouter(envoi("a"));
    await m.s.ajouter({ sorte: "salon", gestion: "https://shhgone.test/salon#s" + "s".repeat(43), invitation: "https://shhgone.test/salon#c" + "c".repeat(43), creeLe: T0, echeance: T0 + 86_400_000 });
    m.avancer(RELECTURE_MIN_MS);
    await m.r.relire();
    expect(m.d.etat).not.toHaveBeenCalled();
  });

  it("toutes les ouvertures utilisées : « epuise »", async () => {
    const m = await monter({ etat: vi.fn(async () => ({ opensUsed: 3, maxOpens: 3, expiresInS: 60, state: "draining" })) });
    const p = await m.s.ajouter(envoi("a"));
    m.avancer(RELECTURE_MIN_MS);
    await m.r.relire();
    expect((await m.s.get(p.id))!.etat).toBe("epuise");
  });

  it("absent du serveur : effacé (avant l'échéance) ; erreurs rendues, réseau réessayable", async () => {
    const m = await monter({ etat: vi.fn(async () => Promise.reject(new NotFoundError())) });
    const p = await m.s.ajouter(envoi("a"));
    m.avancer(RELECTURE_MIN_MS);
    await m.r.relire();
    expect(await m.s.get(p.id)).toMatchObject({ etat: "detruit", detruitIci: false, finLe: T0 + RELECTURE_MIN_MS });

    const n = await monter({ etat: vi.fn(async () => Promise.reject(new Error("reseau"))) });
    const q = await n.s.ajouter(envoi("b"));
    n.avancer(RELECTURE_MIN_MS);
    expect(await n.r.relire()).toEqual({ [q.id]: "reseau" });
    expect(await n.r.relire()).toEqual({ [q.id]: "reseau" }); // une coupure n'a pas atteint le serveur
    expect(n.d.etat).toHaveBeenCalledTimes(2);

    const l = await monter({ etat: vi.fn(async () => Promise.reject(new LimitError(600))) });
    const r = await l.s.ajouter(envoi("c"));
    l.avancer(RELECTURE_MIN_MS);
    expect(await l.r.relire()).toEqual({ [r.id]: "limite" });
    l.avancer(RELECTURE_MIN_MS);
    await l.r.relire();
    expect(l.d.etat).toHaveBeenCalledTimes(1); // pause demandée par le serveur (10 min)
  });

  it("Supprimer : par le lien de gestion ; déjà absent compte comme supprimé ; erreur réseau dite", async () => {
    const m = await monter();
    const p = await m.s.ajouter(envoi("a"));
    expect(await m.r.detruire(p.id)).toBeNull();
    expect(m.d.detruire).toHaveBeenCalledWith(G("a"));
    expect(await m.s.get(p.id)).toMatchObject({ etat: "detruit", detruitIci: true });

    const n = await monter({ detruire: vi.fn(async () => Promise.reject(new NotFoundError())) });
    const q = await n.s.ajouter(envoi("b"));
    expect(await n.r.detruire(q.id)).toBeNull();

    const e = await monter({ detruire: vi.fn(async () => Promise.reject(new Error("reseau"))) });
    const r = await e.s.ajouter(envoi("c"));
    expect(await e.r.detruire(r.id)).toBe("reseau");
    expect((await e.s.get(r.id))!.etat).toBe("actif");
  });
});

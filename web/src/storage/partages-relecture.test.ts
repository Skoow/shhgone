// Suivi en direct de « Mes partages » (décision du propriétaire, 28 novembre) : une surveillance
// pour tous les envois actifs, relancée dès sa réponse, tant que la page est visible ; changement
// écrit tout de suite ; absent du serveur → effacé ou échu ; erreurs dites, puis pause et reprise ;
// « Supprimer » par le lien de gestion seul.
import { describe, expect, it, vi } from "vitest";
import { LimitError, NotFoundError } from "../index";
import { memoryBackend } from "./idb";
import { ouvrirPartages, type NouveauPartage } from "./partages";
import { PAUSE_ERREUR_MS, relecteur, type DepsRelecture, type Etat } from "./partages-relecture";

const T0 = Date.UTC(2026, 10, 26, 9, 0);
const G = (c: string) => "https://shhgone.test/s#m" + c.repeat(43);
const envoi = (c: string, o: Partial<NouveauPartage> = {}): NouveauPartage => ({ sorte: "envoi", gestion: G(c), creeLe: T0, echeance: T0 + 86_400_000, ouverturesMax: 3, taille: 10, elements: 1, ...o });

/** `reponses` : une par surveillance ; épuisées, la page se cache (fin de la boucle). */
async function monter(reponses: (Etat[] | Error)[], o: Partial<DepsRelecture> = {}) {
  let now = T0;
  let visible = true;
  const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => now }))!;
  const sleeps: number[] = [];
  const appels: { gestion: string; opensUsed: number; state: string }[][] = [];
  const change = vi.fn();
  const d: DepsRelecture = {
    surveiller: vi.fn(async (suivis) => {
      appels.push(suivis);
      const r = reponses.shift();
      if (reponses.length === 0) visible = false;
      if (r === undefined) throw new Error("reseau");
      if (r instanceof Error) throw r;
      return r;
    }),
    detruire: vi.fn(async () => undefined),
    now: () => now,
    visible: () => visible,
    sleep: async (ms) => void sleeps.push(ms),
    change,
    ...o,
  };
  return { s, d, r: relecteur(s, d), sleeps, appels, change, avancer: (ms: number) => (now += ms) };
}
const etat = (opensUsed: number, state = "ready"): Etat => ({ opensUsed, maxOpens: 3, expiresInS: 3600, state });

describe("suivi en direct de Mes partages", () => {
  it("dès la page affichée : une surveillance pour tous les envois actifs, l'ouverture écrite tout de suite, puis relancée", async () => {
    const m = await monter([[etat(1), etat(0)], [etat(1), etat(2)]]);
    const a = await m.s.ajouter(envoi("a"));
    const b = await m.s.ajouter(envoi("b"));
    await m.r.suivre();
    expect(m.appels).toHaveLength(2);
    // Première : l'état connu (0 ouverture) ; seconde : l'état écrit par la première.
    expect(m.appels[0]!.map((x) => x.opensUsed).sort()).toEqual([0, 0]);
    expect(m.appels[0]!.every((x) => x.state === "ready")).toBe(true);
    expect((await m.s.get(a.id))!.ouvertures + (await m.s.get(b.id))!.ouvertures).toBe(3);
    expect(m.change).toHaveBeenCalledTimes(2);
    expect(m.sleeps).toEqual([]); // aucune attente entre deux surveillances
  });

  it("page cachée : rien ; salons et envois finis : jamais suivis", async () => {
    const m = await monter([[etat(1)]], { visible: () => false });
    await m.s.ajouter(envoi("a"));
    await m.r.suivre();
    expect(m.d.surveiller).not.toHaveBeenCalled();
    const n = await monter([[etat(1)]]);
    await n.s.ajouter({ sorte: "salon", gestion: "https://shhgone.test/salon#s" + "s".repeat(43), invitation: "https://shhgone.test/salon#c" + "c".repeat(43), creeLe: T0, echeance: T0 + 86_400_000 });
    await n.s.ajouter(envoi("z", { echeance: T0 - 1 }));
    await n.r.suivre();
    expect(n.d.surveiller).not.toHaveBeenCalled();
  });

  it("toutes les ouvertures utilisées : « epuise », suivi ensuite comme « draining »", async () => {
    const m = await monter([[etat(3, "draining")], [etat(3, "draining")]]);
    const p = await m.s.ajouter(envoi("a"));
    await m.r.suivre();
    expect((await m.s.get(p.id))!.etat).toBe("epuise");
    expect(m.appels[1]).toEqual([{ gestion: G("a"), opensUsed: 3, state: "draining" }]);
  });

  it("absent du serveur : effacé (avant l'échéance), plus suivi ; erreurs : dites, pause, reprise", async () => {
    const m = await monter([[{ opensUsed: 0, maxOpens: 0, expiresInS: 0, state: "absent" }]]);
    const p = await m.s.ajouter(envoi("a"));
    await m.r.suivre();
    expect(await m.s.get(p.id)).toMatchObject({ etat: "detruit", detruitIci: false, finLe: T0 });

    const n = await monter([new Error("reseau"), [etat(1)]]);
    const q = await n.s.ajouter(envoi("b"));
    await n.r.suivre();
    expect(n.sleeps).toEqual([PAUSE_ERREUR_MS]);
    expect((await n.s.get(q.id))!.ouvertures).toBe(1);
    expect(n.r.erreurs()).toEqual({}); // effacée par la réponse suivante

    const l = await monter([new LimitError(600), [etat(0)]]);
    await l.s.ajouter(envoi("c"));
    await l.r.suivre();
    expect(l.sleeps).toEqual([600_000]); // pause demandée par le serveur
  });

  it("arreter : la surveillance en cours est annulée", async () => {
    let signal: AbortSignal | undefined;
    const m = await monter([], {
      surveiller: (_s, sig) => {
        signal = sig;
        return new Promise((_ok, ko) => sig.addEventListener("abort", () => ko(new DOMException("annulé", "AbortError"))));
      },
    });
    await m.s.ajouter(envoi("a"));
    const fin = m.r.suivre();
    await vi.waitFor(() => expect(signal).toBeDefined());
    m.r.arreter();
    await fin;
    expect(signal!.aborted).toBe(true);
  });

  it("Supprimer : par le lien de gestion ; déjà absent compte comme supprimé ; erreur réseau dite", async () => {
    const m = await monter([]);
    const p = await m.s.ajouter(envoi("a"));
    expect(await m.r.detruire(p.id)).toBeNull();
    expect(m.d.detruire).toHaveBeenCalledWith(G("a"));
    expect(await m.s.get(p.id)).toMatchObject({ etat: "detruit", detruitIci: true });

    const n = await monter([], { detruire: vi.fn(async () => Promise.reject(new NotFoundError())) });
    const q = await n.s.ajouter(envoi("b"));
    expect(await n.r.detruire(q.id)).toBeNull();

    const e = await monter([], { detruire: vi.fn(async () => Promise.reject(new Error("reseau"))) });
    const r = await e.s.ajouter(envoi("c"));
    expect(await e.r.detruire(r.id)).toBe("reseau");
    expect((await e.s.get(r.id))!.etat).toBe("actif");
  });
});

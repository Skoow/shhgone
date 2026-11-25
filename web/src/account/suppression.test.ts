// Suppression totale du compte (conception compte §21.12
// « suppression simplifiée »). Ordre exact : (1) chaque partage connu détruit un par
// un par son secret de gestion, sans le jeton de session ; (2) départ des salons rejoints (aucune
// preuve de membre n'existe encore sur l'appareil : écrans du salon, C-5) ; (3) POST supprimer ;
// (4) effacement de l'appareil si demandé. Une destruction échouée n'arrête pas les autres et est dite.
import { describe, expect, it, vi } from "vitest";
import { partagesConnus, supprimerTout, type Progres } from "./suppression";
import { destroyShare, NotFoundError } from "../index";
import type { HistoryEntry } from "../history/store";
import { priveVide, type CoffrePrive } from "./vaults";

const ORIGIN = "https://shh.test";
const G = (c: string) => `${ORIGIN}/s#m${c.repeat(42)}A`; // dernier caractère canonique (32 octets)
const NOW = 1_800_000_000_000;

function envoi(manage: string, p: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id: manage.slice(-6), sorte: "envoi", origine: "local", manage, link: "", label: "", format: "", createdAt: NOW - 1000, sizeBytes: 1, itemsCount: 1, expiresAt: NOW + 3_600_000, maxOpens: 1, opensUsed: 0, opens: [], state: "ready", lastSeenAt: NOW - 1000, endedAt: 0, destroyedHere: false, ...p };
}

async function tout(it: AsyncIterable<Progres>): Promise<Progres[]> {
  const out: Progres[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("partagesConnus", () => {
  it("coffre privé ET historique de l'appareil, sans doublon ; finis ou échus exclus ; reçus et salons jamais", () => {
    const prive: CoffrePrive = {
      ...priveVide(),
      envois: [
        { id: "a", cree: 1, expire: NOW + 1000, gestion: G("A"), taille: 1, elements: 1, ouvertures_max: 1 },
        { id: "b", cree: 1, expire: NOW - 1, gestion: G("B"), taille: 1, elements: 1, ouvertures_max: 1 }, // échu
        { id: "c", cree: 1, expire: NOW + 1000, gestion: "pas un lien", taille: 1, elements: 1, ouvertures_max: 1 },
      ],
      recus: [{ id: "r", cree: 1, expire: NOW + 1000, lien: `${ORIGIN}/s#${"R".repeat(43)}`, taille: 1, elements: 1, format: "pdf" }],
    };
    const local = [
      envoi(G("A")), // déjà dans le coffre
      envoi(G("D")),
      envoi(G("E"), { state: "gone", endedAt: NOW - 10 }),
      envoi(G("F"), { expiresAt: NOW - 1 }),
      { ...envoi(""), sorte: "recu" as const, link: `${ORIGIN}/s#${"S".repeat(43)}` },
    ];
    expect(partagesConnus(prive, local, NOW)).toEqual([G("A"), G("D")]);
  });
});

describe("supprimerTout", () => {
  function deps(o: { echec?: string[]; absent?: string[] } = {}) {
    const log: string[] = [];
    return {
      log,
      d: {
        avant: vi.fn(async () => void log.push("avant")),
        partages: vi.fn(async () => [G("A"), G("B"), G("C")]),
        detruire: vi.fn(async (l: string) => {
          log.push(`detruire ${l.slice(-2, -1)}`);
          if (o.echec?.includes(l)) throw new Error("reseau");
          if (o.absent?.includes(l)) throw new NotFoundError();
        }),
        supprimerCompte: vi.fn(async () => (log.push("supprimer"), 2)),
        effacerAppareil: vi.fn(async () => void log.push("effacer appareil")),
        oublierCompte: vi.fn(async () => void log.push("oublier compte")),
      },
    };
  }

  it("ordre exact, un par un ; progression « 1 / 3 » … ; fin : salons fermés et partages détruits", async () => {
    const { d, log } = deps();
    const p = await tout(supprimerTout({ effacerAppareil: true }, d));
    expect(log).toEqual(["avant", "detruire A", "detruire B", "detruire C", "supprimer", "oublier compte", "effacer appareil"]);
    expect(p.filter((x) => x.etape === "partages").map((x) => x.etape === "partages" && `${x.fait}/${x.total}`)).toEqual(["0/3", "1/3", "2/3", "3/3"]);
    expect(p.at(-1)).toEqual({ etape: "fini", salonsFermes: 2, partagesDetruits: 3, partagesEchoues: 0 });
  });

  it("une destruction échouée n'empêche pas les autres et est dite ; un partage déjà disparu compte comme détruit", async () => {
    const { d, log } = deps({ echec: [G("A")], absent: [G("B")] });
    const p = await tout(supprimerTout({ effacerAppareil: false }, d));
    expect(log).toEqual(["avant", "detruire A", "detruire B", "detruire C", "supprimer", "oublier compte"]);
    expect(p.at(-1)).toEqual({ etape: "fini", salonsFermes: 2, partagesDetruits: 2, partagesEchoues: 1 });
    expect(d.effacerAppareil).not.toHaveBeenCalled();
  });

  it("refus avant toute destruction (attente après une récupération, réseau) : rien n'est détruit", async () => {
    const { d, log } = deps();
    d.avant.mockRejectedValueOnce(Object.assign(new Error("attente"), { code: "attente" }));
    await expect(tout(supprimerTout({ effacerAppareil: true }, d))).rejects.toThrow("attente");
    expect(log).toEqual([]);
    expect(d.detruire).not.toHaveBeenCalled();
    expect(d.supprimerCompte).not.toHaveBeenCalled();
  });

  it("refus du serveur à la fin : le compte reste ouvert sur l'appareil, l'erreur passe", async () => {
    const { d, log } = deps();
    d.supprimerCompte.mockRejectedValueOnce(Object.assign(new Error("recent"), { code: "recent" }));
    await expect(tout(supprimerTout({ effacerAppareil: true }, d))).rejects.toThrow("recent");
    expect(log).toEqual(["avant", "detruire A", "detruire B", "detruire C"]);
    expect(d.oublierCompte).not.toHaveBeenCalled();
  });

  it("aucune requête de destruction ne porte X-Shh-Session : secret de gestion en X-Shh-Manage seulement (vrai destroyShare)", async () => {
    const vues: { path: string; headers: Headers; body: unknown }[] = [];
    const fetch = (async (u: string, init?: RequestInit) => {
      vues.push({ path: new URL(u).pathname, headers: new Headers(init?.headers), body: init?.body });
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const { d } = deps();
    d.detruire.mockImplementation((l: string) => destroyShare(l, ORIGIN, { fetch, retryDelayMs: 1 }));
    await tout(supprimerTout({ effacerAppareil: false }, d));
    expect(vues.map((v) => v.path)).toEqual(["/api/manage/destroy", "/api/manage/destroy", "/api/manage/destroy"]);
    for (const v of vues) {
      expect(v.headers.has("X-Shh-Session")).toBe(false);
      expect(v.headers.get("X-Shh-Manage")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(v.body ?? null).toBeNull();
    }
  });
});

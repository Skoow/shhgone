// Suppression totale du compte (conception compte §21.12 « suppression simplifiée » ; décision du
// propriétaire du 28 novembre : l'abonnement part toujours avec le compte). Ordre exact : pour
// chaque pass, (a) arrêt du renouvellement (pas pour un accès offert), (b) révocation ; puis
// (c) POST supprimer, l'appareil oublie le compte, (d) les pass et jetons quittent l'appareil ;
// enfin effacement de toutes les données du site sur l'appareil (toujours). Échec de (a) ou (b) :
// rien n'est supprimé. Aucun partage n'est détruit ici (spec §33).
import { describe, expect, it, vi } from "vitest";
import type { PassGarde } from "../paiement/pass";
import { ErreurAbonnement, supprimerTout, type Progres } from "./suppression";

async function tout(it: AsyncIterable<Progres>): Promise<Progres[]> {
  const out: Progres[] = [];
  for await (const p of it) out.push(p);
  return out;
}

const pass = (id: string, moyen: PassGarde["moyen"], n: number): PassGarde => ({ id, pass: new Uint8Array(32).fill(n), offre: moyen === "offert" ? "pro" : "plus", jours: 30, renouvelle: true, moyen, enAttente: false, cree: n });

describe("supprimerTout", () => {
  function deps(passes: PassGarde[] = []) {
    const log: string[] = [];
    return {
      log,
      d: {
        avant: vi.fn(async () => void log.push("avant")),
        passes: vi.fn(async () => passes),
        resilier: vi.fn(async (p: Uint8Array) => (log.push(`resilier ${p[0]}`), "ok" as "ok" | "aucun" | "erreur")),
        revoquer: vi.fn(async (p: Uint8Array) => (log.push(`revoquer ${p[0]}`), "ok" as "ok" | "renouvellement" | "erreur")),
        supprimerCompte: vi.fn(async () => (log.push("supprimer"), 2)),
        oublierCompte: vi.fn(async () => void log.push("oublier compte")),
        oublierPass: vi.fn(async (ids: readonly string[]) => void log.push(`oublier pass ${ids.join(",")}`)),
        effacerAppareil: vi.fn(async () => void log.push("effacer appareil")),
      },
    };
  }

  it("sans abonnement : ordre exact ; fin : salons fermés ; aucune requête de pass", async () => {
    const { d, log } = deps();
    const p = await tout(supprimerTout(d));
    expect(log).toEqual(["avant", "supprimer", "oublier compte", "effacer appareil"]);
    expect(p).toEqual([{ etape: "compte" }, { etape: "fini", salonsFermes: 2 }]);
    expect(d.resilier).not.toHaveBeenCalled();
    expect(d.revoquer).not.toHaveBeenCalled();
  });

  it("avec abonnement payé et accès offert : renouvellement arrêté, pass révoqués, PUIS compte supprimé, puis pass effacés", async () => {
    const { d, log } = deps([pass("A", "carte", 1), pass("B", "offert", 2)]);
    const p = await tout(supprimerTout(d));
    expect(log).toEqual(["avant", "resilier 1", "revoquer 1", "revoquer 2", "supprimer", "oublier compte", "oublier pass A,B", "effacer appareil"]);
    expect(p).toEqual([{ etape: "abonnement" }, { etape: "compte" }, { etape: "fini", salonsFermes: 2 }]);
  });

  it("pas d'abonnement en cours chez le prestataire (« aucun ») : la révocation suit", async () => {
    const { d, log } = deps([pass("A", "paypal", 1)]);
    d.resilier.mockImplementationOnce(async () => (log.push("resilier 1"), "aucun"));
    await tout(supprimerTout(d));
    expect(log).toEqual(["avant", "resilier 1", "revoquer 1", "supprimer", "oublier compte", "oublier pass A", "effacer appareil"]);
  });

  for (const [cas, regler] of [
    ["arrêt du renouvellement impossible (réseau)", (d: ReturnType<typeof deps>["d"]) => d.resilier.mockResolvedValueOnce("erreur")],
    ["révocation impossible (réseau)", (d: ReturnType<typeof deps>["d"]) => d.revoquer.mockResolvedValueOnce("erreur")],
    ["révocation refusée (renouvellement encore en cours)", (d: ReturnType<typeof deps>["d"]) => d.revoquer.mockResolvedValueOnce("renouvellement")],
  ] as const)
    it(`${cas} : rien n'est supprimé, ErreurAbonnement`, async () => {
      const { d } = deps([pass("A", "carte", 1)]);
      regler(d);
      await expect(tout(supprimerTout(d))).rejects.toBeInstanceOf(ErreurAbonnement);
      expect(d.supprimerCompte).not.toHaveBeenCalled();
      expect(d.oublierCompte).not.toHaveBeenCalled();
      expect(d.oublierPass).not.toHaveBeenCalled();
      expect(d.effacerAppareil).not.toHaveBeenCalled();
    });

  it("refus avant (attente après une récupération, réseau) : rien n'est supprimé, aucun pass touché", async () => {
    const { d, log } = deps([pass("A", "carte", 1)]);
    d.avant.mockRejectedValueOnce(Object.assign(new Error("attente"), { code: "attente" }));
    await expect(tout(supprimerTout(d))).rejects.toThrow("attente");
    expect(log).toEqual([]);
    expect(d.supprimerCompte).not.toHaveBeenCalled();
  });

  it("refus du serveur : le compte reste ouvert sur l'appareil, l'erreur passe", async () => {
    const { d, log } = deps();
    d.supprimerCompte.mockRejectedValueOnce(Object.assign(new Error("recent"), { code: "recent" }));
    await expect(tout(supprimerTout(d))).rejects.toThrow("recent");
    expect(log).toEqual(["avant"]);
    expect(d.oublierCompte).not.toHaveBeenCalled();
  });
});

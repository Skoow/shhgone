// Suppression totale du compte (conception compte §21.12 « suppression simplifiée »). Ordre
// exact : (1) POST supprimer ; (2) l'appareil oublie le compte ; (3) effacement de l'appareil si
// demandé. Aucun partage n'est détruit ici (historique local des liens retiré, spec §33).
import { describe, expect, it, vi } from "vitest";
import { supprimerTout, type Progres } from "./suppression";

async function tout(it: AsyncIterable<Progres>): Promise<Progres[]> {
  const out: Progres[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("supprimerTout", () => {
  function deps() {
    const log: string[] = [];
    return {
      log,
      d: {
        avant: vi.fn(async () => void log.push("avant")),
        supprimerCompte: vi.fn(async () => (log.push("supprimer"), 2)),
        effacerAppareil: vi.fn(async () => void log.push("effacer appareil")),
        oublierCompte: vi.fn(async () => void log.push("oublier compte")),
      },
    };
  }

  it("ordre exact ; fin : salons fermés", async () => {
    const { d, log } = deps();
    const p = await tout(supprimerTout({ effacerAppareil: true }, d));
    expect(log).toEqual(["avant", "supprimer", "oublier compte", "effacer appareil"]);
    expect(p).toEqual([{ etape: "compte" }, { etape: "fini", salonsFermes: 2 }]);
  });

  it("sans « effacer cet appareil » : les données de l'appareil restent", async () => {
    const { d, log } = deps();
    await tout(supprimerTout({ effacerAppareil: false }, d));
    expect(log).toEqual(["avant", "supprimer", "oublier compte"]);
    expect(d.effacerAppareil).not.toHaveBeenCalled();
  });

  it("refus avant (attente après une récupération, réseau) : rien n'est supprimé", async () => {
    const { d, log } = deps();
    d.avant.mockRejectedValueOnce(Object.assign(new Error("attente"), { code: "attente" }));
    await expect(tout(supprimerTout({ effacerAppareil: true }, d))).rejects.toThrow("attente");
    expect(log).toEqual([]);
    expect(d.supprimerCompte).not.toHaveBeenCalled();
  });

  it("refus du serveur : le compte reste ouvert sur l'appareil, l'erreur passe", async () => {
    const { d, log } = deps();
    d.supprimerCompte.mockRejectedValueOnce(Object.assign(new Error("recent"), { code: "recent" }));
    await expect(tout(supprimerTout({ effacerAppareil: true }, d))).rejects.toThrow("recent");
    expect(log).toEqual(["avant"]);
    expect(d.oublierCompte).not.toHaveBeenCalled();
  });
});

// Offres du compte (abonnements.ts) : coffre privé et appareil réunis par les octets du pass, état
// gardé ici seulement (aucune requête). Parcours « Pass et compte » de la conception du paiement
// §6.4 qui ne dépendent que de l'état du serveur : renouvellement, fin de période, révocation
// (remboursement, litige, exploitant, suppression du compte depuis un autre appareil).
import { describe, expect, it } from "vitest";
import type { EtatGarde, PassGarde } from "../paiement/pass";
import { abonnementsDe, passConnus } from "./abonnements";
import { passEnEntree } from "./pass";
import { priveVide } from "./vaults";

const pass = (n: number, o: Partial<PassGarde> = {}): PassGarde => ({ id: `id${n}`, pass: new Uint8Array(32).fill(n), offre: "plus", jours: 30, renouvelle: true, moyen: "carte", enAttente: false, cree: n, ...o });
const etat = (o: Partial<EtatGarde> = {}): EtatGarde => ({ etat: "payee", offre: "plus", fin: "2026-12-29", renouvelle: true, droits: [], jour: "2026-11-28", ...o });
const AUJ = "2026-11-28";

describe("passConnus", () => {
  it("appareil et coffre réunis sans doublon (l'enregistrement de l'appareil d'abord) ; commande en attente exclue", () => {
    const a = pass(1);
    const b = pass(2);
    const attente = pass(3, { enAttente: true });
    const prive = { ...priveVide(), pass: [passEnEntree({ ...a, id: "autre" }), passEnEntree(b)] };
    expect(passConnus(prive, [a, attente]).map((g) => g.id)).toEqual(["id1", "id2"]);
    expect(passConnus(undefined, [attente])).toEqual([]);
  });
});

describe("abonnementsDe", () => {
  it("renouvellement : la fin lue au serveur (état gardé) fait foi ; sans état gardé, fin inconnue", async () => {
    const l = await abonnementsDe([pass(1), pass(2)], async (id) => (id === "id1" ? etat({ fin: "2027-01-28" }) : null), AUJ);
    expect(l).toEqual([
      { id: "id1", offre: "plus", fin: "2027-01-28", renouvelle: true, arrete: false, offert: false },
      { id: "id2", offre: "plus", fin: null, renouvelle: true, arrete: false, offert: false },
    ]);
  });

  it("fin de période, révocation (remboursement, litige, exploitant, compte supprimé ailleurs), paiement non abouti : plus d'offre", async () => {
    const etats: Record<string, EtatGarde> = {
      id1: etat({ fin: AUJ }), // fin exclue : aujourd'hui n'est plus valable
      id2: etat({ etat: "revoquee", fin: AUJ, renouvelle: false }),
      id3: etat({ etat: "non_aboutie" }),
      id4: etat({ etat: "inconnue", fin: null, offre: null }), // purgé
    };
    expect(await abonnementsDe([pass(1), pass(2), pass(3), pass(4)], async (id) => etats[id] ?? null, AUJ)).toEqual([]);
  });

  it("renouvellement arrêté : « arrete » ; paiement unique et accès offert : ni renouvelé ni arrêté ; Pro d'abord", async () => {
    const l = await abonnementsDe(
      [pass(1), pass(2, { renouvelle: false }), pass(3, { offre: "pro", moyen: "offert", renouvelle: false })],
      async (id) => (id === "id1" ? etat({ renouvelle: false }) : id === "id3" ? etat({ offre: "pro", renouvelle: false }) : null),
      AUJ,
    );
    expect(l.map((a) => [a.id, a.renouvelle, a.arrete, a.offert])).toEqual([
      ["id3", false, false, true],
      ["id1", false, true, false],
      ["id2", false, false, false],
    ]);
  });
});

// « Mes partages » ↔ coffre privé du compte (spec §33, D42-30) : format des listes `envois` et
// `salons` (celui d'avant le 25 novembre), jamais de lien de partage ni de mot de passe ; fusion à
// l'ouverture ; `recus` et `rejoints` vidés ; entrée finie depuis 7 jours retirée du coffre.
import { describe, expect, it } from "vitest";
import { GARDE_APRES_FIN_MS, nettoyer, type Partage } from "../storage/partages";
import { ajouterEntree, deCoffre, fusionner, retirerEntree, versCoffre } from "./sync";
import { priveVide, type CoffrePrive } from "./vaults";

const T0 = Date.UTC(2026, 10, 26, 9, 0);
const G = (c: string) => "https://shh.test/s#m" + c.repeat(43);
function envoi(c: string, o: Partial<Partage> = {}): Partage {
  return nettoyer({ id: c.repeat(22), sorte: "envoi", origine: "local", gestion: G(c), invitation: "", nom: "Devis", taille: 9, elements: 2, creeLe: T0, echeance: T0 + 3600_000, ouvertures: 1, ouverturesMax: 3, etat: "actif", vuLe: T0, finLe: 0, detruitIci: false, ...o })!;
}
const salon = (c: string): Partage =>
  nettoyer({ id: c.repeat(22), sorte: "salon", origine: "local", gestion: "https://shh.test/salon#s" + c.repeat(43), invitation: "https://shh.test/salon#c" + c.repeat(43), nom: "", taille: 0, elements: 0, creeLe: T0, echeance: T0 + 3600_000, ouvertures: 0, ouverturesMax: 0, etat: "actif", vuLe: T0, finLe: 0, detruitIci: false })!;

describe("Mes partages ↔ coffre privé", () => {
  it("format du coffre : envoi et salon (champs fixés) ; aller-retour sans perte des champs gardés", () => {
    expect(versCoffre(envoi("a"))).toEqual({ id: "a".repeat(22), cree: T0, expire: T0 + 3600_000, gestion: G("a"), taille: 9, elements: 2, ouvertures_max: 3, libelle: "Devis" });
    expect(versCoffre(envoi("a", { nom: "" }))).not.toHaveProperty("libelle");
    expect(versCoffre(salon("b"))).toEqual({ id: "b".repeat(22), cree: T0, expire: T0 + 3600_000, gestion: salon("b").gestion, invitation: salon("b").invitation, libelle: "" });
    expect(deCoffre("envois", versCoffre(envoi("a")), T0)).toMatchObject({ origine: "compte", gestion: G("a"), nom: "Devis", taille: 9, elements: 2, ouverturesMax: 3, ouvertures: 0 });
    expect(deCoffre("salons", versCoffre(salon("b")), T0)).toMatchObject({ origine: "compte", sorte: "salon", invitation: salon("b").invitation });
    // Mal formée (lien de partage à la place du lien de gestion) : null.
    expect(deCoffre("envois", { ...versCoffre(envoi("a")), gestion: "https://shh.test/s#" + "k".repeat(43) }, T0)).toBeNull();
  });

  it("ajout et retrait par lien de gestion (pas de doublon)", () => {
    let c: CoffrePrive = priveVide();
    c = ajouterEntree(c, envoi("a"));
    expect(ajouterEntree(c, { ...envoi("a"), id: "z".repeat(22) })).toBe(c);
    c = ajouterEntree(c, salon("b"));
    expect(c.envois).toHaveLength(1);
    expect(c.salons).toHaveLength(1);
    c = retirerEntree(c, { ...envoi("a"), id: "z".repeat(22) });
    expect(c.envois).toEqual([]);
  });

  it("fusion : l'appareil reçoit le coffre, le coffre reçoit l'appareil ; retiré ailleurs → retiré ici ; recus/rejoints vidés ; pass gardé", () => {
    const local = [envoi("a"), { ...envoi("c"), origine: "compte" as const }];
    const coffre: CoffrePrive = { ...priveVide(), envois: [versCoffre(envoi("b"))], salons: [versCoffre(salon("d"))], recus: [{ id: "r" }], rejoints: [{ id: "j" }], pass: [{ id: "p" }] };
    const r = fusionner(local, coffre, T0);
    expect(r.importer.map((p) => p.gestion)).toEqual([G("b"), salon("d").gestion]);
    expect(r.retirer).toEqual(["c".repeat(22)]);
    expect(r.coffre!.envois.map((v) => v.gestion)).toEqual([G("b"), G("a")]);
    expect(r.coffre!.recus).toEqual([]);
    expect(r.coffre!.rejoints).toEqual([]);
    expect(r.coffre!.pass).toEqual([{ id: "p" }]);
    // Rien de changé : pas d'écriture.
    expect(fusionner([envoi("a")], { ...priveVide(), envois: [versCoffre(envoi("a"))] }, T0).coffre).toBeNull();
  });

  it("fini depuis 7 jours : retiré du coffre, pas importé", () => {
    const vieux = versCoffre(envoi("a", { echeance: T0 }));
    const r = fusionner([], { ...priveVide(), envois: [vieux] }, T0 + GARDE_APRES_FIN_MS);
    expect(r.importer).toEqual([]);
    expect(r.coffre!.envois).toEqual([]);
  });
});

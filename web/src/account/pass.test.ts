// Pass des offres payantes dans le coffre privé (conception du paiement §6.2, DP-8).
import { describe, expect, it } from "vitest";
import { fakeIndexedDB } from "../history/fake-idb.test-helper";
import { garder, lirePasses, nouvelId, tirerPass, type PassGarde } from "../paiement/pass";
import { passDeEntree, passEnEntree, synchroniserPass } from "./pass";
import { fusionner } from "./sync";
import { priveDeJson, priveEnJson, priveVide } from "./vaults";

const g = (over: Partial<PassGarde> = {}): PassGarde => ({ id: nouvelId(), pass: tirerPass(), offre: "plus", jours: 365, renouvelle: false, moyen: "carte", enAttente: false, cree: 5, ...over });

describe("pass dans le coffre privé", () => {
  it("entrée ↔ pass ; entrée mal formée ignorée", () => {
    const a = g();
    expect(passDeEntree(passEnEntree(a))).toEqual(a);
    const b = g({ pays: "DE" });
    expect(passDeEntree(passEnEntree(b))).toEqual(b);
    expect(passDeEntree({ ...passEnEntree(b), pays: "de" })).toEqual({ ...b, pays: undefined });
    expect(passDeEntree({ ...passEnEntree(a), offre: "max" })).toBeNull();
    expect(passDeEntree({ ...passEnEntree(a), p: "court" })).toBeNull();
    // Accès offert : origine « offert », relue telle quelle ; une origine inconnue est ignorée.
    const o = g({ offre: "pro", moyen: "offert" });
    expect(passDeEntree(passEnEntree(o))).toEqual(o);
    expect(passDeEntree({ ...passEnEntree(o), moyen: "cadeau" })).toBeNull();
  });

  it("coffre sans pass : même JSON qu'avant ; avec pass : relu à l'identique ; la fusion de l'historique les garde", () => {
    expect(new TextDecoder().decode(priveEnJson(priveVide()))).toBe('{"v":1,"salons":[],"recus":[],"rejoints":[],"envois":[]}');
    const p = { ...priveVide(), pass: [passEnEntree(g())] };
    expect(priveDeJson(priveEnJson(p))).toEqual(p);
    const f = fusionner([], { ...p, recus: [{ id: "x" }] }, { now: 0 });
    expect(f.coffre?.pass).toEqual(p.pass);
  });

  it("appareil ↔ coffre : chacun reçoit ce qui lui manque ; une commande en attente ne part pas", async () => {
    const idb = fakeIndexedDB();
    const ici = g({ offre: "pro" });
    const attente = g({ enAttente: true });
    await garder(idb, ici);
    await garder(idb, attente);
    const ailleurs = g();
    const coffre = { ...priveVide(), pass: [passEnEntree(ailleurs)] };
    const patch = await synchroniserPass(idb, coffre);
    const lus = await lirePasses(idb);
    expect(lus.some((x) => Buffer.from(x.pass).equals(Buffer.from(ailleurs.pass)))).toBe(true);
    expect(patch).not.toBeNull();
    const ecrit = patch!(coffre);
    expect(ecrit.pass!.map((e) => e.id).sort()).toEqual([ailleurs.id, ici.id].sort());
    // Rejouée sur un coffre qui l'a déjà (409 puis relecture) : rien en double.
    expect(patch!(ecrit)).toBe(ecrit);
    // Tout est déjà des deux côtés : rien à écrire.
    expect(await synchroniserPass(idb, ecrit)).toBeNull();
  });
});

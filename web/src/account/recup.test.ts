// Clé de récupération (conception du compte par passkey §2.2, §3.1) : tirage, affichage et
// lecture par le moteur (vecteurs compte-v3.json, cle_recup), groupe de vérification.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { affichage, derivees, fichierTexte, groupeAVerifier, groupeJuste, lire, nouvelleCle } from "./recup";

const V = JSON.parse(readFileSync(new URL("../../../engine/vectors/compte-v3.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

describe("clé de récupération", () => {
  it("nouvelle clé : 16 octets aléatoires ; affichage en 7 groupes relu à l'identique, même en minuscules", async () => {
    const r = nouvelleCle();
    expect(r.length).toBe(16);
    expect(hex(r)).not.toBe(hex(nouvelleCle()));
    const t = await affichage(r);
    expect(t.split("-").map((g) => g.length)).toEqual([4, 4, 4, 4, 4, 4, 3]);
    expect(await lire(t)).toEqual(r);
    expect(await lire(` ${t.toLowerCase()} `)).toEqual(r);
  });

  it("vecteurs : affichage, saisie tolérante ou erreur exacte, dérivées", async () => {
    for (const c of V.cle_recup.texte) expect(await affichage(unhex(c.r))).toBe(c.affichage);
    for (const c of V.cle_recup.saisie) {
      const t = Buffer.from(c.entree_hex, "hex").toString("utf8");
      if (c.error) await expect(lire(t), c.label).rejects.toThrow(c.error);
      else expect(hex(await lire(t)), c.label).toBe(c.r);
    }
    for (const c of V.recup) {
      const d = await derivees(unhex(c.r));
      expect([hex(d.aR), hex(d.vR), hex(d.kekR)]).toEqual([c.a_r, c.v_r, c.kek_r]);
    }
  });

  it("groupe à vérifier : 1 à 7, tiré au hasard ; comparaison tolérante (minuscules, I/L/O, blancs)", () => {
    const vus = new Set<number>();
    for (let i = 0; i < 200; i++) vus.add(groupeAVerifier());
    expect([...vus].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const t = "AB10-CDEF-GH01-JKMN-PQRS-TVWX-YZ*";
    expect(groupeJuste(t, 1, "ab10")).toBe(true);
    expect(groupeJuste(t, 1, "abIO")).toBe(true);
    expect(groupeJuste(t, 1, "AB L0")).toBe(true);
    expect(groupeJuste(t, 7, "yz*")).toBe(true);
    expect(groupeJuste(t, 1, "AB11")).toBe(false);
    expect(groupeJuste(t, 2, "AB10")).toBe(false);
    expect(groupeJuste(t, 8, "")).toBe(false);
  });

  it("fichier .txt : la clé et la phrase, rien d'autre", () => {
    expect(fichierTexte("XXXX-YYY", "Clé de récupération Shhgone.")).toBe("Clé de récupération Shhgone.\n\nXXXX-YYY\n");
  });
});

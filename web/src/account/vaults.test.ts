// Coffres du compte (conception compte §21.2.2, §21.5, §37.2) : forme « SHH-ACCT1 » / « SHH-PROF1 »,
// paliers, contenu JSON strict des deux coffres, fusion des écritures concurrentes, refus d'un gen
// plus petit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CompteError } from "./api";
import {
  creerCoffre,
  ouvrir,
  PALIERS,
  priveDeJson,
  priveEnJson,
  priveVide,
  profilDeJson,
  profilEnJson,
  REGLAGES_DEFAUT,
  sceller,
  type CoffrePrive,
  type Profil,
  type Sorte,
  type Transport,
} from "./vaults";

const V = JSON.parse(readFileSync(new URL("../../../engine/vectors/compte-v3.json", import.meta.url), "utf8"));
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const aes = async (raw: Uint8Array) => crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
const H = new Uint8Array(16).fill(3);

const profil = (p: Partial<Profil> = {}): Profil => ({ pseudo: "Léa", photo: null, langue: "fr", reglages: { ...REGLAGES_DEFAUT }, pass: null, ...p });

describe("forme des coffres (vecteurs)", () => {
  for (const [section, sorte] of [
    ["coffre_prive", "prive"],
    ["coffre_profil", "profil"],
  ] as const) {
    it(`${section} : ouvre chaque vecteur et rend son JSON`, async () => {
      for (const c of V[section]) {
        const key = await aes(unhex(c.cle));
        const blob = await sceller(sorte, key, unhex(c.h), c.gen, unhex(c.json_hex), unhex(c.nonce));
        expect(hex(await ouvrir(sorte, key, unhex(c.h), blob, c.gen)), c.label).toBe(c.json_hex);
      }
    });
  }

  it("refuse : autre sorte, autre h, gen annoncé différent, octet changé, taille hors palier", async () => {
    const c = V.coffre_prive[0];
    const key = await aes(unhex(c.cle));
    const blob = unhex(c.blob);
    const nope = (s: Sorte, h: Uint8Array, b: Uint8Array, g: number) => expect(ouvrir(s, key, h, b, g)).rejects.toThrow("coffre_illisible");
    await nope("profil", unhex(c.h), blob, c.gen);
    await nope("prive", H, blob, c.gen);
    await nope("prive", unhex(c.h), blob, c.gen + 1);
    const bad = blob.slice();
    bad[100]! ^= 1;
    await nope("prive", unhex(c.h), bad, c.gen);
    await nope("prive", unhex(c.h), blob.slice(0, blob.length - 1), c.gen);
  });

  it("paliers 4, 16, 64, 256 Kio : le plus petit qui tient ; au-delà, coffre_trop_grand", async () => {
    expect(PALIERS).toEqual([4096, 16384, 65536, 262144]);
    const key = await aes(new Uint8Array(32).fill(1));
    for (const [n, palier] of [[0, 4096], [4092, 4096], [4093, 16384], [65532, 65536], [65533, 262144], [262140, 262144]] as const) {
      const b = await sceller("profil", key, H, 1, new Uint8Array(n).fill(0x61));
      expect(b.length, String(n)).toBe(palier + 45);
      expect((await ouvrir("profil", key, H, b, 1)).length).toBe(n);
    }
    await expect(sceller("profil", key, H, 1, new Uint8Array(262141))).rejects.toThrow("coffre_trop_grand");
  });
});

describe("contenu du coffre de profil", () => {
  it("aller-retour exact (photo comprise)", () => {
    const p = profil({ photo: new Uint8Array([1, 2, 3, 250]), pass: "jeton-du-pass", reglages: { proposerProfil: false, garderRecus: false } });
    expect(profilDeJson(profilEnJson(p))).toEqual(p);
  });

  it("« garder_salons » retiré (24 novembre) : un coffre ancien qui le porte se lit, et se réécrit sans lui", () => {
    const ancien = new TextEncoder().encode(JSON.stringify({ v: 1, pseudo: "Léa", photo: null, langue: "fr", reglages: { proposer_profil: true, garder_recus: false, garder_salons: true }, pass: null }));
    const p = profilDeJson(ancien);
    expect(p.reglages).toEqual({ proposerProfil: true, garderRecus: false });
    expect(JSON.parse(new TextDecoder().decode(profilEnJson(p))).reglages).toEqual({ proposer_profil: true, garder_recus: false });
  });

  it("une photo de 64 Ko tient dans le palier de 256 Kio", async () => {
    const photo = crypto.getRandomValues(new Uint8Array(65536));
    const key = await aes(new Uint8Array(32).fill(2));
    const b = await sceller("profil", key, H, 1, profilEnJson(profil({ photo })));
    expect(b.length).toBe(262144 + 45);
    expect(profilDeJson(await ouvrir("profil", key, H, b, 1)).photo).toEqual(photo);
  });

  it("photo de plus de 64 Ko, pseudo vide, langue inconnue : refusés à l'écriture", () => {
    expect(() => profilEnJson(profil({ photo: new Uint8Array(65537) }))).toThrow("photo_trop_grande");
    expect(() => profilEnJson(profil({ pseudo: "" }))).toThrow("profil_invalide");
    expect(() => profilEnJson(profil({ langue: "de" }))).toThrow("profil_invalide");
  });

  it("rien du coffre privé dans le profil : seuls v, pseudo, photo, langue, reglages, pass sont écrits", () => {
    const p = { ...profil(), salons: [{ id: "x", s_gestion: "SECRET" }], kCompte: "SECRET" } as unknown as Profil;
    const json = new TextDecoder().decode(profilEnJson(p));
    expect(Object.keys(JSON.parse(json))).toEqual(["v", "pseudo", "photo", "langue", "reglages", "pass"]);
    expect(json).not.toContain("SECRET");
  });

  it("lecture : forme minimale des vecteurs acceptée (défauts) ; version inconnue refusée", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(profilDeJson(enc({ v: 1, pseudo: "Léa", langue: "fr" }))).toEqual(profil());
    expect(() => profilDeJson(enc({ v: 2, pseudo: "Léa", langue: "fr" }))).toThrow("coffre_version");
    expect(() => profilDeJson(enc({ v: 1, langue: "fr" }))).toThrow("coffre_illisible");
    expect(() => profilDeJson(new Uint8Array([0xff]))).toThrow("coffre_illisible");
  });
});

describe("contenu du coffre privé", () => {
  it("vide : forme exacte du vecteur « petit »", () => {
    expect(hex(priveEnJson(priveVide()))).toBe(V.coffre_prive[0].json_hex);
  });

  it("aller-retour ; entrée sans id texte, ou id en double, refusée", () => {
    const p: CoffrePrive = { salons: [{ id: "a", s: 1 }], recus: [], rejoints: [{ id: "b" }], envois: [] };
    expect(priveDeJson(priveEnJson(p))).toEqual(p);
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(() => priveDeJson(enc({ v: 1, salons: [{ s: 1 }], recus: [], rejoints: [], envois: [] }))).toThrow("coffre_illisible");
    expect(() => priveDeJson(enc({ v: 1, salons: [{ id: "a" }, { id: "a" }], recus: [], rejoints: [], envois: [] }))).toThrow("coffre_illisible");
    expect(() => priveDeJson(enc({ v: 3, salons: [], recus: [], rejoints: [], envois: [] }))).toThrow("coffre_version");
  });
});

/** Serveur de coffre en mémoire : if_gen, 409 avec le gen du serveur (§37.2). */
function serveur(sorte: Sorte) {
  const s = { blob: new Uint8Array(0), gen: 0, ecritures: 0 };
  const t: Transport = {
    lire: async () => ({ blob: s.blob, gen: s.gen }),
    ecrire: async (ifGen, blob) => {
      if (ifGen !== s.gen) throw new CompteError(409, "conflict", { gen: s.gen });
      expect(new TextDecoder().decode(blob.slice(0, 9))).toBe(sorte === "prive" ? "SHH-ACCT1" : "SHH-PROF1");
      expect(new DataView(blob.buffer, blob.byteOffset + 9, 8).getBigUint64(0)).toBe(BigInt(ifGen + 1));
      s.blob = blob;
      s.gen = ifGen + 1;
      s.ecritures++;
      return s.gen;
    },
  };
  return { s, t };
}

describe("écritures : fusion sur 409, gen plus petit refusé", () => {
  it("coffre privé : deux appareils écrivent en même temps, les deux ajouts restent", async () => {
    const key = await aes(new Uint8Array(32).fill(4));
    const { s, t } = serveur("prive");
    s.blob = await sceller("prive", key, H, 1, priveEnJson(priveVide()));
    s.gen = 1;
    const opts = { sorte: "prive" as const, cle: key, h: H, transport: t, versJson: priveEnJson, deJson: priveDeJson };
    const a = creerCoffre({ ...opts, valeur: priveVide(), gen: 1 });
    const b = creerCoffre({ ...opts, valeur: priveVide(), gen: 1 });
    await Promise.all([
      a.ecrire((p) => ({ ...p, recus: [...p.recus, { id: "lien-a" }] })),
      b.ecrire((p) => ({ ...p, salons: [...p.salons, { id: "salon-b" }] })),
    ]);
    const fin = priveDeJson(await ouvrir("prive", key, H, s.blob, s.gen));
    expect(fin.recus.map((e) => e.id)).toEqual(["lien-a"]);
    expect(fin.salons.map((e) => e.id)).toEqual(["salon-b"]);
    expect(s.gen).toBe(3);
  });

  it("coffre de profil : deux écritures concurrentes de champs différents sont fusionnées", async () => {
    const key = await aes(new Uint8Array(32).fill(5));
    const { s, t } = serveur("profil");
    s.blob = await sceller("profil", key, H, 1, profilEnJson(profil()));
    s.gen = 1;
    const opts = { sorte: "profil" as const, cle: key, h: H, transport: t, versJson: profilEnJson, deJson: profilDeJson };
    const a = creerCoffre({ ...opts, valeur: profil(), gen: 1 });
    const b = creerCoffre({ ...opts, valeur: profil(), gen: 1 });
    await Promise.all([a.ecrire((p) => ({ ...p, langue: "en" })), b.ecrire((p) => ({ ...p, pseudo: "Zoé" }))]);
    const fin = profilDeJson(await ouvrir("profil", key, H, s.blob, s.gen));
    expect(fin.langue).toBe("en");
    expect(fin.pseudo).toBe("Zoé");
  });

  it("gen plus petit que le plus grand vu : refusé (coffre_recule), rien n'est écrit", async () => {
    const key = await aes(new Uint8Array(32).fill(6));
    const { s, t } = serveur("prive");
    s.blob = await sceller("prive", key, H, 4, priveEnJson(priveVide()));
    s.gen = 4;
    const c = creerCoffre({ sorte: "prive", cle: key, h: H, transport: t, versJson: priveEnJson, deJson: priveDeJson, valeur: priveVide(), gen: 5 });
    await expect(c.relire()).rejects.toThrow("coffre_recule");
    // 409 avec un gen plus petit : même refus, aucune écriture.
    await expect(c.ecrire((p) => p)).rejects.toThrow("coffre_recule");
    expect(s.ecritures).toBe(0);
  });

  it("une erreur autre qu'un conflit passe telle quelle, sans nouvel essai", async () => {
    const key = await aes(new Uint8Array(32).fill(7));
    let n = 0;
    const t: Transport = { lire: async () => ({ blob: new Uint8Array(0), gen: 0 }), ecrire: async () => (n++, Promise.reject(new CompteError(429, "limit", { retryAfterS: 60 }))) };
    const c = creerCoffre({ sorte: "prive", cle: key, h: H, transport: t, versJson: priveEnJson, deJson: priveDeJson, valeur: priveVide(), gen: 1 });
    await expect(c.ecrire((p) => p)).rejects.toThrow("limit");
    expect(n).toBe(1);
  });
});

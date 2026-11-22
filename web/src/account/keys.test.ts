// Clés du compte (conception 2026-11-22-compte-passkey-design.md §5) : enveloppes PRF et de
// récupération, clés des coffres, rejouées par keys.ts (moteur + WebCrypto) sur
// engine/vectors/compte-v3.json (sections enveloppe_prf, recup, cles, coffre_prive, coffre_profil).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aleatoire32, clesDuCompte, enveloppePrf, enveloppeRecup, ouvrir, ouvrirEnveloppesPrf, ouvrirRecup, sceller } from "./keys";
import { sceller as scellerCoffre } from "./vaults";

const V = JSON.parse(readFileSync(new URL("../../../engine/vectors/compte-v3.json", import.meta.url), "utf8"));
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)));
type Cas = Record<string, string> & { error?: string };

describe("enveloppes PRF (vecteurs « enveloppe_prf »)", () => {
  const cas = (V.enveloppe_prf as Cas[]).filter((c) => !c.error);

  it("scelle exactement le vecteur (60 octets) et l'ouvre avec la sortie PRF", async () => {
    expect(cas.length).toBeGreaterThan(0);
    for (const c of cas) {
      const env = await enveloppePrf(unhex(c.p), unhex(c.h), unhex(c.cred_id), unhex(c.k_compte), unhex(c.nonce));
      expect(env.length).toBe(60);
      expect(hex(env), c.label).toBe(c.env);
      expect(hex((await ouvrirEnveloppesPrf(unhex(c.p), unhex(c.h), unhex(c.cred_id), [unhex(c.env)]))!), c.label).toBe(c.k_compte);
    }
  });

  it("plusieurs enveloppes : la première qui s'ouvre ; aucune (autre sortie PRF, autre passkey, autre compte) : null", async () => {
    const c = cas[0]!;
    const [p, h, id, env] = [unhex(c.p), unhex(c.h), unhex(c.cred_id), unhex(c.env)];
    const autre = new Uint8Array(60).fill(5);
    expect(hex((await ouvrirEnveloppesPrf(p, h, id, [autre, env]))!)).toBe(c.k_compte);
    expect(await ouvrirEnveloppesPrf(p, h, id, [])).toBeNull();
    expect(await ouvrirEnveloppesPrf(new Uint8Array(32).fill(1), h, id, [env])).toBeNull();
    const id2 = id.slice();
    id2[0]! ^= 1;
    expect(await ouvrirEnveloppesPrf(p, h, id2, [env])).toBeNull();
    expect(await ouvrirEnveloppesPrf(p, new Uint8Array(16), id, [env])).toBeNull();
    expect(await ouvrirEnveloppesPrf(p, h, id, [env.slice(0, 59)])).toBeNull();
  });

  it("cred_id hors bornes : cred_id_invalide (moteur)", async () => {
    for (const c of (V.enveloppe_prf as Cas[]).filter((x) => x.error)) {
      await expect(enveloppePrf(new Uint8Array(32), unhex(c.h), new Uint8Array(Number(c.cred_id_len)), aleatoire32()), c.label).rejects.toThrow(c.error);
    }
  });
});

describe("enveloppe de récupération (vecteurs « recup »)", () => {
  it("Env_r exacte, rouverte par KEK_r ; A_r ne l'ouvre pas ; tout défaut : enveloppe_invalide", async () => {
    for (const c of V.recup as Cas[]) {
      const env = await enveloppeRecup(unhex(c.kek_r), unhex(c.h), unhex(c.k_compte), unhex(c.nonce));
      expect(hex(env), c.label).toBe(c.env_r);
      expect(hex(await ouvrirRecup(unhex(c.kek_r), unhex(c.h), env))).toBe(c.k_compte);
      await expect(ouvrirRecup(unhex(c.a_r), unhex(c.h), env)).rejects.toThrow("enveloppe_invalide");
      await expect(ouvrirRecup(unhex(c.kek_r), new Uint8Array(16), env)).rejects.toThrow("enveloppe_invalide");
    }
  });

  it("sans nonce donné : nonce aléatoire, deux enveloppes différentes qui s'ouvrent", async () => {
    const kek = aleatoire32();
    const ad = new Uint8Array(9).fill(7);
    const k = aleatoire32();
    const a = await sceller(kek, ad, k);
    const b = await sceller(kek, ad, k);
    expect(hex(a)).not.toBe(hex(b));
    expect(hex(await ouvrir(kek, ad, b))).toBe(hex(k));
    const bad = b.slice();
    bad[30]! ^= 1;
    await expect(ouvrir(kek, ad, bad)).rejects.toThrow("enveloppe_invalide");
  });
});

describe("clés des coffres (vecteurs « cles », « coffre_prive », « coffre_profil »)", () => {
  it("K_prive, K_profil (de K_compte) et K_etiquette, non extractibles, scellent exactement les coffres des vecteurs", async () => {
    for (const [section, cle] of [
      ["coffre_prive", "prive"],
      ["coffre_profil", "profil"],
    ] as const) {
      for (const c of V[section]) {
        const src = V.cles.find((x: Cas) => x.label === c.cles);
        const k = await clesDuCompte(unhex(src.k_compte));
        expect(k[cle].extractable).toBe(false);
        expect(k.etiquette.extractable).toBe(false);
        const blob = await scellerCoffre(cle, k[cle], unhex(c.h), c.gen, unhex(c.json_hex), unhex(c.nonce));
        expect(blob.length, c.label).toBe(c.blob_len);
        expect(await sha(blob), c.label).toBe(c.blob_sha256);
      }
    }
  });

  it("aleatoire32 : 32 octets tirés par crypto.getRandomValues", () => {
    const a = aleatoire32();
    expect(a.length).toBe(32);
    expect(hex(a)).not.toBe(hex(aleatoire32()));
  });
});

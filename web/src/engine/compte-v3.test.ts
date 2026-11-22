// Compte par passkey et clé de récupération (conception 2026-11-22-compte-passkey-design.md §5,
// §14) : engine/vectors/compte-v3.json rejoué par le build WebAssembly sous Node (le pseudo par
// le module du salon), à partir des seules entrées du fichier ; dérivations recalculées à part
// (HKDF de WebCrypto, SHA-256 de node:crypto) ; enveloppes et coffres refaits et ouverts par
// WebCrypto, comme le site le fera (le fichier est écrit par le moteur avec l'AES-256-GCM natif
// des apps : mêmes octets attendus).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadEngine, type Wasm } from "./load";
import { loadSalonEngine, type SalonEngine } from "../salon/engine";

const V = JSON.parse(readFileSync(new URL("../../../engine/vectors/compte-v3.json", import.meta.url), "utf8"));
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (s: string) => Buffer.from(s, "hex").toString("utf8");
const utf8 = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p));

let W: Wasm;
let S: SalonEngine;
beforeAll(async () => {
  W = (await loadEngine()).wasm;
  S = await loadSalonEngine();
});

/** Résultat ou message d'erreur d'un appel. */
function out<T>(f: () => T): { ok: T } | { error: string } {
  try {
    return { ok: f() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function hkdf(ikm: Uint8Array, info: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) }, k, 256)));
}

async function aesSeal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer>, additionalData: ad as Uint8Array<ArrayBuffer> }, k, plain as Uint8Array<ArrayBuffer>));
  return cat(nonce, ct);
}

async function aesOpen(key: Uint8Array, ad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: ad as Uint8Array<ArrayBuffer> }, k, sealed.slice(12)));
}

describe("compte-v3.json : rejoué par le moteur WebAssembly et WebCrypto", () => {
  it("constants : E_prf du moteur, E_prf et sel_prf recalculés par node:crypto", () => {
    const c = V.constants;
    expect(hex(W.entreePrf())).toBe(c.entree_prf);
    expect(sha(utf8(c.etiquettes.entree_prf))).toBe(c.entree_prf);
    expect(sha(cat(utf8("WebAuthn PRF\0"), unhex(c.entree_prf)))).toBe(c.sel_prf);
    expect(c.enveloppe_len).toBe(60);
  });

  it("enveloppe_prf : KEK_i, AD, enveloppe de 60 octets refaite et ouverte par WebCrypto", async () => {
    expect(V.enveloppe_prf.length).toBeGreaterThanOrEqual(6);
    for (const c of V.enveloppe_prf) {
      const h = unhex(c.h);
      if (c.error) {
        expect(out(() => W.adEnveloppePrf(h, new Uint8Array(c.cred_id_len).fill(1))), c.label).toEqual({ error: c.error });
        continue;
      }
      const p = unhex(c.p);
      const cred = unhex(c.cred_id);
      expect(hex(W.kekPrf(p)), c.label).toBe(c.kek);
      expect(await hkdf(p, V.constants.etiquettes.kek_prf)).toBe(c.kek);
      const ad = cat(utf8("SHH-CENV2"), h, unhex(sha(cred)));
      expect(hex(ad)).toBe(c.ad);
      expect(hex(W.adEnveloppePrf(h, cred))).toBe(c.ad);
      const env = await aesSeal(unhex(c.kek), unhex(c.nonce), ad, unhex(c.k_compte));
      expect(hex(env), c.label).toBe(c.env);
      expect(hex(await aesOpen(unhex(c.kek), ad, env))).toBe(c.k_compte);
      // Liée à sa passkey : un autre cred_id ne l'ouvre pas.
      const autre = cred.slice();
      autre[0] ^= 1;
      await expect(aesOpen(unhex(c.kek), W.adEnveloppePrf(h, autre), env)).rejects.toThrow();
    }
  });

  it("cle_recup.texte : affichage du moteur, groupes 4 × 6 + 3", () => {
    for (const c of V.cle_recup.texte) {
      const a = W.cleRecupAffichage(unhex(c.r));
      expect(a, c.label).toBe(c.affichage);
      expect(a.split("-").map((g: string) => g.length)).toEqual([4, 4, 4, 4, 4, 4, 3]);
      expect(a.replaceAll("-", "")).toBe(c.texte);
      expect(hex(W.cleRecupLire(utf8(c.texte))), c.label).toBe(c.r);
    }
  });

  it("cle_recup.saisie (≥ 30 cas) : clé lue ou erreur exacte", () => {
    expect(V.cle_recup.saisie.length).toBeGreaterThanOrEqual(30);
    for (const c of V.cle_recup.saisie) {
      const got = out(() => hex(W.cleRecupLire(unhex(c.entree_hex))));
      expect(got, c.label).toEqual(c.error ? { error: c.error } : { ok: c.r });
    }
  });

  it("recup : A_r, v_r = SHA-256(A_r), KEK_r, Env_r refaite et ouverte par WebCrypto", async () => {
    for (const c of V.recup) {
      const r = unhex(c.r);
      const d = W.cleRecupDerivees(r);
      expect(hex(d.aR)).toBe(c.a_r);
      expect(hex(d.vR)).toBe(c.v_r);
      expect(hex(d.kekR)).toBe(c.kek_r);
      expect(await hkdf(r, V.constants.etiquettes.a_r)).toBe(c.a_r);
      expect(await hkdf(r, V.constants.etiquettes.kek_r)).toBe(c.kek_r);
      expect(sha(unhex(c.a_r))).toBe(c.v_r);
      const ad = cat(utf8("SHH-CENV2"), unhex(c.h), utf8("recup"));
      expect(hex(W.adEnveloppeRecup(unhex(c.h)))).toBe(hex(ad));
      expect(hex(ad)).toBe(c.ad);
      const env = await aesSeal(unhex(c.kek_r), unhex(c.nonce), ad, unhex(c.k_compte));
      expect(hex(env)).toBe(c.env_r);
      expect(hex(await aesOpen(unhex(c.kek_r), ad, env))).toBe(c.k_compte);
      // A_r, seul envoyé au serveur, n'ouvre pas l'enveloppe.
      await expect(aesOpen(unhex(c.a_r), ad, env)).rejects.toThrow();
    }
  });

  it("cles : K_prive, K_profil (de K_compte), K_etiquette par le moteur et par WebCrypto", async () => {
    const e = V.constants.etiquettes;
    for (const c of V.cles) {
      const k = unhex(c.k_compte);
      expect(hex(W.clePrive(k))).toBe(c.k_prive);
      expect(hex(W.cleProfilCompte(k))).toBe(c.k_profil);
      expect(hex(W.cleAppareil(k))).toBe(c.k_etiquette);
      expect(await hkdf(k, e.k_prive)).toBe(c.k_prive);
      expect(await hkdf(k, e.k_profil)).toBe(c.k_profil);
      expect(await hkdf(k, e.k_etiquette)).toBe(c.k_etiquette);
    }
    for (const n of [31, 33, 0]) {
      expect(out(() => W.cleProfilCompte(new Uint8Array(n)))).toEqual({ error: "clé ou sel de taille invalide" });
      expect(out(() => W.kekPrf(new Uint8Array(n)))).toEqual({ error: "clé ou sel de taille invalide" });
    }
    for (const n of [15, 17, 0]) {
      expect(out(() => W.cleRecupAffichage(new Uint8Array(n)))).toEqual({ error: "clé ou sel de taille invalide" });
      expect(out(() => W.adEnveloppeRecup(new Uint8Array(n)))).toEqual({ error: "clé ou sel de taille invalide" });
    }
  });

  for (const [section, magie, champ] of [
    ["coffre_profil", "SHH-PROF1", "k_profil"],
    ["coffre_prive", "SHH-ACCT1", "k_prive"],
  ] as const) {
    it(`${section} : « ${magie} » refait par WebCrypto avec la clé de cles.${champ}`, async () => {
      expect(V[section].length).toBeGreaterThanOrEqual(2);
      for (const c of V[section]) {
        expect(c.cle).toBe(V.cles.find((x: { label: string }) => x.label === c.cles)[champ]);
        const gen = new Uint8Array(8);
        new DataView(gen.buffer).setBigUint64(0, BigInt(c.gen));
        const ad = cat(utf8(magie), unhex(c.h), gen);
        expect(hex(ad)).toBe(c.ad);
        const json = unhex(c.json_hex);
        const clair = new Uint8Array(c.palier);
        new DataView(clair.buffer).setUint32(0, json.length);
        clair.set(json, 4);
        const blob = cat(utf8(magie), gen, await aesSeal(unhex(c.cle), unhex(c.nonce), ad, clair));
        expect(blob.length, c.label).toBe(c.blob_len);
        expect(sha(blob), c.label).toBe(c.blob_sha256);
        if (c.blob) expect(hex(blob)).toBe(c.blob);
      }
    });
  }

  it("pseudo (≥ 30 cas) : affichage, p_canon, réservé, ou erreur exacte (module du salon)", () => {
    expect(V.pseudo.length).toBeGreaterThanOrEqual(30);
    for (const c of V.pseudo) {
      const got = out(() => {
        const a = S.pseudoValide(text(c.entree_hex));
        const p = S.cleUnicite(a);
        return { affiche_hex: hex(utf8(a)), p_canon_hex: hex(utf8(p)), reserve: S.pseudoReserve(p) };
      });
      if (c.error) expect(got, c.label).toEqual({ error: c.error });
      else expect(got, c.label).toEqual({ ok: { affiche_hex: c.affiche_hex, p_canon_hex: c.p_canon_hex, reserve: c.reserve } });
    }
  });
});

// Partage sans mot de passe (D42-27) : engine/vectors/v6-sans-mdp.json, produit par le moteur
// Rust (engine/core/tests/sans_mdp.rs), rejoué ici par le build WebAssembly avec le fournisseur
// WebCrypto du site, et pour les liens par la partie TypeScript (pure.ts, app/link.ts) : mêmes
// sorties, mêmes refus, à partir des seules entrées du fichier.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { readLink, readShare } from "../app/link";
import { loadEngine, type Engine, type Wasm } from "./load";
import { createProvider, type WebCryptoProvider } from "./provider";
import * as P from "./pure";

const V = JSON.parse(readFileSync(new URL("../../../engine/vectors/v6-sans-mdp.json", import.meta.url), "utf8"));
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

let E: Engine;
let W: Wasm;
beforeAll(async () => {
  E = await loadEngine();
  W = E.wasm;
});

function out<T>(f: () => T): { ok: T } | { error: string } {
  try {
    return { ok: f() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Fournisseur WebCrypto réel dont l'aléa rejoue `draws` ; copie des clés brutes importées. */
function replay(draws: Uint8Array[]): { p: WebCryptoProvider; imports: Uint8Array[] } {
  const real = createProvider();
  const q = [...draws];
  const imports: Uint8Array[] = [];
  const p: WebCryptoProvider = {
    ...real,
    random(n: number) {
      const d = q.shift();
      if (!d || d.length !== n) throw new Error("tirage inattendu");
      return new Uint8Array(d);
    },
    async aesImport(raw: Uint8Array) {
      imports.push(new Uint8Array(raw));
      return real.aesImport(raw);
    },
  };
  return { p, imports };
}

type Parsed = { kind: string; origin: string; key: string; no_password?: boolean } | { error: string };

/** Lecture par le moteur, au format du fichier. */
function engineParse(url: string, base: string): Parsed {
  const r = out(() => W.parseLink(utf8(url), base));
  if ("error" in r) return r;
  const p = r.ok;
  return p.kind === "s" ? { kind: "s", origin: p.origin, key: hex(p.kLien), no_password: p.noPassword } : { kind: "m", origin: p.origin, key: hex(p.sGestion) };
}

/** Lecture de forme par pure.ts (clé décodée ici pour le test seulement). */
function pureParse(url: string, base: string): Parsed {
  const r = out(() => P.linkForm(url, base));
  if ("error" in r) return r;
  const f = r.ok;
  const key = hex(P.unb64u(f.key));
  return f.kind === "s" ? { kind: "s", origin: f.origin, key, no_password: f.noPassword } : { kind: "m", origin: f.origin, key };
}

describe("v6-sans-mdp.json : liens (D42-27)", () => {
  it("constantes : étiquette HKDF, marque du fragment, taille de E", () => {
    expect(V.constants).toEqual({ ENVELOPE_LEN: 60, NO_PASSWORD_INFO: "shhdrop/v2/sans-mdp", NO_PASSWORD_MARK: "l" });
    expect(P.NO_PASSWORD_MARK).toBe(V.constants.NO_PASSWORD_MARK);
  });

  it("lien écrit par le moteur (avec et sans mot de passe), relu par le moteur et par linkForm", () => {
    for (const c of V.links.written) {
      const key = unhex(c.key);
      const link = String(c.fn === "shareLinkNoPassword" ? W.shareLinkNoPassword(V.links.origin, key, c.base) : W.shareLink(V.links.origin, key, c.base));
      expect(link, c.label).toBe(c.link);
      expect(engineParse(link, c.base), c.label).toEqual(c.parsed);
      expect(pureParse(link, c.base), c.label).toEqual(c.parsed);
      expect(P.isNoPasswordLink(link), c.label).toBe(c.fn === "shareLinkNoPassword");
      if (c.base === "/" && c.fn === "shareLinkNoPassword") expect(link, c.label).toMatch(P.NO_PASSWORD_LINK_SHAPE);
      if (c.base === "/" && c.fn === "shareLink") expect(link, c.label).toMatch(P.SHARE_LINK_SHAPE);
    }
  });

  it("lecture : ancien lien (avec mot de passe) toujours lu, formes abîmées refusées, même verdict moteur et pure.ts", () => {
    let ok = 0;
    for (const c of V.links.parse) {
      expect(engineParse(c.url, c.base), c.label).toEqual(c.result);
      expect(pureParse(c.url, c.base), c.label).toEqual(c.result);
      if (!("error" in c.result)) ok++;
    }
    expect(ok).toBe(6);
  });

  it("QR code : jamais de mot de passe dans un lien sans mot de passe (moteur et pure.ts)", () => {
    for (const c of V.links.qr) {
      const eng = out(() => String(W.shareLinkWithPassword(utf8(c.link), utf8(c.password))));
      expect(eng, c.label).toEqual(c.link_with_password);
      expect(out(() => P.shareLinkWithPassword(c.link, c.password)), c.label).toEqual(c.link_with_password);
      expect(W.splitPassword(utf8(c.link)), c.label).toEqual(c.split);
      expect(P.splitPassword(c.link), c.label).toEqual(c.split);
    }
  });

  it("app/link.ts garde la marque « l » (readLink, readShare) ; l'ancien lien reste sans marque", () => {
    for (const c of V.links.written) {
      const s = readLink(c.link, "s", c.base);
      expect(s, c.label).toEqual({ kind: "s", link: `${V.links.origin}/s#${c.link.slice(c.link.indexOf("#") + 1)}` });
      expect(readShare(c.link, c.base), c.label).toEqual({ state: s, password: null });
      expect(readLink(c.link, "m", c.base), c.label).toEqual({ kind: "incomplete" });
    }
  });
});

describe("v6-sans-mdp.json : dérivations (D42-27)", () => {
  it("K_sans, K_accès, id, K_preuve, V_preuve, en-tête et E de chaque cas ; E rouverte par le lien seul", async () => {
    for (const c of V.keys) {
      const kLien = unhex(c.k_lien);
      const kSans = W.noPasswordKey(kLien);
      expect(hex(kSans), c.label).toBe(c.k_sans);
      // HKDF-SHA-256 à sel vide, étiquette exacte : même valeur par WebCrypto.
      const base = await crypto.subtle.importKey("raw", kLien, "HKDF", false, ["deriveBits"]);
      const viaWebCrypto = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8("shhdrop/v2/sans-mdp") }, base, 256));
      expect(hex(viaWebCrypto), c.label).toBe(c.k_sans);
      const a = W.deriveAccess(kLien);
      expect([hex(a.kAcces), hex(a.vAcces)], c.label).toEqual([c.k_acces, c.v_acces]);
      const id = W.shareId(kLien);
      expect(hex(id), c.label).toBe(c.id);
      // Chaîne écrite à la main dans le vecteur : K_maître, K_env (non extractible : comparée à l'import).
      expect(hex(W.hkdf(new Uint8Array([...kLien, ...kSans]), "shhdrop/v2/maitre", 32)), c.label).toBe(c.k_maitre);
      expect(hex(W.hkdf(unhex(c.k_maitre), "shhdrop/v2/enveloppe", 32)), c.label).toBe(c.k_env);
      const t = replay([unhex(c.r), unhex(c.envelope_nonce)]);
      const seed = W.newSeed(t.p);
      const keys = await W.contentKeys(seed);
      expect(hex(keys.engagement), c.label).toBe(c.engagement);
      const header = W.header(keys.engagement);
      expect(hex(header), c.label).toBe(c.header);
      const ak = await W.accessKeys(t.p, kLien, kSans);
      expect(hex(t.imports[1]!), `${c.label} : K_env importée`).toBe(c.k_env);
      expect([hex(ak.kPreuve), hex(ak.vPreuve)], c.label).toEqual([c.k_preuve, c.v_preuve]);
      const env = await W.seal(ak, seed, id, header);
      expect(hex(env), c.label).toBe(c.envelope);
      expect(env.length).toBe(V.constants.ENVELOPE_LEN);
      // Ouverture par le lien seul : K_sans recalculée, R rendue, engagement vérifié.
      const ak2 = await W.accessKeys(createProvider(), kLien, W.noPasswordKey(kLien));
      const r2 = await W.open(ak2, unhex(c.envelope), id, header);
      await W.contentKeysChecked(r2, keys.engagement);
      expect(hex(W.seedBytes(r2)), c.label).toBe(c.r);
      // Une autre K_mdp (un mot de passe quelconque) ne rouvre pas E.
      const ak3 = await W.accessKeys(createProvider(), kLien, new Uint8Array(32).fill(7));
      await expect(W.open(ak3, unhex(c.envelope), id, header)).rejects.toThrow("paquet_corrompu");
    }
  });
});

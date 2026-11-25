// « Le serveur ne voit rien » pour un partage SANS mot de passe (D42-27) — BLOQUANT comme
// sees-nothing.test.ts. Vrai serveur Go, vrai client du site, vrai moteur WebAssembly.
//
// Un partage protégé et un partage sans mot de passe sont créés, ouverts et détruits l'un après
// l'autre. On vérifie :
// - le serveur reçoit les mêmes routes, les mêmes champs, de mêmes tailles, pour les deux sortes
//   (rien ne lui dit lequel a un mot de passe) ; `meta` rend la même forme ;
// - aucune requête ne porte la marque du fragment (le lien « #l… » entier), K_lien, K_sans,
//   K_maître, K_env, R ni le contenu ; rien de cela sur disque, dans les journaux ni dans la
//   mémoire du serveur ;
// - le lien seul ouvre le partage sans mot de passe ; un ancien lien (avec mot de passe) exige
//   toujours le mot de passe ; un lien sans mot de passe tronqué de sa marque ne s'ouvre pas.
import { createHash, hkdfSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { b64u, concat, generatePassword, utf8, type KLien } from "../src/engine/pure";

// Graines R tirées par createShare (copie gardée pendant newSeed, comme sees-nothing.test.ts).
const seeds = vi.hoisted(() => ({ list: [] as Uint8Array<ArrayBuffer>[], on: false }));
vi.mock("../src/engine/provider", async (orig) => {
  const m = await orig<typeof import("../src/engine/provider")>();
  return {
    ...m,
    createProvider: () => {
      const p = m.createProvider();
      return {
        ...p,
        random: (n: number) => {
          const b = p.random(n);
          if (n === 32 && seeds.on) seeds.list.push(new Uint8Array(b));
          return b;
        },
      };
    },
  };
});
vi.mock("../src/engine/index", async (orig) => {
  const m = await orig<typeof import("../src/engine/index")>();
  return {
    ...m,
    newSeed: async () => {
      seeds.on = true;
      try {
        return await m.newSeed();
      } finally {
        seeds.on = false;
      }
    },
  };
});
import { deriveAccess, isNoPasswordLink, parseLink } from "../src/engine";
import { BadPasswordError, createShare, destroyShare, openShare, shareStatus } from "../src/transfer/client";
import { solveAltcha } from "./altcha";
import { capturingFetch, findIn, needle, scanDir, scanProcessMemory, type Captured, type Needle } from "./scan";
import { startServer, type TestServer } from "./server";

const MARKER = "SANS-MDP-REPERE-4c1e";
const NAME = "fichier-sans-mdp-repere.pdf";
const hk = (ikm: Uint8Array, info: string) => new Uint8Array(hkdfSync("sha256", ikm, new Uint8Array(0), info, 32));
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

type Shape = Record<string, unknown>;
/** Forme d'un corps ou d'une réponse JSON : clés triées, et pour chaque valeur son type et sa taille. */
function shape(buf: Buffer): Shape {
  if (buf.length === 0) return {};
  const o = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => {
        const v = o[k];
        return [k, typeof v === "string" ? `string(${v.length})` : Array.isArray(v) ? `array(${v.length})` : typeof v];
      }),
  );
}

describe("partage sans mot de passe : le serveur ne voit rien et ne distingue pas les deux sortes (D42-27)", () => {
  let srv: TestServer;
  const logProtected: Captured[] = [];
  const logOpen: Captured[] = [];
  const fetchProtected = capturingFetch(logProtected);
  const fetchOpen = capturingFetch(logOpen);
  const PASSWORD = generatePassword();
  let link: string; // lien « #l… » du partage sans mot de passe
  let protectedLink: string;
  let kLien: KLien;
  let secrets: Needle[];

  beforeAll(async () => {
    srv = await startServer();
    const items = () => [
      { kind: "text" as const, name: "", mime: "text/plain", data: utf8(`texte ${MARKER} texte`) },
      { kind: "file" as const, name: NAME, mime: "application/pdf", data: new Uint8Array(200_000).map((_, i) => (i * 31 + 3) & 255) },
    ];
    const base = { ttlHours: 1, maxOpens: 2, solveCaptcha: solveAltcha };
    const rp = await createShare(srv.origin, items(), { ...base, password: PASSWORD, fetch: fetchProtected });
    protectedLink = rp.link;
    const r = await createShare(srv.origin, items(), { ...base, password: null, fetch: fetchOpen });
    link = r.link;
    expect(isNoPasswordLink(link)).toBe(true);
    expect(isNoPasswordLink(protectedLink)).toBe(false);
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s#l[A-Za-z0-9_-]{43}$/);
    const p = await parseLink(link);
    if (p.kind !== "s") throw new Error("lien de partage attendu");
    expect(p.noPassword).toBe(true);
    kLien = p.kLien;

    // Le lien seul ouvre : aucun mot de passe (le champ passé est ignoré).
    const o = await openShare(link, "", srv.origin, undefined, { fetch: fetchOpen });
    expect(o.manifest.items[0]!.text).toBe(`texte ${MARKER} texte`);
    expect(o.manifest.items[1]!.name).toBe(NAME);
    await o.done();
    const op = await openShare(protectedLink, PASSWORD, srv.origin, undefined, { fetch: fetchProtected });
    await op.done();
    // Statut, puis destruction par le lien de gestion (identiques pour les deux sortes).
    await shareStatus(r.manage, srv.origin, { fetch: fetchOpen });
    await shareStatus(rp.manage, srv.origin, { fetch: fetchProtected });
    await destroyShare(r.manage, srv.origin, { fetch: fetchOpen });
    await destroyShare(rp.manage, srv.origin, { fetch: fetchProtected });

    expect(seeds.list).toHaveLength(2);
    const r1 = seeds.list[1]!; // R du partage sans mot de passe (créé en second)
    const kSans = hk(kLien, "shhdrop/v2/sans-mdp");
    const kMaitre = hk(concat(kLien, kSans), "shhdrop/v2/maitre");
    const frag = link.slice(link.indexOf("#"));
    secrets = [
      needle("lien entier", link),
      needle("fragment « #l… »", frag),
      needle("fragment sans « # »", frag.slice(1)),
      needle("K_lien", kLien),
      needle("K_lien (base64url)", b64u(kLien)),
      needle("K_sans", kSans),
      needle("K_maître", kMaitre),
      needle("K_env", hk(kMaitre, "shhdrop/v2/enveloppe")),
      needle("R", r1),
      needle("K_contenu", hk(r1, "shhdrop/v2/contenu")),
      needle("texte repère", MARKER),
      needle("nom repère", NAME),
    ];
  });
  afterAll(async () => {
    await srv?.dispose();
  });

  it("mêmes routes, dans le même ordre, pour les deux sortes de partage", () => {
    const routes = (l: Captured[]) => l.map((r) => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "")}`);
    expect(routes(logOpen)).toEqual(routes(logProtected));
    expect(routes(logOpen)).toContain("POST /api/shares/finalize");
    expect(routes(logOpen)).toContain("POST /api/shares/unlock");
  });

  it("finalize, meta et unlock : mêmes champs et mêmes tailles avec et sans mot de passe", () => {
    const pick = (l: Captured[], end: string) => l.find((r) => r.url.split("?")[0]!.endsWith(end))!;
    // Création : corps fait du palier et de la preuve anti-robot (longueur variable), seulement les clés.
    expect(Object.keys(shape(pick(logOpen, "/api/shares").body))).toEqual(Object.keys(shape(pick(logProtected, "/api/shares").body)));
    for (const end of ["/api/shares/finalize"]) {
      expect(shape(pick(logOpen, end).body), end).toEqual(shape(pick(logProtected, end).body));
    }
    const fin = JSON.parse(pick(logOpen, "/api/shares/finalize").body.toString("utf8")) as Record<string, unknown>;
    // Un sel de 16 octets et les paramètres Argon2id de création partent aussi sans mot de passe.
    expect(Buffer.from(fin.salt as string, "base64url")).toHaveLength(16);
    expect([fin.kdf_ops, fin.kdf_mem]).toEqual([3, 67_108_864]);
    expect(Buffer.from(fin.proof_v as string, "base64url")).toHaveLength(32);
    expect(Buffer.from(fin.envelope as string, "base64url")).toHaveLength(60);
    for (const end of ["/api/shares/meta", "/api/shares/unlock"]) {
      const a = pick(logOpen, end), b = pick(logProtected, end);
      expect(shape(a.response), `${end} : réponse`).toEqual(shape(b.response));
      expect(shape(a.body), `${end} : corps`).toEqual(shape(b.body));
      expect(a.headers.map(([k]) => k).sort(), `${end} : en-têtes`).toEqual(b.headers.map(([k]) => k).sort());
    }
  });

  it("aucune requête ne porte la marque, le lien, K_lien, K_sans, K_maître, K_env, R ni le contenu", () => {
    const hits: string[] = [];
    for (const r of logOpen) {
      const where = `${r.method} ${r.url}`;
      for (const l of findIn(Buffer.from(r.url), secrets)) hits.push(`${where} URL : ${l}`);
      for (const l of findIn(r.body, secrets)) hits.push(`${where} corps : ${l}`);
      for (const l of findIn(r.response, secrets)) hits.push(`${where} réponse : ${l}`);
      for (const [k, v] of r.headers) for (const l of findIn(Buffer.from(`${k}: ${v}`), secrets)) hits.push(`${where} en-tête ${k} : ${l}`);
    }
    expect(hits).toEqual([]);
  });

  it("disque, journaux et mémoire du serveur : aucun repère", async () => {
    expect(scanDir(srv.dataDir, secrets)).toEqual([]);
    const mem = await scanProcessMemory(srv.pid, secrets);
    if (mem.ok) expect(mem.hits).toEqual([]);
    else if (process.env.CI) throw new Error(`fouille mémoire obligatoire en CI : ${mem.why}`);
    await srv.stop();
    expect(findIn(srv.stdout(), secrets)).toEqual([]);
    expect(findIn(srv.stderr(), secrets)).toEqual([]);
    expect(scanDir(srv.dataDir, secrets)).toEqual([]);
  });
});

describe("compatibilité et lien abîmé (D42-27)", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  });
  afterAll(async () => {
    await srv?.dispose();
  });

  it("ancien lien (protégé) : le mot de passe reste exigé, un faux compte un essai ; le bon ouvre", async () => {
    const pw = generatePassword();
    const r = await createShare(srv.origin, [{ kind: "text", name: "", mime: "text/plain", data: utf8("ancien") }], { ttlHours: 1, maxOpens: 1, password: pw, solveCaptcha: solveAltcha });
    expect(isNoPasswordLink(r.link)).toBe(false);
    await expect(openShare(r.link, "", srv.origin)).rejects.toThrow("mot_de_passe_requis");
    await expect(openShare(r.link, "Ab3!cD5?#Fg", srv.origin)).rejects.toBeInstanceOf(BadPasswordError);
    const o = await openShare(r.link, pw, srv.origin);
    expect(o.manifest.items[0]!.text).toBe("ancien");
    await o.done();
  });

  it("lien sans mot de passe privé de sa marque : lu comme protégé, il ne s'ouvre pas sans le bon mot de passe ; le lien entier ouvre", async () => {
    const r = await createShare(srv.origin, [{ kind: "text", name: "", mime: "text/plain", data: utf8("sans") }], { ttlHours: 1, maxOpens: 1, password: null, solveCaptcha: solveAltcha });
    const stripped = r.link.replace("#l", "#");
    expect(isNoPasswordLink(stripped)).toBe(false);
    await expect(openShare(stripped, "", srv.origin)).rejects.toThrow("mot_de_passe_requis");
    await expect(openShare(stripped, "Ab3!cD5?#Fg", srv.origin)).rejects.toBeInstanceOf(BadPasswordError);
    const o = await openShare(r.link, "", srv.origin);
    expect(o.manifest.items[0]!.text).toBe("sans");
    expect(o.lastOpen).toBe(true);
    // Dernière ouverture : la destruction par le lien seul (avec l'octroi) est permise.
    await o.destroy();
    await expect(openShare(r.link, "", srv.origin)).rejects.toThrow();
  });

  it("createShare refuse un mot de passe absent (undefined) : seul null veut dire « sans mot de passe »", async () => {
    await expect(
      createShare(srv.origin, [{ kind: "text", name: "", mime: "text/plain", data: utf8("x") }], {
        ttlHours: 1,
        maxOpens: 1,
        password: undefined as unknown as null,
        solveCaptcha: solveAltcha,
      }),
    ).rejects.toThrow("mot_de_passe_non_genere");
  });

  it("le K_accès d'un lien « #l » est celui de la même clé sans marque (le serveur trouve le partage par V_accès)", async () => {
    const k = new Uint8Array(32).fill(9);
    const a = await parseLink(`${srv.origin}/s#l${b64u(k)}`);
    const b = await parseLink(`${srv.origin}/s#${b64u(k)}`);
    if (a.kind !== "s" || b.kind !== "s") throw new Error("lien de partage attendu");
    expect([a.noPassword, b.noPassword]).toEqual([true, false]);
    const ka = (await deriveAccess(a.kLien)).kAcces, kb = (await deriveAccess(b.kLien)).kAcces;
    expect(Buffer.from(ka).equals(Buffer.from(kb))).toBe(true);
    expect(sha256(ka)).toHaveLength(32);
  });
});

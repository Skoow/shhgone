// Envoi d'une pièce de salon repris après un redémarrage du serveur (D42-32) : faux serveur qui
// « redémarre » au milieu de l'envoi (jetons d'envoi d'avant refusés en 404, coupure réseau le
// temps du redémarrage) ; l'envoi reprend par le jeton de membre au premier segment non
// acquitté, sans rien renvoyer d'acquitté, et la pièce relue est exactement celle envoyée.
import { describe, expect, it } from "vitest";
import { ENVOI_PATIENCE_MS, EnvoiRepris, envoyerPiece, lirePiece } from "./pieces";
import { SalonError, type Net } from "./api";

const JETON = "J".repeat(43);
const ID = "AAAAAAAAAAAAAAAAAAAAAA";

function fauxServeur(o: { redemarrerApres: number; coupures?: number; perdue?: boolean; finaliseeAvant?: boolean }) {
  const segs = new Map<number, Uint8Array>();
  let bucket = 0;
  let jeton = "jeton-d-envoi-signe-0";
  let gen = 0;
  let recus = 0;
  let coupures = 0;
  let redemarre = false;
  let finalisee = false;
  const vus: string[] = [];
  const reponse = (v: unknown, status: number) => new Response(JSON.stringify(v), { status });
  const n: Net = {
    origin: "https://x.test",
    fetch: async (url, init) => {
      const u = new URL(String(url));
      const h = (init?.headers ?? {}) as Record<string, string>;
      const m = /\/segments\/(\d+)$/.exec(u.pathname);
      vus.push(`${init?.method} ${u.pathname}`);
      // Redémarrage : le serveur ne répond plus quelques fois (coupure), puis repart avec une clé
      // de jetons neuve (l'ancien jeton d'envoi ne vaut plus rien).
      if (redemarre && coupures < (o.coupures ?? 0)) {
        coupures++;
        throw new TypeError("Failed to fetch");
      }
      if (u.pathname.endsWith("/pieces") && init?.method === "POST") {
        bucket = JSON.parse(String(init.body)).bucket;
        return reponse({ piece: ID, upload_token: jeton }, 201);
      }
      if (u.pathname.endsWith("/pieces/reprendre")) {
        if (h["X-Shh-Membre"] !== JETON || h["X-Shh-Piece"] !== ID || o.perdue) return reponse({ error: "not_found" }, 404);
        jeton = `jeton-d-envoi-signe-${++gen}`;
        return reponse({ upload_token: jeton, prete: finalisee }, 200);
      }
      if (h.Authorization !== `Bearer ${jeton}`) return reponse({ error: "not_found" }, 404);
      if (m && init?.method === "PUT") {
        segs.set(Number(m[1]), new Uint8Array(init.body as Uint8Array));
        if (++recus === o.redemarrerApres) {
          redemarre = true;
          jeton = "plus-valable";
          if (o.finaliseeAvant) finalisee = true;
        }
        return new Response(null, { status: 204 });
      }
      if (u.pathname.endsWith("/finalize")) {
        if (finalisee) return reponse({ error: "not_found" }, 404);
        finalisee = true;
        return reponse({}, 200);
      }
      return reponse({ error: "not_found" }, 404);
    },
  };
  const lire: Net = { origin: n.origin, fetch: async (url) => new Response(segs.get(Number(/(\d+)$/.exec(String(url))![1]))!.slice(), { status: 200 }) };
  return { n, lire, vus, segs, finalisee: () => finalisee };
}

const pasDAttente = async () => {};

describe("envoi de pièce repris après un redémarrage du serveur", () => {
  it("redémarrage après le 2e segment (3 segments) : reprise au 3e, rien d'acquitté renvoyé, relue octet pour octet", async () => {
    const f = fauxServeur({ redemarrerApres: 2, coupures: 3 });
    const data = new Uint8Array(64 * 65536 * 2 + 1000);
    for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(data.length, i + 65536)));
    const ref = await envoyerPiece(f.n, JETON, new Blob([data]), { nom: "a.bin", mime: "application/octet-stream", vocal: false, attendre: pasDAttente });
    expect(f.finalisee()).toBe(true);
    const puts = f.vus.filter((v) => v.startsWith("PUT"));
    expect(puts).toEqual([
      "PUT /api/salons/pieces/segments/0",
      "PUT /api/salons/pieces/segments/1",
      ...Array(5).fill("PUT /api/salons/pieces/segments/2"), // 3 coupures, 404 (ancien jeton), puis le bon
    ]);
    expect(f.vus.filter((v) => v === "POST /api/salons/pieces/reprendre")).toHaveLength(1);
    const lu = new Uint8Array(await (await lirePiece(f.lire, JETON, ref)).arrayBuffer());
    expect(lu).toEqual(data);
  }, 60_000);

  it("redémarrage après le dernier segment : la finalisation reprend ; déjà finalisée : rien à refaire", async () => {
    for (const finaliseeAvant of [false, true]) {
      const f = fauxServeur({ redemarrerApres: 1, finaliseeAvant });
      await envoyerPiece(f.n, JETON, new Blob([new Uint8Array(10)]), { nom: "a", mime: "text/plain", vocal: false, attendre: pasDAttente });
      expect(f.finalisee()).toBe(true);
      expect(f.vus.filter((v) => v.endsWith("/finalize"))).toHaveLength(finaliseeAvant ? 1 : 2);
    }
  });

  it("pièce perdue par le serveur (reprise 404) : l'envoi échoue, sans boucle", async () => {
    const f = fauxServeur({ redemarrerApres: 1, perdue: true });
    await expect(envoyerPiece(f.n, JETON, new Blob([new Uint8Array(64 * 65536 * 2)]), { nom: "a", mime: "text/plain", vocal: false, attendre: pasDAttente })).rejects.toMatchObject({ status: 404 });
    expect(f.vus.filter((v) => v.endsWith("/reprendre"))).toHaveLength(1);
  });

  it("refus explicite (413, 429) : relancé tel quel ; serveur absent trop longtemps : abandon après la patience", async () => {
    const n: Net = { origin: "https://x.test", fetch: async () => new Response(JSON.stringify({ error: "too_large" }), { status: 413 }) };
    await expect(new EnvoiRepris(n, JETON, new Uint8Array(16), "t", pasDAttente).appel(async () => { throw new SalonError(413, "too_large"); })).rejects.toMatchObject({ status: 413 });
    let attendu = 0;
    const r = new EnvoiRepris(n, JETON, new Uint8Array(16), "t", async (ms) => void (attendu += ms));
    await expect(r.appel(async () => { throw new Error("reseau"); })).rejects.toThrow("reseau");
    expect(attendu).toBeLessThanOrEqual(ENVOI_PATIENCE_MS);
    expect(attendu).toBeGreaterThan(ENVOI_PATIENCE_MS - 30_000);
  });
});

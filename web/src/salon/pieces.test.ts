import { describe, expect, it } from "vitest";
import { Lots, avecReprise, causeLecture, envoyerPiece, lectureDefinitive, lirePiece } from "./pieces";
import { SalonError, type Net } from "./api";

/** Faux serveur des pièces : segments gardés tels quels, tailles exactes vérifiées. */
function fauxServeur() {
  const segs = new Map<number, Uint8Array>();
  let bucket = 0;
  const vus: string[] = [];
  const n: Net = {
    origin: "https://x.test",
    fetch: async (url, init) => {
      const u = new URL(String(url));
      const m = /\/segments\/(\d+)$/.exec(u.pathname);
      vus.push(`${init?.method} ${u.pathname}`);
      if (u.pathname.endsWith("/pieces") && init?.method === "POST") {
        bucket = JSON.parse(String(init.body)).bucket;
        return new Response(JSON.stringify({ piece: "AAAAAAAAAAAAAAAAAAAAAA", upload_token: "jeton-d-envoi-signe-xyz" }), { status: 201 });
      }
      if (m && init?.method === "PUT") {
        const s = Number(m[1]);
        const b = new Uint8Array(init.body as Uint8Array);
        const attendu = Math.min(64, bucket - 64 * s) * 65552 + (s === 0 ? 48 : 0);
        if (b.length !== attendu) return new Response(JSON.stringify({ error: "bad_request" }), { status: 400 });
        segs.set(s, b);
        return new Response(null, { status: 204 });
      }
      if (u.pathname.endsWith("/finalize")) return new Response("{}", { status: 200 });
      if (m) return new Response(segs.get(Number(m[1]))!.slice(), { status: 200 });
      return new Response("{}", { status: 404 });
    },
  };
  return { n, segs, vus, bucket: () => bucket };
}

describe("pièces du salon", () => {
  for (const taille of [0, 1, 70_000, 64 * 65536 + 10]) {
    it(`${taille} octets : conteneur au palier, segments entiers, relu octet pour octet`, async () => {
      const f = fauxServeur();
      const data = new Uint8Array(taille);
      for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(data.length, i + 65536)));
      const ref = await envoyerPiece(f.n, "J".repeat(43), new Blob([data]), { nom: "a.bin", mime: "application/octet-stream", vocal: false });
      expect(ref.palier).toBe(f.bucket());
      expect(ref.r.length).toBe(32);
      const lu = new Uint8Array(await (await lirePiece(f.n, "J".repeat(43), ref)).arrayBuffer());
      expect(lu).toEqual(data);
      // Le segment 0 n'est lu qu'une fois.
      expect(f.vus.filter((v) => v === "GET /api/salons/pieces/segments/0")).toHaveLength(1);
    }, 60_000);
  }
  // La taille annoncée par le message ne lie personne ; la taille réelle
  // (manifeste) est vérifiée avant de demander la suite.
  it("pièce plus grosse que le plafond donné : refusée sans lire le contenu", async () => {
    const f = fauxServeur();
    const data = new Uint8Array(64 * 65536 * 2 + 10); // trois segments
    const ref = await envoyerPiece(f.n, "J".repeat(43), new Blob([data]), { nom: "a.png", mime: "image/png", vocal: false });
    f.vus.length = 0;
    await expect(lirePiece(f.n, "J".repeat(43), ref, 65536)).rejects.toThrow("trop_gros");
    // Le manifeste est en fin de conteneur : seuls le premier et le dernier segment sont lus,
    // jamais le contenu entre les deux.
    expect(f.vus).toEqual(["GET /api/salons/pieces/segments/0", "GET /api/salons/pieces/segments/2"]);
    // Sous le plafond : lue.
    expect((await lirePiece(f.n, "J".repeat(43), ref, data.length)).size).toBe(data.length);
  }, 60_000);
  // Restes, point 6 : une grosse pièce (vidéo jusqu'à 500 Mo) n'est plus gardée deux fois (morceaux
  // en mémoire de la page, puis copie dans le Blob) : les morceaux passent au Blob par lots.
  it("Lots : au plus un lot en mémoire de la page, octets rendus dans l'ordre, morceaux effacés", async () => {
    const l = new Lots(8);
    const a = Uint8Array.of(1, 2, 3, 4, 5);
    const b = Uint8Array.of(6, 7, 8, 9, 10);
    l.ajouter(a);
    expect(l.enAttente).toBe(5);
    expect([...a]).toEqual([0, 0, 0, 0, 0]); // l'original est effacé : la copie seule est gardée
    l.ajouter(b);
    expect(l.enAttente).toBe(0); // lot plein : passé au Blob
    l.ajouter(Uint8Array.of(11));
    expect(l.enAttente).toBe(1);
    const bl = l.blob("application/octet-stream");
    expect(bl.type).toBe("application/octet-stream");
    expect([...new Uint8Array(await bl.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
  it("autre graine : refusé (paquet_corrompu)", async () => {
    const f = fauxServeur();
    const ref = await envoyerPiece(f.n, "J".repeat(43), new Blob([new Uint8Array(10)]), { nom: "a", mime: "text/plain", vocal: false });
    await expect(lirePiece(f.n, "J".repeat(43), { ...ref, r: new Uint8Array(32) })).rejects.toThrow();
  });
  // Plafond de sortie par pièce (serveur : salon.SortieMax) : 403 egress_limit, définitif ; la
  // lecture échoue au premier refus, sans nouvel essai, et la cause est « sortie ».
  it("plafond de sortie de la pièce : 403 egress_limit, une seule requête, cause « sortie »", async () => {
    const f = fauxServeur();
    const ref = await envoyerPiece(f.n, "J".repeat(43), new Blob([new Uint8Array(10)]), { nom: "a", mime: "text/plain", vocal: false });
    const lire = f.n.fetch;
    let refus = 0;
    f.n.fetch = async (url, init) => {
      if (init?.method !== "GET") return lire(url, init);
      refus++;
      return new Response(JSON.stringify({ error: "egress_limit" }), { status: 403 });
    };
    const e = await lirePiece(f.n, "J".repeat(43), ref).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SalonError);
    expect([(e as SalonError).status, (e as SalonError).code]).toEqual([403, "egress_limit"]);
    expect(causeLecture(e)).toBe("sortie");
    expect(refus).toBe(1); // aucun nouvel essai
  });
  it("téléchargement coupé au milieu : repris au segment coupé, rien n'est relu depuis le début", async () => {
    const f = fauxServeur();
    const data = new Uint8Array(64 * 65536 * 2 + 10); // trois segments
    crypto.getRandomValues(data.subarray(0, 65536));
    const ref = await envoyerPiece(f.n, "J".repeat(43), new Blob([data]), { nom: "a.bin", mime: "application/octet-stream", vocal: false });
    f.vus.length = 0;
    const lire = f.n.fetch;
    let coupe = false;
    f.n.fetch = async (url, init) => {
      if (!coupe && String(url).endsWith("/segments/1")) {
        coupe = true;
        f.vus.push("coupure");
        throw new TypeError("Failed to fetch");
      }
      return lire(url, init);
    };
    const lu = new Uint8Array(await (await lirePiece(f.n, "J".repeat(43), ref)).arrayBuffer());
    expect(lu).toEqual(data);
    expect(f.vus.filter((v) => v.startsWith("GET")).sort()).toEqual(["GET /api/salons/pieces/segments/0", "GET /api/salons/pieces/segments/1", "GET /api/salons/pieces/segments/2"]);
    expect(f.vus).toContain("coupure");
  }, 60_000);
  it("avecReprise : réseau et 5xx réessayés (3 fois au plus), refus 4xx jamais", async () => {
    const attentes: number[] = [];
    const attendre = async (ms: number) => void attentes.push(ms);
    let n = 0;
    expect(await avecReprise(async () => (++n < 3 ? Promise.reject(new SalonError(503, "unavailable")) : "ok"), attendre)).toBe("ok");
    expect(attentes).toEqual([1000, 3000]);
    n = 0;
    await expect(avecReprise(async () => (n++, Promise.reject(new TypeError("x"))), attendre)).rejects.toThrow("x");
    expect(n).toBe(4);
    n = 0;
    await expect(avecReprise(async () => (n++, Promise.reject(new SalonError(429, "budget"))), attendre)).rejects.toThrow("budget");
    expect(n).toBe(1);
  });
  it("causeLecture : 404 indisponible, 403 egress_limit sortie, 429 budget relu, le reste lecture (réessayable)", () => {
    expect(causeLecture(new SalonError(404, "not_found"))).toBe("indisponible");
    expect(causeLecture(new SalonError(403, "egress_limit"))).toBe("sortie");
    expect(causeLecture(new SalonError(403, "excluded"))).toBe("lecture");
    expect(causeLecture(new SalonError(429, "budget"))).toBe("relu");
    expect(causeLecture(new SalonError(429, "limit"))).toBe("lecture");
    expect(lectureDefinitive("relu") && lectureDefinitive("sortie")).toBe(true);
    expect(lectureDefinitive("lecture") || lectureDefinitive("indisponible") || lectureDefinitive(undefined)).toBe(false);
    expect(causeLecture(new Error("reseau"))).toBe("lecture");
  });
});

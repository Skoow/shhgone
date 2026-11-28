// Pièce de salon reprise après un plantage du serveur (D42-32) : vrai binaire Go (salons
// persistants, clé maîtresse), vrai envoi de pièce du site (src/salon/pieces.ts), serveur tué net
// (SIGKILL) après le 2ᵉ segment acquitté d'une pièce de 3 segments, relancé sur le même dossier
// et le même port. L'envoi se termine sans recréer la pièce (reprise par le jeton de membre,
// aucun segment acquitté renvoyé) et un autre membre lit exactement le fichier envoyé.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envoyerPiece, lirePiece } from "../src/salon/pieces";
import { ClientSalon } from "./salon-client";
import { startServer, type TestServer } from "./server";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("pièce de salon reprise après un plantage du serveur", () => {
  const dossierCle = mkdtempSync(join(tmpdir(), "shh-e2e-cle-pieces-"));
  const cle = join(dossierCle, "salons_cle");
  const serveurs: TestServer[] = [];
  const clients: ClientSalon[] = [];
  afterAll(async () => {
    for (const x of clients) await x.fermer().catch(() => undefined);
    for (const s of serveurs) await s.dispose().catch(() => undefined);
    rmSync(dossierCle, { recursive: true, force: true });
  });

  it("SIGKILL au milieu de l'envoi, relance : l'envoi reprend au premier segment manquant, la pièce se lit", async () => {
    const srv = await startServer({ salons: true, cleSalons: cle });
    serveurs.push(srv);
    const port = Number(new URL(srv.origin).port);
    const cr = await ClientSalon.creer(srv, { maxMembers: 4 });
    const a = cr.createur;
    clients.push(a);
    const b = await ClientSalon.rejoindre(srv, cr.lien, cr.mdp);
    clients.push(b);
    await Promise.all([a.attendreMembres([0, 1]), b.attendreMembres([0, 1])]);

    let courant = srv;
    const acquittes = new Set<string>();
    const vus: string[] = [];
    let renvoyes = 0;
    let tue: Promise<void> | undefined;
    const fetch = (async (u: RequestInfo | URL, i?: RequestInit) => {
      const req = new Request(u, i);
      const url = new URL(req.url);
      vus.push(`${req.method} ${url.pathname}`);
      if (req.method === "PUT" && acquittes.has(url.pathname)) renvoyes++;
      if (tue !== undefined) await tue; // serveur tué : les requêtes suivantes attendent sa mort
      const r = await globalThis.fetch(u, i);
      if (req.method === "PUT" && r.status === 204) {
        acquittes.add(url.pathname);
        if (acquittes.size === 2 && tue === undefined) tue = courant.tuer();
      }
      return r;
    }) as typeof globalThis.fetch;

    const data = new Uint8Array(64 * 65536 * 2 + 12345); // 3 segments
    for (let off = 0; off < data.length; off += 65536) crypto.getRandomValues(data.subarray(off, Math.min(data.length, off + 65536)));
    const envoi = envoyerPiece({ origin: srv.origin, fetch }, a.jeton, new Blob([data]), {
      nom: "photo.bin",
      mime: "application/octet-stream",
      vocal: false,
      attendre: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 500))),
    });
    while (tue === undefined) await new Promise((r) => setTimeout(r, 20));
    await tue;
    courant = await startServer({ salons: true, cleSalons: cle, reprendre: { dataDir: srv.dataDir, port } });
    serveurs.splice(serveurs.indexOf(srv), 1, courant); // même dossier : supprimé une fois, par le second
    const ref = await envoi;

    expect(renvoyes).toBe(0); // aucun segment acquitté renvoyé
    expect(vus.filter((x) => x === "POST /api/salons/pieces")).toHaveLength(1); // jamais une seconde pièce
    expect(vus.filter((x) => x === "POST /api/salons/pieces/reprendre")).toHaveLength(1);
    expect(vus.filter((x) => x === "POST /api/salons/pieces/finalize").length).toBeGreaterThanOrEqual(1);

    // B, dont la page est restée ouverte, lit la pièce avec son jeton de membre (repris).
    const lu = new Uint8Array(await (await lirePiece({ origin: courant.origin, fetch: globalThis.fetch }, b.jeton, ref)).arrayBuffer());
    expect(sha(lu)).toBe(sha(data));
  });
});

// Envoi repris après un redémarrage (D42-31, 28 novembre : « il ne faut rien perdre après un
// redémarrage ») : vrai binaire Go, gros fichier envoyé par le brouillon du site, serveur tué
// net (SIGKILL : plantage, manque de mémoire, coupure) au milieu de l'envoi, relancé sur le même
// dossier de données et le même port. L'envoi se termine sans repartir de zéro (reprise par
// S_gestion, aucun segment acquitté renvoyé, jamais un second brouillon), et le destinataire
// ouvre exactement le fichier envoyé. Puis un lecteur qui revient après un second plantage
// rouvre la même ouverture avec son octroi, sans en consommer une de plus.
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { openShare } from "../src/transfer/client";
import { createDraft } from "../src/transfer/draft";
import { solveAltcha } from "./altcha";
import { startServer, type TestServer } from "./server";

const PW = "Kq7!mP2#x?a";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("envoi repris après un plantage du serveur", () => {
  const serveurs: TestServer[] = [];
  afterAll(async () => {
    for (const s of serveurs) await s.dispose().catch(() => undefined);
  });

  it("gros fichier, SIGKILL au milieu, relance : l'envoi se termine, le destinataire ouvre le bon contenu", async () => {
    // Port fixé (salon activé, sans clé maîtresse) : le site garde la même origine après la relance.
    const srv = await startServer({ salons: true, cleSalons: false });
    serveurs.push(srv);
    const port = Number(new URL(srv.origin).port);
    let courant = srv;
    const acked = new Set<string>();
    const vus: string[] = [];
    let renvoyes = 0;
    let tue: Promise<void> | undefined;
    const fetch = (async (u: RequestInfo | URL, i?: RequestInit) => {
      const req = new Request(u, i);
      const url = new URL(req.url);
      const cle = `${url.pathname}${url.search}`;
      vus.push(`${req.method} ${url.pathname}`);
      if (req.method === "PUT" && acked.has(cle)) renvoyes++;
      const r = await globalThis.fetch(u, i);
      if (req.method === "PUT" && r.status === 204) {
        acked.add(cle);
        // Au 4ᵉ segment acquitté (sur 13) : plantage, pendant que d'autres segments sont en vol.
        if (acked.size === 4 && tue === undefined) tue = courant.tuer();
      }
      return r;
    }) as typeof globalThis.fetch;

    const data = new Uint8Array(50 * 1048576);
    for (let off = 0; off < data.length; off += 65536) crypto.getRandomValues(data.subarray(off, off + 65536));
    const blob = new Blob([data]);
    const d = createDraft(srv.origin, { fetch, solveCaptcha: solveAltcha, auto: true });
    d.sync([{ id: "a", data: blob }]);
    const fin = d.finalize([{ id: "a", item: { kind: "file", name: "gros.bin", mime: "application/octet-stream", data: blob } }], {
      ttlHours: 1,
      maxOpens: 2,
      password: PW,
      solveCaptcha: solveAltcha,
    });
    // Le serveur est tué, puis relancé sur le même dossier et le même port.
    while (tue === undefined) await new Promise((r) => setTimeout(r, 20));
    await tue;
    const avant = acked.size;
    courant = await startServer({ salons: true, cleSalons: false, reprendre: { dataDir: srv.dataDir, port } });
    serveurs.splice(serveurs.indexOf(srv), 1, courant); // même dossier : supprimé une fois, par le second
    const r = await fin;

    expect(avant).toBeGreaterThanOrEqual(4);
    expect(renvoyes).toBe(0); // aucun segment acquitté renvoyé : reprise au premier manquant
    expect(vus.filter((x) => x === "POST /api/shares")).toHaveLength(1); // jamais un second brouillon
    expect(vus.filter((x) => x === "POST /api/manage/resume").length).toBeGreaterThanOrEqual(1);
    expect(vus).not.toContain("POST /api/manage/destroy");

    const o = await openShare(r.link, PW, courant.origin, undefined, { fetch });
    expect(sha(await o.item(0))).toBe(sha(data));
    const grant = o.grant;

    // Second plantage pendant que le lecteur a le partage ouvert : il revient avec son octroi.
    await courant.tuer();
    const srv3 = await startServer({ salons: true, cleSalons: false, reprendre: { dataDir: srv.dataDir, port } });
    serveurs.splice(serveurs.indexOf(courant), 1, srv3);
    courant = srv3;
    const o2 = await openShare(r.link, PW, srv3.origin, { grant }, { fetch });
    expect(o2.opensLeft).toBe(1); // 2 permises, une seule prise
    expect(sha(await o2.item(0))).toBe(sha(data));
    await o2.done();
  }, 180_000);
});

// Salons persistants (conception du salon v3 §5.2, décisions du 25 et du 26 novembre) : vrai
// binaire Go arrêté proprement (SIGTERM), ou tué net (SIGKILL : plantage, manque de mémoire,
// coupure), puis relancé sur le même dossier de données, la même clé maîtresse et le même port ;
// vrai moteur du salon. Les clients restés ouverts se reconnectent avec leur
// jeton et leur dernier rang (sans `rejoindre`, sans refondation du groupe), l'absent rattrape
// le message envoyé avant l'arrêt, et la conversation continue dans le même groupe MLS.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Enveloppe, EnveloppeEnvoi, Evenement } from "../src/salon/engine";
import { ClientSalon, alea, egal, type Recu } from "./salon-client";
import { startServer, type TestServer } from "./server";

type Envoi = EnveloppeEnvoi & { id: Uint8Array };

const texte = (x: string): Envoi => ({ id: alea(16), heureMs: Date.now(), regle: 0, message: { k: "texte", x } });
const message = (id: Uint8Array) => (r: Recu) => r.k === "evt" && r.evenement.type === "message" && egal(r.evenement.enveloppe.id, id);
const enveloppe = (r: Recu): { deSiege: number; enveloppe: Enveloppe } => (r as { evenement: Extract<Evenement, { type: "message" }> }).evenement;

async function lit(c: ClientSalon, e: Envoi, siege: number): Promise<void> {
  const m = enveloppe(await c.attendre(message(e.id)));
  expect(m.deSiege).toBe(siege);
  expect(m.enveloppe).toEqual(e);
}

describe("salon persistant : redémarrage du serveur", () => {
  const dossierCle = mkdtempSync(join(tmpdir(), "shh-e2e-cle-salons-"));
  const cle = join(dossierCle, "salons_cle");
  const serveurs: TestServer[] = [];
  const clients: ClientSalon[] = [];
  afterAll(async () => {
    for (const x of clients) await x.fermer().catch(() => undefined);
    for (const s of serveurs) await s.dispose().catch(() => undefined);
    rmSync(dossierCle, { recursive: true, force: true });
  });

  for (const brutal of [false, true]) {
    it(`messages avant et après le redémarrage${brutal ? " brutal (SIGKILL)" : ""}, historique rattrapé, même groupe`, async () => {
      const srv = await startServer({ salons: true, cleSalons: cle });
      serveurs.push(srv);
      const cr = await ClientSalon.creer(srv, { maxMembers: 4 });
      const a = cr.createur;
      clients.push(a);
      const b = await ClientSalon.rejoindre(srv, cr.lien, cr.mdp);
      clients.push(b);
      await Promise.all([a.attendreMembres([0, 1]), b.attendreMembres([0, 1])]);
      const avant = texte("avant le redémarrage");
      await a.envoyer(avant);
      await lit(b, avant, 0);
      // B s'absente ; A écrit pendant son absence, puis le serveur s'arrête.
      await b.couper();
      const absence = texte("pendant l'absence de B");
      await a.envoyer(absence);
      const dernierA = a.dernierSeq;
      const epoques = [a.salon.epoque(), b.salon.epoque()];
      expect(epoques[0]).toBeDefined();
      if (brutal) {
        // Plantage : la ligne est écrite au plus une seconde après le dernier message.
        await new Promise((r) => setTimeout(r, 1_500));
        await srv.tuer();
        await a.attendreFermeture();
      } else {
        await srv.stop();
        expect(await a.attendreFermeture()).toBe(1001);
      }

      const srv2 = await startServer({ salons: true, cleSalons: cle, reprendre: { dataDir: srv.dataDir, port: Number(new URL(srv.origin).port) } });
      serveurs.splice(serveurs.indexOf(srv), 1, srv2); // même dossier : supprimé une fois, par le second
      expect(srv2.origin).toBe(srv.origin);
      // A revient avec son dernier rang : accueil au même rang, rien de rejoué ; B rattrape.
      const avantA = a.recus.length;
      await a.reconnecter();
      const liste = a.recus.slice(avantA).find((r) => r.k === "enr" && r.enr.type === 0x0d) as { enr: { seq: number } } | undefined;
      // Arrêt propre : même rang ; plantage : la réserve des rangs fait un trou (jamais moins).
      if (brutal) expect(liste?.enr.seq).toBeGreaterThanOrEqual(dernierA);
      else expect(liste?.enr.seq).toBe(dernierA);
      await b.reconnecter();
      await lit(b, absence, 0);
      // La conversation continue, dans les deux sens, au rang suivant.
      const apres = texte("après le redémarrage");
      const seq = await b.envoyer(apres);
      expect(seq).toBeGreaterThan(dernierA);
      await lit(a, apres, 1);
      const retour = texte("réponse de A");
      await a.envoyer(retour);
      await lit(b, retour, 0);
      expect(a.erreurs).toEqual([]);
      expect(b.erreurs).toEqual([]);
      // Même groupe MLS : aucune refondation (un groupe refondé repartirait d'une époque neuve).
      expect(a.salon.epoque()).toBe(epoques[0]);
      expect(b.salon.epoque()).toBe(epoques[1]);
    });
  }
});

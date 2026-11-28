// Pass payé sur l'appareil d'une page, pour les tests contre le vrai serveur (SHH_PAIEMENT=1) sans
// appeler de prestataire : la page passe une vraie commande sur /offres (pass tiré et gardé par le
// site, en attente), la commande est interceptée dans le navigateur (aucun appel à Stripe, comme
// paiement.spec.ts), puis le pass est inscrit payé directement dans paiements.db du serveur de test
// (ce que ferait le webhook du prestataire : une ligne `passes`, empreinte Q seulement), et la page
// de retour le range « payé ». Ensuite tout est réel : clés des jetons, émission en aveugle par le
// serveur, dépense d'un jeton anonyme.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

const JOUR = 86_400;

/** Empreinte Q = SHA-256(« shhdrop/v2/pass » ‖ 0x00 ‖ P) (server/internal/paiement/pass.go). */
function empreinte(pass: Buffer): Buffer {
  return createHash("sha256").update("shhdrop/v2/pass").update(Buffer.from([0])).update(pass).digest();
}

/**
 * Inscrit le pass P (base64url) payé, offre Plus (1) ou Pro (2), pour 30 jours, dans paiements.db.
 * `renouvelle` : aussi une commande payée qui se renouvelle (carte), sans identifiant d'abonnement
 * chez le prestataire (aucun appel sortant : la résiliation au serveur répond « aucun abonnement »).
 */
async function inscrirePaye(dataDir: string, p: string, offre: 1 | 2, renouvelle = false): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataDir, "paiements.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const auj = Math.floor(Date.now() / 1000 / JOUR) * JOUR;
    db.prepare("INSERT INTO passes(q, offre, debut_jour, fin_jour, jetons, recharge_jour, revoque) VALUES(?,?,?,?,?,?,0)").run(
      empreinte(Buffer.from(p, "base64url")),
      offre,
      auj,
      auj + 30 * JOUR,
      offre === 1 ? 30 : 100,
      auj + 30 * JOUR,
    );
    if (renouvelle)
      db.prepare("INSERT INTO commandes(id, q, offre, jours, renouvelle, moyen, etat, abonnement, cree_jour, garde_jour) VALUES(?,?,?,30,1,1,2,NULL,?,?)").run(
        randomBytes(16),
        empreinte(Buffer.from(p, "base64url")),
        offre,
        auj,
        auj + 210 * JOUR,
      );
  } finally {
    db.close();
  }
}

/**
 * Range sur l'appareil de `page` un pass Plus payé (mensuel, carte). `shh` : le serveur de test
 * (paiement activé). Les requêtes vers la page hébergée du prestataire sont retirées de
 * `foreignRequests` (redirection voulue, servie vide ici).
 */
export async function passPaye(page: Page, shh: { origin: string; server: { dataDir: string }; foreignRequests: string[] }, o: { renouvelle?: boolean } = {}): Promise<void> {
  await page.goto(shh.origin + "/offres");
  const co = page.locator("[data-checkout]");
  await co.locator('[data-tier="plus"] .big').click();
  await co.locator("[data-pays]").selectOption("FR");
  await co.locator("[data-waiver]").check();
  let pass = "";
  await page.route("**/api/paiement/commande", (route) => {
    pass = route.request().headers()["x-shh-pass"] ?? "";
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"url":"https://checkout.stripe.com/c/pay/cs_test_appel"}' });
  });
  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ status: 204 }));
  const hosted = page.waitForRequest(/^https:\/\/checkout\.stripe\.com\//);
  await co.locator("[data-pay]").click();
  await hosted;
  await page.unroute("**/api/paiement/commande");
  await page.unroute("https://checkout.stripe.com/**");
  shh.foreignRequests.splice(0);
  expect(pass).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await inscrirePaye(shh.server.dataDir, pass, 1, o.renouvelle === true);
  // Retour : l'état est lu au vrai serveur, le pass passe « payé » sur l'appareil.
  await page.goto(shh.origin + "/offres/retour");
  await expect(page.locator('[data-return="payee"]')).toBeVisible({ timeout: 30_000 });
}

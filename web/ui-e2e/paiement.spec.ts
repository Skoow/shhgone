// Paiement (conception du paiement, 19 novembre) contre le vrai serveur avec SHH_PAIEMENT=1 (bacs à
// sable Stripe et NOWPayments, clés d'essai écrites par e2e/server.ts) : bouton actif seulement
// quand le moyen est proposé, le rythme de l'annuel choisi, le pays choisi et la case cochée ; pass
// dans X-Shh-Pass, jamais dans l'adresse ; redirection seulement vers la page hébergée ; page de
// retour (reçu, en attente, non abouti, arrêt du renouvellement). La commande elle-même est
// interceptée dans le navigateur (aucun appel réel à Stripe depuis les tests ; le serveur est
// couvert par server/internal/paiement et server/internal/api) ; l'état d'un pass inconnu est lu
// au vrai serveur.
import { fileURLToPath } from "node:url";
import { axe, expect, test } from "./fixtures";

test.use({ locale: "fr-FR", timezoneId: "Europe/Berlin", shhServer: { paiement: { webhookStripe: "whsec_e2e_test", ipnNOWPayments: "ipn-e2e" } } });
const SHOTS = fileURLToPath(new URL("../../.superpowers/sdd/2026-11-19-paiement/shots/", import.meta.url));
const w = (isMobile: boolean) => (isMobile ? 390 : 1440);
const PASS = /^[A-Za-z0-9_-]{43}$/;

test("Offres avec paiement : conditions du bouton, pass dans l'en-tête, erreur du prestataire, redirection vers la page hébergée ; capture", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/offres");
  const co = page.locator("[data-checkout]");
  // Appels des salons : « bientôt », jamais en vente.
  // Appels (20 novembre) : Plus et Pro « Inclus » avec « bientôt (pas encore disponible) » (24 novembre :
  // pas compris aujourd'hui), Gratuit « Non inclus ».
  for (const x of ["plus", "pro"]) await expect(co.locator(`[data-tier="${x}"] [data-calls]`)).toHaveText(/^Appels audio et vidéo\s+Inclus\s+bientôt \(pas encore disponible\)$/);
  await expect(co.locator('[data-tier="free"] [data-calls]')).toHaveText(/^Appels audio et vidéo\s+Non inclus$/);
  await co.locator('[data-tier="pro"] .big').click();
  await co.locator("[data-billing]").getByText("Annuel").click();
  const sum = co.locator("[data-summary]");
  const go = sum.locator("[data-pay]");
  const pourquoi = sum.locator("[data-wait]");
  // PayPal non configuré sur ce serveur : refus dit.
  await co.locator('[data-means="paypal"]').click();
  await expect(go).toBeDisabled();
  await expect(pourquoi).toHaveText("Ce moyen de paiement n'est pas encore proposé.");
  await co.locator('[data-means="card"]').click();
  // Annuel par carte : paiement unique ou renouvellement, jamais présélectionné.
  await expect(co.locator("[data-renew] input:checked")).toHaveCount(0);
  await expect(pourquoi).toHaveText("Choisissez paiement unique ou renouvellement automatique.");
  await co.locator("[data-renew]").getByText("Paiement unique").click();
  // Pays proposé d'avance d'après le fuseau horaire de l'appareil (24 novembre), modifiable ;
  // vidé, il bloque de nouveau.
  await expect(co.locator("[data-pays]")).toHaveValue("DE");
  await co.locator("[data-pays]").selectOption("");
  await expect(pourquoi).toHaveText("Choisissez votre pays de résidence.");
  // 27 pays de l'UE (plus « Choisir… »), pas le Royaume-Uni.
  await expect(co.locator("[data-pays] option")).toHaveCount(28);
  await expect(co.locator('[data-pays] option[value="GB"]')).toHaveCount(0);
  await co.locator("[data-pays]").selectOption("DE");
  // Case de renonciation jamais précochée.
  await expect(sum.locator("[data-waiver]")).not.toBeChecked();
  await expect(pourquoi).toHaveText("Cochez la case de l'accès immédiat pour continuer.");
  await sum.locator("[data-waiver]").check();
  await expect(go).toBeEnabled();
  await expect(go).toHaveText("Payer sur la page sécurisée de Stripe");
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}offres-paiement-${w(isMobile)}.png`, fullPage: true });

  // 1) Prestataire injoignable : erreur dite, rien de prélevé, pass oublié.
  const vus: { url: string; headers: Record<string, string>; body: string | null }[] = [];
  await page.route("**/api/paiement/commande", async (route) => {
    const r = route.request();
    vus.push({ url: r.url(), headers: r.headers(), body: r.postData() });
    await route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"prestataire"}' });
  });
  await go.click();
  await expect(sum.locator("[data-pay-error]")).toHaveText("Le prestataire de paiement ne répond pas. Rien n'a été prélevé ; réessayez plus tard.");
  expect(vus).toHaveLength(1);
  expect(vus[0]!.headers["x-shh-pass"]).toMatch(PASS);
  // Preuve anti-robot calculée par la page (défi du vrai serveur, audit du 20 novembre, S2).
  expect(JSON.parse(vus[0]!.body!)).toEqual({ offre: "pro", jours: 365, renouvelle: false, moyen: "carte", pays: "DE", renonciation: true, altcha: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/), hp: "", shown_at: expect.any(String) });
  expect(vus[0]!.url).toBe(shh.origin + "/api/paiement/commande");
  expect(vus[0]!.url + vus[0]!.body).not.toContain(vus[0]!.headers["x-shh-pass"]!);
  const garde = () => page.evaluate(() => new Promise<number>((ok) => {
    const r = indexedDB.open("shhdrop-pass");
    r.onsuccess = () => {
      const db = r.result;
      const noms = [...db.objectStoreNames];
      if (noms.length === 0) return ok(0);
      const tx = db.transaction(noms, "readonly");
      let n = 0;
      for (const s of noms) tx.objectStore(s).count().onsuccess = (e) => (n += (e.target as IDBRequest<number>).result);
      tx.oncomplete = () => ok(n);
    };
  }));
  // Le pass est retiré après l'échec (seule la clé de la base reste).
  const apres = await garde();

  // 2) Réussite : la page hébergée s'ouvre (seule requête vers une autre origine).
  await page.unroute("**/api/paiement/commande");
  await page.route("**/api/paiement/commande", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"url":"https://checkout.stripe.com/c/pay/cs_test_e2e"}' }),
  );
  // La page hébergée est demandée, puis rien n'est affiché (204 : le navigateur reste sur la
  // page) : sous WebKit, après une page d'une autre origine servie par route.fulfill, l'onglet
  // ne navigue plus (« Assertion error » de Playwright, run CI 44666763368, reproduit en local) ;
  // un abort mène Chromium à une page d'erreur qui coupe la navigation suivante. La requête
  // suffit à la preuve.
  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ status: 204 }));
  const hosted = page.waitForRequest("https://checkout.stripe.com/**");
  await go.click();
  expect((await hosted).url()).toBe("https://checkout.stripe.com/c/pay/cs_test_e2e");
  expect(shh.foreignRequests.every((u) => u.startsWith("https://checkout.stripe.com/"))).toBe(true);
  shh.foreignRequests.splice(0); // la redirection voulue vers la page hébergée
  // Retour : le pass en attente est lu sur l'appareil, son état demandé au vrai serveur
  // (commande jamais arrivée au serveur ici : « non abouti »).
  await page.goto(shh.origin + "/offres/retour");
  await expect(page.getByRole("heading", { level: 1, name: "Votre paiement" })).toBeVisible();
  await expect(page.locator('[data-return="non_aboutie"]')).toContainText("Paiement non abouti");
  expect(await garde()).toBe(apres + 1);
  await page.locator("[data-forget]").click();
  await expect(page.locator('[data-return="aucune"]')).toContainText("Aucune commande sur cet appareil");
  expect(await garde()).toBe(apres);
});

test("Retour : reçu, puis arrêt du renouvellement ; en attente ; sans commande ; capture", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/offres/retour");
  await expect(page.locator('[data-return="aucune"]')).toContainText("Cette page affiche le résultat d'un paiement commencé sur cet appareil.");
  // Une commande Plus mensuelle (abonnement) passée sur cet appareil.
  await page.goto(shh.origin + "/offres");
  const co = page.locator("[data-checkout]");
  await co.locator('[data-tier="plus"] .big').click();
  await co.locator("[data-pays]").selectOption("FR");
  await co.locator("[data-waiver]").check();
  await page.route("**/api/paiement/commande", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"url":"https://checkout.stripe.com/c/pay/cs_test_2"}' }),
  );
  // Page hébergée demandée, rien affiché (204, voir le test précédent).
  await page.route("https://checkout.stripe.com/**", (route) => route.fulfill({ status: 204 }));
  const hosted = page.waitForRequest(/^https:\/\/checkout\.stripe\.com\//);
  await co.locator("[data-pay]").click();
  await hosted;
  shh.foreignRequests.splice(0);
  // En attente d'abord, puis reçu (webhook arrivé).
  let n = 0;
  const etats: string[] = [];
  await page.route("**/api/paiement/etat", (route) => {
    etats.push(route.request().headers()["x-shh-pass"] ?? "");
    const e = n++ === 0 ? { v: 1, etat: "attente", offre: "plus", fin: null, renouvelle: false, droits: [] } : { v: 1, etat: "payee", offre: "plus", fin: "2026-12-20", renouvelle: true, droits: ["partage_plus"] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(e) });
  });
  await page.goto(shh.origin + "/offres/retour");
  await expect(page.locator('[data-return="attente"]')).toContainText("Paiement en attente");
  await expect(page.locator('[data-return="payee"]')).toContainText("Plus est enregistré sur cet appareil jusqu'au 19 décembre 2026.", { timeout: 15_000 });
  await expect(page.locator('[data-return="payee"]')).toContainText("Les partages Plus et Pro ne sont pas encore ouverts");
  expect(etats.every((x) => PASS.test(x))).toBe(true);
  expect(new Set(etats).size).toBe(1);
  // Note de vente, faite sur l'appareil (S4) : seul GET /api/paiement (régime de TVA du vrai
  // serveur, oss) est lu ; aucune requête n'emporte le pays, le montant ou une identité.
  const lus: string[] = [];
  page.on("request", (r) => lus.push(`${r.method()} ${new URL(r.url()).pathname}`));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("[data-note]").click()]);
  expect(dl.suggestedFilename()).toMatch(/^note-de-vente-shhgone-\d{4}-\d{2}-\d{2}\.html$/);
  const { readFile } = await import("node:fs/promises");
  const note = await readFile((await dl.path())!, "utf8");
  for (const x of ["Note de vente", "Shhgone Plus, 30 jours, renouvelé chaque mois", "TVA (20 %)", "5,83 €", "1,17 €", "7,00 €", "FR", "[À COMPLÉTER : SIREN]", "guichet unique OSS"])
    expect(note).toContain(x);
  expect(note).not.toMatch(/<script|src=|href=/i);
  expect(lus.filter((x) => x.includes("/api/"))).toEqual(["GET /api/paiement"]);
  await page.route("**/api/paiement/resilier", (route) => route.fulfill({ status: 204 }));
  await page.locator("[data-stop]").click();
  await expect(page.locator("[data-stopped]")).toContainText("Renouvellement arrêté");
  await expect(page.locator("[data-stop]")).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}retour-recu-${w(isMobile)}.png`, fullPage: true });
});

test("Le vrai serveur : GET /api/paiement, état d'un pass inconnu, webhook Stripe mal signé refusé", async ({ shh, request }) => {
  const o = await (await request.get(shh.origin + "/api/paiement")).json();
  expect(o).toEqual({ v: 1, moyens: ["carte", "crypto"], pays: expect.arrayContaining(["DE", "FR"]), bientot: ["appel_audio", "appel_video"], tva: { regime: "oss", taux: expect.objectContaining({ DE: 1900, FR: 2000 }) } });
  const pass = Buffer.alloc(32, 5).toString("base64url");
  const e = await request.post(shh.origin + "/api/paiement/etat", { headers: { "X-Shh-Pass": pass } });
  expect(await e.json()).toEqual({ v: 1, etat: "inconnue", offre: null, fin: null, renouvelle: false, droits: [] });
  const wh = await request.post(shh.origin + "/api/paiement/webhook/stripe", { headers: { "Stripe-Signature": "t=1,v1=00" }, data: '{"object":"event"}' });
  expect(wh.status()).toBe(400);
  // Webhook bien signé (secret d'essai de ce serveur) d'un événement non traité : 200.
  const { createHmac } = await import("node:crypto");
  const corps = JSON.stringify({ id: "evt_e2e", object: "event", livemode: false, type: "customer.created", data: { object: { id: "cus_1" } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", "whsec_e2e_test").update(`${t}.${corps}`).digest("hex");
  const ok = await request.post(shh.origin + "/api/paiement/webhook/stripe", { headers: { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" }, data: corps });
  expect(ok.status()).toBe(200);
});

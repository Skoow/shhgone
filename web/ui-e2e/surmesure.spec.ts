// Comptes sur mesure et noms des accès offerts (décision du propriétaire, 25 novembre), de bout
// en bout : vrai binaire Go (SHH_COMPTES=1, SHH_SALONS=1, SHH_PAIEMENT=1, tableau de bord sur son
// écouteur), site construit avec le compte (dist-comptes). Une personne crée son compte par
// passkey (authentificateur virtuel de Chromium) : 1 h à 24 h, 4 places. L'exploitant la retrouve
// au tableau de bord par son pseudo exact (tapé en majuscules : le serveur canonise), lui pose
// 50 places et 30 jours avec un nom, et offre deux accès nommés. La personne voit alors les
// durées longues et crée un salon de 30 jours et 50 places. Captures des trois écrans dans
// SHH_CAPTURES_SURMESURE (sinon test-results/captures/surmesure/).
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { siteComptes } from "./comptes-site";
import { expect, test as base } from "./fixtures";

const JETON = randomBytes(32).toString("hex");
const SHOTS = process.env.SHH_CAPTURES_SURMESURE ?? fileURLToPath(new URL("../test-results/captures/surmesure/", import.meta.url));

const test = base.extend<object, { site: string }>({
  site: [async ({}, use) => use(await siteComptes()), { scope: "worker", timeout: 360_000 }],
  shhServer: async ({ site }, use) =>
    use({
      comptes: { cle: new Uint8Array(randomBytes(32)), admin: JETON },
      paiement: { webhookStripe: "whsec_e2e_test", ipnNOWPayments: "ipn-e2e" },
      env: { SHH_STATIC_DIR: site },
    }),
});

test.use({ locale: "fr-FR", timezoneId: "Europe/Paris", actionTimeout: 30_000 });
test.setTimeout(300_000);
test.skip(({ browserName, isMobile }) => browserName !== "chromium" || isMobile, "authentificateur virtuel WebAuthn (CDP) : Chromium de bureau seulement");

const champ = (page: Page, label: string) => page.getByLabel(label, { exact: true }).and(page.locator("input"));
const bouton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const titre = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });

async function inscrire(page: Page, origin: string, pseudo: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await page.goto(origin + "/compte/inscription?suite=salon");
  await champ(page, "Pseudo").fill(pseudo);
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 });
  await bouton(page, "Créer avec une passkey").click();
  await expect(titre(page, "Votre clé de récupération")).toBeVisible({ timeout: 30_000 });
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  await bouton(page, "Je l'ai notée").click();
  const label = (await page.locator("label").filter({ hasText: "Tapez le groupe" }).textContent())!;
  await page.getByLabel(label.trim(), { exact: true }).fill(cle.split("-")[Number(/n°\s*(\d)/u.exec(label)![1]) - 1]!);
  await bouton(page, "Terminer").click();
  await expect(titre(page, "Compte créé.")).toBeVisible({ timeout: 30_000 });
}

/** Navigation dans l'application, sans recharger (la session simple vit en mémoire de l'onglet). */
async function aller(page: Page, chemin: string): Promise<void> {
  await page.evaluate((c) => {
    history.pushState({}, "", c);
    dispatchEvent(new PopStateEvent("popstate"));
  }, chemin);
}

/** Options du groupe « Durée du salon » de la création d'un salon. */
const durees = async (page: Page) =>
  (await page.getByRole("radiogroup", { name: "Durée du salon", exact: true }).locator(".opt").allTextContents()).map((x) => x.replace(/\s+/gu, " ").trim());

test("compte sur mesure : recherche par pseudo, 50 places et 30 jours, accès offerts nommés ; captures", async ({ page, shh, context }) => {
  mkdirSync(SHOTS, { recursive: true });
  const pseudo = `Lea${randomBytes(2).toString("hex").replace(/[01im]/gu, "x")}`;
  await inscrire(page, shh.origin, pseudo);
  await bouton(page, "Continuer").click();
  await expect(titre(page, "Créer un salon")).toBeVisible();
  await expect(page.getByText("Ouvert, 4\u202fau plus")).toBeVisible();
  expect(await durees(page)).toEqual(["1 h", "6 h", "12 h", "24 h"]);

  // --- Tableau de bord : recherche par pseudo exact, sur mesure, accès offerts nommés -----------
  const admin = await context.newPage();
  await admin.setViewportSize({ width: 1280, height: 900 });
  // Ancien nom gardé dans ce navigateur (avant le 25 novembre) : repris une fois, puis effacé.
  await admin.goto(shh.server.adminOrigin! + "/");
  await admin.locator("#jeton").fill(JETON);
  await admin.getByRole("button", { name: "Ouvrir", exact: true }).click();
  await expect(admin.locator("#tableau")).toBeVisible();
  await expect(admin.locator("#carte-surmesure")).toBeVisible();
  await expect(admin.locator("#surmesure-liste")).toHaveText("Aucun compte sur mesure.");
  await admin.locator("#chercher-pseudo").fill("inconnu" + pseudo);
  await admin.locator("#chercher-bouton").click();
  await expect(admin.locator("#surmesure-resultat")).toContainText("Introuvable");
  await admin.locator("#chercher-pseudo").fill(" " + pseudo.toUpperCase() + " ");
  await admin.locator("#chercher-bouton").click();
  await expect(admin.locator("#compte-trouve")).toBeVisible();
  await expect(admin.locator("#chercher-pseudo")).toHaveValue("");
  await expect(admin.locator("#compte-faits")).toContainText("1 salon(s) à la fois · 4 personnes par salon · 1 jour au plus");
  await admin.locator("#sm-salons").fill("2");
  await admin.locator("#sm-places").fill("50");
  await admin.locator("#sm-jours").fill("30");
  await admin.locator("#sm-nom").fill("Léa, ma sœur");
  await admin.locator("#sm-enregistrer").click();
  await expect(admin.locator("#surmesure-resultat")).toContainText("Limites sur mesure enregistrées");
  await expect(admin.locator("#compte-faits")).toContainText("2 salon(s) à la fois · 50 personnes par salon · 30 jours au plus");
  await expect(admin.locator("#surmesure-liste")).toContainText("Léa, ma sœur");

  for (const [nom, duree] of [["", "mois"], ["Marc (collègue)", "an"], ["Zoé", "sans_fin"]] as const) {
    await admin.locator("#offrir-nom").fill(nom);
    await admin.locator("#offrir-duree").selectOption(duree);
    await admin.locator("#offrir-bouton").click();
    await admin.locator("#offrir-bouton").click(); // second appui : confirmation
    await expect(admin.locator("#offert-lien")).toBeVisible();
    await admin.locator("#offert-oublier").click();
  }
  await expect(admin.locator("#offerts")).toContainText("Marc (collègue)");
  await expect(admin.locator("#offerts")).toContainText("Zoé");
  // Reprise unique d'un nom gardé avant le 25 novembre dans le navigateur (clé locale) : envoyé
  // au serveur pour l'accès sans nom, puis la clé locale est effacée.
  const sansNom = await admin.evaluate(async (j) => {
    const r = await fetch("/api/paiement/offerts", { headers: { Authorization: "Bearer " + j } });
    return ((await r.json()) as { offerts: { id: string; nom: string }[] }).offerts.find((o) => !o.nom)!.id;
  }, JETON);
  await admin.evaluate((id) => localStorage.setItem("shh-admin-noms-offerts", JSON.stringify({ [id]: "Inès (ancien nom local)" })), sansNom);
  await admin.locator("#offerts-actualiser").click();
  await expect(admin.locator("#offerts")).toContainText("Inès (ancien nom local)");
  await expect(admin.locator("#offerts-resultat")).toContainText("repris sur le serveur");
  const sansBandeau = ".onglets { position: static !important; }"; // onglets collants : hors de la capture
  await admin.locator("#carte-surmesure").screenshot({ path: `${SHOTS}/admin-comptes-sur-mesure.png`, style: sansBandeau });
  await admin.locator("#carte-offerts").screenshot({ path: `${SHOTS}/admin-acces-offerts-nommes.png`, style: sansBandeau });
  // Plus aucun stockage dans la page d'administration.
  expect(await admin.evaluate(() => localStorage.length)).toBe(0);

  // --- La personne : durées longues et 50 places, salon de 30 jours créé ------------------------
  await aller(page, "/");
  await aller(page, "/salon/nouveau");
  await expect(page.getByText("Ouvert, 50\u202fau plus")).toBeVisible();
  expect(await durees(page)).toEqual(["1 h", "6 h", "12 h", "24 h", "3 j", "7 j", "14 j", "30 j"]);
  await page.getByRole("radiogroup", { name: "Durée du salon", exact: true }).locator(".opt").filter({ hasText: "30" }).click();
  await page.screenshot({ path: `${SHOTS}/salon-nouveau-durees-longues.png`, fullPage: true });
  await bouton(page, "Créer le salon").click();
  await expect(titre(page, "Salon prêt")).toBeVisible({ timeout: 60_000 });
});

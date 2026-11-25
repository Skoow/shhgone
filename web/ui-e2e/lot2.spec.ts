// Lot 2 de l'audit de design (Offres et Accueil) : captures PC (1440) et téléphone (390) de
// l'accueil et de la page Offres (paiement fermé, puis ouvert avec Plus choisi), dans
// test-results/captures/lot2-<LOT2_TAG>/ (« avant » ou « apres »). Pleine page en mouvement réduit
// (les révélations au défilement ne cachent alors rien), et le premier écran tel quel.
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const TAG = process.env.LOT2_TAG ?? "apres";
const SHOTS = fileURLToPath(new URL(`../test-results/captures/lot2-${TAG}/`, import.meta.url));
const w = (isMobile: boolean) => (isMobile ? "tel" : "pc");

test.use({ locale: "fr-FR", timezoneId: "Europe/Paris" });
// Captures seulement (Chromium) : la capture d'un élément par WebKit injecte une feuille de style
// que la CSP refuse (erreur de page comptée par fixtures.ts) ; les vérifications sont dans
// home.spec.ts, pages.spec.ts et paiement.spec.ts, sur les quatre navigateurs.
test.skip(({ browserName }) => browserName !== "chromium", "captures Chromium");

test("captures : accueil", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/");
  await expect(page.locator("#hero-title")).toBeAttached();
  await page.screenshot({ path: `${SHOTS}${w(isMobile)}-accueil-haut.png` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({ path: `${SHOTS}${w(isMobile)}-accueil.png`, fullPage: true });
  if (TAG !== "apres") return;
  // Accueil refait : toute la page, chaque section en gros plan, et les jonctions (biais et fondus),
  // animations en marche.
  const ROOT = fileURLToPath(new URL("../test-results/captures/", import.meta.url));
  await page.screenshot({ path: `${ROOT}lot2-accueil-${w(isMobile)}-complet.png`, fullPage: true });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const s of ["facts", "how", "demo-sec", "priv", "life", "trust", "offers", "faq"]) {
    const sec = page.locator(`section.${s}`).first();
    await sec.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    await sec.screenshot({ path: `${ROOT}lot2-accueil-${w(isMobile)}-${s}.png` });
  }
  // Jonctions : la ligne de partage entre deux sections, au milieu d'une fenêtre de 500 px.
  for (const [i, s] of (["how", "priv", "life", "trust"] as const).entries()) {
    const y = await page.locator(`section.${s}`).first().evaluate((e) => e.getBoundingClientRect().top + scrollY);
    await page.evaluate((y) => scrollTo(0, y - 250), y);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${ROOT}lot2-accueil-jonction-${w(isMobile)}-${i + 1}-${s}.png`, clip: { x: 0, y: 0, width: isMobile ? 390 : 1440, height: 500 } });
  }
});

test("captures : offres, paiement fermé", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/offres");
  await expect(page.locator("[data-pay-closed]")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}${w(isMobile)}-offres-haut.png` });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.screenshot({ path: `${SHOTS}${w(isMobile)}-offres.png`, fullPage: true });
});

test.describe("paiement ouvert", () => {
  test.use({ shhServer: { paiement: { webhookStripe: "whsec_e2e_test", ipnNOWPayments: "ipn-e2e" } } });
  test("captures : offres, Plus choisi", async ({ page, shh, isMobile }) => {
    if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shh.origin + "/offres");
    const co = page.locator("[data-checkout]");
    await co.locator('[data-tier="plus"] .big').click();
    await expect(co.locator("[data-pays]")).toHaveValue("FR");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.screenshot({ path: `${SHOTS}${w(isMobile)}-offres-plus.png`, fullPage: true });
  });
});

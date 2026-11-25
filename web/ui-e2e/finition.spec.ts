// Passe de finition (design) : captures PC (1440×900) et téléphone (390×844) de chaque écran
// hors accueil, offres et compte (déjà refaits) : composeur, scellement, lien prêt, ouverture,
// contenu, suivi, historique, téléchargements, pages d'information, pied de page, menu du
// téléphone, erreurs. Hors de la suite normale : ne tourne que si FINITION_TAG est posé
// (« avant » ou « apres »), dans test-results/captures/finition-<TAG>/. Chromium seulement.
//   FINITION_TAG=apres PW_LOCAL_CHROMIUM=1 npx playwright test ui-e2e/finition.spec.ts --project=chromium-desktop --project=chromium-mobile
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { file, freshPage, sendShare, settle, unlock } from "./open-helpers";
import { addText, openFilePicker, readyHeading, sendButton } from "./send-helpers";

const TAG = process.env.FINITION_TAG ?? "";
const DIR = fileURLToPath(new URL(`../test-results/captures/finition-${TAG}/`, import.meta.url));

test.use({ locale: "fr-FR", timezoneId: "Europe/Paris" });
test.skip(TAG === "", "captures de finition : FINITION_TAG non posé");
test.skip(({ browserName }) => browserName !== "chromium", "captures Chromium");

async function shot(page: Page, isMobile: boolean, name: string, full = false) {
  mkdirSync(DIR, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}${isMobile ? "tel" : "pc"}-${name}.png`, fullPage: full });
}

test("finition : pages d'information, pied, menu, erreurs", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const p of ["securite", "confidentialite", "conditions", "mentions-legales", "signaler", "verifier"]) {
    await page.goto(`${shh.origin}/${p}`);
    await expect(page.locator("h1")).toBeVisible();
    await shot(page, isMobile, `info-${p}`);
    if (p === "securite") await shot(page, isMobile, `info-${p}-page`, true);
  }
  await page.goto(shh.origin + "/");
  await page.locator("footer[data-foot]").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await shot(page, isMobile, "pied");
  if (isMobile) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.getByRole("banner").getByRole("button", { name: "Ouvrir le menu" }).click();
    await shot(page, isMobile, "menu");
  }
  await page.goto(shh.origin + "/offres");
  await expect(page.locator("h1")).toBeVisible();
  await shot(page, isMobile, "offres-page", true);
  await page.goto(shh.origin + "/nope");
  await shot(page, isMobile, "404");
  const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => 255 - i * 3)).toString("base64url");
  await page.goto(`${shh.origin}/s#${KEY}`);
  await expect(page.locator("h1")).toBeVisible({ timeout: 20_000 });
  await shot(page, isMobile, "lien-invalide");
  await page.goto(shh.origin + "/envois");
  await expect(page.locator("h1")).toBeVisible();
  await shot(page, isMobile, "historique-vide");
  await page.goto(shh.origin + "/telechargements");
  await expect(page.locator("h1")).toBeVisible();
  await shot(page, isMobile, "telechargements-vide");
});

test("finition : envoi, ouverture, contenu, suivi, historique", async ({ page, shh, isMobile, browser }) => {
  test.setTimeout(180_000);
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/envoyer");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await addText(page, "Le code de la porte est 4471. Le digicode change lundi.");
  const fc = await openFilePicker(page);
  await fc.setFiles([file("contrat.pdf"), file("foret-brume.jpg"), file("budget-2026.xlsx")]);
  await expect(page.locator("[data-row]")).toHaveCount(4);
  await page.evaluate(() => scrollTo(0, 0));
  await shot(page, isMobile, "composeur");
  await shot(page, isMobile, "composeur-page", true);
  await page.route("**/api/**", async (r) => {
    if (r.request().method() !== "GET") await new Promise((res) => setTimeout(res, 2500));
    await r.continue();
  });
  await sendButton(page).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${DIR}${isMobile ? "tel" : "pc"}-scellement.png` });
  await expect(readyHeading(page)).toBeVisible({ timeout: 120_000 });
  await page.unroute("**/api/**");

  const sent = await sendShare(page, shh.origin + "/envoyer", { text: "Rendez-vous jeudi à 18 h.", files: [file("contrat.pdf")], keep: true, isMobile });
  await page.goto(shh.origin + "/envois");
  await expect(page.locator("h1")).toBeVisible();
  await shot(page, isMobile, "historique");

  const vp = isMobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } };
  const { ctx: rc, page: r } = await freshPage(browser, { ...vp, locale: "fr-FR", reducedMotion: "reduce" });
  await r.goto(sent.link);
  await expect(r.getByLabel("Mot de passe", { exact: true })).toBeVisible({ timeout: 20_000 });
  await shot(r, isMobile, "ouverture");
  await r.getByLabel("Mot de passe", { exact: true }).fill("nope-nope-nope");
  await r.getByRole("button", { name: /^Déverrouiller/ }).click();
  await r.waitForTimeout(1500);
  await shot(r, isMobile, "ouverture-erreur");
  await unlock(r, sent.password);
  await shot(r, isMobile, "contenu");
  await shot(r, isMobile, "contenu-page", true);
  await rc.close();

  const { ctx: mc, page: m } = await freshPage(browser, { ...vp, locale: "fr-FR", reducedMotion: "reduce" });
  await m.goto(sent.manage);
  await expect(m.getByRole("heading", { name: "Suivi du partage" })).toBeVisible({ timeout: 20_000 });
  await shot(m, isMobile, "suivi");
  await m.getByRole("button", { name: "Supprimer maintenant" }).click();
  await shot(m, isMobile, "suivi-confirmer");
  await m.getByRole("button", { name: "Supprimer", exact: true }).click();
  await expect(m.getByRole("heading", { name: "Supprimé" })).toBeVisible({ timeout: 20_000 });
  await shot(m, isMobile, "supprime");
  await mc.close();
});

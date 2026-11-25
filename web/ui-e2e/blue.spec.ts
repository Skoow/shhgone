// Retours BLUE : deux bleus distincts, Plus = ciel, Pro = profond ; chaque
// verrou, badge, carte et colonne au bleu de SON offre. Captures fr-FR ×2 à 390 et 1440.
import { fileURLToPath } from "node:url";
import { axe, expect, test } from "./fixtures";
import { settle } from "./open-helpers";
import { addText } from "./send-helpers";

const SHOTS = fileURLToPath(new URL("../test-results/captures/BLUE/", import.meta.url));
test.use({ locale: "fr-FR", timezoneId: "Europe/Paris", deviceScaleFactor: 2 });
const w = (isMobile: boolean) => (isMobile ? 390 : 1440);
const PLUS = "rgb(62, 193, 245)";
const PRO = "rgb(92, 128, 255)";
const color = (e: Element) => getComputedStyle(e).color;

// Plus aucun verrou ni pastille Plus ou Pro
// dans le composeur ; le bloc des offres (Plus, Pro) ouvre la feuille
// d'information (« bientôt » en tête).
test("composeur et options : aucun choix payant verrouillé ; l'offre en cours dans un petit cadre ; captures", async ({ page, shh, isMobile }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: w(isMobile), height: isMobile ? 844 : 900 });
  await page.goto(shh.origin + "/");
  await addText(page, "Le code de la porte est 4471.");
  await expect(page.locator("[data-paid-space], [data-locked]")).toHaveCount(0);
  // Plus de bande des offres dans le composeur : « Votre offre : Gratuit ».
  await expect(page.locator("[data-current-offer]").filter({ visible: true })).toContainText("Gratuit");
  await settle(page);
  await page.screenshot({ path: `${SHOTS}compose-top-${w(isMobile)}.png` });
  if (isMobile) await page.getByRole("button", { name: /^Options · / }).click();
  const opts = page.locator(".opts").filter({ visible: true });
  await expect(opts.getByText(/jours|première ouverture|Jusqu'à 50/)).toHaveCount(0);
  await settle(page);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}options-${w(isMobile)}.png` });
  if (isMobile) await page.keyboard.press("Escape");
});

test("Offres : noms des offres au bleu de leur offre ; capture", async ({ page, shh, isMobile }) => {
  await page.setViewportSize({ width: w(isMobile), height: isMobile ? 844 : 1000 });
  await page.goto(shh.origin + "/offres");
  expect(await page.locator('[data-tier="plus"] .nm').evaluate(color)).toBe(PLUS);
  expect(await page.locator('[data-tier="pro"] .nm').evaluate(color)).toBe(PRO);
  await settle(page);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}offres-${w(isMobile)}.png`, fullPage: true });
});

// « Vérifier cette version » (spec §28.4) : section de la page Sécurité (25 novembre ; ancienne
// page à part). L'adresse « /verifier » (et « /en/verifier »), citée par les Releases, le README et
// la spec, ouvre la page Sécurité à cette section, sans « # » (réservé aux clés). Le lien de la
// page Sécurité y descend sur place ; « Version xxxxxxx », en bas du pied de page, y mène ; plus de
// lien à part dans le pied. Commandes à recopier avec l'identité exacte du signataire ; limites
// honnêtes ; aucune empreinte affichée par la page elle-même ; aucune ressource tierce (gardes de
// fixtures.ts) ; aucun défilement de côté sur téléphone. Captures fr-FR 390 et 1440.
import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { axe, expect, test } from "./fixtures";

test.use({ locale: "fr-FR" });
const SHOTS = fileURLToPath(new URL("../test-results/captures/", import.meta.url));
const w = (isMobile: boolean) => (isMobile ? 390 : 1440);
const IDENTITE = "https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$v";

/** La section est ouverte : son titre est en haut de l'écran (sous l'en-tête), avec le focus. */
async function ouverte(page: Page, titre: string) {
  const h = page.locator("#verifier").getByRole("heading", { level: 2, name: titre });
  await expect(h).toBeFocused();
  // Défilement doux en cours : attendre son arrivée.
  await expect.poll(() => h.evaluate((e) => Math.round(e.getBoundingClientRect().top)), { timeout: 5000 }).toBeGreaterThanOrEqual(0);
  await expect.poll(() => h.evaluate((e) => Math.round(e.getBoundingClientRect().top)), { timeout: 5000 }).toBeLessThan(200);
  await expect(h).toBeInViewport();
}

test("Sécurité, section « Vérifier cette version » : contenu, lien sur place, « /verifier » ; capture", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/securite");
  const section = page.locator("#verifier");
  await expect(section.getByRole("heading", { level: 2, name: "Vérifier cette version" })).toBeVisible();
  for (const h of ["Pourquoi vérifier", "Comment c'est prouvé", "La version de ce site", "Vérifier vous-même", "Ce que la vérification ne prouve pas"])
    await expect(section.getByRole("heading", { level: 3, name: h })).toBeVisible();
  // Le sommaire la cite.
  await expect(page.getByRole("navigation", { name: "Sommaire" }).getByRole("button", { name: "Vérifier cette version" })).toBeVisible();
  await expect(section).toContainText("Vous n'avez pas à nous croire sur parole");
  await expect(section).toContainText("Cette page ne peut pas prouver sa propre intégrité : un serveur piégé pourrait la modifier aussi. Vérifiez avec un outil qui ne vient pas de ce site.");
  await expect(section).toContainText("contrôle automatique compris");
  await expect(section).toContainText("applications iOS et Android");
  await expect(section).toContainText("écrivez-nous (page Contact)");
  const cmd = section.locator("[data-cmd]");
  await expect(cmd).toHaveCount(1);
  await expect(cmd).toContainText(`--certificate-identity "${IDENTITE}"`);
  await expect(cmd).toContainText("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
  await expect(cmd).toContainText("verify-site.mjs https://shhgone.com release.json");
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/100\s?%|regexp|insecure/i);
  // Aucune empreinte calculée par la page (spec §28.8, C7).
  expect(text).not.toMatch(/\b[0-9a-f]{40,}\b/);
  // Le bloc de commandes défile seul : la page ne défile jamais de côté.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Détails techniques de la page : ceux de la vérification s'y ajoutent.
  const tech = page.locator("[data-tech]");
  await tech.locator("summary").click();
  await expect(tech).toContainText("release.json (schéma 1)");
  await expect(tech.getByRole("link", { name: /Versions publiées/ })).toHaveAttribute("href", "https://github.com/Skoow/shhgone/releases");
  await expect(tech.getByRole("link", { name: /Journal public de Sigstore/ })).toHaveAttribute("href", "https://search.sigstore.dev/");
  await expect(tech.getByRole("link", { name: /Code source public/ })).toHaveCount(1);
  await tech.locator("summary").click();
  expect(await axe(page)).toEqual([]);

  // « Vérifier que ce site sert bien le code public » : descend à la section, l'adresse ne change pas.
  await page.evaluate(() => scrollTo(0, 0));
  const lien = page.locator("#limites").getByRole("link", { name: "Vérifier que ce site sert bien le code public" });
  await expect(lien).toHaveAttribute("href", "/verifier");
  await lien.click();
  await ouverte(page, "Vérifier cette version");
  await expect(page).toHaveURL(shh.origin + "/securite");

  // Ancienne adresse : la page Sécurité, ouverte à la section.
  await page.goto(shh.origin + "/verifier");
  await expect(page).toHaveURL(shh.origin + "/verifier");
  await expect(page.getByRole("heading", { level: 1, name: "Sécurité" })).toBeVisible();
  await ouverte(page, "Vérifier cette version");
  await expect(page).toHaveTitle(/^Vérifier cette version · Shhgone$/);
  await page.screenshot({ path: `${SHOTS}contact-securite-verifier-${w(isMobile)}.png` });

  // Pied de page : plus de lien à part ; « Version xxxxxxx » mène à la section.
  const foot = page.locator("footer[data-foot]");
  await expect(foot.getByRole("list").getByRole("link", { name: "Vérifier cette version" })).toHaveCount(0);
  const version = foot.locator("[data-build]");
  await expect(version).toHaveAttribute("href", "/verifier");
  await expect(version).toHaveAccessibleName(/^Version ([0-9a-f]{7}|dev), Vérifier cette version$/);
  await page.goto(shh.origin + "/conditions");
  await version.scrollIntoViewIfNeeded();
  await version.click();
  await expect(page).toHaveURL(shh.origin + "/verifier");
  await ouverte(page, "Vérifier cette version");
  expect(shh.foreignRequests).toEqual([]);
});

test("Verify this version (en) : « /en/verifier » ouvre la page Security à la section", async ({ page, shh }) => {
  await page.goto(shh.origin + "/en/verifier");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  await ouverte(page, "Verify this version");
  await expect(page.locator("#verifier")).toContainText("This page cannot prove its own integrity: a tampered server could change it too. Verify with a tool that does not come from this site.");
  await expect(page.locator("[data-cmd]")).toContainText(`--certificate-identity "${IDENTITE}"`);
  await expect(page.locator("footer [data-build]")).toHaveAttribute("href", "/en/verifier");
  expect(await axe(page)).toEqual([]);
});

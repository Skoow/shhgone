// Page « Vérifier cette version » (spec §28.) : en français et en anglais, liée
// depuis le pied de page et la page Sécurité ; commandes à recopier avec l'identité exacte du
// signataire ; limites honnêtes ; aucune empreinte affichée par la page elle-même ; aucune
// ressource tierce (gardes de fixtures.ts : aucune requête hors de l'origine, aucune violation
// CSP) ; aucun défilement de côté sur téléphone. Captures fr-FR 390 et 1440.
import { fileURLToPath } from "node:url";
import { axe, expect, test } from "./fixtures";

test.use({ locale: "fr-FR" });
const SHOTS = fileURLToPath(new URL("../test-results/captures/verifier/", import.meta.url));
const w = (isMobile: boolean) => (isMobile ? 390 : 1440);
const IDENTITE = "https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$v";

test("Vérifier cette version : pourquoi, preuve, commandes, limites ; liée du pied de page et de Sécurité ; capture", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/securite");
  const lien = page.locator("#limites").getByRole("link", { name: "Vérifier que ce site sert bien le code public" });
  await expect(lien).toHaveAttribute("href", "/verifier");
  await lien.click();
  await expect(page).toHaveURL(shh.origin + "/verifier");
  await expect(page.getByRole("heading", { level: 1, name: "Vérifier cette version" })).toBeVisible();
  await expect(page).toHaveTitle(/Vérifier cette version/);
  for (const h of ["Pourquoi vérifier", "Comment c'est prouvé", "La version de ce site", "Vérifier vous-même", "Ce que la vérification ne prouve pas"])
    await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
  const main = page.locator("main");
  await expect(main).toContainText("Cette page ne peut pas prouver sa propre intégrité : un serveur piégé pourrait la modifier aussi. Vérifiez avec un outil qui ne vient pas de ce site.");
  await expect(main).toContainText("contrôle automatique compris");
  await expect(main).toContainText("applications iOS et Android");
  const cmd = page.locator("[data-cmd]");
  await expect(cmd).toHaveCount(1);
  await expect(cmd).toContainText(`--certificate-identity "${IDENTITE}"`);
  await expect(cmd).toContainText("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
  await expect(cmd).toContainText("verify-site.mjs https://shhgone.com release.json");
  const text = await main.innerText();
  expect(text).not.toMatch(/100\s?%|regexp|insecure/i);
  // Aucune empreinte calculée par la page (spec §28.8, C7).
  expect(text).not.toMatch(/\b[0-9a-f]{40,}\b/);
  // Le bloc de commandes défile seul : la page ne défile jamais de côté.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const tech = page.locator("[data-tech]");
  await tech.locator("summary").click();
  await expect(tech.getByRole("link", { name: /Versions publiées/ })).toHaveAttribute("href", "https://github.com/Skoow/shhgone/releases");
  await expect(tech.getByRole("link", { name: /Journal public de Sigstore/ })).toHaveAttribute("href", "https://search.sigstore.dev/");
  await tech.locator("summary").click();
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}verifier-${w(isMobile)}.png`, fullPage: true });
  // Pied de page : lien « Vérifier cette version ».
  const foot = page.locator("footer[data-foot]");
  await expect(foot.getByRole("link", { name: "Vérifier cette version" })).toHaveAttribute("href", "/verifier");
  expect(shh.foreignRequests).toEqual([]);
});

test("Verify this version (en) : même page en anglais, servie sous /en/verifier", async ({ page, shh }) => {
  await page.goto(shh.origin + "/en/verifier");
  await expect(page.getByRole("heading", { level: 1, name: "Verify this version" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("main")).toContainText("This page cannot prove its own integrity: a tampered server could change it too. Verify with a tool that does not come from this site.");
  await expect(page.locator("[data-cmd]")).toContainText(`--certificate-identity "${IDENTITE}"`);
  expect(await axe(page)).toEqual([]);
});

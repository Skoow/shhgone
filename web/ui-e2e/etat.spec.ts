// Page « État du service » (28 novembre) : un voyant par service, lu de GET /api/etat-service ;
// lien dans le pied de page ; serveur injoignable dit tel quel ; version anglaise ; axe.
import { axe, capture, expect, test } from "./fixtures";

test.describe("fr-FR", () => {
  test.use({ locale: "fr-FR" });

  test("cinq services, partages « Fonctionne », services fermés dits « Pas encore ouvert » ; pied de page ; axe ; capture", async ({ page, shh }) => {
    await page.goto(shh.origin + "/");
    await page.locator("footer").getByRole("link", { name: "État du service" }).click();
    await expect(page).toHaveURL(shh.origin + "/etat");
    await expect(page).toHaveTitle("État du service · Shhgone");
    await expect(page.getByRole("heading", { level: 1, name: "État du service" })).toBeVisible();
    const lignes = page.locator("[data-service]");
    await expect(lignes).toHaveCount(5);
    await expect(page.locator("[data-service=partages]")).toHaveAttribute("data-etat", "ok");
    await expect(page.locator("[data-service=partages]")).toContainText("Fonctionne");
    // Serveur de test : sans paiement, donc sans appels.
    await expect(page.locator("[data-service=paiement]")).toContainText("Pas encore ouvert");
    await expect(page.locator("[data-service=appels]")).toContainText("Pas encore ouvert");
    await expect(page.locator("[data-etat-statut]")).toHaveText(/^Vérifié à \d{1,2}\s?h\s?\d{2}\.$|^Vérifié à \d{1,2}:\d{2}\.$/);
    await expect(page.locator("meta[name=robots]")).toHaveAttribute("content", "noindex");
    expect(await axe(page)).toEqual([]);
    await capture(page, "etat");
  });

  test("serveur injoignable : dit tel quel, puis l'état revient à la relecture", async ({ page, shh }) => {
    await page.route("**/api/etat-service", (r) => r.abort());
    await page.goto(shh.origin + "/etat");
    await expect(page.locator("[data-etat-statut]")).toHaveText("Le serveur ne répond pas : le service est peut-être arrêté. Cette page réessaie toute seule.");
    await expect(page.locator("[data-service]")).toHaveCount(0);
    await page.unroute("**/api/etat-service");
    // Retour sur l'onglet : relu tout de suite.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("[data-service]")).toHaveCount(5);
  });
});

test("en-US : /en/etat en anglais", async ({ page, shh }) => {
  await page.goto(shh.origin + "/en/etat");
  await expect(page.getByRole("heading", { level: 1, name: "Service status" })).toBeVisible();
  await expect(page.locator("[data-service=partages]")).toContainText("Working");
  await capture(page, "etat-en");
});

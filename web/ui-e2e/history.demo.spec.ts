// Démo GitHub Pages (UI §14.3) et historique : l'historique marche, en mémoire de
// l'onglet seulement ; aucune base « shhdrop-history » sur l'origine partagée de Pages.
import { expect, test } from "./fixtures";
import { addText, readyHeading, sendButton } from "./send-helpers";

test.use({ locale: "fr-FR" });

test("démo : envoi → « Vos envois » (en mémoire), aucune base IndexedDB d'historique", async ({ page, demo }) => {
  test.setTimeout(120_000);
  await page.goto(demo.url);
  await addText(page, "Démo");
  await sendButton(page).click();
  await expect(readyHeading(page)).toBeVisible({ timeout: 60_000 });
  // Désactivé par défaut : la personne l'active.
  const keep = page.getByRole("switch", { name: "Garder dans mon historique" });
  await expect(keep).toHaveAttribute("aria-checked", "false");
  await expect(keep).toBeEnabled();
  await keep.click();
  await expect(keep).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-keep][data-kept]")).toHaveCount(1);
  await page.getByRole("button", { name: "Terminé" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Terminer" }).or(page.locator(".ready").getByRole("button", { name: "Terminer" })).filter({ visible: true }).first().click();
  await expect(readyHeading(page)).toBeHidden();
  // Navigation dans l'application (aucun rechargement : la démo garde l'historique en mémoire) ;
  // « Mes partages » est dans l'en-tête, ou dans le menu ☰ sur téléphone.
  const menu = page.locator("[data-menu-button]");
  if (await menu.isVisible()) await menu.click();
  await page.getByRole(await menu.isVisible() ? "navigation" : "banner").getByRole("link", { name: "Mes partages", exact: true }).first().click();
  await expect(page).toHaveURL(/\/shhgone\/envois$/);
  await expect(page.locator("[data-share-card]")).toHaveCount(1);
  await expect(page.locator("[data-share-card] [data-state-chip]")).toHaveText("Actif");
  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
  expect(dbs).not.toContain("shhdrop-history");
});

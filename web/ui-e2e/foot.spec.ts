// Plus de roue ni de panneau Réglages ; le pied de page
// est sur toutes les pages (accueil, composeur, pages d'information, partage ouvert), ordinateur
// et téléphone, et porte « À propos » (plus de choix de langue ni de « Nettoyage automatique » :
// la langue suit le navigateur, chaque fichier a son balai). Pendant un
// envoi, ses liens sont désactivés (aucun clic ne quitte la page). Salon « bientôt » sur
// l'accueil, à part des actions d'envoi (spec §39).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { foot, footLink } from "./foot-helpers";
import { freshPage, sendShare } from "./open-helpers";
import { addFile, composerFits, readyHeading, sendButton, sleep } from "./send-helpers";

const SEG = /\/api\/shares\/segments\/\d+(\?from=\d+)?$/;

/** Aucune entrée « Réglages » (roue de l'en-tête, onglet, panneau) sur la page. */
async function noSettings(page: Page) {
  await expect(page.getByRole("button", { name: /^(Réglages|Settings)$/ })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: /^(Réglages|Settings)$/ })).toHaveCount(0);
  // En-tête : ni roue ni langue ; ses seuls boutons sont les menus de la barre du haut.
  await expect(page.getByRole("banner").getByRole("button", { name: /Réglages|Settings|Langue|Language|Français|English/ })).toHaveCount(0);
}

/** Pied présent, avec ses liens et « À propos » ; ni langue ni nettoyage automatique. */
async function fullFoot(page: Page) {
  const f = foot(page);
  await f.scrollIntoViewIfNeeded();
  await expect(f).toBeVisible();
  await expect(footLink(page, "Sécurité")).toBeVisible();
  await expect(footLink(page, "Conditions d'utilisation")).toBeVisible();
  await expect(f.getByRole("group", { name: /^(Langue|Language)$/ })).toHaveCount(0);
  await expect(f.getByRole("switch")).toHaveCount(0);
  // Plus de « À propos » (pied B) : la phrase de la marque le dit déjà.
  await expect(f.getByText("À propos", { exact: true })).toHaveCount(0);
  await page.evaluate(() => scrollTo(0, 0));
}

test.describe("fr-FR", () => {
  test.use({ locale: "fr-FR" });

  test("pied de page sur l'accueil, le composeur, une page d'info et un partage ouvert ; aucune entrée Réglages", async ({ page, shh, browser, isMobile }) => {
    test.setTimeout(120_000);
    await page.goto(shh.origin + "/");
    await noSettings(page);
    await fullFoot(page);

    await page.goto(shh.origin + "/envoyer");
    await expect(page.getByRole("heading", { name: "Votre partage" })).toBeVisible();
    await noSettings(page);
    await fullFoot(page);
    // Ordinateur : l'écran d'envoi tient entier dans l'écran, le pied vient dessous.
    if (!isMobile) expect(await composerFits(page)).toBe(true);

    await page.goto(shh.origin + "/securite");
    await fullFoot(page);
    await expect(page.getByRole("button", { name: /^(Réglages|Settings)$/ })).toHaveCount(0);

    const { ctx, page: sender } = await freshPage(browser);
    const s = await sendShare(sender, shh.origin + "/", { text: "Le code de la porte est 4471." });
    await ctx.close();
    await page.goto(s.link);
    await noSettings(page);
    await fullFoot(page);
  });

  // Ancien test « langue et nettoyage automatique changés depuis le pied de page » : les deux
  // réglages sont retirés. La langue suit le
  // navigateur (i18n.spec.ts) ; le nettoyage se fait au balai (envoi.spec.ts).

  test("pendant un envoi : pied affiché, liens désactivés avec leur raison", async ({ page, shh }) => {
    test.setTimeout(120_000);
    await page.goto(shh.origin + "/envoyer");
    await addFile(page, "doc.bin", 6 * 1048576);
    await page.route(SEG, async (route) => {
      await sleep(1500);
      await route.continue().catch(() => undefined);
    });
    await sendButton(page).click();
    await expect(page.getByRole("heading", { name: "Chiffrement et envoi" })).toBeVisible({ timeout: 30_000 });
    const f = foot(page);
    await expect(f).toBeAttached();
    const reason = f.locator("[data-foot-busy]");
    await expect(reason).toContainText("désactivés pendant l'envoi");
    // Plus de bandeau visible : la raison est lue par les lecteurs d'écran et en bulle.
    await expect(reason).toHaveClass(/sr-only/);
    await expect(footLink(page, "Sécurité")).toHaveAttribute("title", /désactivés pendant l'envoi/);
    // Liens : désactivés, décrits par la raison, gardés au clavier ; un clic ne quitte pas la page.
    const sec = footLink(page, "Sécurité");
    await expect(sec).toHaveAttribute("aria-disabled", "true");
    await expect(sec).toHaveAccessibleDescription(/désactivés pendant l'envoi/);
    await expect(sec).not.toHaveAttribute("tabindex", "-1");
    await expect(footLink(page, /^Open source sur GitHub/)).toHaveAttribute("aria-disabled", "true");
    await expect(f.getByRole("link", { name: "Shhgone, accueil" })).toHaveAttribute("aria-disabled", "true");
    for (const l of await f.getByRole("link").all()) await expect(l).toHaveAttribute("aria-disabled", "true");
    await sec.click({ force: true });
    expect(new URL(page.url()).pathname).toBe("/envoyer");
    // Toujours en cours d'envoi (aucun écran quitté).
    await expect(page.getByRole("heading", { name: "Chiffrement et envoi" })).toBeVisible();
    await expect(readyHeading(page)).toBeVisible({ timeout: 90_000 });
  });

  test("Salon : plus de bouton à part sur l'accueil ; avec les autres actions de « Créer sur place », « bientôt », désactivé avec sa raison", async ({ page, shh, isMobile }) => {
    await page.goto(shh.origin + "/");
    // Deux boutons seulement dans le héros (fichiers, créer sur place).
    await expect(page.locator("[data-room]")).toHaveCount(0);
    // Cadre d'envoi : Choisir des fichiers, Photo ou vidéo, Vocal, Salon (bientôt).
    await expect(page.locator("[data-ctas] button")).toHaveCount(4);
    await expect(page.locator('[data-make="room"]')).toContainText("bientôt");
    await page.locator('[data-make="room"]').click();
    await expect(page).toHaveURL(shh.origin + "/envoyer");
    // Téléphone : la feuille « Ajouter » s'ouvre ; ordinateur : la rangée « Créer sur place ».
    const scope = isMobile ? page.getByRole("dialog", { name: "Ajouter" }) : page.getByRole("group", { name: "Créer sur place" });
    const room = scope.getByRole("button", { name: /^Salon/ });
    await expect(room).toBeVisible();
    await expect(room).toHaveAttribute("aria-disabled", "true");
    await expect(room).toContainText("bientôt");
    await expect(room).toBeInViewport(); // feuille du bas : attendre la fin de sa montée
    await room.click({ force: true }); // aria-disabled : un appui annonce « Bientôt », rien d'autre
    await expect(page).toHaveURL(shh.origin + "/envoyer");
  });

  test("ordinateur : plus de lumière au pointeur (contour lumineux gardé) ; « Créer sur place » en haut ; flèche sous le texte", async ({ page, shh, isMobile }) => {
    test.skip(isMobile, "ordinateur seulement (téléphone : feuille « Ajouter », inchangée)");
    // Le réceptacle n'est plus que sur la page d'envoi (carte de l'accueil, avec sa lumière
    // ambiante, retirée) : aucun projecteur au pointeur.
    await page.goto(shh.origin + "/envoyer");
    await expect(page.locator(".vessel .spot, .vessel .spot-clip")).toHaveCount(0);
    await page.mouse.move(1000, 500);
    await expect(page.locator(".vessel.lit")).toHaveCount(0);

    await page.goto(shh.origin + "/envoyer");
    const make = page.getByRole("group", { name: "Créer sur place" });
    await expect(make).toBeVisible();
    const zone = page.locator(".dropzone.empty");
    const [cap, mk, dz] = [await page.locator(".top .cap").boundingBox(), await make.boundingBox(), await zone.boundingBox()];
    // Sous la ligne de capacité, au-dessus de la zone de dépôt.
    expect(mk!.y).toBeGreaterThanOrEqual(cap!.y + cap!.height - 1);
    expect(mk!.y + mk!.height).toBeLessThanOrEqual(dz!.y + 1);
    // Libellés écrits à côté des icônes ; « Photo ou vidéo » est UN seul bouton.
    await expect(make.getByRole("button", { name: "Photo ou vidéo", exact: true })).toHaveCount(1);
    for (const b of await make.getByRole("button").all()) expect(await b.locator(":scope > span").last().evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(20);
    // Flèche SOUS « Déposez… » / « ou cliquez… », sans phrase de collage.
    const [tx, ic] = [await zone.locator(".dz-tx").boundingBox(), await zone.locator(".dz-ic").boundingBox()];
    expect(ic!.y).toBeGreaterThanOrEqual(tx!.y + tx!.height);
    await expect(zone).toHaveText(/^\s*Déposez des fichiers n'importe où sur la page\s*ou cliquez ici pour les choisir\s*$/);
    expect(await composerFits(page)).toBe(true);
  });
});

test("page courte sur grand écran : le pied de page touche le bas de l'écran, sans bande vide dessous", async ({ page, shh }) => {
  await page.setViewportSize({ width: 2000, height: 1300 });
  await page.goto(shh.origin + "/telechargements");
  const f = foot(page);
  await expect(f).toBeVisible();
  const b = (await f.boundingBox())!;
  const bas = await page.evaluate(() => Math.max(innerHeight, document.documentElement.scrollHeight));
  expect(Math.abs(b.y + b.height - bas)).toBeLessThan(2);
});

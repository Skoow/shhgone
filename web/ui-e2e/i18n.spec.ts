import type { Page } from "@playwright/test";
import { axe, capture, expect, test } from "./fixtures";
import { foot, footLink, pageIn } from "./foot-helpers";

/** Va à la page Sécurité : lien du pied de page (présent partout, ordinateur et téléphone). */
async function openSecurity(page: Page) {
  const l = footLink(page, /^(Sécurité|Security)$/);
  await l.scrollIntoViewIfNeeded();
  await l.click();
}

test.describe("français par défaut", () => {
  test.use({ locale: "fr-FR" });

  // Plus de bascule dans le pied de page : la langue du
  // navigateur décide ; un onglet en anglais montre les textes et titres anglais.
  test("la langue du navigateur décide <html lang>, les textes et les titres ; rien n'est stocké", async ({ page, shh, browser }) => {
    await page.goto(shh.origin + "/inconnu");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.getByRole("heading", { name: "Cette page n'existe pas." })).toBeVisible();
    await expect(page).toHaveTitle("Page introuvable · Shhgone");
    await expect(foot(page).getByRole("group", { name: /^(Langue|Language)$/ })).toHaveCount(0);

    const en = await pageIn(browser, "en-US", shh.origin + "/inconnu");
    await expect(en.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(en.page.getByRole("heading", { name: "This page does not exist." })).toBeVisible();
    await expect(en.page).toHaveTitle("Page not found · Shhgone");
    // Titre par route (scan UX B9) : Sécurité, puis l'accueil.
    await openSecurity(en.page);
    await expect(en.page).toHaveTitle("Security and encryption · Shhgone");
    // Pages bilingues : l'adresse donne la langue ; « / » reste en français et
    // propose « English version » vers « /en ».
    await expect(en.page).toHaveURL(shh.origin + "/en/securite");
    await en.page.goto(shh.origin + "/");
    await expect(en.page.locator("html")).toHaveAttribute("lang", "fr");
    // Bandeau en haut de page (≥ 44 px), au-dessus de la barre du
    // site et sans la recouvrir ; fermable (il ne revient pas en changeant d'écran).
    const bar = en.page.locator("[data-english-bar]");
    await expect(bar).toBeVisible();
    const b = (await bar.boundingBox())!;
    expect(b.y).toBe(0);
    expect(b.height).toBeGreaterThanOrEqual(44);
    const top = (await en.page.locator("header.top").boundingBox())!;
    expect(top.y).toBeGreaterThanOrEqual(b.y + b.height - 1);
    for (const l of [en.page.locator("[data-english-link]"), en.page.locator("[data-english-close]")]) {
      expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await axe(en.page)).toEqual([]);
    await en.page.locator("[data-english-close]").click();
    await expect(bar).toHaveCount(0);
    await en.page.goto(shh.origin + "/");
    await en.page.locator("[data-english-link]").click();
    await expect(en.page).toHaveURL(shh.origin + "/en");
    await expect(en.page).toHaveTitle("Shhgone · End-to-end encrypted sharing, no account needed");
    await en.ctx.close();
    // Accueil : titre descriptif (référencement, retours CLEAN2) ; page d'envoi : « Envoyer ».
    await page.goto(shh.origin + "/");
    await expect(page).toHaveTitle("Shhgone · Partage chiffré de bout en bout, sans compte");
    await page.goto(shh.origin + "/envoyer");
    await expect(page).toHaveTitle("Envoyer · Shhgone");

    const stored = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
      idb: (await indexedDB.databases()).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0, cookie: "", idb: 0 });
    expect((await page.context().cookies()).length).toBe(0);
  });


  test("lien d'évitement : focus sur le contenu, aucun # dans l'adresse", async ({ page, shh }) => {
    await page.goto(shh.origin + "/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Aller au contenu" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#contenu")).toBeFocused();
    expect(new URL(page.url()).hash).toBe("");
  });

  // Pages d'information séparées : « Sécurité » charge sa page ; la navigation
  // interne sans rechargement se vérifie donc dans l'application, de la page d'envoi vers l'accueil.
  test("navigation interne sans rechargement, focus sur le contenu, retour arrière", async ({ page, shh, isMobile }) => {
    // De la page d'envoi à l'accueil par le logo (lien de l'application, toujours présent).
    await page.goto(shh.origin + "/envoyer");
    await page.evaluate(() => ((window as unknown as { __marque: number }).__marque = 1));
    await page.locator("a.logo").click();
    await expect(page).toHaveURL(shh.origin + "/");
    // Focus dans le contenu : sur <main>, ou sur le titre de l'écran qui l'a pris (téléphone).
    await expect.poll(() => page.evaluate(() => document.querySelector("main#contenu")?.contains(document.activeElement) ?? false)).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(shh.origin + "/envoyer");
    expect(await page.evaluate(() => (window as unknown as { __marque?: number }).__marque)).toBe(1);
  });

  test("404 de l'interface : axe et capture", async ({ page, shh }) => {
    await page.goto(shh.origin + "/s/a/b");
    await expect(page.getByRole("heading", { name: "Cette page n'existe pas." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Retour à l'accueil" })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await capture(page, "coque-404-fr");
  });
});

test.describe("anglais par défaut", () => {
  test.use({ locale: "en-GB" });

  test("langue du navigateur non française → anglais (page de l'application ; version /en des pages bilingues)", async ({ page, shh }) => {
    await page.goto(shh.origin + "/envoyer");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.goto(shh.origin + "/en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("[data-english-link]")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await capture(page, "coque-en");
  });
});

test("le verre de l'en-tête apparaît au défilement et pas avant", async ({ page, shh }) => {
  await page.goto(shh.origin + "/inconnu");
  const header = page.locator("header.top");
  await expect(header).not.toHaveClass(/scrolled/);
  await page.evaluate(() => {
    document.body.style.minHeight = "4000px"; // CSSOM : permis par la CSP, contrairement à l'attribut style
  });
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect(header).toHaveClass(/scrolled/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(header).not.toHaveClass(/scrolled/);
});

test("ni en-tête ni pied de page ne proposent de langue : elle suit le navigateur", async ({ page, shh }) => {
  await page.goto(shh.origin + "/inconnu");
  await expect(page.getByRole("button", { name: /^(English|Français)$/ })).toHaveCount(0);
  await expect(foot(page).getByRole("group", { name: /^(Langue|Language)$/ })).toHaveCount(0);
});

test("le secret du # ne fuit ni dans le DOM, ni dans le titre, ni dans la console, ni dans une requête", async ({ page, shh }) => {
  const SECRET = "SECRETSECRET";
  const consoleTexts: string[] = [];
  const urls: string[] = [];
  page.on("console", (m) => consoleTexts.push(m.text()));
  page.on("request", (r) => urls.push(r.url()));
  await page.goto(`${shh.origin}/s/AbCdEfGhIjKlMnOpQrStUv#${SECRET}`);
  await expect(page.locator("main#contenu")).toBeVisible();
  // Navigation interne : le routeur travaille sous l'adresse complète.
  await openSecurity(page);
  await page.goBack();
  await page.evaluate(() => 0);
  expect(await page.content()).not.toContain(SECRET);
  expect(await page.title()).not.toContain(SECRET);
  expect(consoleTexts.join("\n")).not.toContain(SECRET);
  expect(urls.join("\n")).not.toContain(SECRET);
});

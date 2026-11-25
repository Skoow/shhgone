// Nom du partage, sur le vrai serveur : champ des options,
// « Lien prêt » (en tête des informations), page d'ouverture puis de contenu du destinataire (titre,
// texte brut isolé, jamais dans l'onglet). Rien n'est gardé sur l'appareil de l'expéditeur
// (historique des liens retiré, spec §33).
import type { Page } from "@playwright/test";
import { axe, expect, test } from "./fixtures";
import { freshPage, pwField, sendShare, unlockButton } from "./open-helpers";

// Inversion de sens et blancs : retirés et regroupés par le moteur ; balises : du texte.
const TYPED = "  Dossier‮ Dupont   <b>T4</b> ";
const TITLE = "Dossier Dupont <b>T4</b>";

/** Tout le stockage local de la page (localStorage, sessionStorage, noms des bases IndexedDB). */
const storage = (page: Page) =>
  page.evaluate(async () => [JSON.stringify(localStorage), JSON.stringify(sessionStorage), JSON.stringify((await indexedDB.databases?.()) ?? [])].join("\n"));

test.describe("fr-FR", () => {
  test.use({ locale: "fr-FR", timezoneId: "Europe/Paris" });

  test("nom du partage : Lien prêt, ouverture, contenu ; rien gardé chez l'expéditeur", async ({ page, shh, browser, isMobile }) => {
    test.setTimeout(180_000);
    const sent = await sendShare(page, shh.origin + "/", { text: "Le code est 4471.", title: TYPED, isMobile });

    // « Lien prêt » : le nom (nettoyé par le moteur) en tête du bloc d'informations, en texte brut.
    const facts = page.locator("[data-ready-card] [data-ready-facts]");
    const name = facts.locator("[data-ready-name]");
    await expect(name.locator("bdi")).toHaveText(TITLE);
    expect(await facts.evaluate((f) => f.firstElementChild?.hasAttribute("data-ready-name"))).toBe(true);
    await expect(name.locator("b")).toHaveCount(0);
    await expect(page).not.toHaveTitle(/Dupont/);
    expect(await axe(page)).toEqual([]);

    // Rien de gardé chez l'expéditeur : ni le nom, ni une base d'historique.
    const raw = await storage(page);
    for (const s of ["Dupont", "Dossier", "shhdrop-history"]) expect(raw).not.toContain(s);

    // Destinataire, autre contexte : avant le déverrouillage, rien (manifeste chiffré) ; après, le
    // nom en titre de la page de contenu, isolé (bdi), jamais dans le titre de l'onglet.
    const r = await freshPage(browser);
    await r.page.goto(sent.link);
    await expect(pwField(r.page)).toBeVisible({ timeout: 30_000 });
    await expect(r.page.locator("body")).not.toContainText("Dupont");
    await pwField(r.page).fill(sent.password);
    await unlockButton(r.page).click();
    const h1 = r.page.getByRole("heading", { level: 1, name: `Contenu, ${TITLE}` });
    await expect(h1).toBeVisible({ timeout: 30_000 });
    await expect(h1.locator("bdi")).toHaveText(TITLE);
    await expect(h1.locator("b")).toHaveCount(0);
    await expect(r.page).not.toHaveTitle(/Dupont/);
    expect(await axe(r.page)).toEqual([]);
    await r.ctx.close();
  });

  test("sans nom : rien sur « Lien prêt », « Contenu » chez le destinataire", async ({ page, shh, browser, isMobile }) => {
    test.setTimeout(120_000);
    const sent = await sendShare(page, shh.origin + "/", { text: "Sans nom.", isMobile });
    await expect(page.locator("[data-ready-name]")).toHaveCount(0);
    const r = await freshPage(browser);
    await r.page.goto(sent.link);
    await pwField(r.page).fill(sent.password);
    await unlockButton(r.page).click();
    await expect(r.page.getByRole("heading", { level: 1, name: "Contenu", exact: true })).toBeVisible({ timeout: 30_000 });
    await r.ctx.close();
  });
});

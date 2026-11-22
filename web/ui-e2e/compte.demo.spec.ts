// Compte essayable de la démo GitHub Pages (propriétaire, 19 novembre ; conception du compte par
// passkey §11, Q8) : faux serveur du compte dans l'onglet (src/demo/fake-compte.ts) et passkey
// SIMULÉE (src/demo/passkeys.ts) : aucune feuille du système, aucune passkey laissée dans le
// gestionnaire du visiteur ; la clé de récupération, les enveloppes et les coffres sont les vrais
// (moteur). Parcours par l'interface réelle : inscription, déconnexion, connexion, clé de
// récupération, suppression. Gardes de la fixture `demo` : aucune requête /api sur le réseau, rien
// hors de l'origine, aucune violation de la CSP. Aucun authentificateur virtuel : la démo tourne
// aussi sous WebKit.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PSEUDO = "LeaDemo";

/**
 * Navigation dans l'application, sans rechargement : une session sans « Rester connecté » ne
 * survit pas à un rechargement (voulu), `page.goto` la fermerait.
 */
async function aller(page: Page, url: string, chemin: string) {
  const cible = new URL(url).pathname + chemin;
  await page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, cible);
  await expect(page).toHaveURL(new RegExp(chemin.replace(/[/]/g, "\\/") + "$"));
}

async function inscrire(page: Page, url: string): Promise<string> {
  await aller(page, url, "compte/inscription");
  await expect(page.locator("[data-demo-note]")).toContainText("Dans la démo, aucune passkey n'est créée");
  await page.getByLabel("Pseudo", { exact: true }).fill(PSEUDO);
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 });
  await page.getByRole("button", { name: "Créer avec une passkey", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Votre clé de récupération" })).toBeVisible({ timeout: 30_000 });
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  await page.getByRole("button", { name: "Je l'ai notée", exact: true }).click();
  const label = (await page.locator("label").filter({ hasText: "Tapez le groupe" }).textContent())!;
  await page.getByLabel(label.trim(), { exact: true }).fill(cle.split("-")[Number(/n°\s*(\d)/u.exec(label)![1]) - 1]!);
  await page.getByRole("button", { name: "Terminer", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Compte créé." })).toBeVisible({ timeout: 30_000 });
  return cle;
}

async function deconnecter(page: Page, url: string) {
  await aller(page, url, "compte");
  await page.locator("main").getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page.getByRole("banner").getByRole("link", { name: "Se connecter" })).toBeVisible();
}

test.describe("compte de la démo", () => {
  // Ordinateur : « Se connecter » et « Mon compte » sont dans l'en-tête (téléphone : menu ☰).
  test.use({ locale: "fr-FR", viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
  test.setTimeout(180_000);

  test("inscription avec la passkey simulée, déconnexion, connexion en un clic ; rien sur le réseau ; ni la clé ni le pseudo affiché dans l'état de l'onglet", async ({ page, demo }) => {
    await page.goto(demo.url);
    await page.getByRole("banner").getByRole("link", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(/\/compte\/connexion$/);
    const cle = await inscrire(page, demo.url);
    await expect(page.getByRole("banner").getByRole("link", { name: "Mon compte" })).toBeVisible();
    await deconnecter(page, demo.url);
    await aller(page, demo.url, "compte/connexion");
    await page.getByRole("button", { name: "Se connecter avec une passkey", exact: true }).click();
    await expect(page.locator("[data-connecte]")).toBeVisible({ timeout: 30_000 });
    const garde = await page.evaluate(() => sessionStorage.getItem("shh.demo.compte") ?? "");
    expect(garde).toContain("leaderno"); // p_canon (squelette UTS #39 : « m » → « rn »), comme le vrai serveur le reçoit
    expect(garde).not.toContain(PSEUDO);
    for (const x of [cle, cle.replaceAll("-", ""), cle.toLowerCase()]) expect(garde).not.toContain(x);
    expect(garde).not.toMatch(/"results"/);
  });

  test("clé de récupération (aucune passkey sur cet « appareil »), puis suppression du compte par un geste", async ({ page, demo }) => {
    await page.goto(demo.url);
    const cle = await inscrire(page, demo.url);
    await deconnecter(page, demo.url);
    await aller(page, demo.url, "compte/recuperation");
    await page.getByLabel("Clé de récupération", { exact: true }).and(page.locator("input")).fill(cle.toLowerCase());
    await page.getByRole("button", { name: "Ouvrir", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Créez une passkey sur cet appareil" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Plus tard", exact: true }).click();
    await expect(page.locator("[data-recupere]")).toContainText("Votre clé de récupération a servi.");

    await aller(page, demo.url, "compte");
    await page.getByRole("button", { name: "Supprimer le compte" }).click();
    await page.getByRole("button", { name: "Supprimer définitivement" }).click();
    await page.getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Compte supprimé." })).toBeVisible({ timeout: 30_000 });
    await aller(page, demo.url, "compte/recuperation");
    await page.getByLabel("Clé de récupération", { exact: true }).and(page.locator("input")).fill(cle);
    await page.getByRole("button", { name: "Ouvrir", exact: true }).click();
    await expect(page.getByText("Cette clé de récupération n'ouvre aucun compte.")).toBeVisible({ timeout: 30_000 });
  });
});

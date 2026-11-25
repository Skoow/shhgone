// Conversation du salon, passe d'interface (cadre de la vitrine, panneau « Paramètres du salon »,
// coches dans la bulle, décompte d'effacement, fin de la conversation) : vrai binaire Go avec
// SHH_SALONS=1 et SHH_COMPTES=1, site avec compte (comptes-site.ts), comme salon.spec.ts.
// La créatrice sur ordinateur (1440 × 900), l'invité sur téléphone (390 × 844). Captures
// test-results/captures/salon2-*.png. Chromium seulement (passkey : authentificateur virtuel).
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";
import { siteComptes } from "./comptes-site";
import { axe, expect, test as base } from "./fixtures";

const CAPTURES = fileURLToPath(new URL("../test-results/captures", import.meta.url));

const test = base.extend<object, { site: string }>({
  site: [async ({}, use) => use(await siteComptes()), { scope: "worker", timeout: 360_000 }],
  shhServer: async ({ site }, use) => use({ comptes: { cle: new Uint8Array(randomBytes(32)) }, env: { SHH_STATIC_DIR: site } }),
});

test.use({ locale: "fr-FR", timezoneId: "Europe/Paris", actionTimeout: 30_000 });
test.setTimeout(300_000);
test.skip(({ browserName, isMobile }) => browserName !== "chromium" || isMobile, "salon2.spec.ts : une seule fois, sur Chromium ordinateur (l'invité y ouvre son propre contexte de téléphone)");

const champ = (page: Page, label: string) => page.getByLabel(label, { exact: true }).and(page.locator("input"));
const bouton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const titre = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const fil = (page: Page) => page.getByRole("log");
const saisie = (page: Page) => page.getByLabel("Message", { exact: true });
const zone = (page: Page) => page.getByRole("region", { name: "Conversation", exact: true });
const bulle = (page: Page, texte: string) => fil(page).locator("li").filter({ has: page.locator("p.texte", { hasText: texte }) });

/** Fin des animations finies (entrée du panneau, de la feuille) avant de mesurer ou de photographier. */
const fini = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));

async function photo(page: Page, nom: string): Promise<void> {
  mkdirSync(CAPTURES, { recursive: true });
  await fini(page);
  await page.screenshot({ path: `${CAPTURES}/${nom}.png` });
}

async function inscrire(page: Page, origin: string, pseudo: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await page.goto(origin + "/compte/inscription?suite=salon");
  await champ(page, "Pseudo").fill(pseudo);
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 });
  await bouton(page, "Créer avec une passkey").click();
  await expect(titre(page, "Votre clé de récupération")).toBeVisible({ timeout: 30_000 });
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  await bouton(page, "Je l'ai notée").click();
  const label = (await page.locator("label").filter({ hasText: "Tapez le groupe" }).textContent())!;
  await page.getByLabel(label.trim(), { exact: true }).fill(cle.split("-")[Number(/n°\s*(\d)/u.exec(label)![1]) - 1]!);
  await bouton(page, "Terminer").click();
  await expect(titre(page, "Compte créé.")).toBeVisible({ timeout: 30_000 });
}
async function envoyer(page: Page, texte: string): Promise<void> {
  await saisie(page).fill(texte);
  await zone(page).getByRole("button", { name: "Envoyer", exact: true }).click();
  await expect(fil(page).locator("p.texte").getByText(texte, { exact: true })).toBeVisible();
}

test("conversation : cadre, paramètres, coches, effacement, fin", async ({ page, shh, browser }) => {
  const r = randomBytes(3).toString("hex");
  const pseudoA = `Camille${r.slice(0, 2)}`;
  const pseudoB = `Noe${r.slice(2, 4)}`;
  // Vitrine (sans session), réduite sur ordinateur : marge en haut et en bas.
  await page.goto(shh.origin + "/salon/nouveau");
  const ecranVitrine = page.locator("[data-vitrine] .ecran");
  await expect(ecranVitrine).toBeVisible();
  const bv = (await ecranVitrine.boundingBox())!;
  expect(bv.y).toBeGreaterThanOrEqual(64 + 48);
  expect(bv.y + bv.height).toBeLessThanOrEqual(900 - 48);
  await photo(page, "salon2-vitrine-pc");

  await inscrire(page, shh.origin, pseudoA);
  await bouton(page, "Continuer").click();
  await bouton(page, "Créer le salon").click();
  await expect(titre(page, "Salon prêt")).toBeVisible({ timeout: 60_000 });
  const lien = (await page.locator(".cf").filter({ hasText: "Lien d'invitation" }).locator(".val").textContent())!.trim();
  const mdp = (await page.locator(".cf").filter({ hasText: "Mot de passe" }).locator(".val").textContent())!.trim();
  await bouton(page, "Entrer dans le salon").click();
  await expect(titre(page, "Un salon qui s'efface")).toBeVisible();
  await bouton(page, "Entrer dans le salon").click();
  await expect(fil(page)).toBeVisible();

  const ctxB = await (browser as Browser).newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const pageB = await ctxB.newPage();
  try {
    await pageB.goto(lien);
    await champ(pageB, "Mot de passe du salon").fill(mdp);
    await bouton(pageB, "Continuer").click();
    await expect(titre(pageB, "Un salon qui s'efface")).toBeVisible({ timeout: 30_000 });
    await champ(pageB, "Pseudonyme pour ce salon").fill(pseudoB);
    await bouton(pageB, "Entrer dans le salon").click();
    await expect(fil(pageB)).toBeVisible();

    // Mes messages à droite, ceux des autres à gauche, chez chacun.
    const t1 = `On se retrouve à 21 h devant le cinéma ${r}`;
    await envoyer(page, t1);
    await expect(fil(pageB).locator("p.texte").getByText(t1, { exact: true })).toBeVisible({ timeout: 30_000 });
    const t2 = `Parfait, je prends les billets ${r}`;
    await envoyer(pageB, t2);
    await expect(bulle(page, t2)).toBeVisible({ timeout: 30_000 });
    const droite = async (p: Page, texte: string) => {
      const li = (await bulle(p, texte).boundingBox())!;
      const fl = (await fil(p).boundingBox())!;
      return li.x + li.width / 2 > fl.x + fl.width / 2;
    };
    expect(await droite(page, t1)).toBe(true);
    expect(await droite(page, t2)).toBe(false);
    expect(await droite(pageB, t2)).toBe(true);
    expect(await droite(pageB, t1)).toBe(false);
    // Coches dans la bulle, avant l'heure, sur mes messages seulement : « Vu » quand B l'a vu.
    await expect(bulle(page, t1).locator(".coche")).toHaveText("Vu", { timeout: 30_000 });
    await expect(bulle(page, t1).locator(".coche.vu svg path")).toHaveCount(2);
    await expect(bulle(page, t2).locator(".coche")).toHaveCount(0);
    const ordre = await bulle(page, t1).locator(".meta > *").evaluateAll((els) => els.map((e) => e.className.split(" ")[0] || e.tagName.toLowerCase()));
    expect(ordre.at(-1)).toBe("time");
    // Modifié : mention avant l'heure.
    await bulle(pageB, t2).getByRole("button", { name: "Actions du message" }).click();
    await bulle(pageB, t2).getByRole("button", { name: "Modifier" }).click();
    const t2b = `Parfait, je prends les billets pour nous deux ${r}`;
    await saisie(pageB).fill(t2b);
    await zone(pageB).getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(bulle(page, t2b).locator(".modifie")).toHaveText("modifié", { timeout: 30_000 });
    // Décompte de l'effacement (règle par défaut : 5 min après lecture) : en haut de la bulle.
    await expect(bulle(page, t2b).locator("[data-decompte]")).toBeVisible({ timeout: 30_000 });
    await expect(bulle(page, t2b).locator("[data-decompte]")).toContainText(/\d (min|s)/);
    const t3 = `Je garde une place près de l'allée ${r}`;
    await envoyer(page, t3);
    await expect(bulle(pageB, t3)).toBeVisible({ timeout: 30_000 });
    await expect(bulle(page, t3).locator(".coche")).toHaveText("Vu", { timeout: 30_000 });
    await photo(page, "salon2-conversation-pc");
    await photo(pageB, "salon2-conversation-tel");
    await bulle(page, t2b).scrollIntoViewIfNeeded();
    await bulle(page, t2b).screenshot({ path: `${CAPTURES}/salon2-ephemere-accuses-pc.png` });
    expect(await axe(page)).toEqual([]);

    // Paramètres : panneau latéral (ordinateur), feuille du bas (téléphone) ; Échap le ferme.
    const params = bouton(page, "Paramètres du salon");
    await expect(params).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("complementary")).toHaveCount(0); // plus de colonne à droite
    await params.click();
    const panneau = page.getByRole("dialog", { name: "Paramètres du salon" });
    await expect(panneau).toBeVisible();
    await fini(page);
    await expect(params).toHaveAttribute("aria-expanded", "true");
    await expect(panneau.getByText(pseudoB, { exact: true })).toBeVisible();
    const bp = (await panneau.boundingBox())!;
    expect(bp.x + bp.width).toBeGreaterThan(1430);
    expect(bp.height).toBeGreaterThan(850);
    await photo(page, "salon2-parametres-pc");
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(panneau).toHaveCount(0);
    await expect(params).toBeFocused();
    await bouton(pageB, "Paramètres du salon").click();
    const feuille = pageB.getByRole("dialog", { name: "Paramètres du salon" });
    await expect(feuille).toBeVisible();
    await fini(pageB);
    const bf = (await feuille.boundingBox())!;
    expect(Math.round(bf.y + bf.height)).toBe(844);
    await photo(pageB, "salon2-parametres-tel");
    // Règle d'effacement à 1 min (depuis la feuille), puis un message qui s'efface pour de bon.
    await feuille.getByRole("radio", { name: "1 min après lecture" }).click();
    await pageB.keyboard.press("Escape");
    await expect(fil(page).getByText(`${pseudoB} a réglé l'effacement des messages`)).toBeVisible({ timeout: 30_000 });
    const t4 = `Ce message part dans une minute ${r}`;
    await envoyer(pageB, t4);
    await expect(bulle(page, t4)).toBeVisible({ timeout: 30_000 });
    await expect(bulle(page, t4).locator("[data-decompte]")).toBeVisible({ timeout: 30_000 });
    await photo(pageB, "salon2-ephemere-tel");
    await expect(bulle(page, t4)).toHaveCount(0, { timeout: 120_000 });
    await expect(bulle(pageB, t4)).toHaveCount(0, { timeout: 120_000 });

    // Fin : la créatrice détruit le salon ; chez l'invité, « Cette conversation est terminée » et l'heure.
    await params.click();
    await panneau.getByRole("button", { name: "Détruire le salon" }).first().click();
    await panneau.getByRole("button", { name: "Détruire le salon" }).last().click();
    await expect(titre(pageB, "Cette conversation est terminée")).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText(/^Terminée le \d{1,2}\s\S+\sà\s\d{1,2}\u202fh\u202f\d{2}$/)).toBeVisible();
    await expect(pageB.getByRole("link", { name: "Créer un salon" })).toBeVisible();
    await photo(pageB, "salon2-termine-tel");
    expect(await axe(pageB)).toEqual([]);
    await expect(titre(page, "Cette conversation est terminée")).toBeVisible({ timeout: 30_000 });
    await photo(page, "salon2-termine-pc");
    // Adresse d'un salon fini ouverte plus tard : jamais « Cette page n'existe pas », ni date.
    await pageB.goto(lien);
    await expect(titre(pageB, "Cette conversation est terminée ou n'existe plus")).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText("Cette page n'existe pas")).toHaveCount(0);
    await expect(pageB.getByText(/^Terminée le/)).toHaveCount(0);
    await photo(pageB, "salon2-termine-lien-tel");
    await page.goto(lien);
    await expect(titre(page, "Cette conversation est terminée ou n'existe plus")).toBeVisible({ timeout: 30_000 });
    await photo(page, "salon2-termine-lien-pc");
    expect(await axe(page)).toEqual([]);
  } finally {
    await ctxB.close();
  }
});

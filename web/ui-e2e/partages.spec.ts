// « Mes partages » (spec §33, D42-30), « Se déconnecter » de la barre du bas et de la ligne du haut,
// confirmation Oui / Non de la suppression du compte avec un abonnement (26 novembre). Vrai binaire
// Go, site avec compte (SHH_SITE_COMPTES=1), paiement en bac à sable (pass payé : pass-helpers.ts),
// passkey par l'authentificateur virtuel de Chromium. Captures dans SHH_CAPTURES_PARTAGES si posé
// (revue visuelle), sinon dans le dossier des captures du banc.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { siteComptes } from "./comptes-site";
import { axe, expect, test as base } from "./fixtures";
import { sendShare } from "./open-helpers";
import { passPaye } from "./pass-helpers";

const test = base.extend<object, { site: string }>({
  site: [async ({}, use) => use(await siteComptes()), { scope: "worker", timeout: 360_000 }],
  shhServer: async ({ site }, use) => use({ comptes: { cle: new Uint8Array(randomBytes(32)) }, paiement: { webhookStripe: "whsec_e2e_partages", ipnNOWPayments: "ipn-e2e-partages" }, env: { SHH_STATIC_DIR: site } }),
});
test.use({ locale: "fr-FR", timezoneId: "Europe/Paris", actionTimeout: 30_000, viewport: async ({ isMobile }, use) => use(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }) });
test.setTimeout(240_000);
test.skip(({ browserName }) => browserName !== "chromium", "passkey par l'authentificateur virtuel de Chromium (CDP)");

const DIR = process.env.SHH_CAPTURES_PARTAGES ?? "";
async function shot(page: Page, nom: string, isMobile: boolean): Promise<void> {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(400); // animations d'arrivée finies
  await page.screenshot({ path: join(DIR, `${nom}-${isMobile ? "telephone" : "pc"}.png`), fullPage: false });
}
/** Navigation dans l'application, sans recharger (la session du compte n'est qu'en mémoire). */
async function aller(page: Page, chemin: string): Promise<void> {
  await page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, chemin);
}
const champ = (page: Page, label: string) => page.getByLabel(label, { exact: true }).and(page.locator("input"));
const bouton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const titre = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });

async function inscrire(page: Page, origin: string, pseudo: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await page.goto(origin + "/compte/inscription?suite=salon");
  await champ(page, "Pseudo").fill(pseudo);
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 });
  await bouton(page, "Créer avec une passkey").or(bouton(page, "Garder le compte sur cet ordinateur")).click();
  await expect(titre(page, "Votre clé de récupération")).toBeVisible({ timeout: 30_000 });
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  await bouton(page, "Copier").click();
  await bouton(page, "Je l'ai notée").click();
  const label = (await page.locator("label").filter({ hasText: "Tapez le groupe" }).textContent())!;
  await page.getByLabel(label.trim(), { exact: true }).fill(cle.split("-")[Number(/n°\s*(\d)/u.exec(label)![1]) - 1]!);
  await bouton(page, "Terminer").click();
  await expect(titre(page, "Compte créé.")).toBeVisible({ timeout: 30_000 });
}

test("sans compte : Lien prêt sans lien de gestion, Mes partages (vide puis plein), Supprimer et Retirer", async ({ page, shh, isMobile }) => {
  await page.goto(shh.origin + "/envois");
  await expect(titre(page, "Mes partages")).toBeVisible();
  await expect(page.locator("[data-shares-empty]")).toBeVisible();
  await expect(page.locator("[data-shares-device]")).toContainText("Sans compte, cette liste n'existe que dans ce navigateur");
  expect(await axe(page)).toEqual([]);
  await shot(page, "mes-partages-vide", isMobile);

  const sent = await sendShare(page, shh.origin + "/envoyer", { text: "Le code de la porte est 4471.", title: "Code de la porte", opens: 3, isMobile });
  await expect(page.locator("[data-kept]")).toContainText("Retrouvez ce partage dans Mes partages.");
  await expect(page.locator("[data-kept-device]")).toBeVisible();
  await expect(page.locator(".ready")).not.toContainText(sent.manage.slice(sent.manage.indexOf("#")));
  expect(await axe(page)).toEqual([]);
  await shot(page, "lien-pret", isMobile);
  // Un deuxième partage, puis le lien de « Lien prêt » (la garde de sortie demande, rien n'est copié).
  await sendShare(page, shh.origin + "/envoyer", { text: "Deuxième note.", isMobile });
  page.once("dialog", (d) => void d.accept());
  await page.locator("[data-kept] a[data-shares-link]").click();
  await expect(titre(page, "Mes partages")).toBeVisible();
  const cartes = page.locator("[data-share-card]");
  await expect(cartes).toHaveCount(2);
  await expect(cartes.filter({ hasText: "Code de la porte" })).toContainText("Ouvert 0 / 3");
  await expect(page.locator("main")).not.toContainText(sent.manage.slice(sent.manage.indexOf("#") + 2));
  expect(await axe(page)).toEqual([]);
  await shot(page, "mes-partages-plein", isMobile);
  // Supprimer : pour tout le monde (par le lien de gestion) ; la carte dit « Détruit ».
  const c = cartes.filter({ hasText: "Code de la porte" });
  await c.getByRole("button", { name: "Supprimer", exact: true }).click();
  // Confirmation sur place (ordinateur) ou dans une feuille du bas (téléphone).
  await (isMobile ? page.getByRole("dialog") : c.getByRole("group")).getByRole("button", { name: "Supprimer", exact: true }).click();
  await expect(c).toHaveAttribute("data-state", "detruit");
  const r = await fetch(shh.origin + "/api/manage/status", { headers: { "X-Shh-Manage": sent.manage.slice(sent.manage.indexOf("#m") + 2) } });
  expect(r.status).toBe(404);
  await c.getByRole("button", { name: "Retirer de la liste" }).click();
  await expect(cartes).toHaveCount(1);
  // Rechargement : la liste vient de l'appareil.
  await page.reload();
  await expect(page.locator("[data-share-card]")).toHaveCount(1);
});

test("connecté : Salon prêt, Mes partages avec le salon, Se déconnecter (barre du bas, ligne du haut), suppression avec abonnement", async ({ page, shh, isMobile }) => {
  await passPaye(page, shh);
  await inscrire(page, shh.origin, `Lea${randomBytes(3).toString("hex")}`);
  await bouton(page, "Continuer").or(bouton(page, "Plus tard")).click();
  await bouton(page, "Créer le salon").click();
  await expect(titre(page, "Salon prêt")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-manage]")).toHaveCount(0);
  await expect(page.locator("[data-kept]")).toContainText("Retrouvez ce salon dans Mes partages");
  await expect(page.locator("[data-kept-device]")).toHaveCount(0); // connecté : gardé aussi dans le compte
  await shot(page, "salon-pret", isMobile);

  await aller(page, "/envois");
  await expect(page.locator("[data-share-card][data-sorte=salon]")).toBeVisible();
  await expect(page.locator("[data-share-card][data-sorte=salon] a[data-room-manage]")).toHaveAttribute("href", /\/salon#s[A-Za-z0-9_-]{43}$/);
  await expect(page.locator("[data-shares-device]")).toContainText("Avec votre compte");
  const tab = page.getByRole("navigation", { name: "Navigation principale" });
  if (isMobile) {
    await expect(tab.getByRole("link", { name: "Partages" })).toHaveAttribute("aria-current", "page");
    await expect(tab.locator("[data-tab-logout]")).toBeVisible();
    // À droite de la barre.
    const b = (await tab.locator("[data-tab-logout]").boundingBox())!;
    expect(b.x + b.width).toBeGreaterThan((page.viewportSize()?.width ?? 390) - 90);
    await shot(page, "barre-du-bas-connecte", isMobile);
  } else {
    await expect(page.locator("[data-nav-logout]")).toBeVisible();
    await expect(page.getByRole("banner").getByRole("link", { name: "Mon compte" })).toBeVisible();
    await shot(page, "ligne-du-haut-connecte", isMobile);
  }

  // La page d'envoi lit l'état du pass (au plus une fois par jour, gardé chiffré sur l'appareil) :
  // la date de fin est alors connue ici, sans requête à la suppression.
  await aller(page, "/envoyer");
  await expect(page.locator("[data-current-offer]").filter({ visible: true }).or(page.getByRole("button", { name: /^Ajouter$/ })).first()).toBeVisible();
  await page.waitForTimeout(2000);
  // Suppression : fenêtre Oui / Non avec l'abonnement Plus perdu, sa date, aucun remboursement.
  await aller(page, "/compte");
  await bouton(page, "Supprimer le compte").click();
  await expect(page.locator("[data-delete-subs]")).toContainText("Votre offre Plus, valable jusqu'au");
  await bouton(page, "Supprimer définitivement").click();
  const d = page.getByRole("dialog");
  await expect(d).toContainText("Supprimer définitivement votre compte");
  await expect(d).toContainText("sera perdue pour ce compte");
  await expect(d).toContainText("Rien n'est remboursé automatiquement.");
  // Pass de 30 jours sans renouvellement (pass-helpers.ts) : rien sur le renouvellement (vitest couvre l'autre cas).
  await expect(d).toContainText("valable jusqu'au");
  await shot(page, "confirmation-suppression-abonnement", isMobile);
  await d.getByRole("button", { name: "Non", exact: true }).click();
  await expect(d).toBeHidden();

  // Se déconnecter : confirmation légère, puis plus de session ; le salon (venu de cet appareil) reste.
  await aller(page, "/envois");
  await (isMobile ? page.locator("[data-tab-logout]") : page.locator("[data-nav-logout]")).click();
  await expect(page.getByRole("dialog")).toContainText("Se déconnecter");
  await page.getByRole("dialog").getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page.locator("[data-nav-logout], [data-tab-logout]")).toHaveCount(0);
  await expect(page.locator("[data-share-card][data-sorte=salon]")).toBeVisible();
});

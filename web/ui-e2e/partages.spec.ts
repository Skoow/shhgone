// « Mes partages » et « Mes salons » (spec §33, D42-30, D42-33), barre du bas, champ pseudo,
// fenêtres « Arrêter votre abonnement ? » et « Supprimer définitivement votre compte ? » (28 novembre). Vrai binaire
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

/** Les états du champ pseudo, capturés (création de compte) : vide, invalide, réservé, vérification, valide. */
async function capturesPseudo(page: Page, pseudo: string, isMobile: boolean): Promise<void> {
  const c = champ(page, "Pseudo");
  const etat = page.locator("[data-field-status]");
  await expect(etat).toHaveAttribute("data-field-status", "vide");
  await shot(page, "pseudo-vide", isMobile);
  await c.fill("Lé");
  await expect(etat).toHaveAttribute("data-field-status", "ko");
  await expect(page.locator("[data-regle=caracteres]")).toHaveAttribute("data-etat", "ko");
  await expect(c).toHaveAttribute("aria-invalid", "true");
  await shot(page, "pseudo-invalide", isMobile);
  await c.fill("admin");
  await expect(page.getByText("Ce pseudo est réservé.")).toBeVisible({ timeout: 30_000 });
  await shot(page, "pseudo-reserve", isMobile);
  // Vérification : la réponse du serveur est retenue le temps de la capture.
  let lacher: () => void = () => undefined;
  const retenue = new Promise<void>((ok) => (lacher = ok));
  await page.route("**/api/compte/**", async (route) => {
    if (route.request().url().includes("pseudo/verifier")) await retenue;
    await route.fallback();
  });
  await c.fill(pseudo);
  await expect(etat).toHaveAttribute("data-field-status", "verif");
  await shot(page, "pseudo-verification", isMobile);
  lacher();
  await page.unroute("**/api/compte/**");
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 });
  await expect(etat).toHaveAttribute("data-field-status", "ok");
  await expect(c).not.toHaveAttribute("aria-invalid", "true");
  expect(await axe(page)).toEqual([]);
  await shot(page, "pseudo-valide", isMobile);
}

async function inscrire(page: Page, origin: string, pseudo: string, isMobile?: boolean): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await page.goto(origin + "/compte/inscription?suite=salon");
  if (isMobile !== undefined) await capturesPseudo(page, pseudo, isMobile);
  else await champ(page, "Pseudo").fill(pseudo);
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

/** « Se termine le 29 nov. (12 h 14) » / « Terminé le … » */
const FIN = /^(Se termine|Terminé) le \d{1,2} \S+ \(\d{1,2} h \d\d\)$/u;

test("sans compte : Mes partages (vide, en cours, terminé), Supprimer le partage, Effacer l'historique ; Mes salons à part", async ({ page, shh, isMobile }) => {
  await page.goto(shh.origin + "/envois");
  await expect(titre(page, "Mes partages")).toBeVisible();
  await expect(page.locator("main")).toContainText("Les partages que vous avez envoyés. Jamais ceux que vous avez reçus.");
  await expect(page.locator("[data-shares-empty=envoi]")).toBeVisible();
  await expect(page.locator("[data-shares-empty=salon]")).toHaveCount(0);
  await expect(page.locator("[data-shares-device]")).toContainText("Sans compte, cette liste n'existe que dans ce navigateur");
  expect(await axe(page)).toEqual([]);
  await shot(page, "mes-partages-vide", isMobile);

  const sent = await sendShare(page, shh.origin + "/envoyer", { text: "Le code de la porte est 4471.", title: "Code de la porte", opens: 3, isMobile });
  await expect(page.locator("[data-kept]")).toContainText("Retrouvez ce partage dans Mes partages.");
  await expect(page.locator(".ready")).not.toContainText(sent.manage.slice(sent.manage.indexOf("#")));
  await sendShare(page, shh.origin + "/envoyer", { text: "Deuxième note.", title: "Deuxième note", isMobile });
  page.once("dialog", (d) => void d.accept());
  await page.locator("[data-kept] a[data-shares-link]").click();
  await expect(titre(page, "Mes partages")).toBeVisible();
  const cartes = page.locator("[data-share-card]");
  await expect(cartes).toHaveCount(2);
  const c = cartes.filter({ hasText: "Code de la porte" });
  await expect(c).toContainText("Ouvert 0 / 3");
  await expect(c.locator("[data-share-tag]")).toHaveText("En cours");
  await expect(c.locator("[data-share-end]")).toHaveText(FIN);
  await expect(c.locator("[data-share-end]")).toContainText("Se termine le");
  await expect(page.locator("main")).not.toContainText(/S'efface dans|Créé le/);
  await expect(page.locator("main")).not.toContainText(sent.manage.slice(sent.manage.indexOf("#") + 2));
  expect(await axe(page)).toEqual([]);
  await shot(page, "mes-partages-en-cours", isMobile);
  // « Supprimer le partage » : pour tout le monde (lien de gestion) ; la ligne passe « Terminé ».
  await c.getByRole("button", { name: "Supprimer le partage", exact: true }).click();
  const confirmation = isMobile ? page.getByRole("dialog") : c.getByRole("group");
  await expect(confirmation).toContainText("Supprimer ce partage pour tout le monde");
  await confirmation.getByRole("button", { name: "Supprimer", exact: true }).click();
  await expect(c).toHaveAttribute("data-state", "detruit");
  await expect(c.locator("[data-share-tag]")).toHaveText("Terminé");
  await expect(c.locator("[data-share-end]")).toContainText("Terminé le");
  const r = await fetch(shh.origin + "/api/manage/status", { headers: { "X-Shh-Manage": sent.manage.slice(sent.manage.indexOf("#m") + 2) } });
  expect(r.status).toBe(404);
  await expect(c.locator("[data-share-remove]")).toHaveText("Retirer");
  expect(await axe(page)).toEqual([]);
  await shot(page, "mes-partages-en-cours-et-termine", isMobile);
  // « Effacer l'historique » : Oui / Non ; « Non » ne fait rien ; « Oui » retire le terminé, garde l'actif.
  const zone = page.locator("[data-history-clear]");
  await zone.getByRole("button", { name: "Effacer l'historique" }).click();
  const question = isMobile ? page.getByRole("dialog") : zone.getByRole("group");
  await expect(question).toContainText("Ceux en cours restent.");
  await shot(page, "effacer-historique", isMobile);
  await question.getByRole("button", { name: "Non", exact: true }).click();
  await expect(cartes).toHaveCount(2);
  await zone.getByRole("button", { name: "Effacer l'historique" }).click();
  await (isMobile ? page.getByRole("dialog") : zone.getByRole("group")).getByRole("button", { name: "Oui", exact: true }).click();
  await expect(cartes).toHaveCount(1);
  await expect(cartes.first()).toContainText("Deuxième note");
  await expect(page.locator("[data-history-clear]")).toHaveCount(0);
  await shot(page, "mes-partages-historique-efface", isMobile);
  // Rechargement : la liste vient de l'appareil.
  await page.reload();
  await expect(page.locator("[data-share-card]")).toHaveCount(1);
  // Mes salons : à part, vide (aucun salon créé ici) ; jamais les partages de fichiers.
  await page.goto(shh.origin + "/salons");
  await expect(titre(page, "Mes salons")).toBeVisible();
  await expect(page.locator("main")).toContainText("Les salons que vous avez créés.");
  await expect(page.locator("[data-share-card]")).toHaveCount(0);
  await expect(page.locator("[data-shares-empty=salon]")).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await shot(page, "mes-salons-vide", isMobile);
});

test("connecté : champ pseudo, Mes salons, barre du bas, fenêtre de suppression, Se déconnecter, pseudo pris", async ({ page, shh, isMobile }) => {
  await passPaye(page, shh);
  const pseudo = `Lea${randomBytes(3).toString("hex")}`;
  await inscrire(page, shh.origin, pseudo, isMobile);
  await bouton(page, "Continuer").or(bouton(page, "Plus tard")).click();
  await bouton(page, "Créer le salon").click();
  await expect(titre(page, "Salon prêt")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-manage]")).toHaveCount(0);
  await expect(page.locator("[data-kept]")).toContainText("Retrouvez ce salon dans Mes salons");
  await expect(page.locator("[data-kept] a[data-shares-link]")).toHaveAttribute("href", "/salons");

  // Mes salons : le salon, « Gérer le salon », « En cours », date de fin ; jamais dans Mes partages.
  await aller(page, "/salons");
  await expect(titre(page, "Mes salons")).toBeVisible();
  const s = page.locator("[data-share-card][data-sorte=salon]");
  await expect(s).toBeVisible();
  await expect(s.locator("[data-share-icon=salon]")).toHaveCount(1);
  await expect(s.locator("[data-share-tag]")).toHaveText("En cours");
  await expect(s.locator("[data-share-end]")).toHaveText(FIN);
  await expect(s.locator("a[data-room-manage]")).toHaveText("Gérer le salon");
  await expect(s.locator("a[data-room-manage]")).toHaveAttribute("href", /\/salon#s[A-Za-z0-9_-]{43}$/);
  await expect(page.locator("[data-shares-device]")).toContainText("Avec votre compte");
  expect(await axe(page)).toEqual([]);
  await shot(page, "mes-salons-en-cours", isMobile);
  const tab = page.getByRole("navigation", { name: "Navigation principale" });
  if (isMobile) {
    // Barre du bas : Nouveau, Partages, Salons, Compte, Déconnexion ; libellés entiers.
    await expect(tab.getByRole("link")).toHaveText(["Nouveau", "Partages", "Salons", "Compte"]);
    await expect(tab.getByRole("link", { name: "Salons" })).toHaveAttribute("aria-current", "page");
    await expect(tab.locator("[data-tab-logout]")).toBeVisible();
    const entiers = () => tab.locator(".lb:visible").evaluateAll((ls) => ls.filter((e) => e.scrollWidth > e.clientWidth).map((e) => `${e.textContent} ${e.scrollWidth}/${e.clientWidth}`));
    expect(await entiers()).toEqual([]);
    await shot(page, "barre-du-bas-390", isMobile);
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await entiers()).toEqual([]);
    await expect(tab.locator("[data-tab-logout] .lb:visible")).toHaveText("Quitter");
    await expect(tab.locator("[data-tab-logout]")).toHaveAccessibleName("Quitter");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, "barre-du-bas-320", isMobile);
    await page.setViewportSize({ width: 390, height: 844 });
    // Menu ☰ : Mes partages, puis Mes salons ; plus de Téléchargements.
    await page.getByRole("banner").getByRole("button", { name: "Ouvrir le menu" }).click();
    const menu = page.locator("[data-menu]");
    await expect(menu.getByRole("link", { name: /^Mes salons/ })).toBeVisible();
    await expect(menu.getByRole("link", { name: /^Téléchargements/ })).toHaveCount(0);
    await shot(page, "menu-telephone", isMobile);
    await page.keyboard.press("Escape");
  } else {
    const haut = page.getByRole("banner");
    await expect(haut.getByRole("link", { name: "Mes partages" })).toBeVisible();
    await expect(haut.getByRole("link", { name: "Mes salons" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("[data-nav-logout]")).toBeVisible();
    await shot(page, "ligne-du-haut-connecte", isMobile);
  }
  await aller(page, "/envois");
  await expect(page.locator("[data-share-card]")).toHaveCount(0);

  // Page Compte : champ pseudo (pseudo actuel), carte, fenêtre de suppression avec l'abonnement.
  await aller(page, "/compte");
  await expect(page.locator("[data-regle=disponible]")).toContainText("C'est votre pseudo actuel", { timeout: 30_000 });
  const carte = page.locator("[data-carte-compte]");
  await expect(carte.locator("[data-carte-offre-texte]")).toHaveText(/^Plus jusqu'au \d{1,2} \S+ \d{4}( · ne sera pas renouvelé)?$/);
  await page.locator("#sec-profil").scrollIntoViewIfNeeded();
  await shot(page, "compte-pseudo", isMobile);
  await bouton(page, "Supprimer le compte").click();
  await expect(page.locator("[data-delete-sub-item]")).toContainText("Votre abonnement Plus");
  await bouton(page, "Supprimer définitivement").click();
  const d = page.getByRole("dialog");
  await expect(d).toContainText("Supprimer définitivement votre compte");
  await expect(d.locator("[data-delete-dialog] li")).toHaveCount(3);
  await expect(d).toContainText(/Votre abonnement Plus, valable jusqu'au \d{1,2} \S+ \d{4}, s'arrête aujourd'hui sur tous vos appareils\./);
  await expect(d.locator("[data-delete-refund]")).toHaveText("Aucun remboursement possible.");
  await expect(d).not.toContainText(/[Tt]éléchargement/);
  await expect(d.getByRole("button", { name: "Supprimer mon compte" })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await shot(page, "fenetre-supprimer-compte", isMobile);
  await d.getByRole("button", { name: "Annuler", exact: true }).click();
  await expect(d).toBeHidden();

  // Se déconnecter, puis le même pseudo à la création d'un autre compte : « Déjà pris ».
  await aller(page, "/salons");
  await (isMobile ? page.locator("[data-tab-logout]") : page.locator("[data-nav-logout]")).click();
  await page.getByRole("dialog").getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page.locator("[data-nav-logout], [data-tab-logout]")).toHaveCount(0);
  await expect(page.locator("[data-share-card][data-sorte=salon]")).toBeVisible();
  await page.goto(shh.origin + "/compte/inscription");
  await champ(page, "Pseudo").fill(pseudo);
  await expect(page.locator("[data-regle=disponible]")).toHaveAttribute("data-etat", "ko", { timeout: 30_000 });
  await expect(page.locator("[data-field-status]")).toHaveAttribute("data-field-status", "ko");
  await expect(page.getByText("Déjà pris", { exact: true })).toBeVisible();
  await shot(page, "pseudo-pris", isMobile);
});

test("abonnement qui se renouvelle : fenêtre « Arrêter votre abonnement ? », puis suppression du compte qui révoque le pass", async ({ page, shh, isMobile }) => {
  await passPaye(page, shh, { renouvelle: true });
  await inscrire(page, shh.origin, `Max${randomBytes(3).toString("hex")}`);
  await bouton(page, "Continuer").or(bouton(page, "Plus tard")).click();
  await aller(page, "/compte");
  const carte = page.locator("[data-carte-compte]");
  await expect(carte.locator("[data-carte-offre-texte]")).toHaveText(/^Plus jusqu'au .+ · renouvelé automatiquement$/);
  // Arrêter : fenêtre Oui / Non, puis la route d'arrêt (interceptée : le faux paiement n'a pas
  // d'abonnement chez un prestataire) ; la carte dit « ne sera pas renouvelé ».
  let arrets = 0;
  await page.route("**/api/paiement/resilier", (route) => {
    arrets++;
    expect(route.request().headers()["x-shh-pass"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(route.request().headers()["x-shh-session"]).toBeUndefined();
    return arrets === 1 ? route.abort("failed") : route.fulfill({ status: 204 });
  });
  await bouton(page, "Arrêter l'abonnement").click();
  const d = page.getByRole("dialog");
  await expect(d).toContainText("Arrêter votre abonnement");
  await expect(d).toContainText(/Votre abonnement Plus ne sera pas renouvelé\. Vous en profitez jusqu'au .+, puis votre compte repasse en Gratuit\./);
  await expect(d.locator("[data-carte-arret-remboursement]")).toHaveText("Aucun remboursement possible.");
  expect(await axe(page)).toEqual([]);
  await shot(page, "fenetre-arreter-abonnement", isMobile);
  await d.getByRole("button", { name: "Oui, arrêter" }).click();
  await expect(carte.locator("[data-carte-arret-erreur]")).toContainText("L'abonnement n'a pas pu être arrêté");
  await carte.getByRole("button", { name: "Réessayer" }).click();
  await expect(carte.locator("[data-carte-offre-texte]")).toHaveText(/^Plus jusqu'au .+ · ne sera pas renouvelé$/);
  await expect(carte.locator("[data-carte-arret]")).toHaveCount(0);
  await page.unroute("**/api/paiement/resilier");

  // Suppression du compte : le pass est révoqué au vrai serveur, puis le compte supprimé.
  const revocations: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/paiement/revoquer")) revocations.push(r.headers()["x-shh-pass"] ?? "");
  });
  await bouton(page, "Supprimer le compte").click();
  await bouton(page, "Supprimer définitivement").click();
  await expect(page.getByRole("dialog")).toContainText("Votre abonnement Plus");
  await bouton(page, "Supprimer mon compte").click();
  await expect(titre(page, "Compte supprimé.")).toBeVisible({ timeout: 30_000 });
  expect(revocations).toHaveLength(1);
  const etat = await fetch(shh.origin + "/api/paiement/etat", { method: "POST", headers: { "X-Shh-Pass": revocations[0]! } });
  expect(((await etat.json()) as { etat: string }).etat).toBe("revoquee");
});

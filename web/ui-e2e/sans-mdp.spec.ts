// Mot de passe facultatif, désactivé par défaut (D42-27), sur le vrai serveur et le vrai site :
// création et ouverture SANS mot de passe (lien « #l », bouton « Ouvrir », jamais d'ouverture au
// chargement) et AVEC (interrupteur, mot de passe généré, « Générer un autre », champ à
// l'ouverture). Ordinateur et téléphone (projets Playwright). Captures dans SHH_CAPTURES_SANSMDP
// quand la variable est donnée (dossier hors du dépôt).
import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { freshPage, noteRow, openButton, openNoPassword, pwField, sendShare, unlock, unlockButton } from "./open-helpers";
import { addText, enterComposer } from "./send-helpers";

test.use({ locale: "fr-FR" });
const TEXT = "Repère sans mot de passe 8b2d.";
const OUT = process.env.SHH_CAPTURES_SANSMDP;

async function shot(page: Page, name: string, focus?: Locator) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await focus?.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700); // entrées animées finies
  await page.screenshot({ path: `${OUT}/${test.info().project.name}-${name}.png`, fullPage: test.info().project.name.includes("mobile") && !focus });
}

/** Options du composeur : colonne (ordinateur) ou feuille « Options » (téléphone). */
async function options(page: Page, isMobile: boolean) {
  if (!isMobile) return page.locator(".side");
  await page.getByRole("button", { name: /^Options · / }).click();
  return page.getByRole("dialog", { name: "Options" });
}

test("création sans mot de passe (défaut) : interrupteur désactivé, avertissement ; « Lien prêt » ne montre que le lien", async ({ page, shh, isMobile }) => {
  test.setTimeout(120_000);
  await page.goto(shh.origin + "/");
  await enterComposer(page);
  await addText(page, TEXT);
  const opts = await options(page, isMobile);
  const sw = opts.getByRole("switch", { name: "Protéger par un mot de passe" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(opts.getByText("Sans mot de passe, quiconque a le lien peut ouvrir", { exact: false }).first()).toBeVisible();
  await expect(opts.getByRole("button", { name: "Générer un autre" })).toHaveCount(0);
  await shot(page, "1-creation-sans-mdp", opts.locator("[data-protect]"));
  if (isMobile) await page.keyboard.press("Escape");
  const sent = await sendShare(page, shh.origin + "/", { text: TEXT, protect: false, isMobile });
  expect(sent.password).toBe("");
  expect(sent.link).toMatch(/\/s#l[A-Za-z0-9_-]{43}$/);
  await expect(page.getByRole("group", { name: "Mot de passe", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-ready-works]")).toContainText("Sans mot de passe, quiconque a ce lien peut ouvrir le partage.");
  await expect(page.getByRole("button", { name: "Copier le lien", exact: true })).toBeVisible();
  await shot(page, "2-lien-pret-sans-mdp");
  // Feuille « Partager » : QR du lien seul.
  await page.getByRole("button", { name: "Partager", exact: true }).click();
  await page.getByRole("button", { name: "Afficher le QR code" }).click();
  await expect(page.getByRole("img", { name: "QR code du lien" })).toBeVisible();
});

test("ouverture sans mot de passe : aucun champ, jamais ouvert au chargement ; « Ouvrir » ouvre et consomme une ouverture", async ({ page, shh, browser }) => {
  test.setTimeout(120_000);
  const s = await freshPage(browser);
  const sent = await sendShare(s.page, shh.origin + "/", { text: TEXT, opens: 2, protect: false });
  await s.ctx.close();
  // Le chargement seul (comme un aperçu de messagerie qui exécute la page) ne prend rien.
  const unlocks: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/shares/unlock")) unlocks.push(r.url());
  });
  await page.goto(sent.link);
  await expect(openButton(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Ce partage n'a pas de mot de passe", { exact: false })).toBeVisible();
  await expect(pwField(page)).toHaveCount(0);
  await expect(unlockButton(page)).toHaveCount(0);
  await expect(page.getByText(/Ouvrir compte 1\s+ouverture sur les 2\s+restantes/)).toBeVisible();
  expect(page.url()).not.toContain("#");
  await page.waitForTimeout(1500);
  expect(unlocks).toEqual([]);
  await shot(page, "3-ouverture-sans-mdp");
  await openNoPassword(page);
  expect(unlocks).toHaveLength(1);
  await expect(noteRow(page)).toBeVisible();
  await shot(page, "4-contenu-sans-mdp");
  // Rechargement : « Rouvrir », toujours sans champ, sans ouverture de plus.
  await page.reload();
  await expect(page.getByRole("button", { name: "Rouvrir" })).toBeVisible({ timeout: 30_000 });
  await expect(pwField(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Rouvrir" }).click();
  await expect(noteRow(page)).toBeVisible({ timeout: 30_000 });
});

test("création avec mot de passe : interrupteur activé, mot de passe généré, « Générer un autre » ; ouverture avec le champ", async ({ page, shh, isMobile }) => {
  test.setTimeout(120_000);
  await page.goto(shh.origin + "/");
  await enterComposer(page);
  await addText(page, TEXT);
  const opts = await options(page, isMobile);
  const sw = opts.getByRole("switch", { name: "Protéger par un mot de passe" });
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  const field = opts.locator("[data-pw]");
  await expect(field).toBeVisible();
  await expect(opts.getByText("Envoyez-le par un autre moyen que le lien.", { exact: false })).toBeVisible();
  const read = async () => ((await field.locator(".sr-only").first().textContent()) ?? "").trim();
  const before = await read();
  expect(before).toHaveLength(11);
  await opts.getByRole("button", { name: "Générer un autre" }).click();
  await expect.poll(read).not.toBe(before);
  const shown = await read();
  await shot(page, "5-creation-avec-mdp", opts.locator("[data-protect]"));
  if (isMobile) await page.keyboard.press("Escape");
  const { sendButton, readyHeading } = await import("./send-helpers");
  await sendButton(page).click();
  await expect(readyHeading(page)).toBeVisible({ timeout: 60_000 });
  const pw = page.getByRole("group", { name: "Mot de passe", exact: true });
  await expect(pw).toBeVisible();
  await pw.locator("[data-reveal]").click();
  // Le mot de passe de « Lien prêt » est celui choisi dans le composeur.
  await expect(pw.locator(".sr-only").first()).toHaveText(shown);
  await pw.locator("[data-reveal]").click();
  await shot(page, "6-lien-pret-avec-mdp");
  const link = (await page.getByRole("group", { name: "Lien", exact: true }).locator(".sr-only").first().textContent()) ?? "";
  expect(link).toMatch(/\/s#[A-Za-z0-9_-]{43}$/);
  const r = { page: await page.context().newPage() };
  await r.page.goto(link);
  await expect(pwField(r.page)).toBeVisible({ timeout: 30_000 });
  await expect(openButton(r.page)).toHaveCount(0);
  await shot(r.page, "7-ouverture-avec-mdp");
  await unlock(r.page, shown);
  await expect(noteRow(r.page)).toBeVisible();
  await r.page.close();
});

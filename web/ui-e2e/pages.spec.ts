// Pages d'information (plan Task 25, retours UI5) et en-tête : Sécurité (limites honnêtes),
// Confidentialité, Conditions et Mentions légales (squelettes « En cours de rédaction », aucune
// identité inventée), Signaler un abus, Offres (« par partage »). Captures fr-FR 390 et 1440.
import { fileURLToPath } from "node:url";
import { axe, captureOf, expect, test } from "./fixtures";

test.use({ locale: "fr-FR" });
const SHOTS = fileURLToPath(new URL("../../.superpowers/sdd/2026-11-04-shhdrop-ecrans/shots/task-UI5/", import.meta.url));
const w = (isMobile: boolean) => (isMobile ? 390 : 1440);

test("Sécurité : chiffrement, ce que voit le serveur, limites (historique, onglet, PDF et archives, caméra) ; jamais « 100 % » ; capture", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/securite");
  await expect(page.getByRole("heading", { level: 1, name: "Sécurité" })).toBeVisible();
  for (const h of ["Fermé à clé sur votre appareil", "Le lien et le mot de passe", "Ce que voit notre serveur", "Ce que Shhgone ne peut pas faire", "QR code et partage en un geste", "Caméra et micro"])
    await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
  const main = page.locator("main");
  for (const x of ["historique", "stockage de cet onglet", "Les archives et les formats non pris en charge partent tels quels", "anciens passages", "adresse IP", "jusqu'à la fin de sa durée", "Les noms de fichiers, leurs types et vos textes sont chiffrés aussi"]) await expect(main).toContainText(x);
  const text = await main.innerText();
  expect(text).not.toMatch(/100\s?%|sécurisé à|audit|Suisse|Islande/i);
  // Retours UI6 : corps sans jargon ni noms d'algorithmes ; détails repliés en bas, liens publics.
  expect(text).not.toMatch(/AES|Argon|HKDF|WebCrypto|libsodium|Permissions-Policy|SHA-/);
  const tech = page.locator("[data-tech]");
  await expect(tech).not.toHaveAttribute("open");
  await tech.locator("summary").click();
  for (const x of ["AES-256-GCM", "Argon2id", "Permissions-Policy"]) await expect(tech).toContainText(x);
  await expect(tech.getByRole("link", { name: /Code source public/ })).toHaveAttribute("href", "https://github.com/Skoow/shhgone");
  await expect(tech.getByRole("link", { name: /Spécification publique/ })).toHaveAttribute("href", /docs\/superpowers\/specs\/2026-11-03-shhdrop-design\.md$/);
  await tech.locator("summary").click();
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}securite-${w(isMobile)}.png`, fullPage: true });
});

test("Confidentialité, Signaler, Conditions, Mentions : contenus, bandeau « En cours de rédaction » (Mentions seulement), aucun e-mail ni identité inventée", async ({ page, shh }) => {
  await page.goto(shh.origin + "/confidentialite");
  await expect(page.locator("main")).toContainText("Aucun cookie");
  await expect(page.locator("main")).toContainText("Votre adresse IP n'est pas enregistrée.");
  // Aucun repli Google reCAPTCHA (retiré le 24 novembre) : la page n'en parle pas.
  await expect(page.locator("#verification")).toContainText("sans service extérieur");
  await expect(page.locator("main")).not.toContainText("Google");
  await page.goto(shh.origin + "/signaler");
  await expect(page.getByRole("heading", { level: 1, name: "Signaler un abus" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Signaler");
  // Signalement complet par écrit (DSA art. 16) : lien, explication, nom et e-mail, bonne foi.
  await expect(page.locator("main")).toContainText("de bonne foi");
  // Mentions légales (22 novembre) : éditeur particulier anonyme (LCEN art. 1-1, II), point de
  // contact unique du DSA (art. 11 et 12), hébergeur OVH ; bandeau gardé jusqu'à l'avis du juriste.
  await page.goto(shh.origin + "/mentions-legales");
  await expect(page.getByRole("heading", { level: 1, name: "Mentions légales" })).toBeVisible();
  await expect(page.locator("[data-draft]")).toHaveText("En cours de rédaction");
  await expect(page.locator("main")).not.toContainText("compléter par le propriétaire");
  await expect(page.locator("main")).toContainText("contact@shhgone.com");
  await expect(page.locator("main")).toContainText("OVH SAS");
  await expect(page.locator("main")).toContainText("article 1-1, II");
  expect(await axe(page)).toEqual([]);
  // Conditions : modération décrite (DSA art. 14), aucune coordonnée ni hébergeur.
  await page.goto(shh.origin + "/conditions");
  await expect(page.locator("main")).toContainText("aucun outil automatique de modération");
  expect(await page.locator("main").innerText()).not.toMatch(/@|SAS|SARL|OVH|Hetzner|Scaleway/);
  expect(await axe(page)).toEqual([]);
  await page.goto(shh.origin + "/conditions");
  await expect(page.getByRole("heading", { level: 1, name: "Conditions d'utilisation" })).toBeVisible();
  await expect(page.locator("main")).toContainText("la moitié de ses ouvertures permises");
  await expect(page.locator("main")).not.toContainText("compléter par le propriétaire");
  for (const p of ["/securite", "/confidentialite", "/signaler", "/conditions"]) {
    await page.goto(shh.origin + p);
    await expect(page.locator("[data-draft]")).toHaveCount(0);
    expect(await page.locator("main").innerText()).not.toContain("@");
  }
});

test("Offres (refaite le 16 novembre) : une seule présentation, facturation, choix de l'offre, récapitulatif ; rien n'est demandé ni prélevé ; capture", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  const lectures: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/paiement")) lectures.push(r.url());
  });
  await page.goto(shh.origin + "/offres");
  const co = page.locator("[data-checkout]");
  const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
  // Paiement pas ouvert sur ce serveur (revue du 20 novembre, U12) : dit en t\u00eate de page, avant
  // les offres, et les boutons portent \u00ab Bient\u00f4t \u00bb ; une seule lecture de /api/paiement.
  const ferme = co.locator("[data-pay-closed]");
  await expect(ferme).toHaveText("Le paiement n'est pas encore ouvert sur ce serveur. Rien n'est demand\u00e9 ni pr\u00e9lev\u00e9 aujourd'hui.");
  expect((await ferme.boundingBox())!.y).toBeLessThan((await co.locator('[data-tier="free"]').boundingBox())!.y);
  for (const x of ["plus", "pro"]) await expect(co.locator(`[data-tier="${x}"] [data-soon]`)).toHaveText("Bient\u00f4t");
  expect(lectures).toEqual([shh.origin + "/api/paiement"]);
  // Trois offres, une seule fois chacune (plus de tableau qui redisait les cartes).
  await expect(co.locator("[data-tier]")).toHaveCount(3);
  await expect(page.locator("[data-offers], [data-prices]")).toHaveCount(0);
  for (const [x, size] of [["free", "2 Go"], ["plus", "10 Go"], ["pro", "30 Go"]] as const) expect(norm(await co.locator(`[data-tier="${x}"]`).innerText())).toContain(size);
  // Mensuel par défaut (16 novembre) ; annuel au choix. Prix « 7 € / mois », TTC dit une fois (17 novembre).
  expect(norm(await co.locator('[data-tier="plus"] [data-price]').innerText())).toMatch(/7 €\s*\/\s*mois/);
  await co.locator("[data-billing]").getByText("Annuel").click();
  expect(norm(await co.locator('[data-tier="plus"] [data-price]').innerText())).toMatch(/70 €\s*\/\s*an/);
  await co.locator("[data-billing]").getByText("Mensuel").click();
  expect(norm(await co.locator('[data-tier="plus"] [data-price]').innerText())).toMatch(/7 €\s*\/\s*mois/);
  expect(norm(await co.locator('[data-tier="pro"] [data-price]').innerText())).toMatch(/20 €\s*\/\s*mois/);
  // Gratuit : l'offre en cours, rien à choisir.
  await expect(co.locator('[data-tier="free"] input')).toHaveCount(0);
  await expect(co.locator("[data-summary]")).toHaveCount(0);
  await co.locator('[data-tier="pro"] .big').click();
  const sum = co.locator("[data-summary]");
  expect(norm(await sum.innerText())).toMatch(/Pro · Mensuel · 20 € \/ mois/);
  // Paiement pas ouvert sur ce serveur (sans SHH_PAIEMENT) : le bouton le dit, aucun prélèvement.
  const go = sum.getByRole("button", { name: "Bientôt" });
  await expect(go).toBeDisabled();
  await expect(go).toHaveAccessibleDescription(/Rien n'est demandé ni prélevé aujourd'hui\./);
  await expect(page.locator("main form, main input[type=email], main input[type=password], main img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}offres-${w(isMobile)}.png`, fullPage: true });
});

test("en-tête : air au-dessus du logo, sans roue des Réglages ; pied de page ; captures", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shh.origin + "/securite");
  // Le premier élément de la barre (logo, ou « Retour » sur téléphone) n'est plus collé en haut.
  const first = await page.locator(isMobile ? "header.top .bar" : "header.top a.logo").boundingBox();
  expect(first!.y).toBeGreaterThanOrEqual(8);
  // Plus de roue des Réglages (retours du 11 novembre) : son contenu est dans le pied de page.
  await expect(page.getByRole("banner").getByRole("button", { name: "Réglages" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}entete-${w(isMobile)}.png` });
  const foot = page.locator("footer[data-foot]");
  await foot.scrollIntoViewIfNeeded();
  await expect(foot).toBeVisible();
  await captureOf(foot, { path: `${SHOTS}pied-${w(isMobile)}.png` });
});

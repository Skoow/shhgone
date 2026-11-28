// Pages d'information et en-tête : Sécurité (limites honnêtes),
// Confidentialité, Conditions et Mentions légales (squelettes « En cours de rédaction », aucune
// identité inventée), Signaler un abus, Offres (« par partage »). Captures fr-FR 390 et 1440.
import { fileURLToPath } from "node:url";
import { axe, captureOf, expect, test } from "./fixtures";

test.use({ locale: "fr-FR" });
const SHOTS = fileURLToPath(new URL("../test-results/captures/UI5/", import.meta.url));
const w = (isMobile: boolean) => (isMobile ? 390 : 1440);
/** Captures de la page Contact, de la section « Vérifier cette version » et du pied de page. */
const CAPTURES = fileURLToPath(new URL("../test-results/captures/", import.meta.url));

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
  await expect(tech.getByRole("link", { name: /Spécification publique/ })).toHaveAttribute("href", /docs\/conception\/specs\/2026-11-03-shhdrop-design\.md$/);
  await tech.locator("summary").click();
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}securite-${w(isMobile)}.png`, fullPage: true });
});

test("Confidentialité, Signaler, Conditions, Mentions : contenus, bandeau « En cours de rédaction » (Mentions seulement), aucun e-mail ni identité inventée", async ({ page, shh }) => {
  await page.goto(shh.origin + "/confidentialite");
  await expect(page.locator("main")).toContainText("Aucun cookie");
  await expect(page.locator("main")).toContainText("Votre adresse IP n'est pas enregistrée.");
  // Aucun repli Google reCAPTCHA (retiré) : la page n'en parle pas.
  await expect(page.locator("#verification")).toContainText("sans service extérieur");
  await expect(page.locator("main")).not.toContainText("Google");
  await page.goto(shh.origin + "/signaler");
  await expect(page.getByRole("heading", { level: 1, name: "Signaler un abus" })).toBeVisible();
  await expect(page.locator("main")).toContainText("Signaler");
  // Signalement complet par écrit (DSA art. 16) : lien, explication, nom et e-mail, bonne foi.
  await expect(page.locator("main")).toContainText("de bonne foi");
  // Mentions légales : éditeur particulier anonyme (LCEN art. 1-1, II), point de
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
  // Aucune adresse e-mail hors des pages Contact et Mentions légales (la commande de vérification
  // de Sécurité cite « release.yml@refs/… », qui n'en est pas une).
  for (const p of ["/securite", "/confidentialite", "/signaler", "/conditions"]) {
    await page.goto(shh.origin + p);
    await expect(page.locator("[data-draft]")).toHaveCount(0);
    expect(await page.locator("main").innerText()).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    await expect(page.locator('main a[href^="mailto:"]')).toHaveCount(0);
  }
  // Les pages qui renvoyaient au « contact des mentions légales » mènent à la page Contact.
  for (const p of ["/confidentialite", "/signaler", "/mentions-legales"]) {
    await page.goto(shh.origin + p);
    await expect(page.locator('main a[href="/contact"]').first()).toBeVisible();
    await expect(page.locator("main")).not.toContainText("contact des mentions légales");
  }
});

test("Contact : adresse en lien mailto, « Copier l'adresse », pour quoi écrire, ce qu'il ne faut jamais envoyer ; sans adresse postale ni délai ; pied de page ; captures", async ({ page, shh, isMobile, context, browserName }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  if (browserName === "chromium") await context.grantPermissions(["clipboard-write"], { origin: shh.origin });
  await page.goto(shh.origin + "/contact");
  await expect(page.getByRole("heading", { level: 1, name: "Contact" })).toBeVisible();
  await expect(page).toHaveTitle(/^Contact · Shhgone$/);
  const main = page.locator("main");
  for (const h of ["Notre adresse", "Pour quoi nous écrire", "Ce qu'il ne faut jamais nous envoyer", "Ce que devient votre message"])
    await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
  const mail = page.locator("[data-mail]");
  const addr = mail.getByRole("link", { name: "contact@shhgone.com" });
  await expect(addr).toHaveAttribute("href", "mailto:contact@shhgone.com");
  // Un lien mailto n'ouvre pas de nouvel onglet et ne charge rien.
  await expect(addr).not.toHaveAttribute("target");
  await expect(main).toContainText("En français ou en anglais");
  await expect(main).toContainText("Le lien complet d'un partage, avec son mot de passe s'il en a un");
  await expect(main.getByRole("link", { name: "Signaler un abus" })).toHaveAttribute("href", "/signaler");
  const text = await main.innerText();
  expect(text).not.toMatch(/\b\d{5}\b|rue |cedex|délai|sous \d|\d+\s?(h|heures?|jours?)\b/i);
  // Une seule adresse, celle de contact.
  expect(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g)).toEqual(["contact@shhgone.com"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${CAPTURES}contact-${w(isMobile)}.png`, fullPage: true });
  // « Copier l'adresse » : copiée (le bouton le dit), ou, sans presse-papiers, l'adresse est
  // sélectionnée pour une copie à la main.
  const copy = mail.getByRole("button", { name: "Copier l'adresse" });
  await copy.click();
  if (browserName === "chromium") {
    await expect(mail.getByRole("button", { name: "Adresse copiée" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText().catch(() => "refusé"))).toMatch(/^(contact@shhgone\.com|refusé)$/);
  } else {
    await expect
      .poll(async () => (await mail.getByRole("button", { name: "Adresse copiée" }).count()) > 0 || (await page.evaluate(() => getSelection()?.toString())) === "contact@shhgone.com")
      .toBe(true);
  }
  // Pied de page : « Contact » dans la colonne « Légal ».
  const foot = page.locator("footer[data-foot]");
  const legal = foot.getByRole("list", { name: "Légal" });
  await expect(legal.getByRole("link", { name: "Contact", exact: true })).toHaveAttribute("href", "/contact");
  await expect(legal.getByRole("link", { name: "Contact", exact: true })).toHaveAttribute("aria-current", "page");
  // Version anglaise.
  await page.goto(shh.origin + "/en/contact");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1, name: "Contact" })).toBeVisible();
  await expect(page.locator("[data-mail]").getByRole("button", { name: "Copy the address" })).toBeVisible();
  await expect(page.locator("main")).toContainText("In French or English");
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: `${CAPTURES}contact-en-${w(isMobile)}.png`, fullPage: true });
});

test("pied de page : colonnes équilibrées (ordinateur), groupes enchaînés sans case vide (téléphone, 390 et 360) ; captures", async ({ page, shh, isMobile }) => {
  for (const width of isMobile ? [390, 360] : [1440]) {
    await page.setViewportSize({ width, height: isMobile ? 844 : 900 });
    await page.goto(shh.origin + "/contact");
    const foot = page.locator("footer[data-foot]");
    await foot.scrollIntoViewIfNeeded();
    const lists = foot.getByRole("list");
    // Confiance : Sécurité, Confidentialité, Open source, Signaler ; Légal : Conditions, Mentions, Contact, État du service.
    await expect(foot.getByRole("list", { name: "Confiance" }).getByRole("listitem")).toHaveCount(4);
    await expect(foot.getByRole("list", { name: "Légal" }).getByRole("listitem")).toHaveCount(4);
    const rows = await lists.evaluateAll((uls) =>
      uls.flatMap((ul) => [...ul.querySelectorAll("li")].map((li) => {
        const r = li.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      })),
    );
    if (isMobile) {
      // Téléphone : les lignes se suivent à pas égal, sans trou entre les groupes.
      const tops = [...new Set(rows.map((r) => r.top))].sort((a, b) => a - b);
      const steps = tops.slice(1).map((t, i) => t - tops[i]!);
      expect(Math.max(...steps) - Math.min(...steps), `${width} : ${steps.join(", ")}`).toBeLessThanOrEqual(1);
      // Huit liens, deux par ligne : la dernière ligne est pleine (aucun lien seul).
      const derniere = rows.filter((r) => r.top === rows.at(-1)!.top);
      expect(derniere).toHaveLength(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } else {
      // Ordinateur : deux colonnes titrées, de même hauteur (4 et 4 liens).
      const cols = await foot.locator(".col").evaluateAll((c) => c.map((e) => e.getBoundingClientRect().height));
      expect(cols).toHaveLength(2);
      expect(Math.abs(cols[0]! - cols[1]!)).toBeLessThanOrEqual(48);
    }
    await captureOf(foot, { path: `${CAPTURES}contact-pied-${width}.png` });
  }
});

test("Offres : facturation, cartes et comparatif, choix de l'offre, récapitulatif ; rien n'est demandé ni prélevé ; capture", async ({ page, shh, isMobile }) => {
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  const lectures: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/paiement")) lectures.push(r.url());
  });
  await page.goto(shh.origin + "/offres");
  const co = page.locator("[data-checkout]");
  const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");
  // Paiement pas ouvert sur ce serveur : dit en t\u00eate de page, avant
  // les offres, et les boutons portent \u00ab Bient\u00f4t \u00bb ; une seule lecture de /api/paiement.
  const ferme = co.locator("[data-pay-closed]");
  await expect(ferme).toHaveText("Le paiement n'est pas encore ouvert sur ce serveur. Rien n'est demand\u00e9 ni pr\u00e9lev\u00e9 aujourd'hui.");
  expect((await ferme.boundingBox())!.y).toBeLessThan((await co.locator('[data-tier="free"]').boundingBox())!.y);
  for (const x of ["plus", "pro"]) await expect(co.locator(`[data-tier="${x}"] [data-soon]`)).toHaveText("Bient\u00f4t");
  // Appels : inclus dans Plus et Pro, réservés à ces offres ; plus de « bientôt ».
  for (const x of ["plus", "pro"]) await expect(co.locator(`td[data-calls="${x}"]`)).toHaveText("Inclus");
  await expect(co.locator('td[data-calls="free"]')).toHaveText("Non inclus");
  await expect(co.locator("td[data-calls]").first().locator("xpath=..").locator("th")).toHaveText("Appels audio et vidéo");
  expect(lectures).toEqual([shh.origin + "/api/paiement"]);
  // Trois offres, une carte chacune ; le détail est dans le comparatif aligné, pas dans les cartes.
  await expect(co.locator("[data-tier]")).toHaveCount(3);
  await expect(page.locator("[data-offers], [data-prices]")).toHaveCount(0);
  for (const [x, size] of [["free", "2 Go"], ["plus", "10 Go"], ["pro", "30 Go"]] as const) expect(norm(await co.locator(`[data-tier="${x}"]`).innerText())).toContain(size);
  // Mensuel par défaut ; annuel au choix. Prix « 7 € / mois », TTC dit une fois.
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
  // Départ du compte à rebours à la première ouverture : annoncé « bientôt », pas encore codé.
  await expect(co.locator(".adds li").filter({ hasText: "première ouverture" })).toHaveText("Bientôt (pas encore disponible) : le compte à rebours pourra démarrer à la première ouverture");
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
  // Plus de roue des Réglages : son contenu est dans le pied de page.
  await expect(page.getByRole("banner").getByRole("button", { name: "Réglages" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}entete-${w(isMobile)}.png` });
  const foot = page.locator("footer[data-foot]");
  await foot.scrollIntoViewIfNeeded();
  await expect(foot).toBeVisible();
  await captureOf(foot, { path: `${SHOTS}pied-${w(isMobile)}.png` });
});

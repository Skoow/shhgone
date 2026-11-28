// Salon façon application de messagerie (passe d'interface du 25 novembre) : vrai binaire Go avec
// SHH_SALONS=1 et SHH_COMPTES=1, site avec compte (comptes-site.ts), comme salon2.spec.ts.
// La créatrice sur ordinateur (1440 × 900), un invité sur téléphone (390 × 844), une troisième
// personne sur ordinateur. Vérifie la mise en page d'application : en-tête et saisie fixes, seul
// le fil défile, aucun défilement de la page ; séries de bulles (nom et photo sur le premier
// message d'une série), séparateur du jour, messages système centrés ; boutons d'appel dans leur
// cadre « Plus · Pro » sans pass ; saisie collée en bas, clavier virtuel compris. Captures
// test-results/captures/salon4-*.png (ou SALON4_CAPTURES). Chromium seulement (passkey).
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";
import { siteComptes } from "./comptes-site";
import { axe, expect, test as base } from "./fixtures";

const CAPTURES = process.env.SALON4_CAPTURES ?? fileURLToPath(new URL("../test-results/captures", import.meta.url));
const PREFIXE = process.env.SALON4_PREFIXE ?? "salon4";
const FICHIERS = fileURLToPath(new URL("./files", import.meta.url));

// Appels proposés (relais déclaré, paiement activé) : les boutons d'appel s'affichent ; aucun appel
// n'est passé ici, le relais n'a pas besoin de répondre.
const SECRET = join(mkdtempSync(join(tmpdir(), "shh-salon4-")), "turn.secret");
writeFileSync(SECRET, randomBytes(24).toString("hex") + "\n");
chmodSync(SECRET, 0o600);

const test = base.extend<object, { site: string }>({
  site: [async ({}, use) => use(await siteComptes()), { scope: "worker", timeout: 360_000 }],
  shhServer: async ({ site }, use) =>
    use({
      comptes: { cle: new Uint8Array(randomBytes(32)) },
      paiement: { webhookStripe: "whsec_e2e_salon4", ipnNOWPayments: "ipn-e2e-salon4" },
      env: { SHH_STATIC_DIR: site, SHH_TURN_URLS: "turn:127.0.0.1:3478?transport=udp", SHH_TURN_SECRET_FILE: SECRET },
    }),
});

test.use({ locale: "fr-FR", timezoneId: "Europe/Paris", actionTimeout: 30_000 });
test.setTimeout(420_000);
test.skip(({ browserName, isMobile }) => browserName !== "chromium" || isMobile, "salon4.spec.ts : une seule fois, sur Chromium ordinateur (l'invité ouvre son propre contexte de téléphone)");

const champ = (page: Page, label: string) => page.getByLabel(label, { exact: true }).and(page.locator("input"));
const bouton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const titre = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const fil = (page: Page) => page.getByRole("log");
const saisie = (page: Page) => page.getByLabel("Message", { exact: true });
const zone = (page: Page) => page.getByRole("region", { name: "Conversation", exact: true });
const bulle = (page: Page, texte: string) => fil(page).locator("li").filter({ has: page.locator("p.texte", { hasText: texte }) });
const fini = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));

async function photo(page: Page, nom: string): Promise<void> {
  mkdirSync(CAPTURES, { recursive: true });
  await fini(page);
  await page.screenshot({ path: `${CAPTURES}/${PREFIXE}-${nom}.png` });
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
  await bouton(page, "Créer avec une passkey").or(bouton(page, "Garder le compte sur cet ordinateur")).click();
  await expect(titre(page, "Votre clé de récupération")).toBeVisible({ timeout: 30_000 });
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  await bouton(page, "Copier").click(); // « Je l'ai notée » attend la clé copiée ou téléchargée
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
async function rejoindre(page: Page, lien: string, mdp: string, pseudo: string, image?: string): Promise<void> {
  await page.goto(lien);
  await champ(page, "Mot de passe du salon").fill(mdp);
  await bouton(page, "Continuer").or(bouton(page, "Plus tard")).click();
  await expect(titre(page, "Un salon qui s'efface")).toBeVisible({ timeout: 30_000 });
  await champ(page, "Pseudonyme pour ce salon").fill(pseudo);
  if (image) {
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles(join(FICHIERS, image));
    await expect(page.locator('img[src^="blob:"]').first()).toBeVisible({ timeout: 30_000 });
  }
  await bouton(page, "Entrer dans le salon").click();
  await expect(fil(page)).toBeVisible();
}

test("salon façon application : en-tête et saisie fixes, séries, jour, appels encadrés", async ({ page, shh, browser }) => {
  const r = randomBytes(3).toString("hex");
  const pseudoA = `Camille${r.slice(0, 2)}`;
  const pseudoB = `Noe${r.slice(2, 4)}`;
  const pseudoC = `Ines${r.slice(4, 6)}`;

  // --- Vitrine (sans session) ---------------------------------------------------------------------
  await page.goto(shh.origin + "/salon/nouveau");
  const ecranVitrine = page.locator("[data-vitrine] .ecran");
  await expect(ecranVitrine).toBeVisible();
  await photo(page, "vitrine-pc");
  {
    const ctxV = await (browser as Browser).newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: "fr-FR", timezoneId: "Europe/Paris" });
    const pv = await ctxV.newPage();
    await pv.goto(shh.origin + "/salon/nouveau");
    await expect(pv.locator("[data-vitrine] .ecran")).toBeVisible();
    expect(await pv.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await pv.locator("[data-vitrine]").scrollIntoViewIfNeeded();
    await photo(pv, "vitrine-tel");
    await ctxV.close();
  }

  // --- Créatrice, invité sur téléphone, troisième personne ---------------------------------------
  await inscrire(page, shh.origin, pseudoA);
  await bouton(page, "Continuer").or(bouton(page, "Plus tard")).click();
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
  const ctxC = await (browser as Browser).newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const pageC = await ctxC.newPage();
  try {
    await rejoindre(pageB, lien, mdp, pseudoB, "foret-brume.jpg");
    await rejoindre(pageC, lien, mdp, pseudoC);

    // --- Une conversation : séries, réponse, pièces, réaction --------------------------------------
    const m = [
      [page, `Salut ! On s'organise pour samedi ? ${r}`],
      [page, `J'ai réservé la salle de 14 h à 18 h. ${r}`],
      [pageB, `Top, je ramène les jeux ${r}`],
      [pageB, `Et des crêpes ${r}`],
      [pageC, `Je peux venir vers 15 h, ça vous va ? ${r}`],
      [page, `Parfait, on t'attend. Pense à prendre la rallonge pour le projecteur, celle de l'an dernier ne marche plus. ${r}`],
    ] as const;
    for (const [p, x] of m) {
      await envoyer(p, x);
      for (const q of [page, pageB, pageC]) await expect(bulle(q, x)).toBeVisible({ timeout: 30_000 });
    }
    // Pièces : un PDF (invité), une photo (créatrice).
    await zone(pageB).locator('input[type="file"]').first().setInputFiles(join(FICHIERS, "contrat.pdf"));
    // PDF que le nettoyage ne sait pas traiter : envoyé tel quel, après confirmation.
    const telQuel = bouton(pageB, "Envoyer tel quel");
    await expect(telQuel.or(fil(pageB).getByText("contrat.pdf", { exact: true }))).toBeVisible({ timeout: 30_000 });
    if (await telQuel.isVisible()) await telQuel.click();
    await expect(fil(page).getByText("contrat.pdf", { exact: true })).toBeVisible({ timeout: 60_000 });
    await zone(page).locator('input[type="file"]').first().setInputFiles(join(FICHIERS, "lac-gele.jpg"));
    for (const q of [page, pageB]) await expect(fil(q).locator("img.img").last()).toBeVisible({ timeout: 60_000 });
    const fin = `Super, merci pour la photo ! ${r}`;
    await envoyer(pageB, fin);
    await expect(bulle(page, fin)).toBeVisible({ timeout: 30_000 });
    await bulle(page, fin).getByRole("button", { name: "Actions du message" }).click();
    await bulle(page, fin).getByRole("button", { name: "Réagir 👍" }).click();
    await expect(bulle(pageB, fin).locator(".reactions")).toContainText("👍 1", { timeout: 30_000 });
    await expect(bulle(page, m[1][1]).locator(".coche")).toHaveText(/Vu/, { timeout: 30_000 });

    // Mise en page d'application : la page ne défile pas, le fil oui ; en-tête en haut, saisie
    // collée en bas de la fenêtre ; aucun défilement horizontal (ordinateur et téléphone).
    for (const [p, w, h] of [[page, 1440, 900], [pageB, 390, 844]] as const) {
      const mes = await p.evaluate(() => {
        const z = document.querySelector<HTMLElement>("[role=log]")!;
        const s = document.querySelector<HTMLElement>(".saisie")!.getBoundingClientRect();
        const t = document.querySelector<HTMLElement>(".tete")!.getBoundingClientRect();
        return { page: document.scrollingElement!.scrollHeight, larg: document.documentElement.scrollWidth, defile: z.scrollHeight > z.clientHeight, bas: z.scrollHeight - z.scrollTop - z.clientHeight, saisie: s.bottom, tete: t.top };
      });
      expect(mes.page).toBeLessThanOrEqual(h);
      expect(mes.larg).toBeLessThanOrEqual(w);
      expect(mes.defile).toBe(true); // fil long : il défile, seul
      expect(mes.bas).toBeLessThanOrEqual(2); // en bas, sur le dernier message
      expect(Math.round(mes.saisie)).toBe(h);
      expect(mes.tete).toBeLessThanOrEqual(w < 900 ? 0 : 64); // téléphone : plein écran ; ordinateur : sous la barre du site
    }
    // Séries : nom et photo sur le premier message d'une série seulement ; jour « Aujourd'hui ».
    await fil(pageC).evaluate((z) => (z.scrollTop = 0));
    for (const q of [pageB, pageC]) {
      await expect(bulle(q, m[0][1]).locator(".auteur")).toHaveText(pseudoA);
      await expect(bulle(q, m[0][1]).locator(".gout .avatar")).toHaveCount(1);
      await expect(bulle(q, m[1][1]).locator(".auteur")).toHaveCount(0);
      await expect(bulle(q, m[1][1]).locator(".gout .avatar")).toHaveCount(0);
      await expect(fil(q).locator("li.jour")).toHaveText(["Aujourd'hui"]);
    }
    const ecart = async (q: Page, a: string, b: string) => (await bulle(q, b).boundingBox())!.y - ((await bulle(q, a).boundingBox())!.y + (await bulle(q, a).boundingBox())!.height);
    expect(await ecart(pageC, m[0][1], m[1][1])).toBeLessThanOrEqual(4); // dans une série : serré
    expect(await ecart(pageC, m[1][1], m[2][1])).toBeGreaterThanOrEqual(8); // entre deux séries : de l'air
    await photo(pageC, "debut-pc-invite");
    await fil(pageC).evaluate((z) => (z.scrollTop = z.scrollHeight));
    // Appels : un groupe « Appels » encadré, étiqueté « Plus · Pro » (aucun pass ici).
    const appels = page.getByRole("group", { name: "Appels", exact: true });
    await expect(appels.locator(".badge")).toHaveText("Plus · Pro");
    await expect(appels.getByRole("button", { name: "Appel audio", exact: true })).toHaveAccessibleDescription("Réservé aux offres Plus et Pro.");
    // Bouton rond : « Envoyer » dès qu'il y a du texte, sinon « Message vocal ».
    await expect(zone(page).getByRole("button", { name: "Envoyer", exact: true })).toHaveCount(0);
    await expect(zone(page).getByRole("button", { name: "Message vocal", exact: true })).toBeVisible();

    await photo(page, "conversation-pc");
    await photo(pageB, "conversation-tel");
    await photo(pageC, "conversation-pc-invite");
    expect(await axe(page)).toEqual([]);
    expect(await axe(pageB)).toEqual([]);

    // Téléphone, clavier virtuel ouvert (fenêtre réduite, comme Chrome sur Android) : saisie en bas.
    await saisie(pageB).focus();
    await saisie(pageB).fill("Je regarde les horaires");
    await pageB.setViewportSize({ width: 390, height: 500 });
    await expect.poll(async () => Math.round((await pageB.locator(".saisie").boundingBox())!.y + (await pageB.locator(".saisie").boundingBox())!.height)).toBe(500);
    await expect(saisie(pageB)).toBeInViewport();
    await expect(pageB.locator(".tete")).toBeInViewport();
    await photo(pageB, "clavier-tel");
    await pageB.setViewportSize({ width: 390, height: 844 });
    await saisie(pageB).fill("");

    // Paramètres du salon (ordinateur, téléphone).
    await bouton(page, "Paramètres du salon").click();
    await expect(page.getByRole("dialog", { name: "Paramètres du salon" })).toBeVisible();
    await photo(page, "parametres-pc");
    await page.keyboard.press("Escape");
    await bouton(pageB, "Paramètres du salon").click();
    await expect(pageB.getByRole("dialog", { name: "Paramètres du salon" })).toBeVisible();
    await photo(pageB, "parametres-tel");
    await pageB.keyboard.press("Escape");

    // Appels réservés à Plus et Pro (aucun pass sur ces appareils).
    await expect(page.locator("[data-appels]")).toBeVisible({ timeout: 30_000 });
    await page.locator(".tete").screenshot({ path: `${CAPTURES}/${PREFIXE}-appels-pc.png` });
    await pageB.locator(".tete").screenshot({ path: `${CAPTURES}/${PREFIXE}-appels-tel.png` });
  } finally {
    await ctxB.close();
    await ctxC.close();
  }
});

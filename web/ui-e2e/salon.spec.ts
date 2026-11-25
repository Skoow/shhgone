// Salon de bout en bout PAR L'INTERFACE : vrai binaire Go avec SHH_SALONS=1 et
// SHH_COMPTES=1 (créer un salon exige un compte, D42-26), site construit avec SHH_SITE_COMPTES=1
// (web/dist-comptes, comptes-site.ts), origine http://localhost:<port> (rp.id des passkeys).
// Deux navigateurs : la créatrice (compte par passkey avec l'authentificateur virtuel de Chromium,
// création, salon prêt, entrée) et un invité (lien, mot de passe, page d'explication, pseudonyme),
// qui échangent de vrais messages chiffrés par MLS : texte, lien, réponse, réaction,
// modification, retrait, « écrit », coches « vu ».
// Puis le test bloquant « le serveur ne voit rien » étendu au salon par l'interface : aucun
// texte de message, pseudonyme, mot de passe, clé du lien ni de gestion dans le dossier de
// données (base, WAL, conversations, pièces) ni dans les sorties du serveur.
// WebKit : aucun authentificateur virtuel (CDP) pour créer le compte ; écarté (R14).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { findIn, needle, scanDir } from "../e2e/scan";
import { siteComptes } from "./comptes-site";
import { axe, capture, expect, test as base } from "./fixtures";

const FICHIERS = fileURLToPath(new URL("./files", import.meta.url));

const test = base.extend<object, { site: string }>({
  site: [async ({}, use) => use(await siteComptes()), { scope: "worker", timeout: 360_000 }],
  shhServer: async ({ site }, use) => use({ comptes: { cle: new Uint8Array(randomBytes(32)) }, env: { SHH_STATIC_DIR: site } }),
});

test.use({ locale: "fr-FR", timezoneId: "Europe/Paris", actionTimeout: 30_000 });
test.setTimeout(600_000); // parcours long : rechargement, exclusion, troisième et quatrième navigateurs
test.skip(({ browserName }) => browserName !== "chromium", "salon.spec.ts : Chromium seulement — la créatrice crée son compte avec une passkey, et WebKit n'a pas d'authentificateur virtuel WebAuthn (CDP) ; passage manuel sur iPhone et Mac avant l'ouverture (conception du compte par passkey, R14)");

const champ = (page: Page, label: string) => page.getByLabel(label, { exact: true }).and(page.locator("input"));
const bouton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const titre = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const fil = (page: Page) => page.getByRole("log");
const saisie = (page: Page) => page.getByLabel("Message", { exact: true });
const zone = (page: Page) => page.getByRole("region", { name: "Conversation", exact: true });

/**
 * Inscription complète par l'interface avec une passkey (authentificateur virtuel), suite
 * « salon » : pseudo, passkey, clé de récupération notée, un groupe retapé.
 */
async function inscrire(page: Page, origin: string, pseudo: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await page.goto(origin + "/compte/inscription?suite=salon");
  await expect(titre(page, "Créer un compte")).toBeVisible();
  await champ(page, "Pseudo").fill(pseudo);
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 });
  await bouton(page, "Créer avec une passkey").or(bouton(page, "Garder le compte sur cet ordinateur")).click();
  await expect(titre(page, "Votre clé de récupération")).toBeVisible({ timeout: 30_000 });
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  await bouton(page, "Copier").click(); // « Je l\'ai notée » attend la clé copiée ou téléchargée
  await bouton(page, "Je l\'ai notée").click();
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

/** Bulle d'un message par son texte (élément de liste du fil). */
const bulle = (page: Page, texte: string) => fil(page).locator("li").filter({ has: page.locator("p.texte", { hasText: texte }) });

test("deux navigateurs : création avec un compte, invitation, messages chiffrés, et le serveur ne voit rien", async ({ page, shh, browser, browserName }, info) => {
  const r = randomBytes(4).toString("hex");
  const pseudoA = `Lea${r.slice(0, 4)}`;
  const pseudoB = `Hugo${r.slice(4, 8)}`;

  // --- Créatrice : compte (pseudo choisi à l'inscription), création, salon prêt ----------------------
  await inscrire(page, shh.origin, pseudoA);
  await bouton(page, "Continuer").or(bouton(page, "Plus tard")).click();
  await expect(titre(page, "Créer un salon")).toBeVisible();
  await capture(page, "salon-nouveau");
  expect(await axe(page)).toEqual([]);
  await expect(page).toHaveURL(/\/salon\/nouveau$/);
  // Compte récent : 4 places au plus (conception du compte §11) ; « Ouvert » les prend toutes.
  await expect(page.getByText("Ouvert, 4 au plus")).toBeVisible();
  // Historique désactivé par défaut, même avec un compte : la créatrice l'active
  // elle-même ici (la suite s'appuie sur le lien de gestion gardé : « Détruire le salon » après
  // délogement). Sans cela, « Salon prêt » montre le lien de gestion d'emblée (appel.spec.ts).
  const garder = page.getByRole("switch", { name: "Garder dans mon historique" });
  await expect(garder).toHaveAttribute("aria-checked", "false");
  await garder.click();
  await expect(garder).toHaveAttribute("aria-checked", "true");
  await bouton(page, "Créer le salon").click();
  await expect(titre(page, "Salon prêt")).toBeVisible({ timeout: 60_000 });
  await capture(page, "salon-pret");
  expect(await axe(page)).toEqual([]);
  // Lien et mot de passe affichés (jamais dans la barre d'adresse).
  const lien = (await page.locator(".cf").filter({ hasText: "Lien d'invitation" }).locator(".val").textContent())!.trim();
  const mdp = (await page.locator(".cf").filter({ hasText: "Mot de passe" }).locator(".val").textContent())!.trim();
  expect(lien).toMatch(new RegExp(`^${shh.origin.replace(/[.]/g, "\\.")}/salon#c[A-Za-z0-9_-]{43}$`));
  expect(mdp).toMatch(/^.{11}$/);
  expect(page.url()).not.toContain("#");
  await bouton(page, "Afficher le lien de gestion").click();
  const gestion = (await page.locator(".cf").filter({ hasText: "Lien de gestion" }).locator(".val").textContent())!.trim();
  expect(gestion).toMatch(/\/salon#s[A-Za-z0-9_-]{43}$/);
  await bouton(page, "Entrer dans le salon").click();
  await expect(titre(page, "Un salon qui s'efface")).toBeVisible();
  // Compte avec son pseudo (choisi à l'inscription) : le salon le prend, non modifiable ici.
  await expect(champ(page, "Pseudonyme pour ce salon")).toHaveValue(pseudoA);
  await expect(page.locator("[data-pseudo-fige]")).toBeVisible();
  await bouton(page, "Entrer dans le salon").click();
  await expect(fil(page)).toBeVisible();

  // --- Invité : autre navigateur, lien, mot de passe, explication, pseudonyme ------------------------
  const ctxB: BrowserContext = await (browser as Browser).newContext({ ...info.project.use, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const pageB = await ctxB.newPage();
  const erreursB: string[] = [];
  pageB.on("pageerror", (e) => erreursB.push(e.message));
  // WebKit : pendant une capture, Playwright injecte puis retire un <style> en ligne que la CSP
  // refuse (fixtures.ts, swallowHarnessStyle) ; ce refus-là, pendant une capture de B, est ignoré.
  let enCaptureB = false;
  pageB.on("console", (m) => {
    const x = m.text();
    if (!/Refused to|Content Security Policy/.test(x)) return;
    if (enCaptureB && browserName === "webkit" && x.startsWith("Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive")) return;
    erreursB.push(x);
  });
  const captureB = async (nom: string) => {
    enCaptureB = true;
    try {
      await capture(pageB, nom);
      await pageB.evaluate(() => 0); // aller-retour : les messages de la capture sont arrivés
    } finally {
      enCaptureB = false;
    }
  };
  let ctxC: BrowserContext | undefined;
  let ctxE: BrowserContext | undefined;
  try {
    await pageB.goto(lien);
    await expect(titre(pageB, "Salon de discussion")).toBeVisible();
    expect(pageB.url()).toBe(shh.origin + "/salon"); // « # » retiré de la barre
    await champ(pageB, "Mot de passe du salon").fill("mauvais-mdp");
    await bouton(pageB, "Continuer").or(bouton(pageB, "Plus tard")).click();
    await expect(pageB.getByText(/Mot de passe incorrect\. Essais restants/)).toBeVisible({ timeout: 30_000 });
    await champ(pageB, "Mot de passe du salon").fill(mdp);
    await bouton(pageB, "Continuer").or(bouton(pageB, "Plus tard")).click();
    await expect(titre(pageB, "Un salon qui s'efface")).toBeVisible({ timeout: 30_000 });
    // Un seul libellé pour la photo.
    await expect(pageB.getByText("Photo pour ce salon", { exact: false })).toHaveCount(1);
    await expect(pageB.getByText("Photo de profil", { exact: false })).toHaveCount(0);
    await captureB("salon-explication");
    expect(await axe(pageB)).toEqual([]);
    await champ(pageB, "Pseudonyme pour ce salon").fill(pseudoA);
    // Unicité : le pseudonyme de la créatrice est déjà pris (dès que son profil est arrivé).
    await expect(pageB.getByText("Déjà pris dans ce salon.")).toBeVisible({ timeout: 30_000 });
    // Tests croisés de la casse et des sosies : même refus.
    for (const v of [pseudoA.toUpperCase(), pseudoA.toLowerCase(), pseudoA.replace("L", "I")]) {
      await champ(pageB, "Pseudonyme pour ce salon").fill(v);
      await expect(pageB.getByText("Déjà pris dans ce salon.")).toBeVisible();
    }
    // Invité : ni un mot réservé (ADMlN = admin), ni le pseudo d'un compte (vérifié par le
    // serveur, sans salon) ; même message, qui ne dit pas lequel.
    await champ(pageB, "Pseudonyme pour ce salon").fill("ADMlN");
    await bouton(pageB, "Entrer dans le salon").click();
    await expect(pageB.getByText("Ce pseudo est déjà pris sur Shhgone. Choisissez-en un autre.")).toBeVisible();
    await champ(pageB, "Pseudonyme pour ce salon").fill(pseudoB);
    await bouton(pageB, "Entrer dans le salon").click();
    await expect(fil(pageB)).toBeVisible();

    // --- Échanges -----------------------------------------------------------------------------------
    const t1 = `Bonjour depuis A ${r}`;
    await envoyer(page, t1);
    await expect(fil(pageB).locator("p.texte").getByText(t1, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bulle(pageB, t1)).toContainText(pseudoA);
    const t2 = `Réponse de B ${r} https://exemple.org/page`;
    await saisie(pageB).fill("en train…");
    await expect(page.getByText(`${pseudoB} écrit…`)).toBeVisible({ timeout: 15_000 });
    await saisie(pageB).fill("");
    // Réponse citée.
    await bulle(pageB, t1).getByRole("button", { name: "Actions du message" }).click();
    await bulle(pageB, t1).getByRole("button", { name: "Répondre" }).click();
    await expect(pageB.getByText(`Réponse à ${pseudoA}`)).toBeVisible();
    await envoyer(pageB, t2);
    const chezA = bulle(page, `Réponse de B ${r}`);
    await expect(chezA).toBeVisible({ timeout: 30_000 });
    await expect(chezA.locator("blockquote")).toContainText(t1);
    // Lien https cliquable, sans aperçu, sans référent.
    const a = chezA.getByRole("link", { name: "https://exemple.org/page" });
    await expect(a).toHaveAttribute("rel", "noopener noreferrer");
    await expect(a).toHaveAttribute("referrerpolicy", "no-referrer");
    // Coches : « Vu » chez A quand B a vu le message (accusés groupés, 2,5 s).
    await expect(bulle(page, t1).locator(".coche")).toHaveText("Vu", { timeout: 30_000 });
    // Fiche « Infos » (v3 §14.2) : nos messages seulement, heure de chaque accusé par lecteur.
    await bulle(pageB, t1).getByRole("button", { name: "Actions du message" }).click();
    await expect(bulle(pageB, t1).getByRole("button", { name: "Répondre" })).toBeVisible();
    await expect(bulle(pageB, t1).getByRole("button", { name: "Infos" })).toHaveCount(0); // pas pour le message d'un autre
    await bulle(pageB, t1).getByRole("button", { name: "Actions du message" }).click();
    await bulle(page, t1).getByRole("button", { name: "Actions du message" }).click();
    await bulle(page, t1).getByRole("button", { name: "Infos", exact: true }).click();
    const fiche = page.getByRole("dialog", { name: "Infos du message" });
    await expect(fiche.getByText(/^Envoyé : \d{1,2} h \d{2}$/)).toBeVisible();
    await expect(fiche.locator("li").filter({ hasText: pseudoB }).locator("dd")).toHaveText([/^\d{1,2} h \d{2}$/, /^\d{1,2} h \d{2}$/]);
    await capture(page, "salon-infos");
    expect(await axe(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(fiche).toHaveCount(0);
    // Réaction.
    await bulle(page, `Réponse de B ${r}`).getByRole("button", { name: "Actions du message" }).click();
    await bulle(page, `Réponse de B ${r}`).getByRole("button", { name: "Réagir 👍" }).click();
    await expect(bulle(pageB, `Réponse de B ${r}`).locator(".reactions")).toContainText("👍 1", { timeout: 30_000 });
    // Modification (auteur seulement), puis retrait pour tous.
    await bulle(page, t1).getByRole("button", { name: "Actions du message" }).click();
    await bulle(page, t1).getByRole("button", { name: "Modifier" }).click();
    const t1b = `Bonjour corrigé ${r}`;
    await saisie(page).fill(t1b);
    await zone(page).getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(fil(pageB).locator("p.texte").getByText(t1b, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(bulle(pageB, t1b)).toContainText("modifié");
    const t3 = `À retirer ${r}`;
    await envoyer(page, t3);
    await expect(fil(pageB).locator("p.texte").getByText(t3, { exact: true })).toBeVisible({ timeout: 30_000 });
    await bulle(page, t3).getByRole("button", { name: "Actions du message" }).click();
    await bulle(page, t3).getByRole("button", { name: "Retirer pour tous" }).click();
    await page.getByRole("button", { name: "Retirer pour tous" }).last().click(); // confirmation
    await expect(fil(pageB).locator("p.texte").getByText(t3, { exact: true })).toHaveCount(0, { timeout: 30_000 });
    await expect(fil(pageB).getByText("Message retiré").first()).toBeVisible();
    // --- Pièces : une image affichée chez B, un document enregistré chez B ---------------
    const nomDoc = `notes-${r}.txt`;
    const contenuDoc = `Contenu repère du document ${r} `.repeat(50);
    const image = readFileSync(join(FICHIERS, "lac-gele.jpg"));
    await zone(page).locator('input[type="file"]').setInputFiles([
      { name: `photo-${r}.jpg`, mimeType: "image/jpeg", buffer: image },
      { name: nomDoc, mimeType: "text/plain", buffer: Buffer.from(contenuDoc) },
    ]);
    // Image : déchiffrée et affichée d'office chez B (16 Mo au plus).
    await expect(fil(pageB).locator("img.img")).toHaveCount(1, { timeout: 60_000 });
    await expect(fil(pageB).getByText(nomDoc, { exact: true })).toBeVisible({ timeout: 60_000 });
    const telechargement = pageB.waitForEvent("download");
    await fil(pageB).locator("li").filter({ hasText: nomDoc }).getByRole("button", { name: "Enregistrer" }).click();
    const dl = await telechargement;
    expect(dl.suggestedFilename()).toBe(nomDoc);
    expect(readFileSync((await dl.path())!, "utf8")).toBe(contenuDoc);
    // Accusés de pièce (v3 §14.2) chez l'expéditrice : document « Téléchargé », photo « Ouvert ».
    await expect(fil(page).locator("li").filter({ hasText: nomDoc }).locator(".accuses")).toHaveText("Téléchargé", { timeout: 30_000 });
    await expect(fil(page).locator("li").filter({ hasText: `photo-${r}.jpg` }).locator(".accuses")).toHaveText("Ouvert", { timeout: 30_000 });
    // Texte trop long (§39.5) : refusé, proposé en fichier « message.txt », reçu chez A.
    const long = `Très long ${r} `.repeat(150);
    await saisie(pageB).fill(long);
    await zone(pageB).getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(pageB.getByText("Ce texte est trop long pour un message", { exact: false })).toBeVisible();
    await bouton(pageB, "Envoyer en fichier .txt").click();
    await expect(fil(page).getByText("message.txt", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(saisie(pageB)).toHaveValue("");
    // Silencieux (v3 §14.4) : 1 h, puis son réactivé.
    await bouton(page, "Mettre en silencieux").click();
    await bouton(page, "Pendant 1\u202fh").click();
    await expect(bouton(page, "Réactiver le son")).toBeVisible();
    await bouton(page, "Réactiver le son").click();
    await expect(bouton(page, "Mettre en silencieux")).toBeVisible();
    // Écran « Fichiers » : les pièces, du plus récent au plus ancien.
    await bouton(pageB, "Fichiers").click();
    await expect(pageB.getByRole("dialog").getByText(nomDoc, { exact: true })).toBeVisible();
    await captureB("salon-fichiers");
    // Sélection multiple (v3 §14.3) : une archive .zip faite sur l'appareil, sans compression.
    const dlg = pageB.getByRole("dialog");
    await dlg.getByRole("button", { name: "Tout sélectionner", exact: true }).click();
    const zipDl = pageB.waitForEvent("download");
    await dlg.getByRole("button", { name: "Télécharger (3)", exact: true }).click();
    const archive = await zipDl;
    expect(archive.suggestedFilename()).toBe("salon.zip");
    const octetsZip = readFileSync((await archive.path())!);
    expect([...octetsZip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(octetsZip.includes(Buffer.from(contenuDoc))).toBe(true); // stocké : octets tels quels
    expect(octetsZip.includes(Buffer.from(nomDoc))).toBe(true);
    await pageB.keyboard.press("Escape");
    // Album (v3 §14.3) : deux photos envoyées ensemble, en grille chez B ; chacune reste un message.
    await zone(page).locator('input[type="file"]').setInputFiles([
      { name: `album-1-${r}.jpg`, mimeType: "image/jpeg", buffer: image },
      { name: `album-2-${r}.jpg`, mimeType: "image/jpeg", buffer: image },
    ]);
    await expect(fil(pageB).locator("li.msg.album img.img")).toHaveCount(2, { timeout: 60_000 });
    await expect(fil(pageB).locator("li.msg.album .auteur")).toHaveCount(1);
    await fil(pageB).locator("li.msg.album").last().scrollIntoViewIfNeeded();
    await captureB("salon-album");
    // Mode sélection dans la conversation (v3 §14.3) : appui long sur une photo de l'album, toucher
    // sur la seconde, « Télécharger (2) » en une archive .zip ; puis au clavier (menu « Sélectionner »).
    const photo1 = fil(pageB).locator("li.msg.album").first().locator(".bulle");
    const zoneP = (await photo1.boundingBox())!;
    await pageB.mouse.move(zoneP.x + zoneP.width / 2, zoneP.y + zoneP.height / 2);
    await pageB.mouse.down();
    await pageB.waitForTimeout(800);
    await pageB.mouse.up();
    const barre = pageB.getByRole("group", { name: "Sélection" });
    await expect(barre.getByText("Pièces choisies : 1")).toBeVisible();
    await fil(pageB).locator("li.msg.album").nth(1).locator(".bulle").click();
    await expect(barre.getByText("Pièces choisies : 2")).toBeVisible();
    await captureB("salon-selection");
    expect(await axe(pageB)).toEqual([]);
    const zipAlbum = pageB.waitForEvent("download");
    await barre.getByRole("button", { name: "Télécharger (2)", exact: true }).click();
    const octetsAlbum = readFileSync((await (await zipAlbum).path())!);
    expect(octetsAlbum.includes(Buffer.from(`album-1-${r}.jpg`))).toBe(true);
    expect(octetsAlbum.includes(Buffer.from(`album-2-${r}.jpg`))).toBe(true);
    expect(octetsAlbum.includes(Buffer.from(nomDoc))).toBe(false);
    await expect(barre).toHaveCount(0);
    const doc = fil(pageB).locator("li").filter({ hasText: nomDoc });
    await doc.getByRole("button", { name: "Actions du message" }).focus();
    await pageB.keyboard.press("Enter");
    await doc.getByRole("button", { name: "Sélectionner", exact: true }).focus();
    await pageB.keyboard.press("Enter");
    await expect(pageB.getByRole("checkbox", { name: `Choisir ${nomDoc}` })).toBeFocused();
    await expect(barre.getByText("Pièces choisies : 1")).toBeVisible();
    await pageB.keyboard.press("Space");
    await expect(barre.getByText("Pièces choisies : 0")).toBeVisible();
    await pageB.keyboard.press("Escape");
    await expect(barre).toHaveCount(0);

    // Captures (preuve) et audit d'accessibilité (WCAG 2.1 A et AA) des écrans du salon.
    await capture(page, "salon-conversation");
    await captureB("salon-conversation-invite");
    expect(await axe(page)).toEqual([]);
    // Participants : en ligne, pseudonymes, « vous ».
    if (!(await page.getByRole("dialog", { name: "Paramètres du salon" }).isVisible())) await bouton(page, "Paramètres du salon").click();
    await expect(page.getByText(pseudoB, { exact: true }).last()).toBeVisible();

    // --- règle d'effacement, codes de vérification, destruction ----------------------------
    await page.getByRole("radio", { name: "1 min après lecture" }).click();
    await expect(fil(pageB).getByText(`${pseudoA} a réglé l'effacement des messages`)).toBeVisible({ timeout: 30_000 });
    // Le code de A vu par A et par B est le même (5 groupes de 5 chiffres).
    await page.getByText(`Voir le code de ${pseudoA}`).click();
    const codeChezA = (await page.locator(".chiffres").first().textContent())!.trim();
    expect(codeChezA).toMatch(/^\d{5}( \d{5}){4}$/);
    if (!(await pageB.getByRole("dialog", { name: "Paramètres du salon" }).isVisible())) await bouton(pageB, "Paramètres du salon").click();
    await pageB.getByText(`Voir le code de ${pseudoA}`).click();
    await expect(pageB.locator(".chiffres").first()).toHaveText(codeChezA);
    await bouton(pageB, "J'ai comparé ce code").click();
    await expect(pageB.getByText(`Voir le code de ${pseudoA} · Code vérifié`)).toBeVisible();
    await captureB("salon-participants");
    expect(await axe(pageB)).toEqual([]);
    expect(erreursB).toEqual([]);

    const cle = (l: string) => l.slice(l.lastIndexOf("#") + 2);
    // --- Preuve de membre (D41-26) : B recharge, rouvre le lien, retrouve SA place ------------------
    await pageB.reload();
    await pageB.goto(lien);
    await champ(pageB, "Mot de passe du salon").fill(mdp);
    await bouton(pageB, "Continuer").or(bouton(pageB, "Plus tard")).click();
    await expect(fil(pageB)).toBeVisible({ timeout: 60_000 });
    await expect(titre(pageB, "Un salon qui s'efface")).toHaveCount(0); // pas d'explication ni de pseudonyme à redonner
    const t4 = `Après rechargement ${r}`;
    await envoyer(pageB, t4);
    await expect(bulle(page, t4)).toContainText(pseudoB, { timeout: 30_000 });
    // Même place : une seule arrivée de B chez A, pas de « Participant 3 ».
    await expect(fil(page).getByText(`${pseudoB} a rejoint le salon`)).toHaveCount(1);
    await expect(page.getByText("Participant 3")).toHaveCount(0);

    // --- Exclusion : B exclu, nouvelle invitation, C entre et lit ---------------
    // Participants : dans le panneau « Paramètres du salon » (souvent encore ouvert).
    const exclureB = page.getByRole("button", { name: `Exclure ${pseudoB}`, exact: true });
    if (!(await exclureB.isVisible())) await bouton(page, "Paramètres du salon").click();
    await exclureB.click();
    await page.getByRole("button", { name: "Exclure", exact: true }).last().click(); // confirmation
    await expect(titre(pageB, "Fin du salon")).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText("Vous avez été exclu de ce salon.")).toBeVisible();
    await expect(page.getByText(`${pseudoB} a été exclu.`, { exact: false })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Nouvelle invitation" })).toBeVisible();
    const invit = page.locator("section").filter({ has: page.getByRole("heading", { name: "Nouvelle invitation" }) });
    const lien2 = (await invit.locator(".cf").filter({ hasText: "Lien d'invitation" }).locator(".val").textContent())!.trim();
    const mdp2 = (await invit.locator(".cf").filter({ hasText: "Mot de passe" }).locator(".val").textContent())!.trim();
    expect(lien2).toMatch(/\/salon#c[A-Za-z0-9_-]{43}$/);
    expect(lien2).not.toBe(lien);
    expect(mdp2).not.toBe(mdp);
    await capture(page, "salon-nouvelle-invitation");
    expect(await axe(page)).toEqual([]);
    await expect(fil(page).getByText("L'invitation a changé", { exact: false })).toBeVisible({ timeout: 30_000 });
    // L'exclu, avec l'ancien lien et l'ancien mot de passe : plus rien.
    await pageB.goto(lien);
    await expect(titre(pageB, "Cette conversation est terminée ou n'existe plus")).toBeVisible({ timeout: 30_000 });
    ctxC = await (browser as Browser).newContext({ ...info.project.use, locale: "fr-FR", timezoneId: "Europe/Paris" });
    const pageC = await ctxC.newPage();
    const pseudoC = `Ines${r.slice(0, 3)}`;
    await pageC.goto(lien2);
    await champ(pageC, "Mot de passe du salon").fill(mdp2);
    await bouton(pageC, "Continuer").or(bouton(pageC, "Plus tard")).click();
    await expect(titre(pageC, "Un salon qui s'efface")).toBeVisible({ timeout: 30_000 });
    await champ(pageC, "Pseudonyme pour ce salon").fill(pseudoC);
    await bouton(pageC, "Entrer dans le salon").click();
    await expect(fil(pageC)).toBeVisible();
    const t5 = `Après exclusion ${r}`;
    await expect(fil(page).getByText(`${pseudoC} a rejoint le salon`)).toBeVisible({ timeout: 60_000 });
    // Siège de B redonné à C : la ligne d’exclusion garde le nom de B.
    await expect(fil(page).getByText(`${pseudoB} a été exclu du salon`)).toBeVisible();
    if (await page.getByRole("dialog", { name: "Paramètres du salon" }).isVisible()) await page.keyboard.press("Escape");
    await envoyer(page, t5);
    await expect(fil(pageC).locator("p.texte").getByText(t5, { exact: true })).toBeVisible({ timeout: 30_000 });

    // --- Exigence C-3 32 : la créatrice revient sans son lien de gestion (autre navigateur : ni
    // historique ni preuve), entre comme simple membre, colle son lien de gestion DANS la
    // conversation : rien n'est envoyé, elle retrouve ses droits ; l'ancienne page est délogée.
    ctxE = await (browser as Browser).newContext({ ...info.project.use, locale: "fr-FR", timezoneId: "Europe/Paris" });
    const pageE = await ctxE.newPage();
    const pseudoE = `Lea${r.slice(4, 8)}x`;
    await pageE.goto(lien2);
    await champ(pageE, "Mot de passe du salon").fill(mdp2);
    await bouton(pageE, "Continuer").or(bouton(pageE, "Plus tard")).click();
    await expect(titre(pageE, "Un salon qui s'efface")).toBeVisible({ timeout: 30_000 });
    await champ(pageE, "Pseudonyme pour ce salon").fill(pseudoE);
    await bouton(pageE, "Entrer dans le salon").click();
    await expect(fil(pageE)).toBeVisible();
    await expect(fil(page).getByText(`${pseudoE} a rejoint le salon`)).toBeVisible({ timeout: 60_000 });
    if (!(await pageE.getByRole("dialog", { name: "Paramètres du salon" }).isVisible())) await bouton(pageE, "Paramètres du salon").click();
    await pageE.getByText("Vous avez créé ce salon\u202f?").click();
    await expect(pageE.getByText("Vous êtes revenu sans votre lien de gestion\u202f: vous ne pouvez plus exclure ni changer l'invitation. Collez votre lien de gestion pour retrouver ces droits.")).toBeVisible();
    await expect(pageE.getByRole("button", { name: `Exclure ${pseudoC}`, exact: true })).toHaveCount(0);
    if (await pageE.getByRole("dialog", { name: "Paramètres du salon" }).isVisible()) await pageE.keyboard.press("Escape");
    // Collé dans la saisie : vidée aussitôt, rien envoyé, choix proposé.
    await saisie(pageE).fill(`mon lien ${gestion}`);
    await expect(saisie(pageE)).toHaveValue("");
    await expect(pageE.getByText("Vous avez collé un lien de gestion. Il n'a pas été envoyé", { exact: false })).toBeVisible();
    await capture(pageE, "salon-lien-gestion-colle");
    expect(await axe(pageE)).toEqual([]);
    await bouton(pageE, "Retrouver mes droits de créateur").click();
    await expect(pageE.getByText("Vous avez retrouvé vos droits de créateur.")).toBeVisible({ timeout: 30_000 });
    // L'ancienne page de la créatrice est délogée ; la nouvelle a les droits (exclure C).
    await expect(titre(page, "Fin du salon")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Votre place de créateur a été reprise", { exact: false })).toBeVisible();
    // Restes, point 3 : lien de gestion encore dans l'historique local de A → « Détruire le salon » proposé.
    await expect(bouton(page, "Détruire le salon")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Pour détruire le salon, ouvrez votre lien de gestion", { exact: false })).toHaveCount(0);
    await capture(page, "salon-fin-deloge");
    expect(await axe(page)).toEqual([]);
    if (!(await pageE.getByRole("dialog", { name: "Paramètres du salon" }).isVisible())) await bouton(pageE, "Paramètres du salon").click();
    await expect(pageE.getByRole("button", { name: `Exclure ${pseudoC}`, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(pageE.getByText("Vous avez créé ce salon\u202f?")).toHaveCount(0);
    if (await pageE.getByRole("dialog", { name: "Paramètres du salon" }).isVisible()) await pageE.keyboard.press("Escape");
    const t6 = `Créatrice de retour ${r}`;
    await envoyer(pageE, t6);
    await expect(fil(pageC).locator("p.texte").getByText(t6, { exact: true })).toBeVisible({ timeout: 30_000 });
    // Le lien collé n'est arrivé chez personne.
    await expect(fil(pageC).getByText(cle(gestion), { exact: false })).toHaveCount(0);

    // --- Le serveur ne voit rien (test bloquant, étendu au salon par l'interface) -------------------
    const reperes = [
      needle("texte 1", t1),
      needle("texte 1 modifié", t1b),
      needle("texte 2", `Réponse de B ${r}`),
      needle("texte retiré", t3),
      needle("nom du document", nomDoc),
      needle("nom de la photo", `photo-${r}.jpg`),
      needle("contenu du document", contenuDoc.slice(0, 60)),
      needle("début de la photo (après l'en-tête JPEG)", new Uint8Array(image.subarray(200, 264))),
      needle("pseudo A", pseudoA),
      needle("pseudo B", pseudoB),
      needle("pseudo C", pseudoC),
      needle("mot de passe du salon", mdp),
      needle("nouveau mot de passe", mdp2),
      needle("nouvelle clé du lien (base64url)", cle(lien2)),
      needle("nouvelle clé du lien (octets)", new Uint8Array(Buffer.from(cle(lien2), "base64url"))),
      needle("texte après rechargement", t4),
      needle("texte après exclusion", t5),
      needle("pseudo E", pseudoE),
      needle("texte de la créatrice revenue", t6),
      needle("texte long envoyé en .txt", long.slice(0, 60)),
      needle("clé du lien (base64url)", cle(lien)),
      needle("lien de gestion (base64url)", cle(gestion)),
      needle("clé du lien (octets)", new Uint8Array(Buffer.from(cle(lien), "base64url"))),
      needle("secret de gestion (octets)", new Uint8Array(Buffer.from(cle(gestion), "base64url"))),
    ];
    const dir = shh.server.dataDir;
    expect(scanDir(dir, reperes)).toEqual([]);
    // Lien de gestion ouvert SEUL (32), dans un autre navigateur : il ne fait entrer
    // personne, dit l'état du salon, propose de le détruire (confirmation annulée ici).
    const ctxD: BrowserContext = await (browser as Browser).newContext({ ...info.project.use, locale: "fr-FR", timezoneId: "Europe/Paris" });
    try {
      const pageD = await ctxD.newPage();
      await pageD.goto(gestion);
      await expect(titre(pageD, "Lien de gestion")).toBeVisible({ timeout: 30_000 });
      expect(pageD.url()).toBe(shh.origin + "/salon");
      await expect(pageD.getByText("Personnes dans le salon\u202f: 2", { exact: false })).toBeVisible();
      await expect(fil(pageD)).toHaveCount(0);
      expect(await axe(pageD)).toEqual([]);
      await bouton(pageD, "Détruire le salon").first().click();
      await bouton(pageD, "Annuler").click(); // confirmation ouverte, puis annulée
      await expect(bouton(pageD, "Détruire le salon")).toBeVisible();
    } finally {
      await ctxD.close();
    }
    // Destruction par la créatrice délogée, depuis son écran de fin : seul
    // J_gestion part ; fin chez C et E, plus rien sur le disque.
    await bouton(page, "Détruire le salon").first().click();
    await page.getByRole("button", { name: "Détruire le salon" }).last().click(); // confirmation
    await expect(page.getByText("Ce salon a été détruit.", { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(bouton(page, "Reprendre la main ici")).toHaveCount(0);
    await expect(titre(pageC, "Cette conversation est terminée")).toBeVisible({ timeout: 30_000 });
    await expect(pageC.getByText("Ce salon a été détruit.", { exact: false })).toBeVisible();
    await capture(pageC, "salon-fin");
    await expect(titre(page, "Cette conversation est terminée")).toBeVisible({ timeout: 30_000 });
    await expect(titre(pageE, "Cette conversation est terminée")).toBeVisible({ timeout: 30_000 });
    expect(scanDir(dir, reperes)).toEqual([]);
    await shh.server.stop();
    expect(scanDir(dir, reperes)).toEqual([]);
    expect(findIn(shh.server.stdout(), [needle("témoin", "SHH_LISTENING")])).toEqual(["témoin"]);
    expect(findIn(shh.server.stdout(), reperes)).toEqual([]);
    expect(findIn(shh.server.stderr(), reperes)).toEqual([]);
  } finally {
    await ctxC?.close();
    await ctxE?.close();
    await ctxB.close();
  }
});

// Gestes communs aux tests du destinataire (open, content, save, endoflife, démo) : envoyer un
// partage par l'interface, lire le lien et le mot de passe sur « Lien prêt », puis ouvrir.
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { expect } from "./fixtures";
import { addText, cleanAll, openFilePicker, readyHeading, sendButton } from "./send-helpers";

const FILES = fileURLToPath(new URL("./files/", import.meta.url));
export const file = (name: string) => join(FILES, name);

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".svg": "image/svg+xml",
  ".html": "text/html",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".exe": "application/x-msdownload",
  ".zip": "application/zip",
};
type Upload = { name: string; mimeType: string; buffer: Buffer };
/** Fichier de ui-e2e/files en mémoire (chemins et tampons ne se mélangent pas dans setFiles). */
const upload = (f: string | Upload): Upload =>
  typeof f === "string" ? { name: basename(f), mimeType: MIME[extname(f)] ?? "application/octet-stream", buffer: readFileSync(f) } : f;

export type Sent = { link: string; password: string; manage: string };

/**
 * Envoi par l'interface (bureau : options dans la colonne ; téléphone : feuille « Options »).
 * `files` : chemins de ui-e2e/files ou fichiers en mémoire ; ordre d'ajout = ordre du composeur.
 */
export async function sendShare(
  page: Page,
  url: string,
  o: {
    text?: string;
    files?: (string | { name: string; mimeType: string; buffer: Buffer })[];
    opens?: number;
    download?: boolean;
    isMobile?: boolean;
    clean?: boolean;
    title?: string;
    /**
     * « Protéger par un mot de passe » (D42-28, désactivé par défaut dans l'interface) : activé
     * ici par défaut, pour les tests écrits avec un mot de passe ; `false` : partage sans mot de
     * passe (lien « #l », `password` vide).
     */
    protect?: boolean;
  } = {},
): Promise<Sent> {
  const protect = o.protect !== false;
  // Lien de gestion : plus affiché sur « Lien prêt » (gardé dans « Mes partages », D42-30) ; le
  // test le déduit de l'en-tête X-Shh-Manage de la création (S_gestion), comme send.spec.ts. La
  // création part dès l'ajout du premier élément (envoi anticipé, D41-19) : écoute posée avant.
  let manage = "";
  const onRequest = (r: import("@playwright/test").Request) => {
    const u = new URL(r.url());
    if (r.method() === "POST" && u.pathname === "/api/shares")
      void r.allHeaders().then((h) => {
        if (h["x-shh-manage"]) manage = `${u.origin}/s#m${h["x-shh-manage"]}`;
      });
  };
  page.on("request", onRequest);
  await page.goto(url);
  if (o.text !== undefined) await addText(page, o.text);
  if (o.files?.length) {
    const chooser = openFilePicker(page);
    await (await chooser).setFiles(o.files.map(upload));
    await expect(page.locator("[data-row]")).toHaveCount(o.files.length + (o.text !== undefined ? 1 : 0));
    // Rien n'est nettoyé sans le balai : « Tout nettoyer » pour l'éprouver.
    if (o.clean) await cleanAll(page);
  }
  if (o.opens !== undefined || o.download === false || o.title !== undefined || protect) {
    let opts = page.locator(".side");
    // Téléphone : feuille « Options » (aussi quand l'appelant ne le dit pas : la colonne est cachée).
    const mobile = o.isMobile ?? !(await opts.isVisible().catch(() => false));
    if (mobile) {
      await page.getByRole("button", { name: /^Options · / }).click();
      opts = page.getByRole("dialog", { name: "Options" });
    }
    // Nom du partage : premier champ des options.
    if (o.title !== undefined) await opts.getByLabel("Nom du partage (facultatif)").fill(o.title);
    if (o.opens !== undefined) {
      // Contrôle segmenté : au clavier, comme une personne (flèches depuis le choix courant).
      const group = opts.getByRole("radiogroup", { name: "Ouvertures" });
      const target = group.getByRole("radio", { name: String(o.opens), exact: true });
      await group.getByRole("radio", { checked: true }).focus();
      for (let k = 0; k < 10 && !(await target.isChecked()); k++) await page.keyboard.press("ArrowRight");
      await expect(target).toBeChecked();
    }
    if (o.download === false) {
      const sw = opts.getByRole("switch", { name: "Autoriser le téléchargement" });
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "false");
    }
    if (protect) {
      const sw = opts.getByRole("switch", { name: "Protéger par un mot de passe" });
      await expect(sw).toHaveAttribute("aria-checked", "false"); // désactivé par défaut (D42-28)
      await sw.click();
      await expect(sw).toHaveAttribute("aria-checked", "true");
    }
    if (mobile) await page.keyboard.press("Escape");
  }
  await sendButton(page).click();
  await expect(readyHeading(page)).toBeVisible({ timeout: 60_000 });
  page.off("request", onRequest);
  await expect.poll(() => manage).toMatch(/#m[A-Za-z0-9_-]{43}$/);
  await expect(page.locator("[data-kept]")).toBeVisible();
  await expect(page.locator("[data-manage]")).toHaveCount(0);
  const read = async (l: ReturnType<Page["locator"]>) => (await l.locator(".sr-only").first().textContent()) ?? "";
  const link = await read(page.getByRole("group", { name: "Lien", exact: true }));
  // Mot de passe masqué à l'arrivée : l'œil l'affiche, puis le remasque. Sans mot de passe : aucun.
  const pw = page.getByRole("group", { name: "Mot de passe", exact: true });
  let password = "";
  if (protect) {
    await pw.locator("[data-reveal]").click();
    password = await read(pw);
    await pw.locator("[data-reveal]").click();
  } else await expect(pw).toHaveCount(0);
  expect(link).toMatch(protect ? /#[A-Za-z0-9_-]{43}$/ : /#l[A-Za-z0-9_-]{43}$/);
  return { link, password, manage };
}

/** Bouton « Ouvrir » d'un partage sans mot de passe (D42-28). */
export const openButton = (page: Page) => page.getByRole("button", { name: /^(Ouvrir|Ouverture…)$/ });

/** Ouvre un partage sans mot de passe (geste « Ouvrir ») ; attend l'écran de contenu. */
export async function openNoPassword(page: Page): Promise<void> {
  await expect(pwField(page)).toHaveCount(0);
  await openButton(page).click();
  await expect(page.getByRole("heading", { name: /^Contenu(, .+)?$/ })).toBeVisible({ timeout: 30_000 });
}

/** Contexte neuf (aucun état partagé avec l'expéditeur), même locale. */
export async function freshPage(browser: Browser, opts: Parameters<Browser["newContext"]>[0] = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: "fr-FR", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...opts });
  return { ctx, page: await ctx.newPage() };
}

export const unlockButton = (page: Page) => page.getByRole("button", { name: /^(Déverrouiller|Déchiffrement)/ });
export const pwField = (page: Page) => page.getByLabel("Mot de passe", { exact: true });

/**
 * Saisit le mot de passe et déverrouille ; attend l'écran de contenu (titré « Contenu », ou du nom
 * du partage, précédé de « Contenu, » pour les lecteurs d'écran :).
 */
export async function unlock(page: Page, password: string): Promise<void> {
  await pwField(page).fill(password);
  await unlockButton(page).click();
  await expect(page.getByRole("heading", { name: /^Contenu(, .+)?$/ })).toBeVisible({ timeout: 30_000 });
}

/** Animations finies (entrées, dissolution) : contraste et captures stables. */
export const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.timeline === document.timeline && a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );

/** Ligne d'une note dans la liste du contenu (sa première ligne y est montrée en extrait). */
/** Ligne d'une note chez le destinataire, par son titre (la ligne ne montre jamais le contenu). */
export const noteRow = (page: Page, title = "Note") => page.locator('li.row[data-kind="note"]').filter({ has: page.locator(`.name[title="${title}"]`) });

/** Aller à la page Sécurité : lien du pied de page s'il est visible, sinon Réglages (onglet ou en-tête). */
export async function goSecurity(page: Page) {
  // Pied de page sur toutes les pages, ordinateur et téléphone.
  const foot = page.locator("footer.foot").getByRole("link", { name: "Sécurité", exact: true });
  await foot.scrollIntoViewIfNeeded();
  await foot.click();
}

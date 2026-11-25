// « Lien prêt » (UI §9.5) sur le vrai serveur : deux cartes pour deux secrets (M18), copie qui
// lit l'état, partage natif sans mot de passe, QR du lien seul, dictée locale, garde de sortie
// tant que le lien et le mot de passe ne sont pas copiés (coches), « Nouveau partage » discret,
// menus du site par la même garde, Supprimer. Captures fr-FR à 1440 × 900 et 390 × 844.
import type { BrowserContext, Page } from "@playwright/test";
import { NotFoundError, fetchMeta } from "../src/index";
import { qrPath } from "../src/qr/qr";
import { axe, capture, expect, grantClipboard, readClipboard, test } from "./fixtures";
import { addText, armed, readyHeading, sendButton } from "./send-helpers";

const LINK_RE = /^http:\/\/127\.0\.0\.1:\d+\/s#[A-Za-z0-9_-]{43}$/;

async function toReady(page: Page, context: BrowserContext, origin: string, text = "Le code de la porte est 4471.") {
  await grantClipboard(context, origin);
  await page.goto(origin + "/");
  await addText(page, text);
  await sendButton(page).click();
  await expect(readyHeading(page)).toBeVisible({ timeout: 60_000 });
}
const clip = (page: Page) => readClipboard(page);
const newShare = (page: Page) => page.locator(".ready .done").getByRole("button", { name: "Nouveau partage", exact: true });
/** Captures demandées (PC, téléphone) : test-results/captures/<nom>-{d1440,m}.png. */
const shot = (page: Page, name: string, isMobile: boolean) => page.screenshot({ path: `test-results/captures/${name}-${isMobile ? "m" : "d1440"}.png`, fullPage: isMobile });
const linkCard = (page: Page) => page.getByRole("group", { name: "Lien", exact: true });
const pwCard = (page: Page) => page.getByRole("group", { name: "Mot de passe", exact: true });
/** Valeur complète d'un CopyField (texte pour lecteur d'écran). */
/** Valeur lue par le lecteur d'écran ; le mot de passe est d'abord affiché (masqué à l'arrivée). */
const valueOf = async (page: Page, card: ReturnType<typeof linkCard>) => {
  const eye = card.locator("[data-reveal]");
  if ((await eye.count()) > 0 && (await eye.getAttribute("aria-pressed")) !== "true") await eye.click();
  return (await card.locator(".sr-only").first().textContent()) ?? "";
};

test.describe("fr-FR", () => {
  test.use({ locale: "fr-FR", timezoneId: "Europe/Paris" });

  test("deux cartes, copie depuis l'état, coches, Partager (app, copie, QR du lien et du mot de passe, D41-29), Nouveau partage", async ({ page, shh, context, isMobile }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      (window as unknown as { __shared: unknown[] }).__shared = shared;
      Object.defineProperty(navigator, "share", { value: async (d: unknown) => void shared.push(d), configurable: true });
    });
    await toReady(page, context, shh.origin);
    await expect(readyHeading(page)).toBeFocused();

    // Ordre du DOM : avertissement → un seul cadre (lien, mot de passe, infos) →
    // Supprimer → Nouveau partage ; plus de « Gérer ce partage ».
    const order = await page.evaluate(() => {
      const els = [...document.querySelectorAll(".ready p.never, .ready [data-ready-card] [role=group][aria-label], .ready [data-ready-facts], .ready .danger-zone, .ready .done")];
      return els.map((e) => e.getAttribute("aria-label") ?? e.className.split(" ").find((c) => c && !c.startsWith("svelte-")));
    });
    expect(order).toEqual(["never", "Lien", "Mot de passe", "facts", "danger-zone", "done"]);
    await expect(page.getByText("Gérer ce partage")).toHaveCount(0);
    await expect(page.locator(".ready p.never")).toHaveText("Ce lien et ce mot de passe ne seront plus jamais affichés.");
    // Aucune action principale en bas : « Nouveau partage » discret (fantôme), Supprimer aussi.
    await expect(newShare(page)).toHaveClass(/\bghost\b/);
    await expect(page.locator(".ready .done .btn.primary")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Supprimer ce partage" })).not.toHaveClass(/\bprimary\b/);
    await expect(page.locator("[data-ready-works]")).toHaveText("Le lien marche déjà. Gardez le lien et le mot de passe\u202f: ils ne seront plus affichés après.");
    // Rien de copié : aucune coche, avertissement à la fermeture armé.
    await expect(page.locator("[data-ready-copied]")).toHaveCount(0);
    expect(await armed(page)).toBe(true);
    // Mot de passe masqué à l'arrivée ; « Copier » donne la vraie valeur, même masquée.
    await expect(pwCard(page).locator("[data-masked]")).toBeVisible();
    await expect(pwCard(page).locator("[data-reveal]")).toHaveAttribute("aria-pressed", "false");
    // Lien de gestion : montré sans l'historique (seul moyen de suivre le partage), caché avec lui.
    // Sans compte, l'historique est désactivé par défaut.
    const keep = page.getByRole("switch", { name: "Garder dans mon historique" });
    await expect(keep).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("[data-manage] .sr-only").first()).toHaveText(/#m[A-Za-z0-9_-]{43}$/);
    await keep.click();
    await expect(keep).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("[data-manage]")).toHaveCount(0);
    await keep.click();
    await expect(page.locator("[data-manage] .sr-only").first()).toHaveText(/#m[A-Za-z0-9_-]{43}$/);
    // Plus d'avertissement « par un autre moyen ».
    await expect(page.locator(".ready").getByText("autre moyen", { exact: false })).toHaveCount(0);

    const link = await valueOf(page, linkCard(page));
    const password = await valueOf(page, pwCard(page));
    // Remasqué : la copie qui suit se fait masquée.
    await pwCard(page).locator("[data-reveal]").click();
    await expect(pwCard(page).locator("[data-masked]")).toBeVisible();
    expect(link).toMatch(LINK_RE);
    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(await linkCard(page).innerText()).not.toContain(password);

    // Copier lit l'état, jamais le DOM.
    await page.evaluate(() => document.querySelectorAll(".cf .val").forEach((e) => (e.textContent = "x")));
    await linkCard(page).getByRole("button", { name: /^Copier/ }).click();
    expect(await clip(page)).toBe(link);
    // Le lien seul : sa coche ; toujours l'avertissement (le mot de passe manque).
    await expect(linkCard(page).locator("[data-ready-copied]")).toBeVisible();
    await expect(pwCard(page).locator("[data-ready-copied]")).toHaveCount(0);
    expect(await armed(page)).toBe(true);
    await pwCard(page).getByRole("button", { name: /^Copier/ }).click();
    expect(await clip(page)).toBe(password);
    // Les deux : deux coches, plus d'avertissement.
    await expect(pwCard(page).locator("[data-ready-copied]")).toBeVisible();
    expect(await armed(page)).toBe(false);

    // Copier le lien et le mot de passe (D41-29) : une seule copie, deux lignes.
    await page.getByRole("button", { name: "Copier le lien et le mot de passe" }).first().click();
    expect(await clip(page)).toBe(`Lien\u202f: ${link}\nMot de passe\u202f: ${password}`);
    // Partager : feuille à trois choix ; « Envoyer vers une app » → { text } avec les deux lignes.
    await page.locator("main").getByRole("button", { name: "Partager", exact: true }).click(); // « Partager » de la barre du haut : un menu, hors de <main>
    const sheet = page.getByRole("dialog", { name: "Partager le lien et le mot de passe" });
    await sheet.getByRole("button", { name: "Envoyer vers une app" }).click();
    expect(await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).toEqual([
      { text: `Lien\u202f: ${link}\nMot de passe\u202f: ${password}` },
    ]);
    // QR : le lien suivi du mot de passe (#<K_lien>.<base64url>), même chemin que qrPath.
    await sheet.getByRole("button", { name: "Afficher le QR code" }).click();
    const qr = sheet.getByRole("img", { name: "QR code du lien et du mot de passe" });
    await expect(qr).toBeVisible();
    const both = `${link}.${Buffer.from(password, "utf8").toString("base64url")}`;
    expect(await qr.locator("path").getAttribute("d")).toBe(qrPath(both).d);
    await expect(sheet.getByText("À montrer seulement à la personne en face de vous.")).toBeVisible();
    await sheet.getByRole("button", { name: "Copier le lien et le mot de passe" }).click();
    await expect(page.locator("input[type=email]")).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await capture(page, "ready-qr");
    await page.keyboard.press("Escape");

    // Aucun « Vider le presse-papier » (clipboard-read=() : rien à vérifier) ; la copie reste.
    await expect(page.getByRole("button", { name: "Vider le presse-papier" })).toHaveCount(0);
    expect(await clip(page)).toBe(`Lien\u202f: ${link}\nMot de passe\u202f: ${password}`);

    // Tout est copié : « Nouveau partage » part sans confirmation ; composeur vide, plus aucun secret à l'écran.
    expect(await armed(page)).toBe(false);
    await newShare(page).click();
    // Composeur vide (page /envoyer, D41-37) : « Ajouter » sur téléphone, zone de dépôt sur ordinateur.
    await expect(page.getByRole("button", { name: /^(Commencer|Ou créer sur place|Ajouter)/ }).or(page.locator(".dropzone")).filter({ visible: true }).first()).toBeVisible();
    await expect(page.locator("[data-row]")).toHaveCount(0);
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).not.toContain(link);
    expect(body).not.toContain(password);
    expect(await armed(page)).toBe(false);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  });

  test("rien de copié : « Nouveau partage » demande confirmation (texte clair) ; Continuer → composeur vide", async ({ page, shh, context }) => {
    test.setTimeout(120_000);
    await toReady(page, context, shh.origin);
    expect(await armed(page)).toBe(true);
    await newShare(page).click();
    await expect(page.getByText("Vous n'avez pas encore copié le lien et le mot de passe. Ils ne pourront plus être affichés. Continuer\u202f?")).toBeVisible();
    await page.getByRole("button", { name: "Annuler" }).filter({ visible: true }).click();
    await expect(readyHeading(page)).toBeVisible();
    await newShare(page).click();
    await page.getByRole("group").getByRole("button", { name: "Continuer", exact: true }).filter({ visible: true }).click();
    await expect(readyHeading(page)).toHaveCount(0);
    expect(await armed(page)).toBe(false);
  });

  test("menus du site (routeur) : rien de copié → une confirmation, refus → on reste, accord → on part ; tout copié → rien demandé, Retour non plus", async ({ page, shh, context, isMobile }) => {
    test.setTimeout(150_000);
    const dialogs: string[] = [];
    let answer = false;
    page.on("dialog", (d) => {
      dialogs.push(`${d.type()}:${d.message()}`);
      void (answer ? d.accept() : d.dismiss());
    });
    /** Logo de l'en-tête (« Shhgone, accueil ») : un lien du site, par le routeur. */
    const home = () => page.locator("header.top a.logo").click();

    await toReady(page, context, shh.origin);
    await expect(page.locator("header.top a.logo")).not.toHaveAttribute("aria-disabled", "true");
    await shot(page, "ready2-arrivee", isMobile);
    await home();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toMatch(/^confirm:Quitter cette page/);
    await expect(readyHeading(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/envoyer");
    // Accord : on part (une seule question, pas de seconde alerte « beforeunload »).
    answer = true;
    await home();
    await expect(readyHeading(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(dialogs).toHaveLength(2);

    // Page d'information (autre fichier HTML, chargement complet) : une seule question aussi.
    await toReady(page, context, shh.origin);
    await page.locator("footer.foot").getByRole("link", { name: "Sécurité", exact: true }).click();
    await expect(page).toHaveURL(/\/securite$/);
    expect(dialogs).toHaveLength(3);
    expect(dialogs[2]).toMatch(/^confirm:/);

    // Tout copié : coches, aucune question par les menus ni par le Retour ensuite.
    answer = false;
    await toReady(page, context, shh.origin);
    await page.locator("main").getByRole("button", { name: "Copier le lien et le mot de passe" }).click();
    await expect(page.locator("[data-ready-copied]")).toHaveCount(2);
    expect(await armed(page)).toBe(false);
    await page.waitForTimeout(400);
    await shot(page, "ready2-copie", isMobile);
    await home();
    await expect(readyHeading(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/");
    await page.goBack();
    await page.waitForTimeout(300);
    expect(dialogs).toHaveLength(3);
  });

  test("Supprimer ce partage : confirmation, « Partage supprimé », plus rien sur le serveur", async ({ page, shh, context }) => {
    test.setTimeout(120_000);
    await toReady(page, context, shh.origin);
    const link = await valueOf(page, linkCard(page));
    await capture(page, "ready");
    await page.getByRole("button", { name: "Supprimer ce partage" }).click();
    await expect(page.getByText("Supprimer ce partage pour tout le monde ? Le lien ne mènera plus à rien.")).toBeVisible();
    await page.getByRole("button", { name: "Supprimer", exact: true }).click();
    const title = page.getByRole("heading", { name: "Partage supprimé" });
    await expect(title).toBeVisible();
    await expect(title).toBeFocused();
    await expect(page.getByText("Il a été effacé du serveur : le lien ne mène plus à rien.", { exact: false })).toBeVisible();
    await expect.poll(async () => fetchMeta(link, shh.origin).then(() => "vivant", (e) => (e instanceof NotFoundError ? "supprimé" : String(e)))).toBe("supprimé");
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(link);
    await page.waitForTimeout(2600); // gomme du logo
    await capture(page, "ready-deleted");
    await page.getByRole("button", { name: "Nouveau partage" }).click();
    // Composeur vide (page /envoyer, D41-37) : « Ajouter » sur téléphone, zone de dépôt sur ordinateur.
    await expect(page.getByRole("button", { name: /^(Commencer|Ou créer sur place|Ajouter)/ }).or(page.locator(".dropzone")).filter({ visible: true }).first()).toBeVisible();
    expect(await armed(page)).toBe(false);
  });

  test("mot de passe généré de 11 caractères : affiché exactement comme il est copié (scan UX B5 ; D41-15 : plus de saisie)", async ({ page, shh, context }) => {
    test.setTimeout(120_000);
    await grantClipboard(context, shh.origin);
    await toReady(page, context, shh.origin);
    const gen = await valueOf(page, pwCard(page));
    expect(gen).toHaveLength(11);
    // Affiché tout collé, sans groupe ni séparateur : ce qu'on lit = la copie.
    await expect(pwCard(page).locator(".val.vis")).toHaveText(gen);
    await pwCard(page).getByRole("button", { name: /^Copier/ }).click();
    expect(await clip(page)).toBe(gen);
  });

  test("échéance en deux lignes (date et heure exactes, puis décompte) et durée de vie choisie (3 ouvertures, 6 h)", async ({ page, shh, context, isMobile }) => {
    test.setTimeout(120_000);
    // Date.now() figé et durée exacte : le serveur arrondit l'échéance au quart d'heure SUPÉRIEUR
    // de son heure réelle ; la réponse de finalize est fixée ici à 12 h (ou 6 h) pile.
    const exact = async (p: Page) =>
      p.route("**/api/shares/finalize", async (route) => {
        const r = await route.fetch();
        const ttl = JSON.parse(route.request().postData() ?? "{}").ttl_hours as number;
        await route.fulfill({ response: r, json: { expires_in_s: ttl * 3600 } });
      });
    await exact(page);
    await page.clock.setFixedTime(new Date("2026-11-05T21:41:00+01:00"));
    await toReady(page, context, shh.origin);
    await expect(page.getByText("Actif", { exact: true })).toBeVisible();
    await expect(page.locator("[data-deadline] .ends")).toHaveText(/^Se termine le 6\snov\. à 9\sh\s41$/);
    await expect(page.locator("[data-deadline] .left")).toHaveCount(0); // heure de fin seule
    await expect(page.getByText(/^S'efface tout seul\s: après 1\souverture, ou à cette heure \(12\sh après l'envoi, arrondie au quart d'heure supérieur\)\.$/)).toBeVisible();
    await expect(page.getByText(/disparaît de partout/)).toHaveCount(0);

    const p2 = await context.newPage();
    await exact(p2);
    await p2.clock.setFixedTime(new Date("2026-11-05T21:36:00+01:00"));
    await p2.goto(shh.origin + "/");
    await addText(p2, "options");
    if (isMobile) await p2.getByRole("button", { name: /^Options · / }).click(); // téléphone : options en feuille
    await p2.getByRole("radiogroup", { name: "Durée" }).getByRole("radio", { name: /^6\sh$/ }).evaluate((e: HTMLInputElement) => e.click());
    await p2.getByRole("radiogroup", { name: "Ouvertures" }).getByRole("radio", { name: "3", exact: true }).evaluate((e: HTMLInputElement) => e.click());
    if (isMobile) await p2.keyboard.press("Escape");
    await sendButton(p2).click();
    await expect(readyHeading(p2)).toBeVisible({ timeout: 60_000 });
    await expect(p2.getByText(/^S'efface tout seul\s: après 3\souvertures, ou à cette heure \(6\sh après l'envoi, arrondie au quart d'heure supérieur\)\.$/)).toBeVisible();
    await expect(p2.locator("[data-deadline] .ends")).toHaveText(/^Se termine le 6\snov\. à 3\sh\s36$/);
    await expect(p2.locator("[data-deadline] .left")).toHaveCount(0);
  });

  test("mot de passe affiché tout collé (11 caractères, sans groupe ni point), sans « Épeler » ; rien dans la console ni le stockage", async ({ page, shh, context }) => {
    test.setTimeout(120_000);
    const logs: string[] = [];
    page.on("console", (m) => logs.push(m.text()));
    await toReady(page, context, shh.origin);
    const password = await valueOf(page, pwCard(page));
    expect(password).toMatch(/^[abcdefghkmnpqrtuvwxyACDEFGHJKLMNPQRTUVWXY23456789!?@#$%&*+\-=/()]{11}$/);
    await expect(pwCard(page).locator(".val.vis")).toHaveText(password);
    await expect(pwCard(page).locator(".gsep, .g")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Épeler" })).toHaveCount(0);
    expect(logs.join("\n")).not.toContain(password);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(await page.title()).toBe("Lien prêt · Shhgone");
  });

  test("mouvement réduit : aucune animation ; sinon, montée en éventail ≤ 640 ms et boutons cliquables", async ({ page, shh, context }) => {
    test.setTimeout(120_000);
    // Toutes les animations WAAPI lancées dans « Lien prêt » : durée + délai ≤ 640 ms.
    await page.addInitScript(() => {
      const runs: number[] = [];
      (window as unknown as { __runs: number[] }).__runs = runs;
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (k, o) {
        if (this.closest(".ready") && typeof o === "object") runs.push(Number(o.duration ?? 0) + Number(o.delay ?? 0));
        return orig.call(this, k, o);
      };
    });
    await toReady(page, context, shh.origin);
    const runs = await page.evaluate(() => (window as unknown as { __runs: number[] }).__runs);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const d of runs) expect(d).toBeLessThanOrEqual(640);
    // Boutons cliquables pendant l'animation : la copie répond tout de suite.
    await page.getByRole("group", { name: "Lien", exact: true }).getByRole("button", { name: /^Copier/ }).click();

    // Seconde page au premier plan : sinon l'onglet est en arrière-plan, requestAnimationFrame
    // y est suspendu et Playwright ne voit jamais un bouton « stable » (S11, téléphone).
    const p2 = await context.newPage();
    await p2.bringToFront();
    await p2.emulateMedia({ reducedMotion: "reduce" });
    await p2.goto(shh.origin + "/");
    await addText(p2, "réduit");
    await sendButton(p2).click();
    await expect(readyHeading(p2)).toBeVisible({ timeout: 60_000 });
    expect(
      await p2.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.(".ready")).length),
    ).toBe(0);
  });
});

test.describe("390 × 844", () => {
  test.use({ locale: "fr-FR", viewport: { width: 390, height: 844 }, isMobile: false });

  test("« Nouveau partage » dans le fil, jamais collé en bas ; sous Supprimer ; QR en feuille ; capture", async ({ page, shh, context }) => {
    test.setTimeout(120_000);
    await toReady(page, context, shh.origin);
    await page.waitForTimeout(700);
    await capture(page, "ready-390");
    const done = newShare(page);
    const del = page.getByRole("button", { name: "Supprimer ce partage" });
    expect(await del.evaluate((e) => getComputedStyle(e.closest(".danger-zone")!).position)).toBe("static");
    expect(await done.evaluate((e) => getComputedStyle(e.closest(".done")!).position)).toBe("static");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const [d, b] = [await del.boundingBox(), await done.boundingBox()];
    expect(d!.y + d!.height).toBeLessThanOrEqual(b!.y);
    await capture(page, "ready-390-bottom");
    await page.locator("main").getByRole("button", { name: "Partager", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Partager le lien et le mot de passe" });
    await sheet.getByRole("button", { name: "Afficher le QR code" }).click();
    await expect(sheet.getByRole("img", { name: "QR code du lien et du mot de passe" })).toBeVisible();
    await page.waitForTimeout(500);
    await capture(page, "ready-qr-390");
  });
});

test.describe("en-US", () => {
  test.use({ locale: "en-US" });

  test("Link ready in English ; capture", async ({ page, shh }) => {
    test.setTimeout(120_000);
    // « Start » mène à la page d'envoi (D41-37) ; puis « Add » (téléphone) ou « Create here » (ordinateur).
    await page.goto(shh.origin + "/envoyer");
    const add = page.getByRole("button", { name: /^Add/ }).or(page.locator(".dropzone")).filter({ visible: true }).first();
    await expect(add).toBeVisible();
    if (await page.getByRole("button", { name: /^Add/ }).filter({ visible: true }).first().isVisible()) {
      await page.getByRole("button", { name: /^Add/ }).filter({ visible: true }).first().click();
      await page.getByRole("dialog", { name: "Add" }).getByRole("button", { name: /^Note/ }).click();
    } else await page.getByRole("group", { name: "Create here" }).getByRole("button", { name: "Note", exact: true }).click();
    const dlg = page.getByRole("dialog");
    await dlg.locator("textarea").fill("The door code is 4471.");
    await dlg.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Encrypt and send" }).click();
    await expect(page.getByRole("heading", { name: "Link ready" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("group", { name: "Password" })).toBeVisible();
    await expect(page.getByText("different channel", { exact: false })).toHaveCount(0);
    await page.waitForTimeout(700);
    await capture(page, "ready-en");
  });
});

// Accueil (UI §9.1, §20.4 ; UI §25) : titre mot par mot, cases cochées,
// infographie, boutons du héros (qui mènent à la page d'envoi « /envoyer » ; Photo ou
// vidéo, Vocal, Note), voile de dépôt pleine page, sections sous le pli (Comment ça marche,
// Pensé pour la confidentialité, Offres, questions), révélations au défilement.
import type { Page } from "@playwright/test";
import { axe, capture, expect, test } from "./fixtures";
import { maxRelLuminance } from "./png";
import { MIMES } from "../src/media/capture";

const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Glisser de fichiers simulé : DataTransfer construit dans la page (Chromium et WebKit). */
async function drag(page: Page, type: "dragenter" | "dragover" | "dragleave" | "drop", names: string[]) {
  await page.evaluate(
    ({ type, names }) => {
      const dt = new DataTransfer();
      for (const n of names) dt.items.add(new File(["x"], n, { type: "text/plain" }));
      const e = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
      document.querySelector("main")!.dispatchEvent(e);
    },
    { type, names },
  );
}

const TITLE_FR = "Un lien chiffré, puis ça s'efface.";

test.describe("fr-FR", () => {
  test.use({ locale: "fr-FR" });

  test("titre, phrase, cases cochées, fenêtre de dépôt, sections titrées, infographie lisible ; axe", async ({ page, shh, isMobile }) => {
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    await page.goto(shh.origin + "/");
    await expect(page.getByRole("heading", { level: 1, name: TITLE_FR })).toBeVisible();
    await expect(page.locator("[data-lede]")).toHaveText(/^Vos fichiers, mais aussi des messages vocaux, des notes et bientôt un salon de discussion/);
    const certs = page.getByRole("list", { name: "En bref" }).getByRole("listitem");
    await expect(certs).toHaveCount(3);
    // Cadre d'envoi : « Choisir des fichiers », puis Photo ou vidéo, Vocal, Salon. Plus de « Parcourir ».
    await expect(page.getByRole("button", { name: /^Choisir des fichiers/ })).toBeVisible();
    await expect(page.getByRole("group", { name: "Ou créer sur place" }).getByRole("button")).toHaveText([/Photo ou vidéo/, /Vocal/, /Salon/]);
    await expect(page.getByRole("button", { name: "Parcourir les fichiers" })).toHaveCount(0);
    // Limites gratuites (spec §41.2), lues des constantes.
    for (const h of ["Comment ça marche", "Ce qui reste hors de notre portée", "Offres", "Vos questions"])
      await expect(page.getByRole("heading", { level: 2, name: h, exact: true })).toHaveCount(1);
    // Infographie : sept étapes lisibles en liste, le dessin caché.
    await expect(page.locator("[data-demo-steps] li")).toHaveCount(7);
    await expect(page.locator("[data-demo] svg").first()).toHaveAttribute("focusable", "false");
    await expect(page.getByRole("link", { name: "Tous les détails de sécurité" })).toHaveAttribute("href", "/securite");
    // Le code public (pied de page) : lien sortant sans référent.
    await expect(page.locator("footer").getByRole("link", { name: /^Open source sur GitHub/ })).toHaveAttribute("rel", "noopener noreferrer");
    // Aucun « # » dans un lien de la page (réservé aux clés, UI §12.1).
    expect(await page.locator("main a[href*='#']").count()).toBe(0);
    expect(await noHScroll(page)).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.waitForTimeout(900);
    await capture(page, "home");

    await page.getByRole("link", { name: "Tous les détails de sécurité" }).click();
    await expect(page).toHaveURL(shh.origin + "/securite");
  });

  test("téléphone 390 × 844 : « Choisir des fichiers » et « Créer sur place » dans le cadre, au premier écran ; infographie dessous ; plus de carte de dépôt", async ({ page, shh, isMobile }) => {
    test.skip(!isMobile, "projets téléphone seulement");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(shh.origin + "/");
    await page.waitForTimeout(1400); // positions finales (entrée finie)
    // La carte de dépôt ne reste que sur la page d'envoi.
    await expect(page.locator('[data-slot="compose"]')).toBeHidden();
    const frame = (await page.locator("[data-ctas]").boundingBox())!;
    const pick = (await page.locator("[data-pick]").boundingBox())!;
    const make = (await page.locator('[data-make="room"]').boundingBox())!;
    expect(pick.height).toBeGreaterThanOrEqual(48);
    expect(make.height).toBeGreaterThanOrEqual(48);
    // Le bouton occupe la largeur de la zone de dépôt ; ordre : fichiers, puis « Créer sur place ».
    const drop = (await page.locator("[data-ctas] .drop").boundingBox())!;
    expect(pick.width).toBeGreaterThan(drop.width - 40);
    expect(make.y).toBeGreaterThan(pick.y);
    expect(make.y + make.height).toBeLessThanOrEqual(844);
    // Tout le cadre est visible au premier écran, même sous les barres de Safari :
    // 700 px laissent la place de la barre d'adresse et des onglets d'un iPhone.
    expect(frame.y + frame.height).toBeLessThanOrEqual(700);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    const demo = (await page.locator("[data-demo]").boundingBox())!;
    expect(demo.y).toBeGreaterThan(frame.y + frame.height);
    // « Créer sur place » : page d'envoi, feuille « Ajouter » ouverte.
    await page.locator('[data-make="room"]').click();
    await expect(page).toHaveURL(shh.origin + "/envoyer");
    await expect(page.getByRole("dialog", { name: "Ajouter" })).toBeVisible();
  });

  test("ordinateur : la légende de l'animation est centrée dans son cadre", async ({ page, shh }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(shh.origin + "/");
    const cadre = page.locator("[data-demo-now]");
    await cadre.scrollIntoViewIfNeeded();
    await expect(cadre.locator(".cap:not(.gabarit)")).toBeVisible();
    const c = (await cadre.boundingBox())!;
    const t = (await cadre.locator(".cap:not(.gabarit)").boundingBox())!;
    expect(Math.abs(t.x + t.width / 2 - (c.x + c.width / 2))).toBeLessThan(2);
  });

  test("320 px : rien ne déborde ; capture", async ({ page, shh }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(shh.origin + "/");
    await expect(page.getByRole("heading", { level: 1, name: TITLE_FR })).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    await page.waitForTimeout(900);
    await capture(page, "home-320");
  });

  test("texte à 200 % sur 320 px : aucun débordement ; capture", async ({ page, shh }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(shh.origin + "/");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%"; // CSSOM : permis par la CSP
    });
    await expect(page.locator("[data-pick]")).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    // Plus strict que la page : aucune section ne déborde de sa colonne. Dans Chromium, un mot trop
    // long (« s'autodétruit », question de la FAQ) débordait de 14 px dans la marge sans créer de
    // défilement ; dans WebKit, aux métriques un peu plus larges, il en créait un.
    // Le texte réservé aux lecteurs d'écran (.sr-only, 1 px, sur une ligne) aussi. Les sections en
    // bande (.fondu) débordent exprès par leur décor (halo d'un bord à l'autre de l'écran,
    // coupé par #app) : leur contenu, lui, est vérifié. Les dessins SVG (mis à
    // l'échelle, sans texte de page) et la copie décorative du titre (.words, ses points qui partent
    // vers la droite, coupés par le titre) n'entrent pas dans cette mesure.
    const overflow = await page.evaluate(() =>
      [document.querySelector(".home")!, ...document.querySelectorAll(".home > *, .home section *")]
        .filter((e) => getComputedStyle(e).overflowX === "visible" && !e.closest(".tile, .sr-only, svg, .words") && !e.matches(".fondu, .home"))
        .filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0)
        .map((e) => `${e.tagName}.${(e as HTMLElement).className} ${e.scrollWidth} > ${e.clientWidth}`),
    );
    expect(overflow).toEqual([]);
    await page.waitForTimeout(900);
    await capture(page, "home-320-200pct");
    await page.locator("[data-demo]").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(900);
    expect(await noHScroll(page)).toBe(true);
    await capture(page, "home-320-200pct-securite");
  });

  test("K1 : aucune animation d'entrée (accueil écrit au build) ; seule l'ambiance boucle", async ({ page, shh }) => {
    await page.addInitScript(() => {
      const names: string[] = [];
      (window as unknown as { __anims: string[] }).__anims = names;
      document.addEventListener("animationstart", (e) => names.push((e as AnimationEvent).animationName), true);
    });
    await page.goto(shh.origin + "/");
    await page.waitForTimeout(1500);
    const names = await page.evaluate(() => (window as unknown as { __anims: string[] }).__anims);
    expect(names.filter((n) => /(rise-only|rise-in|vault-in|word-in|letter-fade)$/.test(n))).toEqual([]);
    const infinite = await page.evaluate(() =>
      document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).every((a) => ((a.effect as KeyframeEffect).target as Element).closest("[data-ambient], [data-demo], [data-boucle]") !== null),
    );
    expect(infinite).toBe(true);
  });

  test("/#faq : la page défile jusqu'aux questions", async ({ page, shh }) => {
    await page.goto(shh.origin + "/#faq");
    await expect(page.locator("section#faq")).toBeInViewport();
    await expect(page.locator("#faq-title")).toBeInViewport();
  });

  test("lot 2 : le schéma de la vie d'un lien ne tourne que près de l'écran", async ({ page, shh }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(shh.origin + "/");
    const etat = (sel: string) =>
      page.evaluate((sel) => [...new Set(document.querySelector(sel)!.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations === Infinity).map((a) => a.playState))].join(), sel);
    await page.locator("section.life").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await expect.poll(() => etat("section.life")).toBe("running");
    await page.locator("footer[data-foot]").evaluate((e) => e.scrollIntoView({ block: "end" }));
    await expect.poll(() => etat("section.life")).toBe("paused");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(shh.origin + "/");
    await page.locator("section.life").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await expect.poll(() => etat("section.life")).toBe("");
  });

  test("K8 : le titre a pour nom la phrase entière ; la copie animée est cachée", async ({ page, shh }) => {
    await page.goto(shh.origin + "/");
    const h1 = page.getByRole("heading", { level: 1, name: TITLE_FR, exact: true });
    await expect(h1).toBeVisible();
    await expect(h1.locator(".words")).toHaveAttribute("aria-hidden", "true");
    await expect(h1.locator(".words .w")).toHaveCount(TITLE_FR.split(" ").length);
  });

  test("rien n'attend : à 100 ms, « Créer sur place » mène à la page d'envoi vide (grand cadre de dépôt), puis le sélecteur multiple", async ({ page, shh, isMobile }) => {
    test.skip(isMobile, "téléphone : page d'envoi vide, « Ajouter » (drop.spec.ts)");
    await page.goto(shh.origin + "/", { waitUntil: "domcontentloaded" });
    const start = page.locator('[data-make="room"]');
    await expect(start).toBeAttached();
    await page.waitForTimeout(100);
    await start.click({ force: true });
    await expect(page).toHaveURL(shh.origin + "/envoyer");
    const zone = page.locator(".dropzone.empty");
    await expect(zone).toBeVisible();
    const chooser = page.waitForEvent("filechooser", { timeout: 2000 });
    await zone.click();
    expect((await chooser).isMultiple()).toBe(true);
  });


  test("Photo ou vidéo : caméra dans la page ; sans caméra, repli sur le sélecteur filtré (capture) ; les fichiers choisis ouvrent le composeur", async ({ page, shh, isMobile, browserName }) => {
    test.skip(isMobile, "téléphone : feuille « Ajouter » (capture.spec.ts)");
    // Aucune caméra ici : la page le dit et propose le sélecteur (fausse caméra : capture.spec.ts).
    // Sur le prototype : WebKit ignore l'affectation sur l'objet navigator.mediaDevices, et sa
    // vraie caméra répondait alors « accès refusé ».
    await page.addInitScript(() => {
      if (typeof MediaDevices !== "undefined")
        Object.defineProperty(MediaDevices.prototype, "getUserMedia", { configurable: true, value: () => Promise.reject(new DOMException("aucune", "NotFoundError")) });
    });
    await page.goto(shh.origin + "/envoyer"); // « Créer sur place » : sur la page d'envoi
    await page.waitForTimeout(900);
    // Compte les événements « close » des boîtes de dialogue (écouteur en phase de capture : il passe avant le
    // site) : on attend l'événement lui-même, qui remet `open` à faux, au lieu d'un délai fixe.
    await page.evaluate(() => {
      const w = window as unknown as { __closes: number };
      w.__closes = 0;
      document.addEventListener("close", () => w.__closes++, true);
    });
    let closes = 0;
    // Bascule « Vidéo » seulement si le navigateur sait enregistrer une vidéo (captureSupport,
    // media/capture.ts). Le WebKit Linux des tests n'en enregistre aucune (comme pour le vocal,
    // compose.spec.ts) : le site masque alors la bascule, et le tour Vidéo attendait en vain
    // (CI du 11, webkit-desktop ; ce test ne tourne pas sur téléphone).
    const canVideo = await page.evaluate(
      (list) => typeof MediaRecorder !== "undefined" && list.some((m) => MediaRecorder.isTypeSupported(m)),
      MIMES.video.map(([m]) => m),
    );
    if (browserName === "chromium") expect(canVideo, "Chromium enregistre la vidéo : le tour Vidéo y reste vérifié").toBe(true);
    for (const [mode, accept, fallback] of [["Photo", "image/*", "Choisir une photo"], ["Vidéo", "video/*", "Choisir une vidéo"]] as const) {
      await page.getByRole("group", { name: "Créer sur place" }).getByRole("button", { name: "Photo ou vidéo", exact: true }).click();
      const cam = page.locator("dialog[data-capture]");
      if (mode === "Vidéo" && !canVideo) {
        await expect(cam.getByRole("alert")).toContainText("Aucune caméra ni aucun micro utilisable");
        await expect(cam.getByRole("button", { name: "Vidéo", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(cam).toBeHidden();
        break;
      }
      if (mode === "Vidéo") await cam.getByRole("button", { name: "Vidéo", exact: true }).click();
      await expect(cam.getByRole("alert")).toContainText("Aucune caméra ni aucun micro utilisable");
      // Le WebKit des tests n'émet pas « filechooser » pour un champ <input capture> : le repli
      // vers le sélecteur n'y est vérifié que sous Chromium.
      if (browserName !== "chromium") {
        await expect(cam.getByRole("button", { name: fallback })).toBeVisible();
        await page.keyboard.press("Escape");
        // L'événement « close » (qui remet `open` à faux) arrive après la fermeture visible : sans
        // attente, WebKit rouvrait puis refermait la boîte et le tour suivant ne trouvait rien.
        await expect(cam).toBeHidden();
        closes++;
        await expect.poll(() => page.evaluate(() => (window as unknown as { __closes: number }).__closes), { message: "événement close de la boîte caméra non reçu après Échap" }).toBe(closes);
        await page.waitForTimeout(100);
        continue;
      }
      const chooser = page.waitForEvent("filechooser");
      await cam.getByRole("button", { name: fallback }).click();
      const fc = await chooser;
      expect(fc.isMultiple()).toBe(false);
      expect(await fc.element().getAttribute("accept")).toBe(accept);
      expect(await fc.element().getAttribute("capture")).toBe("environment");
      await expect(cam).toBeHidden();
      await page.waitForTimeout(100);
    }
    const chooser = page.waitForEvent("filechooser"); // déjà sur la page d'envoi
    await page.locator(".dropzone.empty").click();
    await (await chooser).setFiles([
      { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") },
      { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b") },
    ]);
    await expect(page.locator("[data-row]")).toHaveCount(2); // le composeur s'ouvre (compose.spec.ts)
  });

  test("glisser-déposer : voile pleine page, Échap le ferme, un dépôt ajoute ; capture", async ({ page, shh }) => {
    await page.goto(shh.origin + "/");
    await page.waitForTimeout(900);
    const overlay = page.locator(".overlay");
    await expect(overlay).toBeHidden();
    await drag(page, "dragenter", ["a.txt"]);
    await expect(overlay).toBeVisible();
    await expect(page.locator("[data-ctas].over")).toHaveCount(1); // le cadre d'envoi s'allume
    await page.waitForTimeout(600);
    await capture(page, "home-drop");
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
    // Entrées et sorties sur des éléments enfants : le voile reste tant que le compteur n'est pas à zéro.
    await drag(page, "dragenter", ["a.txt"]);
    await drag(page, "dragenter", ["a.txt"]);
    await drag(page, "dragleave", ["a.txt"]);
    await expect(overlay).toBeVisible();
    await drag(page, "drop", ["a.txt", "b.txt", "c.txt"]);
    await expect(overlay).toBeHidden();
    await expect(page.locator("[data-row]")).toHaveCount(3);
    expect(page.url()).toBe(shh.origin + "/");
  });

  test("« Créer sur place » mène à la page d'envoi ; retour : l'accueil ; Sécurité › Comment ça marche descend à sa section", async ({ page, shh, isMobile }) => {
    await page.goto(shh.origin + "/");
    const cta = page.locator('[data-make="room"]');
    await cta.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await cta.click();
    await expect(page).toHaveURL(shh.origin + "/envoyer");
    await expect(page.getByRole("heading", { name: "Votre partage" })).toBeVisible();
    // Téléphone : « Créer sur place » a ouvert la feuille « Ajouter » ; la refermer d'abord.
    if (isMobile) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Ajouter" })).toBeHidden();
    }
    await page.goBack();
    await expect(page).toHaveURL(shh.origin + "/");
    await expect(page.getByRole("heading", { level: 1, name: TITLE_FR })).toBeVisible();
    if (!isMobile) {
      await page.evaluate(() => scrollTo(0, 0));
      await page.getByRole("button", { name: "Sécurité" }).click();
      await page.locator("[data-nav-item]").filter({ hasText: "Comment ça marche" }).click();
      await expect(page.getByRole("heading", { level: 2, name: "Comment ça marche" })).toBeInViewport();
      expect(page.url()).toBe(shh.origin + "/");
    }
  });

  test("questions : accordéon natif, une seule réponse ouverte à la fois", async ({ page, shh }) => {
    await page.goto(shh.origin + "/");
    const q1 = page.getByText("Que se passe-t-il si je perds le lien ?");
    const q2 = page.getByText("Le destinataire peut-il garder une copie ?");
    await q1.scrollIntoViewIfNeeded();
    await q1.click();
    await expect(page.getByText(/^Personne ne peut le retrouver, pas même nous/)).toBeVisible();
    await q2.click();
    await expect(page.getByText(/^Oui, s.il enregistre un élément/)).toBeVisible();
    await expect(page.getByText(/^Personne ne peut le retrouver, pas même nous/)).toBeHidden();
    expect(await page.locator("details[open]").count()).toBe(1);
  });

  test("révélations : chaque section apparaît en entier une fois dans l'écran", async ({ page, shh }) => {
    await page.goto(shh.origin + "/");
    for (const sel of ["section.how h2", "[data-priv-card]:last-child", "[data-offer]:last-child", "section.faq h2"]) {
      const el = page.locator(sel).first();
      await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await expect
        .poll(() => el.evaluate((e) => Number(getComputedStyle(e.closest(".rv") ?? e).opacity)), { timeout: 3000 })
        .toBe(1);
    }
  });

  test("fond : nuit et pictogrammes, plus de trame de croix, sans défilement horizontal, sous le plafond de luminance K5", async ({ page, shh, browserName }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(shh.origin + "/");
    // Un seul motif : les pictogrammes ; plus de trame de croix.
    await expect(page.locator("[data-trame]")).toHaveCount(0);
    expect(await noHScroll(page)).toBe(true);
    test.skip(browserName !== "chromium", "luminance mesurée sur la capture Chromium");
    // K5 : contenu caché (CSSOM), fonds seuls (nuit, trame, aurore), en haut et plus bas dans la page.
    const max: number[] = [];
    for (const y of [0, 1600]) {
      await page.evaluate((y) => scrollTo(0, y), y);
      await page.waitForTimeout(300);
      const hide = "main, header, footer, .skip, .banner-slot";
      await page.evaluate(async (sel) => {
        for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "hidden";
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }, hide);
      max.push(maxRelLuminance(await page.screenshot()));
      await page.evaluate((sel) => {
        for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = "";
      }, hide);
    }
    for (const m of max) expect(m).toBeLessThanOrEqual(0.05);
  });

  test("ambiance : pause hors écran et onglet caché, reprise ensuite", async ({ page, shh }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(shh.origin + "/");
    await page.mouse.move(1, 1);
    const state = () =>
      page.evaluate(() => {
        const out: Record<string, string[]> = {};
        for (const a of document.getAnimations()) {
          const el = (a.effect as KeyframeEffect).target as Element;
          const root = el.closest("[data-ambient]");
          if (!root || a.effect?.getComputedTiming().iterations !== Infinity) continue;
          const k = el.closest(".aurora") ? "aurora" : el.closest("[data-demo]") ? "demo" : "other";
          (out[k] ??= []).push(a.playState);
        }
        return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...new Set(v)].sort().join(",")]));
      });
    // Haut de page : plus rien ne boucle (titre figé) ; l'infographie (sa section,
    // sous « Comment ça marche ») tourne quand elle est à l'écran et s'arrête hors écran.
    await expect.poll(async () => (await state()).other).toBeUndefined();
    const demo = page.locator("[data-demo]");
    await demo.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await expect.poll(async () => (await state()).demo).toBe("running");
    await page.locator("footer[data-foot]").evaluate((e) => e.scrollIntoView({ block: "end" }));
    await expect.poll(async () => (await state()).demo).toBe("paused");
    await demo.evaluate((e) => e.scrollIntoView({ block: "center" }));
    await expect.poll(async () => (await state()).demo).toBe("running");
    const setHidden = (v: boolean) =>
      page.evaluate((hidden) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
        document.dispatchEvent(new Event("visibilitychange"));
      }, v);
    await setHidden(true);
    await expect.poll(async () => Object.values(await state()).every((s) => s === "paused")).toBe(true);
    await setHidden(false);
    await expect.poll(async () => (await state()).demo).toBe("running");
  });

  test("mouvement réduit : aucune animation, ni au chargement ni au défilement ; capture", async ({ page, shh, isMobile }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto(shh.origin + "/");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    // (m6, contour de la carte de dépôt : la carte n'est plus sur l'accueil, .)
    await capture(page, "home-v3-reduced");
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    // Au défilement, seules restent les transitions de couleur de l'en-tête (verre, UI §5.4) :
    // aucune animation d'image clé, rien qui bouge.
    expect(await page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSTransition)).length)).toBe(0);
    expect(
      await page.evaluate(() =>
        document.getAnimations().map((a) => (a as CSSTransition).transitionProperty).filter((p) => /transform|translate|scale|rotate|opacity/.test(p)),
      ),
    ).toEqual([]);
    expect(await page.locator(".rv-wait").count()).toBe(0);
  });

  test("transition de vue réduite (m5) : fondu seulement, aucun groupe déplacé ni redimensionné", async ({ page, shh, browserName }) => {
    test.skip(browserName !== "chromium", "pseudo-éléments de transition dans getAnimations : Chromium");
    await page.goto(shh.origin + "/");
    const run = (reduced: boolean) =>
      page.evaluate(async (r) => {
        const root = document.documentElement;
        root.classList.toggle("vt-reduced", r);
        const doc = document as Document & { startViewTransition(cb: () => void): { ready: Promise<void>; finished: Promise<void> } };
        // Le titre (groupe hero-title) change de taille : sans réduction, son groupe s'anime.
        const vt = doc.startViewTransition(() => document.querySelector("h1")!.classList.toggle("compact"));
        await vt.ready;
        const pseudo = document
          .getAnimations()
          .map((a) => (a.effect as KeyframeEffect).pseudoElement)
          .filter((p): p is string => !!p && p.startsWith("::view-transition"));
        await vt.finished;
        root.classList.remove("vt-reduced");
        return pseudo;
      }, reduced);
    const normal = await run(false);
    expect(normal.some((p) => p.startsWith("::view-transition-group(hero-title)"))).toBe(true);
    const reduced = await run(true);
    expect(reduced.filter((p) => p.startsWith("::view-transition-group"))).toEqual([]);
    expect(reduced).toContain("::view-transition-new(root)");
  });

  test("contraste forcé : aurore, grain et trame retirés, contrôles visibles ; captures", async ({ page, shh, browserName, isMobile }) => {
    test.skip(browserName !== "chromium", "forcedColors : Chromium seulement");
    await page.emulateMedia({ forcedColors: "active" });
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto(shh.origin + "/");
    await expect(page.getByRole("heading", { level: 1, name: TITLE_FR })).toBeVisible();
    for (const sel of [".aurora", ".grain"])
      expect(await page.locator(sel).first().evaluate((e) => getComputedStyle(e).display), sel).toBe("none");
    for (const name of ["Choisir des fichiers", "Vocal"]) {
      const b = page.getByRole("button", { name: new RegExp(`^${name}`) }).filter({ visible: true }).first();
      expect(await b.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe("solid");
    }
    // Le cadre d'envoi est la zone de dépôt : pointillé.
    expect(await page.locator("[data-ctas]").evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe("dashed");
    await page.waitForTimeout(900);
    await capture(page, "home-v3-forced");
    await page.locator("section.priv").evaluate((e) => e.scrollIntoView());
    await page.waitForTimeout(900);
    await capture(page, "home-v3-forced-securite");
  });

  test("captures v3 : premier écran et chaque section", async ({ page, shh, isMobile }) => {
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.goto(shh.origin + "/");
    await page.waitForTimeout(1000);
    const tag = isMobile ? "390" : "1440";
    await capture(page, `home-v3-${tag}`);
    for (const s of ["how", "priv", "offers", "faq"]) {
      await page.locator(`section.${s}`).evaluate((e) => e.scrollIntoView({ block: "start" }));
      await page.evaluate(() => scrollBy(0, -72));
      await page.waitForTimeout(900);
      await capture(page, `home-v3-${tag}-${s}`);
    }
    expect(await noHScroll(page)).toBe(true);
  });
});

test.describe("en-US", () => {
  test.use({ locale: "en-US" });

  test("titre, infographie, sections en anglais ; axe ; capture", async ({ page, shh, isMobile }) => {
    await page.setViewportSize(isMobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    // Version anglaise de l'accueil : « /en » (pages bilingues).
    await page.goto(shh.origin + "/en");
    await expect(page.getByRole("heading", { level: 1, name: "One encrypted link, then it's gone." })).toBeVisible();
    await expect(page.locator("[data-demo-steps] li").nth(1)).toContainText("Encrypted on your device");
    await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Or create something here" })).toBeVisible();
    for (const h of ["How it works", "What stays out of our reach", "Plans", "Your questions"])
      await expect(page.getByRole("heading", { level: 2, name: h, exact: true })).toHaveCount(1);
    expect(await noHScroll(page)).toBe(true);
    expect(await axe(page)).toEqual([]);
    await page.waitForTimeout(900);
    await capture(page, "home-en");
  });
});

// Décalage à l'arrivée de la police (28 novembre) : Mona Sans retardée de 1,2 s, l'accueil ne doit
// pas bouger (CLS < 0,02 ; 0,18 à 0,35 avant, titre et accroche qui changeaient de nombre de lignes :
// largeurs maximales en « ch » et titre anglais trop large pour 360 à 405 px). Chromium seul
// (API layout-shift) ; toute la largeur, téléphone, tablette et ordinateur.
test.describe("police tardive", () => {
  for (const path of ["/", "/en"])
    test(`aucun décalage à l'arrivée de Mona Sans : ${path}`, async ({ page, shh, browserName }) => {
      test.skip(browserName !== "chromium", "API layout-shift : Chromium seul");
      await page.route(/\.woff2$/, async (r) => {
        await new Promise((ok) => setTimeout(ok, 1200));
        await r.continue();
      });
      for (const width of [320, 360, 390, 412, 430, 560, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 860 });
        await page.goto(shh.origin + path);
        await page.evaluate(() => {
          (window as unknown as { cls: number }).cls = 0;
          new PerformanceObserver((l) => {
            for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { cls: number }).cls += e.value;
          }).observe({ type: "layout-shift", buffered: true });
        });
        await page.waitForFunction(() => document.fonts.check('700 40px "Mona Sans"') && document.fonts.status === "loaded", undefined, { timeout: 10_000 });
        await page.waitForTimeout(300);
        const cls = await page.evaluate(() => (window as unknown as { cls: number }).cls);
        expect(cls, `${path} à ${width} px`).toBeLessThan(0.02);
      }
    });
});

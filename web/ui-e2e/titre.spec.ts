// Nom du partage, sur le vrai serveur : champ des options,
// « Lien prêt » (en tête des informations), page d'ouverture puis de contenu du destinataire (titre,
// texte brut isolé, jamais dans l'onglet), « Mes partages » (sur la carte, chiffré dans IndexedDB,
// rien dans localStorage, renommé sur l'appareil sans changer ce que voit le destinataire).
import type { Page } from "@playwright/test";
import { axe, expect, test } from "./fixtures";
import { freshPage, pwField, sendShare, unlockButton } from "./open-helpers";

// Inversion de sens et blancs : retirés et regroupés par le moteur ; balises : du texte.
const TYPED = "  Dossier‮ Dupont   <b>T4</b> ";
const TITLE = "Dossier Dupont <b>T4</b>";

/** Tout ce que l'historique garde dans IndexedDB, en texte et en hex, et tout localStorage. */
const storage = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((ok, ko) => {
        const r = indexedDB.open("shhdrop-history");
        r.onerror = () => ko(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(["meta", "entries"], "readonly");
          const all = tx.objectStore("entries").getAll();
          const meta = tx.objectStore("meta").getAll();
          tx.oncomplete = () => {
            const parts: string[] = [JSON.stringify(localStorage), JSON.stringify(sessionStorage), JSON.stringify(meta.result.filter((x) => !(x instanceof CryptoKey)))];
            for (const rec of all.result as { iv: Uint8Array; ct: Uint8Array }[])
              for (const b of [rec.iv, rec.ct]) parts.push(String.fromCharCode(...b), [...b].map((x) => x.toString(16).padStart(2, "0")).join(""));
            db.close();
            ok(parts.join("\n"));
          };
        };
      }),
  );

test.describe("fr-FR", () => {
  test.use({ locale: "fr-FR", timezoneId: "Europe/Paris" });

  test("nom du partage : Lien prêt, ouverture, contenu, Mes partages (chiffré, renommé ici seulement)", async ({ page, shh, browser, isMobile }) => {
    test.setTimeout(180_000);
    const sent = await sendShare(page, shh.origin + "/", { text: "Le code est 4471.", title: TYPED, isMobile, keep: true });

    // « Lien prêt » : le nom (nettoyé par le moteur) en tête du bloc d'informations, en texte brut.
    const facts = page.locator("[data-ready-card] [data-ready-facts]");
    const name = facts.locator("[data-ready-name]");
    await expect(name.locator("bdi")).toHaveText(TITLE);
    expect(await facts.evaluate((f) => f.firstElementChild?.hasAttribute("data-ready-name"))).toBe(true);
    await expect(name.locator("b")).toHaveCount(0);
    await expect(page).not.toHaveTitle(/Dupont/);
    expect(await axe(page)).toEqual([]);

    // Historique : gardé chiffré, rien en clair dans IndexedDB ni dans localStorage.
    await expect.poll(async () => (await storage(page)).length).toBeGreaterThan(100);
    const raw = await storage(page);
    for (const s of ["Dupont", "Dossier", Buffer.from("Dupont").toString("hex")]) expect(raw).not.toContain(s);

    // Destinataire, autre contexte : avant le déverrouillage, rien (manifeste chiffré) ; après, le
    // nom en titre de la page de contenu, isolé (bdi), jamais dans le titre de l'onglet.
    const r = await freshPage(browser);
    await r.page.goto(sent.link);
    await expect(pwField(r.page)).toBeVisible({ timeout: 30_000 });
    await expect(r.page.locator("body")).not.toContainText("Dupont");
    await pwField(r.page).fill(sent.password);
    await unlockButton(r.page).click();
    const h1 = r.page.getByRole("heading", { level: 1, name: `Contenu, ${TITLE}` });
    await expect(h1).toBeVisible({ timeout: 30_000 });
    await expect(h1.locator("bdi")).toHaveText(TITLE);
    await expect(h1.locator("b")).toHaveCount(0);
    await expect(r.page).not.toHaveTitle(/Dupont/);
    expect(await axe(r.page)).toEqual([]);
    await r.ctx.close();

    // « Mes partages » : le nom sur la carte ; renommer ici seulement (l'écran le dit).
    await page.goto(shh.origin + "/envois");
    const card = page.locator("[data-share-card]");
    await expect(card).toHaveCount(1);
    await expect(card.locator("[data-share-title] bdi")).toHaveText(TITLE);
    await card.getByRole("button", { name: "Détails" }).click();
    await card.getByRole("button", { name: "Renommer" }).click();
    const field = card.getByLabel("Nom sur cet appareil");
    await expect(field).toHaveValue(TITLE);
    await expect(card.locator("[data-rename]")).toContainText("le destinataire voit toujours le nom choisi à l'envoi");
    await field.fill("Contrat signé​ ");
    await card.getByRole("button", { name: "Enregistrer le nom" }).click();
    await expect(card.locator("[data-share-title] bdi")).toHaveText("Contrat signé");
    expect(await axe(page)).toEqual([]);
    // Relu après rechargement ; toujours rien en clair.
    await page.reload();
    await expect(page.locator("[data-share-card] [data-share-title] bdi")).toHaveText("Contrat signé");
    const raw2 = await storage(page);
    for (const s of ["Contrat", "Dupont", Buffer.from("Contrat").toString("hex")]) expect(raw2).not.toContain(s);
  });

  test("sans nom : rien sur « Lien prêt », « Contenu » chez le destinataire", async ({ page, shh, browser, isMobile }) => {
    test.setTimeout(120_000);
    const sent = await sendShare(page, shh.origin + "/", { text: "Sans nom.", isMobile });
    await expect(page.locator("[data-ready-name]")).toHaveCount(0);
    const r = await freshPage(browser);
    await r.page.goto(sent.link);
    await pwField(r.page).fill(sent.password);
    await unlockButton(r.page).click();
    await expect(r.page.getByRole("heading", { level: 1, name: "Contenu", exact: true })).toBeVisible({ timeout: 30_000 });
    await r.ctx.close();
  });
});

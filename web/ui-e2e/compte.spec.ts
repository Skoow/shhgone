// Compte par passkey de bout en bout, PAR L'INTERFACE (conception 2026-11-22-compte-passkey-design.md
// §3, §5, §14). Vrai binaire Go avec SHH_COMPTES=1 (et SHH_SALONS=1), origine
// http://localhost:<port> (rp.id des passkeys), clé K_serveur tirée au hasard ; site construit avec
// SHH_SITE_COMPTES=1 (web/dist-comptes, comptes-site.ts). Passkeys : authentificateur virtuel de
// Chromium (CDP WebAuthn.addVirtualAuthenticator, avec ou sans PRF). Chaque test a son serveur neuf.
// Couvert : inscription (pseudo, passkey, clé de récupération notée, un groupe retapé), connexion en
// un clic, rechargement sans « Rester connecté », nouvel appareil par la clé de récupération (puis
// passkey créée sur cet appareil, retrait de l'ancienne, nouvelle clé), passkey sans PRF (clé locale
// effacée par « Se déconnecter »), réparation des enveloppes (même passkey, autre sortie PRF : clé
// demandée une fois, enveloppe ajoutée, connexion suivante sans la clé), suppression du compte par
// un geste, et « le serveur ne voit rien » vu du navigateur : sorties PRF (lues dans la page par un
// crochet de test), clé de récupération sous toutes ses formes, pseudo affiché, ni dans le dossier de
// données (-wal et -shm compris), ni dans les sorties du serveur, ni dans une requête.
// WebKit : aucun authentificateur virtuel (CDP) ; ces tests y sont écartés (R14 : passage manuel sur
// iPhone et Mac avant l'ouverture).
import { randomBytes } from "node:crypto";
import type { BrowserContext, CDPSession, Page, Request } from "@playwright/test";
import { findIn, needle, scanDir, type Needle } from "../e2e/scan";
import { siteComptes } from "./comptes-site";
import { expect, test as base } from "./fixtures";

const test = base.extend<{ requetes: { url: string; body: string }[] }, { site: string }>({
  site: [async ({}, use) => use(await siteComptes()), { scope: "worker", timeout: 360_000 }],
  shhServer: async ({ site }, use) => use({ comptes: { cle: new Uint8Array(randomBytes(32)) }, env: { SHH_STATIC_DIR: site } }),
  // Corps de toutes les requêtes /api/compte du contexte (fouillés par « le serveur ne voit rien »).
  requetes: async ({ context }, use) => {
    const l: { url: string; body: string }[] = [];
    const f = (r: Request) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) l.push({ url: r.url(), body: r.postData() ?? "" });
    };
    context.on("request", f);
    await use(l);
  },
});

test.use({ locale: "fr-FR", timezoneId: "Europe/Paris" });
test.skip(({ browserName }) => browserName !== "chromium", "compte.spec.ts : Chromium seulement — WebKit n'a pas d'authentificateur virtuel WebAuthn (CDP) ; passage manuel sur iPhone et Mac avant l'ouverture (conception du compte par passkey, R14)");
test.setTimeout(180_000);

const champ = (page: Page, label: string) => page.getByLabel(label, { exact: true }).and(page.locator("input"));
const bouton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const titre = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const connecte = (page: Page) => page.locator("[data-connecte]");

/**
 * Crochet de test (avant le site) : relève les sorties PRF rendues à la page ; `masque` : la même
 * passkey rend une AUTRE sortie PRF (XOR), comme le trousseau iCloud en QR ou sous une autre
 * version d'iOS (conception §4, R6). Rien n'est changé d'autre.
 */
async function crochetPrf(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const w = window as unknown as { __prf: string[]; __masque: boolean };
    // Gardées pour l'onglet (sessionStorage) : chaque page rechargée repart de là.
    w.__prf = JSON.parse(sessionStorage.getItem("test-prf") ?? "[]") as string[];
    w.__masque = sessionStorage.getItem("test-masque") === "1";
    const c = navigator.credentials;
    if (!c) return;
    const enrober = (f: typeof c.get) =>
      async function (this: CredentialsContainer, o?: CredentialRequestOptions) {
        const cred = (await f.call(c, o)) as PublicKeyCredential | null;
        if (!cred) return cred;
        const g = cred.getClientExtensionResults.bind(cred);
        const r = g() as { prf?: { results?: { first?: ArrayBuffer } } };
        const first = r.prf?.results?.first;
        if (first) {
          const b = new Uint8Array(first.slice(0));
          if (w.__masque) for (let i = 0; i < b.length; i++) b[i] = b[i]! ^ 0x5a;
          w.__prf.push(btoa(String.fromCharCode(...b)));
          sessionStorage.setItem("test-prf", JSON.stringify(w.__prf));
          r.prf!.results!.first = b.buffer;
        }
        cred.getClientExtensionResults = () => r as AuthenticationExtensionsClientOutputs;
        return cred;
      };
    c.get = enrober(c.get) as typeof c.get;
    c.create = enrober(c.create as unknown as typeof c.get) as unknown as typeof c.create;
  });
}

/** Authentificateur virtuel de cet onglet (plateforme, vérification de l'utilisateur, PRF ou non). */
async function authentificateur(page: Page, prf: boolean): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: prf },
  });
  return { cdp, id: authenticatorId };
}

/** Inscription par la page ; rend la clé de récupération affichée (« XXXX-…-XXX »). */
async function inscrire(page: Page, origin: string, pseudo: string, rester = false): Promise<string> {
  await page.goto(origin + "/compte/inscription");
  await expect(titre(page, "Créer un compte")).toBeVisible();
  await champ(page, "Pseudo").fill(pseudo);
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 }); // preuve anti-robot et cérémonie chargées
  await bouton(page, "Créer avec une passkey").or(bouton(page, "Garder le compte sur cet ordinateur")).click();
  await expect(titre(page, "Votre clé de récupération")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-pas-encore]")).toHaveText("Le compte n'existe qu'après « Terminer ».");
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  expect(cle).toMatch(/^([0-9A-Z*~$=]{4}-){6}[0-9A-Z*~$=U]{3}$/);
  await bouton(page, "Copier").click(); // « Je l\'ai notée » attend la clé copiée ou téléchargée
  await bouton(page, "Je l\'ai notée").click();
  const label = (await page.locator("label").filter({ hasText: "Tapez le groupe" }).textContent())!;
  const k = Number(/n°\s*(\d)/u.exec(label)![1]);
  await page.getByLabel(label.trim(), { exact: true }).fill(cle.split("-")[k - 1]!.toLowerCase());
  if (rester) await page.getByLabel("Rester connecté sur cet appareil").check();
  await bouton(page, "Terminer").click();
  await expect(titre(page, "Compte créé.")).toBeVisible({ timeout: 30_000 });
  return cle;
}

/** Connexion par la passkey depuis la page de connexion ; rend la vue atteinte. */
async function connecter(page: Page, origin: string): Promise<"ouvert" | "cle"> {
  await page.goto(origin + "/compte/connexion");
  await expect(titre(page, "Se connecter")).toBeVisible();
  await bouton(page, "Se connecter avec une passkey").or(bouton(page, "Utiliser une passkey de cet ordinateur")).click();
  const cle = page.locator("[data-repli]");
  await expect(connecte(page).or(cle)).toBeVisible({ timeout: 30_000 });
  return (await cle.isVisible()) ? "cle" : "ouvert";
}

async function parametres(page: Page, origin: string): Promise<void> {
  await page.evaluate(() => {
    history.pushState(null, "", "/compte");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(titre(page, "Paramètres")).toBeVisible();
  void origin;
}

async function deconnecter(page: Page, origin: string): Promise<void> {
  await parametres(page, origin);
  await bouton(page, "Se déconnecter").click();
  await expect(titre(page, "Se connecter")).toBeVisible();
}

/** Toutes les formes de la clé de récupération (affichée, collée, minuscules). */
const formesCle = (c: string): Needle[] => [needle("clé (groupée)", c), needle("clé (texte)", c.replaceAll("-", "")), needle("clé (minuscules)", c.toLowerCase()), needle("clé (minuscules, texte)", c.replaceAll("-", "").toLowerCase())];
const sortiesPrf = async (page: Page): Promise<Needle[]> => ((await page.evaluate(() => (window as unknown as { __prf: string[] }).__prf)) ?? []).map((b, i) => needle(`sortie PRF ${i}`, new Uint8Array(Buffer.from(b, "base64"))));

test("inscription, déconnexion, connexion en un clic ; session oubliée au rechargement sans « Rester connecté »", async ({ page, shh, requetes }) => {
  await crochetPrf(page.context());
  await authentificateur(page, true);
  const pseudo = `Zoe${randomBytes(3).toString("hex")}`;
  const cle = await inscrire(page, shh.origin, pseudo);
  await expect(page.locator("[data-cle-locale]")).toHaveCount(0); // la passkey ouvre les données
  await deconnecter(page, shh.origin);
  expect(await connecter(page, shh.origin)).toBe("ouvert");
  await page.reload();
  await page.goto(shh.origin + "/compte");
  await expect(titre(page, "Se connecter")).toBeVisible(); // rien de gardé sans « Rester connecté »
  expect(await connecter(page, shh.origin)).toBe("ouvert");
  // Aucune requête vers /api/compte entre le clic et la cérémonie : la feuille est partie sans attendre
  // (couvert par source-rules.test.ts) ; ici, aucune requête ne porte une sortie PRF ni la clé.
  const prf = await sortiesPrf(page);
  expect(prf.length).toBeGreaterThanOrEqual(3);
  for (const r of requetes) {
    expect(r.body, r.url).not.toMatch(/"results"|hmacGetSecret/);
    expect(findIn(Buffer.from(r.body), [...prf, ...formesCle(cle), needle("pseudo affiché", pseudo)]), r.url).toEqual([]);
  }
});

test("nouvel appareil par la clé de récupération : passkey créée ici, ancienne retirée, nouvelle clé ; l'ancienne clé ne sert plus", async ({ page, shh, browser }, info) => {
  await crochetPrf(page.context());
  await authentificateur(page, true);
  const pseudo = `Leo${randomBytes(3).toString("hex")}`;
  const cle = await inscrire(page, shh.origin, pseudo);
  // Passkey de ce premier appareil renommée (libellé chiffré sur l'appareil) : on la retrouve ensuite.
  await parametres(page, shh.origin);
  await page.getByRole("button", { name: /^Renommer / }).click();
  await champ(page, "Nom de la passkey").fill("Premier appareil");
  await page.getByRole("region", { name: "Passkeys" }).getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("region", { name: "Passkeys" }).getByText("Premier appareil")).toBeVisible();

  // Autre appareil (autre navigateur, autre authentificateur, sans la passkey).
  const ctx = await browser.newContext({ ...info.project.use, locale: "fr-FR", timezoneId: "Europe/Paris" });
  try {
    const p2 = await ctx.newPage();
    await crochetPrf(ctx);
    await authentificateur(p2, true);
    await p2.goto(shh.origin + "/compte/connexion");
    await p2.getByRole("link", { name: "J'ai ma clé de récupération" }).click();
    await expect(titre(p2, "Clé de récupération")).toBeVisible();
    await champ(p2, "Clé de récupération").fill("ABCD-EFGH");
    await bouton(p2, "Ouvrir").click();
    await expect(p2.getByText("Clé mal recopiée : vérifiez chaque groupe.")).toBeVisible();
    await champ(p2, "Clé de récupération").fill(cle.toLowerCase().replaceAll("-", " "));
    await bouton(p2, "Ouvrir").click();
    await expect(titre(p2, "Créez une passkey sur cet appareil")).toBeVisible({ timeout: 30_000 });
    await bouton(p2, "Créer la passkey").click();
    await expect(p2.getByText("Passkey ajoutée.").first()).toBeVisible({ timeout: 30_000 });
    await expect(p2.locator("[data-recupere]")).toContainText("Votre clé de récupération a servi.");
    await parametres(p2, shh.origin);
    const pks = p2.getByRole("region", { name: "Passkeys" }).locator("li");
    await expect(pks).toHaveCount(2);
    // Retrait de la passkey du premier appareil ; session récente (clé de récupération).
    await expect(p2.getByRole("region", { name: "Passkeys" }).getByText("Premier appareil")).toBeVisible();
    await bouton(p2, "Retirer Premier appareil").click();
    await expect(p2.getByText("Retirer cette passkey ? Elle ne pourra plus ouvrir ce compte.")).toBeVisible();
    await p2.getByRole("region", { name: "Passkeys" }).getByRole("button", { name: "Retirer", exact: true }).last().click();
    await expect(p2.getByRole("region", { name: "Passkeys" }).locator("p.ok")).toContainText("Passkey retirée", { timeout: 30_000 });
    await expect(pks).toHaveCount(1);
    await expect(p2.getByText("Ajoutez d'abord une autre passkey : la dernière ne se retire pas.")).toBeVisible();
    // Nouvelle clé de récupération (proposée après usage, Q10).
    await bouton(p2, "Créer une nouvelle clé").click();
    const nouvelle = (await p2.locator("[data-cle] .g").allTextContents()).join("-");
    await bouton(p2, "Copier").click(); // « Je l\'ai notée » attend la clé copiée ou téléchargée
    await bouton(p2, "Je l\'ai notée").click();
    const label = (await p2.locator("label").filter({ hasText: "Tapez le groupe" }).textContent())!;
    await p2.getByLabel(label.trim(), { exact: true }).fill(nouvelle.split("-")[Number(/n°\s*(\d)/u.exec(label)![1]) - 1]!);
    await bouton(p2, "Enregistrer la nouvelle clé").click();
    await expect(p2.getByText("Nouvelle clé enregistrée. L'ancienne ne sert plus.").first()).toBeVisible({ timeout: 30_000 });
    // L'ancienne clé ne sert plus ; la passkey retirée ne connecte plus le premier appareil.
    await deconnecter(p2, shh.origin);
    await p2.getByRole("link", { name: "J'ai ma clé de récupération" }).click();
    await champ(p2, "Clé de récupération").fill(cle);
    await bouton(p2, "Ouvrir").click();
    await expect(p2.getByText("Cette clé de récupération n'ouvre aucun compte.")).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.close();
  }
  await page.goto(shh.origin + "/compte/connexion");
  await bouton(page, "Se connecter avec une passkey").or(bouton(page, "Utiliser une passkey de cet ordinateur")).click();
  await expect(page.getByText("Cette passkey n'est liée à aucun compte.")).toBeVisible({ timeout: 30_000 });
});

test("réparation des enveloppes : même passkey, autre sortie PRF → clé demandée une fois, enveloppe ajoutée → connexion suivante sans la clé", async ({ page, shh, requetes }) => {
  await crochetPrf(page.context());
  await authentificateur(page, true);
  const cle = await inscrire(page, shh.origin, `Ana${randomBytes(3).toString("hex")}`);
  await deconnecter(page, shh.origin);
  // La passkey rend désormais une autre sortie PRF (crochet : masque).
  await page.evaluate(() => sessionStorage.setItem("test-masque", "1"));
  expect(await connecter(page, shh.origin)).toBe("cle");
  await expect(page.locator("[data-repli]")).toHaveText("Cet appareil ne permet pas d'ouvrir vos données avec cette passkey. Entrez votre clé de récupération une fois : cet appareil s'en souviendra.");
  await champ(page, "Clé de récupération").fill(cle);
  await bouton(page, "Ouvrir").click();
  await expect(connecte(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-cle-locale]")).toHaveCount(0); // réparée : aucune clé gardée ici
  const poses = requetes.filter((r) => r.url.endsWith("/api/compte/passkeys/enveloppe"));
  expect(poses).toHaveLength(1);
  // Connexion suivante (rien de gardé : déconnexion) : l'enveloppe ajoutée ouvre les données.
  await deconnecter(page, shh.origin);
  expect(await connecter(page, shh.origin)).toBe("ouvert");
  expect(requetes.filter((r) => r.url.endsWith("/api/compte/passkeys/enveloppe"))).toHaveLength(1);
  expect(requetes.filter((r) => r.url.endsWith("/api/compte/recup"))).toHaveLength(1);
});

test("passkey sans PRF : clé locale gardée (dit à l'écran), connexion sans clé ; « Se déconnecter » l'efface, la clé est redemandée", async ({ page, shh }) => {
  await crochetPrf(page.context());
  await authentificateur(page, false);
  const cle = await inscrire(page, shh.origin, `Max${randomBytes(3).toString("hex")}`);
  await expect(page.locator("[data-cle-locale]")).toContainText("vos données s'ouvrent grâce à une clé gardée ici");
  await page.reload();
  expect(await connecter(page, shh.origin)).toBe("ouvert");
  await parametres(page, shh.origin);
  await expect(page.locator("[data-deconnexion-cle]")).toBeVisible();
  await bouton(page, "Se déconnecter").click();
  expect(await connecter(page, shh.origin)).toBe("cle");
  await champ(page, "Clé de récupération").fill(cle);
  await bouton(page, "Ouvrir").click();
  await expect(connecte(page)).toBeVisible({ timeout: 30_000 });
});

test("suppression du compte par un geste de passkey ; ensuite la passkey ne connecte plus ; le serveur ne voit rien", async ({ page, shh, requetes }) => {
  await crochetPrf(page.context());
  await authentificateur(page, true);
  const pseudo = `Ines${randomBytes(3).toString("hex")}`;
  const cle = await inscrire(page, shh.origin, pseudo, true);
  await page.reload(); // « Rester connecté »
  await parametres(page, shh.origin);
  const reperes = [...(await sortiesPrf(page)), ...formesCle(cle), needle("pseudo affiché", pseudo)];
  expect(reperes.length).toBeGreaterThan(5);
  const dir = shh.server.dataDir;
  expect(scanDir(dir, reperes)).toEqual([]);
  await bouton(page, "Supprimer le compte").click();
  await expect(page.getByText("Une confirmation par passkey vous sera demandée.")).toBeVisible();
  await bouton(page, "Supprimer définitivement").click();
  await bouton(page, "Supprimer").click();
  await expect(titre(page, "Compte supprimé.")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-passkey-gestionnaire]")).toContainText(`Supprimez aussi la passkey « ${pseudo} »`);
  await page.goto(shh.origin + "/compte/connexion");
  await bouton(page, "Se connecter avec une passkey").or(bouton(page, "Utiliser une passkey de cet ordinateur")).click();
  // signalUnknownCredential a pu faire oublier la passkey à l'authentificateur : soit aucune passkey,
  // soit « liée à aucun compte » ; dans les deux cas, rien ne s'ouvre.
  await expect(page.getByText("Cette passkey n'est liée à aucun compte.").or(bouton(page, "Se connecter avec une passkey").or(bouton(page, "Utiliser une passkey de cet ordinateur")))).toBeVisible({ timeout: 30_000 });
  await expect(connecte(page)).toHaveCount(0);
  for (const r of requetes) expect(r.body, r.url).not.toMatch(/"results"|hmacGetSecret/);
  expect(scanDir(dir, reperes)).toEqual([]);
  await shh.server.stop();
  expect(scanDir(dir, reperes)).toEqual([]);
  expect(findIn(shh.server.stdout(), reperes)).toEqual([]);
  expect(findIn(shh.server.stderr(), reperes)).toEqual([]);
});

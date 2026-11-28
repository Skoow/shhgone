// Liens sous « /s » et page d'ouverture séparée (docs/conception/specs/2026-11-16-liens-s-et-pages-design.md) : le lien rendu est « /s#… » ;
// la page /s ne charge pas le script de l'application d'envoi ; l'ancienne forme à la racine est
// refusée (l'accueil, la clé retirée de l'adresse) ; la clé est retirée de l'adresse
// après lecture, comme avant.
import { apiComptee, expect, test } from "./fixtures";
import { file, freshPage, sendShare, unlock } from "./open-helpers";

test.use({ locale: "fr-FR" });

test("lien /s#… : ouverture dans la page /s, sans le script d'envoi ; ancienne forme /#… : accueil, rien ouvert", async ({ browser, shh }) => {
  test.setTimeout(120_000);
  const s = await freshPage(browser);
  const sent = await sendShare(s.page, shh.origin + "/", { text: "Bonjour", files: [file("contrat.pdf")], opens: 3 });
  await s.ctx.close();
  expect(sent.link).toMatch(new RegExp(`^${shh.origin}/s#[A-Za-z0-9_-]{43}$`));
  expect(sent.manage).toMatch(new RegExp(`^${shh.origin}/s#m[A-Za-z0-9_-]{43}$`));

  // Nouveau lien : servi par s.html, sans le script de l'application d'envoi (assets/index-*.js).
  const a = await freshPage(browser);
  const scripts: string[] = [];
  a.page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(new URL(r.url()).pathname);
  });
  await a.page.goto(sent.link);
  await expect(a.page.getByRole("button", { name: /^(Déverrouiller|Déchiffrement)/ })).toBeVisible({ timeout: 30_000 });
  await unlock(a.page, sent.password);
  // « /s » n'est plus montré une fois le lien lu.
  expect(new URL(a.page.url()).pathname).toBe("/");
  expect(new URL(a.page.url()).hash).toBe("");
  expect(scripts.some((p) => /\/assets\/s-[^/]+\.js$/.test(p))).toBe(true);
  expect(scripts.filter((p) => /\/assets\/index-[^/]+\.js$/.test(p))).toEqual([]);
  // Rechargement de l'ouverture déverrouillée : « / » repart vers « /s », l'onglet rouvre le
  // partage (octroi de l'onglet, spec §41.4), et l'adresse redevient « / ».
  await a.page.reload();
  await expect(a.page.getByRole("heading", { name: "Contenu", exact: true }).or(a.page.getByRole("heading", { name: "Rouvrir ce partage" }))).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(a.page.url()).pathname).toBe("/");
  await a.ctx.close();

  // Ancienne forme à la racine (refusée) : l'accueil, la clé retirée, aucune requête.
  const b = await freshPage(browser);
  const api: string[] = [];
  b.page.on("request", (r) => {
    if (apiComptee(r.url(), r.method())) api.push(r.url());
  });
  await b.page.goto(sent.link.replace("/s#", "/#"));
  await expect(b.page.locator("[data-pick]")).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(b.page.url()).hash).toBe("");
  await expect(b.page.getByRole("button", { name: /^(Déverrouiller|Déchiffrement)/ })).toHaveCount(0);
  expect(api).toEqual([]);
  await b.ctx.close();

  // Lien de gestion sous /s : écran de gestion, clé retirée de l'adresse.
  const c = await freshPage(browser);
  await c.page.goto(sent.manage);
  await expect(c.page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(c.page.url()).hash).toBe("");
  expect(new URL(c.page.url()).pathname).toBe("/");
  await c.ctx.close();
});

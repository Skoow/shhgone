import { axe, capture, expect, test } from "./fixtures";

test("l'accueil se charge sous la CSP, sans violation ni requête tierce", async ({ page, shh }) => {
  const res = await page.goto(shh.origin + "/");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(await axe(page)).toEqual([]);
  await capture(page, "accueil");
});

// Spec §32 : les liens sont sous « /s#… » ; /s/ et /m/ ne sont pas des routes (404 de
// l'interface), « noindex » comme toute page qui n'est pas publique (audit du 28 novembre).
for (const p of ["/s/x", "/m/x"]) {
  test(`${p} : 404 de l'interface, X-Robots-Tag: noindex`, async ({ page, shh }) => {
    const res = await page.goto(shh.origin + p);
    expect(res?.status()).toBe(404); // vrai statut
    expect(res?.headers()["x-robots-tag"]).toBe("noindex");
    await expect(page.getByRole("heading", { name: /^(Cette page n'existe pas\.|This page does not exist\.)$/ })).toBeVisible();
  });
}

test.describe("fr-FR", () => {
  test.use({ locale: "fr-FR" });
test("pied de page (UI5) : Produit, Confiance, Légal ; langue, nettoyage, À propos ; sans traceur ; © ; version du build ; visible en bas de l'accueil, téléphone compris", async ({ page, shh, isMobile }) => {
  await page.goto(shh.origin + "/");
  const foot = page.locator("footer[data-foot]");
  await foot.scrollIntoViewIfNeeded();
  await expect(foot).toBeVisible();
  // Ordinateur : trois colonnes titrées ; téléphone : un seul bloc, les
  // titres restent pour les lecteurs d'écran (chaque liste garde son nom).
  for (const c of ["Confiance", "Légal"]) {
    if (isMobile) await expect(foot.getByRole("list", { name: c })).toBeVisible();
    else await expect(foot.getByText(c, { exact: true })).toBeVisible();
  }
  // Sans compte, plus de colonne « Produit » (« Offres » retiré du pied).
  await expect(foot.getByText("Produit", { exact: true })).toHaveCount(0);
  // Sans compte, pas de « Téléchargements » tant que l'historique n'est pas activé sur cet appareil
  // (désactivé par défaut ; qui change celle).
  await expect(foot.getByRole("link", { name: /^Téléchargements/ })).toHaveCount(0);
  // Plus d'« Envoyer », de « Mes partages » ni de « Salon » dans le pied : le logo, l'en-tête et le menu y mènent.
  for (const l of ["Envoyer", "Mes partages"]) await expect(foot.getByRole("link", { name: new RegExp(`^${l}$`) })).toHaveCount(0);
  await expect(foot.getByText(/^Salon/)).toHaveCount(0);
  // Phrase de l'hébergeur de la démo : dans la démo seulement.
  await expect(foot.locator("[data-demo-host]")).toHaveCount(0);
  // Plus d'« Offres » ni de « Licence » : la licence est dite sur GitHub.
  for (const l of ["Sécurité", "Confidentialité", "Open source sur GitHub", "Signaler un abus", "Conditions d'utilisation", "Mentions légales", "Contact"])
    await expect(foot.getByRole("link", { name: new RegExp(`^${l}`) })).toBeVisible();
  for (const l of ["Offres", "Licence"]) await expect(foot.getByRole("link", { name: new RegExp(`^${l}`) })).toHaveCount(0);
  // 7 liens (« Vérifier cette version » est une section de Sécurité, plus un lien à part ; « Contact »
  // ajouté le 25 novembre), plus le logo (retour à l'accueil, UI7) et « Version xxxxxxx », qui mène
  // à cette section.
  await expect(foot.getByRole("link")).toHaveCount(9);
  await expect(foot.getByRole("link", { name: /^Vérifier cette version$/ })).toHaveCount(0);
  await expect(foot.getByRole("link", { name: "Shhgone, accueil" })).toBeVisible();
  await expect(foot.getByRole("link", { name: /^Open source/ })).toHaveAttribute("href", "https://github.com/Skoow/shhgone");
  await expect(foot.getByRole("link", { name: /^Open source/ })).toHaveAttribute("rel", "noopener noreferrer");
  // Retours UI9 : plus de mention « aucune publicité » ; le nom en bas à gauche, « © 2026 » à côté.
  await expect(foot.getByText(/publicité/)).toHaveCount(0);
  await expect(foot.locator(".base .sig")).toHaveText(/^Shhgone\s*©\s2026$/);
  await expect(foot.locator("[data-build]")).toHaveText(/^Version ([0-9a-f]{7}|dev)$/);
  await expect(foot.locator("[data-build]")).toHaveAttribute("href", "/verifier");
  // Ni langue ni nettoyage automatique ; « À propos » reste.
  await expect(foot.getByRole("combobox")).toHaveCount(0);
  await expect(foot.getByRole("group", { name: "Langue" })).toHaveCount(0);
  await expect(foot.getByRole("switch")).toHaveCount(0);
  // Plus de « À propos » (pied B) : la phrase de la marque le dit déjà.
  await expect(foot.getByText("Shhgone chiffre sur votre appareil avant l'envoi.", { exact: false })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600); // fin des apparitions au défilement
  expect(await axe(page)).toEqual([]);
});

test("Téléchargements sans compte : dans le menu et le pied de page seulement une fois l'historique activé ici, retiré à la désactivation", async ({ page, shh, isMobile }) => {
  const foot = page.locator("footer[data-foot]");
  const link = () => foot.getByRole("link", { name: /^Téléchargements/ });
  const menuHas = async (n: number) => {
    if (!isMobile) return;
    await page.getByRole("banner").getByRole("button", { name: "Ouvrir le menu" }).click();
    await expect(page.locator("[data-menu]").getByRole("link", { name: /^Téléchargements/ })).toHaveCount(n);
    await page.keyboard.press("Escape");
  };
  await page.goto(shh.origin + "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(link()).toHaveCount(0);
  await menuHas(0);
  // Activé par la personne (page joignable par son adresse) : le lien apparaît.
  await page.goto(shh.origin + "/telechargements");
  await page.getByRole("button", { name: "L'activer" }).click();
  await expect(page.getByRole("switch", { name: /^Garder l'historique/ })).toHaveAttribute("aria-checked", "true");
  await expect(link()).toHaveCount(1);
  // Relu depuis l'appareil : application et page d'information.
  await page.goto(shh.origin + "/");
  await expect(link()).toHaveCount(1);
  await menuHas(1);
  await page.goto(shh.origin + "/securite");
  await expect(link()).toHaveCount(1);
  await menuHas(1);
  // Désactivé (et effacé) : le lien disparaît, partout.
  await page.goto(shh.origin + "/telechargements");
  await page.getByRole("switch", { name: /^Garder l'historique/ }).click();
  await expect(page.getByRole("switch", { name: /^Garder l'historique/ })).toHaveAttribute("aria-checked", "false");
  await expect(link()).toHaveCount(0);
  await page.goto(shh.origin + "/securite");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(link()).toHaveCount(0);
  await menuHas(0);
});
});

test("référencement : robots.txt et sitemap.xml ; pages publiques indexées, pages privées « noindex »", async ({ page, request, shh }) => {
  const robots = await request.get(shh.origin + "/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain("Sitemap: https://shhgone.com/sitemap.xml");
  const map = await request.get(shh.origin + "/sitemap.xml");
  expect(map.status()).toBe(200);
  expect(map.headers()["content-type"]).toMatch(/xml/);
  const locs = [...(await map.text()).matchAll(/<loc>https:\/\/shhgone\.com([^<]*)<\/loc>/g)].map((m) => m[1]);
  // Pages bilingues : chaque page indexée et sa version « /en ».
  expect(locs).toEqual(["/", "/securite", "/confidentialite", "/offres", "/conditions", "/mentions-legales", "/contact"].flatMap((p) => [p, p === "/" ? "/en" : "/en" + p]));
  const meta = (n: string) => page.locator(`meta[name="${n}"]`);
  const og = (n: string) => page.locator(`meta[property="${n}"]`);
  for (const p of locs) {
    const res = await page.goto(shh.origin + p);
    expect(res?.headers()["x-robots-tag"], p).toBeUndefined();
    await expect(meta("robots"), p).toHaveAttribute("content", "index, follow");
    await expect(page.locator('link[rel="canonical"]'), p).toHaveAttribute("href", shh.origin + p);
    await expect(page.locator('link[rel="alternate"][hreflang]'), p).toHaveCount(3);
    expect((await meta("description").getAttribute("content"))!.length, p).toBeGreaterThan(40);
    expect((await meta("description").getAttribute("content"))!.length, p).toBeLessThanOrEqual(155);
    // Aperçu de lien écrit au build (adresses de production, shhgone.com) ; le script ne le change pas.
    await expect(og("og:url"), p).toHaveAttribute("content", "https://shhgone.com" + p);
    await expect(og("og:image"), p).toHaveAttribute("content", "https://shhgone.com/og-image.png");
    await expect(page.locator('script[type="application/ld+json"]'), p).toHaveCount(p === "/" || p === "/en" ? 1 : 0);
  }
  const img = await request.get(shh.origin + "/og-image.png");
  expect([img.status(), img.headers()["content-type"]]).toEqual([200, "image/png"]);
  for (const p of ["/envoyer", "/signaler", "/verifier", "/inconnu"]) {
    const res = await page.goto(shh.origin + p);
    expect(res?.headers()["x-robots-tag"], p).toBe("noindex");
    await expect(meta("robots"), p).toHaveAttribute("content", "noindex");
    await expect(page.locator('link[rel="canonical"]'), p).toHaveCount(0);
    await expect(og("og:url"), p).toHaveCount(0);
  }
  // Barre oblique finale : une seule adresse par page (301).
  const slash = await request.get(shh.origin + "/securite/", { maxRedirects: 0 });
  expect([slash.status(), slash.headers()["location"]]).toEqual([301, "/securite"]);
  // Un partage ouvert (« /s#clé ») n'est jamais indexé, et la canonique ne garde aucun fragment.
  await page.goto(shh.origin + "/s#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(meta("robots")).toHaveAttribute("content", "noindex");
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});

test("translate=no et meta notranslate", async ({ page, shh }) => {
  await page.goto(shh.origin + "/");
  await expect(page.locator("html")).toHaveAttribute("translate", "no");
  await expect(page.locator('meta[name="google"]')).toHaveAttribute("content", "notranslate");
});

test("les gardes enregistrent une requête tierce et une violation CSP", async ({ page, shh }) => {
  // Preuve que les gardes de fin de test fonctionnent ; on les vide ensuite pour ne pas échouer.
  await page.goto(shh.origin + "/");
  await page.evaluate(() => void fetch("http://127.0.0.1:1/x").catch(() => {}));
  await expect.poll(() => shh.cspViolations.length).toBeGreaterThan(0);
  // Navigation du cadre principal vers une origine tierce, servie par route() : aucun réseau,
  // même comportement dans tous les moteurs (WebKit attend longtemps un port fermé).
  await page.route("http://tiers.invalid/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>t</title>" }));
  await page.goto("http://tiers.invalid/");
  expect(shh.foreignRequests).toContain("http://tiers.invalid/");
  shh.cspViolations.length = 0;
  shh.foreignRequests.length = 0;
});

test("capture() n'avale pas une vraie violation CSP", async ({ page, shh }) => {
  await page.goto(shh.origin + "/");
  // Violation réelle de la page avant la capture, puis capture : elle doit rester enregistrée.
  await page.evaluate(() => void fetch("http://127.0.0.1:1/x").catch(() => {}));
  await expect.poll(() => shh.cspViolations.length).toBeGreaterThan(0);
  await capture(page, "garde-violation");
  expect(shh.cspViolations.some((v) => v.includes("connect-src"))).toBe(true);
  shh.cspViolations.length = 0;
  // Style en ligne de la page, après la capture : refusé et enregistré (hors fenêtre de capture).
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent = "body{color:red}";
    document.head.append(st);
  });
  await expect.poll(() => shh.cspViolations.length).toBeGreaterThan(0);
  shh.cspViolations.length = 0;
});

test("vitesse : JS et CSS servis compressés (brotli) ; fichiers à empreinte en cache un an, page jamais en cache", async ({ page, shh, browserName }) => {
  const seen: { url: string; enc: string; cache: string }[] = [];
  page.on("response", async (r) => {
    if (/\/assets\/index-[^/]+\.(js|css)$/.test(r.url())) {
      const h = await r.allHeaders();
      seen.push({ url: r.url(), enc: h["content-encoding"] ?? "", cache: h["cache-control"] ?? "" });
    }
  });
  const doc = await page.goto(shh.origin + "/");
  expect((await doc!.allHeaders())["cache-control"]).toBe("no-store");
  // L'application démarre : le JS compressé a été décodé et exécuté.
  await expect(page.locator("main h1").first()).toBeVisible();
  expect(seen.map((s) => s.url.split(".").pop()).sort()).toEqual(["css", "js"]);
  for (const s of seen) {
    // WebKit sous Linux n'annonce brotli qu'en HTTPS : en HTTP (serveur de test), il reçoit la
    // variante gzip, précompressée elle aussi (CI). Les autres reçoivent brotli.
    expect(s.enc, s.url).toBe(browserName === "webkit" ? "gzip" : "br");
    // Le nom porte l'empreinte du contenu, et index.html (jamais en cache) fixe ce nom et son
    // empreinte SRI : un fichier en cache ne peut pas être une autre version.
    expect(s.cache, s.url).toBe("public, max-age=31536000, immutable");
  }
});

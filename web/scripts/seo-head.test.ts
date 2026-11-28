// Référencement (audit du 28 novembre) : balises des pages indexées, plan du site exact, titres et
// descriptions dans les longueurs que les moteurs affichent, description par défaut des gabarits.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INDEXED } from "../src/app/seo";
import { routeTitle } from "../src/app/title";
import { setLang, t } from "../src/i18n/i18n.svelte";
import { fr } from "../src/i18n/fr";
import { esc, jsonLd, OG_IMAGE, seoHead, sitemapXml } from "./seo-head.mjs";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");
const PATHS = Object.values(INDEXED) as string[];

describe("seo-head", () => {
  it("plan du site : exactement les pages indexées (app/seo.ts), en français et en anglais", () => {
    expect(read("public/sitemap.xml")).toBe(sitemapXml(PATHS));
    const locs = [...read("public/sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toHaveLength(2 * PATHS.length);
    expect(new Set(locs).size).toBe(locs.length);
    expect(locs).toContain("https://shhgone.com/");
    expect(locs).toContain("https://shhgone.com/en/securite");
    expect(read("public/robots.txt")).toMatch(/^Sitemap: https:\/\/shhgone\.com\/sitemap\.xml$/m);
    expect(read("public/robots.txt")).not.toMatch(/^Disallow/m);
  });

  it("titre (60 caractères au plus) et description (155 au plus, 70 au moins) de chaque page indexée, uniques par langue", () => {
    for (const lang of ["fr", "en"] as const) {
      setLang(lang);
      const titles = new Set<string>();
      const descs = new Set<string>();
      for (const name of Object.keys(INDEXED) as (keyof typeof INDEXED)[]) {
        const title = routeTitle(name === "home" ? "landing" : name);
        const desc = t(`seo.${name}` as "seo.home");
        expect([...title].length, `${lang} ${name} : ${title}`).toBeLessThanOrEqual(60);
        expect([...desc].length, `${lang} ${name} : ${desc}`).toBeLessThanOrEqual(155);
        if (name !== "mentions") expect([...desc].length, `${lang} ${name}`).toBeGreaterThanOrEqual(70);
        titles.add(title);
        descs.add(desc);
      }
      expect(titles.size, lang).toBe(PATHS.length);
      expect(descs.size, lang).toBe(PATHS.length);
    }
    setLang("fr");
  });

  it("gabarits (index.html, page.html, s.html) : description par défaut = seo.home, aucun aperçu de lien écrit à la main", () => {
    for (const f of ["index.html", "page.html", "s.html"]) {
      const html = read(f);
      expect(html, f).toContain(`content="${fr["seo.home"]}"`);
      expect(html, f).not.toMatch(/property="og:|name="twitter:|ld\+json/);
    }
  });

  it("page indexée : canonique dans sa langue, hreflang, aperçu de lien complet ; JSON-LD sur l'accueil seulement", () => {
    const h = seoHead({ path: "/securite", lang: "en", title: "Security & co · Shhgone", description: 'Say "hi" <b>' });
    expect(h).toContain('<link rel="canonical" href="https://shhgone.com/en/securite" />');
    expect(h).toContain('<link rel="alternate" hreflang="fr" href="https://shhgone.com/securite" />');
    expect(h).toContain('<link rel="alternate" hreflang="en" href="https://shhgone.com/en/securite" />');
    expect(h).toContain('<link rel="alternate" hreflang="x-default" href="https://shhgone.com/securite" />');
    expect(h).toContain('<meta property="og:url" content="https://shhgone.com/en/securite" />');
    expect(h).toContain('<meta property="og:title" content="Security &amp; co · Shhgone" />');
    expect(h).toContain('<meta property="og:description" content="Say &quot;hi&quot; &lt;b&gt;" />');
    expect(h).toContain('<meta property="og:locale" content="en_US" />');
    expect(h).toContain(`<meta property="og:image" content="https://shhgone.com${OG_IMAGE.path}" />`);
    expect(h).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(h).not.toContain("ld+json");
    expect(h).not.toContain("#");
    const home = seoHead({ path: "/", lang: "fr", title: "x", description: "y" });
    expect(home).toContain(`<script type="application/ld+json">${jsonLd("fr")}</script>`);
    expect(home).toContain('<meta property="og:locale" content="fr_FR" />');
  });

  it("page non indexée : « noindex » seul", () => {
    expect(seoHead({ path: undefined })).toBe('<meta name="robots" content="noindex" />\n  ');
  });

  it("JSON-LD : WebSite et Organization sans donnée personnelle, ni « < », ni autre domaine que le nôtre et schema.org", () => {
    for (const lang of ["fr", "en"] as const) {
      const s = jsonLd(lang);
      expect(s).not.toContain("<");
      const d = JSON.parse(s) as Record<string, unknown> & { publisher: Record<string, unknown> };
      expect(d["@type"]).toBe("WebSite");
      expect(d.url).toBe(lang === "fr" ? "https://shhgone.com/" : "https://shhgone.com/en");
      expect(Object.keys(d.publisher).sort()).toEqual(["@type", "logo", "name", "url"]);
      for (const u of s.match(/https?:\/\/[^"]*/g) ?? []) expect(u === "https://schema.org" || u.startsWith("https://shhgone.com/"), u).toBe(true);
    }
    expect(esc('a&"<>')).toBe("a&amp;&quot;&lt;&gt;");
  });

  it("image d'aperçu : PNG du site aux dimensions annoncées", () => {
    const png = readFileSync(join(web, "public", OG_IMAGE.path));
    expect(png.toString("latin1", 1, 4)).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([OG_IMAGE.width, OG_IMAGE.height]);
  });
});

// Référencement (audit du 28 novembre) : balises de <head> des pages indexées, écrites au build par
// le greffon infoPages (vite.config.ts), et plan du site (public/sitemap.xml, comparé par
// seo-head.test.ts). Rien ici ne charge de ressource tierce : toutes les adresses sont celles du
// site (origine fixe, chemin fixe, jamais de « # »), l'image d'aperçu est un fichier du site.
//
// Aperçus de lien (Open Graph, carte Twitter/X) : seulement sur les pages publiques indexées.
// Jamais sur la page d'un partage (s.html), ni sur l'application (app.html) : un aperçu de lien de
// partage ne montre que le titre « Ouvrir un partage », sans image ni texte d'accroche.
// Données structurées (JSON-LD, schema.org) : sur les deux accueils seulement, WebSite et
// Organization (le nom du service, son adresse et son logo : aucune donnée personnelle, l'éditeur
// reste anonyme). Pas de FAQPage : Google ne l'affiche plus que pour des sites officiels ou de santé.

export const SITE_ORIGIN = "https://shhgone.com";
/** Image d'aperçu (scripts/gen-icons.mjs) : 1200 × 630, le format conseillé par Open Graph et X. */
export const OG_IMAGE = { path: "/og-image.png", width: 1200, height: 630 };

/** Adresse d'une page bilingue dans une langue (comme app/langues.ts, cheminEn). */
export const enPath = (path) => (path === "/" ? "/en" : "/en" + path);
const url = (path, lang) => SITE_ORIGIN + (lang === "en" ? enPath(path) : path);

/** Attribut HTML échappé. */
export const esc = (x) => x.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** JSON-LD des accueils : JSON pur, « < » échappé (aucune fin de balise possible dans le bloc). */
export function jsonLd(lang) {
  const data = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Shhgone",
    url: url("/", lang),
    inLanguage: lang,
    publisher: { "@type": "Organization", name: "Shhgone", url: SITE_ORIGIN + "/", logo: SITE_ORIGIN + "/icon-512.png" },
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Balises d'une page : `path` (chemin français, sans base) pour une page indexée, undefined sinon
 * (« noindex », rien d'autre). Page indexée : robots, canonique (dans sa langue), hreflang fr, en et
 * x-default (= fr), Open Graph et carte X ; JSON-LD pour l'accueil (`path` « / »).
 */
export function seoHead({ path, lang = "fr", title = "", description = "" }) {
  if (path === undefined) return `<meta name="robots" content="noindex" />\n  `;
  const self = url(path, lang);
  const tags = [
    `<meta name="robots" content="index, follow" />`,
    `<link rel="canonical" href="${self}" />`,
    `<link rel="alternate" hreflang="fr" href="${url(path, "fr")}" />`,
    `<link rel="alternate" hreflang="en" href="${url(path, "en")}" />`,
    `<link rel="alternate" hreflang="x-default" href="${url(path, "fr")}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Shhgone" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${self}" />`,
    `<meta property="og:locale" content="${lang === "en" ? "en_US" : "fr_FR"}" />`,
    `<meta property="og:locale:alternate" content="${lang === "en" ? "fr_FR" : "en_US"}" />`,
    `<meta property="og:image" content="${SITE_ORIGIN}${OG_IMAGE.path}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="${OG_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="Shhgone" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ];
  if (path === "/") tags.push(`<script type="application/ld+json">${jsonLd(lang)}</script>`);
  return tags.join("\n    ") + "\n  ";
}

/**
 * Plan du site : chaque page indexée en français et en anglais, avec ses versions (hreflang). Sans
 * « lastmod » : une date de build changerait les octets du site à chaque construction (build
 * reproductible, spec §28.1) sans dire quand la page a changé ; Google n'utilise lastmod que s'il est
 * exact.
 */
export function sitemapXml(paths) {
  const alt = (p) =>
    `<xhtml:link rel="alternate" hreflang="fr" href="${url(p, "fr")}"/><xhtml:link rel="alternate" hreflang="en" href="${url(p, "en")}"/><xhtml:link rel="alternate" hreflang="x-default" href="${url(p, "fr")}"/>`;
  const rows = paths.flatMap((p) => [`  <url><loc>${url(p, "fr")}</loc>${alt(p)}</url>`, `  <url><loc>${url(p, "en")}</loc>${alt(p)}</url>`]);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- Pages publiques indexées (app/seo.ts, INDEXED), en français et en anglais ; écrit par`,
    `     scripts/seo-head.mjs (sitemapXml), comparé par scripts/seo-head.test.ts. -->`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
    ...rows,
    `</urlset>`,
    ``,
  ].join("\n");
}

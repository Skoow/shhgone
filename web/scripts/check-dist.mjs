#!/usr/bin/env node
// Contrôle du site construit (UI §14.3, A41) : le code de démo est absent de la production, et
// la démo porte bien ses protections. Lancé par `make test-web` et la CI après les builds.
//   node scripts/check-dist.mjs [dossier]          production (défaut : web/dist)
//   node scripts/check-dist.mjs --demo [dossier]   démo (défaut : web/dist-demo)
//   --comptes : build de production fait avec SHH_SITE_COMPTES=1 (module de compte admis)
// Sortie 0 si tout va bien ; sinon 1, une ligne par problème sur stderr.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { DEMO_BASE, DEMO_META } from "./demo-meta.mjs";
import { findAnalytics, findErrorListeners } from "./no-analytics.mjs";
import { checkSri, sha384 } from "./sri.mjs";

const MARK = "__SHH_DEMO__";
/** Phrase du dictionnaire anglais (titre de l'accueil) : absente du script principal de production. */
// Phrase propre au dictionnaire anglais (titre de l'accueil), à garder égale à en.ts (test).
const EN_PROBE = "One link, one password, then it's gone.";
/**
 * Appel des passkeys du navigateur (account/navigateur.ts) : jamais dans la démo, qui simule la
 * passkey (conception du compte par passkey §11, Q8 : aucune passkey de démo laissée dans le
 * gestionnaire des visiteurs) ; présent avec --comptes.
 */
const PASSKEY_PROBE = /navigator\??\.credentials/;

/**
 * Poids maximal du module WebAssembly du salon, en brotli (400 000 → 430 000). Mesuré : 422 572 o en
 * brotli (profil wasm-salon, opt-level "z"), dont OpenMLS et hpke-rs avec `experimental` toujours
 * actif par openmls_rust_crypto (ML-KEM, X-Wing, P-256/384, k256 compilés), et les tables Unicode
 * du texte (~96 Ko). Un fournisseur crypto limité à la suite 0x0001 pourrait le réduire plus tard.
 * 429 684 o avec le pseudo du compte (pseudoValide, pseudoReserve), 316 o sous
 * le plafond : la prochaine fonction du salon le dépassera probablement (décision à prendre).
 *  (version finale du salon : relever le plafond avec une
 * justification écrite) : 430 211 o avec les accusés de pièce `piece_ouverte` et
 * `piece_telechargee` (v3 §14.2 ; deux sortes de message, leurs vecteurs communs). 430 000 → 435 000 :
 * environ 4,8 Ko de marge pour les corrections, pas pour de nouvelles fonctions ; toute fonction
 * nouvelle du moteur du salon repasse par une décision (ou par le fournisseur crypto réduit).
 * La preuve de membre (D41-26) n'ajoute rien au module (HKDF du moteur de partage, AES-GCM de WebCrypto).
 */
const SALON_BROTLI_MAX = 435_000;

/**
 * Poids maximal du moteur des partages (assets/engine-*.wasm), en brotli : il est chargé par
 * toutes les pages de partage. Mesuré : 141 559 o avant le compte, 191 466 o
 * avec la règle du pseudo (tables Unicode : unicode-segmentation, -script, -security), 148 300 o
 * une fois le pseudo exposé par le module du salon à la place (dérivations du compte gardées).
 * Le plafond laisse ~5 % de marge : une table Unicode ou une bibliothèque entrée par erreur se voit.
 * 154 958 o avec le compte par passkey ajouté au compte par e-mail, 147 481 o
 * une fois le compte par e-mail retiré (adresse, mot de passe, Argon2id du compte). Plafond gardé
 * (le baisser est une décision).
 */
const ENGINE_BROTLI_MAX = 156_000;

/** Traces de démo interdites en production (le texte du bandeau, sans ponctuation typographique). */
/** Phrase visible de la démo (demo/install.ts, HOST_NOTE) : exigée dans la démo, interdite en production. */
const HOST_NOTE_EN = "hosted by GitHub, which sees your IP address";
const FORBIDDEN_IN_PROD = [
  MARK,
  "fake-server",
  "fake-xhr",
  "DemoBanner",
  'http-equiv="Content-Security-Policy"',
  "le lien ne marche que dans cet onglet",
  "the link only works in this tab",
  // Phrase de l'hébergeur de la démo (pied de page).
  "hébergée par GitHub, qui voit",
  HOST_NOTE_EN,
  `${DEMO_BASE}assets/`, // base de la démo dans un build de production
];

/**
 * Adresses absolues admises dans index.html, pdf-frame.html et le CSS : espaces de noms XML
 * (SVG en ligne), de simples identifiants qu'aucun navigateur ne télécharge.
 */
// « https://shhgone.com/s » : notre propre adresse, écrite en texte dans l'exemple du lien en
// deux de l'accueil (« affiche https devant ») ; jamais chargée.
const ALLOWED_URLS = new Set(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink", "http://www.w3.org/1999/xhtml", "https://shhgone.com/s"]);

/**
 * Aucune ressource tierce (règles du projet, spec §10) : rend chaque adresse http(s):// absolue, et
 * chaque adresse « //hôte » sans schéma dans un attribut src, href, action ou dans url(…) /
 * @import, hors ALLOWED_URLS. La CSP de production (default-src 'self') les bloquerait, pas
 * celle d'un cadre ou d'une copie servie ailleurs : le contrôle ne dépend pas d'elle.
 * Une adresse s'arrête aussi à « % » et « & » (xmlns encodé d'une image SVG en ligne du CSS,
 * &quot; du HTML) : l'hôte, lui, reste toujours dans ce qui est rendu.
 */
export function findExternalUrls(text) {
  const out = [];
  for (const [url] of text.matchAll(/https?:\/\/[^\s"'`()<>\\%&]*/gi)) if (!ALLOWED_URLS.has(url)) out.push(url);
  for (const [, url] of text.matchAll(/(?:\b(?:src|href|action|srcset|poster|data)\s*=\s*["']?|url\(\s*["']?|@import\s+["'])(\/\/[^\s"'`()<>\\%&]*)/gi)) out.push(url);
  return out;
}

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const metaRe = (attrs) => {
  const parts = Object.entries(attrs).map(([k, v]) => `${k}="(?:${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${esc(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"`);
  return new RegExp(`^<meta ${parts.join(" ")}\\s*/?>`);
};

/**
 * Traces du module de compte (web/src/account/ : routes et base IndexedDB) : interdites dans un
 * build sans __COMPTES__ (le site public ne change pas) et dans la démo.
 */
const ACCOUNT_TRACES = ["/api/compte", "shhdrop-compte"];

/** Rend la liste des problèmes (vide si tout va bien). `comptes` : build de production avec __COMPTES__ (la démo l'a toujours). */
/** Pages d'information servies par leur propre fichier (vite.config.ts, PAGE_PATHS). */
export const INFO_PAGES = ["securite.html", "confidentialite.html", "offres.html", "conditions.html", "mentions-legales.html", "signaler.html", "verifier.html"];
/** Versions anglaises (pages bilingues, src/app/langues.ts), production seulement : accueil et pages d'information. */
export const EN_PAGES = ["en.html", ...INFO_PAGES.map((p) => "en-" + p)];

/** `pages` : pages d'information exigées (le vrai build : INFO_PAGES ; les petits sites des tests : aucune). */
export function checkDist(dir, demo, comptes = false, pages = []) {
  const problems = [];
  if (!existsSync(join(dir, "index.html"))) return [`${dir} : index.html absent (build manquant ?)`];
  const raw = files(dir).map((p) => ({ rel: relative(dir, p), data: readFileSync(p) }));
  // Variantes précompressées (.br, .gz) : chacune doit redonner exactement son fichier source ;
  // elles ne sont pas relues comme du texte (le source l'est déjà). Aucune dans la démo.
  const byRel = new Map(raw.map((f) => [f.rel, f.data]));
  for (const f of raw) {
    const m = /^(.*)\.(br|gz)$/.exec(f.rel);
    if (!m) continue;
    if (demo) problems.push(`${f.rel} : variante précompressée dans la démo`);
    const src = byRel.get(m[1]);
    let out = null;
    try {
      out = m[2] === "br" ? brotliDecompressSync(f.data) : gunzipSync(f.data);
    } catch {
      out = null;
    }
    if (!src || !out || !out.equals(src)) problems.push(`${f.rel} : ne redonne pas ${m[1]}`);
  }
  const all = raw.filter((f) => !/\.(br|gz)$/.test(f.rel));
  const index = readFileSync(join(dir, "index.html"), "utf8");

  // Spec §28.3 : chaque script et feuille de style de index.html porte une empreinte exacte
  // (production et démo).
  problems.push(...checkSri("index.html", index, (rel) => byRel.get(rel) ?? null, demo ? DEMO_BASE : "/"));
  // Cadre PDF isolé (UI §13), qui reçoit le PDF déchiffré : mêmes empreintes (chemins relatifs),
  // et crossorigin sur chaque balise : son origine est opaque, une empreinte sans CORS serait
  // refusée par le navigateur (le serveur pose Access-Control-Allow-Origin: * sur ses deux
  // fichiers, static_paths.go).
  const frame = byRel.get("pdf-frame.html")?.toString("utf8");
  if (frame === undefined) problems.push("pdf-frame.html : absent");
  else {
    problems.push(...checkSri("pdf-frame.html", frame, (rel) => byRel.get(rel) ?? null, "/"));
    const tags = [...frame.matchAll(/<(?:script\b[^>]*\ssrc=|link\b[^>]*\srel="stylesheet")[^>]*>/g)].map((m) => m[0]);
    if (tags.length !== 2) problems.push(`pdf-frame.html : ${tags.length} balises de script ou de style (2 attendues)`);
    for (const t of tags) if (!/\scrossorigin="anonymous"/.test(t)) problems.push(`pdf-frame.html : crossorigin="anonymous" absent (${t.slice(0, 60)})`);
  }

  // Pages séparées : chaque page d'information a son fichier, ses
  // empreintes SRI, son contenu déjà écrit (titre h1) avant tout script, son titre d'onglet, et
  // ne charge ni le moteur ni le client d'envoi (aucun script qu'elle cite ne les cite).
  for (const page of pages) {
    const html = byRel.get(page)?.toString("utf8");
    if (html === undefined) {
      problems.push(`${page} : page d'information absente`);
      continue;
    }
    problems.push(...checkSri(page, html, (rel) => byRel.get(rel) ?? null, demo ? DEMO_BASE : "/"));
    // Version anglaise : <html lang="en"> ; l'accueil anglais (en.html) est l'application avec
    // son accueil écrit, comme index.html (il charge donc le moteur).
    if (page.startsWith("en") && !/<html lang="en"/.test(html)) problems.push(`${page} : version anglaise sans <html lang="en">`);
    if (page === "en.html") {
      const home = /<!--shh-home-->([\s\S]*?)<!--\/shh-home-->/.exec(html)?.[1];
      if (home === undefined || !/<h1[^>]*>/.test(home)) problems.push("en.html : accueil anglais non écrit (sans titre h1)");
      else if (/\sstyle="/.test(home) || /\/src\//.test(home)) problems.push("en.html : style en ligne ou adresse de développement dans l'accueil écrit");
      continue;
    }
    const app = /<div id="app">([\s\S]*?)<\/body>/.exec(html)?.[1] ?? "";
    if (!/<h1[^>]*>[^<]+/.test(app)) problems.push(`${page} : contenu non écrit dans le HTML (aucun titre h1 avant le script)`);
    if (/<!--shh-page-->/.test(html)) problems.push(`${page} : gabarit non rempli`);
    if (/\/src\//.test(app)) problems.push(`${page} : adresse de développement (/src/) dans le contenu`);
    if (/\sstyle="/.test(app)) problems.push(`${page} : attribut style dans le contenu (la CSP n'admet aucun style en ligne)`);
    const base = demo ? DEMO_BASE : "/";
    const scripts = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+\.js)"/g)].map((m) => (m[1].startsWith(base) ? m[1].slice(base.length) : m[1]));
    for (const rel of scripts) {
      const text = byRel.get(rel)?.toString("utf8") ?? "";
      if (/assets\/(?:engine-[^"'\s]+|[^"'\s/]+\.wasm)/.test(text)) problems.push(`${page} : ${rel} cite le moteur de chiffrement (une page d'information ne le charge pas)`);
    }
  }

  // Accueil écrit au build (référencement) : index.html porte le contenu de
  // l'accueil (titre h1) avant le script, sans attribut style ni adresse de développement ;
  // app.html (autres adresses de l'application, 404) est la même page sans ce contenu : au plus
  // le squelette (U13, coque sans contenu entre <!--shh-shell--> et <!--/shh-shell-->, sous
  // #app[data-squelette]), sans titre ni contenu principal, sans attribut style ni adresse de
  // développement.
  if (pages.length > 0) {
    const home = /<!--shh-home-->([\s\S]*?)<!--\/shh-home-->/.exec(index)?.[1];
    if (home === undefined) problems.push("index.html : accueil non écrit (repères <!--shh-home--> absents)");
    else {
      if (!/<h1[^>]*>/.test(home)) problems.push("index.html : accueil écrit sans titre h1");
      if (/\sstyle="/.test(home)) problems.push("index.html : attribut style dans l'accueil écrit (CSP)");
      if (/\/src\//.test(home)) problems.push("index.html : adresse de développement (/src/) dans l'accueil écrit");
    }
    const appHtml = byRel.get("app.html")?.toString("utf8");
    if (appHtml === undefined) problems.push("app.html : page de l'application sans accueil écrit absente");
    else {
      problems.push(...checkSri("app.html", appHtml, (rel) => byRel.get(rel) ?? null, demo ? DEMO_BASE : "/"));
      const shell = /<div id="app" data-squelette><!--shh-shell-->([\s\S]*?)<!--\/shh-shell--><\/div>/.exec(appHtml)?.[1];
      if (appHtml.includes("<!--/shh-home-->") || (shell === undefined && !appHtml.includes('<div id="app"><!--shh-home--></div>')))
        problems.push("app.html : contient l'accueil écrit (il ne doit pas s'afficher sur les autres adresses)");
      else if (shell !== undefined) {
        if (/<h1[^>]*>/.test(shell) || !/<main\b[^>]*>\s*(?:<!--[^>]*-->\s*)*<\/main>/.test(shell)) problems.push("app.html : squelette avec du contenu (titre ou contenu principal)");
        if (/\sstyle="/.test(shell)) problems.push("app.html : attribut style dans le squelette (CSP)");
        if (/\/src\//.test(shell)) problems.push("app.html : adresse de développement (/src/) dans le squelette");
      }
    }
  }

  // Page « /s » : ouverture et gestion d'un partage, son propre fichier, ses
  // empreintes SRI, jamais indexée, sans le script de l'application d'envoi (assets/index-*.js).
  if (pages.length > 0) {
    const sHtml = byRel.get("s.html")?.toString("utf8");
    if (sHtml === undefined) problems.push("s.html : page d'ouverture absente");
    else {
      problems.push(...checkSri("s.html", sHtml, (rel) => byRel.get(rel) ?? null, demo ? DEMO_BASE : "/"));
      if (!/<meta name="robots" content="noindex"/.test(sHtml)) problems.push("s.html : sans « noindex »");
      if (/assets\/index-[^"]+\.js/.test(sHtml)) problems.push("s.html : charge le script de l'application d'envoi");
      // Exigence C-3 1 (spec salon v3 §3.6.1) : la page d'ouverture des partages ne charge ni le
      // module du salon ni sa colle (aucun script qu'elle cite ne les cite).
      const base = demo ? DEMO_BASE : "/";
      for (const m of sHtml.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+\.js)"/g)) {
        const rel = m[1].startsWith(base) ? m[1].slice(base.length) : m[1];
        const text = byRel.get(rel)?.toString("utf8") ?? "";
        if (/assets\/salon-[^"'\s/]+\.wasm|shhdrop_salon_wasm|recevoirTrame/.test(text)) problems.push(`s.html : ${rel} charge le module du salon`);
      }
    }
  }

  // Aucune ressource tierce (règles du projet) : ni dans les pages (index.html, 404.html de la démo,
  // pdf-frame.html), ni dans les feuilles de style (polices, images). Production et démo.
  for (const f of all) {
    if (!/\.html$|\.css$/.test(f.rel)) continue;
    // Pages d'information : leur contenu écrit cite des liens sortants (<a href>, ouverts par la
    // personne, jamais chargés par la page) ; seuls ces liens-là sont admis. Même chose pour le
    // pied de page du squelette d'app.html (U13), copié en 404.html dans la démo.
    let text = f.data.toString("utf8");
    if (INFO_PAGES.includes(f.rel) || EN_PAGES.includes(f.rel) || f.rel === "index.html" || f.rel === "app.html" || f.rel === "404.html")
      text = text
        .replace(/<a\b[^>]*\shref="https:\/\/[^"]*"[^>]*>/g, "<a>")
        // Page « Vérifier cette version » (spec §28.4) : les commandes à recopier citent des
        // adresses en texte, dans <pre data-cmd><code>…</code></pre>. Seul un texte sans aucune
        // balise est admis (rien ne s'y charge) ; une balise dedans laisse tout le bloc contrôlé.
        .replace(/<pre\b[^>]*\sdata-cmd(?:="")?(?:\s[^>]*)?><code>[^<]*<\/code><\/pre>/g, "<pre></pre>")
        .replace(/<link rel="(?:canonical|alternate" hreflang="(?:fr|en|x-default))" href="https:\/\/shhgone\.com\/[a-z/-]*" \/>/g, "");
    for (const url of findExternalUrls(text)) problems.push(`${f.rel} : adresse externe « ${url} » (aucune ressource tierce)`);
  }

  // Spec §35.1 : aucune statistique, aucun écouteur global d'erreurs, dans tout build.
  for (const f of all) {
    if (/\.(woff2?|png|jpe?g|gif|ico|webp|avif|wasm)$/i.test(f.rel)) continue;
    const text = f.data.toString("utf8");
    for (const w of findAnalytics(text)) problems.push(`${f.rel} : statistique « ${w} » (spec §35.1)`);
    for (const m of findErrorListeners(text)) problems.push(`${f.rel} : écouteur global d'erreurs « ${m} » (spec §35.1)`);
  }

  // Compte : jamais en production sans --comptes ; toujours dans la démo (compte essayable, faux
  // serveur de l'onglet).
  if (!demo && !comptes)
    for (const f of all) {
      if (/\.(woff2?|png|jpe?g|gif|ico|webp|avif|wasm)$/i.test(f.rel)) continue;
      for (const t of ACCOUNT_TRACES) if (f.data.includes(t)) problems.push(`${f.rel} : module de compte « ${t} » dans un build sans __COMPTES__`);
    }
  // Avec --comptes, le module de compte doit être là (sinon le build n'a pas pris SHH_SITE_COMPTES=1
  // et les pages du compte manqueraient en silence).
  if (comptes && !demo && !all.some((f) => /\.m?js$/.test(f.rel) && f.data.includes("/api/compte")))
    problems.push("module de compte absent alors que --comptes est demandé (build fait sans SHH_SITE_COMPTES=1 ?)");
  if (comptes && !demo && !all.some((f) => /\.m?js$/.test(f.rel) && PASSKEY_PROBE.test(f.data.toString("utf8"))))
    problems.push("appel des passkeys (navigator.credentials) absent alors que --comptes est demandé");
  if (demo)
    for (const f of all) if (/\.m?js$/.test(f.rel) && PASSKEY_PROBE.test(f.data.toString("utf8"))) problems.push(`${f.rel} : appel des passkeys du navigateur dans la démo (la passkey y est simulée)`);

  if (!demo) {
    for (const f of all)
      for (const s of FORBIDDEN_IN_PROD) if (f.data.includes(s)) problems.push(`${f.rel} : trace de démo « ${s} »`);
    // Spec §28.3 : aucun import() dynamique, que l'empreinte SRI de index.html ne
    // couvrirait pas. La démo en garde un (son faux serveur, chargé à part).
    for (const f of all) {
      if (!/\.m?js$/.test(f.rel)) continue;
      // Cadre PDF isolé (UI §13) : pdf.js garde trois import() (WebAssembly, worker séparé) sur
      // des chemins que nos options n'empruntent pas (useWasm: false, worker sur le fil
      // principal). Le fichier lui-même est couvert par l'empreinte de pdf-frame.html
      // (ci-dessus). Exempté de cette règle, lui seul.
      if (f.rel === "pdf-frame.js") continue;
      const n = f.data.toString("utf8").match(/(?<![\w$.])import\s*\(/g)?.length ?? 0;
      if (n > 0) problems.push(`${f.rel} : import() dynamique (${n} fois), interdit en production`);
    }
    // Moteur WebAssembly (spec moteur §7 ; il remplace libsodium et l'ancien moteur TypeScript) : .wasm et le script du Worker d'Argon2id (assets/engine-*.js) vivent dans leurs
    // propres fichiers, chargés à la demande avec contrôle d'intégrité (fetch + integrity, puis
    // Worker ; repli : calcul dans la page avec le moteur déjà vérifié). Le script principal ne
    // contient aucun octet .wasm (magie « \0asm » version 1, en base64 ou en tableau de
    // nombres), ne cite aucun de ces fichiers sans son empreinte SHA-384, et aucun n'est orphelin.
    // Scripts du site (points d'entrée et morceaux partagés des pages séparées) : tout script
    // sous assets/ sauf les scripts lus avec leur empreinte : Worker du moteur, dictionnaire
    // anglais (données lues par fetch), et tout script de Worker
    // (« worker » dans le nom : le Worker anti-robot, assets/pow-worker-*.js, ; ou un Worker émis par Vite, ?worker). new Worker(url) n'ayant pas de contrôle
    // d'intégrité, chacun doit être cité avec son empreinte SHA-384 (lu par fetch avec
    // `integrity`, puis lancé depuis un Blob).
    const WORKER = /^assets\/[^/]*worker[^/]*\.js$/i;
    const mains = all.filter((f) => /^assets\/(?!engine-|locale-)[^/]+\.js$/.test(f.rel) && !WORKER.test(f.rel)).map((f) => ({ rel: f.rel, text: f.data.toString("utf8") }));
    for (const m of mains) {
      if (m.text.includes("AGFzbQEAAAA") || /\b0,\s*97,\s*115,\s*109,\s*1,\s*0,\s*0,\s*0\b/.test(m.text))
        problems.push(`${m.rel} : octets WebAssembly en ligne dans le script principal : le moteur doit rester dans assets/engine-*.wasm, lu avec son empreinte`);
      const cited = new Set([...m.text.matchAll(/\/(assets\/(?:engine-[A-Za-z0-9_-]+\.js|locale-[A-Za-z0-9_-]+\.js|[A-Za-z0-9._-]*worker[A-Za-z0-9._-]*\.js|[A-Za-z0-9._-]+\.wasm))/gi)].map((x) => x[1]));
      for (const rel of cited) {
        const data = byRel.get(rel);
        if (!data) problems.push(`${rel} : cité par le script principal, absent du site`);
        else if (!m.text.includes(sha384(data))) problems.push(`${rel} : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)`);
      }
    }
    // Fichier du moteur (.wasm, script du Worker) qu'aucun script principal ne cite : orphelin
    // (chargé d'ailleurs, sans contrôle d'intégrité, ou inutile). Cité sans empreinte : ci-dessus.
    for (const f of all)
      if ((/^assets\/(?:[^/]+\.wasm|engine-[^/]+\.js|locale-[^/]+\.js)$/i.test(f.rel) || WORKER.test(f.rel)) && !mains.some((m) => m.text.includes(`/${f.rel}`)))
        problems.push(`${f.rel} : orphelin, aucun script principal ne le cite avec son empreinte SHA-384`);
    // Une seule langue au démarrage (D4) : le dictionnaire anglais (assets/locale-en-*.js, cité avec
    // son empreinte ci-dessus) n'est pas aussi dans le script principal.
    if (all.some((f) => /^assets\/locale-en-[^/]+\.js$/.test(f.rel)))
      for (const m of mains) if (m.text.includes(EN_PROBE)) problems.push(`${m.rel} : dictionnaire anglais dans le script principal (il doit rester dans assets/locale-en-*.js)`);
    // Moteur WebAssembly : précompressé comme le texte (vite.config.ts, COMPRESSIBLE ; servi par
    // static.go avec Content-Encoding), sinon 506 Ko seraient lus au lieu de 148 Ko en brotli.
    for (const f of all) {
      if (!/\.wasm$/i.test(f.rel) || f.data.length < 1024) continue;
      const missing = [".br", ".gz"].filter((e) => !byRel.has(f.rel + e));
      if (missing.length) problems.push(`${f.rel} : sans variante ${missing.join(" ni ")} : le moteur serait téléchargé sans compression`);
    }
    // Module du salon : à part du moteur (assets/salon-*.wasm, cité avec son empreinte
    // ci-dessus, jamais en ligne), au plus SALON_BROTLI_MAX octets transférés (variante brotli) ;
    // moteur des partages (assets/engine-*.wasm), au plus ENGINE_BROTLI_MAX.
    for (const f of all) {
      const cap = /^assets\/salon-[^/]+\.wasm$/.test(f.rel)
        ? { max: SALON_BROTLI_MAX, nom: "module du salon" }
        : /^assets\/engine-[^/]+\.wasm$/.test(f.rel)
          ? { max: ENGINE_BROTLI_MAX, nom: "moteur des partages" }
          : null;
      if (!cap) continue;
      const br = byRel.get(f.rel + ".br");
      if (br && br.length > cap.max) problems.push(`${f.rel} : ${br.length} octets en brotli, plus que ${cap.max.toLocaleString("fr-FR").replace(/\s/g, " ")} (${cap.nom})`);
    }
    // A7 : polices et images du site sous assets/, nom à empreinte (Vite) : cache d'un an chez le
    // serveur Go (static.go, immutableAsset). Seuls les fichiers publics d'adresse fixe (icônes,
    // logo, manifeste) restent à la racine, en no-store.
    for (const f of all) {
      const font = /\.woff2?$/i.test(f.rel);
      const image = /\.(png|svg|webp|jpe?g|gif|avif)$/i.test(f.rel) && f.rel.includes("/");
      if ((font || image) && !/^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(f.rel)) problems.push(`${f.rel} : police ou image sans empreinte hors de assets/ (A7 : pas de cache long)`);
    }
    if (existsSync(join(dir, "404.html"))) problems.push("404.html : propre à la démo");
    return problems;
  }

  if (!all.some((f) => f.data.includes(MARK))) problems.push(`marque ${MARK} absente : ce n'est pas un build de démo`);
  // Spec moteur §7 : la CSP de la démo (connect-src 'none') interdit de lire un .wasm ; le moteur
  // est donc intégré à un script de la démo (base64 du module, magie « \0asm » version 1).
  for (const f of all)
    if (/\.wasm$/i.test(f.rel)) problems.push(`${f.rel} : fichier .wasm dans la démo : sa CSP (connect-src 'none') interdit de le lire, le moteur doit être intégré au script`);
  // Aucun script de Worker dans la démo (W3) : sa CSP interdit de le lire avec son empreinte, et
  // son faux serveur n'exige aucune preuve de travail ; new Worker(url) le lancerait sans contrôle.
  for (const f of all)
    if (/^assets\/[^/]*worker[^/]*\.js$/i.test(f.rel)) problems.push(`${f.rel} : script de Worker dans la démo (lancé sans contrôle d'intégrité)`);
  // La démo dit, visiblement, que GitHub l'héberge et voit l'adresse IP.
  if (!all.some((f) => /\.m?js$/.test(f.rel) && f.data.includes(HOST_NOTE_EN)))
    problems.push(`phrase de l'hébergeur absente des scripts de la démo (« ${HOST_NOTE_EN} »)`);
  if (!all.some((f) => /\.m?js$/.test(f.rel) && f.data.includes("AGFzbQEAAAA")))
    problems.push("moteur WebAssembly absent des scripts de la démo (base64 « AGFzbQEAAAA ») : elle ne pourrait ni chiffrer ni ouvrir");
  // Les balises de la démo, dans l'ordre, en tout premier dans <head>.
  const head = /<head>\s*([\s\S]*)$/.exec(index);
  let rest = head ? head[1] : "";
  for (const attrs of DEMO_META) {
    const m = metaRe(attrs).exec(rest);
    if (!m) {
      problems.push(`index.html : <meta ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}> absente ou mal placée`);
      break;
    }
    rest = rest.slice(m[0].length).trimStart();
  }
  if (!existsSync(join(dir, "404.html"))) problems.push("404.html absent (adresses profondes sur Pages)");
  // 404.html = app.html : index.html sans l'accueil écrit au build.
  else if (readFileSync(join(dir, "404.html"), "utf8") !== (existsSync(join(dir, "app.html")) ? readFileSync(join(dir, "app.html"), "utf8") : index))
    problems.push("404.html différent de app.html");
  for (const [, url] of index.matchAll(/(?:src|href)="(\/[^"]*)"/g))
    if (!url.startsWith(DEMO_BASE)) problems.push(`index.html : « ${url} » hors de la base ${DEMO_BASE}`);
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const comptes = args.includes("--comptes");
  const rest = args.filter((a) => a !== "--demo" && a !== "--comptes");
  const web = fileURLToPath(new URL("..", import.meta.url));
  const dir = rest[0] ?? join(web, demo ? "dist-demo" : "dist");
  // Le point d'entrée des pages d'information construit (assets/page-*.js) : ses six pages sont
  // exigées. Les petits sites des tests, qui n'en ont pas, ne les demandent pas.
  const hasPages = existsSync(join(dir, "assets")) && readdirSync(join(dir, "assets")).some((n) => /^page-[^/]+\.js$/.test(n));
  const problems = checkDist(dir, demo, comptes, hasPages ? (demo ? INFO_PAGES : [...INFO_PAGES, ...EN_PAGES]) : []);
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-dist${demo ? " --demo" : ""} : ${p}`);
    process.exit(1);
  }
  console.log(`check-dist${demo ? " --demo" : ""} : ${dir} conforme`);
}

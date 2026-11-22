// check-dist.mjs (UI §14.3, A41) : production sans trace de démo ; démo avec ses protections.
import { execFileSync } from "node:child_process";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkDist, findExternalUrls } from "./check-dist.mjs";
import { addSri, sha384 } from "./sri.mjs";
import { DEMO_CSP } from "./demo-meta.mjs";

const SCRIPT = fileURLToPath(new URL("./check-dist.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const esc = (s: string) => s.replace(/'/g, "&#39;");
const PROD_INDEX = `<!doctype html><html><head>\n<meta charset="utf-8" />\n<script type="module" crossorigin src="/assets/index-a.js"></script>\n</head><body></body></html>`;
/** Démo : le moteur WebAssembly est intégré à un script (base64 du module, Task 11). */
const DEMO_ENGINE = 'const wasm="AGFzbQEAAAAB";';
const DEMO_INDEX = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="${esc(DEMO_CSP)}">
    <meta name="referrer" content="no-referrer">
    <meta name="robots" content="noindex">
    <meta charset="utf-8" />
    <script type="module" crossorigin src="/shhgone/assets/index-a.js"></script>
</head><body></body></html>`;

/** Site d'essai ; `sri` (défaut) : index.html reçoit les empreintes comme au build (spec §28.3). */
function site(input: Record<string, string>, sri = true): string {
  const d = mkdtempSync(join(tmpdir(), "check-dist-"));
  dirs.push(d);
  const files: Record<string, string> = { ...input };
  if (sri) files["assets/index-a.js"] ??= "console.info(1)"; // le script que chargent PROD_INDEX et DEMO_INDEX
  for (const page of Object.keys(files).filter((f) => !f.includes("/") && f.endsWith(".html"))) {
    if (!sri || files[page] === undefined) continue;
    const base = files[page]!.includes('"/shhgone/') ? "/shhgone/" : "/";
    try {
      files[page] = addSri(files[page]!, (rel: string) => (files[rel] === undefined ? null : Buffer.from(files[rel]!)), base);
    } catch {
      // ressource absente du site d'essai : la page reste telle quelle (le test porte sur autre chose)
    }
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(d, name, ".."), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
}

/** Lance le script comme en CI ; rend le code de sortie et stderr. */
function run(args: string[]): { code: number; err: string } {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], { stdio: "pipe" });
    return { code: 0, err: "" };
  } catch (e) {
    const x = e as { status: number; stderr: Buffer };
    return { code: x.status, err: x.stderr.toString() };
  }
}

describe("check-dist.mjs, production", () => {
  // Pages séparées (conception du 16 novembre) : exigées par le vrai build (INFO_PAGES).
  it("pages séparées : chaque page existe, a ses empreintes, son contenu écrit, aucun style en ligne, et ne charge pas le moteur", () => {
    const PAGE = (body: string, js = "page-a.js") =>
      `<!doctype html><html><head>\n<script type="module" crossorigin src="/assets/${js}"></script>\n</head><body><div id="app">${body}</div></body></html>`;
    const S = (robots = '<meta name="robots" content="noindex" />', js = "s-a.js") =>
      `<!doctype html><html><head>\n${robots}\n<script type="module" crossorigin src="/assets/${js}"></script>\n</head><body><div id="app"></div></body></html>`;
    // Accueil écrit au build (18 novembre) : index.html avec son contenu entre repères, app.html sans.
    const HOME = (body: string) => PROD_INDEX.replace("<body></body>", `<body><div id="app"><!--shh-home-->${body}<!--/shh-home--></div></body>`);
    const APP = PROD_INDEX.replace("<body></body>", '<body><div id="app"><!--shh-home--></div></body>');
    const ok = { "index.html": HOME("<h1>Un lien</h1>"), "app.html": APP, "assets/index-a.js": "console.info(1)", "securite.html": PAGE("<h1>Sécurité</h1><p>…</p>"), "assets/page-a.js": "console.info(2)", "s.html": S(), "assets/s-a.js": "console.info(3)" };
    expect(checkDist(site(ok), false, false, ["securite.html"])).toEqual([]);
    expect(checkDist(site({ ...ok, "index.html": PROD_INDEX }), false, false, ["securite.html"])).toContain("index.html : accueil non écrit (repères <!--shh-home--> absents)");
    expect(checkDist(site({ ...ok, "index.html": HOME("<p>x</p>") }), false, false, ["securite.html"])).toContain("index.html : accueil écrit sans titre h1");
    expect(checkDist(site({ ...ok, "index.html": HOME('<h1 style="x">U</h1>') }), false, false, ["securite.html"])).toContain("index.html : attribut style dans l'accueil écrit (CSP)");
    expect(checkDist(site({ ...ok, "index.html": HOME('<h1>U</h1><a href="https://github.com/x">code</a>') }), false, false, ["securite.html"])).toEqual([]);
    const { "app.html": _a, ...noApp } = ok;
    expect(checkDist(site(noApp), false, false, ["securite.html"])).toContain("app.html : page de l'application sans accueil écrit absente");
    expect(checkDist(site({ ...ok, "app.html": HOME("<h1>U</h1>") }), false, false, ["securite.html"])).toContain("app.html : contient l'accueil écrit (il ne doit pas s'afficher sur les autres adresses)");
    // Squelette (U13) : la coque sans contenu ; ses liens sortants (pied de page) sont admis.
    const SHELL = (inner: string) => PROD_INDEX.replace("<body></body>", `<body><div id="app" data-squelette><!--shh-shell-->${inner}<!--/shh-shell--></div></body>`);
    const coque = '<header><a class="logo" href="/">S</a></header> <main id="contenu"><!----><!----></main> <footer><a href="https://github.com/x">code</a></footer>';
    expect(checkDist(site({ ...ok, "app.html": SHELL(coque) }), false, false, ["securite.html"])).toEqual([]);
    expect(checkDist(site({ ...ok, "app.html": SHELL(coque.replace("<!----><!---->", "<h1>Se connecter</h1>")) }), false, false, ["securite.html"])).toContain("app.html : squelette avec du contenu (titre ou contenu principal)");
    expect(checkDist(site({ ...ok, "app.html": SHELL(coque.replace("<!----><!---->", "<p>x</p>")) }), false, false, ["securite.html"])).toContain("app.html : squelette avec du contenu (titre ou contenu principal)");
    expect(checkDist(site({ ...ok, "app.html": SHELL(coque.replace("<header>", '<header style="x">')) }), false, false, ["securite.html"])).toContain("app.html : attribut style dans le squelette (CSP)");
    expect(checkDist(site({ ...ok, "app.html": SHELL(coque + '<img src="https://pistage.example/p.png">') }), false, false, ["securite.html"]).join("\n")).toMatch(/app\.html : adresse externe/);
    expect(checkDist(site({ ...ok, "app.html": PROD_INDEX.replace("<body></body>", '<body><div id="app"><p>x</p></div></body>') }), false, false, ["securite.html"])).toContain("app.html : contient l'accueil écrit (il ne doit pas s'afficher sur les autres adresses)");
    const { "securite.html": _p, ...noPage } = ok;
    expect(checkDist(site(noPage), false, false, ["securite.html"])).toContain("securite.html : page d'information absente");
    expect(checkDist(site({ ...ok, "securite.html": PAGE("") }), false, false, ["securite.html"]).join("\n")).toMatch(/contenu non écrit/);
    expect(checkDist(site({ ...ok, "securite.html": PAGE('<h1 style="x">S</h1>') }), false, false, ["securite.html"]).join("\n")).toMatch(/attribut style/);
    expect(checkDist(site({ ...ok, "securite.html": PAGE('<h1>S</h1><img src="/src/assets/a.png">') }), false, false, ["securite.html"]).join("\n")).toMatch(/adresse de développement/);
    expect(checkDist(site({ ...ok, "assets/page-a.js": 'const e="/assets/engine-x.wasm";' }), false, false, ["securite.html"]).join("\n")).toMatch(/cite le moteur/);
    expect(checkDist(site({ ...ok, "securite.html": PAGE('<h1>S</h1><a href="https://github.com/x">code</a>') }), false, false, ["securite.html"])).toEqual([]);
    // Versions anglaises (20 novembre) : <html lang="en">, accueil anglais écrit.
    const EN_HOME = HOME("<h1>One link</h1>").replace("<html", '<html lang="en"');
    const EN_PAGE = PAGE("<h1>Security</h1>").replace("<html", '<html lang="en"');
    const en = { ...ok, "en.html": EN_HOME, "en-securite.html": EN_PAGE };
    const P = ["securite.html", "en.html", "en-securite.html"];
    expect(checkDist(site(en), false, false, P)).toEqual([]);
    expect(checkDist(site({ ...en, "en-securite.html": PAGE("<h1>Security</h1>") }), false, false, P)).toContain('en-securite.html : version anglaise sans <html lang="en">');
    expect(checkDist(site({ ...en, "en.html": APP.replace("<html", '<html lang="en"') }), false, false, P)).toContain("en.html : accueil anglais non écrit (sans titre h1)");
    const { "en.html": _e, ...noEn } = en;
    expect(checkDist(site(noEn), false, false, P)).toContain("en.html : page d'information absente");
    const alt = '<link rel="alternate" hreflang="en" href="https://shhgone.com/en/securite" />';
    expect(checkDist(site({ ...en, "securite.html": PAGE("<h1>S</h1>").replace("</head>", alt + "</head>") }), false, false, P)).toEqual([]);
    expect(checkDist(site({ ...en, "securite.html": PAGE("<h1>S</h1>").replace("</head>", alt.replace("shhgone.com", "evil.example") + "</head>") }), false, false, P).join("\n")).toMatch(/adresse externe/);
    // Page « /s » (16 novembre) : présente, jamais indexée, sans le script de l'application d'envoi.
    const { "s.html": _s, ...noS } = ok;
    expect(checkDist(site(noS), false, false, ["securite.html"])).toContain("s.html : page d'ouverture absente");
    expect(checkDist(site({ ...ok, "s.html": S("") }), false, false, ["securite.html"])).toContain("s.html : sans « noindex »");
    expect(checkDist(site({ ...ok, "s.html": S(undefined, "index-a.js"), "assets/index-a.js": "1" }), false, false, ["securite.html"])).toContain("s.html : charge le script de l'application d'envoi");
    // Exigence C-3 1 : la page d'ouverture ne charge pas le module du salon.
    expect(checkDist(site({ ...ok, "assets/s-a.js": 'const s="/assets/salon-x.wasm";' }), false, false, ["securite.html"]).join("\n")).toMatch(/s\.html : assets\/s-a\.js charge le module du salon/);
  });

  it("A7 : police ou image hors de assets/ ou sans empreinte → refus (pas de cache long)", () => {
    const ok = site({ "index.html": PROD_INDEX, "assets/mona-sans-AbCdEf12.woff2": "w", "assets/grain-AbCdEf12.png": "p", "assets/motif-AbCdEf12.svg": "<svg/>" });
    expect(checkDist(ok, false)).toEqual([]);
    for (const bad of ["fonts/mona-sans.woff2", "assets/grain.png", "assets/motif.svg", "assets/aurora-ink.png"]) {
      const d = site({ "index.html": PROD_INDEX, [bad]: "x" });
      expect(checkDist(d, false).join("\n")).toContain(`${bad} : police ou image sans empreinte`);
    }
    // Fichiers publics d'adresse fixe (icônes, manifeste) : permis à la racine.
    expect(checkDist(site({ "index.html": PROD_INDEX, "favicon.ico": "i", "icon-192.png": "p", "logo.svg": "<svg/>" }), false)).toEqual([]);
  });

  it("D4 : fichier de langue cité avec son empreinte, jamais orphelin ; anglais absent du script principal", () => {
    const lang = '{"hero.title":"One link, one password, then it\'s gone."}';
    const ok = site({ "index.html": PROD_INDEX, "assets/index-a.js": `const s="/assets/locale-en-AbCdEf12.js",i="${sha384(Buffer.from(lang))}";`, "assets/locale-en-AbCdEf12.js": lang });
    expect(checkDist(ok, false)).toEqual([]);
    const orphan = site({ "index.html": PROD_INDEX, "assets/locale-en-AbCdEf12.js": lang });
    expect(checkDist(orphan, false).join("\n")).toContain("assets/locale-en-AbCdEf12.js : orphelin");
    const noSri = site({ "index.html": PROD_INDEX, "assets/index-a.js": 'const s="/assets/locale-en-AbCdEf12.js";', "assets/locale-en-AbCdEf12.js": lang });
    expect(checkDist(noSri, false).join("\n")).toContain("assets/locale-en-AbCdEf12.js : son empreinte SHA-384");
    const both = site({ "index.html": PROD_INDEX, "assets/index-a.js": `const s="/assets/locale-en-AbCdEf12.js",i="${sha384(Buffer.from(lang))}",t="One link, one password, then it's gone.";`, "assets/locale-en-AbCdEf12.js": lang });
    expect(checkDist(both, false).join("\n")).toContain("dictionnaire anglais dans le script principal");
  });

  it("U13 : domaines jetables dans leur fichier, cité avec son empreinte, jamais orphelin ni dans un script ; exigé avec --comptes", () => {
    const liste = '["0-mail.com","guerrillamail.com"]';
    const ok = site({ "index.html": PROD_INDEX, "assets/index-a.js": `const s="/assets/jetables-AbCdEf12.js",i="${sha384(Buffer.from(liste))}";`, "assets/jetables-AbCdEf12.js": liste });
    expect(checkDist(ok, false)).toEqual([]);
    expect(checkDist(site({ "index.html": PROD_INDEX, "assets/jetables-AbCdEf12.js": liste }), false).join("\n")).toContain("assets/jetables-AbCdEf12.js : orphelin");
    const noSri = site({ "index.html": PROD_INDEX, "assets/index-a.js": 'const s="/assets/jetables-AbCdEf12.js";', "assets/jetables-AbCdEf12.js": liste });
    expect(checkDist(noSri, false).join("\n")).toContain("assets/jetables-AbCdEf12.js : son empreinte SHA-384");
    const enLigne = site({ "index.html": PROD_INDEX, "assets/index-a.js": 'const l="0-mail.com\\nguerrillamail.com\\n";' });
    expect(checkDist(enLigne, false).join("\n")).toContain("assets/index-a.js : liste des domaines jetables dans un script");
    const sansListe = site({ "index.html": PROD_INDEX, "assets/index-a.js": 'fetch(o+"/api/compte/connexion")' });
    expect(checkDist(sansListe, false, true).join("\n")).toContain("assets/jetables-*.js absent alors que --comptes est demandé");
  });

  it("passe sans marque", () => {
    const d = site({ "index.html": PROD_INDEX, "assets/index-a.js": "console.info(1)" });
    expect(run([d])).toEqual({ code: 0, err: "" });
  });

  it("compte (plan du compte, lot 9) : sans --comptes, aucune trace du module de compte (/api/compte, shhdrop-compte) ; avec --comptes, admise", () => {
    for (const trace of ['fetch(o+"/api/compte/connexion")', 'indexedDB.open("shhdrop-compte")']) {
      const d = site({ "index.html": PROD_INDEX, "assets/index-a.js": trace });
      const r = run([d]);
      expect(r.code, trace).toBe(1);
      expect(r.err, trace).toMatch(/assets\/index-a\.js : module de compte « (\/api\/compte|shhdrop-compte) » dans un build sans __COMPTES__/);
      if (trace.includes("/api/compte")) {
        const liste = '["0-mail.com"]';
        const avec = site({ "index.html": PROD_INDEX, "assets/index-a.js": `${trace};const j="/assets/jetables-AbCdEf12.js",i="${sha384(Buffer.from(liste))}";`, "assets/jetables-AbCdEf12.js": liste });
        expect(run(["--comptes", avec]), trace).toEqual({ code: 0, err: "" });
      }
    }
    // --comptes sans module de compte : refusé (build fait sans SHH_SITE_COMPTES=1).
    const vide = site({ "index.html": PROD_INDEX, "assets/index-a.js": "console.info(1)" });
    expect(run(["--comptes", vide]).err).toContain("module de compte absent alors que --comptes est demandé");
  });

  it("échoue si un fichier contient __SHH_DEMO__", () => {
    const d = site({ "index.html": PROD_INDEX, "assets/index-a.js": 'const MARK="__SHH_DEMO__"' });
    const r = run([d]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("assets/index-a.js : trace de démo « __SHH_DEMO__ »");
  });

  it("échoue sur la CSP meta, le texte du bandeau, la base de démo, 404.html", () => {
    expect(checkDist(site({ "index.html": DEMO_INDEX }), false).join("\n")).toMatch(/Content-Security-Policy[\s\S]*shhgone\/assets\//);
    expect(checkDist(site({ "index.html": PROD_INDEX, "a.js": "Demo: nothing is sent, the link only works in this tab." }), false)).toHaveLength(1);
    expect(checkDist(site({ "index.html": PROD_INDEX, "a.js": "rien n'est envoyé, le lien ne marche que dans cet onglet" }), false)).toHaveLength(1);
    expect(checkDist(site({ "index.html": PROD_INDEX, "404.html": PROD_INDEX }), false)).toEqual(["404.html : propre à la démo"]);
  });

  it("échoue sur un import() dynamique dans un script (spec §28.3, audit F1) ; import.meta reste permis", () => {
    const d = site({
      "index.html": PROD_INDEX,
      "assets/index-a.js": "const u=import.meta.url;a(()=>import(`./QrCode-x.js`));b(()=>import ('./y.js'))",
      "assets/w.css": "a{content:'import('}",
    });
    const r = run([d]);
    expect(r.code).toBe(1);
    expect(r.err.trim().split("\n")).toEqual(["check-dist : assets/index-a.js : import() dynamique (2 fois), interdit en production"]);
    expect(run([site({ "index.html": PROD_INDEX, "assets/index-a.js": "const u=import.meta.url;x.reimport(1)" })])).toEqual({ code: 0, err: "" });
  });

  it("aucune ressource tierce : échoue sur une adresse http(s):// ou //hôte dans index.html, pdf-frame.html ou le CSS, production et démo ; espaces de noms SVG admis", () => {
    const svg = "a{background:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E\")}";
    const svgEnc = "a{background:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27%3E%3C/svg%3E\")}";
    expect(checkDist(site({ "index.html": PROD_INDEX, "assets/a.css": svg + svgEnc }), false)).toEqual([]);
    const font = "@font-face{src:url(https://fonts.gstatic.com/x.woff2)}";
    const page = PROD_INDEX.replace("</head>", '<link rel="icon" href="//cdn.example/i.png"></head>');
    const frame = '<!doctype html><script src="http://cdn.example/pdf.js"></script>';
    expect(checkDist(site({ "index.html": page, "assets/a.css": font, "pdf-frame.html": frame, "pdf-frame.css": "@import '//x.example/a.css';" }), false)).toEqual([
      "assets/a.css : adresse externe « https://fonts.gstatic.com/x.woff2 » (aucune ressource tierce)",
      "index.html : adresse externe « //cdn.example/i.png » (aucune ressource tierce)",
      "pdf-frame.css : adresse externe « //x.example/a.css » (aucune ressource tierce)",
      "pdf-frame.html : adresse externe « http://cdn.example/pdf.js » (aucune ressource tierce)",
    ]);
    const demo = { "index.html": DEMO_INDEX, "404.html": DEMO_INDEX, "assets/index-a.js": 'const MARK="__SHH_DEMO__";' + DEMO_ENGINE, "assets/a.css": font };
    expect(checkDist(site(demo), true)).toEqual(["assets/a.css : adresse externe « https://fonts.gstatic.com/x.woff2 » (aucune ressource tierce)"]);
    // Hors des pages et du CSS (scripts : pdf.js, messages) : non concerné par cette règle.
    expect(checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": 'const u="https://example.org/doc"' }), false)).toEqual([]);
    // Encodé, majuscules, &quot; : l'hôte reste visible.
    expect(findExternalUrls("HTTPS://Evil.example/a")).toEqual(["HTTPS://Evil.example/a"]);
    expect(findExternalUrls("url(&quot;https://evil.example/a&quot;)")).toEqual(["https://evil.example/a"]);
    expect(findExternalUrls("xmlns=%27http://www.w3.org/2000/svg%27 x=%27https://evil.example/b%27")).toEqual(["https://evil.example/b"]);
    expect(findExternalUrls('<a href="/x">//commentaire</a> a{b:c} /* // */')).toEqual([]);
  });

  it("échoue sur une statistique ou un écouteur global d'erreurs (spec §35.1), démo comprise ; « scrollbar » passe", () => {
    const trap = { "assets/index-a.js": 'const s="x GTAG( y";navigator.sendBeacon(u);window.onerror = f', "assets/a.css": "::-webkit-scrollbar{}" };
    expect(checkDist(site({ "index.html": PROD_INDEX, ...trap }), false)).toEqual([
      "assets/index-a.js : statistique « gtag( » (spec §35.1)",
      "assets/index-a.js : statistique « sendbeacon » (spec §35.1)",
      "assets/index-a.js : écouteur global d'erreurs « window.onerror = » (spec §35.1)",
    ]);
    const demo = { "index.html": DEMO_INDEX, "404.html": DEMO_INDEX, "assets/install-a.js": 'const MARK="__SHH_DEMO__";gtag(1)' + DEMO_ENGINE };
    expect(checkDist(site(demo), true)).toEqual(["assets/install-a.js : statistique « gtag( » (spec §35.1)"]);
  });

  it("SRI (spec §28.3) : échoue si un script ou une feuille de style n'a pas d'empreinte, ou une fausse ; passe avec la bonne", () => {
    const js = "console.info(1)";
    const page = (attrs: string) => `<!doctype html><html><head>\n<script type="module" crossorigin src="/assets/index-a.js"${attrs}></script>\n<link rel="stylesheet" crossorigin href="/assets/a.css">\n</head><body></body></html>`;
    const files = { "assets/index-a.js": js, "assets/a.css": "a{}" };
    const none = run([site({ "index.html": page(""), ...files }, false)]);
    expect(none.code).toBe(1);
    expect(none.err.trim().split("\n")).toEqual([
      "check-dist : index.html : /assets/index-a.js sans attribut integrity (spec §28.3)",
      "check-dist : index.html : /assets/a.css sans attribut integrity (spec §28.3)",
    ]);
    const wrong = run([site({ "index.html": page(` integrity="${sha384(Buffer.from("autre"))}"`), ...files }, false)]);
    expect(wrong.err).toContain("index.html : /assets/index-a.js : empreinte integrity différente du fichier");
    const good = addSri(page(""), (rel: string) => Buffer.from((files as Record<string, string>)[rel]!));
    expect(good).toContain(`src="/assets/index-a.js" integrity="${sha384(Buffer.from(js))}"`);
    expect(run([site({ "index.html": good, ...files }, false)])).toEqual({ code: 0, err: "" });
    // Fichier absent du site, script en ligne : refusés.
    expect(run([site({ "index.html": good }, false)]).err).toContain("index.html : /assets/index-a.js absent du site");
    expect(run([site({ "index.html": `<!doctype html><html><head><script>1</script></head></html>` }, false)]).err).toContain("index.html : script en ligne");
  });

  it("Argon2id hors du script principal (10 novembre ; moteur WebAssembly depuis la Task 11, libsodium supprimé) : le moteur absent de index-*.js ; ses fichiers portent l'empreinte inscrite dans le script ; aucun orphelin", () => {
    const wasm = String.fromCharCode(0, 97, 115, 109, 1, 0, 0, 0);
    const kdf = "self.onmessage=1";
    const files = { "assets/engine-AbCd1234.wasm": wasm, "assets/engine-kdf-EfGh5678.js": kdf };
    const main = (extra: string) => `const a="/assets/engine-AbCd1234.wasm",b="/assets/engine-kdf-EfGh5678.js";${extra}`;
    const hashes = `const i="${sha384(Buffer.from(wasm, "latin1"))}",j="${sha384(Buffer.from(kdf))}";`;
    // Octets du moteur dans le script principal (comme libsodium autrefois) : refusés.
    expect(checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": `const w="${Buffer.from(wasm + "\x01", "latin1").toString("base64")}"` }), false)).toEqual([
      "assets/index-a.js : octets WebAssembly en ligne dans le script principal : le moteur doit rester dans assets/engine-*.wasm, lu avec son empreinte",
    ]);
    expect(checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": main("") }), false)).toEqual([
      "assets/engine-AbCd1234.wasm : cité par le script principal, absent du site",
      "assets/engine-kdf-EfGh5678.js : cité par le script principal, absent du site",
    ]);
    expect(checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": main(""), ...files }), false)).toEqual([
      "assets/engine-AbCd1234.wasm : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
      "assets/engine-kdf-EfGh5678.js : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
    ]);
    expect(checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": main(hashes), ...files }), false)).toEqual([]);
    // Fichiers du moteur que le script principal ne cite pas : orphelins.
    expect(checkDist(site({ "index.html": PROD_INDEX, ...files }), false)).toEqual([
      "assets/engine-AbCd1234.wasm : orphelin, aucun script principal ne le cite avec son empreinte SHA-384",
      "assets/engine-kdf-EfGh5678.js : orphelin, aucun script principal ne le cite avec son empreinte SHA-384",
    ]);
  });

  it("moteur WebAssembly (spec moteur §7) : tout .wasm cité par le script principal existe et porte son empreinte, comme le script du Worker", () => {
    // Octets d'un module WebAssembly vide (magie « \0asm », version 1), écrits sans échappement.
    const wasm = String.fromCharCode(0, 97, 115, 109, 1, 0, 0, 0);
    const prod = (main: string, extra: Record<string, string> = {}) => checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": main, ...extra }), false);
    const cite = 'const s="/assets/engine-AbCd1234.wasm";';
    expect(prod(cite)).toEqual(["assets/engine-AbCd1234.wasm : cité par le script principal, absent du site"]);
    expect(prod(cite, { "assets/engine-AbCd1234.wasm": wasm })).toEqual([
      "assets/engine-AbCd1234.wasm : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
    ]);
    expect(prod(cite + `const i="${sha384(Buffer.from(wasm, "latin1"))}";`, { "assets/engine-AbCd1234.wasm": wasm })).toEqual([]);
    // Cité deux fois : un seul signalement.
    expect(prod(cite + cite, { "assets/engine-AbCd1234.wasm": wasm })).toHaveLength(1);
    // N'importe quel .wasm (un fichier émis par Vite sans notre greffon, par exemple).
    expect(prod('const s="/assets/shhdrop_wasm_bg-Zz9.wasm";', { "assets/shhdrop_wasm_bg-Zz9.wasm": wasm })).toEqual([
      "assets/shhdrop_wasm_bg-Zz9.wasm : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
    ]);
    // Script du Worker d'Argon2id du moteur : même règle.
    const w = "self.onmessage=1";
    expect(prod('const w="/assets/engine-kdf-AbCd1234.js";', { "assets/engine-kdf-AbCd1234.js": w })).toEqual([
      "assets/engine-kdf-AbCd1234.js : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
    ]);
    expect(prod(`const w="/assets/engine-kdf-AbCd1234.js";const i="${sha384(Buffer.from(w))}";`, { "assets/engine-kdf-AbCd1234.js": w })).toEqual([]);
  });

  it("W3 (audit du 20 novembre) : le Worker anti-robot, comme tout script de Worker, est cité avec son empreinte SHA-384, jamais orphelin", () => {
    const prod = (main: string, extra: Record<string, string> = {}) => checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": main, ...extra }), false);
    const w = "self.onmessage=1";
    const hash = sha384(Buffer.from(w));
    // Script émis par le greffon shh-pow (assets/pow-worker-*.js).
    expect(prod('const w="/assets/pow-worker-AbCd1234.js";', { "assets/pow-worker-AbCd1234.js": w })).toEqual([
      "assets/pow-worker-AbCd1234.js : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
    ]);
    expect(prod(`const w="/assets/pow-worker-AbCd1234.js",i="${hash}";`, { "assets/pow-worker-AbCd1234.js": w })).toEqual([]);
    // Ancien chemin (new Worker sur le fichier émis par Vite, ?worker&url) : cité sans empreinte, refusé.
    expect(prod('new Worker("/assets/pow.worker-CqXgVHIX.js",{type:"module"});', { "assets/pow.worker-CqXgVHIX.js": w })).toEqual([
      "assets/pow.worker-CqXgVHIX.js : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
    ]);
    expect(prod('const w="/assets/pow-worker-AbCd1234.js";')).toEqual(["assets/pow-worker-AbCd1234.js : cité par le script principal, absent du site"]);
    // Présent mais cité par aucun script : orphelin.
    expect(prod("console.info(1)", { "assets/pow.worker-CqXgVHIX.js": w })).toEqual([
      "assets/pow.worker-CqXgVHIX.js : orphelin, aucun script principal ne le cite avec son empreinte SHA-384",
    ]);
  });

  it("moteur WebAssembly : en production, tout .wasm de plus de 1 Kio a ses variantes .br et .gz (servies par static.go), qui redonnent le fichier", () => {
    const wasm = String.fromCharCode(0, 97, 115, 109, 1, 0, 0, 0) + "\x01".repeat(2000);
    const w = "assets/engine-AbCd1234.wasm";
    // Le script principal cite les .wasm avec leur empreinte (sinon : orphelins, règle de la Task 11).
    const small = "\0asm";
    const main = `const a="/${w}",i="${sha384(Buffer.from(wasm, "latin1"))}";`;
    const prod = (extra: Record<string, string | Buffer>) => checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": main, [w]: wasm, ...(extra as Record<string, string>) }), false);
    const br = brotliCompressSync(Buffer.from(wasm));
    const gz = gzipSync(Buffer.from(wasm));
    expect(prod({})).toEqual([`${w} : sans variante .br ni .gz : le moteur serait téléchargé sans compression`]);
    expect(prod({ [w + ".br"]: br })).toEqual([`${w} : sans variante .gz : le moteur serait téléchargé sans compression`]);
    expect(prod({ [w + ".br"]: br, [w + ".gz"]: gz })).toEqual([]);
    expect(prod({ [w + ".br"]: br, [w + ".gz"]: gzipSync(Buffer.from("autre")) })).toEqual([`${w}.gz : ne redonne pas ${w}`]);
    // Petit .wasm (moins de 1 Kio, comme pour le texte : precompress ne le compresse pas) : rien exigé.
    const both = main + `const b="/assets/petit-AbCd1234.wasm",j="${sha384(Buffer.from(small))}";`;
    expect(prod({ "assets/index-a.js": both, "assets/petit-AbCd1234.wasm": small }).filter((p) => p.includes("petit"))).toEqual([]);
  });

  it("module du salon (Task 9) : assets/salon-*.wasm d'au plus 430 Ko en brotli ; cité avec son empreinte comme le moteur", () => {
    // Octets peu compressibles (xorshift32) : la variante brotli garde presque toute leur taille.
    const bruit = (n: number) => {
      const b = Buffer.alloc(n);
      let x = 1;
      for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        b[i] = x & 0xff;
      }
      return Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), b]);
    };
    const prod = (wasm: Buffer) => {
      const w = "assets/salon-AbCd1234.wasm";
      const main = `const a="/${w}",i="${sha384(wasm)}";`;
      const d = site({ "index.html": PROD_INDEX, "assets/index-a.js": main });
      writeFileSync(join(d, w), wasm);
      writeFileSync(join(d, w + ".br"), brotliCompressSync(wasm));
      writeFileSync(join(d, w + ".gz"), gzipSync(wasm));
      return checkDist(d, false);
    };
    expect(prod(bruit(420_000))).toEqual([]);
    const gros = prod(bruit(440_000));
    expect(gros).toHaveLength(1);
    expect(gros[0]).toMatch(/^assets\/salon-AbCd1234\.wasm : \d+ octets en brotli, plus que 435 000 \(module du salon\)$/);
    // Cité sans son empreinte : refusé comme tout .wasm.
    const d = site({ "index.html": PROD_INDEX, "assets/index-a.js": 'const a="/assets/salon-AbCd1234.wasm";' });
    writeFileSync(join(d, "assets/salon-AbCd1234.wasm"), "\0asm");
    expect(checkDist(d, false)).toEqual([
      "assets/salon-AbCd1234.wasm : son empreinte SHA-384 n'est pas inscrite dans le script principal (chargement sans contrôle d'intégrité)",
    ]);
  });

  it("moteur des partages : assets/engine-*.wasm d'au plus 156 Ko en brotli (chargé par toutes les pages de partage)", () => {
    const bruit = (n: number) => {
      const b = Buffer.alloc(n);
      let x = 7;
      for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        b[i] = x & 0xff;
      }
      return Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), b]);
    };
    const prod = (wasm: Buffer) => {
      const w = "assets/engine-AbCd1234.wasm";
      const d = site({ "index.html": PROD_INDEX, "assets/index-a.js": `const a="/${w}",i="${sha384(wasm)}";` });
      writeFileSync(join(d, w), wasm);
      writeFileSync(join(d, w + ".br"), brotliCompressSync(wasm));
      writeFileSync(join(d, w + ".gz"), gzipSync(wasm));
      return checkDist(d, false);
    };
    expect(prod(bruit(150_000))).toEqual([]);
    const gros = prod(bruit(192_000));
    expect(gros).toHaveLength(1);
    expect(gros[0]).toMatch(/^assets\/engine-AbCd1234\.wasm : \d+ octets en brotli, plus que 156 000 \(moteur des partages\)$/);
  });

  it("moteur WebAssembly : aucun octet de .wasm en ligne dans le script principal de production (base64 ou tableau)", () => {
    const msg = "assets/index-a.js : octets WebAssembly en ligne dans le script principal : le moteur doit rester dans assets/engine-*.wasm, lu avec son empreinte";
    const b64 = Buffer.from(String.fromCharCode(0, 97, 115, 109, 1, 0, 0, 0, 1, 2, 3), "latin1").toString("base64");
    expect(b64.startsWith("AGFzbQEAAAA")).toBe(true);
    const prod = (main: string) => checkDist(site({ "index.html": PROD_INDEX, "assets/index-a.js": main }), false);
    expect(prod(`const w="${b64}"`)).toEqual([msg]);
    expect(prod(`const w="data:application/wasm;base64,${b64}"`)).toEqual([msg]);
    expect(prod("const w=new Uint8Array([0,97,115,109,1,0,0,0,1])")).toEqual([msg]);
    expect(prod("const w=new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])")).toEqual([msg]);
    // Un texte ordinaire qui contient « asm » passe.
    expect(prod('const s="wasm-unsafe-eval asm.js"')).toEqual([]);
  });

  it("échoue si le build manque", () => {
    expect(run([join(tmpdir(), "absent-check-dist")]).code).toBe(1);
  });
});

describe("check-dist.mjs --demo", () => {
  const good = () => ({ "index.html": DEMO_INDEX, "404.html": DEMO_INDEX, "assets/install-a.js": 'const MARK="__SHH_DEMO__";' + DEMO_ENGINE });

  it("passe avec la marque, les balises en tête de <head> et 404.html", () => {
    expect(run(["--demo", site(good())])).toEqual({ code: 0, err: "" });
  });

  it("W3 : aucun script de Worker dans la démo (sa CSP interdit de le lire avec son empreinte)", () => {
    expect(checkDist(site({ ...good(), "assets/pow.worker-CqXgVHIX.js": "self.onmessage=1" }), true)).toEqual([
      "assets/pow.worker-CqXgVHIX.js : script de Worker dans la démo (lancé sans contrôle d'intégrité)",
    ]);
  });

  it("compte : admis dans la démo (compte essayable, faux serveur de l'onglet, 19 novembre)", () => {
    const r = run(["--demo", site({ ...good(), "assets/install-a.js": good()["assets/install-a.js"] + 'x="/api/compte"' })]);
    expect(r.code).toBe(0);
  });

  it("échoue sans la marque", () => {
    const r = run(["--demo", site({ ...good(), "assets/install-a.js": "x" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("marque __SHH_DEMO__ absente");
  });

  it("échoue sans la CSP meta, avec une CSP différente ou si elle n'est pas en tête", () => {
    const noCsp = DEMO_INDEX.replace(/<meta http-equiv[^>]*>\s*/, "");
    expect(checkDist(site({ ...good(), "index.html": noCsp, "404.html": noCsp }), true)).toHaveLength(1);
    const weak = DEMO_INDEX.replace("object-src &#39;none&#39;", "object-src *");
    expect(checkDist(site({ ...good(), "index.html": weak, "404.html": weak }), true)).toHaveLength(1);
    const late = DEMO_INDEX.replace('<meta charset="utf-8" />', "").replace("<head>", '<head><meta charset="utf-8" />');
    expect(checkDist(site({ ...good(), "index.html": late, "404.html": late }), true)).toHaveLength(1);
  });

  it("échoue sans referrer ou robots", () => {
    for (const drop of [/<meta name="referrer"[^>]*>/, /<meta name="robots"[^>]*>/]) {
      const h = DEMO_INDEX.replace(drop, "");
      expect(checkDist(site({ ...good(), "index.html": h, "404.html": h }), true)).toHaveLength(1);
    }
  });

  it("échoue sans 404.html, ou s'il diffère de app.html (index.html sans accueil écrit)", () => {
    const { "404.html": _, ...no404 } = good();
    expect(checkDist(site(no404), true)).toEqual(["404.html absent (adresses profondes sur Pages)"]);
    expect(checkDist(site({ ...good(), "404.html": "autre" }), true)).toEqual(["404.html différent de app.html"]);
  });

  it("moteur WebAssembly intégré au script (connect-src 'none') : aucun fichier .wasm dans la démo", () => {
    expect(checkDist(site({ ...good(), "assets/engine-AbCd1234.wasm": "x" }), true)).toEqual([
      "assets/engine-AbCd1234.wasm : fichier .wasm dans la démo : sa CSP (connect-src 'none') interdit de le lire, le moteur doit être intégré au script",
    ]);
  });

  it("moteur WebAssembly présent dans un script de la démo (Task 11) : sinon elle ne pourrait ni chiffrer ni ouvrir", () => {
    expect(checkDist(site({ ...good(), "assets/install-a.js": 'const MARK="__SHH_DEMO__"' }), true)).toEqual([
      "moteur WebAssembly absent des scripts de la démo (base64 « AGFzbQEAAAA ») : elle ne pourrait ni chiffrer ni ouvrir",
    ]);
  });

  it("échoue si une ressource est hors de la base /shhgone/", () => {
    const h = DEMO_INDEX.replace("/shhgone/assets/", "/assets/");
    expect(checkDist(site({ ...good(), "index.html": h, "404.html": h }), true)).toEqual([
      "index.html : « /assets/index-a.js » hors de la base /shhgone/",
    ]);
  });
});

it("sonde EN_PROBE présente dans en.ts (sinon le contrôle du dictionnaire anglais ne voit plus rien)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./check-dist.mjs", import.meta.url), "utf8");
  const probe = /const EN_PROBE = "([^"]+)";/.exec(src)?.[1];
  expect(probe).toBeTruthy();
  expect(readFileSync(new URL("../src/i18n/en.ts", import.meta.url), "utf8")).toContain(JSON.stringify(probe).slice(1, -1));
});

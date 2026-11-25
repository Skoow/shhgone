import { svelte } from "@sveltejs/vite-plugin-svelte";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, defineConfig, type Plugin } from "vite";
import { DEMO_BASE, DEMO_META } from "./scripts/demo-meta.mjs";
import { addSri, sha384 } from "./scripts/sri.mjs";

/**
 * Production : le build échoue si un module de src/demo/ entre dans le bundle (A41 : un faux
 * serveur qui remplace fetch serait une porte dérobée). Seconde garde : scripts/check-dist.mjs.
 */
export function demoGuard(): Plugin {
  return {
    name: "shh-demo-guard",
    apply: "build",
    generateBundle(_, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type !== "chunk") continue;
        const bad = Object.keys(out.modules).filter((id) => id.replace(/\\/g, "/").includes("/src/demo/"));
        if (bad.length > 0) this.error(`code de démo dans le build de production : ${bad.join(", ")}`);
      }
    },
  };
}

/**
 * Intégrité des sous-ressources (spec §28.3) : une empreinte SHA-384 sur chaque script et
 * feuille de style de index.html, calculée sur les fichiers écrits. Le navigateur refuse
 * alors tout script ou style dont les octets ne correspondent pas ; l'empreinte de
 * index.html fixe tout ce qu'il charge. Contrôle : scripts/check-dist.mjs. À placer avant
 * demoMeta (qui copie index.html en 404.html) ; precompress passe après (closeBundle).
 */
export function sri(base: string): Plugin {
  let outDir = "";
  return {
    name: "shh-sri",
    apply: "build",
    configResolved(c) {
      outDir = join(c.root, c.build.outDir);
    },
    // Toutes les pages de la racine (index.html et les pages séparées, écrites juste avant).
    writeBundle: {
      sequential: true,
      handler() {
        const read = (rel: string) => {
          try {
            return readFileSync(join(outDir, rel));
          } catch {
            return null;
          }
        };
        for (const f of readdirSync(outDir)) {
          if (!f.endsWith(".html") || f === "pdf-frame.html") continue;
          const page = join(outDir, f);
          writeFileSync(page, addSri(readFileSync(page, "utf8"), read, base));
        }
      },
    },
  };
}

/**
 * Colle de wasm-bindgen : sans argument, son initialisation lirait le .wasm voisin
 * (`new URL('shhdrop_wasm_bg.wasm', import.meta.url)`), que Vite émettrait ou intégrerait sans
 * empreinte. Nos appels donnent toujours le module compilé : ce chemin est remplacé par une
 * erreur. Le build échoue si la colle change de forme (contrôle : scripts/check-dist.mjs).
 */
export function engineGlue(): Plugin {
  const DEFAULT = "new URL('shhdrop_wasm_bg.wasm', import.meta.url)";
  return {
    name: "shh-engine-glue",
    enforce: "pre",
    transform(code, id) {
      if (!id.replace(/\\/g, "/").endsWith("/src/engine/pkg/shhdrop_wasm.js")) return null;
      if (code.split(DEFAULT).length !== 2) this.error("shh-engine : colle de wasm-bindgen inattendue (chemin par défaut du .wasm)");
      return { code: code.replace(DEFAULT, '(() => { throw new Error("moteur_sans_source"); })()'), map: null };
    },
  };
}

/**
 * Moteur WebAssembly (spec moteur §7). ./source, importé par un module de src/engine/, est
 * remplacé par source.verified.ts (production) ou source.demo.ts (démo) ; tout autre chemin
 * vers src/engine/source.ts arrête le build (le .wasm y serait lu sans empreinte).
 * Production : le .wasm est écrit sous assets/engine-EMPREINTE.wasm, le script du Worker
 * d'Argon2id (argon2.worker.ts et la colle, construit à part en script classique) sous
 * assets/engine-kdf-EMPREINTE.js ; adresses et empreintes SHA-384 dans le module virtuel
 * virtual:shh-engine, donc dans le script principal, jamais les octets du .wasm.
 * Démo : sa CSP (connect-src 'none') interdit de lire un fichier : le module virtuel contient
 * le .wasm en base64, couvert par l'empreinte de index.html ; aucun fichier émis.
 */
export function engineWasm(base: string, demo: boolean): Plugin {
  const VIRTUAL = "virtual:shh-engine";
  const here = fileURLToPath(new URL(".", import.meta.url));
  const name = (prefix: string, data: Buffer, ext: string) => `assets/${prefix}-${createHash("sha256").update(data).digest("base64url").slice(0, 8)}.${ext}`;
  let code = "";
  return {
    ...engineGlue(),
    name: "shh-engine",
    apply: "build",
    enforce: "pre", // avant la résolution de Vite, pour remplacer ./source
    async buildStart() {
      const wasm = readFileSync(join(here, "src/engine/pkg/shhdrop_wasm_bg.wasm"));
      if (demo) {
        code = `export const wasm = ${JSON.stringify(wasm.toString("base64"))};`;
        return;
      }
      const out = await build({
        configFile: false,
        root: here,
        logLevel: "warn",
        plugins: [engineGlue()],
        build: { write: false, sourcemap: false, lib: { entry: join(here, "src/engine/argon2.worker.ts"), name: "shhEngineKdf", formats: ["iife"], fileName: () => "kdf.js" } },
      });
      const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : []));
      const chunk = outputs.find((c) => c.type === "chunk");
      if (!chunk || chunk.type !== "chunk" || outputs.length !== 1) throw new Error("shh-engine : build du Worker inattendu");
      const worker = Buffer.from(chunk.code);
      const wasmName = name("engine", wasm, "wasm");
      const workerName = name("engine-kdf", worker, "js");
      this.emitFile({ type: "asset", fileName: wasmName, source: wasm });
      this.emitFile({ type: "asset", fileName: workerName, source: worker });
      const meta = { src: base + wasmName, integrity: sha384(wasm), workerSrc: base + workerName, workerIntegrity: sha384(worker) };
      code = Object.entries(meta)
        .map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`)
        .join(" ");
    },
    resolveId(source, importer) {
      if (source === VIRTUAL) return "\0" + VIRTUAL;
      const from = importer?.replace(/\\/g, "/") ?? "";
      if (/^\.\/source(?:\.ts)?$/.test(source) && from.includes("/src/engine/")) return join(here, demo ? "src/engine/source.demo.ts" : "src/engine/source.verified.ts");
      return null;
    },
    load(id) {
      if (id.replace(/\\/g, "/").endsWith("/src/engine/source.ts")) this.error(`shh-engine : src/engine/source.ts (lecture sans empreinte) n'entre jamais dans un build`);
      return id === "\0" + VIRTUAL ? code : null;
    },
  };
}

/**
 * Worker de la preuve de travail anti-robot (spec §28.3) : new Worker(url)
 * n'a pas de contrôle d'intégrité. ./pow-source, importé par un module de src/captcha/, est
 * remplacé par pow-source.verified.ts (production) ou pow-source.demo.ts (démo : preuve factice,
 * aucun Worker) ; tout autre chemin vers src/captcha/pow-source.ts arrête le build (son Worker
 * serait lancé sans empreinte). Production : au premier import de virtual:shh-pow, pow.worker.ts
 * est construit à part en script classique et écrit sous assets/pow-worker-EMPREINTE.js ; son
 * adresse et son empreinte SHA-384 vont dans le script (lu par fetch avec `integrity`, puis Worker
 * depuis un Blob). Contrôle : scripts/check-dist.mjs (cité avec son empreinte, jamais orphelin).
 */
export function powWorker(base: string, demo: boolean): Plugin {
  const VIRTUAL = "virtual:shh-pow";
  const here = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "shh-pow",
    apply: "build",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === VIRTUAL) return "\0" + VIRTUAL;
      const from = importer?.replace(/\\/g, "/") ?? "";
      if (/^\.\/pow-source(?:\.ts)?$/.test(source) && from.includes("/src/captcha/")) return join(here, demo ? "src/captcha/pow-source.demo.ts" : "src/captcha/pow-source.verified.ts");
      return null;
    },
    async load(id) {
      if (id.replace(/\\/g, "/").endsWith("/src/captcha/pow-source.ts")) this.error("shh-pow : src/captcha/pow-source.ts (Worker sans empreinte) n'entre jamais dans un build");
      if (id !== "\0" + VIRTUAL) return null;
      if (demo) this.error("shh-pow : pas de Worker de preuve de travail dans la démo");
      const out = await build({
        configFile: false,
        root: here,
        logLevel: "warn",
        build: { write: false, sourcemap: false, lib: { entry: join(here, "src/captcha/pow.worker.ts"), name: "shhPow", formats: ["iife"], fileName: () => "pow.js" } },
      });
      const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : []));
      const chunk = outputs.find((c) => c.type === "chunk");
      if (!chunk || chunk.type !== "chunk" || outputs.length !== 1) this.error("shh-pow : build du Worker inattendu");
      const worker = Buffer.from(chunk.code);
      const fileName = `assets/pow-worker-${createHash("sha256").update(worker).digest("base64url").slice(0, 8)}.js`;
      this.emitFile({ type: "asset", fileName, source: worker });
      return `export const src = ${JSON.stringify(base + fileName)}; export const integrity = ${JSON.stringify(sha384(worker))};`;
    },
  };
}

/**
 * Module WebAssembly du salon (engine/salon-wasm, du salon), à part du moteur des partages.
 * ./source, importé par un module de src/salon/, est remplacé par source.verified.ts (production)
 * ou source.demo.ts (démo : seulement les règles du pseudo, pour le compte essayable) ; tout autre chemin vers src/salon/source.ts arrête le
 * build. Production : au premier import du module virtuel virtual:shh-salon (donc seulement si
 * une page importe src/salon/engine.ts), .wasm est écrit sous assets/salon-EMPREINTE.wasm ;
 * son adresse et son empreinte SHA-384 vont dans le script, jamais ses octets (lu par fetch avec
 * `integrity` au premier besoin du salon). La colle de wasm-bindgen ne lit jamais .wasm voisin
 * (chemin par défaut remplacé par une erreur, comme pour le moteur). Contrôle : check-dist.mjs
 * (cité avec son empreinte, absent du script principal, au plus 430 000 octets en brotli).
 */
export function salonWasm(base: string, demo: boolean): Plugin {
  const VIRTUAL = "virtual:shh-salon";
  const DEFAULT = "new URL('shhdrop_salon_wasm_bg.wasm', import.meta.url)";
  const here = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "shh-salon",
    apply: "build",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === VIRTUAL) return "\0" + VIRTUAL;
      const from = importer?.replace(/\\/g, "/") ?? "";
      if (/^\.\/source(?:\.ts)?$/.test(source) && from.includes("/src/salon/")) return join(here, demo ? "src/salon/source.demo.ts" : "src/salon/source.verified.ts");
      return null;
    },
    load(id) {
      if (id.replace(/\\/g, "/").endsWith("/src/salon/source.ts")) this.error("shh-salon : src/salon/source.ts (lecture sans empreinte) n'entre jamais dans un build");
      if (id !== "\0" + VIRTUAL) return null;
      const wasm = readFileSync(join(here, "src/salon/pkg/shhdrop_salon_wasm_bg.wasm"));
      // Démo (compte essayable) : sa CSP (connect-src 'none') interdit de lire un
      // .wasm ; le module est donc en base64, dans un morceau que source.demo.ts charge à part,
      // au premier besoin (le pseudo de l'inscription), jamais avec les pages de partage.
      if (demo) return `export const wasm = ${JSON.stringify(wasm.toString("base64"))};`;
      const fileName = `assets/salon-${createHash("sha256").update(wasm).digest("base64url").slice(0, 8)}.wasm`;
      this.emitFile({ type: "asset", fileName, source: wasm });
      return `export const src = ${JSON.stringify(base + fileName)}; export const integrity = ${JSON.stringify(sha384(wasm))};`;
    },
    transform(code, id) {
      if (!id.replace(/\\/g, "/").endsWith("/src/salon/pkg/shhdrop_salon_wasm.js")) return null;
      if (code.split(DEFAULT).length !== 2) this.error("shh-salon : colle de wasm-bindgen inattendue (chemin par défaut du .wasm)");
      return { code: code.replace(DEFAULT, '(() => { throw new Error("salon_sans_source"); })()'), map: null };
    },
  };
}

/**
 * Module WebAssembly des jetons anonymes (conception du paiement §7, crate shhdrop-jetons-wasm) :
 * comme le salon, lu seulement au besoin (obtenir des jetons pour un partage payant), jamais par
 * les pages de partage. Production : assets/jetons-EMPREINTE.wasm, adresse et empreinte SHA-384
 * dans le script (src/paiement/source.verified.ts). Démo : aucun paiement, aucun module
 * (source.demo.ts refuse). La colle de wasm-bindgen ne lit jamais le .wasm voisin.
 */
export function jetonsWasm(base: string, demo: boolean): Plugin {
  const VIRTUAL = "virtual:shh-jetons";
  const DEFAULT = "new URL('shhdrop_jetons_wasm_bg.wasm', import.meta.url)";
  const here = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "shh-jetons",
    apply: "build",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === VIRTUAL) return "\0" + VIRTUAL;
      const from = importer?.replace(/\\/g, "/") ?? "";
      if (/^\.\/source(?:\.ts)?$/.test(source) && from.includes("/src/paiement/")) return join(here, demo ? "src/paiement/source.demo.ts" : "src/paiement/source.verified.ts");
      return null;
    },
    load(id) {
      if (id.replace(/\\/g, "/").endsWith("/src/paiement/source.ts")) this.error("shh-jetons : src/paiement/source.ts (lecture sans empreinte) n'entre jamais dans un build");
      if (id !== "\0" + VIRTUAL) return null;
      if (demo) return "export const src = \"\"; export const integrity = \"\";";
      const wasm = readFileSync(join(here, "src/paiement/pkg/shhdrop_jetons_wasm_bg.wasm"));
      const fileName = `assets/jetons-${createHash("sha256").update(wasm).digest("base64url").slice(0, 8)}.wasm`;
      this.emitFile({ type: "asset", fileName, source: wasm });
      return `export const src = ${JSON.stringify(base + fileName)}; export const integrity = ${JSON.stringify(sha384(wasm))};`;
    },
    transform(code, id) {
      if (!id.replace(/\\/g, "/").endsWith("/src/paiement/pkg/shhdrop_jetons_wasm.js")) return null;
      if (code.split(DEFAULT).length !== 2) this.error("shh-jetons : colle de wasm-bindgen inattendue (chemin par défaut du .wasm)");
      return { code: code.replace(DEFAULT, '(() => { throw new Error("jetons_sans_source"); })()'), map: null };
    },
  };
}

/**
 * Une seule langue au démarrage (rapport de performance, D4) : ./en-source, importé par
 * src/i18n/, est remplacé par en-source.verified.ts (production) ou en-source.demo.ts (démo, dont
 * la CSP interdit fetch : dictionnaire intégré). Production : le dictionnaire anglais est écrit en
 * JSON sous assets/locale-en-EMPREINTE.js (extension .js : cache immuable et compression du
 * serveur Go, sans le changer) ; son adresse et son empreinte SHA-384 vont dans le script, jamais
 * ses textes. Contrôle : scripts/check-dist.mjs.
 */
export function langAsset(base: string, demo: boolean): Plugin {
  const VIRTUAL = "virtual:shh-lang";
  const here = fileURLToPath(new URL(".", import.meta.url));
  let code = "";
  return {
    name: "shh-lang",
    apply: "build",
    enforce: "pre",
    async buildStart() {
      if (demo) return;
      // Type stripping de Node (en.ts n'a que des types effaçables) : mêmes textes que le source.
      const { en } = (await import(pathToFileURL(join(here, "src/i18n/en.ts")).href)) as { en: Record<string, string> };
      const data = Buffer.from(JSON.stringify(en));
      const fileName = `assets/locale-en-${createHash("sha256").update(data).digest("base64url").slice(0, 8)}.js`;
      this.emitFile({ type: "asset", fileName, source: data });
      code = `export const src = ${JSON.stringify(base + fileName)}; export const integrity = ${JSON.stringify(sha384(data))};`;
    },
    resolveId(source, importer) {
      if (source === VIRTUAL) return "\0" + VIRTUAL;
      const from = importer?.replace(/\\/g, "/") ?? "";
      if (/^\.\/en-source(?:\.ts)?$/.test(source) && from.includes("/src/i18n/")) return join(here, demo ? "src/i18n/en-source.demo.ts" : "src/i18n/en-source.verified.ts");
      return null;
    },
    load(id) {
      if (id !== "\0" + VIRTUAL) return null;
      if (demo) this.error("shh-lang : pas de fichier de langue dans la démo");
      return code;
    },
  };
}

/**
 * Passkeys (conception du compte par passkey §11, Q8) : ./navigateur, importé par
 * src/account/webauthn.ts, est remplacé dans la démo par navigateur.demo.ts (passkey simulée de
 * src/demo/passkeys.ts : aucune feuille du système, aucune passkey laissée dans le gestionnaire
 * des visiteurs). Le build de la démo ne contient donc aucun appel à navigator.credentials
 * (contrôle : scripts/check-dist.mjs --demo).
 */
export function navigateurPasskeys(demo: boolean): Plugin {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "shh-navigateur",
    enforce: "pre",
    resolveId(source, importer) {
      const from = importer?.replace(/\\/g, "/") ?? "";
      if (demo && /^\.\/navigateur(?:\.ts)?$/.test(source) && from.endsWith("/src/account/webauthn.ts")) return join(here, "src/account/navigateur.demo.ts");
      return null;
    },
  };
}

/** Démo : CSP, referrer et robots en tête de <head> ; index.html copié en 404.html (Pages). */
export function demoMeta(): Plugin {
  let outDir = "";
  return {
    name: "shh-demo-meta",
    apply: "build",
    configResolved(c) {
      outDir = join(c.root, c.build.outDir);
    },
    transformIndexHtml: {
      order: "post",
      handler: () => DEMO_META.map((attrs) => ({ tag: "meta", attrs, injectTo: "head-prepend" as const })),
    },
    // GitHub Pages n'a pas de repli monopage : une adresse profonde reçoit 404.html.
    writeBundle() {
      // Sans l'accueil écrit au build (app.html, infoPages) : une adresse profonde ne l'affiche
      // pas avant le script.
      const app = join(outDir, "app.html");
      copyFileSync(existsSync(app) ? app : join(outDir, "index.html"), join(outDir, "404.html"));
    },
  };
}

/**
 * Pages séparées : chaque page d'information a son propre fichier
 * HTML (securite.html, offres.html…), copié du gabarit page.html, avec son titre, sa description,
 * son adresse canonique et son contenu déjà écrits (rendu Svelte côté serveur, en français, par
 * src/pages/prerender.ts). Le script de ces pages (src/pages/main.ts) ne contient ni composeur,
 * ni moteur, ni compte. Les attributs style du rendu sont retirés (la CSP n'admet aucun style en
 * ligne ; le script les pose au montage), les images importées pointent vers leurs fichiers
 * construits. À placer AVANT sri : chaque page reçoit ensuite ses empreintes.
 */
export const SITE_ORIGIN = "https://shhgone.com";
export const PAGE_PATHS = ["/securite", "/confidentialite", "/offres", "/conditions", "/mentions-legales", "/signaler", "/verifier"] as const;
export function infoPages(base: string, demo: boolean): Plugin {
  const here = fileURLToPath(new URL(".", import.meta.url));
  let outDir = "";
  let configFile: string | undefined;
  let mode = "";
  return {
    name: "shh-info-pages",
    config: () => ({ build: { rollupOptions: { input: { index: join(here, "index.html"), page: join(here, "page.html"), s: join(here, "s.html") } } } }),
    configResolved(c) {
      outDir = join(c.root, c.build.outDir);
      configFile = c.configFile;
      mode = c.mode;
    },
    // Développement : « /securite » sert le gabarit, rempli par le script.
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const p = (req.url ?? "").split("?")[0]!;
        const rest = p.startsWith(base) ? "/" + p.slice(base.length) : p;
        const sansEn = rest === "/en" ? "/" : rest.startsWith("/en/") ? rest.slice(3) : rest;
        if ((PAGE_PATHS as readonly string[]).includes(sansEn.replace(/\.html$/, ""))) req.url = base + "page.html";
        else if (rest === "/en") req.url = base;
        // Liens sous « /s » : la page d'ouverture et de gestion.
        else if (rest === "/s") req.url = base + "s.html";
        next();
      });
    },
    writeBundle: {
      order: "pre",
      sequential: true,
      async handler(_opts, bundle) {
        const template = readFileSync(join(outDir, "page.html"), "utf8");
        // Images importées par les composants : adresse de développement → fichier construit.
        const assets = new Map<string, string>();
        for (const f of Object.values(bundle)) {
          if (f.type !== "asset") continue;
          for (const o of (f as { originalFileNames?: string[] }).originalFileNames ?? []) assets.set("/" + o.replace(/\\/g, "/"), base + f.fileName);
        }
        const { createServer } = await import("vite");
        const vite = await createServer({ configFile, mode, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
        try {
          const { renderPage, renderHome, renderShell, PAGE_FILES } = (await vite.ssrLoadModule("/src/pages/prerender.ts")) as {
            renderPage: (n: string, lang?: "fr" | "en") => { body: string; title: string; description: string; path: string | undefined };
            renderHome: (lang?: "fr" | "en") => { body: string; title: string; description: string; path: string | undefined };
            renderShell: () => string;
            PAGE_FILES: Record<string, string>;
          };
          const clean = (raw: string, file: string) => {
            const body = raw
              .replace(/\sstyle="[^"]*"/g, "")
              .replace(/\ssrc="([^"]*?\/src\/[^"]+)"/g, (_m, u: string) => {
                // Adresse de développement, avec ou sans la base (« /shhgone/src/… » en démo).
                const to = assets.get(u.startsWith(base) ? "/" + u.slice(base.length) : u);
                if (!to) throw new Error(`pages séparées : ${u} sans fichier construit`);
                return ` src="${to}"`;
              });
            if (/\b(?:href|src)="[^"]*\/src\//.test(body)) throw new Error(`pages séparées : ${file} cite encore /src/`);
            return body;
          };
          // Pages bilingues (app/langues.ts) : hors démo, chaque page indexée a sa
          // version anglaise « /en… » ; les deux se citent (hreflang fr, en, x-default = fr).
          const enPath = (path: string) => (path === "/" ? "/en" : "/en" + path);
          const robots = (path: string | undefined, lang: "fr" | "en" = "fr") =>
            demo
              ? ""
              : path !== undefined
                ? `<meta name="robots" content="index, follow" />\n    <link rel="canonical" href="${SITE_ORIGIN}${lang === "en" ? enPath(path) : path}" />\n    ` +
                  `<link rel="alternate" hreflang="fr" href="${SITE_ORIGIN}${path}" />\n    <link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${enPath(path)}" />\n    ` +
                  `<link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}${path}" />\n  `
                : `<meta name="robots" content="noindex" />\n  `;
          const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
          const inLang = (html: string, lang: "fr" | "en", title: string, description: string) => {
            const out = html
              .replace('<html lang="fr"', `<html lang="${lang}"`)
              .replace(/<title>[^<]*<\/title>/, `<title>${esc(demo ? "Démo · " + title : title)}</title>`)
              .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, (_m, a: string, b: string) => a + esc(description) + b);
            if (!out.includes(`<html lang="${lang}"`)) throw new Error("pages séparées : <html lang> introuvable");
            return out;
          };
          // Accueil (référencement) : son contenu écrit dans index.html, entre deux
          // repères (le 404, copié d'index.html, les retire : shh-404).
          {
            const indexFile = join(outDir, "index.html");
            // app.html : la même page sans l'accueil écrit, servie pour les autres adresses de
            // l'application (« /envoyer », « /envois »…) et le 404 (serveur Go, static.go) :
            // l'accueil ne s'y affiche jamais avant le script.
            // « noindex » : ni l'envoi, ni un partage, ni le 404 ne sont des pages à indexer.
            // Squelette (U13) : la coque sans contenu (ambiance et logo visibles, le reste caché par
            // base.css tant que #app porte data-squelette), au lieu d'un écran vide avant le script.
            const appHtml = readFileSync(indexFile, "utf8");
            const vide = '<div id="app"><!--shh-home--></div>';
            if (!appHtml.includes(vide)) throw new Error(`index.html sans ${vide}`);
            const squelette = `<div id="app" data-squelette><!--shh-shell-->${clean(renderShell(), "app.html")}<!--/shh-shell--></div>`;
            writeFileSync(join(outDir, "app.html"), appHtml.replace("</head>", robots(undefined) + "</head>").replace(vide, squelette));
            const r = renderHome();
            const body = clean(r.body, "index.html");
            const html = readFileSync(indexFile, "utf8");
            if (!html.includes("<!--shh-home-->")) throw new Error("index.html sans repère <!--shh-home-->");
            writeFileSync(indexFile, html.replace("</head>", robots(r.path) + "</head>").replace("<!--shh-home-->", `<!--shh-home-->${body}<!--/shh-home-->`));
            // Version anglaise de l'accueil : en.html, servie sous « /en » (static.go).
            if (!demo) {
              const e = renderHome("en");
              writeFileSync(
                join(outDir, "en.html"),
                inLang(html, "en", e.title, e.description)
                  .replace("</head>", robots(e.path, "en") + "</head>")
                  .replace("<!--shh-home-->", `<!--shh-home-->${clean(e.body, "en.html")}<!--/shh-home-->`),
              );
            }
          }
          // Version anglaise : « en-<fichier> » (en-securite.html…), servie sous « /en/<page> ».
          for (const lang of demo ? (["fr"] as const) : (["fr", "en"] as const))
            for (const [name, frFile] of Object.entries(PAGE_FILES)) {
              const file = lang === "en" ? "en-" + frFile : frFile;
              const r = renderPage(name, lang);
              const body = clean(r.body, file);
              const html = inLang(template, lang, r.title, r.description)
                .replace("</head>", robots(r.path, lang) + "</head>")
                .replace("<!--shh-page-->", body);
              if (!html.includes(body)) throw new Error(`pages séparées : ${file} sans contenu`);
              writeFileSync(join(outDir, file), html);
            }
        } finally {
          await vite.close();
        }
        rmSync(join(outDir, "page.html"));
      },
    },
  };
}

/**
 * Version du site affichée dans le pied de page : hash court du commit, sans
 * secret. SHH_BUILD_ID (CI, image Docker) sinon `git rev-parse --short=7 HEAD` ; 7 à 40 chiffres
 * hexadécimaux, ramenés à 7. Même commit, même valeur : la construction reste reproductible
 * (spec §28).
 * Build (`vite build`, production comme démo) : sans identifiant valide, le build ÉCHOUE (une image marquée « dev » ne pourrait jamais correspondre au build public).
 * « dev » seulement pour `vite dev` et les tests (command « serve »).
 */
export function buildId(command: "build" | "serve"): string {
  let id = process.env.SHH_BUILD_ID ?? "";
  if (id === "") {
    try {
      id = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      id = "";
    }
  }
  if (/^[0-9a-f]{7,40}$/.test(id)) return id.slice(0, 7);
  if (command === "serve") return "dev";
  throw new Error(
    `identifiant de build absent ou invalide (« ${id} ») : donner SHH_BUILD_ID=$(git rev-parse --short=7 HEAD), 7 à 40 chiffres hexadécimaux minuscules, ou construire depuis un dépôt git`,
  );
}

/** Types précompressés : texte, et le moteur WebAssembly (spec moteur §7 ; les images et polices le
 * sont déjà) ; mêmes extensions que static.go. */
export const COMPRESSIBLE = /\.(js|css|html|svg|webmanifest|xml|txt|wasm)$/;

/**
 * Vitesse (retours CLEAN2) : à côté de chaque fichier texte (ou .wasm) de plus de 1 Kio, une variante
 * brotli (.br, qualité 11) et gzip (.gz, niveau 9, sans date : reproductible), servies par le
 * serveur Go selon Accept-Encoding. Les octets décompressés sont identiques (SRI inchangée ;
 * contrôle : scripts/check-dist.mjs). Production seulement (GitHub Pages compresse la démo).
 */
export function precompress(): Plugin {
  let outDir = "";
  return {
    name: "shh-precompress",
    apply: "build",
    configResolved(c) {
      outDir = join(c.root, c.build.outDir);
    },
    closeBundle() {
      // Build raté : dist/ peut manquer ; ne pas masquer l'erreur d'origine par un ENOENT.
      if (!existsSync(outDir)) return;
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
      for (const f of walk(outDir)) {
        if (!COMPRESSIBLE.test(f)) continue;
        const data = readFileSync(f);
        if (data.length < 1024) continue;
        writeFileSync(f + ".br", brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
        writeFileSync(f + ".gz", gzipSync(data, { level: 9 }));
      }
    },
  };
}

/**
 * Compte par e-mail : drapeau de construction __COMPTES__, `false` par
 * défaut en production. Vrai si SHH_SITE_COMPTES vaut exactement « 1 » au build de production, et
 * toujours dans la démo (son faux serveur du compte répond dans l'onglet). Faux, aucun écran n'importe src/account/ (source-rules.test.ts) :
 * aucun code du compte dans le site (contrôle : scripts/check-dist.mjs sans --comptes).
 * Activation publique : décision D8 (conception du compte §20), avec SHH_COMPTES=1
 * côté serveur.
 */
export function comptesActifs(demo: boolean): boolean {
  // Démo : toujours (connexion essayable ; faux serveur du compte de
  // l'onglet, src/demo/fake-compte.ts, aucun e-mail envoyé).
  return demo || process.env.SHH_SITE_COMPTES === "1";
}

/**
 * Pages du compte : App.svelte ne les voit que par
 * src/routes/compte/pages.ts. Sans __COMPTES__ (défaut, démo), ce module est remplacé par
 * pages.off.ts (aucune page, aucun import) : ni le module de compte, ni le moteur du salon qu'il
 * charge n'entrent dans le graphe du site (check-dist.mjs : aucune trace du compte ; la démo
 * refuse tout module du salon).
 */
export function comptesPages(actifs: boolean): Plugin {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "shh-comptes",
    enforce: "pre",
    resolveId(source, importer) {
      if (actifs || !/^\.\/routes\/compte\/pages(?:\.ts)?$/.test(source)) return null;
      if (!(importer ?? "").replace(/\\/g, "/").endsWith("/src/App.svelte")) return null;
      return join(here, "src/routes/compte/pages.off.ts");
    },
  };
}

/**
 * Salon : drapeau de construction __SALONS__. Vrai en production avec le compte
 * (SHH_SITE_COMPTES=1 : créer un salon exige un compte, D42-26) ; toujours faux dans la démo
 * (GitHub Pages n'a pas de serveur du salon : le salon y reste « bientôt », sans faux serveur).
 */
export function salonsActifs(demo: boolean): boolean {
  return !demo && comptesActifs(demo);
}

/**
 * Écrans du salon : App.svelte ne les voit que par src/routes/salon/pages.ts. Sans
 * __SALONS__, ce module est remplacé par pages.off.ts : ni écran, ni client, ni WebSocket.
 */
export function salonPages(actifs: boolean): Plugin {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "shh-salons",
    enforce: "pre",
    resolveId(source, importer) {
      if (actifs || !/^\.\/routes\/salon\/pages(?:\.ts)?$/.test(source)) return null;
      if (!(importer ?? "").replace(/\\/g, "/").endsWith("/src/App.svelte")) return null;
      return join(here, "src/routes/salon/pages.off.ts");
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const demo = mode === "demo";
  return {
    plugins: [comptesPages(comptesActifs(demo)), salonPages(salonsActifs(demo)), svelte(), infoPages(demo ? DEMO_BASE : "/", demo), sri(demo ? DEMO_BASE : "/"), engineWasm(demo ? DEMO_BASE : "/", demo), powWorker(demo ? DEMO_BASE : "/", demo), salonWasm(demo ? DEMO_BASE : "/", demo), jetonsWasm(demo ? DEMO_BASE : "/", demo), langAsset(demo ? DEMO_BASE : "/", demo), navigateurPasskeys(demo), ...(demo ? [demoMeta()] : [demoGuard(), precompress()])],
    base: demo ? DEMO_BASE : "/",
    define: { __SHH_BUILD__: JSON.stringify(buildId(command)), __COMPTES__: JSON.stringify(comptesActifs(demo)), __SALONS__: JSON.stringify(salonsActifs(demo)), __BILINGUE__: JSON.stringify(!demo) },
    build: {
      outDir: demo ? "dist-demo" : "dist",
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      sourcemap: false,
    },
  };
});

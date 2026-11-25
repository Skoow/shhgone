// Build du cadre PDF isolé (UI §13) : un script classique (IIFE) pdf-frame.js et
// pdf-frame.css, SANS empreinte dans le nom (servis avec CORP cross-origin par une liste fermée,
// static.go), écrits à côté du site déjà construit (dist ou dist-demo).
//
// Intégrité (spec §28.3) : le cadre reçoit le PDF déchiffré ; pdf-frame.html (copié de public/
// par le build principal) reçoit ensuite integrity="sha384-…" et crossorigin="anonymous" sur
// ses deux balises (greffon shh-pdf-frame-sri, contrôlé par check-dist.mjs). crossorigin est
// exigé : le cadre a une origine opaque (sandbox allow-scripts), toute requête y est intersite,
// et une empreinte sur une réponse sans CORS est refusée. Le serveur pose donc
// Access-Control-Allow-Origin: * sur pdf-frame.js et pdf-frame.css (static_paths.go ; GitHub
// Pages le fait pour la démo). Rien en développement (vite dev) : public/pdf-frame.html reste nu.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { precompress } from "./vite.config.ts";
import { addSri } from "./scripts/sri.mjs";

/** Ajoute crossorigin="anonymous" (s'il manque) aux balises <script src> et <link rel="stylesheet">. */
export function withCrossorigin(html: string): string {
  return html.replace(/<(script\b[^>]*\ssrc=|link\b[^>]*\srel="stylesheet")[^>]*>/g, (tag) =>
    /\scrossorigin\b/.test(tag) ? tag : tag.replace(/^<(script|link)\b/, (m) => `${m} crossorigin="anonymous"`),
  );
}

// Dossier de sortie RÉSOLU (configResolved) : celui de la configuration, ou celui de
// `--outDir` (site avec compte, ui-e2e/comptes-site.ts : dist-comptes).
function pdfFrameSri(): Plugin {
  let outDir = "";
  return {
    name: "shh-pdf-frame-sri",
    apply: "build",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    // writeBundle : après l'écriture de pdf-frame.js et .css, avant la précompression (closeBundle).
    writeBundle: {
      sequential: true,
      handler() {
        const page = join(outDir, "pdf-frame.html");
        const read = (rel: string) => {
          try {
            return readFileSync(join(outDir, rel));
          } catch {
            return null;
          }
        };
        // Chemins relatifs (pdf-frame.css, pdf-frame.js) : lus dans outDir tels quels.
        writeFileSync(page, addSri(withCrossorigin(readFileSync(page, "utf8")), read, "/"));
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  const outDir = demo ? "dist-demo" : "dist";
  return {
    plugins: [pdfFrameSri(), ...(demo ? [] : [precompress()])],
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      copyPublicDir: false,
      lib: { entry: "src/viewers/pdf-frame/main.ts", name: "shhPdfFrame", formats: ["iife"], fileName: () => "pdf-frame.js", cssFileName: "pdf-frame" },
    },
  };
});

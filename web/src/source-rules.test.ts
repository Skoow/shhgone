import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveConfig, type Rollup } from "vite";
import { comptesPages, demoGuard } from "../vite.config";

const srcDir = dirname(fileURLToPath(import.meta.url));
const webDir = dirname(srcDir);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const EXCLUDED_DIRS = new Set(["crypto", "transfer", "demo"]);

function isScanned(rel: string): boolean {
  if (!/\.(ts|svelte)$/.test(rel)) return false;
  if (/\.test(?:-helper)?\.ts$/.test(rel) || rel.endsWith(".d.ts")) return false;
  if (rel === "index.ts") return false;
  return !rel.split("/").slice(0, -1).some((d) => EXCLUDED_DIRS.has(d));
}

const files = walk(srcDir)
  .map((abs) => ({ abs, rel: relative(srcDir, abs).split(sep).join("/") }))
  .filter((f) => isScanned(f.rel))
  .map((f) => ({ ...f, text: readFileSync(f.abs, "utf8") }));

// Motifs des règles, testés sur des exemples (voir « motifs des règles ») pour ne pas dériver.
const Q = "[\"'`]"; // guillemet simple, double ou accent grave (import() en gabarit)
const NQ = "[^\"'`]";
// Attribut style dans une balise : style="…", style={…}, style=x, raccourci {style}, style nu.
// Les directives style:prop (CSSOM) et data-style ne comptent pas.
const RE_STYLE_ATTR = /<[a-zA-Z][^<>]*?(?<![-\w:.])style(?=\s*[={}/>\s])/;
const RE_FORBIDDEN_IMPORT = new RegExp(
  `(?:from\\s*|import\\s*\\(\\s*|import\\s+)${Q}${NQ}*\\/(?:transfer|crypto|engine(?!\\/pure(?:\\.[a-z]+)?${Q}))(?:\\/${NQ}*|\\.[a-z]+)?${Q}`,
);
const RE_DEMO_IMPORT = new RegExp(
  `(?:from\\s*|import\\s*\\(\\s*|import\\s+)${Q}${NQ}*\\bdemo(?:\\/${NQ}*|\\.[a-z]+)?${Q}\\s*\\)?`,
  "g",
);

const UI_DIRS = ["routes", "ui", "flows", "viewers", "media", "captcha", "app", "history", "downloads"];
const inUiDir = (rel: string) => UI_DIRS.includes(rel.split("/")[0]!);

function offenders(
  re: RegExp,
  filter: (rel: string) => boolean = () => true,
): string[] {
  return files.filter((f) => filter(f.rel) && re.test(f.text)).map((f) => f.rel);
}

describe("règles de sources", () => {
  it("analyse bien des fichiers (main.ts, App.svelte)", () => {
    const rels = files.map((f) => f.rel);
    expect(rels).toContain("main.ts");
    expect(rels).toContain("App.svelte");
  });

  it("pas de {@html", () => expect(offenders(/\{@html/)).toEqual([]));
  it("pas d'attribut style (style=\"…\" ni style={…}) dans un .svelte", () =>
    expect(offenders(RE_STYLE_ATTR, (r) => r.endsWith(".svelte"))).toEqual([]));
  it("pas d'eval ni de new Function", () =>
    expect(offenders(/\beval\s*\(|new\s+Function\b/)).toEqual([]));
  // Moteur (Task 11) : les écrans n'en voient que la partie sans clé (engine/pure.ts) ; le reste
  // passe par l'interface publique (index.ts).
  it("pas d'import de transfer/, crypto/ ni engine/ (hors engine/pure) dans les écrans", () =>
    expect(offenders(RE_FORBIDDEN_IMPORT, inUiDir)).toEqual([]));
  // Exception écrite (audit du 20 novembre, W3) : captcha/pow-source.verified.ts lit le script du
  // Worker anti-robot avec son empreinte (fetch + integrity, comme engine/source.verified.ts), et
  // aucune adresse de l'API.
  it("pas de fetch( ni XMLHttpRequest dans les écrans", () => {
    expect(offenders(/\bfetch\s*\(|XMLHttpRequest/, (r) => inUiDir(r) && r !== "captcha/pow-source.verified.ts")).toEqual([]);
    const pow = files.find((f) => f.rel === "captcha/pow-source.verified.ts")!.text;
    expect(pow).toMatch(/fetch\(src, \{ integrity, credentials: "omit", redirect: "error" \}\)/);
    expect(pow).not.toMatch(/\/api\/|XMLHttpRequest/);
  });
  it("aucun stockage navigateur (hors historique local et retours, ci-dessous)", () =>
    expect(
      offenders(/localStorage|indexedDB|document\.cookie/, (r) => r !== "history/live.svelte.ts" && r !== "history/presence.svelte.ts" && r !== "history/returns.ts" && r !== "downloads/live.svelte.ts" && r !== "downloads/probe.ts" && r !== "account/persist.ts" && r !== "paiement/pass.ts" && r !== "salon/preuve.ts"),
    ).toEqual([]));
  // Spec §33, §33.1 : exception écrite, l'historique local chiffré des envois. Seul
  // history/live.svelte.ts lit `indexedDB` (pour le passer à history/store.ts, qui chiffre) ;
  // aucun localStorage ni cookie, même là ; et rien d'autre que history/ ne lit le stockage.
  it("historique : indexedDB lu seulement par history/live.svelte.ts, jamais localStorage ni cookie", () => {
    const live = files.find((f) => f.rel === "history/live.svelte.ts");
    expect(live?.text).toMatch(/indexedDB/);
    expect(live?.text).not.toMatch(/localStorage|document\.cookie|sessionStorage/);
    expect(offenders(/\bIDB(?:Factory|Database|ObjectStore|Transaction)\b/, (r) => !r.startsWith("history/") && !r.startsWith("downloads/") && !r.startsWith("account/") && !r.startsWith("paiement/") && r !== "salon/preuve.ts")).toEqual([]);
  });
  // D42-22 : exception écrite, l'octroi d'ouverture gardé chiffré pour revenir jusqu'à
  // l'échéance (history/returns.ts, voisin de l'historique et même mécanisme : AES-GCM, clé non
  // extractible, base IndexedDB à part). Il lit `indexedDB` lui-même (base à part, sans passer
  // par l'état des écrans de l'historique) ; jamais localStorage, sessionStorage ni cookie ;
  // l'entrée n'a que l'étiquette, l'octroi et l'échéance (jamais K_lien ni mot de passe).
  it("retours : indexedDB seulement, entrée sans K_lien ni mot de passe", () => {
    const r = files.find((f) => f.rel === "history/returns.ts")!;
    expect(r.text).toMatch(/indexedDB/);
    expect(r.text).not.toMatch(/localStorage|document\.cookie|sessionStorage/);
    const type = r.text.match(/export type ReturnEntry = \{([\s\S]*?)\n\};/)![1]!;
    expect([...type.matchAll(/^\s+(\w+):/gm)].map((m) => m[1])).toEqual(["tag", "grant", "expiresAt"]);
  });
  // Conception compte §21.9 (R12) : exception écrite, l'historique des téléchargements, chiffré
  // comme l'historique des envois. Seul downloads/live.svelte.ts lit `indexedDB` ; la base
  // `shhdrop-telechargements` n'est nommée que dans downloads/ ; aucune requête dans ce module ;
  // l'entrée n'a que nom, taille, format, source et date (jamais lien, clé, mot de passe).
  it("téléchargements : base seulement dans downloads/, indexedDB lu par downloads/live.svelte.ts, aucun fetch, entrée sans secret", () => {
    expect(offenders(/shhdrop-telechargements/, (r) => !r.startsWith("downloads/"))).toEqual([]);
    expect(files.find((f) => f.rel === "downloads/store.ts")?.text).toMatch(/shhdrop-telechargements/);
    const live = files.find((f) => f.rel === "downloads/live.svelte.ts")!;
    expect(live.text).toMatch(/indexedDB/);
    expect(live.text).not.toMatch(/localStorage|document\.cookie|sessionStorage/);
    expect(offenders(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, (r) => r.startsWith("downloads/"))).toEqual([]);
    // downloads/probe.ts (pages d'information, 22 novembre) : lecture seule du drapeau « on »,
    // jamais d'écriture ni d'entrée lue.
    const probe = files.find((f) => f.rel === "downloads/probe.ts")!.text;
    expect(probe).toMatch(/"readonly"/);
    expect(probe).not.toMatch(/"readwrite"|\.put\(|\.add\(|\.delete\(|\.clear\(|"entries"|localStorage|sessionStorage|document\.cookie/);
    expect([...probe.matchAll(/\.get\("([^"]+)"\)/g)].map((m) => m[1])).toEqual(["flag:on"]);
    const store = files.find((f) => f.rel === "downloads/store.ts")!;
    const type = store.text.match(/export type DownloadEntry = \{([\s\S]*?)\n\};/)![1]!;
    expect([...type.matchAll(/^\s+(\w+):/gm)].map((m) => m[1])).toEqual(["id", "name", "sizeBytes", "format", "source", "savedAt"]);
  });
  // Conception compte §8.5, §9, §15 (plan, lot 9) : web/src/account/ est le seul détenteur du jeton
  // de session, de K_compte et de s_profil. Une seule couche réseau (account/api.ts) : X-Shh-Session
  // n'est écrit que là ; la base `shhdrop-compte` (« Rester connecté », exception écrite, chiffrée
  // par une clé non extractible) n'est nommée et lue que par account/persist.ts ; aucun cookie.
  it("compte : X-Shh-Session seulement dans account/api.ts, seul fichier du compte qui fait des requêtes", () => {
    expect(offenders(/X-Shh-Session/i, (r) => r !== "account/api.ts")).toEqual([]);
    expect(files.find((f) => f.rel === "account/api.ts")?.text).toMatch(/X-Shh-Session/);
    expect(offenders(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, (r) => r.startsWith("account/") && r !== "account/api.ts")).toEqual([]);
    expect(offenders(/XMLHttpRequest|sendBeacon|WebSocket|EventSource/, (r) => r === "account/api.ts")).toEqual([]);
    // keepalive (audit du 18 novembre) : seulement pour la déconnexion, pour qu'elle parte même si
    // l'onglet se ferme aussitôt ; aucune autre requête ne survit à la page.
    const apiTs = files.find((f) => f.rel === "account/api.ts")!.text;
    expect([...apiTs.matchAll(/keepalive: true/g)]).toHaveLength(2); // l'option d'appel, et son seul usage
    expect(apiTs).toMatch(/export async function deconnexion[\s\S]{0,160}keepalive: true/);
  });
  // Conception du paiement §5.2, §6.1 : le pass P ne part que dans X-Shh-Pass, écrit seulement par
  // paiement/api.ts (seul fichier du paiement qui fait des requêtes) ; la base `shhdrop-pass`
  // (exception écrite, chiffrée par une clé non extractible) n'est nommée et lue que par
  // paiement/pass.ts ; aucun localStorage, sessionStorage ni cookie.
  it("paiement : X-Shh-Pass seulement dans paiement/api.ts, base shhdrop-pass seulement dans paiement/pass.ts", () => {
    expect(offenders(/X-Shh-Pass/i, (r) => r !== "paiement/api.ts")).toEqual([]);
    expect(files.find((f) => f.rel === "paiement/api.ts")?.text).toMatch(/X-Shh-Pass/);
    // Exception : lecture du module WebAssembly des jetons (source*.ts, avec son empreinte en
    // production, comme le salon), jamais une requête au serveur.
    expect(offenders(/\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource/, (r) => r.startsWith("paiement/") && r !== "paiement/api.ts" && !/^paiement\/source(\.verified)?\.ts$/.test(r))).toEqual([]);
    expect(offenders(/\/api\//, (r) => /^paiement\/source/.test(r))).toEqual([]);
    expect(offenders(/shhdrop-pass/, (r) => r !== "paiement/pass.ts")).toEqual([]);
    expect(files.find((f) => f.rel === "paiement/pass.ts")?.text).toMatch(/indexedDB/);
    expect(offenders(/localStorage|sessionStorage|document\.cookie/, (r) => r.startsWith("paiement/"))).toEqual([]);
  });
  // Conception du compte par passkey §9, §14 (plan, lot W1) : navigator.credentials seulement dans
  // account/navigateur.ts (la démo le remplace par une passkey simulée), utilisé par account/webauthn.ts ;
  // ni l'un ni l'autre ne fait de requête ; et aucune requête entre le geste et l'appel
  // au navigateur (Safari annule la cérémonie) : dans les fonctions de session appelées par un
  // geste, rien de api.* avant creer( / obtenir( / prfApresCreation(, sauf le rechargement d'une
  // cérémonie échue (« if (!fraiche(c)) »), qui n'arrive que si l'écran ne l'a pas chargée.
  it("compte : navigator.credentials seulement dans account/navigateur.ts ; aucune requête entre le geste et la cérémonie", () => {
    const sansCommentaires = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    expect(files.filter((f) => f.rel !== "account/navigateur.ts" && /navigator\s*\??\.\s*credentials|\bcredentials\s*\??\.\s*(?:create|get)\s*\(|PublicKeyCredential\b/.test(sansCommentaires(f.text))).map((f) => f.rel)).toEqual([]);
    expect(files.find((f) => f.rel === "account/navigateur.ts")!.text).toMatch(/navigator\?\.credentials/);
    for (const r of ["account/navigateur.ts", "account/navigateur.demo.ts", "account/webauthn.ts"]) expect(files.find((f) => f.rel === r)!.text, r).not.toMatch(/\bfetch\b|api\./);
    const s = files.find((f) => f.rel === "account/session.svelte.ts")!.text;
    const gestes: [string, RegExp][] = [
      ["creerPasskey", /\bcreer\(/],
      ["ajouterPasskey", /\bcreer\(/],
      ["deuxiemeGeste", /prfApresCreation\(/],
      ["deuxiemeGesteAjout", /prfApresCreation\(/],
      ["seConnecter", /\bobtenir\(/],
      ["reauthLien", /\bobtenir\(/],
    ];
    for (const [nom, appel] of gestes) {
      const debut = s.search(new RegExp(`(?:export )?async function ${nom}\\(`));
      expect(debut, nom).toBeGreaterThan(-1);
      const corps = s.slice(debut, s.indexOf("\n}\n", debut));
      const i = corps.search(appel);
      expect(i, nom).toBeGreaterThan(-1);
      const avant = corps.slice(0, i).replace(/if \(!fraiche\(c\)\) c = \{[^\n]*\n/g, "");
      expect(avant, nom).not.toMatch(/\bapi\.|\bfetch\b|preparer[A-Z]/);
    }
  });
  it("compte : s_profil et K_compte seulement dans account/", () => {
    expect(offenders(/s_profil|sProfil|kCompte|K_compte/, (r) => !r.startsWith("account/") && !r.startsWith("engine/"))).toEqual([]);
  });
  it("compte : base shhdrop-compte nommée et lue seulement par account/persist.ts, sans localStorage ni sessionStorage", () => {
    expect(offenders(/shhdrop-compte/, (r) => r !== "account/persist.ts")).toEqual([]);
    const p = files.find((f) => f.rel === "account/persist.ts")!;
    expect(p.text).toMatch(/shhdrop-compte/);
    expect(p.text).toMatch(/indexedDB/);
    expect(offenders(/localStorage|sessionStorage|document\.cookie/, (r) => r.startsWith("account/"))).toEqual([]);
  });
  // Les écrans ne voient du compte que son état (account/session.svelte.ts), et seulement derrière
  // le drapeau de construction __COMPTES__ (faux par défaut : aucun code du compte dans le site).
  it("compte : les écrans n'importent que account/session.svelte, et tout import du compte est derrière __COMPTES__", () => {
    const RE_ACCOUNT = new RegExp(`(?:from\\s*|import\\s*\\(\\s*|import\\s+)${Q}${NQ}*\\/account\\/(${NQ}*)${Q}`, "g");
    for (const f of files.filter((x) => !x.rel.startsWith("account/"))) {
      const targets = [...f.text.matchAll(RE_ACCOUNT)].map((m) => m[1]);
      if (targets.length === 0) continue;
      expect(targets.filter((t) => !/^session\.svelte(?:\.ts|\.js)?$/.test(t!)), f.rel).toEqual([]);
      expect(f.text, f.rel).toMatch(/__COMPTES__/);
    }
  });
  // Conception compte §21.7, §21.8 (plan, lot 11) : exception écrite, une entrée reçue ou de salon
  // garde son lien (`link`, K_lien) ; un envoi jamais (cleanEntry, history/store.test.ts). Toujours
  // aucun mot de passe, nom d'élément ni contenu : la liste des champs reste fermée. Seul ajout du
  // 19 novembre : `label` d'un envoi porte le titre du partage (manifeste), pas un nom d'élément.
  it("historique : liste fermée des champs de HistoryEntry (lien seulement pour un reçu ou un salon), aucun mot de passe ni nom", () => {
    const store = files.find((f) => f.rel === "history/store.ts")!;
    const type = store.text.match(/export type HistoryEntry = \{([\s\S]*?)\n\};/)![1]!;
    const fields = [...type.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(["id", "sorte", "origine", "manage", "link", "label", "format", "createdAt", "sizeBytes", "itemsCount", "expiresAt", "maxOpens", "opensUsed", "opens", "state", "lastSeenAt", "endedAt", "destroyedHere"]);
    expect(type).not.toMatch(/password|motDePasse|mdp|name|nom|text|content|items\b/i);
  });
  // Spec §41.4 : exception écrite, l'octroi d'ouverture de l'onglet (session/open-grant.ts),
  // et plus tard le salon (chat/session.ts, §39.13.3). Nulle part ailleurs.
  // Salon (plan C-3) : une seule couche réseau par sorte. Requêtes HTTP du salon seulement dans
  // salon/api.ts (la création avec session : account/api.ts) ; le WebSocket du salon seulement dans
  // salon/client.ts, nulle part ailleurs dans le site ; aucun stockage navigateur dans salon/.
  it("salon : fetch seulement dans salon/api.ts, WebSocket seulement dans salon/client.ts (et salon.svelte.ts qui le crée)", () => {
    expect(offenders(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|EventSource/, (r) => r.startsWith("salon/") && r !== "salon/api.ts" && r !== "salon/source.ts" && r !== "salon/source.verified.ts")).toEqual([]);
    expect(offenders(/\bnew\s+WebSocket\b/, (r) => r !== "salon/salon.svelte.ts")).toEqual([]);
    expect(offenders(/\bWebSocket\b/, (r) => !r.startsWith("salon/"))).toEqual([]);
    expect(offenders(/localStorage|sessionStorage|indexedDB|document\.cookie/, (r) => (r.startsWith("salon/") && r !== "salon/preuve.ts") || r.startsWith("routes/salon/"))).toEqual([]);
    // Preuve de membre (D41-26), exception écrite : base `shhdrop-salon` nommée et lue seulement
    // par salon/preuve.ts, jamais localStorage, sessionStorage ni cookie ; aucun mot de passe.
    const pv = files.find((f) => f.rel === "salon/preuve.ts")!;
    expect(pv.text).toMatch(/indexedDB/);
    expect(pv.text).not.toMatch(/localStorage|sessionStorage|document\.cookie|\bmdp\b|motDePasse/);
    expect(offenders(/shhdrop-salon"/, (r) => r !== "salon/preuve.ts")).toEqual([]);
  });
  // Plan C-4, point 1 : la graine R en clair (seedBytes, seedFromBytes) ne sert qu'aux pièces du
  // salon, où elle voyage dans un message MLS ; jamais dans un partage (R y reste dans l'enveloppe).
  it("salon : seedBytes et seedFromBytes seulement dans salon/pieces.ts (et engine/)", () =>
    expect(offenders(/\bseed(?:Bytes|FromBytes)\b/, (r) => r !== "salon/pieces.ts" && !r.startsWith("engine/"))).toEqual([]));
  // Exigence C-3 33 (spec salon v3 §15.2) : S_gestion n'est jamais montré au serveur, seulement
  // J_gestion (jetonGestion) ; aucun en-tête X-Shh-Manage n'est écrit hors de salon/api.ts et account/api.ts.
  it("salon : X-Shh-Manage du salon écrit seulement par salon/api.ts et account/api.ts", () => {
    expect(offenders(/["']X-Shh-Manage["']\s*:/, (r) => r.startsWith("salon/") && r !== "salon/api.ts")).toEqual([]);
    expect(offenders(/X-Shh-Manage/, (r) => r.startsWith("routes/salon/"))).toEqual([]);
  });
  it("sessionStorage seulement dans session/open-grant.ts (et chat/session.ts)", () =>
    expect(offenders(/sessionStorage/, (r) => r !== "session/open-grant.ts" && r !== "chat/session.ts")).toEqual([]));
  it("pas de console.log", () => expect(offenders(/console\.log/)).toEqual([]));
  // Exception démo (UI §14.3) : le faux serveur de la démo garde son état (ce que garderait le
  // vrai serveur : empreintes, segments chiffrés) en IndexedDB, rangé par onglet (identifiant
  // en sessionStorage), pour qu'un rechargement retrouve le partage. Seulement dans
  // demo/persist.ts, jamais dans le build de production (demoGuard, check-dist).
  it("démo : stockage navigateur seulement dans demo/persist.ts", () => {
    const demoFiles = walk(join(srcDir, "demo"))
      .filter((a) => /\.(ts|svelte)$/.test(a) && !/\.test\.ts$/.test(a))
      .map((a) => ({ rel: relative(srcDir, a).split(sep).join("/"), text: readFileSync(a, "utf8") }));
    const bad = demoFiles.filter((f) => f.rel !== "demo/persist.ts" && /localStorage|indexedDB|sessionStorage|document\.cookie/.test(f.text));
    expect(bad.map((f) => f.rel)).toEqual([]);
    const p = demoFiles.find((f) => f.rel === "demo/persist.ts");
    expect(p?.text).not.toMatch(/localStorage|document\.cookie/);
  });

  // UI §20.2 S6 et §20.4 (poussière) : styles par CSSOM et WAAPI seulement, aucune lecture de
  // pixels du contenu hors des visionneuses. Ces deux règles valent pour TOUS les sources.
  const everySource = walk(srcDir)
    .map((abs) => ({ rel: relative(srcDir, abs).split(sep).join("/"), abs }))
    .filter((f) => /\.(ts|svelte)$/.test(f.rel) && !/\.test\.ts$/.test(f.rel) && !f.rel.endsWith(".d.ts"))
    .map((f) => ({ ...f, text: readFileSync(f.abs, "utf8") }));
  it("jamais setAttribute(\"style\") (CSSOM seulement, S6), dans tout src/", () =>
    expect(everySource.filter((f) => /setAttribute\s*\(\s*["'`]style["'`]/.test(f.text)).map((f) => f.rel)).toEqual([]));
  it("aucun document.cookie, dans tout src/ (démo comprise)", () =>
    expect(everySource.filter((f) => /document\.cookie/.test(f.text)).map((f) => f.rel)).toEqual([]));
  it("getImageData seulement sous viewers/ (aucune lecture des pixels du contenu)", () =>
    expect(
      everySource.filter((f) => !f.rel.startsWith("viewers/") && /getImageData/.test(f.text)).map((f) => f.rel),
    ).toEqual([]));

  // Task R2 (spec §28.3, §41.6) : l'écrivain .zip, les visionneuses et les écrans sont importés
  // statiquement ; aucun import() dynamique hors de main.ts (démo).
  it("aucun import() dynamique dans zip/, viewers/, flows/, ui/, routes/", () =>
    expect(
      everySource
        .filter((f) => /^(zip|viewers|flows|ui|routes)\//.test(f.rel) && /\bimport\s*\(/.test(f.text))
        .map((f) => f.rel),
    ).toEqual([]));

  it("demo/ importé seulement par main.ts, pages/main.ts et open/main.ts, sous la forme import(\"…/demo/install\")", () => {
    for (const f of files) {
      const found = f.text.match(RE_DEMO_IMPORT) ?? [];
      if (f.rel === "main.ts") {
        for (const m of found) expect(m).toBe('import("./demo/install")');
      } else if (f.rel === "pages/main.ts" || f.rel === "open/main.ts") {
        // Pages séparées et page « /s » (16 novembre) : même installation de la démo, même condition.
        for (const m of found) expect(m).toBe('import("../demo/install")');
      } else {
        expect({ file: f.rel, found }).toEqual({ file: f.rel, found: [] });
      }
    }
  });
});

describe("marque de démo", () => {
  const MARK_RE = /__SHH_DEMO__/;
  const all = walk(srcDir)
    .map((abs) => ({ abs, rel: relative(srcDir, abs).split(sep).join("/") }))
    .filter((f) => /\.(ts|svelte)$/.test(f.rel) && !/\.test\.ts$/.test(f.rel));

  it("chaque module de src/demo/ porte la marque", () => {
    const demo = all.filter((f) => f.rel.startsWith("demo/"));
    expect(demo.length).toBeGreaterThanOrEqual(4);
    for (const f of demo) expect(readFileSync(f.abs, "utf8"), f.rel).toMatch(/const MARK = "__SHH_DEMO__"/);
  });

  it("aucun fichier hors de src/demo/ ne porte la marque (app/demo-hooks.ts compris)", () => {
    const out = all.filter((f) => !f.rel.startsWith("demo/") && MARK_RE.test(readFileSync(f.abs, "utf8"))).map((f) => f.rel);
    expect(out).toEqual([]);
  });
});

describe("motifs des règles", () => {
  const matches = (re: RegExp, text: string) => new RegExp(re.source, re.flags.replace("g", "")).test(text);

  it("style : attribut texte ou expression", () => {
    for (const t of ['<div style="color:red">', "<div style='x'>", "<div style={s}>", "<div style = {`a:${b}`}>", "<div style=`x`>", "<div style=color:red>", "<div {style}>", "<div class=\"a\" {style} id=\"b\">"])
      expect(matches(RE_STYLE_ATTR, t), t).toBe(true);
    for (const t of ["<div class:on={x}>", "<div style:color={c}>", "<style>a{}</style>", "const lifestyle = 1", "const style = { a: 1 };", "let { style } = $props();", "<div data-style=\"a\">"])
      expect(matches(RE_STYLE_ATTR, t), t).toBe(false);
  });

  it("imports interdits dans les écrans : toutes les écritures", () => {
    for (const t of [
      'import { a } from "../transfer/api"',
      "import x from '../crypto/keys'",
      'import("../transfer/api")',
      "import(`../transfer/api`)",
      'import "../crypto/boot"',
      'import { a } from "../transfer"',
      'import("../crypto")',
      "import(`../crypto`)",
      'import { a } from "../transfer.ts"',
      'import("../crypto.js")',
      "import(`../transfer/api.ts`)",
      'import { a } from "../engine"',
      'import { a } from "../engine/index"',
      'import { a } from "../engine/load.ts"',
      'import("../engine/argon2")',
      'import { a } from "../engine/pured"',
    ])
      expect(matches(RE_FORBIDDEN_IMPORT, t), t).toBe(true);
    for (const t of ['import { a } from "../engine/pure"', 'import { a } from "../engine/pure.ts"', 'import { a } from "../ui/transfer-badge"', 'import { a } from "./transferred"', 'import { a } from "node:crypto"'])
      expect(matches(RE_FORBIDDEN_IMPORT, t), t).toBe(false);
  });

  it("demo : import avec ou sans barre finale, guillemets ou gabarit", () => {
    for (const t of [
      'import("./demo/install")',
      "import(`./demo/install`)",
      'import("./demo")',
      "import('./demo')",
      "import(`./demo`)",
      'import { x } from "./demo"',
      'import "../demo/install"',
      'import("./demo.ts")',
      "import(`./demo.js`)",
      'import { x } from "./demo/install.ts"',
    ])
      expect(matches(RE_DEMO_IMPORT, t), t).toBe(true);
    for (const t of ['import { x } from "./demographie"', 'import { x } from "./ui/predemo"'])
      expect(matches(RE_DEMO_IMPORT, t), t).toBe(false);
  });

  it("demo : le motif capture l'import entier (forme exacte exigée dans main.ts)", () => {
    expect("import(`./demo`)".match(RE_DEMO_IMPORT)).toEqual(["import(`./demo`)"]);
    expect('import("./demo/install")'.match(RE_DEMO_IMPORT)).toEqual(['import("./demo/install")']);
  });
});

describe("vite.config.ts résolu", () => {
  it("assetsInlineLimit 0 et pas de polyfill modulepreload", async () => {
    const cfg = await resolveConfig(
      { configFile: join(webDir, "vite.config.ts"), root: webDir },
      "build",
    );
    expect(cfg.build.assetsInlineLimit).toBe(0);
    const mp = cfg.build.modulePreload;
    expect(mp).not.toBe(false);
    expect(typeof mp === "object" && mp.polyfill).toBe(false);
    expect(cfg.build.sourcemap).toBe(false);
  });

  it("production : base /, sortie dist, garde demoGuard, sans demoMeta", async () => {
    const cfg = await resolveConfig({ configFile: join(webDir, "vite.config.ts"), root: webDir }, "build");
    expect(cfg.base).toBe("/");
    expect(cfg.build.outDir).toBe("dist");
    const names = cfg.plugins.map((p) => p.name);
    expect(names).toContain("shh-demo-guard");
    expect(names).not.toContain("shh-demo-meta");
  });

  // Plan du compte, lot 9 : drapeau de construction __COMPTES__, faux par défaut et toujours faux
  // dans la démo (aucun serveur) ; vrai seulement si SHH_SITE_COMPTES=1 au build de production.
  it("__COMPTES__ : false par défaut en production, true avec SHH_SITE_COMPTES=1, toujours dans la démo (compte essayable)", async () => {
    const define = async (mode: string | undefined, env: string | undefined) => {
      const was = process.env.SHH_SITE_COMPTES;
      if (env === undefined) delete process.env.SHH_SITE_COMPTES;
      else process.env.SHH_SITE_COMPTES = env;
      try {
        return (await resolveConfig({ configFile: join(webDir, "vite.config.ts"), root: webDir, mode }, "build")).define?.__COMPTES__;
      } finally {
        if (was === undefined) delete process.env.SHH_SITE_COMPTES;
        else process.env.SHH_SITE_COMPTES = was;
      }
    };
    expect(await define(undefined, undefined)).toBe("false");
    expect(await define(undefined, "0")).toBe("false");
    expect(await define(undefined, "true")).toBe("false");
    expect(await define(undefined, "1")).toBe("true");
    expect(await define("demo", undefined)).toBe("true");
    expect(await define("demo", "1")).toBe("true");
  });

  // Plan du compte, lot 10 : App.svelte ne voit les pages du compte que par routes/compte/pages.ts,
  // remplacé par pages.off.ts (aucun import) sans __COMPTES__ : ni le module de compte ni le moteur
  // du salon n'entrent alors dans le graphe du site.
  it("pages du compte : App.svelte → routes/compte/pages seulement ; pages.off.ts sans __COMPTES__", () => {
    const app = files.find((f) => f.rel === "App.svelte")!.text;
    expect(app).not.toMatch(/\/account\//);
    expect([...app.matchAll(/from\s*"(\.\/routes\/compte\/[^"]*)"/g)].map((m) => m[1])).toEqual(["./routes/compte/pages"]);
    const off = readFileSync(join(srcDir, "routes/compte/pages.off.ts"), "utf8");
    expect(off).not.toMatch(/\bfrom\s*["'`]\.|\bimport\s*\(/); // aucun module du site
    const resolve = (actifs: boolean, source: string, importer: string) =>
      (comptesPages(actifs).resolveId as (this: unknown, s: string, i?: string) => string | null).call({}, source, importer);
    const appPath = join(srcDir, "App.svelte");
    expect(resolve(false, "./routes/compte/pages", appPath)).toBe(join(srcDir, "routes/compte/pages.off.ts"));
    expect(resolve(true, "./routes/compte/pages", appPath)).toBeNull();
    expect(resolve(false, "./routes/compte/pages", join(srcDir, "main.ts"))).toBeNull();
  });

  it("mode demo : base /shhgone/, sortie dist-demo, demoMeta", async () => {
    const cfg = await resolveConfig({ configFile: join(webDir, "vite.config.ts"), root: webDir, mode: "demo" }, "build");
    expect(cfg.base).toBe("/shhgone/");
    expect(cfg.build.outDir).toBe("dist-demo");
    const names = cfg.plugins.map((p) => p.name);
    expect(names).toContain("shh-demo-meta");
    expect(names).not.toContain("shh-demo-guard");
  });

  it("demoGuard fait échouer le build si un module de src/demo/ est dans un morceau", () => {
    const hook = demoGuard().generateBundle as (this: unknown, o: unknown, b: Rollup.OutputBundle) => void;
    const ctx = { error: (m: string) => { throw new Error(m); } };
    const chunk = (ids: string[]) => ({ "a.js": { type: "chunk", modules: Object.fromEntries(ids.map((i) => [i, {}])) } }) as unknown as Rollup.OutputBundle;
    expect(() => hook.call(ctx, {}, chunk(["/w/src/main.ts", "/w/src/app/demo-hooks.ts"]))).not.toThrow();
    expect(() => hook.call(ctx, {}, chunk(["/w/src/main.ts", "/w/src/demo/fake-server.ts"]))).toThrow(/code de démo/);
    expect(() => hook.call(ctx, {}, chunk(["C:\\w\\src\\demo\\install.ts"]))).toThrow(/code de démo/);
  });
});

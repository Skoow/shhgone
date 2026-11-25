// Appel audio et vidéo À TROIS, de bout en bout par l'interface (conception des appels) : vrai binaire Go (SHH_SALONS=1, SHH_COMPTES=1, relais configuré), vrai relais
// TURN de notre image (`shhcheck turn`, deploy/shhcheck/turn.go, construit ici depuis l'arbre :
// exactement celui que compose.yaml lance en production), trois navigateurs Chromium avec micro
// et caméra factices. Prouve : l'appel se lance, les deux autres le voient et le rejoignent,
// chacun reçoit vraiment l'image et le son des autres, TOUT le média passe par le relais (aucune
// connexion directe : paires de candidats « relay » des deux côtés), micro et caméra se coupent,
// raccrocher retire la tuile chez les autres. Rien à installer : Go suffit (déjà exigé par les tests).
// Appels réservés aux offres Plus et Pro : sans pass, « Appel audio » explique
// « Réservé aux offres Plus et Pro » sans rien demander ; A, qui a un pass Plus payé (pass-helpers.ts),
// lance l'appel avec un jeton anonyme (seule requête qui en porte un) ; B et C le rejoignent sans offre.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { siteComptes } from "./comptes-site";
import { axe, capture, expect, test as base } from "./fixtures";
import { passPaye } from "./pass-helpers";

const SHHCHECK = fileURLToPath(new URL("../../deploy/shhcheck", import.meta.url));

/** Adresse IPv4 de la machine hors boucle locale : Chromium ne propose pas de candidat sur 127.0.0.1. */
function adresse(): string | null {
  for (const l of Object.values(networkInterfaces())) for (const a of l ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}
function portLibre(): Promise<number> {
  return new Promise((ok, ko) => {
    const s = createServer();
    s.once("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

type Relais = { url: string; secretFile: string };

const test = base.extend<{ relais: Relais }, { site: string; shhcheck: string }>({
  site: [async ({}, use) => use(await siteComptes()), { scope: "worker", timeout: 360_000 }],
  // Binaire du relais, construit une fois par processus de test depuis deploy/shhcheck.
  shhcheck: [
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), "shh-shhcheck-"));
      const bin = join(dir, "shhcheck");
      execFileSync("go", ["build", "-o", bin, "."], { cwd: SHHCHECK, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0" } });
      try {
        await use(bin);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 300_000 },
  ],
  relais: async ({ shhcheck }, use) => {
    const ip = adresse()!;
    const port = await portLibre();
    const dir = mkdtempSync(join(tmpdir(), "shh-turn-"));
    const secretFile = join(dir, "turn.secret");
    writeFileSync(secretFile, randomBytes(24).toString("hex") + "\n");
    chmodSync(secretFile, 0o600);
    // Adresse de la machine donnée explicitement (elle est privée sur un banc d'essai).
    const proc: ChildProcess = spawn(shhcheck, ["turn"], {
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "", SHH_TURN_SECRET_FILE: secretFile, SHH_TURN_IP: ip, SHH_TURN_PORT: String(port), SHH_TURN_PORTS: "49160-49400" },
    });
    try {
      // Prêt quand il répond en STUN (le contrôle que deploy.sh fait en production).
      await expect.poll(() => {
        try {
          execFileSync(shhcheck, ["stun", `${ip}:${port}`], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      }, { timeout: 15_000 }).toBe(true);
      await use({ url: `turn:${ip}:${port}?transport=udp`, secretFile });
    } finally {
      proc.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  },
  // Paiement activé (bacs à sable, aucun appel sortant) : les appels sont réservés aux offres
  // Plus et Pro ; sans paiement, le serveur ne les propose pas.
  shhServer: async ({ site, relais }, use) =>
    use({
      comptes: { cle: new Uint8Array(randomBytes(32)) },
      paiement: { webhookStripe: "whsec_e2e_appel", ipnNOWPayments: "ipn-e2e-appel" },
      env: { SHH_STATIC_DIR: site, SHH_TURN_URLS: relais.url, SHH_TURN_SECRET_FILE: relais.secretFile },
    }),
});

test.use({
  locale: "fr-FR",
  timezoneId: "Europe/Paris",
  permissions: ["camera", "microphone"],
  // Les options de lancement du projet sont remplacées en bloc : le chemin local du navigateur (playwright.config.ts) est redit.
  launchOptions: { ...(process.env.PW_LOCAL_CHROMIUM === "1" ? { executablePath: "/opt/pw-browsers/chromium" } : {}), args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});
test.skip(({ browserName }) => browserName !== "chromium", "appel.spec.ts : Chromium (micro et caméra factices)");
test.setTimeout(420_000);

const champ = (page: Page, label: string) => page.getByLabel(label, { exact: true }).and(page.locator("input"));
const bouton = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const titre = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const fil = (page: Page) => page.getByRole("log");
const appel = (page: Page) => page.locator("section[data-appel='dans']");
const tuiles = (page: Page) => appel(page).locator("li.tuile");

/** Garde chaque RTCPeerConnection de la page, pour lire ensuite par où passe le média. */
async function espionner(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const w = window as unknown as { __pcs: RTCPeerConnection[]; RTCPeerConnection: typeof RTCPeerConnection };
    w.__pcs = [];
    const Vrai = w.RTCPeerConnection;
    w.RTCPeerConnection = class extends Vrai {
      constructor(c?: RTCConfiguration) {
        super(c);
        w.__pcs.push(this);
      }
    };
  });
}

/** Pour chaque connexion ouverte : types des candidats choisis, octets reçus en audio et en vidéo, politique ICE. */
async function etatDesConnexions(page: Page) {
  return page.evaluate(async () => {
    const w = window as unknown as { __pcs: RTCPeerConnection[] };
    const out: { politique: string | undefined; local: string; distant: string; audio: number; video: number }[] = [];
    for (const pc of w.__pcs) {
      if (pc.connectionState !== "connected") continue;
      const stats = await pc.getStats();
      let local = "";
      let distant = "";
      let audio = 0;
      let video = 0;
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
          local = stats.get(s.localCandidateId)?.candidateType ?? "";
          distant = stats.get(s.remoteCandidateId)?.candidateType ?? "";
        }
        if (s.type === "inbound-rtp" && s.kind === "audio") audio += s.bytesReceived ?? 0;
        if (s.type === "inbound-rtp" && s.kind === "video") video += s.bytesReceived ?? 0;
      });
      out.push({ politique: pc.getConfiguration().iceTransportPolicy, local, distant, audio, video });
    }
    return out;
  });
}

/** Compte par passkey (authentificateur virtuel de Chromium) : pseudo, passkey, clé notée, un groupe retapé. */
async function inscrire(page: Page, origin: string, pseudo: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await page.goto(origin + "/compte/inscription?suite=salon");
  await champ(page, "Pseudo").fill(pseudo);
  await expect(page.locator("[data-dispo]")).toHaveText("Disponible", { timeout: 30_000 });
  await bouton(page, "Créer avec une passkey").or(bouton(page, "Garder le compte sur cet ordinateur")).click();
  await expect(titre(page, "Votre clé de récupération")).toBeVisible({ timeout: 30_000 });
  const cle = (await page.locator("[data-cle] .g").allTextContents()).join("-");
  await bouton(page, "Copier").click(); // « Je l\'ai notée » attend la clé copiée ou téléchargée
  await bouton(page, "Je l\'ai notée").click();
  const label = (await page.locator("label").filter({ hasText: "Tapez le groupe" }).textContent())!;
  await page.getByLabel(label.trim(), { exact: true }).fill(cle.split("-")[Number(/n°\s*(\d)/u.exec(label)![1]) - 1]!);
  await bouton(page, "Terminer").click();
  await expect(titre(page, "Compte créé.")).toBeVisible({ timeout: 30_000 });
}

async function inviter(browser: Browser, use: object, lien: string, mdp: string, pseudo: string): Promise<{ ctx: BrowserContext; page: Page; erreurs: string[] }> {
  const ctx = await browser.newContext({ ...use, locale: "fr-FR", timezoneId: "Europe/Paris", permissions: ["camera", "microphone"] });
  await espionner(ctx);
  const page = await ctx.newPage();
  const erreurs: string[] = [];
  page.on("pageerror", (e) => erreurs.push(e.message));
  page.on("console", (m) => /Refused to|Content Security Policy/.test(m.text()) && erreurs.push(m.text()));
  await page.goto(lien);
  await champ(page, "Mot de passe du salon").fill(mdp);
  await bouton(page, "Continuer").click();
  await expect(titre(page, "Un salon qui s'efface")).toBeVisible({ timeout: 30_000 });
  await champ(page, "Pseudonyme pour ce salon").fill(pseudo);
  await bouton(page, "Entrer dans le salon").click();
  await expect(fil(page)).toBeVisible();
  return { ctx, page, erreurs };
}

test("appel vidéo à trois : tout passe par le relais, qui parle, micro, caméra, raccrocher, onglet fermé", async ({ page, context, shh, browser }, info) => {
  const r = randomBytes(4).toString("hex");
  await espionner(context);

  // --- A range un pass Plus payé sur son appareil, crée son compte, puis le salon, et y entre ----------
  // (Le pass est d'abord : il appartient à l'appareil, pas au compte, et la session du compte ne
  // survit pas aux pages chargées par passPaye.)
  await passPaye(page, shh);
  await inscrire(page, shh.origin, `Lea${r.slice(0, 4)}`);
  await bouton(page, "Continuer").click();
  await bouton(page, "Créer le salon").click();
  await expect(titre(page, "Salon prêt")).toBeVisible({ timeout: 60_000 });
  // Historique désactivé par défaut, même avec un compte : le lien de gestion est
  // montré d'emblée, pour être gardé à la main.
  await expect(page.locator("[data-manage]")).toContainText("Il n'est pas gardé dans l'historique de cet appareil");
  await expect(bouton(page, "Afficher le lien de gestion")).toHaveCount(0);
  const lien =(await page.locator(".cf").filter({ hasText: "Lien d'invitation" }).locator(".val").textContent())!.trim();
  const mdp = (await page.locator(".cf").filter({ hasText: "Mot de passe" }).locator(".val").textContent())!.trim();
  await bouton(page, "Entrer dans le salon").click();
  await expect(champ(page, "Pseudonyme pour ce salon")).toHaveValue(`Lea${r.slice(0, 4)}`); // pseudo du compte
  await bouton(page, "Entrer dans le salon").click();
  await expect(fil(page)).toBeVisible();

  const b = await inviter(browser as Browser, info.project.use, lien, mdp, `Hugo${r.slice(4, 8)}`);
  const c = await inviter(browser as Browser, info.project.use, lien, mdp, `Nora${r.slice(2, 6)}`);
  try {
    // Les trois sont dans le groupe chiffré : un message de A arrive chez B et C.
    await page.getByLabel("Message", { exact: true }).fill(`Avant l'appel ${r}`);
    await page.getByRole("region", { name: "Conversation", exact: true }).getByRole("button", { name: "Envoyer", exact: true }).click();
    for (const p of [b.page, c.page]) await expect(fil(p).getByText(`Avant l'appel ${r}`, { exact: true })).toBeVisible({ timeout: 60_000 });

    // --- Demandes d'identifiants du relais, sur les trois pages : qui porte un jeton anonyme ? -------
    const demandes: { qui: string; jeton: boolean }[] = [];
    for (const [qui, p] of [["A", page], ["B", b.page], ["C", c.page]] as const)
      p.on("request", (q) => {
        if (new URL(q.url()).pathname === "/api/salons/appel") demandes.push({ qui, jeton: /^PrivateToken token=[A-Za-z0-9_-]{472}$/.test(q.headers()["authorization"] ?? "") });
      });

    // --- Badge « Plus · Pro » sur les boutons d'appel, sans pass sur l'appareil (B, C), pas chez A ---
    for (const p of [b.page, c.page]) {
      await expect(p.locator("[data-appels] .badge")).toHaveText("Plus · Pro");
      await expect(bouton(p, "Appel audio")).toHaveAccessibleDescription("Réservé aux offres Plus et Pro.");
    }
    await expect(page.locator("[data-appels] .badge")).toHaveCount(0, { timeout: 30_000 });
    await expect(bouton(page, "Appel vidéo")).toHaveAccessibleDescription("");
    await capture(b.page, "appel-badge");

    // --- B, sans offre, touche « Appel audio » : l'explication, sans micro ni requête ---------------
    await bouton(b.page, "Appel audio").click();
    const reserve = b.page.locator("[data-appel-reserve]");
    await expect(reserve).toContainText("Réservé aux offres Plus et Pro.");
    await expect(reserve.getByRole("link", { name: "Voir les offres", exact: true })).toHaveAttribute("href", "/offres");
    await expect(appel(b.page)).toHaveCount(0);
    expect(await axe(b.page)).toEqual([]);
    await capture(b.page, "appel-reserve");
    expect(demandes).toEqual([]);

    // --- A (pass Plus) lance un appel vidéo ; B et C le voient et le rejoignent sans offre ----------
    await bouton(page, "Appel vidéo").click();
    await expect(appel(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("En attente des autres participants…")).toBeVisible();
    for (const p of [b.page, c.page]) await expect(p.getByText("Appel en cours (1)")).toBeVisible({ timeout: 30_000 });
    // L'appel sonne chez B : l'explication s'efface, « Rejoindre » est ouvert à tous.
    await expect(reserve).toHaveCount(0);
    // A : une demande sans jeton (appels fermés, 402), puis la même avec un jeton anonyme.
    expect(demandes).toEqual([{ qui: "A", jeton: false }, { qui: "A", jeton: true }]);
    await capture(b.page, "appel-bandeau");
    await bouton(b.page, "Rejoindre avec la caméra").click();
    await expect(appel(b.page)).toBeVisible({ timeout: 30_000 });
    await expect(c.page.getByText("Appel en cours (2)")).toBeVisible({ timeout: 30_000 });
    await bouton(c.page, "Rejoindre").click(); // sans caméra
    await expect(appel(c.page)).toBeVisible({ timeout: 30_000 });

    // Trois tuiles partout, les deux autres « liées ».
    for (const p of [page, b.page, c.page]) {
      await expect(tuiles(p)).toHaveCount(3, { timeout: 60_000 });
      await expect(tuiles(p).and(p.locator("[data-lien='lie']"))).toHaveCount(2, { timeout: 90_000 });
    }
    // B et C sont entrés sans jeton : les appels sont ouverts pour tout le salon ; un seul jeton dépensé.
    expect(demandes.filter((d) => d.qui !== "A")).toEqual([{ qui: "B", jeton: false }, { qui: "C", jeton: false }]);
    expect(demandes.filter((d) => d.jeton)).toHaveLength(1);
    // Le panneau d'appel reste collé sous la barre du site, même la page défilée.
    await expect(appel(page)).toBeInViewport();
    await capture(page, "appel-a-trois");
    expect(await axe(page)).toEqual([]);

    // --- Le média arrive vraiment, et seulement par le relais ----------------------------------------
    await expect
      .poll(
        async () => {
          const e = await etatDesConnexions(page);
          return e.length === 2 && e.every((x) => x.audio > 0) && e.some((x) => x.video > 0);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    for (const p of [page, b.page, c.page]) {
      const e = await etatDesConnexions(p);
      expect(e.length).toBe(2);
      for (const x of e) expect([x.politique, x.local, x.distant]).toEqual(["relay", "relay", "relay"]);
    }
    // A voit l'image de B (caméra allumée) : la vidéo distante avance.
    const videoDeB = tuiles(page).filter({ hasText: `Hugo${r.slice(4, 8)}` }).locator("video");
    await expect.poll(() => videoDeB.evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.currentTime > 0), { timeout: 30_000 }).toBe(true);
    // Qui parle : le son factice de Chromium (bips) allume la tuile de qui l'envoie.
    await expect.poll(() => tuiles(page).and(page.locator("[data-parle]")).count(), { timeout: 30_000 }).toBeGreaterThan(0);
    // Un seul appareil photo factice : pas de bouton pour changer de caméra.
    await expect(bouton(b.page, "Changer de caméra (face ou dos)")).toHaveCount(0);
    // C est entré sans caméra : pas d'image, son initiale à la place.
    await expect(tuiles(page).filter({ hasText: `Nora${r.slice(2, 6)}` }).locator(".pastille")).toBeVisible();

    // --- Micro et caméra ---------------------------------------------------------------------------
    await bouton(b.page, "Couper le micro").click();
    await expect(bouton(b.page, "Réactiver le micro")).toBeVisible();
    await bouton(b.page, "Éteindre la caméra").click();
    await expect(tuiles(page).filter({ hasText: `Hugo${r.slice(4, 8)}` }).locator(".pastille")).toBeVisible({ timeout: 30_000 });
    await bouton(c.page, "Allumer la caméra").click();
    await expect(tuiles(page).filter({ hasText: `Nora${r.slice(2, 6)}` }).locator(".pastille")).toHaveCount(0, { timeout: 30_000 });

    // --- Raccrocher -----------------------------------------------------------------------------------
    await bouton(page, "Raccrocher").click();
    await expect(appel(page)).toHaveCount(0);
    await expect(page.getByText("Appel en cours (2)")).toBeVisible({ timeout: 30_000 });
    for (const p of [b.page, c.page]) await expect(tuiles(p)).toHaveCount(2, { timeout: 30_000 });
    // Onglet de C fermé sans raccrocher : B le voit partir tout de suite, sans
    // attendre les 40 s d'absence.
    await c.page.close();
    await expect(tuiles(b.page)).toHaveCount(1, { timeout: 10_000 });
    await bouton(b.page, "Raccrocher").click();
    // Plus personne : le bandeau disparaît, les boutons d'appel reviennent.
    await expect(bouton(page, "Appel audio")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Appel en cours/)).toHaveCount(0);

    expect(b.erreurs).toEqual([]);
    expect(c.erreurs).toEqual([]);
  } finally {
    await b.ctx.close();
    await c.ctx.close();
  }
});

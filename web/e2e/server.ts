// Lance le vrai binaire `server/shhdrop serve` pour les tests d'intégration :
// dossier de données temporaire, port libre (SHH_LISTEN=127.0.0.1:0, lu sur stdout ; salon ou
// compte activé : port choisi avant, voir StartOpts.salons et StartOpts.comptes),
// stdout et stderr capturés en octets bruts (fouillés par le test « le serveur ne voit rien »).
// SHH_STORAGE_MAX = 4 Gio : le serveur refuse de démarrer si le plafond dépasse l'espace
// disque libre moins 1 Gio (audit F6), et le défaut de 200 Gio dépasse souvent un poste de test.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BINARY = fileURLToPath(new URL("../../server/shhdrop", import.meta.url));

export type TestServer = {
  origin: string;
  /** Tableau de bord d'administration (StartOpts.comptes.admin) : origine de son écouteur. */
  adminOrigin?: string;
  pid: number;
  dataDir: string;
  stdout(): Buffer;
  stderr(): Buffer;
  /** Arrête le processus (SIGTERM, puis SIGKILL après 5 s) ; garde le dossier de données. */
  stop(): Promise<void>;
  /** stop() puis suppression du dossier de données. */
  dispose(): Promise<void>;
};

/** Échec de démarrage : le processus a été tué et son dossier supprimé. */
export class ServerStartError extends Error {
  constructor(
    msg: string,
    readonly dataDir: string,
    readonly stdout: Buffer,
    readonly stderr: Buffer,
  ) {
    super(msg);
  }
}

export type StartOpts = {
  /** Variables ajoutées ou remplacées (une valeur undefined retire la variable). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Binaire à lancer (BINARY par défaut). */
  binary?: string;
  /**
   * Salon activé (SHH_SALONS=1) : SHH_ORIGIN est obligatoire et doit être l'origine exacte
   * que les clients envoient (en-tête Origin du WebSocket) ; le port est donc choisi avant le
   * lancement (port libre, puis SHH_LISTEN=127.0.0.1:<port>, SHH_ORIGIN=http://127.0.0.1:<port>).
   */
  salons?: boolean;
  /**
   * Compte activé (SHH_COMPTES=1, salon compris ; compte par passkey, sans e-mail) : K_serveur
   * est écrite dans un dossier à part (hors du dossier de données, 0400), supprimé par
   * dispose(). L'origine est alors http://localhost:<port> : c'est le rp.id des passkeys, et
   * les navigateurs refusent une adresse IP comme rp.id (conception du compte par passkey §17).
   * `admin` : jeton du tableau de bord (SHH_ADMIN_TOKEN, développement local), écouteur sur un
   * second port libre.
   */
  comptes?: { cle: Uint8Array; admin?: string };
  /**
   * Paiement activé (SHH_PAIEMENT=1, bacs à sable, conception du paiement §10) avec Stripe et
   * NOWPayments : clés d'essai et secrets de webhook écrits dans un dossier à part (0400),
   * supprimé par dispose(). Les secrets de webhook sont rendus (webhookStripe, ipnNOWPayments)
   * pour signer de faux webhooks. Aucun appel sortant tant qu'aucune commande n'atteint le serveur.
   */
  paiement?: { webhookStripe: string; ipnNOWPayments: string };
};

/** Port TCP libre sur 127.0.0.1 (ouvert puis refermé : une course est possible, sans conséquence en test). */
async function portLibre(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok, ko) => s.listen(0, "127.0.0.1", ok).once("error", ko));
  const { port } = s.address() as { port: number };
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

export async function startServer(opts: StartOpts = {}): Promise<TestServer> {
  const bin = opts.binary ?? BINARY;
  if (!existsSync(bin)) throw new Error(`binaire absent : ${bin} (lancer make test-e2e)`);
  let salons: Record<string, string> = {};
  let secrets: string | undefined;
  let adminOrigin: string | undefined;
  if (opts.salons || opts.comptes || opts.paiement) {
    const port = await portLibre();
    const hote = opts.comptes ? "localhost" : "127.0.0.1";
    salons = { SHH_LISTEN: `127.0.0.1:${port}`, SHH_ORIGIN: `http://${hote}:${port}` };
    // Paiement seul : SHH_ORIGIN (adresses de retour) sans le salon.
    if (opts.salons || opts.comptes) salons.SHH_SALONS = "1";
  }
  if (opts.comptes) {
    const c = opts.comptes;
    secrets = mkdtempSync(join(tmpdir(), "shh-e2e-secrets-"));
    const cle = join(secrets, "cle");
    writeFileSync(cle, c.cle);
    chmodSync(cle, 0o400);
    Object.assign(salons, { SHH_COMPTES: "1", SHH_COMPTES_CLE_FILE: cle });
    if (c.admin !== undefined) {
      const p = await portLibre();
      adminOrigin = `http://127.0.0.1:${p}`;
      Object.assign(salons, { SHH_ADMIN_LISTEN: `127.0.0.1:${p}`, SHH_ADMIN_TOKEN: c.admin });
    }
  }
  if (opts.paiement) {
    secrets ??= mkdtempSync(join(tmpdir(), "shh-e2e-secrets-"));
    const f = (nom: string, v: string) => {
      const p = join(secrets!, nom);
      writeFileSync(p, v);
      chmodSync(p, 0o400);
      return p;
    };
    Object.assign(salons, {
      SHH_PAIEMENT: "1",
      SHH_PAIEMENT_ESSAI: "1",
      SHH_TVA: "oss",
      SHH_STRIPE_CLE_FILE: f("stripe", "sk_test_e2e"),
      SHH_STRIPE_WEBHOOK_FILE: f("stripe_webhook", opts.paiement.webhookStripe),
      SHH_NOWPAYMENTS_CLE_FILE: f("np", "np-e2e"),
      SHH_NOWPAYMENTS_IPN_FILE: f("np_ipn", opts.paiement.ipnNOWPayments),
    });
  }
  const retirerSecrets = () => {
    if (secrets) rmSync(secrets, { recursive: true, force: true });
  };
  const dataDir = mkdtempSync(join(tmpdir(), "shh-e2e-"));
  const env: Record<string, string> = {};
  // SHH_DISABLE_DUMPABLE_HARDENING : le test « le serveur ne voit rien » lit /proc/<pid>/mem du
  // serveur ; PR_SET_DUMPABLE(0) (audit adverse, Z2) l'en empêcherait. Éteint pour les tests
  // seulement ; la production garde le durcissement (compose.yaml ne pose pas cette variable).
  for (const [k, v] of Object.entries({ PATH: process.env.PATH ?? "", SHH_DATA_DIR: dataDir, SHH_LISTEN: "127.0.0.1:0", SHH_STORAGE_MAX: "4294967296", SHH_DISABLE_DUMPABLE_HARDENING: "1", ...salons, ...opts.env })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn(bin, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  proc.stdout.on("data", (b: Buffer) => out.push(b));
  proc.stderr.on("data", (b: Buffer) => err.push(b));
  // « close » : processus terminé ET flux stdout/stderr entièrement lus.
  const closed = new Promise<void>((res) => proc.once("close", () => res()));
  const alive = () => proc.exitCode === null && proc.signalCode === null;

  let addr: string;
  try {
    addr = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pas de SHH_LISTENING à temps")), opts.timeoutMs ?? 10_000);
      proc.stdout.on("data", () => {
        const m = /^SHH_LISTENING (\S+)\n/.exec(Buffer.concat(out).toString("utf8"));
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`serveur arrêté avant l'écoute (code ${code})`));
      });
    });
  } catch (e) {
    if (alive()) proc.kill("SIGKILL");
    await closed;
    rmSync(dataDir, { recursive: true, force: true });
    retirerSecrets();
    const stderr = Buffer.concat(err);
    throw new ServerStartError(`${(e as Error).message} : ${stderr.toString("utf8")}`, dataDir, Buffer.concat(out), stderr);
  }

  const stop = async () => {
    if (alive()) {
      proc.kill("SIGTERM");
      const t = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      await closed;
      clearTimeout(t);
    }
    await closed;
  };
  return {
    origin: `http://${addr}`,
    adminOrigin,
    pid: proc.pid!,
    dataDir,
    stdout: () => Buffer.concat(out),
    stderr: () => Buffer.concat(err),
    stop,
    async dispose() {
      await stop();
      rmSync(dataDir, { recursive: true, force: true });
      retirerSecrets();
    },
  };
}

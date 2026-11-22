// OBSOLÈTE depuis le 22 novembre (compte par passkey, plus aucun e-mail) : gardé seulement pour que
// les parcours ui-e2e du compte par e-mail (ui-e2e/compte.spec.ts, salon.spec.ts) compilent encore
// jusqu'à leur réécriture (lot T1) ; le serveur refuse désormais toute variable SHH_SMTP_*.
// Faux serveur SMTP pour les tests de bout en bout du compte (plan du compte, lot 16) : boucle
// locale, texte clair (le serveur ne l'accepte que vers 127.0.0.1, config.comptesFromEnv),
// AUTH PLAIN annoncée (net/smtp n'envoie le mot de passe hors TLS que vers la boucle locale).
// Garde chaque message reçu (enveloppe, DATA après retrait du bourrage de points) et la
// transcription brute de chaque session, que le test « le serveur ne voit rien » fouille.
import { createServer, type Server, type Socket } from "node:net";

export type Courriel = {
  /** MAIL FROM et RCPT TO, tels que reçus (sans chevrons). */
  de: string;
  a: string[];
  /** Ligne AUTH PLAIN décodée : « \0utilisateur\0mot de passe ». */
  auth: string;
  /** Nom annoncé par EHLO ou HELO. */
  ehlo: string;
  /** Message entier (en-têtes et corps, CRLF final compris), sans la ligne du point final. */
  data: Buffer;
};

export type FauxSMTP = {
  port: number;
  recus: Courriel[];
  /** Tout ce que le client a écrit, toutes sessions confondues. */
  transcription(): Buffer;
  /** Attend le n-ième message (compté depuis 1), 15 s au plus. */
  attendre(n: number): Promise<Courriel>;
  fermer(): Promise<void>;
};

export async function demarrerSMTP(): Promise<FauxSMTP> {
  const recus: Courriel[] = [];
  const brut: Buffer[] = [];
  const attentes: { n: number; ok: (c: Courriel) => void }[] = [];
  const sockets = new Set<Socket>();
  const reveiller = () => {
    for (const a of [...attentes]) {
      const c = recus[a.n - 1];
      if (c) {
        attentes.splice(attentes.indexOf(a), 1);
        a.ok(c);
      }
    }
  };
  const srv: Server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
    let tampon = Buffer.alloc(0);
    let enData = false;
    let cour: Courriel = { de: "", a: [], auth: "", ehlo: "", data: Buffer.alloc(0) };
    const ecrire = (l: string) => s.write(l + "\r\n");
    ecrire("220 127.0.0.1 ESMTP faux");
    s.on("data", (b: Buffer) => {
      brut.push(Buffer.from(b));
      tampon = Buffer.concat([tampon, b]);
      for (;;) {
        if (enData) {
          const fin = tampon.indexOf("\r\n.\r\n");
          if (fin < 0) return;
          const lignes = tampon.subarray(0, fin + 2).toString("latin1").split("\r\n");
          cour.data = Buffer.from(lignes.map((l) => (l.startsWith(".") ? l.slice(1) : l)).join("\r\n"), "latin1");
          tampon = tampon.subarray(fin + 5);
          enData = false;
          recus.push(cour);
          cour = { de: "", a: [], auth: cour.auth, ehlo: cour.ehlo, data: Buffer.alloc(0) };
          ecrire("250 OK");
          reveiller();
          continue;
        }
        const i = tampon.indexOf("\r\n");
        if (i < 0) return;
        const ligne = tampon.subarray(0, i).toString("latin1");
        tampon = tampon.subarray(i + 2);
        const cmd = ligne.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") {
          cour.ehlo = ligne.slice(5);
          s.write("250-127.0.0.1\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        } else if (cmd === "AUTH") {
          const p = ligne.split(" ");
          cour.auth = Buffer.from(p[2] ?? "", "base64").toString("utf8");
          ecrire("235 2.7.0 OK");
        } else if (cmd === "MAIL") {
          cour.de = /<([^>]*)>/.exec(ligne)?.[1] ?? "";
          ecrire("250 OK");
        } else if (cmd === "RCPT") {
          cour.a.push(/<([^>]*)>/.exec(ligne)?.[1] ?? "");
          ecrire("250 OK");
        } else if (cmd === "DATA") {
          enData = true;
          ecrire("354 suite");
        } else if (cmd === "QUIT") {
          ecrire("221 au revoir");
          s.end();
        } else if (cmd === "RSET" || cmd === "NOOP") {
          ecrire("250 OK");
        } else {
          ecrire("502 inconnu");
        }
      }
    });
  });
  await new Promise<void>((ok, ko) => srv.listen(0, "127.0.0.1", ok).once("error", ko));
  const { port } = srv.address() as { port: number };
  return {
    port,
    recus,
    transcription: () => Buffer.concat(brut),
    attendre: (n) =>
      new Promise<Courriel>((ok, ko) => {
        const t = setTimeout(() => ko(new Error(`faux SMTP : message ${n} non reçu`)), 15_000);
        attentes.push({
          n,
          ok: (c) => {
            clearTimeout(t);
            ok(c);
          },
        });
        reveiller();
      }),
    async fermer() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => srv.close(() => ok()));
    },
  };
}

/** Décodage quoted-printable (RFC 2045 §6.7) du corps des e-mails du serveur. */
export function qp(s: string): Buffer {
  return Buffer.from(
    s.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
    "latin1",
  );
}

/**
 * Code à 6 chiffres d'un e-mail du serveur (« Votre code : 123 456 », conception du compte §21.3),
 * avec son destinataire. Le modèle exact de l'e-mail est vérifié par compte-sees-nothing.test.ts.
 */
export function codeDuCourriel(m: Courriel): { a: string[]; code: string } {
  const t = m.data.toString("latin1");
  const corps = qp(t.slice(t.indexOf("\r\n\r\n") + 4)).toString("utf8");
  const c = /^Votre code : (\d{3}) (\d{3})\r\n/.exec(corps);
  if (!c) throw new Error("faux SMTP : aucun code dans l'e-mail reçu");
  return { a: m.a, code: c[1]! + c[2]! };
}

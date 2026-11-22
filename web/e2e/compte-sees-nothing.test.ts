// « Le serveur ne voit rien », compte (conception du compte par passkey §14) — CE TEST BLOQUE
// TOUTE MISE EN LIGNE, et toute activation de SHH_COMPTES=1.
// Lot S2 (retrait du compte par e-mail) : version réduite, refaite avec les cérémonies WebAuthn
// et la clé de récupération aux lots suivants. Ici : le vrai binaire démarre avec SHH_COMPTES=1
// sans aucune variable d'e-mail ; une ancienne variable SHH_SMTP_* ou SHH_MAIL_FROM fait refuser
// le démarrage ; les routes du compte par e-mail ont disparu (404 uniforme) ; une clé de
// récupération inconnue reçoit « identifiants » ; rien de la requête n'est gardé.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { b64u } from "../src/engine/pure";
import { needle, scanDir } from "./scan";
import { ServerStartError, startServer, type TestServer } from "./server";

const RETIREES = [
  "inscription/renvoyer", "connexion", "connexion/totp", "reauth", "oubli/debut", "oubli/renvoyer", "oubli/verifier",
  "oubli/fin", "mdp", "email/debut", "email/renvoyer", "email/fin", "totp/debut", "totp/fin", "totp/retirer",
  "totp/annuler-retrait",
];

describe("le serveur ne voit rien : compte sans e-mail (lot S2)", () => {
  let srv: TestServer;
  const aR = new Uint8Array(randomBytes(32));
  beforeAll(async () => {
    srv = await startServer({ comptes: { cle: new Uint8Array(randomBytes(32)) } });
  });
  afterAll(async () => {
    await srv?.dispose();
  });

  it("refuse de démarrer avec une ancienne variable d'e-mail", async () => {
    for (const k of ["SHH_SMTP_HOST", "SHH_SMTP_PASSWORD_FILE", "SHH_MAIL_FROM"]) {
      const e = await startServer({ comptes: { cle: new Uint8Array(randomBytes(32)) }, env: { [k]: "x" } }).then(
        async (s) => {
          await s.dispose();
          return undefined;
        },
        (err: unknown) => err,
      );
      expect(e, k).toBeInstanceOf(ServerStartError);
      expect(String((e as ServerStartError).stderr ?? e), k).toContain(k);
    }
  });

  it("les routes du compte par e-mail répondent comme une route inconnue", async () => {
    const ref = await fetch(`${srv.origin}/api/inconnue`);
    const refCorps = await ref.text();
    for (const r of RETIREES) {
      const w = await fetch(`${srv.origin}/api/compte/${r}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      expect(w.status, r).toBe(ref.status);
      expect(await w.text(), r).toBe(refCorps);
    }
  });

  it("clé de récupération inconnue : identifiants, rien de gardé", async () => {
    const w = await fetch(`${srv.origin}/api/compte/recup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a_r: b64u(aR), persistante: false, etiquette: "" }),
    });
    expect(w.status).toBe(403);
    expect(await w.text()).toBe('{"error":"identifiants"}');
    const n = [needle("A_r", aR as Uint8Array<ArrayBuffer>)];
    expect(scanDir(srv.dataDir, n)).toEqual([]);
    expect(srv.stdout().includes(Buffer.from(b64u(aR)))).toBe(false);
    expect(srv.stderr().includes(Buffer.from(b64u(aR)))).toBe(false);
  });
});

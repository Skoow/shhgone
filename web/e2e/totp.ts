// OBSOLÈTE depuis le 22 novembre (compte par passkey, plus aucun e-mail) : gardé seulement pour que
// les parcours ui-e2e du compte par e-mail (ui-e2e/compte.spec.ts, salon.spec.ts) compilent encore
// jusqu'à leur réécriture (lot T1) ; le serveur refuse désormais toute variable SHH_SMTP_*.
// Application d'authentification jouée par les tests (RFC 6238 : HMAC-SHA-1 de node:crypto,
// 6 chiffres, pas de 30 s ; clé en base32 RFC 4648). Partagée par compte-sees-nothing.test.ts
// (vitest) et ui-e2e/compte.spec.ts (Playwright).
import { createHmac } from "node:crypto";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Base32 (RFC 4648, majuscules, sans remplissage) → octets ; espaces ignorés (clé affichée par groupes). */
export function base32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let v = 0;
  const out: number[] = [];
  for (const c of s.replace(/\s+/g, "")) {
    const i = A.indexOf(c);
    if (i < 0) throw new Error(`base32 : caractère inattendu « ${c} »`);
    v = (v << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Code TOTP du pas `pas` (RFC 6238 §4, troncature dynamique de RFC 4226 §5.3). */
export function codeTotp(secret: string, pas: number): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(pas));
  const d = createHmac("sha1", base32(secret)).update(c).digest();
  const o = d[19]! & 15;
  return String((d.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * Générateur de codes jamais servis : le serveur refuse un pas déjà accepté et tolère ±1 pas.
 * Chaque appel rend le code du plus petit pas encore inutilisé parmi (maintenant − 1 … + 1), loin
 * d'une frontière de pas ; sinon il attend le pas suivant. Un générateur par compte (pas déjà vus).
 */
export function horlogeTotp(): (secret: string) => Promise<string> {
  let dernierPas = 0;
  return async (secret) => {
    for (;;) {
      const t = Date.now() / 1000;
      if (30 - (t % 30) < 2) {
        await dormir(2500); // loin d'une frontière de pas
        continue;
      }
      const maintenant = Math.floor(t / 30);
      const pas = Math.max(dernierPas + 1, maintenant - 1);
      if (pas <= maintenant + 1) {
        dernierPas = pas;
        return codeTotp(secret, pas);
      }
      await dormir((30 - (t % 30)) * 1000 + 500);
    }
  };
}

// Authentificateur logiciel des e2e du compte par passkey (écrit pour « le serveur ne voit rien »). Il joue navigator.credentials
// (create, get) et l'authentificateur sous Node : il lit les options JSON de WebAuthn niveau 3
// que rend le serveur et rend les réponses JSON telles que le navigateur les donne au script
// (PublicKeyCredential.toJSON) : la sortie PRF y est, dans clientExtensionResults.prf.results,
// comme chez un vrai navigateur ; le test les passe par sansSortiePrf du site
// (web/src/account/webauthn.ts) avant l'envoi, et la sortie PRF est aussi rendue à part (repère).
// ES256 (P-256) et EdDSA (Ed25519) de node:crypto ; attestation « none » ; AAGUID aléatoire
// (repère : le serveur ne doit jamais le garder).
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

type Bytes = Uint8Array<ArrayBuffer>;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url")) as Bytes;
const sha256 = (...xs: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const x of xs) h.update(x);
  return new Uint8Array(h.digest()) as Bytes;
};
const cat = (...xs: Uint8Array[]) => new Uint8Array(Buffer.concat(xs.map((x) => Buffer.from(x)))) as Bytes;

// --- CBOR minimal (RFC 8949) : entiers, octets, textes, tableaux, tables à clés entières ou texte.
type Cbor = number | Uint8Array | string | Cbor[] | { paires: [number | string, Cbor][] };
function tete(majeur: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((majeur << 5) | n);
  if (n < 256) return Uint8Array.of((majeur << 5) | 24, n);
  if (n < 65536) return Uint8Array.of((majeur << 5) | 25, n >> 8, n & 255);
  return Uint8Array.of((majeur << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
}
export function cbor(v: Cbor): Bytes {
  if (typeof v === "number") return cat(v >= 0 ? tete(0, v) : tete(1, -1 - v));
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return cat(tete(3, b.length), b);
  }
  if (v instanceof Uint8Array) return cat(tete(2, v.length), v);
  if (Array.isArray(v)) return cat(tete(4, v.length), ...v.map(cbor));
  return cat(tete(5, v.paires.length), ...v.paires.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

export type Alg = -7 | -8;

export type Passkey = {
  id: Bytes;
  userHandle: Bytes;
  rpId: string;
  alg: Alg;
  cle: KeyObject;
  cose: Bytes;
  /** Secret hmac-secret de la passkey (null : passkey sans PRF). */
  prf: Bytes | null;
  compteur: number;
};

export class Authentificateur {
  readonly aaguid: Bytes = new Uint8Array(randomBytes(16)) as Bytes;
  readonly passkeys: Passkey[] = [];
  constructor(
    readonly alg: Alg = -7,
    readonly avecPrf = true,
  ) {}

  #cle(): { cle: KeyObject; cose: Bytes } {
    if (this.alg === -7) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const j = publicKey.export({ format: "jwk" }) as { x: string; y: string };
      return { cle: privateKey, cose: cbor({ paires: [[1, 2], [3, -7], [-1, 1], [-2, unb64u(j.x)], [-3, unb64u(j.y)]] }) };
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const j = publicKey.export({ format: "jwk" }) as { x: string };
    return { cle: privateKey, cose: cbor({ paires: [[1, 1], [3, -8], [-1, 6], [-2, unb64u(j.x)]] }) };
  }

  #signer(p: Passkey, donnees: Uint8Array): Bytes {
    return new Uint8Array(p.alg === -7 ? sign("sha256", donnees, { key: p.cle, dsaEncoding: "der" }) : sign(null, donnees, p.cle)) as Bytes;
  }

  /** Sortie PRF de p pour l'entrée e (hmac-secret sur SHA-256(« WebAuthn PRF » ‖ 0x00 ‖ e)). */
  sortie(p: Passkey, e: Uint8Array): Bytes | null {
    if (!p.prf) return null;
    return new Uint8Array(createHmac("sha256", p.prf).update(sha256(new TextEncoder().encode("WebAuthn PRF\0"), e)).digest()) as Bytes;
  }

  /** navigator.credentials.create : réponse (sans sortie PRF), passkey, sortie PRF à part. */
  creer(options: Record<string, any>, origine: string): { credential: Record<string, unknown>; passkey: Passkey; sortie: Bytes | null } {
    const { cle, cose } = this.#cle();
    const p: Passkey = {
      id: new Uint8Array(randomBytes(32)) as Bytes,
      userHandle: unb64u(options.user.id),
      rpId: options.rp.id,
      alg: this.alg,
      cle,
      cose,
      prf: this.avecPrf ? (new Uint8Array(randomBytes(32)) as Bytes) : null,
      compteur: 0,
    };
    const idLen = Uint8Array.of(p.id.length >> 8, p.id.length & 255);
    const authData = cat(sha256(new TextEncoder().encode(p.rpId)), Uint8Array.of(0x01 | 0x04 | 0x08 | 0x10 | 0x40), new Uint8Array(4), this.aaguid, idLen, p.id, cose);
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: origine, crossOrigin: false }));
    const att = cbor({ paires: [["fmt", "none"], ["attStmt", { paires: [] }], ["authData", authData]] });
    this.passkeys.push(p);
    const e = options.extensions?.prf?.eval?.first as string | undefined;
    const sortie = e === undefined ? null : this.sortie(p, unb64u(e));
    return {
      credential: {
        id: b64u(p.id),
        rawId: b64u(p.id),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ["internal", "hybrid"] },
        clientExtensionResults: { credProps: { rk: true }, prf: { enabled: this.avecPrf, ...(sortie ? { results: { first: b64u(sortie) } } : {}) } },
      },
      passkey: p,
      sortie,
    };
  }

  /** navigator.credentials.get : réponse (sans sortie PRF) et sortie PRF à part. */
  obtenir(options: Record<string, any>, origine: string, p: Passkey): { credential: Record<string, unknown>; sortie: Bytes | null } {
    p.compteur++;
    const n = p.compteur;
    const authData = cat(sha256(new TextEncoder().encode(options.rpId)), Uint8Array.of(0x01 | 0x04 | 0x08 | 0x10), Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255));
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: origine, crossOrigin: false }));
    const sig = this.#signer(p, cat(authData, sha256(clientData)));
    const e = options.extensions?.prf?.eval?.first as string | undefined;
    const sortie = e === undefined ? null : this.sortie(p, unb64u(e));
    return {
      credential: {
        id: b64u(p.id),
        rawId: b64u(p.id),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle: b64u(p.userHandle) },
        clientExtensionResults: sortie ? { prf: { results: { first: b64u(sortie) } } } : {},
      },
      sortie,
    };
  }
}

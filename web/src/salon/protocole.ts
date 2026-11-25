// Enregistrements du WebSocket du salon (docs/conception/specs/2026-11-11-salon-v3-design.md
// §17) : lecture des enregistrements du
// serveur, taille exacte par type, et construction des messages du client. Pur : aucun réseau,
// aucun moteur. Entiers gros-boutistes ; un enregistrement de taille inexacte ou de type
// inconnu est refusé (null) : le client le note et l'ignore, il ne devine jamais.

/** Taille d'une trame (moteur : `TAILLE_TRAME`). */
export const TAILLE_TRAME = 4140;
/** `depuis` d'une reprise (nouvelle identité, aucun rattrapage). */
export const DEPUIS_REPRISE = 0xffffffffffffffffn;

/** Enregistrement du serveur, lu. `seq` : rang (pris ou porté, selon le type). */
export type Enregistrement =
  | { type: 0x01; seq: number; siege: number; recuMs: number; trame: Uint8Array }
  | { type: 0x02 | 0x0a; seq: number; siege: number; nonce: Uint8Array }
  | { type: 0x03; seq: number; siege: number }
  | { type: 0x05; seq: number; raison: number }
  | { type: 0x07; seq: number; siege: number; enLigne: boolean; derniereMin: number }
  | { type: 0x08; seq: number; ping: Uint8Array }
  | { type: 0x09; seq: number; siege: number | undefined; nonce: Uint8Array; r: number }
  | { type: 0x0b; seq: number; secondes: number }
  | { type: 0x0c; seq: number }
  | { type: 0x0d; seq: number; createur: number; annonces: { siege: number; nonce: Uint8Array; derniereMin: number }[] }
  | { type: 0x0e; seq: number; cible: number }
  | { type: 0x0f; seq: number }
  | { type: 0x10; seq: number; depart: number; secondes: number; places: number };

/** Taille exacte de chaque type (hors 0x0D, 11 + 25 n). */
const TAILLES: Readonly<Record<number, number>> = {
  0x01: 9 + 1 + 8 + TAILLE_TRAME,
  0x02: 9 + 17,
  0x03: 9 + 1,
  0x05: 9 + 1,
  0x07: 9 + 1 + 1 + 8,
  0x08: 9 + 8,
  0x09: 9 + 1 + 16 + 4,
  0x0a: 9 + 17,
  0x0b: 9 + 4,
  0x0c: 9,
  0x0e: 9 + 8,
  0x0f: 9,
  0x10: 9 + 8 + 4 + 1,
};

/** Types qui prennent un nouveau rang (les autres portent le dernier attribué). */
export const PREND_UN_RANG: ReadonlySet<number> = new Set([0x01, 0x02, 0x03, 0x09, 0x0a]);

const vue = (b: Uint8Array, o: number, n: number) => new DataView(b.buffer, b.byteOffset + o, n);
/** Entier de 64 bits ; au-delà de 2^53 − 1 (jamais atteint par un vrai serveur) : refusé. */
function u64(b: Uint8Array, o: number): number | null {
  const v = vue(b, o, 8).getBigUint64(0);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
}
const u32 = (b: Uint8Array, o: number) => vue(b, o, 4).getUint32(0);

/** Lit un enregistrement du serveur ; null si sa taille ou son type est faux. */
export function lire(b: Uint8Array): Enregistrement | null {
  if (b.length < 9) return null;
  const type = b[0]!;
  const seq = u64(b, 1);
  if (seq === null) return null;
  if (type === 0x0d) {
    const n = b[10];
    if (n === undefined || b.length !== 11 + 25 * n) return null;
    const annonces = [];
    for (let i = 0; i < n; i++) {
      const o = 11 + 25 * i;
      const m = u64(b, o + 17);
      if (m === null) return null;
      annonces.push({ siege: b[o]!, nonce: b.slice(o + 1, o + 17), derniereMin: m });
    }
    return { type, seq, createur: b[9]!, annonces };
  }
  if (TAILLES[type] === undefined || b.length !== TAILLES[type]) return null;
  switch (type) {
    case 0x01: {
      const recuMs = u64(b, 10);
      return recuMs === null ? null : { type, seq, siege: b[9]!, recuMs, trame: b.slice(18) };
    }
    case 0x02:
    case 0x0a:
      return { type, seq, siege: b[9]!, nonce: b.slice(10, 26) };
    case 0x03:
      return { type, seq, siege: b[9]! };
    case 0x05:
      return { type, seq, raison: b[9]! };
    case 0x07: {
      const m = u64(b, 11);
      return m === null ? null : { type, seq, siege: b[9]!, enLigne: b[10] === 1, derniereMin: m };
    }
    case 0x08:
      return { type, seq, ping: b.slice(9, 17) };
    case 0x09:
      return { type, seq, siege: b[9] === 0xff ? undefined : b[9]!, nonce: b.slice(10, 26), r: u32(b, 26) };
    case 0x0b:
      return { type, seq, secondes: u32(b, 9) };
    case 0x0c:
    case 0x0f:
      return { type, seq };
    case 0x0e: {
      const c = u64(b, 9);
      return c === null ? null : { type, seq, cible: c };
    }
    case 0x10: {
      const d = u64(b, 9);
      return d === null ? null : { type, seq, depart: d, secondes: u32(b, 17), places: b[21]! };
    }
  }
  return null;
}

type Octets = Uint8Array<ArrayBuffer>;

/** Accueil (51 octets) : jeton de membre (43 caractères base64url) ‖ `depuis` (8). */
export function accueil(jeton: string, depuis: bigint): Octets {
  if (!/^[A-Za-z0-9_-]{43}$/.test(jeton)) throw new Error("argument_invalide");
  const b = new Uint8Array(51);
  for (let i = 0; i < 43; i++) b[i] = jeton.charCodeAt(i);
  vue(b, 43, 8).setBigUint64(0, depuis);
  return b;
}

/** `0x01` : trame (4 140 octets), et l'identifiant de la pièce liée (16 octets) s'il y en a une. */
export function trame(t: Uint8Array, piece?: Uint8Array): Octets {
  if (t.length !== TAILLE_TRAME || (piece !== undefined && piece.length !== 16)) throw new Error("argument_invalide");
  const b = new Uint8Array(1 + TAILLE_TRAME + (piece ? 16 : 0));
  b[0] = 0x01;
  b.set(t, 1);
  if (piece) b.set(piece, 1 + TAILLE_TRAME);
  return b;
}

function avecRang(type: number, seq: number): Octets {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("argument_invalide");
  const b = new Uint8Array(9);
  b[0] = type;
  vue(b, 1, 8).setBigUint64(0, BigInt(seq));
  return b;
}

/** `0x02` : retirer pour tous la trame de rang `seq` (trame de ce siège). */
export const retirer = (seq: number): Octets => avecRang(0x02, seq);
/** `0x05` : lecture de la trame de rang `seq` (règles 1 à 3). */
export const lu = (seq: number): Octets => avecRang(0x05, seq);
/** `0x03` : quitter le salon. */
export const quitter = (): Octets => new Uint8Array([0x03]);
/** `0x04` : ping de 8 octets (le serveur rend `0x08` avec les mêmes). */
export function ping(n: Uint8Array): Octets {
  if (n.length !== 8) throw new Error("argument_invalide");
  const b = new Uint8Array(9);
  b[0] = 0x04;
  b.set(n, 1);
  return b;
}

/** Raisons du `0x05` de fin ; 3 réservé, jamais émis. */
export const RAISONS_FIN = { expire: 1, detruit: 2, remplace: 4, exclu: 5, lent: 6, interrompu: 7 } as const;

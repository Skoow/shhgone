// Ce que le compte garde sur cet appareil (conception compte §9, D7 ; conception du compte par
// passkey §5.5). EXCEPTION ÉCRITE à « aucun stockage navigateur » (source-rules.test.ts) : base
// IndexedDB `shhdrop-compte`, nommée et lue seulement ici. Deux enregistrements, chacun chiffré
// AES-256-GCM par une clé créée NON EXTRACTIBLE et gardée dans la base (même mécanisme que
// l'historique, history/store.ts) :
// - « session » : seulement si la personne coche « Rester connecté » (décochée par défaut) :
//   jeton de session, h, K_compte, passkey de la session, plus grands gen vus ;
// - « cle » : clé locale de l'appareil (h, K_compte), gardée MÊME SANS « Rester connecté » quand
//   la passkey n'ouvre pas les données ici (pas de PRF, ou sortie PRF sans enveloppe) : sinon chaque
//   connexion redemanderait la clé de récupération (§5.5). L'écran le dit.
// Honnêtement : la clé de chiffrement est sur le même appareil ; cela ne protège que d'une
// lecture naïve du stockage. La vraie protection est le verrouillage de l'appareil (R13).
// « Se déconnecter » supprime la base entière (clé comprise) : la clé de récupération sera
// redemandée. Limite (faible) : le jeton et les clés passent par une chaîne JSON le temps du
// chiffrement ; une chaîne JavaScript ne s'efface pas.
// Apps (D42-20) : trousseau du système à la place, même contenu.
import { idbBackend, type Backend } from "../history/store";
import { b64u, unb64u, utf8 } from "../engine/pure";

export const COMPTE_DB = "shhdrop-compte";
const SESSION = "session";
const CLE = "cle";
const AAD = { [SESSION]: utf8("shhdrop-compte/v2/session"), [CLE]: utf8("shhdrop-compte/v2/cle") };

type Bytes = Uint8Array<ArrayBuffer>;
export type Sauvegarde = { jeton: string; h: Uint8Array; kCompte: Uint8Array; credId: Uint8Array | null; parRecup: boolean; genProfil: number; genPrive: number };
export type CleLocale = { h: Uint8Array; kCompte: Uint8Array };

/** IndexedDB du navigateur, ou null (refusé : navigation privée de certains navigateurs, cadres). */
export function idbDuNavigateur(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

const base = (idb: IDBFactory): Backend => idbBackend(idb, COMPTE_DB);
const cleDeLaBase = (b: Backend) => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]).then((k) => b.key(k));

async function ecrire(idb: IDBFactory, id: typeof SESSION | typeof CLE, o: Record<string, unknown>): Promise<void> {
  const b = base(idb);
  const key = await cleDeLaBase(b);
  const pt = utf8(JSON.stringify(o));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD[id] }, key, pt));
    await b.put(id, { iv, ct });
  } finally {
    pt.fill(0);
  }
}

/** L'enregistrement `id` déchiffré ; null si aucune base (rien n'est créé), absent ou illisible. */
async function relire(idb: IDBFactory, id: typeof SESSION | typeof CLE): Promise<Record<string, unknown> | null> {
  const b = base(idb);
  try {
    if (!(await b.exists())) return null;
    const rec = (await b.all()).find(([k]) => k === id)?.[1];
    if (!(rec?.iv instanceof Uint8Array) || !(rec.ct instanceof Uint8Array)) return null;
    const key = await cleDeLaBase(b);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv as Bytes, additionalData: AAD[id] }, key, rec.ct as Bytes));
    const o = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
    pt.fill(0);
    return typeof o === "object" && o !== null ? o : null;
  } catch {
    return null;
  }
}

function octets(o: Record<string, unknown>, k: string, n: number): Bytes {
  const v = unb64u(o[k] as string);
  if (v.length !== n) throw new Error();
  return v;
}

export async function sauver(idb: IDBFactory, s: Sauvegarde): Promise<void> {
  await ecrire(idb, SESSION, {
    jeton: s.jeton,
    h: b64u(s.h as Bytes),
    k_compte: b64u(s.kCompte as Bytes),
    cred_id: s.credId === null ? "" : b64u(s.credId as Bytes),
    par_recup: s.parRecup,
    gen_profil: s.genProfil,
    gen_prive: s.genPrive,
  });
}

/** La session gardée ; null si aucune, ou illisible. */
export async function lire(idb: IDBFactory): Promise<Sauvegarde | null> {
  const o = await relire(idb, SESSION);
  if (!o) return null;
  try {
    const gen = (k: string) => {
      if (!Number.isSafeInteger(o[k]) || (o[k] as number) < 0) throw new Error();
      return o[k] as number;
    };
    if (typeof o.jeton !== "string" || unb64u(o.jeton).length !== 32 || typeof o.par_recup !== "boolean" || typeof o.cred_id !== "string") return null;
    const credId = o.cred_id === "" ? null : unb64u(o.cred_id);
    return { jeton: o.jeton, h: octets(o, "h", 16), kCompte: octets(o, "k_compte", 32), credId, parRecup: o.par_recup, genProfil: gen("gen_profil"), genPrive: gen("gen_prive") };
  } catch {
    return null;
  }
}

/** Coupe « Rester connecté » : la session gardée est oubliée, la clé locale reste. */
export async function oublierSession(idb: IDBFactory): Promise<void> {
  const b = base(idb);
  if (await b.exists().catch(() => false)) await b.del(SESSION);
}

export async function sauverCle(idb: IDBFactory, c: CleLocale): Promise<void> {
  await ecrire(idb, CLE, { h: b64u(c.h as Bytes), k_compte: b64u(c.kCompte as Bytes) });
}

/** La clé locale de l'appareil pour le compte h, ou null. */
export async function lireCle(idb: IDBFactory, h: Uint8Array): Promise<Bytes | null> {
  const o = await relire(idb, CLE);
  if (!o) return null;
  try {
    const hh = octets(o, "h", 16);
    const k = octets(o, "k_compte", 32);
    if (hh.some((x, i) => x !== h[i])) {
      k.fill(0);
      return null;
    }
    return k;
  } catch {
    return null;
  }
}

/** Déconnexion : la base entière disparaît (session gardée, clé locale, clé de chiffrement). */
export async function effacer(idb: IDBFactory): Promise<void> {
  await base(idb).drop();
}

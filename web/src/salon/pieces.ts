// Pièces jointes du salon (spec salon v3 §3.4, §4.4 ; plan C-4) : chaque pièce est un paquet SHH2
// d'un seul élément sous une graine R neuve, tirée par le moteur des partages ; R (32 octets)
// voyage dans le message MLS `piece`, chiffré de bout en bout : le serveur ne reçoit que le
// conteneur chiffré, de la taille exacte de son palier. Ni le nom, ni le type, ni le contenu ne
// lui parviennent en clair (le nom et le type sont dans le message chiffré et le manifeste).
// Assemblage : chaque segment entier (en-tête, morceaux de l'élément, morceau du manifeste,
// aléa ailleurs) est fait ici, dans un tampon de 4 Mio au plus, puis envoyé (plan C-4 point 2).
import { CHUNK_CT, HEADER, SEG_CHUNKS } from "../engine/pure";
import { contentKeys, contentKeysChecked, elementSealer, forget, newSeed, openStream, readHeader, sealFinal, seedBytes, seedFromBytes } from "../engine/index";
import * as api from "./api";

/** Plus grand fichier : palier 8 000 du serveur (« 500 Mo », spec §39.1). */
export const PIECE_MAX = 524_222_464;
/** Images et vocaux affichés d'office jusqu'à 16 Mio (spec §39.5). */
export const AFFICHE_MAX = 16 * 1048576;
/** Paliers des vocaux (serveur : VocalPaliers) ; au-delà, refusé. */
export const PALIERS_VOCAUX = [1, 16, 80] as const;

export type RefPiece = { r: Uint8Array; piece: Uint8Array; palier: number };

/**
 * Cause d'une lecture de pièce ratée, pour le message : « indisponible » (404 : retirée ou
 * effacée), « sortie » (403 egress_limit : plafond de sortie de la pièce atteint sur le serveur,
 * définitif, jamais réessayé), sinon « lecture » (réessayable).
 */
export function causeLecture(e: unknown): "indisponible" | "sortie" | "lecture" {
  if (e instanceof api.SalonError && e.status === 404) return "indisponible";
  if (e instanceof api.SalonError && e.status === 403 && e.code === "egress_limit") return "sortie";
  return "lecture";
}

const segments = (bucket: number) => Math.ceil(bucket / SEG_CHUNKS);
const chunksDuSegment = (bucket: number, n: number) => Math.min(SEG_CHUNKS, bucket - n * SEG_CHUNKS);

function alea(b: Uint8Array<ArrayBuffer>): void {
  for (let o = 0; o < b.length; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(b.length, o + 65536)));
}

/**
 * Chiffre `blob` et l'envoie comme pièce : rend sa référence (R en clair : SECRET, à mettre dans
 * le message `piece` puis à effacer par l'appelant). `vocal` : palier vocal (1, 16 ou 80), hors
 * du budget de 2 Go, au rythme d'une voix (serveur). `progres` : fraction envoyée.
 */
export async function envoyerPiece(n: api.Net, jeton: string, blob: Blob, o: { nom: string; mime: string; vocal: boolean; progres?: (f: number) => void; signal?: AbortSignal }): Promise<RefPiece> {
  if (blob.size > PIECE_MAX) throw new Error("trop_gros");
  const seed = await newSeed();
  let r: Uint8Array | undefined;
  try {
    const keys = await contentKeys(seed);
    const sealer = await elementSealer(blob, 0);
    try {
      const fin = await sealFinal([{ kind: "file", name: o.nom, mime: o.mime, size: blob.size, first: 0, sealer }], keys, {});
      if (o.vocal && !(PALIERS_VOCAUX as readonly number[]).includes(fin.bucket)) throw new Error("vocal_trop_long");
      const { piece, envoi } = await api.creerPiece(n, jeton, fin.bucket, o.vocal);
      const total = segments(fin.bucket);
      for (let s = 0; s < total; s++) {
        if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const base = s === 0 ? HEADER : 0;
        const buf = new Uint8Array(base + chunksDuSegment(fin.bucket, s) * CHUNK_CT);
        alea(buf);
        // Une pièce qui commence au morceau 0 du paquet porte d'abord 48 octets nuls (la place de
        // l'en-tête, engine/core/src/elements.rs) : elle est posée à l'octet 0, l'en-tête ensuite.
        for (const [j, p] of sealer.pieces.entries()) if (p.seg === s) buf.set(await sealer.piece(j), s === 0 && p.from === 0 ? 0 : base + p.from * CHUNK_CT);
        if (s === 0) buf.set(fin.header, 0);
        const dernier = fin.bucket - 1;
        if (Math.floor(dernier / SEG_CHUNKS) === s) buf.set(fin.tail, base + (dernier - s * SEG_CHUNKS) * CHUNK_CT);
        await api.envoyerSegment(n, envoi, s, buf);
        o.progres?.((s + 1) / total);
      }
      await api.finaliserPiece(n, envoi);
      r = await seedBytes(seed);
      return { r, piece, palier: fin.bucket };
    } finally {
      sealer.forget();
      forget(keys);
    }
  } finally {
    forget(seed);
  }
}

/** Taille d'un lot de morceaux déchiffrés gardés par la page avant de passer au Blob. */
const LOT = 8 * 1048576;

/**
 * Assemble un fichier déchiffré par lots (restes du salon, point 6) : la page ne garde que le lot
 * en cours (8 Mio au plus) ; chaque lot plein devient un Blob, que le navigateur peut garder hors
 * de la mémoire de la page (Chromium écrit les gros Blobs sur le disque). Avant : tous les
 * morceaux, puis leur copie dans le Blob final, soit deux fois la taille du fichier au pic.
 * Chaque morceau reçu est copié puis effacé (comme avant).
 */
export class Lots {
  #faits: Blob[] = [];
  #lot: Uint8Array<ArrayBuffer>[] = [];
  enAttente = 0;
  constructor(private readonly taille = LOT) {}
  ajouter(c: Uint8Array): void {
    this.#lot.push(c.slice() as Uint8Array<ArrayBuffer>);
    this.enAttente += c.length;
    c.fill(0);
    if (this.enAttente >= this.taille) this.#vider();
  }
  #vider(): void {
    if (this.#lot.length === 0) return;
    this.#faits.push(new Blob(this.#lot));
    for (const m of this.#lot) m.fill(0);
    this.#lot = [];
    this.enAttente = 0;
  }
  blob(type: string): Blob {
    this.#vider();
    return new Blob(this.#faits, { type });
  }
}

/**
 * Lit une pièce reçue (`ref` du message `piece` ou de l'avatar d'un profil) : octets du fichier.
 * Le segment 0 n'est lu qu'une fois (budget de lecture du serveur, plan C-2 Task 13).
 * `max` : octets acceptés au plus ; une pièce plus grosse lève « trop_gros » dès le manifeste lu
 * (premier et dernier segments), sans lire le contenu (un membre ne peut pas faire télécharger 500 Mo à tous par une photo ou un avatar).
 */
export async function lirePiece(n: api.Net, jeton: string, ref: RefPiece, max: number = PIECE_MAX): Promise<Blob> {
  const seg0 = await api.lireSegment(n, jeton, ref.piece, 0);
  const premier = seg0;
  const { engagement } = await readHeader(seg0);
  const seed = await seedFromBytes(ref.r);
  try {
    const keys = await contentKeysChecked(seed, engagement);
    try {
      const rd = await openStream(
        async (s) => {
          // Segment 0 (4 Mio au plus) gardé pendant la lecture : le lecteur peut le redemander.
          if (s === 0) return premier.slice();
          return api.lireSegment(n, jeton, ref.piece, s);
        },
        ref.palier,
        keys,
      );
      try {
        // Taille réelle (manifeste chiffré) : la taille annoncée par le message
        // ne lie personne (audit du 20 novembre). Au-delà de `max`, rien d'autre n'est demandé.
        const e = rd.manifest.items[0];
        if (!e || e.size > max) throw new Error("trop_gros");
        const lots = new Lots();
        let recu = 0;
        await rd.streamItem(0, (c) => {
          recu += c.length;
          if (recu > max) {
            c.fill(0);
            throw new Error("trop_gros");
          }
          lots.ajouter(c);
        });
        return lots.blob(e?.kind === "file" ? "application/octet-stream" : "text/plain");
      } finally {
        rd.wipe();
        rd.free();
      }
    } finally {
      forget(keys);
    }
  } finally {
    forget(seed);
  }
}

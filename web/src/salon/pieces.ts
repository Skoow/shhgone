// Pièces jointes du salon (spec salon v3 §3.4, §4.4) : chaque pièce est un paquet SHH2
// d'un seul élément sous une graine R neuve, tirée par le moteur des partages ; R (32 octets)
// voyage dans le message MLS `piece`, chiffré de bout en bout : le serveur ne reçoit que le
// conteneur chiffré, de la taille exacte de son palier. Ni le nom, ni le type, ni le contenu ne
// lui parviennent en clair (le nom et le type sont dans le message chiffré et le manifeste).
// Assemblage : chaque segment entier (en-tête, morceaux de l'élément, morceau du manifeste,
// aléa ailleurs) est fait ici, dans un tampon de 4 Mio au plus, puis envoyé.
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
 * effacée), « sortie » (403 egress_limit : plafond de sortie de la pièce atteint sur le serveur),
 * « relu » (429 budget : ce membre a déjà téléchargé la pièce ; une lecture par membre, avec
 * une marge de reprise), sinon « lecture » (réessayable).
 * « sortie » et « relu » sont définitifs : jamais réessayés (`lectureDefinitive`).
 */
export function causeLecture(e: unknown): "indisponible" | "sortie" | "relu" | "lecture" {
  if (e instanceof api.SalonError && e.status === 404) return "indisponible";
  if (e instanceof api.SalonError && e.status === 403 && e.code === "egress_limit") return "sortie";
  if (e instanceof api.SalonError && e.status === 429 && e.code === "budget") return "relu";
  return "lecture";
}

/** Refus du serveur qu'aucun nouvel essai ne lèverait (plafond de sortie, budget de lecture). */
export const lectureDefinitive = (c: string | undefined): boolean => c === "sortie" || c === "relu";

/** Attentes avant chaque nouvel essai d'un segment coupé (réseau ou erreur 5xx du serveur). */
export const REPRISES_MS = [1000, 3000, 8000] as const;

/**
 * Lit un segment, repris sur place après une coupure : le téléchargement continue au segment
 * coupé au lieu de tout relire depuis le début (le serveur compte chaque octet envoyé à un
 * membre). Un refus du serveur (4xx) n'est jamais réessayé.
 */
export async function avecReprise<T>(f: () => Promise<T>, attendre: (ms: number) => Promise<void> = (ms) => new Promise((ok) => setTimeout(ok, ms))): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const refus = e instanceof api.SalonError && e.status < 500;
      if (refus || i >= REPRISES_MS.length) throw e;
      await attendre(REPRISES_MS[i]!);
    }
  }
}

/**
 * Attentes avant chaque nouvel essai d'un envoi de pièce coupé (réseau, 5xx : serveur qui
 * redémarre) ; la dernière se répète, jusqu'à ENVOI_PATIENCE_MS d'attente en tout.
 */
export const ENVOI_REPRISES_MS = [1000, 3000, 8000, 15000, 30000] as const;
export const ENVOI_PATIENCE_MS = 10 * 60_000;

/**
 * Un appel d'envoi (segment, finalisation) avec son jeton, repris après une coupure ou un
 * redémarrage du serveur (D42-32) : coupure réseau ou 5xx → même appel après une attente ; 404
 * (jeton d'envoi d'avant le redémarrage) → reprise par le jeton de membre (jeton neuf), une fois
 * par appel, puis le même appel ; « prête » (finalisée avant le redémarrage) : rend "prete" sans
 * refaire l'appel. Tout autre refus (4xx) est relancé tel quel. Chaque segment acquitté est sur le
 * disque du serveur : rien d'acquitté n'est renvoyé.
 */
export class EnvoiRepris {
  private attendu = 0;
  constructor(
    private readonly n: api.Net,
    private readonly jeton: string,
    private readonly piece: Uint8Array,
    private envoi: string,
    private readonly attendre: (ms: number) => Promise<void> = (ms) => new Promise((ok) => setTimeout(ok, ms)),
    private readonly signal?: AbortSignal,
  ) {}

  async appel(f: (envoi: string) => Promise<void>): Promise<"fait" | "prete"> {
    let repris = false;
    for (let i = 0; ; i++) {
      if (this.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      try {
        await f(this.envoi);
        return "fait";
      } catch (e) {
        if (e instanceof api.SalonError && e.status === 404 && !repris) {
          repris = true;
          const r = await this.avecPatience(() => api.reprendrePiece(this.n, this.jeton, this.piece));
          if (r.prete) return "prete";
          this.envoi = r.envoi;
          i = -1;
          continue;
        }
        const coupure = (e instanceof Error && e.message === "reseau") || (e instanceof api.SalonError && e.status >= 500);
        if (!coupure) throw e;
        await this.pause(i, e);
      }
    }
  }

  /** La reprise elle-même, patiente comme un appel (serveur encore en train de démarrer). */
  private async avecPatience<T>(f: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await f();
      } catch (e) {
        const coupure = (e instanceof Error && e.message === "reseau") || (e instanceof api.SalonError && e.status >= 500);
        if (!coupure) throw e;
        await this.pause(i, e);
      }
    }
  }

  private async pause(i: number, e: unknown): Promise<void> {
    const ms = ENVOI_REPRISES_MS[Math.min(i, ENVOI_REPRISES_MS.length - 1)]!;
    if (this.attendu + ms > ENVOI_PATIENCE_MS) throw e;
    this.attendu += ms;
    await this.attendre(ms);
  }
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
export async function envoyerPiece(
  n: api.Net,
  jeton: string,
  blob: Blob,
  o: { nom: string; mime: string; vocal: boolean; progres?: (f: number) => void; signal?: AbortSignal; attendre?: (ms: number) => Promise<void> },
): Promise<RefPiece> {
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
      const reprise = new EnvoiRepris(n, jeton, piece, envoi, o.attendre, o.signal);
      let prete = false;
      const total = segments(fin.bucket);
      for (let s = 0; s < total && !prete; s++) {
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
        prete = (await reprise.appel((t) => api.envoyerSegment(n, t, s, buf))) === "prete";
        o.progres?.((s + 1) / total);
      }
      if (!prete) await reprise.appel((t) => api.finaliserPiece(n, t));
      o.progres?.(1);
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
 * Assemble un fichier déchiffré par lots : la page ne garde que le lot
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
 * Chaque segment n'est demandé qu'une fois (une lecture par membre sur le serveur) : le premier
 * et le dernier (manifeste) sont gardés pendant la lecture, un segment coupé est repris sur place.
 * `max` : octets acceptés au plus ; une pièce plus grosse lève « trop_gros » dès le manifeste lu
 * (premier et dernier segments), sans lire le contenu (un membre ne peut pas faire télécharger 500 Mo à tous par une photo ou un avatar).
 */
export async function lirePiece(n: api.Net, jeton: string, ref: RefPiece, max: number = PIECE_MAX): Promise<Blob> {
  const seg0 = await avecReprise(() => api.lireSegment(n, jeton, ref.piece, 0));
  const premier = seg0;
  const dernier = segments(ref.palier) - 1;
  let fin: Uint8Array<ArrayBuffer> | undefined;
  const { engagement } = await readHeader(seg0);
  const seed = await seedFromBytes(ref.r);
  try {
    const keys = await contentKeysChecked(seed, engagement);
    try {
      const rd = await openStream(
        async (s) => {
          // Premier et dernier segments (4 Mio au plus chacun) gardés pendant la lecture : le
          // lecteur les redemande (en-tête, puis manifeste avant le contenu).
          if (s === 0) return premier.slice();
          if (s === dernier) return (fin ??= await avecReprise(() => api.lireSegment(n, jeton, ref.piece, s))).slice();
          return avecReprise(() => api.lireSegment(n, jeton, ref.piece, s));
        },
        ref.palier,
        keys,
      );
      try {
        // Taille réelle (manifeste chiffré) : la taille annoncée par le message
        // ne lie personne. Au-delà de `max`, rien d'autre n'est demandé.
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

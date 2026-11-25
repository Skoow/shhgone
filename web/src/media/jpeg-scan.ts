// Lecture des marqueurs JPEG, partagée par le nettoyage (jpeg.ts) et la vignette EXIF (exif.ts),
// à part pour que exif.ts ne dépende pas de jpeg.ts (qui dépend de lui).
import { Malformed, concat, startsWith, u16be, u8 } from "./bytes";

/** Tables et trames gardées : DQT, DHT, DAC, DRI, DNL, SOF0 à SOF15 (sauf DHT, JPG, DAC). */
export function keptTable(m: number): boolean {
  return m === 0xdb || m === 0xc4 || m === 0xcc || m === 0xdd || m === 0xdc || (m >= 0xc0 && m <= 0xcf && m !== 0xc8);
}

/** Fin des données compressées qui suivent un SOS : position du marqueur suivant. */
export function scanEnd(b: Uint8Array, o: number): number {
  for (let i = o; i < b.length - 1; i++) {
    if (b[i] !== 0xff) continue;
    let j = i + 1;
    while (j < b.length && b[j] === 0xff) j++;
    if (j >= b.length) break;
    const n = b[j]!;
    if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
      i = j;
      continue;
    }
    return j - 1;
  }
  throw new Malformed("jpeg_sans_fin");
}

/**
 * Vignette EXIF nettoyée (* la vignette est gardée, ses métadonnées partent). Rend un JPEG neuf : SOI, puis seulement ce
 * qui sert à l'afficher, octets inchangés et dans l'ordre (tables et trames de `keptTable`, APP14
 * Adobe comme pour l'image principale, SOS et données compressées), puis EOI. Tout autre segment
 * est retiré sans toucher au reste : APP0 à APP15 (EXIF, XMP, IPTC…), COM, et les marqueurs
 * réservés ou rares qui peuvent porter n'importe quoi (0xC8, 0xDE, 0xDF, 0xF0 à 0xFD).
 * Ce qui suit le premier EOI, dans la longueur déclarée par l'IFD1, n'est jamais gardé.
 * null seulement si la vignette est mal formée : pas de SOI, pas d'EOI, segment qui déborde,
 * marqueur seul hors norme (comme).
 */
export function cleanThumbnail(j: Uint8Array): Uint8Array<ArrayBuffer> | null {
  try {
    if (u8(j, 0) !== 0xff || u8(j, 1) !== 0xd8) return null;
    const out: Uint8Array[] = [j.subarray(0, 2)];
    let o = 2;
    for (;;) {
      if (u8(j, o) !== 0xff) return null;
      while (u8(j, o + 1) === 0xff) o++; // octets de remplissage
      const m = u8(j, o + 1);
      if (m === 0xd9) {
        out.push(j.subarray(o, o + 2));
        return concat(out);
      }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8) || m === 0x00) return null;
      const len = u16be(j, o + 2);
      const next = o + 2 + len;
      if (len < 2 || next > j.length) return null;
      if (m === 0xda) {
        const end = scanEnd(j, next);
        out.push(j.subarray(o, end)); // SOS et données compressées, octet pour octet
        o = end;
        continue;
      }
      if (keptTable(m) || (m === 0xee && startsWith(j, o + 4, "Adobe"))) out.push(j.subarray(o, next));
      o = next; // tout autre segment : retiré
    }
  } catch {
    return null;
  }
}

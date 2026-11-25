// Liens du salon : invitation « https://…/salon#c<K_lien> » et gestion
// « https://…/salon#s<S_gestion> », 43 caractères base64url (32 octets). Le « # » n'est jamais
// envoyé au serveur ; la page le lit une fois puis le retire de la barre (spec §5.3). Pur.
import { b64u, unb64u } from "../engine/pure";

export const SALON_PATH = "/salon";
const FRAG = /^#([cs])([A-Za-z0-9_-]{43})$/;

/** Fragment d'un lien du salon : sorte (c invitation, s gestion) et secret, ou null. */
export function lireFragment(hash: string): { sorte: "c" | "s"; cle: Uint8Array<ArrayBuffer> } | null {
  const m = FRAG.exec(hash);
  if (!m) return null;
  let cle: Uint8Array<ArrayBuffer>;
  try {
    cle = unb64u(m[2]!);
  } catch {
    return null;
  }
  return cle.length === 32 ? { sorte: m[1] as "c" | "s", cle } : null;
}

/** Fragment de gestion n'importe où dans un texte (43 caractères exactement, bornés). */
const GESTION_DANS = /#s([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

/**
 * Exigence C-3 32 : secret du premier lien de gestion (« …#s<43> ») contenu dans un texte tapé ou
 * collé dans la conversation, ou null. Un tel texte n'est jamais envoyé : il sert seulement à
 * retrouver les droits du créateur, sur l'appareil.
 */
export function lienGestionDans(texte: string): Uint8Array<ArrayBuffer> | null {
  const m = GESTION_DANS.exec(texte);
  if (!m) return null;
  const f = lireFragment("#s" + m[1]);
  return f?.sorte === "s" ? f.cle : null;
}

/** Lien complet (origine, base de l'application) : invitation ou gestion. */
export function lienSalon(origin: string, sorte: "c" | "s", cle: Uint8Array, base = "/"): string {
  if (cle.length !== 32) throw new Error("argument_invalide");
  return origin + base.replace(/\/$/, "") + SALON_PATH + "#" + sorte + b64u(cle as Uint8Array<ArrayBuffer>);
}

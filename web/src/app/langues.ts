// Pages bilingues (référencement et stabilité de l'affichage) : l'accueil et les pages
// d'information ont une version anglaise écrite au build sous « /en » (« /en », « /en/securite »…),
// la version française gardant son adresse. Sur ces pages, l'adresse décide de la langue ; le
// serveur ne lit jamais Accept-Language (spécification §36 S2) : un navigateur anglophone voit un
// lien « English version » (ui/EnglishLink.svelte) vers la version anglaise. Ailleurs (envoi, partage,
// compte, salon), la langue suit le navigateur, sans adresse propre. Démo (GitHub Pages) : aucune
// version écrite, la langue suit le navigateur partout. Aucune donnée dans l'adresse.
import type { Lang } from "../i18n/format";

/** Vrai au build de production et en développement (vite.config.ts) ; faux dans la démo et sous vitest. */
export const BILINGUE: boolean = typeof __BILINGUE__ === "boolean" && __BILINGUE__;

/** Chemins français des pages bilingues (sans la base). */
export const PAGES_BILINGUES: readonly string[] = ["/", "/securite", "/confidentialite", "/offres", "/conditions", "/mentions-legales", "/signaler", "/verifier"];

/** Adresse d'une page bilingue dans une langue : « /securite » → « /en/securite », « / » → « /en ». */
export function cheminEn(lang: Lang, chemin: string): string {
  if (lang === "fr") return chemin;
  return chemin === "/" ? "/en" : "/en" + chemin;
}

/**
 * Langue et chemin français d'une adresse de page bilingue (sans la base) ; null pour toute autre
 * adresse. Le nom de fichier (« /securite.html ») vaut l'adresse ; la version anglaise n'a que
 * des adresses sans « .html ».
 */
export function langueDuChemin(p: string): { lang: Lang; chemin: string } | null {
  if (p === "/en") return { lang: "en", chemin: "/" };
  if (p.startsWith("/en/")) {
    const c = p.slice(3);
    return c !== "/" && PAGES_BILINGUES.includes(c) ? { lang: "en", chemin: c } : null;
  }
  const c = p.endsWith(".html") ? p.slice(0, -5) : p;
  return PAGES_BILINGUES.includes(c) ? { lang: "fr", chemin: c } : null;
}

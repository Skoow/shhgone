// « Lien prêt » : ce que la personne a déjà mis de côté (en mémoire seulement, jamais stocké).
// Le partage marche sans aucun clic ; les garde-fous (avertissement à la fermeture, confirmation
// de « Nouveau partage », confirmation du Retour) ne servent qu'à ne pas perdre le lien et le mot
// de passe avant de les avoir copiés : ils tombent dès que les deux l'ont été (une copie à la
// main, après un refus du presse-papier, ne compte pas : on ne peut pas la constater).

export type Copies = { readonly link: boolean; readonly password: boolean };

/** `both` : « Copier le lien et le mot de passe » ou « Envoyer vers une app » réussis. */
export type Copied = "link" | "password" | "both";

export const NOTHING_COPIED: Copies = { link: false, password: false };

export function noteCopy(c: Copies, what: Copied): Copies {
  return { link: c.link || what !== "password", password: c.password || what !== "link" };
}

/** Le lien et le mot de passe ont tous deux été copiés ou partagés. */
export const secured = (c: Copies): boolean => c.link && c.password;

/** Avertissement à la fermeture de l'onglet : tant que ce n'est ni fini (Nouveau partage, Supprimer) ni mis de côté. */
export const warnOnUnload = (c: Copies, finished: boolean): boolean => !finished && !secured(c);

/** « Nouveau partage » (et le Retour) demandent confirmation tant que les deux ne sont pas copiés. */
export const confirmLeave = (c: Copies): boolean => !secured(c);

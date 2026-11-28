// « Lien prêt » : ce que la personne a déjà mis de côté (en mémoire seulement, jamais stocké).
// Le partage marche sans aucun clic ; les garde-fous (avertissement à la fermeture, confirmation
// de « Nouveau partage », confirmation du Retour) ne servent qu'à ne pas perdre le lien, le mot de
// passe et la gestion du partage avant de les avoir mis de côté : ils tombent dès que c'est fait
// (une copie à la main, après un refus du presse-papier, ne compte pas : on ne peut pas la constater).
// Gestion (D42-30) : gardée d'office dans « Mes partages » (`manage` dès que l'appareil l'a
// gardée) ; si l'appareil ne peut rien garder (stockage refusé), le lien de gestion est montré et
// compte comme le lien et le mot de passe : il faut le copier.

export type Copies = { readonly link: boolean; readonly password: boolean; readonly manage: boolean };

/** `both` : « Copier le lien et le mot de passe » ou « Envoyer vers une app » réussis ; `manage` : gardé dans Mes partages, ou lien de gestion copié. */
export type Copied = "link" | "password" | "both" | "manage";

export const NOTHING_COPIED: Copies = { link: false, password: false, manage: false };

export function noteCopy(c: Copies, what: Copied): Copies {
  return {
    link: c.link || what === "link" || what === "both",
    password: c.password || what === "password" || what === "both",
    manage: c.manage || what === "manage",
  };
}

/** Le lien, le mot de passe et la gestion ont tous été mis de côté. */
export const secured = (c: Copies): boolean => c.link && c.password && c.manage;

/** Avertissement à la fermeture de l'onglet : tant que ce n'est ni fini (Nouveau partage, Supprimer) ni mis de côté. */
export const warnOnUnload = (c: Copies, finished: boolean): boolean => !finished && !secured(c);

/** « Nouveau partage » (et le Retour) demandent confirmation tant que tout n'est pas mis de côté. */
export const confirmLeave = (c: Copies): boolean => !secured(c);

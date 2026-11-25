// Options de l'envoi (UI §9.3, spec §31, §34) : nom du partage, durée,
// ouvertures, mot de passe, droits du destinataire. En mémoire seulement : le mot de passe
// n'est jamais rangé ni journalisé.
// Le mot de passe est toujours généré (D41-15) : aucune saisie, donc aucun contrôle ici.
import { OPENS_DEFAULT, TITLE_MAX, TTL_DEFAULT, previewKindOf, type TtlHours } from "../index";
import { limitesDe, type Formule } from "../limits";

export type Rights = "voir" | "enregistrer" | "coffre";

export type OptionsDeps = {
  /** Mot de passe généré (spec §31). */
  generate: () => string;
  /** Le droit « coffre » est-il proposé ici (spec §27 : pas en démo) ? */
  vaultAllowed?: () => boolean;
};

export function createOptions(deps: OptionsDeps) {
  let ttl = $state<number>(TTL_DEFAULT);
  let opens = $state(OPENS_DEFAULT);
  // Formule du partage (conception du paiement §11) : gratuit par défaut ; Plus ou Pro seulement
  // si un pass payé est gardé sur cet appareil (formules, posé par l'écran).
  let formule = $state<Formule>("free");
  let formules = $state<readonly Formule[]>([]);
  const lim = $derived(limitesDe(formule));
  let generated = $state(deps.generate());
  // Nom du partage : texte libre, nettoyé par le moteur au scellement (cleanTitle).
  let title = $state("");
  // Droits (spec §34, simplifiés) : un interrupteur
  // « Autoriser le téléchargement » (activé par défaut), seulement s'il est activé et là où
  // le coffre existe, la sous-option « Garder une copie chiffrée dans l'app du destinataire ».
  let download = $state(true);
  let vault = $state(false);
  const vaultOk = () => deps.vaultAllowed?.() === true;
  const rights = $derived<Rights>(!download ? "voir" : vault && vaultOk() ? "coffre" : "enregistrer");

  return {
    get ttlHours(): number {
      return ttl;
    },
    set ttlHours(v: number) {
      if (lim.ttlHours.includes(v)) ttl = v;
    },
    get maxOpens() {
      return opens;
    },
    set maxOpens(v: number) {
      opens = Math.min(lim.maxOpens, Math.max(1, Number.isFinite(v) ? Math.trunc(v) : 1));
    },
    /** Formule de ce partage ; en changer ramène durée et ouvertures dans ses limites. */
    get formule(): Formule {
      return formule;
    },
    set formule(f: Formule) {
      if (f !== "free" && !formules.includes(f)) return;
      formule = f;
      const l = limitesDe(f);
      if (!l.ttlHours.includes(ttl)) ttl = TTL_DEFAULT;
      opens = Math.min(opens, l.maxOpens);
    },
    /** Formules payantes utilisables ici (pass payé gardé sur l'appareil). */
    get formules(): readonly Formule[] {
      return formules;
    },
    set formules(l: readonly Formule[]) {
      formules = l.filter((x) => x !== "free");
      if (formule !== "free" && !formules.includes(formule)) this.formule = "free";
    },
    /** Limites de la formule choisie. */
    get limites() {
      return lim;
    },
    /** Mot de passe qui sera utilisé : toujours le dernier généré. */
    get password() {
      return generated;
    },
    /** Droit écrit dans le manifeste : voir, enregistrer ou coffre. */
    get rights(): Rights {
      return rights;
    },
    set rights(v: Rights) {
      if (v === "voir") download = false;
      else if (v === "enregistrer") (download = true), (vault = false);
      else if (v === "coffre" && vaultOk()) (download = true), (vault = true);
    },
    get allowDownload() {
      return download;
    },
    set allowDownload(v: boolean) {
      download = v === true;
    },
    /** Sous-option du téléchargement ; sans effet si le coffre n'est pas proposé ici. */
    get keepVault() {
      return download && vault && vaultOk();
    },
    set keepVault(v: boolean) {
      vault = v === true && vaultOk();
    },
    regenerate() {
      generated = deps.generate();
    },
    /** Nom du partage tel que saisi (le moteur le nettoie) ; vu par le destinataire. */
    get title() {
      return title;
    },
    set title(v: string) {
      title = typeof v === "string" ? v : "";
    },
    /**
     * Nom trop long : NFC de la saisie au-delà de TITLE_MAX points de code. Majorant du nom que le
     * moteur gardera (son nettoyage ne fait que retirer ou regrouper) : si ce n'est pas trop long
     * ici, sealFinal ne refusera pas (« titre_trop_long »).
     */
    get titleTooLong() {
      return titleTooLong(title);
    },
  };
}

/** Voir `titleTooLong` des options. */
export function titleTooLong(raw: string): boolean {
  return [...raw.normalize("NFC")].length > TITLE_MAX;
}

/** Nom passé au moteur : undefined s'il n'y a que des blancs (rien à écrire). */
export function sendTitle(o: Pick<Options, "title">): { title?: string } {
  return o.title.trim() === "" ? {} : { title: o.title };
}
export type Options = ReturnType<typeof createOptions>;

/**
 * Droit écrit dans le manifeste et, pour le coffre, la durée de garde (spec §27.4, §34.1) :
 * `keep_ttl_h` = durée du partage. Sans elle, createShare refuse « coffre » (S5).
 */
export function sendRights(o: Pick<Options, "rights" | "ttlHours">): { rights: Rights; keepTtlH?: TtlHours } {
  // Partage payant de 2 à 7 jours : le coffre garde au plus 24 h (spec §27.4 : 1, 6, 12 ou 24 h).
  return o.rights === "coffre" ? { rights: "coffre", keepTtlH: Math.min(o.ttlHours, 24) as TtlHours } : { rights: o.rights };
}


type Viewable = { kind: "file" | "text"; base: string; ext: string; mime: string; size: number };

/**
 * Le destinataire peut-il ouvrir cet élément dans le navigateur, sans le télécharger ? Même règle
 * que sa visionneuse (previewKindOf, transfer/safety.ts) : images, sons, vidéos, textes et PDF
 * (cadre isolé). Une seule liste, pour que l'avertissement ne dérive plus (les PDF étaient encore annoncés « impossibles à ouvrir »).
 */
export function viewableInBrowser(i: Viewable): boolean {
  return previewKindOf({ kind: i.kind, mime: i.mime.trim(), size: i.size } as Parameters<typeof previewKindOf>[0]) !== "none";
}

/** Éléments qui ne pourront pas être ouverts sans téléchargement (spec §34). */
export function viewOnlyBlockers(items: readonly Viewable[]): string[] {
  return items.filter((i) => !viewableInBrowser(i)).map((i) => i.base + i.ext);
}

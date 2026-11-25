// Textes des erreurs des pages du compte (conception compte §12, §21.15 ; conception du compte par
// passkey §3) : une erreur du module de compte (CompteError du serveur, ou code de l'appareil)
// devient le message exact, rattaché à son champ quand il en a un. Rien d'autre que des textes
// fixes et des nombres : jamais le pseudo, la clé ni la réponse brute du serveur.
// Annulation de la feuille de passkey (« annule ») : AUCUN message (conception §3).
import { formatDuration } from "../../i18n/format";
import { getLang, t } from "../../i18n/i18n.svelte";

export type Champ = "pseudo" | "cle" | "photo" | "nom";
export type Erreur = { champ?: Champ; texte: string };
/** Où l'erreur arrive : `identifiants` ne se dit pas de la même façon pour une passkey et pour une clé. */
export type Moment = "inscription" | "connexion" | "cle" | "parametres";

const CHAMP_CODE: Record<string, [Champ, Parameters<typeof t>[0]]> = {
  pseudo_longueur: ["pseudo", "account.err.pseudoLongueur"],
  pseudo_caracteres: ["pseudo", "account.err.pseudoCaracteres"],
  pseudo_ecritures: ["pseudo", "account.err.pseudoEcritures"],
  pseudo_reserve: ["pseudo", "account.err.pseudoReserve"],
  pseudo_pris: ["pseudo", "account.pseudo.taken"],
  photo_illisible: ["photo", "account.photo.err"],
  cle_recup_longueur: ["cle", "account.err.cle"],
  cle_recup_caractere: ["cle", "account.err.cle"],
  cle_recup_controle: ["cle", "account.err.cle"],
  cle_autre_compte: ["cle", "account.err.cleAutre"],
};

const ILLISIBLE = new Set(["coffre_illisible", "coffre_recule", "coffre_version", "enveloppe_invalide"]);

/** Code d'une erreur (serveur ou appareil), ou "" si ce n'en est pas une connue. */
export function codeDe(e: unknown): string {
  if (e instanceof Error && typeof (e as { code?: unknown }).code === "string") return (e as unknown as { code: string }).code;
  if (e instanceof Error && e.name === "LimitError") return "limit";
  return e instanceof Error ? e.message : "";
}

/** La personne a fermé la feuille de passkey : rien à dire. */
export const annulee = (e: unknown): boolean => codeDe(e) === "annule";

export function erreur(e: unknown, moment: Moment): Erreur {
  const code = codeDe(e);
  const x = e as { retryAfterS?: number };
  const mapped = CHAMP_CODE[code];
  if (mapped) return { champ: mapped[0], texte: t(mapped[1]) };
  switch (code) {
    case "identifiants":
      return moment === "cle" ? { champ: "cle", texte: t("account.err.cleInconnue") } : { texte: t("account.err.identifiants") };
    case "not_found":
    case "aucune_etape":
      return { texte: t("account.err.etape") };
    case "limit":
    case "limite":
      return { texte: t("account.err.limit", { duration: formatDuration(x.retryAfterS ?? 60, getLang()) }) };
    case "busy":
      return { texte: t(moment === "inscription" ? "account.err.busy" : "account.err.busyAutre") };
    case "reseau":
      return { texte: t("account.err.reseau") };
    case "recent":
    case "sans_passkey":
      return { texte: t("account.reauth.needed") };
    case "derniere":
      return { texte: t("account.passkeys.last") };
    case "passkeys_max":
      return { texte: t("account.passkeys.max") };
    case "deja_enregistree":
      return { texte: t("account.passkeys.deja") };
    case "webauthn_absent":
      return { texte: t("account.nopasskey") };
    case "webauthn_echec":
    case "options_invalides":
      return { texte: t("account.err.passkey") };
  }
  if (ILLISIBLE.has(code)) return { texte: t("account.err.coffre") };
  return { texte: t("account.err.autre") };
}

/** « 2026-11-21 » → « 2 » (année ajoutée si ce n'est pas l'année en cours). */
export function jourLong(iso: string, now = new Date()): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const year = d.getUTCFullYear() !== now.getUTCFullYear();
  return new Intl.DateTimeFormat(getLang(), { day: "numeric", month: "long", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(d);
}

/** « 2026-11 » → « novembre 2026 ». */
export function moisLong(m: string): string {
  const d = new Date(`${m}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? m : new Intl.DateTimeFormat(getLang(), { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

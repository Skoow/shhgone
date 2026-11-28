// Interface publique du client Shhdrop (pour l'interface du Plan 2). Seules les fonctions
// sûres sont exportées : la couche HTTP (transfer/api) et les dérivations de clés restent
// internes, pour qu'aucun écran ne puisse envoyer un secret au serveur par erreur.
export {
  BadPasswordError,
  CAPTCHA_MIN_MS,
  CATEGORIES,
  CATEGORIE_AUTRE,
  PREPARED_MIN_LEFT_MS,
  CorruptError,
  GrantInvalidError,
  StillOpenError,
  ReopenLimitError,
  grantTag,
  LimitError,
  NotFoundError,
  ReadBudgetError,
  EgressLimitError,
  ServerError,
  collectToBlob,
  createShare,
  destroyShare,
  fetchMeta,
  openShare,
  shareStatus,
  watchShares,
  type Categorie,
  type CaptchaProof,
  type CreateOpts,
  type Net,
  type Opened,
  type OpenOpts,
  type PreviewKind,
} from "./transfer/client";
export { prepareCaptcha, proofForm, type PreparedCaptcha } from "./transfer/prepare";
// Envoi dès l'ajout (spec §41.14) : brouillon et état des lignes.
export { createDraft, failedElement, type Draft, type ElementStatus } from "./transfer/draft";
export { SERVER_STALL_MS } from "./transfer/upload";
export { isRiskyName, previewKindOf, safeName as cleanName } from "./transfer/safety";
export { MANIFEST_MAX, PREVIEW_MAX, type KeepTtl, type Rights } from "./engine";
// Géométrie publique du paquet (aucune clé) : budget de lecture estimé par la page (flows/read-meter.ts).
export { CHUNK, SEG_CHUNKS, bucketFor, segmentCount, segmentSize } from "./engine";
// Place d'un fichier dans un envoi dès l'ajout (segments entiers, spec §41.14) : géométrie seulement.
export { DATA_SEGMENTS, contentMaxOf, dataSegmentsOf, segmentsFor, segmentsNeeded, type Palier } from "./engine";
export {
  CONTENT_MAX,
  MAX_ITEMS,
  MAX_OPENS,
  NAME_MAX,
  OPENS_DEFAULT,
  PW_TRIES,
  STRIP_MAX,
  TEXT_MAX,
  TITLE_MAX,
  TTL_DEFAULT,
  TTL_HOURS,
  TTL_MAX_HOURS,
  type TtlHours,
} from "./limits";
export { PASSWORD_ALPHABET, PASSWORD_LEN, generatePassword, isGeneratedPassword, type GeneratedPassword } from "./engine";
// Empreinte SHA-256 d'un fichier, affichée sur sa ligne avant l'envoi.
export { fileSha256 } from "./engine";
// Nom du partage : nettoyage du moteur, celui que verra le destinataire.
export { cleanTitle } from "./engine";
export {
  MANAGE_FRAGMENT,
  NO_PASSWORD_FRAGMENT,
  NO_PASSWORD_LINK_SHAPE,
  SHARE_FRAGMENT,
  SHARE_LINK_SHAPE,
  SHARE_PW_FRAGMENT,
  isNoPasswordLink,
  manageLink,
  parseLink,
  shareLink,
  shareLinkNoPassword,
  shareLinkWithPassword,
  splitPassword,
  type ParsedLink,
} from "./engine";
export type { Item, Manifest, ManifestClean, ManifestEntry, ManifestV2 } from "./engine";
export type { KAcces, KLien, KPreuve, SGestion } from "./engine";

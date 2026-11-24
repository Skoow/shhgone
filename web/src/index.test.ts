// L'interface publique n'expose ni la couche HTTP ni les dérivations de clés (audit M1).
import { describe, expect, it } from "vitest";
import * as pub from "./index";

describe("interface publique", () => {
  it("exactement les fonctions sûres", () => {
    expect(Object.keys(pub).sort()).toEqual(
      [
        "BadPasswordError",
        "CAPTCHA_MIN_MS",
        // Codes des catégories de signalement (conception compte §21.10.1) : constantes, aucun secret.
        "CATEGORIES",
        "CATEGORIE_AUTRE",
        // Empreinte SHA-256 d'un fichier, calculée sur l'appareil (16 novembre) : rien de secret n'en sort.
        "fileSha256",
        // Nom du partage (19 novembre) : nettoyage d'un texte de l'expéditeur, aucun secret.
        "cleanTitle",
        "TITLE_MAX",
        "GrantInvalidError",
        "ReopenLimitError",
        // Destruction par un destinataire avant la dernière ouverture (20 novembre).
        "StillOpenError",
        "grantTag",
        "CHUNK",
        "SEG_CHUNKS",
        "bucketFor",
        "segmentCount",
        "segmentSize",
        "DATA_SEGMENTS",
        "contentMaxOf",
        "dataSegmentsOf",
        "segmentsFor",
        "segmentsNeeded",
        "createDraft",
        "failedElement",
        "CONTENT_MAX",
        "CorruptError",
        "MAX_ITEMS",
        "MANIFEST_MAX",
        "MAX_OPENS",
        "NAME_MAX",
        "OPENS_DEFAULT",
        "STRIP_MAX",
        "TEXT_MAX",
        "TTL_DEFAULT",
        "PASSWORD_ALPHABET",
        "PASSWORD_LEN",
        "PW_TRIES",
        "ReadBudgetError",
        "EgressLimitError",
        "ServerError",
        "TTL_HOURS",
        "TTL_MAX_HOURS",
        "generatePassword",
        "LimitError",
        "NotFoundError",
        "PREVIEW_MAX",
        "SERVER_STALL_MS",
        "cleanName",
        "isRiskyName",
        "previewKindOf",
        "collectToBlob",
        "createShare",
        "destroyShare",
        "fetchMeta",
        "isGeneratedPassword",
        "MANAGE_FRAGMENT",
        "SHARE_FRAGMENT",
        "SHARE_LINK_SHAPE",
        "SHARE_PW_FRAGMENT",
        "shareLinkWithPassword",
        "splitPassword",
        "manageLink",
        "openShare",
        "parseLink",
        "prepareCaptcha",
        // Plan du compte, lot 10 : champs anti-robot des routes du compte (même preuve qu'un partage).
        "proofForm",
        "PREPARED_MIN_LEFT_MS",
        "shareLink",
        "shareStatus",
      ].sort(),
    );
  });
  it("constantes et nettoyage des noms", () => {
    expect(pub.SERVER_STALL_MS).toBe(780_000);
    expect(pub.PREVIEW_MAX).toBe(200 * 1048576);
    expect(pub.cleanName("../a\u202E.txt")).toBe("a.txt");
  });
});

// Types exportés (contrôle à la compilation par tsc).
export type _Types = [pub.CaptchaProof, pub.PreparedCaptcha, pub.GeneratedPassword, pub.Rights, pub.KeepTtl, pub.ManifestV2, pub.TtlHours];

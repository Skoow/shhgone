// Vignette EXIF gardée (décision du propriétaire) : elle peut montrer la photo d'avant un
// recadrage ou une retouche ; la bulle du balai, la confirmation et la page Sécurité le disent (test d'intrusion
// du 11 novembre).
import { describe, expect, test } from "vitest";
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";
import { infoPage } from "./content";

const all = (lang: "fr" | "en") => {
  const p = infoPage("securite", lang);
  return [p.lede, ...p.blocks.flatMap((b) => [...(b.p ?? []), ...(b.list ?? [])])].join("\n");
};
const FR_RE = /vignette[^.]*avant (un )?recadrage ou (une )?retouche/iu;
const EN_RE = /thumbnail[^.]*before (it was )?cropp(ed|ing) or edit(ed|ing)/iu;

describe("vignette d'aperçu gardée : dite honnêtement", () => {
  test("page Sécurité, en français et en anglais", () => {
    expect(all("fr")).toMatch(FR_RE);
    expect(all("en")).toMatch(EN_RE);
  });
  // Plus d'interrupteur dans le pied de page (décision du propriétaire du 12 novembre) : la bulle
  // du balai d'une photo et la confirmation de « Tout nettoyer » le disent avant de nettoyer.
  test("bulle du balai d'une photo et confirmation de « Tout nettoyer »", () => {
    for (const k of ["clean.what.photos", "clean.what.all"] as const) {
      expect(fr[k]).toMatch(FR_RE);
      expect(en[k]).toMatch(EN_RE);
    }
  });
});

// Compte par e-mail (plan du compte, lot 16 ; conception compte §16, §21.18). Règle : les textes
// qui décrivent le compte n'existent qu'avec __COMPTES__ ; les phrases communes restent vraies
// avec ou sans compte (le site public n'annonce pas une fonction absente).
const NOMS = ["securite", "confidentialite", "conditions", "mentions", "signaler"] as const;
const texte = (name: (typeof NOMS)[number], lang: "fr" | "en", comptes: boolean) => {
  const p = infoPage(name, lang, comptes);
  return [p.title, p.lede, ...p.blocks.flatMap((b) => [b.h, ...(b.p ?? []), ...(b.list ?? [])]), ...(p.tech ? [p.tech.h, ...(p.tech.p ?? []), ...(p.tech.list ?? [])] : [])].join("\n");
};
const tout = (lang: "fr" | "en", comptes: boolean) => NOMS.map((n) => texte(n, lang, comptes)).join("\n");

describe("textes publics et compte par e-mail", () => {
  test("aucune page ni aucun texte ne promet « ni e-mail » ni « 100 % » ; « Aucun cookie » reste écrit", () => {
    for (const comptes of [false, true]) {
      expect(tout("fr", comptes)).not.toMatch(/ni e-mail|100\s?%/iu);
      expect(tout("en", comptes)).not.toMatch(/no e-?mail|100\s?%/iu);
      expect(texte("confidentialite", "fr", comptes)).toContain("Aucun cookie de notre part");
      expect(texte("confidentialite", "en", comptes)).toContain("No cookies of ours");
    }
    for (const dict of [fr, en] as Record<string, string>[]) for (const [k, v] of Object.entries(dict)) expect(v, k).not.toMatch(/\b(ni e-mail|no e-?mail)\b|100\s?%/iu);
  });

  test("sans __COMPTES__ (site public d'aujourd'hui) : aucune page ne décrit le compte", () => {
    for (const lang of ["fr", "en"] as const) {
      const t = tout(lang, false);
      expect(t).not.toMatch(lang === "fr" ? /créez un compte|empreinte|séquestr|banni|pseudo/iu : /create an account|fingerprint|banned|nickname/iu);
      for (const n of NOMS) expect(infoPage(n, lang, false).blocks.some((b) => b.id === "compte"), n).toBe(false);
    }
  });

  test("avec __COMPTES__ : Confidentialité dit ce que garde le compte (empreinte, profil lisible, deux coffres, salons, catégories, motif, 7 jours, sauvegardes 7 jours, fournisseur, 13 mois)", () => {
    const f = texte("confidentialite", "fr", true);
    for (const re of [/Sans compte pour envoyer, recevoir ou rejoindre un salon/u, /qu'en empreinte/u, /pas en clair/u, /fournisseur d'envoi d'e-mails/u, /ne contient que le code/u, /ne quitte jamais votre appareil/u, /le service peut donc les lire/u, /second coffre, chiffré par votre mot de passe seulement/u, /quels salons votre compte a créés/u, /jamais quels partages/u, /au jour/u, /catégorie/u, /bannissement/u, /recours/u, /7 jours|7 jours/u, /30 jours/u, /13 mois/u, /exporter vos données/u])
      expect(f).toMatch(re);
    const e = texte("confidentialite", "en", true);
    for (const re of [/only as a fingerprint/u, /email delivery provider/u, /can therefore read them/u, /encrypted by your password only/u, /never which shares/u, /category/u, /appeal/u, /erased after 7 days/u, /in these copies for up to 7 days/u, /13 months/u]) expect(e).toMatch(re);
    expect(texte("conditions", "fr", true)).toMatch(/au moins 15 ans/u);
    expect(texte("conditions", "en", true)).toMatch(/at least 15/u);
    expect(texte("securite", "fr", true)).toMatch(/Ce que le compte ne protège pas/u);
    expect(texte("securite", "en", true)).toMatch(/What the account does not protect/u);
  });

  test("Signaler un abus : la catégorie part avec le signalement (feuille du lot 14, publique)", () => {
    expect(texte("signaler", "fr", false)).toMatch(/ne contient que la catégorie choisie/u);
    expect(texte("signaler", "fr", false)).not.toMatch(/ni le motif/u);
    expect(texte("signaler", "en", false)).toMatch(/only the category you chose/u);
  });

  test("Confidentialité : l'historique des téléchargements (lot 15, public) est dit", () => {
    expect(texte("confidentialite", "fr", false)).toMatch(/historique des téléchargements[^.]*chiffré sur cet appareil/u);
    expect(texte("confidentialite", "en", false)).toMatch(/downloads history[^.]*encrypted on this device/u);
  });

  test("accueil : la carte « Partage sans compte » ne parle du compte qu'avec __COMPTES__", () => {
    expect(fr["home.priv.account.p"]).not.toMatch(/salon|empreinte|en clair/u);
    expect(fr["home.priv.account.p.comptes"]).toMatch(/Pour créer un salon, une adresse e-mail que nous ne gardons pas en clair/u);
    expect(en["home.priv.account.p.comptes"]).toMatch(/To create a room, an email address/u);
  });
});

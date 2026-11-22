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

  test("Confidentialité : l'historique des téléchargements (lot 15, public) est dit, désactivé par défaut (22 novembre)", () => {
    expect(texte("confidentialite", "fr", false)).toMatch(/historique des téléchargements est désactivé par défaut[^.]*vous-même\. Activé, il garde chiffrés sur cet appareil/u);
    expect(texte("confidentialite", "fr", false)).toMatch(/le désactiver efface tout/u);
    expect(texte("confidentialite", "en", false)).toMatch(/downloads history is off by default[^.]*yourself\. When on[^.]*encrypted on this device/u);
    expect(texte("confidentialite", "en", false)).toMatch(/turning it off erases it all/u);
  });

  test("accueil : la carte « Partage sans compte » ne parle du compte qu'avec __COMPTES__", () => {
    expect(fr["home.priv.account.p"]).not.toMatch(/salon|empreinte|en clair/u);
    expect(fr["home.priv.account.p.comptes"]).toMatch(/Pour créer un salon, une adresse e-mail que nous ne gardons pas en clair/u);
    expect(en["home.priv.account.p.comptes"]).toMatch(/To create a room, an email address/u);
  });
});

// Paiement (conception du paiement §3, §7, §13, S16 à S19). La page Offres est publique, avec ou
// sans compte, et le paiement s'ouvre côté serveur (aucun drapeau de construction) : la section
// est toujours là, écrite au conditionnel « quand il est proposé ».
describe("Confidentialité : section paiement", () => {
  const section = (lang: "fr" | "en", comptes: boolean) => {
    const b = infoPage("confidentialite", lang, comptes).blocks.find((x) => x.id === "paiement");
    return b ? [b.h, ...(b.p ?? []), ...(b.list ?? [])].join("\n") : "";
  };
  test("en français, avec et sans compte", () => {
    for (const comptes of [false, true]) {
      const t = section("fr", comptes);
      for (const re of [
        /quand il est proposé/u,
        /page du prestataire/u,
        /Stripe[^.]*PayPal[^.]*NOWPayments/u,
        /aucun de leurs scripts/iu,
        /voit ce que vous lui donnez[^.]*votre adresse IP/u,
        /code à sens unique tiré du pass/u,
        /Jamais votre nom, votre adresse e-mail, votre pays, le montant ni votre adresse IP/u,
        /jamais à vos partages/u,
        /jeton anonyme/u,
        /sans pouvoir savoir de quel pass il vient/u,
        /jour de sa clé\. Un partage payant ne se cache donc que parmi les pass de la même offre qui ont pris des jetons ce jour-là ou la veille/u, // S19
        /au moment même du partage/u, // S16, résiduel
        /à une heure tirée au hasard/u, // S16, corrigé
        // S17 : clés annoncées 7 jours à l'avance, clé différente refusée, limite du premier contact.
        /annonce ses clés sept jours à l'avance/u,
        /refuse, avec un avertissement, une clé différente pour un jour déjà annoncé/u,
        /dès le premier contact ne serait pas détecté par cet appareil seul/u,
      ])
        expect(t).toMatch(re);
    }
  });
  test("en anglais, avec et sans compte", () => {
    for (const comptes of [false, true]) {
      const t = section("en", comptes);
      for (const re of [
        /when it is offered/u,
        /page of the provider you choose/u,
        /Stripe[^.]*PayPal[^.]*NOWPayments/u,
        /none of their scripts/iu,
        /sees what you give it[^.]*your IP address/u,
        /one-way code derived from the pass/u,
        /Never your name, your email address, your country, the amount or your IP address/u,
        /never to your shares/u,
        /anonymous token/u,
        /without being able to tell which pass it came from/u,
        /day of its key\. A paid share therefore only hides among the passes of the same plan that took tokens that day or the day before/u,
        /at the very moment of the share/u,
        /at a randomly drawn time/u,
        /announces its keys seven days ahead/u,
        /refuses, with a warning, a different key for a day already announced/u,
        /from the very first contact would not be detected by that device alone/u,
      ])
        expect(t).toMatch(re);
    }
  });
});

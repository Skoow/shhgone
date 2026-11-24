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

// Compte par passkey (conception du compte par passkey §8, §12). Règle : les textes
// qui décrivent le compte n'existent qu'avec __COMPTES__ ; les phrases communes restent vraies
// avec ou sans compte (le site public n'annonce pas une fonction absente).
const NOMS = ["securite", "confidentialite", "conditions", "mentions", "signaler"] as const;
const texte = (name: (typeof NOMS)[number], lang: "fr" | "en", comptes: boolean) => {
  const p = infoPage(name, lang, comptes);
  return [p.title, p.lede, ...p.blocks.flatMap((b) => [b.h, ...(b.p ?? []), ...(b.list ?? [])]), ...(p.tech ? [p.tech.h, ...(p.tech.p ?? []), ...(p.tech.list ?? [])] : [])].join("\n");
};
const tout = (lang: "fr" | "en", comptes: boolean) => NOMS.map((n) => texte(n, lang, comptes)).join("\n");

describe("textes publics et compte par passkey", () => {
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

  test("avec __COMPTES__ : Confidentialité dit ce que garde le compte par passkey (clés publiques pseudonymes, clé de récupération, profil illisible, deux coffres, gestionnaires, salons, catégories, recours, sauvegardes 7 jours, 13 mois)", () => {
    const f = texte("confidentialite", "fr", true);
    for (const re of [
      /Sans compte pour envoyer, recevoir ou rejoindre un salon/u,
      /Pour créer un salon, un compte sans e-mail ni mot de passe, par passkey/u,
      /clé publique/u,
      /données pseudonymes/u,
      /restent des données personnelles/u,
      /Votre clé de récupération ne quitte jamais votre appareil/u,
      /Votre pseudo, votre photo et votre abonnement sont chiffrés sur vos appareils : le service ne peut pas les lire\./u,
      /second coffre/u,
      /Apple, Google ou votre gestionnaire de mots de passe/u,
      /quels salons votre compte a créés/u,
      /jamais quels partages/u,
      /au jour/u,
      /catégorie/u,
      /bannissement/u,
      /recours/u,
      /7 jours/u,
      /30 jours/u,
      /13 mois/u,
      /exporter vos données/u,
    ])
      expect(f).toMatch(re);
    // Le séquestre a disparu (conception §8) : plus rien ne dit que le service peut lire le profil.
    expect(f).not.toMatch(/peut donc les lire|peut lire votre profil|mot de passe oublié|adresse e-mail n'est gardée|fournisseur d'envoi/u);
    const e = texte("confidentialite", "en", true);
    for (const re of [/neither email nor password, using a passkey/u, /public key/u, /pseudonymous data/u, /Your recovery key never leaves your device/u, /the service cannot read them/u, /Apple, Google or your password manager/u, /never which shares/u, /category/u, /appeal/u, /erased after 7 days/u, /in these copies for up to 7 days/u, /13 months/u]) expect(e).toMatch(re);
    expect(e).not.toMatch(/can therefore read them|can read your profile|forgotten password|email delivery/u);
    expect(texte("conditions", "fr", true)).toMatch(/au moins 15 ans/u);
    expect(texte("conditions", "fr", true)).toMatch(/Sans passkey ni clé de récupération, le compte ne peut pas être récupéré/u);
    expect(texte("conditions", "en", true)).toMatch(/at least 15/u);
    expect(texte("securite", "fr", true)).toMatch(/Ce que le compte ne protège pas/u);
    expect(texte("securite", "fr", true)).toMatch(/Votre clé de récupération est la clé du compte : qui la lit peut prendre le compte/u);
    expect(texte("securite", "fr", true)).toMatch(/protégée seulement par son verrouillage/u);
    expect(texte("securite", "en", true)).toMatch(/What the account does not protect/u);
    for (const lang of ["fr", "en"] as const) expect(tout(lang, true)).not.toMatch(/e-?mail\b[^.]*(code|empreinte|fingerprint)|double authentification|two-factor|séquestr|escrow/iu);
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

  test("Confidentialité, « Sur votre appareil » : l'historique des envois, ce qu'il garde, désactivé par défaut avec ou sans compte (24 novembre, B), 7 jours, comment l'effacer (24 novembre)", () => {
    for (const comptes of [false, true]) {
      const fr = infoPage("confidentialite", "fr", comptes).blocks.find((b) => b.h === "Sur votre appareil")!.list!.find((l) => l.startsWith("L'historique de vos envois"))!;
      expect(fr).toMatch(/lien de gestion[^.]*jamais le lien de partage ni le mot de passe\./u);
      expect(fr).toMatch(/Il est désactivé par défaut, avec ou sans compte : rien n'est gardé tant que vous n'activez pas vous-même « Garder dans mon historique » ; « Lien prêt » et « Salon prêt » vous montrent alors le lien de gestion/u);
      expect(fr).toMatch(/7 jours après la fin/u);
      expect(fr).toMatch(/« Effacer l'historique » dans « Mes partages » efface tout\./u);
      const en = infoPage("confidentialite", "en", comptes).blocks.find((b) => b.h === "On your device")!.list!.find((l) => l.startsWith("The history of what you send"))!;
      expect(en).toMatch(/management link[^.]*never the share link or the password\./u);
      expect(en).toMatch(/It is off by default, with or without an account: nothing is kept until you turn on “Keep in my history” yourself; “Link ready” and “Room ready” then show you the management link/u);
      expect(en).toMatch(/7 days after the share or room ends/u);
      expect(en).toMatch(/“Clear history” in “My shares” erases it all\./u);
    }
    // Les libellés cités sont ceux de l'interface.
    expect([fr["ready.keep"], fr["hist.clear"], fr["hist.remove"], fr["hist.title"]]).toEqual(["Garder dans mon historique", "Effacer l'historique", "Retirer de la liste", "Mes partages"]);
    expect([en["ready.keep"], en["hist.clear"], en["hist.remove"], en["hist.title"]]).toEqual(["Keep in my history", "Clear history", "Remove from list", "My shares"]);
  });

  test("Sécurité, détails techniques : taille exacte (à 4 Mio près pendant l'envoi, qui commence dès l'ajout ; palier seul au repos)", () => {
    const tech = (lang: "fr" | "en") => infoPage("securite", lang).tech!.list!.find((l) => l.startsWith(lang === "fr" ? "Taille" : "Size"))!;
    expect(tech("fr")).toMatch(/commence dès qu'un fichier est ajouté, avant « Chiffrer et envoyer »/u);
    expect(tech("fr")).toMatch(/Pendant l'envoi, le serveur voit la taille à 4 Mio près/u);
    expect(tech("fr")).toMatch(/le serveur ne connaît plus que ce palier\./u);
    expect(tech("en")).toMatch(/starts as soon as a file is added, before “Encrypt and send”/u);
    expect(tech("en")).toMatch(/During the upload, the server sees the size to within 4 MiB/u);
    expect(tech("en")).toMatch(/the server then knows only that tier\./u);
    expect(fr["options.submit"]).toBe("Chiffrer et envoyer");
    expect(en["options.submit"]).toBe("Encrypt and send");
    expect(JSON.stringify(infoPage("securite", "fr"))).not.toMatch(/ne connaît que le palier/u);
    expect(JSON.stringify(infoPage("securite", "en"))).not.toMatch(/only knows the tier/u);
  });

  test("accueil : la carte « Partage sans compte » ne parle du compte qu'avec __COMPTES__", () => {
    expect(fr["home.priv.account.p"]).not.toMatch(/salon|empreinte|en clair/u);
    expect(fr["home.priv.account.p.comptes"]).toMatch(/Pour créer un salon, un compte sans e-mail ni mot de passe, par passkey\./u);
    expect(en["home.priv.account.p.comptes"]).toMatch(/To create a room, an account with neither email nor password, using a passkey\./u);
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
        // Appels réservés à Plus et Pro (24 novembre) : un jeton ouvre les appels du salon ; ce
        // que voit le serveur, y compris quand c'est le créateur (connu par son compte).
        /appels audio et vidéo des salons sont réservés à Plus et Pro/u,
        /ouvre les appels pour tout le salon jusqu'à sa fin ; les autres participants n'ont besoin d'aucune offre/u,
        /si c'est le créateur du salon[^.]*ce compte a Plus ou Pro/u,
        /de même pour un appel lancé juste après/u,
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
        /calls in rooms are reserved for Plus and Pro/u,
        /opens calls for the whole room until it ends; the other participants need no plan/u,
        /if it is the room's creator[^.]*this account has Plus or Pro/u,
        /the same goes for a call started right after/u,
      ])
        expect(t).toMatch(re);
    }
  });
});

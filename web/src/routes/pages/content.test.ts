// Vignette EXIF gardée : elle peut montrer la photo d'avant un
// recadrage ou une retouche ; la bulle du balai, la confirmation et la page Sécurité le disent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { en } from "../../i18n/en";
import { fr } from "../../i18n/fr";
import { CONTACT_EMAIL, infoPage, type Block, type InfoName, type InfoPage } from "./content";

/** Tout le texte affiché d'une page : sections, parties, commandes, liens, détails techniques. */
const PAGES: readonly InfoName[] = ["securite", "confidentialite", "conditions", "mentions", "signaler", "contact"];
const blocTexte = (b: Block) => [b.h, ...(b.p ?? []), ...(b.list ?? []), ...(b.code ?? []), ...(b.after ?? []), b.link?.label ?? "", ...(b.sub ?? []).flatMap((s) => [s.h, ...(s.p ?? []), ...(s.list ?? []), ...(s.code ?? []), ...(s.after ?? [])])];
const pageTexte = (p: InfoPage) => [p.title, p.lede, ...p.blocks.flatMap(blocTexte), p.tech?.h ?? "", ...(p.tech?.p ?? []), ...(p.tech?.list ?? [])].join("\n");

// Un abonné a des partages et des appels inclus : le mécanisme anonyme reste interne, jamais le
// mot « jeton » ni « token » dans un texte affiché (la commande de vérification garde l'adresse de
// l'émetteur de GitHub, qui n'est pas un texte).
describe("aucun « jeton » ni « token » affiché", () => {
  test("pages d'information et dictionnaires, en français et en anglais, avec et sans compte", () => {
    for (const comptes of [false, true])
      for (const lang of ["fr", "en"] as const)
        for (const nom of PAGES) {
          // L'adresse de l'émetteur de GitHub (token.actions…) est dans une commande, pas un texte.
          const texte = pageTexte(infoPage(nom, lang, comptes)).replace("https://token.actions.githubusercontent.com", "");
          expect(texte, `${nom} ${lang}`).not.toMatch(/\bjetons?\b|\btokens?\b/iu);
        }
    for (const [lang, d] of [["fr", fr], ["en", en]] as const)
      for (const [k, v] of Object.entries(d)) expect(v, `${lang} ${k}`).not.toMatch(/\bjetons?\b|\btokens?\b/iu);
  });
});

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
  // Plus d'interrupteur dans le pied de page : la bulle
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
      /13 mois/u,
      /la page Compte montre ce que nous gardons/u,
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
  test("Signaler un abus : la catégorie part avec le signalement (feuille, publique)", () => {
    expect(texte("signaler", "fr", false)).toMatch(/ne contient que la catégorie choisie/u);
    expect(texte("signaler", "fr", false)).not.toMatch(/ni le motif/u);
    expect(texte("signaler", "en", false)).toMatch(/only the category you chose/u);
  });

  test("Confidentialité : plus d'historique des téléchargements (D42-33), l'ancien est effacé", () => {
    expect(texte("confidentialite", "fr", false)).toMatch(/Aucun historique des fichiers que vous recevez n'est gardé/u);
    expect(texte("confidentialite", "fr", false)).not.toMatch(/historique des téléchargements est désactivé/u);
    expect(texte("confidentialite", "en", false)).toMatch(/No history of the files you receive is kept/u);
  });

  // 26 novembre (spec §33, D42-30) : « Mes partages » gardé d'office, ce qui y est (et jamais), la
  // perte sans compte ; aucune liste des liens reçus.
  test("Confidentialité, « Sur votre appareil » : Mes partages (texte exact), jamais le lien d'un partage ni un mot de passe", () => {
    for (const comptes of [false, true]) {
      const fr = infoPage("confidentialite", "fr", comptes).blocks.find((b) => b.h === "Sur votre appareil")!.list!;
      expect(fr).toContain("Mes partages et Mes salons : chaque partage que vous envoyez et chaque salon que vous créez sont gardés chiffrés sur cet appareil, pour les suivre et les supprimer : le lien de gestion, le nom du partage, sa taille, son nombre d'éléments, son échéance et ses ouvertures ; pour un salon, son lien de gestion et son lien d'invitation. Jamais le lien d'un partage, ni un mot de passe, ni le nom d'un fichier. Une entrée s'efface 7 jours après la fin du partage, et vous pouvez la retirer à tout moment. Sans compte, effacer les données de ce navigateur efface la liste, et avec elle la gestion de ces partages. Aucune liste des liens reçus n'est gardée.");
      expect(fr.join(" ")).not.toMatch(/Garder dans mon historique|Garder ce partage/u);
      const en = infoPage("confidentialite", "en", comptes).blocks.find((b) => b.h === "On your device")!.list!;
      expect(en.join(" ")).toMatch(/My shares and My rooms: every share you send and every room you create are kept encrypted on this device/u);
      expect(en.join(" ")).toMatch(/No list of the links you receive is kept/u);
    }
    expect(texte("confidentialite", "fr", true)).toMatch(/Ce second coffre garde aussi « Mes partages »/u);
    expect(texte("confidentialite", "fr", true)).not.toMatch(/exporter vos données/u);
    expect(texte("confidentialite", "en", true)).not.toMatch(/export your data/u);
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

  test("accueil : la carte « Aucune identité demandée » ne parle du compte qu'avec __COMPTES__", () => {
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
        /preuve anonyme/u,
        /sans pouvoir savoir de quel pass elle vient/u,
        /jour de sa clé\. Un partage payant ne se cache donc que parmi les pass de la même offre qui ont pris des preuves ce jour-là ou la veille/u, // S19
        /au moment même du partage/u, // S16, résiduel
        /à une heure tirée au hasard/u, // S16, corrigé
        // S17 : clés annoncées 7 jours à l'avance, clé différente refusée, limite du premier contact.
        /annonce ses clés sept jours à l'avance/u,
        /refuse, avec un avertissement, une clé différente pour un jour déjà annoncé/u,
        /dès le premier contact ne serait pas détecté par cet appareil seul/u,
        // Appels réservés à Plus et Pro : une preuve anonyme ouvre les appels du salon ; ce
        // que voit le serveur, y compris quand c'est le créateur (connu par son compte).
        /appels audio et vidéo des salons sont réservés à Plus et Pro/u,
        /ouvre les appels pour tout le salon jusqu'à sa fin ; les autres participants n'ont besoin d'aucune offre/u,
        // Accès offert nommé par l'exploitant (noms_offerts, 25 novembre) : dit sur la page.
        /offrir un accès sans paiement et y associer un nom ou une note/u,
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
        /anonymous proof/u,
        /without being able to tell which pass it came from/u,
        /day of its key\. A paid share therefore only hides among the passes of the same plan that took proofs that day or the day before/u,
        /at the very moment of the share/u,
        /at a randomly drawn time/u,
        /announces its keys seven days ahead/u,
        /refuses, with a warning, a different key for a day already announced/u,
        /from the very first contact would not be detected by that device alone/u,
        /calls in rooms are reserved for Plus and Pro/u,
        /opens calls for the whole room until it ends; the other participants need no plan/u,
        /give an access without payment and attach a name or a note to it/u,
        /if it is the room's creator[^.]*this account has Plus or Pro/u,
        /the same goes for a call started right after/u,
      ])
        expect(t).toMatch(re);
    }
  });
});

// « Vérifier cette version » (spec §28.4, §28.8 C1 et C7) : section de la page Sécurité (25
// novembre, demande du propriétaire), même contenu que l'ancienne page « /verifier ».
describe("section « Vérifier cette version » de la page Sécurité", () => {
  const section = (lang: "fr" | "en", comptes = false) => infoPage("securite", lang, comptes).blocks.find((b) => b.id === "verifier")!;
  const sub = (lang: "fr" | "en", id: string) => section(lang).sub!.find((s) => s.id === id)!;
  const textes = (lang: "fr" | "en") => {
    const p = infoPage("securite", lang);
    return [...blocTexte(section(lang)), ...(p.tech?.list ?? [])].join("\n");
  };

  test("titre exact, dernière section, avec ou sans compte ; ses parties dans l'ordre", () => {
    for (const comptes of [false, true]) {
      expect(section("fr", comptes).h).toBe("Vérifier cette version");
      expect(section("en", comptes).h).toBe("Verify this version");
      for (const lang of ["fr", "en"] as const) expect(infoPage("securite", lang, comptes).blocks.at(-1)?.id).toBe("verifier");
    }
    for (const lang of ["fr", "en"] as const) expect(section(lang).sub!.map((s) => s.id)).toEqual(["pourquoi", "preuve", "version", "commandes", "verif-limites"]);
    expect(section("fr").p).toEqual(["Vous n'avez pas à nous croire sur parole : n'importe qui peut vérifier que les fichiers servis par ce site sont exactement ceux construits depuis notre code public."]);
  });
  // Identité exacte du signataire, lue dans deploy/provenance.sh : la page dit ce que vérifie deploy.sh.
  const provenance = readFileSync(fileURLToPath(new URL("../../../../deploy/provenance.sh", import.meta.url)), "utf8");
  const depot = /^readonly PROVENANCE_DEPOT=(\S+)$/mu.exec(provenance)?.[1];

  test("la phrase imposée par la spec, en français et en anglais", () => {
    expect(textes("fr")).toContain("Cette page ne peut pas prouver sa propre intégrité : un serveur piégé pourrait la modifier aussi. Vérifiez avec un outil qui ne vient pas de ce site.");
    expect(textes("en")).toContain("This page cannot prove its own integrity: a tampered server could change it too. Verify with a tool that does not come from this site.");
  });

  test("limites honnêtes : victime ciblée, contrôle automatique compris ; apps natives ; en-têtes ; jamais « 100 % »", () => {
    expect(textes("fr")).toMatch(/code piégé à une seule personne[^.]*contrôle automatique compris/u);
    expect(textes("fr")).toMatch(/applications iOS et Android/u);
    expect(textes("fr")).toMatch(/en-têtes du serveur\) ne sont pas vérifiés/u);
    expect(textes("en")).toMatch(/tampered code to a single person[^.]*automatic check included/u);
    expect(textes("en")).toMatch(/iOS and Android apps/u);
    for (const lang of ["fr", "en"] as const) expect(textes(lang)).not.toMatch(/100\s?%|garanti|guarantee/iu);
  });

  test("commandes : identité exacte de deploy/provenance.sh, émetteur de GitHub, jamais d'expression ouverte ni sans journal", () => {
    expect(depot).toBe("Skoow/shhgone");
    for (const lang of ["fr", "en"] as const) {
      const code = sub(lang, "commandes").code ?? [];
      const tout = code.join("\n");
      expect(tout).toContain(`--certificate-identity "https://github.com/${depot}/.github/workflows/release.yml@refs/tags/web-v$v"`);
      expect(tout).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
      expect(tout).toContain(`https://github.com/${depot}/releases/download/web-v$v/release.json.sigstore.json`);
      expect(tout).toMatch(/verify-site\.mjs https:\/\/shhgone\.com release\.json$/mu);
      expect(tout).not.toMatch(/regexp|\.\*|insecure|ignore-tlog/u);
      // Le vérificateur vient de GitHub, pas du site vérifié.
      expect(tout).toContain(`clone https://github.com/${depot}`);
      expect(tout).not.toMatch(/curl[^\n]*shhgone\.com/u);
    }
  });

  test("aucune empreinte calculée ni affichée par la page (C7) ; version du build citée", () => {
    for (const lang of ["fr", "en"] as const) {
      expect(textes(lang)).not.toMatch(/\b[0-9a-f]{40,}\b/u);
      expect(sub(lang, "version").p?.join(" ")).toContain("dev"); // BUILD_ID des tests
    }
  });

  test("liens : seulement le dépôt public et le journal de Sigstore (liens sortants, rien n'est chargé), sans doublon", () => {
    for (const lang of ["fr", "en"] as const) {
      const links = infoPage("securite", lang).tech?.links ?? [];
      for (const l of links) expect(l.url).toMatch(/^https:\/\/(github\.com\/Skoow\/shhgone(\/|$)|search\.sigstore\.dev\/$)/u);
      expect(new Set(links.map((l) => l.url)).size).toBe(links.length);
      expect(links.map((l) => l.url)).toEqual(expect.arrayContaining(["https://github.com/Skoow/shhgone/releases", "https://search.sigstore.dev/"]));
    }
  });

  test("« Ce que Shhgone ne peut pas faire » mène à la section, sans « # » (adresse /verifier)", () => {
    for (const lang of ["fr", "en"] as const) expect(infoPage("securite", lang).blocks.find((b) => b.id === "limites")?.link).toMatchObject({ path: "/verifier", section: "verifier" });
  });

  test("un écart se signale par la page Contact ; le lien des versions publiées est dit en bas de la page", () => {
    expect(textes("fr")).toMatch(/Toute autre réponse est un écart : écrivez-nous \(page Contact\)\./u);
    expect(textes("en")).toMatch(/Any other answer is a difference: write to us \(Contact page\)\./u);
    expect(textes("fr")).toMatch(/lien dans les détails techniques, en bas de cette page/u);
    expect(textes("en")).toMatch(/link in the technical details, at the bottom of this page/u);
  });
});

// Pages juridiques (mentions simples, éditeur anonyme,
// aucun champ d'identité à compléter sur le site ; conditions de vente et confidentialité
// complétées selon ce que fait le site). Chiffres comparés au code (limits.ts, offres.go,
// service.go).
describe("pages juridiques : conditions de vente, confidentialité, mentions", () => {
  const offres = readFileSync(fileURLToPath(new URL("../../../../server/internal/paiement/offres.go", import.meta.url)), "utf8");
  const service = readFileSync(fileURLToPath(new URL("../../../../server/internal/paiement/service.go", import.meta.url)), "utf8");
  const bloc = (name: "conditions" | "confidentialite" | "mentions", lang: "fr" | "en", id: string, comptes = true) => {
    const b = infoPage(name, lang, comptes).blocks.find((x) => x.id === id);
    return b ? [b.h, ...(b.p ?? []), ...(b.list ?? [])].join("\n") : "";
  };

  test("conditions de vente : prix TTC, partages inclus et durées lus dans le code, rétractation, renouvellement", () => {
    expect(offres).toMatch(/Nom: "plus"[^\n]*Mois: 700, An: 7000, JetonsPeriod: 30,/u);
    expect(offres).toMatch(/Nom: "pro"[^\n]*Mois: 2000, An: 20000, JetonsPeriod: 100,/u);
    for (const comptes of [false, true]) {
      const f = bloc("conditions", "fr", "vente", comptes);
      for (const re of [
        /Plus 7 € par mois ou 70 € par an ; Pro 20 € par mois ou 200 € par an/u,
        /2 ou 3 jours et 10 ouvertures/u,
        /2, 3 ou 7 jours et 20 ouvertures/u,
        /30 \(Plus\) ou 100 \(Pro\) par période de 30 jours/u,
        /un mois compte 30 jours, un an 365 jours/u,
        /14 jours pour vous rétracter/u,
        /case non cochée d'avance/u,
        /jamais choisi pour vous/u,
        /« Arrêter le renouvellement »/u,
        /Union européenne seulement/u,
        /L224-25-12/u,
      ])
        expect(f).toMatch(re);
      const e = bloc("conditions", "en", "vente", comptes);
      for (const re of [
        /Plus €7 a month or €70 a year; Pro €20 a month or €200 a year/u,
        /2 or 3 days and 10 opens/u,
        /2, 3 or 7 days and 20 opens/u,
        /30 \(Plus\) or 100 \(Pro\) per 30-day period/u,
        /14 days to withdraw/u,
        /“Stop renewal”/u,
        /“Download the sales receipt”/u,
      ])
        expect(e).toMatch(re);
    }
    // Libellés cités : ceux de l'interface.
    expect([fr["offers.ret.stop"], fr["offers.ret.note"], fr["offers.title"]]).toEqual(["Arrêter le renouvellement", "Télécharger la note de vente", "Offres"]);
    expect([en["offers.ret.stop"], en["offers.ret.note"], en["offers.title"]]).toEqual(["Stop renewal", "Download the sales receipt", "Plans"]);
  });

  test("Conditions : aucune coordonnée ni nom d'hébergeur (ui-e2e/pages.spec.ts), aucune case à compléter", () => {
    for (const lang of ["fr", "en"] as const)
      for (const comptes of [false, true]) expect(texte("conditions", lang, comptes)).not.toMatch(/@|SAS|SARL|OVH|Hetzner|Scaleway|COMPLÉTER|TO BE COMPLETED/u);
  });

  test("Confidentialité : durées du paiement lues dans service.go, appels par le relais, contact, hébergement, CNIL", () => {
    expect(service).toMatch(/gardeAttente = 7 \* jourS/u);
    expect(service).toMatch(/gardeLitiges = 180 \* jourS/u);
    expect(service).toMatch(/gardePass {4}= 31 \* jourS/u);
    for (const comptes of [false, true]) {
      expect(bloc("confidentialite", "fr", "paiement", comptes)).toMatch(/non payée est effacée après 7 jours[^.]*180 jours après la fin de l'offre[^.]*31 jours après la fin/u);
      expect(bloc("confidentialite", "fr", "paiement", comptes)).toMatch(/responsables de leurs propres traitements/u);
      expect(bloc("confidentialite", "fr", "appels", comptes)).toMatch(/chiffrés de bout en bout[^.]*DTLS-SRTP/u);
      expect(bloc("confidentialite", "fr", "appels", comptes)).toMatch(/en mémoire seulement ; rien n'est écrit sur disque/u);
      expect(bloc("confidentialite", "fr", "contact", comptes)).toMatch(/hébergée par OVH/u);
      expect(bloc("confidentialite", "fr", "hebergement", comptes)).toMatch(/en France/u);
      expect(bloc("confidentialite", "en", "appels", comptes)).toMatch(/end-to-end encrypted[^.]*DTLS-SRTP/u);
      expect(bloc("confidentialite", "en", "paiement", comptes)).toMatch(/180 days after the plan ends/u);
      for (const lang of ["fr", "en"] as const) {
        expect(texte("confidentialite", lang, comptes)).toMatch(/cnil\.fr/u);
        expect(texte("confidentialite", lang, comptes)).not.toContain("@");
      }
    }
  });

  test("Mentions légales : éditeur anonyme gardé, hébergeur OVH en France, bandeau gardé jusqu'à l'avis de l'avocat", () => {
    for (const lang of ["fr", "en"] as const) {
      expect(infoPage("mentions", lang).draft).toBe(true);
      const t = texte("mentions", lang, true);
      expect(t).toMatch(/article 1-1, II/u);
      expect(t).toContain("contact@shhgone.com");
      expect(t).toMatch(/OVH SAS[\s\S]*Strasbourg/u);
      expect(t).not.toMatch(/COMPLÉTER|TO BE COMPLETED|SIREN/u);
    }
  });
});

// Page Contact (25 novembre, demande du propriétaire) : l'adresse de contact n'est écrite que sur
// Contact et sur les Mentions légales (obligation légale) ; aucune autre page ne porte d'adresse.
describe("page Contact et adresses e-mail", () => {
  test("une adresse e-mail seulement sur Contact (bloc « mail ») et Mentions légales, jamais ailleurs", () => {
    expect(CONTACT_EMAIL).toBe("contact@shhgone.com");
    for (const comptes of [false, true])
      for (const lang of ["fr", "en"] as const)
        for (const nom of PAGES) {
          const p = infoPage(nom, lang, comptes);
          const texte = pageTexte(p);
          const mails = p.blocks.filter((b) => b.mail);
          if (nom === "contact") {
            expect(mails.map((b) => b.id), `${nom} ${lang}`).toEqual(["adresse"]);
            expect(texte).not.toContain("@"); // l'adresse vient de CONTACT_EMAIL, rendue par InfoPage
          } else {
            expect(mails, `${nom} ${lang}`).toEqual([]);
            if (nom !== "mentions") expect(texte, `${nom} ${lang}`).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+|mailto/u);
            else expect(texte.match(/[\w.+-]+@[\w.-]+/gu)?.every((m) => m === CONTACT_EMAIL)).toBe(true);
          }
        }
  });

  test("contenu : pour quoi écrire, ce qu'il ne faut jamais envoyer, langues ; ni adresse postale ni délai promis", () => {
    const f = pageTexte(infoPage("contact", "fr", false));
    for (const re of [/En français ou en anglais/u, /Signaler un abus/u, /autorités[^.]*demandes de retrait/u, /RGPD/u, /CNIL/u, /faille/u, /Le lien complet d'un partage, avec son mot de passe s'il en a un/u, /Seule exception, un signalement d'abus par écrit/u, /hébergée par OVH/u])
      expect(f).toMatch(re);
    const e = pageTexte(infoPage("contact", "en", false));
    for (const re of [/In French or English/u, /Report abuse/u, /removal requests/u, /GDPR/u, /flaw/u, /The full link of a share, with its password if it has one/u, /The only exception is a written abuse report/u]) expect(e).toMatch(re);
    for (const lang of ["fr", "en"] as const)
      for (const comptes of [false, true]) {
        const t = pageTexte(infoPage("contact", lang, comptes));
        expect(t).not.toMatch(/\b\d{5}\b|rue |street|BP \d|cedex|\d+\s?(h|heures?|hours?|jours?|days?)\b|sous \d|within \d|délai|promptly|rapidement/iu);
      }
    expect(infoPage("contact", "fr").blocks.find((b) => b.id === "pourquoi")?.link?.path).toBe("/signaler");
    // Avec le compte : la clé de récupération ne s'envoie jamais non plus.
    expect(pageTexte(infoPage("contact", "fr", true))).toMatch(/jamais un mot de passe ni votre clé de récupération/u);
    expect(pageTexte(infoPage("contact", "fr", false))).not.toMatch(/clé de récupération/u);
  });

  test("les autres pages renvoient vers la page Contact, plus vers « le contact des mentions légales »", () => {
    for (const comptes of [false, true])
      for (const lang of ["fr", "en"] as const) for (const nom of PAGES) expect(pageTexte(infoPage(nom, lang, comptes))).not.toMatch(/contact des mentions légales|contact in the legal notice|adresse est dans les mentions|address is in the legal notice/u);
    for (const [k, v] of Object.entries({ ...fr, ...en })) expect(v, k).not.toMatch(/contact des mentions légales|contact in the legal notice/u);
    expect(infoPage("mentions", "fr").blocks.some((b) => b.link?.path === "/contact")).toBe(true);
    expect(infoPage("confidentialite", "en", true).blocks.some((b) => b.link?.path === "/contact")).toBe(true);
  });
});

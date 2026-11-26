// Pages d'information : Sécurité, Confidentialité, Conditions
// d'utilisation, Mentions légales, Signaler un abus, Contact. Textes relus sur la spécification
// (docs/conception/specs/2026-11-03-shhdrop-design.md : §2, §5.3, §7, §9, §18, §35, §36, §41.4,
// §41.8, D41-28, D41-29). Règles : jamais « 100 % », aucune allégation d'audit ni de pays
// d'hébergement, aucune identité d'éditeur ni d'hébergeur inventée (champs « à
// compléter »), aucune adresse e-mail hors des pages Contact et Mentions légales (CONTACT_EMAIL).
// Chiffres lus dans les constantes.
// « Vérifier cette version » (spec §28.4), section de la page Sécurité (l'adresse « /verifier » y
// mène) : comment n'importe qui vérifie que le site servi est le build public signé ; elle n'affiche aucune empreinte calculée par elle-même (une
// preuve qui se certifierait seule, §28.8 C7) et dit qu'elle ne peut pas prouver sa propre intégrité.
// Compte par passkey (conception 2026-11-22-compte-passkey-design.md §8, §12) : les textes qui
// DÉCRIVENT le compte ne s'ajoutent qu'avec __COMPTES__ (COMPTE_FR, COMPTE_EN) : le site public
// n'annonce pas une fonction absente. Les phrases communes restent vraies dans les deux cas.
// Mentions légales simples, éditeur anonyme gardé, aucun
// champ d'identité à compléter sur le site ; hébergement en France chez OVH dit (Mentions,
// Confidentialité), ce qui remplace la règle B3 ; conditions de vente des offres Plus et Pro et
// confidentialité complétées selon le code. Ce qui manque avant la vente réelle :
// docs/juridique/avant-la-vente.md. Tous ces textes sont à relire par l'avocat.
import { BUILD_ID } from "../../app/build";
import { CONTENT_MAX, MAX_ITEMS, MAX_OPENS, PAID, PW_TRIES, TTL_MAX_HOURS } from "../../limits";
import { formatBytes, type Lang } from "../../i18n/format";

export type InfoName = "securite" | "confidentialite" | "conditions" | "mentions" | "signaler" | "contact";
/** Partie d'une section, sous un titre de niveau 3 (section « Vérifier cette version » de la page Sécurité). */
export type Sub = { id: string; h: string; p?: string[]; list?: string[]; code?: string[]; after?: string[] };
/**
 * Section : paragraphes, liste, puis des lignes de commande à recopier, affichées telles quelles,
 * et des paragraphes après elles ; `sub` : parties sous un titre de niveau 3 ; `mail` : l'adresse
 * de contact, avec « Copier l'adresse » (page Contact seulement) ; `link` : lien vers une autre
 * page du site, ou, avec `section`, vers une section de la même page (sans « # » : le « # » est
 * réservé aux clés).
 */
export type Block = {
  id?: string;
  h: string;
  p?: string[];
  list?: string[];
  code?: string[];
  after?: string[];
  sub?: Sub[];
  mail?: true;
  link?: { label: string; path: string; section?: string };
};
/** Section repliée en bas de page (Sécurité : détails techniques pour les experts, liens publics). */
export type Tech = { h: string; p?: string[]; list?: string[]; links: { label: string; url: string }[] };
export type InfoPage = { title: string; lede: string; draft?: boolean; blocks: Block[]; tech?: Tech };

/** Dépôt public du code (lien sortant simple : rien n'est chargé depuis GitHub). */
export const SOURCE_URL = "https://github.com/Skoow/shhgone";
export const SPEC_URL = "https://github.com/Skoow/shhgone/blob/main/docs/conception/specs/2026-11-03-shhdrop-design.md";
/** Releases signées (spec §28.2) et mode d'emploi détaillé (deploy/README.md §3.3). */
export const RELEASES_URL = "https://github.com/Skoow/shhgone/releases";
export const VERIFY_DOC_URL = "https://github.com/Skoow/shhgone/blob/main/deploy/README.md";
/** Journal public de transparence de Sigstore (Rekor), consultable par tous. */
export const REKOR_URL = "https://search.sigstore.dev/";
/**
 * Adresse de contact (mentions légales, point de contact unique du règlement européen sur les
 * services numériques). Écrite seulement sur les pages Contact et Mentions légales (test).
 */
export const CONTACT_EMAIL = "contact@shhgone.com";

/**
 * Commandes de vérification (deploy/README.md §3.3) : identité exacte du signataire, jamais une
 * expression ouverte (spec §28.2, §28.8 C1). `v` : texte à la place du numéro de version.
 */
export function verifyCommands(v: string): string[] {
  const rel = "https://github.com/Skoow/shhgone/releases/download/web-v$v";
  return [
    `v=${v}`,
    `curl -fsSLO ${rel}/release.json`,
    `curl -fsSLO ${rel}/release.json.sigstore.json`,
    "cosign verify-blob release.json --bundle release.json.sigstore.json \\",
    "  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\",
    '  --certificate-identity "https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$v"',
    "git clone https://github.com/Skoow/shhgone",
    "node shhgone/web/scripts/verify-site.mjs https://shhgone.com release.json",
  ];
}

/** `comptes` : drapeau de construction __COMPTES__ (paramètre pour les tests). */
export function infoPage(name: InfoName, lang: Lang, comptes: boolean = __COMPTES__): InfoPage {
  const size = formatBytes(CONTENT_MAX, lang);
  const v = { size, n: MAX_ITEMS, h: TTL_MAX_HOURS, tries: PW_TRIES, opens: MAX_OPENS };
  const page = (lang === "fr" ? FR : EN)[name](v);
  const f = comptes ? (lang === "fr" ? COMPTE_FR : COMPTE_EN)[name] : undefined;
  return f ? f(page) : page;
}

/** Insère `ajout` après le bloc de titre `apres` (à la fin s'il n'existe pas). */
function inserer(blocks: Block[], apres: string, ajout: Block): Block[] {
  const i = blocks.findIndex((b) => b.h === apres);
  return i < 0 ? [...blocks, ajout] : [...blocks.slice(0, i + 1), ajout, ...blocks.slice(i + 1)];
}
function remplacer(blocks: Block[], h: string, nouveau: Block): Block[] {
  return blocks.map((b) => (b.h === h ? nouveau : b));
}

/** Partages inclus par période de 30 jours (server/internal/paiement/offres.go, JetonsPeriod ; test). */
export const PLUS_JETONS = 30;
export const PRO_JETONS = 100;
/** « 2 ou 3 », « 2, 3 ou 7 ». */
function jours(d: readonly number[], ou: string): string {
  return d.length < 2 ? d.join("") : `${d.slice(0, -1).join(", ")} ${ou} ${d[d.length - 1]}`;
}

/**
 * « Vérifier cette version » (spec §28.4), section de la page Sécurité (ancienne page « /verifier », qui y mène
 * encore) : comment n'importe qui vérifie que le site servi est le build public signé. Ses détails
 * techniques et ses liens s'ajoutent à ceux de la page.
 */
const VERIFIER_FR: { block: Block; tech: string[]; links: Tech["links"] } = {
  block: {
    id: "verifier",
    h: "Vérifier cette version",
    p: ["Vous n'avez pas à nous croire sur parole : n'importe qui peut vérifier que les fichiers servis par ce site sont exactement ceux construits depuis notre code public."],
    sub: [
      {
        id: "pourquoi",
        h: "Pourquoi vérifier",
        p: [
          "Vos fichiers sont chiffrés dans votre navigateur, par le code que ce site vous envoie. Si ce code était modifié, par exemple sur un serveur piraté, il pourrait voler les clés. Le chiffrement ne vaut donc que ce que vaut le code servi.",
        ],
      },
      {
        id: "preuve",
        h: "Comment c'est prouvé",
        list: [
          "Le code du site est public, et le site se reconstruit à l'identique depuis ce code : deux constructions, sur deux machines différentes, donnent les mêmes octets.",
          "Pour chaque version, GitHub reconstruit le site et publie la liste de tous ses fichiers, avec la taille et l'empreinte de chacun : le manifeste (release.json).",
          "Ce manifeste est signé par Sigstore, un service public de signature, sans clé secrète que nous pourrions perdre ou nous faire voler : la signature dit qu'il vient de notre procédure de publication sur GitHub, à partir d'un commit précis du code public. Elle est inscrite dans un journal public que tout le monde peut consulter.",
          "Notre serveur refuse d'installer une version dont les fichiers ne sont pas exactement ceux d'un manifeste signé. Et toutes les heures, un contrôle automatique, hors de notre serveur, compare le site en ligne au manifeste signé et nous alerte au moindre écart.",
        ],
      },
      {
        id: "version",
        h: "La version de ce site",
        p: [
          `Ce site annonce la version ${BUILD_ID} : ce sont les premiers caractères du commit depuis lequel il a été construit. Sur la page des versions publiées (lien dans les détails techniques, en bas de cette page), cherchez la version « web-v… » dont le commit commence ainsi : son numéro (par exemple 1.0.0) est celui à vérifier.`,
        ],
      },
      {
        id: "commandes",
        h: "Vérifier vous-même",
        p: [
          "Sur un ordinateur, avec cosign (l'outil de Sigstore), Node.js et git. Le code du vérificateur se télécharge depuis GitHub, jamais depuis ce site. Remplacez 1.0.0 par le numéro de la version :",
        ],
        code: verifyCommands("1.0.0"),
        after: [
          "La commande cosign prouve que le manifeste vient de notre publication : elle doit répondre « Verified OK ». Le vérificateur télécharge ensuite chaque fichier du site et compare sa taille et son empreinte au manifeste : il doit répondre « conforme ». Toute autre réponse est un écart : écrivez-nous (page Contact).",
        ],
      },
      {
        id: "verif-limites",
        h: "Ce que la vérification ne prouve pas",
        list: [
          "Cette page ne peut pas prouver sa propre intégrité : un serveur piégé pourrait la modifier aussi. Vérifiez avec un outil qui ne vient pas de ce site.",
          "Un serveur compromis pourrait servir un code piégé à une seule personne, choisie selon son adresse ou son navigateur, et le bon code à tous les autres, contrôle automatique compris. La vérification ne protège vraiment que la personne qui la fait elle-même, avant d'utiliser le site.",
          "La signature prouve d'où vient le code, pas qu'il est sans défaut : c'est la relecture du code public qui peut le dire.",
          "Les réglages de sécurité envoyés avec les pages (les en-têtes du serveur) ne sont pas vérifiés : seul le contenu des fichiers l'est.",
          "Les futures applications iOS et Android embarqueront ce code, signé par les magasins d'applications : il ne viendra plus de notre serveur à chaque visite. Ce sera la protection la plus forte contre ce risque.",
        ],
      },
    ],
  },
  tech: [
    "Manifeste : release.json (schéma 1) donne la version, le commit, et pour chaque fichier servi, variantes .br et .gz comprises, son chemin, sa taille et son SHA-256 ; écrit par web/scripts/release-manifest.mjs, publié avec SHA256SUMS et dist.tar.gz.",
    "Signature : cosign sign-blob, sans clé, par le workflow release.yml sur une étiquette web-v<x.y.z> (identité OIDC de GitHub Actions, certificat Fulcio, journal Rekor). Vérifiez toujours avec l'identité exacte, jamais avec une expression ouverte, et jamais sans le journal de transparence.",
    "Vérificateur : web/scripts/verify-site.mjs, sans dépendance. Il refuse les redirections, vérifie les variantes compressées et le repli monopage, et ne répond jamais « conforme » après une erreur réseau.",
    "Limite post-quantique : les signatures de Sigstore sont en ECDSA P-256 ; elles seront remplacées quand Sigstore proposera une signature post-quantique.",
  ],
  links: [
    { label: "Versions publiées et manifestes signés (GitHub)", url: RELEASES_URL },
    { label: "Mode d'emploi détaillé (§3.3)", url: VERIFY_DOC_URL },
    { label: "Journal public de Sigstore", url: REKOR_URL },
  ],
};

/**
 * « Verify this version » (spec §28.4), section de la page Sécurité (ancienne page « /verifier », qui y mène
 * encore) : comment n'importe qui vérifie que le site servi est le build public signé. Ses détails
 * techniques et ses liens s'ajoutent à ceux de la page.
 */
const VERIFIER_EN: { block: Block; tech: string[]; links: Tech["links"] } = {
  block: {
    id: "verifier",
    h: "Verify this version",
    p: ["You don't have to take our word for it: anyone can check that the files this site serves are exactly the ones built from our public code."],
    sub: [
      {
        id: "pourquoi",
        h: "Why verify",
        p: [
          "Your files are encrypted in your browser, by the code this site sends you. If that code were modified, for example on a hacked server, it could steal the keys. Encryption is only as good as the code that is served.",
        ],
      },
      {
        id: "preuve",
        h: "How it is proven",
        list: [
          "The site's code is public, and the site can be rebuilt identically from it: two builds, on two different machines, give the same bytes.",
          "For every version, GitHub rebuilds the site and publishes the list of all its files, with the size and fingerprint of each: the manifest (release.json).",
          "This manifest is signed by Sigstore, a public signing service, without any secret key we could lose or have stolen: the signature says it comes from our publishing process on GitHub, built from a precise commit of the public code. It is recorded in a public log that anyone can search.",
          "Our server refuses to install a version whose files are not exactly those of a signed manifest. And every hour, an automatic check, outside our server, compares the live site with the signed manifest and alerts us at the slightest difference.",
        ],
      },
      {
        id: "version",
        h: "The version of this site",
        p: [
          `This site announces version ${BUILD_ID}: the first characters of the commit it was built from. On the page of published versions (link in the technical details, at the bottom of this page), look for the "web-v…" version whose commit starts this way: its number (for example 1.0.0) is the one to verify.`,
        ],
      },
      {
        id: "commandes",
        h: "Verify it yourself",
        p: [
          "On a computer, with cosign (the Sigstore tool), Node.js and git. The verifier's code is downloaded from GitHub, never from this site. Replace 1.0.0 with the version number:",
        ],
        code: verifyCommands("1.0.0"),
        after: [
          "The cosign command proves that the manifest comes from our publishing process: it must answer \"Verified OK\". The verifier then downloads every file of the site and compares its size and fingerprint with the manifest: it must answer \"conforme\" (matches). Any other answer is a difference: write to us (Contact page).",
        ],
      },
      {
        id: "verif-limites",
        h: "What verification does not prove",
        list: [
          "This page cannot prove its own integrity: a tampered server could change it too. Verify with a tool that does not come from this site.",
          "A compromised server could serve tampered code to a single person, chosen by their address or browser, and the right code to everyone else, the automatic check included. Verification only truly protects the person who runs it themselves, before using the site.",
          "The signature proves where the code comes from, not that it is flawless: only reviewing the public code can tell.",
          "The security settings sent with the pages (the server's headers) are not verified: only the content of the files is.",
          "The future iOS and Android apps will embed this code, signed by the app stores: it will no longer come from our server on every visit. That will be the strongest protection against this risk.",
        ],
      },
    ],
  },
  tech: [
    "Manifest: release.json (schema 1) gives the version, the commit, and for every served file, .br and .gz variants included, its path, size and SHA-256; written by web/scripts/release-manifest.mjs, published with SHA256SUMS and dist.tar.gz.",
    "Signature: cosign sign-blob, keyless, by the release.yml workflow on a web-v<x.y.z> tag (GitHub Actions OIDC identity, Fulcio certificate, Rekor log). Always verify with the exact identity, never an open expression, and never without the transparency log.",
    "Verifier: web/scripts/verify-site.mjs, with no dependency. It refuses redirects, checks compressed variants and the single-page fallback, and never answers \"conforme\" after a network error.",
    "Post-quantum limit: Sigstore signatures use ECDSA P-256; they will be replaced when Sigstore offers a post-quantum signature.",
  ],
  links: [
    { label: "Published versions and signed manifests (GitHub)", url: RELEASES_URL },
    { label: "Detailed instructions (§3.3)", url: VERIFY_DOC_URL },
    { label: "Sigstore public log", url: REKOR_URL },
  ],
};

type V = { size: string; n: number; h: number; tries: number; opens: number };

const FR: Record<InfoName, (v: V) => InfoPage> = {
  securite: (v) => ({
    title: "Sécurité",
    lede: "Ce que Shhgone protège, comment, et ce qu'il ne peut pas faire. Aucune protection n'est parfaite : voici ce qui est vrai aujourd'hui.",
    blocks: [
      {
        id: "chiffrement",
        h: "Fermé à clé sur votre appareil",
        p: [
          "Vos fichiers et vos textes sont chiffrés dans votre navigateur, avant de partir. Ce qui arrive sur notre serveur est illisible sans la clé, pour nous comme pour n'importe qui d'autre.",
          "Le mot de passe, facultatif et désactivé par défaut, est volontairement lent à vérifier quand vous l'activez : essayer des mots de passe au hasard coûte très cher à qui voudrait le deviner.",
          "Les noms de fichiers, leurs types et vos textes sont chiffrés aussi : nous ne pouvons pas les lire.",
        ],
      },
      {
        id: "lien",
        h: "Le lien et le mot de passe",
        p: [
          "La clé est cachée dans la fin du lien, après le signe #. Les navigateurs n'envoient jamais cette partie à un serveur. Il faut le lien pour ouvrir un partage, et aussi le mot de passe si vous en avez mis un : notre serveur n'a ni l'un ni l'autre.",
          "Sans mot de passe (le réglage par défaut), quiconque a le lien peut ouvrir le partage : une sauvegarde de messagerie ou un historique de navigateur qui garde le lien suffit, tant que le partage existe et qu'il reste une ouverture. Activez le mot de passe et envoyez-le par un autre moyen pour plus de sûreté.",
          `Avec un mot de passe, après ${v.tries} mots de passe faux, le partage est détruit. Il s'efface aussi à la fin de sa durée (${v.h} h au plus en gratuit) ou après le nombre d'ouvertures choisi (${v.opens} au plus).`,
        ],
      },
      {
        id: "serveur",
        h: "Ce que voit notre serveur",
        list: [
          "Des données chiffrées, dont la taille est arrondie. Jamais la clé ni le mot de passe.",
          "Votre adresse IP pendant la connexion, comme pour tout site web. Elle n'est écrite nulle part.",
          "La taille approximative d'un partage, l'heure des envois et des ouvertures, et quels morceaux chiffrés sont lus.",
          "Aucune date de création n'est gardée ; les heures de fin sont arrondies au quart d'heure.",
        ],
      },
      {
        id: "sortie",
        h: "Après la dernière ouverture",
        p: [
          "Quand toutes les ouvertures sont prises, personne d'autre ne peut entrer. Chaque personne qui a ouvert le partage peut y revenir depuis le même navigateur jusqu'à la fin de sa durée, sans compter d'ouverture : le contenu chiffré reste donc sur le serveur jusque-là. La dernière personne peut le détruire tout de suite ; sinon, il est effacé à la fin de la durée choisie à l'envoi.",
          "Pour revenir, ce navigateur garde l'autorisation d'ouverture, chiffrée, jamais la clé ni le mot de passe ; il faut rouvrir le lien (et retaper le mot de passe s'il y en a un). Depuis un autre appareil, en navigation privée ou après un redémarrage de notre serveur, le retour n'est plus possible si toutes les ouvertures sont prises.",
        ],
      },
      {
        id: "limites",
        h: "Ce que Shhgone ne peut pas faire",
        list: [
          "Empêcher une capture d'écran, une photo de l'écran ou une copie : ce que le destinataire voit ou télécharge lui appartient.",
          "Effacer l'historique de votre navigateur. Nous retirons la clé de la barre d'adresse, mais le navigateur a déjà noté l'adresse complète dans son historique (parfois synchronisé). Ouvrez le lien en navigation privée pour laisser moins de traces.",
          "Garantir que la mémoire de l'appareil est vidée : nous l'effaçons du mieux possible. Pour qu'un rechargement ne coûte pas une ouverture, le lien et un code d'ouverture restent dans le stockage de cet onglet le temps de l'ouverture (jamais le mot de passe ni le contenu ; sans mot de passe, ce lien suffit à rouvrir le partage).",
          "Tout effacer dans les fichiers. Photos, PDF et documents bureautiques perdent leurs informations cachées (lieu, appareil, auteur, dates), comme les vidéos et les sons, si vous les nettoyez avant l'envoi (un geste, sur votre appareil ; sans lui, le fichier part tel quel). Les archives et les formats non pris en charge partent tels quels : leur ligne le dit. Ce qui se voit dans l'image ou se lit dans le document reste : la vignette d'aperçu d'une photo est gardée (elle peut montrer la photo d'avant un recadrage ou une retouche), un PDF ne perd que ses propriétés de document (ses pages, leurs miniatures et ses images restent telles quelles), les commentaires d'un document gardent leurs auteurs, et un PDF modifié plusieurs fois peut garder d'anciens passages.",
          "Vérifier l'expéditeur : un lien peut venir de n'importe qui.",
          "Vous protéger d'un site piégé : si notre serveur ou notre code était compromis, le site servi pourrait voler les clés. C'est pour cela que le code est public et que le site se reconstruit à l'identique depuis ce code.",
          "Cacher votre adresse IP au serveur et à l'hébergeur pendant la connexion.",
        ],
        link: { label: "Vérifier que ce site sert bien le code public", path: "/verifier", section: "verifier" },
      },
      {
        id: "qr",
        h: "QR code et partage en un geste",
        p: [
          "« Partager » peut envoyer le lien et le mot de passe ensemble, et le QR code les contient tous les deux (sans mot de passe, le lien seul). Avec une seule ouverture (le réglage par défaut), personne d'autre ne pourra voir le contenu ensuite, et le destinataire verrait qu'il a déjà été ouvert.",
          "Mais quelqu'un qui lit le message avant le destinataire peut l'ouvrir à sa place, et l'adresse du QR (lien et mot de passe) reste dans l'historique du navigateur qui l'ouvre. Pour plus de sûreté, envoyez le lien et le mot de passe par deux moyens différents.",
        ],
      },
      {
        id: "appareil",
        h: "Caméra et micro",
        p: [
          "Le site ne peut utiliser la caméra et le micro que pour ses propres enregistrements, après votre accord, et jamais à l'intérieur d'un autre site. Les autres fonctions sensibles du navigateur lui sont fermées.",
        ],
      },
      VERIFIER_FR.block,
    ],
    tech: {
      h: "Détails techniques (pour les experts)",
      list: [
        "Contenu, noms, types et textes : AES-256-GCM (WebCrypto), clés dérivées par HKDF-SHA-256 ; aucune cryptographie maison.",
        "Mot de passe (facultatif) : Argon2id (RustCrypto, dans le moteur WebAssembly du site), 64 Mio de mémoire, 3 passes, combiné à la clé du fragment du lien (après #), jamais transmise au serveur. Sans mot de passe, une clé tirée du fragment par HKDF-SHA-256 prend sa place ; le serveur reçoit les mêmes données et ne sait pas quels partages ont un mot de passe.",
        `Ouverture : le serveur vérifie une preuve dérivée de la clé et du mot de passe (ou de la clé seule), sans recevoir ni l'une ni l'autre ; ${v.tries} preuves fausses détruisent le partage.`,
        "Taille : l'envoi chiffré commence dès qu'un fichier est ajouté, avant « Chiffrer et envoyer ». Pendant l'envoi, le serveur voit la taille à 4 Mio près, car le contenu part en morceaux chiffrés de 4 Mio. Une fois l'envoi fini, le contenu chiffré occupe un palier de taille fixe : le serveur ne connaît plus que ce palier.",
        "Navigateur : en-têtes stricts (Content-Security-Policy, Permissions-Policy) ; aucun script, police ni traceur d'un autre site.",
        ...VERIFIER_FR.tech,
      ],
      links: [
        { label: "Code source public (GitHub)", url: SOURCE_URL },
        { label: "Spécification publique", url: SPEC_URL },
        ...VERIFIER_FR.links,
      ],
    },
  }),
  confidentialite: (v) => ({
    title: "Confidentialité",
    lede: "Sans compte, ni pour envoyer, ni pour recevoir. Aucun traceur, aucune mesure d'audience, aucune publicité.",
    blocks: [
      {
        h: "Ce que nous gardons",
        list: [
          "Le contenu chiffré et le strict nécessaire pour le servir : sa taille arrondie, son échéance arrondie au quart d'heure, le nombre d'ouvertures restantes et d'essais ratés, des vérificateurs qui ne permettent pas de déchiffrer.",
          "Rien de cela ne contient votre nom, votre adresse e-mail, votre adresse IP, le nom de vos fichiers ou leur contenu en clair.",
          `Tout est effacé à l'échéance (${v.h} h au plus en gratuit), ou plus tôt à la destruction. Après la dernière ouverture, le contenu chiffré reste jusqu'à l'échéance, pour que le destinataire puisse y revenir, sauf s'il le détruit.`,
        ],
      },
      {
        h: "Ce que nous ne gardons pas",
        list: [
          "Votre adresse IP n'est pas enregistrée. Le serveur la voit le temps de traiter chaque demande, comme tout site web, mais ne l'écrit nulle part et ne la garde pas : les limites anti-abus n'en gardent qu'un code à sens unique, en mémoire seulement, sous une clé tirée au hasard, remplacée chaque jour puis effacée : une fois la clé effacée, plus rien ne relie ce code à votre adresse.",
          "Aucun cookie de notre part, et aucune mesure d'audience.",
          "Aucun journal des partages, aucune mesure d'audience. Le serveur tient seulement, en mémoire, des compteurs globaux pour son exploitation (par exemple le nombre de partages créés depuis son dernier démarrage) : rien par personne, par adresse ni par partage, rien sur disque.",
        ],
      },
      {
        h: "Sur votre appareil",
        list: [
          "Le contenu déchiffré reste en mémoire et n'est jamais écrit dans le stockage du navigateur.",
          "Le lien et un code d'ouverture restent dans le stockage de l'onglet le temps de l'ouverture, pour qu'un rechargement ne coûte pas une ouverture.",
          "La langue affichée suit celle de votre navigateur : rien n'est gardé pour cela.",
          "Salon : pour retrouver votre place après un rechargement, votre code de membre, le nom que vous y portez et la clé du salon sont gardés chiffrés sur cet appareil, lisibles seulement avec le mot de passe du salon ; ils s'effacent à la fin du salon.",
          "Offres payantes : le pass, son état lu le jour même, les preuves anonymes qu'il donne (avec l'heure où chacune a été obtenue) et les clés de signature déjà vues sont gardés chiffrés sur cet appareil.",
          "Aucune liste de vos partages ni des liens reçus n'est gardée, sur l'appareil comme dans un compte. « Lien prêt » et « Salon prêt » vous montrent le lien de gestion : gardez-le vous-même, c'est le seul moyen de suivre ou de supprimer le partage plus tard.",
          "L'historique des téléchargements est désactivé par défaut : rien n'est gardé tant que vous ne l'activez pas vous-même. Activé, il garde chiffrés sur cet appareil le nom, la taille et la sorte de chaque fichier enregistré, sa provenance et l'heure ; il n'est jamais envoyé, et ne contient jamais le lien ni le mot de passe. Chaque entrée s'efface après 30 jours ; le désactiver efface tout.",
        ],
      },
      {
        // Conception du paiement §3, §7, S16 à S19. Relu sur le code : server/internal/paiement
        // (base.go, stripe.go, jetons.go), web/src/paiement (jetons.ts, pass.ts).
        id: "paiement",
        h: "Offres payantes : le paiement",
        list: [
          "Le paiement, quand il est proposé, se fait sur la page du prestataire choisi, vers laquelle nous vous envoyons : Stripe pour la carte, PayPal, ou NOWPayments pour les cryptomonnaies. Aucun de leurs scripts n'est chargé sur nos pages.",
          "Le prestataire voit ce que vous lui donnez (selon le moyen : nom, adresse e-mail, carte, compte PayPal ou portefeuille), votre adresse IP, le montant et un numéro de commande tiré au hasard ; il le garde selon ses propres règles. Le pays que vous déclarez passe par notre serveur pour la TVA, sans y être gardé (pour la carte, nous le transmettons aussi à Stripe).",
          "Votre appareil tire au hasard un pass, qui ne dit rien de vous. Nous gardons un code à sens unique tiré du pass, l'offre, le moyen choisi (carte, PayPal ou crypto), les dates au jour, le nombre de partages payants restants, le numéro de commande, la référence de l'abonnement chez le prestataire (pour arrêter le renouvellement) et un code à sens unique de ses références de paiement (pour un remboursement ou une contestation). Jamais votre nom, votre adresse e-mail, votre pays, le montant ni votre adresse IP (l'offre et sa durée suffisent pourtant à retrouver le prix).",
          "Qui réunirait les données du prestataire et notre base pourrait relier votre identité à votre pass et à son offre, jamais à vos partages.",
          // Décision du propriétaire du 25 novembre (paiements.db, noms_offerts).
          "Exception : pour une personne qu'il connaît, l'exploitant peut offrir un accès sans paiement et y associer un nom ou une note ; ce nom est gardé sur notre serveur avec le code du pass, et effacé avec lui.",
          "Chaque partage payant utilise une preuve anonyme, signée « en aveugle » (Privacy Pass) : quand votre appareil demande des preuves, notre serveur voit le pass et combien il en prend ; quand un partage en utilise une, il voit une preuve valable pour Plus ou Pro, sans pouvoir savoir de quel pass elle vient. La preuve ne relie pas non plus deux partages entre eux.",
          "Les appels audio et vidéo des salons sont réservés à Plus et Pro : le premier participant qui lance un appel utilise une preuve anonyme de la même façon, qui ouvre les appels pour tout le salon jusqu'à sa fin ; les autres participants n'ont besoin d'aucune offre. Notre serveur voit qu'un participant de ce salon a utilisé une preuve Plus ou Pro, sans savoir de quel pass elle vient ; mais si c'est le créateur du salon, que notre serveur connaît par son compte, il apprend ainsi que ce compte a Plus ou Pro (et laquelle des deux), toujours sans savoir quel pass.",
          "Limite : chaque preuve porte le jour de sa clé. Un partage payant ne se cache donc que parmi les pass de la même offre qui ont pris des preuves ce jour-là ou la veille.",
          "Limite : l'heure. Après chaque partage payant, tant que le site reste ouvert, votre appareil refait sa petite réserve de preuves à une heure tirée au hasard. Mais sans preuve en réserve (premier partage payant, ou après un ou deux jours sans), les preuves sont demandées au moment même du partage ; de même, l'appareil demande l'état du pass au plus une fois par jour (et après un paiement ou un refus), à l'ouverture de l'accueil ou de la page d'envoi. Avec peu d'acheteurs, notre serveur pourrait alors rapprocher par l'heure un partage payant fait juste après de votre pass ; de même pour un appel lancé juste après (et donc pour le salon où il a lieu).",
          "Limite : la même clé pour tous. Un serveur malveillant pourrait donner une clé par personne et reconnaître ainsi ses preuves. Pour le gêner, notre serveur annonce ses clés sept jours à l'avance ; votre appareil garde celles qu'il a vues et refuse, avec un avertissement, une clé différente pour un jour déjà annoncé. Mais un serveur qui donnerait à votre appareil ses propres clés dès le premier contact ne serait pas détecté par cet appareil seul : il faudrait comparer avec une autre source, par exemple entre le site et les futures apps.",
          // service.go (gardeAttente, gardeLitiges, gardePass), jetons.go (depenses), sauvegarder.sh.
          "Durées : une commande non payée est effacée après 7 jours ; une commande payée est gardée jusqu'à 180 jours après la fin de l'offre (délai des contestations de paiement), puis effacée ; le code du pass, 31 jours après la fin de l'offre. Une preuve utilisée n'est gardée que deux jours, sous forme de code à sens unique, pour qu'elle ne serve qu'une fois. Cette base est sauvegardée chaque jour, chiffrée, chez un autre hébergeur ; chaque copie est effacée après 7 jours.",
          "Stripe, PayPal et NOWPayments sont responsables de leurs propres traitements (paiement, lutte contre la fraude, obligations légales), selon leurs politiques de confidentialité ; ils peuvent transférer des données hors de l'Union européenne. Les factures et la comptabilité sont tenues à partir de leurs relevés, hors de notre serveur, et gardées 10 ans comme la loi l'exige.",
        ],
      },
      {
        // Conception des appels §5, §6, §7 : relais TURN sur notre machine (deploy/shhcheck/turn.go).
        id: "appels",
        h: "Appels audio et vidéo",
        list: [
          "Le son et l'image sont chiffrés de bout en bout entre les participants (DTLS-SRTP) : notre relais les transmet sans pouvoir les lire.",
          "Ils passent toujours par notre relais : les autres participants ne voient pas votre adresse IP. Le relais, lui, la voit pendant l'appel, avec le volume et les horaires, en mémoire seulement ; rien n'est écrit sur disque.",
          "Pour joindre le relais, votre appareil reçoit un identifiant temporaire (6 heures au plus) qui ne désigne ni le salon, ni la personne.",
        ],
      },
      {
        id: "contact",
        h: "Si vous nous écrivez",
        p: [
          "Votre message et votre adresse e-mail arrivent dans notre messagerie, hébergée par OVH. Nous les gardons le temps de traiter votre demande, puis nous les effaçons, sauf obligation légale (par exemple une demande d'une autorité). Les alertes techniques que notre serveur nous envoie ne contiennent aucune donnée d'utilisateur.",
        ],
      },
      {
        id: "hebergement",
        h: "Hébergement",
        p: [
          "Le site et ses données sont hébergés en France, sur un serveur dédié loué à OVH. Seules les bases des comptes et des paiements sont sauvegardées, chiffrées, chez un autre hébergeur ; jamais les partages ni les salons.",
        ],
      },
      {
        id: "verification",
        h: "Vérification anti-robot",
        p: [
          "Une petite preuve de calcul est faite par votre navigateur, sans service extérieur.",
        ],
      },
      {
        h: "Vos droits",
        p: [
          "Nous ne gardons rien qui permette de vous identifier ni de retrouver vos partages à partir de votre identité. Pour exercer vos droits ou poser une question, écrivez-nous (page Contact). Un partage peut être détruit à tout moment par son expéditeur (lien de gestion) ou, à la dernière ouverture, par son destinataire.",
          "Le responsable de ces traitements est l'éditeur de Shhgone (voir les mentions légales). Vous pouvez aussi adresser une réclamation à la CNIL (cnil.fr).",
        ],
        link: { label: "Page Contact", path: "/contact" },
      },
      {
        h: "Demandes des autorités",
        p: [
          "Nous répondons aux demandes légales des autorités, qui nous écrivent à l'adresse de la page Contact. Voici ce que nous pouvons leur donner, et ce que nous ne pouvons pas donner, parce que nous ne l'avons pas.",
        ],
        list: [
          "Le contenu d'un partage ou d'un salon : jamais, il est chiffré sur votre appareil et nous n'avons pas la clé.",
          "Qui a envoyé ou ouvert un partage : rien ne permet de le savoir, aucune adresse IP n'est gardée.",
          "Sur un lien transmis : nous pouvons détruire le partage ou le salon tout de suite.",
          "Avec un compte : seulement ce que garde le compte, jamais le contenu ni une adresse IP.",
        ],
      },
    ],
  }),
  conditions: (v) => ({
    title: "Conditions d'utilisation",
    lede: "Les règles d'usage de Shhgone, et les conditions de vente des offres Plus et Pro. Mise à jour le 25 novembre 2026.",
    blocks: [
      {
        h: "Objet",
        p: [
          "Shhgone permet d'envoyer des fichiers, des photos, des vidéos, des messages vocaux et des notes, chiffrés sur votre appareil, par un lien (et un mot de passe si vous le voulez), sans compte. Ces conditions s'appliquent à toute utilisation du site. En utilisant Shhgone, vous les acceptez.",
        ],
      },
      {
        h: "Le service",
        list: [
          "Vos contenus sont chiffrés dans votre navigateur avant de partir : nous ne pouvons ni les lire, ni les retrouver, ni les rendre.",
          `Un partage s'efface à son échéance (${v.h} h au plus en gratuit), après le nombre d'ouvertures choisi (${v.opens} au plus), ou après ${v.tries} mots de passe faux. Limites en gratuit : ${v.n} éléments et ${v.size} par partage.`,
          "Shhgone n'est pas un service de sauvegarde : gardez vos originaux. Un lien ou un mot de passe perdu ne peut pas être retrouvé, pas même par nous.",
        ],
      },
      {
        // Conditions de vente (conception du paiement §1, §2, §5, §9.4). Chiffres lus dans PAID
        // (web/src/limits.ts) et offres.go (partages inclus).
        id: "vente",
        h: "Offres payantes : conditions de vente",
        p: ["Quand elles sont proposées, les offres Plus et Pro s'achètent sur la page Offres. Elles ajoutent de la place, de la durée et des ouvertures, et permettent de lancer des appels audio et vidéo dans un salon ; aucune n'ajoute de sécurité."],
        list: [
          `Prix TTC : Plus ${PAID.plus.month}\u00a0€ par mois ou ${PAID.plus.year}\u00a0€ par an ; Pro ${PAID.pro.month}\u00a0€ par mois ou ${PAID.pro.year}\u00a0€ par an. Le même prix TTC dans tous les pays. Vente aux personnes qui résident dans l'Union européenne seulement.`,
          `Contenu : Plus, jusqu'à ${formatBytes(PAID.plus.bytes, "fr")} par partage, ${jours(PAID.plus.ttlDays, "ou")} jours et ${PAID.plus.opens} ouvertures ; Pro, jusqu'à ${formatBytes(PAID.pro.bytes, "fr")}, ${jours(PAID.pro.ttlDays, "ou")} jours et ${PAID.pro.opens} ouvertures. Partages inclus : ${PLUS_JETONS} (Plus) ou ${PRO_JETONS} (Pro) par période de 30 jours, sans report ; ouvrir les appels d'un salon compte comme un partage.`,
          "Durée : un mois compte 30 jours, un an 365 jours, à partir du jour où le prestataire confirme le paiement.",
          "Renouvellement : par carte ou PayPal, le mensuel se renouvelle chaque mois ; l'annuel est, au choix, un paiement unique ou un renouvellement chaque année (jamais choisi pour vous). En cryptomonnaie, c'est toujours un paiement unique, sans renouvellement. « Arrêter le renouvellement », sur l'appareil qui garde l'offre, l'arrête en un geste, sans frais : l'offre va jusqu'à la fin de la période payée, et rien n'est plus prélevé.",
          "Paiement : sur la page du prestataire choisi (Stripe, PayPal ou NOWPayments). L'offre est active quand il nous confirme le paiement.",
          "Droit de rétractation : vous avez en principe 14 jours pour vous rétracter. Comme l'offre sert dès le paiement, la page Offres vous demande, avant de payer, de demander l'accès immédiat et de renoncer à ce droit pour la période commencée (case non cochée d'avance) ; sans elle, le paiement ne commence pas.",
          "Un remboursement total ou une contestation du paiement arrête l'offre.",
          "Votre offre est un pass tiré au hasard par votre appareil : nous ne savons pas qui l'a acheté. Sans compte, elle ne vit que sur cet appareil : effacer les données du site la perd, et nous ne pouvons pas la retrouver.",
          "Facture : Stripe l'envoie à l'adresse donnée lors du paiement ; pour PayPal et les cryptomonnaies, demandez-la à l'adresse de la page Contact, avec le numéro de commande donné par le prestataire. Après le paiement, « Télécharger la note de vente » donne aussi un récapitulatif, fait sur votre appareil.",
          "Vous bénéficiez de la garantie légale de conformité des contenus et services numériques (Code de la consommation, articles L224-25-12 et suivants). Pour toute réclamation, écrivez à l'adresse de la page Contact.",
        ],
      },
      {
        h: "Usage autorisé",
        p: ["Shhgone sert à transmettre des contenus de façon privée. Il est interdit de l'utiliser pour :"],
        list: [
          "diffuser un contenu illégal : abus sexuels sur mineurs, apologie ou provocation au terrorisme, incitation à la haine ou à la violence, contenu intime diffusé sans accord ;",
          "harceler, menacer, escroquer ou usurper l'identité de quelqu'un ;",
          "diffuser un logiciel malveillant ou une page d'hameçonnage ;",
          "partager un contenu sans en avoir le droit (droits d'auteur, vie privée, données personnelles d'autrui) ;",
          "gêner le fonctionnement du service (envois automatisés en masse, contournement des limites ou de la vérification anti-robot).",
        ],
      },
      {
        h: "Vos responsabilités",
        p: [
          "Vous êtes responsable de ce que vous envoyez et de la personne à qui vous l'envoyez. Transmettez le lien (et le mot de passe, s'il y en a un, par un autre moyen) seulement à qui doit les recevoir.",
        ],
      },
      {
        h: "Signalement",
        p: [
          "Toute personne qui a ouvert un partage peut le signaler, une fois par ouverture. Le partage est supprimé pour tout le monde quand la moitié de ses ouvertures permises l'ont signalé (arrondie au-dessus, deux voix au moins dès deux ouvertures : 1 sur 1, 2 sur 2, 2 sur 3, 3 sur 5). Une seule personne ne peut donc pas supprimer un partage destiné à plusieurs. Voir « Signaler un abus ».",
          "Sur décision d'une autorité, ou quand on nous transmet le lien d'un partage manifestement illégal, nous pouvons aussi le supprimer.",
        ],
      },
      {
        h: "Modération",
        p: [
          "Nous ne lisons pas les partages ni les salons (ils sont chiffrés sur votre appareil) et n'utilisons aucun outil automatique de modération. Les seules mesures possibles sont la suppression d'un partage ou d'un salon : par les signalements des personnes qui l'ont ouvert (règle ci-dessus), ou par l'éditeur, en personne, après un signalement écrit qui joint le lien, ou sur demande d'une autorité.",
          "Toute décision peut être contestée en écrivant à l'adresse de la page Contact : elle est réexaminée par une personne.",
        ],
      },
      {
        h: "Disponibilité",
        p: [
          "Le service est fourni tel quel, sans garantie de disponibilité. Il peut être interrompu pour maintenance ou après un incident ; un envoi en cours peut alors être perdu et devra être refait.",
        ],
      },
      {
        h: "Responsabilité",
        p: [
          "Dans les limites permises par la loi, nous ne sommes pas responsables des contenus échangés, que nous ne pouvons pas lire, ni de la disparition d'un partage effacé selon ses règles (échéance, ouvertures, mots de passe faux, signalements). Rien dans ces conditions ne limite les droits que la loi vous garantit, notamment comme consommateur.",
        ],
      },
      {
        h: "Données personnelles",
        p: ["Ce que nous gardons, et surtout ce que nous ne gardons pas, est décrit dans la page Confidentialité."],
      },
      {
        h: "Propriété intellectuelle",
        p: [
          "Vos contenus restent les vôtres : nous n'acquérons aucun droit sur eux. Le code de Shhgone est public, sous licence AGPL-3.0.",
        ],
      },
      {
        h: "Modifications",
        p: ["Nous pouvons modifier ces conditions. La date de mise à jour est indiquée en haut de cette page ; la version en vigueur est celle affichée au moment de votre utilisation."],
      },
      {
        h: "Droit applicable",
        p: [
          "Ces conditions sont soumises au droit français. En cas de litige, une solution amiable est d'abord recherchée en nous écrivant (page Contact) ; à défaut, les tribunaux français sont compétents, sous réserve des règles qui protègent le consommateur.",
        ],
      },
    ],
  }),
  mentions: () => ({
    title: "Mentions légales",
    lede: "Qui édite Shhgone, qui l'héberge, et comment nous joindre.",
    draft: true,
    blocks: [
      {
        h: "Éditeur",
        list: [
          "Shhgone est édité par une personne physique non professionnelle qui, comme la loi le permet (loi n° 2004-575 du 21 juin 2004, article 1-1, II), ne publie pas son identité : celle-ci est connue de l'hébergeur ci-dessous.",
          "Contact : contact@shhgone.com (en français ou en anglais).",
        ],
      },
      {
        h: "Hébergeur",
        list: ["OVH SAS", "2 rue Kellermann, 59100 Roubaix, France", "Téléphone : +33 9 72 10 10 07", "Serveur dédié en France (Strasbourg). Le nom de domaine, ses DNS et la messagerie sont aussi chez OVH SAS."],
      },
      {
        h: "Contact et contenus illicites",
        p: [
          "Point de contact unique pour les autorités et pour les utilisateurs (règlement européen sur les services numériques, articles 11 et 12), y compris pour les demandes de retrait des autorités : contact@shhgone.com, en français ou en anglais. Chaque message est lu par une personne, jamais par un robot seul.",
          "Pour signaler un contenu illicite : depuis le partage (« Signaler ce partage »), ou par écrit à contact@shhgone.com (voir « Signaler un abus » pour ce qu'il faut joindre) ; vous pouvez aussi le signaler aux autorités (en France : PHAROS, internet-signalement.gouv.fr).",
        ],
        link: { label: "Page Contact", path: "/contact" },
      },
      {
        h: "Données personnelles",
        p: ["Voir la page Confidentialité. Pour exercer vos droits, écrivez à contact@shhgone.com ; vous pouvez aussi saisir la CNIL (cnil.fr)."],
      },
      {
        h: "Propriété intellectuelle et code source",
        p: ["Le nom et le logo Shhgone appartiennent à l'éditeur. Le code de Shhgone est public, sous licence AGPL-3.0."],
      },
    ],
  }),
  signaler: (v) => ({
    title: "Signaler un abus",
    lede: "Un partage illégal ou malveillant ? Si vous l'avez ouvert, vous pouvez le signaler en deux gestes.",
    blocks: [
      {
        h: "Depuis le partage",
        list: [
          "Ouvrez le partage avec son lien (et son mot de passe s'il en a un).",
          "En bas du contenu, choisissez « Signaler ce partage », dites ce qui se passe, puis « Signaler ».",
          "Chaque ouverture compte pour une voix. Le partage est supprimé pour tout le monde quand la moitié de ses ouvertures permises l'ont signalé (deux voix au moins dès deux ouvertures : 1 sur 1, 2 sur 2, 2 sur 3, 3 sur 5) : les téléchargements en cours sont coupés, plus aucune ouverture n'est possible. Sinon, votre signalement est compté et le partage reste ouvert aux autres.",
        ],
      },
      {
        h: "Ce que nous recevons",
        p: [
          "Le signalement ne contient que la catégorie choisie (par exemple « Arnaque ») et la preuve que vous avez ouvert le partage : ni le contenu, ni qui vous êtes. Nous ne pouvons pas lire le partage. Nous comptons, en mémoire seulement, les signalements par catégorie depuis le dernier démarrage du serveur et leur nombre dans l'heure, pour repérer un abus massif ; rien n'est écrit sur disque.",
          `Sans le lien (et le mot de passe, s'il y en a un), rien ne peut être fait sur le partage : il s'effacera seul à son échéance (${v.h} h au plus en gratuit). Pour un contenu illégal, vous pouvez aussi écrire à l'adresse de la page Contact en joignant le lien.`,
        ],
      },
      {
        h: "Par écrit",
        list: [
          "Écrivez à l'adresse de la page Contact en joignant : le lien complet du partage (avec ce qui suit le « # ») et son mot de passe s'il en a un et si vous l'avez, sans lequel personne ne peut voir le contenu d'un partage protégé ; ce qui vous paraît illégal, et pourquoi ; votre nom et votre adresse e-mail (facultatifs pour un contenu d'abus sexuel sur mineur) ; une phrase qui confirme que vous signalez de bonne foi et que ces informations sont exactes.",
          "Nous accusons réception, une personne examine le partage (jamais un robot seul), puis nous vous répondons avec notre décision et les recours possibles.",
          "Un contenu manifestement illégal est détruit tout de suite : plus aucune ouverture, téléchargements en cours coupés. Si la vie ou la sécurité de quelqu'un est menacée, nous prévenons les autorités.",
        ],
        link: { label: "Page Contact", path: "/contact" },
      },
    ],
  }),
  contact: () => ({
    title: "Contact",
    lede: "Une question, un contenu à signaler, une demande légale ou une faille de sécurité\u202f: écrivez-nous.",
    blocks: [
      {
        id: "adresse",
        h: "Notre adresse",
        mail: true,
        p: ["En français ou en anglais. Chaque message est lu par une personne, jamais par un robot seul."],
      },
      {
        id: "pourquoi",
        h: "Pour quoi nous écrire",
        list: [
          "Une question ou de l'aide pour utiliser Shhgone.",
          "Un contenu illégal\u202f: le plus simple est de le signaler depuis le partage. Pour un signalement par écrit, la page «\u00a0Signaler un abus\u00a0» dit ce qu'il faut joindre.",
          "Les autorités et les demandes légales, y compris les demandes de retrait\u202f: cette adresse est notre point de contact unique (règlement européen sur les services numériques, articles 11 et 12).",
          "L'exercice de vos droits sur vos données personnelles (RGPD)\u202f: accès, rectification, effacement, opposition. Vous pouvez aussi saisir la CNIL (cnil.fr).",
          "La sécurité\u202f: une faille ou un comportement anormal du site. Dites ce que vous avez vu et comment le reproduire.",
        ],
        link: { label: "Signaler un abus", path: "/signaler" },
      },
      {
        id: "jamais",
        h: "Ce qu'il ne faut jamais nous envoyer",
        p: [
          "Le lien complet d'un partage, avec son mot de passe s'il en a un\u202f: qui les a peut ouvrir le partage. Seule exception, un signalement d'abus par écrit, où ils nous sont nécessaires pour voir le contenu, comme le dit la page «\u00a0Signaler un abus\u00a0».",
          "Nous ne vous demanderons jamais un mot de passe.",
        ],
      },
      {
        id: "message",
        h: "Ce que devient votre message",
        p: [
          "Votre message et votre adresse e-mail arrivent dans notre messagerie, hébergée par OVH. Nous les gardons le temps de traiter votre demande, puis nous les effaçons, sauf obligation légale.",
        ],
        link: { label: "Confidentialité", path: "/confidentialite" },
      },
    ],
  }),
};

const EN: Record<InfoName, (v: V) => InfoPage> = {
  securite: (v) => ({
    title: "Security",
    lede: "What Shhgone protects, how, and what it cannot do. No protection is perfect: here is what is true today.",
    blocks: [
      {
        id: "chiffrement",
        h: "Locked on your device",
        p: [
          "Your files and texts are encrypted in your browser before they leave. What reaches our server is unreadable without the key, for us as for anyone else.",
          "The password, optional and off by default, is deliberately slow to check when you turn it on: trying passwords at random is very expensive for anyone who wants to guess it.",
          "File names, their types and your texts are encrypted too: we can't read them.",
        ],
      },
      {
        id: "lien",
        h: "The link and the password",
        p: [
          "The key is hidden at the end of the link, after the # sign. Browsers never send that part to a server. Opening a share takes the link, and also the password if you set one: our server has neither.",
          "Without a password (the default), anyone who has the link can open the share: a messaging backup or a browser history that keeps the link is enough, as long as the share exists and an open is left. Turn on the password and send it another way to be safer.",
          `With a password, after ${v.tries} wrong passwords, the share is destroyed. It is also erased when its time runs out (${v.h} h at most on the free plan) or after the chosen number of opens (${v.opens} at most).`,
        ],
      },
      {
        id: "serveur",
        h: "What our server sees",
        list: [
          "Encrypted data, with a rounded size. Never the key or the password.",
          "Your IP address while you are connected, like any website. It is never written down.",
          "The approximate size of a share, when it is sent and opened, and which encrypted pieces are read.",
          "No creation date is kept; end times are rounded to the quarter hour.",
        ],
      },
      {
        id: "sortie",
        h: "After the last open",
        p: [
          "Once all opens are used, nobody else can get in. Each person who opened the share can come back to it from the same browser until its time runs out, without using an open: the encrypted content therefore stays on the server until then. The last person can destroy it right away; otherwise it is erased at the end of the duration chosen when sending.",
          "To come back, this browser keeps the open permission, encrypted, never the key or the password; you reopen the link (and type the password again if there is one). From another device, in a private window or after our server restarts, coming back is no longer possible once all opens are used.",
        ],
      },
      {
        id: "limites",
        h: "What Shhgone cannot do",
        list: [
          "Prevent a screenshot, a photo of the screen or a copy: what the recipient sees or downloads is theirs.",
          "Erase your browser history. We remove the key from the address bar, but the browser has already recorded the full address in its history (sometimes synced). Open the link in a private window to leave fewer traces.",
          "Guarantee the device's memory is wiped: we clear it as best we can. So that a reload doesn't cost an open, the link and an open code stay in this tab's storage while the share is open (never the password or the content; without a password, that link is enough to reopen the share).",
          "Remove everything from files. Photos, PDFs and office documents lose their hidden information (location, device, author, dates), as do videos and audio, if you clean them before sending (one tap, on your device; without it, the file is sent as is). Archives and unsupported formats are sent as they are: their row says so. What is visible in the picture or readable in the document stays: a photo keeps its preview thumbnail (it may show the photo as it was before cropping or editing), a PDF only loses its document properties (its pages, their thumbnails and its images stay as they are), comments in a document keep their authors, and a PDF edited several times may keep older passages.",
          "Verify the sender: a link can come from anyone.",
          "Protect you from a tampered site: if our server or code were compromised, the site could steal keys. That is why the code is public and the site can be rebuilt identically from it.",
          "Hide your IP address from the server and the host while you are connected.",
        ],
        link: { label: "Check that this site serves the public code", path: "/verifier", section: "verifier" },
      },
      {
        id: "qr",
        h: "QR code and one-tap sharing",
        p: [
          "“Share” can send the link and the password together, and the QR code holds both (without a password, the link alone). With a single open (the default), nobody else can see the content afterwards, and the recipient would see it had already been opened.",
          "But someone who reads the message before the recipient can open it in their place, and the QR address (link and password) stays in the history of the browser that opens it. To be safer, send the link and the password through two different channels.",
        ],
      },
      {
        id: "appareil",
        h: "Camera and microphone",
        p: [
          "The site can only use the camera and microphone for its own recordings, after you agree, and never inside another site. The browser's other sensitive features are closed to it.",
        ],
      },
      VERIFIER_EN.block,
    ],
    tech: {
      h: "Technical details (for experts)",
      list: [
        "Content, names, types and texts: AES-256-GCM (WebCrypto), keys derived with HKDF-SHA-256; no home-made cryptography.",
        "Password (optional): Argon2id (RustCrypto, in the site's WebAssembly engine), 64 MiB of memory, 3 passes, combined with the key in the link fragment (after #), which is never sent to the server. Without a password, a key derived from the fragment by HKDF-SHA-256 takes its place; the server receives the same data and does not know which shares have a password.",
        `Opening: the server checks a proof derived from the key and the password (or the key alone), without receiving either; ${v.tries} wrong proofs destroy the share.`,
        "Size: the encrypted upload starts as soon as a file is added, before “Encrypt and send”. During the upload, the server sees the size to within 4 MiB, because the content goes up in encrypted 4 MiB pieces. Once the upload is done, the encrypted content fills a fixed size tier: the server then knows only that tier.",
        "Browser: strict headers (Content-Security-Policy, Permissions-Policy); no script, font or tracker from another site.",
        ...VERIFIER_EN.tech,
      ],
      links: [
        { label: "Public source code (GitHub)", url: SOURCE_URL },
        { label: "Public specification", url: SPEC_URL },
        ...VERIFIER_EN.links,
      ],
    },
  }),
  confidentialite: (v) => ({
    title: "Privacy",
    lede: "No account, to send or to receive. No trackers, no audience measurement, no ads.",
    blocks: [
      {
        h: "What we keep",
        list: [
          "The encrypted content and only what is needed to serve it: its rounded size, its expiry rounded to the quarter hour, the opens and failed attempts left, and verifiers that cannot decrypt anything.",
          "None of it holds your name, email address, IP address, file names or readable content.",
          `Everything is erased when it expires (${v.h} h at most on the free plan), or sooner when destroyed. After the last open, the encrypted content stays until it expires, so the recipient can come back to it, unless they destroy it.`,
        ],
      },
      {
        h: "What we don't keep",
        list: [
          "Your IP address is not recorded. The server sees it while handling each request, like any website, but never writes it down or keeps it: the anti-abuse limits keep only a one-way code derived from it, in memory only, under a random key replaced every day and then erased: once the key is gone, nothing links that code to your address.",
          "No cookies of ours, and no analytics.",
          "No log of shares, no audience measurement. The server only keeps, in memory, global counters for its own operation (for example the number of shares created since it last started): nothing per person, per address or per share, nothing on disk.",
        ],
      },
      {
        h: "On your device",
        list: [
          "Decrypted content stays in memory and is never written to browser storage.",
          "The link and an open code stay in the tab's storage while the share is open, so a reload doesn't cost an open.",
          "The display language follows your browser's: nothing is stored for it.",
          "Room: to get your seat back after a reload, your member code, the name you use there and the room key are kept encrypted on this device, readable only with the room password; they are erased when the room ends.",
          "Paid plans: the pass, its status read that same day, the anonymous proofs it gives (with the time each one was obtained) and the signing keys already seen are kept encrypted on this device.",
          "No list of your shares or of the links you receive is kept, on the device or in an account. “Link ready” and “Room ready” show you the management link: keep it yourself, it is the only way to follow or delete the share later.",
          "The downloads history is off by default: nothing is kept until you turn it on yourself. When on, it keeps the name, size and kind of each saved file, where it came from and the time, encrypted on this device; it is never sent, and never holds the link or the password. Each entry is erased after 30 days; turning it off erases it all.",
        ],
      },
      {
        id: "paiement",
        h: "Paid plans: payment",
        list: [
          "Payment, when it is offered, takes place on the page of the provider you choose, to which we send you: Stripe for cards, PayPal, or NOWPayments for cryptocurrencies. None of their scripts is loaded on our pages.",
          "The provider sees what you give it (depending on the method: name, email address, card, PayPal account or wallet), your IP address, the amount and a randomly drawn order number; it keeps them under its own rules. The country you declare passes through our server for VAT, without being kept there (for cards, we also pass it on to Stripe).",
          "Your device draws a random pass, which says nothing about you. We keep a one-way code derived from the pass, the plan, the chosen method (card, PayPal or crypto), the dates to the day, the number of paid shares left, the order number, the provider's subscription reference (to stop the renewal) and a one-way code of its payment references (for a refund or a dispute). Never your name, your email address, your country, the amount or your IP address (the plan and its length are enough, though, to work out the price).",
          "Someone who combined the provider's data with our database could link your identity to your pass and its plan, never to your shares.",
          "Exception: for someone they know, the operator can give an access without payment and attach a name or a note to it; that name is kept on our server with the pass's code, and erased with it.",
          "Each paid share uses an anonymous proof, signed “blind” (Privacy Pass): when your device asks for proofs, our server sees the pass and how many it takes; when a share uses one, it sees a proof valid for Plus or Pro, without being able to tell which pass it came from. The proof does not link two shares together either.",
          "Audio and video calls in rooms are reserved for Plus and Pro: the first participant who starts a call uses an anonymous proof in the same way, which opens calls for the whole room until it ends; the other participants need no plan. Our server sees that a participant in that room used a Plus or Pro proof, without knowing which pass it came from; but if it is the room's creator, whom our server knows by their account, it thereby learns that this account has Plus or Pro (and which one), still without knowing which pass.",
          "Limit: each proof carries the day of its key. A paid share therefore only hides among the passes of the same plan that took proofs that day or the day before.",
          "Limit: timing. After each paid share, while the site stays open, your device refills its small reserve of proofs at a randomly drawn time. But with no proof in reserve (first paid share, or after one or two days without one), proofs are requested at the very moment of the share; likewise, the device asks for the pass's status at most once a day (and after a payment or a refusal), when the home page or the send page opens. With few buyers, our server could then link a paid share made right after to your pass by its timing; the same goes for a call started right after (and so for the room where it takes place).",
          "Limit: the same key for everyone. A malicious server could give one key per person and so recognise their proofs. To hinder this, our server announces its keys seven days ahead; your device keeps the ones it has seen and refuses, with a warning, a different key for a day already announced. But a server that gave your device its own keys from the very first contact would not be detected by that device alone: that would take a comparison with another source, for example between the site and the future apps.",
          "Retention: an unpaid order is erased after 7 days; a paid order is kept until 180 days after the plan ends (the time limit for payment disputes), then erased; the pass code, 31 days after the plan ends. A used proof is kept for only two days, as a one-way code, so that it can be used only once. This database is backed up every day, encrypted, with another host; each copy is erased after 7 days.",
          "Stripe, PayPal and NOWPayments are responsible for their own processing (payment, fraud prevention, legal obligations), under their privacy policies; they may transfer data outside the European Union. Invoices and accounts are kept from their statements, outside our server, for 10 years as the law requires.",
        ],
      },
      {
        id: "appels",
        h: "Audio and video calls",
        list: [
          "Sound and picture are end-to-end encrypted between participants (DTLS-SRTP): our relay passes them on without being able to read them.",
          "They always go through our relay: the other participants do not see your IP address. The relay itself sees it during the call, with the volume and timing, in memory only; nothing is written to disk.",
          "To reach the relay, your device gets a temporary identifier (6 hours at most) that names neither the room nor the person.",
        ],
      },
      {
        id: "contact",
        h: "If you write to us",
        p: [
          "Your message and your email address arrive in our mailbox, hosted by OVH. We keep them while we handle your request, then erase them, unless the law requires otherwise (for example a request from an authority). The technical alerts our server sends us contain no user data.",
        ],
      },
      {
        id: "hebergement",
        h: "Hosting",
        p: [
          "The site and its data are hosted in France, on a dedicated server rented from OVH. Only the accounts and payments databases are backed up, encrypted, with another host; never shares or rooms.",
        ],
      },
      {
        id: "verification",
        h: "Bot check",
        p: [
          "Your browser solves a small proof of work, with no outside service.",
        ],
      },
      {
        h: "Your rights",
        p: [
          "We keep nothing that could identify you or find your shares from your identity. To exercise your rights or ask a question, write to us (Contact page). A share can be destroyed at any time by its sender (management link) or, at the last open, by its recipient.",
          "The controller of this processing is Shhgone's publisher (see the legal notice). You can also complain to the CNIL (cnil.fr).",
        ],
        link: { label: "Contact page", path: "/contact" },
      },
      {
        h: "Requests from authorities",
        p: [
          "We answer lawful requests from authorities, sent to the address on the Contact page. Here is what we can give them, and what we cannot give, because we do not have it.",
        ],
        list: [
          "The content of a share or a room: never, it is encrypted on your device and we do not have the key.",
          "Who sent or opened a share: nothing lets us know, no IP address is kept.",
          "For a link sent to us: we can destroy the share or the room at once.",
          "With an account: only what the account keeps, never the content or an IP address.",
        ],
      },
    ],
  }),
  conditions: (v) => ({
    title: "Terms of use",
    lede: "The rules for using Shhgone, and the terms of sale of the Plus and Pro plans. Updated on 25 November 2026.",
    blocks: [
      {
        h: "Purpose",
        p: [
          "Shhgone lets you send files, photos, videos, voice messages and notes, encrypted on your device, with a link (and a password if you wish), without an account. These terms apply to any use of the site. By using Shhgone, you accept them.",
        ],
      },
      {
        h: "The service",
        list: [
          "Your content is encrypted in your browser before it leaves: we can neither read it, find it, nor give it back.",
          `A share erases itself when it expires (${v.h} h at most on the free plan), after the chosen number of opens (${v.opens} at most), or after ${v.tries} wrong passwords. Free limits: ${v.n} items and ${v.size} per share.`,
          "Shhgone is not a backup service: keep your originals. A lost link or password cannot be recovered, not even by us.",
        ],
      },
      {
        id: "vente",
        h: "Paid plans: terms of sale",
        p: ["When they are offered, the Plus and Pro plans are bought on the Plans page. They add space, duration and opens, and let you start audio and video calls in a room; neither adds security."],
        list: [
          `Prices including VAT: Plus €${PAID.plus.month} a month or €${PAID.plus.year} a year; Pro €${PAID.pro.month} a month or €${PAID.pro.year} a year. The same price including VAT in every country. Sold only to people who live in the European Union.`,
          `What you get: Plus, up to ${formatBytes(PAID.plus.bytes, "en")} per share, ${jours(PAID.plus.ttlDays, "or")} days and ${PAID.plus.opens} opens; Pro, up to ${formatBytes(PAID.pro.bytes, "en")}, ${jours(PAID.pro.ttlDays, "or")} days and ${PAID.pro.opens} opens. Shares included: ${PLUS_JETONS} (Plus) or ${PRO_JETONS} (Pro) per 30-day period, not carried over; opening calls in a room counts as one share.`,
          "Length: a month is 30 days, a year 365 days, from the day the provider confirms the payment.",
          "Renewal: by card or PayPal, the monthly plan renews every month; the yearly plan is, as you choose, a one-off payment or a yearly renewal (never chosen for you). In cryptocurrency, it is always a one-off payment, with no renewal. “Stop renewal”, on the device that holds the plan, stops it in one step, at no cost: the plan runs until the end of the paid period, and nothing more is charged.",
          "Payment: on the page of the provider you choose (Stripe, PayPal or NOWPayments). The plan is active once the provider confirms the payment to us.",
          "Right of withdrawal: you normally have 14 days to withdraw. Because the plan works as soon as you pay, the Plans page asks you, before paying, to request immediate access and to waive this right for the period started (a box that is not ticked in advance); without it, payment does not start.",
          "A full refund or a payment dispute stops the plan.",
          "Your plan is a pass drawn at random by your device: we do not know who bought it. Without an account, it lives only on that device: clearing the site's data loses it, and we cannot find it again.",
          "Invoice: Stripe sends it to the address given when paying; for PayPal and cryptocurrencies, ask us at the address on the Contact page, quoting the order number given by the provider. After payment, “Download the sales receipt” also gives a summary, made on your device.",
          "You benefit from the legal guarantee of conformity for digital content and services (French Consumer Code, articles L224-25-12 onwards). For any complaint, write to the address on the Contact page.",
        ],
      },
      {
        h: "Allowed use",
        p: ["Shhgone is for sending content privately. You may not use it to:"],
        list: [
          "spread illegal content: child sexual abuse, glorifying or inciting terrorism, inciting hatred or violence, intimate content shared without consent;",
          "harass, threaten, defraud or impersonate anyone;",
          "spread malware or a phishing page;",
          "share content you have no right to share (copyright, privacy, other people's personal data);",
          "disrupt the service (mass automated sending, getting around the limits or the anti-bot check).",
        ],
      },
      {
        h: "Your responsibilities",
        p: [
          "You are responsible for what you send and for who you send it to. Pass on the link (and the password, if there is one, another way) only to the person who should receive them.",
        ],
      },
      {
        h: "Reporting",
        p: [
          "Anyone who opened a share can report it, once per open. The share is deleted for everyone once half of its allowed opens have reported it (rounded up, at least two votes from two opens: 1 of 1, 2 of 2, 2 of 3, 3 of 5). One person alone therefore cannot delete a share meant for several people. See “Report abuse”.",
          "On the decision of an authority, or when we are sent the link to a share that is clearly illegal, we may also delete it.",
        ],
      },
      {
        h: "Moderation",
        p: [
          "We do not read shares or rooms (they are encrypted on your device) and use no automated moderation tool. The only possible measures are deleting a share or a room: through reports from the people who opened it (rule above), or by the publisher, in person, after a written report that includes the link, or at the request of an authority.",
          "Any decision can be challenged by writing to the address on the Contact page: a person reviews it again.",
        ],
      },
      {
        h: "Availability",
        p: [
          "The service is provided as is, with no guarantee of availability. It may be interrupted for maintenance or after an incident; an upload in progress may then be lost and will have to be done again.",
        ],
      },
      {
        h: "Liability",
        p: [
          "To the extent permitted by law, we are not liable for the content exchanged, which we cannot read, nor for a share disappearing under its rules (expiry, opens, wrong passwords, reports). Nothing in these terms limits the rights the law gives you, in particular as a consumer.",
        ],
      },
      {
        h: "Personal data",
        p: ["What we keep, and above all what we don't, is described on the Privacy page."],
      },
      {
        h: "Intellectual property",
        p: ["Your content stays yours: we acquire no rights over it. Shhgone's code is public, under the AGPL-3.0 license."],
      },
      {
        h: "Changes",
        p: ["We may change these terms. The update date is shown at the top of this page; the version in force is the one shown when you use the service."],
      },
      {
        h: "Governing law",
        p: [
          "These terms are governed by French law. In case of a dispute, an amicable solution is sought first by writing to us (Contact page); failing that, the French courts have jurisdiction, subject to the rules that protect consumers.",
        ],
      },
    ],
  }),
  mentions: () => ({
    title: "Legal notice",
    lede: "Who publishes Shhgone, who hosts it, and how to reach us.",
    draft: true,
    blocks: [
      {
        h: "Publisher",
        list: [
          "Shhgone is published by a private individual acting in a non-professional capacity who, as French law allows (Law no. 2004-575 of 21 June 2004, article 1-1, II), does not publish their identity: it is known to the host below.",
          "Contact: contact@shhgone.com (in French or English).",
        ],
      },
      { h: "Host", list: ["OVH SAS", "2 rue Kellermann, 59100 Roubaix, France", "Phone: +33 9 72 10 10 07", "Dedicated server in France (Strasbourg). The domain name, its DNS and the mailbox are also with OVH SAS."] },
      {
        h: "Contact and illegal content",
        p: [
          "Single point of contact for authorities and users (EU Digital Services Act, articles 11 and 12), including removal requests from authorities: contact@shhgone.com, in French or English. Every message is read by a person, never by a bot alone.",
          "To report illegal content: from the share (“Report this share”), or in writing to contact@shhgone.com (see “Report abuse” for what to include); you can also report it to the authorities (in France: PHAROS, internet-signalement.gouv.fr).",
        ],
        link: { label: "Contact page", path: "/contact" },
      },
      {
        h: "Personal data",
        p: ["See the Privacy page. To exercise your rights, write to contact@shhgone.com; you can also complain to the CNIL (cnil.fr)."],
      },
      { h: "Intellectual property and source code", p: ["The Shhgone name and logo belong to the publisher. Shhgone's code is public, under the AGPL-3.0 license."] },
    ],
  }),
  signaler: (v) => ({
    title: "Report abuse",
    lede: "An illegal or malicious share? If you opened it, you can report it in two steps.",
    blocks: [
      {
        h: "From the share",
        list: [
          "Open the share with its link (and its password if it has one).",
          "Below the content, choose “Report this share”, say what is going on, then “Report”.",
          "Each open counts as one vote. The share is deleted for everyone once half of its allowed opens have reported it (at least two votes from two opens: 1 of 1, 2 of 2, 2 of 3, 3 of 5): downloads in progress are cut, no open remains possible. Otherwise your report is counted and the share stays open to the others.",
        ],
      },
      {
        h: "What we receive",
        p: [
          "A report holds only the category you chose (for example “Scam”) and the proof that you opened the share: neither the content nor who you are. We cannot read the share. We count, in memory only, reports per category since the server last started and their number per hour, to spot mass abuse; nothing is written to disk.",
          `Without the link (and the password, if there is one), nothing can be done to the share: it erases itself when it expires (${v.h} h at most on the free plan). For illegal content, you can also write to the address on the Contact page with the link.`,
        ],
      },
      {
        h: "In writing",
        list: [
          "Write to the address on the Contact page with: the full link of the share (including what follows the “#”) and its password if it has one and you have it, without which no one can see the content of a protected share; what seems illegal to you, and why; your name and email address (optional for child sexual abuse material); a sentence confirming that you report in good faith and that this information is accurate.",
          "We acknowledge receipt, a person reviews the share (never a bot alone), then we reply with our decision and the possible remedies.",
          "Manifestly illegal content is destroyed at once: no open remains possible, downloads in progress are cut. If someone's life or safety is threatened, we alert the authorities.",
        ],
        link: { label: "Contact page", path: "/contact" },
      },
    ],
  }),
  contact: () => ({
    title: "Contact",
    lede: "A question, content to report, a legal request or a security flaw: write to us.",
    blocks: [
      {
        id: "adresse",
        h: "Our address",
        mail: true,
        p: ["In French or English. Every message is read by a person, never by a bot alone."],
      },
      {
        id: "pourquoi",
        h: "What to write to us about",
        list: [
          "A question, or help using Shhgone.",
          "Illegal content: the simplest way is to report it from the share. To report it in writing, the “Report abuse” page says what to include.",
          "Authorities and legal requests, including removal requests: this address is our single point of contact (EU Digital Services Act, articles 11 and 12).",
          "Exercising your rights over your personal data (GDPR): access, rectification, erasure, objection. You can also complain to the CNIL (cnil.fr).",
          "Security: a flaw or unusual behaviour of the site. Tell us what you saw and how to reproduce it.",
        ],
        link: { label: "Report abuse", path: "/signaler" },
      },
      {
        id: "jamais",
        h: "What you should never send us",
        p: [
          "The full link of a share, with its password if it has one: whoever has them can open the share. The only exception is a written abuse report, where we need them to see the content, as the “Report abuse” page says.",
          "We will never ask you for a password.",
        ],
      },
      {
        id: "message",
        h: "What happens to your message",
        p: [
          "Your message and your email address arrive in our mailbox, hosted by OVH. We keep them while we handle your request, then erase them, unless the law requires otherwise.",
        ],
        link: { label: "Privacy", path: "/confidentialite" },
      },
    ],
  }),
};

// --- Avec le compte (__COMPTES__ seulement ; conception du compte par passkey §8, §12, §13 ; à relire par le juriste) ---

const COMPTE_FR: Partial<Record<InfoName, (p: InfoPage) => InfoPage>> = {
  confidentialite: (p) => ({
    ...p,
    lede: "Sans compte pour envoyer, recevoir ou rejoindre un salon. Aucun traceur, aucune mesure d'audience, aucune publicité.",
    blocks: remplacer(
      inserer(p.blocks, "Ce que nous ne gardons pas", {
        id: "compte",
        h: "Si vous créez un compte (pour créer des salons)",
        list: [
          "Pour créer un salon, un compte sans e-mail ni mot de passe, par passkey : votre téléphone, votre ordinateur ou votre gestionnaire de mots de passe vous reconnaît. Nous ne demandons ni adresse, ni numéro de téléphone, ni nom.",
          "Pour chaque passkey, nous gardons sa clé publique, son identifiant, le mois de son ajout et si elle peut se synchroniser entre vos appareils ; jamais le modèle de votre gestionnaire. Avec l'identifiant tiré au hasard du compte, ce sont des données pseudonymes : elles ne disent pas qui vous êtes, mais restent des données personnelles.",
          "Votre clé de récupération ne quitte jamais votre appareil : le serveur garde seulement un code à sens unique tiré d'elle, qui retrouve le compte quand vous la tapez, et jamais de quoi ouvrir vos données.",
          "Votre pseudo, votre photo et votre abonnement sont chiffrés sur vos appareils : le service ne peut pas les lire. Pour vérifier qu'il est unique, une forme simplifiée de votre pseudo est aussi gardée, sous forme d'un code à sens unique.",
          "Votre abonnement est dans un second coffre, chiffré de la même façon : nous ne pouvons pas le lire. Les deux coffres ne s'ouvrent qu'avec une de vos passkeys ou votre clé de récupération. Le compte ne garde ni vos liens, ni vos partages, ni la gestion de vos salons.",
          "Apple, Google ou votre gestionnaire de mots de passe gardent la passkey : ils apprennent que vous avez un compte Shhgone et votre pseudo (c'est le nom de la passkey). C'est leur traitement, selon leurs propres règles.",
          "Nous savons quels salons votre compte a créés, le temps de leur vie, pour pouvoir bannir un compte qui nuit ; jamais quels partages.",
          "Dates gardées au jour (création, ancienneté), dernière connexion au mois : aucune heure, aucune adresse IP, aucun nom d'appareil ni de passkey en clair.",
          "Signalements : seulement leur catégorie, comptée en mémoire. Un bannissement est lié au compte, avec sa durée (3 ans par défaut) et sa catégorie, montrée à la personne avec un identifiant pour un recours.",
          "La base des comptes est sauvegardée chaque jour, chiffrée, chez un autre hébergeur ; chaque copie est effacée après 7 jours. Un compte supprimé peut donc rester jusqu'à 7 jours dans ces copies.",
          "Sans connexion pendant 13 mois, le compte est effacé, au plus tard au début du 14e mois. Nous ne pouvons pas vous prévenir : nous n'avons aucun moyen de vous joindre.",
        ],
      }),
      "Vos droits",
      {
        h: "Vos droits",
        p: [
          "Sans compte, nous ne gardons rien qui permette de vous identifier ni de retrouver vos partages à partir de votre identité. Pour exercer vos droits, écrivez-nous (page Contact). Un partage peut être détruit à tout moment par son expéditeur (lien de gestion) ou, à la dernière ouverture, par son destinataire.",
          "Avec un compte : la page Compte montre ce que nous gardons (date de création, palier, appareils, passkeys) ; vous y corrigez votre pseudo et votre photo, et vous supprimez votre compte à tout moment. Pour un recours contre un bannissement, écrivez-nous en donnant l'identifiant montré à la connexion (page Contact).",
          "Le responsable de ces traitements est l'éditeur de Shhgone (voir les mentions légales). Vous pouvez aussi adresser une réclamation à la CNIL (cnil.fr).",
        ],
        link: { label: "Page Contact", path: "/contact" },
      },
    ),
  }),
  conditions: (p) => ({
    ...p,
    blocks: inserer(p.blocks, "Signalement", {
      id: "compte",
      h: "Compte",
      p: [
        "Un compte gratuit sert seulement à créer des salons ; partager, ouvrir un lien et rejoindre un salon restent sans compte. Il faut avoir au moins 15 ans.",
        "Le compte s'ouvre par une passkey ou par la clé de récupération montrée à sa création. Sans passkey ni clé de récupération, le compte ne peut pas être récupéré : nous n'avons aucun moyen de vous le rendre.",
        "Un compte qui crée des salons pour nuire peut être banni : il ne peut plus créer de salon et ses salons sont fermés, pendant la durée du bannissement (3 ans par défaut). Le motif est montré à la connexion ; un recours est possible en nous écrivant (page Contact).",
        "Un compte sans connexion pendant 13 mois est effacé, au plus tard au début du 14e mois.",
      ],
    }),
  }),
  securite: (p) => ({
    ...p,
    blocks: inserer(p.blocks, "Ce que Shhgone ne peut pas faire", {
      id: "compte",
      h: "Ce que le compte ne protège pas",
      list: [
        "Votre clé de récupération est la clé du compte : qui la lit peut prendre le compte et retirer vos passkeys. Rangez-la hors ligne ou dans votre gestionnaire de mots de passe ; si elle a pu être vue, créez-en une nouvelle dans les paramètres.",
        "Sur un appareil où votre passkey ne peut pas ouvrir vos données, la clé qui les ouvre est gardée sur l'appareil, protégée seulement par son verrouillage ; « Se déconnecter » l'efface.",
        "Qui peut utiliser une de vos passkeys (votre téléphone déverrouillé, votre gestionnaire de mots de passe) a aussi votre compte : pseudo, photo, abonnement, salons à créer.",
        "Sans passkey ni clé de récupération, le compte et ses données sont perdus.",
        "Notre serveur sait quels salons votre compte a créés, le temps de leur vie.",
        "Un pseudo ne prouve pas une identité : dans un salon, n'importe qui peut choisir le même.",
      ],
    }),
  }),
  contact: (p) => ({
    ...p,
    blocks: p.blocks.map((b) => (b.id === "jamais" ? { ...b, p: [b.p![0]!, "Nous ne vous demanderons jamais un mot de passe ni votre clé de récupération de compte."] } : b)),
  }),
};

const COMPTE_EN: Partial<Record<InfoName, (p: InfoPage) => InfoPage>> = {
  confidentialite: (p) => ({
    ...p,
    lede: "No account to send, to receive or to join a room. No trackers, no audience measurement, no ads.",
    blocks: remplacer(
      inserer(p.blocks, "What we don't keep", {
        id: "compte",
        h: "If you create an account (to create rooms)",
        list: [
          "To create a room, an account with neither email nor password, using a passkey: your phone, your computer or your password manager recognises you. We ask for no address, no phone number and no name.",
          "For each passkey, we keep its public key, its identifier, the month it was added and whether it can sync between your devices; never the model of your password manager. With the account's random identifier, this is pseudonymous data: it does not say who you are, but it is still personal data.",
          "Your recovery key never leaves your device: the server keeps only a one-way code derived from it, which finds the account when you type it, and never anything that opens your data.",
          "Your nickname, your photo and your subscription are encrypted on your devices: the service cannot read them. To check that your nickname is unique, a simplified form of it is also kept, as a one-way code.",
          "Your subscription is in a second vault, encrypted the same way: we cannot read it. Both vaults only open with one of your passkeys or your recovery key. The account keeps neither your links, nor your shares, nor the management of your rooms.",
          "Apple, Google or your password manager keep the passkey: they learn that you have a Shhgone account and your nickname (it is the passkey's name). That is their processing, under their own rules.",
          "We know which rooms your account created, for as long as they live, so that an account that does harm can be banned; never which shares.",
          "Dates kept to the day (creation, seniority), last sign-in to the month: no time of day, no IP address, no readable device or passkey name.",
          "Reports: only their category, counted in memory. A ban is tied to the account, with its length (3 years by default) and its category, shown to the person with an identifier for an appeal.",
          "The accounts database is backed up every day, encrypted, with another host; each copy is erased after 7 days. A deleted account can therefore remain in these copies for up to 7 days.",
          "With no sign-in for 13 months, the account is erased, at the latest at the start of the 14th month. We cannot warn you: we have no way to reach you.",
        ],
      }),
      "Your rights",
      {
        h: "Your rights",
        p: [
          "Without an account, we keep nothing that could identify you or find your shares from your identity. To exercise your rights, write to us (Contact page). A share can be destroyed at any time by its sender (management link) or, at the last open, by its recipient.",
          "With an account: the Account page shows what we keep (creation date, tier, devices, passkeys); you correct your nickname and photo there, and delete your account at any time. To appeal against a ban, write to us quoting the identifier shown at sign-in (Contact page).",
          "The controller of this processing is Shhgone's publisher (see the legal notice). You can also complain to the CNIL (cnil.fr).",
        ],
        link: { label: "Contact page", path: "/contact" },
      },
    ),
  }),
  conditions: (p) => ({
    ...p,
    blocks: inserer(p.blocks, "Reporting", {
      id: "compte",
      h: "Account",
      p: [
        "A free account is only used to create rooms; sharing, opening a link and joining a room need no account. You must be at least 15.",
        "The account opens with a passkey or with the recovery key shown when it is created. Without a passkey or the recovery key, the account cannot be recovered: we have no way to give it back to you.",
        "An account that creates rooms to do harm can be banned: it can no longer create rooms and its rooms are closed, for the length of the ban (3 years by default). The reason is shown at sign-in; an appeal is possible by writing to us (Contact page).",
        "An account with no sign-in for 13 months is erased, at the latest at the start of the 14th month.",
      ],
    }),
  }),
  securite: (p) => ({
    ...p,
    blocks: inserer(p.blocks, "What Shhgone cannot do", {
      id: "compte",
      h: "What the account does not protect",
      list: [
        "Your recovery key is the key to the account: whoever reads it can take over the account and remove your passkeys. Keep it offline or in your password manager; if it may have been seen, create a new one in the settings.",
        "On a device where your passkey cannot open your data, the key that opens it is kept on the device, protected only by its lock; “Sign out” erases it.",
        "Whoever can use one of your passkeys (your unlocked phone, your password manager) also has your account: nickname, photo, subscription, rooms to create.",
        "Without a passkey or the recovery key, the account and its data are lost.",
        "Our server knows which rooms your account created, for as long as they live.",
        "A nickname does not prove an identity: in a room, anyone can pick the same one.",
      ],
    }),
  }),
  contact: (p) => ({
    ...p,
    blocks: p.blocks.map((b) => (b.id === "jamais" ? { ...b, p: [b.p![0]!, "We will never ask you for a password or for your account recovery key."] } : b)),
  }),
};

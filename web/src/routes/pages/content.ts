// Pages d'information (plan Task 25, retours UI5) : Sécurité, Confidentialité, Conditions
// d'utilisation, Mentions légales, Signaler un abus. Textes relus sur la spécification
// (docs/superpowers/specs/2026-11-03-shhdrop-design.md : §2, §5.3, §7, §9, §18, §35, §36, §41.4,
// §41.8, D41-28, D41-29). Règles : jamais « 100 % », aucune allégation d'audit ni de pays
// d'hébergement (plan B3), aucune identité d'éditeur ni d'hébergeur inventée (champs « à
// compléter par le propriétaire »), aucune adresse e-mail. Chiffres lus dans les constantes.
// Compte par e-mail (plan du compte, lot 16 ; conception compte §16, §21.18) : les textes qui
// DÉCRIVENT le compte ne s'ajoutent qu'avec __COMPTES__ (COMPTE_FR, COMPTE_EN) : le site public
// n'annonce pas une fonction absente. Les phrases communes restent vraies dans les deux cas.
import { CONTENT_MAX, MAX_ITEMS, MAX_OPENS, PW_TRIES, TTL_MAX_HOURS } from "../../limits";
import { formatBytes, type Lang } from "../../i18n/format";

export type InfoName = "securite" | "confidentialite" | "conditions" | "mentions" | "signaler";
export type Block = { id?: string; h: string; p?: string[]; list?: string[] };
/** Section repliée en bas de page (Sécurité : détails techniques pour les experts, liens publics). */
export type Tech = { h: string; p?: string[]; list?: string[]; links: { label: string; url: string }[] };
export type InfoPage = { title: string; lede: string; draft?: boolean; blocks: Block[]; tech?: Tech };

/** Dépôt public du code (lien sortant simple : rien n'est chargé depuis GitHub). */
export const SOURCE_URL = "https://github.com/Skoow/shhgone";
export const SPEC_URL = "https://github.com/Skoow/shhgone/blob/main/docs/superpowers/specs/2026-11-03-shhdrop-design.md";

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
          "Le mot de passe est volontairement lent à vérifier : essayer des mots de passe au hasard coûte très cher à qui voudrait le deviner.",
          "Les noms de fichiers, leurs types et vos textes sont chiffrés aussi : nous ne pouvons pas les lire.",
        ],
      },
      {
        id: "lien",
        h: "Le lien et le mot de passe",
        p: [
          "La clé est cachée dans la fin du lien, après le signe #. Les navigateurs n'envoient jamais cette partie à un serveur. Il faut le lien et le mot de passe pour ouvrir un partage : notre serveur n'a ni l'un ni l'autre.",
          `Après ${v.tries} mots de passe faux, le partage est détruit. Il s'efface aussi à la fin de sa durée (${v.h} h au plus en gratuit) ou après le nombre d'ouvertures choisi (${v.opens} au plus).`,
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
          "Pour revenir, ce navigateur garde l'autorisation d'ouverture, chiffrée, jamais la clé ni le mot de passe ; il faut rouvrir le lien et retaper le mot de passe. Depuis un autre appareil, en navigation privée ou après un redémarrage de notre serveur, le retour n'est plus possible si toutes les ouvertures sont prises.",
        ],
      },
      {
        id: "limites",
        h: "Ce que Shhgone ne peut pas faire",
        list: [
          "Empêcher une capture d'écran, une photo de l'écran ou une copie : ce que le destinataire voit ou télécharge lui appartient.",
          "Effacer l'historique de votre navigateur. Nous retirons la clé de la barre d'adresse, mais le navigateur a déjà noté l'adresse complète dans son historique (parfois synchronisé). Ouvrez le lien en navigation privée pour laisser moins de traces.",
          "Garantir que la mémoire de l'appareil est vidée : nous l'effaçons du mieux possible. Pour qu'un rechargement ne coûte pas une ouverture, le lien et un jeton d'ouverture restent dans le stockage de cet onglet le temps de l'ouverture (jamais le mot de passe ni le contenu).",
          "Tout effacer dans les fichiers. Photos, PDF et documents bureautiques perdent leurs informations cachées (lieu, appareil, auteur, dates), comme les vidéos et les sons, si vous les nettoyez avant l'envoi (un geste, sur votre appareil ; sans lui, le fichier part tel quel). Les archives et les formats non pris en charge partent tels quels : leur ligne le dit. Ce qui se voit dans l'image ou se lit dans le document reste : la vignette d'aperçu d'une photo est gardée (elle peut montrer la photo d'avant un recadrage ou une retouche), un PDF ne perd que ses propriétés de document (ses pages, leurs miniatures et ses images restent telles quelles), les commentaires d'un document gardent leurs auteurs, et un PDF modifié plusieurs fois peut garder d'anciens passages.",
          "Vérifier l'expéditeur : un lien peut venir de n'importe qui.",
          "Vous protéger d'un site piégé : si notre serveur ou notre code était compromis, le site servi pourrait voler les clés. C'est pour cela que le code est public et que le site se reconstruit à l'identique depuis ce code.",
          "Cacher votre adresse IP au serveur et à l'hébergeur pendant la connexion.",
        ],
      },
      {
        id: "qr",
        h: "QR code et partage en un geste",
        p: [
          "« Partager » peut envoyer le lien et le mot de passe ensemble, et le QR code les contient tous les deux. Avec une seule ouverture (le réglage par défaut), personne d'autre ne pourra voir le contenu ensuite, et le destinataire verrait qu'il a déjà été ouvert.",
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
    ],
    tech: {
      h: "Détails techniques (pour les experts)",
      list: [
        "Contenu, noms, types et textes : AES-256-GCM (WebCrypto), clés dérivées par HKDF-SHA-256 ; aucune cryptographie maison.",
        "Mot de passe : Argon2id (RustCrypto, dans le moteur WebAssembly du site), 64 Mio de mémoire, 3 passes, combiné à la clé du fragment du lien (après #), jamais transmise au serveur.",
        `Ouverture : le serveur vérifie une preuve dérivée de la clé et du mot de passe, sans recevoir ni l'une ni l'autre ; ${v.tries} preuves fausses détruisent le partage.`,
        "Taille : le contenu chiffré occupe des paliers fixes ; le serveur ne connaît que le palier.",
        "Navigateur : en-têtes stricts (Content-Security-Policy, Permissions-Policy) ; aucun script, police ni traceur d'un autre site.",
      ],
      links: [
        { label: "Code source public (GitHub)", url: SOURCE_URL },
        { label: "Spécification publique", url: SPEC_URL },
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
          "Le lien et un jeton d'ouverture restent dans le stockage de l'onglet le temps de l'ouverture, pour qu'un rechargement ne coûte pas une ouverture.",
          "La langue affichée suit celle de votre navigateur : rien n'est gardé pour cela.",
          "Salon : pour retrouver votre place après un rechargement, votre jeton de membre, le nom que vous y portez et la clé du salon sont gardés chiffrés sur cet appareil, lisibles seulement avec le mot de passe du salon ; ils s'effacent à la fin du salon.",
          "Offres payantes : le pass et les jetons anonymes qu'il donne (avec l'heure où chacun a été obtenu) sont gardés chiffrés sur cet appareil.",
          "Si vous cochez « Garder ce partage », le lien reçu (avec sa clé), sa taille et son échéance sont gardés chiffrés sur cet appareil, jamais le mot de passe. Ils s'effacent 7 jours après l'échéance, ou quand vous les retirez.",
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
          "Chaque partage payant dépense un jeton anonyme, signé « en aveugle » (Privacy Pass) : quand votre appareil demande des jetons, notre serveur voit le pass et combien de jetons il prend ; quand un partage en dépense un, il voit un jeton valable pour Plus ou Pro, sans pouvoir savoir de quel pass il vient. Le jeton ne relie pas non plus deux partages entre eux.",
          "Limite : chaque jeton porte le jour de sa clé. Un partage payant ne se cache donc que parmi les pass de la même offre qui ont pris des jetons ce jour-là ou la veille.",
          "Limite : l'heure. Après chaque partage payant, tant que le site reste ouvert, votre appareil refait sa petite réserve de jetons à une heure tirée au hasard. Mais sans jeton en réserve (premier partage payant, ou après un ou deux jours sans), les jetons sont demandés au moment même du partage ; et l'appareil demande l'état du pass à l'ouverture de l'accueil ou de la page d'envoi. Avec peu d'acheteurs, notre serveur pourrait alors rapprocher ce partage de votre pass par l'heure.",
          "Limite : rien ne prouve encore à votre appareil que notre serveur donne la même clé du jour à tout le monde. Un serveur malveillant pourrait donner une clé par personne et reconnaître ainsi ses jetons. Ce point n'est pas résolu.",
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
          "Nous ne gardons rien qui permette de vous identifier ni de retrouver vos partages à partir de votre identité. Pour exercer vos droits ou poser une question, utilisez le contact des mentions légales. Un partage peut être détruit à tout moment par son expéditeur (lien de gestion) ou, à la dernière ouverture, par son destinataire.",
        ],
      },
      {
        h: "Demandes des autorités",
        p: [
          "Nous répondons aux demandes légales des autorités, qui s'adressent au contact des mentions légales. Voici ce que nous pouvons leur donner, et ce que nous ne pouvons pas donner, parce que nous ne l'avons pas.",
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
    lede: "Les règles d'usage de Shhgone. Mise à jour le 20 novembre 2026.",
    blocks: [
      {
        h: "Objet",
        p: [
          "Shhgone permet d'envoyer des fichiers, des photos, des vidéos, des messages vocaux et des notes, chiffrés sur votre appareil, par un lien et un mot de passe, sans compte. Ces conditions s'appliquent à toute utilisation du site. En utilisant Shhgone, vous les acceptez.",
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
          "Vous êtes responsable de ce que vous envoyez et de la personne à qui vous l'envoyez. Transmettez le lien et le mot de passe par deux moyens différents, et seulement à qui doit les recevoir.",
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
          "Toute décision peut être contestée en écrivant au contact des mentions légales : elle est réexaminée par une personne.",
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
          "Ces conditions sont soumises au droit français. En cas de litige, une solution amiable est d'abord recherchée par le contact des mentions légales ; à défaut, les tribunaux français sont compétents, sous réserve des règles qui protègent le consommateur.",
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
        list: ["OVH SAS", "2 rue Kellermann, 59100 Roubaix, France", "Téléphone : +33 9 72 10 10 07"],
      },
      {
        h: "Contact et contenus illicites",
        p: [
          "Point de contact unique pour les autorités et pour les utilisateurs (règlement européen sur les services numériques, articles 11 et 12), y compris pour les demandes de retrait des autorités : contact@shhgone.com, en français ou en anglais. Chaque message est lu par une personne, jamais par un robot seul.",
          "Pour signaler un contenu illicite : depuis le partage (« Signaler ce partage »), ou par écrit à contact@shhgone.com (voir « Signaler un abus » pour ce qu'il faut joindre) ; vous pouvez aussi le signaler aux autorités (en France : PHAROS, internet-signalement.gouv.fr).",
        ],
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
          "Ouvrez le partage avec son lien et son mot de passe.",
          "En bas du contenu, choisissez « Signaler ce partage », dites ce qui se passe, puis « Signaler ».",
          "Chaque ouverture compte pour une voix. Le partage est supprimé pour tout le monde quand la moitié de ses ouvertures permises l'ont signalé (deux voix au moins dès deux ouvertures : 1 sur 1, 2 sur 2, 2 sur 3, 3 sur 5) : les téléchargements en cours sont coupés, plus aucune ouverture n'est possible. Sinon, votre signalement est compté et le partage reste ouvert aux autres.",
        ],
      },
      {
        h: "Ce que nous recevons",
        p: [
          "Le signalement ne contient que la catégorie choisie (par exemple « Arnaque ») et la preuve que vous avez ouvert le partage : ni le contenu, ni qui vous êtes. Nous ne pouvons pas lire le partage. Nous comptons, en mémoire seulement, les signalements par catégorie depuis le dernier démarrage du serveur et leur nombre dans l'heure, pour repérer un abus massif ; rien n'est écrit sur disque.",
          `Sans le lien et le mot de passe, rien ne peut être fait sur le partage : il s'effacera seul à son échéance (${v.h} h au plus en gratuit). Pour un contenu illégal, vous pouvez aussi écrire au contact des mentions légales en joignant le lien.`,
        ],
      },
      {
        h: "Par écrit",
        list: [
          "Écrivez au contact des mentions légales en joignant : le lien complet du partage (avec ce qui suit le « # ») et son mot de passe si vous l'avez, sans lequel personne ne peut voir le contenu ; ce qui vous paraît illégal, et pourquoi ; votre nom et votre adresse e-mail (facultatifs pour un contenu d'abus sexuel sur mineur) ; une phrase qui confirme que vous signalez de bonne foi et que ces informations sont exactes.",
          "Nous accusons réception, une personne examine le partage (jamais un robot seul), puis nous vous répondons avec notre décision et les recours possibles.",
          "Un contenu manifestement illégal est détruit tout de suite : plus aucune ouverture, téléchargements en cours coupés. Si la vie ou la sécurité de quelqu'un est menacée, nous prévenons les autorités.",
        ],
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
          "The password is deliberately slow to check: trying passwords at random is very expensive for anyone who wants to guess it.",
          "File names, their types and your texts are encrypted too: we can't read them.",
        ],
      },
      {
        id: "lien",
        h: "The link and the password",
        p: [
          "The key is hidden at the end of the link, after the # sign. Browsers never send that part to a server. Opening a share takes the link and the password: our server has neither.",
          `After ${v.tries} wrong passwords, the share is destroyed. It is also erased when its time runs out (${v.h} h at most on the free plan) or after the chosen number of opens (${v.opens} at most).`,
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
          "To come back, this browser keeps the open permission, encrypted, never the key or the password; you reopen the link and type the password again. From another device, in a private window or after our server restarts, coming back is no longer possible once all opens are used.",
        ],
      },
      {
        id: "limites",
        h: "What Shhgone cannot do",
        list: [
          "Prevent a screenshot, a photo of the screen or a copy: what the recipient sees or downloads is theirs.",
          "Erase your browser history. We remove the key from the address bar, but the browser has already recorded the full address in its history (sometimes synced). Open the link in a private window to leave fewer traces.",
          "Guarantee the device's memory is wiped: we clear it as best we can. So that a reload doesn't cost an open, the link and an open token stay in this tab's storage while the share is open (never the password or the content).",
          "Remove everything from files. Photos, PDFs and office documents lose their hidden information (location, device, author, dates), as do videos and audio, if you clean them before sending (one tap, on your device; without it, the file is sent as is). Archives and unsupported formats are sent as they are: their row says so. What is visible in the picture or readable in the document stays: a photo keeps its preview thumbnail (it may show the photo as it was before cropping or editing), a PDF only loses its document properties (its pages, their thumbnails and its images stay as they are), comments in a document keep their authors, and a PDF edited several times may keep older passages.",
          "Verify the sender: a link can come from anyone.",
          "Protect you from a tampered site: if our server or code were compromised, the site could steal keys. That is why the code is public and the site can be rebuilt identically from it.",
          "Hide your IP address from the server and the host while you are connected.",
        ],
      },
      {
        id: "qr",
        h: "QR code and one-tap sharing",
        p: [
          "“Share” can send the link and the password together, and the QR code holds both. With a single open (the default), nobody else can see the content afterwards, and the recipient would see it had already been opened.",
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
    ],
    tech: {
      h: "Technical details (for experts)",
      list: [
        "Content, names, types and texts: AES-256-GCM (WebCrypto), keys derived with HKDF-SHA-256; no home-made cryptography.",
        "Password: Argon2id (RustCrypto, in the site's WebAssembly engine), 64 MiB of memory, 3 passes, combined with the key in the link fragment (after #), which is never sent to the server.",
        `Opening: the server checks a proof derived from the key and the password, without receiving either; ${v.tries} wrong proofs destroy the share.`,
        "Size: encrypted content fills fixed tiers; the server only knows the tier.",
        "Browser: strict headers (Content-Security-Policy, Permissions-Policy); no script, font or tracker from another site.",
      ],
      links: [
        { label: "Public source code (GitHub)", url: SOURCE_URL },
        { label: "Public specification", url: SPEC_URL },
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
          "The link and an open token stay in the tab's storage while the share is open, so a reload doesn't cost an open.",
          "The display language follows your browser's: nothing is stored for it.",
          "Room: to get your seat back after a reload, your member token, the name you use there and the room key are kept encrypted on this device, readable only with the room password; they are erased when the room ends.",
          "Paid plans: the pass and the anonymous tokens it gives (with the time each one was obtained) are kept encrypted on this device.",
          "If you tick “Keep this share”, the received link (with its key), its size and its expiry are kept encrypted on this device, never the password. They are erased 7 days after expiry, or when you remove them.",
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
          "Each paid share spends an anonymous token, signed “blind” (Privacy Pass): when your device asks for tokens, our server sees the pass and how many tokens it takes; when a share spends one, it sees a token valid for Plus or Pro, without being able to tell which pass it came from. The token does not link two shares together either.",
          "Limit: each token carries the day of its key. A paid share therefore only hides among the passes of the same plan that took tokens that day or the day before.",
          "Limit: timing. After each paid share, while the site stays open, your device refills its small reserve of tokens at a randomly drawn time. But with no token in reserve (first paid share, or after one or two days without one), tokens are requested at the very moment of the share; and the device asks for the pass's status when the home page or the send page opens. With few buyers, our server could then link that share to your pass by its timing.",
          "Limit: nothing yet proves to your device that our server gives the same key of the day to everyone. A malicious server could give one key per person and so recognise their tokens. This is not solved.",
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
          "We keep nothing that could identify you or find your shares from your identity. To exercise your rights or ask a question, use the contact in the legal notice. A share can be destroyed at any time by its sender (management link) or, at the last open, by its recipient.",
        ],
      },
      {
        h: "Requests from authorities",
        p: [
          "We answer lawful requests from authorities, sent to the contact in the legal notice. Here is what we can give them, and what we cannot give, because we do not have it.",
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
    lede: "The rules for using Shhgone. Updated on 20 November 2026.",
    blocks: [
      {
        h: "Purpose",
        p: [
          "Shhgone lets you send files, photos, videos, voice messages and notes, encrypted on your device, with a link and a password, without an account. These terms apply to any use of the site. By using Shhgone, you accept them.",
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
          "You are responsible for what you send and for who you send it to. Pass on the link and the password through two different channels, and only to the person who should receive them.",
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
          "Any decision can be challenged by writing to the contact in the legal notice: a person reviews it again.",
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
          "These terms are governed by French law. In case of a dispute, an amicable solution is sought first through the contact in the legal notice; failing that, the French courts have jurisdiction, subject to the rules that protect consumers.",
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
      { h: "Host", list: ["OVH SAS", "2 rue Kellermann, 59100 Roubaix, France", "Phone: +33 9 72 10 10 07"] },
      {
        h: "Contact and illegal content",
        p: [
          "Single point of contact for authorities and users (EU Digital Services Act, articles 11 and 12), including removal requests from authorities: contact@shhgone.com, in French or English. Every message is read by a person, never by a bot alone.",
          "To report illegal content: from the share (“Report this share”), or in writing to contact@shhgone.com (see “Report abuse” for what to include); you can also report it to the authorities (in France: PHAROS, internet-signalement.gouv.fr).",
        ],
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
          "Open the share with its link and password.",
          "Below the content, choose “Report this share”, say what is going on, then “Report”.",
          "Each open counts as one vote. The share is deleted for everyone once half of its allowed opens have reported it (at least two votes from two opens: 1 of 1, 2 of 2, 2 of 3, 3 of 5): downloads in progress are cut, no open remains possible. Otherwise your report is counted and the share stays open to the others.",
        ],
      },
      {
        h: "What we receive",
        p: [
          "A report holds only the category you chose (for example “Scam”) and the proof that you opened the share: neither the content nor who you are. We cannot read the share. We count, in memory only, reports per category since the server last started and their number per hour, to spot mass abuse; nothing is written to disk.",
          `Without the link and the password, nothing can be done to the share: it erases itself when it expires (${v.h} h at most on the free plan). For illegal content, you can also write to the contact in the legal notice with the link.`,
        ],
      },
      {
        h: "In writing",
        list: [
          "Write to the contact in the legal notice with: the full link of the share (including what follows the “#”) and its password if you have it, without which no one can see the content; what seems illegal to you, and why; your name and email address (optional for child sexual abuse material); a sentence confirming that you report in good faith and that this information is accurate.",
          "We acknowledge receipt, a person reviews the share (never a bot alone), then we reply with our decision and the possible remedies.",
          "Manifestly illegal content is destroyed at once: no open remains possible, downloads in progress are cut. If someone's life or safety is threatened, we alert the authorities.",
        ],
      },
    ],
  }),
};

// --- Avec le compte (__COMPTES__ seulement ; conception compte §16, §21.18 ; à relire par le juriste) ---

const COMPTE_FR: Partial<Record<InfoName, (p: InfoPage) => InfoPage>> = {
  confidentialite: (p) => ({
    ...p,
    lede: "Sans compte pour envoyer, recevoir ou rejoindre un salon. Aucun traceur, aucune mesure d'audience, aucune publicité.",
    blocks: remplacer(
      inserer(p.blocks, "Ce que nous ne gardons pas", {
        id: "compte",
        h: "Si vous créez un compte (pour créer des salons)",
        list: [
          "Votre adresse e-mail n'est gardée qu'en empreinte (un calcul à sens unique, avec une clé secrète du serveur) : nous ne la gardons pas en clair. Elle passe par notre serveur le temps d'envoyer un code, et par notre fournisseur d'envoi d'e-mails (nom à compléter par le propriétaire), qui voit l'adresse, l'heure et le code. L'e-mail ne contient que le code.",
          "Votre mot de passe ne quitte jamais votre appareil : le serveur reçoit seulement une valeur qui en est tirée, et n'en garde qu'une empreinte.",
          "Votre pseudo, votre photo, votre langue et votre abonnement sont chiffrés, mais gardés de façon à pouvoir vous être rendus si vous oubliez votre mot de passe : le service peut donc les lire. Pour vérifier qu'il est unique, une forme simplifiée de votre pseudo est aussi gardée, en empreinte seulement.",
          "Vos liens, les salons que vous rejoignez et la gestion de vos salons et partages sont dans un second coffre, chiffré par votre mot de passe seulement : nous ne pouvons pas les lire. Après un mot de passe oublié, ce coffre est perdu, sauf ce qui est encore sur un de vos appareils.",
          "Nous savons quels salons votre compte a créés, le temps de leur vie, pour pouvoir bannir un compte qui nuit ; jamais quels partages.",
          "Dates gardées au jour (création, ancienneté), dernière connexion au mois : aucune heure, aucune adresse IP, aucun nom d'appareil en clair.",
          "Signalements : seulement leur catégorie, comptée en mémoire. Un bannissement garde l'empreinte de l'adresse, sa durée (3 ans par défaut) et sa catégorie, montrée à la personne ; un recours est possible.",
          "Après une récupération par e-mail, l'adresse ne peut pas être changée ni le compte supprimé pendant 7 jours, par sécurité.",
          "La base des comptes est sauvegardée chaque jour, chiffrée, chez un autre hébergeur ; chaque copie est effacée après 7 jours. Un compte supprimé peut donc rester jusqu'à 7 jours dans ces copies.",
          "Sans connexion pendant 13 mois, le compte est effacé, au plus tard au début du 14e mois. Nous ne pouvons pas vous prévenir : nous n'avons pas votre adresse.",
        ],
      }),
      "Vos droits",
      {
        h: "Vos droits",
        p: [
          "Sans compte, nous ne gardons rien qui permette de vous identifier ni de retrouver vos partages à partir de votre identité. Pour exercer vos droits, utilisez le contact des mentions légales. Un partage peut être détruit à tout moment par son expéditeur (lien de gestion) ou, à la dernière ouverture, par son destinataire.",
          "Avec un compte : vous pouvez exporter vos données (le fichier est fait sur votre appareil), corriger votre pseudo, votre photo et votre adresse, et supprimer votre compte à tout moment depuis ses paramètres. L'empreinte de votre adresse reste une donnée personnelle : pour une demande faite par adresse ou un recours contre un bannissement, écrivez-nous (contact des mentions légales).",
        ],
      },
    ),
  }),
  conditions: (p) => ({
    ...p,
    blocks: inserer(p.blocks, "Signalement", {
      id: "compte",
      h: "Compte",
      p: [
        "Un compte gratuit sert seulement à créer des salons ; partager, ouvrir un lien et rejoindre un salon restent sans compte. Il faut avoir au moins 15 ans.",
        "Un compte qui crée des salons pour nuire peut être banni : il ne peut plus créer de salon, ses salons sont fermés, et la même adresse ne peut pas en recréer un pendant la durée du bannissement (3 ans par défaut). Le motif est montré à la connexion ; un recours est possible par le contact des mentions légales.",
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
        "Votre boîte mail est la clé du compte : qui la lit peut le récupérer (avec la double authentification, il lui faut aussi votre application). Protégez-la bien.",
        "Le service peut lire votre profil (pseudo, photo, langue, abonnement) : c'est ce qui permet de vous le rendre après un mot de passe oublié.",
        "Qui a votre mot de passe a aussi vos liens et la gestion de vos salons et partages.",
        "Votre fournisseur d'e-mails voit que vous recevez des codes Shhgone.",
        "Notre serveur sait quels salons votre compte a créés, le temps de leur vie.",
        "Un pseudo ne prouve pas une identité : dans un salon, n'importe qui peut choisir le même.",
      ],
    }),
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
          "Your email address is kept only as a fingerprint (a one-way computation with a secret server key): we do not keep it in readable form. It passes through our server while a code is sent, and through our email delivery provider (name to be completed by the owner), which sees the address, the time and the code. The email holds only the code.",
          "Your password never leaves your device: the server only receives a value derived from it, and keeps only a fingerprint of that.",
          "Your nickname, photo, language and subscription are encrypted, but kept so that they can be given back if you forget your password: the service can therefore read them. To check that it is unique, a simplified form of your nickname is also kept, as a fingerprint only.",
          "Your links, the rooms you join and the management of your rooms and shares are in a second vault, encrypted by your password only: we cannot read them. After a forgotten password, this vault is lost, except what is still on one of your devices.",
          "We know which rooms your account created, for as long as they live, so that an account that does harm can be banned; never which shares.",
          "Dates kept to the day (creation, seniority), last sign-in to the month: no time of day, no IP address, no readable device name.",
          "Reports: only their category, counted in memory. A ban keeps the fingerprint of the address, its length (3 years by default) and its category, shown to the person; an appeal is possible.",
          "After a recovery by email, the address cannot be changed and the account cannot be deleted for 7 days, for safety.",
          "The accounts database is backed up every day, encrypted, with another host; each copy is erased after 7 days. A deleted account can therefore remain in these copies for up to 7 days.",
          "With no sign-in for 13 months, the account is erased, at the latest at the start of the 14th month. We cannot warn you: we do not have your address.",
        ],
      }),
      "Your rights",
      {
        h: "Your rights",
        p: [
          "Without an account, we keep nothing that could identify you or find your shares from your identity. To exercise your rights, use the contact in the legal notice. A share can be destroyed at any time by its sender (management link) or, at the last open, by its recipient.",
          "With an account: you can export your data (the file is made on your device), correct your nickname, photo and address, and delete your account at any time from its settings. The fingerprint of your address is still personal data: for a request made by address or an appeal against a ban, write to us (contact in the legal notice).",
        ],
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
        "An account that creates rooms to do harm can be banned: it can no longer create rooms, its rooms are closed, and the same address cannot create another one for the length of the ban (3 years by default). The reason is shown at sign-in; an appeal is possible through the contact in the legal notice.",
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
        "Your mailbox is the key to the account: whoever reads it can recover it (with two-factor authentication, they also need your app). Protect it well.",
        "The service can read your profile (nickname, photo, language, subscription): that is what lets it give it back after a forgotten password.",
        "Whoever has your password also has your links and the management of your rooms and shares.",
        "Your email provider sees that you receive Shhgone codes.",
        "Our server knows which rooms your account created, for as long as they live.",
        "A nickname does not prove an identity: in a room, anyone can pick the same one.",
      ],
    }),
  }),
};

# Shhdrop — règles du projet

Partage chiffré de bout en bout, sans compte, avec liens qui s'autodétruisent.
Spécification de référence : `docs/conception/specs/2026-11-03-shhdrop-design.md`.

## Priorités (dans cet ordre)

1. Sécurité et confidentialité.
2. Exactitude (aucune erreur de logique).
3. Simplicité : ne rien coder qui ne serve pas la spécification.

## Vigilance permanente

À chaque étape (spécification, plan, code, revue, mise en ligne), signaler de soi-même, sans attendre qu'on le demande :

- ce qui **manque** et dont on n'a pas encore parlé ;
- toute **erreur**, contradiction ou ambiguïté, y compris dans la spécification ou dans un choix déjà validé ;
- ce qui est **inutile** ou trop complexe pour ce que ça apporte ;
- tout **risque** de sécurité, de confidentialité, légal ou d'exploitation ;
- ce qui peut être **automatisé** pour que le propriétaire ait le moins possible à faire lui-même, sans jamais affaiblir la sécurité : un secret n'est jamais affiché par une session d'assistance ni collé dans une conversation ; le propriétaire ne tape un secret que dans sa propre fenêtre SSH, en saisie masquée.

Chaque signalement donne la gravité, l'endroit, le problème et une correction concrète. On ne corrige pas en silence un choix validé : on le signale et on propose.

## Règles techniques

- Apps iOS et Android natives prévues plus tard (spécification D42-20 : moteur commun en Rust, interface Flutter), **pas développées pour l'instant**. Tout choix de format, de chiffrement, d'API ou de lien doit rester utilisable tel quel par ces apps ; signaler tout ce qui ne marcherait que dans un navigateur.

- Aucune crypto maison : bibliothèques reconnues uniquement, avec les paramètres de la spécification. Site : WebCrypto pour AES-GCM et les nombres aléatoires, bibliothèques Rust reconnues (RustCrypto : hkdf, sha2, hmac, argon2, subtle) dans le moteur pour le reste ; apps : RustCrypto, libsodium ou bibliothèques du système (moteur Rust, sous-projet 1, validé le 10 novembre). Exception, salon : OpenMLS (version épinglée) sur RustCrypto, avec son propre AES-GCM (OpenMLS ne peut pas utiliser WebCrypto), dans le même moteur Rust pour le site (module wasm à part) et les apps (validé par le propriétaire, 12 novembre). Exception, jetons anonymes des offres payantes (Privacy Pass, RSA aveugle, RFC 9474 et 9578 type 2, RSABSSA-SHA384-PSS-Deterministic) : crate Rust `blind-rsa-signatures` (= 0.19.0) dans le moteur pour le site et les apps, et `github.com/cloudflare/circl` (v1.6.5, `blindsign/blindrsa`) dans le serveur Go, versions exactes épinglées après revue de chaîne d'approvisionnement, mêmes résultats prouvés par des vecteurs communs (décision du propriétaire, 19 novembre ; conception `docs/conception/specs/2026-11-19-paiement-design.md` §7, §12 ; ajoutées le 19 novembre). Compte (décision du propriétaire, 22 novembre) : passkeys vérifiées par `github.com/go-webauthn/webauthn` v0.18.2 (et ses dépendances aux versions exactes de `docs/conception/revues/2026-11-22-revue-go-webauthn.md`, épinglées après revue de chaîne d'approvisionnement ; signatures vérifiées par la bibliothèque standard de Go), clé du coffre ouverte par l'extension PRF de WebAuthn ou par une clé de récupération, avec HKDF-SHA-256 et AES-256-GCM (conception `docs/conception/specs/2026-11-22-compte-passkey-design.md` §5, §6). Exception, HMAC-SHA1 imposé par un protocole standard, jamais pour protéger un contenu (validé par le propriétaire, 22 novembre) : identifiants temporaires du relais d'appel TURN (« REST », `crypto/hmac` et `crypto/sha1` de Go, vérifiés par pion/turn épinglé ; le média reste chiffré de bout en bout par DTLS-SRTP ; conception `docs/conception/specs/2026-11-20-appels-design.md` §5). Paiement (décision du 19 novembre) : par redirection vers la page hébergée de Stripe, PayPal ou NOWPayments, jamais de script du prestataire dans nos pages ; le serveur ne garde que l'empreinte du pass, jamais d'identité, de pays ni de montant. Le site et les apps doivent donner les mêmes résultats, prouvés par des vecteurs de test communs (décision du propriétaire, 10 novembre).
- Le serveur ne doit jamais recevoir ni stocker de contenu, de nom de fichier, de clé ou de mot de passe en clair. Le test « le serveur ne voit rien » bloque toute mise en ligne.
  Aucune exception : le séquestre du profil a été retiré le 22 novembre (conception `docs/conception/specs/2026-11-22-compte-passkey-design.md` §8). Le serveur ne reçoit jamais la sortie PRF d'une passkey, la clé de récupération ni la clé du compte ; il ne garde que les clés publiques des passkeys, les enveloppes chiffrées (4 au plus par passkey) et l'empreinte `v_r` (test bloquant « le serveur ne voit rien » du compte).
- Aucune ressource tierce sur le site : pas de CDN, de police externe, d'analytics ni de traceur, sans exception (le repli Google reCAPTCHA de la spécification §26 a été retiré le 24 novembre, décision du propriétaire).
- Aucune adresse IP enregistrée sur disque.
- Passkeys du compte : `navigator.credentials` n'est appelé que dans `web/src/account/navigateur.ts` (la démo le remplace par une passkey simulée, jamais de vraie passkey) ; aucune requête entre le geste et la cérémonie ; la sortie PRF ne quitte jamais l'appareil (liste blanche de `clientExtensionResults`). Sur l'appareil, seule la base `shhdrop-compte` garde le compte (session si « Rester connecté », clé locale si la passkey n'ouvre pas les données), chiffrée par une clé non extractible et effacée par « Se déconnecter ».
- Toute modification passe par des tests. On n'annonce rien comme « fait » sans preuve (tests passés, captures).
- Ne jamais écrire « 100 % sécurisé ».

## Git

- Commits : auteur = adresse anonyme GitHub du propriétaire (`git commit --author="Skoow <190851638+Skoow@users.noreply.github.com>"`), committer = identité signée de l'environnement (configuration globale, ne pas la remplacer), pour que GitHub affiche « Verified ». Jamais l'e-mail personnel du propriétaire.
- Travail poussé régulièrement sur GitHub : la machine de développement peut être réinitialisée à tout moment.
- Tout le travail se fait directement sur la branche `main` (décision du propriétaire) : pas de branche de travail, tests au vert avant chaque push.

## Langue

Échanges et documentation en français ; code et messages de commit techniques en français ou en anglais, au choix, mais de façon cohérente dans un même fichier.

# Ouvrir les comptes au public : ce qu'il faut réunir

État au 22 novembre 2026. Le compte fonctionne **sans e-mail** depuis la décision du propriétaire du 22 novembre (conception `docs/superpowers/specs/2026-11-22-compte-passkey-design.md`) :
- inscription et connexion par passkey (WebAuthn), « Rester connecté » ;
- clé de récupération de 27 caractères, notée à l'inscription, quand toutes les passkeys sont perdues ;
- passkeys du compte (ajout, nom, retrait), liste des appareils, export, suppression ;
- pseudo unique, deux coffres chiffrés sur l'appareil.

Avec l'e-mail ont disparu : le code par e-mail, le mot de passe, le mot de passe oublié, la double authentification (TOTP), le séquestre du profil et le relais SMTP.

**Côté serveur, c'est codé et testé** (lots S1 à S8 du plan `docs/superpowers/plans/2026-11-22-compte-passkey.md`). **Le site reste à refaire** contre ces routes (lots W du plan) : le site actuel parle encore à l'ancien compte par e-mail et ne marche plus contre le serveur.

Il est **activé en production** (décision D8 du 19 novembre) : `SHH_COMPTES: "1"` dans `deploy/compose.yaml`, site de l'image construit avec `SHH_SITE_COMPTES=1`. `deploy.sh` refuse d'installer sans la clé du serveur (point 4) et pour un autre nom que `shhgone.com`. Dans la démo GitHub Pages, il est **essayable**, avec un faux serveur dans l'onglet ; ce faux serveur est encore celui du compte par e-mail et sera refait avec le site.

Ce document liste ce qui manque pour l'ouvrir au public. La procédure technique elle-même est dans `deploy/README.md` §12.

## 1. Décisions qui vous reviennent

| N° | Décision | État | Ce qu'il faut faire |
|---|---|---|---|
| D8 | Ouverture au public | **prise le 19 novembre : ouvert** | `SHH_COMPTES: "1"` et `SHH_SALONS: "1"` dans `deploy/compose.yaml`, site de l'image construit avec le compte. **Risque assumé : sans l'avis du juriste (point 2).** |
| ~~D1~~ | ~~Fournisseur d'envoi d'e-mails~~ | **caduque le 22 novembre** | le compte n'envoie plus d'e-mail. Seule l'alerte de la machine en envoie, avec son propre identifiant (`deploy/README.md` §4, « Surveillance ») |
| D4 | Un signalement remet l'ancienneté à zéro | ouverte | recommandé : oui, avec « Rendre l'ancienneté » au tableau de bord |
| D7 | « Rester connecté » | ouverte | recommandé : proposé, décoché par défaut ; session de 30 jours sans usage, 90 jours au plus (c'est ce qui est codé) |

Sources : `docs/superpowers/specs/2026-11-14-compte-email-design.md`, §20 ; `docs/superpowers/specs/2026-11-22-compte-passkey-design.md`, §16 (questions tranchées le 22 novembre).

## 2. Avis du juriste (recommandé ; D8 prise sans lui, risque assumé)

À lui soumettre, avec la conception du compte (§16, §21.18) :
- **LCEN art. 6 et décret 2021-1362** : obligation possible de conserver 1 an les données de création de compte (pseudonyme ; plus aucune adresse e-mail n'est reçue depuis le 22 novembre) et de connexion (adresse IP). Elle contredirait « aucune adresse IP sur disque » (gravité élevée, R17). La conception du compte par passkey, §12, donne le détail.
- **Recherche du 22 novembre (non juridique, à faire confirmer)**, détail en §2.1 ci-dessous.
- **Contenus terroristes et pédocriminels** : obligations de l'hébergeur (LCEN, DSA art. 16 à 18, règlement TCO 2021/784) face à des signalements de contenus que Shhgone ne peut pas lire (R15).
- **Motif de bannissement** gardé sous forme de catégorie : donnée relative à une infraction présumée (RGPD art. 10, R16).
- **Photo de profil** : contenu hébergé. Depuis le retrait du séquestre (22 novembre), le serveur ne peut plus la lire.
- **Bannissement sans adresse** : un compte banni se recrée avec une autre passkey. Est-ce une mesure suffisante face à une demande d'une autorité ? Conception du compte par passkey, §7.4.

### 2.1 Conservation des IP et des données d'identification : ce que disent les textes (22 novembre 2026)

Recherche faite sans avocat, sur sources secondaires (Légifrance refuse les lectures automatiques) ; seules les citations marquées « texte » ont été recoupées.

- **Pas d'obligation de collecter** (texte) : décret 2021-1362, art. 8 : « Les données mentionnées aux articles 2 à 6 ne doivent être conservées que dans la mesure où elles sont collectées » ; Conseil d'État, 30 juin 2023, n° 459724 : les hébergeurs « ne sont tenus de conserver que les données qu'ils sont amenés à collecter dans le cadre de leur activité ».
- **Mais ce qui est collecté doit être gardé** : identité civile, dont l'adresse e-mail, 5 ans ; pseudonyme et données de vérification du mot de passe, 1 an après la clôture ; paiement, 1 an ; IP de la source de connexion, 1 an.
- **Nouveau, gravité élevée** : injonction « sécurité nationale » renouvelée par le décret n° 2026-920 du 30 septembre 2026 (en vigueur le 21 octobre 2026) ; elle vise aussi les hébergeurs (art. 6 du décret 2021-1362 : identifiant du contenu, nature de l'opération, date et heure, 1 an). Shhdrop crée l'identifiant et l'heure de chaque partage puis les détruit : non traité jusqu'ici.
- **Nouveau, gravité élevée** : le salon est probablement un « service de communications interpersonnelles non fondé sur la numérotation » (CPCE L32, ordonnance 2021-650), donc Shhdrop serait opérateur pour le salon (L34-1). Précédent : la Cour fédérale allemande a traité Tuta comme un service de télécommunications.
- **Sanction** (ancien art. 6 VI LCEN, numérotation après la loi SREN à vérifier) : 1 an et 75 000 € pour le dirigeant, 375 000 € pour la personne morale. Le risque concret est une réquisition à laquelle on ne peut pas répondre.

Questions à poser à l'avocat :
1. Une IP tenue en mémoire quelques minutes, pour limiter le débit, est-elle « collectée » au sens de l'art. 8 ?
2. ~~L'adresse e-mail reçue pour envoyer le code~~ : sans objet depuis le 22 novembre, plus aucune adresse n'est reçue. À la place : le pseudonyme et la clé publique d'une passkey sont-ils des « données d'identification » à garder 1 an après la clôture du compte ? Aujourd'hui, ils sont effacés à la suppression.
3. Le salon fait-il de Shhdrop un opérateur (L32, L34-1) ? Déclaration à l'ARCEP ?
4. L'injonction 2026-920 oblige-t-elle à garder un an l'identifiant et l'heure de chaque partage et de chaque salon ?
5. Des liens privés relèvent-ils de l'hébergement (LCEN, DSA) ?
6. Où sont aujourd'hui l'obligation et la sanction après la loi SREN ?
7. Que faire face à un ordre de journalisation ciblée pour l'avenir (art. 100 du code de procédure pénale) ?

## 3. Ce qui manque encore dans le produit

- **Le salon** (plans C-3 à C-5) : **codé et testé** au 19 novembre (création, entrée, conversation, pièces, vocaux, règles d'effacement, codes, exclusion avec nouvelle invitation, preuve de membre, destruction ; « le serveur ne voit rien » étendu au salon). Avant l'ouverture publique, il reste :
  - ~~les décisions prises par défaut à valider~~ : validées par le propriétaire le 22 novembre (spécification du salon v3, §16 : preuve de membre en AES-GCM de WebCrypto, sens de « Ouvert », silencieux gardé dans la preuve, délai de l'alerte d'écart, pièces une par une sans album) ;
  - un passage sous WebKit (Safari, iPhone) du parcours `web/ui-e2e/salon.spec.ts` ;
  - les restes listés dans les plans C-4 et C-5 (lien de gestion collé dans la conversation, vidéo de plus de 16 Mo, fiche « Infos ») : aucun ne bloque l'usage, à trancher.
- **Jetons anonymes (Privacy Pass)** et paiement Plus/Pro : le coffre du compte prévoit le pass Plus, mais la vente n'est pas codée.

## 4. À préparer techniquement (vous, avec `deploy/README.md` §12)

1. ~~Compte chez le fournisseur d'e-mails (D1)~~ : **caduc** le 22 novembre, plus de SMTP pour le compte. S'il a été créé, effacer `secrets/shh_smtp_mdp` (`deploy.sh` refuse de démarrer tant qu'il est là), puis révoquer le mot de passe chez le fournisseur.
2. **Clé du serveur** (32 octets) dans `/srv/shhdrop/secrets/`, avec des droits stricts (§12.2).
   - **Copie hors ligne obligatoire.** Sans elle, l'unicité des pseudos est perdue ; les comptes, eux, restent utilisables.
3. **Sauvegarde quotidienne chiffrée** de `comptes.db` (§12.4), installée **le jour même** de l'activation, puis une restauration essayée (§12.5) :
   - `age` et sa paire de clés (la clé privée hors ligne, à part de la clé du serveur) ;
   - un stockage objet dans l'UE, chez un autre fournisseur que l'hébergeur, avec versions et suppression après 7 jours ;
   - un accès en écriture seule sur la machine.
4. **Configuration** :
   - `deploy/.env` : `SHH_DOMAIN=shhgone.com`, le seul nom accepté avec le compte, car les passkeys sont liées à ce nom. Aucune variable `SHH_SMTP_*` ni `SHH_MAIL_FROM` : elles sont refusées ;
   - `compose.yaml` : `SHH_SALONS: "1"` et `SHH_COMPTES: "1"`.
5. **Site** construit avec `SHH_SITE_COMPTES=1`, contrôlé par `node scripts/check-dist.mjs --comptes`, **après la refonte du site** (lots W du plan).
6. Déploiement : `deploy/deploy.sh sha256:<empreinte>`. Il contrôle les secrets et le nom du site.

## 5. Preuves déjà en place

- **Tests du serveur** : `server/internal/compte` (cérémonies WebAuthn avec un authentificateur logiciel, clé de récupération, enveloppes, limites, bannissement, effacement) et `server/internal/api` (routes du compte par HTTP).
- **Test « le serveur ne voit rien » étendu au compte par passkey** : `web/e2e/compte-sees-nothing.test.ts`, bloquant. Il fouille le dossier de données, les sorties et la mémoire du serveur : ni sortie PRF, ni clé du compte, ni clé de récupération, ni pseudo affiché, ni photo, ni AAGUID sur disque.
- **Revue de la bibliothèque WebAuthn** (go-webauthn v0.18.2 et ses dépendances) : `docs/superpowers/plans/2026-11-22-revue-go-webauthn.md`.
- **À refaire avec le site** : tests unitaires du compte dans `web/src/account` et `web/src/routes/compte`, faux serveur de la démo (`web/src/demo/fake-compte.ts`), parcours par l'interface (`web/ui-e2e/compte.spec.ts`, `compte.demo.spec.ts`). Ils sont encore écrits pour le compte par e-mail ; `web/ui-e2e/compte.spec.ts` et `salon.spec.ts` ne démarrent plus, le serveur refusant les variables SMTP qu'ils posent.

Ce qui reste à votre charge : les décisions (point 1), l'avis du juriste (point 2) et la préparation du point 4. Côté code, il reste la refonte du site (lots W du plan).

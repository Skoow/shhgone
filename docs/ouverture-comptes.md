# Ouvrir les comptes au public : ce qu'il faut réunir

État au 19 novembre 2026. Le compte par e-mail est **entièrement codé** côté moteur, serveur et site :
- inscription par code e-mail, connexion, « Rester connecté » ;
- double authentification (TOTP), mot de passe oublié, changement d'adresse et de mot de passe ;
- liste des appareils, export, suppression ;
- pseudo unique, deux coffres chiffrés sur l'appareil.

Il est **activé en production** (décision D8 du 19 novembre) : `SHH_COMPTES: "1"` dans `deploy/compose.yaml`, site de l'image construit avec `SHH_SITE_COMPTES=1`. Il ne peut pas encore fonctionner en ligne : `deploy.sh` refuse d'installer sans les secrets et le fournisseur d'e-mails (point 4). Dans la démo GitHub Pages, il est **essayable**, avec un faux serveur dans l'onglet ; aucun e-mail n'y est envoyé.

Ce document liste ce qui manque pour l'ouvrir au public. La procédure technique elle-même est dans `deploy/README.md` §12.

## 1. Décisions qui vous reviennent

| N° | Décision | État | Ce qu'il faut faire |
|---|---|---|---|
| D8 | Ouverture au public | **prise le 19 novembre : ouvert** | `SHH_COMPTES: "1"` et `SHH_SALONS: "1"` dans `deploy/compose.yaml`, site de l'image construit avec le compte. **Risque assumé : sans l'avis du juriste (point 2).** |
| D1 | Fournisseur d'envoi d'e-mails | ouverte | choisir un fournisseur dans l'UE, en SMTP standard (recommandé : Scaleway Transactional Email) |
| D4 | Un signalement remet l'ancienneté à zéro | ouverte | recommandé : oui, avec « Rendre l'ancienneté » au tableau de bord |
| D7 | « Rester connecté » | ouverte | recommandé : proposé, décoché par défaut ; session de 30 jours sans usage, 90 jours au plus (c'est ce qui est codé) |

Source : `docs/superpowers/specs/2026-11-14-compte-email-design.md`, §20 et §21.19.

## 2. Avis du juriste (recommandé ; D8 prise sans lui, risque assumé)

À lui soumettre, avec la conception du compte (§16, §21.18) :
- **LCEN art. 6 et décret 2021-1362** : obligation possible de conserver 1 an les données de création de compte (adresse, pseudonyme) et de connexion (adresse IP). Elle contredirait « adresse jamais gardée » et « aucune adresse IP sur disque » (gravité élevée, R17).
- **Recherche du 22 novembre (non juridique, à faire confirmer)**, détail en §2.1 ci-dessous.
- **Contenus terroristes et pédocriminels** : obligations de l'hébergeur (LCEN, DSA art. 16 à 18, règlement TCO 2021/784) face à des signalements de contenus que Shhgone ne peut pas lire (R15).
- **Motif de bannissement** gardé sous forme de catégorie : donnée relative à une infraction présumée (RGPD art. 10, R16).
- **Photo de profil** : contenu hébergé, lisible par le séquestre (R22).
- **Suppression retardée de 7 jours** après une récupération : compatible avec le RGPD art. 12.3 ? (§21.10).

### 2.1 Conservation des IP et des données d'identification : ce que disent les textes (22 novembre 2026)

Recherche faite sans avocat, sur sources secondaires (Légifrance refuse les lectures automatiques) ; seules les citations marquées « texte » ont été recoupées.

- **Pas d'obligation de collecter** (texte) : décret 2021-1362, art. 8 : « Les données mentionnées aux articles 2 à 6 ne doivent être conservées que dans la mesure où elles sont collectées » ; Conseil d'État, 30 juin 2023, n° 459724 : les hébergeurs « ne sont tenus de conserver que les données qu'ils sont amenés à collecter dans le cadre de leur activité ».
- **Mais ce qui est collecté doit être gardé** : identité civile, dont l'adresse e-mail, 5 ans ; pseudonyme et données de vérification du mot de passe, 1 an après la clôture ; paiement, 1 an ; IP de la source de connexion, 1 an.
- **Nouveau, gravité élevée** : injonction « sécurité nationale » renouvelée par le décret n° 2026-920 du 30 septembre 2026 (en vigueur le 21 octobre 2026) ; elle vise aussi les hébergeurs (art. 6 du décret 2021-1362 : identifiant du contenu, nature de l'opération, date et heure, 1 an). Shhdrop crée l'identifiant et l'heure de chaque partage puis les détruit : non traité jusqu'ici.
- **Nouveau, gravité élevée** : le salon est probablement un « service de communications interpersonnelles non fondé sur la numérotation » (CPCE L32, ordonnance 2021-650), donc Shhdrop serait opérateur pour le salon (L34-1). Précédent : la Cour fédérale allemande a traité Tuta comme un service de télécommunications.
- **Sanction** (ancien art. 6 VI LCEN, numérotation après la loi SREN à vérifier) : 1 an et 75 000 € pour le dirigeant, 375 000 € pour la personne morale. Le risque concret est une réquisition à laquelle on ne peut pas répondre.

Questions à poser à l'avocat :
1. Une IP tenue en mémoire quelques minutes, pour limiter le débit, est-elle « collectée » au sens de l'art. 8 ?
2. L'adresse e-mail reçue pour envoyer le code puis gardée en empreinte HMAC : identité civile « collectée » à garder 5 ans ? L'empreinte suffit-elle ? Effet sur la suppression du compte ?
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

1. **Compte chez le fournisseur d'e-mails** (D1) :
   - SMTP en TLS implicite sur le port 465 ;
   - suivi des ouvertures et des clics désactivé ;
   - contrat de sous-traitance (RGPD art. 28) ;
   - journaux gardés le moins longtemps possible ;
   - enregistrements DNS de l'expéditeur (SPF, DKIM, DMARC) posés et vérifiés (§12.1).
2. **Clé du serveur** (32 octets) et mot de passe SMTP, dans `/srv/shhdrop/secrets/`, avec des droits stricts (§12.2).
   - **Copie hors ligne de la clé obligatoire** : sans elle, tous les comptes sont perdus, sans recours.
3. **Sauvegarde quotidienne chiffrée** de `comptes.db` (§12.4), installée **le jour même** de l'activation, puis une restauration essayée (§12.5) :
   - `age` et sa paire de clés (la clé privée hors ligne, à part de la clé du serveur) ;
   - un stockage objet dans l'UE, chez un autre fournisseur que l'hébergeur, avec versions et suppression après 30 jours ;
   - un accès en écriture seule sur la machine.
4. **Configuration** :
   - `deploy/.env` : `SHH_SMTP_HOST`, `SHH_SMTP_USER`, `SHH_MAIL_FROM` ;
   - `compose.yaml` : `SHH_SALONS: "1"` et `SHH_COMPTES: "1"`.
5. **Site** construit avec `SHH_SITE_COMPTES=1`, contrôlé par `node scripts/check-dist.mjs --comptes`.
6. Déploiement : `deploy/deploy.sh sha256:<empreinte>`. Il contrôle le relais SMTP, les secrets et le fournisseur.

## 5. Preuves déjà en place

- **Tests unitaires** : du compte (`web/src/account`, `web/src/routes/compte`) et du serveur (`server/internal/compte`, `server/internal/api/compte_test.go`).
- **Test « le serveur ne voit rien » étendu au compte** : `web/e2e/compte-sees-nothing.test.ts`, bloquant.
- **Démo** : parcours par l'interface (`web/ui-e2e/compte.demo.spec.ts`) et faux serveur du compte testé (`web/src/demo/fake-compte.test.ts`, TOTP contre les vecteurs de la RFC 6238).
- **Tests de bout en bout contre le vrai serveur**, comptes activés et faux SMTP local (`web/ui-e2e/compte.spec.ts`), par l'interface réelle :
  - inscription, connexion, mauvais mot de passe ;
  - « Rester connecté » et deux onglets ;
  - mot de passe oublié, changement de mot de passe ;
  - double authentification ;
  - suppression ;
  - « le serveur ne voit rien » (dossier de données et sorties du serveur fouillés : ni adresse, ni mot de passe, ni pseudo, ni clé TOTP).

  Pour l'instant sous Chromium seulement : WebKit est à activer après un premier passage vert en CI.

Ce qui reste à votre charge : les décisions (point 1), l'avis du juriste (point 2) et les comptes chez les fournisseurs (point 4). Le reste est prêt.

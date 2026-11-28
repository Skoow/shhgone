# Point de reprise du travail (28 novembre 2026)

À lire en premier pour reprendre le travail là où il s'est arrêté. Les règles du projet restent dans `CLAUDE.md` ; la spécification dans `docs/conception/specs/`.

## 1. État de `main`

- Dernière version poussée : voir `git log` (référencement et rapidité fusionnés le 28 novembre, après `8849d21`).
- Mise à jour de la préproduction (session sur le serveur) : `git fetch origin puis deploy/preprod.sh <commit complet>` ; le commit complet se lit par `git rev-parse <court>` après le `git fetch`.
- `shares.db` est au schéma 6 : une image d'avant le 28 novembre ne l'ouvre plus (le retour arrière sûr est en cours, § 2.2).
- Prochain numéro de décision libre au registre : **D42-34** (D42-32 et D42-33 sont réservés aux travaux du § 2).

## 2. Travaux en cours, pas encore fusionnés

Ils ont été lancés le 28 novembre dans des copies de travail locales (`git worktree list`). Si la machine a été réinitialisée et qu'elles ont disparu, les refaire à partir des descriptions ci-dessous. Après fusion : tests complets (voir § 5), push, puis donner au propriétaire la commande de mise à jour.

### 2.1 Pages « Mes partages » / « Mes salons », pseudo, fenêtres (D42-33)

1. Deux pages séparées : « Mes partages » (`/envois`, partages de fichiers seulement) et « Mes salons » (salons seulement), chacune dans le menu, la ligne du haut et la barre du bas (lisible à 390 et 320 px).
2. Lignes : « Se termine le 29 nov. (12 h 14) », puis « Terminé le 29 nov. (12 h 14) ». Icône fichier ou salon (rien selon le contenu).
3. Étiquette « En cours » (vert) / « Terminé » (gris).
4. Terminés : « Retirer » un par un, et « Effacer l'historique » en haut (confirmation), qui garde les actifs.
5. Sous-titre « Les partages que vous avez envoyés » ; « Supprimer le partage » = détruit pour tout le monde ; « Retirer de la liste » = seulement de la liste ; « Gérer le salon » = créateur.
6. Pseudo (création de compte et page Compte) : liste de règles interactive (croix rouge / coche verte, mise à jour pendant la saisie : caractères, longueur, disponible ; info « 3 changements par an au plus ») et indicateur dans le champ (carré, coche blanche sur fond vert si valide et libre, spinner pendant la vérification, croix si pris).
7. Fenêtre « Arrêter l'abonnement » : « Votre abonnement {offre} ne sera pas renouvelé. Vous en profitez jusqu'au {date}, puis votre compte repasse en Gratuit. Aucun remboursement possible. »
8. Fenêtre « Supprimer votre compte » : disposition plus claire (liste courte, abonnement mis en évidence, « Aucun remboursement possible. »), sans mention des téléchargements ; « rien n'est remboursé automatiquement » remplacé partout.
9. Page « Téléchargements » (onglet « Fichiers », historique des fichiers reçus) retirée ; base locale effacée au démarrage.
10. Renouvellement arrêté automatiquement : pass sans aucun jeton émis depuis 12 mois (tâche quotidienne du serveur) ; compte banni : arrêt à sa connexion (le serveur ne relie pas compte et pass), et la règle des 12 mois s'applique aussi.

### 2.2 Maintenance, reprise restante, retour arrière (D42-32)

1. `deploy/maintenance.sh annoncer <date-heure> <durée>` / `annuler` / `etat` : bandeau sur le site ; 10 min avant, nouvelles créations refusées (503 `maintenance`, heure de retour), ce qui est en cours continue ; état qui survit au redémarrage ; dans `etat.sh` et l'e-mail du lundi ; procédure de redémarrage pas à pas dans `deploy/README.md` (annoncer, `reboot`, déverrouiller LUKS par SSH, `etat.sh`).
2. Reprise après redémarrage encore à faire : pièces de salon en cours d'envoi ; étapes d'inscription (pas de passkey orpheline) ; lien session ↔ passkey. Corriger aussi `deploy/README.md` « Sortie par partage » et le texte `salon.intro.2`.
3. Retour arrière sûr : copie cohérente des bases avant toute mise à jour qui change un `user_version`, restaurée en cas de retour arrière.

### 2.3 Référencement et rapidité — fusionné le 28 novembre

Fait : référencement complet (aperçus de lien Open Graph locaux, JSON-LD sans donnée personnelle, `X-Robots-Tag: noindex` côté serveur, redirection des barres obliques finales) ; premier affichage mobile de l'accueil 3,75 s → 2,10 s. Restes à décider :
- titre de l'accueil sans mot-clé recherché (proposition « Shhgone · Partage chiffré de bout en bout, sans compte ») ;
- décalage d'affichage de l'accueil anglais sur téléphone (boutons « Photo or video » pendant la police de secours) ;
- poids JS de l'accueil (≈ 612 Ko non compressés, dont salon et compte) : leur donner leurs propres pages HTML (chantier) ;
- `/salon` pourrait être écrite au build et indexée à l'ouverture ;
- spec UI §12.5 assouplie (balises `og:*` sur les pages publiques) : à confirmer.
Tests Playwright dont le texte attendu ne correspond plus au contenu : `pages.spec.ts:83`, `home.spec.ts:178` (K8) ; échecs non analysés lors d'une série complète : audit-1111, drop, no-preview, send 429, appel, salon4 — à passer en revue.

Audit SEO initial (titres, descriptions, `hreflang`, `canonical`, `noindex` des écrans d'application, sitemap, `robots.txt`, Open Graph, JSON-LD sans donnée personnelle, préproduction non indexée) et mesures Lighthouse avant/après (mobile et ordinateur) avec améliorations (poids JS, chargement différé du moteur, images, police, compression, cache en production seulement ; préproduction gardée en `no-store`). Liste de ce que le propriétaire fera à l'ouverture (Search Console et Bing par enregistrement DNS TXT, sitemap).

### 2.4 À lancer ensuite : noms, images et rangement des partages et des salons (demande du 28 novembre)

Demande du propriétaire :
- Nommer un partage de fichiers ou un salon (facultatif) à la création, ou après coup dans « Mes partages » / « Mes salons » (petit crayon), par son créateur. Exemples : « Entre amis », « Projet privé », « Carrosserie ».
- Le nom se met à jour **pour tous ceux qui sont dans le salon ou le partage**, pour qu'un membre qui a plusieurs salons sache à quoi chacun correspond.
- Plus tard : une image (logo) par salon, l'ordre des salons modifiable (épingler en premier), une couleur par salon (contour de la carte) pour le repérer d'un coup d'œil.

Points de conception à trancher avant de coder (proposer au propriétaire) :
1. **Nom et image d'un salon** : le protocole salon v3 n'a pas de nom. Les faire passer **chiffrés de bout en bout** (message applicatif MLS du créateur, gardé dans l'état du groupe), jamais lisibles par le serveur ; mis à jour chez tous les membres ; image ré-encodée sur l'appareil et bornée en taille comme la photo de profil. Les apps (moteur Rust commun) doivent suivre le même format : vecteurs communs.
2. **Nom d'un partage** : il existe déjà (§29.3), chiffré dans le manifeste, posé à la création et vu par le destinataire. Le changer après coup **pour le destinataire** demande une nouveauté (étiquette chiffrée modifiable par le lien de gestion, que le serveur garde sans pouvoir la lire). Le renommer **seulement dans sa propre liste** est simple (coffre local / compte).
3. **Les membres n'ont pas de liste de leurs salons** : « Mes salons » ne liste que ceux qu'on a créés (D42-30, liste `rejoints` vidée). Pour qu'un membre voie ses salons avec leur nom, il faut une liste « salons rejoints » (appareil + coffre du compte), à décider (confidentialité : lien d'invitation gardé, jamais le mot de passe).
4. **Ordre, épingle, couleur** : préférences de chaque personne, gardées sur l'appareil et dans le coffre du compte ; rien sur le serveur.
5. Prochain numéro de décision libre : D42-34.

### 2.5 À lancer ensuite : listes du créateur, du destinataire et du membre (demande du 28 novembre)

Demande du propriétaire :
- **Créateur** (partages et salons) : tout voir dans son compte. Partage : combien de personnes l'ont ouvert, le supprimer en avance. Salon : combien de personnes sont entrées, et y **revenir** d'un clic.
- **Destinataire d'un partage** : une liste « reçus ». Aucune action, sauf : le **dernier** qui ouvre peut le supprimer une fois ses fichiers récupérés (existe déjà, D42-22) ; les autres peuvent le **retirer de leur liste** une fois fini.
- **Membre d'un salon** : il retrouve le salon dans « Mes salons » et **y revient d'un clic** pendant toute sa durée (ex. salon de 7 jours, parti après 1 h), sans qu'on lui renvoie le lien. Le mot de passe du salon reste exigé à la première entrée. **Avec un compte**, on se souvient de lui : pas de mot de passe à retaper. **Sans compte** : trouver un moyen sûr de ne pas le retaper.

Conception proposée (à valider avec le propriétaire avant de coder) :
1. **Comptage, pas identité** : le créateur voit le **nombre** d'ouvertures et de membres, jamais qui (le service est anonyme ; le serveur ne connaît pas les personnes). Ouvertures : déjà connues par le lien de gestion. Membres d'un salon : nombre de sièges occupés, lisible par le créateur.
2. **Retour au salon** : le serveur garde déjà la place de chaque membre et son jeton (persistance continue, D42-31) ; le site sait déjà reprendre une place avec son jeton. Il manque seulement de **garder ce jeton et le lien d'invitation** dans la liste du membre.
3. **Avec compte** : ce secret de retour est gardé dans le **coffre privé chiffré** du compte (comme « Mes partages », D42-30), sur tous ses appareils ; jamais le mot de passe en clair, rien de lisible par le serveur.
4. **Sans compte** : le garder sur l'appareil, chiffré par une **clé non extractible** du navigateur (comme la session « Rester connecté »), avec un choix explicite « Se souvenir de ce salon sur cet appareil ». Le serveur n'y gagne rien. Limite à dire honnêtement : quelqu'un qui utilise l'appareil déverrouillé peut rentrer dans le salon ; effacer les données du site l'oublie. C'est faisable et sûr dans ces limites.
5. **Listes « reçus » et « salons rejoints »** : elles avaient été retirées (D42-27, liste `rejoints` vidée en D42-30) ; les rétablir, simplifiées, avec ces seules actions. Confidentialité : lien gardé chiffré, jamais le mot de passe.
6. À combiner avec le § 2.4 (noms, images, ordre, couleurs). Prochain numéro de décision libre : D42-34.

## 3. Décisions déjà prises (rappel)

- Mot de passe des partages facultatif, désactivé par défaut (D42-28). Anti-robot ALTCHA partout, chemin de passkey retenu sur ordinateur (D42-29). « Mes partages » automatique, lien de gestion retiré de « Lien prêt » (D42-30). Rien perdu au redémarrage (D42-31).
- Comptes sur mesure retirés (26 novembre) ; accès offerts Pro nommés gardés.
- Supprimer le compte = arrêter le renouvellement, révoquer le pass, supprimer le compte, effacer l'appareil ; échec → rien supprimé.
- Un seul e-mail de bilan le lundi ; alerte SSH immédiate ; contrôle d'intégrité chaque nuit.
- Pas de second serveur de préproduction pour l'instant (plus tard, environ 5 à 7 € par mois).

## 4. À faire ou à décider plus tard

### Par le propriétaire

- Double authentification (passkey de préférence) sur GitHub, OVH et les boîtes mail ; verrouillage du domaine chez OVH.
- Sauvegarde hors du serveur (Scaleway) : le plus gros risque de perte aujourd'hui (panne disque).
- Copie hors ligne de `shh_comptes_cle`.
- Jeton GitHub en lecture seule pour l'e-mail du lundi (`deploy/README.md`, puis `sudo deploy/secret.sh alerte_github_jeton`).
- Garder les e-mails « Intégrité : base refaite » (copie hors du serveur).
- Plus tard : clé SSH sur clé physique (YubiKey) ; second serveur de préproduction.
- Avant les ventes : clés de test Stripe, PayPal, NOWPayments (`deploy/secret.sh`), puis appels (ports TURN) ; accès au tableau de bord (`deploy/admin-jeton.sh`).
- Ouverture au public au moins 30 jours après l'achat du domaine ; étiquette `web-v1.0.0` (poussée par le propriétaire) ; paquet GHCR public ; retirer les branches de préproduction des workflows ; retirer l'accès `sudo` de développement.

### À faire valider par un juriste (`docs/juridique/avant-la-vente.md`)

- « Aucun remboursement possible » : juste pour un changement d'avis (renonciation à la rétractation, DP-10), mais n'exclut pas les garanties légales.
- Droit d'accès et de portabilité sans « Exporter mes données » (route `GET /api/compte/export` sans client).
- Arrêt automatique du renouvellement (12 mois sans usage, compte banni) à écrire dans les conditions de vente.

### Points techniques ouverts

- Test Playwright instable : `ui-e2e/salon.spec.ts` (album de 2 photos), déjà avant le 26 novembre.
- `pseudo/libre` (invités d'un salon) sans anti-robot, limité à 30 par heure.
- Étape « Vérification anti-robot » encore affichée dans la progression de l'envoi : ne la montrer qu'en cas d'attente.
- Suppression du compte et arrêt de l'abonnement : les requêtes du pass et du compte se suivent de près (corrélation possible en direct, rien n'est gardé ; écrit dans Confidentialité).
- Champ `langue` du coffre de profil (gardé pour l'instant) ; règle de contenu sur « ni e-mail ».
- En fin de projet : réécriture de l'historique et clé du propriétaire V4 ; retirer `CLAUDE.md` du dépôt public.

## 5. Façon de travailler

- Tout sur `main`, tests au vert avant chaque push ; commits `git commit --author="Skoow <190851638+Skoow@users.noreply.github.com>"`, sans ligne d'attribution ; fusion des travaux parallèles par `cherry-pick`, jamais de commit de fusion.
- Tests : `cd web && TMPDIR=/dev/shm npx vitest run src scripts --maxWorkers=2` ; `npx svelte-check --fail-on-warnings` ; `cd server && go test ./... && go vet ./... && gofmt -l .` ; e2e `cd web && npx vitest run e2e/<fichier> --testTimeout=120000 --hookTimeout=120000` (après `cd server && go build -o shhdrop ./cmd/shhdrop`) ; Playwright `PW_LOCAL_CHROMIUM=1 npx playwright test <spec> --trace off` ; `make lint-deploy` (ShellCheck 0.11.0) ; actionlint `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`.
- Quelques tests mesurent une durée (`password.test.ts`, `media/hostile.test.ts`) : sous forte charge, les relancer seuls avant de conclure.
- Disque de la machine de développement serré : `TMPDIR=/dev/shm` pour les builds et tests ; nettoyer `go clean -cache` et les copies de travail terminées.
- Le propriétaire ne tape un secret que dans sa propre fenêtre SSH, en saisie masquée ; aucun secret dans une conversation.

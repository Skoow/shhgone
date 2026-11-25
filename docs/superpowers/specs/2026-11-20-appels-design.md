# Appels audio et vidéo du salon : conception

20 novembre 2026. Demande du propriétaire : « fais la voix et la vidéo », à plusieurs. Complète la spécification du salon v3 §8 (`2026-11-11-salon-v3-design.md`), qui posait les contraintes et renvoyait à ce document.

**État.** Codé et testé (moteur, serveur, site, relais). Sans rien à installer (décision du propriétaire, 21 novembre : « il ne faut pas que les utilisateurs aient quoi que ce soit à installer, il faut que cela marche directement ») : le relais TURN fait partie de notre image et `deploy.sh` le met en place (`deploy/README.md` §14). ~~Ouvert à tous les salons, sans offre payante (même décision).~~ **Réservé aux offres Plus et Pro depuis le 24 novembre** (décision du propriétaire) : §5.1. **Conséquence : tant que le paiement est fermé (`SHH_PAIEMENT=0`, la production actuelle), le serveur ne propose aucun appel** (ni route, ni boutons) et le relais reste inutilisé.

## 1. Ce que fait la fonction

- Dans un salon, deux boutons : « Appel audio » et « Appel vidéo ». Un seul appel par salon à la fois.
- Les autres membres voient « Appel en cours (n) » et peuvent le rejoindre, avec ou sans caméra.
- Jusqu'à **6 participants**. Chacun peut couper son micro, allumer ou éteindre sa caméra, raccrocher. L'appel continue tant qu'il reste quelqu'un.
- La conversation écrite reste utilisable pendant l'appel.
- Rien n'est enregistré, nulle part.

## 2. Choix d'architecture

| Sujet | Choix | Raison |
|---|---|---|
| Transport | WebRTC, **maillage** : une connexion par paire de participants | Aucun serveur de média à écrire ni à exploiter ; suffisant jusqu'à 6 |
| Chemin du média | **Toujours par notre relais TURN** (`iceTransportPolicy: "relay"`) | Un appel direct montrerait l'adresse IP de chacun aux autres (spec §39.3.1, salon v3 §8) |
| Chiffrement | **DTLS-SRTP** de bout en bout entre les deux navigateurs d'une paire | C'est celui de WebRTC : aucune crypto à nous |
| Authentification | L'empreinte DTLS de chacun voyage dans l'offre et la réponse, qui sont des **messages du salon chiffrés et signés par MLS** | Un intermédiaire (relais, serveur) ne peut pas substituer sa propre empreinte |
| Signalisation | Messages volatils du salon (`appel_present`, `appel_fin`, `appel_signal`) | Le serveur ne voit pas qui appelle qui ; rien n'est écrit sur disque |
| Relais | `shhcheck turn` dans notre image (bibliothèque pion/turn v4.1.4, épinglée), identifiants temporaires | Rien à installer ni à épingler en plus ; même image que le serveur ; le serveur Go ne relaie rien |

### 2.1 Écart avec la spécification du salon v3 §8 (à valider par le propriétaire)

La v3 §8 écrivait : « chiffrés de bout en bout par SFrame (RFC 9605), avec une clé tirée de l'exporteur MLS ». **Ce document ne l'applique pas**, pour cette raison :

- SFrame sert quand un serveur de média (SFU) termine le DTLS : il faut alors une seconde couche de chiffrement. En maillage, le DTLS va d'un participant à l'autre et le relais TURN ne le termine pas : le média est déjà chiffré de bout en bout.
- L'ajouter demanderait une bibliothèque SFrame de plus (revue de chaîne d'approvisionnement), un Worker par flux et une API (`RTCRtpScriptTransform`) absente de certains navigateurs, sans gain de sécurité dans ce montage.
- `exporterSframe` reste dans le moteur, prêt pour le jour où un SFU remplacerait le maillage (plus de 6 participants).

**Conséquence à connaître :** la sécurité de l'appel repose sur l'authenticité des messages du salon. Qui est membre du groupe MLS peut appeler ; qui n'en est pas ne peut ni lire la signalisation ni se faire passer pour un membre.

## 3. Messages (moteur, `engine/salon/src/message.rs`)

Trois sortes, toutes **volatiles** (relayées, jamais rangées) :

| Sorte | Champs (JSON) | Sens |
|---|---|---|
| `appel_present` | `c` (identifiant de l'appel, 16 octets), `video` (booléen) | « Je suis dans cet appel », à l'entrée puis toutes les 15 s |
| `appel_fin` | `c` | « Je quitte cet appel » |
| `appel_signal` | `c`, `pour` (siège, 0 à 254), `s` (`offre`, `reponse`, `glace`), `i`, `n`, `x` | Morceau `i` sur `n` d'une offre ou d'une réponse SDP (8 morceaux au plus), ou un candidat ICE (`n` = 1) |

Règles du moteur : `x` de 1 à 3 600 octets, ASCII imprimable et fins de ligne seulement ; `i` < `n` ; champs en trop refusés. Vecteurs communs : `engine/vectors/salon-v3.json` (21 cas « appel »), rejoués par le site.

Les apps natives utiliseront les mêmes messages : WebRTC existe sur iOS et Android (bibliothèque du système ou `flutter_webrtc`). Rien ici ne dépend du navigateur.

## 4. Déroulement (site, `web/src/salon/appel.ts`)

1. **Entrer.** Le micro (et la caméra) sont demandés, puis les identifiants du relais (`POST /api/salons/appel`, d'abord sans jeton ; sur 402 seulement, avec un jeton anonyme : §5.1). Sans l'un des deux : pas d'appel, rien ne reste allumé. **Lancer** un appel (aucun appel en cours) sans pass payé sur l'appareil : ni micro ni requête, l'écran explique « Réservé aux offres Plus et Pro » avec un lien vers `/offres` (ouvert dans un autre onglet, le salon reste ouvert).
2. **Se dire présent.** `appel_present` part aussitôt, puis toutes les 15 s. Un participant muet 40 s est retiré.
3. **Se connecter.** Entre deux sièges, **le plus petit numéro propose**, l'autre répond : jamais deux offres croisées. Une offre venue d'un siège plus grand est ignorée.
4. **Deux appels lancés en même temps.** Le plus petit identifiant l'emporte ; l'autre s'y rallie.
5. **Connexion perdue.** Le plus petit siège repropose : trois fois vite, puis à chaque présence redite.
6. **Départ ou exclusion du salon.** La connexion d'appel de ce siège est fermée aussitôt, sans attendre.
7. **Raccrocher.** `appel_fin`, connexions fermées, micro et caméra arrêtés.

Défense en profondeur sur les adresses IP : tout candidat qui n'est pas « relay » est jeté, à l'envoi comme à la réception, dans le SDP comme en candidat seul, même si le navigateur respecte déjà la politique « relais seulement ».

**Ajouts du 21 novembre** (aucun changement de message, de serveur ni de relais) :

- **Qui parle** : la tuile de qui parle s'allume. Le niveau du son déjà reçu (ou capté, pour soi) est mesuré dans le navigateur, 10 fois par seconde (`web/src/salon/parole.ts`) ; rien n'est envoyé ni gardé.
- **Caméra de face ou de dos** : bouton affiché quand l'appareil a plusieurs caméras. La nouvelle image est obtenue avant d'arrêter l'ancienne ; refusée ou absente, rien ne change. Image de face en miroir pour soi seulement.
- **Écran gardé allumé** pendant l'appel (Screen Wake Lock, repris au retour sur l'onglet).
- **Micro ou caméra arrêtés d'eux-mêmes** (débranchés, autorisation retirée, pris par une autre application) : sans micro, on quitte l'appel en le disant (`appel_fin`) et un message l'explique ; sans caméra, l'appel continue en audio et les autres le voient.
- **Onglet fermé** : on raccroche en le disant (`pagehide`), au lieu de laisser les autres attendre 40 s.

Apps natives : les mêmes comportements existent dans les API du système (niveau audio, choix de caméra, écran allumé) ; rien à changer au protocole.

**Partage d'écran : retiré le 25 novembre.** Un bouton « Partager l'écran » (`getDisplayMedia`) avait été codé sans figurer dans cette conception, et l'en-tête `Permissions-Policy` du site refuse `display-capture` (audit F3 : un script injecté ne doit pas pouvoir capturer l'écran) : le bouton ne pouvait qu'échouer. Le rouvrir demanderait une décision du propriétaire, puis `display-capture=(self)` et cette section.

Débit : vidéo 640 × 360, 24 images par seconde, 500 kbit/s au plus vers chaque participant. File d'envoi de la signalisation cadencée sous la limite du serveur pour les trames volatiles.

## 5. Serveur (`server/internal/api/handlers_salon_appel.go`)

- `POST /api/salons/appel` (en-tête `X-Shh-Membre`, corps `{}`, et facultatif `Authorization: PrivateToken token=<jeton>`) → `{urls, username, credential, ttl_s}`. Route absente sans relais configuré **ou sans paiement** (§5.1).
- Identifiants temporaires TURN (« REST ») : nom = `<échéance>:<16 octets aléatoires>`, mot de passe = `base64(HMAC-SHA1(secret, nom))`. Le nom ne désigne ni salon, ni siège, ni compte. Valables 6 heures au plus, **jamais au-delà de la fermeture des appels du salon** (donc de sa fin ; un renouvellement qui raccourcit le salon raccourcit aussi les identifiants donnés ensuite, `finAppelsLocked`, corrigé le 25 novembre). 20 demandes par heure et par membre (comptées avant toute dépense de jeton).
- `rejoindre` répond `calls: true` quand le relais **et** les jetons anonymes (paiement ouvert) sont configurés : le site n'affiche les boutons que dans ce cas.

### 5.1 Appels réservés aux offres Plus et Pro (décision du propriétaire, 24 novembre)

**Règle.** Les appels d'un salon sont **fermés** à sa création. Un membre qui a Plus ou Pro les **ouvre** en présentant un jeton anonyme (Privacy Pass, RFC 9578 type 2, le même que pour les partages payants : conception du paiement §7) sur `POST /api/salons/appel` ; le jeton est dépensé et les appels restent ouverts **pour tous les membres du salon, jusqu'à sa fin**. Appels déjà ouverts : aucun jeton n'est lu ni dépensé.

| Cas | Réponse |
|---|---|
| Appels ouverts | 200, identifiants jusqu'à min(6 h, fermeture) |
| Fermés, sans `Authorization` | **402 `offre_requise`** |
| Fermés, jeton valable d'une offre avec `appel_audio` | jeton dépensé, appels ouverts jusqu'à la fin du salon, 200 |
| Jeton mal formé, faux, déjà dépensé, ou offre sans le droit | 400 `bad_request` (jeton rendu dans le dernier cas) |
| Deux membres ouvrent en même temps | le premier ouvre ; le jeton du second est rendu (`Rendre`), il resert |
| Membre inconnu, corps faux, limite atteinte | 404, 400, 429 avant toute dépense |

**Ce que garde le serveur** : l'heure de fin des appels du salon, **en mémoire seulement** (`salon.appelsJusqua`, `server/internal/salon/appels.go`) : ni le jeton (seule son empreinte, dans `depenses` de `paiements.db`, comme pour un partage, purgée après deux jours), ni l'offre, ni le siège qui l'a ouvert. Perdue au redémarrage du serveur : le prochain qui lance un appel avec une offre les rouvre (les identifiants déjà donnés restent valables jusqu'à leur échéance). Un renouvellement du salon ne les prolonge pas : ils se ferment à la fin prévue au moment de l'ouverture.

**Choix, et pourquoi.**

1. **Qui doit avoir le droit : la personne qui lance l'appel, une fois pour le salon.** Pas chaque participant : un appel se fait à plusieurs, et la règle de §38.1 de la spécification (« le destinataire ne voit jamais l'offre », jamais besoin de compte pour recevoir) vaut ici : qui rejoint n'a besoin de rien. Pas le créateur du salon seulement : (a) les salons payants (jeton dépensé à la création, conception du paiement §11) ne sont pas codés ; (b) la création d'un salon exige une session de compte, et un jeton dépensé dans la même requête relierait au compte le fait d'avoir payé, à chaque salon ; ici, un membre quelconque peut ouvrir. Le droit est celui **du salon**, jamais d'un pass ni d'un compte (conception du paiement §11 : « les appels liront ce niveau »). Quand les salons payants existeront, un salon créé avec un jeton Plus ou Pro aura ses appels ouverts d'emblée (aucun second jeton).
2. **Audio seul et vidéo : même règle.** Plus et Pro comprennent tous deux `appel_audio` et `appel_video` (décision du 24 novembre, `offres.go`). Le serveur ne voit pas si de l'image passe (média chiffré de bout en bout par DTLS-SRTP, à travers le relais) : une règle par média ne serait pas vérifiable. Le serveur exige donc `appel_audio` ; caméra allumée ou non reste un choix de chaque participant. Si une offre future n'avait que l'audio, il faudrait un autre mécanisme (le site seul ne le garantirait pas).
3. **Paiement fermé : pas d'appels du tout**, plutôt que des boutons qui mèneraient à une offre impossible à acheter (règle d'honnêteté, spécification §38.1 ; conception du paiement §11 : « jamais vendus ni promis comme disponibles » tant qu'on ne peut pas les obtenir). Aucun drapeau de plus : la condition est `relais configuré ET SHH_PAIEMENT=1` (`salonAPI.appels`).

**Site.** Le portefeuille de l'appareil (`web/src/paiement/appel.ts`) dit, **sans requête**, si un pass payé est gardé (état gardé du jour s'il existe : échu, révoqué ou sans le droit ne compte pas). La demande d'identifiants part d'abord sans jeton ; sur 402 seulement, un jeton est pris (d'abord un jeton gardé « mûr », sinon un lot obtenu tout de suite) et la même demande repart avec lui (`web/src/salon/appel-offre.ts`) ; ensuite, réapprovisionnement à une heure tirée au hasard (S16). Sans jeton : « Réservé aux offres Plus et Pro » et le lien vers `/offres`.

**Ce que voit le serveur, en plus** : qu'un siège de ce salon a dépensé, à cette heure, un jeton Plus ou Pro (l'offre se lit à la clé), jamais lequel des pass. **Limites, écrites aussi sur la page Confidentialité** : (a) si c'est le **créateur** qui ouvre, le serveur, qui connaît le compte du créateur, apprend que ce compte a Plus ou Pro (pas quel pass) ; (b) S16 résiduel : sans jeton en réserve, l'émission (qui présente le pass) et la dépense se suivent de quelques secondes et peuvent être rapprochées par l'heure, ce qui relierait ce pass à ce salon ; (c) un jeton ouvre les appels d'un salon de 24 h au plus aujourd'hui : il est pris sur la réserve des partages payants (30 par période pour Plus, 100 pour Pro ; 10 ou 20 émis par jour au plus).

Apps (D42-20) : même route, même jeton, même ordre (sans jeton, puis avec) ; rien de propre au navigateur.
- Configuration : `SHH_TURN_URLS`, `SHH_TURN_SECRET_FILE` (les deux ou aucune ; fichier 0400 ou 0600 hors du dossier de données).

**HMAC-SHA1** est imposé par le protocole TURN (identifiants temporaires « REST ») pour ces identifiants. Ce n'est pas un choix de chiffrement du projet : il ne protège que l'accès au relais. À ajouter aux exceptions écrites de `CLAUDE.md` (décision du propriétaire).

## 6. Ce que chacun voit

| Qui | Voit | Ne voit pas |
|---|---|---|
| Serveur Go | Qu'un membre a demandé des identifiants de relais ; des trames volatiles chiffrées ; qu'un siège de ce salon a dépensé un jeton Plus ou Pro pour ouvrir les appels (§5.1), et l'heure de fin des appels (en mémoire) | Qui appelle qui, le son, l'image, la signalisation ; de quel pass vient le jeton |
| Relais TURN | Les adresses IP des deux bouts, le volume et les horaires, en mémoire | Le son, l'image, le salon, l'identité |
| Autres participants | Votre son et votre image ; l'adresse du relais | Votre adresse IP |
| Disque | Rien | |

## 7. Relais (`deploy/shhcheck/turn.go`)

- Écoute UDP et TCP sur 3478, réseau de la machine ; ports relayés 49160 à 49999 (UDP).
- Adresse publique : `SHH_TURN_IP`, sinon celle de la route par défaut ; une adresse détectée privée est refusée (machine derrière un routeur), avec un message qui dit quoi faire.
- Destinations : adresses publiques seulement ; la machine elle-même seulement sur sa plage relayée (un participant joint l'autre par son allocation). Jamais d'adresse privée, de boucle locale, de réseau interne Docker ni d'autre service de la machine.
- Bornes : 60 allocations simultanées, 2,5 Mbit/s par allocation (paquets au-delà jetés) ; réglables.
- Aucun journal : le journaliseur de la bibliothèque est coupé ; conteneur sans journal.
- Tests : `deploy/shhcheck/turn_test.go` (vrai client TURN : relais entre deux allocations, destinations interdites, débit, plafond, identifiants faux ou échus) et `web/ui-e2e/appel.spec.ts` (trois navigateurs, ce même relais).

## 8. Risques et points ouverts

| Gravité | Sujet | État |
|---|---|---|
| Moyenne | **Bande passante.** Un appel vidéo à 6 demande environ 15 Mbit/s au relais dans chaque sens | Plafond par défaut environ 150 Mbit/s (réglable) ; à surveiller avec l'usage |
| Moyenne | **Réseaux qui bloquent l'UDP et le port 3478** (certaines entreprises) : l'appel échoue | TURN sur TCP 3478 prévu ; TURN sur TLS 443 demanderait de partager le port de Caddy : pas fait |
| Faible | **Identifiants non révocables.** Un membre exclu garde l'accès au relais jusqu'à 6 heures | Il n'y gagne qu'un relais bridé, sans accès au salon ni aux appels |
| Faible | **Métadonnées.** Le relais sait qu'une adresse IP a été en appel, et quand | Inévitable avec un relais ; rien n'est gardé |
| Faible | **Appel de plus de 6 heures** coupé à l'échéance des identifiants | Rappeler |
| Faible | **Safari** : non testé (les tests utilisent le micro et la caméra factices de Chromium) | À essayer sur un vrai iPhone |
| Faible | **Cadre légal** d'un service d'appels (v3 §8) | Avis du juriste, comme pour le salon |
| **Élevée, exploitation** | **Paiement fermé (`SHH_PAIEMENT=0`) : aucun appel possible** (§5.1, 24 novembre) ; le relais tourne pour rien | Voulu (règle d'honnêteté) ; ouvrir le paiement, ou ne pas déployer le relais d'ici là |
| Moyenne, confidentialité | **Créateur qui ouvre les appels** : le serveur relie son compte au fait d'avoir Plus ou Pro (en mémoire, le temps de la requête) | Écrit sur la page Confidentialité ; correction possible : ne jamais présenter le jeton depuis le siège 0 (un autre membre ouvre), au prix d'un appel impossible au créateur seul |
| Moyenne, confidentialité | **S16 résiduel** : sans jeton en réserve, émission (avec le pass) puis dépense à quelques secondes : rapprochement possible du pass et du salon par l'heure | Écrit ; le réapprovisionnement à heure tirée au hasard réduit les cas suivants |
| Faible, exploitation | **Redémarrage du serveur** : les appels ouverts se referment (état en mémoire) ; un nouveau jeton est demandé au prochain lancement | Rare ; garder l'heure de fin dans `salons.db` si cela gêne (une colonne, sans identifiant) |
| Faible, économie | Un jeton par salon ouvert, pris sur la réserve des partages payants (30 par période pour Plus) | À valider par le propriétaire (réserve à part pour les appels si besoin) |

## 9. Preuves


- Moteur : `cargo test -p shhdrop-salon` ; vecteurs régénérés.
- Serveur : `go test ./...` (`salon_appel_test.go` : sans relais, sans paiement, 402 sans jeton, ouverture par un jeton Plus ou Pro pour tout le salon, jeton en trop non dépensé, jetons faux, dépense jamais avant les refus du membre ; `salon/appels_test.go` ; `paiement/offres_test.go`, `TestDroitsAppels` ; `config/appels_test.go`).
- Site : `src/salon/appel.test.ts` (appel à deux, à plusieurs, candidats filtrés, appels simultanés, exclusion, reprise, cadence, erreur « offre »), `src/salon/appel-offre.test.ts` (jeton seulement sur 402), `src/paiement/appel.test.ts` (pass lu sur l'appareil seulement).
- Relais : `go test -race ./...` dans `deploy/shhcheck`.
- De bout en bout : `ui-e2e/appel.spec.ts`, trois navigateurs, vrai serveur (paiement activé), notre relais : B sans offre voit « Réservé aux offres Plus et Pro » sans aucune requête ; A, avec un pass Plus rangé par la vraie page (`ui-e2e/pass-helpers.ts`), lance l'appel (une demande sans jeton, puis une avec) ; B et C rejoignent sans jeton ; image et son reçus, paires de candidats « relay » des deux côtés sur chaque connexion.
- Déploiement : `deploy/test-sortie.sh` (contrôles statiques du service `relais-turn`).

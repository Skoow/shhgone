# Appels audio et vidéo du salon : conception

20 novembre 2026. Demande du propriétaire : « fais la voix et la vidéo », à plusieurs. Complète la spécification du salon v3 §8 (`2026-11-11-salon-v3-design.md`), qui posait les contraintes et renvoyait à ce document.

**État.** Codé et testé (moteur, serveur, site, relais). **Activé par défaut**, sans rien à installer (décision du propriétaire, 21 novembre : « il ne faut pas que les utilisateurs aient quoi que ce soit à installer, il faut que cela marche directement ») : le relais TURN fait partie de notre image et `deploy.sh` le met en place (`deploy/README.md` §14). Ouvert à tous les salons, sans offre payante (même décision).

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

1. **Entrer.** Le micro (et la caméra) sont demandés, puis les identifiants du relais (`POST /api/salons/appel`). Sans l'un des deux : pas d'appel, rien ne reste allumé.
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

Débit : vidéo 640 × 360, 24 images par seconde, 500 kbit/s au plus vers chaque participant. File d'envoi de la signalisation cadencée sous la limite du serveur pour les trames volatiles.

## 5. Serveur (`server/internal/api/handlers_salon_appel.go`)

- `POST /api/salons/appel` (en-tête `X-Shh-Membre`, corps `{}`) → `{urls, username, credential, ttl_s}`. Route absente sans relais configuré.
- Identifiants temporaires TURN (« REST ») : nom = `<échéance>:<16 octets aléatoires>`, mot de passe = `base64(HMAC-SHA1(secret, nom))`. Le nom ne désigne ni salon, ni siège, ni compte. Valables 6 heures. 20 demandes par heure et par membre.
- `rejoindre` répond `calls: true` quand le relais est configuré : le site n'affiche les boutons que dans ce cas.
- Configuration : `SHH_TURN_URLS`, `SHH_TURN_SECRET_FILE` (les deux ou aucune ; fichier 0400 ou 0600 hors du dossier de données).

**HMAC-SHA1** est imposé par le protocole TURN (identifiants temporaires « REST ») pour ces identifiants. Ce n'est pas un choix de chiffrement du projet : il ne protège que l'accès au relais. À ajouter aux exceptions écrites de `CLAUDE.md` (décision du propriétaire).

## 6. Ce que chacun voit

| Qui | Voit | Ne voit pas |
|---|---|---|
| Serveur Go | Qu'un membre a demandé des identifiants de relais ; des trames volatiles chiffrées | Qui appelle qui, le son, l'image, la signalisation |
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

## 9. Preuves


- Moteur : `cargo test -p shhdrop-salon` ; vecteurs régénérés.
- Serveur : `go test ./...` (`salon_appel_test.go`, `config/appels_test.go`).
- Site : `src/salon/appel.test.ts` (11 cas : appel à deux, à plusieurs, candidats filtrés, appels simultanés, exclusion, reprise, cadence).
- Relais : `go test -race ./...` dans `deploy/shhcheck`.
- De bout en bout : `ui-e2e/appel.spec.ts`, trois navigateurs, vrai serveur, notre relais : image et son reçus, paires de candidats « relay » des deux côtés sur chaque connexion.
- Déploiement : `deploy/test-sortie.sh` (contrôles statiques du service `relais-turn`).

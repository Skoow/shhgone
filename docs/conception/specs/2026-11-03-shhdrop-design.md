# Shhdrop — spécification

Produit : **Shhdrop**, servi sur **shhgone.com** (les exemples de lien écrits `https://shhdrop.app/…` désignent l'origine du site, quelle qu'elle soit).
Statut : référence du service ; décrit l'état retenu, codé sauf mention « pas codé » ou « plus tard ».

---

## 0. Lecture de ce document

### Organisation

- **§1 à §19** : le service de partage (périmètre, règles, parcours, architecture, cryptographie, API, données, sécurité, exploitation, droit, limites assumées).
- **§20 à §42** : domaines détaillés, chacun à son numéro (taille et quotas §24, code vérifiable §28, format v2 du partage §29, mot de passe §31, lien §32, historique local §33 (retiré, D42-27), droits du destinataire §34, métadonnées §35, ce que voit le serveur §36, compte §37, offres payantes §38, salon §39, envoi direct §40), puis le **registre des décisions** (§41.0, §42.0).
- **Conceptions séparées**, qui font foi sur leur sujet : interface (`2026-11-04-shhdrop-ui-design.md`, citée « UI §… »), moteur Rust (`2026-11-10-…`), salon v3 (`2026-11-11-salon-v3-design.md`, citée « v3 §… »), compte par passkey (`2026-11-22-compte-passkey-design.md`), paiement (`2026-11-19-paiement-design.md`), appels (`2026-11-20-appels-design.md`), tableau de bord d'administration (`2026-11-13-…`).

### Conventions

- Les **numéros** de section (§…), de décision (D1 à D4, D41-…, D42-…), de question (Q-…) et de signalement (S…, F-…, C…) sont **stables** : le code et les autres documents les citent. Une section remplacée garde son numéro et renvoie à ce qui la remplace.
- Une **décision** se lit dans le registre (§41.0, §42.0) : date, contenu, sections touchées. Le texte des sections donne l'état qui en résulte.
- « Gio », « Mio », « Kio » : puissances de 2 ; « Go » dans les textes affichés désigne les mêmes valeurs.
- L'**exploitant** est la personne qui fait tourner le service (serveur, comptes GitHub, domaine, déclarations).

### Décisions de base

| # | Sujet | État retenu |
|---|---|---|
| D1 | Mode « lecture seule » | Proposé sous le nom « Voir seulement », avec un texte honnête : ce n'est qu'une dissuasion (§34) |
| D2 | Chiffrement au repos du serveur | Tout le dossier de données sur un volume **LUKS2**, déverrouillé à la main après chaque redémarrage de la machine ; base SQLite sans SQLCipher (§22) |
| D3 | Mise en ligne | Script `deploy.sh` lancé à la main (image épinglée par empreinte, provenance vérifiée, §28.7) + mises à jour de sécurité automatiques du système ; le serveur ne va jamais chercher du code seul |
| D4 | Anti-robot | Preuve de travail **ALTCHA** hébergée chez nous, adaptative, sans service tiers (§22, §24) |

---

## 1. En une phrase

Shhdrop est un **site web installable sur téléphone (PWA)** qui permet d'envoyer du **texte, des photos, des vidéos, des messages vocaux et des documents** à une personne, **sans compte**, par un **lien chiffré de bout en bout** protégé par un mot de passe, qui **s'autodétruit** au bout d'un temps choisi ou après un nombre d'ouvertures choisi. Le serveur ne peut jamais lire ce qui est envoyé.

### Pourquoi

Les messageries chiffrent le transport, mais le contenu reste sur les téléphones et dans les sauvegardes (WhatsApp, iCloud…). Avec Shhdrop, il ne reste dans la conversation qu'un **lien mort** : une fois expiré, ouvert ou détruit, il ne mène plus à rien et le contenu n'existe plus sur le serveur.

### Pour qui

Ouvert à tous, sans inscription pour partager. Ouverture publique après les vérifications légales de la section 17.

### Ce qui définit la réussite

1. Le contenu, les noms de fichiers, le mot de passe et la clé du lien sont **invisibles pour le serveur**, prouvé par des tests automatiques (section 14).
2. Un lien expiré, détruit ou épuisé **ne donne plus accès à rien**, et les données sont effacées.
3. Le destinataire peut **lire, écouter, regarder ou télécharger** sur le site, sur iPhone, Android et ordinateur.
4. Le service **tourne seul** au quotidien (nettoyage, HTTPS, mises à jour système, alertes).

---

## 2. Modèle de menaces

| Adversaire | Ce qu'il peut faire | Ce que Shhdrop garantit |
|---|---|---|
| Observateur réseau (Wi-Fi public, FAI) | Voir le trafic | HTTPS obligatoire ; contenu déjà chiffré |
| Proxy d'entreprise / inspection TLS | Voir le chemin du lien (`/s`, §32), pas le `#` ; aucun identifiant dans les adresses de l'API ; s'il déchiffre TLS, il voit aussi les en-têtes (`K_accès`, `S_gestion`) | Sans la clé d'accès, ni infos ni destruction possibles ; aucune adresse ne permet de relier l'envoi à l'ouverture (§29.8) |
| Hébergeur, administrateur du serveur, pirate du serveur | Lire disque, base, mémoire | Contenu, noms, mot de passe et clé jamais présents ; seules des empreintes inexploitables sans le lien |
| Voleur de sauvegarde (WhatsApp, iCloud) qui récupère le lien | Ouvrir le lien | Mot de passe obligatoire, envoyé par un autre canal ; lien mort après usage |
| Voleur du lien **et** de la base | Essayer des mots de passe hors ligne | Argon2id (coûteux) + mots de passe forts par défaut |
| Inconnu qui tape des mots de passe | Deviner en ligne | 5 essais puis destruction ; nécessite déjà la clé d'accès |
| Destinataire malveillant | Copier ce qu'il reçoit | **Non protégé** (limite assumée, section 18) |
| Abuseur (spam, malware, contenus illicites) | Utiliser le service | Limites, quotas, durée maximale de 24 h, signalement, destruction par l'admin |
| Attaquant du code du site (serveur piraté, dépôt GitHub compromis) | Servir un site piégé qui vole les clés | Comptes de l'exploitant protégés (section 15.4), CSP stricte, dépendances minimales et verrouillées, builds reproductibles et versions signées vérifiables (section 28). **Limite résiduelle assumée** (section 18) |
| Saturation (déni de service) | Remplir le disque, épuiser la bande passante | Place réservée et bornée, quotas par connexion, limite de débit, plafond global |

---

## 3. Périmètre

### Dans la V1

- Partage jusqu'à 200 éléments pour toutes les formules (D41-17) : texte, fichiers, photo prise sur place, vocal enregistré sur place.
- Chiffrement de bout en bout dans le navigateur, mot de passe obligatoire et toujours généré (§31).
- Lien de partage + lien de gestion privé pour l'expéditeur.
- Destinataire : compte à rebours, déverrouillage, lecture sur le site (image, audio, vidéo, texte, PDF), téléchargement, destruction, signalement.
- Fin de vie automatique (temps, ouvertures, 5 mots de passe faux, destruction, signalement).
- Limites par connexion et quotas de stockage.
- PWA installable (sans mode hors ligne), français et anglais, clair et sombre, accessible.
- Serveur autonome au quotidien, commandes d'administration, alertes simples.
- Pages : accueil, comment ça marche / sécurité, mentions légales, confidentialité, CGU, contact et signalement, `security.txt`.

### Plus tard

- Spécifiés à part : salon de discussion éphémère chiffré (§39, salon v3) ; compte facultatif (§37) ; offres payantes (§38). Envoi direct pair à pair : **plus tard et optionnel**, jamais par défaut (§40, §41.3).
- Adresse Tor (.onion) · apps iOS et Android natives (D42-20, section 16) · partage depuis la galerie Android (exigerait un stockage en clair sur le téléphone) · aperçu Word/Excel · lecture vidéo pendant le téléchargement · autres langues · audit externe (obligatoire avant ouverture large).

### Jamais

- Compte **obligatoire** pour envoyer ou recevoir (le compte de §37 est facultatif et sert au salon et à la synchronisation), carnet de contacts · publicité, analytics, traceurs, ressources tierces, sans exception · tout mécanisme permettant au serveur de lire un contenu.
- **Aucune statistique** (§35.1) : ni mesure d'audience, ni télémétrie, ni service de rapport d'erreurs (Sentry et semblables), ni statistiques ou compteurs côté serveur autres que les compteurs d'exploitation et les agrégats d'usage en mémoire listés en §9.5. Rien n'est agrégé par personne, par connexion ou par partage au-delà de ce que les règles de la §4 exigent, et rien de cela n'est écrit sur disque.

---

## 4. Règles et limites

| Règle | Valeur (gratuit) |
|---|---|
| Éléments par partage | **200** au plus, pour toutes les formules (D41-17, §41.13) |
| Taille par partage | **2 Gio** de contenu utile (§41.2) ; plus grand palier gratuit de 32 769 morceaux de 64 Kio (2 Gio de données + le morceau du manifeste), fichier chiffré de 48 + 32 769 × 65 552 = 2 148 073 536 octets (§29.3) |
| Durée de vie | au choix 1 h, 6 h, 12 h, 24 h ; comptée **à partir de la fin de l'envoi** ; expiration arrondie au **quart d'heure supérieur**. Plus et Pro (§38.9.1, pas codé) : le compte à rebours pourra démarrer à la **première ouverture**, avec un plafond absolu de 7 jours après la création. À l'échéance, aucune nouvelle ouverture ; un téléchargement commencé peut se terminer pendant 2 h au plus (§41.8) |
| Ouvertures | au choix **1 à 5** (`share.MaxOpens`, `MAX_OPENS` ; Plus 10, Pro 20, §38.8.1) ; **une ouverture = un déverrouillage réussi** ; recharger la page, ou ouvrir le partage dans plusieurs onglets du même navigateur après un déverrouillage réussi, ne compte **pas** une ouverture de plus jusqu'à l'échéance, y compris en revenant plus tard depuis le même navigateur (§41.4, D42-22) ; un autre navigateur ou appareil, ou un octroi refusé, en consomme une (impossible quand toutes sont prises) |
| Fin de vie | le premier atteint : durée, ouvertures épuisées, destruction (expéditeur, dernier destinataire, administrateur), signalements (§7.6), 5 mots de passe faux |
| Mot de passe | toujours **généré** : 11 caractères, exactement 3 caractères spéciaux (§31) ; aucune saisie à la création (D41-15) |
| Essais de mot de passe | 5 ratés → destruction |
| Création de partages | Gratuit : 3 par jour par connexion (IPv4, ou bloc IPv6 /64) ; 10 par jour par bloc /48. Plus et Pro : 30 et 100 liens par pass (§38.8.1). 6 Gio utiles par jour par connexion et 12 Gio par bloc /48 (§24, §41.2) |
| Limite de débit | 60 requêtes par minute par connexion sur les routes publiques ; les envois et téléchargements de segments porteurs d'un jeton valide ont leur propre limite, 600 par minute par connexion et 6 000 par bloc /48 (§24) ; un segment au jeton invalide compte dans les 60 |
| Transferts de segments | au plus 16 téléchargements simultanés par connexion, 64 par /48 et 256 au total ; envois : 8, 32 et 64 ; au-delà 429 (connexion, /48) ou 503 (serveur), avec `Retry-After` ; une ouverture lit au plus 2 × le fichier chiffré de son palier + 2 segments 0, puis 429 `budget` (§24) ; un partage sert au plus `SHH_SHARE_EGRESS_MAX` octets (250 Gio par défaut), toutes ouvertures confondues, puis 403 `egress_limit` (§38.6) |
| Stockage total | plafond configurable (`SHH_STORAGE_MAX`, 200 Gio par défaut), **réservé à la création** ; au-delà, nouveaux envois refusés |

Les offres payantes facultatives ont leurs propres limites (§38.8.1) et une réserve de stockage séparée (§38.6) ; les limites ci-dessus restent celles du gratuit, pour toujours.

---

## 5. Parcours

### 5.1 Expéditeur

1. **Composer** : fichiers, photo, vocal, texte ; aperçu, ✕ pour retirer, jauge « 340 Mo / 2 Go · 3 / 200 ».
   - Nettoyage des métadonnées à la demande, fichier par fichier ou « Tout nettoyer » (§35.2), avec un état honnête par élément ; « Nettoyé » seulement quand le nettoyage a réussi.
2. **Options** : nom du partage (facultatif, §29.3), durée, nombre d'ouvertures, mot de passe (toujours généré, « Générer un autre », §31).
3. **Envoi** : chiffrement et envoi par segments dès l'ajout de chaque fichier (D41-19, §41.14), progression, reprise automatique si le réseau coupe. La reprise ne fonctionne **que dans le même onglet** : fermer l'onglet abandonne l'envoi, qui compte quand même dans la limite du jour et est effacé au bout de 15 min sans nouveau segment (5 à 20 min s'il n'en a reçu aucun ; 6 h au plus).
4. **Lien prêt**, affiché seulement quand l'envoi est entièrement terminé :
   - lien (Copier, Partager, QR code) ;
   - mot de passe (Copier), avec le rappel : « Envoie-le par un **autre moyen** que le lien. Les deux dans la même messagerie, c'est comme ne pas en mettre » ;
   - lien de gestion (Copier) ;
   - « Ces informations ne seront plus jamais affichées ».
5. **Gestion** (lien privé) : « Ouvert 1 / 3 · Expire dans 4 h 15 », bouton « Détruire maintenant ». Quand le partage n'existe plus, la page affiche « Supprimé », sans pouvoir en donner la raison.

### 5.2 Destinataire

1. **Ouverture** : « Quelqu'un vous a envoyé un partage chiffré. Shhdrop ne vérifie pas l'identité de l'expéditeur. »
   - Compte à rebours, champ mot de passe, « Déverrouiller », essais restants affichés en cas d'erreur.
   - Avertissement si la page est ouverte dans le navigateur intégré d'une app (Instagram, Facebook…), qui peut espionner la page : « Ouvrez ce lien dans votre navigateur ».
2. **Contenu** : liste des éléments, lecture sur le site (section 12), téléchargement, bandeau « Disponible encore 5 h 31 · disparaît quand vous quittez la page · recharger ne compte pas une ouverture de plus pendant 30 min », boutons « Détruire maintenant » et « Signaler ».
3. **Lien invalide** : message unique, quelle que soit la raison : « Ce lien n'existe pas ou n'est plus disponible ».

   - **Rechargement (§41.4)** : après un déverrouillage réussi, la page garde dans le `sessionStorage` de l'onglet le secret du lien et un octroi d'ouverture ; recharger redemande le mot de passe mais ne consomme pas une ouverture de plus ; plusieurs onglets du même navigateur s'entendent par `BroadcastChannel`.

### 5.3 Hygiène du lien

Dès que le navigateur a lu la partie secrète (après le `#`), il la **retire de la barre d'adresse** (`history.replaceState`), chez l'expéditeur comme chez le destinataire. **Limite (constatée par `web/ui-e2e/persist.spec.ts`)** : `replaceState` ne change que l'entrée de l'historique **de l'onglet** (`location.href` sans `#`, `history.length` inchangé). Le navigateur a déjà écrit l'adresse complète, `#` compris, au moment de la navigation : Chromium la garde dans `Default/History` (historique global, synchronisé si l'historique l'est), `Favicons`, `Sessions/*` et une base de mesures (`segmentation_platform/ukm_db`). La page ne peut ni l'effacer ni empêcher sa synchronisation : **hors de notre contrôle**. Ce qui reste vrai : le serveur ne reçoit jamais le `#` ; le lien seul n'ouvre rien sans le mot de passe, qui passe par un autre canal ; la barre d'adresse et l'entrée de l'onglet ne le montrent plus. Dit sur l'accueil (« Pourquoi c'est sûr », lien unique).

---

## 6. Architecture

```
Navigateur expéditeur ──(chiffré)──► Caddy ──► Serveur Shhdrop (Go) ──(chiffré)──► Navigateur destinataire
 chiffre localement                 HTTPS      stocke + applique les règles         déchiffre localement
 clés dans le # du lien                         ne voit jamais les clés              clés lues dans le #
```

| Partie | Choix | Raison |
|---|---|---|
| Serveur | **Go**, un binaire statique, sans CGO | Sûr, rapide, build simple |
| Base | **SQLite** via `modernc.org/sqlite` (Go pur), `secure_delete=ON`, WAL vidé dans la seconde qui suit tout effacement (regroupé, au plus une fois par seconde), à chaque passage du janitor, et au démarrage après les purges (stockage F1 à F3) | Un fichier, rien à administrer |
| Fichiers | Un fichier par partage, taille réservée, écriture à position fixe ; derrière une interface interchangeable | Bornage strict ; passage possible à un stockage externe |
| Site | **TypeScript + Svelte + Vite**, PWA sans service worker | Léger ; aucune persistance de code piégé |
| Crypto navigateur | **Partages** : moteur Rust (RustCrypto : HKDF, SHA-256, HMAC, Argon2id) en WebAssembly + **WebCrypto** (AES-256-GCM, nombres aléatoires), D42-21 ; pas de libsodium. **Salon** : second module wasm qui embarque **OpenMLS =0.9.2 sur RustCrypto** (voir la ligne suivante) | Standards reconnus, aucune crypto maison |
| Crypto du salon | **OpenMLS =0.9.2** sur RustCrypto (`openmls_rust_crypto`), dans un second module wasm, avec **son propre AES-GCM RustCrypto** : WebCrypto est asynchrone et les traits d'OpenMLS sont synchrones, un fournisseur WebCrypto est impossible. `chacha20poly1305` pour l'enveloppe des trames ; `postcard` pour le stockage MLS qui efface ses valeurs. Le reste du site garde le moteur des partages (D42-21) | Aucune crypto maison ; voir spec salon v3 §3 |
| PDF | **pdf.js** dans une zone isolée | Lecture des PDF sur le site sans exécuter leur code |
| HTTPS / déploiement | **Docker + Caddy** | Certificats automatiques, portable |
| Hébergement | Serveur dédié en France (§17.1) | Voir sections 15 et 17 |

### Organisation du dépôt

```
shhdrop/
├── server/
│   ├── cmd/shhdrop/        # serveur + commandes admin (freeze, wipe, destroy)
│   └── internal/
│       ├── api/            # routes, en-têtes de sécurité, IP de confiance, limite de débit
│       ├── share/          # règles d'un partage (création, envoi, déverrouillage, fin de vie)
│       ├── token/          # jetons signés (envoi, téléchargement)
│       ├── store/          # SQLite
│       ├── blob/           # fichiers chiffrés (réservation, écriture bornée, effacement)
│       ├── limits/         # quotas et limites par connexion
│       └── janitor/        # nettoyage, réconciliation au démarrage
├── web/src/
│   ├── crypto/             # clés, paquet chiffré, phrase de passe
│   ├── transfer/           # envoi et téléchargement par segments, reprise
│   ├── viewers/            # affichage image/audio/vidéo/texte, PDF isolé
│   ├── media/              # vocal, photo, retrait des métadonnées, noms de fichiers sûrs
│   ├── routes/             # écrans
│   └── i18n/               # fr, en
├── deploy/                 # docker-compose, Caddyfile, deploy.sh, scripts d'alerte
└── docs/
```

Chaque module a une responsabilité unique et des tests propres. `web/src/crypto` ne dépend d'aucun écran ; `server/internal/share` ne dépend pas du HTTP.

---

## 7. Modèle cryptographique

> §7.1 à §7.5 posent les principes et le déroulé (clés, paquet, envoi, ouverture) dans le format v1. **Tout nouveau partage suit le format v2 de la §29** (graine de contenu `R` enveloppée par le lien et le mot de passe, paquet « SHH2 », étiquettes `shhdrop/v2/`, identifiant interne tiré par le serveur) ; les règles de déroulé de §7.4 et §7.5, §7.6 et §7.7 valent pour les deux.

### 7.1 Clés

| Élément | Création | Où il vit |
|---|---|---|
| `K_lien` | 32 octets aléatoires | après le `#` du lien de partage ; jamais envoyé |
| `K_accès` | HKDF(`K_lien`, « shhdrop/v1/acces ») | envoyé au serveur pour lire `meta` et déverrouiller |
| `V_accès` | SHA-256(`K_accès`) | serveur |
| `sel` | 16 octets aléatoires | serveur (renvoyé par `meta`) |
| `K_mdp` | Argon2id(mot de passe, `sel`) : 64 Mio, 3 passes, 1 fil, 32 octets | navigateur |
| `K_maître` | HKDF(`K_lien` ‖ `K_mdp`, « shhdrop/v1/maitre ») | navigateur |
| `K_contenu` | HKDF(`K_maître`, « shhdrop/v1/contenu ») | navigateur |
| `K_preuve` | HKDF(`K_maître`, « shhdrop/v1/preuve ») | envoyé pour déverrouiller et détruire |
| `V_preuve` | SHA-256(`K_preuve`) | serveur |
| `C_engagement` | HMAC-SHA-256(`K_contenu`, « shhdrop/v1/engagement ») | en tête du paquet (en clair) |
| `S_gestion` | 32 octets aléatoires | après le `#` du lien de gestion |
| `V_gestion` | SHA-256(`S_gestion`) | serveur |

- Toutes les étiquettes HKDF et HMAC sont préfixées `shhdrop/v1/` (`acces`, `maitre`, `contenu`, `preuve`, `engagement`) : un changement de version change toutes les clés.
- Le navigateur **refuse** des paramètres Argon2id inférieurs au minimum ci-dessus, même si le serveur les propose.
- Les paramètres visent environ 1 s sur un téléphone d'entrée de gamme ; ils sont versionnés.

### 7.2 Pourquoi c'est solide

- Lire un contenu exige **le lien ET le mot de passe**.
- Sans `K_lien` (256 bits), la base et les fichiers volés ne servent à rien.
- Avec le lien **et** la base, seuls des essais hors ligne contre `V_preuve` restent possibles, ralentis par Argon2id ; d'où les mots de passe forts par défaut.
- En ligne : il faut déjà `K_accès`, puis 5 essais seulement.
- `C_engagement` empêche un serveur malveillant de faire déchiffrer un paquet fabriqué pour plusieurs clés.

### 7.3 Le paquet chiffré

- **En-tête en clair** (48 octets) : « SHH1 », version, `C_engagement`.
- **Contenu chiffré** = longueur du manifeste (4 octets) + **manifeste** + données des éléments + **bourrage de zéros**.
- **Manifeste** (JSON, 64 Kio maximum) : pour chaque élément, type, nom de fichier, type MIME, taille, position ; une note est un élément chiffré comme un fichier, jusqu'à 100 000 caractères (D41-37, §29.3).
- **Morceaux crypto** de 64 Kio, AES-256-GCM avec `K_contenu`, principe STREAM :
  - nonce de 12 octets = numéro du morceau (11 octets) + drapeau « dernier morceau » (1 octet) ;
  - données authentifiées = en-tête ;
  - tout morceau modifié, retiré, déplacé ou ajouté est détecté.
- **Paliers de taille**, en nombre de morceaux : 1, 16, 80, 160, 400, 800, 1 600, 4 000, 8 000, 16 385, 32 769 (de 64 Kio à 2 Gio ; les formules payantes ajoutent 81 921, 163 841, 327 681 et 819 201, §38.8 ; §29.3, §41.2). **Au repos**, le serveur ne connaît que le palier de taille ; **pendant l'envoi**, qui commence dès l'ajout d'un fichier (envoi anticipé, D41-19, §29.7), il voit la taille **à 4 Mio près** (S4, §36). Il ne connaît ni les noms, ni les types, ni le nombre d'éléments, ni la taille exacte.
- **Palier canonique** : à l'ouverture, le navigateur vérifie que le palier annoncé par le serveur est exactement celui que le chiffrement aurait choisi pour le contenu décrit par le manifeste (authentifié) ; sinon, paquet corrompu. Avec la taille exacte de chaque segment et le drapeau « dernier morceau », un serveur ne peut ni tronquer le paquet ni changer son palier.
- **Lecture en flux** : le navigateur ne déchiffre que les morceaux dont il a besoin. Les morceaux jamais lus ne sont pas vérifiés : le bourrage, et les éléments qu'on n'ouvre pas. Tout ce qui est montré ou enregistré est authentifié.
- **Enregistrement interrompu** : `saveItem` écrit au fil du déchiffrement ; si une erreur survient (paquet corrompu, réseau), l'écran doit **abandonner ou supprimer** le fichier partiel (`writable.abort()`) et ne jamais l'annoncer comme terminé.
- **Segments de transport** de 64 morceaux (4 Mio + tags) : un envoi ou un téléchargement par segment. La taille exacte de chaque segment se déduit du palier.

### 7.4 Envoi

1. `POST /api/shares` : durée, ouvertures, palier, `sel`, paramètres KDF, `V_accès`, `V_preuve`, `V_gestion`.
   - Le serveur vérifie les limites, **réserve** la place du palier et répond avec un identifiant (128 bits) et un **jeton d'envoi signé** (valable 6 h jusqu'à 2 Gio, 24 h au-delà, §41.2). `upload_deadline` = maintenant + 6 h (ou 24 h), arrondi au quart d'heure supérieur.
2. `PUT /segments/{n}` : le serveur refuse tout `n` hors palier, toute taille inexacte et tout envoi après finalisation. Il écrit à la position exacte, et renvoyer un segment le remplace (reprise). Chaque segment reçu met à jour `progress_at` (minute du dernier segment, §9.1). Le navigateur chiffre chaque segment juste avant de l'envoyer et renvoie les mêmes octets en cas de nouvel essai : un segment n'est jamais rechiffré à partir du fichier.
3. `POST /finalize` : tous les segments sont présents → état `ready`, et `expires_at` = maintenant + durée, arrondi au quart d'heure supérieur.
4. Un envoi non finalisé à `upload_deadline` (6 h au plus, 24 h pour les paliers payants) est effacé et sa place libérée. Un envoi qui n'a reçu **aucun segment** est effacé dès `upload_deadline` − 5 h 55 (− 23 h 55 pour 24 h) (5 à 20 min après la création selon l'arrondi) : une réservation vide ne bloque pas l'espace. La date de création n'est pas stockée : ce seuil se calcule à partir de l'échéance arrondie. Un envoi **bloqué** (aucun nouveau segment depuis 15 min, d'après `progress_at`) est effacé lui aussi.

### 7.5 Déverrouillage et téléchargement

1. `GET meta` (avec `K_accès`) : secondes restantes avant expiration, `sel`, paramètres KDF. Sans `K_accès` valide : réponse « introuvable », qui ne compte pas comme essai.
2. `POST unlock` (avec `K_accès` et `K_preuve`), traité en une seule requête SQL conditionnelle :
   - **Faux** : `failed_attempts = failed_attempts + 1 WHERE failed_attempts < 5` ; réponse avec les essais restants ; au 5ᵉ, destruction.
   - **Atomicité** : lecture du compteur, comparaison de `K_preuve` et décompte se font sous un verrou par partage (en mémoire, rayé par empreinte de l'`id`), pour `unlock`, la reprise par octroi et `destroy` : même avec 20 essais simultanés, jamais plus de 5 évalués (faux comptés + juste accepté), puis destruction.
   - **Juste** : `opens_left = opens_left - 1, opens_issued = opens_issued + 1 WHERE state='ready' AND opens_left > 0 AND expires_at > now AND failed_attempts < 5`, et passage en `draining` avec `purge_at` = `expires_at` (D42-22) quand `opens_left` atteint 0. Le n° d'ouverture rendu (`opens_issued`) entre dans un **jeton de téléchargement signé**, propre à cette ouverture, valable 6 h et plafonné à `expires_at`. La réponse porte aussi un **octroi d'ouverture** signé (§41.4) (jusqu'à `expires_at`, D42-22), qui permet de rouvrir cette même ouverture sans en consommer une autre ; `unlock` avec un octroi valable ne décrémente rien.
3. `GET /segments/{n}` (avec le jeton) : refusé dès l'expiration du partage ou sa destruction, et pour une ouverture déjà terminée, avec la règle de l'ouverture active (§41.8) : une ouverture qui a reçu un segment dans les 120 s précédentes termine son téléchargement jusqu'à 2 h après l'événement (et jamais au-delà de son jeton) ; aucune ouverture nouvelle ; coupure immédiate pour un signalement, l'administrateur ou l'exclusion d'un salon. Signal `gone` : 410 sur toute requête à jeton valide, et `GET /api/shares/watch`.
4. `POST done` (avec le jeton) : pose le bit de cette ouverture dans `done_mask` (idempotent : un `done` rejoué ne change rien) ; le jeton de cette ouverture ne lit plus aucun segment.
5. Quand `opens_left = 0` (état `draining`), plus aucun déverrouillage n'est possible. Le partage est effacé dès que toutes les ouvertures émises sont terminées (nombre de bits de `done_mask` = `opens_issued`), au plus tard à `purge_at`.

### 7.6 Destruction et signalement

- `POST destroy` avec `K_preuve` (destinataire) ou `S_gestion` (expéditeur), ou `shhdrop admin destroy -` (administrateur, pour un signalement reçu par e-mail ; lien lu sur l'entrée standard, §15.3).
- « Signaler » : une voix (ci-dessous), avec sa catégorie comptée **en mémoire** (agrégats de §9.5, pour les alertes et le tableau de bord).
- Un signalement n'efface pas seul. Chaque ouverture vaut **une voix**, prouvée par `K_preuve` et par l'octroi de l'ouverture (§41.4) envoyé dans le corps (`{"proof","reason":"report","categorie","grant"}`, `grant` obligatoire avec `"report"`, interdit sans) ; la même ouverture ne compte qu'une fois (une voix nouvelle seulement). Le partage est effacé pour tous, sans grâce (flux coupés, §41.8), quand les voix atteignent `max(⌈max_opens / 2⌉, min(2, max_opens))` (`share.ReportsNeeded`) : 1 sur 1, 2 sur 2, 2 sur 3, 3 sur 5 ; un seul destinataire ne peut donc pas effacer le partage d'un autre. Réponse `200 {"detruit": 0|1}` (entier, simple à lire par les apps). Les voix vivent en mémoire seulement (§9.5), perdues au redémarrage comme les octrois, oubliées à la destruction et par le balayage après l'échéance. Un signalement sur un partage déjà fermé aux ouvertures (échu, essais épuisés, détruit) ou encore en envoi (`uploading`) est refusé (404) et ne coupe rien : sinon une seule personne pourrait couper la lecture des autres (§41.8).
- **Destruction simple par un destinataire** (`reason` absent) : corps `{"proof","grant"}`, octroi toujours obligatoire (400 sinon) ; permise au **dernier** destinataire seulement : octroi valide de ce partage, `n = opens_issued` et état `draining`. Un destinataire précédent reçoit `409 still_open`, un octroi faux ou échu `409 grant_invalid`. Sans octroi (lien et mot de passe tapés plus tard), seul l'expéditeur détruit. L'expéditeur (`S_gestion`) et l'administrateur gardent la destruction immédiate. À reprendre tel quel par les apps (moteur commun).
- La destruction invalide immédiatement tous les jetons. On efface d'abord le fichier, puis la ligne en base.

### 7.7 Jetons

- Jeton = HMAC-SHA-256(secret serveur, type ‖ id ‖ n° d'ouverture ‖ expiration).
- Le serveur ne stocke pas les jetons, mais revérifie l'état du partage à chaque usage.
- Le secret est généré au démarrage et gardé en mémoire : un redémarrage invalide les envois et téléchargements en cours (le navigateur l'indique).

---

## 8. API du serveur

Toutes les réponses : JSON, `Cache-Control: no-store`, erreurs uniformes pour « inexistant / expiré / détruit / mauvaise clé d'accès ».

| Route | Rôle | Authentification |
|---|---|---|
| `POST /api/shares` | Création + réservation | limites par connexion |
| `PUT /api/shares/segments/{n}` | Envoi d'un segment | jeton d'envoi |
| `POST /api/shares/finalize` | Activation | jeton d'envoi |
| `GET /api/shares/meta` | Secondes restantes, sel, KDF | `K_accès` (en-tête) |
| `POST /api/shares/unlock` | Déverrouillage | `K_accès` + `K_preuve` |
| `GET /api/shares/segments/{n}` | Téléchargement | jeton de téléchargement |
| `POST /api/shares/done` | Fin de téléchargement | jeton de téléchargement |
| `POST /api/shares/destroy` | Destruction / signalement par le destinataire (motif) | `K_accès` + `K_preuve` |
| `GET /api/manage/status` | Ouvertures, secondes restantes | `S_gestion` (en-tête) |
| `POST /api/manage/destroy` | Destruction par l'expéditeur | `S_gestion` (en-tête) |
| `GET /healthz` | Santé (local uniquement) | — |

- **Aucun identifiant dans les chemins** (§29.8) : le jeton signé désigne le partage, sinon `K_accès` ou `S_gestion`. Les routes du format v2 sont en §29.8 ; celles du compte sous `/api/compte/` (conception du compte par passkey §6.4), du salon sous `/api/salons/` (§39.3.9), du paiement sous `/api/paiement/` (conception du paiement). Un jeton Privacy Pass (`Authorization: PrivateToken`) est accepté sur `POST /api/shares` pour un partage Plus ou Pro (§38.4).
- Les secrets passent dans des **en-têtes ou le corps**, jamais dans l'URL.
- **IP de confiance** : le serveur écoute uniquement en local ; il ne croit que l'en-tête posé par Caddy (`X-Shh-Client-IP`) et ignore tout `X-Forwarded-For` venu du client. L'en-tête n'est cru que d'un pair de confiance : boucle locale, ou réseau listé dans `SHH_TRUSTED_PROXY`. Un test le vérifie.
- **JSON strict** : un corps qui contient une clé en double ou une clé de casse différente (`PROOF`, `pRoOf`) est refusé (400) avant le décodage. Les secrets et identifiants base64url doivent avoir leur longueur exacte en caractères (22 ou 43), sans `\r` ni `\n`. Un tableau de taille fixe doit avoir exactement son nombre d'éléments (audit F7 : `encoding/json` ignorait les éléments en trop et complétait par des zéros).

**Configuration (variables d'environnement, vérifiées au démarrage ; toute erreur arrête le serveur) :**

| Variable | Règle |
|---|---|
| `SHH_DATA_DIR` | obligatoire, **chemin absolu**, sans `?`, `#` ni `%`. Un dossier existant doit être vide (premier démarrage ; le dossier `lost+found` d'un volume ext4 dédié est ignoré) ou contenir `shares.db` **et** `blobs/` ; sinon refus, sans toucher aux droits ni aux fichiers |
| `SHH_LISTEN` | `hôte:port` numérique, par défaut `127.0.0.1:8080`. Hors boucle locale (`127.0.0.0/8`, `::1`, `localhost`), refusé sauf si `SHH_BEHIND_PROXY=1` **et** `SHH_TRUSTED_PROXY` sont donnés (cas Docker du déploiement) |
| `SHH_BEHIND_PROXY` | `0` ou `1`. À `1` : toute requête `/api/` sans `X-Shh-Client-IP` valide, ou venue d'un pair qui n'est pas un proxy de confiance, reçoit 500 ; les fichiers creux sont refusés (voir `SHH_STORAGE_MAX`) |
| `SHH_TRUSTED_PROXY` | liste de CIDR canoniques séparés par des virgules (ex. `172.18.0.0/16`). Acceptés : un sous-réseau (jamais `/0`) d'un réseau local (RFC 1918, `127.0.0.0/8`, `169.254.0.0/16`, `fc00::/7`, `::1`, `fe80::/10`), ou un réseau public d'au moins `/24` en IPv4 et `/48` en IPv6 ; refusés : `/0`, les réseaux publics plus larges, les préfixes NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) et la notation IPv4-dans-IPv6 (`::ffff:a.b.c.d/…`) ; exige `SHH_BEHIND_PROXY=1`. La boucle locale reste toujours de confiance |
| `SHH_STORAGE_MAX` | entier décimal > 0 (chiffres seuls), 200 Gio par défaut. Au démarrage : `SHH_STORAGE_MAX` ≤ espace libre (`statfs`) + place déjà réservée − 1 Gio, sinon refus. Avec `SHH_BEHIND_PROXY=1`, une sonde vérifie que `fallocate` fonctionne ; sans allocation réelle, les créations sont refusées (507) |
| `SHH_STATIC_DIR` | chemin absolu ; le dossier et son `index.html` doivent exister. Vide : page d'attente |
| `SHH_SALONS_MAX` | refusé au démarrage si `SHH_SALONS_MAX` × 256 Kio dépasse 10 % de `GOMEMLIMIT`, ou si la part de trames par salon (§39.3.2) est inférieure à 1 000. Le démarrage est aussi refusé si les fils du disque dépassent la moitié de `pids_limit` |

Les autres variables (salon, compte, paiement, appels) sont décrites avec leur domaine et dans `deploy/README.md`.

- **Délais réseau** : lecture et écriture limitées (protection contre les connexions lentes), corps de requête plafonnés à la taille exacte attendue. Chaque transfert de segment (`PUT` et `GET`) doit tenir un **débit minimal de 32 Kio/s, mesuré par fenêtres de 5 s** : au moins 160 Kio par fenêtre, sinon la connexion est coupée et rend sa place (§24). L'échéance de la connexion est repoussée de 5 s chaque fois que 160 Kio sont passés. Une révocation (§41.8) pose une échéance définitive, que plus rien ne repousse. Un segment de 4 Mio prend au plus ≈ 133 s ; un client ne peut pas tenir une place en n'envoyant presque rien (audits I3 et M4).
- **Segments servis en flux** depuis le fichier (aucun tampon de la taille du segment), avec `Content-Length` ; une copie incomplète coupe la connexion. Seul un partage `ready` ou `draining` est lu : aucun segment en cours d'écriture n'est servi.

---

## 9. Données stockées

### 9.1 Base

Table `shares`, une ligne par partage vivant :

`id` (clé primaire : identifiant interne tiré par le serveur, §29.8 ; index uniques sur `access_v` et `manage_v` ; table `WITHOUT ROWID` : aucun compteur d'insertion ne trahit l'ordre de création), `state` (`uploading`, `ready`, `draining`), `bucket` (palier), `ttl_hours`, `max_opens`, `opens_left`, `opens_issued`, `done_mask` (un bit par ouverture terminée), `failed_attempts`, `segments_mask` (segments reçus), `salt`, `kdf_ops`, `kdf_mem`, `access_v`, `proof_v`, `manage_v` (SHA-256 de `K_accès`, `K_preuve`, `S_gestion`), `expires_at`, plus l'enveloppe de la graine (§29.2). Les échéances d'envoi et de purge (`upload_deadline`, `progress_at`, `purge_at`) sont tenues **en mémoire** par le serveur, pas en colonnes (§36 S5, S11, S12) ; `ttl_hours` est remis à `NULL` après `finalize`.

- La base ne garde qu'une date, `expires_at`, **arrondie au quart d'heure supérieur**.
- `progress_at` (mémoire) : minute du dernier segment reçu, pour effacer un envoi bloqué (§7.4). Il n'existe **que pendant l'envoi** : vide à la création (la minute de création n'est jamais notée), mis à jour à chaque segment, oublié à la finalisation comme `upload_deadline`.

- **Prévu pour les fonctions payantes de §38.9 (pas codé)** : `tier` (0, 1, 2), `starts_on_first_open`, `hard_expires_at` (§38.9.1), `opens_at` (§38.9.6), `brand` (§38.9.9), `extensions` (compteur, §38.9.4) ; tables séparées `parts`, `links`, `requests`, `request_notes` (§38.9.3, §38.9.5, §38.9.7). Pour un partage `starts_on_first_open` non démarré, `ttl_hours` reste non nul jusqu'au premier déverrouillage (S49). Date créée à 15 min près : voir S48.
- **Jamais stockés** : adresse IP, date de création (sauf, pour un partage payant, le plafond `hard_expires_at` qui la donne à 15 min près, S48), nom, type ou taille exacte de fichier, navigateur, pays, jetons.
- La ligne est supprimée quand le partage meurt. `secure_delete=ON`, `temp_store=MEMORY` et vidage du WAL chaque minute : rien ne reste dans le fichier de base (vérifié par le test « le serveur ne voit rien » après destruction et arrêt).
- **Version du schéma (audit)** : `PRAGMA user_version` = **1** (`store.SchemaVersion`), écrite à l'ouverture d'une base plus ancienne. Un binaire refuse une base d'une version plus récente, sans la toucher (message fixe, sans chemin) : un retour arrière ne réécrit jamais une base qu'il ne connaît pas. À incrémenter avec toute migration.
- **Écriture et vidage** : `synchronous=FULL` est écrit dans les PRAGMA (valeur par défaut, gardée exprès). Le vidage du WAL lit le résultat de `wal_checkpoint(TRUNCATE)` : un vidage incomplet (base occupée) rend une erreur, et il est refait au passage suivant.
- **Seconde base `comptes.db`** (compte, conception `2026-11-22-compte-passkey-design.md` §6.3), dans le même dossier, ni ouverte ni créée sans `SHH_COMPTES=1`. Tables `comptes` (`h` aléatoire ; `p_empreinte`, empreinte à clé du pseudo ; `pseudo_jour` ; `v_r`, empreinte de la clé de récupération, et son enveloppe `env_r` ; coffres `blob_profil` et `blob_prive` avec leur `gen` ; `cree_jour`, `compte_des`, `vu_mois`), `passkeys` (identifiant, clé publique, algorithme, `be`, étiquette chiffrée par l'appareil, mois d'ajout), `enveloppes` (4 au plus par passkey), `sessions` (SHA-256 du jeton, identifiant montré, étiquette chiffrée par l'appareil, mois de création, jour d'échéance, `persistante`, `par_recup`) et `bannis` (identifiant aléatoire, `h`, début, échéance, état, motif, salons fermés). Mêmes règles que `shares.db` (`secure_delete=ON`, `temp_store=MEMORY`, WAL vidé après chaque effacement, 0600, `WITHOUT ROWID`), **seulement des BLOB et des INTEGER** (aucune colonne texte), dates au jour (multiples de 86 400) ou au mois, jamais d'heure ; version du schéma 3 (`compte.VersionBase`). **Contrairement à `shares.db`, elle survit aux redémarrages** et elle est sauvegardée (§9.2). Dans `shares.db`, table `salons` : colonne `compte`, seul lien compte ↔ salon, effacé avec le salon ; aucun lien avec `shares`. **Pseudo** : le premier changement est permis le jour même de l'inscription ; l'attente (jusqu'au jour UTC suivant) ne court qu'à partir d'un changement ; `pseudo_jour` vaut 0 tant que le pseudo n'a jamais changé (`compte.TestPseudoUneFoisPar24h`). **Jamais sur disque** : sortie PRF d'une passkey, `K_compte`, clé de récupération, pseudo affiché ou canonique, photo en clair, AAGUID, jeton de session en clair, adresse IP, en-têtes, heure. Vérifié par `web/e2e/compte-sees-nothing.test.ts` (§36).

### 9.2 Fichiers

- Un fichier par partage, à la taille exacte du palier, contenant uniquement du chiffré : aucun fichier en clair n'existe jamais, même temporaire.
- Place réellement réservée sur le disque à la création (`fallocate` sous Linux, sinon fichier creux).
- **Dates d'accès et de modification du fichier remises à zéro** à chaque écriture (`Chtimes`). Le système de fichiers garde en revanche la date de naissance et la date de changement (ctime) du fichier, que l'application ne peut pas effacer : elles ne sont lisibles que par qui accède au volume déverrouillé, serveur en marche (section 18). Cela vaut aussi pour les fichiers de pièces et de conversations du salon (heure du premier message). Seuls le volume chiffré et l'absence d'instantanés protègent cette métadonnée ; les `ctime` sont ramenés à l'heure du passage de l'entretien (chaque minute).
- Droits resserrés à chaque démarrage : dossiers en 0700, base et fichiers annexes en 0600.
- **Sauvegardes** : aucune sauvegarde de ce dossier, **sauf `comptes.db`** : copie quotidienne prise sur la machine (`sqlite3 .backup`), chiffrée par `age` vers la clé publique de l'exploitant, envoyée chez un autre fournisseur en écriture seule, **7 copies** puis effacement par la règle du stockage (`deploy/README.md`) ; sessions effacées à la restauration. Les partages, les salons, les conversations et leurs fichiers ne sont **jamais** sauvegardés. La clé du serveur `K_serveur` (`SHH_COMPTES_CLE_FILE`, refusée au démarrage si elle est dans `SHH_DATA_DIR`) n'est jamais dans la sauvegarde : sa copie hors ligne est gardée à part. Elle ne sert plus qu'à l'index des pseudos : sa perte perd l'unicité des pseudos, pas les comptes (conception du compte par passkey §7.4).
- Au démarrage, une **réconciliation** efface les fichiers sans ligne et les lignes sans fichier.

### 9.3 En mémoire uniquement

- Compteurs des limites : clé = HMAC(secret du jour, IP, /64 ou /48), effacés chaque jour. Ce sont des **données pseudonymisées** au sens du RGPD, pas anonymes.
- Secret des jetons, compteur agrégé des signalements (§9.5).
- Liste complète et justifiée de ces compteurs : §9.5. Tout ce que le serveur voit ou pourrait déduire : §36.

### 9.4 Journaux

- Journaux d'accès de Caddy **désactivés**.
- Journaux de l'application : uniquement des événements sans donnée personnelle.
- Règles de §36 : aucune adresse, aucun identifiant de partage, aucun en-tête du client dans un journal ni dans un message d'erreur.
- **Sortie d'erreur (audit F3 et F4)** : le serveur et `shhdrop admin` n'affichent que les messages écrits pour l'exploitant. Toute autre erreur (elle pourrait contenir le chemin d'un fichier de partage, donc un identifiant interne) devient un message fixe. Une commande inconnue n'est pas recopiée.

### 9.5 Aucune statistique ; compteurs d'exploitation autorisés (§35.1)

Interdits, côté serveur comme côté navigateur : mesure d'audience, télémétrie, rapports d'erreurs envoyés à un service, `expvar`, `net/http/pprof`, Prometheus, OpenTelemetry, StatsD, « métriques » de Caddy (`metrics`), compteurs de partages créés, d'ouvertures, d'octets servis, de requêtes par route, histogrammes de latence, taux d'erreurs, et toute table ou fichier qui garde un historique d'activité. Un nouveau compteur exige une ligne de ce tableau, avec sa justification, avant d'être codé.

| Compteur (mémoire seulement) | Clé | Durée de vie | Pourquoi il est nécessaire |
|---|---|---|---|
| Créations et octets du jour (`count64`, `count48`, `bytes64`, `bytes48`) | HMAC(secret du jour, /64 ou IPv4, /48) | jusqu'à minuit UTC, secret jeté (envois en cours : D42-1) | quotas de §4 (3 et 10 liens, 6 et 12 Gio de données utiles, §24) |
| Requêtes et segments de la minute (`req`, `req48` : requêtes par bloc /48, audit du 20 novembre, `seg`, `seg48`) | idem | 1 min | limites de débit de §4 et §24 |
| Transferts simultanés (`Slots`) | idem, plus un total | durée du transfert | transferts bornés (§24) |
| Transferts simultanés par envoi et par ouverture (`Keyed`, 11 novembre, audits I3 et M4) | id interne de l'envoi ; (id interne, n° d'ouverture) | durée du transfert ; une clé sans transfert est oubliée aussitôt | au plus 4 par envoi et 4 par ouverture (§24) |
| Envois en scellement (`sealing`) | id interne de l'envoi | le temps d'un `finalize` | segments refusés pendant que `finalize` écrit le bourrage ; présence seulement, aucun compte |
| Envois anticipés en cours et octets abandonnés | id de l'envoi → clés HMAC ; clés HMAC → octets | jusqu'à `finalize` ou effacement ; minuit UTC ; au balayage, un envoi dont la ligne a disparu hors du serveur (`admin destroy`, `wipe`) est oublié | §29.5 |
| Budget de lecture par ouverture, budget de pré-lecture par partage | (id, n° d'ouverture) ; id | 6 h ; vie du partage | §24 (M1), §29.6 |
| octets servis par partage, toutes ouvertures confondues (`share/budget.go`, `readBudget.shares`) | id interne ; un entier | vie du partage et sa grâce ; perdu au redémarrage (qui invalide aussi tous les jetons) | plafond de sortie par partage, `SHH_SHARE_EGRESS_MAX` (§38.6) ; ni adresse, ni ouverture, ni heure ; jamais écrit sur le disque |
| Défis anti-robot consommés ; créations de l'heure par connexion | sel du défi ; HMAC de connexion | 2 min ; 1 h | usage unique ; difficulté qui double (§22 D4) |
| Signalements de l'heure | aucun (un seul entier) | remis à zéro chaque heure | alerte « les signalements s'accumulent » (§15.2) ; exposé seulement comme booléen sur `/healthz` local et dans le tableau de bord, jamais le nombre (§36 S21) ; les agrégats par catégorie sont une ligne à part, plus bas |
| Place réservée totale | aucune (somme) | calculée depuis la base | plafond global `SHH_STORAGE_MAX` (§4) |
| Limites du compte (`insc64`, `insc48`, `inscD64`, `cnx64`, `echec64`, `echec48`, `recup64`, `recup48`, `coffreCpt`, `pseudoCpt` ; conception du compte par passkey §7.2) | HMAC(secret du jour, /64 ou IPv4, /48) ; HMAC du jour de `h` ou de l'étape : jamais une adresse | 1 min, 1 h ou minuit UTC selon la limite | 3 et 10 comptes par jour ; 20 `inscription/debut` par heure ; 60 `connexion/debut` par minute ; 20 et 60 échecs par heure ; 10 et 30 essais de clé de récupération par heure ; 60 écritures des coffres et 10 ajouts de passkey par heure ; 30 vérifications de pseudo par heure |
| Cérémonies WebAuthn en cours (`compte/defis.go`) : défi, `rp.id`, passkeys permises, `h` tiré, empreinte du pseudo réservé | identifiant aléatoire de la cérémonie | quelques minutes, nombre borné ; perdues au redémarrage | inscription et connexion par passkey (conception du compte par passkey §6.2) |
| Sessions du compte (`compte/sessions.go`) : dernier usage, « session récente » | `t_v` (SHA-256 du jeton) | 2 h sans usage ; récente : 5 min | inactivité et plafond des sessions ; un redémarrage remet l'inactivité à zéro sans prolonger le plafond |
| Références éphémères des salons d'un compte (`compte/service.go:refs`) et des salons signalés du tableau de bord (`adminui/comptes.go:m`) | 16 octets aléatoires → `h` et identifiant interne du salon | 10 min ; perdues au redémarrage | désigner un salon sans jamais en sortir l'identifiant |
| Voix de signalement d'un partage (`share/report.go`) : numéros des ouvertures qui ont signalé | id interne du partage → n° d'ouverture (prouvé par l'octroi signé, §41.4) | jusqu'à l'échéance du partage ou son effacement ; perdues au redémarrage (comme les octrois) | effacer un partage seulement au seuil de §7.6, une voix par ouverture ; ni adresse, ni catégorie, ni identité |
| Signalements par catégorie (`usage`, `salon`) : un compteur par catégorie (1 à 10) et par sorte (partage, salon) ; par salon vivant signalé, le nombre par catégorie | aucune ; identifiant interne du salon | depuis le démarrage ; vie du salon | tableau de bord (conception du compte par e-mail §21.10.3, R14 ; à valider avec le juriste, R15) ; rien sur disque sauf le motif d'un bannissement (`bannis.motif`) |
| Agrégats d'usage (`server/internal/usage`, lus par l'écouteur d'administration seulement) : partages créés, envois terminés, déverrouillages, destructions demandées, partages effacés par l'entretien, requêtes refusées par la limite de débit, octets chiffrés reçus et servis, salons créés, entrées dans un salon, agrégats du compte ; envois et lectures en cours avec leur plus haut ; connexions distinctes ayant créé un partage depuis minuit UTC (lu dans les compteurs de quotas, sans rien garder de plus) | aucune (un entier chacun) | depuis le dernier démarrage | tableau de bord d'administration (règles ci-dessous) |
| Octets Plus du jour (§38.6) | HMAC(secret du jour, /64 ou IPv4, /48) | minuit UTC | Plus 40 et 80 Gio, Pro 100 et 200 Gio par jour |
| Salons créés du jour, entrées de l'heure (§39.3.6) | HMAC(secret du jour, /64 ou IPv4, /48) | minuit UTC ; 1 h | 5 et 15 salons par jour ; 20 et 60 entrées par heure |
| Vérifications du pseudo d'un invité de salon (`POST /api/compte/pseudo/libre`) | HMAC(secret du jour, /64 ou IPv4, /48) | 1 h | 30 et 90 par heure ; ni salon, ni pseudo, ni réponse gardés |
| Salons vivants par bloc (`vivants`, `parBloc`, §39.3.6) | HMAC-SHA-256(clé tirée au démarrage du processus, /48 ou IPv4) ; id interne du salon → cette clé et l'échéance (mise à jour par un renouvellement) | jusqu'à la fin du salon (échéance, destruction) ; un redémarrage oublie tout | 5 salons vivants au plus par /48, pour que quelques blocs ne prennent pas les `SHH_SALONS_MAX` places |
| Trames de la minute, flux ouverts (§39.3.6) | jeton de membre (SHA-256) ; HMAC de connexion | 1 min ; durée du flux | 60 par siège, 480 par connexion, 960 par /48 ; 8, 16 et 2 000 WebSocket |
| Commandes de paiement de l'heure (`paie64`, `paie48`, conception du paiement §8) | HMAC(secret du jour, /64 ou IPv4, /48) | 1 h (fenêtre fixe UTC) | 10 commandes par heure par connexion, 30 par /48 |
| Commandes de paiement créées par heure (audit S2) (`paiement.Service.recentes`, tableau de 4 entiers, pas une table) | aucune (heure UTC → nombre) | 4 h ; perdu au redémarrage | plafond de 1 000 commandes à la fois en attente et récentes (conception du paiement §8) : les vieilles commandes en attente, gardées 7 jours, ne bloquent plus les ventes |
| Webhooks PayPal de la minute (audit S3) (`ppw64`, `ppw48`) | HMAC(secret du jour, /64 ou IPv4, /48) | 1 min (fenêtre fixe) | 30 par connexion, 60 par /48 : chaque webhook PayPal peut coûter un appel sortant authentifié (conception du paiement §8) |
| Identifiants de transmission PayPal refusés (audit S3) (`paiement/paypal.go:vu`) | SHA-256 du `Paypal-Transmission-Id` → échéance ; ni adresse, ni corps, ni signature | 1 h ; 4 096 au plus (table pleine : rien de plus n'est gardé) ; perdu au redémarrage | un faux webhook répété ne coûte qu'un appel sortant ; un identifiant vérifié ou dont la vérification n'a pas abouti n'est pas gardé (PayPal peut le renvoyer) |
| (plus tard, §41.3) Identifiants TURN de l'heure, octets relayés du jour (§40.4) | HMAC(secret du jour, /64 ou IPv4, /48) | 1 h ; minuit UTC | 30 identifiants par heure ; 5 Go relayés par jour (gratuit) |
| État d'un salon vivant (§39.3.2) : index des trames non volatiles (24 octets par trame, la trame elle-même chiffrée sur disque, v3 §5.1), journal des annonces, sièges ; pièces jointes : auteur (siège, SHA-256 du jeton), rang de création, trame liée, sorte (vocal), segments reçus, octets lus par jeton (budget de lecture), **octets servis par pièce, tous jetons confondus (un entier, plafond de sortie `salon.SortieMax`, v3 §3.4)**, index id de pièce → salon | id interne du salon ; id de pièce ; SHA-256 du jeton de membre | vie du salon ; une pièce : jusqu'à son effacement (sa trame, son auteur, 15 min sans lien ou sans segment, fin du salon) | relais, ordre, rattrapage et règles du salon ; pièces : plancher de lecture (plan, point 11), lien avec la trame (point 2), budget de lecture (§24, M1) ; pas une statistique |
| Membres et limites d'un salon vivant : index SHA-256 du jeton → salon, jetons → siège, empreintes des jetons révoqués par une exclusion, seaux par siège (trames 60 par minute rafale 20, 1 200 messages par heure, 120 pièces par heure), réserve vocale, dernière connexion (minute), connexion ouverte par siège, `0x0E` à renvoyer, lectures de pièces en cours (clé `m:` + SHA-256 du jeton) | SHA-256 du jeton de membre ; numéro de siège ; jamais d'adresse | vie du siège (départ, exclusion ; jamais une absence) ou du salon ; révoqués : jusqu'à la fin du salon ; un redémarrage oublie tout | sièges, exclusion, limites de §39.3.6, effacement, « dernière connexion » (v3 §14.1) ; pas une statistique |
| Ouvertures actives et flux de segments annulables (§41.8) | (id interne, n° d'ouverture) → heure du dernier segment ; clé de révocation → fonctions d'annulation | 120 s sans segment ; fin de grâce de 2 h au plus ; fin du flux | continuer un téléchargement commencé après l'expiration ou une suppression ; couper les flux d'une exclusion, d'un signalement ou d'un lien révoqué. Un descripteur détaché garde V_accès et V_preuve, pour qu'un signalement le coupe (§41.8) |
| Octrois d'ouverture (§41.4, D42-22) : retours acceptés (`grants`) | (id interne, n° d'ouverture) | jusqu'à l'échéance du partage (D42-22) | revenir sur la même ouverture sans en consommer ; au plus 20 retours ; budget de lecture (2 + r), gardé jusqu'à l'échéance |
| Requêtes `watch` tenues (§41.8) | HMAC de connexion ; total | 25 s | signal « gone » en moins d'une seconde ; 2 par connexion, 256 au total |
| Abonnements de notification (§38.9.8, si Q-F3 acceptée) | id interne du partage | vie du partage ou redémarrage | notification d'ouverture ; jamais écrits sur disque |
| Places de transfert réservées au Pro (§38.9.13) | total | durée du transfert | 192 places communes, 64 réservées |

Ne sont **pas** des statistiques : les colonnes d'un partage vivant (`opens_left`, `opens_issued`, `done_mask`, `failed_attempts`), nécessaires à ses règles et effacées avec lui ; de même, en mémoire seulement, les morceaux reçus d'un segment partagé d'un brouillon (§41.14), oubliés à `finalize` ou à l'effacement. Hors de notre contrôle, à dire sur la page Confidentialité : les tableaux de bord de trafic de l'hébergeur, les statistiques de trafic de GitHub Pages pour la démo, la sonde externe de §15.2 (elle ne reçoit que la page d'accueil publique).

**Agrégats d'usage du tableau de bord** (ligne « Agrégats d'usage » ci-dessus ; conception du tableau de bord d'administration) :

- **Permis** : un entier par compteur, depuis le dernier démarrage, en mémoire, lu seulement par l'écouteur d'administration.
- **Toujours interdit** : toute mesure d'audience côté navigateur, toute télémétrie, tout rapport d'erreurs envoyé à un service, tout compteur **par** personne, connexion, adresse ou partage au-delà des quotas de §4 (seule exception : le nombre de signalements par catégorie d'un salon vivant signalé, effacé avec lui), toute série dans le temps, tout compteur **écrit sur disque**, toute route publique de métriques. L'alerte horaire des signalements reste un booléen (§15.2, §36 S21).
- **Ce que cela expose** : qui lit la mémoire du serveur en marche, ou détient le jeton d'administration, connaît l'activité globale depuis le démarrage ; rien ne survit à un redémarrage. Avec très peu d'utilisateurs, un agrégat peut désigner une activité précise.
- **Non compté, par construction** : le nombre de fichiers (le manifeste est chiffré) ; un abonné ne se compte pas (le pass est au porteur).
- **Promesse publique** (page Confidentialité) : « aucune mesure d'audience », suivie de la mention des compteurs globaux en mémoire. À relire par le juriste.
- Tests : `usage.TestQueDesEntiers`, `adminui.TestEtatQueDesAgregats`, test « aucune statistique » de `server/internal/stats_test.go`.

---

## 10. Sécurité du site web

- **En-têtes** :
  - CSP : `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' wss://{hôte du site}; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  - `require-trusted-types-for 'script'` **si** Svelte le supporte sans politique « default » ; sinon absent.
  - `Strict-Transport-Security` (déjà préchargé pour .app), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
  - `Permissions-Policy: microphone=(self), camera=(self), geolocation=()`. Photo et vidéo prises dans l'interface (Q-REC1) (`getUserMedia`, §35.3), sans passer par la galerie ; repli sur le sélecteur (`<input capture>`) si la caméra est refusée ou absente. `microphone=(self)` sert au vocal enregistré dans l'interface. `/pdf-frame.html` reçoit `microphone=(), camera=(), geolocation=()` (il n'en a jamais besoin). Audit F3 : tout ce qui ne sert pas est refusé explicitement, sur toutes les pages : `geolocation=(), display-capture=(), clipboard-read=(), usb=(), serial=(), hid=(), payment=(), gyroscope=(), accelerometer=(), magnetometer=(), midi=(), xr-spatial-tracking=(), browsing-topics=(), interest-cohort=()` (`bluetooth` retiré : Chromium ne le reconnaît pas dans l'en-tête et l'écrit en erreur dans la console ; test `hygiene.spec.ts`). Restent à leur défaut (`self`) : `clipboard-write` (copie), `web-share` (Partager), `screen-wake-lock`, `fullscreen` et `publickey-credentials-*` (§37.9). `clipboard-read=()` interdit à la page de lire le presse-papiers : il n'est donc jamais vidé d'office (§41.4 F2, voir Ready).
  - `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`. Pas de COEP : inutile, Argon2id tourne sur un seul fil.
  - **Vitesse (retours CLEAN2 puis CLEAN4)** : `Cache-Control: no-store` partout, fichiers du site compris (changements d'interface visibles tout de suite pendant le développement ; à rouvrir avant la mise en ligne : les fichiers à empreinte de `/assets/` peuvent être mis en cache un an sans risque). Fichiers texte du site précompressés au build (`.br` qualité 11, `.gz` niveau 9), servis selon `Accept-Encoding` ; aucune compression à la volée, rien sur `/api/*` (pas de BREACH). `check-dist.mjs` vérifie que chaque variante redonne exactement son fichier.
- **Aucune ressource tierce** sur les pages de l'application, sans exception. `robots.txt` et `noindex` sur les pages de partage, sans aperçu pour les messageries.
- **Fichiers du site** : servis depuis `SHH_STATIC_DIR` sans jamais en sortir (liens symboliques compris) ; fichiers et dossiers cachés (`.env`, `.git/…`) → 404 ; aucune liste de dossier (dossier sans `index.html` → 404) ; `GET` et `HEAD` seulement. Application monopage : un chemin inconnu sans extension sert `index.html` avec les mêmes en-têtes ; un fichier absent (`x.js`) → 404. Un fichier n'est servi qu'à son chemin exact (`/pdf-frame.html/` et variantes : 404), pour que la politique du cadre PDF ne puisse pas être contournée par une variante de chemin. Aucun repli particulier sous `/s/` ni `/m/` (§32 ; un `#` abîmé par une messagerie reste sur `/`, qui charge l'application et le retire). Les segments cachés et la remontée (`..`) restent refusés ; `/api/…` et les autres préfixes ne changent pas.
- **Origine attendue** : le client ne prend jamais l'adresse du serveur dans le lien. Chaque fonction reçoit l'origine du site (`location.origin`) et refuse un lien d'une autre origine ou qui contient des identifiants (`user:pw@`) ; l'origine doit être `https://hôte[:port]` exacte (http seulement pour `localhost`, `127.0.0.1`, `[::1]`). Le préfixe `#c` désigne un salon (§39.1). Cela protège aussi hors navigateur (Node, future appli, §16), où la CSP ne s'applique pas.
- **Secrets typés** : K_lien, K_accès, K_preuve et S_gestion ont des types TypeScript distincts ; envoyer K_lien au serveur ne compile pas. La couche HTTP n'est pas exportée par l'interface publique (`web/src/index.ts`).
- **Pas de service worker** : aucun code ne reste installé dans le navigateur entre deux visites. Cela ne protège pas d'un serveur compromis, qui peut enregistrer le sien (§28.5) ; le service worker d'épinglage est écarté (§28.6, Q-C1).
- **Contenu déchiffré** : en mémoire, jamais dans le stockage du navigateur (exceptions écrites : coffre chiffré, §27 ; clé du lien et octroi d'ouverture dans le `sessionStorage` de l'onglet, §41.4 ; octroi d'ouverture seul (sans `K_lien` ni mot de passe), chiffré AES-256-GCM sous une clé non extractible, en IndexedDB, pour revenir jusqu'à l'échéance, D42-22 ; preuve de membre du salon, chiffrée sous le mot de passe du salon, en IndexedDB (D41-26, §39.13.3) ; jamais de clair). Effacement **au mieux** (mise à zéro des tableaux, révocation des URL blob) : le navigateur ne garantit pas davantage.
- **Dépendances** minimales, versions verrouillées (`package-lock.json`, `go.sum`), installation reproductible (`npm ci`).
- **Navigateur sans WebCrypto** : refus clair. Rien n'est jamais envoyé en clair.

---

## 11. Anti-abus

- Limites et quotas de la section 4, appliqués par connexion, par /64 et par /48.
- Place réservée à la création, plafond global.
- Signalement depuis le contenu ; signalements par e-mail traités avec `admin destroy`.
- **Réputation du domaine** : si des liens Shhdrop servent à diffuser des malwares, Google Safe Browsing peut bloquer **tout** le domaine. D'où la réaction rapide aux signalements et le suivi des alertes. Plus tard, un domaine séparé pour les liens pourra être envisagé.
- Preuve de travail anti-robot à la création d'un partage ou d'un salon (D4, §22).

---

## 12. Lecture et création de contenu

### Lecture

| Type | Affichage |
|---|---|
| Image (JPEG, PNG, WebP, GIF, AVIF) | `<img>` depuis une URL blob, plein écran, zoom natif |
| SVG | **jamais affiché** : téléchargement seul, avec l'avertissement « à risque » (ouvert localement dans un navigateur, son script s'exécute ; décision du 7 novembre) |
| Audio | `<audio controls>` natif |
| Vidéo (MP4, MOV, WebM) | `<video controls>` natif, **après** téléchargement complet |
| Texte | Affiché comme **texte brut** (jamais interprété comme HTML) |
| PDF | pdf.js dans une `iframe` sandbox **sans** `allow-same-origin`, données transmises par `postMessage`, scripts du PDF désactivés. **Prototype au début du projet** ; si c'est impossible à faire fonctionner de façon fiable, repli sur le téléchargement |
| HEIC | Affiché là où le navigateur le sait (Safari) ; sinon téléchargement |
| Autres | Téléchargement seulement |

- Le type affiché suit une **liste blanche** : un fichier déclaré « image » qui n'en est pas une n'est pas affiché. Dans le code, `Opened.previewKind(i)` rend `image` (JPEG, PNG, WebP, GIF, AVIF, HEIC ; jamais SVG), `audio` (MPEG, MP4, AAC, Ogg, WebM, WAV), `video` (MP4, WebM, QuickTime), `pdf`, `text` (éléments texte) ou `none` (tout le reste, HTML compris, et tout élément de plus de 200 Mio). L'écran traite un échec de décodage comme `none`.
- Le nom et le type MIME du manifeste sont **bruts** (écrits par l'expéditeur) : jamais affichés ni utilisés tels quels. On utilise `Opened.safeName(i)` et `Opened.isRiskyFile(i)`.
- **Téléchargement** :
  - type `application/octet-stream`, toujours (`collectToBlob` ne prend plus de type) ;
  - **nom de fichier nettoyé** (`safeName`) : NFC ; caractères d'inversion de sens d'écriture retirés (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C ; anti-« facture‮fdp.exe ») ; contrôles C0/C1, `/` et `\` retirés ; tous les caractères ignorables par défaut retirés (`Default_Ignorable_Code_Point` : largeur nulle, U+00AD, U+034F, remplissages hangul, sélecteurs de variante, étiquettes…) ; U+200D (ZWJ) gardé seulement entre deux emoji et U+FE0F seulement après un emoji ; espaces regroupés ; points initiaux retirés (fichier caché), points et espaces finaux aussi (Windows les retire) ; 120 points de code au plus, coupés entre deux graphèmes (`Intl.Segmenter`), extension gardée (« fichier » devant l'extension si la coupe ne laisse rien avant elle, jamais un nom qui commence par un point) ; « fichier » si rien ne reste ;
  - **avertissement** pour les fichiers exécutables ou dangereux (`isRiskyFile` : .exe, .msi, .bat, .cmd, .com, .scr, .ps1, .vbs, .js, .jar, .apk, .app, .dmg, .pkg, .sh, .html, .htm, .hta, .lnk, .iso, .msix, .appx, .reg, .wsf, .cpl, .pif, .url, .command, .desktop, .svg, .svgz, .xhtml, .xht, .mht, .mhtml ; .img, .vhd, .vhdx, .one, .chm, .xlsm, .docm, .pptm, .xlam, .ppam, .iqy, .slk, .scf, .jse, .vbe, .psm1, .appref-ms, .application, .gadget, .msc, .settingcontent-ms, .wsh, .msp, .xll, .ps1xml, .inf (D41-13 ; codées dans `web/src/transfer/safety.ts`) ; plus le contenu reconnu : MZ, ELF, Mach-O, ISO).
- **Destruction et signalement après lecture** : `Opened.destroy("report")` réutilise K_accès et K_preuve gardés depuis l'ouverture, sans relire `meta` : possible même après la dernière ouverture (état `draining`). `wipe()` les met à zéro. La fin du téléchargement (`done`) part en `keepalive` pour survivre à la fermeture de la page.
- **Mémoire** : déchiffrement élément par élément, chiffré libéré au fur et à mesure ; avertissement sur les appareils qui manquent de mémoire.

### Création

- **Vocal** : enregistré dans l'interface (§35.3) avec `MediaRecorder`, en **AAC/MP4** quand c'est disponible (lisible partout), sinon Opus/WebM. Compatibilité testée sur iPhone, Android et ordinateur.
- **Photo** et **vidéo** : prises dans l'interface (`getUserMedia`, Q-REC1, §35.3) ; repli sur le sélecteur (`<input capture>`) si la caméra est refusée ou absente.
- **Retrait des métadonnées**, sans réencodage, pour tous les formats courants (images, PDF, bureautique, vidéo, audio) : **§35.2**.

---

## 13. Gestion des erreurs

| Situation | Comportement |
|---|---|
| Réseau coupé pendant l'envoi | Reprise automatique au segment manquant (même onglet) |
| Onglet fermé pendant l'envoi | Envoi abandonné, effacé au bout de 15 min sans nouveau segment (6 h au plus), compte dans la limite du jour |
| Réseau coupé pendant le téléchargement | Reprise tant que le jeton (6 h) et le partage sont valides |
| Serveur redémarré pendant un transfert | Message « Le transfert a été interrompu, réessayez » |
| Mot de passe faux | « Mot de passe incorrect · N essais restants » ; destruction au 5ᵉ |
| Partage expiré ou supprimé pendant la lecture | Un téléchargement commencé se termine (grâce de 2 h au plus) ; l'interface du destinataire se ferme à la suppression (§41.8) |
| Limites atteintes | « Limite atteinte, réessayez dans X h » |
| Serveur plein | « Service temporairement saturé, réessayez plus tard » |
| Trop gros / trop d'éléments | Bloqué avant l'envoi, avec la raison |
| Navigateur trop ancien ou navigateur intégré | Refus clair / avertissement |
| Partage inexistant, expiré, détruit | Message unique |

Messages dans les langues du site (conception des langues).

---

## 14. Tests

### Automatiques (à chaque modification)

- **Unitaires** Go et TypeScript.
- **Crypto** : vecteurs officiels (AES-GCM, HKDF, HMAC, Argon2id) ; aller-retour sur tous les types et paliers ; morceau modifié, retiré, déplacé ou ajouté détecté ; mauvais engagement refusé ; paramètres KDF trop faibles refusés ; tirage de la phrase de passe sans biais.
- **Règles et concurrence** : expiration et arrondi ; ouvertures ; 5 essais **en parallèle** (jamais plus de 5) ; déverrouillages simultanés (jamais plus que N) ; deux destinataires qui téléchargent en même temps ; état `draining` ; destruction ; limites par connexion, /64 et /48 ; réservation et serveur plein ; segments hors palier ou de mauvaise taille refusés ; usurpation de `X-Forwarded-For` sans effet.
- **« Le serveur ne voit rien »** : un fichier contenant un mot repère, un nom de fichier repère, un mot de passe repère et une `K_lien` repère sont utilisés. Ensuite, la base (y compris les pages libres et le WAL), les fichiers, les journaux, les requêtes HTTP capturées et la mémoire exportée du processus sont fouillés. **Aucun repère ne doit apparaître. Ce test bloque toute mise en ligne.**
- **Après destruction** : les octets du partage ont disparu du fichier de base et du disque.
- **Sécurité web** : en-têtes et CSP vérifiés ; fichiers piégés (PDF avec script, SVG avec script, HTML) sans exécution ; noms de fichiers piégés nettoyés.
- **Parcours complets** (Playwright) : Chromium et WebKit, ordinateur et simulation iPhone / Android.
- **Analyse des dépendances** : `govulncheck`, `npm audit`, Dependabot.
- **Aucune statistique** (§35.1) : recherche dans les sources, les dépendances (`package-lock.json`, `go.sum`) et le build (`dist/`, `dist-demo/`) des SDK et adresses connus de mesure d'audience, télémétrie et rapports d'erreurs (liste en §35.1) ; côté serveur, aucune table hors du schéma exact de chaque base, toute `map` déclarée hors de la liste blanche de §9.5 fait échouer le test, et chaque compteur de §9.5 est vide après sa rotation (horloge injectée).
- **Métadonnées** (§35.2) : pour chaque format, fichiers d'essai réels générés localement avec des repères (GPS fictif, appareil, auteur, logiciel, dates) ; aucun repère après nettoyage, éléments à garder intacts, fichier toujours lisible ; échec d'analyse jamais annoncé « Nettoyé ».

### Manuels (avant chaque mise en ligne)

- Site de test séparé.
- Liste de vérification sur un vrai iPhone et un vrai Android : photo (orientation correcte), photo et vidéo avec localisation activée puis fichier reçu passé à `exiftool` et `ffprobe` (aucune position, aucun appareil, aucune date de prise), document Word et LibreOffice avec auteur, vocal enregistré sur l'un et lu sur l'autre (pause comprise), vidéo d'iPhone lue sur Android, PDF, mauvais mot de passe, expiration, destruction, installation de la PWA, accessibilité (VoiceOver / TalkBack).

---

## 15. Exploitation

### 15.1 Hébergement

- Serveur dédié en France (choix et raisons : §17.1).
- Vérifier le **volume de trafic sortant inclus** : un partage de 2 Gio ouvert 10 fois = 20 Gio sortants.
- Aucun intermédiaire qui déchiffre le trafic (pas de CDN-proxy), TLS terminé par Caddy.
- **Disque : au moins `SHH_STORAGE_MAX` + 1 Gio libres** (200 Gio par défaut, donc 201 Gio) pour que le serveur démarre : sinon refus au démarrage (voir `SHH_STORAGE_MAX`, §8). La place déjà réservée par les partages existants compte comme libre. Réduire `SHH_STORAGE_MAX` ou agrandir le disque avant la mise en ligne. L'espace est lu avec `Frsize` (unité de `Bavail`) quand il est non nul, sinon `Bsize`.
- **Volume de données monté en `noatime`** (à appliquer au déploiement) : sinon la date d'accès d'un fichier révèle l'heure de la première lecture (audit de confidentialité P5). Le serveur ouvre déjà les fichiers en lecture avec `O_NOATIME` sous Linux (repli silencieux si refusé) ; le montage couvre les autres lectures (sauvegarde, outils). Il ne remet pas les dates à zéro après une lecture : `chtimes` mettrait le `ctime`, que nul ne peut fixer, à l'heure de la lecture.

### 15.2 Au quotidien (automatique)

- Nettoyage chaque minute : partages expirés, envois abandonnés, `draining` terminés, vidage du WAL.
- HTTPS renouvelé par Caddy ; mises à jour de sécurité du système automatiques ; redémarrage automatique des conteneurs ; heure synchronisée (NTP).
- Conteneur verrouillé : utilisateur non administrateur, système de fichiers en lecture seule sauf les données, image minimale.
- **Alertes simples** : une sonde externe gratuite (site injoignable), et un script horaire qui envoie un e-mail si le disque dépasse 80 % ou si les signalements s'accumulent.

### 15.3 Commandes d'administration

- Les commandes **ne créent jamais rien** (sauf le fichier de gel) : `SHH_DATA_DIR` doit être un chemin absolu qui contient `shares.db`, ouverte en `mode=rw` (sans création). Sinon : message, code de sortie 1, rien de fait. Chaque réussite affiche le chemin absolu et le nombre de partages touchés. Codes : 0 réussite, 1 échec, 2 erreur d'usage.
- `shhdrop admin freeze` / `unfreeze` : bloque ou rouvre les nouveaux envois.
- `shhdrop admin destroy -` : traite un signalement ; le lien est lu sur l'**entrée standard**, pour qu'il n'aille ni dans l'historique du shell ni dans `/proc/<pid>/cmdline`. Le lien ne contient que la clé (§32) ; la commande en tire `K_accès` (HKDF, §29.2), cherche le partage par `V_accès` et n'écrit rien. `shhdrop admin destroy <argument>` est refusé (erreur d'usage) : tout argument contiendrait la clé. Un lien `#c` détruit le salon (§39.1) (`K_accès_s`, « shhdrop/v2/salon/acces »).
- `shhdrop admin wipe --yes` : gèle d'abord les créations (le gel reste en place, à lever avec `unfreeze`), puis efface tout (urgence).
- `deploy.sh` : installe une version précise (image épinglée par empreinte), contrôle la santé, et revient en arrière si le contrôle échoue (D3).

### 15.4 Sécurité des comptes de l'exploitant

Un compte piraté permettrait de servir un site piégé : c'est la menace la plus réaliste.

- **GitHub** : double authentification (clé de sécurité de préférence), branche `main` protégée, aucun secret dans le dépôt (il est public), alertes de secrets activées.
- **Registraire du domaine** : double authentification, verrou de transfert, **DNSSEC**, enregistrement **CAA** (seul Let's Encrypt peut émettre un certificat).
- **Serveur** : connexion SSH par clé uniquement, pare-feu (22, 80, 443 seulement), mots de passe désactivés.
- **E-mail de contact** : adresse dédiée, avec double authentification.

### 15.5 Plan d'incident

En cas de doute sur la sécurité du serveur ou du code :

1. `admin freeze`, puis `admin wipe` si nécessaire.
2. Changer les accès (SSH, GitHub, registraire).
3. Réinstaller le serveur depuis zéro.
4. Publier un avis sur le site.
5. **Violation de données personnelles (RGPD art. 33 et 34)** : quand elle touche `comptes.db`, `paiements.db` ou une de leurs sauvegardes, ou quand le serveur a été pris (adresses IP et pass en direct, code du site modifiable) : (a) **notification à la CNIL dans les 72 heures** après sa découverte, sauf absence de risque pour les personnes (raison écrite au registre) ; (b) **information des personnes concernées** quand le risque est élevé : faute d'e-mail ou de téléphone (aucun n'est collecté), par un **avis sur le site** (accueil et page Sécurité), communication publique permise par l'art. 34.3 c ; inutile pour des données restées illisibles (art. 34.3 a) ; (c) **registre des violations** (art. 33.5), tenu hors du serveur comme le registre des retraits, modèle `docs/juridique/registre-violations-modele.md`. Procédure détaillée : `deploy/README.md` §6.

---

## 16. Préparation App Store (sans rien réécrire)

Les apps iOS et Android seront **natives et autonomes** (D42-20 : moteur commun en Rust, interface Flutter), sans interface web embarquée (ni Capacitor ni navigateur intégré). Elles ne sont pas développées pour l'instant ; ce qui doit déjà être prêt :

- Chemin `/s` des liens (§32) : il pourra être pris par les liens universels des apps sans prendre tout le site.
- Format, chiffrement, API et liens utilisables tels quels par le moteur commun, prouvés par des vecteurs de test communs (`engine/vectors/`).
- Au moment des magasins : publier `apple-app-site-association` et `assetlinks.json` (conception du compte par passkey §6.5) ; compte Apple Developer (99 $/an, identité publique de l'éditeur) ; déclaration de chiffrement.

---

## 17. Cadre légal

Héberger hors UE **ne soustrait pas un exploitant résidant en France** au droit français ni au RGPD.

- **À faire valider par un juriste avant toute ouverture au public :**
  - **Conservation des données d'identification** (LCEN art. 6, décret 2021-1362) : les hébergeurs doivent conserver certaines données (dont l'IP de création d'un contenu) pendant 1 an. C'est en **conflit direct** avec « aucune IP enregistrée ». Il faut déterminer si Shhdrop est concerné et comment s'y conformer ;
  - **DSA** : point de contact et procédure de notification (art. 16).
- **ANSSI** : déclaration de fourniture d'un moyen de cryptologie assurant la confidentialité (LCEN art. 30, décret 2007-663). Démarche simple, à faire avant l'ouverture au public.
- **Mentions légales** : particulier non professionnel, identité communiquée à l'hébergeur, contact.
- **CGU** : contenus illicites interdits, destruction sur signalement, aucune garantie de conservation, pas de vérification de l'expéditeur.
- **Confidentialité** : liste exacte de ce qui est traité (section 9), pas de cookies (donc pas de bandeau).
- **Compte facultatif et offre payante** : §37.9, conception du compte par passkey §12 (conservation des données de création de compte) ; §38.5 et conception du paiement §9 (statut professionnel, factures, TVA, rétractation, CGV, médiateur).
- **Domaine** : registraire classique avec WHOIS masqué et double authentification (avec Njalla, c'est Njalla qui détient légalement le domaine : risque de perte de contrôle).

### 17.1 Vérifications du 22 novembre (textes lus ou cités, avis d'un avocat toujours requis)

- **Décret 2025-980** (injonction « sécurité nationale » d'un an, renouvelée chaque année depuis 2021) : vise aussi les hébergeurs (personnes du 2 du I de l'article 6 de la LCEN) ; pour eux, il renvoie aux données de l'**article 6 du décret 2021-1362** (chaque opération de création d'un contenu : identifiant de la connexion d'origine, identifiant du contenu, nature, date et heure).
- **Article 8 du décret 2021-1362** : ces données ne sont à conserver que **dans la mesure où elles sont collectées** ; le Conseil d'État (n° 459724) en déduit qu'un hébergeur ne garde que ce qu'il collecte pour son activité. **Question unique pour l'avocat** : une adresse vue le temps de traiter une requête, transformée aussitôt en HMAC sous un secret aléatoire tenu en mémoire et remplacé chaque nuit, jamais écrite, est-elle « collectée » ? Si oui, la promesse « aucune IP enregistrée » est à revoir par décision de l'exploitant (rien n'est changé sans elle).
- **Adresses dans le serveur** : une connexion de salon ne garde pas l'adresse pendant sa durée (`limits.FrameGuard`) ; aucune adresse ne survit au traitement d'une requête dans le serveur Go. Restent hors de portée : le noyau et Caddy le temps de la connexion TCP, et le relais TURN des appels, qui doit connaître les deux bouts (en mémoire seulement).
- **DSA (règlement 2022/2065, lu sur EUR-Lex)** : Shhgone est un service d'hébergement, **pas une plateforme en ligne** (considérant 14 : diffusion à un nombre fini de personnes choisies par l'émetteur ; salons sur admission). S'appliquent : art. 11 et 12 (point de contact unique : `contact@shhgone.com`, français et anglais), 14 (modération décrite dans les Conditions), 16 (signalement : le bouton du site ; signalement complet par écrit avec lien, explication, nom et e-mail, bonne foi ; accusé de réception et décision), 17 (seulement si l'on connaît les coordonnées), 18 (menace pour la vie ou la sécurité). Dispensé : art. 15 (micro ou petite entreprise), art. 19 et suivants.
- **Règlement 2021/784 (contenus terroristes, lu sur EUR-Lex)** : ne s'applique qu'aux hébergeurs qui **diffusent au public** (« nombre potentiellement illimité de personnes ») : probablement pas à Shhgone. Sinon : retrait en 1 h, préavis de 12 h la première fois, point de contact public (art. 15).
- **LCEN art. 6-1** : retrait sous 24 h sur demande de l'OFAC (Pharos) pour contenus pédocriminels ou terroristes, sinon blocage ; recours sous 48 h. Procédure de destruction depuis un téléphone : `deploy/README.md` §4.
- **ANSSI** : l'annexe 1 du décret 2007-663 ne dispense que des catégories précises (matériel grand public) : déclaration à faire.
- **Revue des données gardées** : base et mémoire conformes à §9 (aucun contenu, nom de fichier, clé ou adresse IP en clair ; dates au jour, au mois ou au quart d'heure). Trouvé et corrigé : le suivi des connexions du pare-feu du noyau gardait les adresses des deux bouts jusqu'à 5 jours (`nf_conntrack_tcp_timeout_established`) : ramené à 30 min (README §1), contrôlé par `deploy.sh` (avertissement). **Règle : garder le moins de données, le moins longtemps, supprimer l'inutile**, appliquée : clé des « salons vivants par bloc » remplacée à minuit (`limits.CleBloc` ; une lecture de la mémoire ne relie plus un salon vivant à l'adresse IPv4 de son créateur ; le plafond de 5 salons vivants par adresse repart à zéro à minuit) ; bannissement de 3 ans par défaut, 30 jours ou 1 an au choix (lié au compte, jamais à une adresse IP) ; sauvegardes du compte gardées 7 jours. Écarté : échéance des partages arrondie à l'heure (un partage vivrait plus longtemps, contraire à la décision). Colonnes des bases relues une à une : chacune sert (aucune à retirer).
- **Hébergement retenu** : dédié SYS-1 (Kimsufi / OVHcloud, `24sys01-v1`, Xeon-E 2136, 32 Go ECC, 2 × 512 Go NVMe en RAID logiciel), en France : Gravelines de préférence, sinon Roubaix ou Strasbourg. Héberger hors UE ne retire rien au droit français pour un exploitant en France ; la révision suisse de l'OSCPT (projet de 2025, non en vigueur) rend la Suisse moins sûre que prévu au §15.1.

---

## 18. Limites assumées (affichées honnêtement sur le site)

1. Ce que le destinataire **télécharge ou capture** lui appartient.
2. Le **code du site** est le point sensible de tout chiffrement dans un navigateur : si le serveur ou le compte GitHub est compromis, le site servi pourrait être piégé. Réduit au minimum (section 15.4), pas éliminé.
3. Le serveur et l'hébergeur **voient l'adresse IP** de connexion, même sans l'enregistrer.
4. La mémoire du navigateur est effacée **au mieux**, pas de façon garantie.
5. Shhdrop **ne vérifie pas l'expéditeur** : un lien peut venir de n'importe qui.
6. Le serveur ne stocke **aucune date de création** et arrondit ses dates au quart d'heure, mais le système de fichiers garde la date de naissance et de changement de chaque fichier chiffré : quelqu'un qui accède au volume déverrouillé du serveur en marche peut en déduire l'heure de création d'un partage vivant.
7. **Enregistrement sans `showSaveFilePicker`** (Firefox, Safari, téléphones) : l'élément est assemblé en `Blob`. Les tranches déchiffrées sont repliées dans le `Blob` tous les 64 Mio, puis mises à zéro ; le navigateur garde ce `Blob` en mémoire ou le place dans son stockage temporaire, sur le disque, hors du contrôle du site.
8. **Effacement de la mémoire** : `wipe()` met à zéro le segment chiffré en cache, mais le manifeste (noms, types, textes) reste en mémoire sous forme de chaînes JavaScript, impossibles à effacer ; elles disparaissent quand la page les oublie.
9. **Aperçu** limité aux éléments de 200 Mio ; au-delà, téléchargement seulement.
10. **Clés gardées après l'ouverture** : pour permettre le signalement après la dernière ouverture, K_accès et K_preuve restent en mémoire de la page jusqu'à `wipe()` (ou jusqu'à ce que la page les oublie). Ils ne permettent pas de déchiffrer, seulement de détruire le partage.
11. On n'écrit jamais « 100 % sécurisé ». On écrit ce qui est vrai : le contenu est chiffré de bout en bout ; le serveur ne reçoit que des données chiffrées, jamais la clé. On ne promet pas que le serveur « ne voit rien » : il voit l'adresse IP, les tailles et les heures (§2), et un site piégé reste une limite assumée (§18).
12. **Taille à 4 Mio près, pour tous les partages** (revue K1, I3) : pendant l'envoi, le serveur en marche apprend la taille du contenu à environ 4 Mio près : l'envoi dès l'ajout (§29.7, §41.14, seul mode) révèle les segments reçus, leur ordre et leur heure, et le fait qu'une composition est en cours ; fuite **assumée** (Q-K1). Après la finalisation, la base ne garde plus cette frontière (`segments_mask` remis à « tous reçus ») : au repos, seul le palier reste visible.
13. **Victime ciblée** (§28.8) : un serveur compromis peut servir un code piégé à une seule personne ; la vérification publique ne la protège que si elle vérifie elle-même, avec un outil qui ne vient pas du site.
14. **Coffre** (§27.1) : captures d'écran, téléphone compromis, et confiance de l'expéditeur envers le destinataire restent hors de portée ; « Voir seulement » (§34) n'est qu'une dissuasion.
15. **Métadonnées** (§35.2) : on retire ce que les conteneurs déclarent (EXIF, XMP, propriétés du document, étiquettes, pistes de position) ; ce qui est **dans le contenu lui-même** reste : texte ou visage visibles, date incrustée dans l'image, données d'un flux vidéo (SEI), anciennes révisions d'un PDF, modifications suivies d'un document et leurs auteurs, contenu des archives. Restent aussi (audit) : la vignette d'aperçu d'une photo (JFIF ou EXIF) et, dans un PDF, tout ce qui n'est pas une propriété du document (pages, miniatures, images, polices).
16. **Ordre de lecture** (§36) : le serveur voit quels segments un destinataire télécharge et quand ; la lecture monotone réduit ce qu'il en déduit (quels éléments ont été ouverts), sans le supprimer (le point d'arrêt reste visible).
17. **En-têtes et empreinte TLS** (§36) : le proxy reçoit forcément l'adresse, l'empreinte TLS et les en-têtes du navigateur ; ils ne sont ni journalisés ni transmis au serveur, mais un serveur compromis les voit en direct.
18. **Compte facultatif** (§37) : au repos, rien ne relie un compte à ses partages ; **en direct**, un serveur compromis peut les relier par l'adresse IP et l'heure (écriture du coffre de compte, relectures de l'historique), malgré l'écriture différée. Un appareil neuf ne peut pas détecter qu'on lui ressert un ancien coffre de compte. Le texte « nous ne pouvons pas le lire » vaut tant que le code servi n'est pas piégé (point 2).
19. **Offre payante** (§38) : le vendeur officiel connaît l'identité du payeur et l'empreinte de son pass ; au repos, on voit qu'un partage est Plus, pas qui l'a payé ; l'adresse IP à l'émission et à l'usage des jetons reste visible en direct.
20. **Salon : qui parle avec qui** (§39) : en direct, le serveur voit les adresses des membres d'un même salon et l'heure de leurs envois ; jamais sur disque.
21. **Salon : membres** (§39.2, v3 §3.6.1) : chacun peut copier ce qu'il voit ; un pseudonyme ne prouve rien ; avec des clés MLS volées, la lecture reste possible jusqu'au retrait du membre et à un nouveau Commit.
22. **Salon : coupures** (§39.3.2, v3 §5.1) : la conversation est gardée chiffrée sur le disque du serveur jusqu'à la fin du salon et rattrapée sans limite après une coupure ; un **redémarrage du serveur** la rend illisible, et les messages d'avant sont alors perdus pour tous.
23. **Envoi direct** (§40.1, plus tard et optionnel) : l'expéditeur doit rester en ligne ; en connexion directe, les pairs voient leurs adresses IP ; par le relais, notre machine voit les deux adresses et le volume, sans rien stocker.
24. **Destruction par le lien seul** (audit du 12 novembre) : qui détient le lien sans le mot de passe peut détruire un partage par **cinq faux essais** sur `POST /api/shares/destroy` (compteur commun avec `unlock`, §29.8). Un partage dont toutes les ouvertures sont prises (`draining`) reste jusqu'à son échéance pour les retours (D42-22) : **cette fenêtre dure jusqu'à l'échéance** (24 h au plus). Une destruction ainsi provoquée prive aussi les personnes qui ont déjà ouvert de leur retour. Le lien doit donc rester aussi confidentiel que le mot de passe.

---

## 19. Accessibilité

- Contraste conforme WCAG 2.1 AA, en clair et en sombre.
- Tout est utilisable **au clavier**, avec focus visible.
- Libellés lisibles par VoiceOver et TalkBack ; compte à rebours annoncé sans spam (mise à jour discrète).
- Zones tactiles de 44 px minimum ; textes agrandissables sans casser la page.

---

## 20. Décisions encore ouvertes

Les questions closes sont dans le registre (§41.0, §42.0) et dans le tableau de chaque section ; restent :

| Sujet | Quand |
|---|---|
| Avis d'un juriste (LCEN, DSA, conservation des données, §17.1) et déclaration ANSSI | Avant l'ouverture large au public ; le compte et le salon sont ouverts sans cet avis, risque assumé (§37, §39.7) |
| Mentions légales à compléter (identité professionnelle de l'exploitant) | Avant la première vente (§38.5, Q-P5) |
| Stockage total (200 Gio par défaut, plus 300 Gio de réserve payante) | Selon le serveur (§41.2) |
| Envoi direct : Q-D1 à Q-D3 (§40.9) | Avant l'envoi direct (plus tard, optionnel) |
| Salon : questions encore ouvertes de §39.12 et §41.7, Q-WS1 | Selon le tableau de chaque section |
| Pire cas de sortie des formules payantes : Q-P11 (§38.8.4) | Avant les fonctions payantes de §38.9 |
| Démo signée : Q-C3 (§28.9) | À décider |
| Bandeau « suppression à distance non garantie » après plusieurs échecs de la surveillance (§41.8) | À décider (texte dans chaque langue) |

Idées d'interface closes, non retenues : aperçu « comme le destinataire » avant l'envoi, code de vérification de 4 mots entre expéditeur et destinataire, texte à lecture unique dans un partage.

---

## 21. Compléments de sécurité de l'interface

| Gravité | Sujet | Problème | Décision |
|---|---|---|---|
| Critique | **Accents dans le mot de passe** | « é » peut être encodé de deux façons selon le clavier (iPhone, Android, ordinateur) : le même mot de passe donnerait une autre clé, et le destinataire ne pourrait jamais ouvrir | Mot de passe **normalisé en Unicode NFC** avant Argon2id, des deux côtés |
| Important | **Cache « page précédente »** (bfcache) | Après avoir quitté la page, le bouton « Retour » peut réafficher le contenu déchiffré gardé en mémoire par le navigateur | `Cache-Control: no-store` sur les pages, et effacement du contenu à l'événement `pagehide` ; à la réouverture depuis ce cache, la page se recharge |
| Important | **Gestionnaires de mots de passe** | Le navigateur proposerait d'enregistrer le mot de passe du partage, qui resterait alors stocké | Champs `autocomplete="off"` / `"one-time-code"`, pas de balise `<form>` de connexion classique |
| Important | **Traduction automatique** | La traduction de Chrome ou Safari envoie le texte affiché à Google ou Apple, donc le contenu déchiffré | `translate="no"` sur tout le site et `<meta name="google" content="notranslate">` |
| Mineur | **Apprentissage du clavier** | Gboard ou SwiftKey peuvent mémoriser le texte saisi dans un message | `autocorrect="off"`, `spellcheck="false"`, `autocapitalize="off"` sur les zones de saisie sensibles ; limite signalée (l'app ne peut pas l'empêcher complètement) |
| Important | **Conditions de l'hébergeur** | Beaucoup d'hébergeurs interdisent les services de partage de fichiers anonymes dans leurs conditions d'utilisation, ce qui expose à une coupure sans préavis | Vérifier les conditions d'utilisation **avant** de louer le serveur |
| Mineur | **Extensions du navigateur** | Une extension malveillante ou trop curieuse peut lire la page | Limite assumée, ajoutée à la section 18 |
| Mineur | **Page de gestion** | Afficher « Ouvert 1 / 3 » demande de connaître le maximum | Colonne `max_opens` ajoutée à la table |
| Mineur | **Fin de téléchargement rejouée** | Un même `done` envoyé deux fois fausserait le compteur | Un indicateur par ouverture (`done_mask`) rend `done` idempotent |
| Mineur | **Partage vide** | Un envoi sans aucun élément | Bloqué dans le navigateur |

---

## 22. Base chiffrée et anti-robot (D2, D4)

### D2 — Base et disque chiffrés

- Tout le dossier de données (`/data` : base SQLite, fichiers chiffrés, fichiers temporaires) est sur un **volume LUKS2 (AES-256-XTS, Argon2id)**. La base est donc chiffrée au repos avec le reste.
- La **phrase de déverrouillage n'est jamais stockée sur le serveur**. Après un redémarrage de la machine, l'exploitant déverrouille le volume en SSH (`deploy/unlock.sh`) ; tant que ce n'est pas fait, le site reste hors service. Les redémarrages du conteneur, eux, sont automatiques et n'ont pas besoin de déverrouillage.
- Les mises à jour de sécurité automatiques **ne redémarrent pas la machine d'elles-mêmes** ; une alerte prévient quand un redémarrage est nécessaire.
- **Swap désactivé** (sinon des pages mémoire pourraient être écrites en clair sur un disque non chiffré) ; vidages mémoire du noyau (core dumps) désactivés. Le durcissement mémoire du processus ne peut pas être coupé en production : `SHH_DISABLE_DUMPABLE_HARDENING=1` est refusée avec `SHH_BEHIND_PROXY=1`, et les commandes `shhdrop admin` sont durcies aussi.
- La base reste en `modernc.org/sqlite` (pas de SQLCipher) : la protection au repos vient du volume chiffré. Le niveau de protection est le même, sans CGO.

### D4 — Anti-robot fort et respectueux de la vie privée

- **ALTCHA** (open source, MIT), **hébergé par Shhdrop** : widget servi depuis notre domaine, bibliothèque serveur Go (`altcha-lib-go`). Aucun service tiers, aucun cookie, aucun traceur (exclus : hCaptcha, Turnstile, reCAPTCHA, §26).
- **Preuve de travail adaptative** : environ 1 s pour une première création ; la difficulté **double à chaque création** de la même connexion dans l'heure (plafond : environ 30 s).
- **Défis signés (HMAC), à usage unique** (consommés en mémoire), valables **2 minutes**, liés à la connexion.
- **Pièges** : un champ caché qui ne doit pas être rempli, et un délai minimum de 3 s entre l'affichage de la page et la création.
- S'ajoute aux limites de la section 4 (créations et octets par jour).
- Limite assumée : aucun captcha n'arrête tous les robots ; l'objectif est de rendre la création en série lente et coûteuse.

---

## 23. Écarts retenus à l'implémentation du cœur

| Sujet | Spécification d'origine | Implémentation retenue |
|---|---|---|
| Paramètres KDF côté navigateur | minimum seul | minimum **et** plafond : audit F4 : plafond = paramètres de création, `ops` = 3 et `mem` = 64 Mio exactement, entiers obligatoires (un serveur malveillant ne peut pas faire allouer 256 Mio et planter l'onglet d'un petit téléphone) ; le serveur refuse aussi tout autre réglage à `finalize` (un partage que personne ne pourrait ouvrir) ; hors bornes : « lien introuvable », aucun `unlock` |
| Version de Go | — | Go 1.26 |
| Quota de 300 Mio par jour | taille envoyée | octets **utiles** du palier : `bucket × 65 536` |
| Délai de 3 s (piège anti-robot) | heure d'affichage | jeton `shown_at` signé et **lié au sel du défi** ALTCHA : utilisable une seule fois |
| ALTCHA | `altcha-lib-go` | version ≥ 1.0.0 (correctif GO-2025-4239) ; sel au format strict terminé par le délimiteur « & » |
| Jeton de téléchargement | par ouverture | par ouverture, **mort après `done`** de cette ouverture (`done_mask`) |
| Destruction par le destinataire | `K_preuve` | un `K_preuve` faux (avec `K_accès` juste) **compte comme essai** de mot de passe, avec le même compteur que `unlock` |
| Adresse du client | en-tête posé par Caddy | `SHH_BEHIND_PROXY=1` : **échec fermé**, toute requête sans `X-Shh-Client-IP` venue de la boucle locale est refusée |
| `/healthz` | local uniquement | boucle locale seulement, et refusé s'il porte `X-Shh-Client-IP` (donc s'il passe par Caddy) |
| Erreurs côté destinataire et gestion | — | coupure persistante → `reseau` ; 429 → `LimitError` ; mauvais mot de passe → `BadPasswordError` ; tout le reste → `NotFoundError` (aucun message choisi par le serveur) |
| Envois vides | effacés au bout d'1 h | sans aucun segment : effacés 5 à 20 min après la création (section 7.4) |
| Dates stockées | `expires_at` arrondi | `upload_deadline`, `expires_at` et `purge_at` arrondis au quart d'heure supérieur (`purge_at` ≤ `expires_at`) ; table `WITHOUT ROWID` |
| Liens | — | `https:` obligatoire ; `http:` accepté seulement pour `localhost`, `127.0.0.1`, `[::1]` |

---

## 24. Taille, quotas, transferts et dépendances

### Taille

- **2 Gio maximum par lien** (gratuit), tous éléments confondus (contenu utile). Paliers en morceaux de 64 Kio : `[1, 16, 80, 160, 400, 800, 1600, 4000, 8000, 16385, 32769]` (de 64 Kio à 2 Gio, §29.3, §41.2). Le fichier chiffré du plus grand palier gratuit fait 48 + 32 769 × 65 552 = 2 148 073 536 octets.
- **Envoi** : lecture des fichiers par morceaux (`File.slice`), jamais tout le fichier en mémoire.
- **Réception** :
  - aperçu sur le site (image, audio, vidéo, PDF) seulement pour les éléments de **200 Mio maximum** ; au-delà, téléchargement seulement ;
  - téléchargement **en flux** : déchiffrement segment par segment, écriture directe sur le disque via l'API d'accès aux fichiers (`showSaveFilePicker`) quand elle existe (Chrome, Edge sur ordinateur) ; sinon, assemblage en `Blob` (le navigateur peut alors placer des morceaux déchiffrés dans son stockage temporaire : limite assumée, ajoutée à la §18).
- **Délais** (§41.2) : jeton d'envoi et `upload_deadline` **6 h** (24 h au-delà de 2 Gio) ; jeton de téléchargement `min(6 h, expires_at)` (24 h au-delà de 2 Gio) ; `purge_at` = `min(ceil15(now + 6 h), expires_at)`.
- **Quotas** : 3 liens par jour par connexion, 10 par /48, **6 Gio par jour** par connexion et **12 Gio par jour par /48** ; stockage total par défaut **200 Gio** (`SHH_STORAGE_MAX`). **Données utiles** : les octets reçus comptent 64 Kio par morceau chiffré commencé (l'en-tête du segment 0 ne compte pas), et le morceau du manifeste (64 Kio) n'est pas compté. Sinon un partage plein coûtait plus que sa réservation, et le 3ᵉ partage plein du jour était refusé. Un corps incomplet (coupé, trop lent) est compté pour ce qui est arrivé : tenir une place n'est jamais gratuit.
- **Limite de débit des segments** : un `PUT`/`GET` de segment dont le jeton est valide est exclu des 60 requêtes par minute et compte dans une limite à part de 600 par minute et par connexion, et de 6 000 par minute et par /48 ; un jeton invalide compte dans les 60.
- **Transferts simultanés** : téléchargements de segments au plus 16 par connexion, 64 par /48, 256 au total ; envois (corps gardé en mémoire, ≤ 4 Mio) 8, 32 et 64. Refus immédiat, sans file d'attente : 429 `limit` (connexion ou /48) ou 503 `busy` (serveur), `Retry-After: 5`. Compteurs en mémoire, sur les clés HMAC du jour, jamais d'adresse. En plus, au plus **4 transferts simultanés par envoi** (jeton d'envoi) **et 4 par ouverture** (id interne, n° d'ouverture) ; au-delà, 429 `limit` (`Retry-After: 5`), sans prendre de place du serveur. Le site envoie et lit un segment à la fois ; 4 laissent la place d'un nouvel essai pendant qu'une requête coupée finit côté serveur. Chaque transfert doit aussi tenir 32 Kio/s par fenêtres de 5 s (§8, « Délais réseau »). **Limite restante** : avec 2 envois en préparation par connexion, 8 adresses IPv4 tiennent encore les 64 places d'envoi, mais au prix de 64 × 32 Kio/s (2 Mio/s), comptés à leur quota du jour (6 Gio par adresse, environ 7 h).
- **Budget de lecture par ouverture** (§41.4, D42-22) : compté en mémoire par (identifiant, n° d'ouverture), sans adresse : 2 × le fichier chiffré de son palier + 2 segments 0 (une lecture complète, un nouvel essai de chaque segment, deux relectures de l'en-tête) + min(r × F, max(3 × F, 256 Mio)) ; au-delà, 429 `budget` (`Retry-After: 60`). F est le fichier chiffré et r (au plus 20) le nombre de retours acceptés : un petit partage se relit à chaque retour, un gros fichier trois fois de plus au plus (dit à l'écran) ; il ne se remet jamais à zéro avec un nouveau jeton, ni à l'échéance pendant la grâce (gardé jusqu'à l'échéance + 2 h) ; oublié avec le partage (destruction, échéance, fin de grâce).
- **Envoi bloqué** : aucun nouveau segment depuis 15 min → effacé (`progress_at`, §9.1), en plus de l'échéance de 6 h et de la règle « aucun segment en 5 min ».

### Anti-robot

- ALTCHA est le seul moyen anti-robot (§26). reCAPTCHA chargé dans la page exécuterait du code tiers sur la page qui détient la clé du lien (§10, §2), avec traçage et bandeau de cookies en plus ; ALTCHA est plus rapide pour l'utilisateur (aucune image) et ne charge rien de l'extérieur. Une personne dont l'appareil ne peut pas calculer la preuve de travail (Worker absent, navigateur intégré restreint, appareil très lent) ne peut pas créer de partage ni de salon ; elle peut réessayer depuis un autre navigateur.

### Dépendances

- Toutes les dépendances (npm, modules Go, actions GitHub, chaîne Go) sont tenues à leur **dernière version stable publiée depuis au moins 7 jours, sauf correctif de sécurité** (une version piégée est le plus souvent retirée dans les premiers jours ; un correctif de sécurité, lui, s'applique sans attendre, après lecture de l'avis). Dependabot applique le délai (`cooldown: default-days: 7`, avis de sécurité exclus du délai) ; une mise à jour à la main vérifie la date de publication (`npm view <paquet> time`, `go list -m -json <module>@<version>`). Installation uniquement depuis les sources officielles (registre npm, `proxy.golang.org`, actions publiées par leurs éditeurs officiels) ; versions verrouillées (`package-lock.json`, `go.sum`).
- Vérification à chaque modification : `govulncheck`, `npm audit` ; Dependabot activé (npm, gomod, github-actions).

---

## 25. Durcissement après l'audit « sharp edges »

Audit « sharp edges » du cœur (rapport tenu hors du dépôt) : 4 moyens, 11 faibles, aucun critique, tous corrigés :

| Point | Correction |
|---|---|
| M1 secrets confondus | types marqués `KLien`, `KAcces`, `KPreuve`, `SGestion` ; `ParsedLink` en union discriminée ; couche HTTP hors de l'interface publique `web/src/index.ts` ; `tsc` lancé par `npm test` |
| M2 admin sur un mauvais dossier | rien n'est créé ; `shares.db` exigée, ouverte en `mode=rw` ; chemin et nombre affichés ; code non nul (§15.3) |
| M3 écoute publique sans proxy | `SHH_LISTEN` hors boucle locale refusé sauf `SHH_BEHIND_PROXY=1` + `SHH_TRUSTED_PROXY` (§8) |
| M4 nom et type bruts | `safeName`, `previewKind`, `isRiskyFile` ; `collectToBlob` toujours en `application/octet-stream` (§12) |
| F1 origine prise dans le lien | origine attendue en paramètre, liens d'une autre origine ou avec identifiants refusés ; origine validée (§10) |
| F2 JSON insensible à la casse, doublons | clés exactes, sans doublon, vérifiées avant le décodage (§8) |
| F3 `\r` `\n` ignorés en base64 | longueur exacte en caractères et alphabet vérifiés (secrets, identifiants, jetons) |
| F4 `match(nil)` | secret de 32 octets exigé ; vérificateur égal à SHA-256("") refusé |
| F5 `SHH_DATA_DIR` | absolu ; dossier non vide d'un autre programme refusé (§8) |
| F6 `SHH_STORAGE_MAX` sans plafond | `statfs` au démarrage, 1 Gio de marge ; fichiers creux refusés derrière le proxy (§8) |
| F7 site statique | `index.html` exigé ; fichiers cachés et listes de dossiers refusés ; repli monopage (§10) |
| F8 32 bits | comparaison sûre ; `GOARCH=386 go build ./...` dans `make test-go` |
| F9 mot de passe trop court ou vide | forme générée exigée (§31) ; `deriveContentForCreate` impose `checkPassword` et `KDF_CREATE` ; mot de passe vide refusé à l'ouverture |
| F10 valeurs zéro de `share.Service` | `share.NewService` valide `FrozenFile` et `StorageMax` ; un `Service` sans `FrozenFile` est gelé (échec fermé) |
| F11 lien dans argv | `admin destroy -` (entrée standard), avertissement si l'argument contient `#` (§15.3) |
| S1 signalement après la dernière ouverture | `Opened.destroy(reason?)` sans `meta` ; `done` en `keepalive` (§12, §18) |

API du client pour l'interface : `createShare(origin, items, opts)`, `openShare(link, password, expectedOrigin, onProgress?, net?)`, `fetchMeta(link, expectedOrigin, net?)`, `destroyShare(link, expectedOrigin, opts?)`, `shareStatus(manage, expectedOrigin, net?)`, `collectToBlob(opened, i, foldBytes?)`.

---

## 26. Repli Google reCAPTCHA : écarté

Aucun repli vers Google reCAPTCHA (ni vers aucun autre service tiers) : la preuve de travail ALTCHA hébergée chez nous est le seul moyen anti-robot (D4, §22, §24). Ni `SHH_RECAPTCHA_SECRET`, ni `SHH_VERIF_ORIGIN`, ni `siteverify`, ni cadre de vérification (`web/verif/`, `dist-verif/`) n'existent ; `TestNoOutgoingHTTP` n'a aucune exception pour lui. Conséquence assumée : §24, « Anti-robot ».

---

## 27. Coffre chiffré sur téléphone (pas construit)

> **État** : le coffre local **n'est pas construit**, et l'option n'est pas proposée dans l'interface tant que les apps n'existent pas. Son code de garde (`web/src/vault/`, règles `weakpw.ts`, liste noire `blocklist.ts` et ses listes SecLists, NCSC, Richelieu) est supprimé. **S'il est construit un jour** : code de garde à refaire (règles de §31, listes à reprendre, licences et attribution CC BY 4.0 à remettre, F-13). Le **format ne change pas** : le manifeste accepte toujours `rights: "coffre"` et `keep_ttl_h` (moteur, vecteurs), pour les apps. Ce qui suit est la conception à reprendre.

Le destinataire peut garder un partage reçu dans un **coffre chiffré local**, sur téléphone seulement (PWA installée, future application), **et seulement si l'expéditeur l'a permis** (droit « Voir, enregistrer et garder dans le coffre », §34). Le droit est désactivé par défaut. C'est une exception écrite à §10 (« contenu déchiffré : jamais dans le stockage du navigateur ») et à UI §12.1 : le coffre ne stocke que du chiffré, confiné au module `web/src/vault/`.

### 27.1 Ce que le coffre garantit, et ce qu'il ne garantit pas

| Il garantit | Il ne garantit pas |
|---|---|
| Le serveur n'apprend rien : le droit est dans le manifeste chiffré, la copie se fait pendant une ouverture ordinaire | **Captures d'écran**, photo de l'écran, enregistrement de l'écran (iOS et Android ne les bloquent pas pour une PWA) |
| Rien de lisible sur le disque : paquet chiffré, clé jamais écrite en clair | **Un téléphone compromis** (logiciel espion, accès administrateur) lit ce qui s'affiche et peut capter le déverrouillage |
| Effacement à l'échéance dès que l'application tourne (en ligne dans une PWA, §27.5) | **L'expéditeur fait confiance au destinataire** : un destinataire qui veut garder le contenu le gardera (capture, autre appareil) |
| Effacement après N déverrouillages ratés, et à la main à tout moment | **Un code du site piégé** (§2, §18.2) peut demander le déverrouillage et lire le coffre : le coffre est aussi sûr que le code servi (d'où §28) |
| | **Effacement physique** de la mémoire flash : on efface les clés (effacement cryptographique), le système décide quand les blocs sont réécrits |
| | Effacement **pendant que l'application est fermée** : une PWA n'exécute rien quand elle est fermée ; l'effacement se fait au prochain lancement, et le déchiffrement est refusé après l'échéance |
| | La **suppression par l'expéditeur** n'atteint pas une copie déjà gardée (aucun canal sans réseau, et une vérification en ligne trahirait la copie au serveur) |

### 27.2 Clés (WebCrypto et libsodium seulement)

- **Secret de déverrouillage `U`** (32 octets), au choix fixé à la création du coffre, jamais rétrogradé ensuite :
  - **Passkey avec l'extension WebAuthn PRF** (choix par défaut quand elle existe : Safari iOS 18 et plus avec le trousseau iCloud, Chrome Android avec le gestionnaire de Google). Création : `rp.id` = hôte du site, `user.id` = 16 octets aléatoires, `user.name` « Coffre Shhdrop », `residentKey: "required"`, `userVerification: "required"`, `extensions.prf.eval.first = sel_prf` (32 octets aléatoires gardés dans le coffre). `U` = `prf.results.first`. La passkey ne sert que de source de clé : aucune signature n'est vérifiée, aucun serveur n'intervient.
  - **Code du coffre** sinon : `U` = Argon2id(code NFC, `sel_code`, 64 Mio, 3 passes, 1 fil, 32 octets), mêmes paramètres minimaux que §7.1. Le code suit `checkPassword` (10 caractères au moins et règles de la liste noire, §31) : un code à 4 ou 6 chiffres est refusé, car il tombe en quelques heures si quelqu'un copie le stockage du navigateur (le compteur d'essais ne protège que dans l'application).
- `U` est importé aussitôt en clé HKDF **non extractible**, puis le tampon est mis à zéro. Clé par entrée : `K_coffre_i` = HKDF(`U`, sel = `sel_i` (32 octets aléatoires par entrée), info « shhdrop/v2/coffre/contenu ») en AES-256-GCM non extractible ; `C_coffre_i` = HKDF(`U`, `sel_i`, « shhdrop/v2/coffre/engagement »). Témoin de déverrouillage : `T` = AES-GCM(HKDF(`U`, « shhdrop/v2/coffre/temoin »), « shhdrop-coffre-ok »).
- Le contenu gardé est **rescellé** dans un paquet Shhdrop ordinaire (§29.3, même code `container.ts`, mêmes paliers) sous `K_coffre_i` : aucun format ni construction de plus. La clé du partage (`R`, §29) n'est jamais conservée.
- Limite honnête : `U` passe dans la mémoire de la page pendant le déverrouillage (la sortie PRF et celle d'Argon2id sont des tableaux JavaScript). « Non extractible » réduit cette fenêtre, sans protéger contre un script qui tourne sur l'origine à ce moment.
- Une passkey synchronisée (trousseau iCloud, gestionnaire Google) existe aussi sur les autres appareils du compte. Le paquet, lui, n'est que sur ce téléphone : il faut les deux.

### 27.3 Stockage

- **OPFS** (`navigator.storage.getDirectory()`) : un fichier `coffre/<entree>.shh` par entrée (le paquet rescellé). **IndexedDB** (base `shh-coffre`) : `mode` (`prf` ou `code`), `sel_prf` ou `sel_code`, `credentialId`, `T`, `essais_rates`, `derniere_heure_vue`, et par entrée `{ id aléatoire, sel_i, echeance, taille du palier }`. Aucun nom, type ni texte en clair : ils sont dans le manifeste chiffré.
- **Échéance en double** : en clair dans IndexedDB (pour effacer sans déverrouiller), et authentifiée dans un petit enregistrement chiffré sous `K_coffre_i` (pour refuser un déchiffrement après l'échéance même si quelqu'un a modifié la valeur en clair).
- `navigator.storage.persist()` demandé à la première entrée. Plafonds : 1 Gio par entrée, 2 Gio et 20 entrées au total, et jamais plus que `storage.estimate()` moins 200 Mio.
- Ce qu'un tiers qui accède au téléphone déverrouillé peut voir sans le code : qu'il existe N entrées, leurs tailles de palier et leurs échéances.

### 27.4 Échéance, essais, effacement

- **Échéance** = min(heure de l'ouverture + `expiresInS` lu par `meta`, heure de l'ouverture + `keep_ttl_h` du manifeste). Le serveur ne peut que **raccourcir** la durée, jamais l'allonger au-delà de ce que l'expéditeur a choisi. C'est l'échéance **en temps** du partage : épuiser les ouvertures ne l'avance pas (avec 1 ouverture, le partage meurt sur le serveur à la fin du téléchargement, la copie reste jusqu'à l'échéance).
- **Horloge** : `maintenant` = max(`Date.now()`, `derniere_heure_vue`), enregistré à chaque lancement. Reculer l'horloge du téléphone ne prolonge pas une entrée déjà vue après son échéance.
- **Effacement automatique** : au lancement, à chaque retour au premier plan, et par minuterie quand l'application est ouverte. Il efface les entrées échues **sans déverrouillage** (fichier OPFS, puis ligne IndexedDB). Une entrée échue n'est jamais déchiffrée (contrôle de l'échéance authentifiée avant tout déchiffrement).
- **Essais ratés** : `N` = 5. Le compteur est **incrémenté avant** l'essai et remis à zéro après un succès (tuer l'application pendant un essai ne rend pas l'essai gratuit). Seul un secret faux compte (témoin `T` qui ne se déchiffre pas) ; une annulation de la passkey (`NotAllowedError`) ne compte pas. Au 5ᵉ échec, tout le coffre est effacé (fichiers, base, `sel_prf`).
- **Effacement manuel** : « Effacer » par entrée, « Vider le coffre » (confirmation sur place). Détruire ou signaler un partage depuis le coffre (en ligne) efface aussi sa copie.
- **Verrouillage** : à la sortie de l'écran du coffre, à `visibilitychange → hidden` et après 2 min sans geste, les clés et les aperçus sont oubliés (URL blob révoquées, tampons mis à zéro). Le contenu est masqué dès `hidden`, sans garantie que la vignette du sélecteur d'applications ne soit pas déjà prise.

### 27.5 Réseau et hors-ligne : dépendance à §28.6

Sans service worker et avec `Cache-Control: no-store` partout (§10), une PWA installée **ne démarre pas sans réseau** : ni lecture, ni effacement hors ligne. Le service worker d'épinglage étant écarté (§28.6, Q-C1), le coffre fonctionnerait en ligne seulement : l'effacement aurait lieu au premier lancement en ligne après l'échéance (le déchiffrement restant refusé). Dans une app native, cette limite disparaît.

### 27.6 Parcours

- **Expéditeur** (Options ; non proposé tant que les apps n'existent pas) : droit « Ce que le destinataire peut faire » (§34) ; le troisième choix s'intitule **« Autoriser le destinataire à garder une copie chiffrée sur son téléphone »**, avec, quand il est choisi : « Elle reste jusqu'à l'expiration ({durée}). Supprimer le partage ne l'efface pas : seul le destinataire, ou l'échéance, l'efface. Une capture d'écran reste toujours possible. » Sur « Lien prêt » : « Pour garder une copie, le destinataire doit ouvrir le lien dans l'app Shhdrop installée. »
- **Destinataire, navigateur d'un téléphone** (pas l'app) : avant le déverrouillage, une note fixe, la même pour tous les partages (elle ne dit rien du droit, qu'on ne connaît qu'après) : « Si vous avez l'app Shhdrop, ouvrez-y ce lien avant de déverrouiller : c'est là seulement qu'un partage peut être gardé, quand l'expéditeur l'a permis. » Sur iOS, Safari et l'app installée ne partagent pas leur stockage, et l'app ne capte pas les liens : l'app propose **« Ouvrir un lien reçu »** (champ où l'on colle le lien).
- **Destinataire, dans l'app**, si le manifeste porte `rights: "coffre"` : sur l'écran de contenu, bouton **« Garder dans le coffre »** (`secondary`, icône `lock`). Premier usage : création du coffre (passkey, ou code si PRF manque, avec la raison), puis téléchargement complet et rescellement, progression en octets ; « Gardé jusqu'au {date, heure} ». Échec (place, quota, annulation) : rien n'est gardé, aucun fichier partiel (le fichier OPFS est supprimé).
- **Écran du coffre** (`/coffre`, dans l'app seulement) : verrouillé, « {n} partages gardés · le prochain s'efface dans {durée} » et **Déverrouiller** (passkey ou code). Déverrouillé : une ligne par entrée, « Reçu le {date} · s'efface dans 4 h 12 » (compte à rebours : `Countdown`, mêmes seuils d'annonce, à la seconde sous 5 min), **Ouvrir** (écran de contenu en mode local : pas de « Terminer », pas de réseau ; « Enregistrer » selon le droit), **Effacer**. Pied : **Vider le coffre**. À l'échéance d'une entrée ouverte : dissolution, puis « Ce partage a expiré : sa copie a été effacée de ce téléphone. »
- Démo GitHub Pages : coffre **désactivé** (faux serveur en mémoire, et origine `skoow.github.io` partagée entre tous les dépôts Pages du même compte : IndexedDB et OPFS y seraient lisibles par ses autres pages).

### 27.7 Lentilles « sharp edges » et « insecure defaults »

| # | Gravité | Endroit | Problème | Correction (intégrée) |
|---|---|---|---|---|
| V1 | Élevée | Droit absent ou mal formé | Un défaut permissif ferait garder des copies sans accord | Absent, inconnu ou mal typé → `"voir"` (le plus restrictif, §34) ; seul `rights === "coffre"` avec `keep_ttl_h ∈ {1, 6, 12, 24}` ouvre le coffre |
| V2 | Élevée | Code du coffre | Un code court tombe hors ligne après copie du stockage, quel que soit le compteur | `checkPassword` imposé (10 caractères au moins, §27.2) ; passkey proposée d'abord |
| V3 | Élevée | PRF absente au déverrouillage | Repli silencieux vers un mode plus faible | Mode fixé à la création ; PRF absente plus tard → erreur « Ce coffre a été créé avec une passkey » ; jamais de repli |
| V4 | Moyenne | Compteur d'essais | Incrémenté après l'essai : tuer l'app donne des essais gratuits ; une annulation compterait | Incrémenté avant ; seule une erreur du témoin compte |
| V5 | Moyenne | Échéance en clair | Modifiable sur l'appareil pour prolonger | Échéance authentifiée vérifiée avant tout déchiffrement ; horloge monotone par `derniere_heure_vue` |
| V6 | Moyenne | Échéance fournie par le serveur | Un serveur malveillant l'allongerait | `min(expiresInS, keep_ttl_h)` |
| V7 | Moyenne | Démo | Origine partagée `skoow.github.io` | Coffre désactivé en démo, test |
| V8 | Faible | Taille | Remplir le téléphone | Plafonds de §27.3, vérification avant le téléchargement |

### 27.8 Questions ouvertes (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-V1 | `N` essais avant effacement | 5, comme le partage |
| Q-V2 | Verrouillage | à la sortie de l'écran, en arrière-plan, et après 2 min sans geste |
| Q-V3 | Indice dans le lien (« gardable ») pour prévenir avant le déverrouillage | Non : note fixe pour tous (aucun changement de format, rien n'est révélé à qui voit le lien) |
| Q-V4 | Plafonds | 1 Gio par entrée, 2 Gio et 20 entrées au total |
| Q-V5 | Coffre sur ordinateur (PWA installée) | Non (téléphone seulement) ; la détection (`display-mode: standalone` et `pointer: coarse`) est un garde d'interface, pas une frontière de sécurité |
| Q-V6 | Hors-ligne | Coffre en ligne seulement dans une PWA (Q-C1 : pas de service worker) |

---

## 28. Code vérifiable (zéro confiance)

Risque visé : un serveur compromis sert un JavaScript modifié qui vole les clés (§2, §18.2). Le chiffrement de bout en bout ne vaut que ce que vaut le code qui le fait. But : que n'importe qui puisse prouver que les fichiers servis sont exactement ceux construits depuis le dépôt public, et que l'exploitant soit prévenu d'un écart. **Aucune de ces mesures n'empêche un serveur compromis de servir un code piégé à une victime choisie** sans que personne ne le voie (§28.8).

### 28.1 Builds reproductibles

- Node épinglé à la version exacte (`.node-version`, lu par `actions/setup-node`), `npm ci` sur le verrou commité, `SOURCE_DATE_EPOCH` = date du commit, `TZ=UTC`, `LANG=C.UTF-8`, `umask 022`. Aucun horodatage, chemin absolu ni valeur aléatoire dans `dist/` (`sourcemap: false` déjà). Les fichiers générés (polices, grain, aurore, icônes) sont commités, pas régénérés au build.
- La configuration de déploiement n'est jamais injectée dans les fichiers servis (ni `config.prod.js`, ni cadre de vérification, §26).
- Job CI `repro` : deux builds dans deux dossiers absolus différents, sur deux runners distincts, puis comparaison de `SHA256SUMS`. Toute différence fait échouer le job, qui est **obligatoire** pour une publication (jamais `continue-on-error`).
- **Identifiant de build obligatoire** : le numéro de version du pied de page vient de `SHH_BUILD_ID`, sinon de `git rev-parse --short=7 HEAD` ; 7 à 40 chiffres hexadécimaux minuscules, ramenés à 7. Sans identifiant valide, `vite build` (production et démo) **échoue** ; « dev » reste pour `vite dev` et les tests. L'image Docker exige `--build-arg SHH_BUILD_ID` (son contexte n'a pas de `.git`) et vérifie son format : elle porte donc le numéro du build public. La CI (`repro-docker`) compare tout `dist/` de l'image à ses propres builds, avec le même `SHH_BUILD_ID`.

### 28.2 Manifeste de version signé

- `web/scripts/release-manifest.mjs` (sans dépendance, `node:crypto`) écrit `release.json` : `{ "schema": 1, "name": "shhdrop-web", "version", "commit", "files": [{ "path", "size", "sha256" }] }`, fichiers triés par chemin (ordre des octets), JSON à clés ordonnées, fin de ligne LF ; et `SHA256SUMS` (format `sha256sum -c`). Deux manifestes : `dist/`, `dist-demo/`.
- **Où vit le manifeste** : le numéro de version du site est le commit lui-même (`SHH_BUILD_ID`, §28.1) ; un commit ne peut donc pas contenir le manifeste de son propre build. Le manifeste est écrit par `release.yml` et publié dans la Release seulement ; « build local = build CI » se prouve en reconstruisant le commit de l'étiquette et en comparant à `release.json` (deploy/README.md §3.3). Le manifeste de la production décrit `dist/` construit avec le compte (`SHH_SITE_COMPTES=1`, comme l'image) ; démo : Q-C3.
- **Workflow** (`.github/workflows/release.yml`) : la CI entière (`ci.yml` appelé par `workflow_call` : tests, e2e « le serveur ne voit rien », `repro`, `repro-docker`, `deploy-lint`), commit exigé dans `main`, site reconstruit et comparé aux empreintes du job `repro`, puis signature dans un job à part qui ne lance aucun code npm, revérifiée avec l'identité exacte de `deploy.sh`. cosign v3.1.4 épinglé par empreinte (deploy/provenance.sh, deploy/README.md §3.2). Dépôt : **`Skoow/shhgone`**.
- **Image du serveur** : sur la même étiquette, `release.yml` construit l'image deux fois, sur deux machines, par `deploy/construire-image.sh` (`SHH_BUILD_ID` = commit court, `SOURCE_DATE_EPOCH` = date du commit, dates réécrites, BuildKit v0.34.2 épinglé par empreinte, une plateforme, aucune attestation) et exige la même empreinte ; un job sans code npm, seul à avoir `packages: write`, compare le `/site` de l'image au manifeste, la pousse telle quelle (crane épinglé) sur **`ghcr.io/skoow/shhgone`**, vérifie qu'elle se lit sans identifiant (paquet public ; un premier paquet de compte personnel est privé : l'exploitant le rend public une fois, deploy/README.md §3.2), puis la signe sans clé (`cosign sign`, même identité exacte que le manifeste). Le job `signer` écrit et signe **`image.json`** (`{ "schema": 1, "name": "shhdrop-image", "version", "commit", "image": "ghcr.io/skoow/shhgone@sha256:…", "release.json": "<SHA-256 de release.json>" }`), publié dans la Release : c'est lui qui lie site et image. Le lien va d'`image.json` vers `release.json` (son SHA-256), pas l'inverse : `release.json` reste au schéma 1 (aucun changement du site, de `verify-site.mjs` ni de la page `/verifier`), et la liaison est aussi forte (même identité, octets exacts de part et d'autre).
- Workflow `release.yml` sur une étiquette `web-v<x.y.z>` : reconstruction, comparaison, puis signature **sans clé** par `cosign sign-blob --bundle release.json.sigstore.json` (jeton OIDC de GitHub Actions, certificat Fulcio, inscription dans le journal public Rekor). Publication dans la Release GitHub : `release.json`, son bundle, `SHA256SUMS` et l'archive `dist.tar.gz` déterministe (`tar --sort=name --mtime=@$SOURCE_DATE_EPOCH --owner=0 --group=0 --numeric-owner`, `gzip -n`). Permissions : `id-token: write` et `contents: write` dans ce seul job ; actions épinglées par empreinte.
- Vérification : `cosign verify-blob release.json --bundle release.json.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp '^https://github\.com/Skoow/shhgone/\.github/workflows/release\.yml@refs/tags/web-v[0-9]+\.[0-9]+\.[0-9]+$'` (`deploy.sh` donne l'identité exacte de la version, `deploy/provenance.sh`). Jamais d'expression ouverte (`.*`), jamais `--insecure-ignore-tlog`.
- Étiquettes `web-v*` protégées (règle de dépôt : création réservée au titulaire du dépôt). Ce que la signature prouve : « construit par ce workflow, depuis ce commit public ». Ce qu'elle ne prouve pas : que ce code est sain. Un compte GitHub volé peut signer une version piégée : elle sera publique et visible dans Rekor (détectable, pas empêché).
- Limite post-quantique : les signatures Sigstore sont en ECDSA P-256, forgeables par un futur ordinateur quantique ; migration quand Sigstore proposera ML-DSA (§30).

### 28.3 SRI sur chaque script et style

- Greffon Vite `sri` (une quarantaine de lignes, `node:crypto` SHA-384) : `integrity="sha384-…"` sur chaque `<script type="module">`, `<link rel="stylesheet">` et `<link rel="modulepreload">` de `index.html`, `s.html` et des pages d'information ; `check-dist.mjs` échoue si une balise de script ou de style de ces pages n'a pas d'`integrity`. **Exception, à faire** : le cadre PDF (`pdf-frame.html`) n'a pas encore d'empreinte : il vit dans une origine opaque, où une empreinte exigerait des en-têtes CORS sur ses deux fichiers ; il reçoit pourtant le PDF déchiffré.
- SRI ne couvre ni `import()` dynamique, ni `new Worker(url)`. Une carte d'import avec `integrity` exigerait un script en ligne, donc un hachage dans la CSP de chaque réponse : refusé. Règle : **aucun `import()` dynamique dans le build de production** (le QR est importé statiquement ; contrôle par `check-dist.mjs`) ; chaque Worker (Argon2id, D42-14 ; preuve de travail anti-robot, W3) a son script lu par `fetch` avec `integrity` (adresse et empreinte SHA-384 inscrites dans le script parent), puis lancé depuis un Blob (CSP `worker-src blob:` seul, audit R5 : aucun Worker lancé sur un fichier ; `server/internal/api/headers.go`) ; `check-dist.mjs` refuse tout script de Worker cité sans son empreinte ou orphelin. La démo ne lance pas de Worker anti-robot (preuve factice).
- Honnêtement : contre un serveur compromis, SRI seul ne protège rien (il modifie aussi `index.html`). Il réduit la vérification à un fichier : avec SRI, l'empreinte de `index.html` fixe tous les scripts et styles qu'il charge.

### 28.4 Vérificateur

- **Ligne de commande** : `web/scripts/verify-site.mjs <origine> <release.json>` (sans dépendance) télécharge chaque fichier listé depuis l'origine, avec `Cache-Control: no-cache`, compare SHA-256 et taille, vérifie que `/index.html`, `/`, `/s/x` et `/x` (repli monopage) rendent les mêmes octets que `index.html`. Code de sortie non nul au premier écart ou à la première erreur réseau (jamais « vert » sur une erreur). Mode d'emploi : `cosign verify-blob …` (§28.2), puis `node verify-site.mjs https://shhdrop.app release.json`.
- **Page codée** : section « Vérifier cette version » de la page Sécurité (25 novembre, décision du propriétaire : plus de page à part ni de lien séparé dans le pied de page), ouverte à son titre par les adresses `/verifier` et `/en/verifier`, gardées (Releases, deploy/README.md) ; « Version xxxxxxx », en bas du pied de page, y mène (web/src/routes/pages/content.ts, `VERIFIER_FR`, `VERIFIER_EN`), commandes avec l'identité exacte, limites (victime ciblée, en-têtes, apps natives). Écart : le site ne connaît pas son numéro de Release (construit avant l'étiquette) ; la page affiche le commit (`SHH_BUILD_ID`) et dit de chercher la Release dont le commit commence ainsi.
- **Page « Vérifier cette version »** (`/verifier`, mode Read, liée depuis Sécurité et le pied de page ; depuis le 25 novembre, section de la page Sécurité, voir ci-dessus) : numéro de version et commit, lien vers la Release GitHub et vers le mode d'emploi. Elle dit : « Cette page ne peut pas prouver sa propre intégrité : un serveur piégé pourrait la modifier aussi. Vérifiez avec un outil qui ne vient pas de ce site. » Elle n'affiche aucune empreinte calculée par elle-même (ce serait une preuve qui se certifie seule).
- **Plus tard** : l'application native (§16, D42-20), signée par les magasins : le code ne vient plus du serveur à chaque visite, c'est la défense la plus forte. Une extension de navigateur de vérification (à la manière de Code Verify) est possible mais coûteuse à maintenir (Q-C2). Proposition de norme à suivre : intégrité, cohérence et transparence des applications web (WAICT), en cours de discussion.

### 28.5 Ce qu'une PWA peut vérifier sans service worker

Rien de fiable. Sans service worker, chaque lancement recharge le code depuis le serveur ; un code piégé désactiverait tout contrôle qu'il porte lui-même, et la page ne peut pas joindre GitHub (`connect-src 'self'`, aucune ressource tierce). L'absence de service worker (§10) ne protège pas d'un serveur compromis : il peut enregistrer **son propre** service worker, que notre choix n'empêche pas. Correctif proposé pour le plan d'incident (§15.5) : servir un `sw.js` qui se désinscrit lui-même et `Clear-Site-Data: "cache"` (sans `"storage"`, qui viderait les coffres).

### 28.6 Service worker minimal d'épinglage : écarté

Aucun service worker d'épinglage (Q-C1) : le site reste sans service worker (§10). Un tel service worker ne garantissait rien face à un serveur compromis (qui remplace `sw.js` lui-même), ajoutait du code qui persiste et ne servait qu'au coffre hors ligne (§27.5). Les applications natives (D42-20) restent la défense contre un serveur qui servirait un autre code.

### 28.7 Effets sur le déploiement

- `deploy.sh` télécharge l'archive, `release.json` et son bundle depuis la Release, exécute `cosign verify-blob` (identité exacte de §28.2) et `sha256sum -c`, décompresse dans `SHH_STATIC_DIR` (volume en lecture seule), puis lance `verify-site.mjs` contre `https://shhdrop.app` à travers Caddy, et revient en arrière au premier écart. Aucune option pour sauter la vérification.
- **Adapté à l'image** (le site est dans l'image, `/site`, pas sur un volume) : `deploy.sh sha256:<empreinte> <x.y.z> <commit>` (commit : V3 ci-dessous) vérifie la signature de `release.json` (cosign épinglé par empreinte, identité exacte `…/release.yml@refs/tags/web-v<x.y.z>`), puis exige que le `/site` de l'image redonne ce manifeste octet pour octet (recalculé en shell, `deploy/provenance.sh`, sans Node ni analyseur JSON sur le serveur), **avant** tout démarrage ; après le démarrage, le contrôle de santé lance `verify-site.mjs` à travers Caddy (Node de l'image épinglée du Dockerfile) et un écart ramène la version précédente. Aucune option. Banc d'essai sans réseau : `deploy/test-provenance.sh`. Ce qui n'a pu être essayé qu'en CI ou sur le serveur : la vraie signature Sigstore (Fulcio, Rekor), `docker run --add-host` avec `--network host`.
- **Verrous de mise en ligne (`deploy/verrous.sh`, deploy/README.md §3.5)**, contre un compte GitHub volé dont le code piégé, signé par `release.yml` comme tout autre, serait installé par erreur. Tous obligatoires, sans option : **V1**, le commit du manifeste signé est dans la copie du dépôt du serveur et signé (SSH) par une clé de `/etc/shhdrop/signataires-autorises` (root, 0644 au plus), ainsi que chaque commit depuis le commit installé, fusions comprises (`%G?` = `G` ; gpg désactivé pour la vérification : une modification faite sur le site de GitHub, signée par sa clé GPG, est refusée) ; **V2**, le commit installé (`/etc/shhdrop/commit-installe`, écrit seulement après une installation réussie, jamais abaissé par un retour arrière) est un ancêtre du nouveau ; à la première installation sous verrous, V1 seul, annoncé ; **V3**, le commit complet est donné en argument (`deploy.sh sha256:<empreinte> <x.y.z> <commit>`), tiré de la conversation de développement, et doit être celui du manifeste ; un résumé borné des changements (`git log --oneline`, `git diff --stat`) est affiché avant l'installation. La copie vérifiée est celle de `deploy.sh` ; elle n'est mise à jour que par `git fetch` (jamais `git pull`, qui ferait tourner un `deploy.sh` non vérifié) : le `deploy.sh` du commit installé vérifie, avance la copie (`git merge --ff-only`) puis relance celui du nouveau commit, qui refait tout. Aucun accès réseau ajouté ; le serveur n'a aucun accès en écriture à GitHub. Signataire autorisé : la clé de développement `shhgone-dev` (`SHA256:32dP45eSMmVSt/G/CGvcxl/P+MO3Nwj9xeTh/GSA2wc`). **Limite** : cette clé est partagée par l'environnement de développement ; qui contrôle à la fois le compte GitHub et cet environnement peut signer. **V4**, la clé personnelle de l'exploitant (ligne `proprietaire` du même fichier), fermera ce cas : prévue, pas encore exigée. Banc d'essai : `deploy/test-verrous.sh` (dépôt et clés SSH temporaires, `make lint-deploy`).
- Caddy ne modifie aucun corps de réponse (ni `templates`, ni réécriture) ; la compression ne change pas les octets décompressés.
- Surveillance externe : workflow GitHub planifié (toutes les heures) qui lance `verify-site.mjs` contre la production et l'origine de vérification et ouvre une alerte au premier écart (`.github/workflows/verifier-site.yml`) : contre les trois dernières Releases signées (le temps d'une mise en ligne ou d'un retour arrière ; un retour à l'une d'elles passe sans alerte, le journal le dit), alerte = échec du workflow (e-mail de GitHub), inactif sans `SHH_SONDE_HOTE`. Limite : il ne voit que ce que le serveur lui sert ; un serveur qui ne piège que certaines victimes (adresse IP, navigateur) passe inaperçu.
- Image du serveur : build Go `-trimpath -buildvcs=false`, `CGO_ENABLED=0`, image épinglée par empreinte (D3) et attestée par cosign (§28.2) : construite par `release.yml` (deux builds, même empreinte), publiée sur `ghcr.io/skoow/shhgone`, signée sans clé, liée au manifeste par `image.json` signé. **Avant tout téléchargement de l'image**, `deploy.sh` vérifie les signatures de `release.json` et d'`image.json` (identité exacte), recalcule `image.json` de l'empreinte donnée en argument et l'exige identique octet pour octet, puis `cosign verify ghcr.io/skoow/shhgone@<empreinte>` (même identité et émetteur exacts, journal exigé) ; `SHH_IMAGE_REPO` vaut `ghcr.io/skoow/shhgone` et toute autre valeur est refusée ; aucune option pour sauter (banc d'essai : `deploy/test-provenance.sh`, imitations de cosign, curl et docker). Les binaires du serveur et de `shhcheck` sont donc prouvés comme le site. Le serveur n'est pas de confiance pour le contenu (chiffrement de bout en bout) : cette attestation sert l'exploitation, pas la confidentialité. **Prouvé seulement à la première Release** : reproductibilité sur les machines de GitHub (essayée sur un poste : deux builds sans cache, même archive OCI), signature sur ghcr.io (cosign v3, référents OCI ou étiquette de repli), lecture sans identifiant, hôtes de Sigstore joignables depuis le serveur.

- **Préproduction (deploy/README.md §15)** : tant que le site n'est pas ouvert, `SHH_PREPROD=1` met une barrière dans Caddy (le public ne reçoit que la page de maintenance, 503 ; accès de l'exploitant par un lien secret qui pose un témoin) et `deploy/preprod.sh <commit>` installe une version de développement construite sur le serveur, verrous V1 à V3 gardés mais **sans** la vérification de provenance de ce paragraphe (risque C8, §28.8). `deploy.sh` reste utilisable et garde la barrière.

### 28.8 Lentilles et limites

| # | Gravité | Endroit | Problème | Correction (intégrée) |
|---|---|---|---|---|
| C1 | Élevée | `cosign verify-blob` | Une identité en expression ouverte accepte la signature de n'importe quel workflow GitHub | Expression ancrée, workflow et étiquette exacts |
| C2 | Élevée | `deploy.sh` | Une option « sauter la vérification » finirait utilisée en urgence | Aucune option ; échec = retour arrière |
| C3 | Élevée | Service worker | Installer en cache un fichier non vérifié | Sans objet : pas de service worker (§28.6) |
| C4 | Moyenne | Job `repro` | Non bloquant, il ne prouve rien | Obligatoire pour la Release |
| C5 | Moyenne | Vérificateur | Vert sur une erreur réseau, ou fichiers en plus non vus | Code non nul ; limite écrite : le repli monopage empêche d'énumérer des fichiers en plus, on vérifie que tout chemin inconnu rend `index.html` |
| C6 | Moyenne | SRI | `import()` et `Worker` hors SRI | Pas d'`import()` en production ; Worker couvert par le manifeste |
| C7 | Faible | Page `/verifier` | Une page qui certifie sa propre empreinte | Aucune empreinte affichée, texte honnête |
| C8 | Élevée tant qu'elle dure, nulle après | Préproduction, `deploy/preprod.sh` (deploy/README.md §15) | L'image est construite sur le serveur depuis un commit de développement : ni signature Sigstore, ni build de `release.yml` comparé, ni manifeste signé ; une version servie ainsi au public n'aurait aucune provenance prouvée, et la surveillance horaire (`verifier-site.yml`) ne vérifie rien tant qu'elle voit la page de maintenance | Accepté seulement derrière la barrière (`SHH_PREPROD=1` exigé, aucun utilisateur ni donnée réelle) ; verrous V1 à V3 gardés ; `deploy.sh` (Release signée) reste le seul chemin pour ouvrir : ouverture = `SHH_PREPROD` retiré, `deploy.sh` avec la Release `web-v1.0.0`, branches « préproduction » des workflows retirées |

Limite résiduelle assumée (§18, point 13) : une victime ciblée par un serveur compromis reçoit un code piégé ; la vérification publique ne la protège que si elle vérifie elle-même, avant d'utiliser le site, avec un outil qui ne vient pas du site.

### 28.9 Questions ouvertes

| # | Question | Défaut recommandé |
|---|---|---|
| Q-C1 | Service worker minimal d'épinglage (§28.6) | **Écarté** : aucun service worker |
| Q-C2 | Extension de navigateur de vérification | Non en V1 ; application native d'abord (§16) |
| Q-C3 | Démo signée elle aussi | Oui (même workflow, coût nul). **Pas fait** : Pages publie chaque commit vert de `main`, pas les étiquettes ; un manifeste signé ne décrirait pas la démo servie. À décider : publier la démo depuis `release.yml`, ou y renoncer (la démo n'a ni serveur ni données réelles). |

---

## 29. Format v2 et chiffrement anticipé (« au plus 5 s d'attente »)

Format de tout nouveau partage (remplace les clés et le paquet de §7.1 à §7.3). Étiquettes `shhdrop/v2/`. Aucune construction maison : HKDF-SHA-256, HMAC-SHA-256, SHA-256, Argon2id (moteur Rust, RustCrypto) et AES-256-GCM (WebCrypto), D42-21.

### 29.1 Ce qui attend vraiment, en chiffres

- **Chiffrer n'est pas le goulot** : AES-256-GCM dans WebCrypto passe par l'accélération matérielle, de l'ordre de 1 à 3 Go/s sur ordinateur et de 0,3 à 1 Go/s sur téléphone récent ; chaque bloc est chiffré pendant l'envoi du précédent.
- **Argon2id** (64 Mio, 3 passes) : de 0,3 à 1,5 s selon l'appareil ; calculé pendant la composition, il ne bloque pas le clic.
- **Le réseau est de la physique** : 1 Go à 100 Mbit/s en montée prend environ 80 s (1 Gio environ 86 s) ; à 20 Mbit/s (4G courante), environ 7 min ; à 500 Mbit/s (fibre), environ 17 s. Aucun choix de chiffrement ne réduit ce temps.
- **Principe** : l'envoi chiffré commence **pendant la composition**, avant tout mot de passe ; Argon2id du mot de passe généré se calcule pendant la composition. Au clic sur « Envoyer », il ne reste que : enveloppe de la clé (quelques millisecondes), envoi de ce qui n'est pas encore parti (au plus 2 segments de 4 Mio, plus ce que le réseau n'a pas encore absorbé), `finalize`. Cible : **≤ 5 s après le clic quand l'envoi anticipé a rattrapé la composition**, soit environ 1,5 s à 50 Mbit/s et 3,5 s à 20 Mbit/s ; au-dessous d'environ 15 Mbit/s, ou si l'on clique avant que l'envoi ait rattrapé, l'attente est celle du réseau, affichée honnêtement (§9.4 UI).
- « Tout chiffrer sur notre serveur, sans calcul sur l'appareil » est impossible en chiffrement de bout en bout : le serveur verrait le contenu en clair. Le chiffrement reste dans le navigateur, rendu invisible.

### 29.2 Clés

| Élément | Création | Où il vit |
|---|---|---|
| `K_lien` | 32 octets aléatoires, tirés au début de l'envoi anticipé | après le `#` du lien (§32) ; jamais envoyé |
| `id` | HKDF(`K_lien`, « shhdrop/v2/id »), 16 octets | navigateur seulement : données authentifiées de `E` (→ tâche K2, §29.8 : jamais envoyé ; le serveur tire son propre identifiant interne) |
| `K_accès`, `V_accès` | HKDF(`K_lien`, « shhdrop/v2/acces »), SHA-256(`K_accès`) | envoyé / serveur |
| `R` (graine de contenu) | 32 octets aléatoires, tirés au début de l'envoi anticipé | navigateur ; mis à zéro après l'enveloppe, ou à l'abandon |
| `K_contenu` | HKDF(`R`, « shhdrop/v2/contenu »), AES-256-GCM, non extractible | navigateur |
| `C_engagement` | HMAC-SHA-256(`R`, « shhdrop/v2/engagement ») | en-tête en clair « SHH2 » |
| `S_gestion`, `V_gestion` | 32 octets aléatoires, SHA-256 | lien de gestion (§32) / serveur |
| `sel` | 16 octets aléatoires, tirés au début de l'envoi anticipé | serveur (renvoyé par `meta`) |
| `K_mdp` | Argon2id(mot de passe NFC, `sel`) : 64 Mio, 3 passes, 1 fil, 32 octets ; à l'ouverture, blancs ASCII de bord retirés avant NFC (D42-21) | navigateur |
| `K_maître` | HKDF(`K_lien` ‖ `K_mdp`, « shhdrop/v2/maitre ») | navigateur |
| `K_env` | HKDF(`K_maître`, « shhdrop/v2/enveloppe »), AES-256-GCM | navigateur |
| `K_preuve`, `V_preuve` | HKDF(`K_maître`, « shhdrop/v2/preuve »), SHA-256(`K_preuve`) | envoyé pour déverrouiller / serveur |
| `E` (enveloppe) | `nonce` (12 octets aléatoires) ‖ AES-256-GCM(`K_env`, `nonce`, `R`, données authentifiées = « shhdrop/v2/enveloppe-ad » ‖ `id` ‖ en-tête de 48 octets), 60 octets ; préfixe des données authentifiées distinct de l'info HKDF de `K_env` (revue K1, m2 : une étiquette, un usage) | serveur ; rendue seulement après un déverrouillage réussi |

À l'ouverture : `unlock` réussi → `E` → `K_env` (lien + mot de passe) → `R` → contrôle de `C_engagement` (`crypto.subtle.verify` HMAC) → `K_contenu` → lecture.

### 29.3 Paquet v2

- En-tête « SHH2 », version 2, `C_engagement` (48 octets). Clair du paquet de `B` morceaux : **données** (éléments dans l'ordre d'ajout, à partir de l'octet 0) ‖ zéros ‖ **manifeste** ‖ longueur du manifeste (4 octets) en toute fin. Le manifeste (JSON v2, §34) donne la position de chaque élément ; l'ordre d'affichage y est indépendant de l'ordre d'ajout, donc renommer ou réordonner ne touche pas les données déjà parties.
- Morceaux, nonces, données authentifiées, segments de transport : inchangés (§7.3, principe STREAM). **Chaque numéro de morceau n'est chiffré qu'une fois par `R`** ; un segment réessayé renvoie les mêmes octets.
- **Palier canonique v2** : le plus petit palier de capacité ≥ fin des données + 4 + `MANIFEST_MAX` (64 Kio). La longueur réelle des noms n'influence donc pas le palier ; `CONTENT_MAX` est inchangé.
- **Réserve du manifeste et paliers** : `MANIFEST_MAX` = 65 532 octets, pour que le manifeste et sa longueur tiennent dans **un morceau** de 64 Kio, le dernier du paquet. Palier canonique = plus petit palier dont la capacité ≥ fin des données + 64 Kio. Un partage de texte seul (aucune donnée de fichier) prend le **palier 1** (64 Kio). Les quotas d'octets (§4, §24) comptent les données utiles d'un palier, (palier − 1) × 64 Kio : 0 pour le palier 1. Le manifeste tient dans le dernier morceau, donc le bourrage, s'il existe, se termine juste avant le dernier segment.
- **Paliers** : `[1, 16, 80, 160, 400, 800, 1600, 4000, 8000, 16385, 32769]` morceaux pour le gratuit ; `CONTENT_MAX` = 2 147 483 648 octets ; le plus grand palier gratuit fait **32 769 morceaux** (2 Gio de données + le morceau du manifeste, 513 segments dont le dernier d'un morceau), fichier chiffré de 48 + 32 769 × 65 552 = 2 148 073 536 octets ; le palier de 16 385 morceaux (1 Gio de données) est un palier intermédiaire. Paliers payants : §38.8.1.
- **Notes, éléments chiffrés (D41-37)** : le texte d'une note (UTF-8) n'est plus dans le manifeste mais est la **donnée d'un élément**, chiffrée sous sa propre clé `K_élément` (§41.14) comme un fichier, placée et empaquetée de même (H-2, emprise en puissance de deux). Entrée du manifeste : `{kind: "text", name, mime, size, offset, k}`, sans `text` ; `TEXT_MAX` = **100 000 points de code** (au plus 400 000 octets). Le lecteur déchiffre et authentifie le texte à l'ouverture (UTF-8 strict, au plus `TEXT_MAX`, sinon `paquet_corrompu`). **Rétrocompatibilité** : une entrée `text` sans `k` (ancien format, `size` = `offset` = 0) reste lue. Aucune cryptographie nouvelle.
- **Bourrage rempli par le serveur** : les segments entièrement compris entre le dernier segment de données et le segment de fin ne sont pas envoyés ; à `finalize` (brouillon, §41.14), le serveur remplit **tout morceau manquant** du palier final d'octets aléatoires (`crypto/rand`), indiscernables d'un chiffré pour qui lit le disque, dans la borne de D42-17. Le lecteur ne lit jamais le bourrage (§7.3). Gain : jusqu'à la moitié de l'envoi en moins.
- **Empreinte des fichiers** : chaque entrée de fichier du manifeste peut porter `sha256`, l'empreinte SHA-256 des octets envoyés (64 chiffres hexadécimaux minuscules), calculée sur l'appareil de l'expéditeur et écrite après `clean`. Champ **facultatif** : un ancien lecteur l'ignore, un ancien manifeste n'en a pas ; à la lecture, une valeur mal formée ou portée par une note est ignorée ; à l'écriture, le moteur refuse une valeur mal formée et n'en écrit jamais pour une note. Si les empreintes font dépasser `MANIFEST_MAX`, le partage part sans elles. Vecteurs communs : `engine/vectors/v2-empreinte.json` (lecture et écriture octet pour octet), utilisables tels quels par les apps.
- **Nom du partage** : le manifeste peut porter `title`, nom choisi par l'expéditeur, écrit après `keep_ttl_h` et avant `items` (ordre de `JSON.stringify`). Champ **facultatif**, chiffré comme le reste du manifeste sous `K_contenu` : le serveur ne le voit jamais. Nettoyage du moteur (`manifest::clean_title`), le même à l'écriture et à la lecture : toute espace Unicode devient une espace ; commandes (C0, DEL, C1) et `Default_Ignorable_Code_Point` retirés (inversions et isolats de sens, LRM, RLM, ALM, largeur nulle, BOM, étiquettes), sauf U+200D et U+FE0F (emoji) ; NFC ; espaces regroupées et rognées. `TITLE_MAX` = **80 points de code** après nettoyage : au-delà, le scellement refuse (`titre_trop_long`) ; vide après nettoyage, rien n'est écrit. À la lecture, absent, mal typé, vide après nettoyage ou trop long : aucun titre, **jamais une erreur** ; un ancien lecteur l'ignore (champ inconnu ; vérifié le 19 novembre avec le moteur d'avant ce changement sur les 25 manifestes des vecteurs). Le destinataire le voit en texte brut seulement, isolé par `<bdi>`, jamais dans le titre de l'onglet (il entrerait dans l'historique du navigateur). Vecteurs communs : `engine/vectors/v2-titre.json` (nettoyage, lecture tolérante, écriture octet pour octet, scellement), produits par le moteur Rust et rejoués par le site.
- **Nom du partage, interface** : champ « Nom du partage (facultatif) » en tête des options, aide « Vu par le destinataire, chiffré comme le reste. » ; chez le destinataire, le nom devient le titre de la page de contenu (après le déverrouillage seulement), en texte brut isolé par `<bdi>`, jamais dans le titre de l'onglet ; sur « Lien prêt », en tête des informations du partage ; dans l'historique local (§33). Vecteurs : `engine/vectors/v2-titre.json`. Le comptage est en points de code (pas en graphèmes) pour rester identique partout ; le champ du site borne à 80 unités UTF-16, et le composeur compare NFC(saisie) à `TITLE_MAX` avant le moteur (un nom de 80 points de code peut en compter plus après NFC : U+0344, U+0958…). Les apps passent par le même moteur Rust (tables NFC de `unicode-normalization`, liste `est_ignorable`).

### 29.4 Envoi anticipé

1. **Démarrage** : composition non vide et stable depuis 2 s, page visible, en ligne, (condition abandonnée le 24 novembre, Q-K2), preuve anti-robot disponible (pré-calculée, UI §9.4.2). `POST /api/shares` : palier, preuve anti-robot ; `K_accès` et `S_gestion` en en-tête (§29.8). Ni durée, ni ouvertures, ni sel, ni `V_preuve` à ce stade.
2. **Pendant la composition** : chaque segment dont les 64 morceaux sont des données complètes est chiffré puis envoyé. Ajouter un élément qui tient dans le palier : il est ajouté à la suite. Renommer, réordonner : rien à refaire. Modifier une note (D41-37 : élément comme un fichier) : l'ancienne version est retirée comme un fichier retiré, la nouvelle envoyée sous une clé neuve.
3. **Redémarrage** (nouveaux `K_lien`, `R`, `sel`, nouveau partage ; l'ancien est détruit par `S_gestion` en `keepalive`) quand : un élément dont un morceau a déjà été chiffré est retiré ou remplacé (sinon le destinataire pourrait déchiffrer un élément retiré, puisqu'il recevra `R`), ou la composition dépasse le palier réservé. Au plus 3 redémarrages par 10 min ; au-delà, l'envoi attend le clic.
4. **Au clic sur « Envoyer »** : `K_mdp` (déjà calculé pour le mot de passe généré ; sinon, Argon2id au plus tard une seconde après la dernière frappe), `K_maître`, `K_env`, `K_preuve`, `E` ; chiffrement et envoi du dernier segment de données et du segment de fin (manifeste) ; `POST finalize` : `sel`, `kdf_ops`, `kdf_mem`, `V_preuve`, `E`, durée, ouvertures, puis, depuis D41-19, palier final, en-tête et manifeste chiffré (`bucket`, `header`, `tail`, `void`, §41.14 ; seule forme depuis le retrait de l'ancienne, H-5). Le serveur remplit d'aléa les morceaux manquants (dans la borne de D42-17, sinon 409 `incomplete`), écrit l'en-tête et le manifeste, passe en `ready` et fixe `expires_at` (inchangé : à partir de la fin de l'envoi).
5. **Abandon** (page quittée, liste vidée, onglet tué) : `R` n'est jamais enveloppée et disparaît avec la page : le chiffré déjà envoyé n'est plus déchiffrable par personne (effacement cryptographique). Le partage est détruit en `keepalive` quand c'est possible, sinon effacé par les règles existantes (aucun segment en 5 à 20 min, 15 min sans segment, échéance de 3 h, §7.4).
6. Le serveur apprend qu'une composition est en cours et voit arriver les segments.

### 29.5 Quotas et anti-abus

- Les quotas de la §4 (3 liens par jour et par connexion, 10 par /48, 6 Gio utiles par jour, 12 Gio par /48) sont **débités à `finalize`** ; la création est refusée s'ils sont déjà atteints.
- Nouveaux plafonds pour les envois anticipés : au plus 2 envois non finalisés à la fois par connexion (6 par /48) ; **octets abandonnés** (envois effacés sans `finalize`) : 12 Gio par jour et par connexion, 24 Gio par /48, débités à l'effacement ; au-delà, l'envoi anticipé est refusé (429) et l'écran revient à l'envoi au clic. La place reste réservée à la création (plafond global, §4).
- **Mise en œuvre** : les quotas journaliers comptent, à la création, les partages finalisés **et** les envois en cours de la connexion (réservation) ; un envoi effacé sans `finalize` libère sa réservation et ses octets passent dans le compteur des octets abandonnés. Le compteur se remet à zéro à minuit UTC avec le secret du jour, envois en cours compris (remplacé par D42-1, complété le 11 novembre : un envoi de la veille finalisé après minuit compte dans le jour où il finit).
- **Note de menace (acceptée)** : pour appliquer « 2 envois non finalisés à la fois » et les octets abandonnés, le serveur garde **en mémoire seulement** la correspondance « id d'un envoi en cours → clés HMAC de la connexion » (jamais sur disque), retirée à `finalize` ou à l'effacement. Quelqu'un qui lit la mémoire du serveur en marche peut relier un envoi en cours à une adresse IPv4 (le secret du jour est aussi en mémoire et l'espace IPv4 se parcourt) ; il voit de toute façon les adresses en direct (§18.3).
- La difficulté de la preuve de travail compte toutes les créations de l'heure (finalisées ou non) : les redémarrages sont bornés (point 3).

### 29.6 Pré-lecture chez le destinataire

- La pré-lecture démarre à la réponse de `meta`, à calendrier fixe, jamais au rythme des frappes (§36 S10). Pendant la saisie du mot de passe, le navigateur télécharge les segments chiffrés avec `K_accès` seul : `GET /segments/{n}` avec l'en-tête `K_accès`, accepté **seulement en état `ready`**, avant l'expiration, sans consommer d'ouverture. Ordre : segment de fin (manifeste), puis les premiers segments de données, jusqu'à 64 Mio.
- Sûr parce que `R` est aléatoire : sans `E`, rendue seulement après un `K_preuve` juste, le chiffré ne permet **aucun** essai hors ligne de mot de passe (en v1, `K_contenu` dérivait du mot de passe : la même pré-lecture aurait permis de deviner hors ligne à partir de `C_engagement`).
- Bande passante : budget de pré-lecture par partage, en mémoire, de 2 × la taille du palier sur toute sa vie ; au-delà, 429. Les segments pré-lus comptent dans la limite de 600 par minute.

### 29.7 Analyse des menaces de la v2

| Adversaire | v2 |
|---|---|
| Voleur de la base et des fichiers, sans le lien | Rien : `K_lien` 256 bits |
| Voleur de la base **et** du lien | Un Argon2id par mot de passe essayé, contre `V_preuve` ou `E` : même coût qu'en v1 (§31 pour le mot de passe par défaut) |
| Détenteur du lien seul (sauvegarde de messagerie) | Pré-lecture du chiffré, inutile sans `E` ; en ligne, 5 essais puis destruction (inchangé) |
| Serveur malveillant | N'a ni `K_lien`, ni `K_mdp`, ni `R` ; ne peut fabriquer ni `E` (il lui faudrait `K_env`) ni un paquet pour plusieurs clés (`C_engagement`) ; échanger `E` ou le chiffré d'un autre partage échoue (`id` et en-tête authentifiés) |
| Serveur qui observe les envois | **Nouveau** : l'ordre et l'heure des segments donnent la taille du contenu à 4 Mio près, et le fait qu'une composition est en cours ; en v1, il ne connaissait que le palier. Limite assumée, à ajouter à §18 |
| Abandon | Chiffré indéchiffrable (`R` oubliée) puis effacé |
| `R` en mémoire | Elle vit dans la page pendant la composition, comme les fichiers en clair eux-mêmes : aucune exposition nouvelle |
| Destinataire malveillant, après un nettoyage ou un retrait (vérifié le 12 novembre) | Un fichier parti en envoi anticipé puis nettoyé (contenu remplacé) ou retiré n'est plus lisible. Son élément est abandonné : graine `k` oubliée (`forget`), jamais écrite dans le manifeste ; la version nettoyée repart sous une graine neuve, à une place neuve. Les segments entiers déjà partis sont effacés par `erase` : la finalisation échoue (« réseau ») tant qu'un effacement n'a pas abouti. Les morceaux d'un petit élément sont remplacés par le serveur à la finalisation (`void`, au plus `MAX_VOID` plages ; au-delà, chiffrés sous une graine oubliée). Test `web/e2e/clean-leak.test.ts` : toutes les graines tirées pendant le test, celles des originaux comprises, sont essayées sur tous les morceaux du flux stocké ; le repère des originaux n'apparaît nulle part (le témoin le retrouve pendant l'envoi anticipé). Rien n'a donc été changé : ni envoi retardé, ni nouvelle `R` |

### 29.8 API (remplace les lignes concernées de §8)

| Route | Changement |
|---|---|
| `POST /api/shares` | Corps : `bucket`, preuve anti-robot (ni `id`, ni vérificateur : champ inconnu → 400). En-têtes `X-Shh-Access` (`K_accès`) et `X-Shh-Manage` (`S_gestion`), 43 caractères chacun ; le serveur calcule `access_v` et `manage_v` (SHA-256) et tire l'`id` interne (128 bits, `crypto/rand`). `access_v` ou `manage_v` déjà présent → 400 `bad_request` (même corps qu'une création invalide), **compté au quota** de créations et dans la difficulté anti-robot : seul qui connaît `K_accès` ou `S_gestion` peut le provoquer |
| `PUT /api/shares/segments/{n}`, `POST /api/shares/finalize` | Jeton d'envoi, qui désigne le partage. Corps de `finalize` : `salt`, `kdf_ops`, `kdf_mem`, `proof_v`, `envelope`, `ttl_hours`, `max_opens`, `bucket`, `header`, `tail`, `void` facultatif (§41.14 ; longueurs exactes, JSON strict ; `fill_from`, `fill_to` retirés le 24 novembre, H-5 : champs inconnus, 400) |
| `GET /api/shares/meta`, `POST /api/shares/unlock`, `POST /api/shares/destroy` | `K_accès` en en-tête : partage trouvé par `access_v` (index unique). Réponse d'`unlock` : jeton de téléchargement **et** `envelope` (et `grant`, puis `opens_left` depuis les retours UI4 : ouvertures encore possibles après celle-ci, déjà connues par `meta` ; puis `last_open` depuis la revue D42-22 : 1 seulement pour la dernière ouverture permise, n = `opens_issued`, sinon 0 ; **entier 0 ou 1, jamais un booléen** (audit du 12 novembre, D2 : `true` et `false` n'ont pas la même longueur, qu'un observateur du trafic chiffré mesurerait ; le client refuse toute autre valeur, §36 S62). **Ce que cela révèle (relecture du 12 novembre)** : avec D42-22, une personne qui revient lit `opens_left` et `last_open` à jour, donc apprend si quelqu'un a ouvert le partage après elle, et combien de fois ; seulement à qui détient lien, mot de passe et octroi, et c'est déjà ce qu'elle verrait par `meta` sur un partage encore `ready`) |
| `GET /api/shares/segments/{n}`, `POST /api/shares/done` | Jeton de téléchargement, qui désigne le partage (pré-lecture par `K_accès`, §29.6 : non livrée, même règle le jour venu) |
| `GET /api/manage/status`, `POST /api/manage/destroy` | `S_gestion` en en-tête, corps vide, recherche par `manage_v` (index unique) ; remplacent `GET /{id}/status` et la destruction par `S_gestion` (§32). Anciennes routes avec `{id}` → 404 |

Table `shares` : `proof_v`, `salt`, `kdf_*`, `ttl_hours`, `max_opens` deviennent `NULL` jusqu'à `finalize` ; colonne `envelope` (60 octets) ; index uniques sur `access_v` et `manage_v` ; `id` = identifiant interne tiré par le serveur (clé primaire, nom du fichier, sujet des jetons), sans lien avec l'`id` du client. À `finalize`, `segments_mask` passe à « tous reçus » (la frontière du bourrage n'est pas gardée, revue K1, I3) ; un seul `finalize` à la fois par `id` (verrou en mémoire), un appel concurrent répond aussitôt 503 `busy` sans rien écrire (revue K1, I1).

**Oracle d'existence fermé (revue K1, I2, option a)** :
- L'`id` du client (HKDF de `K_lien`) ne sert plus qu'aux données authentifiées de `E` ; il n'est **jamais envoyé** (vérifié par « le serveur ne voit rien », qui le fouille comme un secret). Il ne permet donc plus de désigner un partage : aucune adresse de l'API n'en porte, ni d'ailleurs aucun identifiant.
- Toute requête qui désigne un partage prouve un secret : un jeton signé par le serveur (envoi, lecture), `K_accès` (`meta`, `unlock`, `destroy` du destinataire, et **création**) ou `S_gestion` (gestion, et **création**). Le serveur cherche par SHA-256 de ce secret (index uniques), jamais par une valeur fournie telle quelle.
- La création ne peut donc heurter un partage existant que si son auteur connaît `K_accès` ou `S_gestion` du partage (même lien envoyé deux fois) : il le connaît déjà. Qui ne connaît qu'un `id`, ou un vérificateur lu dans une base volée, obtient exactement les mêmes réponses que le partage existe ou non (test `TestCreateCannotProbeExistence`).
- Inchangés : limites de débit et quotas (le doublon reste compté), 5 essais puis destruction (même compteur pour `unlock` et `destroy`), budget de lecture par ouverture (lié à l'`id` interne et au n° d'ouverture du jeton), un seul `finalize` à la fois par partage.
- Recherche par empreinte et temps constant : l'index compare `SHA-256(secret)` aux valeurs stockées ; la durée de la recherche ne dépend que de cette empreinte, que l'attaquant calcule lui-même, et ne révèle rien de `K_accès` d'autrui (préimage). `K_preuve` reste comparée en temps constant (`subtle.ConstantTimeCompare`).
- Coût honnête : `K_accès` et `S_gestion` transitent par le serveur dès la création (au lieu de leurs empreintes). Ce sont des secrets d'accès au serveur, qu'il voit de toute façon à chaque `meta` ou `manage/status` ; ils ne donnent ni le contenu ni `E`, et ne sont jamais écrits (mêmes tests).
- Administration : `shhdrop admin destroy -` lit le lien signalé, en tire `K_accès` (HKDF-SHA-256, sel vide, « shhdrop/v2/acces ») et cherche par `V_accès` (§15.3).

Le test « le serveur ne voit rien » ajoute un repère de mot de passe saisi **après** le début de l'envoi anticipé, et vérifie qu'aucune requête ne porte `R`, `K_contenu`, `K_mdp` ni `K_lien`.

---

## 30. Revue post-quantique

- **Contenu** : aucune cryptographie à clé publique ne le protège. AES-256 garde environ 128 bits de sécurité face à l'algorithme de Grover ; HKDF-SHA-256, HMAC-SHA-256 et Argon2id restent adaptés. `K_lien` et `S_gestion` font 256 bits pour cette raison : ne pas les raccourcir (§32).
- **Transport** : TLS protège `K_accès`, `K_preuve`, `E` et le chiffré, jamais `K_lien` ni le mot de passe. Un enregistrement « stocker maintenant, déchiffrer plus tard » ne donnerait donc pas le contenu, mais des métadonnées et des secrets d'accès. Défense en profondeur : **échange de clés hybride X25519MLKEM768 obligatoire** sur Caddy (proposé par défaut par Go 1.24 et plus, et par Caddy 2.10 et plus ; écrit explicitement dans le Caddyfile, `curves x25519mlkem768 x25519`). Repli X25519 seul accepté pour les navigateurs qui n'ont pas encore l'hybride (Q-PQ1). **Test du déploiement** : un client Go limité à `CurvePreferences: [X25519MLKEM768]` se connecte et `ConnectionState().CurveID` vaut `X25519MLKEM768` ; il bloque la mise en ligne.
- **Passkeys du coffre** (§27) : la sortie PRF est un HMAC calculé dans l'authentificateur, donc symétrique ; les signatures ECDSA de la passkey ne protègent rien ici.
- **Signatures de version** (§28.2) : ECDSA, donc à migrer vers une signature post-quantique quand Sigstore la proposera.
- **Q-PQ1** : refuser les connexions sans hybride ? **Non** : x25519 reste accepté en repli ; pas de TLS « hybride seulement » (Safari et Firefox anciens resteraient sinon exclus).

---

## 31. Mot de passe généré

- **Toujours généré** (D41-15) : la création n'accepte que la forme générée (`isGeneratedPassword`) ; « Générer un autre » et « Copier », aucune saisie. À l'ouverture, tout mot de passe non vide est accepté (anciens alphabets et longueurs compris).
- **Forme** : **11 caractères**, alphabet de **63 symboles** : minuscules sans `i j l o s z` (20), majuscules sans `B I O S Z` (21), chiffres `2` à `9` (8), 14 spéciaux courants des claviers de téléphone `! ? @ # $ % & * + - = / ( )` ; ni `0 O o 1 l I i j`, ni les sosies `S s Z z B` (5, 2 et 8 n'ont donc plus de sosie) ; aucune espace. Au moins une minuscule, une majuscule et un chiffre, et **exactement 3 caractères spéciaux**. Affichage tout collé.
- **Tirage** : uniforme par rejet (`crypto.getRandomValues`) ; le mot de passe entier est recommencé tant que la contrainte n'est pas tenue (environ 17,8 % des tirages bruts passent) : chaque mot de passe valide a la même probabilité. Mêmes règles dans le moteur Rust (`engine/core/src/password.rs`) et le site (`web/src/engine/pure.ts`, `PASSWORD_LEN` = 11).
- **Entropie** : **11 062 464 629 113 497 600** possibilités = C(11,3) × 14³ × (49⁸ − 29⁸ − 28⁸ − 41⁸ + 8⁸ + 21⁸ + 20⁸), soit **2^63,26** (prouvé par `password.test.ts` : somme par compositions et, indépendamment, inclusion-exclusion). Exigence : au moins 60 bits. **Signalement (faible)** : imposer exactement 3 spéciaux retire 0,81 bit par rapport à « au moins 3 » (2^64,07) ; l'exigence reste tenue.
- **Attaque hors ligne (base et lien volés)** : un essai = un Argon2id de 64 Mio et 3 passes. Hypothèse prudente pour un GPU haut de gamme, bornée par la bande passante mémoire : environ 2 000 essais par seconde ; en moyenne (moitié de l'espace), de l'ordre de 10⁸ années-GPU. La durée de vie du partage n'aide pas : le chiffré volé s'attaque à loisir ; d'où un mot de passe fort par défaut.
- Saisie au téléphone : les spéciaux demandent de changer de clavier ; c'est le prix de l'alphabet.
- **Code du coffre** (seulement si le coffre est construit, §27.2) : pas de liste noire ni de règles dans le code aujourd'hui (supprimées avec le coffre). À refaire : 10 caractères au moins, et refus (1) de moins de 5 caractères distincts, ou de plus de la moitié des caractères pris dans des répétitions (`aaa`, `abab`, casse comprise), des suites (`abcd`, `6789`, `2468`, 4 au moins) ou des rangées et colonnes de clavier AZERTY, QWERTY, QWERTZ (`azer`, `1qaz`, 4 au moins) ; (2) d'un mot de passe entier présent dans la liste ; (3) d'un mot de passe dont le « cœur » (séparateurs, chiffres et symboles des bords retirés, accents retirés, `0→o`, `1→i` ou `l`, `@→a`…) est un mot de passe courant (`motdepasse12`, `Soleil2024!`, `p@ssw0rd`). Listes à reprendre, livrées compressées (environ 14,8 Ko en gzip au total, D41-14), sources épinglées par SHA-256 : SecLists 10k, les 20 000 premières lignes de la liste NCSC 100k, Richelieu (20 000 mots de passe français). Licences : (1) **SecLists 10k** (`10k-most-common.txt`) : licence **MIT** (dépôt SecLists) ; (2) **NCSC, 20 000 premières lignes** de la liste « 100k most used passwords » du National Cyber Security Centre (Royaume-Uni), redistribuée par SecLists sous la licence MIT du dépôt ; la licence **d'origine** de la liste NCSC est **probablement l'Open Government Licence v3.0 (OGL v3) : à confirmer** auprès de la source avant la mise en ligne (si elle n'était pas libre, la liste serait retirée et remplacée par SecLists seule) ; (3) **Richelieu**, 20 000 mots de passe français : **CC BY 4.0** — attribution obligatoire (auteur, source, licence, mention des modifications : liste tronquée et compressée). Les trois textes de licence et l'attribution vont dans `THIRD_PARTY_LICENSES.md` et sur une page « Licences » du site (sans ressource tierce). Les trois listes sont des données publiques de mots de passe divulgués : aucune n'est un secret ; elles sont incluses au code (aucun `import()` dynamique, §28.3), ce qui compte dans le budget de poids de la page.

---

## 32. Lien court

Raisons, format et signalements : `docs/conception/specs/2026-11-16-liens-s-et-pages-design.md` ; vecteurs : `engine/vectors/v4-liens-s.json`.

- **Lien de partage** : `{origine}{base}s#<K_lien en base64url, 43 caractères>` (par exemple `https://shhgone.com/s#…`). L'identifiant n'est pas dans le lien : `id` = HKDF(`K_lien`, « shhdrop/v2/id »), à sens unique. Le serveur ne voit qu'un chemin fixe, `/s`.
- **Lien de gestion** : `{origine}{base}s#m<S_gestion, 43 caractères>` ; le serveur trouve le partage par `V_gestion` (index unique), donc le lien de gestion n'a pas besoin de l'identifiant (§29.8). Le lien de partage, lui, est trouvé par `V_accès` (index unique) : l'`id` n'est jamais envoyé.
- **Lien du QR code** de « Lien prêt » (D41-29) : `{origine}{base}s#<K_lien>.<mot de passe en base64url>`.
- **Pages** : `/s` (`s.html`) ne contient que l'ouverture et la gestion, jamais indexée ; `/` garde l'accueil et l'envoi. Une fois le lien lu et le `#` retiré, `/s` remplace son adresse par `/` (`replaceState`). Seule la forme `{base}s#…` est lue (moteur `parse_link`, `linkForm`) ; un `#` à la racine donne l'accueil, qui le retire de l'adresse sans rien envoyer.
- **Unicité** : `id` fait 128 bits tirés d'une clé aléatoire de 256 bits ; la probabilité d'une collision parmi n partages vaut environ n² / 2¹²⁹ (négligeable même pour 10¹² partages). → tâche K2 : le serveur n'indexe plus par cet `id` mais par `V_accès` et `V_gestion` (256 bits, index uniques) ; un doublon est refusé et le client recommence avec une nouvelle clé. Un lien n'est **jamais réutilisé** pour un nouveau partage : qui garde l'ancien lien y aurait accès. Chaque partage tire une `K_lien` neuve ; un créateur malveillant qui viserait un `id` passé sans connaître sa `K_lien` ne ferait correspondre aucun `V_accès`.
- **Pourquoi pas plus court** : 256 bits restent nécessaires (§30). Le chemin `/s` coûte 2 caractères et sert aux liens universels des apps (§16).
- **Effets** : le routeur reconnaît `/s` avec un fragment de 43 caractères base64url (partage) ou `m` + 43 (gestion) ; tout autre fragment est retiré (hygiène inchangée, UI §12.1). La démo suit le même format sous sa base (`https://skoow.github.io/Shhdrop/s#…`). Le lien partagé ne contient jamais le mot de passe ; **exception** : le lien du QR code de « Lien prêt » (D41-29) le contient, pour être montré seulement à la personne en face (risques résiduels dits en D41-29 ; précision du 13 novembre, audit web D8). Le navigateur intégré (UI S4) garde le `#` jusqu'à ce que la personne quitte la page (« Continuer ici », écran des tâches suivantes).

---

## 33. Historique local de l'expéditeur (retiré le 25 novembre, D42-27)

**Retiré** (décision du propriétaire, 25 novembre : « cela ne sert à rien »). Plus d'historique des envois (`/envois`, « Mes partages »), de liens reçus gardés (« Garder ce partage », réglage du compte « Garder les liens que j'ouvre »), de salons gardés, de « Vos partages actifs » à l'accueil, de liste à l'accueil connecté, de synchronisation par le compte, ni d'« Exporter mes données ». Le module `web/src/history/` n'existe plus.

- **Ce que l'appareil garde encore** (inchangé) : le retour sur un partage ouvert (octroi chiffré, sans `K_lien`, D42-22, `web/src/storage/returns.ts`), les preuves de membre des salons (§39.13.3), l'historique des téléchargements (désactivé par défaut, conception du compte §21.9), le pass des offres (§38), la session du compte (« Rester connecté »). Aucun lien de gestion, aucun lien de partage, aucun lien d'invitation.
- **Gestion d'un partage** : seul qui détient `S_gestion` peut suivre ou supprimer (§33.1, inchangé). « Lien prêt » montre toujours le lien de gestion (Copier), avec « c'est le seul moyen de suivre ou de supprimer le partage une fois cette page fermée » ; « Salon prêt » montre toujours le lien de gestion du salon, avec son avertissement. **Signalement (moyenne, exploitation)** : sans copie du lien de gestion, la gestion n'est possible que tant que la page « Lien prêt » est ouverte ; la garde de sortie (`ready-copies.ts`) ne porte que sur le lien et le mot de passe. Correction proposée : compter aussi la copie du lien de gestion dans la garde (à décider : un geste de plus avant « Nouveau partage »).
- **Données d'avant** : au démarrage (application, page « /s », pages d'information), la base IndexedDB `shhdrop-history` est supprimée, clé comprise, sans erreur (`storage/ancien-historique.ts`) ; « Effacer les données de cet appareil » le fait aussi. Un coffre privé de compte qui porte encore les listes `salons`, `recus`, `rejoints`, `envois` est réécrit avec ces listes vides à l'ouverture de la session (le format du coffre les garde, vides, pour ne pas changer sa forme) ; `garder_recus` est ignoré à la lecture et n'est plus écrit.
- **Suppression du compte** : elle ne détruit plus de partages (la liste n'existe plus) ; l'écran dit que les partages en cours s'effacent à leur échéance, ou plus tôt avec leur lien de gestion.
- **Exporter mes données** retiré avec le reste. **Signalement (moyenne, légal)** : le droit d'accès et de portabilité (RGPD art. 15 et 20) ne passe plus par un fichier ; la page Compte montre ce que le serveur garde (date de création, palier, appareils, passkeys) et la page Confidentialité le dit. La route serveur `GET /api/compte/export` reste (aucun client ne l'appelle) : à retirer ou à rebrancher selon l'avis d'un juriste.

### 33.1 Gestion de l'expéditeur sans empreinte

**Idée proposée et refusée : une empreinte de l'expéditeur** (pour que lui seul puisse supprimer, et que le site lui montre ses liens actifs à son retour). **Signalement (élevée)** : une empreinte d'appareil est **peu fiable** (elle change à chaque mise à jour du navigateur, se ressemble d'un appareil identique à l'autre, se contourne) et c'est du **pistage** : le serveur devrait garder un identifiant qui relie entre eux les partages d'une même personne (contraire à §36 et à la non-liaison de §37.4), et l'empreinte est soumise au consentement (ePrivacy, article 5, paragraphe 3) comme un cookie. Elle est refusée. Elle n'est pas nécessaire : **seul qui détient `S_gestion` peut supprimer** (le serveur ne reconnaît que ce secret). Le besoin « retrouver mes liens » n'est plus couvert par le site (historique retiré, D42-27) : l'expéditeur garde lui-même le lien de gestion.

- **Vue de gestion** (`#m…`) : tableau de bord d'un partage (UI §9.6.4), ouvert par le lien de gestion seul ; elle ne lit plus rien sur l'appareil (plus de nom ni de taille venus de l'historique).

---

## 34. Droits du destinataire

| Droit (`rights` du manifeste v2) | Effet chez le destinataire |
|---|---|
| `"voir"` — « Voir seulement » | Aucun bouton Enregistrer ni Copier ; `controlsList="nodownload"`, `disablePictureInPicture`, menu contextuel des médias neutralisé, `-webkit-touch-callout: none`. Mention : « L'expéditeur a choisi « voir seulement ». Cela n'empêche pas une capture d'écran. » |
| `"enregistrer"` — « Voir et enregistrer » (**par défaut**) | Comportement actuel (UI §9.8, §9.9) |
| `"coffre"` — « Voir, enregistrer et garder dans le coffre » | En plus : « Garder dans le coffre », téléphone seulement (§27) ; porte `keep_ttl_h` |

- Le droit est dans le **manifeste chiffré et authentifié** : le serveur ne le voit pas et ne peut pas l'élargir. Absent, inconnu ou mal typé → `"voir"` (le plus restrictif).
- « Voir seulement » (D1) s'accompagne d'un texte honnête des deux côtés ; à l'expéditeur : « Ce n'est qu'une dissuasion : le destinataire peut toujours faire une capture ou filmer l'écran, et un navigateur modifié peut enregistrer quand même. »
- « Voir seulement » est refusé (choix désactivé, avec la liste des éléments en cause) si un élément ne peut pas s'afficher dans le navigateur (archives, bureautique, plus de 200 Mio) : il serait inaccessible au destinataire.
- Manifeste v2 : `{ "v": 2, "rights": "enregistrer", "keep_ttl_h"?: 12, "items": [...] }`.

### 34.1 Un seul interrupteur

Dans l'interface, le choix est un seul interrupteur ; le format du manifeste (tableau ci-dessus) ne change pas.

- Un interrupteur **« Autoriser le téléchargement »**, **activé par défaut** → `rights: "enregistrer"`. Désactivé → `"voir"` : le destinataire ne peut que regarder sur le site (même effets et même mention que la ligne `"voir"` du tableau).
- **Sous-option** (non proposée tant que le coffre n'est pas construit, §27), affichée seulement quand l'interrupteur est activé : « Autoriser aussi une copie chiffrée dans l'app, sur téléphone » → `"coffre"` avec `keep_ttl_h` = durée du partage. Désactivée par défaut (§27 inchangé). Elle concerne l'appareil du **destinataire** : elle est proposée à tout expéditeur, téléphone ou ordinateur. **Ambiguïté signalée** : si « réservée au téléphone » visait l'appareil de l'expéditeur, il suffit de la masquer quand `pointer: coarse` est faux ; défaut retenu : proposée partout.
- Interrupteur bloqué en position activée, avec la liste des éléments en cause, quand un élément ne s'affiche pas dans le navigateur (règle de « Voir seulement » ci-dessus) ; le désactiver retire aussi la sous-option.
- Q-R1 : téléchargement autorisé par défaut (un `Switch` au lieu de `RightsPicker` à trois choix ; UI §10).

### Questions ouvertes de §29 à §34 (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-K1 | Accepter la fuite de la taille à 4 Mio près vers un serveur qui observe l'envoi anticipé (§29.7) | Oui (décision de vitesse). **Abandonné le 24 novembre** : pas de mode « Envoyer seulement quand je clique » ; l'envoi chiffré commence dès l'ajout d'un fichier (D41-19), pour tous ; la fuite de la taille à 4 Mio près est assumée (§36 S4) |
| Q-K2 | Envoi anticipé sur données mobiles | **Abandonné le 24 novembre** : l'envoi part dès l'ajout, sur données mobiles comme ailleurs (D41-19) ; `saveData` n'est pas lu |
| Q-MDP1 | 8 ou 10 caractères par défaut | 10 recommandé ; 8 appliqué |
| Q-H1 | Verrou par passkey de l'historique | Sans objet : historique retiré (D42-27) |
| Q-H2 | Historique activé par défaut | Sans objet : historique retiré (D42-27) |
| Q-R1 | Droit par défaut | Réglée (§34.1) : « Autoriser le téléchargement » activé |

---

## 35. Aucune statistique, fichiers nettoyés, enregistrement dans l'interface

Demande : « Aucune donnée de statistique ni d'analytics. Des fichiers propres, documents et vidéos compris. L'enregistrement vocal doit être possible depuis notre interface. Réduire au maximum ce que le serveur peut voir » (ce dernier point : §36).

### 35.1 Aucune statistique

- Règle : §3 « Jamais » et §9.5 (liste fermée des compteurs d'exploitation, chacun justifié). Aucune exception pour « juste compter les visites » : un compteur anonyme agrégé reste une statistique, et il n'est demandé par aucune règle de la spécification.
- **Navigateur** : aucun SDK, aucun `sendBeacon`, aucun écouteur `error` / `unhandledrejection` qui envoie quoi que ce soit (les erreurs restent dans la page ; la règle « aucun appel réseau hors de `web/src/index.ts` » le garantit déjà). `PerformanceObserver` n'est permis que dans les tests.
- **Serveur** : aucun point d'accès de métriques ; `/healthz` (boucle locale seulement) rend `ok` et un seul booléen `reports_alert` (§9.5, §36) ; les agrégats d'usage ne sont lisibles que par l'écouteur d'administration (§9.5).
- **Sorties du serveur** : aucune, sauf vers les prestataires de paiement, **seulement avec `SHH_PAIEMENT=1`** (`internal/paiement/http.go`, `TestClientPaiementSeulementAvecPaiement`) ; aucun SMTP (le compte par passkey n'envoie pas d'e-mail). Ce n'est ni une métrique ni une télémétrie : aucun compteur n'y part.
- **Exploitation** (déploiement) : Caddy sans `metrics` et API d'administration coupée (`admin off`) ; aucun agent de surveillance de l'hébergeur installé ; l'alerte disque lit `df`, pas l'application.
- **Test « aucune statistique »** (bloquant, §14) :
  - recherche, insensible à la casse, dans `web/src`, `web/scripts`, `web/*.html`, `package-lock.json` (noms de paquets), `dist/`, `dist-demo/` : `google-analytics`, `googletagmanager`, `gtag(`, `analytics.js`, `plausible`, `matomo`, `piwik`, `posthog`, `mixpanel`, `segment.io`, `cdn.segment.com`, `amplitude`, `hotjar`, `clarity.ms`, `@sentry/`, `sentry.io`, `bugsnag`, `rollbar`, `datadog`, `newrelic`, `nr-data.net`, `logrocket`, `fullstory`, `umami`, `usefathom`, `cloudflareinsights`, `web-vitals`, `heapanalytics`, `mc.yandex`, `fbq(`, `doubleclick`, `honeybadger`, `trackjs`, `raygun`, `@opentelemetry`, `elastic-apm`, `sendBeacon` ; un fichier piégé prouve que la recherche détecte ;
  - côté Go : aucun import de `expvar`, `net/http/pprof`, `github.com/prometheus/`, `go.opentelemetry.io/`, `github.com/getsentry/`, `gopkg.in/DataDog/`, `github.com/newrelic/`, `github.com/DataDog/`, `statsd` dans `server/` ni dans `go.sum` ;
  - côté serveur, « rien n'agrège par personne » : (1) toute déclaration `map[` dans `server/internal` hors d'une liste blanche (`limits/`, `captcha/`, et les budgets et envois en cours de `api/`, un par ligne de §9.5) fait échouer le test, qui oblige à justifier tout nouveau compteur ; (2) chaque compteur de §9.5 est vide après sa rotation (horloge injectée : minute, heure, 3 h, minuit UTC) ; (3) `sqlite_master` de `shares.db` ne contient que `shares`, `salons` (avec la colonne `compte`), `salon_pieces` et leurs index (§39.3.5) ; `comptes.db` a son propre schéma exact, contrôlé par `compte.TestSchemaComptes` (seulement des BLOB et des INTEGER) ; (4) aucun client sortant hors de `internal/paiement/http.go` (créé seulement avec `SHH_PAIEMENT=1`), et aucun SMTP (`TestNoOutgoingHTTP`) ; les compteurs du compte sont dans la liste de §9.5.
- **Règle de source « aucune API d'empreinte de l'appareil » (bloquante)** : `web/src/source-rules.test.ts` cherche, dans tout `web/src` (démo comprise, commentaires de ligne entière ignorés), les API qui servent surtout à reconnaître un navigateur : `getBattery`, `hardwareConcurrency`, `navigator.plugins`, `deviceMemory`, et la lecture d'une toile (`toDataURL`, `getImageData`, `.toBlob(`, `convertToBlob`). Seuls trois usages sont admis, chacun avec sa raison écrite dans le test, et une entrée qui ne sert plus fait aussi échouer le test : (1) `ui/avatar.ts`, `toBlob` : réencode la photo de profil choisie par la personne (sans EXIF), jamais une toile de test ; (2) `media/capture.ts`, `toBlob` : photo prise avec la caméra, réencodée en JPEG pour être envoyée chiffrée ; (3) `app/env.ts`, `deviceMemory` : prévenir avant un fichier de plus de 200 Mio sur un appareil à petite mémoire, valeur lue sur place, jamais envoyée. Des témoins prouvent que la règle détecte ces appels.

### 35.2 Nettoyage des métadonnées de tous les fichiers

> **Règles retenues** (aboutissement de D41-22, D41-23, D41-27, D41-31 et des retours suivants ; elles font foi sur les points qu'elles traitent, le détail par format suit) :
>
> - **Jamais automatique** : rien n'est nettoyé ni analysé à l'ajout ; aucun fichier n'est modifié sans une action de la personne ; pas de réglage « Nettoyage automatique ». Le nettoyage se lance par le **balai** de chaque fichier (bouton icône, nom accessible « Nettoyer ce fichier : {nom} », « Clean this file: {name} » en anglais ; bulle au survol et au focus qui dit ce qui sera retiré selon le type) ou par **« Tout nettoyer »** en tête de la liste (affiché seulement s'il reste un fichier à nettoyer) ; dans les deux cas, une **petite confirmation** (explication, « Nettoyer », « Annuler ») le précède, au doigt comme à la souris. Les vidéos et sons importés d'un format que le nettoyage lit (MP4/MOV, WebM, MP3, Ogg, FLAC, WAV) ont aussi le balai.
> - Photos, vidéos et vocaux **pris dans l'interface** sont toujours sans métadonnées (par construction).
> - **Jamais bloquant** (D41-23, plus bas) : un fichier non nettoyé part normalement, marqué « Non nettoyé ». Une photo, une vidéo ou un son d'un format que le nettoyage ne lit pas (TIFF, SVG, AVI, AAC…) est dit dès l'ajout : état `echec` avec son format (« Nettoyage impossible : format non pris en charge », marque ambre, compté près d'Envoyer, dit au destinataire), fichier inchangé, sans balai ni « Réessayer ».
> - **PDF** : seules les propriétés que montrent les détails du fichier sont retirées : le dictionnaire `/Info` de **chaque révision** et le XMP **du document** (`/Metadata` du catalogue), remplacés par `null` **à longueur constante** (aucun octet ne bouge, tables `xref` justes). Rien d'autre n'est touché : pages et leur XMP, contenu, images intégrées, polices, annotations, miniatures `/Thumb`, trailers (`/ID`). Le résultat est **relu** (plus rien à retirer, même taille), sinon `echec` (non bloquant, le fichier part intact). PDF chiffré (`/Encrypt`) ou signé (`/ByteRange`) → `protege` (« Non nettoyé · Fichier signé ou protégé : laissé intact »). Texte : « Nettoyé : propriétés du document retirées (auteur, logiciel, dates) ».
> - ****Photos** (JPEG, PNG, WebP, HEIC/HEIF/AVIF) : la vignette JPEG de l'EXIF (IFD1, celle des téléphones) est **gardée octet pour octet** dans un EXIF minimal : l'orientation si elle sert (IFD0), puis l'IFD1 réduit à Compression (6), position et longueur de la vignette. Aucune autre étiquette ne survit (position, appareil, dates, logiciel…). La vignette est gardée, mais ses propres segments de métadonnées en sont retirés sans toucher au reste : seuls restent SOI, les tables et trames (DQT, DHT, DAC, DRI, DNL, SOFn), APP14 Adobe, SOS et données compressées (octet pour octet), EOI ; partent APP0 à APP13, APP15, COM et les marqueurs réservés qui peuvent porter n'importe quoi (0xC8, 0xDE, 0xDF, 0xF0 à 0xFD) ; rien n'est gardé après le premier EOI. Une vignette mal formée (sans SOI ou EOI, segment qui déborde, marqueur seul hors norme) est retirée (`web/src/media/jpeg-scan.ts`, `cleanThumbnail`). Une vignette trop grande pour le segment APP1 d'un JPEG (64 Kio), ou pour la place de l'EXIF d'origine dans un HEIF, est retirée aussi. La vignette JFIF (APP0 `JFIF`) reste gardée ; l'APP0 **JFXX** est toujours retirée.** Texte : « Nettoyé : position, appareil et dates retirés, vignette d'aperçu gardée ».
> - **Bureautique** : seules les **propriétés du document** (`docProps/core.xml`, `app.xml`, `custom.xml` ; `meta.xml` ODF), les **miniatures** et les **métadonnées des images intégrées** (pixels inchangés) sont retirées ; commentaires, personnes et suivi des modifications restent intacts, auteurs et dates compris.
> - **Archives** : rien ; elles partent intactes (pastille neutre « Archive laissée intacte », non comptée parmi les fichiers non nettoyés).
> - **Envoi anticipé** : Un fichier nettoyé après son envoi anticipé ne laisse rien de lisible au destinataire (§29.7, test `web/e2e/clean-leak.test.ts`) : l'original est abandonné (graine oubliée, segments effacés ou remplacés), la version nettoyée repart sous une graine neuve. Portes : `clean-gate.ts`, `media/clean-label.ts`, `composer.clean`.
> - **Signalements ouverts (gravité moyenne, confidentialité)**, avec leur correction possible : (a) la vignette EXIF peut montrer la photo **avant recadrage ou retouche**, les textes disent seulement qu'elle est gardée : l'écrire dans « En savoir plus » et sur la page Sécurité ; (b) les commentaires d'un document gardent leurs auteurs, sans remarque sur la ligne : une phrase générale sous la liste ; (c) un PDF modifié par mises à jour incrémentales garde le **contenu** de ses anciennes révisions : une phrase dans la bulle quand le PDF a plusieurs révisions.

Détail par format, sous les règles retenues ci-dessus (audit de confidentialité P4).

**Principes**

- **Dans le navigateur, avant tout chiffrement.** Un élément en cours de nettoyage n'est pas transmis à l'envoi anticipé (`draft.sync`, §29.4) : aucun morceau de l'original n'est chiffré. Le résultat remplace l'original dans le composeur.
- **Sans réencodage**, en TypeScript, **sans nouvelle dépendance** (comparaison plus bas). Ce n'est pas de la cryptographie : la règle « aucune crypto maison » ne s'y applique pas. Les CRC-32 (ZIP, PNG, Ogg) sont des sommes de contrôle de format, pas des protections.
- **Trois techniques seulement** :
  1. **reconstruction** des petits formats lus en entier (images de `STRIP_MAX` = 50 Mio au plus, constante déjà dans `web/src/limits.ts` : JPEG, PNG, WebP, GIF ; au-delà, `echec`) ;
  2. **neutralisation en place, à longueur constante**, pour les gros conteneurs (MP4/MOV/M4A, HEIF/AVIF, Matroska/WebM, PDF) : boîte renommée `free` et remplie de zéros, élément EBML remplacé par `Void`, objet PDF remplacé par `null` suivi d'espaces. Aucun octet ne bouge, donc aucune table de positions (`stco`, `iloc`, `xref`, `Cues`) n'est à recalculer ;
  3. **réassemblage** : MP3 (étiquettes coupées), ZIP (Office, ODF : entrées inchangées recopiées telles quelles, parties remplacées écrites sans compression), Ogg (pages d'en-tête refaites), FLAC, WAV.
- **Aucun fichier entier en mémoire** au-delà de `STRIP_MAX` (§24) ; les gros conteneurs n'ont pas de plafond : la sortie est un `Blob` fait de tranches de l'original (`File.slice`) et de petits correctifs ; l'analyse lit par tranches de 4 Mio et rend la main entre deux tranches (pas de Worker de plus, donc rien hors SRI, §28.3).
- **Analyse à bornes vérifiées** : toute longueur qui sort de son parent ou du fichier, toute boîte inconnue là où une liste blanche s'applique, toute structure chiffrée ou signée → résultat `echec` ou `protege`, jamais d'exception ni de fichier à moitié modifié.
- **Les métadonnées des fichiers enregistrés dans l'interface** (vocal, vidéo si Q-REC1) passent par le même nettoyage : `MediaRecorder` écrit le nom du logiciel et, sur Safari, des dates réelles dans `mvhd`.

**Par format**

| Format | Retiré | Gardé | Échec ou refus |
|---|---|---|---|
| **JPEG** | APP1 EXIF réécrit avec la **seule orientation** (0x0112, boutisme d'origine) et, depuis le 11 novembre, la **vignette IFD1 intacte** s'il y en a une (voir la décision en tête) ; APP1 XMP et XMP étendu ; APP0 JFXX (vignette, toujours retirée) ; APP2 MPF et FPXR ; APP3 à APP13 (IPTC, Photoshop) ; APP15 ; COM ; **tout ce qui suit le premier EOI** : images secondaires MPF, carte de gain HDR, carte de profondeur, vidéo des « photos animées » (Google, Samsung), bloc Samsung SEFT | SOI, APP0 JFIF (vignette comprise), vignette IFD1 de l'EXIF (sans ses propres APPn, COM ni marqueurs réservés, 22 novembre ; retirée si mal formée), APP2 ICC (tous les morceaux, dans l'ordre), APP14 Adobe, DQT, DHT, DRI, SOFn, SOS et données compressées (octet pour octet), EOI | marqueur invalide, longueur hors fichier, aucun SOS ou EOI → `echec`. Perte assumée, à dire : rendu HDR, flou de portrait modifiable, animation |
| **PNG** | `tEXt`, `zTXt`, `iTXt` (XMP compris), `tIME`, `eXIf` (réécrit avec la seule orientation si elle ≠ 1 et, depuis le 11 novembre, la vignette IFD1 intacte), tout bloc auxiliaire inconnu (`iDOT`, `caNv`…) | IHDR, PLTE, IDAT, IEND, `tRNS`, `cHRM`, `gAMA`, `iCCP`, `sRGB`, `sBIT`, `cICP`, `mDCV`, `cLLI`, `pHYs`, `bKGD`, `hIST`, `sPLT`, APNG (`acTL`, `fcTL`, `fdAT`) | CRC faux, bloc critique inconnu → `echec` |
| **WebP** | `EXIF` (réécrit avec la seule orientation si elle ≠ 1 et, depuis le 11 novembre, la vignette IFD1 intacte), `XMP `, blocs inconnus ; drapeaux de `VP8X` et taille RIFF corrigés | `VP8`, `VP8L`, `VP8X`, `ALPH`, `ICCP`, `ANIM`, `ANMF` | taille RIFF incohérente → `echec` |
| **GIF** | extensions Commentaire (0xFE) et Application autres que `NETSCAPE2.0`, `ANIMEXTS1.0`, `ICCRGBG1` (XMP `XMP DataXMP` compris) ; tout ce qui suit le terminateur 0x3B | en-tête, palettes, images (sous-blocs LZW recopiés sans décodage), Contrôle graphique (0xF9), Texte (0x01), boucle d'animation, profil ICC | bloc inconnu, sous-bloc hors fichier → `echec` |
| **HEIC / HEIF / AVIF** | **nettoyés en place** (choix, Q-MD2) : données de l'élément `Exif` (repérées par `iloc`, méthodes 0 et 1) remplacées par un EXIF vide valide (18 octets) suivi de zéros (depuis le 11 novembre : par un EXIF qui ne garde que la vignette IFD1 intacte, si elle tient dans la place d'origine ; sinon l'EXIF vide) ; élément XMP (`mime`, `application/rdf+xml`) remplacé par un paquet XMP vide complété d'espaces ; propriété `udes` (titre, description, mots-clés) renommée `free` ; boîtes de premier niveau hors de `ftyp`, `meta`, `mdat`, `idat`, `free`, `skip`, `moov` neutralisées | images, grilles, vignette (image de la photo elle-même), cartes auxiliaires, orientation (`irot`, `imir` : HEIF n'utilise pas l'orientation EXIF), couleurs (`colr`), boîtes `free` existantes mises à zéro | `iloc` méthode 2, extent hors fichier, `Exif` dans plusieurs éléments partagés → `echec`. Pourquoi nettoyer plutôt que refuser : c'est le format par défaut des iPhone et la position y est presque toujours ; refuser pousserait à envoyer tel quel. Note : Safari iOS convertit souvent le HEIC en JPEG dans un `<input>` ; le cas reste fréquent sur ordinateur |
| **PDF** (D41-31) | dictionnaire `/Info` de chaque révision (chaîne des `/Prev`, tables xref classiques et flux xref) et XMP du document (`/Metadata` du catalogue) : objets remplacés par `null` + espaces, à longueur constante. Plus rien d'autre depuis le 11 novembre | pages et leur XMP, contenu, polices, images (et leur XMP), annotations, miniatures `/Thumb` des pages, trailers (`/ID`), anciennes révisions (contenu) : octet pour octet | `/Encrypt` ou `/ByteRange` → `protege` ; `/Info` dans un flux d'objets, xref illisible ou décalée, `/Author` ou `/Producer` resté hors des objets neutralisés → `echec` ; sortie relue (aucun correctif restant, même taille) sinon `echec` |
| **Office OOXML** (`.docx`, `.xlsx`, `.pptx` et variantes à macros) | `docProps/core.xml`, `docProps/app.xml` (société, responsable, modèle, durée d'édition, logiciel), `docProps/custom.xml` remplacés par des versions minimales valides **de même nom** (types de contenu et relations inchangés) ; miniature `docProps/thumbnail.*` et ses références retirées ; images intégrées (`*/media/*`) : métadonnées retirées par les règles d'images ci-dessus (pixels inchangés) ; dates des entrées ZIP fixées au 1ᵉʳ janvier 1980, champs « extra » (dates Unix, UID) et commentaire ZIP retirés | **tout le contenu du document**, recopié sans décompression : commentaires (auteurs, initiales, dates), `word/people.xml`, `xl/persons/`, `ppt/authors.xml`, `ppt/commentAuthors.xml`, suivi des modifications (`w:ins`, `w:del`… avec `w:author` et `w:date`), révisions d'un classeur ; **aucune remarque** sur la ligne (D41-27) | ZIP64, entrée chiffrée, plusieurs disques, nom en double → `echec` ; fichier OLE (`D0 CF 11 E0`, document protégé par mot de passe) ou `_xmlsignatures/` → `protege` ; image intégrée en échec → document en `echec`. Laissés : `w:rsid*`, `customXml/`, chemin du modèle attaché (peut contenir un nom d'utilisateur) |
| **ODF** (`.odt`, `.ods`, `.odp`) | `meta.xml` remplacé par un `office:document-meta` minimal (version d'origine reprise) : auteur initial et dernier, dates, durée et nombre d'éditions, générateur, mots-clés, titre ; miniature `Thumbnails/` retirée (et son entrée du manifeste) ; images de `Pictures/` : métadonnées retirées (pixels inchangés) ; dates et champs « extra » ZIP comme ci-dessus | `mimetype` en premier et sans compression (exigé par ODF) ; `content.xml` et `styles.xml` intacts : annotations (auteurs, dates) et modifications suivies gardées, sans remarque (D41-27) | `manifest:encryption-data` ou `META-INF/documentsignatures.xml` → `protege` ; ZIP invalide → `echec`. Laissés : `settings.xml` (nom d'imprimante) |
| **MP4 / MOV / M4V** (et **M4A**) | neutralisées en place (`free` + zéros) : `udta` et `meta` de `moov` et de chaque `trak` (dont `©xyz`, `©mak`, `©mod`, `©swr`, `©day`, `com.apple.quicktime.location.ISO6709`, `.make`, `.model`, `.software`, `.creationdate`, étiquettes iTunes `ilst`, pochette `covr`) ; boîtes `uuid` (XMP et autres), `prft` (heure murale de capture des MP4 fragmentés) ; toute boîte de premier niveau, de `moov` ou de `trak` hors liste blanche (par exemple `gps ` de caméras embarquées) ; **pistes de métadonnées minutées** (gestionnaire `meta`, codecs `mebx`, `gpmd`, `camm`, `rtmd`) et pistes de **timecode** (`tmcd`, heure du jour de la prise) : `trak` neutralisée **et** ses échantillons mis à zéro dans `mdat` (positions lues dans `stsc`, `stsz`, `stco`/`co64`) ; contenu des `free`/`skip` existantes mis à zéro (anciens `moov` laissés par des éditeurs) ; dates de création et de modification de `mvhd`, `tkhd`, `mdhd` mises à **0** (versions 0 et 1) | flux audio et vidéo octet pour octet, **matrice de `tkhd`** (rotation des vidéos de téléphone), dimensions, `edts`/`elst`, `stsd` complet (`colr`, `pasp`, `clli`, `mdcv`, `sv3d`, `st3d`), `mvex`, `moof`, `sidx` | taille de boîte invalide (0 ailleurs qu'en dernier, 1 avec taille 64 bits incohérente, débordement), `moov` absent, plus de 100 000 correctifs → `echec`. Perte assumée : titre, chapitres de `udta`, pochette |
| **WebM / MKV** | `Tags`, `DateUTC`, `Title`, `SegmentUUID`, `PrevUUID`, `NextUUID` remplacés par `Void` de même taille ; `MuxingApp` et `WritingApp` (obligatoires) réécrits « shhdrop » complété d'octets nuls (chaîne vide si la place manque) | pistes, `Cluster`, `Cues`, chapitres, pièces jointes (polices de sous-titres ; laissées, à dire) | VINT invalide, élément qui déborde de son parent, taille inconnue ailleurs que `Segment` et `Cluster` → `echec` |
| **MP3** (et AAC ADTS) | toutes les étiquettes ID3v2 du début (pied de page compris) et ID3v2.4 de fin (`3DI`), ID3v1 (`TAG`, et `TAG+`), APEv2 (`APETAGEX`), Lyrics3 | trames audio octet pour octet, trame Xing/Info/LAME (lecture à débit variable) | aucune synchronisation de trame dans les 64 Kio qui suivent → `echec` |
| **Ogg Opus / Vorbis** | paquet de commentaires (`OpusTags`, `\x03vorbis`) réécrit : chaîne de l'encodeur vide, aucun commentaire (pochette `METADATA_BLOCK_PICTURE` comprise) ; pages d'en-tête refaites, pages suivantes renumérotées, CRC Ogg recalculés | paquet d'identification, paquet de configuration Vorbis, pages audio (seuls leur numéro et leur CRC changent) | flux multiplexés ou chaînés, autre codec (Theora, FLAC dans Ogg) → `echec` |
| **FLAC** (coût faible) | blocs `VORBIS_COMMENT`, `PICTURE`, `APPLICATION`, `PADDING` ; ID3v2 de tête | `STREAMINFO`, `SEEKTABLE`, `CUESHEET`, trames ; drapeau « dernier bloc » reposé | bloc hors fichier → `echec` |
| **WAV** (coût faible) | blocs `LIST`/`INFO`, `bext` (auteur, date, heure, identifiant UMID), `iXML`, `axml`, `id3 `, `_PMX` (XMP), `cart` et tout bloc hors liste ; taille RIFF corrigée | `fmt `, `fact`, `cue `, `data` (recopié par tranches) | RF64, tailles incohérentes → `echec` |
| **Non pris en charge** | rien | tout | état `non_pris_en_charge` : SVG (peut contenir des chemins de fichiers), TIFF, DNG et photos brutes, `.doc`/`.xls`/`.ppt`, RTF, EPUB, iWork, AVI |
| **Archives** (`.zip`, `.7z`, `.rar`, `.tar`, `.gz`…) | **rien** (D41-27) : jamais ouvertes ni modifiées | tout, octet pour octet | état `intact`, pastille neutre « Archive laissée intacte » (même style que le PDF, pas comptée dans « N fichiers ne sont pas nettoyés ») ; bulle : « Les archives ne sont jamais ouvertes ni modifiées : celle-ci part telle quelle, avec les informations éventuelles des fichiers qu'elle contient. » |
| **Sans métadonnées connues** | rien | tout | état `sans` : textes du composeur, `.txt`, `.md`, `.csv`, `.json` |

**États et textes à l'écran** (le seul endroit qui dit « Nettoyé » ; la spécification UI est à aligner par celui qui la tient)

> **D41-34 (retours UI7)** : la présentation de ces états est remplacée par la bulle du cadenas à deux lignes (voir le journal, D41-34) ; les états et le nettoyage ne changent pas.

| État | Quand | Texte (FR) | Envoi |
|---|---|---|---|
| `nettoye` | nettoyage réussi **et** vérifié (le résultat est relu par le même analyseur : aucun bloc retiré ne reste) | images : « Nettoyé · lieu, appareil et date retirés » (11 novembre : « Nettoyé : position, appareil et dates retirés, vignette d'aperçu gardée ») ; PDF : « Nettoyé : propriétés du document retirées (auteur, logiciel, dates) » ; vidéo : « Nettoyé · lieu, appareil et dates retirés » ; audio : « Nettoyé · titre, artiste, logiciel et dates retirés » ; bureautique : « Nettoyé · propriétés du document (auteur, société, dates) et miniature retirées » ; vocal : « Enregistré ici, sans informations cachées » | normal |
| `intact` | archive, laissée telle quelle par décision (D41-27 ; les PDF sont de nouveau nettoyés, D41-31) | « Archive laissée intacte » (pastille neutre, détail dans la bulle) | normal |
| `echec` | analyse impossible | « Pas pu nettoyer ce fichier. Il partira avec ses informations cachées (lieu, appareil, auteur…). » + **Envoyer tel quel** / **Retirer** | bloqué (`blockReason` `non_nettoye`) jusqu'au choix (Q-MD1) |
| `protege` | signé ou chiffré | « Fichier signé ou protégé : il n'est pas modifié, pour ne pas le casser. Il garde ses informations cachées. » + les deux mêmes boutons | bloqué jusqu'au choix |
| `non_pris_en_charge` | format de la dernière ligne du tableau | « Non nettoyé : ce type de fichier part tel quel. » | normal |
| `sans` | textes, texte brut | rien | normal |

- La phrase générale « Position et appareil retirés des photos » (accueil, FAQ, composeur) n'apparaît que si **tous** les éléments d'images sont `nettoye` ; jamais « aucune trace », jamais « 100 % ».
- **Écarts signalés avec le code livré** (composeur, d46f19e) : un échec de nettoyage **n'ajoute pas** le fichier (`compose.failedClean`), et le texte `home.faq.scan.a` dit que vidéos et documents ne sont pas nettoyés. Les tâches 9a à 9c remplacent le premier par l'état `echec` et mettent le second à jour format par format, seulement quand le code existe.
- Recommandation Q-MD1 : ni envoi silencieux (la personne croirait le fichier propre, comme ses voisins), ni refus sec (elle n'aurait aucun moyen d'envoyer un fichier légitime) : un geste explicite par fichier.
- **Nettoyage automatique (D41-22)** : abandonné (règles retenues en tête de §35.2) ; `non_pris_en_charge` n'est pas « normal » : comme `echec` et `protege`, il porte la marque « Non nettoyé » (D41-23).
- **Non bloquant (D41-23)** : le nettoyage **ne bloque jamais l'envoi**. Un fichier qui n'a pas pu être nettoyé (échec, protégé, PDF, bureautique, vidéo ou audio importés, archive, format inconnu) part normalement, **sans clic**. Sa ligne porte une marque **« Non nettoyé »** bien visible et sa raison courte : « PDF : bientôt pris en charge », « Bureautique : bientôt pris en charge », « Vidéo : bientôt prise en charge », « Audio : bientôt pris en charge », « Archive : contenu non inspecté », « Format non reconnu », « Échec du nettoyage », « Fichier signé ou protégé : laissé intact » ; l'infobulle et le lecteur d'écran ajoutent « Ce fichier part tel quel, avec ses informations cachées éventuelles ». Près d'Envoyer, une phrase discrète résume : « 2 fichiers ne sont pas nettoyés » (pluriels, français et anglais). Les boutons « Envoyer tel quel » et « Retirer » de la ligne disparaissent (« Retirer » reste dans les actions habituelles) ; la note d'archive « son contenu n'est ni vérifié ni nettoyé » est remplacée par la marque. La marque « Original » (réglage désactivé) n'entre pas dans le résumé : c'est un choix fait dans les Réglages. Le verrou `flows/clean-gate.ts` reste : il refuse seulement un contenu qui n'est passé **ni** par le nettoyage **ni** par la décision « non nettoyable » du composeur (aucun contournement silencieux par erreur de programmation).
- **Où le nettoyage est branché (écart signalé avec la consigne « point d'accroche `DraftOpts.prepare` »)** : le nettoyage se fait dans le composeur, à l'ajout (l'élément n'entre dans la liste qu'une fois nettoyé, donc jamais confié à `draft.sync` avant) ; `prepare` sert de **dernier verrou** (`flows/clean-gate.ts`) : il refuse tout contenu que le composeur n'a pas déclaré prêt. Raison : `prepare` tourne dans la file d'envoi unique ; y nettoyer retarderait l'envoi de tous les suivants, et la taille nettoyée doit être connue de la jauge et des blocages avant l'envoi. Depuis D41-23, « prêt » veut dire : nettoyé, sans objet, original, ou marqué « Non nettoyé ».
- **Orientation (D41-22)** : JPEG, PNG et WebP gardent la seule étiquette d'orientation (TIFF à une entrée ; depuis le 11 novembre, plus la vignette IFD1 s'il y en a une) au lieu de tourner l'image, ce qui demanderait de la réencoder ; HEIF garde `irot`/`imir`. Test e2e : même taille affichée avant et après (`createImageBitmap`).

**Outillage : écrit à la main, sans dépendance**

| Option | Licence | Taille (ordre de grandeur, à revérifier au choix) | Ce qu'elle couvre | Verdict |
|---|---|---|---|---|
| Analyseurs écrits à la main | — | environ 2 500 lignes TypeScript, tests compris en plus | tout le tableau | **retenu** : formats documentés, techniques simples (longueur constante), aucune chaîne d'approvisionnement de plus (§24, §28) |
| `exifr` | MIT | plusieurs dizaines de Kio | lecture seule (EXIF, XMP, IPTC) | non : ne réécrit rien ; utile seulement comme contrôle de test, et nos tests ont leurs propres repères |
| `piexifjs` | MIT | dizaines de Kio | JPEG seulement | non : un seul format, plus maintenu depuis des années |
| `pdf-lib` | MIT | centaines de Kio | réécriture complète de PDF | non : taille, maintenance arrêtée, réécriture totale (risque de casser des PDF) |
| `mp4box.js` | BSD-3-Clause | centaines de Kio | analyse ISOBMFF | non : la neutralisation en place demande une centaine de lignes |
| `fflate` | MIT | une dizaine de Kio | ZIP et Deflate | non : `DecompressionStream('deflate-raw')` existe dans tous les navigateurs visés (Chrome 103, Safari 16.4, Firefox 113) et on écrit sans compression ; repli si absent : bureautique en `echec` |
| `ffmpeg.wasm` | LGPL / GPL | dizaines de Mo | tout, par remultiplexage | non : taille, licence, Workers et mémoire partagée (incompatibles avec « pas de COEP », §10) |

`pdfjs-dist`, déjà présent pour la visionneuse, sert seulement **dans les tests** à vérifier qu'un PDF nettoyé s'ouvre, a le même nombre de pages et le même texte.

**Fichiers d'essai**

- Générés localement, jamais une vraie photo : coordonnées GPS **fictives** repères (par exemple 12° 34′ 56″ N, 65° 43′ 21″ O), « ReperMake », « ReperModel », « ReperAuteur », « ReperSociete », « ReperLogiciel », dates 2001-02-03 04:05:06.
- `web/scripts/gen-fixtures.mjs` (sans dépendance, relancé en CI et comparé aux fichiers commités) construit octet par octet : JPEG (avec MPF, seconde image, vidéo de photo animée en fin), PNG, WebP, GIF, PDF (Info, XMP, miniature, mise à jour incrémentale, variante à flux xref, variante signée et chiffrée), DOCX, XLSX, PPTX, ODT minimaux, MP3, Ogg Opus, FLAC, WAV.
- `web/scripts/gen-media-fixtures.sh` (lancé à la main, versions des outils écrites en tête, résultats commités, chacun sous 200 Kio) : `ffmpeg` pour MP4, MOV (matrice de rotation 90°, piste `tmcd`, piste de métadonnées), M4A, WebM, MKV ; `exiftool` pour les repères GPS et appareil ; `heif-enc` et `avifenc` pour HEIC et AVIF.
- Assertions communes : aucun repère (ASCII, UTF-16 BE et LE, rationnels EXIF de la latitude repère) dans la sortie ; éléments gardés identiques (orientation, ICC, matrice, `colr`, flux compressés) ; sortie relue sans erreur (image décodée par `createImageBitmap`, `<video>` et `<audio>` : même durée à 0,1 s près, mêmes dimensions ; PDF ouvert par pdf.js ; ZIP relu, CRC justes) ; fichier tronqué ou piégé → `echec` sans exception ; jamais `nettoye` sur un échec.

### 35.3 Enregistrement dans l'interface

- **Vocal (V1)** : dans la page, `getUserMedia({ audio })` + `MediaRecorder` ; écran d'explication **avant** la demande du navigateur (« Shhdrop va demander l'accès au micro. L'enregistrement reste sur votre appareil et n'est chiffré qu'ici ») ; forme d'onde en direct (barres DOM, sans `<canvas>`) ; pause et reprise (le temps en pause ne compte pas) ; durée maximale 30 min, avertissement 1 min avant, arrêt automatique ; écoute avant d'ajouter, « Recommencer » ; refus, absence de micro, micro occupé : messages distincts avec la marche à suivre ; pistes arrêtées et `AudioContext` fermé à la fin, à l'annulation et à `pagehide` ; passage en arrière-plan → pause automatique. Sortie nettoyée par §35.2 avant l'ajout. **Audit F7** : si l'en-tête n'est ni le WebM ni le MP4 attendus (`stripCaptureMeta` rend `stripped: false`), l'écran de relecture le dit (« Ce format n'a pas pu être nettoyé : la date de l'enregistrement et le nom du navigateur peuvent y rester ») et ne propose que **Garder tel quel** ou **Annuler** ; rien ne part en silence (test `capture.spec.ts`, vocal au format inattendu).
- **Signalement (faible)** : l'audit de confidentialité (P13) propose d'interdire `AudioContext` et `getContext` dans `web/src` contre l'empreinte du navigateur. La forme d'onde a besoin d'un `AnalyserNode`, donc d'un `AudioContext` branché sur le micro : exception limitée à `web/src/media/recorder.ts` (aucun oscillateur, aucun `OfflineAudioContext`), et barres en DOM pour garder l'interdiction de `getContext`.
- `Permissions-Policy: microphone=(self)` : déjà en place (§10) ; `/pdf-frame.html` passe à `microphone=()`.
- **Vidéo dans la page (optionnelle, Q-REC1)** : `getUserMedia({ video, audio })`, aperçu, choix avant/arrière, durée maximale 5 min à 2,5 Mbit/s (environ 94 Mo), même nettoyage. Elle exige `camera=(self)`.
  - Ce qu'elle apporte : l'enregistrement par webcam **sur ordinateur**, où `capture` est ignoré (le sélecteur de fichiers s'ouvre) ; sur téléphone, `<input capture>` ouvre déjà l'appareil du système, de meilleure qualité.
  - Ce qu'elle coûte : avec `camera=(self)`, tout code servi par l'origine peut demander la caméra ; si la personne a choisi « toujours autoriser », un code piégé (§18.2) pourrait filmer **sans nouvelle demande**. C'est déjà vrai pour le micro, mais la caméra est plus grave. Sans elle, l'origine n'a jamais accès à la caméra.
  - **Retenue (Q-REC1)**, avec `camera=(self)` (§10) : l'autorisation n'est demandée qu'après un clic sur « Filmer ici », et les pistes sont coupées dès la fin ; repli `<input capture>`.

### 35.4 Questions ouvertes (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-MD1 | Échec du nettoyage : envoi silencieux, refus, ou choix | Choix explicite par fichier (« Envoyer tel quel » / « Retirer »), envoi bloqué jusque-là |
| Q-MD2 | HEIC/HEIF : nettoyer ou refuser | Nettoyer en place (§35.2) ; `echec` si la structure sort du cas simple |
| Q-MD3 | Modifications suivies (Office, ODF) | Laissées intactes (demande), détectées et signalées à l'écran |
| Q-REC1 | Vidéo enregistrée dans la page (`camera=(self)`) | **Acceptée (2026-11-07)** : photo, vidéo et vocal pris dans l'interface ; repli `<input capture>` |
| Q-STAT1 | Compteur de signalements | Garder un seul entier horaire, exposé en booléen sur `/healthz` local ; sinon, le serveur n'a plus aucun signal d'abus |

---

## 36. Ce que voit le serveur : minimisation

But : que le serveur, et quiconque le lit (hébergeur, pirate, réquisition), apprenne le moins possible. **Fait** = déjà dans la spécification et le code ; **À faire** = tâche M2 (interface) ou déploiement ; **Impossible** = avec la raison. Rien ici ne permet d'écrire « le serveur ne voit rien » à l'écran (§18.11).

| # | Ce qu'il voit ou peut déduire | Exposition actuelle | Réduction la plus forte, praticable | État |
|---|---|---|---|---|
| S1 | **Adresse IP** | en mémoire à chaque requête ; clés HMAC du jour pour les limites (§9.3) ; jamais sur disque côté application ; Caddy et l'hébergeur la voient | Caddy écrase `X-Shh-Client-IP` et ne journalise rien (journal global et d'accès vers `discard`) ; pilote de journal Docker `none`, journald `Storage=volatile`, swap et vidages mémoire coupés (§22) ; test avec une IP repère (texte et 4 octets) sur disque, stdout, stderr | Fait (application) ; **À faire** déploiement (pile) ; masquer l'adresse au serveur : **impossible** sans Tor (prévu plus tard, §3), car les limites par connexion en dépendent |
| S2 | **User-Agent, Referer, Accept-Language, Sec-CH-UA-*, Cookie, Origin** | envoyés par le navigateur ; `Referrer-Policy: no-referrer` ; le serveur Go ne les lit pas (vérifié par lecture) | Caddy les **retire avant de transmettre** au serveur (`header_up -User-Agent -Referer -Accept-Language -Cookie -Sec-CH-UA* -Sec-Fetch-*` sauf `Sec-Fetch-Site`, `-DNT -Priority`, sans `-Origin`) ; test de sources : aucun `r.UserAgent()`, `r.Referer()`, lecture d'en-tête (`Header.Get`, `Header.Values`, `Header[`) hors de la liste blanche du code actuel (`Authorization`, `X-Shh-Client-IP`, `X-Shh-Access`, `X-Shh-Manage`, `X-Shh-Grant`, `Sec-Fetch-Site` et `Content-Type` dans `api.go` seulement, pour refuser une requête d'un autre site et un corps JSON sans `application/json` avant le limiteur ; `Accept-Encoding`, lu seulement par `cmd/shhdrop/static.go` pour choisir la variante précompressée `.br` ou `.gz` d'un fichier du site, jamais gardé ni journalisé ; la longueur passe par `r.ContentLength`) | `Origin` est **gardé** par Caddy et lu par le seul `salonWS` (`handlers_salon_ws.go`), comparé octet pour octet à `SHH_ORIGIN` puis oublié : c'est la défense contre le détournement de WebSocket entre sites (§39.3.1, CH10) ; il ne révèle rien du visiteur (toujours l'origine du site) ; idem `Host`, `Connection`, `Upgrade`, `Sec-WebSocket-*` pour la poignée de main, sur ce seul fichier ; Caddy ne retire donc pas `Origin` : **prouvé** par `deploy/test-proxy.sh` (aucun en-tête retiré vers l'amont n'est `Origin`, `Upgrade`, `Connection` ni `Sec-WebSocket-*` dans la configuration adaptée ; `Origin` reçu tel quel par l'amont ; WebSocket ouvert à travers Caddy, 403 pour une origine étrangère ou absente ; une ligne `header_up -Origin` fait échouer le test). **Fait** M2 (test Go `api/minimize_test.go`) ; **À faire** déploiement (Caddy) |
| S3 | **Empreinte TLS** (JA3/JA4) | visible du seul Caddy, à la poignée de main | ni journalisée ni transmise (Caddy ne la transmet pas par défaut) | **Impossible** à supprimer : toute terminaison TLS la voit ; déploiement vérifie l'absence de journal |
| S4 | **Taille exacte** | **Résumé** : au repos, le palier seulement ; pendant l'envoi, qui commence dès l'ajout d'un fichier, la taille à 4 Mio près. Détail : v1 : palier seulement ; v2 envoi anticipé : à 4 Mio près (§29.7, §18.12) ; **et `fill_from` révèle à 4 Mio près le dernier segment de données même en envoi au clic** (erreur signalée : Q-K1 promettait le contraire) ; au repos, `segments_mask` est remis à « tous reçus » à `finalize` (revue K1, I3, fait) : la base ne garde que le palier | paliers inchangés (écart d'un palier au suivant : ×5 de 1 à 5 Mio, puis ×2 à ×2,5, ce qui reste raisonnable : plus fin fuit plus, plus grossier coûte la bande passante) ; (pas de mode au clic : l'envoi commence dès l'ajout, D41-19) | Envoi dès l'ajout pour tous (brouillon, §41.14) : fuite à 4 Mio près **assumée** (Q-K1) ; ancien `finalize` (`fill_from`, `fill_to`) **retiré le 24 novembre** (H-5) |
| S5 | **Nombre et horaire des segments** | à l'envoi : chaque `PUT` en direct, `progress_at` en base à la minute (§9.1) ; à la lecture : chaque `GET` | `progress_at` **en mémoire seulement** (un redémarrage tue de toute façon les envois, §7.7) ; aucune date de segment ailleurs ; cadence constante à l'envoi **non retenue** (Q-MIN3 : elle ne cache que le débit de la connexion, contre l'objectif de 5 s) | **Fait** M2 (`progress_at` en mémoire, colonne retirée par migration) ; cadence : non retenue |
| S6 | **Nombre d'éléments** | dans le manifeste chiffré (§29.3) | — | Fait |
| S7 | **Taille du manifeste** | réserve fixe dans le dernier morceau, longueur chiffrée (§29.3, K1) : les noms ne changent ni le palier ni le nombre de segments | — | Fait |
| S8 | **Types de fichiers** | dans le manifeste chiffré ; aucun type MIME n'est envoyé | — | Fait |
| S9 | **Quels éléments le destinataire ouvre** (non listé dans la demande, trouvé ici) | la lecture en flux télécharge les segments d'un élément quand on l'ouvre : l'ordre des `GET` trahit les frontières des éléments et ceux qui ont été vus | **lecture monotone** : après le segment de fin (manifeste), le navigateur ne demande que des numéros croissants ; ouvrir l'élément 5 télécharge (et jette) les segments qui le précèdent ; seul un nouvel essai réutilise un numéro (le budget de 2 × le paquet, §24, le permet) ; reste visible : jusqu'où la lecture est allée (§18.16) | **À faire** (client ; non livré par M2 : touche la file de téléchargement de la tâche R2, en cours) |
| S10 | **Saisie du mot de passe** | la pré-lecture « pendant la saisie » (§29.6) pourrait suivre les frappes | la pré-lecture démarre **dès la réponse de `meta`**, selon un calendrier fixe (segment de fin, puis 0, 1, 2… jusqu'à 64 Mio), jamais déclenchée par une frappe ; l'heure de `unlock` reste visible (elle **est** la fin de la saisie : impossible à cacher sans retarder la personne) | **À faire** (la pré-lecture de la tâche K3 n'existe pas encore) |
| S11 | **Heure de création** | non stockée ; déductible de `expires_at − ttl_hours` à 15 min près ; date de naissance du fichier (§18.6) | `ttl_hours` et `max_opens` mis à `NULL` après `finalize` s'ils ne servent plus (`max_opens` sert à « Ouvert 1 / 3 » : gardé) ; texte honnête « à 15 min près » ; date de naissance : impossible (système de fichiers) | **Fait** M2 (`ttl_hours` à `NULL` à `finalize` et par la migration) ; naissance : **impossible** |
| S12 | **Heure des ouvertures** | aucune heure stockée, mais `purge_at` = ceil15(dernière ouverture + 6 h) **date la dernière ouverture à 15 min près** (signalé) ; `atime` réglé par `O_NOATIME` et `noatime` ; budget de lecture : heure de la première lecture, en mémoire | `purge_at` et `upload_deadline` **en mémoire seulement** ; au démarrage, effacer tout partage `uploading` ou `draining` (aucun jeton ne survit à un redémarrage, §7.7, donc aucun lecteur ni envoi possible) ; la base ne garde alors qu'une date, `expires_at`, arrondie au quart d'heure ; le compte à rebours n'a besoin que de `expires_at` | **Fait** M2 (`PurgeAtStart`, échéances en mémoire, colonnes retirées) |
| S13 | **Nombre d'ouvertures** | `opens_left`, `opens_issued`, `done_mask` | nécessaire aux règles (§4) ; compteurs sans heure ; effacés avec le partage | Fait (nécessaire) |
| S14 | **Raison de la destruction** | champ `reason` libre de 64 caractères accepté puis ignoré | `reason` absent ou exactement `"report"` ; tout autre valeur → 400 ; jamais de texte libre | **Fait** M2 ; → **14 novembre 2026** (catégories, conception du compte §21.10.2) : `categorie` entier 1 à 10, seulement avec `"report"` (absente : 10 « Autre ») ; comptée en mémoire, jamais écrite (test `sees-nothing.test.ts`) |
| S15 | **Données anti-robot** | défi lié à la connexion ; sels consommés 2 min ; heures exactes des créations de l'heure par connexion, en mémoire ; (repli retiré le 24 novembre) | heures des créations arrondies à la minute (supérieure) ; rien sur disque | **Fait** M2 ; (repli retiré, aucun tiers) |
| S16 | **État des limites** | §9.5, mémoire, clés HMAC du jour ; correspondance « envoi en cours → connexion » (§29.5) | pas plus court : les quotas du jour exigent des clés du jour | Fait |
| S17 | **Journaux** | application : `ErrorLog` jeté, nettoyeur muet (une ligne fixe), aucune adresse (audit) | test : aucune sortie standard ou d'erreur ne contient d'adresse, d'identifiant, d'en-tête repère ; Caddy, Docker, journald : déploiement (S1) | Fait (application, test e2e « le serveur ne voit rien » avec repères, M2) ; **À faire** déploiement |
| S18 | **Messages d'erreur** | codes fixes (`not_found`, `bad_request`, `limit`, `busy`, `budget`, `internal`), JSON uniforme (§8) | test : aucune réponse ne recopie un identifiant, un chemin, un en-tête ou un corps reçu | Fait ; test M2 (`TestNoEcho`) |
| S19 | **Relectures de la page de gestion** | `manage/status` toutes les 60 s quand l'écran est visible (§33) : relie une connexion à un partage, en direct | relecture seulement écran visible (fait) ; aucune relecture en arrière-plan ni par le service worker ; aucune trace côté serveur | Fait |
| S20 | **Pré-calcul anti-robot et envoi anticipé** | le serveur sait qu'une composition est en cours (§29.4) | mode au clic **abandonné le 24 novembre** (D41-19) | **Assumé** |
| S21 | **Compteur de signalements** | prévu (§7.6), non codé | un entier horaire, booléen `reports_alert` sur `/healthz` local (vrai à partir de 5 dans l'heure), aucun identifiant (§9.5) | **Fait** M2 ; → s'ajoutent les compteurs par catégorie en mémoire, et pour un salon vivant signalé le nombre par catégorie jusqu'à sa fin (S77) |
| S22 à S27 | — | — | — | passkey de §37 jamais codée ; remplacés par S64 à S81 (compte par e-mail) |
| S28 | **Pass payant ↔ identité** (§38) | chez le vendeur officiel seulement (empreinte `Q`) | aucune référence de commande ni moyen de paiement chez nous ; pass rangé dans `B` : le serveur ignore quel compte le détient | **À faire** P1 ; → **14 novembre 2026** (R5) : pass rangé dans le coffre de profil **séquestré** : le serveur peut relier un compte à un pass (S75) |
| S29 | **Pass ↔ partages Plus** | aucun : jetons aveugles (RFC 9474, 9578) ; en direct, adresse et heure | émission par lots à heure aléatoire, longtemps avant usage ; variante sans jetons : liaison en direct (§38.4) | **À faire** P1 |
| S30 | **Partage Plus** | palier, durée ou ouvertures au-delà du gratuit | inévitable (règles appliquées par le serveur) ; ne dit pas qui a payé | Assumé |
| S48 | **Mode « première ouverture » et plafond de 7 jours** (§38.9.1) | `starts_on_first_open` et `hard_expires_at` en base pour un partage Plus ou Pro : le plafond **donne la date de création à 15 min près** (régression par rapport à S11, pour les partages payants seulement) | nécessaire à la règle ; correction possible : retrancher 0 à 3 h au hasard (Q-F1, défaut non) | Assumé (F-1) |
| S49 | **Heure du premier déverrouillage** | vue en direct ; `ttl_hours` remis à `NULL` au premier déverrouillage : la base ne garde que `expires_at` | rien de plus à retirer | Fait en conception (P4) |
| S50 | **Manifeste découpé** (§38.9.2) | l'en-tête en clair porte la version 3 : plus d'environ 200 éléments ; nombre de segments de fin | inévitable (l'en-tête est authentifié) | Assumé |
| S51 | **Parties d'un partage, fichiers à limite** (§38.9.5, §38.9.11) | nombre et paliers des parties, moment de chaque ajout (direct), que telle partie est limitée et son compteur de lectures | une partie par fichier à limite seulement quand l'expéditeur la demande | Assumé |
| S52 | **Liens par destinataire** (§38.9.7) | nombre de liens, compteur d'ouvertures de chacun, appartenance au même partage, révocations (direct) | noms des liens uniquement chez l'expéditeur | Assumé |
| S53 | **Ouverture programmée** (§38.9.6) | `opens_at`, au quart d'heure | nécessaire | Assumé |
| S54 | **Notification d'ouverture** (§38.9.8) | abonnements en mémoire seulement ; le service de notification du navigateur (Google, Apple, Mozilla, Microsoft) apprend qu'une adresse d'abonnement reçoit un message à cet instant ; contenu chiffré d'un octet | rien sur disque ; hôtes fermés | **Conditionnel** (Q-F3, F-8) |
| S55 | **Prolongation** (§38.9.4) | heure de la requête et nouvelle échéance (direct) ; aucune trace gardée sauf `expires_at` et le compteur de prolongations | — | Assumé |
| S56 | **Demandes de fichiers** (§38.9.3) | ligne `requests` (clé publique, limites, échéance), notes scellées de taille fixe, nombre de dépôts ; aucun lien de base entre une demande et les partages déposés ; adresse du déposant en direct | notes scellées à clé publique ; libellé dans le fragment du lien | Assumé |
| S57 | **Marque de la page de réception** (§38.9.9) | qu'une marque existe et sa taille fixe ; contenu scellé par `K_marque` | — | Assumé |
| S58 | **CLI / API** (§38.9.10) | mêmes requêtes qu'un navigateur ; `User-Agent` retiré comme les autres (S2) | — | Fait en conception |
| S59 | **Débit prioritaire** (§38.9.13) | le niveau du partage, déjà connu (S30) | — | Assumé |
| S60 | **Présence pendant la lecture** (§41.8) | `GET /api/shares/watch` tenue 25 s : le serveur sait, à la seconde près, que la page de l'ouverture est restée ouverte et visible | uniquement page visible et active ; pas de journal ; alternative : sonder toutes les 30 s (Q-GONE2) | Assumé (F-5) |
| S61 | **Ouvertures actives, fichiers détachés** (§41.8) | en mémoire : dernière heure de segment de chaque ouverture active ; sur disque : un fichier supprimé mais ouvert, jusqu'à 2 h après une suppression, uniquement pour une ouverture déjà commencée | aucune ouverture nouvelle ; coupure immédiate pour signalement, administrateur et exclusion | Assumé (F-4) |
| S62 | **Longueur des réponses chiffrées** (observateur du réseau : FAI, réseau d'entreprise) | TLS cache le contenu, pas la longueur. `unlock` : `last_open` en entier 0 ou 1 (même longueur), `opens_left` toujours d'un chiffre après une ouverture (9 au plus), octroi et jetons de longueur fixe : longueur constante. **Reste** : `opens_left` dans `meta`, un ou deux chiffres (10 contre 0 à 9) : un observateur apprend qu'un partage à 10 ouvertures n'a encore jamais été ouvert | encoder `opens_left` sur deux caractères ou bourrer la réponse de `meta` (non retenu : gain faible, format à changer aussi dans les apps) | Assumé (faible) |
| S64 | **Adresse e-mail en clair** (compte) | dans la requête (inscription, connexion, récupération, changement), puis en mémoire jusqu'à l'envoi | jamais écrite ; empreintes à clé `e_canon`, `e_envoi` ; file d'envoi en mémoire ; oubliée après l'envoi (au mieux : chaînes Go) | Fait (lots 2 à 4) ; testé |
| S65 | **Fournisseur d'envoi** | adresse, heure, code, adresse IP de la machine | fournisseur dans l'UE, suivi désactivé, contrat de sous-traitance ; un e-mail ne contient que le code ; aucun e-mail à l'initiative du serveur | Choix retenu (D1) |
| S66 | **Mot de passe** | jamais reçu ; `A_auth` (tiré par Argon2id sur l'appareil) reçu à chaque connexion | `v_mdp` = HMAC à clé de `A_auth` | Fait ; testé |
| S67 | **Existence d'un compte et ses dates** | `cree_jour`, `compte_des`, `pseudo_jour` au jour ; `vu_mois` au mois | aucune heure | Fait ; testé (multiples de 86 400) |
| S68 | **Compte ↔ salons créés** | `salons.compte`, le temps de vie du salon ; en direct : l'adresse IP qui crée | nécessaire au bannissement (D42-26) ; effacé avec le salon ; jamais vers les partages | Assumé |
| S69 | **Nombre de salons d'un compte, palier, signalements** | déductibles de `compte_des` et des lignes `salons` | — | Assumé |
| S70 | **Double authentification** | activée ou non ; secret scellé par `K_totp` ; codes en direct | secret rendu une seule fois (`totp/debut`) ; dernier pas en mémoire | Fait ; testé |
| S71 | **Sessions** | nombre par compte, mois d'ajout, « reste connecté », usage en direct | SHA-256 du jeton seulement ; nom d'appareil chiffré par l'appareil ; aucune IP, aucune heure | Fait ; testé |
| S72 | **Deux coffres** (profil, privé) | tailles au palier (4 à 256 Kio), écritures en direct | paliers | Fait |
| S73 | **Liste des bannis** | `e_canon`, identifiant aléatoire, début, échéance, état, motif (catégorie), salons fermés | 3 ans par défaut, 5 ans au plus ; jamais affichée avec une adresse | Fait |
| S74 | **Lien en direct compte ↔ partages** | même adresse IP qui se connecte puis crée un partage | le jeton de session ne part jamais vers les partages (testé) ; reste visible en direct (§18.18) | Assumé ; **impossible** sans Tor |
| S75 | **Profil séquestré** (pseudo, photo, langue, réglages, abonnement) | lisible par qui a `K_serveur` (serveur en marche, vol de la machine) ; au repos, `cle_profil` scellé par `K_sequestre` et coffre chiffré | exception écrite aux règles du projet (R-D1, validée le 14 novembre) ; le coffre privé (liens, gestion) reste chiffré par le mot de passe seulement | Assumé ; testé chiffré au repos |
| S76 | **Empreinte du pseudo** | `p_canon` en clair dans la requête, jamais gardé ; `p_empreinte` au repos | unicité seulement ; aucune recherche par pseudo | Fait ; testé |
| S77 | **Signalements par catégorie** | compteurs en mémoire depuis le démarrage ; catégories par salon vivant jusqu'à sa fin | rien sur disque sauf le motif d'un bannissement | Fait ; avis du juriste (R15) |
| S78 | **Attentes de sécurité** | `recup_jour`, `totp_retrait_jour` au jour | — | Fait |
| S79 | **Sauvegardes** | copies chiffrées de `comptes.db` 30 jours chez un tiers (qui voit la taille et l'heure d'envoi) | `age`, clé privée hors ligne, `K_serveur` jamais dedans | Fait (lot 8) |
| S80 | **Rejeu de suppression** | en direct, une même connexion détruit N partages juste avant de supprimer le compte | aucun lien compte ↔ partage ajouté au serveur | Assumé |
| S81 | **Liste des salons du compte** (`GET /api/compte/salons`) | déjà déductible de S68 ; `ref` éphémère en mémoire | aucun identifiant de salon ne sort | Fait |

Autres lignes : S31 à S43 et S63 pour le salon (§39.3.8) ; §40.7 : S44 à S47 pour l'envoi direct ; S48 à S61 ci-dessus : fonctions payantes (§38.9) et disparition pendant un téléchargement (§41.8) ; S62 : longueur des réponses (audit du 12 novembre). Dont S34 : « en train d'écrire » toujours actif — le serveur voit qui écrit et depuis combien de temps, à 2,5 s près (§39.3.7).

**Le test « le serveur ne voit rien » (§14) s'étend** (bloquant comme avant) : en plus des repères de contenu, de nom, de mot de passe et de clés, il envoie une **IP repère** (texte et 4 octets), un **User-Agent, un Referer et un Accept-Language repères**, un identifiant repère dans une route inconnue et un `reason` repère ; il exige : aucun de ces repères sur disque (base, WAL, fichiers), dans stdout, stderr ni dans une réponse ; base sans `progress_at`, `upload_deadline`, `purge_at` non nuls après `finalize` et sans `ttl_hours` ; toutes les dates de la base multiples de 900 s ; (mode au clic abandonné, ancienne finalisation retirée le 24 novembre, H-5 : le serveur refuse `fill_from`). **Compte** : le même test crée un compte, synchronise un coffre de compte qui contient des `S_gestion`, libellés et réglages repères, puis exige : aucun repère dans `accounts.db`, son WAL, stdout, stderr ni une réponse ; aucune valeur commune entre `accounts.db` et `shares.db` (`V_gestion`, `V_accès`, identifiants) ; aucune date de `accounts.db` qui ne soit un premier du mois à minuit UTC ; aucune requête vers `/api/shares/*` ou `/api/manage/*` qui porte `X-Shh-Session` ; après suppression du compte et arrêt, aucun octet de `B` dans le fichier de base. La fouille de la mémoire reste limitée aux repères de contenu et de clés : l'adresse et les en-têtes passent forcément par la mémoire du processus qui reçoit la requête ; derrière Caddy (déploiement), les en-têtes retirés ne doivent plus y apparaître.

**14 novembre 2026 — il s'étend au compte** (bloquant, `web/e2e/compte-sees-nothing.test.ts`) : vrai serveur `SHH_COMPTES=1`, faux SMTP de la boucle locale, vrai module de compte du site ; parcours complet (inscription avec adresse à majuscules, points et « + », pseudo à accents et photo ; connexion par une variante de l'adresse ; double authentification ; coffre privé rempli de liens repères ; pseudo, mot de passe et adresse changés ; adresse déjà inscrite ; adresse bannie depuis le tableau de bord ; mot de passe oublié avec code e-mail et code de l'application ; export ; suppression refusée 7 jours après la récupération ; suppression totale d'un second compte, salon fermé pour son membre, partage détruit). Il exige : aucun repère (adresses sous toutes leurs formes, mots de passe, `A_auth`, `KEK_mdp`, `K_compte`, `s_profil`, pseudos affichés et canoniques, photo, liens du coffre privé, secret TOTP, jetons de session et d'étape, adresses IP, User-Agent) dans le dossier de données (`comptes.db`, -wal, -shm, `shares.db`…), stdout, stderr ; aucun repère dans une requête hors de la place que le protocole lui donne, ni dans une réponse (le secret TOTP seulement dans `totp/debut`) ; `X-Shh-Session` seulement vers `/api/compte/*` et `POST /api/salons` ; le séquestre `cle_profil`, rouvert avec `K_serveur`, rend `s_profil` (chiffré au repos) ; seulement des BLOB et des INTEGER, dates au jour ou au mois ; chaque e-mail exactement le modèle unique (seuls la date, l'identifiant de message, le destinataire et le code changent) dans les cinq cas (adresse libre, prise, bannie, récupération, nouvelle adresse), sans pseudo, lien, adresse du site ni identifiant ; réponses du tableau de bord sans adresse, empreinte, `h`, pseudo ni lien ; mémoire du serveur sans mot de passe, `KEK_mdp`, `K_compte`, pseudo affiché, photo ni lien du coffre privé ; après la suppression et l'arrêt : rien du compte supprimé (`h`, empreintes, coffres, séquestre, sessions), rien des anciennes valeurs du compte gardé (empreintes de l'ancienne adresse et de l'ancien pseudo, ancien `v_mdp`, ancien coffre privé). **Non couverts ici** : la sauvegarde `age` (script de déploiement, lot 8, `make test-restauration`) et le relais SMTP (lot 8).

### 36.1 Questions ouvertes (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-MIN1 | Mode « au clic » : le navigateur envoie lui-même le bourrage (envoi jusqu'à 2 × plus long) | **Abandonné le 24 novembre** : plus de mode au clic (Q-K1) |
| Q-MIN2 | Lecture monotone chez le destinataire (S9) | Oui |
| Q-MIN3 | Cadence d'envoi constante | Non |
| Q-K1 (rappel) | Envoi anticipé par défaut | **Tranché le 24 novembre** : envoi dès l'ajout pour tous, sans mode au clic |

---

## 37. Compte facultatif

> **Référence** : identité, connexion, récupération, clés, routes, limites et données du compte suivent la conception `docs/conception/specs/2026-11-22-compte-passkey-design.md` (passkey et clé de récupération de 128 bits, enveloppes de `K_compte` par la sortie PRF de chaque passkey et par la clé ; ni e-mail, ni mot de passe, ni double authentification, ni séquestre ; identifiant de site `shhgone.com` ; la démo simule la passkey). Les sous-sections §37.1 à §37.11 posent les principes qui restent valables (compte facultatif, coffres chiffrés, absence de lien avec les partages, synchronisation, signalements) ; là où elles décrivent autre chose (routes, `SHH_ACCOUNTS`, clé de secours, limites), la conception fait foi. La conception intermédiaire par e-mail (`2026-11-14-compte-email-design.md`) n'est plus codée ; ses parties reprises (coffres, pseudo, profil, signalements par catégorie, tableau de bord) y restent décrites.
>
> **Ouverture** : le compte est ouvert au public dès le premier déploiement (`SHH_COMPTES=1`), risque assumé, sans le passage manuel sur appareils réels ni l'avis du juriste (§39.7).
>
> **Textes publics** : les textes qui décrivent le compte n'apparaissent qu'avec `__COMPTES__` (page Confidentialité : bloc « Si vous créez un compte », introduction, « Vos droits » ; Conditions : bloc « Compte » ; Sécurité : « Ce que le compte ne protège pas » ; carte « Partage sans compte » de l'accueil) ; les phrases communes restent vraies dans les deux cas (« il ne faut ni compte, ni adresse e-mail, ni téléphone » pour envoyer ou ouvrir un lien). À relire par le juriste.

Un **compte facultatif** existe. Il n'est **jamais** demandé pour envoyer, recevoir, gérer, garder dans le coffre ni signaler un partage ; il est exigé pour **créer un salon** (§39). Il sert aussi à **synchroniser entre appareils** des coffres de données chiffrés (historique des envois de §33, réglages, profil du salon) et à **ranger** un pass de l'offre payante (§38). Les contacts et annuaires restent exclus.

Désactivé par défaut côté serveur (`SHH_COMPTES=0`), activé en production ; dans la démo GitHub Pages, la passkey est simulée (identifiant de site WebAuthn `github.io` partagé avec tous les sites Pages, faux serveur en mémoire).

### 37.1 Identité : passkey seule

- **WebAuthn uniquement.** Aucun e-mail, nom, téléphone, pseudonyme ni mot de passe n'est demandé ou stocké côté serveur.
- **Création** (`navigator.credentials.create`) : `rp.id` = hôte de `SHH_ORIGIN` (`shhdrop.app`) ; `user.id` = **identifiant de compte** `H` (16 octets tirés par le serveur, `crypto/rand`) ; `user.name` = `user.displayName` = « Compte Shhdrop » (fixe, pour tous) ; `residentKey: "required"` (connexion sans saisie) ; `userVerification: "required"` ; `attestation: "none"` ; algorithmes `-7` (ES256) puis `-257` (RS256) ; `extensions: { prf: { eval: { first: E } } }` où `E` = SHA-256(« shhdrop/v2/compte/prf/1 ») (entrée fixe et publique : le secret est dans l'authentificateur, la sortie diffère pour chaque passkey ; le `/1` permet une rotation).
- **Connexion** (`navigator.credentials.get`) : `allowCredentials` vide (passkey découvrable), `userVerification: "required"`, même `prf.eval.first = E`. Le serveur retrouve le compte par `userHandle` = `H`, puis par l'identifiant de la passkey.
- **Vérification côté serveur** : bibliothèque **`github.com/go-webauthn/webauthn`** (licence BSD-3-Clause, à revérifier ), **version exacte épinglée** dans `go.mod`, dernière stable publiée depuis au moins 7 jours (§24), notée dans `THIRD_PARTY_LICENSES.md`, `govulncheck` vert. Elle ne fait que des vérifications de signatures avec la bibliothèque standard de Go : aucune crypto maison.
- **Ce qui est gardé par passkey** : identifiant de la passkey, clé publique, algorithme, et son enveloppe (§37.2). **Jamais** : AAGUID (modèle de l'authentificateur), transports, attestation, compteur de signatures (il changerait à chaque connexion et daterait l'activité ; les passkeys synchronisées renvoient 0 de toute façon), drapeaux de sauvegarde.
- **Récupération (facultative)** : une **clé de secours** `RK` (32 octets aléatoires, WebCrypto) est montrée **une seule fois** à la création : 52 caractères en base32 Crockford, groupés par 4, avec « Copier » et « Télécharger (.txt) ». La saisie est normalisée (majuscules, espaces et tirets retirés, `I`/`L` → `1`, `O` → `0`). Elle permet de se reconnecter et de déchiffrer sans aucune passkey. Le serveur n'en garde qu'un vérificateur (§37.2). Elle est **obligatoire** quand la passkey n'offre pas PRF (sinon rien ne permettrait de déchiffrer sur un autre appareil) ; proposée et refusable sinon, avec : « Sans clé de secours, perdre vos passkeys fait perdre cet historique. Vos partages, eux, continuent de fonctionner. »

### 37.2 Données à connaissance nulle : clés et coffre de compte

Aucune construction maison : HKDF-SHA-256 et AES-256-GCM de WebCrypto, aléa de `crypto.getRandomValues`. Toutes les clés importées sont **non extractibles**, les tampons intermédiaires mis à zéro au mieux (§18.4).

| Élément | Création | Où il vit |
|---|---|---|
| `K_compte` | 32 octets aléatoires, tirés une fois à la création du compte | jamais sur le serveur en clair ; en mémoire de la page pendant la session |
| `P_i` | sortie PRF de la passkey `i` pour l'entrée `E` (`prf.results.first`, 32 octets) | mémoire, le temps de l'enveloppe |
| `KEK_i` | HKDF(`P_i`, sel = vide, info = « shhdrop/v2/compte/enveloppe ») → AES-256-GCM | mémoire |
| `Env_i` | AES-256-GCM(`KEK_i`, nonce aléatoire de 12 octets, `K_compte`, données authentifiées = « SHH-ENV1 » ‖ `H` ‖ SHA-256(identifiant de la passkey `i`)) | serveur, avec la passkey `i` |
| `KEK_s` | HKDF(`RK`, sel = vide, info = « shhdrop/v2/compte/secours/enveloppe ») | mémoire |
| `Env_s` | AES-256-GCM(`KEK_s`, nonce aléatoire, `K_compte`, données authentifiées = « SHH-ENV1 » ‖ `H` ‖ « secours ») | serveur |
| `A_s` | HKDF(`RK`, info = « shhdrop/v2/compte/secours/acces ») | envoyé au serveur pour la connexion de secours |
| `V_s` | SHA-256(`A_s`) | serveur (index unique : la clé de secours retrouve le compte) |
| `K_blob` | HKDF(`K_compte`, info = « shhdrop/v2/compte/blob ») → AES-256-GCM | mémoire |
| `B` | voir ci-dessous | serveur |

- **Pourquoi pas d'Argon2id ici** : `P_i` et `RK` sont des secrets aléatoires de 256 bits, HKDF suffit (même règle que `K_lien`, §29). Une clé de secours choisie par l'utilisateur est refusée : elle n'est jamais tapée « de tête ».
- **Coffre de compte `B`** = « SHH-ACCT1 » (9 octets) ‖ `gen` (8 octets, entier croissant) ‖ nonce (12 octets) ‖ AES-256-GCM(`K_blob`, nonce, clair bourré, données authentifiées = « SHH-ACCT1 » ‖ `H` ‖ `gen`). Clair = longueur (4 octets) ‖ JSON ‖ zéros jusqu'au palier. **Paliers** de `B` : 4, 16, 64, 256 Kio, 1 Mio (plafond). Nonce aléatoire à chaque écriture (quelques milliers d'écritures au plus par clé : très loin de la limite de 2³² messages).
- **Contenu du JSON** (`v: 1`) : `history` (les entrées de §33 telles quelles : `S_gestion`, échéance, maximum d'ouvertures, libellé local, ouvertures observées ; **jamais** `K_lien`, mot de passe ni noms des éléments), `tombstones` (entrées retirées, gardées 7 jours pour la fusion), `settings` (langue, « Garder dans mon historique » par défaut, mode d'envoi de Q-K1), `pass` (secret du pass de §38, seulement si l'utilisateur l'y range).
- **Le coffre du téléphone (§27) n'est pas synchronisé**, ni son index : les paquets ne quittent jamais le téléphone, un index ailleurs ne servirait à rien et révélerait leur nombre et leurs échéances.
- **Retour en arrière** (un serveur malveillant ressert un ancien `B`) : chaque appareil garde le plus grand `gen` vu pour `H` (module `web/src/account/`, IndexedDB) et refuse un `gen` plus petit. Limite : un appareil neuf ne peut pas le détecter (§18.18).
- **Écritures concurrentes** : `PUT` avec `if_gen` ; si le serveur a déjà un `gen` plus grand → 409, le client relit, fusionne (union des entrées par identifiant local, `tombstones` appliquées, état le plus avancé gardé : `gone` l'emporte), réécrit avec `gen + 1`.
- **Appareil sans PRF** (authentificateur qui ne l'offre pas, vérifié par `getClientCapabilities()` puis par la présence de `prf.results`) : la passkey authentifie seulement ; `K_compte` est obtenue par la clé de secours, saisie une fois, puis gardée sur cet appareil enveloppée par une clé AES-GCM **non extractible** de WebCrypto dans IndexedDB (même protection honnête que §33 : elle ne vaut que le verrouillage de l'appareil). Jamais de repli silencieux : l'écran le dit.
- **PRF à la création** : certains navigateurs ne rendent pas `prf.results` pendant `create` ; le client enchaîne alors un `get` (un geste de plus, annoncé).

### 37.3 Sessions

- Routes exactes, « session récente » pour les actions sensibles, écriture différée de 2 à 12 min : §37.11. **Jeton de session en mémoire seulement**, pas de cookie : 32 octets aléatoires remis après une cérémonie réussie, envoyé dans l'en-tête `X-Shh-Session` **uniquement** par le module `web/src/account/`, et **jamais** vers `/api/shares/*` ni `/api/manage/*` (test de sources et test e2e). Le serveur ne garde que SHA-256(jeton) → `H` en mémoire ; durée 15 min sans usage, 2 h au plus ; un redémarrage les invalide toutes. Recharger la page redemande la passkey (un geste, qui redonne aussi `P_i`).
- **Pourquoi pas de cookie** : un cookie partirait avec chaque requête vers l'origine, y compris celles des partages, ce qui relierait compte et partages ; il faudrait aussi une protection CSRF. Si un cookie devenait nécessaire (application native, §16), il serait `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`, sans `Max-Age`, et la règle « jamais vers les partages » resterait testée.
- **Aucun suivi** : ni identifiant d'appareil, ni empreinte, ni historique de connexions, ni « derniers appareils connectés ».
- **Déconnexion** : le serveur oublie la session ; le client oublie `K_compte`, `K_blob`, le clair du coffre et la copie locale de l'historique synchronisé. **Correction de la demande** (signalée) : « la déconnexion détruit le coffre » ne peut viser que la copie locale ; détruire `B` sur le serveur à la déconnexion supprimerait l'historique de tous les appareils. Seule la **suppression du compte** efface `B` sur le serveur.

### 37.4 Ce qui est stocké, et l'absence de lien avec les partages

- **Base séparée** `accounts.db` (même dossier, mêmes règles que §9 : `secure_delete=ON`, `temp_store=MEMORY`, WAL vidé, droits 0600, `WITHOUT ROWID`), jamais jointe à `shares.db` : aucune colonne commune, aucune requête qui touche les deux.
  - `accounts` : `h` (clé), `created_month` (premier jour du mois UTC de création), `seen_month` (mois de la dernière connexion, pour l'effacement des comptes abandonnés), `blob` (`B`), `gen`, `v_s` et `env_s` (facultatifs).
  - `credentials` : `cred_id` (clé), `h`, `public_key`, `alg`, `env`.
- **Jamais stockés** : adresse IP, en-têtes, heure exacte, heure des écritures de `B`, nombre de connexions, lien entre `H` et un partage, un pass ou un paiement.
- **Aucun lien au repos entre compte et partages** : `S_gestion` n'existe que dans `B` chiffré ; les partages ne portent aucune trace du compte ; le pass (§38) est lui aussi dans `B`, donc le serveur ne sait pas quel compte détient quel pass.
- **En direct, un serveur compromis peut relier** (signalé, §18.18) : la même adresse IP qui écrit `B` vient de finaliser un partage, ou relit `manage/status` pour N partages juste après la connexion. Réductions : l'écriture de `B` après un nouvel envoi est **différée** d'un délai aléatoire de 2 à 12 min (§37.11 A-G2) (ou faite au prochain lancement), jamais immédiate ; les relectures de l'historique restent celles de §33 (60 s, écran visible), étalées au hasard sur la minute ; aucune requête de compte ne porte d'identifiant de partage.

### 37.5 Limites anti-abus

- **Création** : preuve de travail (§22 ; , retiré le 24 novembre) ; 3 comptes par jour par connexion et 10 par /48 (compteurs mémoire sur les clés HMAC du jour, §9.5) ; plafond global `SHH_ACCOUNTS_MAX` (10 000 par défaut).
- **Cérémonies** : défis WebAuthn en mémoire, usage unique, 2 min ; 60 requêtes de compte par minute par connexion (limite commune de §4) ; connexion de secours : 10 essais par heure par connexion.
- **Coffre** : `B` ≤ 1 Mio ; 60 écritures par heure par compte (compteur mémoire par `H`, oublié chaque heure) ; 10 passkeys au plus par compte.
- **Comptes abandonnés** : effacés quand `seen_month` a plus de 13 mois ; compte créé dont `B` est resté vide : effacé au bout de 30 jours (au mois près).

### 37.6 Plusieurs appareils, récupération, suppression

- **Passkey synchronisée** (trousseau iCloud, gestionnaire Google) : elle existe déjà sur les autres appareils du même écosystème, avec le même secret PRF ; « Se connecter » suffit.
- **Autre écosystème** : connexion par l'appareil qui a la passkey (QR code WebAuthn « hybride »), puis, session ouverte et `K_compte` en mémoire, « Ajouter cet appareil » crée une passkey locale et téléverse son `Env_i`. Si PRF manque sur l'un des deux, la clé de secours prend le relais.
- **Récupération** : « J'ai ma clé de secours » → `A_s` → session → `K_compte` par `Env_s` → nouvelle passkey et nouvelle enveloppe ; « Changer de clé de secours » remplace `V_s` et `Env_s` (l'ancienne ne sert plus à rien) ; « Retirer une passkey » supprime sa ligne (jamais la dernière s'il n'y a pas de clé de secours).
- **Rotation de `K_compte`** (passkey perdue ou volée) : « Révoquer et rechiffrer » tire une nouvelle `K_compte`, réécrit `B` et toutes les enveloppes, supprime la passkey retirée.
- **Suppression du compte** : confirmation sur place ; case **« Détruire aussi mes partages actifs »** (décochée par défaut : le client appelle `manage/destroy` pour chaque `S_gestion` avant de supprimer) ; le serveur supprime les lignes, vide le WAL **immédiatement** (`wal_checkpoint(TRUNCATE)`) et oublie les sessions ; le client efface sa copie locale. La passkey reste dans le gestionnaire de l'utilisateur : le site le dit, et le signale au navigateur quand l'API existe (`PublicKeyCredential.signalUnknownCredential`).

### 37.7 Parcours et textes

- **Où le compte apparaît** (jamais sur les pages du destinataire, jamais sur le chemin de l'envoi) :
  - menu de l'en-tête : lien discret **« Compte (facultatif) »** ;
  - `/envois` (§33) : ligne « Retrouver cet historique sur vos autres appareils » → **« Créer un compte (facultatif) »** ;
  - « Lien prêt » : sous la bascule « Garder dans mon historique », un lien texte de même niveau, jamais un bouton principal ni une fenêtre ;
  - page Sécurité : paragraphe « Le compte facultatif ».
- **Texte d'ouverture** de `/compte`, au-dessus du bouton « Créer avec une passkey » (et « Se connecter », « J'ai ma clé de secours », §37.11.4) : « **Facultatif. Sans e-mail. Votre historique est chiffré : nous ne pouvons pas le lire.** » Puis : « Il sert à retrouver vos envois sur vos autres appareils. Rien d'autre ne change : sans compte, tout fonctionne. » et un lien « Ce que le compte ne protège pas » vers la page Sécurité.
- **Parcours de création** : (1) texte d'ouverture ; (2) geste de la passkey (annulation → retour sans erreur, rien n'est créé) ; (3) si PRF manque : « Cet appareil ne permet pas de chiffrer avec la passkey. La clé de secours sera demandée sur chaque nouvel appareil. » ; (4) clé de secours (refusable si PRF) : affichage unique, Copier, Télécharger, case « Je l'ai rangée en lieu sûr » ; (5) « Ajouter l'historique de cet appareil au compte » (activé : c'est la raison d'être du compte) ; (6) « Compte créé. Synchronisation chiffrée active. »
- **Écran du compte** : état de synchronisation (« À jour » ou « Pas encore synchronisé »), passkeys (« Passkey 1, ajoutée en novembre 2026 », au mois près), Ajouter cet appareil, Clé de secours, Se déconnecter, Supprimer le compte.
- La phrase des écrans « Sans compte. Ni pour envoyer, ni pour recevoir. » devient « **Aucun compte nécessaire, ni pour envoyer, ni pour recevoir.** »

### 37.8 Routes

→ Remplacé par le tableau exact de §37.11.1. Toutes sous `/api/compte/`, JSON strict (§8), réponses uniformes, aucune donnée de partage. `inscription/debut` (preuve de travail) et `inscription/fin` ; `connexion/debut` et `connexion/fin` ; `secours` (`A_s`) ; `GET blob` et `PUT blob` (`if_gen`) ; `appareils` (ajout, retrait) ; `secours/renouveler` ; `deconnexion` ; `supprimer`. Les en-têtes lus s'ajoutent à la liste blanche de §36 S2 : `X-Shh-Session` seulement.

### 37.9 Signalements (vigilance)

| Gravité | Endroit | Problème | Correction |
|---|---|---|---|
| Élevée | §3 « Jamais : comptes » ; §33 « Plus tard » | contradiction avec la décision | amendés par renvoi à §37 ; profils et contacts restent exclus |
| Élevée | §37.4, liaison en direct | un serveur compromis relie compte et partages par l'adresse et l'heure | écriture différée et aléatoire, aucun cookie, limite §18.18 ; Tor (§3) seul l'éviterait |
| Élevée | §17, LCEN et décret 2021-1362 | un compte peut faire entrer l'exploitant dans les obligations de conservation des données de création de compte (identifiants, et données de paiement en cas de paiement) | avis du juriste (§20) **avant** d'activer `SHH_ACCOUNTS` en public ; la passkey ne livre aucune identité civile |
| Moyenne | texte imposé « nous ne pouvons pas le lire » | vrai seulement si le code servi n'est pas piégé (§18.2, §28.8) | garder la phrase, avec le lien « Ce que le compte ne protège pas » juste dessous (pas de formule absolue sans renvoi) |
| Moyenne | demande « la déconnexion détruit le coffre » | détruirait l'historique de tous les appareils | déconnexion = oubli local ; suppression du compte = effacement serveur (§37.3) |
| Moyenne | `seen_month`, `created_month` | dates stockées, même grossières | au mois près, nécessaires à l'effacement des comptes abandonnés ; listées en §36 |
| Faible | Confidentialité, §17 « pas de cookies » | reste vrai (aucun cookie) | la page Confidentialité décrit le compte, sa base et ses durées |
| Faible | `Permissions-Policy` (§10) | ne doit pas couper `publickey-credentials-create` / `-get` | `publickey-credentials-create=(self), publickey-credentials-get=(self)` explicites ; `()` sur `/pdf-frame.html` |

### 37.10 Questions ouvertes (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-A1 | Clé de secours obligatoire | Obligatoire sans PRF ; proposée et refusable avec PRF |
| Q-A2 | Synchronisation gratuite ou payante | **Gratuite** : quelques kilo-octets, et elle protège mieux que de recopier des liens à la main |
| Q-A3 | Session sans cookie (jeton en mémoire, passkey redemandée au rechargement) | Oui |
| Q-A4 | Effacement des comptes inactifs | 13 mois sans connexion |
| Q-A5 | Case « Détruire aussi mes partages actifs » à la suppression | Proposée, décochée |

### 37.11 Compléments : création, connexion, récupération

Compléments de §37.1 à §37.10 pour la création, la connexion et la récupération ; ceux qui modifient un choix écrit plus haut sont signalés. Les cérémonies et routes réellement codées sont celles de la conception du compte par passkey (§3, §6).

| # | Gravité | Endroit | Problème | Correction (intégrée ici) |
|---|---|---|---|---|
| A-G1 | Élevée | §37.7, texte d'ouverture | « l'unique bouton « Créer avec une passkey » » : **aucun chemin de connexion ni de récupération** à l'écran | `/compte` hors session : bouton principal « Créer avec une passkey », puis bouton secondaire « Se connecter » et lien « J'ai ma clé de secours » (§37.11.4) |
| A-G2 | Élevée | §37.3 et §37.4 | Contradiction : session oubliée après **15 min** sans usage, écriture de `B` différée de **2 à 30 min** : la plupart des écritures différées tomberaient après la fin de la session | délai ramené à **2 à 12 min** (choix validé modifié, signalé) ; si la session a expiré à l'échéance, l'écriture attend la prochaine connexion et l'écran dit « Pas encore synchronisé · Se connecter » ; jamais de demande de passkey surgie sans geste |
| A-G3 | Élevée | §37.8 | Routes nommées sans corps ni réponse ; « appareils » sans cérémonie ; rotation de `K_compte` sans route | tableau exact de §37.11.1 |
| A-G4 | Moyenne | §37.1, PRF absente au `create` | `inscription/fin` exige-t-elle une enveloppe que le client n'a pas encore ? | `env` facultatif à `inscription/fin` ; un compte sans aucune enveloppe (ni `env`, ni `env_s`) à la fin de sa première session est effacé (§37.11.2) |
| A-G5 | Moyenne | actions sensibles | un jeton de session lu dans la mémoire d'un onglet resté ouvert suffirait à supprimer le compte ou les passkeys | « session récente » exigée (créée par une cérémonie il y a moins de 5 min) pour `appareils/retirer`, `secours/renouveler`, `rechiffrer`, `supprimer` ; sinon 403 `recent` et l'écran redemande la passkey |
| A-G6 | Moyenne | clé de secours | 52 caractères recopiés à la main sans contrôle : une faute consomme un des 10 essais horaires et passe pour « clé inconnue » | **caractère de contrôle** Crockford (valeur mod 37, alphabet `0-9A-Z*~$=U`) en 53ᵉ position ; vérifié dans le navigateur avant tout appel : « Clé mal recopiée : vérifiez chaque groupe » ; saisie de vérification des 4 derniers caractères à la création |
| A-G7 | Moyenne | §37.7 « Passkey 1, ajoutée en novembre 2026 » | la table `credentials` n'a pas de date | colonne `added_month` (premier du mois UTC), comme `created_month` |
| A-G8 | Moyenne | §37.3 déconnexion | « oublie la copie locale de l'historique synchronisé » : les entrées créées sur cet appareil disparaîtraient aussi | chaque entrée de l'historique porte `origine: "local" | "compte"` ; la déconnexion retire seulement les entrées `compte` reçues d'autres appareils et oublie les clés |
| A-G9 | Faible | §37.1 | `E` désigne déjà l'enveloppe des partages (§29.2) | l'entrée PRF s'appelle `E_prf` dans le code et les tests (valeur inchangée) |
| A-G10 | Faible | §37.1, §37.8 | `SHH_ORIGIN` est cité mais n'existe pas dans la configuration du serveur | variable ajoutée : origine exacte `https://hôte[:port]` (http seulement pour la boucle locale, règle de §10) ; obligatoire si `SHH_ACCOUNTS=1` ; `rp.id` = son hôte |
| A-G11 | Faible | §37.1 et §29.8 | « `V_s` comparé en temps constant » et « index unique » se recouvrent | recherche par l'index sur SHA-256(`A_s`), comme `V_accès` (§29.8) : la durée ne dépend que de l'empreinte, que l'attaquant calcule lui-même ; aucun autre test de temps constant à écrire pour `V_s` |
| A-G12 | Faible | §18.18 | créer un compte juste après un envoi (lien depuis « Lien prêt ») relie en direct ce compte à cet envoi, quel que soit le délai d'écriture | dit dans le texte « Ce que le compte ne protège pas » ; la première écriture de `B` suit elle aussi le délai de 2 à 12 min si un `finalize` a eu lieu dans les 12 min |

#### 37.11.1 Routes exactes (remplace la liste de §37.8)

JSON strict (§8), base64url sans remplissage, longueurs exactes ; `H` = 22 caractères, jeton de session et `A_s` = 43, `env` et `env_s` = 80 (60 octets : nonce 12 ‖ `K_compte` chiffrée 32 ‖ étiquette 16), `blob` = taille exacte d'un palier. Erreurs : `not_found` (compte, passkey ou clé de secours inconnus, signature fausse : même corps), `bad_request`, `conflict` (409, avec `gen`), `recent` (403), `limit` (429), `busy` (503, `SHH_ACCOUNTS_MAX`). Les objets WebAuthn suivent les formats JSON de WebAuthn niveau 3 (`PublicKeyCredentialCreationOptionsJSON`, `RegistrationResponseJSON`, `AuthenticationResponseJSON`), lus par go-webauthn.

| Route | Authentification | Corps | Réponse |
|---|---|---|---|
| `POST /api/compte/inscription/debut` | preuve anti-robot (mêmes champs que `POST /api/shares`) | `{ captcha… }` | `{ options }` : `challenge` 32 octets, `user.id` = `H`, `excludeCredentials` vide |
| `POST /api/compte/inscription/fin` | défi (mémoire, 2 min, usage unique) | `{ credential, env?, v_s?, env_s? }` (`v_s` et `env_s` ensemble ou absents) | `{ session }` |
| `POST /api/compte/connexion/debut` | — | `{}` | `{ options }` (`allowCredentials` vide) |
| `POST /api/compte/connexion/fin` | défi | `{ credential }` | `{ session, h, env: string|null, blob: string|null, gen }` ; met `seen_month` à jour |
| `POST /api/compte/secours` | `A_s` (10 essais par heure par connexion) | `{ a_s }` | `{ session, h, env_s, blob: string|null, gen }` |
| `GET /api/compte/blob` | `X-Shh-Session` | — | `{ blob: string|null, gen }` |
| `PUT /api/compte/blob` | session | `{ if_gen, blob }` | `{ gen }` (= `if_gen + 1`) ; 409 `{ gen }` si le serveur a plus grand |
| `GET /api/compte/appareils` | session | — | `{ passkeys: [{ cred_id, added_month: "2026-11" }], secours: boolean }` |
| `POST /api/compte/appareils/debut` | session | `{}` | `{ options }` (`excludeCredentials` = passkeys du compte, 10 au plus) |
| `POST /api/compte/appareils/fin` | session + défi | `{ credential, env? }` | `{}` |
| `POST /api/compte/appareils/enveloppe` | session | `{ cred_id, env }` | `{}` (PRF obtenue par un `get` après le `create`) |
| `POST /api/compte/appareils/retirer` | session **récente** | `{ cred_id }` | `{}` ; refus `bad_request` pour la dernière passkey sans clé de secours |
| `POST /api/compte/secours/renouveler` | session récente | `{ v_s, env_s }` ou `{}` (retrait, permis seulement s'il reste une passkey avec `env`) | `{}` |
| `POST /api/compte/rechiffrer` | session récente | `{ if_gen, blob, envs: [{ cred_id, env }], v_s?, env_s?, retirer?: cred_id }` (toutes les enveloppes restantes, en une transaction) | `{ gen }` |
| `POST /api/compte/deconnexion` | session | `{}` | `{}` |
| `POST /api/compte/supprimer` | session récente | `{}` | `{}` (lignes effacées, `wal_checkpoint(TRUNCATE)`, sessions du compte oubliées) |

#### 37.11.2 Création, pas à pas

1. Le navigateur demande `inscription/debut` (preuve anti-robot, §22) ; le serveur tire `H`, garde en mémoire `défi → H` (2 min).
2. `navigator.credentials.create` (paramètres de §37.1). Annulation (`NotAllowedError`) → retour à l'écran, rien n'est envoyé ; le défi expire seul.
3. Le navigateur tire `K_compte`. Si `prf.results.first` est rendu : `env` = enveloppe de §37.2. Sinon, si `getClientCapabilities()` annonce PRF : un `get` avec `allowCredentials` = cette passkey (un geste de plus, annoncé « Une deuxième confirmation est nécessaire ») ; sinon, clé de secours **obligatoire** (Q-A1).
4. Clé de secours (si choisie ou obligatoire) : `RK` tirée, affichée une fois (13 groupes de 4 caractères + contrôle), « Copier », « Télécharger (.txt) », puis saisie des 4 derniers caractères pour confirmer.
5. `inscription/fin` : le serveur vérifie la cérémonie (origine `SHH_ORIGIN`, `rp.id`, défi, vérification de l'utilisateur, algorithme ES256 ou RS256), crée `accounts` et `credentials` (`added_month`), rend une session.
6. `appareils/enveloppe` si `env` a été obtenue à l'étape 3 par le `get`.
7. Premier `PUT blob` (`if_gen: 0`) avec l'historique local si la case de §37.7 (5) est cochée, sinon un coffre vide au palier de 4 Kio (délai de A-G12).
8. Un compte qui n'a, à la fin de sa première session, **ni `env` ni `env_s`** est effacé par le serveur (rien ne permettrait de le rouvrir).

#### 37.11.3 Connexion et récupération, pas à pas

- **Connexion** : `connexion/debut` → `navigator.credentials.get` (`userVerification: "required"`, `prf.eval.first = E_prf`) → `connexion/fin`. Le serveur trouve la passkey par son identifiant (index unique), vérifie que `userHandle`, s'il est rendu, vaut son `H`, vérifie la signature ; le compteur de signatures n'est ni lu ni stocké (go-webauthn : avertissement de clonage ignoré, compteur passé à 0). Puis le navigateur obtient `K_compte` : par `env` et la sortie PRF ; sinon par la clé enveloppée localement (appareil sans PRF déjà enrôlé, §37.2) ; sinon il demande la clé de secours (« Cet appareil ne permet pas de chiffrer avec la passkey : entrez votre clé de secours une fois »). Il ouvre `B` (refus d'un `gen` plus petit que le plus grand vu sur cet appareil), fusionne avec l'historique local, puis programme l'écriture différée.
- **Récupération** : « J'ai ma clé de secours » → saisie normalisée, caractère de contrôle vérifié localement → `A_s` → `secours` → `K_compte` par `Env_s` → écran « Ajouter une passkey sur cet appareil » (`appareils/debut` et `/fin`, avec `env` si PRF), proposé tout de suite ; refusé : la session vaut 15 min, et l'écran dit qu'il faudra la clé à la prochaine visite.
- **Après une récupération pour passkey volée** : l'écran propose « Révoquer et rechiffrer » (`rechiffrer`, §37.6), qui retire la passkey choisie et change `K_compte`.
- **Session** : 15 min sans usage, 2 h au plus (§37.3, inchangé) ; une écriture différée qui tombe après l'expiration attend la prochaine connexion (A-G2).

#### 37.11.4 Écrans de `/compte` (complète §37.7)

- **Hors session** : texte d'ouverture inchangé, puis « Créer avec une passkey » (`primary`), « Se connecter » (`secondary`), lien « J'ai ma clé de secours », lien « Ce que le compte ne protège pas ».
- **Erreurs** : annulation de la passkey → aucun message ; `not_found` à la connexion → « Aucun compte ne correspond à cette passkey. » ; `not_found` au secours → « Clé de secours inconnue. » ; `limit` → « Trop d'essais. Réessayez dans une heure. » ; `busy` → « Les comptes sont momentanément complets. » ; navigateur sans WebAuthn → « Ce navigateur ne gère pas les passkeys. Rien n'est perdu : tout Shhdrop fonctionne sans compte. »
- **En session** : écran de §37.7 ; « Pas encore synchronisé · Se connecter » quand une écriture attend une session.

#### 37.11.5 Questions ouvertes ajoutées (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-A6 | Délai de l'écriture différée | 2 à 12 min (pour tenir dans la session de 15 min) |
| Q-A7 | Caractère de contrôle de la clé de secours | Oui (53 caractères au lieu de 52) |

---

## 38. Offre payante facultative (« patte blanche »)

Le service gratuit reste **complet, privé et honnête** ; qui veut plus de capacité ou de confort peut payer. **Référence** pour le moyen de paiement, le pass, les jetons, la conformité et la configuration : conception `docs/conception/specs/2026-11-19-paiement-design.md` (Stripe, PayPal, NOWPayments ; routes `/api/paiement/*` seulement avec `SHH_PAIEMENT=1`). Cette section garde les règles d'honnêteté (§38.1), le partage entre gratuit et payant (§38.2), les limites (§38.8) et les fonctions payantes prévues (§38.9).

### 38.1 Règle d'honnêteté

> **Offre visible (D41-16, §41.13)** : en plus de `/offre`, l'expéditeur voit dans le composeur les choix payants **verrouillés** (badge « Plus ») et, au dépassement de la taille gratuite, une ligne neutre « Avec Plus : jusqu'à 10 Go et 7 jours. ». Le reste de cette section tient : aucun motif trompeur, rien pour le destinataire.

- L'offre payante n'apporte **aucune sécurité de plus** : même chiffrement, mêmes règles, même code, mêmes garanties que le gratuit. Seulement de la capacité ou du confort.
- **Aucun motif trompeur** : pas de compte à rebours promotionnel, pas de case précochée, pas de « plus que 2 places », (D41-32 : renouvellement automatique **facultatif**, jamais présélectionné, résiliable à tout moment en un clic, sans frais), pas de prix barré fictif, pas de relance par e-mail (il n'y en a pas), pas de fonction gratuite retirée pour vendre.
- **Le destinataire ne voit jamais l'offre** : aucune mention sur les pages d'ouverture, de contenu ni de coffre. L'expéditeur la voit seulement sur la page `/offre`, et d'une ligne neutre quand il atteint une limite (« Au-delà de 1 Go : offre Plus, facultative »).
- Prix affichés TTC, durée exacte, ce qui se passe à la fin (« le pass s'arrête, rien n'est prélevé »).

### 38.2 Gratuit pour toujours, et ce qui peut être payant

**Gratuit pour toujours** (tout ce qu'il faut pour partager en privé) : chiffrement de bout en bout, mot de passe, tous les types de contenu, nettoyage des métadonnées (§35.2), jusqu'à 200 éléments et 2 Gio par lien, durées 1 h à 24 h, 1 à 5 ouvertures, lien de gestion et destruction, droits du destinataire (§34), historique local (§33), signalement, code vérifiable (§28), compte facultatif et synchronisation (§37, Q-A2).

| Fonction | Gratuit | Payant (limites exactes : §38.8.1) | Règle |
|---|---|---|---|
| Taille par lien | 2 Gio | Plus 10 Gio, Pro 30 Gio | Réserve de stockage séparée (§38.6) |
| Durée de vie | 1, 6, 12, 24 h | Plus 2 ou 3 jours, Pro aussi 7 jours | Toujours arrondie au quart d'heure |
| Ouvertures | 1 à 5 | Plus jusqu'à 10, Pro jusqu'à 20 | Sortie par partage plafonnée (§38.6) |
| Échéance personnalisée | non | date et heure dans la plage permise (pas codé) | Confort, sans coût |
| « Demander des fichiers » (lien de dépôt) | version de base (limites gratuites) | limites de la formule | Spécifiée en §38.9.3 (pas codée) |
| Historique synchronisé | retiré (D42-27) | — | — |
| Coffre du téléphone | 2 Gio, 20 entrées (§27.3, pas construit) | — | **Non** : stockage du téléphone de l'utilisateur, qui ne nous coûte rien ; le vendre serait malhonnête |
| Partages payants | — | Plus 30, Pro 100 par période de 30 jours | Borne le disque (§38.6) |

### 38.3 Paiement respectueux de la vie privée : comparaison

| Option | Pour | Contre | Avis |
|---|---|---|---|
| **Numéro de compte à la Mullvad** (numéro aléatoire, aucun e-mail) | aucun identifiant personnel chez nous ; éprouvé | seul, il ne dit pas comment payer ; le numéro est un secret au porteur | **Retenu comme forme du droit** : le « pass » de §38.4 est ce numéro |
| **Carte via un prestataire** | simple pour tous, remboursements, conformité TVA | le prestataire voit l'identité et la carte | **Retenu en premier**, avec un **vendeur officiel (« Merchant of Record »**, par exemple Paddle ou FastSpring, à comparer) : il vend en son nom, facture, collecte la TVA de chaque pays et garde les preuves de localisation ; nous ne recevons qu'une référence de commande et l'empreinte du pass |
| **Espèces par courrier, bons prépayés** | très anonyme | adresse postale de l'exploitant à publier, saisie et comptabilité de chaque enveloppe, pertes ; bons chez des revendeurs : contrats et commissions | **Non** au lancement ; bons vendus par le vendeur officiel (cartes cadeaux) possibles plus tard |
| **Monero** | paiement privé par conception | retiré de la plupart des plateformes de l'UE : conversion légale en euros difficile ; volatilité ; comptabilité de chaque paiement | **Non** au lancement ; à revoir si une plateforme agréée (MiCA) le convertit |
| **Bitcoin** (BTCPay Server, logiciel libre MIT, auto-hébergé, Lightning) | aucun tiers de paiement ; Lightning discret | registre public (paiements on-chain traçables) ; conversion par une plateforme agréée (KYC de l'exploitant) ; volatilité ; un serveur de plus à tenir | **Plus tard** (deuxième moyen), sur une machine distincte de celle des partages |
| **Jetons d'accès anonymes** (signature aveugle, Privacy Pass) | le serveur vérifie « payé » sans savoir qui, ni relier deux partages Plus | crypto hors WebCrypto/libsodium : **exception aux règles du projet** ; un peu plus de code | **Retenu pour l'usage** (quel que soit le moyen de paiement) |

**Retenu** (conception du paiement) : paiement par **redirection** vers la page hébergée de **Stripe** (carte), **PayPal** ou **NOWPayments** (crypto), jamais de script du prestataire dans nos pages ; l'exploitant est le vendeur (TVA en OSS, factures, remboursements) ; sous `SHH_TVA=oss`, la crypto n'est ni proposée ni acceptée (une seule preuve de localisation). Le pass est un numéro au porteur à la Mullvad, jamais relié à un compte par le serveur ; chaque partage payant est autorisé par un **jeton Privacy Pass** non reliable. Le tableau ci-dessus garde les raisons de l'étude ; le vendeur officiel (« Merchant of Record ») et BTCPay ne sont pas retenus. Pas d'espèces ni de Monero.

### 38.4 Droit d'usage : pass, puis jetons aveugles

- **Pass** : l'appareil tire `P` (32 octets ; WebCrypto, apps : générateur du système) **avant** le paiement et ne l'envoie que dans l'en-tête `X-Shh-Pass`, vers `/api/paiement/*`. Le serveur calcule `Q` = SHA-256(« shhdrop/v2/pass » ‖ 0x00 ‖ `P`) (DP-6) et ne garde que `Q`, l'offre, des jours et la réserve de jetons, dans `paiements.db`, séparée de `shares.db` et `comptes.db` : aucune identité, aucun pays, aucun montant, aucune adresse IP. Le prestataire reçoit un identifiant de commande aléatoire, jamais `Q` (DP-2). Remboursement, litige ou rétractation → pass révoqué. `P` est gardé sur l'appareil, ou rangé dans le coffre privé du compte (le serveur ne sait pas quel compte le détient).
- **Ce que chacun relie** : le prestataire, identité du payeur ↔ commande ; le serveur, au repos, commande ↔ `Q` (S6) et l'identifiant d'abonnement du prestataire (il sert à résilier) ; jamais de lien avec un partage, un salon ou un compte. Les jetons aveugles empêchent de relier `Q` aux partages.
- **Jetons** : protocole **Privacy Pass** (architecture RFC 9576, émission RFC 9578), type **2, RSA aveugle publiquement vérifiable**, **RSABSSA-SHA384-PSS-Deterministic** (RFC 9474 ; S8), présentés dans l'en-tête `Authorization: PrivateToken` (RFC 9577). Bibliothèques vérifiées, aucune crypto maison : moteur Rust **`blind-rsa-signatures` = 0.19.0** (site et apps), serveur **`github.com/cloudflare/circl` v1.6.5** (`blindsign/blindrsa`) ; versions exactes épinglées après revue de chaîne d'approvisionnement ; mêmes résultats prouvés par `engine/vectors/privacypass.json`. **Exception écrite aux règles du projet** (Q-P2). Paramètres exacts, émission, dépense et révocation : conception du paiement §7.
  - Émission : `POST /api/paiement/jetons` avec `P`, par lots (5 au plus par requête), au plus 10 (Plus) ou 20 (Pro) jetons par pass et par jour UTC ; réapprovisionnement à une heure tirée au hasard, longtemps avant usage (S16).
  - Usage : `POST /api/shares` avec un jeton ; le serveur vérifie la signature, refuse un jeton déjà vu (`depenses`, SHA-256 du jeton et jour), applique les limites de la formule de la clé à **ce** partage, ne garde rien qui relie le partage au jeton.
  - Clés d'émission : une par offre et par jour UTC, tirées 7 jours à l'avance et servies à tous (`GET /api/paiement/jetons/cles`, S17) ; un jeton n'est accepté que le jour de sa clé et le lendemain.
  - Post-quantique (§30) : l'anonymat d'une signature aveugle RSA est inconditionnel ; un ordinateur quantique permettrait de **forger** des jetons (fraude), pas de lever l'anonymat.
- **Ce qui reste visible au repos** : qu'un partage est payant (palier > 2 Gio, durée > 24 h ou ouvertures > 5), pas lequel des payeurs l'a créé.

### 38.5 Cadre légal et fiscal (exploitant en France, avis d'un juriste requis)

- **Statut** : vendre est une activité professionnelle. Il faut un statut (micro-entreprise ou société) **avant** la première vente. Conséquence directe : les mentions légales d'un professionnel (LCEN art. 6) publient le nom ou la dénomination, l'adresse et le numéro d'immatriculation ; l'anonymat du « particulier non professionnel » de §17 disparaît (une domiciliation d'entreprise évite l'adresse personnelle). **Juriste.**
- **Factures** : en vente aux particuliers, la note est obligatoire pour une prestation de services à partir de 25 € TTC, ou sur demande ; conservation comptable 10 ans (Code de commerce L123-22). Avec un vendeur officiel, c'est **lui** qui vend et facture le client : nous ne facturons que le vendeur (facture entre entreprises, soumise à la facturation électronique de 2026–2027). **C'est ce qui résout le conflit** entre « aucune donnée personnelle » et l'obligation de facturer : l'identité reste chez le vendeur. **Comptable.**
- **TVA** : services électroniques aux particuliers de l'UE : TVA du pays du client au-delà de 10 000 € de ventes vers d'autres États membres par an (guichet OSS), ce qui exige des preuves de localisation du client (adresse, IP, banque) : **en conflit direct** avec « aucune IP enregistrée » si nous vendions nous-mêmes. Franchise en base possible selon le seuil en vigueur ; hors UE, règles de chaque pays. Le vendeur officiel porte tout cela. **Comptable.**
- **Droit de la consommation** : information précontractuelle et **CGV** (Code de la consommation L111-1, L221-5) ; **droit de rétractation de 14 jours** (L221-18) ; pour un pass utilisable tout de suite, la perte du droit exige un accord exprès et un renoncement exprès avant l'usage (L221-28) : case **non cochée** au paiement, sinon remboursement au prorata ; **médiateur de la consommation** obligatoire (L612-1) ; pas d'abonnement, donc pas de « résiliation en trois clics » à prévoir (L215-1-1). **Juriste.**
- **Données personnelles** : le vendeur officiel est responsable de ses propres traitements ; la page Confidentialité le nomme et dit ce qu'il voit. Décret 2021-1362 (§17, §37.9) : vérifier si des données de paiement doivent être conservées par nous ; avec un vendeur officiel, nous n'en avons pas. **Juriste.**
- **Bitcoin** (si retenu) : accepter un paiement n'est pas une activité de prestataire de services sur crypto-actifs ; la conversion passe par une plateforme agréée MiCA ; chaque encaissement est une recette à comptabiliser à sa valeur en euros. **Comptable.**
- **Cryptologie** (§17) : la déclaration ANSSI doit couvrir une fourniture commerciale. **Juriste.**
- **Contenus illicites** : des liens plus gros, plus longs et plus ouverts attirent la diffusion de masse (piratage, pires contenus) ; DSA (point de contact, notification) et capacité de traiter les signalements à dimensionner avant P2.

### 38.6 Coût du serveur et abus des paliers plus grands

- **Disque** : un partage de 10 Gio pendant 7 jours occupe 5 % de la réserve payante de 300 Gio ; un pass Plus de 30 liens peut, au pire, garder 300 Gio d'un coup. D'où : **réserve payante séparée** `SHH_STORAGE_PLUS_MAX` (300 Gio par défaut, en plus de `SHH_STORAGE_MAX`) ; quand elle est pleine, refus honnête « Capacité Plus momentanément pleine, réessayez plus tard » (503) ; jamais de place prise sur le gratuit.
- **Bande passante** : sortie au pire = taille × ouvertures × 2 (budget de §24) : Plus 100 Go par lien, jusqu'à 200 Go ; Pro 250 Go par lien. Plafonds « taille × ouvertures » par partage (§38.8.1), à comparer au trafic inclus de l'hébergeur (§20).
- **Plafond de sortie par partage (décision 12, avant la première vente)** : le plafond « taille × ouvertures » n'avait jamais été codé ; avec les budgets de lecture de §24 et D42-22 (2 × le fichier, plus 3 relectures complètes par ouverture au plus), un partage Pro de 30 Go à 20 ouvertures pouvait servir environ 3 To. **Fait** : le serveur compte, **en mémoire seulement**, les octets servis par partage, toutes ouvertures confondues (`share/budget.go`, tests `TestEgressLimitPerShare`, `TestEgressCounterForgotten`), et refuse au-delà de **`SHH_SHARE_EGRESS_MAX`** (octets ; **250 Gio par défaut**, au moins 32 Gio, un téléchargement complet du plus grand palier payant). Défaut tiré de cette analyse : le plafond « taille × ouvertures ≤ 250 Go » du Pro (§38.8.1, Q-P11). Le plafond vaut pour tout partage, sans connaître la formule (elle n'est pas gardée après la finalisation, conception du paiement §11) : un gratuit (2 Go × 5) ne l'atteint jamais, un Plus (10 Go × 10) seulement en relisant beaucoup, un Pro de 30 Go sert environ 8 téléchargements complets (signalement (a) de la décision du 17 novembre, ci-dessous : « le dire à l'écran »). **Effets** : (1) une fois le plafond atteint, chaque segment est refusé, **403 `egress_limit`** ; (2) une **nouvelle ouverture** est refusée de même, après le bon mot de passe, dès qu'un téléchargement complet ne tiendrait plus sous le plafond, **sans consommer d'ouverture ni d'essai** (un mot de passe faux reste un essai faux : le plafond ne se lit pas sans le mot de passe) ; (3) le site affiche « Ce partage a atteint sa limite de téléchargement. » / « This share has reached its download limit. » (**fait le 24 novembre** : `EgressLimitError` dans `web/src/transfer/`, écran d'ouverture `flows/receive.svelte.ts` état `egress`, téléchargements `flows/downloads.svelte.ts`, visionneuses `viewers/ViewerPanel.svelte`, textes `egress`, `egress.hint` et `dl.fail.egress` de `i18n/`) : erreur **définitive**, **aucun nouvel essai** proposé, et le **fichier partiel est supprimé** ; le faux serveur de la démo la produit avec `?plafond` (UI §14.3). **Ce que voit le serveur** : rien de nouveau sur le disque ; en mémoire, un entier par partage, sans adresse ni heure (§9.5). **Limites assumées** : (a) un redémarrage remet les compteurs à zéro, mais invalide aussi tous les jetons et octrois (§41.4) : chaque lecteur doit consommer une nouvelle ouverture, donc le total reste borné par les ouvertures ; (b) des lectures simultanées d'un même partage peuvent couper un téléchargement en cours au moment où le plafond est atteint ; (c) par pass de 30 jours, au pire 30 × 250 Gio (Plus) et 100 × 250 Gio (Pro) de sortie.
- **Quotas par connexion** maintenus pour les partages payants (envois à part : Plus 40 Gio par jour par connexion et 80 par /48 ; Pro 100 et 200) : un pass volé ne permet pas de saturer le disque depuis une seule adresse.
- **Jetons** : un jeton = un partage Plus ; émission bornée par `tokens_left` ; un pass partagé publiquement s'épuise vite, et se révoque (remboursement, abus constaté par le vendeur).

### 38.7 Questions ouvertes (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-P1 | Moyen de paiement | **Tranché** : Stripe, PayPal et NOWPayments par redirection, l'exploitant étant le vendeur (conception du paiement ; remplace le choix de Paddle) |
| Q-P2 | Exception à la règle crypto pour Privacy Pass | **Acceptée** : `blind-rsa-signatures` = 0.19.0 (moteur) et circl v1.6.5 (serveur), après revue de chaîne d'approvisionnement ; exception écrite dans les règles du projet |
| Q-P3 | Limites Plus et Pro | Tranchée : §38.8.1 |
| Q-P4 | Abonnement ou prépayé | **Tranché par D41-34** : mensuel en abonnement renouvelé automatiquement (paiement unique de 30 jours en crypto) ; annuel au choix, paiement unique ou renouvellement automatique ; résiliable à tout moment en un clic, sans frais (conception du paiement §1) |
| Q-P5 | Statut juridique de l'exploitant | À décider avec le juriste et le comptable avant P1 (micro-entreprise avec domiciliation ou société) ; l'exploitant indique que le statut et le cadre légal sont prêts. **Restent à fournir avant la première vente** (§38.5) : identité professionnelle pour les mentions légales (dénomination, adresse ou domiciliation, immatriculation), CGV, médiateur de la consommation, texte de renonciation au droit de rétractation (case non cochée), avis du juriste sur la conservation des données de création de compte (D8) |
| Q-P6 | « Demander des fichiers » | Base gratuite, limites Plus payantes ; spécifiée en §38.9.3 |
| Q-P7 | Coffre plus grand payant | Non |

### 38.8 Deux formules, « Plus » et « Pro » : limites et prix

**Aucune formule n'apporte de sécurité de plus** : seulement de la capacité et du confort. Le gratuit reste complet et privé. Rythmes : mensuel en abonnement renouvelé automatiquement (paiement unique de 30 jours en crypto), annuel en paiement unique ou renouvellement automatique, résiliable en un clic (D41-34, conception du paiement §1). Valeurs lues dans un seul endroit par couche : `web/src/limits.ts` (`PAID`) et `server/internal/share/tier.go`, `server/internal/paiement/offres.go` ; un test compare les deux.

#### 38.8.1 Ce que donne chaque formule

> **Ouvertures et taille Pro** : gratuit **1 à 5 ouvertures** (serveur `share.MaxOpens` et `web/src/limits.ts`, `MAX_OPENS`, même valeur, refus au-delà) ; **Plus : jusqu'à 10** ; **Pro : jusqu'à 20** ; **Pro : 30 Go par partage**. **Signalements** : (a) **moyenne, exploitation** : avec 30 Go × 20 ouvertures, le plafond « taille × ouvertures ≤ 250 Go » du Pro bride un partage de 30 Go à 8 ouvertures ; à trancher avant P2 (relever le plafond à 600 Go, ou le dire à l'écran) ; (b) **faible, exactitude** : le palier Pro de 30 Gio (491 521 morceaux) remplace celui de 50 Gio dans la liste des paliers payants, à reprendre  ; (c) **faible, usage** : un partage gratuit pour plus de 5 personnes demande désormais plusieurs liens ou une offre payante.

> Textes des offres (`web/src/ui/OffersStrip.svelte`, `OffersCheckout.svelte`) : appels audio et vidéo « Inclus » pour Plus et Pro, « Non inclus » pour le gratuit ; le départ du compte à rebours à la première ouverture est marqué « Bientôt (pas encore disponible) » (textes `offers.calls.*` et `offers.adds.first`, test `ui/offers-soon.test.ts`).

> Le tableau dit ce que le code applique (`web/src/limits.ts`, `PAID`, et `server/internal/share/tier.go`). Le plafond « taille × ouvertures » n'a jamais été codé : il est remplacé par le plafond de sortie par partage (`SHH_SHARE_EGRESS_MAX`, 250 Gio par défaut, §38.6). Les salons payants, les fonctions de §38.9 et le débit prioritaire ne sont **pas codés** (conception du paiement §11).

| Fonction | Gratuit | **Plus** | **Pro** |
|---|---|---|---|
| Taille par lien | **2 Go** | **10 Go** (paliers 5 et 10 Gio, + morceau du manifeste, §29.3) | **30 Go** (paliers 20 et 30 Gio, + morceau du manifeste) |
| Éléments par lien | **200** | **200** | **200** (D41-17 : même borne technique pour tous) |
| Durée de vie | 1, 6, 12, 24 h | 1, 6, 12, 24 h, **2 ou 3 jours** | 1, 6, 12, 24 h, 2, 3 ou **7 jours** |
| Compte à rebours à la première ouverture (plafond 7 j après la création, §38.9.1) | non | oui (**pas codé**, affiché « Bientôt (pas encore disponible) ») | oui (**pas codé**, idem) |
| Échéance personnalisée (date et heure, pas codée) | non | oui | oui |
| Ouvertures | **1 à 5** | **jusqu'à 10** | **jusqu'à 20** ; sortie par partage plafonnée (§38.6) |
| Partages payants par période de 30 jours (jetons, salons payants compris) | — | 30 | 100 |
| Liens gratuits par jour | 10 (inchangé, §4) | 10 + les liens du pass | 10 + les liens du pass |
| Salon de discussion (§39 ; paliers payants pas codés) | 24 h, 10 personnes, 2 Go | 3 jours, 20 personnes, 5 Go | 7 jours, 50 personnes, 20 Go |
| Appels audio et vidéo dans un salon (conception des appels §5.1) | non : rejoindre un appel en cours seulement | oui : lancer un appel (un jeton anonyme ouvre les appels du salon pour tous ses membres, jusqu'à sa fin) | oui, de même |
| Fonctions payantes détaillées (pas codées) | — | §38.9 : demander des fichiers, prolonger, ajouter des fichiers, ouverture programmée, plusieurs destinataires, notification, limite par fichier, filigrane | Plus, **plus** page personnalisée, CLI/API, débit prioritaire (tableau de §38.9.0) |
| « Demander des fichiers » (§38.9.3) | base gratuite | limites Plus | limites Pro |
| Envoi direct (§40) | plus tard, optionnel (§41.3) | idem | idem |
| Bande passante prioritaire | non | non | oui : réserve séparée de places de transfert simultané (§24) ; « prioritaire », jamais « débit garanti » |
| Historique synchronisé (§37) | retiré (D42-27) | retiré | retiré |
| Coffre du téléphone (§27) | gratuit, 2 Go | inchangé | inchangé |

- Chaque palier payant est un nouveau nombre de morceaux de 64 Kio : 5 Gio = 81 921, 10 Gio = 163 841, 20 Gio = 327 681, 30 Gio = 491 521 (capacité en données + le morceau du manifeste ; `share.PaidBuckets`) ; fichier chiffré de 48 + B × 65 552 octets (10 Gio : 10 740 105 280 ; 30 Gio : 32 220 184 640). Durées de jeton d'envoi et de téléchargement : 24 h au-delà de 2 Gio (§41.2).
- **Historique synchronisé** : retiré (D42-27). Chaque lien Plus ou Pro consomme un jeton aveugle (§38.4) ; Plus et Pro ont **deux clés d'émission distinctes** : le serveur apprend la formule d'un partage (déjà visible par ses limites, §36 S30), jamais le payeur.
- **Signalement (moyenne)** : les jetons aveugles interdisent de suivre le volume sorti **par pass** (ce serait relier les partages au payeur). Seuls bornent donc le pire cas : le nombre de liens du pass, le plafond taille × ouvertures **par lien**, les quotas par connexion et la réserve Plus (§38.6). Pire cas par pass de 30 jours : Plus 30 × 100 Go = 3 To, Pro 100 × 250 Go = 25 To de sortie (le budget de lecture de §24 peut le doubler). Un pass d'abus se révoque (§38.4) ; sur un hébergeur à sortie forfaitaire, ce coût marginal est nul. plafond de sortie par partage codé, `SHH_SHARE_EGRESS_MAX`, 250 Gio par défaut (§38.6) ; pire cas par pass : Plus 30 × 250 Gio, Pro 100 × 250 Gio.

#### 38.8.2 Prix proposés (TTC, euros)

| Formule | 30 jours | 365 jours |
|---|---|---|
| **Plus** | **7 €** | **70 €** (deux mois offerts) |
| **Pro** | **20 €** | **200 €** (deux mois offerts, D41-32) |

> **Affichage des prix (D41-32, retours UI6 ; façons de payer revues par D41-34).** (1) Le prix **mensuel** est affiché en grand : Plus **7 €/mois TTC**, Pro **20 €/mois TTC** ; dessous, l'**annuel payé en une fois** : Plus **70 €/an**, Pro **200 €/an**, « 2 mois offerts » (nombre calculé depuis `PAID`, jamais écrit en dur). (2) **Deux façons de payer, au choix** : **paiement unique** (30 jours ou 1 an, sans renouvellement : rien n'est prélevé ensuite) ou **renouvellement automatique facultatif**, « résiliable à tout moment en un clic, sans frais » ; jamais présélectionné. (3) « **Aucun frais caché.** » (4) Toujours « **Bientôt disponible** » : aucun achat actif, aucun bouton d'achat (D41-16). Remplace Q-P4 (« prépayé seulement ») et la ligne « pas de renouvellement automatique » de §38.1. **Signalements** : (a) *(analyse de marge tenue hors du dépôt)* ; (b) **Moyenne, confidentialité** : un renouvellement automatique oblige le vendeur officiel à garder un moyen de paiement et à relier les périodes successives d'un même pass (il connaît déjà le payeur, mais plus longtemps) ; chez nous rien ne change (le pass reste un numéro au porteur, les jetons restent aveugles, §38.4) ; le paiement unique reste proposé à égalité. (c) **Moyenne, légal** : renouvellement tacite et résiliation en ligne (Code de la consommation, information sur la reconduction et résiliation « en trois clics » de 2023) : textes, rappel avant échéance et parcours de résiliation à faire valider par le juriste (§38.5) avant la tâche P3. (d) **Faible, exactitude** : « par mois » désigne un pass de **30 jours** : la ligne « Paiement unique » le dit (« 30 jours ou 1 an »).

> **Façons de payer et moyens de paiement (D41-34, retours UI7 ; remplace D41-32 (2)).** (1) Le **mensuel** est **uniquement un abonnement à renouvellement automatique**, résiliable en un clic, sans frais : plus de pass de 30 jours en paiement unique. (2) L'**annuel**, au choix : **paiement unique** (rien n'est prélevé ensuite) ou **renouvellement automatique**, résiliable en un clic, sans frais ; jamais présélectionné. (3) **Moyens de paiement affichés** : « Carte bancaire » et « Crypto-monnaies », en **libellés** avec pictogrammes maison, **aucun logo de marque tierce**. (4) Toujours « **Bientôt disponible** » : aucun achat actif, aucun bouton d'achat, **rien n'est implémenté côté paiement**. L'annuel s'affiche « ou 70 € par an » (plus « payé en une fois », puisqu'il peut se renouveler). **Signalements** : (a) **moyenne, exactitude** : une crypto-monnaie ne permet pas de prélèvement récurrent (c'est le payeur qui envoie chaque paiement) ; un abonnement mensuel payé en crypto-monnaie est donc impossible sans relance manuelle ; correction appliquée à l'écran : « Crypto-monnaies (paiement unique à l'année) » (mensuel en crypto : paiement unique de 30 jours, DP-1 de la conception du paiement). (b) **Moyenne, exploitation/légal** : §38.3 recommande la crypto-monnaie (Bitcoin via BTCPay) en **second moyen, plus tard**, et écarte Monero au lancement ; l'afficher dès l'ouverture des ventes demande la plateforme de conversion agréée (MiCA, KYC de l'exploitant), sa comptabilité et un serveur de plus ; à trancher avant la tâche P3, sinon retirer la ligne. (c) **Moyenne, confidentialité** : le mensuel par abonnement seulement oblige le vendeur officiel à garder le moyen de paiement de **chaque** client mensuel (D41-32 (b) ne vaut plus seulement pour ceux qui le choisissent) ; le paiement unique reste possible à l'année. (d) **Faible, motif trompeur** (§38.1) : l'absence de mensuel sans renouvellement doit être dite avant tout paiement (c'est le cas à l'écran) ; rappel avant échéance et résiliation en ligne à valider par le juriste (D41-32 (c)).

> **Ouvertures et espace des offres dans le composeur (D41-36, retours OPT).** (1) Ouvertures : remplacé par l'état codé ci-dessus (gratuit 1 à 5, Plus jusqu'à 10, Pro jusqu'à 20 ; `PAID` dans `web/src/limits.ts`). (2) Dans les options, le texte des choix verrouillés est en blanc ; cadenas, pointillés et badges restent bleus. (3) Les espaces des offres sont des pastilles verrouillées « 10 Go · Plus » et « 50 Go · Pro » à côté de la jauge, en haut du composeur ; la ligne « Avec Plus : jusqu'à 10 Go… » sous le dépassement de 2 Go est retirée du composeur (doublon ; elle reste aux écrans de capture). **Signalements** : (a) **moyenne, exploitation** : Plus n'ajoute plus d'ouvertures ; son attrait repose sur l'espace et la durée ; à revoir avec l'étude de prix (Q-P8). (b) **Faible, exactitude** : le pire cas de sortie de §38.8.1 (Pro 100 × 250 Go) reste un plafond prudent ; avec 50 ouvertures le plafond « taille × ouvertures ≤ 250 Go » est inchangé.

#### 38.8.3 Modèle de coûts

Analyse de marge tenue hors du dépôt. Retiré du dépôt le 24 novembre : prix unitaires de l'hébergeur, frais des prestataires, marges et seuil de rentabilité. Restent ici les seules contraintes techniques : sortie au pire bornée par le plafond par partage (§38.6) ; dimensionnement du disque : §41.2 (200 Gio gratuits + 300 Gio de réserve payante tiennent sur une machine de 1 To utile).

#### 38.8.4 Questions ouvertes ajoutées (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-P8 | Prix | Plus 7 €/30 j, 70 €/an ; Pro 20 €/30 j, 200 €/an (D41-32) ; étude de prix et de marché tenue hors du dépôt |
| Q-P9 | Historique synchronisé payant | Sans objet : historique retiré (D42-27) |
| Q-P10 | Paliers de 5, 10, 20 et 50 Gio | Oui, avec la réserve Plus séparée (§38.6) de 300 Gio |
| Q-P11 | Pire cas de sortie par pass (§38.8.1) | Hébergeur à sortie forfaitaire exigé avant P2 ; sinon baisser les plafonds « taille × ouvertures ». plafond de sortie par partage codé (`SHH_SHARE_EGRESS_MAX`, 250 Gio par défaut ; §38.6) |

### 38.9 Fonctions payantes (pas codées) — spécification détaillée

Fonctions **conservées** (pas de formule « Équipe »). Chacune a ci-dessous : sécurité, ce que voit le serveur (lignes S48 à S59 de §36), interface (UI §9.14) et tests (plan : tâches P4, P5 et F0 à F11, **toutes après la V1**, bloquées comme P1 à P3 par Q-P1, Q-P2, Q-P5 et l'avis de §38.5). Décisions : §41.0 (D41-9 à D41-14).

#### 38.9.0 Règles communes (valent pour toutes les fonctions)

1. **Aucune sécurité de plus, aucune de moins.** Argon2id (mêmes paramètres minimaux), AES-256-GCM/STREAM, 5 essais puis destruction, mot de passe de 10 caractères et liste noire (§31), CSP, nettoyage des métadonnées (§35.2), enveloppe `E` : **strictement identiques** pour le gratuit, Plus et Pro. Aucune fonction ci-dessous ne relâche ni ne renforce l'un d'eux. Test de **parité** : les constantes de sécurité sont lues d'un seul endroit sans paramètre de formule, et un test échoue si une branche `tier` en change une.
2. **Aucune statistique sur les destinataires.** L'expéditeur ne voit que ce que §4 compte déjà : ouvertures utilisées (et, avec §38.9.7, **par lien**, c'est le même compteur), état, échéance. **Jamais** : qui, d'où (adresse, pays, appareil, navigateur), à quelle heure précise (seulement l'intervalle observé en local, §33), combien de temps de lecture, quel élément a été regardé (S9), combien de fois un élément a été vu. Seule exception, **explicite et choisie par l'expéditeur** : la limite par fichier (§38.9.11) compte des lectures complètes d'un fichier à limite, rien d'autre. Test de balayage : les réponses de `meta`, `unlock`, `manage/status` et des nouvelles routes ne contiennent que des champs d'une **liste blanche** ; tout champ nouveau fait échouer le test avec « ajouter une ligne justifiée à §38.9.0 ».
3. **Droit d'usage** : le jeton aveugle de création (§38.4) fixe le **niveau** du partage (`tier` : 0 gratuit, 1 Plus, 2 Pro). Les actions suivantes (prolonger, ajouter, révoquer un lien…) se font avec `S_gestion` et lisent le `tier` **du partage** : aucun pass ni jeton n'y intervient, donc rien ne relie ces actions au payeur. Le `tier` ne change jamais. Une fonction demandée à un niveau insuffisant → 400 `bad_request` identique à une valeur invalide.
4. **Le destinataire ne voit jamais l'offre** (§38.1) : les écrans d'ouverture n'affichent que l'effet (« Ce lien disparaît 24 h après sa première ouverture »), jamais « Plus » ni « Pro ».
5. **Répartition** (Q-F4 ; fixé : minuteur à la première ouverture = Plus et Pro ; page personnalisée et CLI/API = Pro ; débit prioritaire = Pro, §38.8.1) :

| Fonction | Gratuit | Plus | Pro |
|---|---|---|---|
| Départ du compte à rebours à la première ouverture (§38.9.1) | non | oui | oui |
| (abandonné, D41-17) | 200 | 200 | 200 |
| Demander des fichiers (§38.9.3) | base : 1 demande, 5 dépôts, limites gratuites | 3 demandes, 25 dépôts | 10 demandes, 100 dépôts |
| Prolonger (§38.9.4) | non | oui | oui |
| Ajouter des fichiers (§38.9.5) | non | oui (3 ajouts) | oui (7 ajouts) |
| Ouverture programmée (§38.9.6) | non | oui | oui |
| Plusieurs destinataires, liens révocables (§38.9.7) | 1 lien | 5 liens | 25 liens |
| Notification d'ouverture (§38.9.8) | non | oui | oui |
| Page de réception personnalisée (§38.9.9) | non | non | oui |
| CLI / API (§38.9.10) | non | non | oui |
| Limite de téléchargement par fichier (§38.9.11) | non | oui | oui |
| Filigrane « confidentiel » (§38.9.12) | non | oui | oui |
| Débit prioritaire (§38.9.13) | non | non | oui |

6. **Stockage** : les données de ces fonctions sont dans `shares.db` (colonnes ou tables **séparées** : `parts`, `links`, `requests`, `request_notes`) ; aucune colonne ne porte de jeton, de pass, de compte ni d'identifiant de destinataire.

#### 38.9.1 Départ du compte à rebours : à la création ou à la première ouverture (Plus et Pro)

**Choix de l'expéditeur** (UI §9.3.1) : « Le compte à rebours démarre… » **à la création** (par défaut ; **seule option gratuite** : comptée à partir de la fin de l'envoi, §4) ou **à la première ouverture**. Avec la seconde : **plafond absolu** — le partage est purgé **7 jours après sa création**, même s'il n'a jamais été ouvert (c'est aussi la durée maximale de Plus et de Pro, §38.8.1).

- **Serveur — colonnes** : `starts_on_first_open` (0/1, posé à `finalize`, jamais modifié ensuite) et `hard_expires_at` (plafond). Pour tout partage Plus ou Pro, `hard_expires_at` = création + 7 j, arrondi au quart d'heure **inférieur** (seule date arrondie vers le bas : elle ne doit jamais dépasser 7 jours ; la création est connue en mémoire jusqu'à `finalize` : `upload_deadline` − fenêtre d'envoi de 6 h ou 24 h, §41.2). Gratuit : `NULL` (le plafond est `expires_at`).
- **Avant le premier déverrouillage** : `expires_at` = `hard_expires_at` et `ttl_hours` est **conservé** (non nul : la durée choisie). Le nettoyeur purge à `expires_at` comme pour tout partage : un partage jamais ouvert disparaît donc à 7 jours.
- **Premier `unlock` réussi** (le seul qui passe `opens_issued` de 0 à 1 ; un `unlock` avec octroi d'ouverture, §41.4, n'en est pas un), dans la **même requête SQL conditionnelle** que §7.5 : `expires_at = MIN(ceil15(maintenant + ttl_hours h), hard_expires_at), ttl_hours = NULL WHERE starts_on_first_open = 1 AND ttl_hours IS NOT NULL`. Deux déverrouillages simultanés : un seul gagne la condition `ttl_hours IS NOT NULL` ; l'autre lit l'échéance déjà fixée. Le jeton de téléchargement et l'octroi sont plafonnés au **nouvel** `expires_at` (même transaction). **Invariant, testé** : `expires_at` ≤ `hard_expires_at` à tout instant.
- **Ne démarrent rien** : `meta`, la pré-lecture (§29.6), un mot de passe faux, une page de gestion. Démarre le compte à rebours : **n'importe quelle personne qui détient le lien et le mot de passe** (dit à l'expéditeur : « Le compte à rebours démarre quand quelqu'un déverrouille le lien, pas forcément la personne que vous visez »).
- **`meta`** rend en plus `starts_on_open` (booléen), `duration_s` (durée choisie, tant que non démarré) et `seconds_left` (jusqu'à `expires_at`, donc jusqu'au plafond tant que non démarré). **`manage/status`** rend `started` (booléen) et `expires_at`.
- **Durées** autorisées avec ce mode : 1 h, 6 h, 12 h, 24 h, 2, 3 et 7 jours ; la durée est **bornée par le plafond** (ouvert au 6ᵉ jour avec 3 j choisis : disparition au 7ᵉ jour). L'écran le dit avant l'envoi et à l'ouverture (« au plus tard le … »).
- **Ce que voit le serveur** : S48 (le mode et le plafond, donc la **date de création à 15 min près** pour un partage payant, régression par rapport à S11 : voir le signalement F-1, §41.12) ; S49 (l'heure du premier déverrouillage n'est **pas** gardée : `ttl_hours` est remis à `NULL`, `expires_at` seul reste).
- **Tests** : voir plan.

#### 38.9.2 Éléments illimités pour le Pro : abandonné

Le nombre d'éléments n'est pas un critère de formule : 200 pour toutes (D41-17, §41.13). Le manifeste reste d'un seul morceau (§29.3) ; aucun manifeste découpé (tâche P5 abandonnée).

#### 38.9.3 Demander des fichiers (lien de dépôt)

**But** : une personne (le demandeur) envoie un lien ; n'importe qui qui le reçoit peut lui déposer des fichiers, chiffrés de bout en bout, sans compte. **Principe** : le déposant crée un partage Shhdrop **ordinaire** et en scelle le lien au demandeur avec une clé publique ; le serveur ne garde qu'une boîte de notes scellées.

- **Clés** (libsodium, `crypto_box_seal`, rien de maison) : le navigateur du demandeur tire une paire X25519 (`pk`, `sk`), `K_dépôt` (32 octets) et `S_demande` (32 octets). **Lien de demande** (public, à envoyer) : `https://…/d#…` avec, dans le fragment, `pk`, `K_dépôt` et un libellé (au plus 120 caractères, **du texte**, jamais interprété). **Lien de gestion de la demande** (secret) : `S_demande` et `sk`, gardés dans l'historique local chiffré (§33) ; le perdre = perdre les dépôts non encore relevés (dit).
- **Dépôt** : le déposant ouvre le lien, compose comme pour un envoi (même composeur, nettoyage des métadonnées compris, mot de passe **généré et jamais montré**), et son navigateur : (1) `POST /api/shares` avec l'en-tête `X-Shh-Request` = `K_dépôt_acc` = HKDF(`K_dépôt`, « shhdrop/v2/depot ») ; le serveur vérifie que la demande est ouverte, qu'il reste un dépôt (`deposits_left` décrémenté **à la création**), applique les **limites du niveau de la demande** (taille du palier, durée ≤ fin de la demande) en plus des quotas par connexion (§4) ; (2) envoie le partage normalement ; (3) `POST /api/requests/note` : une **note scellée** de taille fixe (512 octets) = `crypto_box_seal`(« SHDP1 » ‖ `K_lien` ‖ mot de passe ‖ `S_gestion` ‖ libellé du déposant facultatif, `pk`).
- **Relevé** : le demandeur (`GET /api/requests/notes`, `S_demande`) reçoit les notes, les ouvre avec `sk` et voit une liste « Dépôts reçus » ; chaque dépôt s'ouvre comme un partage normal (mot de passe déjà connu : pas de saisie), avec les droits et protections habituels (avertissement des fichiers à risque, page de contenu §41.6). Il peut **détruire** un dépôt (`S_gestion` de la note) ou **fermer** la demande (`POST /api/requests/close`).
- **Abus** (le lien de demande est un point d'entrée public) : nombre de dépôts et taille bornés par la demande ; durée de la demande ≤ 24 h (gratuit) ou 7 j (Plus, Pro) ; difficulté anti-robot habituelle (§22 D4) ; quotas par connexion ; un déposant ne voit jamais ce que les autres ont déposé ; le libellé est du texte brut. **Hameçonnage** : la page de dépôt dit toujours « Cette personne vous demande des fichiers. Shhdrop ne vérifie pas son identité. » (bandeau non masquable, comme §38.9.9). **Contenus illicites** : un dépôt est un partage ordinaire ; « Signaler » côté demandeur détruit le dépôt (§7.6) ; le déposant reste responsable de ce qu'il envoie.
- **Limite honnête** : le déposant ne peut pas relire son dépôt (le mot de passe est généré puis scellé pour le seul demandeur) ; il garde ses fichiers d'origine. Un demandeur malveillant n'apprend rien du déposant (aucune adresse, aucun compte) ; le serveur voit l'adresse du déposant en direct, comme pour tout envoi.
- **Ce que voit le serveur** : S56 (une ligne `requests` : `pk`, limites, échéance ; des notes scellées opaques ; le compte des dépôts ; **aucun lien de base entre une demande et les partages déposés**).
- **Tests** : voir plan.

#### 38.9.4 Prolonger un partage (Plus, Pro)

- `POST /api/manage/extend` (`S_gestion`) `{ add_hours }` avec `add_hours` ∈ {1, 6, 12, 24, 48, 72, 168} : nouvelle échéance = `MIN(ceil15(expires_at + add_hours), hard_expires_at)`. **Jamais au-delà du plafond de 7 jours depuis la création** (§38.9.1) : « prolonger » ne fabrique pas un partage plus long que ce que la formule permet. Partage non `ready`, expiré, détruit, gratuit, non démarré (mode « première ouverture », où l'échéance est déjà le plafond) : 404/400 uniformes. Les ouvertures restantes **ne changent pas**.
- **Sécurité** : aucune clé n'est touchée ; le lien et le mot de passe restent ceux d'avant. Les jetons déjà émis sont plafonnés à l'ancienne échéance : un téléchargement en cours qui dépasserait **demande un renouvellement** (octroi/regrant, §41.4), qui obtient le nouveau plafond. Une action de gestion ne peut pas être rejouée par un tiers (en-tête secret, pas de jeton). Limites : 5 prolongations par partage (anti-boucle de requêtes).
- **Ce que voit le serveur** : S55 (le moment et la nouvelle échéance, en direct ; rien n'est gardé de plus qu'`expires_at`).
- **Interface** : bouton « Prolonger » sur la carte du tableau de bord et la vue de gestion (UI §9.14.4) ; la date limite absolue est affichée.
- **Tests**.

#### 38.9.5 Ajouter des fichiers à un partage existant (Plus, Pro)

**Problème de cryptographie** : le paquet est un fichier de taille fixe dont le manifeste est au bout, chaque morceau n'est chiffré qu'une fois par `R` ; on ne peut donc ni agrandir le paquet, ni réécrire son manifeste. **Solution** : un ajout est une **partie** supplémentaire (un second paquet « SHH2 ») rattachée au même partage.

- **Parties** : table `parts(share, n, bucket, state, size_class)`, `n` ≥ 1 (la partie 0 est le paquet d'origine) ; au plus 3 ajouts (Plus) ou 7 (Pro). Chaque partie est envoyée, finalisée et lue **comme un partage** (mêmes segments, mêmes jetons d'envoi), avec ses propres `K_contenu_n` = HKDF(`R`, « shhdrop/v2/partie/contenu » ‖ `n`) et `C_engagement_n` = HMAC(`R`, « shhdrop/v2/partie/engagement » ‖ `n`) : **clés distinctes, donc aucun nonce réutilisé**. La partie n a son propre manifeste (dans son dernier morceau, v2 ou v3), authentifié par `K_contenu_n`. Le palier canonique est vérifié par partie.
- **Qui peut ajouter** : l'expéditeur doit prouver qu'il connaît le **lien et le mot de passe** (il ne les a pas gardés, §33) : il les ressaisit (écran « Ajouter des fichiers »), son navigateur calcule `K_preuve` et appelle `POST /api/manage/envelope` (`S_gestion` **et** `K_preuve`) : le serveur vérifie `K_preuve` (**le même compteur de 5 essais** que `unlock`, sinon `S_gestion` + lien permettraient de deviner le mot de passe hors ligne sans limite) et rend `E` ; le navigateur déchiffre `R`, puis envoie la partie. Aucune clé n'est gardée dans l'historique (variante « garder `R` » rejetée, Q-F2).
- **Destinataire** : `meta` rend le nombre de parties ; `unlock` rend `E` et la liste des parties (palier de chacune) ; le client lit la partie 0 puis les autres, dont il fusionne les listes (une section « Ajouté le … » n'existe pas : le serveur ne garde pas l'heure). Un destinataire qui a déjà ouvert voit « Des éléments ont été ajoutés » au prochain `regrant`/rechargement. L'ajout **ne remet pas** les ouvertures à zéro.
- **Limites** : la taille totale (parties comprises) ≤ la taille du niveau ; l'échéance du partage s'applique à toutes les parties ; budgets de lecture (§24) **par partie** ; quotas du jour débités à `finalize` de la partie.
- **Ce que voit le serveur** : S51 (nombre et paliers des parties, moment de chaque ajout en direct).
- **Tests**.

#### 38.9.6 Ouverture programmée (Plus, Pro)

- L'expéditeur choisit « S'ouvre à partir de : date et heure » (dans les 7 jours). Colonne `opens_at` (arrondie au quart d'heure **supérieur**). **Contrainte** : `opens_at` + 1 h ≤ plafond (`hard_expires_at`, ou `expires_at` en mode « à la création ») : l'écran la vérifie et affiche la fenêtre réellement utilisable ; avec le mode « première ouverture », le compte à rebours ne démarre pas avant `opens_at`.
- **Application par le serveur seulement** (honnête) : avant `opens_at`, `unlock` répond 403 `not_yet` (n'utilise ni essai ni ouverture) et ne rend pas `E`. **Aucun verrou cryptographique** : sans tiers de confiance (pas de service d'horloge ni de « time-lock » externe, règles du projet), un serveur malveillant pourrait rendre `E` plus tôt ; il n'a pourtant ni le lien ni le mot de passe, donc rien n'est lisible sans le destinataire. Dit sur la page Sécurité.
- `meta` rend `opens_at_s` (secondes avant l'ouverture) ; la pré-lecture reste permise. Écran du destinataire : « Ce partage s'ouvrira le … (dans 3 h 20). » avec compte à rebours local, puis le champ de mot de passe.
- Ce que voit le serveur : S53.
- **Tests**.

#### 38.9.7 Plusieurs destinataires, liens révocables un par un (Plus : 5 liens, Pro : 25)

- **Principe** : un seul contenu (`R`, paquet), **un lien par destinataire**. Chaque lien a son propre `K_lien_i` (donc son `K_accès_i`), son `sel_i`, son `K_preuve_i`, son enveloppe `E_i` (qui enveloppe le **même** `R`), ses ouvertures (1 à 10) et son compteur d'essais (5 faux mots de passe détruisent **ce lien seulement**, Q-F7). Le mot de passe peut être le même pour tous (défaut) ou différent. Table `links(share, access_v, proof_v, salt, kdf, envelope, opens_left, opens_issued, done_mask, failed_attempts)`.
- **Création** : l'expéditeur nomme chaque lien (« Alice », « Banque »…) ; les noms restent **dans son historique local chiffré** (§33), jamais envoyés. La somme des ouvertures de tous les liens respecte le plafond du niveau (« taille × ouvertures », §38.8.1).
- **Ajouter un lien plus tard** : ressaisie du lien et du mot de passe comme en §38.9.5 (`POST /api/manage/envelope`), puis création de `E_i`.
- **Révoquer un lien** : `POST /api/manage/revoke` (`S_gestion`, étiquette du lien) : la ligne `links` est supprimée ; ses jetons et octrois sont révoqués **tout de suite** et ses flux de segments **coupés** (§41.8 : une révocation comme une exclusion de salon). Le lien révoqué répond comme un lien inexistant. Les autres liens et le contenu ne bougent pas. **Détruire** le partage détruit tous les liens.
- **Limite honnête, écrite** : un destinataire révoqué **connaît `R`** s'il a déjà ouvert, et garde tout ce qu'il a déjà téléchargé ; sans ses jetons il ne peut plus rien demander au serveur. Rechiffrer pour tous les autres est impossible sans refaire l'envoi. Si le serveur était compromis plus tard, un destinataire révoqué qui garde `R` et un chiffré volé pourraient lire ; c'est la même exposition que n'importe quel destinataire ayant ouvert.
- **Pas d'analyse des destinataires** : le tableau de bord montre par lien « ouvert n / m » et « révoqué » (compteurs de §4), rien d'autre (§38.9.0).
- **Ce que voit le serveur** : S52 (le nombre de liens, les compteurs de chacun, que ces liens appartiennent au même partage, les révocations en direct).
- **Tests**.

#### 38.9.8 Notification d'ouverture (Plus, Pro) — jamais qui, jamais où

- **Contenu** : « Un de vos partages a été ouvert » (et « Dernière ouverture utilisée »). Rien d'autre : ni lien nommé, ni nom, ni adresse, ni pays, ni appareil, ni heure plus précise que celle de la notification elle-même.
- **Canaux** : (1) **Sans compte** : sur le tableau de bord, la relecture locale (§33.1) affiche « ouvert » ; rien de nouveau. (2) **Notification système (Web Push, RFC 8030/8291/8292)**, choisie par l'expéditeur : le navigateur s'abonne (`PushManager`, clé publique VAPID du serveur dans le manifeste de version signé, §28.2), et l'abonnement (adresse, `p256dh`, `auth`) est enregistré **en mémoire seulement**, par partage (comme `purge_at`, S12) ; un redémarrage du serveur l'oublie (dit). Le serveur envoie une charge **chiffrée de bout en bout** (RFC 8291) qui ne contient qu'un octet de type. (3) **Avec le compte facultatif** (§37) : les abonnements des appareils de la personne sont rangés dans le coffre de compte `B` (le serveur ne sait pas à qui) ; à la création d'un partage, le navigateur les envoie au serveur pour ce partage seulement. Le serveur ne relie jamais le compte au partage (§37.4).
- **Dépendances et exceptions (Q-F3)** : Web Push exige un **service worker** (UI §14.1 dit « sans service worker » ; §28.6 le prévoit conditionnel) et un **contact sortant du serveur** vers le service de notification du navigateur (Google, Apple, Mozilla, Microsoft). Ce n'est pas une ressource tierce chargée par le site, mais un tiers de plus qui apprend « cette adresse d'abonnement reçoit une notification à cet instant » (jamais le contenu). La liste d'hôtes autorisés est fermée (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`) contre la falsification de requête côté serveur (SSRF). Cryptographie du côté Go : bibliothèque standard + une dépendance auditée (RFC 8291) ou implémentation avec vecteurs officiels : **exception écrite** à « WebCrypto et libsodium uniquement », comme Q-P2. **Tant que Q-F3 n'est pas tranchée, seuls les canaux (1) et (3) sans push sont livrés.**
- **Limites** : au plus une notification par partage et par minute (regroupement) ; au plus 5 abonnements par partage ; adresse d'abonnement invalide ou refusée (410) : retirée.
- Ce que voit le serveur : S54.
- **Tests**.

#### 38.9.9 Page de réception personnalisée : logo et couleurs (Pro)

- **Marque** : un logo (PNG, WebP ou JPEG ; **jamais SVG**) **ré-encodé dans le navigateur de l'expéditeur** (canvas, sans métadonnées, §35.2) à 128 × 128 au plus et 24 Kio au plus, et deux couleurs (accent et fond de carte). Rangée dans le **profil de marque** de l'expéditeur : historique local chiffré et coffre de compte ; **aucun profil sur le serveur**.
- **Transport** : la marque est **scellée** par une clé dérivée du lien, `K_marque` = HKDF(`K_lien`, « shhdrop/v2/marque »), AES-256-GCM, taille fixe 24 Kio + étiquette (rembourrée), rangée dans la colonne `brand` du partage et rendue par `meta` ; le destinataire la déchiffre **avant** le mot de passe (il a le lien). Le serveur n'en voit rien (octets opaques de taille fixe).
- **Garde-fous contre l'usurpation** (la personnalisation ne doit pas servir à imiter une banque) : (1) la marque ne change **ni les textes, ni la mise en page, ni les champs, ni les boutons** ; seulement le logo (au-dessus de la carte) et l'accent ; (2) un **bandeau fixe, non masquable**, reste : « Page Shhdrop. Le logo est choisi par l'expéditeur ; Shhdrop ne vérifie pas son identité. » ; (3) contraste de l'accent ≥ 4,5:1 sur le fond (sinon l'accent par défaut) ; (4) logo en `<img>` depuis une URL blob (`img-src blob:` existe déjà), révoquée au `load` ; (5) l'adresse du site, le cadenas et la CSP ne changent pas ; (6) échec de déchiffrement ou de décodage → page standard, sans erreur visible.
- **Ce que voit le serveur** : S57 (qu'une marque existe, sa taille fixe).
- **Tests**.

#### 38.9.10 CLI et API (Pro)

- **API** : l'API de §8/§29.8 **est** l'API publique ; elle est documentée (`docs/api.md`), versionnée, sans clé d'API (une clé serait un identifiant qui relie les appels). Le droit Pro s'exerce par **jetons aveugles** (§38.4) : le CLI détient le pass `P` (fichier `0600` ou entrée standard), demande les jetons par lots, les dépense un par partage. Avec un jeton Pro valide, la preuve de travail est à difficulté **fixe minimale** (pas de doublement horaire) et il n'y a pas de repli reCAPTCHA ; ni quotas, ni limites de niveau ne changent.
- **CLI** `shhdrop` (envoi : `shhdrop send fichiers… [--hours N --opens N --password-file F]` ; réception : `shhdrop open LIEN --out DIR` ; gestion : `status`, `destroy`, `extend`) : **même code que le navigateur** (modules `web/src/crypto`, `transfer`, `cleaning` réutilisés sous Node ≥ 22 : WebCrypto et libsodium seulement ; aucune deuxième implémentation de la cryptographie à tenir). Distribué en binaire reproductible et signé (§28) et par le dépôt.
- **Règles de sécurité du CLI** : le **mot de passe ne passe jamais par un argument de ligne de commande** (visible dans la liste des processus) : entrée standard, `--password-file` ou saisie interactive sans écho ; mot de passe généré affiché une fois sur la sortie d'erreur, jamais journalisé ; le lien est écrit sur la sortie standard seulement ; aucun fichier de configuration ne garde `K_lien` ou un mot de passe ; l'historique `S_gestion` reste dans un fichier chiffré `0600` (même format que §33) ; nettoyage des métadonnées appliqué comme dans le navigateur (formats non pris en charge : même comportement qu'au navigateur) ; aucune télémétrie.
- **Ce que voit le serveur** : S58 (rien de plus qu'un navigateur : mêmes requêtes ; l'en-tête `User-Agent` du CLI est retiré comme les autres, S2).
- **Tests** : interopérabilité dans les deux sens avec le navigateur.

#### 38.9.11 Limite de téléchargement par fichier (Plus, Pro)

- **Problème** : le serveur ne connaît pas les frontières des éléments (S9) ; il ne peut donc pas compter « les lectures d'un fichier » dans un paquet unique. **Solution** : un fichier à limite est placé dans sa **propre partie** (§38.9.5), choisie à la composition (« Limiter à 1, 2, 3 ou 5 téléchargements ») ; le serveur compte alors des **lectures complètes de la partie**, par lien (§38.9.7) : `part_reads_left`. Une « lecture » = la partie lue de bout en bout (budget `limite × palier + 2 segments 0`, aucun rechargement hors octroi, §41.4). L'aperçu et l'enregistrement d'une même ouverture partagent **une** lecture (le contenu déjà chargé est réutilisé, §41.6).
- **Sécurité et honnêteté** : c'est une **limite de confort et de dissuasion**, pas une protection : le destinataire peut copier ce qu'il a enregistré ; un client modifié peut contourner le compte *local* mais pas le compteur serveur. Le serveur apprend la taille de la partie à limite et qu'elle est limitée (S51).
- Une fois la limite atteinte : « Ce fichier a atteint sa limite de téléchargements. » ; le reste du partage reste accessible.
- **Tests**.

#### 38.9.12 Filigrane « confidentiel » en lecture seule (Plus, Pro) — une dissuasion, rien de plus

- **Ce que c'est** : avec « Autoriser le téléchargement » désactivé (droit `"voir"`, §34.1), la visionneuse superpose un motif répété et incliné, semi-transparent : « Confidentiel » et, au choix de l'expéditeur, le **nom du lien** (« Pour Alice », §38.9.7). Le texte du filigrane est dans le **manifeste chiffré** (page 1) : le serveur ne le voit pas. Dessiné sur un `<canvas>` pour les images et les pages de PDF (il apparaît donc dans une capture d'écran) ; superposition pour la vidéo et le texte.
- **Honnêteté, écrite sur l'écran de l'expéditeur et du destinataire** : « Le filigrane dissuade et aide à retrouver l'origine d'une fuite. Il n'empêche ni la capture d'écran, ni la photo de l'écran, et il ne protège pas contre un navigateur modifié. » Il n'est **jamais** appliqué aux fichiers enregistrés (Shhdrop ne modifie pas les fichiers) : il n'existe donc que dans le mode « voir seulement ».
- **Aucun pistage** : le nom du lien vient de l'expéditeur, pas du destinataire ; aucune donnée sur le destinataire n'est ajoutée.
- **Tests**.

#### 38.9.13 Débit prioritaire (Pro)

- Les transferts simultanés de segments (§24 : 256 au total) sont répartis en **192 communs et 64 réservés** : un segment d'un partage Pro (le niveau est lu de la ligne du partage en base, jamais d'un en-tête du client) peut prendre une place commune **ou** réservée ; un segment gratuit ou Plus ne prend que les communes. Sans place : 503 `busy` avec `Retry-After`, comme aujourd'hui. Les limites **par connexion et par /48** (16 et 64 téléchargements, 8 et 32 envois) **ne changent pas** : un abus ne passe pas par le Pro.
- Honnêteté : « prioritaire », jamais « débit garanti » (§38.8.1) ; l'avantage profite aussi aux destinataires du partage Pro. Aucun effet sur la sécurité. Ce que voit le serveur : S59 (le niveau du partage, déjà connu, S30).
- **Tests**.

#### 38.9.14 Questions ouvertes ajoutées (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-F1 | Plafond de 7 jours : brouiller la date de création du plafond (retirer 0 à 3 h au hasard) pour que la base ne donne pas la création à 15 min près | Non (règle : « 7 jours après la création ») ; à revoir si S48 gêne |
| Q-F2 | Garder `R` dans l'historique local pour « ajouter des fichiers » sans ressaisir le lien et le mot de passe | Non (un voleur de l'appareil et de la base lirait le contenu) |
| Q-F3 | Notifications Web Push : service worker, contact sortant vers Google, Apple, Mozilla, Microsoft, bibliothèque de chiffrement RFC 8291 côté Go | À trancher ; sans décision, **pas de push** |
| Q-F4 | Répartition des fonctions entre Plus et Pro (§38.9.0) et limites de « Demander des fichiers » | La table de §38.9.0 |
| Q-F5 | Nombre de prolongations par partage | 5 |
| Q-F6 | Les destinataires d'un lien révoqué sont-ils prévenus | Non (le lien répond comme un lien inexistant) |
| Q-F7 | 5 faux mots de passe sur un lien d'un partage à plusieurs liens : détruire ce lien seulement ou tout le partage | Ce lien seulement (une personne qui n'a qu'un lien ne peut pas détruire les autres) |

---

## 39. Salon de discussion éphémère

Demande : « Pouvoir générer un lien de discussion, avec les mêmes critères de sécurité. On y parle, on s'envoie du texte et directement des documents (PDF, Word, photos, vidéos, archives…). On voit en direct quand quelqu'un écrit. Messages vocaux, émojis, et tout ce qui est utile et important. Confidentialité et sécurité avant tout. Fichiers illimités en nombre, mais 1 Go au plus au total dans la conversation. Nombre de participants fixé par le créateur ou laissé ouvert (10 au plus). Une couleur par personne. Après le lien et le mot de passe, avant le salon, une page explique le concept et impose un pseudonyme pour cette conversation. Le bouton du salon est à part, pour qu'on le voie. »

**Référence** : cette section pose le modèle, les clés du salon, le transport, l'entrée, les fonctions, les écrans et le cadre légal ; la **spec salon v3** (`2026-11-11-salon-v3-design.md`) fait foi pour le chiffrement (MLS, OpenMLS =0.9.2), les messages, l'effacement, la conversation sur disque et le protocole du serveur ; les appels ont leur conception (`2026-11-20-appels-design.md`). Créer un salon exige un compte (§37). Serveur : désactivé par défaut (`SHH_SALONS=0`), activé et ouvert au public dès le premier déploiement, risque assumé (§39.7, Q-SAL8).

### 39.1 Modèle

- **Création** par le navigateur du créateur, sans compte : durée de vie **1, 6, 12 ou 24 h** (mêmes choix que les partages ; Plus : §39.11), comptée **depuis la création** (un salon sert tout de suite, il n'y a pas d'envoi à attendre), expiration arrondie au quart d'heure supérieur ; **nombre de participants** « Ouvert (10 au plus) » par défaut, ou de 2 à 10 ; **mot de passe** : même générateur et mêmes règles que §31 (10 caractères générés, 10 au moins si saisi, liste noire) ; bascule « Les participants peuvent détruire le salon » (désactivée par défaut, Q-SAL4) ; preuve anti-robot (§22 ; , retiré le 24 novembre).
- **Lien** : `https://shhdrop.app/#c<K_lien, 43 caractères base64url>` (65 caractères), à côté de `#<43>` (partage) et `#m<43>` (gestion, §32). Le routeur distingue par la longueur et le préfixe ; même hygiène (§5.3). Le créateur garde aussi `S_gestion` (en mémoire de la page, et dans l'historique local de §33 si « Garder dans mon historique » est activé) pour détruire le salon même sans y être.
- **Budget** (**2 Go par salon**, comme un partage gratuit ; 1 Go avant) : **2 Gio = 2 147 483 648 octets de fichiers chiffrés par salon**, imposé par le serveur : chaque pièce jointe compte la taille du fichier chiffré de son palier (48 + B × 65 552) ; les messages écrits et les vocaux n'y comptent pas (v3 §5.1, ils ont leurs propres cadences). Aucune limite de nombre de fichiers. Le plus gros fichier possible reste celui du palier 8 000 (524 416 048 octets de chiffré, **524 222 464 octets utiles, « 500 Mo »**) : quatre tiennent dans le budget. À l'écran : « 2 Go au total · 500 Mo au plus par fichier ». *(Avant le 13 novembre : 1 Gio, trames comprises ; la règle « trames hors budget » vient de la v3 §5.1.)*
- **Fin de vie**, le premier atteint : expiration ; « Détruire le salon » par le créateur (`S_gestion`) ou, si la bascule est activée, par tout participant ; 10 mots de passe faux (Q-SAL3) ; administrateur (`shhdrop admin destroy -` reconnaît `#c`, §15.3) ; budget épuisé ne détruit pas : il bloque seulement les envois de fichiers (« Le salon est plein : 2 Go atteints »). À la fin : flux fermés, file en mémoire effacée, pièces jointes effacées (fichier puis ligne), ligne du salon supprimée, exactement comme un partage (§7.6).
- **Exclusion** : le créateur peut exclure un participant (§39.13).
- **Nouveaux venus** : ils ne voient **pas** les messages d'avant leur arrivée (conséquence de §39.2 : les chaînes changent à chaque arrivée). Choix par défaut, Q-SAL2.
- **Arrivée et départ** : **Remplacé par D41-24** : une place (« siège ») est prise au mot de passe juste et reste **réservée pendant toute la vie du salon** avec son pseudonyme et sa couleur, jusqu'à « Quitter » (message `0x03`), l'exclusion ou la fin du salon. **Coupure réseau, onglet ouvert** : la page se reconnecte seule, sans mot de passe, avec un secret de reconnexion gardé **en mémoire de la page seulement** (§39.13.3). **Rechargement, onglet fermé, application quittée** : le mot de passe est redemandé ; **D41-26** : il ouvre la preuve de membre gardée chiffrée sur l'appareil et rend la même place, le même pseudonyme et la même couleur ; sans preuve, nouvelle place, l'ancienne gardée jusqu'à la fin du salon ou son exclusion par le créateur (§39.13.3 ; revue finale C-2 : siège réservé pour la vie du salon, règle « instantané »). Pendant l'absence, les autres voient « hors ligne » sur la personne (présence `0x07`). Le navigateur prévient avant un rechargement (`beforeunload`) ; les messages affichés disparaissent (Q-SAL2).

### 39.2 Chiffrement

Le contenu du salon est chiffré par **MLS** (RFC 9420) avec **OpenMLS =0.9.2** sur RustCrypto, dans un module wasm à part (spec salon v3 §3 ; trames « SHC3 », v3 §3.2.1). Les clés du salon (§39.2.1), tirées du lien et du mot de passe, protègent l'entrée et l'enveloppe des trames. Une première construction par « clés d'expéditeur » sur libsodium a été étudiée puis écartée au profit de MLS ; elle n'est pas codée (§39.2.2 à §39.2.4).

#### 39.2.1 Clés du salon

> Gardées telles quelles par la spec salon v3 §3.3.

| Élément | Création | Où il vit |
|---|---|---|
| `K_lien` | 32 octets aléatoires | après `#c` ; jamais envoyé |
| `K_accès_s`, `V_accès_s` | HKDF(`K_lien`, « shhdrop/v2/salon/acces »), SHA-256 | en-tête `X-Shh-Access` / serveur (index unique) |
| `S_gestion`, `V_gestion` | 32 octets aléatoires, SHA-256 | navigateur du créateur (jamais gardé, D42-27) / serveur |
| `sel` | 16 octets aléatoires | serveur, rendu par `meta` |
| `K_mdp` | Argon2id(mot de passe NFC, `sel`), 64 Mio, 3 passes (§7.1, mêmes bornes) | navigateur |
| `K_maître_s` | HKDF(`K_lien` ‖ `K_mdp`, « shhdrop/v2/salon/maitre ») | navigateur |
| `K_preuve_s`, `V_preuve_s` | HKDF(`K_maître_s`, « shhdrop/v2/salon/preuve »), SHA-256 | envoyé pour entrer / serveur |
| `K_salon` | HKDF(`K_maître_s`, « shhdrop/v2/salon/cle ») | navigateur |
| `K_trame` | HKDF(`K_salon`, « shhdrop/v2/salon/trame »), 32 octets | navigateur (clé XChaCha20-Poly1305 de l'enveloppe extérieure) |
| `tag_salon` | HKDF(`K_salon`, « shhdrop/v2/salon/id »), 16 octets | navigateur (données authentifiées) ; jamais envoyé |

> **Moteur (F4, spec salon v3 §15)** : le moteur expose `K_maître_s` (`cle_maitre`, `cleMaitre`) et refait `K_preuve_s`, `K_salon`, `K_trame` et `tag_salon` à partir d'elle seule (`cles_depuis_maitre`, `clesDepuisMaitre`), par les dérivations de ce tableau, inchangées ; vecteurs communs `cles.k_maitre` de `engine/vectors/salon-v3.json`. C'est `K_maître_s'`, et elle seule, que le créateur distribue à une rotation (§39.13.2).

Toutes les étiquettes commencent par `shhdrop/v2/salon/` : séparation de domaine avec les partages (§29.2), le coffre (§27.2) et le compte (§37.2). HKDF par WebCrypto (`deriveBits`, sel vide, comme `kdf.ts`). `K_trame` sort en octets bruts, car libsodium l'utilise : elle vit dans la mémoire de la page comme les fichiers en clair (limite §18.4).

#### 39.2.2 Clés de chaque participant

Identité éphémère MLS (Ed25519), tirée à l'entrée, en mémoire de la page seulement : spec salon v3 §3.1.

#### 39.2.3 Format des trames (taille unique)

Trame « SHC3 » de taille unique (4 140 octets) : spec salon v3 §3.2.1.

#### 39.2.4 Époques et renouvellement

Commits MLS ; renouvellement toutes les 100 messages et toutes les heures ; ce que cela garantit et ne garantit pas : spec salon v3 §3.1 et §3.6.1. Le changement d'époque est un **changement de clés**, pas une limite : il n'a aucun effet sur le nombre de messages ni sur la durée de la conversation.

#### 39.2.5 Pièces jointes

> Détail : spec salon v3 §3.4 (la graine `R` voyage dans un message MLS).

- Chaque fichier, vocal ou photo est un **paquet SHH2 d'un seul élément** (§29.3, `container.ts` inchangé) sous une graine `R` aléatoire propre ; nettoyé avant (§35.2, mêmes états `echec` / `protege` et mêmes choix).
- Le message `piece` porte `R` (32 octets), l'identifiant de la pièce tiré par le serveur, le palier, et pour l'affichage avant téléchargement le nom, le type et la taille ; après téléchargement, le manifeste du paquet (authentifié) fait foi : nom, type ou taille différents → « Fichier corrompu », rien n'est affiché. Noms par `safeName`, aperçu par `previewKind`, avertissement par `isRiskyFile` (§12), comme un partage.
- Le serveur n'a jamais `R` ; il ne peut ni lire ni échanger une pièce (le contrôle de `C_engagement` échoue).

### 39.3 Transport et serveur

#### 39.3.1 Choix : WebSocket, toujours par notre serveur

Tout le trafic de discussion (messages, présence, « écrit… », clés, signalisation de contrôle) passe **par notre serveur, sur un WebSocket**, jamais en pair à pair entre participants : aucun WebRTC dans le salon, aucun candidat ICE, aucun serveur STUN ou TURN. Effets : les participants **ne voient jamais l'adresse IP les uns des autres** (seul notre serveur les voit, en direct, §18.3 et §18.20) ; la latence est celle d'un seul aller-retour vers le serveur ; une seule logique de reprise. Les pièces jointes restent stockées chez nous, chiffrées, comme les partages (§39.3.4) ; le comportement « pièces en direct » de Q-SAL10 est supprimé.

- **Bibliothèque** : `github.com/coder/websocket` (licence ISC, série v1.8, dernière version relevée v1.8.15 du 15 juin 2026), sans dépendance transitive ; version exacte épinglée  (dernière stable publiée depuis au moins 7 jours, §24) après revue de chaîne d'approvisionnement (`supply-chain-risk-auditor`, `govulncheck`). `golang.org/x/net/websocket` est déconseillé par ses auteurs ; `gorilla/websocket` (v1.5.3, juin 2024) est la solution de repli.
- **Route** : `GET /api/salons/ws` (mise à niveau HTTP). **Aucun secret dans l'URL** (CH7) : le navigateur ne permet pas d'en-tête sur un WebSocket, donc la **première trame** envoyée par le client, dans les 5 s, est le **message d'accueil** : jeton de membre (43 octets ASCII) ‖ `depuis` (8 octets, gros-boutiste) = 51 octets ; sinon fermeture (code 4001). Le jeton est vérifié par SHA-256 comme avant (§39.3.3).
- **Origine** : le serveur refuse (403) toute mise à niveau dont l'en-tête `Origin` n'est pas exactement l'origine du site (un WebSocket n'est pas soumis à CORS : sans ce contrôle, n'importe quelle page pourrait ouvrir la connexion d'un visiteur). Même sans cela, le message d'accueil exige un jeton que seule la page connaît.
- **Compression désactivée** (pas de `permessage-deflate` : inutile sur du chiffré, et elle ajouterait une fuite de taille). `SetReadLimit` à 4 200 octets ; aucun message plus grand n'est lu.
- **Client → serveur** (messages binaires, type d'un octet puis corps) : `0x01` trame (exactement 4 140 octets) ; `0x02` retirer (`seq`, 8 octets) ; `0x03` quitter (vide) ; `0x04` ping (8 octets aléatoires).
- **Serveur → client** (enregistrements `type` (1) ‖ `seq` (8, gros-boutiste) ‖ données) : `0x01` trame (`siège` (1) ‖ 4 140 octets ; **renvoyée aussi à son expéditeur**, qui s'en sert d'accusé et pour connaître le `seq` de sa trame ; accusé remplacé par `0x0F` en C-2, ci-dessous) ; `0x02` arrivée (`siège` ‖ `nonce_arrivée` (16)) ; `0x03` départ (`siège`) ; `0x04` trou (`seq` = premier numéro encore en file) ; `0x05` fin (raison : 1 expiré, 2 détruit, 3 budget de flux, 4 remplacé par une autre connexion du même siège, **5 exclu**, **6 client trop lent**, **7 interrompu par le serveur** : renouvellement impossible) ; `0x07` présence (`siège` ‖ 1 en ligne ou 0 coupé) ; `0x08` pong (les 8 octets du ping) ; `0x09` exclusion et rotation (§39.13) ; `0x0A` reprise d'un siège par son jeton (`siège` ‖ nouveau `nonce_arrivée`) ; `0x0B` limite (secondes à attendre : trames trop rapprochées, remplace le 429) ; `0x0C` budget (« Le salon est plein »). L'enregistrement `0x06` (maintien toutes les 25 s) est **supprimé** : le ping le remplace.
- **Protocole du serveur (fait foi)** : enregistrements, tailles et codes exacts dans la conception du salon v3 §17 (`docs/conception/specs/2026-11-11-salon-v3-design.md`). Ajouts : client `0x05` lu (`seq`), `0x01` peut porter l'identifiant d'une pièce (16 octets) après la trame ; serveur : `0x01` porte aussi l'heure de réception (8 octets, ms) et fait 4 158 octets, `0x07` porte la dernière connexion (19 octets), `0x09` exclusion (`siège` ‖ `nonce_arrivée` ‖ `r`), `0x0B` limite (secondes, 4 octets), `0x0C` plein (disque, ou 100 000 trames rangées dans ce salon, réglable par `SHH_SALON_FRAMES_MAX`), `0x0D` liste des sièges (11 + 25n octets), `0x0E` trame effacée (`seq`), `0x0F` trame acceptée (9 octets, `seq` = rang de la trame ; à l'expéditeur seul, même en rattrapage ; le client règle sa trame en vol sur `0x0F`, `0x0B` ou `0x0C`, plus sur l'écho, qui ne vient pas pour une volatile ou une « instantané » effacée avant son rattrapage) ; `0x10` réglages (spec `2026-11-13-salon-places-duree-design.md` : départ (8) ‖ secondes restantes (4) ‖ places (1), 22 octets, sans rang ; diffusé à chaque changement de places ou renouvellement, en direct, au retour au direct et dans l'accueil d'un salon déjà réglé ; jamais de fermeture ; le client efface tout ce qu'il garde de rang ≤ départ) ; seuls `0x01`, `0x02`, `0x03`, `0x09`, `0x0A` prennent un rang. `0x04` trou et raison 3 (budget de flux) ne sont jamais émis (numéros réservés). Codes de fermeture : 4001 accueil absent ou invalide, 4002 jeton révoqué (exclusion), 4003 message invalide, 4004 jeton inconnu (place libérée, salon fini, redémarrage), 4005 remplacé, 4006 trop lent, 1000 fin du salon ou départ, 1001 arrêt du serveur ou silence de 45 s, 1009 message trop grand (bibliothèque), 1011 erreur interne (panique, entrée-sortie, trame illisible, journal plein) ; conduite du client pour chacun : salon v3 §17. Les mises à jour du serveur et le redémarrage ou la recréation du conteneur Caddy (après un changement du `Caddyfile` ; pas de `caddy reload`, l'API d'administration étant coupée, `admin off`) coupent les WebSocket : le client se reconnecte seul (rattrapage par `depuis`). Le délai `read_body 5m` de Caddy peut couper un WebSocket dès 5 min : essai long à faire avant l'activation (v3 §3.6.1, exigence d'interface 21).
- **Maintien de la connexion (ping / pong)** : le serveur envoie un **ping WebSocket** toutes les 20 s et ferme la connexion s'il n'a reçu ni pong ni message depuis 45 s (les navigateurs répondent seuls aux pings du serveur). Comme le script ne voit pas ces pings, le client envoie en plus un **ping applicatif** (`0x04`) toutes les 15 s et attend le `0x08` en moins de 10 s ; sans réponse, il ferme et se reconnecte (attente 0,5 / 1 / 2 / 4 / 8 s plus une gigue aléatoire, avec `depuis` = dernier `seq` reçu). Le temps mesuré (RTT) alimente un indicateur « connexion lente » au-delà de 1 s.
- **Contre-pression (back-pressure)** : file d'envoi **bornée par connexion** (256 enregistrements) ; un client qui ne lit pas (file pleine plus de 5 s, ou une écriture bloquée plus de 10 s, `SetWriteDeadline`) est **fermé** avec la raison 6 et se reconnecte en rattrapant la conversation du salon (sur disque, §39.3.2) : le serveur ne garde pour lui que sa file d'envoi bornée, un client lent ne ralentit pas les autres (une goroutine d'écriture par connexion). Côté client : on n'envoie pas tant que `ws.bufferedAmount` dépasse 64 Kio, et au plus 20 trames non accusées ; au-delà, le bouton Envoyer reste actif mais le message attend dans une pile locale bornée (« En attente de la connexion »). Trames montantes : 60 par minute par siège (rafale 20) comme avant, signalées par `0x0B`.
- **Objectifs de latence** (mesurés, tests de §39.8) : **livraison d'un message de bout en bout, p95 inférieure à 300 ms sur un même continent** (de l'envoi chez A à l'affichage chez B, 10 membres, 1 message par seconde et par membre) ; temps passé dans le serveur (réception de la trame, dernière écriture vers les 10 sièges), p95 inférieur à 20 ms ; ouverture du WebSocket et accueil, p95 inférieure à 1 s ; reconnexion après coupure, p95 inférieure à 3 s. Un objectif manqué fait échouer le banc `bench/salon-latency`, pas la mise en ligne seule.
- **Pas de repli** par flux `fetch` en V1 : si le WebSocket échoue 3 fois de suite (certains réseaux d'entreprise le bloquent), l'écran dit « Votre réseau bloque les connexions en direct. Essayez un autre réseau. » (Q-WS1 : un flux `fetch` descendant reste une solution de repli à écrire si ce blocage est fréquent).
- **Caddy et HTTP/2** : `reverse_proxy` transmet la mise à niveau WebSocket ; l'allocation `flush_interval -1` sur le flux n'est plus nécessaire ; Caddy ne retire ni `Origin`, ni `Upgrade`, `Connection`, `Sec-WebSocket-*` (§36 S2 ; le serveur Go ne les lit que dans `handlers_salon_ws.go`), ce que prouve `deploy/test-proxy.sh` (WebSocket gardé 75 s à travers Caddy, origine étrangère ou absente refusée en 403). **CSP** : `connect-src 'self' wss://{hôte du site}` (notre propre hôte, jamais un tiers) : certaines versions de Safari ne font pas correspondre `'self'` aux adresses `wss:` ; testé sur WebKit. Une connexion par siège (une nouvelle remplace l'ancienne, raison 4).
- Limites (§39.3.6) : « flux ouverts » devient « WebSocket ouverts » (4 par connexion, 16 par /48, 2 000 au total ; 8 par connexion depuis la revue finale C-2, I4, §39.3.6).

#### 39.3.2 Relais et conversation sur disque (salon v3 §5.1)

- **Trames non volatiles** : écrites sur le disque du serveur, dans un fichier par salon (`salons/{id interne}`), un emplacement de 4 168 octets par trame, dans un fichier qui grandit par **paliers de 64 emplacements remplis d'octets aléatoires** (stockage F4 : la taille ne donne plus le nombre exact de messages ; une trame retirée ou effacée par la règle a son emplacement écrasé d'octets aléatoires, plus de zéros), sous une **seconde couche AES-256-GCM** dont la clé aléatoire du salon ne vit qu'en mémoire (v3 §5.1). Aucun `seq`, siège, heure ou drapeau en clair sur le disque. Trame retirée ou effacée par la règle : emplacement écrasé de zéros, plus jamais servie. À la fin du salon : clé oubliée, fichier supprimé.
- **Effacement des trames rangées** (v3 §5) : règle 0 jusqu'à la fin ou au renouvellement (protocole, fichiers) ; règles 1, 2, 3 effacées 1 min, 5 min ou 1 h **après la lecture par tous** les sièges présents à l'envoi (lectures `0x05`, départs et exclusions comptés, absents attendus), avec un `0x0E` à tous ; « instantané » et « 10 min / 1 h depuis l'envoi » ne sont plus proposés. Le serveur voit quand le dernier lecteur a lu chaque message de ces règles (v3 §10).
- **Trames volatiles** (« en train d'écrire », accusés, présence ; bit 0 de `drapeaux`) : relayées en direct, **jamais écrites** ni gardées pour le rattrapage (rang consommé, trou normal).
- **Index en mémoire seulement** : par trame non volatile, rang, heure de réception du serveur (ms), emplacement, siège, drapeaux, lecteurs attendus (24 octets) ; jamais en base ni dans un journal, ni dans un fichier d'échange (swap coupé, §22).
- **Rattrapage** : un membre qui revient (`depuis`) reçoit toutes les trames non volatiles non effacées et les annonces de rang supérieur, sans limite de nombre ni de durée ; un nouveau venu ne reçoit rien d'avant son arrivée (`depuis` effectif = max(`depuis`, rang d'émission du jeton)). `0x04` (trou) n'est plus émis.
- Plafond global `SHH_SALONS_MAX` = 200 salons vivants. Au-delà, ou si l'usage total plus 2 Gio dépasse `SHH_STORAGE_MAX`, création refusée (503 `busy`).
- Un redémarrage du serveur oublie la clé de la seconde couche, l'index et les sièges (conversation illisible, fichiers effacés au démarrage) : les pages ouvertes rentrent seules (elles gardent `K_accès_s` et `K_preuve_s` en mémoire, comme l'ouverture d'un partage, §18.10) et ouvrent de nouvelles époques.
- Message `retirer` (`0x02`, `seq`) du WebSocket, utilisé par « Retirer pour tous » : écrase une trame non volatile **de l'occupant actuel du siège** (le serveur sait quel siège a posté chaque trame) : même siège, et rang de la trame supérieur à celui de l'**arrivée (`0x02`) de cet occupant** ; une reprise (`0x0A`, rechargement) garde ce rang, si bien qu'on peut toujours retirer ses propres messages ; au siège 0, toujours le créateur, tout depuis la création du salon. Un siège libéré puis réattribué reçoit un nouveau rang d'arrivée : le nouvel occupant ne retire pas les trames de l'ancien. Volatile, rang inconnu ou trame d'un autre : ignoré sans erreur.

- **Écriture des trames** : la trame est écrite **hors du verrou du salon** ; le rang est attribué ensuite, sous le verrou ; l'index garde l'emplacement de chaque rang (l'ordre des emplacements du fichier n'est pas celui des rangs). Une borne d'appels disque saturée ne fige donc pas l'entretien des autres salons (effacements à échéance).
- **Lectures de conversation** : bornées comme les écritures (bornes propres au salon, distinctes de celle des partages) ; aucun appel disque sous un verrou de salon.
- **Plafond global des trames en mémoire** : la moitié de `SHH_SALON_FRAMES_TOTAL` est réservée à parts égales entre les `SHH_SALONS_MAX` salons ; un salon n'est refusé (`0x0C`) qu'au-delà de sa part et pot commun vide (bornes de démarrage : §8).
- **Clé de conversation** : oubliée à la fin du salon, pas effacée de la mémoire au sens strict (limite de la bibliothèque standard de Go ; à reprendre avec `runtime/secret`).

#### 39.3.3 Sièges, plafond, jetons

- `POST /api/salons/rejoindre` (`X-Shh-Access`, `{ "proof" }`) : `K_preuve_s` juste → le serveur, en une opération atomique, vérifie `sièges occupés < max_members` et `arrivées totales < 5 × max_members`, attribue le plus petit siège libre (0 à 9), tire un **jeton de membre** (32 octets, gardé en mémoire par SHA-256) et un `nonce_arrivée` (16 octets, diffusé dans l'enregistrement 0x02, signé dans l'annonce : un membre ne peut pas rejouer l'annonce d'un autre). Réponse : `{ member_token, seat, seq, nonce_arrivee, expires_in_s, max_members, members_can_destroy, budget_left }` (`nonce_arrivee` : 16 octets en base64url, nécessaire au client avant le WebSocket). Complet → 409 `full` (« Ce salon est complet. ») ; faux → 403 `bad_password` avec essais restants.
- Le plafond est donc imposé par le serveur sur les jetons ; un siège pris reste réservé pendant toute la vie du salon, choisi ou non un pseudonyme, jusqu'au départ, à l'exclusion ou à la fin (revue finale C-2 : siège réservé pour la vie du salon, règle « instantané » ; le serveur ne sait pas si un pseudonyme a été choisi).

#### 39.3.4 Pièces jointes sur disque

- Comme les segments d'un partage : un fichier par pièce, taille exacte du palier réservée (`fallocate`), écriture à position fixe, segments de 4 Mio, bourrage rempli par le serveur à la finalisation (`fill_from`, `fill_to` de la pièce ; les partages n'ont plus cette forme depuis H-5, §29.3), dates remises à zéro, `O_NOATIME`, aucune sauvegarde. Elles comptent dans `SHH_STORAGE_MAX` (§4) et dans le budget du salon, réservées à la création de la pièce.
- Table `salon_pieces` (`id`, `salon_id`, `bucket`, `state`, `segments_mask`), effacée avec le salon. L'auteur d'une pièce n'est connu qu'en mémoire (siège), pour le retrait.
- Téléchargement : `GET /api/salons/pieces/segments/{n}` avec `X-Shh-Membre` et `X-Shh-Piece` (aucun identifiant dans le chemin, §29.8) ; budget de lecture : 2 × le fichier chiffré par membre et par pièce (même règle que §24) ; plafond de sortie par pièce, tous membres confondus : places choisies à la création × 2 lectures du fichier chiffré, en mémoire seulement, puis **403 `egress_limit`** (v3 §3.4).
- Quotas : les octets utiles des pièces comptent dans les quotas journaliers de §4 (6 Gio par connexion, 12 Gio par /48), débités à la finalisation.

#### 39.3.5 Base

- Table `salons` dans `shares.db` (mêmes règles : `WITHOUT ROWID`, `secure_delete`, WAL vidé) : `id` (interne, 128 bits), `access_v`, `manage_v` (index uniques), `proof_v`, `salt`, `kdf_ops`, `kdf_mem`, `expires_at` (arrondie au quart d'heure), `max_members`, `members_can_destroy`, `failed_attempts`, `pieces_bytes` (somme réservée des pièces), `rotation_r` (numéro de la dernière rotation de l'invitation, 0 sans rotation ; en base pour refuser par 409 `stale` un `exclure` rejoué après un redémarrage, qui ferait sinon revivre une invitation morte, §39.13.1b). **Fuite faible acceptée** (v3 §10) : `rotation_r` rend lisible sur le disque, tant que le salon vit, le nombre de rotations de l'invitation, donc une borne du nombre d'exclusions. **Jamais** : durée choisie (l'heure de création s'en déduirait), nombre de messages, budget des trames (en mémoire seulement : un redémarrage le remet à zéro, limite acceptée), sièges, pseudonymes, adresses.
- §35.1 (3) devient : `sqlite_master` ne contient que `shares`, `salons`, `salon_pieces` et leurs index.

#### 39.3.6 Limites (compteurs mémoire, ajoutés à §9.5)

| Limite | Valeur |
|---|---|
| Créations de salons | 5 par jour par connexion, 15 par /48, **renouvellements compris** (13 novembre : un renouvellement, `POST /api/salons/reglages`, compte comme une création) ; preuve anti-robot ; difficulté partagée avec les partages (§22). Création refusée par le serveur sans faute du client (503 `busy`, plafond des salons vivants) : non comptée ; `access_v` ou `manage_v` déjà vus : comptée |
| Salons vivants (décision de l'équipe du 12 novembre, réglable : constante `VivantsParBloc`) | **5 par /48** (par adresse en IPv4) en même temps ; au-delà 429 `limit` avec `Retry-After` jusqu'au quart d'heure suivant (première échéance possible). Sans lui, 14 blocs /48 à 15 créations par jour prennent les 200 places de `SHH_SALONS_MAX`. Compte en mémoire seulement (clé : HMAC-SHA-256 du /48 sous une clé de processus tirée au démarrage, jamais écrite) ; la place revient à la fin du salon (échéance, destruction). Limite : un redémarrage oublie le compte, les salons d'avant ne comptent plus |
| Entrées (`rejoindre`) | 20 par heure par connexion, 60 par /48 ; mots de passe faux : compteur du salon, 10 → destruction |
| Trames montantes | 60 par minute par siège (rafale 20), **480** par minute par connexion, **960** par /48 (une famille ou un bureau derrière un même NAT IPv4 partage une adresse ; un membre actif envoie environ 48 trames par minute, donc 120 bloquait dès 3 membres actifs et 4 WebSocket refusaient le 5ᵉ membre ; le plafond par siège borne déjà chaque membre) ; au-delà `0x0B` et l'écran temporise |
| WebSocket ouverts | **8** par connexion, 16 par /48, 2 000 au total (I4 : NAT d'une famille ou d'un bureau) |
| Pièces | 8 envois de segments simultanés par connexion (§24, inchangé) ; mêmes limites de débit des segments |

Clés : HMAC du jour comme §9.3, jamais d'adresse. L'état d'un salon vivant (file, sièges, empreintes des jetons, budget des trames) n'est pas une statistique au sens de §9.5 : il est nécessaire aux règles et effacé avec le salon.

#### 39.3.7 « En train d'écrire » : toujours actif

- **Décision** : l'indicateur est **activé pour tous et ne peut pas être désactivé**. **Signalement (gravité moyenne)** : c'est le contraire de la recommandation précédente (désactivé par défaut) ; appliqué, avec la fuite écrite ci-dessous, sur la page Sécurité et dans la page d'explication (§39.4, point 3).
- **Quantification grossière** : l'état « écrit » ne part qu'aux **tops d'une grille fixe de 2,5 s** (multiples de 2 500 ms depuis l'entrée dans le salon, horloge monotone) : au premier top qui suit une frappe, puis à chaque top tant qu'une frappe a eu lieu depuis le top précédent ; aucune trame d'arrêt (l'indicateur s'éteint chez les autres 6 s après la dernière trame `ecrit` reçue). Un message envoyé part tout de suite (le retarder au top suivant ralentirait la conversation ; Q-SAL9).
- **Même canal, même taille** : une trame `ecrit` est une trame de type 1 ordinaire (4 140 octets, chiffrée par la chaîne de l'expéditeur, signée) : le serveur ne la distingue pas d'un message.
- **Fuite, dite honnêtement** : le serveur voit **quand** chaque siège envoie une trame. Avec l'indicateur toujours actif, une suite de trames espacées de 2,5 s puis une trame isolée révèle qu'une personne écrit, depuis combien de temps (à 2,5 s près) et quand elle a envoyé, donc la longueur approximative de la saisie et le rythme de chaque participant. La quantification retire la cadence de frappe fine (pas de trame par touche), pas le fait d'écrire. Seul un trafic de couverture constant (une trame toutes les 2,5 s pour chaque présent, qu'il écrive ou non) l'effacerait : environ 1,6 Kio/s par présent et 4 140 octets du budget toutes les 2,5 s (près de 600 Mio sur 24 h pour 10 personnes), **non retenu** (Q-SAL9). Texte de la page d'explication : « Les autres voient quand vous écrivez. Le serveur ne lit rien, mais il voit quand vous êtes actif. »
- **Accusés de lecture** : désactivés par défaut, réglage par personne, trame `lu` au plus toutes les 10 s, seulement si les deux côtés l'ont activé.

#### 39.3.8 Ce que voit le serveur (complète le tableau de §36)

| # | Ce qu'il voit ou peut déduire | Exposition | Réduction | État |
|---|---|---|---|---|
| S31 | Existence d'un salon, échéance, plafond, droit de destruction des membres | `salons`, au quart d'heure | durée non stockée | Fait C-2 (7, 15) |
| S32 | Arrivées et départs, nombre de présents | en direct et en mémoire (sièges) | rien sur disque | Assumé (nécessaire au plafond) |
| S33 | **Qui parle avec qui** : les adresses IP des membres d'un même salon | en direct seulement | jamais sur disque ni journal ; Tor plus tard (§3) | **Impossible** sans Tor ; limite §18.20 |
| S34 | Nombre et heure des trames par siège ; **qui est en train d'écrire et depuis combien de temps** (indicateur toujours actif) | en direct, file de 15 min | taille unique, type caché, état « écrit » quantifié sur une grille de 2,5 s ; pas de trafic de couverture (Q-SAL9) | Assumé, dit (§39.3.7) |
| S35 | Taille des messages | aucune : 4 140 octets toujours | — | Fait par conception |
| S36 | Type de trame (texte, réaction, « écrit », clé, annonce) | aucune : chiffré sous `K_trame` | — | Fait par conception |
| S37 | Pièces jointes : nombre, palier, heure d'envoi et de lecture, qui télécharge | base (palier) et en direct | aperçu automatique des images et vocaux ≤ 16 Mio chez tous (une lecture ne distingue plus qui a regardé) ; taille à 4 Mio près pendant l'envoi (§18.12) | Fait C-2 ; C-5 pour les aperçus |
| S38 | Pseudonymes, couleurs, réactions, réponses, réglages | aucune : dans le chiffré | — | Fait par conception |
| S39 | Budget utilisé | pièces : base ; trames : mémoire | — | Assumé |
| S40 | Mots de passe faux | `failed_attempts` | nécessaire (§2) | Assumé |
| S41 | Créateur | `manage_v` ; en direct, la connexion qui crée | aucun lien avec un compte (§37.4) | Assumé |
| S42 | Retrait d'un message | qu'un siège a retiré l'une de ses trames, laquelle (`seq`) et quand (en mémoire seulement) | — | Assumé |
| S43 | En-têtes, User-Agent | retirés par Caddy (§36 S2) ; `X-Shh-Membre`, `X-Shh-Piece` et `X-Shh-Access-New` ajoutés à la liste blanche (pas d’`X-Shh-Depuis` : `depuis` voyage dans l’accueil du WebSocket) ; `Origin` gardé par Caddy, lu seulement pour le WebSocket | — | Fait C-2 (17 : `test-proxy.sh`, `salon-sees-nothing.test.ts`) |
| S63 | Nombre de messages, heure de la dernière trame, durée choisie | fichier de conversation : taille (par paliers de 64 trames, 267 Ko, depuis le 13 novembre : plus le nombre exact), `ctime` (ramené chaque minute à l'heure du passage de l'entretien : lisible une minute au plus après une écriture), date de naissance (**non corrigeable** : aucun appel système ne la change) (première entrée ; avec `expires_at`, la durée) | fichier préalloué par paliers (plus tard) | Assumé (v3 §10) |

#### 39.3.9 Routes (toutes sous `/api/salons/`, JSON strict de §8 sauf trames et segments)

Longueurs exactes en base64url : secrets et jetons 43 caractères, identifiants de pièce 22. Erreurs : `not_found` (salon inconnu, expiré, détruit, mauvaise `K_accès_s` : même corps), `bad_password` (avec `attempts_left`, comme les partages), `full` (409 : salon complet, ou journal des annonces du salon saturé, définitif ; **aussi disque plein à la création d'une pièce**, même code : le client ne peut pas les distinguer, 507 proposé, non retenu à ce jour), `budget` (409 : budget de 2 Go du salon plein ; 429 : budget de lecture d'une pièce épuisé, comme les partages), `limit` (429, `Retry-After`), `busy` (503, `Retry-After: 5` comme les partages), `excluded` (403), `forbidden` (403 : retrait d'une pièce par un autre que son auteur), `too_large` (413, audit du 12 novembre, D2 : segments reçus pour une pièce, réécritures comprises, au-delà de 2 × sa taille ; la pièce est à abandonner, pas à réessayer), `method_not_allowed` (405, `Allow: GET, PUT` : `HEAD` ou toute autre méthode sur les routes des segments), `bad_request`.

**`S_gestion` inconnu** : absent, mal formé, inconnu ou d'un salon qui n'est plus vivant, il donne 403 `forbidden` sur `exclure` (§39.13.5 : rien n'est révélé), 404 `not_found` sur `gestion` et sur `detruire` (« ce salon n'existe plus »). `detruire` : exactement un de `X-Shh-Manage` ou `X-Shh-Membre` ; aucun des deux, ou membre sans `members_can_destroy` : 403 `forbidden` ; les deux : 400. Le client traite chaque cas.

| Route | Authentification | Corps | Réponse |
|---|---|---|---|
| `POST /api/salons` | preuve anti-robot ; `X-Shh-Access`, `X-Shh-Manage` | `{ ttl_hours ∈ {1,6,12,24}, max_members ∈ 2..10, members_can_destroy, salt, kdf_ops, kdf_mem, proof_v, captcha… }` | `{ expires_in_s }` ; `access_v` ou `manage_v` déjà vus → 400 comme §29.8 |
| `GET /api/salons/meta` | `X-Shh-Access` | — | `{ expires_in_s, salt, kdf_ops, kdf_mem }` |
| `POST /api/salons/rejoindre` | `X-Shh-Access` | `{ proof }` | §39.3.3 |
| `GET /api/salons/ws` | message d'accueil : `X-Shh-Membre` (jeton) ‖ `depuis` | messages de §39.3.1 | WebSocket binaire (§39.3.1) |
| (`trame`, `retirer`, `quitter` : messages `0x01`, `0x02`, `0x03` du WebSocket) | — | — | — |
| `POST /api/salons/exclure` | `X-Shh-Manage`, `X-Shh-Access-New` | `{ seat?, nonce_arrivee?, r, proof_v, salt, kdf_ops, kdf_mem }` | `{}` ; 409 `stale` (§39.13.2) |
| (voir ci-dessus : `0x03`) | — | — | — |
| `POST /api/salons/detruire` | `X-Shh-Manage`, ou `X-Shh-Membre` si `members_can_destroy` (exactement un des deux) | `{ reason?: "report" }` | `{}` ; les deux en-têtes, en-tête mal formé ou raison autre que `"report"` : 400 ; aucun des deux, ou membre sans la permission : 403 `forbidden` ; `S_gestion` ou jeton inconnu, salon échu ou détruit : 404 `not_found` ; jeton révoqué : 403 `excluded` ; un signalement n'est compté qu'après une destruction réussie |
| `POST /api/salons/signaler` (« Quitter et signaler », §39.5) | `X-Shh-Membre` | `{}` | `{}` ; effet : le compteur horaire des signalements (§9.5, un entier sans identifiant, le même que pour un partage signalé) prend +1, et le membre part comme par un `0x03` du WebSocket (départ `0x03` diffusé, jeton oublié, WebSocket fermé en 1000) ; compté après un départ réussi, une fois par salon (booléen en mémoire, sans identifiant ni adresse : les signalements suivants du même salon font partir sans compter) ; un jeton ne signale qu'une fois (il est oublié aussitôt : un second appel donne 404). En-tête absent ou mal formé, corps autre que `{}` : 400 ; jeton inconnu, salon échu ou détruit : 404 `not_found` ; jeton révoqué : 403 `excluded` |
| `GET /api/salons/gestion` | `X-Shh-Manage` | — | `{ expires_in_s, present }` |
| `POST /api/salons/reglages` (spec `2026-11-13-salon-places-duree-design.md`) | `X-Shh-Manage` ; preuve anti-robot avec `renouveler_h` | `{ max_members?: 2..10, renouveler_h?: 1\|6\|12\|24, altcha?, hp?, shown_at? }`, au moins un des deux réglages | `{ max_members, expires_in_s, depuis }` (`depuis` : rang de départ du dernier renouvellement, 0 sans) ; places sous le besoin minimal (sièges occupés, plus le siège 0 du créateur s'il est vide) : 409 `occupied` ; hors bornes ou preuve sans `renouveler_h` : 400 ; `S_gestion` : mêmes réponses que `gestion`. **Renouvellement** = nouvelle durée depuis maintenant (quart d'heure supérieur) et conversation entièrement effacée (trames, pièces : fichier puis ligne, `pieces_bytes` revenu à 0), membres gardés à leur place, `seq` continu, `0x10` à tous ; compté comme une création de salon (quota de §39.3.6, preuve anti-robot ; 429 `limit`, 503 `frozen`) ; aucun plafond de durée gardé en mémoire. Changement de places : plafond des arrivées recalculé (5 × N) |
| `POST /api/salons/pieces` | `X-Shh-Membre` | `{ bucket, vocal }`, tous deux exigés (fichier : paliers de §29.3 jusqu'à 8 000 ; vocal : 1, 16 ou 80) | 201 `{ piece, upload_token }` ; 409 `budget` si le budget de 2 Go manque (fichier) ; 409 `full` si le disque est plein ; 429 `limit` (120 pièces par heure et par siège, ou réserve vocale du siège) |
| `PUT /api/salons/pieces/segments/{n}` | jeton d'envoi de pièce | segment exact (§7.4) | **204 sans corps**, comme les partages ; 413 `too_large` au-delà de 2 × la taille de la pièce (réécritures comprises) |
| `POST /api/salons/pieces/finalize` | jeton d'envoi de pièce | `{ fill_from, fill_to }` | `{}` ; 400 `bad_request` si un segment manque hors de `[fill_from, fill_to)` ou si le bourrage dépasse 4 × morceaux reçus + 512 morceaux (comme `padAllowed` des partages, D42-17) |
| `GET /api/salons/pieces/segments/{n}` | `X-Shh-Membre`, `X-Shh-Piece` | — | segment, en flux ; 429 `budget` (lecture) ; 403 `egress_limit` (plafond de sortie de la pièce, définitif, v3 §3.4) ; `HEAD` ou autre méthode : 405 |
| `POST /api/salons/pieces/retirer` | `X-Shh-Membre`, `X-Shh-Piece` (auteur seulement) | `{}` | `{}` |

### 39.4 Entrée dans le salon

1. **Ouverture du lien** `#c…` : clé lue puis retirée de la barre (§5.3), `meta` (secondes restantes, `sel`, KDF ; rien sur les présents). Écran : « On vous invite dans un salon de discussion chiffré. Il s'efface dans {durée}. » ; mot de passe ; avertissement du navigateur intégré (§5.2) ; conseil facultatif « navigation privée » (registre).
2. **Mot de passe** → `rejoindre` → siège et jeton (complet : écran « Ce salon est complet », sans autre détail).
3. **Page d'explication et pseudonyme** (objectif : après le mot de passe, avant le salon). **Signalement** : le brief du coordinateur plaçait l'explication **avant** le mot de passe ; elle est placée **après**. Retenu : une ligne avant (étape 1), la page complète après, avec le pseudonyme. Textes :
   - titre « Un salon qui s'efface » ;
   - « Chiffré sur chaque appareil. Le serveur ne fait que transmettre des messages qu'il ne peut pas lire. »
   - « Rien n'est gardé en clair : les messages sont écrits chiffrés sur le disque du serveur, illisibles pour lui, et tout s'efface au plus tard dans {durée}, ou plus tôt si le salon est détruit. » (Corrigé le 12 novembre, audit D8 : l'ancien texte, « les messages ne sont jamais écrits sur le disque du serveur », contredisait v3 §5.1, où la conversation est écrite sur le disque, chiffrée de bout en bout puis sous une seconde couche dont la clé reste en mémoire. Texte de l'écran ; les dictionnaires i18n de C-3 devront le reprendre.)
   - « Vous ne verrez pas les messages envoyés avant votre arrivée. »
   - « Une capture d'écran, ou une photo de l'écran, reste toujours possible : n'écrivez que ce que vous accepteriez de voir copié. »
   - « Shhdrop ne vérifie l'identité de personne : un pseudonyme n'est qu'un nom choisi. »
   - « Les autres voient quand vous écrivez. Le serveur ne lit rien, mais il voit quand vous êtes actif. »
   - « Votre salon change de clés de chiffrement toutes les 100 messages, toutes les heures et à chaque arrivée ou départ. C'est automatique et invisible : cela ne limite ni le nombre de messages, ni la durée de la conversation. Les messages écrits et vocaux sont illimités ; seuls les fichiers comptent dans le 2 Go du salon. » (D41-2, **texte corrigé le 12 novembre** selon salon v3 §5.1)
   - « Le créateur peut exclure quelqu'un. La personne exclue garde ce qu'elle a déjà vu et ne lit rien ensuite. » (D41-1)
   - champ **Pseudonyme pour ce salon** (obligatoire), bouton « Entrer dans le salon ».
4. **Pseudonyme** : NFC ; on retire contrôles, caractères d'inversion de sens, caractères ignorables par défaut ; espaces regroupés et rognés ; **2 à 24 graphèmes** (`Intl.Segmenter`) ; seulement lettres, marques, chiffres, (règle retenue : lettres et chiffres seulement, plus d'espace ni de `- _ . '` ; moteur `texte.rs`, vecteurs `pseudo` de `compte.json` et `salon-v3.json` régénérés) ; **une seule écriture** (latin, cyrillique, grec… plus les caractères communs : « Аlice » en cyrillique mêlé est refusé) ; pas d'émoji. **Unique dans le salon** : comparaison sur NFKC en minuscules sans espaces ni ponctuation ; les pseudonymes des présents (reçus dans leurs annonces) sont vérifiés pendant la saisie (« Déjà pris dans ce salon ») ; en cas de course, la première annonce dans l'ordre du serveur gagne et l'autre personne est renvoyée au champ. **Jamais envoyé en clair** : seulement dans les annonces chiffrées. **20 novembre 2026 — un seul pseudo pour un compte** : (→ **22 novembre 2026 : pseudo provisoire retiré**. La conception du compte par passkey, §3.1 et Q6, redemande le pseudo à l'inscription ; aucun compte n'ayant été ouvert au public, aucun n'a de pseudo provisoire. Retirés : `estPseudoProvisoire`, `pseudoAChoisir`, le refus de la forme « Membre/Member + 6 chiffres », le bandeau « Choisissez votre pseudo » du profil et la saisie du pseudo du compte à l'entrée d'un salon. Gardé : le pseudo pris comme invité dans un salon de l'onglet, en mémoire seulement, proposé dans le champ Pseudo de l'inscription.) Les rôles (« admin », « modérateur », « support »…) restent refusés par la liste réservée et la liste du serveur. **20 novembre 2026, suite** : (a) pseudo en **A-Z, a-z et 0-9 seulement** (ni accent, ni autre écriture, ni espace, ni signe ; moteur `texte.rs`, vecteurs régénérés) ; (b) le pseudo d'un compte change **3 fois par an au plus** : 123 jours au moins entre deux changements (serveur `compte.PseudoEcart` ; 123 et non 122 : 3 × 122 = 366 permettrait 4 changements sur une année bissextile — audit du 20 novembre ; essais de disponibilité limités avant la vérification, `AllowPseudoVerifier`), colonne `pseudo_jour` inchangée), le premier changement (22 novembre : depuis le pseudo choisi à l'inscription, `pseudo_jour` = 0, règle du 14 novembre) restant libre ; le nouveau doit toujours être libre ; (c) **dans un salon, une personne connectée garde le pseudo de son compte** (champ en lecture seule, « il se change dans votre profil »), sauf si ce pseudo vient d'être pris dans ce salon ; les invités sans compte choisissent un pseudonyme pour le salon ; (d) inscription : plus de phrase sous l'adresse ; adresse vérifiée pendant la frappe sur l'appareil (format du moteur, domaines jetables : mêmes listes que le serveur, `server/internal/compte/jetables*.txt`, faute de frappe d'un domaine courant corrigée sur proposition) ; **nouveau mot de passe** (inscription, mot de passe oublié, paramètres) : 10 caractères au moins, une minuscule, une majuscule, un chiffre, un caractère spécial, différent de l'adresse, chaque point coché pendant la frappe, refusé avant toute requête sinon (`routes/compte/verifs.ts` ; les apps appliquent la même règle) ; liens des pages du compte en blanc, soulignés (20 novembre, suite). **Audit du 20 novembre** : (retiré le 22 novembre avec le pseudo provisoire) ; vrais domaines voisins d'un domaine courant (ymail.com, mail.com, gmx.de…) jamais « corrigés ». Limite assumée : le pseudo du compte figé dans un salon l'est par l'appareil seulement (le serveur du salon ne voit pas les pseudos, chiffrés).
5. **Couleur** : palette fixe de 10, attribuée au plus petit indice libre parmi les présents, portée par l'annonce (course : ordre du serveur). Chaque couleur a un contraste ≥ 6,7:1 sur `--surface-3` (#202533), donc ≥ 4,5:1 sur tous les fonds du salon : menthe #5FE3B5, ciel #7CC4FF, lavande #B79CFF, rose #FF8FC7, corail #FF9A7A, ambre #F2C46D, citron #D8E86A, turquoise #4FD8E0, lilas #E0A8F0, sable #D9C3A0. La couleur n'est jamais seule : le pseudonyme est toujours écrit à côté (WCAG 1.4.1).
6. **Salon**. Le créateur passe par les étapes 3 à 6 depuis « Salon prêt » (« Entrer dans le salon »), sans retaper le mot de passe.

### 39.5 Fonctions du salon

**Audit du 20 novembre 2026** : le type du Blob d'une pièce montrée (image, vocal, vidéo) ne vient jamais du type annoncé par l'expéditeur tel quel : table fixe (`salon/affichage.ts`, mêmes listes que les partages, `viewers/blobs.ts`) ; vidéo ou vocal d'un type inconnu (par ex. `text/html`, `image/svg+xml`) : type par défaut de la visionneuse ; image hors liste : pas d'aperçu. Une adresse `blob:` héritant de l'origine du site, un type piégé ouvert dans un onglet s'y exécuterait. Les apps appliquent la même table.

- **Texte** : 2 000 graphèmes et 3 500 octets UTF-8 au plus ; au-delà, proposé en pièce jointe `.txt` (« Texte long : envoyer comme fichier ? »). Liens `https?://` cliquables, adresse affichée en entier, `rel="noopener noreferrer"`, `referrerpolicy="no-referrer"` ; **aucun aperçu de lien** (il appellerait le site et révélerait la conversation) ; aucun autre schéma rendu cliquable ; aucun Markdown.
- **Émojis** : rendus par la police du système ; **aucune image d'émoji téléchargée**. Sélecteur : liste générée une fois depuis `emoji-test.txt` d'Unicode (version d'émoji 15.0, licence Unicode v3, fichier source commité avec son empreinte), émojis pleinement qualifiés, 9 catégories Unicode, ton de peau appliqué par modificateur, « récents » en mémoire de la page seulement ; pas de recherche par mot en V1 (Q-SAL6). Réactions : un émoji de cette liste exactement, rien d'autre.
- **Pièces jointes** : tout type, nombre illimité, dans le budget ; sélecteur de fichiers, glisser-déposer et coller, photo et vidéo par `<input capture>` ; détection du type, nettoyage, avertissements et visionneuses du composeur et du contenu (tâches 9a–9c, 10, 21–23). Images et vocaux ≤ 16 Mio téléchargés et affichés d'office ; le reste au clic, avec « Enregistrer ».
- **Vocal** : enregistreur de la tâche 12 (explication avant la demande du micro, pause, nettoyage) ; 10 min au plus par message ; envoyé comme pièce `vocal` avec sa durée ; lu par `<audio controls>`.
- **Réponse et citation** : `reponse` porte l'`id` du message cité et un extrait de 140 graphèmes au plus ; si l'original est retiré, les extraits qui le citent sont vidés chez tous.
- **Retirer pour tous** (ses propres messages seulement, signé) : le message devient « Message retiré » chez tous, sa trame quitte la file du serveur, sa pièce jointe est effacée du disque. Texte : « Retiré pour tout le monde. Ceux qui l'ont déjà lu ont pu le copier. »
- **Effacer après lecture** (par message : texte, image, vocal) : chez le destinataire, « Message à lecture unique · Afficher » ; affiché 30 s avec un compte à rebours, puis retiré de la page et de la mémoire (URL blob révoquées) ; chez l'expéditeur, le contenu est remplacé par « Message à lecture unique envoyé » dès l'envoi. Mention : « Une capture reste possible. »
- **Arrivées et départs** : une ligne système dans le fil, « Léa a rejoint le salon » et « Léa a quitté le salon ». Elle est **construite dans chaque navigateur** à partir de l'annonce chiffrée (§39.2.2) et d'une trame de contrôle « départ » chiffrée et signée (ou, si la page a disparu sans l'envoyer, de l'enregistrement 0x03 du serveur, qui ne porte que le numéro de siège) : le pseudonyme ne passe jamais en clair, seuls les participants le voient. Liste des participants avec leur couleur, la sienne marquée « vous ».
- **En-tête** : « **3 en ligne · 2 places libres** » (places libres = `max_members` − sièges occupés ; salon ouvert : 10 − sièges occupés) et la validité restante en compte à rebours vivant, « s'efface dans 4 h 12 min » (`Countdown`, à la seconde sous 5 min, annonce discrète pour les lecteurs d'écran) ; jauge « 312 Mo sur 2 Go » (2 Go depuis le 13 novembre) dans le panneau des participants. « En ligne » = siège dont le flux est ouvert (enregistrement 0x07) ; un siège gardé pendant une coupure compte dans les places prises, pas dans « en ligne ».
- **Détruire le salon** (créateur, ou tous si permis) : `InlineConfirm` « Détruire pour tout le monde ? » ; tous voient l'écran de fin avec la dissolution.
- **Signaler** : feuille qui explique : (1) « Quitter et signaler » compte le signalement (entier horaire de §9.5) et fait sortir, par `POST /api/salons/signaler` (§39.3.9 : jeton de membre, corps `{}` ; le serveur fait partir le membre comme un `0x03` et compte le signalement après ce départ réussi, une fois par salon, sans rien garder qui l'identifie ; un jeton ne signale qu'une fois) ; la page oublie ensuite ses clés comme après un départ ; si la personne peut détruire, « Détruire et signaler » ; (2) pour un contenu illicite : écrire à l'adresse de contact avec le lien du salon ; « Si vous donnez aussi le mot de passe, l'équipe pourra lire ce qui y passe tant que le salon vit. » L'administrateur détruit par `admin destroy -`.
- **Exclusion** : bouton « Exclure » du créateur sur chaque autre participant, `InlineConfirm` « Exclure {pseudonyme} ? Elle ou il garde ce qui a déjà été vu et ne lira rien ensuite. L'invitation change : l'ancien lien et l'ancien mot de passe ne marchent plus. » ; puis « Nouvelle invitation » (§39.13) ; ligne « {pseudonyme} a été exclu du salon ».
- **Exclus en V1** : modification d'un message ; aperçus de liens ; accusés de lecture par défaut ; notifications (elles exigeraient un service tiers et un service worker) ; historique pour les nouveaux venus (Q-SAL2) ; co-administrateurs (Q-SAL11) ; titre du salon.
- **Onglet en arrière-plan** : le titre devient « (3) Shhdrop » (un nombre, aucun contenu) ; aucun son par défaut. Sur téléphone, quitter l'application coupe souvent le flux : au retour, reconnexion et notice de trou si besoin.

### 39.6 Écrans

- **Accueil** : un bloc à part, sous le réceptacle d'envoi, de style distinct (contour et icône `messages-square`, couleur ciel), titre « Discuter en privé », phrase « Un salon chiffré qui s'efface, jusqu'à 10 personnes. », bouton **« Créer un salon de discussion »**. Il remplace l'entrée « Conversation (bientôt) » du composeur (choix validé modifié, signalé : la demande veut le salon hors du parcours d'envoi).
- **Création** (`/salon/nouveau`) : durée (segments 1 h, 6 h, 12 h, 24 h ; 24 h par défaut), participants (« Ouvert (10 au plus) » ou 2 à 10, pas à pas), mot de passe (champ du composeur avec Générer et Copier), bascule « Les participants peuvent détruire le salon », bouton « Créer le salon ». Mobile : feuille d'options comme le composeur.
- **Salon prêt** : écran « Lien prêt » en variante salon : lien (Copier, Partager, QR), mot de passe (Copier) avec le rappel « par un autre moyen », lien de gestion montré d'emblée avec l'avertissement, pour être gardé à la main (rien n'est gardé sur l'appareil ni dans le compte, D42-27), bouton principal « Entrer dans le salon ».
- **Salon** (`/salon`, aucun secret dans l'adresse), style Nuit chiffrée :
  - ordinateur : colonne de messages centrée (720 px au plus), panneau des participants à droite au-delà de 1 100 px, sinon dans une feuille ;
  - téléphone : en-tête compact, liste plein écran, barre de saisie collée au-dessus du clavier (`visualViewport`, `dvh`, zones sûres), boutons de 44 px ;
  - bulles : les siennes à droite sur `--surface-2`, celles des autres à gauche sur `--surface-1` avec le pseudonyme et un filet de 3 px de leur couleur ; heure à la minute ; menu par message (Répondre, Réagir, Retirer, Enregistrer) ;
  - barre de saisie : zone de texte (Entrée envoie sur ordinateur, Maj+Entrée va à la ligne ; sur téléphone, bouton Envoyer), émojis, joindre, vocal, « Lecture unique ».
- **Accessibilité** : liste en `role="log"` (annonce polie des nouveaux messages : « Alice : … » ; regroupées au-delà de 3 en 2 s : « 5 nouveaux messages ») ; tout au clavier (flèches entre messages, `Échap` ferme le sélecteur et les menus, focus rendu au champ) ; mouvement réduit : aucune entrée animée, « Alice écrit… » en texte fixe ; `forced-colors` : filets de couleur remplacés par le pseudonyme souligné ; textes agrandis à 200 % sans débordement.

### 39.7 Cadre légal et abus (avis d'un juriste requis avant l'ouverture au public)

> le salon et le compte sont **ouverts au public dès le premier déploiement** (`SHH_SALONS: "1"`, `SHH_COMPTES: "1"`, `deploy/compose.yaml`), **sans** l'avis du juriste demandé ici et **sans** le passage manuel du compte sur appareils réels (conception du compte par passkey §14). Les points du tableau ci-dessous restent à soumettre au juriste.

| Gravité | Sujet | Problème | Proposition |
|---|---|---|---|
| Élevée | Statut | Un salon est un **service de communications interpersonnelles non fondé sur la numérotation** (code européen des communications électroniques, transposé dans le CPCE) : statut d'opérateur, éventuelles obligations de déclaration auprès de l'ARCEP, secret des correspondances (CPCE L32-3), réquisitions | **Juriste** avant `SHH_SALONS=1` en public |
| Élevée | Conservation des données de trafic (CPCE L34-1, décret 2021-1362, LCEN art. 6) | Les opérateurs et hébergeurs peuvent devoir conserver des données de connexion : **conflit direct** avec « aucune adresse IP enregistrée » (§17) | **Juriste** ; tant que ce n'est pas tranché, salon réservé à l'usage personnel de l'exploitant ; ouvert au public dès le premier déploiement, risque assumé (§37) |
| Élevée | DSA | Les pièces jointes stockées font de Shhdrop un **hébergeur** pour elles : point de contact (art. 11 et 12), notification et action (art. 16), motivation des décisions (art. 17) ; les échanges privés eux-mêmes sont hors des règles des plateformes | point de contact, formulaire de signalement, procédure de destruction écrite (§15.3), délais de traitement |
| Élevée | Contenus pédocriminels | Signalement aux autorités (PHAROS) quand l'équipe en a connaissance ; le projet de règlement européen « CSAM » pourrait imposer une détection incompatible avec le chiffrement de bout en bout | procédure écrite ; suivre le texte ; ne jamais promettre ce que la loi pourrait interdire |
| Moyenne | Cryptologie | La déclaration ANSSI (§17) doit couvrir la messagerie | à compléter |
| Moyenne | Mineurs, harcèlement | Un salon ouvert à quiconque a le lien et le mot de passe | « Signaler », destruction, durée de 24 h au plus, plafond de 10 ; CGU : usage interdit aux fins illicites |
| Faible | CGU et Confidentialité | Nouveaux traitements (sièges en mémoire, pièces jointes) | pages à compléter |

### 39.8 Tests

- **« Le serveur ne voit rien » étendu aux salons** (bloquant, comme §14) : trois clients ; repères dans le pseudonyme, le texte, un nom de fichier, le contenu d'un fichier, un vocal, un émoji de réaction, le mot de passe, `K_lien`, `K_trame`, `CK_0`, un `IK` secret ; IP, User-Agent et Referer repères (§36). Exige : aucun repère dans `shares.db`, son WAL, `blobs/`, stdout, stderr, ni dans une réponse ; chaque corps de `POST /api/salons/trame` fait exactement 4 140 octets ; aucun en-tête de requête ne porte un pseudonyme ; `salons` ne contient que les colonnes de §39.3.5 ; après destruction et arrêt, ni ligne ni pièce ; fouille de la mémoire du processus : aucun repère de contenu ni de clé.
- **Latence et transport** : banc `bench/salon-latency` (10 clients WebSocket, 1 message par seconde et par client, RTT simulé de 40 ms à 80 ms par `tc netem` ou proxy de test) : p95 de bout en bout < 300 ms, p95 côté serveur < 20 ms ; ping/pong : une connexion silencieuse est fermée en moins de 45 s, le client la détecte en moins de 25 s ; contre-pression : un client qui ne lit pas est fermé (raison 6) sans que la mémoire du serveur dépasse la file bornée ni que les autres ralentissent ; `Origin` étranger → 403 ; message d'accueil absent après 5 s → fermeture ; trame de taille ≠ 4 140 → fermeture ; aucune API WebRTC dans le build.
- **Exclusion** : §39.13.5.
- **Fuzz** : décodeur des trames, des enregistrements du flux et du JSON `M` en TypeScript (10 000 entrées mutées à graine fixe, aucune exception hors des erreurs typées, rien d'affiché) ; côté Go, `FuzzTrame` et `FuzzFlux` (`go test -fuzz`, corpus commité).
- **Vecteurs** : HKDF des étiquettes du salon, chaîne HMAC, XChaCha20-Poly1305 (vecteur de la note IETF draft-irtf-cfrg-xchacha, annexe A.3.1), Ed25519 (RFC 8032, test 1), recalculés par un script Node indépendant pour HKDF et HMAC (`node:crypto`).
- **Playwright à plusieurs clients** : trois contextes de navigateur (créateur, deux invités) sur un vrai serveur ; parcours de §39.4 ; plafond 2 → troisième « complet » ; textes, émojis, réponse, réaction, retrait, lecture unique, « écrit » visible sans réglage et trames `ecrit` alignées sur la grille de 2,5 s, lignes « a rejoint » et « a quitté », en-tête « en ligne · places libres », fichier de 5 Mio, vocal (faux micro), départ (le partant ne déchiffre plus : contrôle dans la page), coupure réseau de 30 s puis rattrapage, destruction → tous à l'écran de fin ; `axe` ; captures ordinateur et téléphone.

### 39.9 Lentilles « sharp edges » et « insecure defaults »

| # | Gravité | Endroit | Problème | Correction (intégrée) |
|---|---|---|---|---|
| CH1 | Élevée | distribution des clés | sceller à une `RK` non vérifiée laisserait un membre glisser une fausse clé au nom d'un autre | `RK` acceptée seulement dans une annonce signée par l'`IK` du membre, liée au `nonce_arrivée` de son siège |
| CH2 | Élevée | départ | un partant garde `CK_i` et dériverait les messages suivants | nouvelle époque de chaque expéditeur à chaque départ, avant tout nouveau message |
| CH3 | Élevée | trame de message | déchiffrer avant de vérifier la signature exposerait le décodeur à des trames forgées par un membre | signature vérifiée d'abord ; trame d'un `IK` non annoncé jetée |
| CH4 | Moyenne | indicateur « écrit » | toujours actif : il fuit l'activité au serveur | grille de 2,5 s, même trame que les messages, texte honnête ; trafic de couverture en option (Q-SAL9) |
| CH5 | Moyenne | pseudonymes | homoglyphes, inversion de sens | une seule écriture, nettoyage de §39.4, unicité NFKC |
| CH6 | Moyenne | réactions et textes | `{@html}` ou émoji arbitraire | nœuds texte ; réaction limitée à la liste |
| CH7 | Moyenne | jeton de membre | dans l'URL du flux | en-tête seulement (d'où `fetch` et non `EventSource`) |
| CH8 | Faible | file du serveur | mémoire ou disque sans borne | conversation chiffrée sur disque, comptée dans `SHH_STORAGE_MAX` ; index de 24 octets par trame en mémoire ; 1 200 messages par heure et par siège ; `SHH_SALONS_MAX` ; file d'envoi bornée par connexion (§39.3.1) |
| CH9 | Élevée | exclusion | l'exclu reviendrait avec le lien et le mot de passe | rotation de l'invitation à chaque exclusion (§39.13.2) |
| CH10 | Moyenne | WebSocket | détournement de connexion (pas de CORS) ; jeton dans l'URL | contrôle d'`Origin`, jeton dans le premier message, `wss://` explicite en CSP (§39.3.1) |
| CH11 | Moyenne | rechargement du salon | `sessionStorage` lisible par un script injecté | D41-24 : plus rien dans le `sessionStorage` ; secret de reconnexion en mémoire de la page seulement ; D41-26 : preuve de membre en IndexedDB, chiffrée (Argon2id du mot de passe et `K_lien`, XChaCha20-Poly1305) ; copie du stockage → attaque hors ligne sur le mot de passe (§39.13.3) |

### 39.10 Limites assumées

Ajoutées à §18, points 20 (qui parle avec qui), 21 (membres) et 22 (coupures).

### 39.11 Offres payantes (§38.8)

Salons plus longs, plus grands et plus remplis pour Plus et Pro (§38.8) ; même chiffrement, même code. Recommandation maintenue : **pas de salon payant avant l'avis du juriste** (§39.7), un salon long attirant d'autres usages. Au-delà de 12 destinataires, la distribution des clés s'étale sur plusieurs trames (§39.2.2).

**Appels audio et vidéo : réservés à Plus et Pro.** Conception des appels §5.1 et conception du paiement §11. En bref : tant que les appels d'un salon sont fermés, `POST /api/salons/appel` demande un jeton anonyme (Privacy Pass, `Authorization: PrivateToken`) d'une offre qui comprend `appel_audio` ; le jeton est dépensé et ouvre les appels **du salon** pour tous ses membres jusqu'à sa fin (heure de fin en mémoire seulement, ni siège, ni offre, ni jeton) ; sans jeton, 402 `offre_requise`. Qui lance doit avoir l'offre ; qui rejoint n'a besoin de rien. Paiement fermé (`SHH_PAIEMENT=0`) : ni route ni boutons (`calls: false`), donc **aucun appel possible tant que le paiement n'est pas ouvert**.

### 39.12 Questions ouvertes (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-SAL1 | Un fichier unique de 1 Go dans un salon (budget porté à 1 074 069 568 + trames) | Non : 1 Go au total, 500 Mo par fichier |
| Q-SAL2 | Historique visible des nouveaux venus | Non (confidentialité persistante, plus simple) |
| Q-SAL3 | Mots de passe faux avant destruction | 10 (jusqu'à 10 personnes peuvent se tromper) ; risque : qui a le lien seul peut détruire le salon en 10 essais |
| Q-SAL4 | Destruction par tout participant | Désactivée par défaut, au choix du créateur |
| Q-SAL5 | Exclure un participant | **Réglée (D41-1)** : oui, par le créateur, avec rotation de l'invitation (§39.13) |
| Q-SAL6 | Recherche d'émoji par mot | Non en V1 (données CLDR lourdes, chargement hors SRI à éviter) |
| Q-SAL7 | MLS au lieu des clés d'expéditeur | Non en V1 ; exception aux règles du projet nécessaire |
| Q-SAL8 | Salon public tant que le juriste n'a pas répondu | Non : `SHH_SALONS=1` pour l'usage personnel seulement |
| Q-SAL9 | « En train d'écrire » toujours actif (décision) : ajouter un trafic de couverture qui efface la fuite, ou retarder les messages au top de 2,5 s | Non aux deux (coût en budget et en réactivité) ; fuite dite ; à revoir si la confidentialité doit primer sur le coût |
| Q-SAL10 | Pièces jointes en direct dans le salon (§40.6) | **Supprimée (D41-3)** : jamais de pair à pair ; les pièces sont toujours stockées chez nous, chiffrées |

### 39.13 Exclure un participant et rotation de l'invitation

Le créateur peut exclure un participant (D41-1). Les co-administrateurs sont reportés (Q-SAL11, défaut non) : seul le créateur détient `S_gestion`, que le serveur sait vérifier ; déléguer exigerait un second justificatif de gestion.

#### 39.13.1 Ce que fait une exclusion

1. **Le serveur révoque le jeton de membre** de la personne exclue (son empreinte est retirée de la table des membres et gardée dans une liste de jetons révoqués, en mémoire, jusqu'à la fin du salon) ; son WebSocket est fermé avec `0x05` raison 5 ; son siège est libéré.
2. **Remplacé (MLS, spec salon v3 §3 ; précisé le 13 novembre, spec salon v3 §15, C-F2)** : un membre retire la feuille MLS de la personne exclue (Commit), ce qui change toutes les clés. **Avant tout nouveau message** reste vrai et c'est le moteur qui l'impose : dès le `0x09`, il refuse d'envoyer tant que cette feuille est dans l'arbre (`retrait_en_attente`), et refuse tout Commit ou message de la personne exclue.
3. **Une ligne système** « X a été exclu du salon » apparaît chez tous (créateur compris). **Signalement (faible)** : la demande disait « ligne chiffrée postée dans le salon » ; elle est **construite dans chaque navigateur** à partir de l'enregistrement `0x09` du serveur (comme « a rejoint » / « a quitté », §39.5) : le pseudonyme ne passe jamais en clair, aucune trame de plus n'est nécessaire, et aucun membre ne peut forger de fausse ligne d'exclusion, puisque seul le créateur authentifié (`S_gestion`) fait émettre `0x09`.
4. **Honnêteté, dite à l'écran** : « La personne exclue garde tout ce qu'elle a déjà vu ou copié. Elle ne lira rien de ce qui sera envoyé ensuite. » (confirmation chez le créateur et message chez la personne exclue : « Vous avez été exclu de ce salon. Ce que vous avez déjà vu reste sur votre écran. »).

#### 39.13.1b Perte immédiate de l'accès à l'historique

Dès l'exclusion, la personne perd **tout accès à la conversation, messages et fichiers**, et ne voit plus rien :
1. **Serveur** : le WebSocket est fermé tout de suite (`0x05` raison 5, code `4002`) et **tous ses jetons sont révoqués**. Dès lors, toute requête de ce jeton est refusée (403 `excluded`) : WebSocket, `POST /api/salons/pieces` (envoi), `GET /api/salons/pieces/segments/{n}` (téléchargement d'un segment de pièce), retrait, quitter. Aucun message n'est plus relayé vers elle, y compris le rattrapage de la file.
2. **Navigateur de la personne exclue** : à la réception de `0x05` raison 5, **ou** à la fermeture `4002`, **ou** à toute réponse `excluded` (par exemple en tentant de reconnecter avec son jeton), la page **efface tout immédiatement** : liste de messages et vues vidées, clés mises à zéro (`sodium.memzero` : `IK`, `RK`, chaînes, `K_maître_s`, `K_trame`), `R` des pièces oubliées, **URL blob des fichiers déchiffrés révoquées** et lecteurs audio/vidéo arrêtés, brouillons effacés, **entrée `sessionStorage` du salon supprimée** (jeton, clé courante, pseudonyme), minuteries arrêtées. Elle affiche alors « Vous avez été exclu de ce salon. » (+ « Ce que vous avez déjà vu reste sur votre écran. » seulement si des copies hors page existent : texte de §39.13.4), remplace l'entrée d'historique (`history.replaceState` vers `/`) et, à un retour par « Précédent » ou au `pageshow` avec `persisted`, **recharge** la page (§21) : rien du salon ne réapparaît (`Cache-Control: no-store`, `sessionStorage` vide).
3. **Pièces jointes, sans rechiffrer** : les fichiers restent sur le serveur, chiffrés sous leur graine `R` propre (§39.2.5), que la personne exclue connaît peut-être déjà. **Rechiffrer de gros fichiers à chaque exclusion coûterait trop** (relecture, rechiffrement et réécriture de jusqu'à 1 Gio, chez un membre qui devrait rester en ligne) : **non retenu**. La règle qui tient sans rechiffrer : **(a)** la révocation du jeton (point 1) : sans jeton de membre valide, le serveur ne sert aucun segment de pièce, quelle que soit la connaissance de l'identifiant de la pièce ou de `R` ; **(b)** la **rotation de l'invitation** (§39.13.2) : l'exclu ne peut pas obtenir un nouveau jeton avec l'ancien lien et l'ancien mot de passe ; **(c)** un **plancher de pièces** : le serveur garde en mémoire, pour chaque jeton, son plancher (rang de l'arrivée qui l'a donné, donc postérieur à toute exclusion qui l'a précédé) et, pour chaque pièce, son **rang de référence** : **le rang de la trame liée** si elle est liée, sinon son rang de création (décision du 12 novembre, §9.5) ; un jeton émis **après** une exclusion ne reçoit **aucune pièce dont le rang de référence est antérieur à son plancher** (404 uniforme). Une pièce envoyée avant son arrivée mais liée à une trame reçue après reste lisible : il lit cette trame, donc la graine de la pièce. Ainsi, même si une invitation transmise à l'exclu le fait rentrer sous un autre pseudonyme, il n'ouvre pas les anciennes pièces dont il connaît l'identifiant et la graine ; les membres déjà présents (jetons plus anciens) gardent les leurs, et une personne invitée après l'exclusion ne voit de toute façon pas les messages d'avant (Q-SAL2), donc n'a pas besoin des anciennes pièces. Après un redémarrage du serveur, les jetons et le plancher sont perdus ensemble, et l'ancienne invitation reste morte (rotation en base).
4. **Limite honnête, écrite sans détour** : **l'application ne peut pas effacer ce que l'appareil de la personne exclue a déjà téléchargé, enregistré, copié ou capturé**, et ne promet aucune suppression à distance de copies. Avec un **client modifié**, la personne garde aussi tout ce qu'elle avait déjà déchiffré en mémoire avant l'exclusion (le nettoyage de l'étape 2 est celui du code officiel : un autre code peut l'ignorer). Ce que la règle garantit, c'est ce qui vient **après** : plus aucun message, plus aucun fichier, plus aucune clé nouvelle.

#### 39.13.2 Pourquoi il faut aussi changer l'invitation : l'exclu ne doit pas pouvoir revenir

Avec le lien et le mot de passe seuls, une personne exclue est **indiscernable d'une nouvelle personne** : une place libre et la bonne preuve suffisent pour entrer. Aucune adresse IP ni empreinte d'appareil n'est utilisée (§36, §2) : la seule protection est de **changer ce qui donne le droit d'entrer**. Chaque exclusion fait donc **tourner le secret d'entrée du salon** :

1. Le navigateur du créateur tire une **nouvelle invitation** : `K_lien'` (32 octets aléatoires) et un nouveau mot de passe `P'` (même générateur que §31), un `sel'`, puis `K_mdp'` (Argon2id), `K_maître_s'` = HKDF(`K_lien'` ‖ `K_mdp'`, « shhdrop/v2/salon/maitre »), et dérive `K_accès_s'`, `K_preuve_s'`, `V_preuve_s'`, `K_salon'`, `K_trame'`, `tag_salon'` (§39.2.1). Rien de l'ancienne invitation n'entre dans les nouvelles clés : qui connaît l'ancien lien, l'ancien mot de passe et l'ancienne `K_trame` n'en déduit rien.
2.
   **La nouvelle clé part après le retrait** (spec salon v3 §15, C-H1 et C-F3) : un message envoyé **avant** le retrait serait lisible par la personne exclue, encore dans le groupe. Une fois le `0x09` reçu et le Commit qui retire la personne exclue fusionné, le créateur envoie dans le groupe MLS un message de la sorte `rotation` (numéro `r`, `K_maître_s'` seule : ni `K_lien'`, ni `K_mdp'`, ni le mot de passe). Le moteur ne l'accepte que du créateur, chiffré à l'époque courante, sans siège exclu dans l'arbre.
3. `POST /api/salons/exclure` (`X-Shh-Manage` ; `X-Shh-Access-New` = `K_accès_s'`) avec `{ seat, nonce_arrivee, r, proof_v, salt, kdf_ops, kdf_mem }` (`seat` absent = changement d'invitation seul). Le serveur, **en une seule opération** : vérifie `S_gestion` ; vérifie que le siège porte bien ce `nonce_arrivée` (sinon 409 `stale` : le siège a changé de titulaire) ; révoque le jeton et ferme sa connexion ; remplace `access_v`, `proof_v`, `salt`, `kdf_*` dans `salons` ; remet `failed_attempts` à 0 ; émet l'enregistrement `0x09` (`siège` (1, 0xFF s'il n'y a pas d'exclu) ‖ `nonce_arrivée` (16) ‖ `r` (4)) au rang `seq` = R.
4.
   **Avec MLS** (spec salon v3 §15) : à `0x09`, chaque membre restant marque le siège exclu ; un membre retire sa feuille MLS ; le créateur envoie alors le message `rotation`. À sa réception, chaque membre dérive `K_salon'`, `K_trame'` et `tag_salon'` de `K_maître_s'` (`clesDepuisMaitre`), réécrit sa preuve de membre, et **refonde le groupe MLS sous les nouvelles clés** (`Salon.refonder` : même identité, mêmes codes de vérification), parce que l'identifiant du groupe porte `tag_salon` : sans cela, plus personne ne pourrait entrer avec la nouvelle invitation. **Les trames de rang supérieur à celui du message `rotation` sont sous `K_trame'`** ; il n'y a plus de fenêtre de 10 s : une trame en route sous l'ancienne clé est refusée et son auteur la renvoie. Entre le `0x09` et la rotation, les trames restent sous l'ancienne `K_trame` : la personne exclue n'en lit pas le contenu (retrait MLS), seulement l'enveloppe si elle les obtient encore (§39.13.4). Pas de « demande de clé » : un membre absent rattrape le message `rotation` à sa reconnexion ; celui qui a rechargé sa page pendant la rotation doit recevoir la nouvelle invitation (manque signalé, spec salon v3 §15, C-F3). Détail de l'ordre : spec salon v3 §3.6.1, exigence 24.
5. **Ancien lien et ancien mot de passe : morts pour tout le monde.** Le serveur ne retrouve plus le salon par l'ancienne `K_accès_s` (réponse `not_found`, identique à un salon inexistant) ; même si un client connaissait la nouvelle `K_accès_s'` sans le nouveau mot de passe, la preuve `K_preuve_s'` échouerait (et compterait dans les 10 essais, Q-SAL3).
6. Le créateur voit « **Nouvelle invitation** » : nouveau lien (`#c…`, Copier, Partager, QR) et nouveau mot de passe (Copier), avec « L'ancien lien et l'ancien mot de passe ne fonctionnent plus pour personne. Les personnes déjà dans le salon ne sont pas touchées. » Le bouton permanent « **Nouveau lien d'invitation** » (panneau des participants) fait la même rotation **sans exclure personne** (utile si le lien a fuité). Aucun membre restant n'a besoin du nouveau lien.

Échecs : si la requête `exclure` échoue, ou si la page du créateur disparaît avant elle, **rien n'a changé** et la personne reste dans le salon ; le créateur est invité à réessayer. *(13 novembre : il n'y a plus de rotation « en attente » chez les membres, la clé ne part qu'après le retrait. Si la page du créateur disparaît **après** `exclure` et avant le message `rotation` : la personne est exclue et retirée du groupe MLS par n'importe quel membre, les membres gardent les anciennes clés d'enveloppe, et plus personne ne peut entrer jusqu'à ce que le créateur refasse « Nouveau lien d'invitation » ; spec salon v3 §15, C-F3.)*

#### 39.13.3 Retour d'une personne par la preuve de membre (D41-26)

**Remplacé par D41-26, qui remplace le « code de retour personnel » proposé dans D41-24** : l'appareil garde une **preuve de membre chiffrée sous le mot de passe du salon** ; sans le mot de passe, elle est inutilisable.

- **Coupure réseau, onglet ouvert** : inchangé (D41-24) — reconnexion seule, sans mot de passe, avec ce que la page garde **en mémoire** (jeton de membre, siège, `K_maître_s` courante, pseudonyme, indice de couleur).
- **Preuve de membre** : c'est le **jeton de membre** déjà tiré par le serveur (§39.3.3, 32 octets aléatoires, gardé côté serveur par SHA-256 seulement) : aucun secret de plus, aucune route de plus. Le paquet chiffré contient : jeton de membre, siège, `nonce_arrivée` courant, pseudonyme, indice de couleur, `K_maître_s` **courante** et ce que le message d'accueil du WebSocket demande pour retrouver le salon (§39.3.1). Jamais les messages, les chaînes, ni les clés d'identité `IK` (une nouvelle `IK` est tirée au retour, comme avant).
- **Chiffrement** (libsodium seulement, aucune construction maison) : `sel_m` = 16 octets aléatoires tirés sur l'appareil ; `K_m` = HKDF(Argon2id(mot de passe NFC tapé à l'entrée, `sel_m`, 64 Mio, 3 passes, 1 fil, 32 octets) ‖ `K_lien` du lien ouvert à l'entrée, « shhdrop/v2/salon/membre-local ») ; paquet = XChaCha20-Poly1305 (`crypto_aead_xchacha20poly1305_ietf`, nonce aléatoire de 24 octets, données authentifiées « shhdrop/v2/salon/membre » ‖ `index`). **Proposition (signalée)** : le `K_lien` entre dans `K_m` en plus du mot de passe demandé ; il ne coûte rien (la personne rouvre de toute façon le lien pour revenir) et rend une copie volée du stockage inattaquable sans le lien (256 bits). Mêmes bornes minimales qu'en §7.1 : la page refuse des paramètres plus faibles.
- **Où** : IndexedDB, base `shhdrop-salon`, une entrée par salon, clé `index` = HKDF(`K_lien`, « shhdrop/v2/salon/membre-index »), 16 octets (le stockage ne montre ni le salon ni son lien) ; valeur `{ sel_m, nonce, paquet, purge_apres }`. `purge_apres` (en clair : fin du salon arrondie à l'heure supérieure) permet d'effacer au démarrage, sans mot de passe, les entrées de salons finis. Module unique (`web/src/salon/member-proof.ts`), seul autorisé à toucher cette base ; nouvelle exception écrite à « rien dans le stockage du navigateur » (§10).
- **Écrit** une fois le pseudonyme accepté (étape 4 de §39.4) ; **réécrit** à chaque rotation `0x09` (nouvelle `K_maître_s`), avec `K_m` gardée en mémoire de la page pendant la session (aucune nouvelle saisie). Après une rotation, la clé `index` et `K_m` restent celles de l'**invitation d'origine** : la personne revient avec le lien et le mot de passe qu'elle a reçus, même s'ils ne permettent plus à personne d'entrer.
- **Retour** (rechargement, onglet fermé, application quittée) : la personne rouvre le lien et tape le mot de passe ; la page cherche `index`, refait `K_m` (un Argon2id) et ouvre le paquet. Réussi → message d'accueil du WebSocket avec le jeton (`0x0A`, nouveau `nonce_arrivée`), même siège, même pseudonyme, même couleur, nouvelle `IK`, nouvelle époque ; elle ne relit rien de ce qui a précédé (Q-SAL2) ; les autres voient « X est de retour ». Aucune requête `rejoindre`, donc aucun essai de mot de passe compté par le serveur. Paquet illisible (mauvais mot de passe) → la page passe par `rejoindre` comme une nouvelle personne (le serveur compte l'essai, §39.3.3) : si le mot de passe est juste mais le paquet illisible (paquet abîmé), c'est une nouvelle place et le paquet est effacé.
- **Effacé** à « Quitter », à l'exclusion (`4002` ou `0x05` raison 5), à la fin du salon (`0x05` raisons 1 et 2, `not_found` à la reconnexion, ou `purge_apres` dépassé au démarrage), et quand le serveur refuse le jeton (place déjà libérée). Effacement au mieux : l'entrée IndexedDB est supprimée ; le navigateur peut garder des restes sur le disque (même limite que §27).
- **Sans preuve sur l'appareil** (autre appareil ou navigateur, navigation privée, stockage effacé, nouvelle invitation reçue après une rotation) : la personne entre comme **nouveau participant** (nouveau siège, pseudonyme à choisir : l'ancien reste pris tant que l'ancienne place existe). **Siège réservé pour la vie du salon (revue finale C-2, règle « instantané », v3 §5)** : une place n'est jamais libérée pour une absence, quelle qu'en soit la durée ; seuls « Quitter » (`0x03`, « Quitter et signaler »), l'exclusion par le créateur (qui libère aussi un siège fantôme) ou la fin du salon la libèrent. Une personne qui revient avec sa preuve retrouve sa place tant que le salon vit ; une place libérée par un départ ou une fin donne `4004`, une exclusion `4002`. Les retours par jeton ne comptent pas dans le plafond `arrivées totales < 5 × max_members` ; les places réservées comptent dans `max_members`.
- Le jeton de membre révoqué d'une personne exclue donne `4002` à la reconnexion ; la page efface sa mémoire **et son paquet**, et affiche l'écran « exclu ».
- **Risque résiduel (signalé, gravité moyenne)** : quelqu'un qui copie le stockage de l'appareil (appareil volé ou déverrouillé, sauvegarde, logiciel malveillant) peut essayer des mots de passe **hors ligne** contre le paquet, sans limite d'essais du serveur : avec le mot de passe généré (2^63,26 possibilités, §31, mise à jour UI5) et un Argon2id de 64 Mio par essai, environ **2^63 × Argon2id** en moyenne (de l'ordre de 1,5 × 10⁸ années-GPU, §31). Avec la proposition ci-dessus, il lui faut **aussi le lien** (souvent dans la messagerie du même appareil : la protection supplémentaire est réelle mais limitée). En cas de réussite, et tant que la place existe : il prend la place, le pseudonyme et la couleur de la personne, et lit la suite du salon. Ce qu'il ne gagne pas : les messages passés (jamais gardés). Si le salon accepte un jour des mots de passe choisis, cette attaque devient réaliste : la preuve de membre ne doit alors être écrite qu'avec un mot de passe généré (à revoir à ce moment-là).

#### 39.13.4 Limites assumées (écrites sur la page Sécurité et dans la fenêtre de confirmation)

- **La personne exclue garde ce qu'elle a déjà vu**, copié ou capturé (messages, fichiers téléchargés) : l'exclusion ne reprend rien.
- **Si quelqu'un lui transmet la nouvelle invitation, elle peut entrer comme n'importe qui, sous un nouveau pseudonyme.** Shhdrop ne reconnaît pas les personnes : **seul le créateur contrôle les invitations**, et chaque exclusion en change.
- Entre l'exclusion et la lecture de `0x09`, quelques trames déjà en route peuvent encore avoir été remises à la personne exclue avant la révocation (le serveur ordonne tout : rien de rang supérieur à R ne lui est remis). *(13 novembre : une fois le `0x09` lu, le moteur d'un membre n'envoie plus rien tant que la feuille de la personne exclue est dans le groupe ; spec salon v3 §15, C-F2.)*
- **Enveloppe des trames entre le retrait et la rotation, et après un simple départ (limite gardée)** : `K_trame` vient de l'invitation, pas de MLS. Une personne retirée du groupe sans rotation (départ volontaire `0x03`, ou les quelques instants entre l'exclusion et le message `rotation`) et qui obtiendrait encore les trames (copie de la file, serveur complice : le serveur ne lui remet plus rien) en lirait l'enveloppe : bit volatile, règle d'effacement, taille de la charge et cadence, **jamais le contenu**. La rotation y met fin. Aucune correction simple sans changer le format des trames (spec salon v3 §15, C-P1).
- **Remplacé le 14 novembre (« L'admin ne doit jamais perdre ses rôles admin même après un rechargement, ou quitter, ou fermer la page »)** : le créateur qui a quitté, rechargé ou fermé la page revient avec `S_gestion` (preuve de membre chiffrée, historique local, ou lien de gestion recollé) et retrouve tous ses droits, exclusion et nouvelle invitation comprises, dès qu'il est de nouveau dans le groupe chiffré (sa clé de rôle MLS est tirée de `S_gestion`). Tant qu'il est absent, personne n'exclut : le salon peut seulement être détruit. Conséquence signalée : le lien de gestion donne aussi les droits du créateur dans la conversation chiffrée (spec salon v3 §15.2, S2).

#### 39.13.5 Tests

- **Serveur (Go)** : exclusion sans `S_gestion` ou avec un jeton de membre → 403 ; `nonce_arrivee` d'un siège déjà réattribué → 409 `stale` ; jeton révoqué → fermeture `4002` et trames, pièces et reconnexion refusées ; ancien `K_accès_s` → `not_found` (réponse identique à un salon inconnu, comparaison octet par octet) ; ancienne preuve avec nouvelle `K_accès_s'` → 403 ; `access_v`, `proof_v`, `salt` remplacés dans une seule transaction (panne simulée au milieu : tout ou rien) ; `0x09` émis une fois, à un `seq` unique, à tous les sièges ; le siège de l'exclu est libre ; exclure son propre siège refusé ; `FuzzExclure`.
- **Perte d'accès** : après l'exclusion, `GET /api/salons/pieces/segments/{n}` avec le jeton révoqué → 403 `excluded` (pour toute pièce, y compris celles que l'exclu a vues) ; `POST /api/salons/pieces` et le WebSocket avec ce jeton → refusés ; un jeton émis après l'exclusion (invitation transmise) demande une pièce antérieure → 404 identique à une pièce inconnue, une pièce postérieure → servie ; un jeton plus ancien (membre resté) → servie ; le plancher disparaît avec la file à l'extinction du salon.
- *(La ligne « Cryptographie (TS) » ci-dessous décrit les clés d'expéditeur étudiées avant MLS. Ses intentions sont couvertes par les tests du moteur `engine/salon/tests/redteam.rs` : rien n'est chiffré pour l'exclu après le `0x09` ; l'exclu, avec l'ancienne `K_maître_s`, l'ancienne `K_trame` et tout son état, ne lit ni le message `rotation` ni aucune trame d'après ; rotation refusée hors de l'époque courante ; décodeur du message `rotation` éprouvé par `robustesse.rs` et les vecteurs. Restent à écrire avec le client C-5 : « rotation jetée si `exclure` échoue » n'a plus d'objet, « messages en vol renvoyés après rotation ».)*
- **Cryptographie (TS)** : après `0x09`, aucun expéditeur restant ne scelle de `CK_0` à la `RK` de l'exclu ; l'exclu, avec l'ancienne `K_maître_s`, l'ancienne `K_trame`, ses chaînes et toutes ses clés, **ne déchiffre aucune trame de rang > R** ; la trame `rotation` n'est pas ouvrable par l'exclu ; rotation en attente jetée si `exclure` échoue ; messages en vol renvoyés après rotation ; fuzz du décodeur de la trame `rotation`.
- **e2e (Playwright, trois contextes plus un quatrième)** : le créateur exclut Bob → Bob voit « Vous avez été exclu » et ne reçoit plus rien ; **Bob tente de revenir avec l'ancien lien et l'ancien mot de passe → refusé (« Ce lien n'existe pas ou n'est plus disponible »)** ; **Alice et le créateur continuent de discuter** sans resaisir quoi que ce soit (messages, « écrit… », une pièce jointe) ; Alice recharge sa page → elle rentre par son jeton de membre, sans lien ni mot de passe ; la ligne « Bob a été exclu du salon » est chez tous ; **le créateur envoie la nouvelle invitation à Carole (quatrième contexte) → elle entre** ; Bob avec la nouvelle invitation entrerait sous un autre pseudonyme (test de la limite : documentée, non « corrigée ») ; « Nouveau lien d'invitation » sans exclusion : l'ancien lien est refusé, personne n'est sorti ; « le serveur ne voit rien » : ni pseudonyme, ni `K_lien'`, ni `P'`, ni `K_maître_s'` dans une requête, ni sur disque.

- **Téléchargement en cours au moment de l'exclusion** : serveur — un flux de pièce en cours (gros fichier, débit limité par le test) est **coupé** à l'exclusion (connexion fermée avant la fin, octets reçus < taille), les requêtes suivantes → 403 `excluded`, registre `Streams` vide ensuite, aucun flux d'un autre membre touché ; client — fichier partiel supprimé (`abort()` appelé), `wipeRoom` exécuté une fois ; e2e — Bob télécharge une pièce de 200 Mio, le créateur l'exclut : le téléchargement s'arrête net chez Bob, Alice finit le sien, **Bob (même contexte, même adresse) rejoint un autre salon avec sa nouvelle invitation sans refus**, aucun compteur ne le distingue (aucun bannissement).

#### 39.13.6 Téléchargements de pièces en cours : annulation immédiate (D41-10)

Quand le serveur révoque le jeton de membre, il **annule en même temps tous les flux de segments de pièces en cours** servis à ce jeton (registre `Streams`, §41.8) : la connexion est fermée au milieu du segment, **sans période de grâce** (contrairement à l'expiration et à la suppression d'un partage, §41.8 cas 1 et 2). Le navigateur de la personne exclue supprime le fichier partiel (`writable.abort()`) et exécute `wipeRoom`. **L'exclusion vaut pour ce salon seulement** : aucun bannissement du service, aucune liste, aucune adresse ni empreinte gardées ; la personne peut rejoindre un autre salon, ou, avec la nouvelle invitation, le même salon sous un autre pseudonyme (limite de §39.13.4).

---

## 40. Envoi direct (pair à pair) — plus tard, optionnel

> **Étude, non applicable** : aucun pair à pair par défaut, nulle part (D41-3, §41.3) ; le salon passe toujours par notre serveur (§39.3.1). Cette section ne s'appliquerait qu'après une décision écrite de la rouvrir (tâches D-1 et D-2, `SHH_DIRECT=0` par défaut) ; §40.2 (salon), §40.6 et Q-SAL10 sont annulés.

Question étudiée : les fichiers pourraient-ils ne jamais passer par nos serveurs, le navigateur ou le téléphone de l'expéditeur les servant directement aux destinataires, comme un torrent ? Réponse : oui, en **option**, par WebRTC ; le mode par défaut reste le partage stocké et asynchrone.

### 40.1 Ce que l'envoi direct change, honnêtement

| Il apporte | Il coûte |
|---|---|
| Le fichier **n'est jamais écrit sur notre disque**, même chiffré : rien à voler, à réquisitionner ni à effacer après coup | **L'expéditeur doit rester en ligne, onglet ouvert**, pendant chaque ouverture ; sinon le destinataire attend |
| Aucune place réservée : un très gros fichier ne remplit pas le serveur | **Les adresses IP** : en connexion directe, chaque pair voit l'adresse de l'autre (candidats ICE) ; seul le **relais TURN forcé** les cache l'un à l'autre (et c'est alors notre relais qui voit les deux, comme le serveur aujourd'hui) |
| En connexion directe, aucun octet ne traverse nos machines | **Traversée des NAT** : sans relais, elle échoue sur une partie des réseaux (NAT symétriques, réseaux d'entreprise, certains réseaux mobiles) |
| Le relais ne stocke rien : il transmet des octets déjà chiffrés deux fois (paquet SHH2, puis DTLS) | **Téléphones** : un onglet mis en arrière-plan est suspendu (iOS en particulier) ; le transfert s'arrête. Verrou d'écran (`navigator.wakeLock`) demandé pendant l'envoi, et texte « Gardez cette page ouverte jusqu'à la fin » |
| | **Relais et bande passante** : avec TURN, tout passe deux fois par notre machine (entrée et sortie) ; on économise le disque, **pas** la bande passante (§40.5) |

### 40.2 Recommandation : mode hybride

- **Par défaut** : partage stocké, asynchrone, inchangé (§29).
- **Option « Envoi direct »** dans les options de l'envoi : conseillée pour les très gros fichiers ou quand rien ne doit être stocké, même chiffré. Mêmes règles : mot de passe, durée (la plage où l'expéditeur promet d'être en ligne, 1 à 24 h), ouvertures, droits, destruction.
- **Salon** (annulé, §41.3) : une pièce jointe part en direct si **tous** les destinataires présents sont en ligne et qu'ils sont **4 au plus** (au-delà, l'expéditeur enverrait N fois le fichier depuis son téléphone) ; sinon elle est stockée (§39.3.4). Q-SAL10.
- **Politique ICE** : `iceTransportPolicy: "relay"` **par défaut** (adresses cachées entre pairs). Option « Connexion directe (plus rapide) » : l'expéditeur l'autorise, et chaque destinataire l'accepte à son tour (« L'expéditeur verra votre adresse IP, et vous la sienne ») ; seulement si les deux côtés l'ont acceptée, `iceTransportPolicy: "all"`. Serveurs STUN et TURN : **les nôtres seulement** (aucun serveur STUN de Google ni d'un tiers, §10).

### 40.3 Clés et paquet (aucune construction nouvelle)

- Le fichier est le **même paquet SHH2** (§29.3) sous la même graine `R`, enveloppée par `E` comme un partage stocké ; le destinataire l'obtient par `unlock` (mot de passe, 5 essais, ouvertures comptées par le serveur). Le paquet circule par segments de 4 Mio sur un `RTCDataChannel` (ordonné, fiable), au-dessus de DTLS ; le lecteur du destinataire est celui des partages (`openStream`), dont la source de segments devient le canal.
- **Bourrage** : l'expéditeur envoie aussi les segments de bourrage, tirés par `crypto.getRandomValues` ; le relais ne voit que la taille du palier.
- **Signalisation chiffrée de bout en bout** : offres et réponses SDP et candidats ICE sont chiffrés en AES-256-GCM (WebCrypto) sous `K_sig` = HKDF(`K_maître`, « shhdrop/v2/direct/signal »), données authentifiées « SHD1 » ‖ `id` (§29.2) ‖ numéro d'ouverture ‖ sens ; chaque message bourré à **8 Kio** exactement. Comme `K_maître` exige le lien **et** le mot de passe, le serveur ne peut ni lire les SDP ni **remplacer l'empreinte DTLS** qu'ils portent : il ne peut pas s'interposer dans la connexion (attaque de l'homme du milieu fermée par la signalisation authentifiée).
- Le serveur ne reçoit jamais le paquet : pas de fichier dans `blobs/`, pas de réservation.

### 40.4 Serveur : signalisation et relais

- **Partage direct** : `POST /api/shares` avec `mode: "direct"` (aucune réservation, `bucket` gardé pour l'affichage du palier) ; `finalize` sans segment. Colonne `mode` dans `shares`. **Présence de l'expéditeur** : sa page ouvre `GET /api/direct/flux` avec `X-Shh-Manage` ; tant que ce flux n'est pas ouvert, `unlock` répond `sender_offline` **sans consommer d'ouverture** ni compter d'essai, et l'écran dit « L'expéditeur n'est pas connecté pour l'instant. Le lien reste valable jusqu'au {date} ; réessayez plus tard. »
- **Boîtes aux lettres en mémoire** : `POST /api/direct/signal` (8 220 octets exactement : nonce 12 ‖ 8 192 octets chiffrés ‖ étiquette 16, jeton de téléchargement côté destinataire ou `X-Shh-Manage` côté expéditeur) ; relais en mémoire seulement, 32 messages par ouverture, oubliés à la fin de l'ouverture ou après 10 min ; jamais sur disque.
- **Identifiants TURN** à durée courte : `POST /api/direct/turn` (jeton de téléchargement, `X-Shh-Manage` ou jeton de membre de salon) → `{ urls: ["turn:turn.shhdrop.app:3478?transport=udp", "turns:turn.shhdrop.app:5349?transport=tcp"], username, credential, ttl: 600 }` ; `username` = échéance ‖ 16 octets aléatoires, `credential` = HMAC-SHA-256(secret TURN partagé, `username`) ; le serveur TURN vérifie de son côté (mécanisme « identifiants longue durée » de TURN, RFC 8489 et RFC 8656, porté par la bibliothèque : il protège l'usage du relais, pas le contenu).
- **Serveur TURN** : `github.com/pion/turn/v4` (**licence MIT**), série v4, version exacte épinglée  (dernière stable publiée depuis au moins 7 jours, §24 ; à vérifier sur pkg.go.dev), dans un binaire séparé `shhdrop-turn`, **de préférence sur une machine séparée** (bande passante UDP, ports 3478 et 5349, plage de relais 49 152–65 535). Il ne journalise rien (journal vers `io.Discard`), ne garde aucune adresse sur disque, refuse les relais vers des adresses privées, de boucle locale ou de lien local (pas de rebond vers notre réseau interne). Le navigateur n'a pas besoin de bibliothèque : WebRTC est natif (`RTCPeerConnection`).
- **Limites** (§9.5, mémoire) : identifiants TURN 30 par heure par connexion ; octets relayés par jour par connexion : 5 Go (gratuit), 2 Go par transfert ; formules payantes : §38.8 ; 3 ouvertures servies à la fois par expéditeur ; une allocation TURN dure 10 min sans trafic au plus.
- `Permissions-Policy` inchangée ; la CSP ne régit pas WebRTC (`connect-src` ne s'y applique pas) : le test « aucune ressource tierce » vérifie que les seuls serveurs ICE configurés sont les nôtres.

### 40.5 Bande passante : relais contre stockage

| Mode | Entrée chez nous | Sortie de chez nous | Disque |
|---|---|---|---|
| Stocké (défaut) | 1 × le palier | 1 × le palier par ouverture (2 × au pire, §24) | le palier, pendant toute la durée |
| Direct par relais TURN | 1 × le palier par ouverture | 1 × le palier par ouverture | **rien** |
| Direct sans relais | rien | rien | **rien** |

Exemple : 1 Gio ouvert 3 fois. Stocké : environ 1 Go entrant, 3 Go sortants, 1 Go de disque pendant 24 h (0,033 To-mois, environ 0,10 à 0,25 €). Relais : 3 Go entrants, 3 Go sortants, aucun disque. Le relais **coûte autant de sortie, plus d'entrée** (souvent gratuite) et économise un disque peu cher : l'envoi direct sert la confidentialité, pas l'économie. Seule la connexion sans relais allège vraiment le serveur, au prix des adresses visibles.

### 40.6 Salon (annulé : les pièces du salon sont toujours stockées chez nous, §41.3)

- Signalisation par trames de contrôle du salon (type 2, sous `K_trame`, signées par `IK`, §39.2.3), sans route de plus ; identifiants TURN par le jeton de membre ; même politique ICE (relais par défaut ; « direct » seulement si tous les participants concernés l'acceptent dans leurs réglages).
- Le message `piece` porte alors `direct: true` et pas d'identifiant de pièce ; si un destinataire n'a pas reçu le fichier au bout de 30 s, l'expéditeur bascule sur l'envoi stocké pour lui (la pièce compte alors dans le budget).

### 40.7 Ce que voit le serveur (complète §36)

| # | Ce qu'il voit ou peut déduire | État |
|---|---|---|
| S44 | Qu'un partage est direct (`mode`), sans fichier ; que l'expéditeur est en ligne (flux ouvert) et quand | Assumé |
| S45 | Signalisation : nombre et heure des messages, 8 Kio chacun, contenu chiffré | Fait par conception |
| S46 | Relais TURN : les **deux adresses**, la durée, le volume relayé (au palier près grâce au bourrage) | Assumé (comme le serveur aujourd'hui) ; jamais sur disque |
| S47 | Connexion directe acceptée : rien du transfert ; les pairs voient leurs adresses | Choix des deux personnes |

### 40.8 Tests

- e2e Chromium à deux contextes, serveur TURN de test (pion, dans le banc) : relais forcé → la paire de candidats choisie est `relay` des deux côtés (`getStats`) ; aucun candidat `host` ni `srflx` dans les SDP avant chiffrement (crochet de test) ; « connexion directe » acceptée d'un seul côté → toujours `relay` ; fichier de 50 Mio reçu identique (SHA-256) ; `blobs/` vide du début à la fin ; expéditeur hors ligne → `sender_offline`, ouvertures inchangées ; onglet de l'expéditeur fermé pendant le transfert → erreur claire chez le destinataire, fichier partiel abandonné (`writable.abort()`, §7.3).
- « Le serveur ne voit rien » : repères de contenu, de nom, de mot de passe et de `K_lien`, plus une empreinte DTLS repère : absents des corps reçus par le serveur, de la mémoire exportée, du disque ; aucun SDP en clair.
- Go : `turn_test.go` (identifiants expirés refusés, relais vers `10.0.0.0/8`, `127.0.0.1`, `169.254.0.0/16`, `fc00::/7` refusé, aucune sortie de journal), `FuzzSignal`.

### 40.9 Questions ouvertes (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-D1 | Relais TURN forcé par défaut | Oui ; « connexion directe » sur accord des deux côtés |
| Q-D2 | Machine TURN séparée | Oui dès une machine plus grosse ; sur la petite, même machine, autre binaire |
| Q-D3 | Envoi direct en V1 publique | **Non** : plus tard, optionnel, après la V1 et sur décision écrite |

---

## 41. Registre des décisions D41 et leurs sections

Registre D41-1 à D41-38 (7 au 19 novembre 2026). Chaque ligne du journal renvoie à la section qui la spécifie ; §41.1 à §41.14 détaillent celles qui n'ont pas d'autre place.

### 41.0 Journal des décisions

| # | Date | Décision | Où |
|---|---|---|---|
| D41-1 | 7 nov. 2026 | **Exclure un participant d'un salon est permis** (inverse Q-SAL5). Le serveur révoque le jeton de membre ; chaque expéditeur restant ouvre une époque tout de suite ; une ligne système est affichée ; l'exclu garde ce qu'il a vu. **Complément du coordinateur** : l'exclusion fait tourner l'invitation (nouveau lien et mot de passe), pour que l'exclu ne puisse pas revenir ; les membres restants rechargent par leur jeton de membre | §39.13, §39.5, §41.4 |
| D41-2 | 7 nov. 2026 | **Le changement de clés ne limite pas la conversation** : époques toutes les 100 messages ou chaque heure ; phrase pour la page d'explication du salon | §39.2.4, §39.4 |
| D41-3 | 7 nov. 2026 | **Le trafic du salon passe toujours par notre serveur, en WebSocket** ; jamais de pair à pair ; objectifs de latence, ping/pong, contre-pression ; pièces jointes stockées chez nous ; **aucun pair à pair par défaut nulle part** ; §40 devient « plus tard, optionnel », tâches D-1 et D-2 « après la V1 » ; comportement de Q-SAL10 supprimé | §39.3.1, §40, §41.3 |
| D41-4 | 7 nov. 2026 | **Gratuit plus généreux** : 15 éléments et 2 Gio par partage ; quotas, paliers, stockage et textes mis à jour ; **Plus et Pro refaits** (Plus 10 Go / 50 éléments / 7 jours, 7 €/mois, 70 €/an ; Pro 50 Go / 200 éléments / 30 jours, 20 €/mois, 220 €/an ; **Pro corrigé par D41-11 : 7 jours ; éléments : D41-17**) ; analyse de marge tenue hors du dépôt. | §4, §38.8, §41.2 |
| D41-5 | 7 nov. 2026 | **Recharger la page, ou ouvrir le partage dans plusieurs onglets du même navigateur, ne compte qu'une ouverture** : octroi d'ouverture signé de 30 min (durée remplacée par D42-22 : jusqu'à l'échéance), clé du lien et octroi gardés dans le `sessionStorage` de l'onglet (exception écrite à « aucun stockage navigateur »), échange entre onglets par `BroadcastChannel` | §41.4 |
| D41-6 | 7 nov. 2026 | **Gestion de l'expéditeur sans empreinte** : historique local chiffré, « Vos partages actifs » à l'accueil, tableau de bord de cartes, synchronisation par le compte facultatif | §33.1 |
| D41-7 | 7 nov. 2026 | **Page de contenu du destinataire « 2027 »** : galerie, visionneuse plein écran, lecteurs vidéo et audio (forme d'onde), texte ; Télécharger, Tout télécharger, archive .zip (écrivain ZIP maison, sans stockage ni dépendance) ; rien de tout cela en « voir seulement » | §41.6, UI §9.8 |
| D41-8 | 7 nov. 2026 | **L'écran « partage détruit »** n'a plus de cadenas ouvert ni de boîte en pointillés : illustration géométrique d'un document qui se défait en points de la Trame, et le mouvement `erase()` du logo | UI §9.10, §20 |
| D41-9 | 7 nov. 2026 | **Départ du compte à rebours (Plus et Pro)** : au choix de l'expéditeur, à la création (seule option gratuite) ou à la première ouverture ; avec « première ouverture », **plafond absolu** : le partage est purgé 7 jours après sa création même s'il n'a jamais été ouvert. Serveur : drapeau `starts_on_first_open` ; `expires_at` fixé au premier déverrouillage réussi, jamais au-delà de création + 7 j. Ce que voit le serveur : S48, S49. Option d'interface dans le composeur payant | §38.9.1, §41.9, §36, UI §9.3.1, §9.7.2, tâche P4 |
| D41-10 | 7 nov. 2026 | **Expiration ou suppression pendant un téléchargement** : à l'expiration, plus aucune ouverture nouvelle, mais une ouverture commencée termine, avec une grâce de 2 h au plus bornée par l'échéance du téléchargement ; à la suppression par l'expéditeur (ou destruction), comme à l'expiration, le fichier en cours se termine en arrière-plan alors que l'interface du destinataire se ferme tout de suite (plus d'accès au lien, de visionneuse, de liste, de nouveau téléchargement, rien de visible) ; serveur : flux déjà accordés terminés, aucune nouvelle requête hors ouverture active, flux annulables liés à la révocation, signal « gone » ; **salon** : l'exclusion annule les téléchargements en cours tout de suite, hors de ce salon seulement, sans bannissement du service. **Contradictions de la demande signalées : F-3** | §41.8, §39.13.6, §7.5, §9.5, §36 S60–S61, UI §9.8.9, tâches M2 (3c, 7b), E1, C-6 |
| D41-11 | 7 nov. 2026 | **Formules payantes corrigées** : durée maximale du Pro **7 jours** (comme Plus) ; **Pro : éléments illimités dans 50 Gio au total** → manifeste découpé (index + segments de manifeste, même paquet SHH2, aucune cryptographie maison) ; l'interface dit « illimité (50 Go au total) » | §38.8, §38.9.2, §41.10, UI §9.14.1, tâches P2 (corrigée), P5 |
| D41-12 | 7 nov. 2026 | **Fonctions payantes conservées (pas d'« Équipe »)**, spécifiées en détail : demander des fichiers, prolonger, ajouter des fichiers, ouverture programmée, plusieurs destinataires à liens révocables un par un, notification d'ouverture, page de réception personnalisée (Pro), CLI/API (Pro), limite de téléchargement par fichier, filigrane « confidentiel » en lecture seule (dissuasion seulement), débit prioritaire. **Aucune fonction ne donne plus de sécurité ; aucune statistique sur les destinataires** | §38.9, §36 S48–S59, UI §9.14, tâches F0 à F11 (après la V1) |
| D41-13 | 7 nov. 2026 | **Extensions à risque** ajoutées : `.wsh`, `.msp`, `.xll`, `.ps1xml`, `.inf` (codées dans `web/src/transfer/safety.ts`) | §12 (`isRiskyFile`) |
| D41-15 | 7 nov. 2026 | **Mot de passe toujours généré** (10 caractères) : plus de saisie d'un mot de passe personnel, nulle part ; la liste noire et ses règles ne servent plus qu'au code du coffre (§27.2) et quittent le paquet livré | §31, §41.13, UI §9.3 |
| D41-16 | 7 nov. 2026 | **Offre visible, verrouillée, jamais vendue avant P1** : limites gratuites dites en clair dans le composeur ; choix payants affichés verrouillés (badge « Plus »), feuille d'information avec le prix prévu et « Bientôt disponible » ; une ligne discrète « Avec Plus… » au dépassement de la taille. Remplace §38.1 (« seulement sur `/offre` ») et UI §9.3.1 (« absente, pas grisée ») pour le composeur | §38.1, §41.13, UI §9.3.1 |
| D41-17 | 7 nov. 2026 | **Le nombre d'éléments n'est plus un critère de formule** (une archive .zip le contourne) : 200 éléments pour toutes les formules, borne technique d'un manifeste d'un morceau ; « illimité » et le manifeste découpé **abandonnés** ; les formules diffèrent par la taille, la durée et les fonctions | §4, §38.8.1, §38.9.0, §38.9.2, §41.13, tâche P5 |
| D41-18 | 7 nov. 2026 | **Écran « partage disparu » pendant un téléchargement** : il dit la cause connue de l'appareil (« a expiré », « a été supprimé », « a été détruit ») et **nomme le fichier en cours** (nom nettoyé), sa progression, puis « Terminé » ou « Téléchargement interrompu. » ; sans téléchargement en cours, la page de fin ordinaire. Remplace, pour ce point, la ligne « sans nom ni taille » de §41.8 | §41.8, §41.13, UI §9.8.9 |
| D41-14 | 7 nov. 2026 | (**Retiré le 24 novembre** avec le code mort du coffre, §27) **Liste noire de mots de passe (§31)** : SecLists 10k, NCSC top-20k et Richelieu 20k (CC BY 4.0), compressées, environ 14,8 Ko en gzip ; licences notées, **licence d'origine de la liste NCSC (probablement OGL v3) à confirmer** | §31 |
| D41-19 | 8 nov. 2026 | **Envoi dès l'ajout, retrait qui efface sur le serveur** : brouillon créé au premier fichier, chaque fichier chiffré sous **sa propre clé** et envoyé aussitôt, à partir d'une frontière de segment ; la croix efface ses segments sur le disque et rend la place ; options, manifeste, `R` et enveloppe fixés au clic. Remplace §29.4 points 1 à 3 | §41.14, §29.3, §29.4, §29.5, §36 S4, S5 |
| D41-20 | 8 nov. 2026 | **Emprise d'un petit élément en puissance de deux** (**remplacé par D41-38**) (ferme Q-H2-1, vie privée d'abord) : un élément de moins d'un segment occupe et envoie 1, 2, 4… 64 morceaux de 64 Kio ; le bourrage est fait de zéros chiffrés sous sa clé d'élément ; le serveur ne voit que la classe de taille ; coût inférieur à 2 fois, environ 1,4 fois en moyenne | §41.14 |
| D41-21 | 8 nov. 2026 | **Dernier segment d'un grand élément en puissance de deux** (**remplacé par D41-38**) (ferme Q-H2-2) : même emprise que D41-20 pour la fin d'un élément d'un segment ou plus ; zéros chiffrés sous sa clé d'élément ; coût inférieur à 2 Mio par grand élément | §41.14 |
| D41-22 | 8 nov. 2026 | **Nettoyage automatique, sans bouton** (§35.2) : chaque fichier est nettoyé dès son ajout, avant tout chiffrement ; marque « Nettoyé » sur sa ligne ; échec, protégé ou format non pris en charge (y compris « bientôt pris en charge » : PDF, bureautique, vidéo et audio d'ailleurs, tâches 9b et 9c) → « Non nettoyé : … » et (remplacé par D41-23) ; réglage « Nettoyer automatiquement les fichiers » (activé par défaut, en mémoire de l'onglet seulement) ; désactivé : marque « Original », rien n'est modifié ; orientation EXIF gardée (seule étiquette conservée) plutôt qu'une rotation, qui demanderait un réencodage | §35.2 |
| D41-23 | 8 nov. 2026 | **Nettoyage non bloquant** (remplace le choix obligatoire de D41-22) : un fichier non nettoyé part sans clic ; marque « Non nettoyé » bien visible et raison courte sur sa ligne ; résumé discret près d'Envoyer (« 2 fichiers ne sont pas nettoyés ») ; le verrou `clean-gate` ne refuse plus que ce qui n'est passé ni par le nettoyage ni par la décision « non nettoyable » | §35.2 |
| D41-24 | 8 nov. 2026 | **Salon : retour d'une personne** (§39.1, §39.13.3) : coupure réseau, onglet ouvert → reconnexion automatique sans mot de passe (secret de reconnexion **en mémoire de la page** seulement) ; rechargement, onglet fermé, application quittée → le mot de passe est redemandé ; place, pseudonyme et couleur restent réservés pendant la vie du salon ; « hors ligne » affiché aux autres pendant l'absence ; **aucun accès au salon gardé sur l'appareil** (le jeton de membre dans le `sessionStorage` est supprimé) | §39 |
| D41-25 | 8 nov. 2026 | **Cadenas d'état par élément, toujours vrai** : icône maison (aucune marque). Envoi : cadenas gris « En attente », « Chiffrement… », « Envoi N % », puis vert avec coche « Chiffré et envoyé » **seulement** quand le serveur a confirmé tous les segments de l'élément (phase `pret` du brouillon) ; erreur : rouge et message. Réception : vert « Déchiffré et vérifié » **seulement** après la lecture entière de l'élément (chaque morceau authentifié par AES-GCM, sous `K_contenu` engagé) ou, pour un texte, après le déchiffrement authentifié du manifeste ; rouge « Non vérifié » en échec ; aucun cadenas avant. Texte toujours à côté de la couleur ; une seule animation (l'anse se ferme, la coche se trace), absente avec `prefers-reduced-motion`. Un texte du composeur n'a pas de cadenas : il part dans le manifeste, au clic | UI §9.2, §9.8 |
| D41-26 | 8 nov. 2026 | **Salon : retour par une preuve de membre** (remplace le « code de retour personnel » proposé dans D41-24) : à l'entrée, l'appareil garde le jeton de membre, le siège, le pseudonyme, la couleur et la clé courante, **chiffrés** (XChaCha20-Poly1305, clé tirée d'Argon2id du mot de passe tapé, sel aléatoire, 64 Mio, 3 passes ; proposé : et du `K_lien`) en IndexedDB, une entrée par salon ; au retour (rechargement, onglet fermé, application quittée), le mot de passe retapé ouvre la preuve et rend la place ; effacée à la fin du salon, à l'exclusion et à « Quitter » ; sans preuve → nouveau participant, l'ancienne place gardée jusqu'à la fin du salon ou à son exclusion par le créateur (revue finale C-2 : siège réservé pour la vie du salon, règle « instantané »). Risque résiduel : attaque hors ligne sur le mot de passe à partir d'une copie du stockage (2^65 possibilités × Argon2id) | §39.1, §39.13.3 |
| D41-27 | 8 nov. 2026 | **Nettoyage sans altérer les fichiers** : PDF jamais ouvert (laissé intact, code de nettoyage PDF supprimé) ; bureautique : propriétés, miniatures et métadonnées des images intégrées seulement, commentaires et suivi des modifications intacts, sans remarque ; archives laissées intactes ; pastilles neutres « PDF laissé intact » / « Archive laissée intacte » | §35.2 |
| D41-28 | 9 nov. 2026 | **Remplacé par D42-22** : quand la personne qui détient la dernière ouverture permise (`opens_left` = 0) quitte la page (`pagehide`), le client envoie « je pars » (`POST /api/shares/leave`, jeton de téléchargement en `Authorization`, corps vide, `fetch` `keepalive`) ; le serveur arme un minuteur de **3 min** (en mémoire) et détruit le partage (destruction avec grâce, comme « Détruire ») s'il n'y a eu entre-temps ni retour de la page par l'octroi (meta ou unlock avec `X-Shh-Grant` : rechargement, autre onglet ; renouvellement d'octroi) ni lecture de segment (téléchargement en arrière-plan : attendre 3 min sans lecture). `visibilitychange` n'arme rien ; ouverture non dernière : aucun effet (204) ; onglet tué sans `pagehide` : purge existante (dernière ouverture + 6 h). Faux serveur de démo : même contrat. **Écart signalé (faible)** : la demande disait `navigator.sendBeacon`, dont le nom est sur la liste interdite de §35.1 (test bloquant) et qui ne pose pas d'en-tête `Authorization` ; `fetch` avec `keepalive` offre la même garantie de remise au déchargement. **Risque signalé (moyen, exploitation)** : les ouvertures précédentes encore affichées mais inactives (aucun segment depuis 120 s) perdent l'accès à la destruction, comme avec « Détruire » ; dans la démo, l'état est écrit en IndexedDB au mieux pendant le déchargement | §41.4, §41.8, §9.5 |
| D41-29 | 9 nov. 2026 | **« Lien prêt » : partager le lien et le mot de passe ensemble** (remplace « deux secrets, deux canaux » de UI §9.5) : bouton principal **« Partager »** qui ouvre une feuille (téléphone : feuille du bas ; ordinateur : panneau) à trois choix — « Envoyer vers une app » (`navigator.share({ text })`, masqué sans l'API), « Copier le lien et le mot de passe », « Afficher le QR code » — et bouton secondaire **« Copier le lien et le mot de passe »** à côté ; texte sur deux lignes « Lien : … » / « Mot de passe : … » ; les copies séparées dans les champs restent. **QR code** : `#<K_lien>.<base64url de l'UTF-8 du mot de passe>` (le « . » est hors de l'alphabet base64url), avertissement « À montrer seulement à la personne en face de vous. », aucun partage natif du QR. À l'ouverture, le client sépare le mot de passe du fragment, retire tout le fragment de l'adresse (`replaceState`), puis déverrouille **une fois** sans saisie, seulement si le mot de passe a la forme générée (un fragment fabriqué ne consomme aucun essai) ; mal formé ou faux : écran de saisie normal, champ vide. **Justification** : avec **une seule ouverture par défaut** (`OPENS_DEFAULT = 1`, vérifié), même envoyés au même endroit, personne d'autre ne pourra voir le contenu ensuite, et le destinataire légitime verrait qu'il a déjà été ouvert. **Risques résiduels signalés (moyen, confidentialité)** : (1) le lien et le mot de passe du QR finissent dans l'**historique global** du navigateur du destinataire (§5.3, M3 : le `replaceState` ne retire pas l'entrée déjà écrite par certains navigateurs ni l'URL lue par l'appareil photo) — atténué par l'ouverture unique et la suppression à la sortie (D41-28) ; (2) **un tiers qui lit le message avant le destinataire** (messagerie, notification, sauvegarde) peut ouvrir à sa place, avec le lien et le mot de passe d'un seul coup — détectable : le destinataire trouve le partage déjà ouvert ; (3) une prévisualisation de lien par une messagerie ne lit pas le fragment, mais l'aperçu du texte peut afficher le mot de passe à l'écran verrouillé | UI §9.5, §5.3, §41.4 |
| D41-30 | 9 nov. 2026 | **Retours UI5** : cadenas en pastille sur l'icône de chaque ligne, ouvert vert chez le destinataire après vérification, fermé gris avant (amende D41-25) ; pied de page complet et pages Sécurité, Confidentialité, Conditions, Mentions légales (squelettes « à compléter par l'exploitant », **à compléter avant la mise en ligne publique**), Signaler un abus, Offres ; bleu Plus/Pro #5596F8 ; taille « par partage » ; mot de passe à exactement 3 spéciaux (§31) | UI §22, §31 |
| D41-32 | 9 nov. 2026 | **Retours UI6 — prix et façons de payer** : prix mensuel en grand (Plus 7 €/mois, Pro 20 €/mois TTC), annuel payé en une fois dessous (Plus 70 €/an, Pro **200 €/an**, « 2 mois offerts ») ; au choix, paiement unique (30 jours ou 1 an, sans renouvellement) ou renouvellement automatique **facultatif**, résiliable à tout moment en un clic, sans frais ; « Aucun frais caché. » ; toujours « Bientôt disponible », aucun achat actif. Remplace Q-P4 et la ligne « pas de renouvellement automatique » de §38.1. Signalés : durée de garde du moyen de paiement chez le vendeur, validation juridique de la reconduction ; étude de prix et de marché avant l'ouverture des ventes (plan) | §38.1, §38.7, §38.8.2, §38.8.3, §38.8.4 |
| D41-33 | 9 nov. 2026 | **Retours UI6 — écrans** : menu « … » d'une ligne du composeur : Aperçu (photo, vidéo, son, vocal, note ; jamais PDF, SVG ni HTML, faute de visionneuse sûre), Renommer ou Modifier, Nettoyer (élément « Original ») ou Réessayer (échec du nettoyage ou de l'envoi) seulement quand c'est utile, Supprimer (remplace « Retirer » partout) ; plus de Monter ni Descendre ; toucher l'icône ouvre l'aperçu ; le vocal se renomme par le menu. Un nouveau nettoyage remplace le contenu de la ligne : le brouillon interrompt et efface l'envoi anticipé, puis renvoie la version nettoyée. Destinataire : pastille verte « Téléchargé » au coin haut-gauche de l'icône (cadenas au coin bas-droit) ; boutons de coin de 24 px (WCAG 2.5.8 ; 44 px impossible pour deux bulles sur une icône de 44 px). Phrase « Les noms de fichiers sont chiffrés aussi… » déplacée en bulle d'une icône à côté du titre des listes et dans la page Sécurité. Icônes de format en couleur, libellé toujours écrit (jetons `--fmt-*`). Page Sécurité sans jargon, détails techniques repliés. **Signalement (faible, ergonomie)** : sur téléphone, l'ordre des éléments ne peut plus être changé (ni poignée ni menu) ; correction possible : poignée à appui long si le besoin revient | UI §9.2.4, §9.8 |
| D41-34 | 9 nov. 2026 | **Retours UI7** : (1) **paiement** : mensuel par abonnement à renouvellement automatique seulement ; annuel au choix (paiement unique ou renouvellement) ; moyens affichés « Carte bancaire » et « Crypto-monnaies » (paiement unique à l'année), libellés sans logo ; toujours « Bientôt disponible », rien d'implémenté (amende D41-32 (2)). (2) **Nettoyage à l'écran** (amende D41-22, D41-23, D41-27, D41-31 pour la présentation seulement ; le nettoyage lui-même ne change pas) : un seul endroit d'état par fichier, la **bulle du cadenas** de l'icône, sur deux lignes : chiffrement (« Chiffré et envoyé », « Déchiffré et vérifié »…) puis nettoyage : « Nettoyé : position, appareil et dates retirés » (texte par format), « Fichier tel quel (non modifié) » (réglage désactivé, archive, format non concerné : vidéo et audio importés non pris en charge, SVG, format inconnu), « Nettoyage impossible : structure du fichier inattendue » (`echec`) ou « Nettoyage impossible : fichier signé ou protégé » (`protege`). Sur la ligne : petite étincelle à côté du type si nettoyé, rien si tel quel, petite pastille ambre seulement en cas d'échec ; plus de marques écrites « Original », « Nettoyé », « Non nettoyé », « Archive laissée intacte ». Résumé près d'Envoyer pour les échecs seulement : « N fichiers n'ont pas pu être nettoyés ». Le nom du bouton du cadenas porte les deux lignes. (3) **Signaler** : plus de bouton en haut de la page destinataire ; « Signaler » n'existe que dans le pied de page : sur un partage ouvert, il ouvre la confirmation de signalement de ce partage (même action), ailleurs il mène à « Signaler un abus » ; le pied s'affiche donc aussi sur téléphone sur un partage ouvert (sinon aucun moyen de signaler) ; même règle pour l'entrée de Réglages. (4) **Pied de page** : logo à gauche au bord intérieur de l'en-tête, phrase du produit, liens sans soulignement (trait au survol et au focus), lueur discrète et filet lumineux, mouvement réduit respecté. (5) **Icônes** : libellé de format dans la feuille, 4 caractères au plus, taille selon la longueur, resserré s'il dépasse ; onglets en SVG maison, Réglages = engrenage de l'en-tête. **Signalements** : (a) **moyenne, confidentialité** : une vidéo ou un son importé (non pris en charge) part avec ses métadonnées éventuelles (lieu, appareil) sans marque visible sur la ligne : seule la bulle dit « Fichier tel quel » (D41-23 montrait « Non nettoyé ») ; correction possible : pastille neutre pour `non_pris_en_charge`, ou phrase « bientôt pris en charge » dans la bulle. (b) **Faible, exactitude** : le destinataire ne sait pas si l'expéditeur a nettoyé (rien dans le manifeste) : sa bulle n'a qu'une ligne. (c) **Faible, cohérence** : le reste des pictogrammes (boutons, pages) vient de Lucide (SVG libre, embarqué, ISC), pas d'icônes maison ; favicon et icônes d'application restent en PNG/ICO, exigés par iOS et Android | §38.8.2, §35.2, UI §9, §22 |
| D41-35 | 9 nov. 2026 | **Retours UI8** : (1) **Nettoyage dit au destinataire** (corrige le signalement (b) de D41-34) : champ facultatif `clean` par fichier dans le manifeste CHIFFRÉ (`image`, `video`, `audio`, `pdf`, `bureautique`, `vocal` si nettoyé ; `echec`, `protege` ; `tel_quel`) ; absent (ancien partage, texte) ou valeur inconnue → rien n'est dit, jamais une erreur ; le serveur n'en voit rien (morceau du manifeste de taille fixe) ; le composeur le compte dans la taille majorée du manifeste. Chez le destinataire : 2ᵉ ligne de la bulle du cadenas (« Nettoyé avant l'envoi : … », « Fichier tel quel », « Non nettoyé : … »). (2) **Marque de nettoyage** (amende D41-34 (2)) : l'étincelle est remplacée par un petit **bouclier** maison (15 px) après « Type · taille » (et la durée d'un vocal), avec sa propre bulle : coché, couleur d'accent si nettoyé ; ambre avec « ! » si échec ; rien si tel quel ; même rendu chez le destinataire. (3) **Pastilles** cadenas et « Téléchargé » : elles rentrent dans le coin de l'icône de format, détachées par une découpe de 2 px de la couleur du fond. (4) **Pied de page** (amende D41-34 (4)) : aucun soulignement, jamais ; survol et focus par la couleur, anneau de focus au clavier. (5) **Icônes** (corrige le signalement (c) de D41-34) : jeu maison (`web/src/ui/icons/`), `@lucide/svelte` retiré. (6) **Comment ça marche** : fond sobre (encre unie, filet de lumière en haut), ni biais ni réglure. **Signalements** : (a) **faible, accessibilité** : en couleurs forcées, les liens du pied ne sont plus soulignés non plus ; ils restent identifiables par leur place (liste de navigation) et l'anneau de focus ; correction possible si un audit l'exige : soulignement en couleurs forcées seulement. (b) **Faible, confiance** : le champ `clean` est déclaratif (un expéditeur modifié peut mentir) ; la bulle le dit comme fait de l'expéditeur (« avant l'envoi »), sans garantie | §35.2, UI §6, §9 |
| D41-36 | 9 nov. 2026 | **Retours OPT** : « Jusqu'à 50 » ouvertures en **Pro** (Pro 100 → 50, Plus garde 1 à 10) ; texte blanc dans les choix verrouillés ; pastilles « 10 Go · Plus » et « 50 Go · Pro » à côté de la jauge du composeur, ligne « Avec Plus » du dépassement retirée du composeur (détail et signalements sous §38.8) | §38.8, UI §9.3 |
| D41-37 | 9 nov. 2026 | **Retours DROP** : (1) **notes = éléments chiffrés** (amende §7.3, §29.3, §29.4, D41-25) : le texte d'une note est la donnée d'un élément sous sa clé `K_élément` (§41.14), envoyé dès la validation de la note (fermeture de l'éditeur) ; cadenas gris puis vert « Chiffré et envoyé » comme un fichier ; modifiée → l'ancienne version est retirée (recouverte d'aléa à `finalize`, ou effacée si elle occupe un segment), la nouvelle renvoyée sous une clé neuve ; entrée du manifeste sans `text` ; lecture des anciens partages (texte dans le manifeste) conservée. (2) `TEXT_MAX` 10 000 → **100 000** points de code ; compteur « n / 100 000 » dans l'éditeur. (3) La ligne d'une note ne montre que son **titre** et « Texte · taille », jamais le contenu (composeur et destinataire ; le contenu se lit avec « Voir »). (4) **Ordinateur** : la zone de dépôt est en **filigrane** dans l'espace vide sous la liste (texte entier, plus clair ; un clic ouvre le choix de fichiers ; dépôt partout sur la page) ; la barre du bas ne garde que « Créer sur place » ; téléphone inchangé. **Signalements** : (a) **faible, confidentialité** : le serveur voit désormais qu'une note existe et sa classe de taille (puissance de deux de morceaux), comme pour un fichier ; avant, une note était cachée dans le morceau fixe du manifeste. Correction possible : garder les notes courtes (≤ quelques Kio) dans le manifeste, au prix d'un cadenas gris pour elles. (b) **Faible, exploitation** : un partage de note seule passe du palier 1 (64 Kio) au palier 16 (1 Mio) : 16 fois plus de disque pour ce cas. (c) **Faible, exactitude** (corrigé par (5)) : sans élément, l'accueil s'affichait au lieu d'un composeur vide. (5) **Page d'envoi « /envoyer »** (base `/shhdrop/` en démo ; route connue du serveur, 200) : le composeur, même vide ; liste vide : grand cadre « Déposez des fichiers… » au centre, texte blanc (ordinateur), « Ajouter » au centre (téléphone). Les « Commencer » de l'accueil (fenêtre de dépôt, appel final, et le grand bouton du téléphone, renommé « Commencer ») y mènent ; le glisser-déposer sur l'accueil ouvre toujours le composeur avec les fichiers ; retour : l'accueil | §29.3, §29.4, §41.14, UI §9 |
| D41-38 | 9 nov. 2026 | **Plus aucun arrondi des emprises** (« on ne va pas grossir tous les fichiers » ; remplace D41-20 et D41-21, rouvre Q-H2-1 et Q-H2-2 comme fuites acceptées) : chaque élément, fichier ou note, n'occupe et n'envoie que ses ⌈taille / 64 Kio⌉ morceaux (`footprintFor` = `chunksFor`) ; aucun bourrage envoyé par le client pendant l'envoi anticipé (une petite note envoie un morceau, plus jamais ~1 Mio). Le remplissage d'aléa fait par le serveur à `finalize` (palier du partage, sans coût d'envoi pour le client) est inchangé. **Fuite acceptée** : pendant l'envoi, le serveur voit la taille de chaque élément à 64 Kio près (longueur de ses requêtes) ; au repos, rien de plus qu'avant (palier final, aléa). Contenu, noms et clés : toujours invisibles (test « le serveur ne voit rien ») | §41.14 |

### 41.1 Contradictions et corrections relevées (vigilance)

| Gravité | Endroit | Problème | Correction (intégrée) |
|---|---|---|---|
| Élevée | D41-1 | Sans changement du droit d'entrée, une personne exclue qui a le lien et le mot de passe revient en une seconde (rien ne la distingue d'une nouvelle personne) ; sans IP ni empreinte, seule une rotation de l'invitation tient | §39.13.2 ; limite dite : une invitation transmise à l'exclu le laisse entrer sous un autre pseudonyme |
| Élevée | D41-5 | `pagehide` envoie `done()` (UI §12.2) : recharger terminerait l'ouverture, qui, pour un partage à 1 ouverture (`draining`), **effacerait le partage avant la saisie du mot de passe** | `pagehide` n'envoie plus `done` ; l'ouverture se termine par « Terminer »/destruction ou par l'expiration de l'octroi (30 min) ; coût dit : un partage dont toutes les ouvertures sont prises reste, chiffré, jusqu'à 30 min de plus (§41.4) |
| Élevée | D41-5 | Le budget de lecture de §24 (2 × le fichier) rendrait « dix rechargements » impossibles ; sans borne, un octroi serait aussi un moyen de relire sans fin | Budget par (id, ouverture) = (2 + r) × le fichier, r ≤ 10 rechargements par ouverture |
| Moyenne | D41-5 | La demande cite Trusted Types comme atténuation ; UI S8 constate qu'ils sont **absents** (incompatibles avec Svelte 5) | On ne s'appuie que sur la CSP stricte et les contrôles de sources ; Trusted Types non invoqués |
| Moyenne | D41-4 | 2 Gio en 3 h exige 1,6 Mbit/s en montée ; le jeton de 3 h et les paliers de plus de 2 Gio (50 Gio) sont impossibles | Jetons d'envoi et de téléchargement : 6 h jusqu'à 2 Gio, 24 h au-delà (§41.2) |
| Moyenne | D41-4 | Assemblage en `Blob` sans `showSaveFilePicker` (iPhone, Firefox) : 2 Gio dépasse souvent la mémoire | Limite §18.7 maintenue et affichée avant ; archive .zip limitée dans ce cas (§41.6) |
| Moyenne | D41-3 | Un WebSocket n'est pas soumis à CORS (détournement de connexion d'un visiteur) et Safari peut ne pas faire correspondre `'self'` à `wss:` dans `connect-src` | Contrôle d'`Origin` + jeton dans le premier message ; `wss://{hôte}` explicite dans la CSP (§39.3.1) |
| Moyenne | D41-3 | « En train d'écrire » compte dans le budget de 1 Gio du salon (le serveur ne distingue pas les types) | Dit dans la page d'explication ; Q-SAL12 |
| Faible | D41-1 | La ligne « exclu » ne peut pas être une trame postée par un membre (falsifiable) | Construite localement à partir de `0x09` du serveur (§39.13.1) |
| Faible | D41-6 | Le serveur peut relier en direct plusieurs partages d'une connexion si l'accueil les relit tous | Affichage local d'abord, relecture espacée et à la demande (§33.1) |

### 41.2 Gratuit : 15 éléments, 2 Gio (D41-4)

> **200 éléments (D41-17)** pour toutes les formules ; les 2 Gio du gratuit restent. « 15 éléments » ci-dessous est remplacé par 200.

« 2 Go » à l'écran désigne 2 Gio (2 147 483 648 octets), comme « 1 Go » désignait 1 Gio jusqu'ici. Les autres limites gratuites ne changent pas : durée 1, 6, 12, 24 h ; ouvertures 1 à 10 ; 5 essais ; création de 3 partages par jour par connexion et 10 par /48 ; salon (24 h, 10 personnes, 1 Go au total, 500 Mo par fichier). **Cohérence vérifiée** : la différence entre 2 Go par partage et 500 Mo par fichier de salon est voulue (budget d'un salon vivant en mémoire et sur disque, §39.1).

| Quantité | Avant | **Maintenant (gratuit)** |
|---|---|---|
| Éléments par partage | 10 | **15** |
| Taille utile par partage (`CONTENT_MAX`) | 1 073 741 824 | **2 147 483 648** |
| Plus grand palier gratuit | 16 385 morceaux (257 segments) | **32 769 morceaux** (513 segments, le dernier d'un morceau) ; fichier chiffré de 48 + 32 769 × 65 552 = **2 148 073 536** octets |
| Paliers gratuits (morceaux de 64 Kio) | 1, 16, 80, 160, 400, 800, 1 600, 4 000, 8 000, 16 385 | **1, 16, 80, 160, 400, 800, 1 600, 4 000, 8 000, 16 385, 32 769** |
| Paliers payants ajoutés (§38.8) | 2 et 5 Gio | 81 921 (5 Gio), 163 841 (10 Gio) ; 327 681 (20 Gio), 819 201 (50 Gio) |
| Octets utiles par jour et par connexion / par /48 | 3 Gio / 6 Gio | **6 Gio / 12 Gio** (trois partages pleins par connexion et par jour) |
| Octets abandonnés par jour (connexion / /48) | 6 Gio / 12 Gio | **12 Gio / 24 Gio** |
| Envois non finalisés à la fois | 2 par connexion, 6 par /48 | inchangé (réserve possible : 2 × 2 Gio) |
| Octets payants du jour (Plus ; Pro) | 20 / 40 Gio | Plus **40 Gio par connexion et 80 par /48** ; Pro **100 et 200** |
| `SHH_STORAGE_MAX` (gratuit, salons compris) | 100 Gio | **200 Gio** par défaut |
| `SHH_STORAGE_PLUS_MAX` (réserve payante, §38.6) | — | **300 Gio** par défaut |
| Jeton d'envoi, `upload_deadline`, jeton de téléchargement, `purge_at` | 3 h | **6 h** jusqu'à 2 Gio ; **24 h** au-delà (paliers payants) |
| Seuil « aucun segment » | `upload_deadline` − 2 h 55 | `upload_deadline` − 5 h 55 (toujours 5 à 20 min après la création) |
| Budget de lecture par ouverture | 2 × le fichier chiffré + 2 segments 0 | inchangé, plus 1 × par rechargement accepté (§41.4) |

- **Dimensionnement du disque** : le pire cas gratuit, 200 Gio, est atteint par 34 connexions qui réservent chacune leur plafond du jour (6 Gio) ; le plafond global refuse alors les envois (507) sans toucher à la réserve payante. 200 + 300 Gio tiennent sur la petite machine (2 × 1 To NVMe en miroir, 1 To utile) avec le système et les salons (200 salons × 1 Go au plus, comptés dans les 200 Gio gratuits). Disque exigé au démarrage : `SHH_STORAGE_MAX` + 1 Gio libres (201 Gio).
- **Bande passante** : un partage de 2 Gio ouvert 10 fois = 20 Gio sortants, jusqu'à 40 Gio avec le budget de lecture. À comparer au trafic inclus de l'hébergeur (§20).
- **Interface** : « 15 éléments · 2 Go » partout (UI §9.1 ligne de preuves, §9.2.5 jauge, §10 textes) ; les textes viennent des constantes (`ITEMS_MAX`, `CONTENT_MAX`), pas de chaînes écrites à la main.
- **Limites rappelées à l'écran** : l'assemblage en `Blob` de gros fichiers sur iPhone, Firefox et les navigateurs sans `showSaveFilePicker` reste limité par la mémoire (§18.7) ; l'écran prévient avant l'enregistrement d'un élément de plus de 200 Mio.
- Plan : tâche Q-1.

### 41.3 Aucun pair à pair par défaut (D41-3)

- **Salon** : tout passe par le WebSocket de notre serveur (§39.3.1). Les participants ne voient pas leurs adresses les uns des autres. Les pièces jointes, y compris les vocaux, sont envoyées chiffrées à notre serveur et téléchargées depuis lui, comme les partages (§39.3.4). **Q-SAL10 est supprimée** (§40.6 ne s'applique plus).
- **Partages** : ils étaient et restent stockés chez nous ; l'envoi direct (§40) n'est ni activé, ni proposé, ni installé : `SHH_DIRECT` n'existe pas dans la V1, aucun serveur TURN n'est déployé, aucune API WebRTC n'est appelée (test de recherche dans les sources et `check-dist.mjs` : `RTCPeerConnection`, `RTCDataChannel` absents du build).
- §40 est conservé comme **étude pour plus tard, optionnelle**, à ne rouvrir qu'après la V1 et sur décision écrite ; tâches D-1 et D-2 « après la V1 ».
- **Pourquoi** : plus simple, plus rapide (un saut), moins de bogues (aucune traversée de NAT ni de cas de pair hors ligne) et le stockage est bon marché ; la protection des adresses entre participants est obtenue sans WebRTC.

### 41.4 Recharger sans consommer une ouverture de plus (D41-5)

**Règle** (remplace « recharger la page consomme une ouverture ») : après un déverrouillage réussi, recharger la page (une ou dix fois) ou ouvrir le même partage dans plusieurs onglets du même navigateur **compte pour une seule ouverture**, tant que l'**octroi d'ouverture** est valable.

**Serveur.**
- `unlock` réussi rend, en plus du jeton de téléchargement et de l'enveloppe, un **octroi d'ouverture** : jeton signé HMAC-SHA-256 (secret du serveur, comme §7.7) lié au partage et au **numéro d'ouverture** n, valable **jusqu'à `expires_at`** (remplacé par D42-22). Contenu : `n` (4 octets) ‖ `exp` (4 octets, secondes) ‖ MAC (32 octets), 40 octets, 54 caractères base64url. Le partage n'est pas dans le jeton : le serveur le retrouve par `K_accès` (§29.8) et vérifie le MAC avec **son** identifiant interne.
- `unlock` avec l'en-tête `X-Shh-Grant` (octroi) **et** `K_preuve` correcte : le serveur rend un **nouveau jeton de téléchargement pour le même n**, l'enveloppe et un octroi renouvelé, **sans décrémenter** `opens_left` ni augmenter `opens_issued`. Même un partage en `draining` (plus d'ouverture disponible) rouvre l'ouverture n tant qu'elle n'est pas terminée.
- **Un mot de passe faux avec un octroi compte comme un essai** (même compteur de 5) : l'octroi ne contourne ni le mot de passe, ni la limite d'essais.
- **Sans ouverture restante** (partage `draining`, D42-22, revue du 12 novembre) : si l'octroi est refusé (`grant_invalid`, `reopen_limit`), déverrouiller ne servirait à rien ; l'écran passe à « Impossible de revenir sur ce partage », avec la cause (limite des 20 retours, ou accès plus reconnu) ; partage introuvable avec un octroi gardé : même écran.
- **Octroi invalide, expiré, de la mauvaise ouverture, ou ouverture n terminée** : réponse 409 `grant_invalid`, **sans consommer d'ouverture ni d'essai** ; le client efface son octroi et repasse à l'écran normal, avec la phrase de §9.7 (jamais de consommation silencieuse). Un redémarrage du serveur invalide les octrois (secret régénéré, §7.7) : recharger consommerait alors une nouvelle ouverture, ce qui est dit.
- **Fin d'ouverture** : `pagehide` **n'envoie plus `done`** (UI §12.2 amendé). L'ouverture n se termine par `done` explicite (« Terminer et effacer », destruction, signalement) (remplacé par D42-22 : plus de fin à l'expiration d'un octroi ; un partage `draining` reste jusqu'à `expires_at` ou sa destruction) (balayage en mémoire des échéances d'octroi ; après un redémarrage, `purge_at` reste le filet). **Coût dit honnêtement** : un partage dont toutes les ouvertures sont prises reste, chiffré, jusqu'à `expires_at` (24 h au plus en gratuit, D42-22), au lieu de partir à la fermeture de la page.
- **Retiré (D42-22)** : l'octroi vaut déjà jusqu'à l'échéance, un renouvellement n'apporterait rien.
- **Retiré (D42-22)** : plus de suppression à la sortie ; la route n'existe plus (404).
- **Au plus 20 retours** (D42-22 : rechargements, autres onglets, retours plus tard, sur toute la vie du lien) par ouverture (compteur en mémoire, par (id, n)) ; au 21ᵉ, 429 `reopen_limit` : une nouvelle ouverture sera nécessaire (dit à l'écran). **Budget de lecture** de §24 par (id, n) : 2 × le fichier chiffré + 2 segments 0 + min(r × F, max(3 × F, 256 Mio)) (revue D42-22) ; il ne se remet jamais à zéro avec le jeton.
- **Aucune adresse IP stockée, aucune empreinte, aucun cookie** : l'octroi n'identifie ni la personne ni l'appareil ; il prouve seulement « cette ouverture a été payée ». Le serveur voit un nouveau déverrouillage pour la même ouverture, ce qu'il voyait déjà comme requête.

**Client** (module unique `web/src/session/open-grant.ts`, seul autorisé à toucher `sessionStorage` ; le salon n'y touche plus, D41-24).
- Après un `openShare` réussi : `sessionStorage["shh.og"]` = `{ v: 1, link: K_lien (43 caractères), grant, last }`. **Jamais** le mot de passe, `R`, une clé de contenu ni le clair.
- **Exception écrite** à « aucun stockage navigateur » (plan, UI §12.1, spec §10), en plus du coffre (§27) et de l'historique (§33) ; `source-rules.test.ts` limite `sessionStorage` à ce module. Le stockage est **propre à l'onglet**. **Correction (constaté par `web/ui-e2e/persist.spec.ts`)** : Chromium écrit `sessionStorage` sur le disque du profil (`Default/Session Storage/*.log`, `K_lien` en clair) et le **rend à l'onglet restauré** (Ctrl+Maj+T, « Continuer là où vous en étiez », reprise après panne ; type de navigation `back_forward`) ; Firefox fait de même (`sessionstore.jsonlz4`, documenté, non mesuré ici). Parade : `last` est posé à chaque `pagehide` ; hors rechargement (`PerformanceNavigationTiming.type` ≠ `reload`), l'entrée n'est reprise que si la dernière sortie date de moins de **2 min** (`RESTORE_MS`), sinon elle est effacée (onglet restauré sans `#` : « lien incomplet », il faut rouvrir le lien du message ; avec `#` : une nouvelle ouverture est comptée). Reste vrai et dit sur l'accueil (« Pourquoi c'est sûr ») : la clé peut rester sur le disque pour la restauration des onglets ; le mot de passe reste nécessaire. Le retour arrière dans le même onglet après plus de 2 min compte aussi une nouvelle ouverture (sens sûr).
- **Rechargement** : l'adresse n'a plus de `#` (hygiène du lien, §5.3). Si `shh.og` existe, l'écran d'ouverture passe à l'état `reopen` : « Vous avez déjà déverrouillé ce partage. Entrez le mot de passe pour le rouvrir : cela ne compte pas une ouverture de plus. » ; le **mot de passe est ressaisi** (il n'est jamais gardé) ; `unlock` part avec l'octroi. Si un `#` est présent et différent du lien gardé, l'entrée est effacée (autre partage).
- **Effacement** de `shh.og` : (bouton retiré, retours UI4 du 8 novembre) ; destruction (par soi ou par `NotFoundError`) ; échéance du partage (minuterie locale) ; **30 min sans activité** (clic, touche, défilement, visibilité) ; `grant_invalid` ; limite de rechargements ; fermeture de l'onglet (par le navigateur, **sauf restauration** : voir ci-dessus, 2 min).
- **Plusieurs onglets** : le `sessionStorage` n'est pas partagé entre onglets. Comportement le plus simple qui tient : au chargement d'un lien (`#`) valide, le nouvel onglet envoie sur un `BroadcastChannel("shhdrop-og")` (même origine seulement) `{ t: "want", r: aléatoire (16 octets), tag: SHA-256(K_accès) tronqué à 16 octets }` et attend **400 ms** ; tout onglet qui détient **en mémoire** un octroi valable pour cette étiquette répond `{ t: "have", r, grant }`. Le nouvel onglet ressaisit le mot de passe et envoie `unlock` avec cet octroi : **même ouverture**, aucune de plus. Sans réponse (aucun autre onglet, onglet fermé, ou octroi expiré), il se comporte comme un premier déverrouillage et la phrase de §9.7 annonce qu'une ouverture sera comptée. L'octroi ne circule qu'en mémoire entre onglets ; chaque onglet écrit ensuite le sien dans son propre `sessionStorage`. Le lien (`K_lien`) n'est jamais échangé : le nouvel onglet l'a déjà, dans son `#`.
- **Risque dit honnêtement** (page Sécurité, §18 point 24) : `sessionStorage` est lisible par quiconque a accès à l'appareil **déverrouillé** et à l'onglet, et par un script injecté (XSS). Sont gardés : `K_lien` et un octroi, **pas** le mot de passe : sans lui, ni le contenu, ni une ouverture de plus ne sont obtenus. Protections : CSP stricte (aucun script en ligne, `script-src 'self'`) et contrôles de sources. **Trusted Types ne sont pas invoqués** : ils sont absents du site (UI S8). Variante rejetée (Q-OG1) : garder aussi `R` pour ne pas ressaisir le mot de passe, car un lecteur du stockage lirait alors le contenu.

**Tests** : serveur (octroi de l'ouverture n rouvre sans décrémenter, y compris en `draining` ; 11ᵉ rechargement refusé ; octroi d'un autre partage, d'une autre ouverture, expiré, falsifié → 409 sans consommation ; mot de passe faux avec octroi → essai compté ; budget (2 + r) ; `pagehide` sans `done`) ; client (module : écriture seulement après succès, jamais de mot de passe, effacement sur chaque cause, minuterie de 30 min) ; e2e : **recharger après le déverrouillage rouvre le partage sans consommer** (`shareStatus` en Node : ouvertures utilisées inchangées, 1 / 3 avant et après), dix rechargements d'affilée, deuxième onglet qui s'appuie sur le premier par `BroadcastChannel`, deuxième onglet sans premier onglet qui consomme et l'annonce, « Terminer » efface et un rechargement redemande le lien ; `sees-nothing` : aucun mot de passe dans le stockage.

**(remplacé par D42-22, 12 novembre : plus de suppression à la sortie ; texte de la dernière ouverture : « Vous êtes la dernière personne à pouvoir ouvrir ce partage : personne d'autre ne pourra l'ouvrir. Vous pouvez y revenir depuis ce navigateur jusqu'à son échéance, puis il sera effacé du serveur. Vous pouvez aussi le détruire maintenant. »)** : à la dernière ouverture permise, quitter la page (`pagehide`) envoie « je pars » ; le serveur supprime le partage 3 min plus tard, sauf si la page revient par l'octroi (rechargement : meta puis unlock avec l'octroi ; autre onglet ; renouvellement) ou si un segment est encore lu (attente de 3 min sans lecture). Message affiché à la dernière ouverture : « Vous êtes la dernière personne à ouvrir ce partage. Il sera supprimé quand vous quitterez cette page. Vous pouvez aussi le détruire maintenant. »

### 41.5 Gestion de l'expéditeur sans empreinte (D41-6)

Voir §33.1 (refus argumenté de l'empreinte, historique local chiffré, « Vos partages actifs » à l'accueil, synchronisation par le compte facultatif) et UI §9.6 (tableau de bord).

### 41.6 Page de contenu du destinataire (D41-7)

- **Interface** : UI §9.8.1 à §9.8.8 (galerie par élément, visionneuse plein écran avec clavier, zoom et balayage, lecteur vidéo, lecteur audio avec forme d'onde, visionneuse de texte, Télécharger, Tout télécharger, archive .zip, « voir seulement »).
- **Décision sur l'archive : écrivain ZIP minimal maison, en mode « stocké » (sans compression), plutôt que fflate.** `fflate` 0.8.3 (MIT, publié le 16 mai 2026, 797 Kio dépaqueté ; le code de création de ZIP seul pèse de l'ordre de quelques Kio après compression, à mesurer) ferait l'affaire, mais : (1) on ne compresserait rien (photos, vidéos, audio et PDF sont déjà compressés ; DEFLATE coûte du temps pour presque aucun gain) ; (2) c'est une dépendance de plus à tenir (§24, `supply-chain-risk-auditor`) pour environ 150 lignes ; (3) un écrivain maison en flux contrôle exactement les noms, les dates et les tailles. Le CRC-32 est un contrôle d'intégrité, pas de la cryptographie (règle « aucune crypto maison » respectée), testé sur le vecteur standard (`"123456789"` → `0xCBF43926`) et relu par `unzip -t`, 7-Zip et `python3 -m zipfile` dans les tests. **Aucun `import()` dynamique** (§28.3) : l'écrivain est importé statiquement. Reste ouverte la bascule vers fflate si l'on veut un jour compresser les textes (Q-ZIP1, défaut non).
- **Écrivain** (`web/src/zip/store-zip.ts`) : entrées « stockées » avec descripteur de données (CRC-32 et tailles écrits après les octets, ce qui permet d'écrire en flux sans tout garder) ; indicateur UTF-8 pour les noms ; **ZIP64** quand une entrée ou l'archive atteint 4 Gio − 1 (paliers Plus et Pro) ; date fixe 1980-01-01 00:00 (aucune métadonnée de date, §35.2) ; noms = `safeName(i)`, **sans séparateur de dossier** (pas de `/`, `\`, `..`, lettre de lecteur : aucune écriture hors du dossier d'extraction), doublons suffixés « (2) », noms réservés de Windows suffixés ; les notes (éléments texte) deviennent des `.txt` UTF-8. Les sorties : `showSaveFilePicker` (flux, Chrome/Edge ordinateur) ; sinon assemblage en `Blob` **limité à 512 Mio** (200 Mio sur iPhone/iPad ou si `deviceMemory` < 4), au-delà de quoi le bouton .zip est remplacé par « Tout télécharger » avec l'explication. Les éléments déjà chargés en mémoire pour l'aperçu sont **réutilisés** (pas de seconde lecture du serveur, budget de §24 préservé).
- **Rien de tout cela en « voir seulement »** : ni « Télécharger », ni « Tout télécharger », ni .zip, ni bouton dans la visionneuse (`allowedActions(rights, kind).save` faux ; les boutons ne sont pas dans le DOM, test).

### 41.7 Questions ouvertes ajoutées (défaut recommandé)

| # | Question | Défaut recommandé |
|---|---|---|
| Q-SAL11 | Co-administrateurs qui peuvent exclure | Non (seul le créateur, qui détient `S_gestion`) |
| Q-SAL12 | Exclure « écrit… » et les trames de contrôle du budget de 1 Go du salon | Impossible (types cachés) ; on dit que la capacité de 1 Go compte tout ; à revoir si le budget gêne |
| Q-WS1 | Repli par flux `fetch` si le WebSocket est bloqué | Non en V1 ; message clair |
| Q-OG1 | Garder aussi `R` pour ne pas ressaisir le mot de passe au rechargement | Non (un lecteur du stockage lirait le contenu) |
| Q-OG2 | Raccourcir les 30 min d'octroi pour que les partages à ouvertures épuisées partent plus vite | Non (30 min demandées) ; à revoir avec les retours |
| Q-ZIP1 | Compression DEFLATE (fflate) dans l'archive | Non (déjà compressé) |
| Q-L1 | Durées des jetons à 6 h et 24 h | Oui (§41.2) |
| Q-GONE1 | Une ligne « Un téléchargement se termine en arrière-plan » (sans nom ni taille) sur l'écran fermé du destinataire | Oui : sans elle, la personne quitte la page et coupe le téléchargement |
| Q-GONE2 | Signal « gone » par requête tenue de 25 s (`watch`) ou par sondage toutes les 30 s | Requête tenue (fermeture en moins d'une seconde) |
| Q-GONE3 | Signalement et destruction par l'administrateur : coupure immédiate sans grâce | Oui (contenu signalé) |
| Q-F1 à Q-F6 | Fonctions payantes (§38.9.14) | Voir §38.9.14 |

### 41.8 Disparition pendant un téléchargement : expiration, suppression, exclusion (D41-10)

**Vocabulaire.** *Ouverture active* : une ouverture `n` dont le jeton de téléchargement a été émis **avant** l'événement et qui a reçu un segment dans les **120 s** précédentes (état en mémoire : (id interne, n) → heure du dernier segment ; ajouté à §9.5). *Fin de grâce* = le plus petit de : événement + **2 h**, et l'expiration du jeton de téléchargement (6 h, ou 24 h au-delà de 2 Gio, §41.2) : la grâce est **bornée par l'échéance du téléchargement**. *Coupure* : le serveur ferme la connexion en cours de segment.

**Cas 1 — Expiration (`expires_at`).**
- **Plus aucune nouvelle ouverture** : `unlock`, octroi, `regrant`, pré-lecture et émission de jeton sont refusés (404 uniforme, 410 `gone` pour un porteur de jeton signé valide, voir « signal »). `meta` répond 404 comme aujourd'hui.
- **Une ouverture active termine ce qu'elle fait** : ses requêtes de segments suivantes sont servies jusqu'à la fin de grâce (budget de lecture de §24 inchangé). Un segment en cours d'envoi n'est jamais coupé à l'échéance. Après 120 s sans segment, le droit est perdu : **pas de reprise après une pause**. Le partage (fichier, ligne) est effacé dès qu'aucune ouverture n'est active, au plus tard à la fin de grâce ; un redémarrage du serveur efface tout partage expiré (§36 S12).
- **Navigateur** : à zéro du compte à rebours local (sans requête) ou sur signal `gone`, l'interface se **ferme tout de suite** : liste, galerie, visionneuse, lecteurs, aperçus retirés du DOM ; URL blob révoquées ; tranches et textes mis à zéro ; `sessionStorage["shh.og"]` effacé ; aucun accès au lien, aucun nouveau téléchargement, aucune relecture, plus d'appel `meta`/`regrant`/`watch`/pré-lecture. Reste **seulement** le tuyau d'écriture des téléchargements déjà en cours (flux vers le fichier, ou assemblage en mémoire pour le repli Blob) avec la clé de contenu non extractible, gardée jusqu'à la fin de **ce** téléchargement puis mise à zéro. L'écran affiche « Ce partage n'est plus disponible. » et, tant qu'un téléchargement se termine, une seule ligne **sans nom ni taille** : « Un téléchargement se termine en arrière-plan. Gardez cette page ouverte. » (Q-GONE1). Si le serveur refuse ou coupe (fin de grâce), le fichier partiel est supprimé (`writable.abort()`) et la ligne devient « Téléchargement interrompu. ».

**Cas 2 — Suppression par l'expéditeur (`manage/destroy`), destruction par le destinataire, 5 mots de passe faux.**
- **Immédiat** : la ligne est retirée ; plus aucune ouverture nouvelle, plus de `meta`, `unlock`, `regrant`, pré-lecture ni jeton (mêmes réponses que cas 1). Les liens révoqués un par un (§38.9.7) suivent la même règle pour **leurs** ouvertures.
- **Ouverture active** : le serveur garde le **descripteur du fichier ouvert** alors que le fichier n'a plus de nom (détaché du dossier : introuvable, non servi à une autre ouverture) et sert les segments suivants **de cette ouverture** jusqu'à la fin de grâce, puis ferme le descripteur (l'espace est alors libéré). La place réservée est décomptée à la fermeture.
- **Navigateur** : identique au cas 1 (fermeture immédiate), avec le même texte ; les téléchargements en cours se terminent en arrière-plan. Le destinataire ne voit jamais **qui** ni **pourquoi** (« n'est plus disponible » pour la suppression comme pour l'expiration).
- **Exceptions sans continuation (coupure immédiate de tous les flux)** : « Signaler » (`reason: "report"`), `shhdrop admin destroy` — un contenu signalé ne doit plus être servi une seconde (Q-GONE3 ; ces deux cas n'avaient pas été tranchés) — et l'exclusion d'un salon (cas 3). un signalement coupe aussi un partage qui a déjà disparu pour les nouvelles ouvertures (échu mais pas encore balayé, détruit au 5ᵉ essai faux, ou retiré avec des lectures en grâce sur un descripteur détaché) : si `K_preuve` est juste, ces lectures en grâce sont coupées tout de suite, sans grâce. Aucun essai n'est compté ; la réponse reste 404, comme pour tout partage disparu (aucun oracle d'existence). Avant, un tel signalement laissait finir les lectures en grâce. → remplacé, voir §7.6 (règle des voix) ; un signalement sur un partage fermé ne coupe plus rien.

**Cas 3 — Salon : exclusion d'un participant.**
- **Annulation immédiate** : à `exclure` (même transaction que la révocation du jeton, §39.13.2), le serveur **annule** tous les flux de segments de pièces servis à ce jeton de membre (annulation du contexte de chaque flux, connexion fermée en cours de segment). Aucune grâce : l'exclu ne finit rien (§39.13.1b). Ses requêtes suivantes → 403 `excluded` ; son navigateur fait `wipeRoom` (clés, blob, brouillons, fichier partiel supprimé).
- **Exclu de ce salon seulement, jamais banni du service** : aucune liste de bannissement, aucune adresse ni empreinte (§36) ; le jeton de membre révoqué ne vaut que dans ce salon ; les compteurs par connexion (entrées de l'heure, salons du jour) ne tiennent pas compte de l'exclusion. **Une nouvelle invitation à un autre salon fonctionne** (test). Une nouvelle invitation au même salon fonctionne aussi, sous un autre pseudonyme (limite déjà écrite, §39.13.4).

**Serveur (amendée) — flux annulables liés à la révocation des jetons.**
- Registre `Streams` (mémoire seulement, §9.5) : chaque service de segment s'enregistre avec une clé de révocation — (id interne, n) pour un partage, empreinte du jeton de membre pour un salon, (id, étiquette du lien) pour un lien révoqué — et un `context.CancelFunc`. `Revoke(clé, avecGrâce bool)` : sans grâce → annule tous les flux de la clé ; avec grâce → marque la clé « en grâce jusqu'à T » et laisse les flux et les requêtes suivantes de **ses ouvertures actives** passer, sans en accepter d'autres.
- Copie du fichier vers la réponse par `io.CopyN` sur un `io.Reader` qui contrôle le contexte ; contrôle de l'**échéance de grâce à chaque segment**, jamais au milieu d'un segment. Test avec `-race`.
- **Signal « gone »** : (1) réponse **410** `{"error":"gone"}` à toute requête qui porte un **jeton signé valide** (segment, `done`, `regrant`, `watch`) quand le partage a disparu ou que l'ouverture n'a plus de droit ; toutes les autres requêtes gardent les erreurs uniformes de §8 (un 410 exige un jeton que seul le serveur a pu signer : **aucun oracle d'existence**). (2) `GET /api/shares/watch` (jeton de téléchargement) : requête tenue **25 s au plus**, 204 si rien, 410 dès la disparition (moins d'une seconde) ; la page la rappelle en boucle tant qu'elle est visible et active ; 2 par connexion, 256 au total, hors des 60 requêtes par minute. (tâche M2 : une surveillance au jeton valide compte dans les 600 requêtes de segments par minute, pour qu'un partage disparu, qui répond 410 tout de suite, ne permette pas une boucle sans limite ; jeton de téléchargement non plafonné à `expires_at`, puisqu'il borne la grâce.) Variante WebSocket écartée (Q-GONE2, plus lourd). Coût dit : S60 (le serveur sait, à 25 s près, qu'une page est restée ouverte).
- **La surveillance réessaie** (`web/src/flows/watch.ts`, `web/src/transfer/api.ts`) : seule une réponse 404 (serveur sans la route) arrête la surveillance. Toute autre réponse ou erreur (429, 5xx, réseau coupé, passage du Wi-Fi à la 4G, redéploiement) est passagère : nouvel essai après 1 s, 2 s, 4 s… 30 s au plus, tant que la page est visible et active, attente remise à zéro au premier succès ; sans cela, une seule requête perdue laissait le contenu à l'écran après une suppression. Tests : `watch.test.ts` (« un échec passager n'arrête rien », « attente croissante »), `api.test.ts`. **À décider** : un bandeau discret après plusieurs échecs de suite (« La suppression à distance n'est plus garantie tant que la connexion n'est pas revenue »). Limite : un destinataire malveillant garde ce qu'il a déchiffré ; la surveillance protège de l'écran oublié, pas de lui.
- **Client** : `gone` → `closeToGone()` : arrête tout appel sauf la **suite des téléchargements déjà en cours** (qui demandent eux-mêmes leurs segments suivants) ; ne lance plus rien ; ferme l'interface comme décrit.

**Tests** : serveur (étapes 3c et 7b) et client, voir plan. Cas minimum : expiration pendant le segment 3 d'un téléchargement de 40 segments → fini ; 120 s de pause puis reprise après expiration → refusé ; ouverture non démarrée à l'échéance → refusée ; `destroy` pendant le téléchargement → fini, une autre ouverture → 404, descripteur fermé à la fin de grâce (aucun fichier détaché ouvert à la fin du test) ; `report` et `admin destroy` → flux coupés ; exclusion → flux de pièces coupés, jeton refusé, autre salon accepté.

### 41.9 Départ du compte à rebours à la première ouverture (D41-9)

Spécifié en §38.9.1 (Plus et Pro seulement ; plafond de 7 jours ; colonnes `starts_on_first_open` et `hard_expires_at` ; ce que voit le serveur : §36 S48 à S49). Interface : UI §9.3.1 et §9.7.2. Plan : tâche P4.

### 41.10 Formules payantes corrigées (D41-11)

- **Durée maximale du Pro : 7 jours, comme Plus** (au lieu de 30 jours, et de 14 jours au-delà de 20 Gio). Corrigé : §38.2, §38.7 (Q-P3), §38.8.1, §38.8.3, plan tâche P2. Le Pro se distingue désormais par la taille (50 Gio), l'absence de limite d'éléments, les ouvertures, la page personnalisée, le CLI/API et le débit prioritaire.
- **Éléments : Pro illimité dans 50 Gio au total** (Plus 50, gratuit 15) → manifeste découpé en index + segments de manifeste (§38.9.2). Interface : « illimité (50 Go au total) ».
- Une durée de 7 jours au lieu de 30 baisse le stockage moyen du Pro ; prix inchangés (Q-P8). Analyse de marge tenue hors du dépôt.

### 41.11 Fonctions payantes (D41-12) et extensions à risque (D41-13), liste noire (D41-14)

- **Fonctions payantes** : onze fonctions conservées, sans « Équipe » ; spécification détaillée en §38.9 ; tâches P4, P5, F0 à F11 « après la V1 ». Règles : aucune sécurité de plus, aucune statistique sur les destinataires (§38.9.0).
- **Extensions à risque** : `.wsh`, `.msp`, `.xll`, `.ps1xml`, `.inf` ajoutées à `isRiskyFile` (§12, liste mise à jour ; codées dans `web/src/transfer/safety.ts`).
- (**Retiré le 24 novembre**, code mort du coffre, §27) **Liste noire de mots de passe** (§31) : SecLists 10k, NCSC top-20k, Richelieu 20k, compressées, environ 14,8 Ko en gzip ; licences notées en §31 (licence d'origine de la liste NCSC : à confirmer).

### 41.12 Signalements F-1 à F-13 (vigilance)

| Id | Gravité | Endroit | Problème | Correction (intégrée ou proposée) |
|---|---|---|---|---|
| F-1 | Moyenne | §38.9.1, `hard_expires_at` | Pour un partage payant, la base contient la date de création + 7 j à 15 min près : la date de création, que S11 s'efforçait de ne pas garder, est de nouveau déductible au repos | Intégré (assumé, S48) ; correction proposée : retrancher 0 à 3 h au hasard (Q-F1, défaut non) |
| F-2 | Faible | §38.9.2 | « Illimité » est faux au sens strict : la liste tient en mémoire | Borne technique de 50 000 éléments, dite ; texte « illimité (50 Go au total) » comme demandé |
| F-3 | Élevée | D41-10, serveur | La demande dit à la fois « les flux déjà accordés peuvent finir, aucune nouvelle requête de segment n'est servie » et « le fichier en cours finit en arrière-plan » ; un fichier de plusieurs segments exige de nouvelles requêtes. De même « le client cesse de demander » contredit « finit en arrière-plan » | Lecture retenue : **les requêtes d'une ouverture active sont servies jusqu'à la fin de grâce** ; aucune autre. Lecture stricte (seul le flux HTTP en cours finit) : un gros fichier serait tronqué, rejetée. **À confirmer** |
| F-4 | Moyenne | §41.8 cas 2 | Après suppression, le chiffré reste lisible jusqu'à 2 h par le descripteur ouvert (jamais pour une ouverture nouvelle ; chiffré seulement) : ce n'est plus un effacement immédiat | Intégré (assumé, S61), dit sur la page Sécurité ; coupure immédiate pour signalement et administrateur (Q-GONE3) |
| F-5 | Moyenne | §41.8 `watch` | Une requête tenue 25 s dit au serveur qu'une page est restée ouverte, à la seconde près | Intégré (S60), seulement tant que la page est visible ; alternative : sonder toutes les 30 s (Q-GONE2) |
| F-6 | Moyenne | §38.9.5, §38.9.7 | `S_gestion` + lien permettraient de deviner le mot de passe hors ligne contre `E` sans les 5 essais | La route d'enveloppe exige `K_preuve` et partage le compteur d'essais de `unlock` |
| F-7 | Faible | §4, §38.8.1 | Le serveur ne voit pas le nombre d'éléments (S6) : « 15, 50 » ne sont pas appliqués par lui | Dit en §38.9.2 ; sans conséquence de sécurité ni de coût (la taille est bornée par le palier) |
| F-8 | Moyenne | §38.9.8 | Web Push impose un service worker (contraire à UI §14.1 par défaut), un contact sortant du serveur et un tiers qui apprend l'instant de la notification, avec une exception à la règle de cryptographie | Seuls les canaux sans push sont livrés tant que Q-F3 n'est pas tranchée |
| F-9 | Moyenne | §38.9.9 | Une page personnalisée peut servir à imiter un service connu (hameçonnage) | Bandeau fixe non masquable, logo seul, aucun texte ni champ modifiable, raster ré-encodé (§38.9.9) |
| F-10 | Faible | §38.9.6 | L'ouverture programmée est appliquée par le serveur, pas par un verrou cryptographique | Dit sur la page Sécurité ; aucun tiers d'horloge (règles du projet) |
| F-11 | Faible | §38.9.12 | Le filigrane peut faire croire à une protection | Texte d'honnêteté obligatoire, uniquement en « voir seulement » |
| F-12 | Moyenne | §38.8.1, Pro | Sans durée de 30 jours, la différence de prix Plus 7 € / Pro 20 € repose sur 50 Gio, l'absence de limite d'éléments, la page personnalisée, le CLI/API et le débit prioritaire | À valider (Q-P8) ; aucun changement de prix sans décision |
| F-13 | Faible | §31 | La licence CC BY 4.0 (Richelieu) exige l'attribution ; la licence d'origine de la liste NCSC n'est pas confirmée | **Sans objet depuis le 24 novembre** : listes et licences retirées avec le code du coffre (§27) ; à reprendre si le coffre est construit |

### 41.13 Mot de passe généré, offre visible, 200 éléments, écran « partage disparu » (D41-15 à D41-18)

- **Mot de passe (D41-15)** : toujours généré ; `createShare` refuse toute autre forme (`mot_de_passe_non_genere`). Le paquet livré perd la liste noire et ses règles (mesuré : voir le rapport de la tâche UP). `web/src/vault/` est supprimé : si le coffre est construit et garde un code choisi, ce code de garde sera à refaire (§27).
- **Offre visible (D41-16)** : « Gratuit : 2 Go · 24 h max » sous « Votre envoi » ; dans les options, 2, 3 et 7 jours, « Démarrer à la première ouverture » et « Jusqu'à 50 » ouvertures, verrouillés, badge « Plus » ; un appui ouvre une feuille : ce que Plus ajoute, **prix prévu** de §38.8.2, « Bientôt disponible. », « Compris ». Aucun achat, formulaire, urgence ni case précochée. Au-delà de 2 Go, sous l'erreur : « Avec Plus : jusqu'à 10 Go et 7 jours. » et « En savoir plus ». Le destinataire ne voit rien de tout cela.
- **200 éléments (D41-17)** : `MAX_ITEMS = 200` pour toutes les formules. Borne d'un manifeste d'un morceau (65 532 octets) : une entrée de fichier au nom ASCII de 120 caractères fait environ 220 octets (≈ 290 entrées) ; des noms non latins (4 octets par caractère) ou de longs textes remplissent le manifeste avant : le composeur mesure le manifeste (majoré) et bloque l'envoi avec une raison claire (« manifeste ») au lieu d'échouer au scellement. Au 201ᵉ élément : « … 200 au plus. Retirez-en, ou regroupez des fichiers dans une archive .zip. », sans ligne « Plus ».
- **Écran « partage disparu » (D41-18)** : voir UI §9.8.9 ; la cause dite est celle que connaît l'appareil : compte à rebours → « a expiré », 410 ou refus d'une lecture avant l'échéance → « a été supprimé », destruction faite ici → « a été détruit ».

| Id | Gravité | Endroit | Problème | Correction (intégrée ou proposée) |
|---|---|---|---|---|
| G-1 | Moyenne | D41-16 contre §38.1, UI §9.3.1 | La règle validée disait « l'offre seulement sur `/offre` » et « option indisponible absente, pas grisée avec une publicité » | Remplacée pour le composeur par D41-16 ; signalée ici, non corrigée en silence |
| G-2 | Moyenne | D41-16, légal (§38.5) | Un prix affiché pour un service pas encore vendu, avant l'avis du juriste et du comptable | Libellé « Prix prévu », TTC, « Bientôt disponible », rien à payer ; à faire valider avant P1 |
| G-3 | Faible | D41-18 contre §41.8 (Q-GONE1) | Le nom du fichier en cours s'affiche après la fermeture (§41.8 disait « sans nom ni taille ») ; « a été supprimé » dit une cause que le serveur ne distingue pas (410 identique pour expiration et suppression) | Nom nettoyé, sur l'écran du destinataire seulement, rien sur le réseau ; « supprimé » seulement si l'échéance locale n'est pas atteinte |
| G-4 | Moyenne | tâche E1 contre tâche M2 | Le serveur ne servait pas encore les segments d'une ouverture active après l'échéance ou la suppression (grâce), ni le 410 `gone`, ni `GET /api/shares/watch` | **Corrigé** par la tâche M2 (étapes 3c et 7b) : grâce, 410, surveillance ; `WATCH_READY = true` |
| G-5 | Faible | D41-17, existant | Avant D41-17, 15 textes longs pouvaient déjà déborder du manifeste et échouer au scellement | Corrigé par le blocage « manifeste » du composeur |

### 41.14 Envoi dès l'ajout et retrait effacé sur le serveur (D41-19)

Règle : l'envoi commence dès qu'un fichier est ajouté ; la croix supprime l'élément du serveur aussitôt et rend le quota. Remplace §29.4 points 1 à 3 (démarrage après 2 s de stabilité, redémarrage complet au retrait). Aucune construction nouvelle : HKDF-SHA-256 et AES-256-GCM de WebCrypto, découpage STREAM inchangé.

**Clés (complète §29.2).**

| Élément | Création | Où il vit |
|---|---|---|
| `K_lien`, `S_gestion` | au premier fichier ajouté (création du brouillon) | inchangé |
| `k_i` (graine de l'élément *i*) | 32 octets aléatoires, à chaque mise en file d'un fichier (et à chaque « Réessayer ») | navigateur ; dans le manifeste chiffré **seulement pour les éléments gardés** |
| `K_élément,i` | HKDF(`k_i`, « shhdrop/v2/element »), AES-256-GCM, non extractible ; données authentifiées des morceaux = « shhdrop/v2/element-ad » | navigateur |
| `R`, `sel`, `K_mdp`, `E` | **au clic sur « Envoyer »** (chaque nouvelle finalisation tire une `R` neuve) | inchangé |

- Le morceau *j* d'un fichier est chiffré sous `K_élément,i`, nonce = numéro de morceau, drapeau « dernier » à 0 (le dernier morceau du paquet est toujours le manifeste). `K_contenu` = HKDF(`R`) ne chiffre plus que le morceau du manifeste ; l'en-tête « SHH2 » (engagement de `R`) est écrit par le serveur à `finalize`.
- **Pourquoi une clé par élément** (vigilance, signalement H-1) : avec une seule `R`, un élément retiré resterait déchiffrable par quiconque obtient le lien, le mot de passe **et** une copie du chiffré (serveur malveillant, sauvegarde, disque saisi avant l'effacement) : §29.4 imposait pour cela un redémarrage complet. Avec `k_i` absente du manifeste, l'élément retiré est **effacé cryptographiquement**, même si le serveur ment sur l'effacement. C'est aussi ce qui permet de **réutiliser sa place** : un nonce ne se répète jamais sous une même clé (nouvelle `k_i` pour tout nouvel élément ou nouvel essai).
- **Nom du partage** : `sealFinal` reçoit en plus le nom choisi par l'expéditeur (facultatif), nettoyé et borné par le moteur (§29.3) ; il entre dans le manifeste au clic, comme les droits. La taille majorée du manifeste calculée par le composeur compte un nom de 80 points de code de 4 octets.
- Lecture : une entrée de fichier du manifeste porte `k` (43 caractères base64url) ; le lecteur déchiffre ses morceaux sous `K_élément`. Entrée sans `k` : ancien format (morceaux sous `K_contenu`), accepté en lecture seulement. Intégrité inchangée ou renforcée : chaque morceau est authentifié sous la clé de son élément et sa position (nonce) ; le manifeste, sous `K_contenu`, fixe la liste, l'ordre, les positions, les tailles et les clés ; un serveur qui échange des segments entre éléments ou entre partages échoue au déchiffrement.

**Corrigé** : un fichier occupe ⌈taille / 64 Kio⌉ **morceaux** (0 pour un fichier vide), sans arrondi (D41-38, qui remplace l'arrondi en puissance de deux de D41-20). Un fichier d'**au moins un segment** (4 Mio) commence sur une frontière de segment et a ses segments pour lui seul ; la fin de son dernier segment n'est pas envoyée. Un **petit** fichier (< 4 Mio) est **empaqueté** avec d'autres dans un segment partagé : premier ajustement au morceau près, sans déborder de son segment, hors segments des grands fichiers ; **son emprise est arrondie à une puissance de deux de morceaux** (1, 2, 4… 64, soit 64 Kio, 128 Kio, 256 Kio… 4 Mio ; D41-20, Q-H2-1), les morceaux en plus étant des zéros chiffrés sous sa clé `K_élément` (nonces suivants, comme la fin de son dernier morceau ; aucune construction nouvelle), indiscernables de l'aléa. Chaque requête d'envoi porte une plage de morceaux d'un segment (`PUT /api/shares/segments/{n}?from=c`, corps = morceaux chiffrés, plus les 48 octets d'en-tête nuls au morceau 0 ; sans `from` : segment entier) ; le serveur note en mémoire les morceaux reçus (un segment complet compte comme reçu) et refuse une plage hors du segment ou du palier. Le seul bourrage envoyé est celui de l'emprise d'un petit élément (moins de 2 fois sa taille, environ 1,4 fois en moyenne ; test : 20 fichiers de 1 Mo envoient au plus 1,5 fois leur somme, environ 21 Mo, et non 80 Mio). Le manifeste donne `offset` = n° de morceau × 64 Kio (le lecteur n'a pas changé : il lit par morceaux). Le palier final reste canonique : `bucketFor(max(offset + taille))` des éléments gardés ; le serveur remplit d'aléa à `finalize` tous les morceaux non reçus du palier final.

**Parcours.**
1. **Premier fichier ajouté** (page visible, en ligne) : défi anti-robot, preuve de travail en arrière-plan, puis `POST /api/shares` avec le plus petit palier qui contient les segments occupés suivis du morceau du manifeste. Un texte seul ne crée rien : il part au clic (il est dans le manifeste). **Remplacé par D41-37** : une note validée (éditeur fermé) est un élément et part comme un fichier ; modifiée, elle est renvoyée (l'ancienne version est traitée comme un élément retiré).
2. **Chaque fichier** passe par le point d'accroche `prepare(élément)` (**nettoyage des métadonnées, à brancher ici : avant l'attribution de la place et le chiffrement**, la taille nettoyée fixant la place), reçoit sa place, puis ses segments sont chiffrés et envoyés un à un (file unique, un segment en vol). Quand le segment suivant dépasse la réservation : `POST /api/shares/grow` (palier supérieur), **au fil de l'envoi** : le serveur refuse un palier qui dépasse de plus de 2 segments le dernier segment reçu. États d'une ligne : en attente, chiffrement, envoi N %, prêt, erreur (Réessayer).
3. **Croix sur un petit élément** : l'envoi est interrompu et attendu ; sa clé `k_i` est jetée (absente du manifeste, l'élément est indéchiffrable) ; **aucun effacement disque immédiat** ; ses morceaux, s'ils sont partis, ne sont jamais réutilisés et sont listés dans `finalize` (`void` : plages [début, fin) de morceaux, 512 au plus, fusionnées ; au-delà, ils restent chiffrés sous une clé oubliée) : le serveur les **remplace par de l'aléa**. La jauge rend la place tout de suite (au plus 4 Mio par élément, minime). **Croix sur un élément d'un segment ou plus (ou remplacement du contenu, par exemple « Nettoyer »)** : l'envoi de l'élément est interrompu et attendu, puis `POST /api/shares/erase` (jeton d'envoi, `{from, to}`) efface ses segments : **trou rendu au système de fichiers** (`fallocate` PUNCH_HOLE, ou écriture de zéros puis `fsync` si le système de fichiers ne le permet pas) et bits remis à zéro ; un effacement à la fois, réessayé (1, 2, 4… 30 s, `503 busy` compris) ; la place n'est rendue à l'écran (jauge, mention « Suppression sur le serveur… » en attendant) et réutilisée qu'**après la confirmation** du serveur ; un effacement qui échoue encore au clic fait échouer la finalisation. « Annuler » le retrait renvoie l'élément sous une nouvelle `k_i`.
4. **Au clic** : attente de la fin des envois (progression globale, titre « 42 % · Shhdrop »), puis `R`, `sel`, Argon2id, `E` ; manifeste des seuls éléments gardés, **dans l'ordre affiché** ; `POST /api/shares/finalize` avec en plus `bucket` (palier final ≤ réservation), `header` (48 octets) et `tail` (morceau chiffré du manifeste, 65 552 octets), sans `fill_*`. Le serveur remplit d'aléa **tous les segments manquants** du palier final (trous des éléments retirés et bourrage), écrit l'en-tête et le manifeste, ramène le fichier à la taille du palier, passe en `ready`. Le lien n'existe qu'après.
5. **Abandon** (onglet fermé, autre route, liste vidée) : destruction en `keepalive` par `S_gestion`. Sinon : `POST /api/shares/keep` toutes les 4 min tant que la page vit ; sans signe de vie depuis 15 min, ou à l'échéance de 6 h, le serveur efface le brouillon (règles existantes, §7.4). Brouillon perdu (404, redémarrage du serveur) : un nouveau est créé au clic et tout repart.

**Quotas (complète §29.5 ; corrigé après l'audit du 8 novembre, H1 et M1).** Le compte d'un envoi au quota journalier d'octets (6 / 12 Gio) vaut **max(réservation, octets reçus)** : la réservation (données utiles du palier, (palier − 1) × 64 Kio) est débitée d'avance à la création **et à chaque `grow`** (429 au-delà) ; les octets reçus au-delà (segments effacés puis renvoyés) le sont à chaque `PUT` ; un segment effacé **reste compté** (sinon une boucle envoi/effacement serait gratuite). Le bourrage rempli par le serveur à `finalize` est donc toujours payé (palier final ≤ réservation) et borné : la réservation ne dépasse jamais de plus de 2 segments, arrondis au palier, ce qui a été reçu. Un envoi abandonné rend sa création et sa réservation non remplie, jamais ses octets reçus. Limites par connexion inchangées : 2 envois non finalisés (6 par /48). Reste assumé : une création au plus grand palier d'emblée (chemin « au clic », §29.5) réserve 2 Gio, payés au quota du jour. « octets reçus » veut dire données utiles (64 Kio par morceau chiffré commencé, morceau du manifeste non compté, §24), y compris ceux d'un corps incomplet. dès qu'un `finalize` commence, les segments du même envoi sont refusés (503 `busy`, `Retry-After: 5`) jusqu'à sa fin, et `finalize` attend les écritures déjà en vol : le bourrage ne croise plus aucune écriture de segment.

**Ce que voit le serveur (complète §36 S4, S5).**
- Pendant la composition : qu'une composition est en cours, le palier de réservation et ses agrandissements, l'heure et le numéro de chaque segment (taille du contenu à 4 Mio près, déjà assumée), et **pour un élément retiré : sa place exacte, donc sa taille arrondie au segment**, et l'heure du retrait (fuite acceptée).
- **Remplacé (D41-38)** : plus d'arrondi ; la longueur de la requête d'envoi de chaque élément (petit, ou fin d'un grand) donne au serveur sa **taille à 64 Kio près**, plus leur nombre (une requête par petit élément) ; la place d'un élément retiré est connue à 64 Kio près. **Fuite acceptée** (« on ne va pas grossir tous les fichiers ») ; rien de cela n'est écrit sur le disque, mais un serveur qui journalise le verrait.
- **Rouvert et accepté (D41-38)** : la fin d'un grand élément n'est plus arrondie, sa dernière requête donne sa taille à 64 Kio près.
- Frontières des éléments gardés (évaluation demandée) : l'alignement seul ne les révèle pas (tous les segments sont pleins et chiffrés, la queue d'un fichier est faite de zéros chiffrés, indiscernables) ; mais l'**horaire** les trahit quand des ajouts sont espacés (pause entre deux suites de segments), et un retrait révèle les frontières de ses deux voisins. Parade la plus simple, **non retenue** : cadence constante (Q-MIN3, contraire à l'objectif de 5 s). Dit franchement ici et à ajouter à §18 (limites assumées) ; le nombre d'éléments gardés et leurs tailles exactes restent dans le manifeste chiffré.
- Au repos après `finalize` : palier final seulement ; trous et bourrage remplis d'aléa, masque « tous reçus », aucune frontière gardée.

**Signalements (vigilance).**

| Id | Gravité | Endroit | Problème | Correction |
|---|---|---|---|---|
| H-1 | Élevée | Demande, §29.4 point 3 | Effacer les segments d'un élément retiré sans changer de clé laisserait l'élément déchiffrable par qui a le lien, le mot de passe et une copie du chiffré (le destinataire reçoit `R`) ; réutiliser sa place réutiliserait des nonces | Clé par élément `k_i`, absente du manifeste pour un élément retiré (intégré) |
| H-2 | Moyenne (corrigé le 8 novembre) | Alignement au segment | Chaque fichier coûtait au moins 4 Mio de place et d'envoi : 20 photos de 1 Mo envoyaient 80 Mio au lieu de 20 | Petits éléments empaquetés par morceaux dans des segments partagés, plages `?from=c`, aucun bourrage envoyé ; retrait d'un petit : clé jetée, morceaux remplacés à `finalize` (`void`) ; blocage « trop gros » : `segmentsNeeded` (grands en segments, petits en morceaux). Contrepartie : tailles visibles à 64 Kio près pendant l'envoi, ramenée un temps à une classe de puissance de deux (D41-20, D41-21), arrondi supprimé par D41-38 (fuite acceptée) |
| H-3 | Moyenne | Réservation disque | Réserver 2 Gio par brouillon dès le premier fichier saturerait le disque (déni de service bon marché) | Réservation par paliers (`grow`) ; `finalize` ramène au palier final |
| H-7 | Élevée (corrigé) | `grow` | Première version : `grow` réservait jusqu'à 2 Gio de disque sans débit du quota ; quelques dizaines d'adresses tenant 2 brouillons 6 h saturaient le disque sans envoyer un octet | `grow` débité d'avance (429), borné à 2 segments au-delà du dernier reçu ; création débitée comme avant |
| H-8 | Moyenne (corrigé) | `finalize` d'un brouillon | ~65 Kio reçus pouvaient faire écrire 2 Gio d'aléa sans refus (`Settle` débitait sans refuser) | Palier final ≤ réservation déjà payée et bornée (H-7) ; `Settle` retiré |
| H-9 | Moyenne (corrigé) | Client, `erase` | Un échec d'effacement était ignoré ; deux retraits rapides → `503 busy` → l'élément restait sur le serveur | Effacements en file, réessayés ; place rendue à l'écran seulement après succès ; finalisation refusée sinon |
| H-4 | Faible | `erase` concurrent d'un `PUT` | Un `PUT` reçu en entier juste avant son interruption peut s'écrire après l'effacement | Le client attend la fin de la requête interrompue avant `erase` ; reliquat éventuel indéchiffrable (`k_i` oubliée) et recouvert ou rempli à `finalize` |
| H-5 | Faible | Ancien `finalize` (`fill_from`, `fill_to`) | Deux modes de finalisation côté serveur | **Mode au clic abandonné le 24 novembre. Retiré le 24 novembre** : `finalize` exige `bucket`, `header` et `tail` (brouillon, §41.14) ; `fill_from` et `fill_to` sont des champs inconnus (400), au serveur comme dans la démo ; le type `FinalizeBody` du site n'a plus que la forme du brouillon. Tests du serveur migrés vers la finalisation du brouillon : ceux qui prouvaient le refus d'un trou hors bourrage prouvent désormais que **tout morceau manquant** est rempli d'aléa (segments envoyés intacts, en-tête et manifeste écrits), sous la seule borne de D42-17 (409 `incomplete`). Les pièces du salon gardent leur propre `{fill_from, fill_to}` (§9.5 du salon), distinct |
| H-6 | Faible | Effacement « vrai » | Un trou rendu au système de fichiers ne garantit pas l'effacement physique (SSD, journal), comme la suppression d'un fichier entier | Disque chiffré (D2) ; effacement cryptographique par H-1 |

---

## 42. Registre des décisions D42 (revue complète du dépôt)

Revue complète du dépôt du 10 novembre (serveur, client et chiffrement, performance, tests, déploiement ; rapport tenu hors du dépôt). Les corrections proposées ont été retenues, sauf la protection contre les connexions lentes (D42-9). Chaque ligne du journal dit ce qu'elle remplace ou précise ; le texte des sections citées donne l'état qui en résulte.

### 42.0 Journal des décisions

| # | Décision | Remplace ou précise |
|---|---|---|
| D42-1 | **Envois en cours comptés après minuit UTC.** À la rotation du jour, un envoi en cours garde sa place dans les quotas (créations, octets, envois simultanés) sous sa clé de la veille. Le secret de la veille reste en mémoire seulement, 6 h 15 au plus (durée de vie d'un envoi), puis il est mis à zéro. Rien sur disque, aucune adresse gardée. | §9.3, §9.5 (« effacés chaque jour », « secret jeté à minuit ») ; §29.5 (« envois en cours compris ») ; §35.1 point 2. Limite assumée : jusqu'à 6 h 15 après minuit, la mémoire relie le pseudonyme de la veille à celui du jour pour une adresse dont un envoi chevauche minuit. un envoi de la veille **finalisé** après minuit compte dans les quotas **du jour** : sa création et ses octets quittent la clé de la veille et vont à la clé du jour de l'adresse qui envoie `finalize` (recalculée à la requête, aucune adresse gardée). Cet ajout n'est jamais refusé : il peut dépasser le quota du jour, qui bloque alors les créations suivantes. Un envoi de la veille **abandonné** après minuit (effacement, échéance) n'a pas d'adresse : ses octets restent sous la clé de la veille, oubliée avec lui. Avant, un envoi finalisé après minuit sortait de tout quota (10 Gio dans la journée au lieu de 6). |
| D42-2 | **Photo, vidéo ou son d'un format que le nettoyage ne sait pas lire** (TIFF, RAW, AVI, AAC, SVG…) : pastille ambre, compté dans « N fichiers n'ont pas pu être nettoyés », texte « Nettoyage impossible : format non pris en charge », dit au destinataire comme un échec. L'envoi reste libre. Les autres fichiers de format inconnu restent « Fichier tel quel ». | D41-34 (« format non concerné : aucune marque ») pour ces trois catégories seulement. |
| D42-3 | **Fichiers à empreinte en cache un an** : `Cache-Control: public, max-age=31536000, immutable` pour `/assets/…-EMPREINTE.(js\|css\|woff2\|png\|webp\|svg)` seulement. `index.html`, toutes les routes HTML, `/pdf-frame.*`, `/api/*`, polices et images sans empreinte restent `no-store`. | §10 (« `no-store` partout… à rouvrir avant la mise en ligne ») ; §27.5. À faire : donner une empreinte aux polices et aux images de `public/`, ou les sortir de `/assets/` (la règle reconnaît un nom, pas une empreinte réelle). |
| D42-4 | **SRI livrée pour `index.html`** (production et démo) : greffon `shh-sri`, contrôle dans `check-dist.mjs`, test navigateur (un script modifié d'un octet n'est pas exécuté). | §28.3. **Écart restant** : `pdf-frame.html` n'a pas d'empreinte. Le cadre vit dans une origine opaque : une empreinte exigerait des en-têtes CORS sur `pdf-frame.js` et `pdf-frame.css`, alors que le serveur n'en pose aucun (§10). À trancher. Il n'existera pas : repli reCAPTCHA retiré le 24 novembre (§26). |
| D42-5 | **Cadre PDF sans réseau** : CSP propre à `/pdf-frame.html` (`default-src 'none'; script-src 'self'; style-src 'self'; img-src blob: data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`). `worker-src 'self'` ajouté à la CSP de l'application. `sandbox allow-scripts` ajouté à cette CSP (`pdfFrameCSP`, `server/internal/api/static_paths.go`). Ce sont les mêmes droits que l'attribut `sandbox="allow-scripts"` du cadre (UI §13), mais posés par le serveur : ils valent aussi si la page est ouverte directement (onglet, cadre sans attribut). Origine opaque, ni formulaire, ni fenêtre, ni navigation du parent ; `postMessage` marche toujours. | §10 (CSP), UI §13. |
| D42-6 | **Quota de `grow` débité sous la réservation de finalisation** ; palier final d'un brouillon borné par les segments reçus (même marge que `grow`). | §29.5, H-8. Limite restante : un seul morceau envoyé dans le dernier segment fait encore écrire le plus grand palier en aléa ; le remède (création petite, agrandissement par `grow` seulement) reste à faire. |
| D42-7 | **Partage « prêt » seulement après synchronisation du fichier sur le disque** (`fdatasync`) ; un échec de synchronisation annule la finalisation. | §7.4, §9.2. |
| D42-8 | **`admin wipe` coupe aussi les lectures en cours** du serveur en marche (demande `kill/all`), ou dit de le redémarrer s'il ne confirme pas. Le serveur lit le dossier `kill/` chaque seconde, même sans descripteur détaché. | §15.3, §41.8. |
| D42-9 | **Refusé** : la protection contre les connexions lentes qui occupent les places d'envoi et de lecture (échéance glissante, part par /48). | Constat B1 de la revue : reste ouvert, par choix. le déni de service a été reproduit (64 envois à 1 octet depuis 8 adresses IPv4 tenaient toutes les places d'envoi 138 s, renouvelables) et corrigé : débit minimal continu (32 Kio/s par fenêtres de 5 s) et 4 transferts au plus par envoi et par ouverture (§8, §24) ; pas de part par /48 en plus. **Décision** : le débit minimal est gardé ; le refus initial de D42-9 est levé, car le déni de service a été prouvé et cette protection est la plus simple qui le corrige. |
| D42-10 | **Suppression et état d'un partage** : seuls 404 et 410 valent « disparu ». Tout autre refus HTTP (403 d'un intermédiaire, 400, 405, 413) rend une erreur avec « Réessayer », et le secret de gestion est gardé. | §13 (gestion des erreurs). |
| D42-11 | **Nettoyage MP4 et MOV** : le nom libre des gestionnaires de piste (`hdlr`) et le nom de l'encodeur vidéo (`compressorname` de `stsd`) sont mis à zéro. Un EXIF illisible (JPEG, PNG, WebP) est retiré au lieu de faire échouer le nettoyage. | §35.2. |
| D42-12 | **Verrou d'envoi par partage** (256 verrous rayés par identifiant) à la place du verrou global ; suppression de fichier et fermeture des descripteurs détachés hors du verrou des lectures ; place utilisée tenue par un compteur en mémoire, recalé par le concierge chaque minute (la place rendue par une commande d'administration est vue en 60 s au plus). | §9.3, §9.5 (structures en mémoire : marqueur `retiring`, compteur de place ; aucune n'est par personne). |
| D42-13 | **Kit de déploiement** dans `deploy/` : Caddy (TLS 1.3 seul avec échange hybride X25519MLKEM768, HTTP/3 coupé, aucun journal, `X-Shh-Client-IP` remplacé), image Docker, `compose.yaml`, `deploy.sh` avec retour arrière, `test-proxy.sh`. | §15, §22, §30. **À valider** : TLS 1.3 seul et HTTP/3 coupé (hors spécification) ; site dans l'image (§15.3) plutôt qu'archive (§28.7) ; hébergeur, registre d'images. plafonds dans `compose.yaml` (serveur : 1 Gio, `GOMEMLIMIT` 900 Mio, 1,5 processeur ; Caddy : 256 Mio, 1 processeur ; la machine doit avoir au moins 2 processeurs) ; en-tête `Server` retiré aussi des réponses que Caddy fabrique (308, 413, 502) ; image construite avec `--build-arg SHH_BUILD_ID` obligatoire (§28.1). HTTP/3 activé (`protocols h1 h2 h3`, port 443/udp ouvert au pare-feu, annoncé par `Alt-Svc`), ce qui remplace « HTTP/3 coupé ». |
| D42-14 | **Argon2id à la demande, hors du fil principal.** libsodium quitte le script principal (308 → 158 Ko brotli) et vit dans `assets/argon2-EMPREINTE.js`. Ce fichier est lu par `fetch` avec `integrity` (empreinte SHA-384 inscrite dans le script principal, contrôlée par `check-dist.mjs`), puis lancé dans un Worker créé depuis un Blob ; le Worker est arrêté après chaque calcul. Repli : le même fichier chargé dans la page par `<script integrity>`. Aucun `import()` dynamique. **CSP : `worker-src 'self' blob:`** (un Blob ne donne rien de plus à un script déjà exécuté) ; **`worker-src blob:` seul depuis le 21 novembre**. La démo garde libsodium dans son script (sa CSP `connect-src 'none'` interdit de lire le fichier). | §28.3 (le Worker d'Argon2id est couvert par une empreinte ; le Worker anti-robot aussi depuis l'audit du 20 novembre, W3, même mécanisme) ; §10 (CSP) ; §29.1 (le calcul ne fige plus l'écran). |
| D42-15 | **Trusted Types activé** : `require-trusted-types-for 'script'; trusted-types svelte-trusted-html shhdrop` dans la CSP de l'application. Toute chaîne brute donnée à `innerHTML`, `script.src` ou `new Worker()` est refusée par le navigateur. Deux politiques seulement : celle des gabarits de Svelte, et « shhdrop » (`web/src/app/trusted.ts`), qui ne laisse passer que nos scripts de `assets/` et les Blob de cette origine. La démo (CSP par balise meta) et le cadre PDF (CSP propre) ne l'ont pas. | §10 (CSP), idée I2 de l'audit du 8 novembre. Vérifié sous Chromium ; les autres moteurs l'appliquent selon leur version. |
| D42-16 | **Code vérifiable, première partie** : build reproductible prouvé en CI (`web/scripts/repro.sh` : deux builds dans deux dossiers, sur deux machines, mêmes empreintes ; Node épinglé par `web/.node-version`) ; `web/scripts/release-manifest.mjs` (`release.json` et `SHA256SUMS`, variantes `.br`/`.gz` comprises) ; `web/scripts/verify-site.mjs` (compare un site en ligne au manifeste, variantes compressées et repli compris, jamais vert sur une erreur). | §28.1, §28.2, §28.4. **Précisions** : pour le repli, `/` et `/index.html` répondent 200, un chemin inconnu 200 ou 404 avec les octets de `index.html` ; les variantes sont vérifiées par l'adresse de base avec `Accept-Encoding`. **Fait le 24 novembre** : `release.yml` (cosign sans clé), vérification obligatoire dans `deploy.sh` (`deploy/provenance.sh`), surveillance horaire (`verifier-site.yml`), page `/verifier` ; manifestes publiés dans les Releases et non commités (§28.2, erreur corrigée). **Reste** : première étiquette et protection des étiquettes `web-v*`, (image construite, publiée et signée par `release.yml` depuis le 25 novembre, §28.2), démo (Q-C3). Le vérificateur ne contrôle pas les en-têtes (un serveur compromis peut affaiblir la CSP sans changer un octet) : limite à garder en §28.8. |
| D42-17 | **Amplification fermée** (complète D42-6). (1) Création au plus au palier 400 (6 segments) ; au-delà, 400 avant le défi anti-robot ; le client grandit ensuite par `grow`. (2) `grow` borné par le plus haut segment **jamais reçu** depuis la création (effacements compris). (3) À `finalize` (l'ancien `fill_from`/`fill_to` est retiré, H-5) : morceaux d'aléa ≤ 4 × morceaux reçus + 512, sinon **409 `incomplete`**, rien d'écrit. Un élément retiré pendant son envoi n'efface que ses segments déjà partis. | §29.3, §29.5, §29.8 (409 possible sur finalize), §41.14 points 1 et suivants, H-5, H-7 (« plus haut reçu »). Preuve qu'un client normal ne l'atteint pas : pire disposition réelle testée, 3 154 morceaux d'aléa pour une borne de 3 892. |
| D42-18 | **Nettoyage complété** : Office (chemin local `absPath`, modèle attaché), MKV/WebM sans la marque « shhdrop », enregistrements passés par les analyseurs communs. Texte Office : « propriétés et chemin local du fichier retirés (auteurs des commentaires et liens vers d'autres fichiers gardés) ». **Décision complémentaire** : l'imprimante des documents Office et ODF est gardée, la vignette JFIF des photos est gardée, et rien n'est modifié dans les images d'un PDF (seule reste la limite de décompression contre les fichiers piégés). la vignette EXIF (IFD1) des photos est gardée aussi, et un PDF ne perd plus que `/Info` et le XMP du catalogue (§35.2). | §35.2 : lignes Office (« chemin du modèle attaché » laissé) et WebM (« réécrits shhdrop ») désormais fausses. |
| D42-19 | **Fichiers piégés bornés** (ZIP, HEIF, FLAC, WAV, Ogg, budget de décompression des PDF) ; Ogg et aperçu repliés en mémoire ; **aperçu limité à 50 Mio sur un appareil à petite mémoire**. CSP : `connect-src 'self' blob:` (Chrome relit lui-même une image blob: qu'il ne décode pas). Démo : « N'y mettez rien de réel ». | §35.2, UI §9.8, §10 (CSP). |
| D42-20 | **Apps iOS et Android 100 % natives et autonomes**, plus le site web. Un seul moteur pour les deux apps, le plus identique possible : cœur commun en Rust (chiffrement, format des partages, échanges avec le serveur, nettoyage des fichiers), utilisé tel quel par iOS et Android ; plus tard, éventuellement par le site (WebAssembly). Compatibilité totale site ↔ apps (un lien créé d'un côté s'ouvre de l'autre), prouvée par des vecteurs de test communs vérifiés à chaque modification. Règle crypto du projet élargie en conséquence (bibliothèques reconnues, mêmes paramètres, mêmes résultats). Fichiers reçus enregistrés en flux dans un dossier privé de l'app, effacés à la fermeture sauf choix d'enregistrer. Interface commune aux deux apps en **Flutter** (Dart), reliée au moteur Rust par flutter_rust_bridge : mêmes écrans sur iPhone et Android, dessinés par l'app (aucune vue web). **Plus tard : aucune app n'est développée pour l'instant.** En attendant, chaque choix de format, de chiffrement, d'API ou de lien doit rester utilisable tel quel par une app native : format des partages et vecteurs de test documentés, API sans dépendance au navigateur (cookies, en-têtes propres au navigateur, CORS), liens qui pourront devenir des liens universels. Spécification de l'app à écrire et à faire valider avant tout code, le moment venu. | Remplace §16 (Capacitor). |
| D42-21 | **Moteur Rust en service sur le site** (sous-projet 1 de D42-20). Chiffrement, format des partages, lien, mot de passe, HKDF, SHA-256, HMAC et Argon2id passent par le moteur Rust (`engine/`, RustCrypto) compilé en WebAssembly ; AES-GCM et les nombres aléatoires restent à WebCrypto. Le `.wasm` est chargé avec contrôle d'empreinte ; Argon2id tourne dans un Worker neuf à chaque appel ; au-delà de 20 s, le Worker est arrêté et le calcul est refait dans la page (interface figée pendant ce calcul sur un appareil très lent ; à revoir avec les apps). L'ancien moteur TypeScript et libsodium sont retirés ; les vecteurs `engine/vectors/v2.json`, produits par l'ancien moteur, prouvent que les partages restent identiques. Temps (Chromium, 3 tours alternés) : chiffrer +8,4 %, ouvrir +23,1 %, Argon2id −18,7 % (plus rapide), poids −0,7 % ; critère « rien de plus lent » tenu (`docs/conception/benchmarks/2026-11-10-moteur-rapport.md`). Mot de passe à l'ouverture : le moteur retire les blancs ASCII de bord (espace, tabulation, retour chariot, saut de ligne) avant NFC et Argon2id, pour le site comme pour les apps (cas dans `engine/vectors/v2-limites.json`). Un mot de passe fait seulement de blancs est refusé (`mot_de_passe_vide`) avant toute requête ; à la création, la forme exacte reste exigée (`mot_de_passe_non_genere`). Blancs intérieurs et blancs non ASCII (espace insécable…) gardés ; le QR garde les blancs, c'est le calcul de K_mdp qui les retire (`kdf::trim_password`). **Notes vérifiées au scellement** : le moteur refuse au manifeste une note que le lecteur refuserait : plus de 100 000 points de code (`texte_trop_long`) ou octets qui ne sont pas de l'UTF-8 strict (`texte_invalide`). Le scelleur garde le verdict du texte qu'il a chiffré (`ElementSealer::check_note`) ; `sealFinal` (wasm) et `FinalEntry::note` (cœur) l'appliquent. Avant, une telle note partait mais le partage ne s'ouvrait pas. **Cas limites communs** : `engine/vectors/v2-limites.json`, produit par le moteur Rust (liens dont la clé commence par « m », 200 et 201 éléments, notes limites, Argon2id NFC difficiles, blancs en bord), rejoué en Rust natif et en WebAssembly ; les apps devront le rejouer comme `v2.json`. **À reporter dans le moteur avant les apps** : (a) le contrôle de taille et de place de chaque élément au moment du manifeste (`sealFinal`) est fait côté TypeScript seulement ; une app native devra l'avoir dans le moteur (11 novembre : fait en partie ; dans le cœur, `FinalEntry::note` et `FinalEntry::file` prennent la taille, la place et la graine du scelleur ; la liaison wasm lit encore `size` et `first` du JavaScript) ; (b) la garde par graine « une graine neuve ne donne qu'un seul jeu de clés de création » n'existe que dans la liaison wasm (`engine/wasm/src/lib.rs` : `SeedCell`/`keys_made`, `creatable`) ; le cœur ne garde que par instance de `ContentKeys` (`use_for_manifest`, `CleDejaUtilisee`) : dans `shhdrop-core`, `content_keys` peut être appelé deux fois sur la même graine et `seal_final` accepte les clés d'ouverture de `content_keys_checked`, d'où un risque de réutilisation de nonce AES-GCM (même clé, `nonce(B−1, true)`) pour une app qui utiliserait le cœur directement ; remède prévu : types distincts « graine neuve → clés de création » et « clés d'ouverture », ces dernières refusées par `seal_final` à la compilation, `size` et `first` pris du scelleur ; (c) `stream_item` livre par lots de 4 Mio (mémoire) ; (d) la logique sans secret dupliquée en TypeScript (`web/src/engine/pure.ts` : mot de passe généré, forme du lien, contrôle d'origine, base64url), égalité prouvée par `pure.test.ts`, à faire passer par le moteur au sous-projet 2. | Spec `2026-11-10-moteur-rust-1-chiffrement-design.md`. **Second module wasm pour le salon** : `engine/salon-wasm`, construit à part (profil `wasm-salon`, opt-level "z"), chargé avec contrôle d'empreinte (SHA-384) seulement sur les pages du salon, jamais sur celles des partages ; **au plus 430 000 octets en brotli** (`check-dist`), mesuré 422 288 à 422 681 (environ 422 Ko). Le moteur des partages ne change pas. Détails : spec salon v3 §3.6. |
| D42-22 | **Retour des personnes qui ont déjà ouvert, jusqu'à l'échéance**. Chaque personne qui a ouvert un partage peut y revenir tant que le lien n'a pas expiré, **sans consommer d'ouverture** ; quand toutes les ouvertures sont prises, **personne d'autre** ne peut entrer. La dernière personne a le bouton « Détruire » : si elle détruit, le partage est supprimé tout de suite ; sinon il reste jusqu'à l'échéance choisie à la création, puis s'efface. Mise en œuvre : l'octroi d'ouverture (§41.4) vaut jusqu'à `expires_at` (au lieu de 30 min) ; il est gardé **chiffré dans le navigateur** (même mécanisme que l'historique local, §33) pour survivre à la fermeture de l'onglet ; aucune empreinte, aucun cookie, aucune IP ; plus de suppression à l'expiration d'un octroi ni 3 min après `leave` (D41-28 remplacé) ; budget de lecture et nombre de retours bornés par ouverture. **Signalements** : (moyen, confidentialité) le contenu chiffré reste sur le serveur jusqu'à l'échéance (24 h au plus en gratuit) au lieu d'environ 30 min après la dernière lecture ; (faible) un autre appareil ou la navigation privée ne peut pas revenir ; un redémarrage du serveur invalide les octrois (secret en mémoire, §7.7) : le retour devient impossible si toutes les ouvertures sont prises, ce qui est dit à l'écran. | Remplace la durée de 30 min de §41.4 et D41-28 (suppression 3 min après `leave`). **Mis en œuvre le 12 novembre** : serveur, octroi jusqu'à `expires_at`, `draining` gardé jusqu'à `expires_at` (purge en mémoire = `expires_at` ; un redémarrage efface toujours les `draining`, dont les octrois ne valent plus rien), routes `regrant` et `leave` retirées, au plus 20 retours par ouverture, budget de lecture 2 × F + 2 segments 0 + min(r × F, max(3 × F, 256 Mio)) (formule de la revue du 12 novembre) gardé jusqu'à l'échéance + 2 h de grâce (un retour après plus de 6 h ne le remet pas à zéro) ; site, `web/src/history/returns.ts` (IndexedDB `shhdrop-returns`, AES-256-GCM, clé non extractible ; étiquette, octroi, échéance seulement), écran « Impossible de revenir sur ce partage » (UI §9.7.1). **Revue de sécurité du 12 novembre** : octrois et budgets oubliés avec le partage (destruction, échéance, fin de grâce, filet à l'échéance + 2 h pour un partage effacé hors du processus) ; budget de retour borné à min(r × F, max(3 × F, 256 Mio)) ; `unlock` rend `last_open` (vrai seulement pour la dernière ouverture permise, n = `opens_issued`) : seule celle-ci voit « Détruire » ; refus d'octroi sans ouverture restante : « Impossible de revenir », cause dite ; la base `shhdrop-returns` est supprimée quand elle est vide, balayée au démarrage, effacée avec l'historique. **Signalements ajoutés** : (moyen, confidentialité) l'octroi est un **jeton au porteur** : un destinataire peut redistribuer lien + mot de passe + octroi, et un tiers revient alors sur son ouverture (borné à 20 retours et au budget) ; c'est inhérent à la possibilité de copier le contenu déjà ouvert, et rien ne l'empêche sans identifier l'appareil (refusé : aucune empreinte) ; (faible, exploitation) un redémarrage du serveur rend tous les retours impossibles sur les partages dont toutes les ouvertures sont prises (ils sont effacés au démarrage) et fait consommer une ouverture sur les autres. |
| D42-23 | **À faire plus tard** : (1) **tableau de bord de l'administrateur** : compteurs agrégés (liens créés, ouverts, détruits, expirés ; salons ; fichiers ; stockage ; comptes ; paiements), actions (détruire un lien, arrêt d'urgence, signalements) ; jamais de données des personnes ni d'IP ; **signalement (moyen)** : contredit « aucune statistique » (§9.5) : seuls des compteurs agrégés sans identifiant sont proposés, et l'accès doit rester privé (tunnel SSH) ; (2) **paiement en crypto seulement** (la carte exige un compte professionnel chez un prestataire) : BTC, Lightning, ETH, USDT, USDC, Monero, Zcash, SOL, par un serveur de paiement auto-hébergé ; **signalements (élevé, légal)** : vendre exige un statut d'entreprise même en crypto (§38.5) ; USDT n'est pas conforme à MiCA dans l'UE ; Monero et Zcash seront refusés par les plateformes de conversion régulées (règlement anti-blanchiment de l'UE, 2027) ; BTCPay couvre BTC, Lightning et Monero, pas toutes les autres sans greffons ou un second outil ; à trancher avec juriste et comptable avant la tâche P1. | Ordre décidé : salon, compte par passkey, tableau de bord admin, paiement, langues, version signée. |
| D42-24 | **Nom affiché : Shhgone** (domaine shhgone.com). Tout ce que voit un visiteur porte ce nom (textes FR et EN, titres d'onglet, manifeste, logo, pied de page, démo). L'interne ne change pas : dépôt, paquets, en-têtes `X-Shh-*`, bases locales (`shhdrop-history`, `shhdrop-returns`…), étiquettes HKDF `shhdrop/v2/…`, variables `SHH_*`, image Docker, base `/shhdrop/` de la démo (devenue `/shhgone/` avec le dépôt `Skoow/shhgone` : Pages sert la démo sous le nom du dépôt ; seules les URL de la démo changent, ni le chiffrement ni les liens de production) : les renommer casserait la compatibilité ou le chiffrement, et les apps (D42-20) gardent les mêmes étiquettes. | UI §0.2 (P9), §6. Test : `web/src/brand.test.ts`. |
| D42-25 | **Création sans compte maintenue, compte facultatif** (« pour l'instant ») : sans compte, partage jusqu'à 2 Go et 24 h, salon de base ; un compte par passkey (sans e-mail ni téléphone) donne des limites plus hautes, l'historique synchronisé, l'avatar gardé, les offres Plus et Pro et, plus tard, les appels. Les destinataires n'ont jamais besoin de compte. Option prévue pour plus tard, réglable depuis le tableau de bord sans reconstruire : exiger un compte pour **créer un salon** seulement, si les abus l'exigent. **Signalement (moyen, confidentialité)** : un compte permet au serveur de relier entre eux les partages et salons d'une même personne ; la conception des comptes (A1 à A3) devra l'empêcher par des jetons anonymes (Privacy Pass, RFC 9576 à 9578) : le compte prouve son droit de créer sans que le serveur sache lequel a créé quoi. | §37 ; conception des comptes à écrire. |
| D42-26 | **Compte par e-mail, obligatoire pour créer un salon** (**remplace** pour le compte la passkey sans e-mail de §37 et D42-25, à valider dans le détail avant code). (1) **Partager et ouvrir un lien** : sans compte, inchangé. (2) **Rejoindre un salon** : sans compte. (3) **Créer un salon** : compte gratuit obligatoire. (4) **Compte** : e-mail + mot de passe + double authentification facultative (code d'application, TOTP) ; aucun numéro de téléphone ; pseudonyme et photo de profil. (5) **Protection** : l'e-mail n'est jamais gardé en clair, seulement une empreinte à clé secrète du serveur (connexion, unicité, bannissement) ; adresses normalisées (alias `+`, points Gmail), domaines jetables refusés ; mot de passe sous Argon2id ; pseudonyme et photo chiffrés sur l'appareil, envoyés aux membres dans le salon comme aujourd'hui (le serveur ne les voit pas). (6) **Ancienneté** : compte neuf limité (1 salon à la fois, 4 places, 24 h), plus après 7 jours sans signalement (3 salons, 10 places) ; le payant ajoute de la capacité. (7) **Pouvoirs du fondateur sur signalement** : détruire un salon ou un partage (existe), **bannir un compte créateur** (ses salons se ferment, plus de création). Un invité sans compte n'est pas bannissable : on ferme le salon. (8) **Rôle d'admin du salon** : lié au compte créateur (le secret de gestion est gardé chiffré dans le compte). **Signalements** : (a) **moyenne, confidentialité** : le serveur relie un compte aux salons qu'il crée (nécessaire au bannissement), ce que §37.4 interdisait ; (b) **moyenne, confidentialité** : le fournisseur de l'e-mail apprend l'usage du service (mail de confirmation) ; (c) **moyenne, promesse publique** : « ni e-mail » devient faux pour le compte, textes du site et des maquettes à reformuler ; (d) **basse** : un banni peut recréer une adresse (freins : anti-robot, ancienneté, limites de création par connexion) ; (e) **juriste** : traitement d'e-mails (RGPD : base légale, durée, droit d'effacement) ; (f) remplace les idées écartées le même jour : empreinte d'appareil (pistage, RGPD, inefficace), numéro de compte au porteur (peu connu). | §37, §39, §38 |
| D42-27 | **Historique local des liens retiré, Profil et Paramètres réunis** (décision du propriétaire, 25 novembre : « cela ne sert à rien »). (1) Retirés : historique des envois (`/envois`, « Mes partages », « Garder dans mon historique » de « Lien prêt » et de la création d'un salon), liens reçus gardés (« Garder ce partage », réglage du compte « Garder les liens que j'ouvre »), « Vos partages actifs » et liste de l'accueil connecté, synchronisation des listes par le compte, destruction des partages connus à la suppression du compte, « Exporter mes données ». (2) Données d'avant : base `shhdrop-history` supprimée au démarrage ; listes du coffre privé vidées à l'ouverture de session (format gardé). (3) « Lien prêt » et « Salon prêt » montrent toujours le lien de gestion. (4) Compte : une seule page `/compte` (Profil et Paramètres ; `/compte/profil` et `/envois` remplacés dans l'adresse), « Se déconnecter » seulement sur cette page, plus de « Nouveau partage » ni d'« Accueil » dans le menu du téléphone ; barre d'onglets du compte : Nouveau, Téléchargements, Compte. (5) Assurances « Chiffré · Sans compte · S'autodétruit » dites une seule fois, sous le héros de l'accueil (retirées du composeur). Signalements : gestion possible seulement tant que « Lien prêt » est ouvert si le lien de gestion n'est pas copié (moyenne) ; droit d'accès et de portabilité sans fichier (moyenne, légal) ; route `GET /api/compte/export` sans client. | §33, §33.1, Q-H1, Q-H2, Q-P9, §37 (historique synchronisé), §38 (tableau des offres), §39 (Salon prêt), conception du compte §21.7, §21.15 |

### 42.1 Encore ouvert après cette revue

- **Provenance** (D42-16) : faite (§28.2, §28.7). Reste : Q-C3. SRI seule ne protège pas d'un serveur compromis (§28.3).
- **Isolation COEP écartée** : pas de `Cross-Origin-Embedder-Policy` (§10).
- **Gros fichier reçu en flux (OPFS)** : non retenu pour l'instant. Une copie en clair resterait dans le stockage du site si l'onglet est fermé avant le nettoyage, contraire à « aucun stockage ». À la place : avertissement à l'écran (UI §9.2.5).
- **Un PUT annulé mais déjà reçu** peut être écrit après l'`erase` ; si un nouvel élément a pris cette place, le destinataire verra une erreur de déchiffrement (existait avant). Remède : compteur de génération par brouillon vérifié par `PutSegment`.
- **Office** : liens vers d'autres classeurs (`xl/externalLinks/`), source de publipostage, identifiants de révision : gardés (le texte le dit).
- **Historique du navigateur** : un test prouve que la clé du lien reste dans l'historique de Chromium (§5.3 corrigée ; la page Sécurité le dit dans les deux langues). Pas de test Firefox.
- **Légal (§17)**, mentions légales à compléter, déclaration ANSSI : inchangés.

### 42.2 Corrections de la vérification du 11 novembre (audit)

Rapport tenu hors du dépôt ; chaque correction est écrite à sa place :

- Serveur : débit minimal et 4 transferts par envoi ou par ouverture (§8, §24, §9.5, D42-9) ; quotas en données utiles (§24, §41.14) ; envoi de la veille finalisé après minuit (D42-1) ; signalement d'un partage déjà disparu (§41.8) ; segments refusés pendant `finalize` (§41.14) ; envois effacés hors du serveur oubliés au balayage (§9.5) ; tableaux JSON de taille fixe (§8) ; version du schéma et vidage du WAL (§9.1) ; sortie d'erreur (§9.4).
- Chaîne : identifiant de build obligatoire (§28.1) ; cadre PDF en `sandbox` (D42-5) ; plafonds des conteneurs et en-tête `Server` (D42-13).
- Moteur : blancs du mot de passe, notes vérifiées au scellement, vecteurs `v2-limites.json` (D42-21, §29.2).
- Nettoyage : PDF limité aux propriétés du document, vignette EXIF gardée (§35.2, §18, D42-18).
- Interface : coffre chez le destinataire retiré (§27, §34.1) ; le reste dans la spécification UI, §23.
- Encore ouvert : I7 (provenance de l'image, §42.1) et I8 (mentions légales, §17).

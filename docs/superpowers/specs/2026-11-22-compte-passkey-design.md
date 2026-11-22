# Compte par passkey et clé de récupération, sans e-mail — conception

> **Validée par le propriétaire le 22 novembre 2026** : toutes les recommandations du §16 acceptées ; domaine définitif `shhgone.com` (RP ID) ; bannis : accepter et observer (Q5). Rien n'est encore codé. Date : 22 novembre 2026. Décision de départ du propriétaire (22 novembre) : « OK pour passkey », avec la question « est-ce facile de se créer un compte ? ». Cette conception **remplace**, pour l'identité, la connexion et la récupération, la conception `2026-11-14-compte-email-design.md` (e-mail, mot de passe, TOTP, séquestre). Ce qui n'est pas dit ici **reste valable** (pseudo unique §21.5, coffres et leurs formats, sessions §8.5, ancienneté §11, bannissement §21.11 sauf la clé de recherche, accueil connecté §21.7, signalements §21.10, suppression totale §21.12, sauvegarde §21.13, tableau de bord §21.14 sauf la recherche par adresse). Les décisions qui reviennent au propriétaire sont en §16, chacune avec une recommandation.

Références lues : `CLAUDE.md` ; `2026-11-14-compte-email-design.md` (entier) ; spécification principale `2026-11-03-shhdrop-design.md` §37 (v2.7 et compléments v2.8 §37.11 : passkey, PRF, clé de secours) ; `docs/ouverture-comptes.md` (§2.1) ; `2026-11-19-paiement-design.md` (§6.2, DP-8) ; code : `engine/core/src/compte.rs`, `engine/vectors/README.md` et `compte.json`, `server/internal/compte/*` (notamment `base.go`, `sequestre.go`, `totp.go`, `cles.go`), `server/internal/api/handlers_compte.go`, `server/internal/api/headers.go`, `server/internal/courriel/`, `server/go.mod`, `web/src/account/*`, `web/src/routes/compte/*`, `web/e2e/compte-sees-nothing.test.ts`, `web/ui-e2e/compte*.ts`.

---

## 1. Intention et critères de réussite

Le compte sert à créer des salons (bannissement possible, ancienneté), à garder un pseudo unique, et à synchroniser les coffres chiffrés entre appareils. Il doit maintenant exister **sans aucune adresse e-mail**.

Réussite :
- créer un compte demande **un pseudo, un geste de passkey et une clé à noter** ; aucune attente, aucun code reçu, aucun mot de passe à inventer (§3.1 : comparaison chiffrée avec l'e-mail) ;
- se connecter = **un clic et un geste** (passkey découvrable) ;
- le serveur ne reçoit **jamais** de quoi ouvrir un coffre : ni la sortie PRF, ni la clé de récupération, ni `K_compte` ; le séquestre du profil **disparaît** (§8), donc l'exception à CLAUDE.md validée le 14 novembre (R2, R-D1) n'a plus lieu d'être ;
- aucune donnée d'identité civile collectée (§12) ;
- le même compte marche sur le site et, plus tard, dans les apps iOS et Android (même RP ID, mêmes enveloppes, vecteurs communs, §10).

**Anti-objectifs** (échec même si « ça marche ») : le serveur voit une sortie PRF, une clé de récupération ou `K_compte` ; une passkey créée sur le site ne marche pas dans l'app (ou l'inverse) ; un cookie, une IP, une heure, un AAGUID ou un compteur de signatures sur disque ; une page dit si un pseudo a un compte autrement que par la vérification de disponibilité déjà prévue (§21.5, bornée).

## 2. Approches envisagées

### 2.1 Où vit la clé du coffre sans mot de passe

| Approche | Pour | Contre | Retenue |
|---|---|---|---|
| **A. Clé maîtresse aléatoire `K_compte`, enveloppes multiples** : une par passkey qui offre PRF, une par la clé de récupération | aucune clé ne dépend d'un seul objet ; ajouter ou retirer une passkey ne rechiffre rien ; c'est le modèle de §37.2, déjà relu, et celui de Bitwarden et 1Password pour le déverrouillage par passkey | deux chemins à tester (avec et sans PRF) | **Oui** |
| B. Chiffrer le coffre directement par la sortie PRF d'une passkey | simple | une deuxième passkey ou un autre écosystème ne l'ouvre pas ; perdre la passkey perd tout | Non |
| C. Clé de récupération seule (aucune enveloppe PRF) | marche partout, aucune dépendance à PRF | il faut taper 27 caractères sur **chaque** nouvel appareil, même avec une passkey synchronisée : contraire à « au moins aussi simple » | Non (mais c'est le **repli** quand PRF manque, §5.5) |
| D. Séquestre serveur de `K_compte` | aucune clé à noter | le serveur lit tout ; contraire à D42-26 point 5 et à la règle « aucune clé en clair » | Non |
| E. Clé gardée par le serveur, rendue après passkey seule | aucune clé à noter, aucune dépendance à PRF | équivaut à D : le serveur (ou qui vole la machine) ouvre tous les coffres | Non |

### 2.2 Format de la clé de récupération

| Format | Saisie | Entropie | Dépendance | Retenue |
|---|---|---|---|---|
| **27 caractères base32 de Crockford** (128 bits + 1 caractère de contrôle mod 37), en 7 groupes `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX` | tolérante (minuscules, espaces, tirets, `I`/`L` → `1`, `O` → `0`), contrôle local avant tout appel | 128 bits | aucune (codage dans le moteur, règles de §37.1 et A-G6 déjà écrites) | **Oui** (recommandé, Q2) |
| 12 mots BIP-39 (128 bits, somme de contrôle SHA-256 intégrée) | plus facile à recopier à la main | 128 bits | une liste de 2 048 mots par langue (la liste française officielle existe) et un crate de plus (`bip39`), revue de chaîne d'approvisionnement ; mots différents selon la langue : une clé notée en français ne se tape pas dans une app réglée en anglais sans gérer les deux listes | Non (possible si le propriétaire préfère des mots) |
| 24 mots BIP-39 ou 53 caractères (256 bits, ancien code de secours) | longue | 256 bits | — | Non : 128 bits suffisent pour une clé aléatoire non tapée de tête ; aucun calcul hors ligne n'est possible sur `v_r` (§5.3) |

**Signalement (faible, sécurité)** : 128 bits gardent une marge de 2⁶⁴ même contre un calculateur quantique (Grover) ; c'est la marge de AES-128, jugée suffisante pour une clé qui ne protège que des coffres de quelques kilo-octets. Si le propriétaire veut 256 bits, la clé passe à 53 caractères (format de §37.1) sans autre changement.

---

## 3. Parcours, écran par écran

Règles d'écran communes de la conception du compte (§12, §21.15) inchangées : étiquettes visibles, `LiveRegion`, focus sur l'erreur, 44 px, 320 px, tout au clavier, rien dans l'URL ni le titre d'onglet. Annuler la feuille de passkey (`NotAllowedError`) n'affiche **aucune** erreur et ne crée rien.

**Contrainte technique qui fixe l'ordre des appels (signalement moyen, exactitude)** : Safari exige que `navigator.credentials.create` et `get` partent du geste de l'utilisateur ; un `fetch` des options entre le clic et l'appel fait échouer la cérémonie. Les options (défi) sont donc **chargées avant le clic** : à l'ouverture de la page de connexion, et à l'inscription dès que la preuve ALTCHA est prête ; défi valable 5 min, rechargé sans bruit s'il a expiré.

### 3.1 Créer un compte (`/compte/inscription`)

| # | Écran | Ce que fait la personne | Ce qui se passe |
|---|---|---|---|
| 1 | « Créer un compte » — sous-titre : « Sans e-mail ni mot de passe. Votre téléphone ou votre ordinateur vous reconnaît. » ; champ **Pseudo** (vérifié pendant la saisie : « Disponible » / « Déjà pris ») ; case « J'ai au moins 15 ans et j'accepte les conditions d'utilisation » ; bouton **« Créer avec une passkey »** ; lien « J'ai déjà un compte » | tape le pseudo (1), coche (2), clique (3) | preuve ALTCHA calculée dès l'ouverture ; `inscription/debut` appelé dès qu'elle est prête (rend `etape` et les options) ; `pseudo/verifier` réserve le pseudo pour l'étape |
| 2 | **Feuille du système** : « Créer une passkey pour shhgone.com ? » (iCloud, Google, Windows Hello, gestionnaire, ou « Utiliser un autre appareil » : QR) | Face ID, empreinte ou code de l'appareil (4) | `create` avec `prf.eval.first = E_prf` ; tirage de `K_compte` et de `R` sur l'appareil |
| 2 bis | seulement si le gestionnaire n'a pas rendu la sortie PRF à la création mais l'annonce (`prf.enabled`) : « Une deuxième confirmation est nécessaire pour chiffrer vos données. » | un geste de plus (4 bis) | `get` limité à cette passkey |
| 3 | **« Votre clé de récupération »** : 7 groupes en police à chasse fixe ; « Elle remplace vos passkeys si vous les perdez toutes. Nous ne pouvons pas la retrouver : sans elle et sans passkey, le compte est perdu. » ; boutons « Copier », « Télécharger (.txt) » ; bouton « Je l'ai notée » | note la clé (5 : copier, télécharger ou recopier), clique (6) | rien n'est envoyé |
| 4 | « Vérification : tapez le groupe n° {k} » (k tiré au hasard parmi 1 à 7, 4 caractères, 3 pour le dernier) ; « Revoir la clé » ; bouton « Terminer » | tape 4 caractères (7), clique (8) | `inscription/fin` : le compte existe sur disque **à partir d'ici seulement** ; « Compte créé. » puis retour à la page d'origine (création de salon le plus souvent) |

**Photo de profil** : retirée de l'inscription (elle reste dans le profil, §21.15.3). Une étape de moins, rien de perdu.

**Fermer la page à l'écran 3 ou 4** : rien n'est créé côté serveur (l'étape expire), mais la passkey existe déjà dans le gestionnaire. Correction : l'écran 3 dit « Le compte n'existe qu'après « Terminer » » ; à l'échec définitif, le client appelle `PublicKeyCredential.signalUnknownCredential` là où il existe (Chrome 132 et suivants, Safari récent) pour que le gestionnaire oublie la passkey ; sinon le texte dit « Vous pouvez supprimer la passkey « {pseudo} » de votre gestionnaire. »

**Comparaison avec la création actuelle par e-mail** (§12.1 et §21.15.2 de la conception du compte) :

| | Par e-mail (aujourd'hui) | Par passkey (proposé) |
|---|---|---|
| Champs à remplir | 3 (adresse, mot de passe de 10 caractères à inventer, pseudo) + case | 1 (pseudo) + case |
| Clics et gestes | « Recevoir un code », « Créer le compte » | « Créer avec une passkey », 1 geste (2 sur certains gestionnaires), « Je l'ai notée », « Terminer » |
| Attente extérieure | **oui** : l'e-mail (quelques secondes à plusieurs minutes, parfois dans les indésirables), changer d'application, lire, revenir, taper 6 chiffres ; Argon2id de 1 à 3 s | **aucune** ; on ne quitte pas la page |
| À retenir | un mot de passe | rien ; une clé à **ranger** (pas à retenir) |
| Total | **8 actions + attente + changement d'application** | **8 actions** (9 avec la deuxième confirmation), aucune attente |

Réponse à la question du propriétaire : **oui, c'est au moins aussi simple, et plus rapide** (aucune attente d'e-mail). La seule étape nouvelle est la clé de récupération ; sans elle, la création tiendrait en **4 actions**. La rendre facultative est la question Q1 (recommandation : obligatoire).

### 3.2 Se connecter (`/compte/connexion`)

| # | Écran | Action |
|---|---|---|
| 1 | « Se connecter » ; bouton **« Se connecter avec une passkey »** ; case « Rester connecté sur cet appareil » (inchangée, décochée, D7) ; liens « J'ai ma clé de récupération », « Créer un compte » | clic (1) |
| 2 | feuille du système : choix du compte (libellé = pseudo, Q6) et Face ID / empreinte / code | geste (2) |

Puis le client ouvre l'enveloppe PRF de cette passkey → `K_compte` → coffres. **2 actions** (aujourd'hui : adresse, mot de passe, clic, Argon2id, plus le code TOTP s'il est actif).

### 3.3 Nouvel appareil

| Cas | Parcours | Actions |
|---|---|---|
| **a. Passkey synchronisée** (même trousseau iCloud, même compte Google, même gestionnaire) | comme §3.2 ; la sortie PRF est la même sur tous les appareils du trousseau | 2 |
| **b. Passkey d'un autre appareil, par QR** (hybride CTAP 2.2) : par exemple un PC Windows et une passkey sur un iPhone | « Se connecter avec une passkey » → la feuille du navigateur propose « Utiliser un téléphone ou une tablette » → QR → le téléphone le lit, Bluetooth de proximité, geste sur le téléphone → connecté sur le PC. Si la sortie PRF arrive : coffres ouverts. Puis bandeau « Ajouter une passkey sur cet appareil ? » (facultatif ; refusé, le QR resservira) | 4 à 5 (+2 pour ajouter une passkey locale) |
| **c. Clé de récupération** | « J'ai ma clé de récupération » → champ unique (collage permis, contrôle local : « Clé mal recopiée : vérifiez chaque groupe. ») → `recup` → `K_compte` par `Env_r` → écran « Ajouter une passkey sur cet appareil » (proposé tout de suite, §3.5) | 3 + 2 |

**Repli quand l'enveloppe ne s'ouvre pas** (sortie PRF absente ou différente, §5.5) : « Cet appareil ne permet pas d'ouvrir vos données avec cette passkey. Entrez votre clé de récupération une fois : cet appareil s'en souviendra. »

### 3.4 Récupération (toutes les passkeys perdues)

1. `/compte/connexion` → « J'ai ma clé de récupération » → saisie → `recup` (10 essais par heure et par connexion).
2. Session récente ouverte ; `K_compte` ← `Env_r` ; coffres ouverts : **rien n'est perdu** (pseudo, photo, salons, liens, pass).
3. Écran obligatoire « Créez une passkey sur cet appareil » (sinon le compte n'a plus de moyen de connexion courant).
4. Écran « Vos passkeys » : les anciennes, avec « Retirer » (la passkey perdue).
5. Bandeau persistant tant que ce n'est pas fait : « Votre clé de récupération a servi. Si elle a pu être vue, créez-en une nouvelle. » (Q10 : proposée ou imposée).

Sans passkey **ni** clé : compte **irrécupérable** (aucun e-mail, aucun séquestre) ; effacé après 13 mois sans connexion ; le pseudo redevient libre à ce moment. Dit à l'écran 3 de l'inscription et dans les paramètres.

### 3.5 Ajouter ou retirer une passkey (Paramètres → « Passkeys »)

- Liste : libellé local (« iPhone », « YubiKey bleue », chiffré par `K_etiquette`, jamais lu par le serveur), « ajoutée en novembre 2026 », « liée à cet appareil » si la passkey n'est pas synchronisable (`be = 0`), « ouvre vos données » si elle a une enveloppe PRF, « cette passkey » pour la courante.
- **Ajouter** : session récente (sinon geste de passkey d'abord), « Ajouter une passkey » → feuille du système → geste → libellé proposé (modifiable) → enveloppe téléversée si PRF. **3 actions.** `excludeCredentials` = passkeys du compte (10 au plus).
- **Retirer** : session récente ; `InlineConfirm` « Retirer cette passkey ? Elle ne pourra plus ouvrir ce compte. » ; **la dernière ne se retire pas** (« Ajoutez d'abord une autre passkey ») ; puis `signalUnknownCredential` sur cet appareil si l'API existe, sinon « Supprimez-la aussi de votre gestionnaire ».
- **Nouvelle clé de récupération** : session récente → nouvelle clé (écrans 3 et 4 de §3.1) → l'ancienne ne sert plus.

### 3.6 Suppression du compte et export

- **Supprimer** : écran de §21.12 inchangé (ce qui est supprimé, ce qui reste), case « Effacer aussi les données de cet appareil », **geste de passkey** à la place du mot de passe (session récente), `InlineConfirm`. Après : `signalUnknownCredential` pour chaque passkey du compte, puis « Compte supprimé. Supprimez aussi la passkey « {pseudo} » de votre gestionnaire si elle y est encore. »
- **Exporter** : inchangé (§21.15.4, point 10), sans adresse ni double authentification ; s'ajoutent les passkeys (mois d'ajout, liée ou synchronisable, avec ou sans PRF ; jamais de clé publique utile à l'utilisateur, mais incluse en base64url pour la portabilité).

---

## 4. Prise en charge réelle de PRF (recherche du 22 novembre 2026)

Recherche faite sur sources publiques ; plusieurs sont secondaires (blogs, suivis de bogues, forums) et se contredisent parfois. **À recontrôler sur appareils réels avant ouverture** (§14, test manuel bloquant).

| Plateforme ou gestionnaire | PRF | Synchronisée (même sortie partout) | Notes |
|---|---|---|---|
| Chrome / Edge ordinateur | oui depuis 116 | selon le gestionnaire | PRF **à la création** sous Windows seulement depuis Chrome 147 ; avant, deuxième geste (§3.1, 2 bis) |
| Chrome Android + Gestionnaire de mots de passe Google | oui | oui | le cas le plus fiable selon toutes les sources |
| Safari macOS 15 / iOS 18 + trousseau iCloud | oui | oui à partir d'**iOS / iPadOS 18.4 et macOS 15.4** | de 18.0 à 18.3, sortie différente entre usage local et hybride ; un message de forum signale à nouveau l'écart sous iOS 26.3.1 : **risque R6** |
| Firefox ordinateur | oui depuis 135 (Windows) / 139 | selon le gestionnaire | un bogue ouvert signale PRF absent sous macOS ; à vérifier |
| Firefox Android | corrigé en 149 selon le suivi de Mozilla | — | à vérifier ; **WebView Android : non** |
| Windows Hello | oui depuis la mise à jour cumulative de février 2026 (24H2, 25H2) ; Firefox 148, Chrome 147 | **non** (liée à la machine, TPM) | sans cette mise à jour : pas de PRF → repli §5.5 |
| Clés physiques (YubiKey ≥ 5.2, `hmac-secret`) | oui | non (liée à la clé) | places de passkeys découvrables limitées sur les anciens modèles |
| Hybride (QR) | oui | suit le gestionnaire du téléphone | voir l'écart iCloud ci-dessus |
| Bitwarden | oui (signalé par plusieurs sources) | oui | — |
| 1Password | **incertain** (sources contradictoires, problèmes signalés en 2026 dans les extensions Chrome et Firefox) | — | traité comme « peut manquer » : repli §5.5 |

Conclusion : PRF est présent chez la grande majorité des personnes (iPhone récent, Android, Chrome), mais **pas partout** (Windows non mis à jour, 1Password, WebView, anciens iOS). Le repli par la clé de récupération est donc **nécessaire**, et c'est une raison de plus de la rendre obligatoire (Q1).

Sources : [matrice PRF (projet stacks-passkey-wallet, juillet 2026)](https://raw.githubusercontent.com/DeOrganized/stacks-passkey-wallet/HEAD/docs/prf-support-matrix.md) ; [Corbado, « Passkeys & WebAuthn PRF »](https://www.corbado.com/blog/passkeys-prf-webauthn) (lu par extraits de recherche, l'hôte n'est pas joignable depuis cet environnement) ; [Chromium, Intent to Ship: WebAuthn PRF extension](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI) ; [Mozilla bug 1958716 (PRF sur Android)](https://bugzilla.mozilla.org/show_bug.cgi?id=1958716) ; [Mozilla bug 1985777](https://bugzilla.mozilla.org/show_bug.cgi?id=1985777) ; [Mozilla bug 1863819](https://bugzilla.mozilla.org/show_bug.cgi?id=1863819) ; [WebKit bug 311099](https://bugs.webkit.org/show_bug.cgi?id=311099) ; [Apple Developer Forums 764730 (sortie PRF différente en hybride)](https://developer.apple.com/forums/thread/764730) ; [Apple Developer Forums 774112](https://developer.apple.com/forums/thread/774112) ; [Apple, ASAuthorizationPublicKeyCredentialPRFRegistrationInput](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfregistrationinput-swift.struct) ; [Apple, ASAuthorizationPublicKeyCredentialPRFAssertionInput](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct) ; [Bitwarden, Windows Hello et PRF](https://community.bitwarden.com/t/encryption-prf-via-windows-hello-passkey/94236/21) ; [1Password Community, prise en charge de PRF](https://www.1password.community/discussions/1password/prf-support/153278) ; [1Password Community, extension non conforme](https://www.1password.community/developers-69/browser-extension-webauthn-prf-extension-not-spec-compliant-24672) ; [Android, GetPublicKeyCredentialOption](https://developer.android.com/reference/androidx/credentials/GetPublicKeyCredentialOption) ; [Android, Sign in with a passkey](https://developer.android.com/identity/passkeys/sign-in-with-passkeys) ; [go-webauthn, versions](https://github.com/go-webauthn/webauthn/releases).

---

## 5. Modèle cryptographique (appareil)

Aucune construction maison. HKDF-SHA-256 du moteur Rust (RustCrypto `hkdf`, `sha2`), AES-256-GCM de WebCrypto sur le site (RustCrypto `aes-gcm` dans les apps), aléa de `crypto.getRandomValues` (système dans les apps), codage base32 de Crockford dans le moteur. Même répartition qu'aujourd'hui (`engine/vectors/README.md`, `compte.json`) : le site chiffre, le moteur dérive, les deux sont prouvés par un nouveau fichier `engine/vectors/compte-v3.json` (un changement de format demande un nouveau fichier, règle du README). Libellés en `shhdrop/v3/compte/…` pour tout ce qui est nouveau ; ceux qui ne changent pas gardent leur libellé v2.

### 5.1 Éléments

| Élément | Création | Où il vit |
|---|---|---|
| `h` | 16 octets tirés par le serveur à `inscription/debut` ; c'est `user.id` de WebAuthn | serveur (clé), appareil |
| `K_compte` | 32 octets aléatoires tirés par l'appareil à la création ; **jamais changé** (§5.6) | mémoire ; IndexedDB enveloppée par une clé WebCrypto non extractible si « Rester connecté » ou appareil sans PRF (§5.5) ; trousseau du système dans les apps |
| `E_prf` | SHA-256(UTF-8 « shhdrop/v3/compte/prf/1 »), 32 octets, public, fixe (le `/1` permet une rotation) | constante ; envoyée dans `prf.eval.first` |
| `sel_prf` | SHA-256(UTF-8 « WebAuthn PRF » ‖ 0x00 ‖ `E_prf`) : ce que l'authentificateur reçoit en `hmac-secret` (calcul fait par le navigateur, défini par WebAuthn niveau 3) | constante des vecteurs, pour les apps (§10.1) |
| `P_i` | `prf.results.first` de la passkey `i` pour `E_prf`, 32 octets | mémoire, le temps d'ouvrir ou de faire l'enveloppe |
| `KEK_i` | HKDF(`P_i`, sel vide, info = « shhdrop/v3/compte/enveloppe/prf », 32) → AES-256-GCM | mémoire |
| `Env_i` | nonce (12) ‖ AES-256-GCM(`KEK_i`, nonce, `K_compte`, AD = « SHH-CENV2 » ‖ `h` ‖ SHA-256(`cred_id_i`)) = **60 octets** | serveur, ligne de la passkey `i` |
| `R` | clé de récupération : 16 octets aléatoires | chez la personne seulement ; montrée une fois |
| `R_texte` | base32 de Crockford de `R` (128 bits → 26 caractères, les 2 bits de bourrage de fin à zéro, refusés sinon) ‖ caractère de contrôle (valeur de `R` comme entier gros-boutiste, mod 37, alphabet `0-9A-Z*~$=U`) = 27 caractères ; affichage en groupes de 4 séparés par « - » ; saisie normalisée (majuscules, blancs et tirets retirés, `I`/`L` → `1`, `O` → `0`) | écran, fichier `.txt` téléchargé |
| `A_r` | HKDF(`R`, sel vide, info = « shhdrop/v3/compte/recup/acces », 32) | envoyé à `recup` |
| `v_r` | SHA-256(`A_r`) | serveur, **index unique** (la clé seule retrouve le compte) |
| `KEK_r` | HKDF(`R`, sel vide, info = « shhdrop/v3/compte/recup/enveloppe », 32) → AES-256-GCM | mémoire |
| `Env_r` | nonce (12) ‖ AES-256-GCM(`KEK_r`, nonce, `K_compte`, AD = « SHH-CENV2 » ‖ `h` ‖ « recup ») = 60 octets | serveur |
| `K_prive` | HKDF(`K_compte`, « shhdrop/v2/compte/blob ») (**inchangé**) | mémoire |
| `K_profil` | HKDF(`K_compte`, « shhdrop/v3/compte/profil ») (**changé** : était HKDF(`s_profil`, « shhdrop/v2/compte/profil »), §8) | mémoire |
| `K_etiquette` | HKDF(`K_compte`, « shhdrop/v2/compte/appareil ») (**inchangé**) ; chiffre aussi le libellé d'une passkey (même format de 64 octets) | mémoire |
| `B_prive`, `B_profil` | formats « SHH-ACCT1 » et « SHH-PROF1 » **inchangés** (AD, paliers 4 à 256 Kio, `gen`) | serveur |

- **Pourquoi HKDF et pas Argon2id** : `P_i` et `R` sont des secrets aléatoires de 256 et 128 bits ; Argon2id n'ajoute rien (règle de §37.2 et de `K_lien`, §29). Le site n'exécute plus Argon2id pour le compte (1 à 3 s gagnées par connexion sur téléphone).
- **Pourquoi `v_r` = SHA-256 et pas HMAC à clé du serveur** : 128 bits aléatoires ne se devinent pas, même avec la base ; recherche par index sur une empreinte que l'attaquant calcule lui-même, donc aucune fuite de temps (§37.11 A-G11, §29.8). La clé du serveur n'entre pas dans la récupération : sa perte ne perd plus les comptes (§7.4).
- **AD de l'enveloppe PRF** : `SHA-256(cred_id)` lie l'enveloppe à sa passkey (une enveloppe recopiée sur une autre ligne ne s'ouvre pas) ; `h` la lie au compte.

### 5.2 Création (côté appareil)

1. `create` (§6.2) → si `prf.results.first` présent : `P` ; sinon si `prf.enabled` : `get` sur cette seule passkey (geste 2 bis) → `P` ; sinon : passkey sans PRF (§5.5).
2. Tirer `K_compte`, `R`. Calculer `Env_i` (si `P`), `A_r`, `v_r`, `Env_r`, `B_profil` (pseudo, langue ; photo vide), `B_prive` (historique local si la personne l'accepte, sinon vide).
3. Écrans 3 et 4, puis `inscription/fin`. Effacer `P`, `R`, `A_r`, `KEK_*` de la mémoire au mieux (§18.4).

### 5.3 Connexion

`get` (découvrable, `prf.eval.first = E_prf`) → `connexion/fin` rend `cred_id`, `env` (ou `null`), les coffres → `K_compte` ← `Env_i` avec `P_i`. Échec de l'ouverture (étiquette GCM fausse : sortie PRF différente) ou `env` nul : clé locale de l'appareil si elle existe (§5.5), sinon clé de récupération demandée une fois. Retour en arrière du coffre : règle de §37.2 inchangée (plus grand `gen` vu).

### 5.4 Récupération

`R_texte` → contrôle local → `A_r` → `recup` → `{ h, env_r, coffres }` → `K_compte` ← `Env_r` (une étiquette fausse ici veut dire une base altérée : erreur franche).

### 5.5 Quand PRF manque

Une passkey sans PRF **authentifie** (session) mais n'**ouvre** rien. Sur un tel appareil :
- première fois : la clé de récupération est demandée **une fois** ; `K_compte` est ensuite gardée sur l'appareil, enveloppée par une clé AES-GCM **non extractible** de WebCrypto (IndexedDB `shhdrop-compte`, module `web/src/account/persist.ts` existant), **même sans « Rester connecté »** (sinon chaque rechargement redemanderait la clé) ; dans les apps, trousseau du système (Keychain, Keystore) ;
- protection honnête : celle du verrouillage de l'appareil (même phrase que §33) ; dit à l'écran : « Sur cet appareil, vos données s'ouvrent grâce à une clé gardée ici. »
- « Se déconnecter » efface cette clé locale : la prochaine fois, la clé de récupération est redemandée (dit sur le bouton) ;
- **jamais de repli silencieux** : l'écran dit toujours pourquoi la clé de récupération est demandée.

Si, à la création, la passkey n'a pas PRF : rien ne change pour la personne (elle note la clé de toute façon) ; le premier appareil garde `K_compte` localement comme ci-dessus.

### 5.6 Ce qui n'est **pas** prévu (simplicité, signalé)

- **Rotation de `K_compte`** (« Révoquer et rechiffrer » de §37.6) : retirée. Elle ne protège que d'un attaquant qui aurait obtenu `K_compte` **et** pourrait encore lire les coffres sur le serveur ; or retirer la passkey ou changer la clé de récupération lui ôte toute session. Reste le cas d'un serveur malveillant allié au voleur : il lit déjà les métadonnées, et ne lit les coffres qu'avec `K_compte` volée avant. **Faible** ; pourra revenir si un besoin apparaît.
- **Plusieurs clés de récupération** : une seule.

---

## 6. Serveur

### 6.1 Bibliothèque WebAuthn

- **`github.com/go-webauthn/webauthn`**, version **v0.18.2** (publiée le 19 septembre 2026, plus de 7 jours : règle §24), licence BSD-3-Clause **à revérifier**, épinglée dans `go.mod`, notée dans `THIRD_PARTY_LICENSES.md`, `govulncheck` vert. Elle ne fait que vérifier des signatures avec la bibliothèque standard de Go (ECDSA, RSA, Ed25519) : aucune crypto maison.
- **Revue de chaîne d'approvisionnement à faire avant ajout** (tâche S1 du plan) : elle tire, d'après ses `go.mod` habituels, `github.com/go-webauthn/x`, `github.com/fxamacker/cbor/v2`, `github.com/golang-jwt/jwt/v5` (métadonnées FIDO), `github.com/google/go-tpm` (attestation TPM), `github.com/google/uuid` (déjà indirect ici). Avec l'attestation « none », le code TPM et les métadonnées ne servent pas mais sont compilés : liste exacte relevée par `go mod graph`, chaque module noté (mainteneurs, licences, avis connus) ; refus si un module n'est pas acceptable, **sans** repli maison (on ne réécrit pas la vérification WebAuthn).
- **Signalement (faible, simplicité)** : la bibliothèque sait tout faire (attestation, métadonnées, conditions) ; on n'en utilise que `BeginRegistration`/`CreateCredential` et `BeginDiscoverableLogin`/`ValidateDiscoverableLogin`, avec une configuration figée (§6.2). Test : toute autre configuration fait échouer le démarrage.

### 6.2 Paramètres des cérémonies

| Paramètre | Valeur |
|---|---|
| `rp.id` | hôte de `SHH_ORIGIN` (variable existante, `server/internal/config/config.go`) ; **définitif** : changer de domaine rend toutes les passkeys inutilisables (R1) |
| `rp.name` | « Shhgone » (nom à fixer avec R24) |
| Origines acceptées | `SHH_ORIGIN` ; plus, quand les apps existeront, `SHH_WEBAUTHN_ORIGINES_APPS` : origines Android exactes `android:apk-key-hash:<base64url du SHA-256 du certificat de signature>` (l'app iOS présente l'origine `https://<rp.id>`). Rien d'autre (ni sous-domaine, ni `http` hors boucle locale) |
| `user.id` | `h` ; `user.name` et `user.displayName` : mis par le **client** (le serveur ne les vérifie pas et ne les voit pas) : pseudo (Q6) |
| `authenticatorSelection` | `residentKey: "required"`, `userVerification: "required"` ; **aucun** `authenticatorAttachment` ni `hints` (téléphone, ordinateur, QR et clé physique permis) |
| `attestation` | `"none"` |
| Algorithmes | `-7` (ES256), `-8` (EdDSA), `-257` (RS256, Windows Hello) |
| Extensions | `prf: { eval: { first: E_prf } }` (le serveur ne lit pas la réponse PRF : elle n'y est pas, le navigateur la rend au script seulement) ; `credProps` pour savoir si la passkey est découvrable |
| Défi | 32 octets `crypto/rand`, usage unique, **5 min** (contrainte Safari §3), en mémoire, clé = SHA-256 de l'`etape` (jeton de 32 octets rendu au client, comme aujourd'hui) ; au plus 20 000 défis vivants (au-delà : 503 `busy`), table ajoutée à `allowedMaps` |
| `allowCredentials` | vide à la connexion (découvrable) ; passkeys du compte pour `reauth` et pour obtenir PRF après `create` |
| `excludeCredentials` | vide à l'inscription ; passkeys du compte à l'ajout |
| Compteur de signatures | **ni lu ni gardé** (les passkeys synchronisées rendent 0 ; le garder daterait chaque connexion) : valeur stockée passée à 0 à chaque vérification, avertissement de clonage ignoré |
| Drapeaux | `UV` exigé ; `BE` (passkey synchronisable) **gardé** : go-webauthn refuse une connexion dont `BE` diffère de l'enregistrement, et l'écran en a besoin (« liée à cet appareil ») ; `BS` (sauvegardée maintenant) ni gardé ni montré |

### 6.3 Ce que garde le disque (`comptes.db`, schéma 3 ; mêmes règles qu'aujourd'hui : BLOB et INTEGER seulement, dates au jour ou au mois, `secure_delete`, `WITHOUT ROWID`)

| Table | Colonnes | Pourquoi |
|---|---|---|
| `comptes` | `h` BLOB(16) clé ; `p_empreinte` BLOB(32) unique ; `pseudo_jour` ; `v_r` BLOB(32) unique ; `env_r` BLOB(60) ; `blob_profil`, `gen_profil` ; `blob_prive`, `gen_prive` ; `cree_jour` ; `compte_des` ; `vu_mois` | **retirées** : `e_canon`, `e_envoi`, `v_mdp`, `env_mdp`, `cle_profil`, `totp`, `totp_retrait_jour`, `recup_jour` |
| `passkeys` | `cred_id` BLOB(1 à 1 023) clé ; `h` BLOB(16) → `comptes` `ON DELETE CASCADE` ; `cle_pub` BLOB (COSE, ≤ 1 024) ; `alg` INTEGER ; `be` 0/1 ; `env` BLOB(60) NULL ; `etiquette` BLOB(64) NULL (chiffrée par l'appareil) ; `ajoutee_mois` INTEGER | connexion, enveloppe, liste. **Jamais** : AAGUID (modèle du gestionnaire), transports, attestation, compteur, `BS`, date de dernier usage |
| `sessions` | inchangée, plus `par_recup` 0/1 | montrer aux autres appareils qu'une session vient de la clé de récupération (R4) |
| `bannis` | `id` BLOB(8) ; **`h` BLOB(16)** → `comptes` `ON DELETE CASCADE` (remplace `e_canon`) ; `debut_jour` ; `jusqu_jour` ; `actif` ; `motif` ; `salons_fermes` | il n'y a plus d'adresse à bannir (R2) |

Limites : 10 passkeys par compte ; 20 sessions (inchangé).

**Jamais sur disque** : sortie PRF, `K_compte`, `R`, `A_r`, pseudo affiché, photo en clair, `p_canon`, AAGUID, IP, en-têtes, heure.

### 6.4 Routes (`/api/compte/`, règles de §8.6 inchangées : JSON strict, base64url sans bourrage, longueurs exactes, rien dans l'URL)

Les objets WebAuthn suivent les formats JSON de WebAuthn niveau 3 (`PublicKeyCredentialCreationOptionsJSON`, `RegistrationResponseJSON`, `AuthenticationResponseJSON`), ceux que lisent go-webauthn et les API natives (§10). Erreur commune `identifiants` (403, même corps) pour passkey inconnue, signature fausse, `userHandle` qui ne correspond pas, clé de récupération inconnue.

| Route | Authentification | Corps | Réponse |
|---|---|---|---|
| `POST inscription/debut` | ALTCHA (champs de `POST /api/shares`) | `{ altcha, hp, shown_at }` | `{ etape, options }` (`user.id` = `h`) |
| `POST pseudo/verifier` | étape ou session (inchangée) | `{ etape?, p_canon }` | `{ libre }` ; libre → **réservé à l'étape** jusqu'à son échéance (évite une passkey créée pour un pseudo pris entre-temps) |
| `POST inscription/fin` | étape | `{ etape, credential, p_canon, env, v_r, env_r, blob_profil, blob_prive, persistante, etiquette, cred_etiquette }` (`env` : chaîne ou `null`) | 201 `{ session, h }` ; `pseudo_pris` (409, étape gardée) |
| `POST connexion/debut` | — | `{}` | `{ etape, options }` |
| `POST connexion/fin` | étape | `{ etape, credential, persistante, etiquette }` | `{ session, h, cred_id, env, blob_profil, gen_profil, blob_prive, gen_prive }` ; met `vu_mois` à jour |
| `POST recup` | `A_r` | `{ a_r, persistante, etiquette }` | `{ session, h, env_r, blob_profil, gen_profil, blob_prive, gen_prive }` (session **récente**) |
| `POST reauth/debut`, `reauth/fin` | session | `{}` puis `{ etape, credential }` | `{ options }` puis `{}` (session récente, 5 min) ; la passkey doit être du compte |
| `GET passkeys` | session | — | `{ passkeys: [{ cred_id, ajoutee: "2026-11", etiquette, be, prf, courante }] }` |
| `POST passkeys/debut`, `passkeys/fin` | session récente | `{}` puis `{ etape, credential, env, etiquette }` | `{ options }` puis `{}` |
| `POST passkeys/enveloppe` | session | `{ cred_id, env }` | `{}` (PRF obtenue par un `get` après le `create`, ou plus tard sur un appareil qui l'offre) |
| `POST passkeys/nommer` | session | `{ cred_id, etiquette }` | `{}` |
| `POST passkeys/retirer` | session récente | `{ cred_id }` | `{}` ; `derniere` (409) pour la dernière |
| `POST recup/renouveler` | session récente | `{ v_r, env_r }` | `{}` |
| `GET /api/compte` | session | — | comme aujourd'hui, **sans** `totp`, `recup_jusqu`, `retrait_totp_le` |
| `sessions`, `sessions/fermer`, `sessions/etiquette`, `deconnexion`, `coffre/*`, `pseudo`, `pseudo/libre`, `export`, `salons`, `salons/detruire` | inchangées | | |
| `POST supprimer` | session récente | `{}` | `{ salons_fermes }` (plus d'attente `attente`) |
| **Retirées** | `inscription/renvoyer`, `connexion` (mot de passe), `connexion/totp`, `oubli/*`, `reauth` (mot de passe), `mdp`, `email/*`, `totp/*` | | |

Règle de §8.5 inchangée : `X-Shh-Session` ne part que vers `/api/compte/*` et `POST /api/salons`.

### 6.5 Fichiers servis pour les apps (plus tard, quand une app existe)

- `/.well-known/apple-app-site-association` : `{ "webcredentials": { "apps": ["<TEAMID>.<identifiant de l'app>"] } }`, `Content-Type: application/json`, sans redirection, sans extension.
- `/.well-known/assetlinks.json` : relation `delegate_permission/common.get_login_creds`, nom du paquet et empreinte SHA-256 du certificat de signature.
- Fichiers statiques du site, construits depuis la configuration ; ils ne disent rien des personnes (Apple et Google les lisent depuis leurs propres serveurs). Test : présents seulement si les identifiants d'app sont configurés, sinon 404 comme une route inconnue.
- `Permissions-Policy` : ajouter `publickey-credentials-create=(self), publickey-credentials-get=(self)` explicitement (aujourd'hui permis par défaut, `server/internal/api/headers.go`), et `()` sur `/pdf-frame.html` (signalement de §37.9 repris).

### 6.6 Ce que voit le serveur (remplace S64 à S66, S70, S73, S75, S78 de §14 et §21.16)

| # | Ce qu'il voit | Exposition | Réduction |
|---|---|---|---|
| S83 | Clé publique et identifiant de chaque passkey, algorithme, `BE`, mois d'ajout | disque | aucune donnée d'identité ; clé publique utile à rien d'autre |
| S84 | AAGUID (modèle du gestionnaire : iCloud, Google, 1Password…) et transports | dans la requête d'enregistrement, en direct | jamais gardés ni journalisés ; test |
| S85 | Usage de la clé de récupération | en direct ; `v_r` au repos | aucune date d'usage gardée |
| S86 | Pseudo canonique `p_canon` | dans la requête (inchangé, S76) | seulement `p_empreinte` au repos |
| S75 | ~~profil séquestré~~ | **supprimée** (§8) | — |

---

## 7. Abus sans e-mail

### 7.1 Ce que coûte un compte

Avant : une adresse confirmée non jetable. Maintenant : une preuve de travail et un geste de passkey, qu'un programme peut simuler (authentificateur logiciel ; l'attestation « none » ne prouve aucun matériel, et l'exiger exclurait les gestionnaires synchronisés). **Signalement (élevée, objectif du compte, R2)** : la raison d'être de D42-26 (« un compte qui coûte un peu à recréer ») s'affaiblit ; un banni recrée un compte en une minute. Ce qui reste comme frein : le **palier neuf** (1 salon, 4 places, 24 h pendant 7 jours), la preuve de travail, les quotas ci-dessous.

### 7.2 Limites (toutes en mémoire, par `server/internal/limits` : clés HMAC du jour pour les connexions, aucune IP sur disque ; nouvelles tables dans `allowedMaps`)

| Quoi | Limite |
|---|---|
| `inscription/debut` | ALTCHA ; difficulté qui **double** après chaque compte créé par la même connexion dans la journée ; 20 par heure par connexion |
| Comptes créés (`inscription/fin`) | 3 par jour par connexion, 10 par /48 (inchangé) ; **plafond global de 500 par jour** (coupe-circuit contre une ferme d'adresses, 503 `busy`, réglable `SHH_COMPTES_JOUR`) ; `SHH_COMPTES_MAX` inchangé |
| `connexion/debut` | 60 par minute par connexion (sans preuve : la connexion doit rester un clic) ; défis vivants bornés (§6.2) |
| `connexion/fin` | 20 échecs par heure par connexion, 60 par /48 |
| `recup` | 10 essais par heure par connexion, 30 par /48 (128 bits : la limite protège la machine, pas la clé) |
| `pseudo/verifier`, `pseudo/libre` | inchangés (30 par heure, 90 par /48) |
| Passkeys | 10 par compte ; `passkeys/debut` 10 par heure par compte |

### 7.3 Prise de pseudos en masse

Bornée par les quotas (3 comptes par jour et par connexion, 500 par jour en tout) et la preuve de travail croissante. Pas de délai avant le premier salon (contraire à la demande de simplicité). Pas de « libération de pseudo » par le fondateur en V1 (Q5 bis) : un pseudo ne prouve rien (R7 de la conception du compte), le préjudice est faible.

### 7.4 Bannissement sans adresse

- Clé du bannissement : `h` (le compte), plus d'adresse ; « Bannir par adresse » et « Recherche par adresse » disparaissent du tableau de bord (§21.14.4) ; « Bannir par lien de salon » et « par salon signalé » restent.
- **Recours** : la personne connectée voit l'identifiant `B-…` et le motif ; elle écrit à l'adresse de contact en donnant cet identifiant ; le fondateur agit par l'identifiant (`shhdrop admin bannis … <id>`). Rien de plus à garder.
- Supprimer un compte banni efface le bannissement (cascade) : il ne protégeait plus rien, puisqu'un nouveau compte se crée sans coût.
- `K_serveur` ne sert plus qu'à `K_pseudo` : sa perte perd l'unicité des pseudos (index illisible, à reconstruire au fil des changements de pseudo), **pas les comptes**. Sauvegarde hors ligne gardée.

---

## 8. Ce qui disparaît

| Élément | Où (code existant) | Raison |
|---|---|---|
| Adresse e-mail, normalisation, domaines jetables, `e_canon`, `e_envoi` | `engine/core/src/compte.rs` (`normaliser`, `sel`), `server/internal/compte/adresse.go`, `jetables*.go/txt`, vecteurs `normaliser` et `sel` | plus d'e-mail |
| Mot de passe, Argon2id du compte, `A_auth`, `v_mdp`, `Env_mdp`, règles du mot de passe | `compte.rs` (`deriver`, `mot_de_passe_valide`), `web/src/routes/compte/MotDePasse.svelte`, `ReglesMdp.svelte` | remplacé par la passkey ; Argon2id reste dans le moteur pour les partages protégés par mot de passe |
| Fournisseur d'e-mails (D1), SMTP, relais `shhcheck relais`, exception de `TestNoOutgoingHTTP`, secrets SMTP, enregistrements SPF/DKIM/DMARC | `server/internal/courriel/`, `server/internal/stats_test.go`, `deploy/` | **le serveur revient à « aucune sortie »** : gain de sécurité et d'exploitation net |
| Codes envoyés, renvois, quotas d'e-mails (S4), file d'envoi | `etapes.go`, `limits` | idem |
| TOTP (double authentification) | `server/internal/compte/totp.go`, routes `totp/*`, `K_totp` | une passkey vérifiée (`UV`) est déjà deux facteurs (l'appareil et le visage, le doigt ou le code) ; la garder n'ajouterait qu'une étape. **Recommandé : retirée** (Q4) |
| Récupération par e-mail (`oubli/*`), attente de 7 jours après récupération (`recup_jour`), retrait de TOTP après 7 jours (`totp_retrait_jour`) | `oubli.go` | leur raison d'être était la **boîte mail volée** (elle devenait la clé du compte, R4) ; une clé de 128 bits que seule la personne détient n'a pas ce défaut. Pas d'attente (Q10 pour le renouvellement de la clé) ; le signalement juridique de l'attente avant suppression (RGPD art. 12.3) disparaît |
| **Séquestre du profil** `s_profil`, `cle_profil`, `K_sequestre` | `server/internal/compte/sequestre.go`, `compte.rs` (`cle_profil`), `web/src/account/keys.ts` | il ne servait qu'à rendre le profil **après une récupération par e-mail sans mot de passe**. Sans e-mail, la récupération passe par `R`, qui ouvre `K_compte` : le profil peut être chiffré par `K_compte` comme le coffre privé. Le séquestre n'apporterait plus qu'un cas (passkey sans PRF, clé perdue, profil seul rendu), qui ne vaut pas de donner au serveur la lecture des pseudos, photos et réglages. **Recommandé : supprimé** (Q3). Effets : l'exception R2 à CLAUDE.md (« aucune clé en clair sur le serveur ») **n'a plus lieu d'être** ; R5 (pass lisible) déjà réglé par DP-8, inchangé ; S75 supprimée ; la note de confidentialité du profil (§21.15.3) devient « Votre pseudo, votre photo et votre abonnement sont chiffrés sur vos appareils : le service ne peut pas les lire. » |
| Deux coffres | — | **gardés** (formats, `gen` et routes existants, écritures indépendantes) ; seul `K_profil` change de source |
| « Rester connecté » | `persist.ts` | **gardé** (D7) ; moins utile (se reconnecter coûte un geste), toujours décoché par défaut |
| Promesse « Ni e-mail » sur le site | `fr.ts`/`en.ts` `home.priv.account.p`, `content.ts` | redevient vraie ; les textes du lot 16 (« une adresse e-mail que nous ne gardons pas en clair ») sont à remplacer par « Pour créer un salon, un compte sans e-mail ni mot de passe, par passkey. » |

**Pass payant (DP-8)** : déjà rangé dans le coffre privé (`web/src/account/pass.ts`) : rien à changer ; il devient récupérable par la clé de récupération, plus jamais par le serveur.

---

## 9. Sur l'appareil (site)

- `web/src/account/` reste seul détenteur du jeton et de `K_compte` ; nouveau `webauthn.ts` (appels `create`/`get`, conversion JSON niveau 3 avec `PublicKeyCredential.parseCreationOptionsFromJSON` quand il existe, sinon conversion base64url locale ; lecture de `prf.results` et `credProps`) et `recup.ts` (saisie, contrôle, appels au moteur).
- Détection : `PublicKeyCredential` absent → « Ce navigateur ne gère pas les passkeys. Tout Shhgone marche sans compte ; seule la création de salon en demande un. » ; `PublicKeyCredential.getClientCapabilities()` sert seulement à annoncer d'avance le deuxième geste, jamais à refuser.
- Le repli reCAPTCHA (§26) reste possible sur `inscription/debut` : `K_compte` n'est tirée qu'après le geste de passkey.
- Aucun `mediation: "conditional"` (remplissage automatique) : il demande un champ d'identifiant, que nous n'avons plus ; le bouton suffit.

## 10. Apps natives futures (D42-20)

### 10.1 Compatibilité

| Point | iOS (`AuthenticationServices`) | Android (`androidx.credentials`, Credential Manager) |
|---|---|---|
| Passkeys | `ASAuthorizationPlatformPublicKeyCredentialProvider` (iOS 16+) ; clés physiques par `ASAuthorizationSecurityKeyPublicKeyCredentialProvider` | `CreatePublicKeyCredentialRequest` / `GetPublicKeyCredentialOption` avec le **JSON WebAuthn** que rend notre serveur (mêmes routes, mêmes objets) |
| Même passkey que le site | oui, si l'app déclare `webcredentials:<rp.id>` et que le site sert l'AASA (§6.5) | oui, avec `assetlinks.json` (§6.5) |
| Origine vue par le serveur | `https://<rp.id>` | `android:apk-key-hash:…` → à ajouter aux origines acceptées (§6.2) |
| PRF | iOS 18+ (`ASAuthorizationPublicKeyCredentialPRFRegistrationInput`, `…AssertionInput`) | passé dans le JSON des extensions ; rendu selon le fournisseur (Gestionnaire Google : oui sur Chrome Android ; **depuis une app : non confirmé par la recherche**) |
| QR (hybride) | proposé par le système | proposé par le système |
| Garde locale de `K_compte` | Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) | Keystore |

**Signalement (moyenne, exactitude, R5)** : il faut prouver que les API natives appliquent le même hachage « WebAuthn PRF » ‖ 0x00 ‖ entrée que le navigateur ; sinon l'enveloppe faite sur le site ne s'ouvre pas dans l'app. Correction : les vecteurs donnent `E_prf` **et** `sel_prf` ; le premier prototype d'app ouvre une enveloppe créée sur le site avec la même passkey (test manuel sur iPhone et Android, avant tout autre travail d'app). Si une API attend le sel brut, l'app passe `sel_prf` (calculé par le moteur).

**Flutter** : pas de greffon tiers pour les passkeys ; un petit canal de plateforme vers les API du système (moins de dépendances, aucune crypto dans le canal : la sortie PRF va au moteur Rust).

### 10.2 Ce qui ne marche que dans le navigateur (signalé)

- clé non extractible de WebCrypto (apps : trousseau du système) ;
- `getClientCapabilities`, `parseCreationOptionsFromJSON` (apps : `isSupported` des sorties PRF, JSON natif) ;
- `signalUnknownCredential` et `signalCurrentUserDetails` (navigateurs récents ; équivalents natifs à vérifier, par exemple `ASCredentialUpdater` sous iOS récent) : toujours doublés d'un texte « supprimez-la de votre gestionnaire » ;
- la démo GitHub Pages (§11).

Rien dans les formats (enveloppes, clé de récupération, routes, JSON) ne dépend du navigateur.

## 11. Démo GitHub Pages

Aujourd'hui essayable avec un faux serveur (§22 de la conception du compte). Une vraie passkey de la démo serait enregistrée pour `skoow.github.io` dans le gestionnaire de la personne et y resterait. **Recommandé (Q8)** : en démo, passkey **simulée** (bouton « Simuler la passkey », texte « Dans la démo, aucune passkey n'est créée »), clé de récupération réelle (calculs du moteur), tout le reste comme aujourd'hui. Les e2e de démo restent sans authentificateur.

## 12. Juridique (pour le juriste ; complète `docs/ouverture-comptes.md` §2.1)

| Donnée | Collectée ? | Catégorie (décret 2021-1362, numérotation à vérifier par le juriste) | Durée de conservation possible |
|---|---|---|---|
| Identité civile (nom, adresse e-mail, téléphone) | **plus rien** | art. 2 (5 ans si collectée) | — : l'obligation de 5 ans ne s'applique plus, puisque rien n'est collecté (art. 8 du décret ; CE 30 juin 2023, n° 459724) |
| Pseudonyme | `p_canon` reçu dans la requête, `p_empreinte` gardée ; pseudo affiché chiffré, **illisible par le serveur** (séquestre retiré) | « catégorie 2 » : identifiant et pseudonymes (art. 3) | 1 an après la clôture **si** l'empreinte compte comme « collectée » : question 2 de l'avocat, reformulée |
| Données de vérification | clés publiques des passkeys, `v_r` | « catégorie 2 » : données permettant de vérifier ou modifier l'authentifiant | idem ; à confirmer : une clé publique est-elle une « donnée de vérification du mot de passe » ? |
| Identifiant du compte `h`, dates au jour | oui | art. 3 (identifiant) | idem |
| IP | en mémoire seulement (inchangé) | art. 5 | question 1 de l'avocat, inchangée |

- **Conflit à faire trancher (élevée, inchangé dans sa nature)** : une conservation d'un an après clôture contredirait la suppression immédiate (§21.12). La passkey **réduit** le problème (plus d'identité civile, pseudo illisible) sans l'effacer.
- RGPD : la clé publique et `h` sont des données pseudonymes (considérant 26) : registre, page Confidentialité ; ne jamais écrire « nous n'avons aucune donnée personnelle ».
- Plus de sous-traitant d'envoi (art. 28) ; plus d'attente de 7 jours avant suppression ; mineurs, DSA, TCO, motif de bannissement : inchangés.
- Apple et Google (trousseaux synchronisés) apprennent que la personne a un compte Shhgone et son pseudo (Q6) : c'est leur traitement, pas le nôtre ; à dire dans la page Confidentialité.

---

## 13. Risques (vigilance)

| # | Gravité | Endroit | Problème | Correction |
|---|---|---|---|---|
| R1 | **Élevée**, exploitation | `rp.id` = domaine | changer de domaine (Shhgone ou Shhdrop, R24 de la conception du compte) rend **toutes** les passkeys inutilisables ; les « origines liées » de WebAuthn (`/.well-known/webauthn`) ne sont pas prises en charge partout | domaine définitif choisi **avant** l'ouverture (Q7) ; `rp.id` figé dans un test de configuration ; la clé de récupération permet toujours de recréer une passkey |
| R2 | **Élevée**, objectif | §7.1 | sans e-mail, recréer un compte ne coûte presque rien : le bannissement ne tient qu'au palier neuf | assumé et dit au propriétaire (Q5) ; palier neuf réglable ; preuve de travail croissante, plafond journalier |
| R3 | **Élevée**, perte de données | §3.4 | passkeys et clé perdues = compte et coffres perdus, sans recours | clé obligatoire et vérifiée (Q1) ; bandeau si aucune passkey synchronisable (`be = 0` partout) : « Ajoutez une deuxième passkey ou gardez bien votre clé » |
| R4 | Élevée, sécurité | clé de récupération | qui lit la clé (photo, fichier `.txt` synchronisé dans un nuage, presse-papiers) prend le compte et peut retirer les passkeys du titulaire | texte à l'écran 3 (« Rangez-la hors ligne ou dans votre gestionnaire ») ; usage visible sur les autres appareils connectés : la session ouverte par `recup` est marquée « ouverte par la clé de récupération » dans la liste des appareils (drapeau de la ligne `sessions`, effacé avec elle ; aucune date de plus sur disque) ; renouvellement après usage (Q10) |
| R5 | Moyenne, exactitude | apps, §10.1 | hachage PRF des API natives non prouvé ; PRF depuis une app Android non confirmé | vecteurs `sel_prf` ; test croisé site ↔ app sur appareils avant le travail d'app ; repli §5.5 |
| R6 | Moyenne, exactitude | iCloud et hybride, §4 | sortie PRF différente entre local et QR (iOS 18.0–18.3, écart signalé de nouveau sous iOS 26.3.1) | l'étiquette GCM détecte l'écart ; repli par la clé une fois par appareil ; message clair ; test manuel sur iPhone en QR |
| R7 | Moyenne, exactitude | Safari, §3 | `fetch` entre le clic et `create`/`get` annule la cérémonie | options chargées avant le clic ; défi de 5 min ; test e2e qui vérifie l'absence de requête entre le clic et l'appel |
| R8 | Moyenne, chaîne d'approvisionnement | go-webauthn | 5 à 8 modules de plus, dont du code d'attestation inutilisé | revue S1 avant ajout ; versions exactes ; `govulncheck` ; mise à jour mensuelle |
| R9 | Moyenne, confidentialité | AAGUID, §6.6 S84 | le serveur voit en direct quel gestionnaire la personne utilise | jamais gardé ni journalisé ; test « le serveur ne voit rien » qui cherche l'AAGUID du faux authentificateur dans le disque et les sorties |
| R10 | Moyenne, perte | export ou changement de gestionnaire (échange de passkeys CXP) | le secret PRF peut ne pas suivre la passkey : l'enveloppe ne s'ouvre plus | repli par la clé (§5.5) ; puis `passkeys/enveloppe` refait l'enveloppe avec la nouvelle sortie |
| R11 | Moyenne, exactitude | inscription interrompue, §3.1 | passkey orpheline dans le gestionnaire | `signalUnknownCredential` ; texte ; l'étape reste valable 5 min pour réessayer `inscription/fin` avec le même `credential` |
| R12 | Faible, confidentialité | `user.name`, Q6 | le pseudo est gardé par Apple, Google ou le gestionnaire | choix au propriétaire ; « Compte Shhgone » fixe reste possible (mais plusieurs comptes deviennent indiscernables dans la feuille) |
| R13 | Faible, sécurité | appareil sans PRF, §5.5 | `K_compte` gardée sur l'appareil, protégée seulement par son verrouillage | dit à l'écran ; « Se déconnecter » l'efface ; CSP et Trusted Types existants |
| R14 | Faible, essais | e2e WebKit | aucun authentificateur virtuel dans WebKit | Chromium (CDP `WebAuthn.addVirtualAuthenticator`, `hasPrf`) en CI ; passage manuel sur iPhone et Mac avant ouverture, avec captures |
| R15 | Faible, inutile retiré | §37.6 | rotation de `K_compte`, plusieurs clés de récupération | non repris (§5.6) |
| R16 | Faible, sécurité | `connexion/debut` sans preuve | création massive de défis | borne de 20 000 défis, 60 par minute par connexion |

## 14. Tests (bloquants)

- **Vecteurs** `engine/vectors/compte-v3.json` (moteur Rust natif, WebAssembly, Go pour ce qui le concerne) : `constants` (`E_prf`, `sel_prf`, libellés) ; `enveloppe_prf` (`P`, `h`, `cred_id`, nonce → `Env`) ; `cle_recup` (`R` → `R_texte` ; ≥ 30 saisies : minuscules, espaces, tirets, `I`/`L`/`O`, longueur fausse, contrôle faux, bits de bourrage non nuls, caractère hors alphabet) ; `recup` (`R` → `A_r`, `v_r`, `KEK_r`, `Env_r`) ; `cles` (`K_compte` → `K_prive`, `K_profil`, `K_etiquette`) ; `coffre_profil` avec la nouvelle clé ; `pseudo` repris de `compte.json`. Go rejoue `recup.v_r` et les longueurs. `compte.json` gelé puis retiré avec le code e-mail.
- **Serveur** : `TestSchemaComptes` v3 exact (aucune colonne d'adresse, de mot de passe, de TOTP, de séquestre, d'AAGUID, de compteur) ; cérémonies avec un authentificateur logiciel de test (ES256, EdDSA, RS256), défi rejoué, défi échu, mauvaise origine, mauvais `rp.id`, `UV` absent, `BE` changé, `userHandle` d'un autre compte, onzième passkey, retrait de la dernière, `recup` faux, quotas ; `TestNoOutgoingHTTP` **sans exception** (le paquet `courriel` n'existe plus) ; `allowedMaps` à jour ; `TestAucunSequestre` : aucune route ne rend de quoi ouvrir un coffre.
- **Site** : `web/src/account` (enveloppes, repli sans PRF, deuxième geste, clé locale, saisie de la clé) ; `source-rules.test.ts` : `navigator.credentials` n'apparaît que dans `web/src/account/webauthn.ts` ; aucun `fetch` entre le gestionnaire du clic et `create`/`get`.
- **« Le serveur ne voit rien »** (`web/e2e/compte-sees-nothing.test.ts`, étendu ; `web/ui-e2e/compte.spec.ts` par l'interface réelle, Chromium avec authentificateur virtuel PRF **et** un second sans PRF) : création, connexion, nouvel appareil par la clé, ajout et retrait de passkey, salon créé, suppression. Repères cherchés dans `comptes.db`, son WAL, `shares.db`, le dossier de données, stdout, stderr et toutes les réponses : sortie PRF (lue dans la page par un crochet de test), `K_compte`, `R` sous toutes ses formes (octets, texte, groupé, minuscules), `A_r` (permis dans la seule requête `recup`, jamais sur disque), pseudo affiché, photo, libellés de passkey et d'appareil, AAGUID du faux authentificateur, jeton de session ; aucune requête vers les partages ou le salon (sauf `POST /api/salons`) avec `X-Shh-Session` ; le pseudo affiché n'apparaît dans **aucune** requête (seul `p_canon` part) ; dates multiples de 86 400 ; après suppression : ni `h`, ni `cred_id`, ni clé publique dans les fichiers.
- **Manuel, bloquant pour l'ouverture** (captures jointes) : iPhone (iOS 18.4+) avec iCloud, en local et par QR depuis un PC ; Android avec le Gestionnaire Google ; Windows 11 à jour avec Windows Hello ; Firefox ; une clé physique ; 1Password ou Bitwarden ; un appareil sans PRF (repli).

## 15. Migration et plan de travail

**Migration : aucune.** Le service n'a jamais été ouvert (`deploy.sh` refusait d'installer sans fournisseur d'e-mails, `docs/ouverture-comptes.md` §1) : aucun compte n'existe. Le schéma 3 remplace le schéma 2 ; au démarrage, une base `comptes.db` de schéma 2 **non vide** fait refuser le démarrage avec un message (jamais d'effacement silencieux) ; vide, elle est recréée. Le code du compte par e-mail est retiré, pas gardé « au cas où » (simplicité).

| Lot | Sous-projet | Contenu | Estimation |
|---|---|---|---|
| P1 | Moteur Rust + vecteurs | `compte.rs` : clé de récupération (codage, contrôle, saisie), HKDF des nouvelles clés, `sel_prf` ; retrait de `normaliser`, `sel`, `deriver`, `mot_de_passe_valide`, `cle_profil` (s_profil) ; WebAssembly ; `compte-v3.json` ; README des vecteurs | 1,5 jour |
| S1 | Serveur : revue go-webauthn | `go mod graph`, licences, avis, décision ; épinglage | 0,5 jour |
| S2 | Serveur : compte | schéma 3, `passkeys`, routes §6.4, défis en mémoire, quotas §7.2, bannis par `h`, retrait de `courriel`, `totp`, `oubli`, `adresse`, `jetables`, `sequestre`, relais SMTP de `deploy/` ; tableau de bord (recherche par adresse retirée) ; `Permissions-Policy` ; AASA et `assetlinks.json` conditionnels | 4 jours |
| W1 | Site | `webauthn.ts`, `recup.ts`, écrans §3 (inscription, connexion, clé, vérification, passkeys, récupération, suppression), repli sans PRF, textes FR et EN, textes publics (§8 dernière ligne, page Sécurité « Ce que le compte ne protège pas » : la clé de récupération est la clé du compte) ; retrait des écrans e-mail, mot de passe, TOTP | 4 jours |
| W2 | Démo | faux serveur passkey simulée (§11) | 1 jour |
| T1 | Tests de bout en bout | « le serveur ne voit rien » étendu, parcours par l'interface avec authentificateurs virtuels, passage manuel sur appareils (§14) | 2 jours |
| D1 | Documents | `docs/ouverture-comptes.md` (D1 caduque, juriste mis à jour), §37 de la spécification (renvoi), conception du compte (en-tête « remplacée pour l'identité »), `deploy/README.md` (plus de SMTP) | 0,5 jour |
| | **Total** | | **≈ 13,5 jours** |

Ordre : P1 → S1 → S2 → W1 → W2 → T1 → D1, chaque lot avec ses tests au vert avant le push sur `main`.

## 16. Questions tranchées par le propriétaire le 22 novembre (recommandations toutes retenues ; Q7 : `shhgone.com`)

1. **Q1 — Clé de récupération obligatoire à la création**, vérifiée par un groupe tiré au hasard. Facultative, la création tomberait à 4 actions, mais toute passkey perdue (ou un gestionnaire sans PRF sur un nouvel appareil) ferait perdre le compte. **Recommandé : obligatoire.**
2. **Q2 — Format de la clé** : 27 caractères (128 bits, base32 de Crockford avec contrôle) ou 12 mots. **Recommandé : 27 caractères** (aucune liste de mots ni dépendance, identique dans toutes les langues).
3. **Q3 — Séquestre du profil supprimé**, profil chiffré par `K_compte` : le serveur ne peut plus lire pseudo, photo, réglages ; l'exception à CLAUDE.md du 14 novembre est retirée. **Recommandé : oui.**
4. **Q4 — Double authentification TOTP retirée** (la passkey vérifiée est déjà à deux facteurs). **Recommandé : oui.**
5. **Q5 — Bannissement par compte seulement**, freins : palier neuf de 7 jours, preuve de travail croissante, 3 comptes par jour et par connexion, 500 par jour en tout. **Recommandé : accepter, et observer** ; allonger le palier neuf (14 jours) seulement si des abus apparaissent. Q5 bis : pas de « libérer un pseudo » au tableau de bord en V1 (recommandé).
6. **Q6 — Nom de la passkey dans le gestionnaire** (`user.name`) : le pseudo (lisible, plusieurs comptes distincts, mais connu d'Apple ou Google) ou « Compte Shhgone » fixe. **Recommandé : le pseudo.**
7. **Q7 — Domaine définitif (RP ID)** avant l'ouverture, avec R24 (Shhgone ou Shhdrop). **Recommandé : trancher maintenant** ; ensuite il ne change plus.
8. **Q8 — Démo** : passkey simulée. **Recommandé : oui** (aucune passkey de démo laissée dans le gestionnaire des visiteurs).
9. **Q9 — Appareils sans PRF acceptés** (clé de récupération une fois par appareil, puis clé gardée sur l'appareil, protégée par son verrouillage). **Recommandé : oui** ; les refuser exclurait Windows non mis à jour et certains gestionnaires.
10. **Q10 — Après usage de la clé de récupération** : nouvelle clé proposée (bandeau jusqu'à ce que ce soit fait) ou imposée tout de suite. **Recommandé : proposée** ; l'imposer ajoute une étape à un moment stressant, pour un risque (clé vue en la tapant) que la personne peut juger elle-même. À l'inverse, si la sécurité prime sans réserve : imposée.
11. **Q11 — « Rester connecté »** : gardé tel que codé (décoché, 30 jours sans usage, 90 au plus), alors que se reconnecter ne coûte plus qu'un geste. **Recommandé : gardé** (rien à recoder, utile sur ordinateur).

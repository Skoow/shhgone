# Compte par passkey et clé de récupération, sans e-mail — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Version 1 du 22 novembre 2026.** Conception **validée** : `docs/superpowers/specs/2026-11-22-compte-passkey-design.md` (toutes les recommandations du §16 acceptées par le propriétaire le 22 novembre ; RP ID définitif `shhgone.com` ; bannis : accepter et observer). Elle **remplace**, pour l'identité, la connexion et la récupération, le plan `2026-11-14-compte-email.md` (e-mail, mot de passe, TOTP, séquestre). Le service n'a jamais été ouvert : **aucune migration**, le code du compte par e-mail est **retiré**, pas gardé « au cas où ».

**Goal :** créer un compte avec un pseudo, un geste de passkey et une clé de récupération à noter ; se connecter en un clic et un geste ; récupérer le compte sans e-mail ; sans que le serveur reçoive jamais de quoi ouvrir un coffre (ni sortie PRF, ni clé de récupération, ni `K_compte`) ; même compte sur le site et, plus tard, dans les apps iOS et Android.

**Architecture :** trois sous-projets, dans cet ordre, chacun livrable seul et laissant `main` vert :

1. **Moteur Rust + vecteurs** (lot P1) : `shhdrop_core::compte` (entrée PRF, enveloppes, clé de récupération, clés des coffres tirées de `K_compte`), liaison WebAssembly, `engine/vectors/compte-v3.json` rejoué en Rust natif, en WebAssembly + WebCrypto et en Go. **Fait** (voir l'état du lot).
2. **Serveur Go** (lots S1 à S8) : revue de chaîne d'approvisionnement de go-webauthn **avant** son ajout, schéma 3 de `comptes.db`, cérémonies WebAuthn, routes de la conception §6.4, limites §7.2, bannissement par `h` ; retrait de l'e-mail, de SMTP, du TOTP, du séquestre et des quotas d'e-mails ; déploiement sans relais SMTP ni secrets d'e-mail.
3. **Site et documents** (lots W1 à W5, T1, D1) : `web/src/account/webauthn.ts` et `recup.ts`, écrans §3, repli sans PRF, démo avec passkey simulée, textes publics FR et EN (Confidentialité, Sécurité, CGU), « le serveur ne voit rien » étendu, parcours ui-e2e avec authentificateurs virtuels ; retrait du code v2 du moteur et de `compte.json` ; liste d'ouverture et audit (tenus hors du dépôt depuis le 24 novembre), `deploy/README.md` ; texte de `CLAUDE.md` proposé au propriétaire (§ « CLAUDE.md » ci-dessous : **le propriétaire seul le modifie**).

**Tech Stack :** Rust 1.99.1 (crates présentes : `hkdf` 0.13, `sha2` 0.11, `zeroize` ; `aes-gcm` 0.11 natif seulement ; aucune crate nouvelle) ; Go (go 1.26.0, toolchain go1.27.4), `github.com/go-webauthn/webauthn` **v0.18.2** (après revue S1, version exacte), `modernc.org/sqlite` v1.62.0 ; Svelte 5, vitest, WebCrypto, Playwright (Chromium : CDP `WebAuthn.addVirtualAuthenticator` avec `hasPrf`).

**Spec :** conception `2026-11-22-compte-passkey-design.md` (entière) ; conception du compte `2026-11-14-compte-email-design.md` pour tout ce qu'elle ne remplace pas (pseudo §21.5, coffres §21.2.2, sessions §8.5, ancienneté §11, bannissement §21.11 sauf la clé, accueil §21.7, signalements §21.10, suppression §21.12, sauvegarde §21.13, tableau de bord §21.14 sauf la recherche par adresse) ; spécification principale §37 (renvoi), §26 (reCAPTCHA).

## Global Constraints

- CLAUDE.md : le serveur ne reçoit ni ne garde de contenu, de nom de fichier, de clé ou de mot de passe en clair ; **plus aucune exception de séquestre** une fois S2 et W1 livrés (texte de CLAUDE.md à changer par le propriétaire, ci-dessous) ; aucune adresse IP sur disque ; aucune crypto maison ; aucune ressource tierce ; tests avant tout « fait » ; jamais « 100 % sécurisé ».
- Commits : `git commit --author="Skoow <190851638+Skoow@users.noreply.github.com>"`, sans changer le committer, sur `main`, message terminé par les lignes d'attribution de la session ; push après les tests du lot au vert.
- **Chaque lot laisse `main` vert** et ne change rien pour le public tant que `SHH_COMPTES=0` et `__COMPTES__ = false` (inchangés : désactivé par défaut).
- **Ordre imposé par les dépendances** : P1 → S1 → S2 … S8 → W1 … W4 → T1 → W5 → D1. Le site du compte par e-mail continue de marcher contre le serveur jusqu'à S2 ; entre S2 et W2, `SHH_COMPTES=1` n'a pas de site utilisable (sans conséquence : jamais ouvert, désactivé par défaut) — signalé, voir « Signalements » point 7.
- Valeurs fixes (conception §5, §6, §7) :
  - HKDF-SHA-256 sel vide ; étiquettes **nouvelles** : `shhdrop/v3/compte/prf/1` (entrée PRF `E_prf` = SHA-256 de ce texte), `shhdrop/v3/compte/enveloppe/prf`, `shhdrop/v3/compte/recup/acces`, `shhdrop/v3/compte/recup/enveloppe`, `shhdrop/v3/compte/profil` ; **inchangées** : `shhdrop/v2/compte/blob` (`K_prive`), `shhdrop/v2/compte/appareil` (`K_etiquette`, aussi pour le libellé de passkey) ; serveur : `…/pseudo` seule (les sous-clés `email`, `mdp`, `totp`, `sequestre` disparaissent) ;
  - `sel_prf` = SHA-256(« WebAuthn PRF » ‖ 0x00 ‖ `E_prf`) ;
  - enveloppes de `K_compte` : 60 octets = nonce (12) ‖ AES-256-GCM ; AD PRF = « SHH-CENV2 » ‖ `h` (16) ‖ SHA-256(`cred_id`) ; AD récupération = « SHH-CENV2 » ‖ `h` ‖ « recup » ; `cred_id` de 1 à 1 023 octets ;
  - clé de récupération `R` : 16 octets ; texte de 27 caractères (26 de base32 de Crockford, 2 bits de bourrage nuls, puis le symbole de contrôle de Crockford de `R` mod 37) ; affichage `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX` ; saisie : blancs Unicode et tirets retirés, minuscules, `I`/`L` → `1`, `O` → `0` ; erreurs `cle_recup_longueur`, `cle_recup_caractere`, `cle_recup_controle` ;
  - `A_r` (envoyé à `recup` seulement), `v_r` = SHA-256(`A_r`) (index unique) ;
  - coffres « SHH-ACCT1 » et « SHH-PROF1 » inchangés (paliers 4, 16, 64, 256 Kio ; palier + 45 octets) ;
  - WebAuthn : `rp.id` = hôte de `SHH_ORIGIN` (`shhgone.com` en production), `rp.name` « Shhgone », `residentKey: "required"`, `userVerification: "required"`, `attestation: "none"`, algorithmes −7, −8, −257, extensions `prf` et `credProps`, défi de 32 octets, 5 min, usage unique, 20 000 vivants au plus, compteur de signatures ni lu ni gardé, `BE` gardé, `BS` ni gardé ni montré ;
  - limites §7.2 : `inscription/debut` 20/h/connexion, difficulté ALTCHA doublée par compte créé dans la journée ; `inscription/fin` 3/jour/connexion, 10/jour//48, **500/jour en tout** (`SHH_COMPTES_JOUR`) ; `connexion/debut` 60/min/connexion ; `connexion/fin` 20 échecs/h/connexion, 60//48 ; `recup` 10/h/connexion, 30//48 ; 10 passkeys par compte, `passkeys/debut` 10/h/compte ; 20 sessions par compte.
- Vérifications : moteur `make test-engine` (fmt, clippy hôte et wasm32, tests) et `cd web && npm run build:engine` ; serveur `make test-go` et `make test-e2e` ; site `make test-web` (+ `make test-ui` et captures pour un écran) ; déploiement `make lint-deploy`, `make test-sortie`, `make test-restauration`.

## Review Focus

1. **Le serveur ne voit rien qui ouvre un coffre** : ni sortie PRF, ni `R` sous aucune forme, ni `KEK_*`, ni `K_compte` ; `A_r` seulement dans la requête `recup`, jamais sur disque ni dans un journal (S4, T1).
2. **Rien de daté ni d'identifiant de matériel sur disque** : ni AAGUID, ni transports, ni attestation, ni compteur, ni `BS`, ni date de dernier usage, ni IP (S2 `TestSchemaComptes`, T1).
3. **Ordre Safari** : aucune requête entre le clic et `navigator.credentials.create`/`get` (W1 `source-rules`, T1).
4. **Repli sans PRF jamais silencieux** et clé locale non extractible effacée à la déconnexion (W1, W2).
5. **Même compte site ↔ apps** : rien de propre au navigateur dans les formats ; `sel_prf` dans les vecteurs ; origines Android prévues (S3).
6. **Retrait complet** : plus aucun code, test, texte, secret ni relais d'e-mail ; `TestNoOutgoingHTTP` sans l'exception SMTP (S6).

---

# Sous-projet 1 — Moteur Rust et vecteurs communs

## Lot P1 — Moteur : compte par passkey (vecteurs `compte-v3.json`)

*Livrable seul : fonctions du moteur et vecteurs, utilisées par personne encore ; le code du compte v2 reste en place (le site l'utilise jusqu'à W1). Dépend de : rien.*

**État : fait le 22 novembre** (commit « feat(moteur): compte par passkey… », voir `git log -- engine/vectors/compte-v3.json`).

**Files :**
- Create : `engine/core/src/compte/v2.rs` (code v2 déplacé, gelé), `engine/core/tests/compte_v3.rs`, `engine/core/tests/support/pseudo.rs` (cas du pseudo communs aux deux fichiers), `engine/vectors/compte-v3.json`, `web/src/engine/compte-v3.test.ts`, `server/internal/compte/vecteurs_v3_test.go`
- Modify : `engine/core/src/compte.rs`, `engine/core/src/error.rs`, `engine/core/tests/compte.rs` (imports `compte::v2`), `engine/core/tests/support/mod.rs`, `engine/wasm/src/lib.rs`, `engine/vectors/README.md`

**Interfaces :**
- Rust (`shhdrop_core::compte`) : `entree_prf() -> [u8;32]`, `sel_prf() -> [u8;32]`, `kek_prf(&[u8;32]) -> Cle`, `ad_enveloppe_prf(&[u8;16], cred_id) -> Result<Vec<u8>>` (`cred_id_invalide`), `ad_enveloppe_recup(&[u8;16]) -> Vec<u8>`, `cle_profil(k_compte)` (**v3**, tirée de `K_compte`), `cle_prive`, `cle_appareil` (inchangées) ; `CleRecup { new(Zeroizing<[u8;16]>), octets(), texte(), affichage(), lire(&str) -> Result<Self>, acces(), verificateur(), kek() }` ; constantes `ENVELOPPE_LEN`, `CRED_ID_MAX`, `RECUP_LEN`, `RECUP_TEXTE_LEN`. Gelé : `compte::v2::{Adresse, normaliser, sel, deriver, cle_profil, mot_de_passe_valide, MDP_MIN, MDP_MAX}`.
- wasm : `entreePrf`, `kekPrf`, `adEnveloppePrf`, `adEnveloppeRecup`, `cleProfilCompte`, `cleRecupAffichage`, `cleRecupLire` (saisie en UTF-8, `Uint8Array`), `cleRecupDerivees` (`{ aR, vR, kekR }`) ; les anciennes (`normaliserAdresse`, `deriverCompte`, `cleProfil`, `motDePasseValide`) gardées jusqu'à W5.
- Apps natives : mêmes fonctions Rust ; AES-256-GCM par `platform::Key` (`native::RustCrypto`) avec les AD ci-dessus ; aucune dépendance au navigateur.

- [x] **Step 1 : tests** — `engine/core/tests/compte_v3.rs` : `fichier_a_jour`, `vecteurs_constantes`, `vecteurs_enveloppe_prf`, `vecteurs_cle_recup_texte`, `vecteurs_cle_recup_saisie` (46 cas), `vecteurs_recup`, `vecteurs_cles`, `vecteurs_coffres`, `vecteurs_pseudo` (égal à `compte.json`), `cle_recup_aller_retour` (2 000 clés), `cle_recup_fautes_de_frappe_detectees` (toute substitution et transposition voisine refusée), `entrees_prf_et_cles_distinctes`. Textes de référence, `E_prf` et `sel_prf` calculés par un programme indépendant (Python).
- [x] **Step 2 :** `cargo test -p shhdrop-core --test compte_v3` → FAIL (fonctions absentes).
- [x] **Step 3 :** implémenter (aucune dépendance nouvelle) ; `SHH_GEN_COMPTE_V3=1 cargo test -p shhdrop-core --test compte_v3` écrit le fichier ; relire le diff ; règle anti-détecteur de secrets.
- [x] **Step 4 :** `make test-engine` ; `cd web && npm run build:engine && npx vitest run src/engine/compte-v3.test.ts` ; `cd server && go test ./internal/compte/ -run VecteursV3` → PASS ; poids du `.wasm` des partages (`node scripts/check-dist.mjs`) sous le plafond : mesuré le 22 novembre, 154 958 o en brotli (152 573 o sans les fonctions du lot), plafond 156 000 o (Signalements point 10).
- [x] **Step 5 :** commit `feat(moteur): compte par passkey, clé de récupération, enveloppes (vecteurs compte-v3.json)`.

**Retraits du moteur reportés à W5** (vérifié le 22 novembre) : `normaliser`, `sel`, `deriver`, `mot_de_passe_valide`, `v2::cle_profil` et `compte.json` servent encore au site (`web/src/account/session.svelte.ts`, `keys.ts`, `argon2.worker.ts`, `web/src/engine/index.ts`) et au serveur (`server/internal/compte/adresse_test.go`, `vecteurs_test.go`, `sequestre_test.go`) ; les retirer maintenant casserait `main`. **Argon2id reste** : il sert aux partages protégés par mot de passe (`kdf::password_key`, `passwordKey`, `passwordKeyForCreate`, `web/src/engine/argon2.worker.ts`).

---

# Sous-projet 2 — Serveur Go

## Lot S1 — Revue de chaîne d'approvisionnement de go-webauthn v0.18.2 (avant tout ajout)

**État : fait le 22 novembre, revue acceptée** (`docs/superpowers/plans/2026-11-22-revue-go-webauthn.md`).

*Livrable seul : un document de revue et une décision ; `go.mod` ne change pas tant que la revue n'est pas acceptée. Dépend de : rien.*

**Files :**
- Create : `docs/superpowers/plans/2026-11-22-revue-go-webauthn.md` (ou une section datée de `docs/superpowers/plans/maj-dependances-2026-11-04.md`, au choix du contrôleur, une seule)
- Modify (seulement si la revue est acceptée, au lot S3) : `server/go.mod`, `server/go.sum`, `THIRD_PARTY_LICENSES.md`

- [x] **Step 1 :** dans un module jetable hors du dépôt (scratchpad), `go mod init x && go get github.com/go-webauthn/webauthn@v0.18.2` ; `go mod graph` et `go list -m all` : liste **exacte** des modules et versions tirés (attendus d'après la conception : `github.com/go-webauthn/x`, `github.com/fxamacker/cbor/v2`, `github.com/golang-jwt/jwt/v5`, `github.com/google/go-tpm`, `github.com/google/uuid`, `github.com/mitchellh/mapstructure` ou successeur ; à relever, pas à supposer).
- [x] **Step 2 :** pour chaque module : version, date de publication (≥ 7 jours, règle §24), mainteneurs, licence (fichier LICENSE lu dans le cache de modules), avis connus (`govulncheck` sur un programme minimal qui appelle `BeginRegistration`, `CreateCredential`, `BeginDiscoverableLogin`, `ValidateDiscoverableLogin` ; base OSV/GitHub Advisory), présence de code `init()`, de `unsafe`, de `cgo`, d'accès réseau ou fichier (grep). Licence de go-webauthn : **à revérifier** (conception §6.1 : BSD-3-Clause annoncée).
- [x] **Step 3 :** vérifier que la vérification des signatures passe par `crypto/ecdsa`, `crypto/rsa`, `crypto/ed25519` de la bibliothèque standard (aucune crypto maison dans la bibliothèque) et noter les chemins d'attestation (TPM, métadonnées FIDO) compilés mais inutilisés avec `attestation: "none"`.
- [x] **Step 4 :** décision écrite : accepté (versions exactes à épingler) ou refusé, avec la raison. **Refus = arrêt du sous-projet 2 et retour au propriétaire, jamais de vérification WebAuthn réécrite à la main.**
- [x] **Step 5 :** commit `docs(revue): chaîne d'approvisionnement de go-webauthn v0.18.2`.

## Lot S2 — Configuration, `comptes.db` schéma 3, retrait du compte par e-mail

**État : fait le 22 novembre. Écarts : la route POST recup (S4) et les nouvelles limites de §7.2 (limits/compte.go) sont venues dès ce lot (recup ne dépend pas de WebAuthn ; elle sert aux tests de session récente) ; la partie Go du tableau de bord (S7 : plus de recherche ni de bannissement par adresse) aussi, sans quoi le serveur ne compilait plus. Gardés exprès : server/internal/compte/jetables*.txt (lus par le site, web/src/listes/jetables.ts, jusqu'à W1), web/e2e/smtp.ts et totp.ts (ui-e2e du compte par e-mail, à refaire en T1 ; web/e2e/server.ts refuse leurs options au lancement). web/e2e/compte-sees-nothing.test.ts réduit dans ce lot, refait au lot S5 avec un authentificateur logiciel.**

*Livrable seul : le serveur démarre en `SHH_COMPTES=1` sans SMTP ; les anciennes routes ont disparu (404) ; aucune nouvelle route encore. Dépend de : P1.*

**Files :**
- Modify : `server/internal/config/{config.go,comptes.go,config_test.go,hardening_test.go}`, `server/internal/compte/{base.go,base_test.go,cles.go,cles_test.go,service.go,service_test.go,sessions.go,bannir.go,bannir_test.go,effacement.go,parametres.go,agregats.go,salons.go}`, `server/internal/api/{handlers_compte.go,compte_test.go,salon_compte_test.go}`, `server/internal/stats_test.go`, `server/cmd/shhdrop/{main.go,admin.go,comptes_test.go,admin_comptes_test.go}`, `server/internal/adminui/{comptes.go,comptes_test.go}` et sa page
- Delete : `server/internal/courriel/` (entier), `server/internal/compte/{adresse.go,adresse_test.go,jetables.go,jetables.txt,jetables-ajouts.txt,oubli.go,oubli_test.go,sequestre.go,sequestre_test.go,totp.go,totp_test.go,etapes.go}` (garder de `etapes.go` ce qui sert aux étapes WebAuthn, déplacé en S3), `server/internal/compte/vecteurs_test.go` (rejeu de `compte.json` ; `vecteurs_v3_test.go` le remplace), `web/scripts/maj-jetables.mjs`, `web/e2e/smtp.ts`, `web/e2e/totp.ts`

**Interfaces :**
- `config.Config` : `Comptes`, `ComptesCleFile`, `ComptesMax`, `ComptesJour` (nouveau, 500 par défaut, `SHH_COMPTES_JOUR` 1 à 100 000) ; **retirés** : `SMTP{…}`, `SHH_SMTP_*`, `SHH_MAIL_FROM`. Une variable `SHH_SMTP_*` ou `SHH_MAIL_FROM` encore présente fait **refuser le démarrage** avec un message (« compte par e-mail retiré le 22 novembre ; ôter la variable ») : jamais ignorée en silence.
- `compte.Cles` : `Pseudo [32]byte` seule (HKDF du fichier `SHH_COMPTES_CLE_FILE` sous `…/pseudo`, inchangé) ; sous-clés `Email`, `Poivre`, `TOTP`, `Sequestre` retirées.
- Schéma 3 exact (conception §6.3) : `comptes(h, p_empreinte, pseudo_jour, v_r, env_r, blob_profil, gen_profil, blob_prive, gen_prive, cree_jour, compte_des, vu_mois)`, `passkeys(cred_id, h, cle_pub, alg, be, env, etiquette, ajoutee_mois)`, `sessions(… , par_recup)`, `bannis(id, h, debut_jour, jusqu_jour, actif, motif, salons_fermes)` ; BLOB et INTEGER seulement, `WITHOUT ROWID`, `secure_delete`, `ON DELETE CASCADE`.
- Démarrage sur une `comptes.db` de schéma 2 : **vide** → recréée ; **non vide** → refus avec message, jamais d'effacement (conception §15).

- [x] **Step 1 : tests** — `TestSchemaComptes` v3 (colonnes exactes ; aucune colonne `e_*`, `v_mdp`, `env_mdp`, `cle_profil`, `totp*`, `recup_jour`, `aaguid`, `compteur`, `bs`, `vu_jour`) ; `TestSchema2NonVideRefuse`, `TestSchema2VideRecree` ; `TestConfigSMTPRefuse` (chaque ancienne variable) ; `TestComptesJour` (bornes) ; `TestNoOutgoingHTTP` : **plus d'exception SMTP** (restent `captcha/recaptcha.go` et `paiement/http.go`, voir Signalements point 1) ; `allowedMaps` sans les maps de `courriel` et des quotas d'e-mails ; `TestBannisParH` (cascade à la suppression du compte) ; `TestPageSansIdentite` du tableau de bord sans « Recherche par adresse » ni « Bannir par adresse ».
- [x] **Step 2 :** `cd server && go test -race ./...` → FAIL.
- [x] **Step 3 :** implémenter les retraits et le schéma ; `export` sans adresse ni double authentification ; `GET /api/compte` sans `totp`, `recup_jusqu`, `retrait_totp_le` ; `supprimer` sans attente (`attente` retiré).
- [x] **Step 4 :** `make test-go` ; `make test-e2e` (les e2e du compte par e-mail sont retirés dans ce lot : `web/e2e/compte-sees-nothing.test.ts` réduit au démarrage et aux 404 des anciennes routes, refait en T1).
- [x] **Step 5 :** commit `refactor(serveur): compte sans e-mail — schéma 3, retrait de SMTP, du TOTP, du séquestre et de la récupération par e-mail`.

## Lot S3 — Cérémonies WebAuthn (go-webauthn, configuration figée)

**État : fait le 22 novembre (internal/compte/webauthn.go, authentificateur logiciel internal/compte/webauthntest, importable par les tests des autres paquets ; govulncheck v1.9.0 : 0 vulnérabilité atteinte). Les défis vivent dans les étapes de defis.go (lot S2). Une réponse qui contient une sortie PRF (prf.results) ou hmac-secret est refusée (bad_request) : le site doit les retirer de clientExtensionResults avant l'envoi.**

*Livrable seul : bibliothèque appelée par des tests seulement. Dépend de : S1 (accepté), S2.*

**Files :**
- Create : `server/internal/compte/webauthn.go`, `server/internal/compte/webauthn_test.go`, `server/internal/compte/defis.go` (défis en mémoire), `server/internal/compte/authentificateur_test.go` (authentificateur logiciel de test : ES256, EdDSA, RS256, drapeaux UV/BE/BS réglables, `userHandle`)
- Modify : `server/go.mod`, `server/go.sum` (versions exactes de S1), `THIRD_PARTY_LICENSES.md`, `server/internal/stats_test.go` (`allowedMaps` : table des défis), `server/internal/config/{config.go,config_test.go}` (`SHH_WEBAUTHN_ORIGINES_APPS`, vide par défaut)

**Interfaces :**
- `compte.WebAuthn` construit une seule fois depuis `SHH_ORIGIN` : `rp.id` = hôte, origines = `SHH_ORIGIN` + `SHH_WEBAUTHN_ORIGINES_APPS` (chacune exactement `android:apk-key-hash:<43 caractères base64url>`, sinon refus de démarrer). **Toute autre configuration fait échouer le démarrage** (test).
- `DebutInscription(h) (etape, options)`, `FinInscription(etape, reponseJSON) (Passkey, error)`, `DebutConnexion() (etape, options)`, `FinConnexion(etape, reponseJSON) (h, cred_id, error)`, `DebutReauth(h, passkeys)`, `FinReauth(…)` ; options en JSON WebAuthn niveau 3 (`PublicKeyCredentialCreationOptionsJSON`), `prf.eval.first` = `E_prf` des vecteurs (`constants.entree_prf` de `compte-v3.json`, test qui le relit).
- Défis : 32 octets `crypto/rand`, clé = SHA-256(`etape`), usage unique, 5 min, 20 000 au plus (au-delà : `busy`, 503).
- Stocké d'une passkey : `cred_id`, `cle_pub` (COSE ≤ 1 024), `alg`, `be`, `ajoutee_mois` ; **jamais** AAGUID, transports, attestation, compteur, `BS`. Compteur remis à 0 avant chaque vérification, avertissement de clonage ignoré.

- [x] **Step 1 : tests** — cérémonie complète pour chaque algorithme ; défi rejoué, défi échu (horloge de test), mauvaise origine, mauvais `rp.id`, `UV` absent, `BE` changé entre inscription et connexion, `userHandle` d'un autre compte, `cred_id` inconnu → même erreur `identifiants` ; attestation autre que `none` refusée ou ignorée sans rien garder ; `TestRPIDProduction` : `SHH_ORIGIN=https://shhgone.com` → `rp.id` = `shhgone.com` ; origine `http://` refusée hors boucle locale ; `localhost` accepté pour les tests (voir Signalements point 3).
- [x] **Step 2 :** FAIL. **Step 3 :** implémenter. **Step 4 :** `make test-go` ; `govulncheck` (CI). **Step 5 :** commit `feat(serveur): cérémonies WebAuthn (go-webauthn épinglé, configuration figée)`.

## Lot S4 — Routes : inscription, connexion, récupération

**État : fait le 22 novembre (recup et limites venues dès S2). Écarts signalés : dans les requêtes, « aucune enveloppe » s'écrit env: "" (jamais null : JSON strict sans null, §8.6) ; la difficulté ALTCHA double par compte créé pendant l'heure qui suit (captcha.RecordCreate existant, commun aux créations), pas « dans la journée ».**

*Livrable seul (`SHH_COMPTES=1` : comptes créables par un client de test). Dépend de : S3.*

**Files :**
- Modify : `server/internal/api/handlers_compte.go`, `server/internal/api/compte_test.go`, `server/internal/compte/{service.go,sessions.go,coffres.go}`, `server/internal/limits/*` (nouvelles limites §7.2)

**Interfaces (conception §6.4, JSON strict, base64url sans bourrage, longueurs exactes) :**
- `POST inscription/debut` (ALTCHA, difficulté doublée par compte créé dans la journée par la connexion) → `{ etape, options }` (`user.id` = `h` de 16 octets tiré ici) ;
- `POST pseudo/verifier` (étape ou session) → `{ libre }`, libre = **réservé à l'étape** jusqu'à son échéance ;
- `POST inscription/fin` `{ etape, credential, p_canon, env|null, v_r, env_r, blob_profil, blob_prive, persistante, etiquette, cred_etiquette }` → 201 `{ session, h }` ; `pseudo_pris` (409, étape gardée) ; plafond global `SHH_COMPTES_JOUR` (503 `busy`) ;
- `POST connexion/debut` `{}` → `{ etape, options }` ; `POST connexion/fin` → `{ session, h, cred_id, env, blob_profil, gen_profil, blob_prive, gen_prive }`, `vu_mois` mis à jour ;
- `POST recup` `{ a_r, persistante, etiquette }` → recherche par `v_r` = SHA-256(`a_r`) (index unique, pas de comparaison en boucle) → session **récente**, `par_recup = 1` ; erreur `identifiants` (403, même corps que passkey inconnue).

- [x] **Step 1 : tests** — parcours complets avec l'authentificateur logiciel ; `TestRecupVecteurs` (les `a_r` de `compte-v3.json` retrouvent un compte créé avec les `v_r` correspondants) ; `env`, `env_r` ≠ 60 octets refusés ; `v_r` en double refusé ; `A_r` absent de toute réponse, de tout journal et de la base (`TestAucunSequestre` : aucune route ne rend `K_compte`, `KEK_*`, `R`, `A_r`) ; quotas §7.2 un par un ; `allowedMaps` à jour.
- [x] **Step 2 :** FAIL. **Step 3 :** implémenter. **Step 4 :** `make test-go` et `make test-e2e`. **Step 5 :** commit `feat(serveur): inscription et connexion par passkey, récupération par clé`.

## Lot S5 — Passkeys du compte, réauthentification, nouvelle clé de récupération

**État : fait le 22 novembre. Écart signalé : GET passkeys ne rend pas « courante » (le serveur ne garde pas quelle passkey a ouvert une session ; l'appareil le sait : cred_id rendu par connexion/fin) ; passkeys_max (409) pour la onzième. Avec ce lot, web/e2e/compte-sees-nothing.test.ts est refait sans écran (authentificateur logiciel web/e2e/webauthn.ts, calculs de l'appareil par le moteur WebAssembly et WebCrypto) : une partie de T1 ; les parcours ui-e2e restent à T1. Ajout du 22 novembre (décision du propriétaire, conception §17 « enveloppes multiples ») : table enveloppes (4 par passkey), connexion/fin et reauth/fin rendent enveloppes, passkeys/enveloppe { env } pour la seule passkey qui a signé l'assertion de la session.**

*Dépend de : S4.*

**Files :** Modify : `server/internal/api/handlers_compte.go`, `server/internal/api/compte_test.go`, `server/internal/compte/{service.go,sessions.go}`

**Interfaces :** `POST reauth/debut`, `reauth/fin` (session récente 5 min ; la passkey doit être du compte) ; `GET passkeys` → `{ passkeys: [{ cred_id, ajoutee: "2026-11", etiquette, be, prf, courante }] }` ; `POST passkeys/debut`, `passkeys/fin` (session récente, `excludeCredentials` = passkeys du compte, 10 au plus, `passkeys/debut` 10/h/compte) ; `POST passkeys/enveloppe` `{ cred_id, env }` ; `POST passkeys/nommer` `{ cred_id, etiquette }` (64 octets) ; `POST passkeys/retirer` (session récente ; `derniere`, 409) ; `POST recup/renouveler` `{ v_r, env_r }` (session récente) ; `sessions` montre `par_recup`.

- [x] **Step 1 : tests** — onzième passkey refusée ; retrait de la dernière refusé ; enveloppe d'une passkey d'un autre compte refusée ; ancienne clé de récupération refusée après `recup/renouveler` ; session non récente refusée partout où elle est exigée.
- [x] **Step 2 :** FAIL. **Step 3 :** implémenter. **Step 4 :** `make test-go`, `make test-e2e`. **Step 5 :** commit `feat(serveur): gestion des passkeys et de la clé de récupération`.

## Lot S6 — En-têtes, fichiers des apps, « aucune sortie » SMTP

**État : fait le 22 novembre. Fichiers d'association servis par l'API (internal/api/apps.go, avant le site statique), réglés par SHH_APPLE_APP_IDS, SHH_ANDROID_APP_PACKAGE et SHH_ANDROID_APP_SHA256 (vides par défaut) ; test dans cmd/shhdrop/static_assoc_test.go. TestNoOutgoingHTTP sans exception SMTP depuis S2.**

*Dépend de : S4.*

**Files :** Modify : `server/internal/api/headers.go` (+ test), `server/cmd/shhdrop/static.go` (+ `static_app_test.go`), `server/internal/config/config.go` (identifiants d'app, vides par défaut), `server/internal/stats_test.go`

- [x] **Step 1 : tests** — `Permissions-Policy` : `publickey-credentials-create=(self), publickey-credentials-get=(self)` sur les pages, `()` sur `/pdf-frame.html` ; `/.well-known/apple-app-site-association` et `/.well-known/assetlinks.json` : 404 identique à une route inconnue sans identifiants d'app, sinon `application/json`, sans redirection ; `TestNoOutgoingHTTP` : aucun `net/smtp`, `crypto/tls` client, ni `net.Dial` hors des exceptions restantes.
- [x] **Step 2 :** FAIL. **Step 3 :** implémenter. **Step 4 :** `make test-go`. **Step 5 :** commit `feat(serveur): Permissions-Policy WebAuthn, fichiers d'association des apps`.

## Lot S7 — Tableau de bord et administration

**État : fait le 22 novembre : la partie Go et la page (plus de recherche ni de bannissement par adresse ; agrégats des passkeys) sont venues au lot S2 ; ce lot ajoute banni_id à GET /api/compte (l'identifiant B-… que la personne bannie donne pour son recours, §7.4).**

*Dépend de : S2.*

**Files :** Modify : `server/internal/adminui/{comptes.go,comptes_test.go,page/*}`, `server/cmd/shhdrop/{admin.go,admin_comptes_test.go}`

- [x] **Step 1 : tests** — « Bannir par adresse » et « Recherche par adresse » absents ; `shhdrop admin bannis … <id>` agit par l'identifiant `B-…` ; « Bannir par lien de salon » et « par salon signalé » inchangés ; `TestPageSansIdentite` (jamais `h`, empreinte, pseudo, `cred_id`).
- [x] **Step 2-5 :** FAIL, implémenter, `make test-go`, commit `refactor(admin): bannissement par compte, plus de recherche par adresse`.

## Lot S8 — Déploiement : relais SMTP et secrets d'e-mail retirés

**État : fait le 22 novembre. relais-smtp et ses variables retirés de compose.yaml ; deploy.sh refuse SHH_SMTP_*, SHH_MAIL_FROM, un secret shh_smtp_mdp resté et, avec SHH_COMPTES=1, un SHH_DOMAIN autre que shhgone.com ; shhcheck smtp remplacé par shhcheck joindre (relais.go gardé) ; l'alerte de la machine a ses propres variables SHH_ALERTE_SMTP_HOST, SHH_ALERTE_SMTP_USER, SHH_ALERTE_FROM (elle lisait celles du compte : signalé) ; test-restauration : avec une autre clé du serveur, la connexion réussit (la clé ne sert plus qu'aux pseudos). Vérifié : make lint-deploy, test-sortie.sh --statique, make test-restauration (root) ; partie réseau de test-sortie non faite (pas de démon Docker utilisable ici).**

*Dépend de : S2.*

**Files :**
- Modify : `deploy/compose.yaml` (service `relais-smtp` retiré, `/etc/hosts` du serveur sans `SHH_SMTP_HOST`), `deploy/deploy.sh` (plus de fournisseur d'e-mails exigé ni de secret SMTP), `deploy/env.example`, `deploy/Dockerfile` si concerné, `deploy/test-sortie.sh` (sortie SMTP retirée, sorties de paiement gardées), `deploy/test-restauration.sh` (schéma 3), `deploy/sauvegarder.sh`, `deploy/restaurer.sh` si le schéma y est cité, `deploy/shhcheck/{compte_test.go,main.go}` (contrôle SMTP retiré), `deploy/README.md` §12 (« Compte par passkey : secrets, sauvegarde »), `Makefile` (commentaires de `lint-deploy`, `test-sortie`)
- Keep : `deploy/shhcheck/relais.go` (**sert encore aux relais de paiement**, conception du paiement §4 : ne pas le supprimer)

- [x] **Step 1 : tests** — `make test-sortie` : la configuration résolue de compose n'a plus de relais SMTP ni de réseau de sortie pour lui ; les relais de paiement inchangés ; `deploy.sh` refuse une ancienne variable SMTP restée dans `.env` (message clair) ; `make test-restauration` sur une `comptes.db` de schéma 3.
- [x] **Step 2 :** FAIL. **Step 3 :** implémenter. **Step 4 :** `make lint-deploy`, `make test-sortie`, `make test-restauration` (root). **Step 5 :** commit `chore(deploy): compte sans e-mail — relais SMTP et secrets retirés`.

---

# Sous-projet 3 — Site, démo, textes, documents

## Lot W1 — Couche du compte : WebAuthn, clé de récupération, repli sans PRF

**État : fait le 22 novembre, avec W2 à W4 dans un seul commit (« feat(site): compte par passkey… ») : la nouvelle couche du compte cassait ensemble écrans, démo et textes ; des commits séparés auraient laissé main rouge. Écarts : navigator.credentials vit dans account/navigateur.ts (remplacé dans la démo par navigateur.demo.ts, passkey simulée), webauthn.ts ne l'appelle que par lui ; options converties localement, même quand parseCreationOptionsFromJSON existe (résultat identique partout, entrées PRF comprises) ; E_prf toujours pris au moteur, jamais aux options du serveur ; clientExtensionResults envoyé en liste blanche (credProps.rk, prf.enabled), sans transports ni authenticatorAttachment ; réparation des enveloppes (reparation.ts, décision du 22 novembre) et lecture tolérante de la sortie PRF (1Password). Clé locale de l'appareil : enregistrement « cle » de persist.ts.**


*Livrable seul : modules et tests unitaires ; écrans en W2. Dépend de : P1, S4 (formes JSON).*

**Files :**
- Create : `web/src/account/webauthn.ts` (+ test), `web/src/account/recup.ts` (+ test)
- Modify : `web/src/engine/index.ts` (fonctions v3 du moteur), `web/src/account/{keys.ts,keys.test.ts,session.svelte.ts,session.test.ts,api.ts,api.test.ts,persist.ts,persist.test.ts,vaults.ts,vaults.test.ts,device.ts,suppression.ts,pass.ts,sync.ts}`, `web/src/source-rules.test.ts` (ou le fichier de règles de source existant)

**Interfaces :**
- `webauthn.ts` : seul fichier qui appelle `navigator.credentials` ; `creer(options)`, `obtenir(options, allow?)` ; JSON niveau 3 par `PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` quand ils existent, sinon conversion base64url locale ; lit `getClientExtensionResults().prf.results.first`, `prf.enabled`, `credProps.rk` ; `NotAllowedError` → aucune erreur affichée ; `signalUnknownCredential` là où il existe.
- `recup.ts` : tirage de `R` (`crypto.getRandomValues`), `cleRecupAffichage`, `cleRecupLire`, `cleRecupDerivees`, groupe de vérification tiré au hasard (1 à 7).
- Enveloppes et coffres par WebCrypto avec les clés et AD du moteur (`kekPrf`, `adEnveloppePrf`, `adEnveloppeRecup`, `cleProfilCompte`) ; **options chargées avant le clic** (connexion : à l'ouverture de la page ; inscription : dès la preuve ALTCHA prête ; défi rechargé sans bruit s'il a expiré).
- Repli sans PRF (conception §5.5) : `K_compte` gardée dans IndexedDB `shhdrop-compte` sous une clé AES-GCM non extractible **même sans « Rester connecté »** ; « Se déconnecter » l'efface ; l'écran dit toujours pourquoi la clé de récupération est demandée.
- Retirés : `MotDePasse`/Argon2id du compte, `s_profil`, `normaliserAdresse`, TOTP, oubli.

- [x] **Step 1 : tests** — `keys.test.ts` et `vaults.test.ts` rejouent `compte-v3.json` (plus `compte.json`) ; enveloppe PRF faite puis ouverte ; sortie PRF différente → repli par la clé (jamais silencieux) ; deuxième geste quand seul `prf.enabled` revient ; clé locale non extractible effacée à la déconnexion ; règle de source : `navigator.credentials` seulement dans `webauthn.ts`, et aucun `fetch` entre le gestionnaire du clic et `create`/`get` (analyse statique du gestionnaire, plus le test T1).
- [x] **Step 2 :** FAIL. **Step 3 :** implémenter. **Step 4 :** `make test-web`. **Step 5 :** commit `feat(site): compte par passkey — WebAuthn, clé de récupération, repli sans PRF`.

## Lot W2 — Écrans (conception §3)

**État : fait le 22 novembre (commit de W1). Écarts signalés : champ Pseudo remis à l'inscription (conception §3.1, Q6 : nom de la passkey) alors que le 20 novembre l'avait retiré ; case « 15 ans et conditions » non remise (phrase sous le bouton, décision du 20 novembre) ; écran « Créez une passkey sur cet appareil » avec « Plus tard » ; route /compte/recuperation à la place de /compte/oubli. Captures d'écran non faites.**


*Dépend de : W1, S5.*

**Files :**
- Modify : `web/src/routes/compte/{Inscription.svelte,Connexion.svelte,Parametres.svelte,Supprimer.svelte,Profil.svelte,Accueil.svelte,erreurs.ts,pages.ts,verifs.ts}` et leurs tests ; `web/src/routes/compte/sections/*` ; `web/src/i18n/{fr.ts,en.ts,en-source.ts,en-source.verified.ts}`
- Create : `web/src/routes/compte/{CleRecup.svelte,VerifCle.svelte,Recuperation.svelte,Passkeys.svelte}` (+ tests)
- Delete : `web/src/routes/compte/{MotDePasse.svelte,ReglesMdp.svelte,Oubli.svelte,Oubli.test.ts,Renvoi.svelte,DemoCode.svelte,Identite.svelte}` (ce qui ne sert plus, à vérifier fichier par fichier)

- [x] **Step 1 : tests** — textes exacts de la conception §3 (FR et EN) ; inscription en 8 actions (9 avec le deuxième geste) ; « Le compte n'existe qu'après « Terminer » » ; vérification d'un groupe (4 caractères, 3 pour le dernier) ; « Revoir la clé » ; « Copier », « Télécharger (.txt) » ; connexion en 2 actions ; « J'ai ma clé de récupération » ; écran obligatoire « Créez une passkey sur cet appareil » après `recup` ; bandeau « Votre clé de récupération a servi… » jusqu'au renouvellement (Q10 : proposée) ; bandeau si aucune passkey synchronisable (`be = 0` partout) ; « Passkeys » : libellé, mois, « liée à cet appareil », « ouvre vos données », « cette passkey », retrait de la dernière refusé ; navigateur sans `PublicKeyCredential` : message de la conception §9 ; règles communes (étiquettes visibles, `LiveRegion`, focus, 44 px, 320 px, clavier, rien dans l'URL ni le titre).
- [x] **Step 2-4 :** FAIL, implémenter, `make test-web`, `make test-ui` sur les écrans touchés, **captures** jointes (FR, EN, 320 px, sombre et clair).
- [x] **Step 5 :** commit `feat(site): écrans du compte par passkey`.

## Lot W3 — Textes publics : Confidentialité, Sécurité, CGU (FR et EN)

**État : fait le 22 novembre (commit de W1).**


*Dépend de : W2 (vocabulaire des écrans).*

**Files :** Modify : `web/src/routes/pages/content.ts` (+ `content.test.ts`), `web/src/i18n/{fr.ts,en.ts}` (`home.priv.account.p` et tout texte « e-mail »), `web/src/i18n/en-source*.ts`

- [x] **Step 1 : tests** — `content.test.ts` : plus aucune mention d'adresse e-mail, de mot de passe du compte, de double authentification, de séquestre ni de « le service peut lire votre profil » ; présence des phrases : « Pour créer un salon, un compte sans e-mail ni mot de passe, par passkey. » ; « Votre pseudo, votre photo et votre abonnement sont chiffrés sur vos appareils : le service ne peut pas les lire. » ; page Sécurité « Ce que le compte ne protège pas » : la clé de récupération est la clé du compte (qui la lit prend le compte), appareil sans PRF protégé par son seul verrouillage ; page Confidentialité : clés publiques des passkeys et `h` sont des données pseudonymes (jamais « aucune donnée personnelle ») ; Apple, Google ou le gestionnaire apprennent l'existence du compte et le pseudo (Q6) ; CGU : compte irrécupérable sans passkey ni clé, effacé après 13 mois sans connexion ; jamais « 100 % sécurisé » (test existant).
- [x] **Step 2-4 :** FAIL, implémenter, `make test-web`. **Step 5 :** commit `docs(site): textes publics du compte par passkey (FR, EN)`.

## Lot W4 — Démo GitHub Pages : passkey simulée

**État : fait le 22 novembre (commit de W1). La phrase « Dans la démo, aucune passkey n'est créée » est dans le cadre de chaque page du compte ; les boutons gardent leur libellé (« Créer avec une passkey »), pas « Simuler la passkey » : signalé.**


*Dépend de : W2.*

**Files :** Modify : `web/src/demo/fake-compte.ts` (+ test), `web/src/app/demo-hooks.ts` si concerné, `web/ui-e2e/compte.demo.spec.ts`, `web/scripts/check-dist.mjs` (la démo ne contient aucun appel à `navigator.credentials`)

- [x] **Step 1 : tests** — en démo, bouton « Simuler la passkey » et texte « Dans la démo, aucune passkey n'est créée » ; clé de récupération réelle (moteur) ; aucun appel à `navigator.credentials` dans le build de démo (`check-dist.mjs --demo`) ; e2e de démo sans authentificateur.
- [x] **Step 2-5 :** FAIL, implémenter, `npm run build:demo && node scripts/check-dist.mjs --demo`, commit `feat(demo): passkey simulée`.

## Lot T1 — « Le serveur ne voit rien » étendu, parcours par l'interface

**État : fait le 22 novembre, sauf le passage manuel (bloquant pour l'ouverture). Réparation prouvée par un crochet de test qui change la sortie PRF de la même passkey (l'authentificateur virtuel de Chromium ne rend plus de PRF pour un identifiant recopié par WebAuthn.addCredential). appel.spec.ts refait aussi (il posait les variables SMTP). Captures non faites.**


*Dépend de : S5, W2.*

**Files :** Modify : `web/e2e/compte-sees-nothing.test.ts`, `web/e2e/server.ts` (origine `http://localhost:<port>` pour WebAuthn, voir Signalements point 3), `web/ui-e2e/compte.spec.ts`, `web/ui-e2e/comptes-site.ts` ; Create : `web/e2e/webauthn.ts` (authentificateur de test côté Node pour les e2e sans navigateur, ou réutilisation de celui de S3 par un petit binaire de test, au choix)

- [x] **Step 1 : tests** — par l'interface réelle (Chromium, CDP `WebAuthn.addVirtualAuthenticator`, un authentificateur **avec** PRF et un **sans**) : création, connexion, nouvel appareil par la clé, ajout et retrait de passkey, salon créé, suppression. Repères cherchés dans `comptes.db`, son WAL, `shares.db`, le dossier de données, stdout, stderr et toutes les réponses : sortie PRF (lue dans la page par un crochet de test), `K_compte`, `R` (octets, texte, groupé, minuscules), `A_r` (permis dans la seule requête `recup`, jamais sur disque), pseudo affiché, photo, libellés de passkey et d'appareil, **AAGUID** du faux authentificateur, jeton de session ; aucune requête vers les partages ou le salon (sauf `POST /api/salons`) avec `X-Shh-Session` ; pseudo affiché dans **aucune** requête ; dates multiples de 86 400 ; aucune requête entre le clic et `create`/`get` ; après suppression : ni `h`, ni `cred_id`, ni clé publique dans les fichiers.
- [x] **Step 2-4 :** FAIL, implémenter, `make test-e2e`, `make test-ui` (Chromium ; WebKit n'a pas d'authentificateur virtuel, R14), captures.
- [x] **Step 5 :** commit `test(compte): le serveur ne voit rien — passkey, PRF, clé de récupération`.
- [ ] **Manuel, bloquant pour l'ouverture** (pas pour le push) : iPhone iOS 18.4+ avec iCloud, en local et par QR depuis un PC ; Android avec le Gestionnaire Google ; Windows 11 à jour avec Windows Hello ; Firefox ; une clé physique ; 1Password ou Bitwarden ; un appareil sans PRF (repli). Captures à garder hors du dépôt.

## Lot W5 — Retrait du compte v2 du moteur et de `compte.json`

**État : fait le 22 novembre. Poids du moteur des partages : 154 958 → 147 481 o en brotli. Code mort retiré en même temps (knip 6.44.2 et grep) : preparerPreuve, creationAvecPrf, option « recuperation » de la fusion, 21 jetons de tokens.css que rien ne lit (les --fmt-* restent : FormatIcon les lit par var(--fmt-{…})).**


*Dépend de : S2 (Go ne lit plus `compte.json`), W1 (le site n'appelle plus les fonctions v2).*

**Files :**
- Delete : `engine/core/src/compte/v2.rs`, `engine/core/tests/compte.rs`, `engine/vectors/compte.json`, `web/scripts/gen-compte-vectors.mjs`, `web/src/engine/compte.test.ts`
- Modify : `engine/core/src/compte.rs` (`pub mod v2` retiré), `engine/core/src/error.rs` (`AdresseInvalide`, `AdresseNonAscii`, `MdpCourt`, `MdpLong`, `MdpAdresse` retirées **si plus aucun usage**), `engine/wasm/src/lib.rs` (`normaliserAdresse`, `deriverCompte`, `cleProfil`, `motDePasseValide` retirées), `web/src/engine/{index.ts,argon2.ts,argon2.worker.ts}` (chemin `compte` du Worker retiré ; **Argon2id des partages gardé**), `engine/core/tests/compte_v3.rs` (comparaison avec `compte.json` retirée), `engine/vectors/README.md`, `web/scripts/check-dist.mjs` (poids du `.wasm` noté)

- [x] **Step 1 :** `grep -rn "normaliser\|deriverCompte\|motDePasseValide\|cleProfil\b\|compte.json\|compte::v2" engine web/src web/scripts server` → plus aucun usage hors des fichiers retirés.
- [x] **Step 2 :** retirer ; `make test-engine`, `make test-web`, `make test-go`, `make test-e2e`.
- [x] **Step 3 :** commit `refactor(moteur): retrait du compte par e-mail (v2) et de compte.json`.

## Lot D1 — Documents

**État : fait le 22 novembre ; deploy/README.md et THIRD_PARTY_LICENSES.md l'étaient déjà (lots S3, S8).**


*Dépend de : S8, W3, T1.*

**Files :** Modify : liste d'ouverture (tenue hors du dépôt depuis le 24 novembre ; D1 « fournisseur d'e-mails » caduque ; §2.1 juriste : plus d'identité civile, pseudonyme illisible, clés publiques et `v_r` ; questions 1 et 2 de l'avocat reformulées, conception §12 ; captures du passage manuel), rapport d'audit du 20 novembre (tenu hors du dépôt depuis le 24 novembre ; note datée : points SMTP, séquestre, TOTP caducs), `deploy/README.md` (§12 réécrit, §1 sans fournisseur d'e-mails, §7 vérifications sans SMTP), `docs/superpowers/specs/2026-11-14-compte-email-design.md` (en-tête « remplacée pour l'identité, la connexion et la récupération par 2026-11-22-compte-passkey-design.md »), `docs/superpowers/plans/2026-11-14-compte-email.md` (même en-tête), `docs/superpowers/specs/2026-11-03-shhdrop-design.md` §37 (renvoi), `THIRD_PARTY_LICENSES.md` (go-webauthn et ses modules ; plus de `pquerna/otp` s'il y était)

- [x] **Step 1 :** relecture croisée : aucun document ne promet encore un e-mail, un TOTP ou un séquestre.
- [x] **Step 2 :** commit `docs: compte par passkey — ouverture, audit, déploiement`.

---

## CLAUDE.md (à modifier par le propriétaire, après S2 et W1)

Les agents ne modifient pas `CLAUDE.md`. Texte exact proposé :

1. **Supprimer**, dans la règle « Aucune crypto maison », la fin de l'exception HMAC-SHA1 :
   - remplacer « (« REST », `crypto/hmac` et `crypto/sha1` de Go, vérifiés par pion/turn épinglé ; le média reste chiffré de bout en bout par DTLS-SRTP ; conception `docs/superpowers/specs/2026-11-20-appels-design.md` §5) et codes de double authentification TOTP (RFC 6238, `server/internal/compte/totp.go`). »
   - par « (« REST », `crypto/hmac` et `crypto/sha1` de Go, vérifiés par pion/turn épinglé ; le média reste chiffré de bout en bout par DTLS-SRTP ; conception `docs/superpowers/specs/2026-11-20-appels-design.md` §5). »
2. **Ajouter**, à la même règle, après l'exception des jetons anonymes : « Compte (décision du propriétaire, 22 novembre) : passkeys vérifiées par `github.com/go-webauthn/webauthn` (version exacte épinglée après revue de chaîne d'approvisionnement ; signatures vérifiées par la bibliothèque standard de Go), clé du coffre ouverte par l'extension PRF de WebAuthn ou par une clé de récupération, avec HKDF-SHA-256 et AES-256-GCM (conception `docs/superpowers/specs/2026-11-22-compte-passkey-design.md` §5, §6). »
3. **Remplacer** tout le paragraphe « Seule exception, validée par le propriétaire (22 novembre) : le séquestre du profil du compte facultatif (…) Les pages Confidentialité et Sécurité le disent. » par : « Aucune exception : le séquestre du profil a été retiré le 22 novembre (conception `docs/superpowers/specs/2026-11-22-compte-passkey-design.md` §8). Le serveur ne reçoit jamais la sortie PRF d'une passkey, la clé de récupération ni la clé du compte ; il ne garde que les clés publiques des passkeys et l'empreinte `v_r` (test bloquant « le serveur ne voit rien » du compte). »

---

## Signalements (vigilance, conception et plan)

1. **Moyenne, exactitude — conception §8 et §14 (« le serveur revient à « aucune sortie » », « `TestNoOutgoingHTTP` sans exception »).** *(24 novembre : le repli reCAPTCHA est retiré, `recaptcha.go` n'a jamais existé dans le serveur ; seule la sortie du paiement reste.)* Faux : il reste deux sorties validées, la vérification reCAPTCHA (`server/internal/captcha/recaptcha.go`) et les prestataires de paiement (`server/internal/paiement/http.go`, relais `deploy/shhcheck/relais.go`). Correction : retirer seulement l'exception SMTP (lot S6) et garder `relais.go` (lot S8) ; corriger la phrase de la conception en « plus aucune sortie SMTP ».
2. **Faible, ambiguïté — conception §5.1 (et spécification principale A-G6) : « alphabet `0-9A-Z*~$=U` ».** Pris à la lettre, c'est 41 symboles (avec I, L, O, U), pas 37. Codé : l'alphabet de contrôle de Crockford, les 32 symboles de base (`0-9`, `A-Z` sans I, L, O, U) puis `*~$=U` (valeurs 32 à 36), écrit dans `compte-v3.json` (`constants.recup.controle`). Correction proposée : écrire « alphabet de contrôle de Crockford `0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U` » dans la conception.
3. **Moyenne, exploitation — tests WebAuthn et `rp.id` (conception §6.2, R1, R14).** Les navigateurs refusent une adresse IP comme `rp.id` ; les e2e et ui-e2e servent aujourd'hui sur `http://127.0.0.1:<port>` (`web/e2e/server.ts`). Correction : origine `http://localhost:<port>` pour les tests du compte (T1) ; le serveur accepte `localhost` en boucle locale seulement. Et « `rp.id` figé dans un test de configuration » ne peut pas figer `shhgone.com` si `rp.id` vient de `SHH_ORIGIN` : le test portera sur `deploy/env.example` et sur `deploy.sh` (refus si `SHH_ORIGIN` n'est pas `https://shhgone.com` quand `SHH_COMPTES=1`).
4. **Faible, ergonomie — symbole de contrôle `*`, `~`, `$`, `=` (5 clés sur 37, ≈ 13,5 %).** Difficile à taper sur un téléphone (clavier des symboles). Le format est validé, donc gardé ; l'écran de saisie doit l'accepter collé et le montrer en clair. Alternative possible si le propriétaire le souhaite (nouveau format, nouveaux vecteurs) : contrôle mod 37 retiré au profit d'un dernier caractère pris dans l'alphabet de base (mod 31, premier aussi, mêmes garanties contre une substitution et une transposition).
5. **Faible, simplicité — répartition « le site chiffre, le moteur dérive » (conception §5).** Gardée telle quelle : le moteur rend clés et AD, WebCrypto (site) et RustCrypto (apps) font l'AES. La forme nonce ‖ chiffré de 60 octets est donc écrite deux fois (TypeScript, puis l'app). Proposition pour plus tard (apps) : une fonction générique du moteur sur `platform::Key` (`sceller_enveloppe`, `ouvrir_enveloppe`), utilisable par le site via le fournisseur WebCrypto existant et par les apps ; non codée maintenant (aucun usage).
6. **Faible, exactitude — vecteurs.** `compte-v3.json` est écrit en entier par le moteur avec l'AES-GCM natif (RustCrypto) ; `compte.json` avait des sections écrites par WebCrypto. La preuve d'égalité est la même (le site refait chaque chiffré avec WebCrypto et compare), avec un seul générateur ; écrit dans `engine/vectors/README.md`.
7. **Faible, exploitation — entre S2 et W2**, `SHH_COMPTES=1` n'a pas de site utilisable (anciennes routes retirées, écrans pas encore refaits). Sans effet public (désactivé par défaut, jamais ouvert) ; ne pas activer les comptes en production avant D1.
8. **Faible, saisie — espace de largeur nulle (U+200B).** Ce n'est pas un blanc Unicode : une clé collée qui en contient est refusée (`cle_recup_longueur`, cas `espace_de_largeur_nulle` des vecteurs). Acceptable (message « Clé mal recopiée ») ; à revoir si des retours le montrent.
10. **Moyenne, exploitation — poids du moteur des partages** (`web/scripts/check-dist.mjs`, `ENGINE_BROTLI_MAX` = 156 000 o). Après P1 : 154 958 o en brotli, **marge de 1 042 o** (le lot ajoute ≈ 2,4 Ko : surtout la colle wasm-bindgen des 8 fonctions exportées). Le lot W5 retire les fonctions v2 (adresse, mot de passe, Argon2id du compte) et rendra de la marge ; d'ici là, tout ajout au moteur des partages risque de dépasser le plafond. Ne pas relever le plafond sans décision ; si W1 a besoin d'une fonction de plus, faire W5 d'abord ou regrouper les fonctions du compte.
9. **Information — environnement de développement.** `web/.node-version` demande Node 26 ; la machine de développement n'a que Node 22 et 24 : les tests du site y passent sous Node 24 avec `--experimental-webstorage` (localStorage) ; `crypto.argon2Sync` manque sous Node 22. La CI utilise la bonne version.

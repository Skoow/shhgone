# Revue de chaîne d'approvisionnement — `github.com/go-webauthn/webauthn` v0.18.2

> Lot S1 du plan `2026-11-22-compte-passkey.md`, faite le 22 novembre 2026 **avant** tout ajout à `server/go.mod`. Conception : `docs/superpowers/specs/2026-11-22-compte-passkey-design.md` §6.1, R8.

**Décision : acceptée**, versions exactes ci-dessous, avec trois conditions de code (§5) qui rendent inatteignables les parties inutiles (attestation, métadonnées FIDO, secp256k1). Aucun avis de sécurité n'affecte une version retenue.

## 1. Méthode

- Module jetable hors du dépôt (scratchpad) : `go mod init x`, `go get github.com/go-webauthn/webauthn@v0.18.2`, programme minimal qui appelle `webauthn.New`, `BeginRegistration`, `CreateCredential`, `BeginDiscoverableLogin`, `ValidateDiscoverableLogin` ; `go mod tidy` ; `go list -m all` ; `go list -deps` (paquets réellement compilés).
- Dates de publication : `https://proxy.golang.org/<module>/@v/<version>.info` (règle §24 : plus de 7 jours).
- Licences : fichier de licence de chaque module dans le cache (`/root/go/pkg/mod`), lu.
- Avis : `govulncheck` v1.9.0 (version déjà épinglée en CI), base `https://storage.googleapis.com/go-vulndb` (stockage public de `vuln.go.dev`, dont l'hôte n'est pas joignable depuis cet environnement ; même contenu, index du 11 novembre 2026), `-show verbose` ; et l'index `modules.json` de la même base pour les avis passés de chaque module. L'API des avis GitHub n'est pas joignable d'ici (session liée au dépôt) : **à recontrôler par Dependabot** une fois le module dans `go.mod`.
- Lecture du code : `grep` de `unsafe`, `import "C"`, `func init`, `net/http`, `net.Dial`, `os.Open*` dans les paquets compilés ; lecture des chemins de vérification de signature.

## 2. Modules tirés (sélection minimale de Go, `go list -m all` du module jetable)

| Module | Version | Publiée | Licence (fichier lu) | Mainteneurs | Rôle | Compilé dans le binaire |
|---|---|---|---|---|---|---|
| `github.com/go-webauthn/webauthn` | v0.18.2 | 2026-09-19 | **BSD-3-Clause** (vérifié : « Redistribution and use… », 3 clauses) | organisation go-webauthn (suite de `duo-labs/webauthn`, mainteneur principal James Elliott, Authelia) | cérémonies, `protocol`, `webauthncose` | oui |
| `github.com/go-webauthn/x` | v0.3.1 | 2026-09-10 | BSD-3-Clause ; sous-paquets recopiés : secp256k1 (ISC, Decred), `encoding/asn1` (BSD, Go), `revoke` (BSD-2, cfssl) | go-webauthn | `encoding/asn1` (lecture DER des signatures ECDSA), `crypto/secp256k1`, `revoke` | oui |
| `github.com/fxamacker/cbor/v2` | v2.9.4 | 2026-09-14 | MIT | Faye Amacker (utilisé par Kubernetes, etc.) | CBOR (objet d'attestation, clés COSE) | oui |
| `github.com/x448/float16` | v0.8.4 | 2020-01-17 | MIT | Montgomery Edwards, Faye Amacker | dépendance de cbor | oui |
| `github.com/golang-jwt/jwt/v5` | v5.3.1 | 2026-01-28 | MIT | golang-jwt (organisation) | métadonnées FIDO (JWT du MDS), SafetyNet | oui (inatteignable, §5) |
| `github.com/go-viper/mapstructure/v2` | v2.5.0 | 2026-01-12 | MIT | go-viper (organisation) | décodage des métadonnées | oui (inatteignable) |
| `github.com/google/go-tpm` | v0.9.8 | 2025-12-29 | Apache-2.0 | Google | attestation TPM (lecture des structures) | oui (inatteignable) |
| `github.com/tinylib/msgp` | v1.6.4 | 2026-03-16 | MIT | Philip Hofer, puis Klaus Post | sérialisation générée de `SessionData` | oui (non utilisée par nous : nous ne sérialisons pas `SessionData`) |
| `github.com/philhofer/fwd` | v1.2.0 | 2024-09-16 | MIT | Philip Hofer | dépendance de msgp | oui |
| `github.com/google/uuid` | v1.6.0 | 2024-01-23 | BSD-3-Clause | Google | AAGUID | oui (**déjà** indirect du serveur) |
| `golang.org/x/crypto` | v0.57.0 | 2026-09-08 | BSD-3-Clause (The Go Authors) | équipe Go | `ocsp` seulement (révocation des certificats des métadonnées) | oui (inatteignable) |
| `golang.org/x/sys` | v0.48.0 → **v0.50.0** | — | BSD-3-Clause | équipe Go | `unix` | déjà dans le serveur (v0.50.0 gardée) |

Modules de `go list -m all` qui ne servent qu'aux tests des dépendances et ne sont **pas** compilés : `github.com/google/go-cmp`, `github.com/google/go-tpm-tools`, `github.com/stretchr/testify`, `go.uber.org/mock`, `go.yaml.in/yaml/v3`, `golang.org/x/{mod,net,term,text,tools}`.

Toutes les versions ont plus de 7 jours (règle §24). v0.18.2 est la dernière publiée (`@v/list` : v0.18.0, v0.18.1, v0.18.2). Elle exige `go >= 1.26.0` : compatible avec la directive `go 1.26.0` et la toolchain go1.27.4 du serveur.

## 3. Avis de sécurité

- `govulncheck` v1.9.0 (programme minimal, toolchain go1.27.4) : **« Your code is affected by 0 vulnerabilities »** ; 0 dans les paquets importés ; 1 dans un module requis mais non appelé : GO-2026-5932 (`golang.org/x/crypto/openpgp`, paquet non maintenu ; **jamais compilé** ici, seul `x/crypto/ocsp` l'est).
- Avis passés de la base Go pour ces modules, tous corrigés **avant** les versions retenues : `go-viper/mapstructure/v2` GO-2025-3787 (corrigé en 2.3.0), GO-2025-3900 (2.4.0) ; `golang-jwt/jwt/v5` GO-2025-3553 (5.2.2) ; `google/go-tpm` GO-2021-0095 (0.3.0). Aucun avis pour go-webauthn, go-webauthn/x, cbor, msgp, fwd, float16, uuid.

## 4. Code (lecture)

- **Vérification des signatures : bibliothèque standard de Go** (`protocol/webauthncose/webauthncose.go`) : ES256 par `crypto/ecdsa.Verify` (après lecture DER par le fork `go-webauthn/x/encoding/asn1`, puis ré-encodage comparé octet à octet : seule une signature DER canonique passe) ; EdDSA par `crypto/ed25519.Verify` ; RS256 par `crypto/rsa.VerifyPKCS1v15` (PS256 par `rsa.VerifyPSS`, non demandé). ML-DSA (Go 1.27, `crypto/mldsa`) déclaré mais non demandé. **Seule exception** : ES256K (secp256k1) vérifié par le code recopié de Decred (`go-webauthn/x/crypto/secp256k1`, avec de l'assembleur amd64) ; **inatteignable** chez nous : l'algorithme de la clé est comparé à `pubKeyCredParams` (étape 16, `protocol/attestation.go`), que nous fixons à −7, −8, −257, et la connexion n'utilise que des clés enregistrées ainsi (contrôle redoublé côté serveur, §5).
- **Réseau** : un seul client sortant, `metadata.Fetch` (MDS FIDO, `http.Client`) et `go-webauthn/x/revoke` (OCSP/CRL, `http.DefaultClient`), appelés **seulement** par le décodage des métadonnées. Nous ne configurons aucun fournisseur de métadonnées (`Config.MDS` nil) et n'appelons jamais `metadata.Fetch` : aucune sortie. `protocol/related_origins.go` **sert** le document `/.well-known/webauthn` (rien n'est récupéré). `TestNoOutgoingHTTP` (analyse des sources de `server/internal`) ne couvre pas les dépendances : signalé (faible) ; garde-fou ajouté : test qui exige `MDS == nil` dans la configuration figée.
- **Fichiers** : aucun accès au disque dans les paquets compilés hors `metadata/providers/cached` (non compilé) et `go-tpm/tpmutil` (ouverture d'un périphérique TPM, jamais appelée : nous ne lisons que des structures d'attestation, et ce chemin est lui-même fermé, §5).
- **`unsafe`** : `tinylib/msgp` (conversion chaîne ↔ octets, sous étiquette de construction), `philhofer/fwd` ; `go-tpm/tpmutil/tbs` (Windows seulement). **cgo** : aucun.
- **`init()`** : enregistrement des formats d'attestation et des algorithmes (tables en mémoire), `jwt` (algorithmes), `msgp`, précalcul secp256k1 (tables, aucun effet de bord extérieur).

## 5. Conditions d'utilisation (codées au lot S3, avec tests)

1. **Configuration figée** (`server/internal/compte/webauthn.go`) : `RPID` = hôte de `SHH_ORIGIN`, `RPOrigins` = `SHH_ORIGIN` seul (puis origines Android exactes de `SHH_WEBAUTHN_ORIGINES_APPS`), `MDS` nil, `AttestationPreference: none`, `residentKey: required`, `userVerification: required`, algorithmes −7, −8, −257 seulement. Un test vérifie chaque champ.
2. **Attestation « none » exigée** : un objet d'attestation de format autre que `none` est refusé **avant** l'appel à la bibliothèque (`bad_request`) : le code TPM, Android, SafetyNet, `packed` et les chaînes de certificats n'est donc jamais exécuté sur une donnée reçue. Les navigateurs remplacent l'attestation par `none` quand `attestation: "none"` est demandé (WebAuthn niveau 3, §5.1.3) ; un écart serait vu au passage manuel sur appareils (§14 de la conception).
3. **Algorithme vérifié par nous aussi** à l'enregistrement (clé COSE relue : −7, −8 ou −257, sinon refus) : ES256K et ML-DSA ne peuvent pas entrer en base.
4. Rien de `SessionData` ni de `Credential` n'est gardé hors de ce que dit la conception §6.3 (ni AAGUID, ni transports, ni attestation, ni compteur, ni `BS`) ; le défi vit en mémoire seulement.

## 6. Décision et suivi

- **Acceptée** : `github.com/go-webauthn/webauthn v0.18.2` et les versions exactes du tableau §2, épinglées dans `server/go.mod` et `server/go.sum` au lot S3, ajoutées à `THIRD_PARTY_LICENSES.md`.
- Suivi : Dependabot (`gomod /server`, déjà configuré) ; `govulncheck` en CI ; mise à jour mensuelle avec relecture du journal des changements de go-webauthn (R8).
- **Signalement (faible, chaîne d'approvisionnement)** : beaucoup de code compilé (attestation, métadonnées, TPM, secp256k1) pour une fonction (vérifier une signature) dont nous n'utilisons qu'une petite partie ; c'est le prix de « aucune vérification WebAuthn réécrite à la main » (plan S1, étape 4). Les conditions §5 rendent le reste inatteignable depuis une requête.
- **Signalement (faible, environnement)** : l'index des avis a été lu sur `storage.googleapis.com/go-vulndb` (même base que `vuln.go.dev`, que le proxy de cet environnement refuse) ; la CI, qui joint `vuln.go.dev`, refera le contrôle.

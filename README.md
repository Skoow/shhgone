# Shhgone

**Partage chiffré de bout en bout, sans compte, avec des liens qui s'autodétruisent.**

Envoyez des fichiers, des photos, des vidéos, des notes ou un message vocal par un lien protégé par un mot de passe. Tout est chiffré sur votre appareil avant de partir : le serveur ne garde qu'un bloc illisible, puis l'efface à l'échéance ou après le nombre d'ouvertures choisi.

- Site : [shhgone.com](https://shhgone.com) (en préparation) · démo : [skoow.github.io/shhgone](https://skoow.github.io/shhgone/) (rien n'y est envoyé à un serveur, les partages restent dans l'onglet)
- Licence : [GNU AGPL-3.0](LICENSE)

> Projet en développement actif. La démo montre le parcours complet ; le service public, le compte facultatif et les offres payantes ne sont pas encore ouverts.

---

## Sommaire

1. [Ce que fait Shhgone](#ce-que-fait-shhgone)
2. [Comment ça marche](#comment-ça-marche)
3. [Ce que le serveur voit, et ce qu'il ne voit pas](#ce-que-le-serveur-voit-et-ce-quil-ne-voit-pas)
4. [Offres](#offres)
5. [Architecture](#architecture)
6. [Développer](#développer)
7. [Documentation](#documentation)
8. [Signaler une faille](#signaler-une-faille)
9. [Licence](#licence)

---

## Ce que fait Shhgone

- **Sans compte** : on dépose, on choisit la durée et le nombre d'ouvertures, on partage le lien et le mot de passe. Aucune adresse e-mail n'est demandée.
- **Compte facultatif, pour créer un salon** (pas encore ouvert) : sans e-mail ni mot de passe, par passkey, avec une clé de récupération à noter. Le profil et les listes sont chiffrés sur l'appareil ; le serveur ne garde que les clés publiques des passkeys et un code à sens unique de la clé de récupération.
- **Tous les contenus** : fichiers, photos, vidéos (pellicule ou appareil photo), notes, mémo vocal, jusqu'à 200 éléments par partage.
- **Liens qui disparaissent** : durée de 1, 6, 12 ou 24 heures, de 1 à 5 ouvertures ; à l'échéance, plus rien n'est lisible ni stocké.
- **Mot de passe toujours généré** : il ne part jamais dans le lien partagé ; on l'envoie par un autre moyen (sauf le QR code « en face à face », qui contient les deux).
- **Nettoyage au choix** : retirer les métadonnées (position GPS, auteur, appareil) des photos, vidéos, PDF et documents bureautiques, fichier par fichier. Le fichier nettoyé n'a plus la même empreinte que l'original ; sans nettoyage, le destinataire reçoit les mêmes octets.
- **Empreinte SHA-256** de chaque fichier, affichée chez l'expéditeur et chez le destinataire, pour comparer avec ses propres outils (`shasum -a 256`, `certutil`).
- **Droits du destinataire** : voir seulement, enregistrer, ou garder dans le coffre de son téléphone.
- **Gestion** : un lien de gestion, gardé par l'expéditeur, permet de suivre les ouvertures et de détruire le partage à tout moment.
- **Historique local** : « Mes partages » vit sur l'appareil, chiffré ; rien n'est gardé côté serveur.

## Comment ça marche

1. **Sur votre appareil**, le navigateur tire une clé aléatoire de 256 bits (`K_lien`) et chiffre chaque élément en **AES-256-GCM**, morceau par morceau (64 Kio), avec une clé propre à chaque élément.
2. Le **mot de passe** est dérivé par **Argon2id** (64 Mio, 3 passes) ; il protège une enveloppe sans laquelle le lien seul ne suffit pas.
3. Le lien a la forme `https://shhgone.com/s#<clé>`. La partie après le `#` (le **fragment**) n'est **jamais envoyée au serveur** par le navigateur ; la page la lit, puis la retire de la barre d'adresse et de l'historique.
4. Le serveur reçoit des segments chiffrés de taille arrondie, une liste de fichiers chiffrée elle aussi, et des vérificateurs dérivés. Il ne peut ni déchiffrer, ni connaître les noms, ni retrouver le mot de passe.
5. À l'ouverture, le destinataire saisit le mot de passe ; tout est déchiffré **chez lui**. Après la dernière ouverture ou à l'échéance, le serveur efface le partage.

Aucune cryptographie maison : WebCrypto pour AES-GCM et l'aléa, bibliothèques reconnues de l'écosystème RustCrypto (HKDF, SHA-2, HMAC, Argon2) dans un moteur commun en Rust, compilé en WebAssembly pour le site. Des **vecteurs de test communs** (`engine/vectors/`) garantissent que le site et les futures applications produisent exactement les mêmes résultats.

## Ce que le serveur voit, et ce qu'il ne voit pas

| Le serveur **ne voit jamais** | Le serveur **voit** |
|---|---|
| le contenu, les noms et types des fichiers | des segments chiffrés, dans une taille arrondie (palier) |
| la clé du lien, le mot de passe | des vérificateurs dérivés (empreintes), comparés en temps constant |
| l'empreinte SHA-256 des fichiers | l'échéance et le nombre d'ouvertures restantes |
| votre adresse IP sur disque | l'adresse IP en mémoire seulement, le temps de limiter les abus |

Aucune ressource tierce sur le site (ni CDN, ni police externe, ni statistiques, ni traceur), une politique de sécurité du contenu stricte, des empreintes d'intégrité (SRI) sur chaque script, et un test automatique « le serveur ne voit rien » qui fouille la mémoire, la base et le disque du serveur après un partage : il bloque toute mise en ligne.

Ces mesures réduisent fortement les risques ; aucune ne rend un service invulnérable. Le détail des menaces prises en compte et des limites connues est dans la [spécification](docs/superpowers/specs/2026-11-03-shhdrop-design.md).

## Offres

Le gratuit reste complet et privé, pour toujours. Les offres payantes n'ajoutent **aucune sécurité** : seulement de la capacité et du confort (prix TTC, prévus, pas encore en vente).

| | Gratuit | Plus | Pro |
|---|---|---|---|
| Taille par partage | 2 Go | 10 Go | 30 Go |
| Durée maximale | 24 h | 3 jours | 7 jours |
| Ouvertures | jusqu'à 5 | jusqu'à 10 | jusqu'à 20 |
| Prix | 0 € | 7 € / mois ou 70 € / an | 20 € / mois ou 200 € / an |

Le paiement passera par un vendeur officiel (Paddle) : nous ne recevrons ni votre identité, ni votre moyen de paiement. Les partages payants seront autorisés par des jetons anonymes (Privacy Pass) qui ne permettent pas de relier un partage à son payeur.

## Architecture

```
web/      site : Svelte 5, Vite, TypeScript ; pages statiques avec empreintes SRI
engine/   moteur commun en Rust : chiffrement, format des partages, liens
          (core, wasm pour le site, salon) et vecteurs de test communs
server/   serveur en Go : API, stockage SQLite, limites, nettoyage
deploy/   Caddy (TLS 1.3), Docker, scripts d'installation, de sauvegarde et de contrôle
docs/     spécifications et plans
```

- Le site a trois sortes de pages : `/` (accueil et envoi), `/s` (ouverture et gestion d'un partage, sans le code d'envoi) et une page par page d'information (`/securite`, `/confidentialite`, `/offres`…).
- Le serveur Go sert le site et l'API derrière Caddy ; il n'écrit aucune adresse IP sur disque et efface les partages à l'échéance.
- Les applications iOS et Android natives (moteur Rust commun, interface Flutter) sont prévues plus tard ; le format des partages et des liens est déjà pensé pour elles.

## Développer

Prérequis : Node (voir `web/.node-version`), Rust (voir `engine/rust-toolchain.toml`) avec la cible `wasm32-unknown-unknown` et `wasm-bindgen-cli`, Go (voir `server/go.mod`).

```bash
cd web && npm ci && npm run build:engine && npx vite
```

```bash
make test
```

`make test` lance le moteur Rust (format, clippy, tests), le serveur Go (tests avec détection de courses), le site (tests unitaires, build, `check-dist`) et les tests de bout en bout. Les tests d'interface complets (Playwright, Chromium et WebKit) se lancent avec `make test-ui`.

## Documentation

- [Spécification principale](docs/superpowers/specs/2026-11-03-shhdrop-design.md) : format, sécurité, ce que voit le serveur, décisions
- [Spécification de l'interface](docs/superpowers/specs/2026-11-04-shhdrop-ui-design.md)
- [Moteur Rust](docs/superpowers/specs/2026-11-10-moteur-rust-1-chiffrement-design.md) et [vecteurs de test](engine/vectors/README.md)
- [Liens sous /s et pages séparées](docs/superpowers/specs/2026-11-16-liens-s-et-pages-design.md)
- [Déploiement](deploy/README.md)

## Signaler une faille

Merci de ne pas ouvrir de ticket public pour une faille de sécurité : utilisez les [avis de sécurité privés de GitHub](https://github.com/Skoow/shhgone/security/advisories/new). Un contenu illicite se signale depuis le site (page « Signaler »).

## Licence

Le code est publié sous licence [GNU AGPL-3.0](LICENSE) (`AGPL-3.0-only`) : vous pouvez l'étudier, le modifier et le redistribuer ; un service en ligne qui utilise une version modifiée doit en publier le code. Les composants tiers (liste de mots, polices, dépendances) gardent leur propre licence, détaillée dans [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

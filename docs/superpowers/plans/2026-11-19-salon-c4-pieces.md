# Salon v3, étape C-4 : pièces, vocaux, fichiers du salon, avatars — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** envoyer et recevoir dans le salon des fichiers, photos, vidéos et vocaux chiffrés de bout en bout (paquet SHH2 d'un élément sous une graine R tirée par le moteur, R dans le message MLS `piece`), les afficher (images et vocaux de 16 Mo au plus d'office, le reste au clic), les rassembler dans l'écran « Fichiers », et donner à chacun un avatar (initiale sur sa couleur, ou photo ré-encodée en 256 × 256).

**Architecture :** `web/src/salon/pieces.ts` (chiffrement et assemblage du conteneur avec le moteur des partages : `newSeed`, `contentKeys`, `elementSealer`, `sealFinal` ; lecture : `readHeader`, `seedFromBytes`, `contentKeysChecked`, `openStream`) ; routes des pièces dans `web/src/salon/api.ts` (seul fichier du salon qui fait des requêtes) ; le client lie la trame à sa pièce (`0x01` ‖ identifiant, plan C-2 point 2) ; écrans : `Piece.svelte` (bulle de pièce), `Fichiers.svelte` (écran « Fichiers »), avatars dans `Membres.svelte` et les bulles.

**Tech Stack :** comme C-3 ; moteur des partages (`engine/wasm`) : deux fonctions nouvelles, `seedBytes` et `seedFromBytes` (point 1).

**Spec :** salon v3 §3.4, §4.4, §7.2, §10 (vocaux, lien pièce ↔ trame), §14.3, §14.6 ; spec principale §39.5 ; « Protocole » et Task 13 du plan C-2.

## Points tranchés (décisions prises par défaut, validées par le propriétaire le 22 novembre)

1. **Élevée, manque du moteur — la graine R d'une pièce.** La v3 §3.4 dit « R voyage dans un message MLS », mais le moteur des partages ne rendait jamais R à JavaScript (graine opaque). **Corrigé ici :** `seedBytes(seed)` (copie de R, à effacer) et `seedFromBytes(r)` (graine d'ouverture seulement, comme après `open` : elle ne chiffre jamais de manifeste) dans `engine/wasm` ; jamais appelées par les partages (règle de sources). Coût : quelques centaines d'octets du module des partages (150 086 → mesuré dans le rapport, plafond 156 000).
2. **Moyenne — assemblage du conteneur.** Le serveur des pièces n'accepte que des segments entiers (pas de `?from`) : le client assemble chaque segment (en-tête, morceaux de l'élément, morceau du manifeste, aléa ailleurs) dans un tampon de 4 Mio au plus, puis `finalize {fill_from: 0, fill_to: 0}`.
3. **Moyenne — nettoyage.** Comme les partages (`stripMetadata`) : un fichier nettoyé part nettoyé ; un échec ou un fichier protégé demande « Envoyer tel quel » (confirmation) ; un format sans nettoyage part tel quel. Les vocaux enregistrés ici n'ont pas de métadonnées.
4. **Moyenne, manque du moteur — coches des documents (§14.2 : `piece_ouverte`, `piece_telechargee`).** Ces sortes n'existent pas dans le moteur (format des messages, vecteurs communs) : **non faites** ; l'écran « Fichiers » garde « Nouveau » / « Vu » / « Téléchargé » pour soi seulement, calculés sur l'appareil. À ajouter au moteur avec leurs vecteurs (C-4 bis).
5. **Faible — albums, sélection multiple à la réception, archive `.zip`.** Plusieurs fichiers choisis d'un coup partent l'un après l'autre (un message chacun) ; l'affichage en album et le téléchargement groupé en archive ne sont pas faits ici (reste signalé).
6. **Faible — paliers vocaux.** Ceux du serveur (1, 16, 80) ; un vocal plus grand que le palier 80 (5 Mio) est refusé avec un message clair (10 min d'Opus à 64 kbit/s ≈ 4,8 Mo).
7. **Faible — avatar.** Photo ré-encodée par `ui/avatar.ts` (256 × 256, JPEG de 64 Ko au plus), pièce de palier 1 annoncée dans `profil.avatar` ; chacun peut masquer l'avatar d'un participant pour soi.

## Tasks

### Task 1 : moteur, graine des pièces
**Files :** Modify `engine/wasm/src/lib.rs`, `web/src/engine/index.ts`, `web/src/engine/engine.test.ts`.
- [ ] test : une R neuve rendue en clair puis relue par `seedFromBytes` ouvre le paquet que la première a scellé ; `seedFromBytes` d'une mauvaise longueur → `graine_invalide` ; `contentKeys` d'une graine relue → `cle_deja_utilisee`.

### Task 2 : pièces (envoi, lecture)
**Files :** Create `web/src/salon/pieces.ts`, `web/e2e/salon-pieces-ui.test.ts` ; Modify `web/src/salon/api.ts`, `web/src/salon/client.ts`.
- [x] test de bout en bout : fichier envoyé par un membre, message `piece` reçu par l'autre, octets relus identiques ; vocal (palier vocal) ; retrait de la pièce avec sa trame.

### Task 3 : écrans
**Files :** Create `web/src/routes/salon/Piece.svelte`, `web/src/routes/salon/Fichiers.svelte` ; Modify `Conversation.svelte`, `Membres.svelte`, `Explication.svelte`, i18n.
- [ ] joindre (sélecteur, glisser-déposer, coller une image), vocal (enregistreur existant), image affichée d'office (16 Mo au plus, jamais SVG), « Enregistrer », écran « Fichiers » (grille, liste, filtres par type et par membre, « Voir dans la conversation »), avatar par défaut et photo.

### Task 4 : Playwright
**Files :** Modify `web/ui-e2e/salon.spec.ts`.
- [x] une image envoyée par A est affichée chez B, un document téléchargé chez B a les mêmes octets ; le nom du fichier et son contenu ne sont pas dans le dossier de données ni dans les sorties du serveur.

## État (19 novembre)

Faits et testés : Tasks 1 à 4 (`web/src/salon/pieces.test.ts` : conteneurs de 0 à 4 Mio relus octet pour octet ; `web/e2e/salon-ui.test.ts` : pièce liée à sa trame, relue par l'autre membre ; `web/ui-e2e/salon.spec.ts` : image affichée et document enregistré chez l'invité, rien chez le serveur). Le module des partages passe de 150 086 à 150 859 octets en brotli (plafond 156 000).

Version finale (19 novembre), faits et testés :
- **Premier vocal** (défaut du 19 novembre, corrigé par décision du propriétaire) : réserve de départ d'un palier 16 (1 048 880 octets) pour chaque occupant (`server/internal/salon/pieces.go`, `TestReserveVocale`, `TestReserveVocaleOccupant`, `TestQuotasPieces`) ; le premier vocal part tout de suite, le second attend (429), `web/e2e/salon-ui.test.ts`.
- **Point 4, coches « Ouvert » et « Téléchargé »** : sortes `piece_ouverte` et `piece_telechargee` dans le moteur, vecteurs communs, `make test-engine` vert ; affichées chez l'expéditeur (Playwright). *Décision par défaut, à valider :* « Ouvert » = image affichée dans un message vu, vocal ou vidéo lancés.
- **Point 5, albums et archive** : albums en grille (mise en page seule) ; « Tout sélectionner » et « Télécharger (N) » dans « Fichiers », une archive `.zip` stockée faite sur l'appareil (200 Mio au plus), chaque fichier accusé « Téléchargé ».
- Plafond brotli du module du salon relevé à 435 000 octets (430 211 mesurés ; justification dans `check-dist.mjs`).

Restes (22 novembre) : **faits** : mode sélection par appui long dans la conversation (et « Sélectionner » au clavier, « Télécharger (N) » en .zip, albums compris) ; fiche « Infos » avec l'heure de chaque accusé ; pièces relues par lots de 8 Mio (pic de mémoire d'une vidéo divisé par deux). **Reste, avec sa raison** : lire une vidéo de plus de 16 Mo PENDANT son téléchargement : MediaSource n'accepte que du MP4 fragmenté ou du WebM (les vidéos de téléphone sont du MP4 ordinaire, à réécrire par une bibliothèque de démultiplexage absente du projet) et n'existe pas dans Safari sur iPhone ; la seule voie générale est un service worker qui déchiffre à la demande les requêtes partielles de `<video>`, donc qui tient les clés : à décider par le propriétaire (surface d'attaque nouvelle), non fait. Test manquant signalé (faible) : `seedFromBytes` d'une mauvaise longueur → `graine_invalide` n'a pas de test (case ci-dessus laissée vide).

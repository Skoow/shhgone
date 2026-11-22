# Salon v3, étape C-3 : écrans du salon (création, entrée, conversation) — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** le salon utilisable de bout en bout dans le site, en code de production : créer un salon (compte exigé, D42-26), le lien et le mot de passe prêts, l'entrée par le lien (mot de passe, page d'explication, pseudonyme), la conversation chiffrée (texte, émojis, réactions, réponses, modifier, retirer, accusés « envoyé / reçu / vu », « écrit », présence et dernière connexion), contre le vrai serveur Go (`SHH_SALONS=1`).

**Architecture :** trois couches dans `web/src/salon/`, testées séparément :
1. `protocole.ts` (pur) : enregistrements du serveur lus et vérifiés (taille exacte par type, rangs), messages du client construits (« Protocole » du plan C-2).
2. `client.ts` : le client du salon (WebSocket, moteur MLS, file d'envoi à une trame en vol, `0x0B`/`0x0C`/`0x0F`, reconnexion, reprise, Commits, KeyPackages, accusés groupés) ; aucune vue. Il émet des événements typés ; il ne sait rien de Svelte. `api.ts` : routes JSON du salon (sauf la création avec session, qui passe par `account/api.ts`, seul fichier qui écrit `X-Shh-Session`).
3. `conversation.ts` (pur) : le fil tel qu'il s'affiche, calculé des événements (exigences C-3 9, 10, 11 : modif et retrait de l'auteur seul, premier identifiant en ordre `seq`, accusés une fois par siège, unicité des pseudonymes par `cleUnicite`, lignes système). `salon.svelte.ts` relie client et conversation à l'état des écrans.
Écrans dans `web/src/routes/salon/` ; routes `/salon/nouveau` (création) et `/salon` (lien `#c…`, salon prêt, conversation), dans l'application (index.html) : la session du compte (en mémoire par défaut) doit survivre au passage de l'accueil à la création, ce qu'un fichier HTML à part empêcherait.

**Tech Stack :** Svelte 5.57.3, TypeScript 7.0.2, vitest 5.1.0 (happy-dom), Playwright 1.65.0 (Chromium, `PW_LOCAL_CHROMIUM=1`), module wasm du salon (`web/src/salon/engine.ts`), serveur Go (`server/`), Node 26.13.0.

**Spec :** `docs/superpowers/specs/2026-11-11-salon-v3-design.md` §3.6.1 (« Exigences pour C-3 » 1 à 36), §4, §6, §7.1, §9, §14.1, §14.2, §14.4 ; `docs/superpowers/specs/2026-11-03-shhdrop-design.md` §39.1, §39.4, §39.5, §39.6 ; `docs/superpowers/specs/2026-11-14-compte-email-design.md` §10.4 ; « Protocole » de `docs/superpowers/plans/2026-11-12-salon-c2-serveur.md`.

## Points à trancher (décisions prises par défaut dans ce plan, à valider par le propriétaire)

Chaque point : gravité, endroit, problème, correction retenue.

1. **Moyenne, liens — forme du lien du salon.** La spec principale écrit `https://shhdrop.app/#c<43>` ; depuis le 18 novembre un « # » à la racine n'ouvre plus rien (les liens de partage sont sous `/s`). **Retenu :** `https://shhgone.com/salon#c<43>` (page `/salon` de l'application), même hygiène que §5.3 (lu puis retiré de la barre). Les apps (D42-20) reconnaîtront `/salon#c…` comme `/s#…`. L'historique accepte déjà tout chemin (`ROOM_LINK`).
2. **Moyenne, manque S3 (spec v3 §15.2) — lien de gestion du salon.** **Retenu :** `https://shhgone.com/salon#s<43>` (`S_gestion`), affiché sur « Salon prêt » derrière « Afficher le lien de gestion » avec l'avertissement de l'exigence 36, gardé dans l'historique local (`manage` d'une entrée `salon_cree`, chiffré au repos, comme celui d'un envoi) et dans le coffre privé du compte (§10.4). **Écart corrigé :** la spec v3 §15.2 dit que l'historique garde déjà `S_gestion` ; c'était faux (`cleanEntry` refusait tout `manage` pour un salon). Le recollage du lien de gestion (`#s`) est fait en C-5 (avec les droits du créateur).
3. **Moyenne, exigence C-3 1 — colle du module hors du script principal.** Depuis le compte (lot 9, `account/session.svelte.ts` importe `salon/engine.ts` pour la règle du pseudo), la colle JavaScript du module du salon est déjà dans le script de l'application (index.html) quand `__COMPTES__` est vrai ; elle ne l'est pas dans la page d'ouverture des partages (`s.html`). **Retenu :** le salon vit dans l'application (point d'architecture ci-dessus) ; `check-dist` exige que `s.html` et les pages d'information ne citent ni la colle ni le `.wasm` du salon ; le `.wasm` n'est lu qu'au premier besoin du salon. Séparer la colle de l'application demanderait un `import()` dynamique (interdit, §28.3) ou un second fichier HTML (perte de la session en mémoire). À trancher si le propriétaire veut un script à part.
4. **Élevée, exploitation, exigence C-3 2 — image Docker.** `deploy/Dockerfile` ne construit pas le module du salon ; or le site avec compte l'importe déjà : le build de l'image échouerait (« import introuvable »). **Corrigé ici :** l'étape `engine` construit aussi `shhdrop-salon-wasm` (profil `wasm-salon`, mêmes options que `build-engine.mjs`) et le site reçoit `salon/pkg/` ; `SHH_ENGINE_PREBUILT=1` vérifie les deux dossiers. Le job `repro-docker` de la CI compare `salon/pkg/` (fichier `.github/workflows/ci.yml`).
5. **Moyenne, manque — preuve de membre (D41-26).** Le moteur n'expose pas encore le scellement de la preuve de membre (HKDF « membre-local », XChaCha20-Poly1305) ; l'écrire en TypeScript serait de la crypto hors moteur, et le module du salon est à 316 octets de son plafond brotli (S7). **Retenu pour C-3 :** pas de preuve de membre. Un invité qui recharge la page revient par le mot de passe sur une **nouvelle place** (l'ancienne reste « hors ligne » jusqu'à la fin ou à son exclusion) ; la page prévient avant de quitter (`beforeunload`). Le créateur revient avec ses droits par `S_gestion` (historique local ou coffre du compte, siège 0). À faire en C-5 si le plafond est relevé (S7), sinon signalé comme reste.
6. **Moyenne, exigence C-3 17 — groupe orphelin.** **Retenu :** à la fin du rattrapage (pong du ping d'accueil), le créateur qui n'est pas dans un groupe et ne voit aucun autre siège en ligne recrée le groupe (`Salon.creer(0, nonce, clés, true, S_gestion)`) et ajoute les KeyPackages reçus ; tout membre qui reçoit `epoque_perdue` rentre par une reprise (exigence C-2 5 : `depuis = 0xFFFF…`, nouvelle identité, nouveau KeyPackage). Limite : un membre resté dans l'ancien groupe et hors ligne à ce moment rentre à son retour par `epoque_perdue`.
7. **Faible — accusés.** `recu` et `vu` groupés, une trame au plus par période de 2,5 s (exigence 19) ; « vu » = message affiché, page visible, 1 s (`IntersectionObserver`, `visibilitychange`).
8. **Faible — « écrit ».** Envoyé au plus toutes les 4 s pendant la frappe ; affiché 6 s après le dernier reçu ; jamais pour un texte vide.
9. **Faible — renouvellement MLS (exigence 12).** `renouveler` après 100 trames envoyées ou 1 h depuis le dernier Commit de ce membre, seulement s'il est le plus petit siège en ligne du groupe (évite que tous renouvellent ensemble et se fassent perdre leurs Commits).
10. **Faible — son et silencieux (§14.4).** Reportés en C-5 (le réglage doit être gardé dans la base locale chiffrée, effacée à la fin du salon : avec la règle d'effacement et la fin du salon).

## Global Constraints

- CLAUDE.md : le serveur ne reçoit jamais de texte, pseudonyme, nom de fichier, clé ou mot de passe en clair ; `X-Shh-Manage` = `jetonGestion(S_gestion)`, jamais `S_gestion` (exigence 33) ; aucune ressource tierce ; aucune IP sur disque ; tests avant tout « fait » ; commits `--author="Skoow <190851638+Skoow@users.noreply.github.com>"`.
- Règles de sources (`web/src/source-rules.test.ts`) : pas de `{@html}`, pas d'attribut `style`, pas de `fetch(` dans les écrans (`routes/`, `ui/`…), aucun stockage navigateur hors des modules autorisés, pas d'`import()` dynamique, `X-Shh-Session` seulement dans `account/api.ts`. Le salon : réseau seulement dans `salon/api.ts` et `salon/client.ts` (règle ajoutée).
- Textes : `nettoyerTexte`, `verifierPseudo`, `cleUnicite`, `nettoyerNom` du moteur seulement (exigence 4) ; jamais `Intl.Segmenter` ni `safeName` pour le salon.
- Secrets rendus par le module mis à zéro après usage : `K_accès_s`, `K_preuve_s`, `J_gestion` (exigence 5, 33).
- Démo (GitHub Pages) : drapeau de construction `__SALONS__` faux ; le salon y reste « bientôt », aucune route `/salon` (404 de l'application), aucun faux serveur du salon.
- Liens `https?://` cliquables, adresse affichée en entier, `rel="noopener noreferrer"`, `referrerpolicy="no-referrer"`, aucun aperçu (§39.5).
- Mobile d'abord (402 px), cibles de 44 px, `role="log"` pour le fil, `forced-colors`, mouvement réduit, français et anglais (mêmes clés, règles de `i18n.test.ts`).

## Review Focus

1. Aucun message perdu ni dupliqué entre rattrapage et direct, ni à la reconnexion (`depuis` = dernier rang vu) ; une trame à la fois en vol, mêmes octets après `0x0B`.
2. Un envoi refusé par le moteur (`commit_en_cours`, `retrait_en_attente`) attend et part ensuite ; jamais contourné (exigence 23).
3. `modif`/`retrait` d'un autre que l'auteur ignorés ; identifiant déjà vu ignoré ; pseudonyme en double : le premier en ordre `seq` le garde.
4. Le serveur ne voit rien (test bloquant étendu au salon par l'interface).
5. Code de fermeture : 4005 ne reconnecte pas ; 4004 refait l'entrée ; 4002 efface et dit l'exclusion ; 1000 après `0x05` : écran de fin.

---

### Task 1 : protocole pur

**Files :** Create `web/src/salon/protocole.ts`, `web/src/salon/protocole.test.ts`.

- [x] **Step 1 :** tests : chaque type serveur de taille exacte est lu (`0x01` siège, heure, trame ; `0x02`/`0x0A` siège et nonce ; `0x03` ; `0x05` raison ; `0x07` présence et minute ; `0x08` ; `0x09` siège `0xFF` → `undefined`, `r` ; `0x0B` secondes ; `0x0C` ; `0x0D` créateur, n annonces de 25 octets ; `0x0E` ; `0x0F` ; `0x10` départ, secondes, places) ; taille fausse ou type inconnu → `null` ; accueil de 51 octets (jeton ‖ `depuis`, reprise = `0xFFFFFFFFFFFFFFFF`) ; `0x01` avec et sans pièce ; `0x02`, `0x03`, `0x04`, `0x05`.
- [x] **Step 2 :** FAIL, puis code, puis PASS.

### Task 2 : routes JSON du salon et création avec session

**Files :** Create `web/src/salon/api.ts`, `web/src/salon/api.test.ts` ; Modify `web/src/account/api.ts` (`creerSalon`), `web/src/account/api.test.ts`, `web/src/account/session.svelte.ts` (`creerSalonDuCompte`), `web/src/source-rules.test.ts`.

- [x] **Step 1 :** tests (fetch simulé) : `meta`, `rejoindre` (avec `X-Shh-Manage` = jeton de gestion pour le créateur), `gestion`, `detruire`, `signaler`, `reglages`, `exclure` ; JSON strict, en-têtes exacts, `credentials: "omit"`, `redirect: "error"` ; erreurs typées `SalonError(status, code, attemptsLeft?, retryS?)` ; coupure → `Error("reseau")`. `account/api.ts creerSalon` : `X-Shh-Session` ajouté aux en-têtes du salon, réponse `{ expires_in_s }` ; refus `palier` (409, `salons`, `places`, `heures`), `banni`, `compte_requis`.
- [x] **Step 2 :** FAIL, code, PASS ; règle de sources : `WebSocket` seulement dans `salon/client.ts`, `fetch` du salon seulement dans `salon/api.ts`.

### Task 3 : client du salon

**Files :** Create `web/src/salon/client.ts`, `web/src/salon/client.test.ts` (WebSocket simulé et vrai moteur sous Node), `web/e2e/salon-ui.test.ts` (vrai serveur, trois clients de production).

Rôles (repris du client de test `web/e2e/salon-client.ts`, plus les exigences C-3) : `0x0D` → `remplacerAnnonces` avant toute trame, KeyPackage publié si hors du groupe ; `0x02`/`0x0A` → `annoncer` puis KeyPackage republié si en attente (exigence 15) ; `0x03` → `marquerParti` ; `0x09` → `marquerExclu` ; `0x07` → présence (et KeyPackage republié si en attente) ; `0x01` → `recevoirTrame` ; `keyPackage` → `ajouter` par le plus petit siège en ligne du groupe ; `commitAccepte { welcome }` → Welcome envoyé ; `commitPerdu` → intentions rejouées ; `entree` → trames rejouées traitées comme en direct (exigence 6) ; `ignore` d'une trame des règles 1 à 3 → `0x05` (exigence 14) ; `attente_pleine` ou `epoque_perdue` → reprise (nouvelle identité) ; ping après l'accueil, fin du rattrapage au pong (exigence 20) ; fermeture 1001/1011/4006 ou coupure → reconnexion avec `depuis` (1 s, 2 s… 30 s) ; 4004 → nouvelle entrée par `rejoindre` (exigence 16) ; 4005 → arrêt sans reconnexion (exigence 35) ; 4002 ou `0x05` raison 5 → exclusion ; `0x05` raisons 1, 2, 7 → fin. Envoi : une trame en vol (exigence 20), `0x0B` → mêmes octets après le délai, `0x0C` → échec « plein », refus du moteur → attente (exigence 23 ; textes à 2 s et 30 s) ; renouvellement MLS (point 9) ; accusés groupés (point 7).

- [ ] **Step 1 :** tests unitaires (faux WebSocket, vrai moteur) : accueil, ordre des rôles, une trame en vol, `0x0B` mêmes octets, reconnexion avec `depuis`, 4005 sans reconnexion, 4004 → rejoindre.
- [ ] **Step 2 :** test e2e (vrai serveur) : création, deux invités, messages chiffrés échangés dans les deux sens, reconnexion sans perte ni doublon, reprise, départ.
- [ ] **Step 3 :** FAIL, code, PASS.

### Task 4 : fil de la conversation

**Files :** Create `web/src/salon/conversation.ts`, `web/src/salon/conversation.test.ts`.

- [ ] **Step 1 :** tests : texte, réponse (citation lue du message local, sinon « indisponible »), réaction (une par siège et par émoji, retirée par une seconde réaction identique), modif et retrait de l'auteur seul (sinon ignorés), identifiant en double ignoré, accusés `recu`/`vu` comptés une fois par siège parmi les attendus (présents à l'envoi, expéditeur exclu), coches (envoyé au `0x0F`, reçu, vu), « écrit » (6 s), profil : pseudonyme unique par `cleUnicite` (premier en ordre `seq` ; l'autre « Participant N » ; soi renvoyé au champ), changement de pseudonyme (« Léa s'appelle maintenant Lou »), couleur (plus petit indice libre), lignes système (rejoint, parti, de retour, créateur revenu, code de vérification changé : exigences 9 et 34), présence et dernière connexion (`0x07` fait foi, exigence C-2 Task 9b), séparateur « Nouveaux messages ».
- [ ] **Step 2 :** FAIL, code, PASS.

### Task 5 : routes, entrées, drapeau `__SALONS__`

**Files :** Modify `web/src/app/router.svelte.ts` (+ test), `web/src/App.svelte`, `web/vite.config.ts`, `web/vitest.config.ts`, `web/src/env.d.ts`, `server/cmd/shhdrop/static.go` (`/salon`, `/salon/nouveau`), `web/src/routes/Compose.svelte`, `web/src/routes/Home.svelte` (comportement du bouton `data-make="room"` seulement), `web/src/ui/TopNav.svelte`, `web/src/ui/MobileMenu.svelte`, `web/src/ui/AddSheet.svelte`, `web/src/ui/NewSheet.svelte`, `web/src/routes/home/Inbox.svelte`, `web/src/routes/compte/Connexion.svelte`, `web/src/routes/compte/Inscription.svelte` (suite `salon` → `/salon/nouveau`).

- [ ] **Step 1 :** tests du routeur : `/salon` et `/salon/nouveau` seulement si `__SALONS__` ; serveur : `TestAppRoutesMatchClientRouter` vert.
- [ ] **Step 2 :** code ; les entrées « Salon » mènent à `/salon/nouveau` (production) et restent « bientôt » dans la démo.

### Task 6 : écrans

**Files :** Create `web/src/routes/salon/Salon.svelte` (aiguillage), `Nouveau.svelte` (création), `Pret.svelte` (salon prêt), `Entree.svelte` (mot de passe), `Explication.svelte` (page d'explication et pseudonyme), `Conversation.svelte`, `Bulle.svelte`, `Saisie.svelte`, `Membres.svelte`, `EmojiPicker.svelte`, `web/src/salon/salon.svelte.ts`, `web/src/salon/liens.ts` (+ tests) ; Modify `web/src/i18n/fr.ts`, `web/src/i18n/en.ts`, `web/src/history/store.ts` (+ test : `manage` `#s` d'un salon créé).

- [ ] **Step 1 :** tests de composants (happy-dom) des cas sans réseau : création sans session → connexion ; mot de passe vide refusé ; pseudonyme refusé par le moteur avec le bon message ; lien cliquable seulement `https?://`.
- [ ] **Step 2 :** code, PASS ; `npm run check` vert.

### Task 7 : Playwright de bout en bout, « le serveur ne voit rien »

**Files :** Create `web/ui-e2e/salon.spec.ts` ; Modify `web/ui-e2e/comptes-site.ts` si besoin, `web/scripts/check-dist.mjs` (+ test) ; `deploy/Dockerfile`, `web/scripts/build-engine.mjs`, `.github/workflows/ci.yml` (point 4).

- [x] **Step 1 :** test : un compte (inscription par l'interface, faux SMTP), création du salon, lien et mot de passe lus sur « Salon prêt », le créateur entre ; un second contexte de navigateur ouvre le lien, tape le mot de passe, choisit un pseudonyme, entre ; échange de messages dans les deux sens, réaction, réponse, modification, retrait, « écrit », coches « vu », présence ; puis recherche, dans le dossier de données et les sorties du serveur, des textes, pseudonymes, mot de passe, lien et clés : aucun.
- [x] **Step 2 :** chromium-desktop et chromium-mobile verts.
- [ ] **Step 3 :** `npm test`, `npm run check`, `npm run test:e2e`, `build:demo` + `check-dist --demo`, `go vet`, `go test -race` ; commit.

## État (19 novembre)

Faits et testés : Tasks 1 à 7 (protocole, routes, client de production, fil, routes et entrées, écrans, Playwright à deux navigateurs contre le vrai serveur avec « le serveur ne voit rien » étendu au salon par l'interface ; chromium-desktop et chromium-mobile). Point 9 changé : le renouvellement MLS est fait par chaque membre après 100 de ses trames ou 1 h (le compteur de générations d'OpenMLS est celui de chaque expéditeur), pas seulement par le plus petit siège.

Version finale (19 novembre, demande du propriétaire), faits et testés :
- **Point 5, preuve de membre** : `web/src/salon/preuve.ts` (base `shhdrop-salon`, seule exception écrite de `source-rules.test.ts` dans le salon). *Décision par défaut, à valider :* AES-256-GCM de WebCrypto, clé non extractible tirée par le moteur (HKDF « membre-local » sur Argon2id ‖ K_lien), au lieu de XChaCha20-Poly1305 : le module du salon ne grossit pas. Rechargement : même place, sans page d'explication (`salon.spec.ts`).
- **Point 10, son et silencieux** : `web/src/salon/son.ts` (+ tests) ; silencieux gardé dans la preuve chiffrée.
- Séparateur « Nouveaux messages » ; texte trop long proposé en fichier `message.txt` (Playwright).
- Accessibilité : bouton « non lus » (nom accessible qui commence par le texte visible).

Restes : WebKit non lancé (comme `compte.spec.ts`).

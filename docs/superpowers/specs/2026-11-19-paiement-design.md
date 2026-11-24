# Paiement des offres Plus et Pro : Stripe, PayPal, NOWPayments et jetons anonymes (conception)

> **État au 19 novembre** : §2 à §6.1, §8 (sauf la sauvegarde), §9.1 (table et régime), §10 et la commande d'administration sont **codés et testés** (`server/internal/paiement`, `server/internal/api/handlers_paiement.go`, `web/src/paiement/`, page Offres et `/offres/retour`). Restent (plan `docs/superpowers/plans/2026-11-19-paiement.md`) : jetons RSA aveugles (§7), pass dans le coffre privé (§6.2), sauvegarde de `paiements.db`, relais de sortie (S1), limites payantes des partages (S2).

**Statut** : conception du 19 novembre 2026, **à valider par le propriétaire**. Les décisions prises par défaut sont numérotées **DP-n** et marquées « à valider ». Remplace l'ébauche Paddle (`2026-11-16-paiement-paddle-design.md`, gardée pour mémoire) ; complète la spécification principale §38 (offre payante), §36 (ce que voit le serveur) et la conception du salon v3 §8 (appels).

**Décisions du propriétaire reprises ici** (19 novembre) :

1. **Stripe** (carte bancaire) et **PayPal** remplacent Paddle. Conséquence acceptée : **le propriétaire devient le vendeur** (TVA, factures, remboursements, litiges, droit de la consommation), il n'y a plus de « vendeur officiel » qui porte cela.
2. **Cryptomonnaies via NOWPayments** (Monero, BTC, ETH, USDT ; service hébergé ; un tiers voit les paiements ; commission ≈ 0,5 %).
3. **Jetons anonymes Privacy Pass (RSA aveugle)** : un achat ne relie jamais les partages à une identité. Moteur Rust : `blind-rsa-signatures` (version épinglée) ; serveur Go : `github.com/cloudflare/circl` (version épinglée) ; mêmes résultats prouvés par des vecteurs communs ; exception écrite dans `CLAUDE.md`.
4. Le compte à rebours « à partir de la première ouverture » est **réservé à Plus et Pro**.
5. Appels audio et vidéo des salons : **option payante, pas encore codée** (salon v3 §8) ; affichés « bientôt », jamais vendus ni promis comme disponibles ; le droit est prévu dès maintenant dans le format (§11).
6. Aucune ressource tierce sur le site : **redirection** vers la page hébergée du prestataire, jamais de script Stripe, PayPal ou NOWPayments dans nos pages.

---

## 1. Ce qui est vendu

| | Plus | Pro |
|---|---|---|
| Prix mensuel (TTC) | 7 € | 20 € |
| Prix annuel (TTC) | 70 € | 200 € |
| Taille par partage | 10 Go | 30 Go |
| Durée d'un partage | 2 ou 3 jours | 2, 3 ou 7 jours |
| Ouvertures | jusqu'à 10 | jusqu'à 20 |
| Compte à rebours à la première ouverture | oui | oui |
| Partages payants par période de 30 jours (jetons) | 30 | 100 |
| Salons payants par période de 30 jours (même réserve de jetons) | compris dans les 30 | compris dans les 100 |
| Appels audio dans un salon | **bientôt** (DP-14) | **bientôt** |
| Appels vidéo dans un salon | **bientôt** (DP-14, décision du propriétaire, 24 novembre) | **bientôt** |

Chiffres lus dans un seul endroit par couche : `web/src/limits.ts` (`PAID`) pour le site, `server/internal/paiement/offres.go` (`Offres`) pour le serveur ; un test compare les deux (prix, durées des périodes, jetons).

**Rythmes et renouvellement** (D41-34, inchangé) :

| Rythme | Carte (Stripe) | PayPal | Crypto (NOWPayments) |
|---|---|---|---|
| Mensuel (30 jours) | abonnement renouvelé chaque mois, résiliable en un clic | abonnement renouvelé chaque mois, résiliable en un clic | **paiement unique de 30 jours** (aucun prélèvement possible en crypto) |
| Annuel (365 jours) | au choix : paiement unique **ou** renouvellement annuel (jamais présélectionné) | au choix : paiement unique **ou** renouvellement annuel | paiement unique de 365 jours |

- **DP-1 (à valider)** : en crypto, le mensuel est proposé en **paiement unique de 30 jours** (D41-34 (a) l'excluait ; l'écran disait « paiement unique pour la période ») : sans renouvellement, il n'y a aucun motif trompeur, et c'est le seul mensuel possible sans prélèvement.
- **Durées exactes** : un « mois » est une période de **30 jours**, un « an » de **365 jours**, comptés en jours UTC à partir du jour du paiement confirmé (§5.4). Un renouvellement payé avant la fin s'ajoute à la fin en cours (jamais de jour perdu).
- **Fin** : sans renouvellement, le pass s'arrête ; rien n'est prélevé. Avec renouvellement, un paiement refusé arrête simplement le pass à sa fin (aucune relance, aucun e-mail de notre part ; le prestataire peut en envoyer selon ses réglages, à couper chez lui, §13).
- **Résiliation** : bouton « Arrêter le renouvellement » sur la page Offres (pass gardé sur l'appareil) → le serveur demande au prestataire d'arrêter le renouvellement à la fin de la période payée (Stripe `cancel_at_period_end`, PayPal `cancel`). Aucune identité demandée : le pass suffit (§5.6).
- **Aucune promotion, aucun code promo, aucun essai gratuit, aucun prix barré** (§38.1).

## 2. Parcours

1. **Page Offres** (`/offres`) : étape 1 offre et rythme ; étape 2 moyen de paiement et **pays de résidence** (§9.2) ; étape 3 compte (facultatif, informatif) ; récapitulatif, case **non cochée** « Je demande l'accès immédiat et je renonce à mon droit de rétractation pour la période commencée » (§9.4), puis bouton « Payer sur la page sécurisée de {prestataire} ».
2. **Pass** : le navigateur tire `P` (32 octets, `crypto.getRandomValues`) et le range **avant** la redirection dans le stockage de l'appareil (§6.1), avec la commande en attente.
3. **Commande** : `POST /api/paiement/commande` (en-tête `X-Shh-Pass: P`, corps : offre, rythme, renouvellement, moyen, pays, renonciation). Le serveur crée la commande (`id` aléatoire de 16 octets), appelle le prestataire et rend l'adresse de sa page hébergée (`url`). Le site vérifie que l'adresse commence par l'origine attendue du prestataire (§4.4), puis `location.assign(url)`.
4. **Page hébergée du prestataire** : la personne paie (carte, compte PayPal, portefeuille crypto). Nous ne voyons rien de ce qui s'y passe.
5. **Retour** : `/offres/retour` (même adresse en cas de réussite ou d'abandon, **sans paramètre** : aucune donnée dans l'adresse). La page lit le pass en attente sur l'appareil, interroge `POST /api/paiement/etat` (`X-Shh-Pass`) toutes les 3 s pendant 2 min, puis toutes les 30 s, et affiche : **« Paiement reçu »** (offre, date de fin, renouvellement), **« Paiement en attente »** (crypto en confirmation, webhook pas encore reçu, paiement crypto partiel), ou **« Paiement non abouti »** (refusé, expiré, abandonné), avec « Réessayer » et « Oublier cette commande ».
6. **Webhook signé** du prestataire → notre serveur : seule source de vérité du paiement (§4). Le retour de la personne ne prouve rien.
7. **Droit** : paiement confirmé → le pass reçoit sa période et sa réserve de jetons (§5). Les jetons anonymes sont émis plus tard, à la demande de l'appareil, et dépensés à la création d'un partage ou d'un salon payant (§7).

**Sans compte** : tout marche. **Avec compte** : le pass est en plus rangé dans le coffre de profil (`pass`, §6.2), pour le retrouver sur un autre appareil.

## 3. Ce que voit chaque partie

| Partie | Voit | Ne voit jamais |
|---|---|---|
| Stripe, PayPal, NOWPayments | identité et moyen de paiement (selon le prestataire), pays, montant, date, **identifiant de commande** (aléatoire, 16 octets en hexadécimal), offre et rythme, renonciation cochée et son heure | `P`, `Q`, jetons, partages, salons, compte |
| Notre serveur (au repos, `paiements.db`) | `Q` = empreinte du pass, offre, jours de début et de fin, jetons restants, commande (identifiant aléatoire), référence d'abonnement du prestataire (pour résilier), empreintes SHA-256 des références de paiement (pour les remboursements et litiges), jours | nom, e-mail, adresse, carte, compte PayPal, adresse de portefeuille, pays, adresse IP, heure précise, montant (déduit de l'offre), lien avec un partage, un salon ou un compte |
| Notre serveur (en direct) | `P` à la commande, à l'état et à l'émission des jetons ; l'adresse IP de la requête (mémoire seulement, limites anti-abus, comme toute requête) | — |
| Un voleur du disque | ce que garde `paiements.db` (ci-dessus) : combien de pass existent, leurs offres et leurs fins | `P` (seul `Q` est gardé : il ne permet ni de demander des jetons ni de lire l'état) |

**Règle** : `paiements.db` est une **base séparée** de `shares.db` et `comptes.db`, sans aucune colonne commune (ni identifiant de partage, ni `h` de compte). Seulement des BLOB et des INTEGER, dates au jour (multiples de 86 400), jamais d'heure, comme `comptes.db`.

**Ce qui relie quoi** :

- Prestataire : identité ↔ commande.
- Notre serveur : commande ↔ `Q`. Donc, en réunissant le prestataire **et** notre disque : identité ↔ `Q` ↔ « a acheté Plus jusqu'au 12 mars ». **Jamais** `Q` ↔ partages ou salons : les jetons sont aveugles (§7).
- **DP-2 (à valider)** : l'identifiant de commande est donné au prestataire à la place de `Q` (l'ébauche Paddle donnait `Q`). Gain : le prestataire n'apprend rien de lié au pass ; un `Q` ne circule jamais hors de notre serveur.

## 4. Prestataires : appels sortants et webhooks

Aucun SDK : appels HTTPS simples avec la bibliothèque standard Go (`net/http`, `crypto/hmac`, `crypto/sha256`, `crypto/sha512`, `encoding/json`), derrière une interface testable (`paiement.Prestataire`). Les adresses des API sont **fixées dans le code** (production ou bac à sable selon `SHH_PAIEMENT_ESSAI`), jamais lues dans l'environnement : une variable modifiée ne peut pas envoyer nos clés ailleurs. Les tests remplacent l'adresse par celle d'un faux serveur `httptest` (champ non exporté).

Client HTTP : délai total 20 s, TLS vérifié (certificats racine de l'image), aucune redirection suivie, réponse lue jusqu'à 1 Mio au plus, aucun en-tête `User-Agent` de notre part autre que `Shhgone` (jamais de version), aucune donnée personnelle envoyée (pas d'e-mail, pas de nom, pas d'IP).

### 4.1 Stripe (carte)

- **Création** : `POST https://api.stripe.com/v1/checkout/sessions` (formulaire), en-têtes `Authorization: Bearer <clé secrète>`, `Stripe-Version: 2026-02-25.clover` (version épinglée, DP-3), `Idempotency-Key: commande-<id>`. Paramètres :
  - `mode=payment` (paiement unique) ou `mode=subscription` (renouvellement) ;
  - `line_items[0][quantity]=1`, `line_items[0][price_data][currency]=eur`, `[unit_amount]` en centimes (700, 7000, 2000, 20000), `[product_data][name]` (« Shhgone Plus, 30 jours »…), `[tax_behavior]=inclusive` (prix TTC), et pour un abonnement `[recurring][interval]=month|year` ;
  - `client_reference_id=<commande>`, `metadata[commande]`, `metadata[pays_declare]`, `metadata[renonciation]=oui`, `metadata[renonciation_heure]` (secondes Unix) ; `payment_intent_data[metadata][commande]` (paiement unique) ou `subscription_data[metadata][commande]` (abonnement) ;
  - `payment_method_types[0]=card` ; `success_url` et `cancel_url` = `<SHH_ORIGIN>/offres/retour` ; `locale=auto` ;
  - `invoice_creation[enabled]=true` en paiement unique (facture Stripe, §9.3) ; `automatic_tax[enabled]=true` si `SHH_STRIPE_TAXE=1` (Stripe Tax, §9.1).
  - Réponse : `id`, `url` ; `url` doit commencer par `https://checkout.stripe.com/`.
  - Prix « en ligne » (`price_data`) plutôt que des prix créés dans le tableau de bord (**DP-4, à valider**) : une seule source de vérité, le code, comparée au site par un test ; rien à recopier chez Stripe.
- **Webhook** : `POST /api/paiement/webhook/stripe`. En-tête `Stripe-Signature: t=<secondes>,v1=<hex>[,v1=<hex>…]` ; signature = HMAC-SHA-256(secret `whsec_…`, `t` ‖ « . » ‖ corps brut) ; **comparaison en temps constant** (`hmac.Equal`) avec chaque `v1` (plusieurs pendant un changement de secret) ; `t` à **±300 s** de l'horloge du serveur (Stripe ne borne que le passé ; nous refusons aussi un `t` dans le futur). `object` = `event`, `livemode` = mode attendu (`false` en essai). Événements traités :
  - `checkout.session.completed` et `checkout.session.async_payment_succeeded` : si `payment_status` = `paid` → paiement confirmé ; référence de paiement = `payment_intent` (paiement unique) ou `invoice` (premier mois d'un abonnement, la même que son `invoice.paid`) ; abonnement : `subscription` gardé pour résilier ;
  - `checkout.session.expired`, `checkout.session.async_payment_failed` → commande « non aboutie » ;
  - `invoice.paid` (`billing_reason` = `subscription_create` ou `subscription_cycle`) : commande lue dans `parent.subscription_details.metadata.commande` (version « clover ») ou, à défaut, par l'abonnement (`parent.subscription_details.subscription`, ou `subscription` des anciennes versions) ; référence = `id` de la facture ; montant `amount_paid` et devise `currency` vérifiés ;
  - `invoice_payment.paid` (`status` = `paid`, `payment.type` = `payment_intent`) : l'empreinte du `payment.payment_intent` est rangée dans `refs` avec la commande de la facture `invoice` (retrouvée par l'empreinte de la facture, rangée au crédit) ; ainsi `charge.refunded` et `charge.dispute.created` d'un abonnement, qui ne portent que ce PaymentIntent, retrouvent la commande (S10). Empreinte déjà présente (paiement unique, dont le PaymentIntent est la référence du crédit ; événement rejoué) → rien ; facture pas encore créditée → **500**, Stripe réessaie (les événements n'arrivent pas dans l'ordre), mais seulement pendant 24 h après l'événement (champ `created`, signé) : au-delà, une facture encore inconnue (motif autre que `subscription_create` ou `subscription_cycle`, commande purgée) → **200** sans rien faire, au lieu de 500 pendant les 3 jours d'essais de Stripe (22 novembre, test `TestStripeLienFactureInconnueTardif`). Limite : une facture qui serait créditée plus de 24 h après son paiement n'aurait plus son PaymentIntent rangé ; son remboursement se révoque alors à la main (§5.5) ;
  - `customer.subscription.deleted` → renouvellement arrêté (le pass va jusqu'à sa fin) ;
  - `charge.refunded` (seulement si `refunded` = `true`, remboursement total) et `charge.dispute.created` → pass **révoqué** ; commande lue dans `metadata.commande`, sinon par l'empreinte de `payment_intent`.
  - Tout autre type : 200, ignoré.

### 4.2 PayPal

- **Jeton d'accès** : `POST https://api-m.paypal.com/v1/oauth2/token` (bac à sable : `api-m.sandbox.paypal.com`), authentification basique `client_id:secret`, corps `grant_type=client_credentials` ; jeton gardé en mémoire jusqu'à 60 s avant son échéance (`expires_in`).
- **Paiement unique (annuel sans renouvellement)** : `POST /v2/checkout/orders`, en-tête `PayPal-Request-Id: commande-<id>` (idempotence), corps : `intent=CAPTURE`, `purchase_units[0]` avec `custom_id=<commande>`, `description`, `amount{currency_code:EUR, value:"70.00", breakdown{item_total, tax_total}}` et `items[0]{name, quantity:"1", category:DIGITAL_GOODS, unit_amount, tax}` (§9.1) ; `payment_source.paypal.experience_context{return_url, cancel_url, user_action:PAY_NOW, shipping_preference:NO_SHIPPING, brand_name:"Shhgone"}`. Réponse : lien `rel=payer-action` (`https://www.paypal.com/…` ou `https://www.sandbox.paypal.com/…`).
- **Abonnement** : `POST /v1/billing/subscriptions`, `PayPal-Request-Id`, corps `plan_id` (plan créé par le propriétaire chez PayPal, §14), `custom_id=<commande>`, `application_context{brand_name, return_url, cancel_url, user_action:SUBSCRIBE_NOW, shipping_preference:NO_SHIPPING}`. Réponse : `id` (abonnement, gardé) et lien `rel=approve`.
- **Capture** : à `CHECKOUT.ORDER.APPROVED`, le serveur appelle `POST /v2/checkout/orders/{id}/capture` (`PayPal-Request-Id: capture-<commande>`) ; une capture `COMPLETED` dans la réponse confirme le paiement (référence = identifiant de la capture), comme le webhook `PAYMENT.CAPTURE.COMPLETED` qui suit (même référence : un seul crédit). **DP-5 (à valider)** : capture déclenchée par le webhook seulement (pas par la page de retour) : une seule voie, déjà signée.
- **Webhook** : `POST /api/paiement/webhook/paypal` (limite propre et identifiants refusés gardés 1 h : §8). Vérification **par l'API** `POST /v1/notifications/verify-webhook-signature` avec `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (en-têtes `PayPal-Auth-Algo`, `PayPal-Cert-Url`, `PayPal-Transmission-Id`, `PayPal-Transmission-Sig`, `PayPal-Transmission-Time`), `webhook_id` (configuration) et `webhook_event` = **corps brut tel quel** (jamais réencodé) ; accepté seulement si `verification_status` = `SUCCESS`. Contrôles avant l'appel (aucun appel sortant pour une requête manifestement fausse) : le webhook doit viser une commande connue de `paiements.db`, quel que soit son état (son identifiant `custom_id`/`custom`, son abonnement ou l'empreinte d'une référence de paiement déjà rangée, lus dans le corps **non vérifié** avec la même lecture que l'événement, pour cette seule recherche), sinon **400** comme une signature fausse (§8, S3) ; les cinq en-têtes présents une seule fois, `cert_url` en `https://api.paypal.com/` ou `https://api.sandbox.paypal.com/` (ou `api-m.`), corps JSON avec `id` et `event_type`. Au plus **4 vérifications simultanées** (au-delà : 503, PayPal réessaie). Événements :
  - `CHECKOUT.ORDER.APPROVED` → capture (ci-dessus) ;
  - `PAYMENT.CAPTURE.COMPLETED` → confirmé (`custom_id`, `amount` vérifiés) ; `PAYMENT.CAPTURE.DENIED` → non abouti ;
  - `BILLING.SUBSCRIPTION.ACTIVATED` → identifiant d'abonnement gardé ; `BILLING.SUBSCRIPTION.CANCELLED`, `…EXPIRED`, `…SUSPENDED` → renouvellement arrêté ;
  - `PAYMENT.SALE.COMPLETED` (abonnement) → confirmé ; commande par `custom` si présent, sinon par `billing_agreement_id` ; référence = `id` de la vente ; inconnue (l'activation n'est pas encore arrivée) → **500** pour que PayPal réessaie ;
  - `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED` → révoqué (par `custom_id`/`custom`, sinon par l'empreinte de la capture ou de la vente : `sale_id`, liens `up`) ;
  - `CUSTOMER.DISPUTE.CREATED` → révoqué (par `disputed_transactions[].seller_transaction_id`).

### 4.3 NOWPayments (crypto)

- **Création** : `POST https://api.nowpayments.io/v1/invoice` (bac à sable : `api-sandbox.nowpayments.io`), en-tête `x-api-key`, corps `price_amount` (7, 20, 70 ou 200), `price_currency=eur`, `order_id=<commande>`, `order_description`, `ipn_callback_url=<SHH_ORIGIN>/api/paiement/webhook/nowpayments`, `success_url` et `cancel_url` = `<SHH_ORIGIN>/offres/retour`, `is_fixed_rate=true`, `is_fee_paid_by_user=false`. Réponse : `invoice_url` en `https://nowpayments.io/` (bac à sable : `https://sandbox.nowpayments.io/`). Monnaies proposées : celles activées par le propriétaire dans son tableau de bord NOWPayments (XMR, BTC, ETH, USDT).
- **Webhook (IPN)** : en-tête `x-nowpayments-sig` = HMAC-SHA-512(secret IPN, JSON du corps **aux clés triées récursivement**, sans espace), en hexadécimal ; comparaison en temps constant. Le serveur retrie les clés lui-même (décodage en `json.Number` pour garder chaque nombre tel qu'écrit, échappement HTML désactivé) ; une différence d'écriture fait refuser (échec fermé, jamais un crédit).
  - `payment_status` = `finished` et `price_amount` = prix attendu et `price_currency` = `eur` → confirmé (référence = `payment_id`) ;
  - `waiting`, `confirming`, `confirmed`, `sending` → en attente ; `partially_paid` → **en attente, jamais crédité** (le propriétaire règle à la main : complément ou remboursement, §8) ;
  - `failed`, `expired` → non abouti ; `refunded` → révoqué.
- **Horodatage** : l'IPN ne porte pas d'heure signée ; le rejeu d'un IPN valide ne fait rien (idempotence, §5.3).

### 4.4 Garde-fous communs

- **Adresses de redirection** vérifiées deux fois (serveur et site) contre une liste fermée d'origines : `https://checkout.stripe.com/`, `https://www.paypal.com/`, `https://www.sandbox.paypal.com/`, `https://nowpayments.io/`, `https://sandbox.nowpayments.io/`. Toute autre réponse → 502 `prestataire`.
- **Montant et devise** vérifiés à chaque confirmation (euros, centimes exacts) ; un écart → commande en « anomalie » (affichée « Paiement non abouti, contactez-nous avec le numéro de commande »), aucun crédit.
- **Corps des webhooks** : 256 Kio au plus, lu en 10 s ; réponse `200 {}` pour un événement traité ou ignoré, `400` pour une signature fausse ou un corps illisible, `500` pour une erreur à nous (le prestataire réessaie), `503` si le serveur est occupé.
- **Aucun journal** : rien du corps, des en-têtes ni de l'adresse n'est écrit (règle de tout le serveur).

## 5. Données gardées, idempotence, cycle de vie

### 5.1 `paiements.db` (schéma 2)

```
passes(q BLOB(32) PK, offre INTEGER (1 Plus, 2 Pro), debut_jour, fin_jour,
       jetons INTEGER ≥ 0, recharge_jour, revoque INTEGER (0/1)) WITHOUT ROWID
commandes(id BLOB(16) PK, q BLOB(32), offre, jours (30/365), renouvelle (0/1),
          moyen (1 carte, 2 PayPal, 3 crypto), etat (1 en attente, 2 payée,
          3 non aboutie, 4 anomalie, 5 révoquée), abonnement BLOB(1..64) NULL,
          cree_jour, garde_jour) WITHOUT ROWID
refs(r BLOB(32) PK = SHA-256(« shhdrop/v2/paiement/ref » ‖ 0x00 ‖ fournisseur ‖ 0x00 ‖ référence),
           commande BLOB(16), jour) WITHOUT ROWID
-- schéma 2 (jetons, §7) ; une base du schéma 1 est migrée à l'ouverture :
passes += emis_jour, emis_n            -- émissions du jour par pass (borne S9)
cles_jetons(jour, offre, sk BLOB PKCS#8) PK(jour, offre) WITHOUT ROWID
depenses(h BLOB(32) PK = SHA-256(jeton), jour) WITHOUT ROWID
```

- Fichier `SHH_DATA_DIR/paiements.db`, 0600, mêmes PRAGMA que `shares.db` (`secure_delete`, WAL), une connexion. **Sauvegardé chaque jour avec `comptes.db`** (perdre la base = perdre les pass payés) : fait (tâche 9, `deploy/sauvegarder.sh`, `deploy/README.md` §12.4, §13.3), dans son propre fichier chiffré, **sans les clés privées des jetons** (retirées de la copie, `VACUUM` compris) ; à la restauration, aucune clé n'est remise et tout jeton émis avant ne passe plus.
- `abonnement` : identifiant d'abonnement du prestataire (`sub_…`, `I-…`), seul texte gardé, **en clair parce qu'il sert à résilier** ; aucune autre référence en clair.

### 5.2 Le pass `P` et son empreinte `Q`

- `P` : 32 octets aléatoires tirés par l'appareil (WebCrypto ; apps : générateur du système). Envoyé en base64url sans bourrage dans l'en-tête `X-Shh-Pass` (jamais dans l'adresse, jamais dans un corps), seulement vers `/api/paiement/*` (et plus tard l'émission des jetons).
- `Q` = SHA-256(« shhdrop/v2/pass » ‖ 0x00 ‖ `P`), calculée **par le serveur** (bibliothèque standard Go). **DP-6 (à valider)** : remplace la formule de §38.4 (SHA-256(HKDF(`P`, « shhdrop/v2/pass »))) : `Q` ne sert qu'à retrouver la ligne, sans clé dérivée ; une seule fonction, côté serveur, donc rien à refaire à l'identique dans le moteur ni dans les apps (l'appareil n'envoie que `P`). Vecteurs : `engine/vectors/paiement.json` (entrée `P`, sortie `Q`), rejoués par le test Go.

### 5.3 Idempotence

- **Un paiement ne crédite qu'une fois** : chaque confirmation porte une **référence de paiement** du prestataire (Stripe : PaymentIntent ou facture ; PayPal : capture ou vente ; NOWPayments : `payment_id`) ; son empreinte est insérée dans `refs` **dans la même transaction** que le crédit ; une empreinte déjà présente → rien (200). Peu importe l'événement qui l'apporte (session terminée puis `invoice.paid`, capture puis `PAYMENT.CAPTURE.COMPLETED`, IPN rejoué).
- Création de commande : `Idempotency-Key` (Stripe) et `PayPal-Request-Id` (PayPal) dérivés de la commande ; un double clic crée deux commandes distinctes, chacune ouverte au plus une fois (sans effet).
- Révocation, arrêt du renouvellement, « non aboutie » : opérations idempotentes (état final).

### 5.4 Crédit d'une période

Dans une transaction : `fin_jour` = max(`fin_jour`, aujourd'hui) + 30 ou 365 jours ; à la première période `debut_jour` = aujourd'hui, `jetons` = réserve de la période (Plus 30, Pro 100), `recharge_jour` = aujourd'hui + 30 ; commande → « payée ». Un pass révoqué ne se recrédite pas (anomalie).

**Réserve de jetons** : à chaque demande d'émission (§7), si `recharge_jour` ≤ aujourd'hui < `fin_jour`, la réserve est **remise** à sa valeur (pas de report) et `recharge_jour` avance de 30 jours (autant de fois que nécessaire). Un annuel a donc 12 ou 13 réserves ; un mensuel renouvelé une par mois.

### 5.5 Remboursement, litige, révocation

- Remboursement **total**, litige ouvert, reversement : `revoque` = 1, `jetons` = 0, `fin_jour` = aujourd'hui ; la commande passe « révoquée ». Les **jetons déjà émis restent utilisables** jusqu'à la fin de l'époque de leur clé (ils sont aveugles : personne ne sait lesquels), d'où l'émission par petits lots (§7).
- Remboursement **partiel** (geste commercial, rétractation au prorata ; montant connu inférieur au prix : PayPal) : aucun effet automatique ; le propriétaire décide (`shhdrop admin paiement revoquer <commande>`, commande lue dans les métadonnées du prestataire).
- **Commande introuvable** pour un remboursement (commande purgée, autre application du même compte, ou facture d'abonnement Stripe dont `invoice_payment.paid` n'est jamais arrivé) : 200, rien ; le propriétaire révoque à la main avec l'identifiant de commande lu dans les métadonnées du prestataire.

### 5.6 Résiliation et état

- `POST /api/paiement/etat` (`X-Shh-Pass`) → `{ "etat": "attente" | "payee" | "non_aboutie" | "anomalie" | "revoquee" | "inconnue", "offre": "plus" | "pro" | null, "fin": "AAAA-MM-JJ" | null, "renouvelle": bool, "droits": [...] }`. `inconnue` : aucun pass ni commande pour ce `P` (commande purgée, ou pass inventé) ; un `P` mal formé (pas exactement 32 octets en base64url) → 400 `bad_request`. Si plusieurs commandes portent le même `P` (nouvel essai après un échec), l'état est celui de la plus favorable (payée, puis en attente, puis les autres).
- `POST /api/paiement/resilier` (`X-Shh-Pass`) → arrête le renouvellement chez le prestataire (Stripe `POST /v1/subscriptions/{id}` `cancel_at_period_end=true` ; PayPal `POST /v1/billing/subscriptions/{id}/cancel`) ; `renouvelle` = 0 ; idempotent.

### 5.7 Purge (passe quotidienne)

- Commande « en attente » ou « non aboutie » : effacée 7 jours après sa création (une page hébergée expire au plus en 24 h ; une confirmation crypto ou un webhook réessayé peut arriver plusieurs jours après : 7 jours laissent la marge, sans quoi un paiement réel resterait sans pass).
- Commande payée ou révoquée : gardée jusqu'à `garde_jour` = fin du pass + 180 jours (délai des litiges : PayPal 180 jours, cartes jusqu'à 120 jours), puis effacée avec ses références.
- Pass : effacé 31 jours après `fin_jour` (après la fin de validité des jetons émis, §7) ou 31 jours après sa révocation.

## 6. Où vit le pass

### 6.1 Sur l'appareil

- Base IndexedDB `shhdrop-pass` (module `web/src/paiement/`), chiffrée comme la session du compte (`account/persist.ts`) : clé AES-256-GCM **non extractible** gardée dans la base ; honnêtement, cela ne protège que d'une lecture naïve du stockage (dit sur la page). Enregistrements : `P`, offre, rythme, moyen, commande en attente oui/non, **pays déclaré** (pour la note de vente faite sur l'appareil, §9.3 ; jamais renvoyé au serveur) ; jetons à part (enregistrements `j:`, §7). **Exception écrite** à « aucun stockage navigateur » (`source-rules.test.ts`), comme le compte.
- « Oublier ce pass » efface l'enregistrement ; perdre l'appareil sans compte = perdre le pass (dit avant le paiement : « Sans compte, votre offre ne vit que sur cet appareil »). **DP-7 (à valider)** : pas de « clé de secours » à recopier au lancement (simplicité) ; le compte la remplace.

### 6.2 Dans le compte (facultatif)

- Coffre de **profil** (`pass`, champ texte existant) : `"shp1:" ‖ base64url(P)` (plusieurs pass : séparés par « , », 8 au plus). Le serveur du compte ne sait pas ouvrir ce coffre… **sauf** le séquestre du profil (conception du compte, R-D1) : avec la clé du serveur et la base, un exploitant peut ouvrir les profils, donc les pass. **DP-8 (à valider)** : ranger le pass dans le coffre **privé** (ouvert seulement par le mot de passe), pas dans le profil : le champ `pass` du profil reste vide. Plan, tâche 8.
- La page Offres (page séparée, sans module de compte) ne lit pas le compte : le rangement se fait depuis l'application, à la connexion suivante.
- **Fait (tâche 8, DP-8 appliquée)** : `web/src/account/pass.ts`. Champ `pass` facultatif du coffre **privé** (absent tant qu'il est vide : le JSON d'un coffre sans pass ne change pas) ; à l'ouverture d'une session, après la fusion de l'historique, chaque côté reçoit ce qui lui manque (pass de l'appareil écrits au coffre, pass du coffre rangés sur l'appareil) ; une commande encore en attente ne part pas ; le profil n'est pas touché. **Écart, à valider** : rangement automatique, sans la question « la ranger dans votre compte ? » (le coffre privé n'est lisible qu'avec le mot de passe : rien n'est montré au serveur du compte). Les jetons ne sont pas rangés (valables deux jours au plus).

### 6.3 Apps (D42-20)

Même format : `P` en base64url, en-tête `X-Shh-Pass`, mêmes routes ; stockage dans le trousseau du système. Rien ne dépend du navigateur **sauf** : la redirection vers la page hébergée (apps : navigateur du système, `ASWebAuthenticationSession` / Custom Tabs) et le retour (`/offres/retour`, lien universel de l'app plus tard). **Signalement S7** : l'App Store et Google Play imposent leur propre paiement pour un service numérique consommé dans l'app (règles 3.1.1 et « Payments policy ») ; vendre Plus/Pro dans les apps par Stripe, PayPal ou crypto peut faire refuser l'app. Correction : dans les apps, **aucun achat** (lecture du pass acheté ailleurs seulement, règle « reader »/« multiplatform services »), à valider à la soumission.

## 7. Jetons anonymes (Privacy Pass, RSA aveugle)

**État** : fait (tâches 6 et 7) pour les **partages** ; la création d'un salon payant ne dépense pas encore de jeton (salons payants non codés). Paramètres, fixés pour que les apps et le salon puissent s'y fier :

- **Protocole** : Privacy Pass, émission RFC 9578 type **0x0002** (RSA aveugle publiquement vérifiable), **RSABSSA-SHA384-PSS-Deterministic**, module de 2 048 bits (RFC 9474). **Signalement S8 (faible, exactitude)** : §38.4 écrit « Randomized » ; RFC 9578 impose la variante **Deterministic** pour le type 2 (le nonce du jeton tient lieu d'aléa) ; corrigé ici. Défi (`TokenChallenge`) : `0x0002 ‖ len(issuer) ‖ issuer ‖ 0x00 ‖ 0x0000` (contexte et origines vides), `issuer` = hôte de `SHH_ORIGIN` ; `token_key_id` = SHA-256 de la clé publique SPKI (RSA-PSS, SHA-384, MGF1-SHA-384, sel de 48 octets ; 72 octets d'en-tête puis PKCS #1) ; jeton de 354 octets (472 caractères base64url).
- **Bibliothèques** (décision du propriétaire) : site et apps, moteur Rust `blind-rsa-signatures` **= 0.19.0** (fonction `jetons` de `shhdrop-core`, épinglée dans `Cargo.lock`), dans un **module wasm à part** (`engine/jetons-wasm`, ≈ 56 Ko en brotli, chargé seulement par le portefeuille de jetons : le moteur des partages reste sous son plafond de 156 000 octets, 151 Ko mesurés) ; serveur, `github.com/cloudflare/circl` **v1.6.5** (`blindsign/blindrsa`, dépendance directe de `server/go.mod`). Vecteurs communs : `engine/vectors/privacypass.json` (clé de test, `TokenRequest`, `TokenResponse`, jeton final, défi), rejoués en Rust, en wasm (vitest) et en Go.
- **Clés d'émission (S9)** : une paire par **offre** (Plus, Pro) et par **jour UTC**, tirée par le serveur à la première demande du jour et gardée dans `paiements.db` (`cles_jetons`) ; un jeton n'est accepté que **le jour de sa clé et le lendemain**, puis la clé est effacée (passe quotidienne). Clés publiques : `GET /api/paiement/jetons/cles` (jour et offre de chaque clé, SPKI, émetteur). **Écart** au plan : ni fichiers `SHH_JETONS_CLES_DIR`, ni publication dans le manifeste de version (impossible pour une clé du jour) : voir S17.
- **S17, même clé pour tous (fait le 22 novembre, décision du propriétaire : rien publié sur GitHub)** : le serveur tire ses clés **7 jours à l'avance** (`JoursAvance`, `server/internal/paiement/jetons.go`) et `GET /api/paiement/jetons/cles` sert celles d'aujourd'hui à J+7 (16 clés, par jour puis Plus, Pro ; format inchangé, un client ancien prend toujours la clé du jour). Règle d'acceptation inchangée (jour de la clé et lendemain). L'appareil qui a un pass garde, chiffrées à côté du pass (enregistrements `c:` à identifiant aléatoire, `web/src/paiement/pass.ts`), les clés vues par (jour, offre), jusqu'au lendemain de leur jour ; à chaque lecture des clés (`clesVerifiees`, `web/src/paiement/jetons.ts`), une clé **différente** pour un (jour, offre) déjà vu est refusée, et ce (jour, offre) le reste même si le serveur revient ensuite à l'ancienne : aucune émission ni dépense de jeton sous lui ; la formule n'est plus proposée ce jour-là et l'écran d'envoi affiche un avertissement (`offers.keys.mismatch`). Une clé jamais vue : rien à comparer, acceptée et gardée. **Limites** : (a) un serveur malveillant qui donne à un appareil ses propres clés **dès le premier contact**, puis s'y tient, n'est pas détecté par cet appareil seul ; il faut un second chemin (comparaison entre le site et les apps, ou entre personnes) ; le gain : le serveur doit s'engager 7 jours à l'avance et ne peut plus changer la clé d'un appareil déjà servi sans être vu ; (b) **fausse alerte après une restauration** : la sauvegarde retire les clés privées (`deploy/sauvegarder.sh`), donc un serveur restauré tire de nouvelles clés et tous les appareils qui avaient vu les anciennes avertissent et refusent la formule jusqu'à 8 jours (voir S20) ; (c) apps (D42-20) : même logique, clés vues dans le trousseau ; rien de propre au navigateur, vecteurs `privacypass.json` inchangés.
- **Émission** : `POST /api/paiement/jetons` (`X-Shh-Pass`, corps : 1 à **5** `TokenRequest`) → `TokenResponse` ; tout message aveuglé hors du module est refusé **avant** tout décompte ; réserve de la période décrémentée dans la même transaction ; **au plus 10 (Plus) ou 20 (Pro) jetons par pass et par jour UTC** (`EmisParJour`). L'appareil demande des lots de 3 et les garde chiffrés à côté du pass (`web/src/paiement/jetons.ts`, enregistrements `j:`, avec l'heure d'obtention, locale, jamais envoyée) ; les jetons d'une clé échue sont jetés. **S16 (fait le 22 novembre)** : après chaque partage payant, un réapprovisionnement est programmé à une heure tirée au hasard (`crypto.getRandomValues`, entre 5 et 30 min, tant que l'application reste ouverte) ; il demande un lot si la réserve valable de la formule est vide ; un partage dépense d'abord un jeton « mûr » (obtenu au moins 5 min avant), puis le plus près d'expirer ; il n'est jamais retardé exprès (il attend seulement un réapprovisionnement déjà en cours). Réserve vide au moment d'un partage : lot demandé tout de suite (écart résiduel, ci-dessous).
- **Dépense** : `Authorization: PrivateToken token=<base64url>` sur `POST /api/shares` d'un partage Plus ou Pro ; le serveur vérifie la signature (clé du jour ou de la veille) ; la **formule du partage est celle de la clé** qui a signé (Plus ou Pro), puis palier, durée et ouvertures sont vérifiés contre elle (§11) ; il refuse un jeton déjà vu (`depenses` : SHA-256 du jeton et jour, purgée après deux jours), rend le jeton si la création échoue ensuite, fixe la formule de l'envoi **en mémoire** (jamais en base) et **ne garde rien** qui relie le partage au jeton.
- **Révocation (S9)** : un pass révoqué (remboursement, litige, `shhdrop admin paiement revoquer`) ne reçoit plus aucun jeton ; ceux qu'il a déjà reçus meurent **au plus tard le surlendemain** de leur émission ; entre-temps, au plus `EmisParJour` partages payants par jour d'émission peuvent encore être créés. **Limite restante, écrite** : un jeton émis ne peut pas être annulé seul sans relier jeton et pass (ce qui détruirait l'anonymat) ; la durée courte des clés est la seule borne.
- **Ce que voit le serveur** : à l'émission, `P` (donc le pass), le nombre de jetons et le jour ; à la dépense, un jeton valable pour une offre et le jour de sa clé, jamais lequel des pass l'a obtenu (anonymat inconditionnel de la signature aveugle) ; deux partages payants du même pass ne sont pas reliables par le jeton.
- **Limites honnêtes** : (1) le jour de la clé réduit l'ensemble d'anonymat aux pass de la même offre qui ont pris des jetons ce jour-là ou la veille (S19) ; (2) S16, résiduel : quand la réserve est vide au moment d'un partage payant (premier partage payant de l'appareil, premier après un ou deux jours sans, ou réserve vidée avant l'heure tirée), le lot est demandé tout de suite : l'émission et cette dépense se suivent de quelques secondes, et l'heure seule peut alors les rapprocher si peu de personnes paient ; les partages suivants dépensent des jetons obtenus à une autre heure. De même, l'état du pass (`POST /etat`, avec `P`) : **depuis le 22 novembre**, il est gardé chiffré sur l'appareil (`e:<id>`, `pass.ts`) et demandé au plus une fois par jour UTC et par pass, ou après un événement qui l'oublie (pass rangé de nouveau, retour de paiement, résiliation, émission refusée) ; le premier chargement du jour reste daté, et un partage payant fait juste après peut encore être rapproché du pass par l'heure ; un pass révoqué peut rester affiché payé jusqu'au lendemain sur l'appareil (l'émission est refusée par le serveur, ce qui oublie l'état) ; (3) S17, résiduel : une clé personnelle dès le premier contact n'est pas détectée par un seul appareil (ci-dessus). **Dit sur la page Confidentialité** (22 novembre, section « Offres payantes : le paiement », `web/src/routes/pages/content.ts`, test `content.test.ts`), avec la redirection vers le prestataire et ce que nous gardons ; S17 y est écrit « pas résolu ».

## 8. Limites et abus

- **Création de commande** : **preuve anti-robot ALTCHA** exigée (`altcha`, `hp`, `shown_at` dans le corps, comme une création de partage ou de salon ; preuve de travail seulement (le repli reCAPTCHA est retiré partout depuis le 24 novembre) ; difficulté qui double après chaque commande de la connexion) ; 10 par heure et par connexion (/64), 30 par /48 ; 1 000 commandes à la fois « en attente » **et récentes** (créées dans l'heure UTC en cours ou les 3 précédentes, compteur en mémoire) au plus (au-delà : 503) ; une commande en attente plus ancienne ne compte plus au plafond mais reste gardée 7 jours (§5.7), pour qu'un paiement tardif soit crédité ; `SHH_PAIEMENT` active la route seulement si au moins un prestataire est configuré. Audit du 20 novembre (S2) : avant, 1 000 commandes jamais payées bloquaient toutes les ventes 7 jours (34 blocs /48 suffisaient), sans aucune preuve ; il faut maintenant entretenir l'attaque (≈ 34 blocs /48 ou adresses IPv4 toutes les 4 h, une preuve de travail chacune).
- **État** : limite générale de l'API (60 requêtes par minute et par connexion) ; la page de retour interroge au plus toutes les 3 s.
- **Webhooks** : soumis à la limite générale par adresse (les prestataires réessaient après un 429) ; la vérification PayPal (appel sortant) est bornée à 4 simultanées ; signatures Stripe et NOWPayments vérifiées avant toute lecture de base. **PayPal (audit du 20 novembre, S3)** : limite propre à la route, 30 webhooks par minute et par connexion, 60 par /48 (429 avant toute lecture du corps) ; un `Paypal-Transmission-Id` que PayPal a déclaré faux (ou en cours de vérification) est refusé (400) sans nouvel appel sortant pendant 1 h (empreinte SHA-256 en mémoire, 4 096 au plus) ; un identifiant vérifié, ou dont la vérification n'a pas abouti (panne : 500), n'est pas gardé, pour que PayPal puisse le renvoyer. **Avant tout appel sortant (22 novembre)** : un webhook qui ne vise aucune commande connue chez nous (ni commande, ni abonnement, ni référence de paiement rangée, quel que soit l'état de la commande, pour garder remboursements et litiges) est refusé sans appel sortant, avec la même réponse qu'une signature fausse (400, corps fixe) ; ces valeurs du corps non vérifié ne servent qu'à cette recherche en lecture seule (le corps est déjà borné), l'événement est relu après vérification. Un faux webhook ne coûte donc un appel sortant que s'il porte un identifiant de commande, d'abonnement ou de paiement réel (aléatoires, connus du seul acheteur et de PayPal). Limites assumées : c'est la seule lecture de base avant vérification d'une signature ; le temps de réponse diffère entre une cible connue (appel sortant) et inconnue (révèle seulement à qui connaît déjà un identifiant qu'il existe) ; un vrai webhook visant une commande purgée, ou d'un type que nous ignorons, reçoit 400 et PayPal le réessaie quelques jours, sans effet (cocher seulement les événements traités, §13). Vérification de la signature sur place (certificat PayPal en cache) non retenue : ce serait vérifier nous-mêmes une chaîne de certificats et un CRC32 du corps (plus de code sensible) pour un gain que la limite donne déjà.
- **Pass partagé publiquement** : la réserve de jetons s'épuise ; un abus constaté se révoque (`shhdrop admin paiement revoquer`).
- **Fraude à la carte** : Radar de Stripe (réglage du propriétaire) ; un litige révoque le pass.
- **Paiement crypto partiel ou en trop** : jamais crédité automatiquement ; le propriétaire voit la commande dans NOWPayments et règle à la main.

## 9. Conformité (le propriétaire est le vendeur)

### 9.1 TVA

- Services fournis par voie électronique à des particuliers : TVA du **pays du client** au-delà de 10 000 € HT de ventes par an vers les autres États membres (guichet unique **OSS**), TVA française en deçà (sauf option) ; **franchise en base** possible pour une micro-entreprise (« TVA non applicable, art. 293 B du CGI »). Le régime est **choisi explicitement** par le propriétaire : `SHH_TVA=franchise|france|oss` (aucune valeur par défaut : le paiement ne démarre pas sans elle).
- **Prix TTC identiques dans tous les pays** (7 € partout) ; le HT varie avec le taux. Calcul en centimes : HT = arrondi au plus proche de TTC × 10 000 / (10 000 + taux en points de base), TVA = TTC − HT.
- **Taux normaux de l'UE** (au 19 novembre 2026, **à vérifier par le comptable** dans la base TEDB de la Commission avant la première vente et à chaque changement) : AT 20, BE 21, BG 20, CY 19, CZ 21, DE 19, DK 25, EE 24, ES 21, FI 25,5, FR 20, GR 24, HR 25, HU 27, IE 23, IT 22, LT 21, LU 17, LV 21, MT 18, NL 21, PL 23, PT 23, RO 21, SE 25, SI 22, SK 23. Table unique : `server/internal/paiement/tva.go`.
- **Pays** : déclaré par la personne sur la page Offres (liste des 27 États membres), envoyé avec la commande, **jamais gardé par notre serveur** ; transmis au prestataire (`metadata[pays_declare]`, ventilation de TVA PayPal) qui le garde avec la transaction. **Preuves de localisation** (OSS, au-delà du seuil : deux éléments non contradictoires) : pays déclaré + pays de la carte (Stripe) ou du compte PayPal ; **en crypto il n'existe qu'un élément** (le pays déclaré) : signalement S3. **Crypto refusée automatiquement sous `SHH_TVA=oss`** (décision du propriétaire, 24 novembre) : le serveur ne la propose plus (`moyens` de `GET /api/paiement` sans `crypto`, donc la page Offres ne la montre pas) **et** refuse une commande crypto (400 `bad_request`, aucun appel à NOWPayments), par une seule règle (`vendable`, `server/internal/paiement/service.go`, test `TestCryptoRefuseEnOSS`). Le prestataire reste inscrit pour ses **webhooks** : un paiement crypto tardif ou un remboursement d'une commande passée avant le passage en `oss` est toujours traité. Choix d'une règle dans le service plutôt qu'un refus de démarrer : passer en `oss` ne demande pas de retirer les secrets NOWPayments, et rien ne casse pour les commandes déjà en cours ; en `franchise` et `france`, la crypto reste proposée.
- **DP-9 (à valider)** : **ventes limitées aux 27 pays de l'UE au lancement**. Hors UE (Royaume-Uni, Suisse, Norvège, Canada…) beaucoup de pays exigent une immatriculation dès la première vente de services numériques : la page dit « Pas encore disponible dans votre pays ».
- Stripe : `SHH_STRIPE_TAXE=1` active Stripe Tax (calcul et déclaration préparée, commission en plus) ; sinon la facture Stripe porte le taux de notre table (réglage manuel du propriétaire dans Stripe).

### 9.2 Registre et conservation

- **Registre OSS** (règlement 282/2011, art. 63 quater) : conservé **10 ans** : pays, date, montant HT, taux, TVA, moyen de paiement. **Il vit chez les prestataires et dans la comptabilité du propriétaire** (exports mensuels des tableaux de bord Stripe, PayPal, NOWPayments), **jamais dans `paiements.db`**, qui ne garde ni montant ni pays.
- Pièces comptables : 10 ans (Code de commerce L123-22), même lieu.

### 9.3 Factures

- France, particulier : note obligatoire pour une prestation de services d'au moins 25 € TTC (annuels Plus et Pro), sinon sur demande. Mentions : numéro unique et continu, date, nom ou dénomination, adresse, SIREN et numéro de TVA intracommunautaire du vendeur (ou la mention de franchise), désignation (« Shhgone Plus, 365 jours »), prix unitaire HT, taux et montant de TVA (par pays en OSS), total TTC, date de la période.
- **Stripe** : facture créée par Stripe (`invoice_creation` pour un paiement unique ; automatique pour un abonnement), envoyée par Stripe à l'e-mail saisi chez Stripe, avec les mentions réglées par le propriétaire dans Stripe.
- **PayPal et crypto** : aucune facture automatique ; **le propriétaire l'émet** depuis son outil de facturation, à partir de l'export du prestataire (PayPal : reçu PayPal + facture du propriétaire ; crypto : sur demande, avec le numéro de commande). Signalement S4.
- Notre serveur **n'émet aucune facture** et ne garde aucune donnée de facturation.
- **Note de vente sur l'appareil (fait, S4)** : sur `/offres/retour`, paiement reçu, « Télécharger la note de vente » produit un fichier HTML autonome (aucun script, aucune ressource externe, valeurs échappées), en français, assemblé sur l'appareil (`web/src/paiement/note.ts`) à partir du pass gardé (offre, durée, moyen, pays déclaré, date de commande), de l'état du pass (fin de la période) et du régime de TVA publié par `GET /api/paiement` (`tva` : régime et taux appliqué par pays, mêmes arrondis que `Ventiler`). Aucune requête n'emporte le pays, le montant ou une identité ; le serveur n'apprend pas qu'une note est faite. Les mentions qui dépendent du propriétaire (nom, adresse, SIREN, numéro de TVA, **numéro de la série continue**) sont en « [À COMPLÉTER] » (`VENDEUR` dans `note.ts`). **Limite** : une série continue exige le registre du vendeur ; la note porte une référence unique tirée sur l'appareil (S18). Un renouvellement est une nouvelle vente que l'appareil ne voit pas : la note ne porte que sur la période affichée.

### 9.4 Droit de la consommation

- Information précontractuelle et **CGV** (L111-1, L221-5) accessibles avant le paiement (lien depuis le récapitulatif) ; prix TTC, durée, renouvellement, résiliation.
- **Rétractation 14 jours** (L221-18) : accès immédiat demandé par une case **non cochée** et renonciation expresse (L221-28 13°, contenu numérique fourni immédiatement) ; sans case cochée, le bouton reste inactif (**DP-10, à valider avec le juriste** : alternative, accepter sans renonciation et rembourser au prorata sur demande). La renonciation et son heure sont transmises au prestataire (`metadata`), preuve gardée avec la transaction.
- **Abonnement** : information sur la reconduction, **résiliation en ligne en un clic** (« Arrêter le renouvellement », §5.6, conforme à la résiliation « en trois clics » de 2023), sans frais ; rappel avant échéance annuelle : **non fait par nous** (aucun e-mail) ; Stripe peut l'envoyer (réglage « e-mails de rappel » du propriétaire) ; signalement S5.
- **Médiateur de la consommation** (L612-1) : nom et adresse dans les CGV et les mentions légales.

### 9.5 RGPD

- Responsables de traitement : le propriétaire (commande, pass, comptabilité) ; Stripe, PayPal et NOWPayments pour leurs propres traitements (lutte contre la fraude, obligations bancaires) ; contrats de sous-traitance ou de coresponsabilité à accepter chez chacun.
- Page Confidentialité : ce que voit chaque prestataire (§3), transferts hors UE (Stripe et PayPal : États-Unis, cadre de protection des données UE–États-Unis ; NOWPayments : pays du siège, à vérifier), durées (§5.7, §9.2).
- Aucune donnée personnelle dans `paiements.db` (pas d'e-mail, de nom, de pays, d'IP) ; `Q` et l'identifiant de commande sont des pseudonymes (le prestataire peut les relier à une personne).
- Mentions légales d'un professionnel (LCEN art. 6) : obligatoires avant la première vente.

## 10. Configuration du serveur

Désactivé par défaut, comme `SHH_COMPTES` : sans `SHH_PAIEMENT=1`, aucune route `/api/paiement/*` (404 uniforme), aucun fichier lu, aucune base ouverte, aucun appel sortant. Toute variable posée est vérifiée même désactivé (erreur visible au démarrage).

| Variable | Rôle |
|---|---|
| `SHH_PAIEMENT` | `1` : active le paiement (exige `SHH_ORIGIN` pour les adresses de retour, `SHH_TVA` et au moins un prestataire complet) |
| `SHH_PAIEMENT_ESSAI` | `1` : bacs à sable (Stripe `sk_test_`/`rk_test_`, PayPal sandbox, NOWPayments sandbox) ; `0` (défaut) : production (`sk_live_`/`rk_live_`) ; une clé d'un autre mode → refus |
| `SHH_TVA` | `franchise`, `france` ou `oss` (§9.1) ; `oss` retire la crypto des moyens proposés et la refuse (24 novembre) |
| `SHH_STRIPE_CLE_FILE`, `SHH_STRIPE_WEBHOOK_FILE` | fichiers secrets : clé secrète ou restreinte, secret de signature `whsec_…` ; les deux ou aucun |
| `SHH_STRIPE_TAXE` | `1` : Stripe Tax |
| `SHH_PAYPAL_CLIENT_ID` | identifiant d'application (public) |
| `SHH_PAYPAL_SECRET_FILE` | fichier secret du secret d'application |
| `SHH_PAYPAL_WEBHOOK_ID` | identifiant du webhook déclaré chez PayPal (public) |
| `SHH_PAYPAL_PLANS` | `plus-mois=P-…,plus-an=P-…,pro-mois=P-…,pro-an=P-…` (quatre plans exactement) |
| `SHH_NOWPAYMENTS_CLE_FILE`, `SHH_NOWPAYMENTS_IPN_FILE` | fichiers secrets : clé d'API, secret IPN ; les deux ou aucun |

Règles (refus de démarrer, message sans valeur secrète) : un prestataire **à moitié configuré** ; un fichier secret dans `SHH_DATA_DIR`, illisible, vide, de plus de 1 Kio, ou aux droits plus larges que 0600 ; une clé Stripe qui n'a pas le préfixe du mode ; un secret Stripe sans `whsec_` ; des plans PayPal incomplets ou en double ; `SHH_PAIEMENT=1` sans prestataire.

**Sortie réseau** (signalement S1, **bloquant pour la mise en ligne**) : le serveur Go n'a **aucune route vers Internet** (`compose.yaml`, réseau `internal`). Le paiement demande trois sorties HTTPS : `api.stripe.com`, `api-m.paypal.com` (ou bac à sable), `api.nowpayments.io`. **Corrigé (tâche 10)** : trois relais `shhcheck relais` (comme le relais SMTP), un par cible fixe `hôte:443` (production ou bac à sable selon `SHH_PAIEMENT_ESSAI`, fixé par `deploy.sh`), sur 172.30.53.4 à .6, profils `paiement-stripe`, `paiement-paypal`, `paiement-nowpayments`, démarrés seulement pour un prestataire dont les secrets sont dans `secrets/` ; `extra_hosts` vers eux ; TLS de bout en bout vérifié par le serveur ; client sans connexion gardée (le relais coupe à 60 s). `SHH_PAIEMENT` et `SHH_PAIEMENT_ESSAI` sont posés dans `compose.yaml` (`"0"` aujourd'hui), jamais dans `deploy/.env` ; `deploy.sh` vérifie secrets et réglages (`deploy/README.md` §13). Tests : `make test-sortie` (partie statique passée ; partie réseau réel : démon Docker requis), `make lint-deploy`.

## 11. Droits et format, pour les apps et le salon

Liste fermée de droits, en texte, rendue par `/api/paiement/etat` et attachée à l'offre (donc à la clé d'émission des jetons) :

| Droit | Plus | Pro | Disponible |
|---|---|---|---|
| `partage_plus` (limites Plus : 10 Gio, 2 ou 3 j, 10 ouvertures) | oui | — | **fait** (tâche 12) |
| `partage_pro` (limites Pro : 30 Gio, 2, 3 ou 7 j, 20 ouvertures) | — | oui | **fait** (tâche 12) |
| `premiere_ouverture` (compte à rebours au premier déverrouillage) | oui | oui | §38.9.1, à coder |
| `salon_plus`, `salon_pro` (§38.8.1 : 3 j, 20 personnes, 5 Go ; 7 j, 50 personnes, 20 Go) | `salon_plus` | `salon_pro` | à coder |
| `appel_audio` | oui (DP-14) | oui | **non : bientôt** |
| `appel_video` | oui (DP-14, décision du propriétaire, 24 novembre ; `offres.go`, `TestDroitsAppelsBientot`) | oui | **non : bientôt** |

- Un jeton dépensé à la création d'un salon fixe le niveau du salon (`tier`) ; les appels liront ce niveau, jamais un pass ni un compte (même règle que les fonctions de §38.9.0 point 3).
- **Appels : jamais vendus ni promis comme disponibles** tant qu'ils n'existent pas : sur la page Offres et les cartes des offres, une ligne « Appels audio et vidéo dans les salons · bientôt » (Plus et Pro, décision du propriétaire, 24 novembre ; avant : « Appels audio · bientôt » pour Plus), sans aucune incidence sur le prix ; les CGV disent que l'offre ne comprend pas les appels aujourd'hui. Spécification des appels à écrire avant tout code (salon v3 §8 : TURN relais seulement, SFrame, coût en bande passante).
- Version du format : champ `v: 1` dans la réponse d'état ; un droit inconnu est ignoré par un client ancien.
- **Limites payantes appliquées (tâche 12)** : contrôle **côté site et côté serveur**. Paliers de taille payants (`PAID_BUCKETS` du moteur, vecteurs `engine/vectors/v5-paliers.json`) ; le serveur (`share/tier.go`) fixe la formule de l'envoi d'après le jeton dépensé, vérifie palier, durée (Plus 48 ou 72 h, Pro 48, 72 ou 168 h), ouvertures (10, 20) et la fenêtre d'envoi (24 h) ; quotas du jour à part pour le payant (Plus 40 Gio par connexion /64 et 80 Gio par /48, Pro 100 et 200 Gio). Le site ne propose une formule payante que si un pass payé est sur l'appareil (Options) ; changer de formule recommence l'envoi. **Pas encore faits** : `premiere_ouverture`, salons payants, et une réserve de stockage séparée pour le payant (les partages payants partagent `SHH_STORAGE_MAX` avec les gratuits). **Plafond de sortie par partage (24 novembre, décision 12)** : un partage, toutes ouvertures confondues, sert au plus `SHH_SHARE_EGRESS_MAX` octets (250 Gio par défaut, à valider), compteur en mémoire seulement, puis 403 `egress_limit` (spec principale §38.6) ; la formule n'étant pas gardée après la finalisation, le même plafond vaut pour tous les partages (seuls les payants peuvent l'atteindre).

## 12. Chaîne d'approvisionnement

- **Aucun SDK de paiement** : ni `stripe-go`, ni SDK PayPal, ni bibliothèque NOWPayments. Raisons : surface d'attaque, mises à jour fréquentes, dépendances transitives ; quatre appels et trois vérifications de signature tiennent dans la bibliothèque standard. Le format des événements Stripe a été relu dans `stripe-go` v84.4.0 (module téléchargé depuis `proxy.golang.org`, non ajouté au dépôt) : signature `t`/`v1`, tolérance 300 s, champs `parent.subscription_details` de la version « clover ».
- **Revue des jetons (19 novembre, tâches 6 et 7)** :
  - **Go** : `github.com/cloudflare/circl` **v1.6.5** (BSD-3-Clause, Cloudflare ; `blindsign/blindrsa`, celui de l'implémentation Privacy Pass de Cloudflare) ; aucune dépendance nouvelle à la compilation (`golang.org/x/sys` v0.50.0 était déjà là ; `golang.org/x/crypto` v0.54.0 n'apparaît que dans le graphe de modules). `go.sum` porte les empreintes.
  - **Rust** (`Cargo.lock`, fonction `jetons` de `shhdrop-core` seulement) : `blind-rsa-signatures` **0.19.0** (MIT, Frank Denis) et ses dépendances directes : `rsa` 0.10.0, `crypto-bigint` 0.7.11, `digest` 0.11.3, `rand` 0.10.4, `rand_core` 0.10.1 (RustCrypto et rust-random, MIT ou Apache-2.0), `crypto-primes` 0.7.2 (Apache-2.0 ou MIT, Entropy), `hmac-sha256` 1.1.15 et `hmac-sha512` 1.1.13 (ISC, Frank Denis), `ct-codecs` 1.1.8 (MIT, Frank Denis), `derive_more` 2.1.1 et `derive-new` 0.7.0 (MIT, macros de compilation) ; puis `pkcs1` 0.8.0, `pkcs8` 0.11.0, `spki` 0.8.1, `der` 0.8.3, `const-oid` 0.10.2 (RustCrypto). Toutes les licences sont compatibles (MIT, Apache-2.0, ISC, BSD-3-Clause). `rand` passe de 0.10.3 à 0.10.4 pour tout le moteur. `getrandom` 0.4.3 avec `wasm_js` (aléa de WebCrypto dans le navigateur).
  - **Avis de sécurité** : `cargo audit` **non lancé** (outil absent de la machine ; son installation n'a pas été autorisée ici) : à lancer avant la première vente. Point connu : RUSTSEC-2023-0071 (« Marvin », temps non constant des opérations à **clé privée** de `rsa` ≤ 0.9) ; ici `rsa` 0.10.0 (arithmétique en temps constant de `crypto-bigint` 0.7), et le moteur ne fait **aucune** opération à clé privée hors des tests (aveuglement, finalisation et vérification utilisent la clé publique) ; la signature est faite par le serveur Go.
  - **Taille** : module `jetons` à part, ≈ 56 Ko en brotli ; le moteur des partages, sans lui, reste sous son plafond (`check-dist`).

## 13. Ce que le propriétaire doit fournir

**Avant tout essai (bac à sable)** :

1. Compte **Stripe** (mode test) : clé secrète `sk_test_…` (ou clé restreinte : écriture Checkout Sessions et Subscriptions, lecture du reste) ; endpoint de webhook `https://<domaine>/api/paiement/webhook/stripe`, **version d'API `2026-02-25.clover`**, événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`, `invoice_payment.paid`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created` ; son secret `whsec_…`.
2. Compte **PayPal Business** et application REST (sandbox) : `client_id` et secret ; webhook `https://<domaine>/api/paiement/webhook/paypal` avec les événements `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`, `CUSTOMER.DISPUTE.CREATED` ; son identifiant ; **un produit et quatre plans** (Plus mensuel 7,00 EUR, Plus annuel 70,00 EUR, Pro mensuel 20,00 EUR, Pro annuel 200,00 EUR, prix TTC, sans période d'essai, sans frais d'installation, `payment_failure_threshold` 1) et leurs identifiants `P-…`.
3. Compte **NOWPayments** (sandbox) : clé d'API, secret IPN, adresse de versement (payout) pour chaque monnaie activée (XMR, BTC, ETH, USDT) ; adresse IPN `https://<domaine>/api/paiement/webhook/nowpayments`.
4. Les secrets **par le formulaire sécurisé ou en fichiers 0400** dans `/srv/shhdrop/secrets/` (jamais dans le chat, le dépôt ou `deploy/.env`).
5. Le domaine de production servi par le serveur (la démo GitHub Pages n'a pas de serveur).

**Avant la première vente réelle** :

6. Statut, SIREN, numéro de TVA intracommunautaire (sauf franchise), **choix du régime de TVA** (`SHH_TVA`), immatriculation OSS si `oss`.
7. Mentions légales d'un professionnel, **CGV**, médiateur de la consommation, texte exact de la renonciation, page Confidentialité complétée (§9.5 ; section paiement écrite le 22 novembre, à relire).
8. Réglages chez Stripe : identité du vendeur et mentions sur les factures, Stripe Tax (ou non), Radar, e-mails de reçus et de rappel ; chez PayPal : nom de marque, e-mails ; chez NOWPayments : monnaies, conversion automatique en euros ou non (choix fiscal, à voir avec le comptable).
9. Comptable : tenue du registre OSS et des factures depuis les exports, traitement des paiements crypto (valeur en euros à la date de réception).
10. Clés de production (`sk_live_…`, application PayPal « Live », NOWPayments production), webhooks de production déclarés de même.
11. Validation des DP-1 à DP-14 et des signalements ci-dessous (S16 à S19 en particulier).
12. **Mentions de la note de vente** (`VENDEUR`, `web/src/paiement/note.ts`, aujourd'hui « [À COMPLÉTER] ») : nom ou dénomination, adresse, SIREN, numéro de TVA intracommunautaire (sauf franchise), et le choix pour la **série continue** des numéros (S18).
13. **Activation** : `SHH_PAIEMENT: "1"` (et `SHH_PAIEMENT_ESSAI` selon le cas) dans `deploy/compose.yaml`, commité ; fichiers `shh_stripe_cle`, `shh_stripe_webhook`, `shh_paypal_secret`, `shh_nowpayments_cle`, `shh_nowpayments_ipn` (compte 65532, 0400) ; `SHH_TVA` et les réglages PayPal dans `deploy/.env` (`deploy/README.md` §13) ; sauvegarde du §12.4 en place le même jour.
14. ~~**CLAUDE.md** : la phrase « pas encore ajoutées au 19 novembre » de l'exception des jetons est à mettre à jour par le propriétaire~~ Fait : l'exception dit « ajoutées le 19 novembre », versions épinglées écrites.
15. Avant la vente : `cargo audit` sur `engine/Cargo.lock` et `govulncheck` sur `server/` ; `make test-sortie` sur une machine avec Docker (partie réseau réel).

## 14. Décisions prises par défaut (à valider)

| # | Décision |
|---|---|
| DP-1 | Crypto : mensuel en paiement unique de 30 jours |
| DP-2 | Le prestataire reçoit un identifiant de commande aléatoire, jamais `Q` |
| DP-3 | Version d'API Stripe épinglée `2026-02-25.clover` (celle de `stripe-go` v84.4.0) ; le webhook est déclaré dans cette version |
| DP-4 | Prix Stripe « en ligne » (`price_data`), pas de prix créés dans le tableau de bord ; PayPal : plans créés par le propriétaire (obligatoires pour un abonnement) |
| DP-5 | Capture PayPal déclenchée par le webhook `CHECKOUT.ORDER.APPROVED` seulement |
| DP-6 | `Q` = SHA-256(« shhdrop/v2/pass » ‖ 0x00 ‖ `P`), calculée par le serveur ; l'appareil n'envoie que `P` |
| DP-7 | Pas de clé de secours du pass au lancement |
| DP-8 | Pass rangé dans le coffre **privé** du compte, pas dans le profil (séquestre) |
| DP-9 | Ventes limitées aux 27 pays de l'UE |
| DP-10 | Renonciation au droit de rétractation obligatoire pour payer |
| DP-11 | Remboursement partiel : aucun effet automatique |
| DP-12 | Rétention : commande non payée 7 jours ; commande payée jusqu'à la fin + 180 jours ; pass jusqu'à la fin + 31 jours |
| DP-13 | Retour unique `/offres/retour`, sans paramètre ; l'état vient du serveur |
| DP-14 | ~~Appels audio dans Plus, audio et vidéo dans Pro, « bientôt »~~ **Tranché le 24 novembre (propriétaire)** : appels audio **et** vidéo dans Plus **et** dans Pro, « bientôt » |

## 15. Signalements

| # | Gravité | Endroit | Problème | Correction |
|---|---|---|---|---|
| S1 | ~~Bloquante~~ **corrigée** | `deploy/compose.yaml` (réseau `internal`) | Le serveur n'a aucune sortie vers Internet : aucun appel à Stripe, PayPal ou NOWPayments ne peut aboutir en production | Fait : trois relais à cible fixe (tâche 10, §10) ; partie réseau réel de `test-sortie.sh` à passer sur une machine avec Docker |
| S2 | ~~Bloquante~~ **corrigée pour les partages** | `server/internal/share` | Le serveur ne connaissait aucune limite Plus/Pro | Fait : paliers, durées, ouvertures, quotas, contrôle site et serveur, jeton dépensé (tâche 12, §11) ; plafond de sortie par partage (24 novembre, `SHH_SHARE_EGRESS_MAX`, 250 Gio par défaut, §11) ; restent `premiere_ouverture` et les salons payants : ne pas les annoncer comme disponibles |
| S3 | Élevée, légal ; **corrigée le 24 novembre** | §9.1 | Crypto : une seule preuve de localisation (pays déclaré) ; au-delà du seuil OSS, deux preuves sont exigées | Fait (décision du propriétaire, 24 novembre) : crypto acceptée seulement en `franchise` ou `france` ; sous `oss`, ni proposée ni acceptée (§9.1). Reste à l'avis du comptable : le passage du seuil de 10 000 € en cours d'année (`france` à `oss`) se règle en changeant `SHH_TVA` le jour même |
| S4 | Élevée, légal | §9.3 | PayPal et crypto n'émettent pas de facture ; note obligatoire dès 25 € TTC | Fait en partie : note de vente téléchargeable sur l'appareil, mentions du vendeur à compléter (§9.3) ; reste au propriétaire la série continue (S18) et ses propres factures depuis son outil |
| S5 | Moyenne, légal | §9.4 | Abonnements : rappel avant reconduction annuelle non fait par nous (aucun e-mail) | Activer le rappel de Stripe et PayPal ; avis du juriste |
| S6 | Moyenne, confidentialité | §3, §5.1 | Notre base relie commande ↔ `Q`, le prestataire commande ↔ identité : ensemble, ils disent qui a payé quel pass (pas quels partages) | Assumé ; dit sur la page Confidentialité ; purge §5.7 |
| S7 | Moyenne, exploitation | §6.3 | App Store et Google Play : vendre un service numérique hors de leur paiement peut faire refuser les apps | Aucun achat dans les apps, lecture du pass seulement |
| S8 | Faible, exactitude | spec §38.4 | « RSABSSA-SHA384-PSS-Randomized » contredit RFC 9578 (type 2 : Deterministic) | Corrigé en §7 |
| S9 | Moyenne, sécurité | §5.5, §7 | Les jetons déjà émis survivent à une révocation | Fait : clés du jour (jeton valable le jour de sa clé et le lendemain), au plus 10 ou 20 jetons par pass et par jour, lots de 5 au plus, aucune clé dans les sauvegardes ; limite restante écrite au §7 ; à dire dans les CGV |
| S10 | ~~Moyenne, exploitation~~ **corrigée** | §4.1 | Un remboursement d'une facture d'abonnement Stripe n'est pas toujours relié à sa commande (le PaymentIntent d'une facture ne porte pas nos métadonnées) | Fait (audit du 20 novembre, S6) : `invoice_payment.paid` range l'empreinte du PaymentIntent avec la commande (§4.1), test `TestStripeAbonnementConteste` (litige et remboursement d'un abonnement → pass révoqué) ; reste : l'événement doit être coché sur l'endpoint Stripe (§13 point 1), sinon révocation à la main |
| S11 | Moyenne, exploitation | §5.1 | `paiements.db` perdue = pass payés perdus | Fait : sauvegarde quotidienne chiffrée avec `comptes.db` (tâche 9) ; un pass payé dans les 24 h d'avant la perte reste perdu (remboursement à la main, README §12.5) |
| S12 | Faible, exploitation | §8 | Webhooks soumis à 60 requêtes par minute par adresse : un pic de renouvellements peut être retardé | Assumé : les prestataires réessaient ; à revoir si des retards s'observent |
| S13 | Moyenne, exactitude | §38.8.2 | Pro annuel à 200 € : marge brute 57,7 %, sous la cible ; frais Stripe (≈ 1,5 % + 0,25 €) et PayPal (≈ 3,4 % + 0,35 €) différents de ceux d'un vendeur officiel, et la TVA à 27 % pèse sur le HT | Refaire le tableau de marge de §38.8.3 avec les vrais frais avant la première vente |
| S14 | Moyenne, légal | §1 | « Appels audio et vidéo · bientôt » affiché à côté d'un prix peut passer pour une promesse | Mention « non compris aujourd'hui » dans les CGV et sur la carte ; aucun effet sur le prix |
| S15 | Faible, confidentialité | §2 | La page Offres demande le pays de résidence | Nécessaire à la TVA ; jamais gardé par nous ; dit sous le champ |
| S16 | Moyenne, confidentialité | §7, `web/src/paiement/jetons.ts` | Un lot de jetons est demandé quand le premier partage payant en manque : émission et première dépense se suivent de quelques secondes ; avec peu d'acheteurs, l'heure peut relier un pass à ce partage (la conception prévoyait une émission anticipée à heure aléatoire) | **Fait en partie (22 novembre)** : réapprovisionnement programmé après chaque dépense à une heure aléatoire (5 à 30 min), jetons mûrs (5 min) dépensés d'abord, jamais d'attente imposée (§7). **Écart à la correction proposée** : pas de lot au simple chargement de l'application, car un jeton vit deux jours au plus et chaque jeton jeté est un partage payé perdu (une visite par jour sans partage viderait la réserve de 30 de Plus en deux à trois semaines). **Fait aussi (22 novembre)** : état du pass gardé sur l'appareil jusqu'au lendemain UTC ou jusqu'à un événement qui le change, au lieu d'être redemandé à chaque chargement (§7). **Reste** : premier partage d'une série (réserve vide) lié par l'heure à son émission, et premier chargement du jour ; dit sur la page Confidentialité. Piste, au choix du propriétaire : lot au chargement malgré la perte de jetons |
| S17 | Moyenne, confidentialité | §7 | Clés du jour servies par l'API : rien ne prouve à l'appareil que tous reçoivent la même ; un serveur malveillant pourrait donner une clé par personne et reconnaître ses jetons | Comparer les clés par un second chemin (par exemple les apps et le site, ou un journal public des clés du jour), ou revenir à des clés publiées dans le manifeste signé (au prix d'une révocation moins rapide). **Fait en partie (22 novembre, décision du propriétaire : rien sur GitHub)** : clés annoncées 7 jours à l'avance, gardées par l'appareil, clé différente pour un jour déjà vu refusée avec un avertissement (§7). **Reste** : clés personnelles dès le premier contact, non détectées par un seul appareil (comparaison site et apps à prévoir) ; dit sur la page Confidentialité |
| S20 | Moyenne, exploitation | §7, `deploy/sauvegarder.sh`, `restaurer.sh` | Depuis S17, une restauration (clés privées des jetons retirées de la copie) fait tirer de nouvelles clés pour des jours déjà annoncés : tous les appareils qui avaient vu les anciennes avertissent « clé différente » et refusent la formule jusqu'à 8 jours | Au choix du propriétaire : garder dans la sauvegarde chiffrée les clés **à venir** (prix : qui vole la sauvegarde et sa clé peut signer des jetons de ces jours, donc créer des partages payants sans payer), ou accepter la fausse alerte et la dire sur la page d'incident |
| S18 | Moyenne, légal | §9.3 | La note de vente ne peut pas porter un numéro de la série continue du vendeur (aucun registre sur l'appareil, aucun compteur chez nous) | Choix du propriétaire : compteur de ventes dans `paiements.db`, rendu par `/api/paiement/etat` (sans identité ni montant), ou factures émises par son outil seulement, la note restant un récapitulatif |
| S19 | Faible, confidentialité | §7 | Le jour de la clé dit le jour d'émission : l'ensemble d'anonymat est celui des pass de la même offre servis ce jour-là ou la veille | Assumé (prix de S9) ; **dit** sur la page Confidentialité (22 novembre) |

# Paiement par Paddle, compte et jetons anonymes (conception, à valider)

Décisions du propriétaire du 16 novembre : ouvrir les étapes « compte » et « paiement » de la page Offres ; vendeur officiel **Paddle** ; **jetons anonymes** (Privacy Pass, Q-P2 acceptée) ; **carte seulement** au lancement (crypto-monnaies retirées de l'affichage). Le propriétaire indique que le statut et le cadre légal sont prêts. S'appuie sur la spec §37 (compte), §38 (offre payante) et la conception du compte par e-mail (`2026-11-14-compte-email-design.md`).

## Parcours (page Offres)

1. Choisir l'offre (Plus ou Pro) et la facturation (mensuel par défaut, annuel au choix). Déjà en ligne.
2. **Compte** : créer son compte ou se connecter (compte facultatif par e-mail, déjà construit derrière `__COMPTES__` / `SHH_COMPTES=1`). Il ne sert qu'à ranger le pass et à synchroniser l'historique (§37).
3. **Paiement** : le navigateur tire le pass `P` (32 octets) et calcule `Q` = SHA-256(HKDF(`P`, « shhdrop/v2/pass »)) (§38.4) ; seul `Q` part, comme donnée de commande, vers Paddle. Paddle encaisse, facture en son nom, collecte la TVA.
4. **Webhook signé de Paddle** → notre serveur : signature vérifiée (HMAC-SHA256 de Paddle, comparaison à temps constant), horodatage borné (rejeu refusé), puis ligne `passes(q, valid_until_day, tokens_left)` dans `passes.db`, séparée des partages et des comptes. Ni référence de commande, ni moyen de paiement, ni e-mail gardés.
5. **Jetons anonymes** : le navigateur présente `P`, reçoit par lots des jetons signés en aveugle (RFC 9474/9578, type 2) ; chaque partage Plus ou Pro dépense un jeton ; le serveur ne peut relier ni un jeton à un pass, ni deux partages entre eux.

## Point bloquant à vérifier : comment ouvrir le paiement Paddle

CLAUDE.md interdit toute ressource tierce sur le site. Le paiement Paddle « classique » charge **Paddle.js** (script de Paddle) sur une page du vendeur. Deux voies, à confirmer dans la documentation de Paddle (`developer.paddle.com`, inaccessible depuis cette session) :

- **A (préférée)** : page de paiement **hébergée par Paddle** (redirection complète vers un domaine Paddle, puis retour vers `/offres?paye=1`). Aucun script tiers chez nous. À vérifier : que Paddle Billing permet une page hébergée sans « lien de paiement par défaut » sur notre domaine, et qu'on peut y attacher `Q` (`custom_data` de la transaction créée par notre serveur via l'API).
- **B (exception à valider)** : une page de paiement sur un **sous-domaine séparé** (par exemple `paiement.shhgone.com`) qui charge Paddle.js, comme l'exception reCAPTCHA (§26, retirée le 24 novembre) : jamais sur une page qui détient des clés, aucun accès à l'origine du site, `Q` seul transmis. Demande une décision écrite du propriétaire.

## Ce qu'il faut du propriétaire avant de coder la partie Paddle

- Compte Paddle (sandbox d'abord) ; produits et prix : Plus 7 €/mois, 70 €/an ; Pro 20 €/mois, 200 €/an (TTC).
- Clé d'API et secret de webhook de la sandbox, saisis par le formulaire sécurisé de l'environnement (jamais dans le chat ni dans le dépôt).
- Le domaine du site en production et l'hébergement du serveur (le site public actuel est la démo GitHub Pages, sans serveur : le compte et le paiement ne peuvent pas y marcher).
- Pour les mentions légales et la vente (§38.5) : identité professionnelle, CGV, médiateur, texte de renonciation au droit de rétractation (case non cochée).

## Signalements

- **Élevée, légal** : aucune vente avant les mentions légales d'un professionnel, les CGV et le médiateur (§38.5).
- **Élevée, sécurité** : le webhook est la seule source de vérité du paiement ; il doit être vérifié (signature, horodatage, rejeu) et testé avant toute mise en ligne.
- **Moyenne, confidentialité** : Paddle connaît l'identité du payeur et `Q` ; nous ne recevons que `Q` ; la page Confidentialité doit le dire.
- **Moyenne, exactitude** : le mensuel est un abonnement (D41-34) ; la résiliation en un clic passe par le portail client de Paddle : à décrire dans les CGV.

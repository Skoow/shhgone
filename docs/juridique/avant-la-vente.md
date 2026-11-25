# Avant la première vente réelle (offres Plus et Pro)

25 novembre 2026. **À faire relire par l'avocat.** Décision du propriétaire du même jour : les pages du site restent simples (éditeur anonyme, aucun champ d'identité à compléter). Ce qui suit doit être ajouté **avant** de passer `SHH_PAIEMENT` à `"1"` (`deploy/compose.yaml`) ; conception du paiement §9 et §13.

## Pourquoi (gravité élevée)

Vendre fait de l'éditeur un professionnel. L'anonymat de la LCEN (art. 1-1, II) ne vaut que pour une personne physique **non professionnelle** : dès la première vente, les mentions légales doivent donner l'identité de l'éditeur (LCEN art. 1-1, I), et les conditions de vente les informations précontractuelles du Code de la consommation (L111-1, L221-5). Ouvrir le paiement avec les pages d'aujourd'hui serait non conforme.

## Informations à fournir par le propriétaire

1. Nom et prénom, ou dénomination sociale, de l'éditeur et vendeur.
2. Statut juridique (micro-entreprise, EI, SASU, EURL…) et, pour une société, capital social.
3. Adresse (siège ou domicile professionnel ; une domiciliation est possible).
4. Numéro d'immatriculation : SIREN/SIRET, et RCS ou inscription au registre national des entreprises (RNE).
5. Numéro de TVA intracommunautaire, ou mention de franchise (« TVA non applicable, art. 293 B du CGI ») ; régime choisi pour `SHH_TVA` (`franchise`, `france` ou `oss`) et immatriculation OSS si besoin.
6. Directeur de la publication (en principe l'éditeur lui-même).
7. Téléphone de contact (exigé par la LCEN pour les professionnels : « coordonnées téléphoniques »), en plus de contact@shhgone.com.
8. Médiateur de la consommation (obligatoire, L612-1) : nom, adresse postale et site web du médiateur choisi, après adhésion.
9. Texte définitif de la renonciation au droit de rétractation et choix DP-10 (renonciation obligatoire, ou accès sans renonciation avec remboursement au prorata), après avis de l'avocat (voir plus bas).
10. Mentions de la note de vente (`VENDEUR`, `web/src/paiement/note.ts`) et série continue des numéros de facture dans l'outil comptable.
11. Fournisseur du stockage des sauvegardes (nom, pays), pour le registre et la page Confidentialité.

## Ce qui sera ajouté au site, une fois ces informations reçues

- Mentions légales : identité complète de l'éditeur et vendeur (points 1 à 7), à la place de la phrase sur l'anonymat ; retrait du bandeau « En cours de rédaction » après relecture de l'avocat.
- Conditions de vente (page Conditions, section « Offres payantes : conditions de vente ») : identité du vendeur, médiateur de la consommation (point 8), texte définitif de la rétractation (point 9).
- Registre des traitements : responsable du traitement identifié, fournisseur des sauvegardes.

## Points à faire trancher par l'avocat

- **Rétractation** : un abonnement d'accès est-il un « contenu numérique » (L221-28 13°, renonciation possible) ou un « service numérique » (L221-28 1° : exclusion seulement s'il est pleinement exécuté ; sinon L221-25 : rétractation possible, paiement au prorata) ? La page Offres demande aujourd'hui une renonciation obligatoire pour payer.
- **Plateforme européenne de règlement en ligne des litiges (RLL)** : supprimée le 20 juillet 2025 (règlement (UE) 2024/3228) ; ne plus la citer. À confirmer.
- Information précontractuelle : la réserve de jetons (30 ou 100 partages payants par période de 30 jours) n'est écrite que dans les Conditions, pas sur la page Offres ; l'ajouter au récapitulatif avant le paiement.
- Anonymat de l'éditeur tant que rien n'est vendu, alors que la page Offres est publique (paiement fermé, « Bientôt ») : acceptable ?
- Conservation des données de connexion (décret 2021-1362 art. 8, décret 2025-980) : question déjà ouverte (spécification §17.1).
- Conditions des prestataires (Stripe, PayPal, NOWPayments) : responsables distincts, transferts hors UE (siège de NOWPayments à vérifier).
- Déclaration ANSSI du moyen de cryptologie (spécification §17), avant l'ouverture au public.

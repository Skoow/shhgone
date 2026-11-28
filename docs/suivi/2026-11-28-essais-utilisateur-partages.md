# Essais « utilisateur réel » : partages, compte, offres (28 novembre 2026)

Hors salon (essai à part, plus tard). Fait sur un serveur local complet (compte, paiement en essai, administration), avec le site construit comme en production, dans Chromium : téléphone (Pixel 7) et ordinateur (1366 × 860). Passkeys virtuelles (pas de vrai téléphone ni de vrai Safari). Captures et journal : dossier de travail de la session (non versionné).

Personnages : Léa (expéditrice, avec compte), Tom (destinataire, ordinateur), Zoé (destinataire, téléphone, dernière ouverture), Max (arrive trop tard).

## Ce qui marche bien

- Inscription par passkey, clé de récupération, groupe retapé ; « Compte créé » clair.
- Envoi : feuille « Ajouter » claire, catégories, options (nom, durée, ouvertures, mot de passe généré, téléchargement), « Lien prêt » très lisible.
- Destinataire : mot de passe faux (4, 3, 2 essais restants, « dernier essai », puis « détruit ») ; lien coupé, modifié ou sans clé → « Lien incomplet », sans requête au serveur ; navigateur intégré (Instagram) détecté ; partage sans mot de passe : « Rien n'est ouvert avant que vous appuyiez sur Ouvrir » ; visionneuse (photo, note, audio, PDF).
- **La dernière personne qui ouvre peut détruire le partage** (Zoé) ; ensuite Max et Tom reçoivent « Ce lien n'existe pas ou n'est plus disponible », avec l'explication.
- Suppression par l'expéditrice : la page déjà ouverte du destinataire passe d'elle-même à « Ce partage a été supprimé ».
- Téléchargement interdit : chaque élément non affichable le dit ; avertissement dans les options (« 3 éléments ne pourront pas être ouverts sans téléchargement »).
- Compte : clé mal recopiée refusée ; nouvelle clé ; **rappel des 6 mois** (bandeau sur l'accueil, Mes partages, section Clé) ; nouvel appareil par la clé de récupération puis passkey ajoutée en un geste ; deux appareils visibles et déconnectables ; suppression du compte (deux confirmations, accès offert arrêté, appareil remis à zéro).
- Accès Pro offert (lien du tableau de bord) : rangé dans le compte, « Pro offert jusqu'au 27 novembre 2027 » sur la page Compte.
- Bandeau de maintenance et page « État du service ».

## Constats, du plus important au moins important

| # | Gravité | Où | Constat | Proposition |
|---|---|---|---|---|
| 1 | **Élevée** (dès l'ouverture des ventes) | Page d'envoi, cadre « Votre offre » (`ui/CurrentOffer.svelte`) | Affiche **« Gratuit · 2 Go · 24 h · 5 ouvertures » en dur**, même avec un pass Plus ou Pro (vu avec l'accès Pro offert). Reste d'avant l'ouverture des ventes. | Lire l'offre réelle (pass de l'appareil ou du compte) et ses limites. |
| 2 | **Élevée** | Page Offres, carte Gratuit (`ui/OffersCheckout.svelte`) | La carte Gratuit dit toujours « votre offre », même avec Pro actif. | Marquer la carte de l'offre réellement détenue. |
| 3 | **Élevée** (expérience payante) | Options d'envoi, « Formule de ce partage » | Une personne Pro doit choisir « Pro » **à chaque envoi** (défaut : Gratuit), et changer de formule **recommence l'envoi des fichiers déjà ajoutés**. Elle peut croire avoir envoyé en Pro alors que non (limites Gratuit). | Formule par défaut = la meilleure offre détenue (tant qu'il reste des partages inclus) ; choisir la formule avant d'ajouter les fichiers, ou ne pas recommencer l'envoi. |
| 4 | **Moyenne** | Mes partages, compteur « Ouvert 0 / 2 » | Après une ouverture, le compteur reste à 0 (et « En cours ») jusqu'à **5 minutes**, même en rechargeant : c'est voulu (spec §33.1, confidentialité), mais **rien ne dit que l'état date**. Léa croit que personne n'a ouvert. | Afficher « État vu à 17 h 02 » et un bouton « Actualiser » (geste de la personne, au plus toutes les 30 s par partage) ; garder la relecture automatique à 5 min. À trancher : c'est un compromis de confidentialité. |
| 5 | **Moyenne** | Inscription, « Je l'ai notée » | Bouton grisé **sans explication** tant qu'on n'a ni copié ni téléchargé la clé. Qui la recopie sur papier est bloqué, ou poussé à la mettre dans le presse-papiers (synchronisé, lu par d'autres applications), alors que l'écran conseille « hors ligne ». | Bouton toujours actif (le groupe retapé ensuite prouve déjà la notation), ou dire « Copiez, téléchargez ou recopiez-la, puis… » et ajouter « Je l'ai recopiée à la main ». |
| 6 | **Moyenne** | Inscription, limite | Après 4 comptes depuis la même connexion : « Trop de tentatives. Réessayez dans 8 h 12. » Ne dit ni ce qui est limité, ni que toute une box (famille, bureau) compte ensemble. | « Trop de comptes créés depuis cette connexion aujourd'hui… », comme le texte de la limite des partages. |
| 7 | **Moyenne** | Compte, Passkeys | Avec deux passkeys sur deux appareils (téléphone, ordinateur) : « **Toutes vos passkeys sont liées à un seul appareil** ». Faux à la lecture (chacune est liée à **son** appareil). | « Chacune de vos passkeys ne marche que sur son appareil. Gardez bien votre clé de récupération. » |
| 8 | **Moyenne** | Session sans « Rester connecté » (défaut) | Un simple rechargement ou une adresse tapée **déconnecte sans prévenir** (vu pendant l'essai : « Sans compte… » affiché alors que Léa venait de créer son compte). | Dire à la connexion ce que coûte l'absence de « Rester connecté » ; ou, après un rechargement, un bandeau « Vous avez été déconnecté : reconnectez-vous ». |
| 9 | Faible | Suppression du compte, première page | Avec un **accès offert** : « Votre abonnement Pro : son renouvellement est arrêté… » (il n'y a pas de renouvellement). La fenêtre suivante, elle, dit juste : « Votre accès offert Pro… s'arrête aujourd'hui ». | Même texte que la fenêtre selon le type (abonnement, paiement unique, accès offert). |
| 10 | Faible | Vocabulaire | « Supprimer ce partage » (expéditeur) / « Détruire ce partage » (destinataire) / « Détruit » / « effacé ». | Un seul verbe pour le même geste (proposition : « Supprimer »). |
| 11 | Faible | Destinataire, texte sous « Ouvrir » | « Ouvrir compte 1 ouverture sur les 2 restantes ; ensuite, revenir depuis ce navigateur n'en compte **en général** pas d'autre » : lecture difficile (« Ouvrir » sans guillemets) et « en général » inquiète. | « « Ouvrir » utilise 1 des 2 ouvertures restantes. Revenir ensuite depuis ce navigateur est gratuit (sauf navigation privée fermée). » |
| 12 | Faible | Options, « Une ouverture = un déverrouillage réussi » | Parle de déverrouillage alors que le mot de passe est désactivé par défaut. | « Une ouverture = une première visite réussie du lien. » |
| 13 | Faible | Texte | « le navigateur intégré **de Instagram** » | « d'Instagram » (élision selon le nom). |
| 14 | Faible | Compte, après une récupération | « créez-en une nouvelle **dans les paramètres** » : la page s'appelle « Compte ». | « …dans Compte, section Clé de récupération ». |
| 15 | Faible | Composeur, SVG | trap.svg rangé dans « Photos », « Image », mais marqué « Programme ou script » ; motif de non-nettoyage différent chez l'expéditeur (« format non pris en charge ») et le destinataire (« structure du fichier inattendue »). | « Image qui peut contenir du code » pour le SVG ; un seul motif. |
| 16 | Faible | « Lien prêt » | Le nom du partage apparaît sous le titre « Échéance ». | Le mettre sous « Lien prêt » (titre). |
| 17 | Faible | Nouvelle clé de récupération | Pendant la création : le bandeau « Cela fait 6 mois… » reste affiché, et la phrase « Elle remplace vos passkeys… » apparaît deux fois. | Masquer le bandeau et le doublon pendant la création. |
| 18 | Faible | Ordinateur ouvert par la clé | La passkey ajoutée ensuite n'est pas marquée « Cette passkey ». | À vérifier (session ouverte par la clé, puis passkey ajoutée). |
| 19 | Suggestion | Inscription, pseudo « Léa » | Refusé (accent) : il faut retaper. | Proposer « Lea » d'un geste. |
| 20 | Suggestion | Composeur | Icônes seules (balai « nettoyer », carte à cadenas) peu parlantes à l'œil (libellés présents pour les lecteurs d'écran). | Libellé visible ou info-bulle. |
| 21 | Suggestion | « Détails » d'une photo | N'affiche que l'empreinte SHA-256. | Dire aussi ce que le nettoyage retirerait (lieu, appareil, date), s'il y en a. |
| 22 | Suggestion | Après « Compte créé » → Continuer | Mène à l'accueil (page de présentation). | Revenir là d'où l'on venait (salon, envoi), sinon « Mes partages ». |
| 23 | Suggestion | Bandeau de maintenance | Dit l'heure et la durée, pas que les envois seront refusés 10 min avant. | Ajouter « Les nouveaux envois seront fermés à partir de 17 h 15. » |

## Pas essayé (à faire à la main ou plus tard)

- Vrai paiement (Stripe, PayPal, NOWPayments) : bacs à sable injoignables d'ici ; offres payantes essayées par un accès offert.
- Vocal et caméra (micro et caméra réels), gros fichiers (plusieurs Go), .zip sur ordinateur (fenêtre « Enregistrer sous » non pilotable), un vrai PDF de plusieurs pages.
- Safari, iPhone réel, vraies passkeys (iCloud, Google), QR « Se connecter avec mon téléphone ».
- Partage qui atteint son échéance pendant la lecture (horloge du serveur non avançable dans cet essai ; couvert par les tests automatiques).
- Le salon (essai à part).

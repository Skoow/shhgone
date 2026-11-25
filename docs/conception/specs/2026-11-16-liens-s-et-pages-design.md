# Liens en « /s » et page d'ouverture séparée (conception courte)

Décisions du 16 novembre, après le lot « pages séparées » (`2026-11-16-pages-separees-design.md`, étape 2).

## Problème

Les liens de partage et de gestion sont à la racine (`https://shhgone.com/#<clé>`, spec §32). La racine est aussi l'accueil. Séparer l'accueil de l'application obligerait donc chaque destinataire à charger l'accueil, puis une redirection : un chargement de plus sur le chemin le plus important, et l'accueil affiché un instant. Et une page d'accueil seule ne peut pas passer à la page d'envoi les fichiers déposés ou choisis (le navigateur ne transmet pas de fichiers d'une page à l'autre sans les écrire en clair sur le disque, ce qui est exclu).

## Décisions

1. **Liens en `/s`** : lien de partage `{origine}{base}s#<K_lien>`, lien de gestion `{origine}{base}s#m<S_gestion>`, lien du QR code `{origine}{base}s#<K_lien>.<mot de passe>`. Le chemin `/s` était déjà réservé aux futurs liens universels des apps (spec §16, D42-20) : une app pourra prendre `/s` sans prendre tout le site.
2. **Deux pages** :
   - `/` (`index.html`) : **accueil et envoi** ensemble (composeur, dépôt direct, sélecteur en un clic), plus « Mes partages », « Téléchargements », compte. L'accueil est **pré-rempli au build** (moteurs de recherche, affichage avant le script).
   - `/s` (`s.html`) : **ouverture et gestion** d'un partage seulement : ni composeur, ni nettoyage des fichiers, ni enregistreur, ni accueil. Plus léger pour le destinataire. Jamais indexée (`noindex`).
3. **Anciens liens `/#…`** : toujours ouverts. La page `/`, avant d'afficher quoi que ce soit, remplace l'adresse par `/s` + le même fragment (`location.replace`, même origine : le fragment ne part jamais au serveur). Le moteur lit les deux formes (`parse_link`), il n'écrit plus que `/s`.

## Format (moteur Rust, apps)

- `share_link`, `manage_link` : un « s » avant le « # ». `parse_link(url, base)` accepte le chemin `base + "s"` (nouveau) et `base` (ancien, avec la tolérance de la barre finale de la démo) ; tout autre chemin reste refusé (`/s/`, `/s/x`, `/ss`…).
- `v2.json` est figé : ses cas `shareLink` et `manageLink` (forme racine) et ses deux cas `parseLink` qui refusaient `…/s#…` sont **remplacés** par `engine/vectors/v3-liens.json`, produit par le moteur Rust et relu. Les autres cas de `v2.json` restent valables tels quels.

## Ce qui ne change pas

Clés, fragments, mot de passe, CSP, SRI, aucune requête de plus vers le serveur, « le serveur ne voit rien ». Le fragment est retiré de l'adresse après lecture (UI §12.1) comme avant.

## Signalements

- **Moyenne, exploitation** : les liens déjà partagés à la racine continuent de marcher par la redirection ; à supprimer seulement par une décision explicite, quand plus aucun ancien lien ne peut être valide (7 jours au plus après la mise en ligne).
- **Faible, confidentialité** : la redirection garde le fragment dans l'historique d'une entrée de plus (`replace` : aucune entrée ajoutée, l'adresse est remplacée), puis l'écran d'ouverture le retire comme avant.
- **Faible, exactitude** : « Rouvrir » de « Mes partages » et les liens de gestion changent de page (navigation complète), comme aujourd'hui pour « Rouvrir » (`location.assign`).

## Décision du 17 novembre : « /s » montré seulement quand il sert

Règle : ne pas afficher `/s` quand on n'en a pas besoin. Le lien partagé garde `/s` (c'est lui qui charge la page d'ouverture). Une fois le lien lu et le « # » retiré, la page `/s` remplace son adresse par l'accueil (`/`, `replaceState`, aucune entrée de plus) : la barre d'adresse montre `shhgone.com/`.

- **Rechargement d'une ouverture déverrouillée** : l'entrée porte la marque d'ouverture (`markReopen`, aucun secret) ; `/` (index.html) la voit avant tout affichage et repart vers `/s` (`location.replace`), où l'écran d'ouverture retrouve l'octroi de l'onglet comme avant (spec §41.4 : rechargement immédiat ; onglet restauré plus de 2 min après : « Lien incomplet »). La clé ne revient jamais dans l'adresse.
- **Écran verrouillé (mot de passe pas encore saisi), gestion** : un rechargement mène à l'accueil, comme avant le 16 novembre (la confirmation du navigateur prévient déjà sur l'écran verrouillé).
- **Navigateur intégré (S4)** : rien n'est retiré, l'adresse garde `/s#…` jusqu'à « Continuer ici ».
- Signalement **faible, exactitude** : au rechargement, `/` charge son script avant de repartir vers `/s` (un aller-retour de plus, seulement dans ce cas).

## Ancienne forme à la racine retirée

Le service n'étant pas lancé, aucun lien à la racine ne peut circuler : la redirection `/#…` → `/s#…` est retirée (point « Moyenne, exploitation » ci-dessus, levé). Le moteur (`parse_link`) et `linkForm` ne lisent plus que `{base}s#…` ; un `#` à la racine donne l'accueil, et l'accueil le retire de l'adresse sans rien envoyer. Vecteurs : `engine/vectors/v4-liens-s.json` (README des vecteurs). Le rechargement d'une ouverture déverrouillée sous « / » (marque `REOPEN_MARK`) repart toujours vers « /s » (`moveToLinkPage`) : ce n'est pas une compatibilité, c'est l'adresse montrée.

**À signaler (faible)** : les invitations de salon prévues (`#c<clé>`, spec salon v3) sont encore écrites à la racine dans les données de test du compte ; à aligner sur `/s` quand le client du salon sera construit.

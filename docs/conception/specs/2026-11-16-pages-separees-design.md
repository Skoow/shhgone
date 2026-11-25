# Pages séparées : une vraie page HTML par page publique (conception courte)

Objectif : une page séparée pour chaque élément du site, pour le référencement et pour le temps de chargement de chaque page.

## Constat (mesuré le 16 novembre)

- Le site est une seule page (`index.html`) et **un seul script** : 712 Ko (226 Ko compressé), plus 205 Ko de styles. Il contient tous les écrans : composeur, envoi, moteur, compte, salon, pages d'information.
- Pour un robot, `/securite`, `/offres`… renvoient la même page vide jusqu'à l'exécution du script ; titre, description et adresse canonique sont posés après coup (`app/seo.ts`).
- **Contrainte de sécurité** (spec §28.3, `check-dist.mjs`) : aucun `import()` dynamique en production, car l'empreinte SRI de la page ne couvrirait pas le code chargé à la demande. Le découpage du code doit donc passer par des **pages distinctes**, chacune avec ses scripts cités par empreinte (`<script>` et `<link rel="modulepreload">` avec `integrity`).

## Approches

1. **Vraies pages HTML par page publique, pré-remplies au build (retenue).** Vite en plusieurs entrées : `index.html` (l'application : accueil, envoi, ouverture, gestion, compte) et une page par page d'information (`securite.html`, `confidentialite.html`, `offres.html`, `conditions.html`, `mentions-legales.html`, `signaler.html`). Chaque page porte son titre, sa description, son adresse canonique et **son contenu déjà écrit** (rendu Svelte côté serveur au moment du build, en français), puis un petit script qui ne contient que la coque et la page. Chaque balise de script garde son empreinte SRI. Robots : contenu lisible sans JavaScript ; visiteurs : page affichée avant le script, et beaucoup moins de code à télécharger.
2. Pré-rendu seul, toujours un seul gros script : bon pour les robots, mais chaque page télécharge encore tout le site. Écartée : ne répond qu'à la moitié de la demande.
3. Chargement à la demande (`import()`) : interdit par §28.3. Écartée.

## Ce qui change

- **Build** (`vite.config.ts`) : entrées multiples ; un greffon génère les pages d'information à partir d'un gabarit (tête de `index.html`, mêmes CSP, polices, icônes) et y insère le HTML rendu par `svelte/server`. L'empreinte SRI est posée sur chaque page.
- **Script des pages d'information** (`src/pages/main.ts`) : monte la coque (`AppShell`, en-tête, menu, pied) et la page demandée (lue dans le chemin) ; ne contient ni composeur, ni moteur de chiffrement, ni compte, ni salon. Le contenu pré-rendu est remplacé au montage (même texte).
- **Navigation** : entre l'application et une page d'information, un lien est une vraie navigation (chargement de la page) ; à l'intérieur de l'application, rien ne change.
- **Serveur** (`server/cmd/shhdrop/static.go`) : un chemin sans extension sert d'abord `chemin.html` s'il existe (200), sinon le repli actuel vers `index.html`. GitHub Pages fait déjà de même (`/securite` → `securite.html`).
- **Contrôles** (`check-dist.mjs`) : SRI vérifiée sur chaque page HTML ; chaque page d'information contient son texte (titre h1) avant tout script ; aucune page d'information ne contient le moteur ni le module de compte.
- **Référencement** : sitemap inchangé (mêmes adresses) ; `seo.ts` garde le même rôle après montage ; la démo reste `noindex`.

## Ce qui ne change pas

- Les pages qui détiennent des clés (ouverture d'un partage, gestion, « Lien prêt ») restent dans l'application, jamais indexées.
- CSP, Trusted Types, aucune ressource tierce, polices locales.
- Les adresses publiques (`/securite`, `/offres`…).

## Étapes

1. Pages d'information séparées et pré-remplies (ce lot), avec mesure du poids avant/après.
2. Ensuite : accueil pré-rempli pour les robots, puis séparer l'accueil (léger) de l'application d'envoi (`/envoyer`, ouverture, gestion).

## Questions laissées au constructeur

- Langue du contenu pré-rendu : français (langue par défaut) ; en anglais, le script remplace le texte au montage.
- Détail des noms de fichiers et de l'organisation du greffon.

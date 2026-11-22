# Analyse d'impact sur la protection des données (AIPD, RGPD article 35)

22 novembre 2026. **Projet à faire relire par l'avocat.** L'AIPD n'est peut-être pas obligatoire (pas de surveillance systématique, pas de données sensibles traitées en clair), mais elle est recommandée pour un service de messagerie et de partage de fichiers ouvert au public.

## 1. Description

Shhgone permet d'envoyer des fichiers et messages chiffrés de bout en bout par un lien avec mot de passe qui s'efface, et de discuter (texte, voix, vidéo) dans des salons temporaires. Le chiffrement se fait sur l'appareil ; le serveur ne garde que du contenu illisible et le minimum pour fonctionner (registre des traitements, T1 à T10).

## 2. Nécessité et proportionnalité

- Minimisation : aucune donnée de contenu, de nom de fichier, de clé ou de mot de passe en clair ; aucune adresse IP sur disque ; dates arrondies ; tout s'efface à l'échéance.
- Durées : la plus courte possible pour chaque traitement (revue du 22 novembre : pare-feu 30 min, sauvegardes 7 jours, clés anti-abus remplacées chaque nuit).
- Information : pages Confidentialité, Conditions, Sécurité ; texte exact de ce qui est gardé.

## 3. Risques pour les personnes

| Risque | Source | Vraisemblance | Gravité | Mesures |
|---|---|---|---|---|
| Lecture d'un contenu par un tiers | piratage du serveur, hébergeur, réquisition | faible | importante | chiffrement de bout en bout : le serveur ne peut rien lire ; clé dans la partie du lien jamais envoyée |
| Identification d'un expéditeur ou d'un destinataire | adresses IP, métadonnées | faible | importante | aucune IP sur disque ; empreintes sous clé effacée chaque nuit ; appels par relais (les participants ne voient pas l'IP des autres) ; aucun journal |
| Lien et mot de passe interceptés | transmission par l'utilisateur | moyenne | importante | conseil d'utiliser deux canaux ; ouvertures limitées ; échéance ; 5 mots de passe faux détruisent le partage |
| Usurpation d'un pseudo dans un salon | membre malveillant | faible | modérée | pseudos uniques par compte ; sosies (I, l, 1 ; O, 0) confondus ; dispute entre anciens membres : aucun ne garde le pseudo ; codes de vérification |
| Contenu illicite diffusé | utilisateur | moyenne | importante | conditions, signalement, destruction immédiate, retrait sur demande des autorités, coopération (DSA, LCEN 6-1) |
| Perte de données de compte | incident | faible | modérée | sauvegarde chiffrée quotidienne, 7 jours |

## 4. Conclusion

Risque résiduel jugé faible au regard des mesures. Point ouvert : conservation des données de connexion (décret 2021-1362, art. 8 ; décret 2025-980) — avis de l'avocat (spécification §17.1).

# Déploiement de Shhdrop

Caddy (TLS) devant le serveur Go, dans Docker. Références : spécification §8, §9.4, §10, §15, §22, §28.7, §30, §36 ; audits du 5 novembre (confidentialité P5 et P6, sécurité F3).

| Fichier | Rôle |
|---|---|
| `Caddyfile` | TLS 1.3, échange de clés hybride, remplacement de `X-Shh-Client-IP`, aucun journal |
| `Dockerfile` | image du serveur : binaire Go statique + site, sur `scratch`, compte 65532 |
| `compose.yaml` | les deux conteneurs (trois avec le compte : relais SMTP), en lecture seule, sans capacité, sans journal |
| `deploy.sh` | installe une version par empreinte, contrôle, revient en arrière ; commandes d'administration |
| `shhcheck/` | petit programme Go : santé du conteneur, test TLS hybride, relais SMTP et contrôle SMTP du compte (§12) ; `salonws_test.go` et `compte_test.go` : essais de banc (tests seulement, hors du binaire) |
| `test-proxy.sh` | test du proxy : le Caddyfile devant le vrai serveur (salon activé), sur la boucle locale |
| `test-sortie.sh` | test de la sortie SMTP : configuration résolue de `compose.yaml`, puis réseau réel avec Docker (§12.1) |
| `compose.yaml` : `relais-stripe`, `relais-paypal`, `relais-nowpayments` | seules sorties du paiement, une par prestataire, paiement activé (§13) |
| `sauvegarder.sh`, `systemd/` | sauvegarde quotidienne chiffrée (age) de `comptes.db` et de `paiements.db`, et son minuteur (§12.4) |
| `restaurer.sh` | vérification mensuelle et restauration d'une sauvegarde (§12.5) |
| `test-restauration.sh` | sauvegarde, effacement, restauration et reconnexion d'un compte de test, puis de `paiements.db` avec un pass factice, en mémoire (§12.5) |
| `env.example` | modèle de `deploy/.env` |

Ce kit réduit les risques ; il ne rend pas le service invulnérable. Les limites sont listées en fin de page.

## 1. Avant d'installer

Chez l'hébergeur et le registraire :

- serveur loué **hors UE** (Suisse ou Islande, §15.1), trafic sortant inclus vérifié, aucun CDN ni proxy devant ;
- instantanés et sauvegardes de la machine **désactivés** chez l'hébergeur, aucun agent de surveillance de l'hébergeur ;
- **aucun outil qui ouvre `shares.db` pendant que le serveur tourne** (seule exception, pour `comptes.db` et non `shares.db` : la sauvegarde quotidienne du compte, §12.4, qui la lit une seconde environ) (sauvegarde à chaud, réplication de type Litestream, `sqlite3` pour « regarder ») : un lecteur d'un autre processus empêche le vidage du journal de la base (`shares.db-wal`), qui garde alors les lignes des partages et des salons déjà effacés. Le tableau de bord d'administration l'affiche (« Vidages de la base ratés ») ; le compte doit rester à 0 (audit adverse du 13 novembre, stockage, F3) ;
- DNS : `A` et `AAAA` vers le serveur ; **DNSSEC** activé ; `CAA 0 issue "letsencrypt.org"` ; double authentification et verrou de transfert (§15.4).

Sur la machine (Linux récent, Docker Engine 25 ou plus avec Compose 2.24 ou plus) :

- **2 processeurs et 2 Gio de mémoire au moins** : `compose.yaml` plafonne le serveur à 1,5 processeur et 1 Gio, Caddy à 1 processeur et 256 Mio (raisons dans le fichier). Avec moins de 2 processeurs, Docker refuse de démarrer le serveur ;

- **disque** : `SHH_STORAGE_MAX` + 1 Gio libres au moins (201 Gio par défaut), sinon le serveur refuse de démarrer ;
- **dimensionnement des salons** : au pire, 2 Go de fichiers × `SHH_SALONS_MAX` (plus leurs conversations) ; le garde-fou `SHH_STORAGE_MAX` protège le disque (au-delà, plus de pièce ni de nouveau salon), et `SHH_SALONS_MAX=50` est conseillé pour un petit serveur. **`SHH_SALONS_MAX` est croisé avec la mémoire au démarrage** : le serveur refuse de démarrer, avec un message qui dit quoi changer, si les journaux des salons (256 Kio par salon au pire) dépasseraient 10 % de `GOMEMLIMIT` (360 salons au plus avec les 900 Mio livrés) ou si la part de trames garantie à chaque salon tomberait sous 1 000 (§11). Les appels disque des conversations ne dépendent plus du nombre de salons ni de connexions : ils ont leurs propres bornes (§11) ;
- **volume chiffré** LUKS2 (AES-256-XTS, Argon2id) pour toutes les données, monté avec **`noatime`** ; la phrase de déverrouillage n'est jamais stockée sur le serveur (§22) ;
- **pas de mémoire d'échange** : `swapoff -a`, ligne retirée de `/etc/fstab` (`deploy.sh` refuse d'installer sinon) ;
- **vidages mémoire coupés** : `kernel.core_pattern=|/bin/false` dans `/etc/sysctl.d/`, en plus de la limite posée sur les conteneurs ;
- **journald en mémoire** : `Storage=volatile` dans `/etc/systemd/journald.conf` (sinon `sshd` et le pare-feu écrivent des adresses sur disque) ; pas de journal des paquets refusés par le pare-feu (`ufw logging off`) ;
- **suivi des connexions du pare-feu raccourci** (22 novembre) : le noyau garde en mémoire, pour chaque connexion vue par le pare-feu, les adresses IP des deux bouts, jusqu'à **5 jours** par défaut pour une connexion TCP établie, même inactive. Dans `/etc/sysctl.d/` : `net.netfilter.nf_conntrack_tcp_timeout_established=1800` (30 min ; nos connexions longues envoient un signe de vie toutes les 25 à 45 s, WebSocket et relais, elles ne sont pas coupées). Vérifier : `sysctl net.netfilter.nf_conntrack_tcp_timeout_established` ;
- **heure** synchronisée (NTP : `timedatectl set-ntp true`) ;
- **mises à jour de sécurité automatiques**, sans redémarrage automatique de la machine (`unattended-upgrades`, `Automatic-Reboot "false"`, §22) ;
- compte par e-mail seulement (§12) : paquets `sqlite3` et `age` (version exacte, notée dans `deploy/.env`), `curl` ;
- **SSH par clé seulement** (`PasswordAuthentication no`), **pare-feu** : 22, 80 et 443 en TCP, **443 en UDP** (HTTP/3, QUIC, décision du 13 novembre), et les ports du relais des appels (3478 en UDP et TCP, 49160 à 49999 en UDP : `deploy.sh` les ouvre lui-même avec ufw, §14), rien d'autre. Avec ufw : `ufw allow 22/tcp`, `ufw allow 80/tcp`, `ufw allow 443/tcp`, `ufw allow 443/udp`. Sans l'ouverture UDP, les navigateurs restent en HTTP/2 (rien ne casse). Tampons UDP conseillés par la bibliothèque QUIC de Caddy, dans `/etc/sysctl.d/` : `net.core.rmem_max=7500000` et `net.core.wmem_max=7500000` (sinon HTTP/3 marche, plus lentement).

## 2. Première installation

```sh
# Volume chiffré (exemple : /dev/sdb ; à adapter). La phrase est demandée au clavier.
cryptsetup luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 --pbkdf argon2id /dev/sdb
cryptsetup open /dev/sdb shhdrop
mkfs.ext4 /dev/mapper/shhdrop
mkdir -p /srv/shhdrop
mount -o noatime,nodev,nosuid,noexec /dev/mapper/shhdrop /srv/shhdrop

# Dossiers attendus par compose.yaml (jamais créés par Docker). secrets/ : exigé même compte
# désactivé (vide), monté en lecture seule dans le serveur (§12.2).
install -d -o 65532 -g 65532 -m 0700 /srv/shhdrop/data
install -d -o root -g root -m 0700 /srv/shhdrop/caddy
install -d -o root -g 65532 -m 0750 /srv/shhdrop/secrets

# Réglages, puis installation d'une version (empreinte de l'image, voir §3).
cp deploy/env.example deploy/.env && editor deploy/.env
deploy/deploy.sh sha256:<empreinte>
```

Ne pas inscrire le volume dans `/etc/fstab` ni `/etc/crypttab` avec une clé : il se déverrouille à la main (§5).

**Machine déjà installée avant le lot 8 du compte** : créer `secrets/` (dernière ligne ci-dessus) avant le prochain `deploy.sh`, qui refuse sinon.

## 3. Mise à jour et retour arrière

L'image est construite ailleurs que sur le serveur, depuis un commit précis, puis publiée dans le registre choisi (`SHH_IMAGE_REPO`) :

```sh
c=$(git rev-parse --short=7 HEAD)
docker build -f deploy/Dockerfile --build-arg SHH_BUILD_ID="$c" -t <registre>/shhdrop:"$c" . && docker push <registre>/shhdrop:"$c"
# « digest: sha256:… » affiché par push : c'est l'empreinte à donner à deploy.sh.
```

`SHH_BUILD_ID` est obligatoire (le build s'arrête sans lui) : c'est le numéro de version affiché par le site, et il doit être celui du commit pour que le site de l'image soit, octet pour octet, celui des builds de la CI (job `repro-docker`, spec §28). Construire depuis un arbre propre (`git status` vide) : des modifications non commitées entreraient dans l'image sous ce numéro.

Vérification du site servi, à faire à la main depuis un autre poste tant que la provenance signée n'existe pas (§9) : construire le site du même commit (`cd web && npm ci --ignore-scripts && npm run build`), en tirer le manifeste (`node scripts/release-manifest.mjs dist --name shhdrop-web --version 0.0.0 --commit "$c" --out /tmp/rel`), puis `node scripts/verify-site.mjs https://<site> /tmp/rel/release.json`.

Sur le serveur :

```sh
git pull                              # Caddyfile, compose.yaml, deploy.sh à jour
deploy/deploy.sh sha256:<empreinte>   # installe, contrôle, revient en arrière si le contrôle échoue
deploy/deploy.sh status               # version en service, version précédente, conteneurs
deploy/deploy.sh rollback             # réinstalle la version précédente
```

Contrôle fait par `deploy.sh`, sans option pour le sauter : conteneur en bonne santé (`/healthz` local) ; `https://<site>/api/captcha` répond 200 à travers Caddy ; page d'accueil avec HSTS ; poignée de main TLS 1.3 limitée à `X25519MLKEM768` (test bloquant de la §30).

À savoir :

- **chaque redémarrage du serveur efface les envois en cours et les partages en cours de lecture** (les jetons ne survivent pas, §36 S12). Relancer `deploy.sh` avec la même empreinte ne redémarre rien ;
- le retour arrière ne concerne que l'image. Pour ramener `Caddyfile` ou `compose.yaml` en arrière : `git checkout <commit> -- deploy/`, puis `deploy.sh` ;
- si le serveur refuse de démarrer, son message n'est écrit nulle part (aucun journal). Pour le lire : `deploy/deploy.sh diagnose`.

## 4. Commandes d'administration (§15.3)

Elles s'exécutent dans le conteneur en marche. Codes de sortie : 0 réussite, 1 échec, 2 erreur d'usage.

```sh
deploy/deploy.sh admin freeze        # suspend les nouveaux envois
deploy/deploy.sh admin unfreeze      # les rétablit
deploy/deploy.sh admin destroy -     # signalement : coller le lien, Entrée, puis Ctrl-D
deploy/deploy.sh admin wipe --yes    # urgence : gèle, puis efface tous les partages
```

Le lien signalé ne se donne **jamais** en argument (il irait dans l'historique du shell) : toujours sur l'entrée standard.

### Détruire un lien depuis un téléphone (signalement, demande d'une autorité)

La destruction est **immédiate** : plus aucune ouverture, téléchargements en cours coupés, aucun délai de grâce (partage ou salon `#c…`). Délais légaux à tenir : **24 h** pour une demande de retrait de la police (LCEN art. 6-1 : contenus pédocriminels ou terroristes), **1 h** pour une injonction de retrait de contenu terroriste (règlement (UE) 2021/784, art. 3, si le service y est soumis). Les demandes arrivent à `contact@shhgone.com` : notification activée sur le téléphone.

1. Une application SSH sur le téléphone (par exemple Termius ou Blink), avec **la même clé SSH** que le poste (jamais de mot de passe, §1).
2. Se connecter à la machine, puis :
   ```sh
   cd /chemin/vers/shhgone && deploy/deploy.sh admin destroy -
   ```
3. Coller le lien entier (avec ce qui suit le `#`), Entrée, puis Ctrl-D. Réponse attendue : `partage` ou `salon` ; « introuvable » si le lien est déjà effacé.
4. Répondre à l'expéditeur du signalement (accusé de réception, décision, recours ; DSA art. 16) ; pour une injonction, prévenir l'autorité de l'heure du retrait (règlement 2021/784, art. 3.6, modèle de son annexe II).

### Tableau de bord d'administration (désactivé par défaut)

Une page qui réunit l'état du serveur (santé, stockage, mémoire, places, partages et salons vivants : des nombres seulement, jamais un identifiant, une adresse ni un contenu) et trois commandes : geler, dégeler, détruire un lien signalé. `wipe` n'y est pas, volontairement : il reste en ligne de commande. Conception : `docs/superpowers/specs/2026-11-13-tableau-de-bord-admin-design.md`.

Elle est servie par un **écouteur à part**, jamais par Caddy, jamais sur le port public. Sans `SHH_ADMIN_LISTEN`, elle n'existe pas.

Pour l'activer (changement de `compose.yaml`, à relire et commiter comme les autres) :

1. **Sur son poste** (pas sur le serveur), tirer un jeton et calculer son empreinte SHA-256 :

   ```sh
   JETON=$(openssl rand -hex 32)
   printf '%s\n' "$JETON"                       # à garder dans son gestionnaire de mots de passe
   printf '%s' "$JETON" | sha256sum | cut -c1-64  # l'empreinte : 64 chiffres hexadécimaux
   unset JETON
   ```

   Mettre **l'empreinte seule** dans `deploy/.env` du serveur : `SHH_ADMIN_TOKEN_SHA256=<les 64 chiffres>`. Le jeton lui-même ne va jamais sur le serveur : ni dans `deploy/.env`, ni dans la configuration du conteneur (`docker inspect`), ni dans l'environnement du processus. Le serveur ne compare que des empreintes ; une empreinte ne permet pas de retrouver le jeton (audit adverse du 13 novembre, 3e campagne : tableau de bord F5, stockage F3). `printf '%s'`, sans retour à la ligne : avec `echo`, l'empreinte serait celle du jeton suivi d'un saut de ligne, et la page refuserait le jeton.
2. Dans `compose.yaml`, service `shhdrop`, section `environment` :

   ```yaml
   SHH_ADMIN_LISTEN: 172.30.53.2:9191
   SHH_ADMIN_TOKEN_SHA256: ${SHH_ADMIN_TOKEN_SHA256:?SHH_ADMIN_TOKEN_SHA256 manquant}
   ```

   `172.30.53.2` est l'adresse du conteneur sur le réseau interne : seule la machine peut la joindre (aucun port publié, aucune route depuis Internet). Le serveur ne répond qu'à la boucle locale et à `SHH_TRUSTED_PROXY` (la machine), et seulement sous les noms `localhost`, `127.0.0.1` ou `172.30.53.2` (en-tête `Host`, n'importe quel port) : un autre nom reçoit la même réponse qu'une route inconnue (protection contre le « DNS rebinding » et contre une ligne de Caddy qui relaierait le nom public vers ce port).
3. `deploy/deploy.sh` relance le conteneur. Depuis son poste : `ssh -L 127.0.0.1:9191:172.30.53.2:9191 <machine>`, puis ouvrir `http://127.0.0.1:9191` et coller le jeton. `127.0.0.1` et non `localhost` : si `[::1]:9191` est déjà pris sur le poste, `ssh` n'ouvre que l'IPv4 et un navigateur qui essaie `::1` d'abord enverrait le jeton à l'autre programme.

**Variable refusée en production.** `SHH_ADMIN_TOKEN` (le jeton en clair) n'est accepté que pour le développement local (sans `SHH_BEHIND_PROXY`). Derrière le proxy déclaré, sa seule présence empêche le serveur de démarrer, tableau de bord activé ou non, avec un message qui donne la commande ci-dessus ; `shhdrop admin` refuse aussi (même configuration). Les deux variables ensemble : refusé. Une empreinte mal formée (pas 64 chiffres hexadécimaux en minuscules, ou celle d'un jeton vide) : refusé, sans afficher la valeur. Si l'écouteur d'administration ne s'ouvre pas (port pris), le site public démarre quand même. Contrepartie : le serveur ne peut plus vérifier la qualité du jeton (une empreinte ne dit rien de ce qu'elle résume) ; c'est la commande de tirage qui la garantit : n'en employer aucune autre.

Le jeton reste dans la mémoire de l'onglet, jamais dans le stockage du navigateur : il se redemande après un rechargement. La page l'oublie et revient à la saisie dès qu'une lecture de l'état est refusée (le serveur ne le reconnaît pas : redémarré avec une autre empreinte, ou autre programme sur le port) ou reste sans réponse trois fois de suite (tunnel coupé), et quand l'onglet est fermé : sinon elle le renverrait toutes les 5 s à quiconque répond ensuite sur ce port.

**Essais de jetons faux** : chaque jeton faux retarde de 250 ms toutes les réponses du tableau de bord, bonnes ou fausses (délai global, rien n'est gardé par adresse), jusqu'à 2 s au plus. Une suite d'essais sur une connexion est donc ralentie à 4 par seconde au plus ; des connexions simultanées en font plus (au plus une par connexion toutes les 2 s) : c'est un frein, pas un verrou, et le jeton de 256 bits reste la vraie protection. L'exploitant n'est jamais refusé : pendant une attaque, chaque lecture lui prend au plus 2 s.

À savoir : tout compte local de la machine peut joindre le port ; le jeton est alors la seule barrière. La mémoire du serveur garde, le temps que le ramasse-miettes la récrive, la copie des en-têtes des dernières requêtes du tableau de bord, jeton compris, et le lien collé dans « Détruire » dans le tampon de lecture de la connexion (le serveur n'en garde lui-même aucune copie : il le traite en octets et efface les siens). Changer le jeton = en tirer un autre, changer l'empreinte dans `deploy/.env` et relancer.

## 5. Après un redémarrage de la machine

Le site reste hors service tant que le volume n'est pas déverrouillé (les conteneurs ne démarrent pas sans lui) :

```sh
cryptsetup open /dev/sdb shhdrop
mount -o noatime,nodev,nosuid,noexec /dev/mapper/shhdrop /srv/shhdrop
deploy/deploy.sh "$(cat deploy/.release)"
```

## 6. Plan d'incident (§15.5)

En cas de doute sur la sécurité du serveur ou du code :

1. `deploy/deploy.sh admin freeze`, puis `deploy/deploy.sh admin wipe --yes` si nécessaire.
2. Changer les accès : clés SSH, GitHub, registraire, registre d'images.
3. Réinstaller le serveur depuis zéro (nouvelle machine, nouveau volume chiffré, §1 et §2). Ne pas reprendre `/srv/shhdrop/caddy` : nouvelles clés TLS, et révoquer les anciens certificats. Compte activé : la **clé du serveur** (§12.2) est à tenir pour connue de l'attaquant, avec `comptes.db` (profils séquestrés lisibles, adresses testables une à une) ; elle ne peut pas être changée sans perdre tous les comptes (conception §5.2) : décision du propriétaire, à prendre avant de reprendre la base ; changer aussi le mot de passe SMTP et l'accès au stockage des sauvegardes.
4. Publier un avis sur le site.

## 7. Vérifications après chaque mise en ligne

Depuis un autre poste (`D=shhgone.com`) :

```sh
# 1. En-têtes du serveur Go, une seule fois chacun : 8 lignes attendues.
curl -sSI https://$D/ | grep -iE '^(content-security-policy|strict-transport-security|referrer-policy|x-content-type-options|permissions-policy|cross-origin-opener-policy|cross-origin-resource-policy|cache-control):' | sort | uniq -c

# 2. X-Shh-Client-IP ne se contrefait pas.
#    a) valeur invalide : 200 attendu (Caddy l'a remplacée ; transmise telle quelle, le serveur répondrait 500).
curl -sS -o /dev/null -w '%{http_code}\n' -H 'X-Shh-Client-IP: pas-une-adresse' https://$D/api/captcha
#    b) 130 requêtes avec 130 adresses annoncées : des 429 doivent apparaître (60 requêtes par minute et par adresse réelle).
for i in $(seq 1 130); do curl -sS -o /dev/null -w '%{http_code}\n' -H "X-Shh-Client-IP: 1.2.3.$i" https://$D/api/shares/meta; done | sort | uniq -c

# 3. /healthz n'est pas exposé : 404 attendu.
curl -sS -o /dev/null -w '%{http_code}\n' https://$D/healthz

# 4. TLS : échange de clés hybride (OpenSSL 3.5 ou plus), TLS 1.2 refusé, HTTP redirigé (308).
openssl s_client -connect $D:443 -servername $D -groups X25519MLKEM768 </dev/null 2>/dev/null | grep -iE 'group|protocol'
curl -sS --tls-max 1.2 -o /dev/null https://$D/ ; echo "code de sortie $? (attendu : non nul)"
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://$D/

# 5. DNS.
dig +short CAA $D ; dig +dnssec +short $D | head -n 2
```

Sur le serveur, après avoir visité le site depuis une adresse connue (`MOI=<votre adresse IP>`) :

```sh
# 6. Aucun journal de conteneur, aucune adresse sur disque (rien ne doit s'afficher après « none none »).
docker inspect -f '{{.HostConfig.LogConfig.Type}}' shhdrop-shhdrop-1 shhdrop-caddy-1 | xargs
find /var/lib/docker/containers -name '*-json.log' -size +0
ls /var/log/journal 2>/dev/null
grep -rlaF "$MOI" /var/lib/docker /var/log /srv/shhdrop 2>/dev/null

# 7. Volume : noatime, pas de mémoire d'échange (rien ne doit s'afficher pour swapon).
findmnt -no OPTIONS -T /srv/shhdrop | tr ',' '\n' | grep -x noatime
swapon --show

# 8. Dates des fichiers chiffrés, après avoir créé puis ouvert un partage : accès et
#    modification au 1er janvier 1970.
stat -c '%x | %y | %n' /srv/shhdrop/data/blobs/*
ls -la --time-style=long-iso /srv/shhdrop/data
```

Si le test 4 ne peut pas être fait avec OpenSSL (version trop ancienne), le même contrôle par `shhcheck`, sur le serveur :

```sh
docker run --rm --network host --log-driver none -v /etc/ssl/certs/ca-certificates.crt:/ca.pem:ro -e SSL_CERT_FILE=/ca.pem \
  --entrypoint /shhcheck "$SHH_IMAGE_REPO@$(cat deploy/.release)" tls 127.0.0.1:443 $D    # « TLS 1.3, X25519MLKEM768 »
```

## 8. Tester le kit

```sh
CADDY=/chemin/vers/caddy deploy/test-proxy.sh     # Caddy 2.10 ou plus, curl 7.83 ou plus, Go, web/dist construit (≈ 2 min 30 : WebSocket gardé 75 s)
make lint-deploy                                  # bash -n, ShellCheck, go vet et tests unitaires de shhcheck (relais SMTP)
SHH_IMAGE=shhdrop:ci make test-sortie             # sortie SMTP : configuration, puis réseau réel (démon Docker ; code 3 sans démon)
sudo make test-restauration                       # sauvegarde et restauration d'un compte de test, en mémoire (≈ 45 s)
```

Le binaire Caddy à donner est celui de l'image épinglée par empreinte dans `compose.yaml` : `docker create` de cette image puis `docker cp …:/usr/bin/caddy` (ce que fait la CI), ou, sans démon Docker, l'index de l'image, son manifeste linux/amd64 et ses couches lus dans le registre, chacun contrôlé par son empreinte SHA-256 avant d'extraire `/usr/bin/caddy`. L'essai long du WebSocket du salon (condition d'activation, §10) : `SALON_GARDE=660` (≈ 14 min en tout).

La CI fait les deux à chaque push : `deploy-lint` (ShellCheck 0.11.0 épinglé), et `repro-docker`, qui construit l'image complète puis lance `test-proxy.sh` avec ses binaires, son site et le Caddy de l'image épinglée dans `compose.yaml`.

`test-proxy.sh` est à relancer à chaque changement du `Caddyfile` ou de version de Caddy : c'est le seul test de la ligne dont dépendent les quotas et l'anti-robot (audit F3).

### Vérification de sécurité hebdomadaire

`.github/workflows/securite.yml` tourne chaque lundi à 04:17 UTC et à la demande (onglet Actions, « Run workflow »). Trois jobs : `govulncheck ./...` (server/), `npm audit --omit=dev --audit-level=moderate` (web/, plus un audit complet informatif qui ne fait pas échouer) et `cargo audit --deny warnings` (engine/, mêmes exceptions que la CI : `engine/.cargo/audit.toml`). Aucun secret.

Un job rouge = une faille connue : GitHub envoie un e-mail d'échec au propriétaire (vérifier que les notifications Actions sont actives pour le dépôt). Pas d'issue automatique. Marche à suivre : lire le journal du job, mettre la dépendance à jour (tests), ou noter l'exception et sa date de réexamen (jamais d'ignore silencieux). Si GitHub n'a lancé aucune exécution pendant 60 jours sans activité sur le dépôt, il désactive les workflows planifiés : les réactiver dans l'onglet Actions.

## 9. Ce que ce kit ne fait pas

- **Démarches légales (§17)** : avis d'un juriste sur la conservation des données d'identification (LCEN, décret 2021-1362, en conflit avec « aucune adresse IP enregistrée »), point de contact DSA, déclaration ANSSI, mentions légales, CGU. Rien n'ouvre au public avant.
- **Provenance du code (§28.7)** : `web/scripts/release-manifest.mjs` et `verify-site.mjs` existent, et la CI prouve que le site de l'image est celui de ses builds (`repro-docker`), mais il n'y a ni `release.yml`, ni signature `cosign` de l'image ou d'un `release.json`, ni registre choisi. `deploy.sh` installe donc l'empreinte qu'on lui donne, sans rien vérifier de sa provenance, et le rappelle à chaque fois ; `verify-site.mjs` se lance à la main (§3).
- **Surveillance (§15.2)** : ni sonde externe (site injoignable, **date de fin du certificat** : Caddy ne journalise rien, un renouvellement raté ne se voit pas autrement), ni script horaire d'alerte (disque à 80 %, signalements). Pour ce script : `df` pour le disque ; `docker exec shhdrop-shhdrop-1 /shhcheck health` affiche `reports_alert`.
- **Déverrouillage (§22)** : pas de `deploy/unlock.sh` ; les trois commandes du §5 en tiennent lieu. Pas d'alerte « redémarrage nécessaire ».
- **Dates et tailles des fichiers** (audit adverse du 13 novembre, stockage, F4). Les dates de contenu et d'accès sont au 1er janvier 1970 ; la date de changement d'inode (`ctime`) de tous les fichiers est ramenée, une fois par minute, à l'heure de ce passage. Restent lisibles par qui lit le disque déverrouillé : la **date de création** (`btime`, sur ext4) de chaque fichier de partage, de pièce et de conversation, qu'aucun appel système ne permet de changer, donc l'heure de création de chaque partage vivant et du premier message de chaque salon ; pendant une minute au plus, le `ctime` d'un fichier qui vient d'être écrit ; la taille d'une conversation, par paliers de 64 messages (plus le nombre exact) ; l'ordre de création (numéros d'inode). Le dossier de données lui-même, `frozen`, `kill/`, `kill.key`, `shares.db`, `shares.db-wal` et `shares.db-shm` ont, depuis la 3ᵉ campagne de l'audit adverse (stockage, F5), leurs dates de contenu et d'accès remises à l'epoch à chaque passage du janitor (une fois par minute) et leur `ctime` ramené à l'heure de ce passage : l'heure du dernier gel, dégel, destruction par l'administrateur ou écriture en base ne se lit plus qu'à la minute près ; un gel et un dégel remettent aussi les dates aussitôt. Restent : la **date de création de `frozen`**, qui donne l'heure du gel en cours tant qu'il dure, et celle de `kill/`, créé au premier passage du serveur (heure du démarrage, sans rapport avec une destruction). Seuls le volume chiffré et l'absence d'instantanés les protègent.
- **Sauvegardes** : aucune pour les partages et les salons, et c'est voulu. La spécification les interdit pour les données (§9.2 : « aucune sauvegarde de ce dossier ») : des partages chiffrés qui vivent 24 h n'ont rien à restaurer, et une sauvegarde garderait ce qui doit disparaître. **Seules exceptions : `comptes.db` (compte activé) et `paiements.db` (paiement activé)**, chiffrées chaque jour (§12.4 ; conception du compte §21.13, décision du propriétaire du 14 novembre ; conception du paiement §5.1, S11 : perdre `paiements.db` rendrait inutilisables les pass payés). À sauvegarder ailleurs que sur le serveur : `deploy/.env` et la phrase du volume, plus, compte activé, la **clé du serveur** (§12.2), chacun à part. `deploy/.env` ne contient aucun secret qui ouvre quoi que ce soit : avec le tableau de bord, seulement l'**empreinte** du jeton (§4), qui ne permet pas de le retrouver ; le jeton lui-même se garde dans le gestionnaire de mots de passe de l'exploitant, jamais avec cette sauvegarde. Un `SHH_ADMIN_TOKEN` en clair n'y a pas sa place (le serveur refuse de démarrer avec lui, §4). Le dossier `caddy/` se recrée seul (nouveau certificat).
- **Durcissement de la machine** : les réglages du §1 (journald, pare-feu, SSH, mises à jour) sont à faire à la main ; aucun script ne les pose ni ne les vérifie, sauf `noatime` et la mémoire d'échange, contrôlés par `deploy.sh`.
- **Hébergeur** : il voit les adresses IP et peut lire la mémoire de la machine. Hors de portée (§18.3).
- **Caddy tourne en root dans son conteneur** (audit du 13 novembre, D9 ; non corrigé, décision à prendre). Il n'a aucune capacité sauf `NET_BIND_SERVICE` (écouter sur 80 et 443), sous `no-new-privileges`, avec un système de fichiers en lecture seule. Le passer en `user: "65532:65532"` ne marche pas avec l'image officielle épinglée : son binaire porte la capacité de fichier `cap_net_bind_service=+p` (lu dans la couche `sha256:5000c332…` de `caddy:2.11.9` : attribut `security.capability`, bit « effectif » absent), et `no-new-privileges` fait de toute façon ignorer les capacités de fichier. Un Caddy non root ne pourrait donc pas écouter sur 443. Deux voies, à choisir : (a) `sysctl net.ipv4.ip_unprivileged_port_start=80` sur la machine (réglage global : tout processus de la machine pourrait alors prendre 80 ou 443 pendant un redémarrage de Caddy ; `network_mode: host` interdit de le poser pour le seul conteneur), puis `user: "65532:65532"` et le dossier `caddy/` donné à 65532 ; (b) garder root, comme aujourd'hui.
- **Confiance accordée à `X-Shh-Client-IP`** : le serveur Go croit cet en-tête, qui donne l'adresse du client pour les limites, de la seule passerelle `172.30.53.1/32` (`SHH_TRUSTED_PROXY`, `compose.yaml`), c'est-à-dire de la machine où Caddy écoute. **Tout processus de la machine** peut donc joindre `172.30.53.2:8080` et annoncer l'adresse qu'il veut : il contourne toutes les limites par adresse (quotas, places, salons). C'est accepté : la machine ne doit faire tourner que `sshd`, Docker, Caddy et le serveur, et un accès à la machine donne déjà bien plus (mémoire, volume déverrouillé). Caddy, lui, remplace toujours l'en-tête par l'adresse du pair TCP (`header_up X-Shh-Client-IP {remote_host}`, contrôlé par `test-proxy.sh`) ; un pair qui n'est pas la passerelle reçoit 500 (échec fermé).
- **Envoi complet à travers Caddy** : `test-proxy.sh` prouve le relais (`/api/captcha`, corps d'un segment, en-têtes, octets), pas la création puis l'ouverture d'un partage par un navigateur. À faire à la main après la première installation (tests manuels de la §14).
- **WebSocket du salon** : `test-proxy.sh` le garde ouvert 75 s à travers Caddy, en HTTP/1.1. Un WebSocket par HTTP/2 (RFC 8441, que certains navigateurs emploient) n'est pas essayé, et l'essai court ne dépasse pas les délais de Caddy : la première coupure possible est à **5 min** (`read_body 5m`). L'essai long se lance avec `SALON_GARDE=660`. Conditions bloquantes d'activation : §10.

## 10. Salon (désactivé)

Le salon (spécification §39 et `docs/superpowers/specs/2026-11-11-salon-v3-design.md`) est **activé** depuis la décision du propriétaire du 19 novembre (le compte, ouvert le même jour, l'exige) : `compose.yaml` pose `SHH_SALONS: "1"`. **Risque assumé par le propriétaire** : l'avis du juriste sur l'hébergement des conversations chiffrées (Q-SAL8, §39.7) n'a pas été demandé (`docs/ouverture-comptes.md`). Le couper : `SHH_SALONS: "0"` (et `SHH_COMPTES: "0"`, qui l'exige). Avec `SHH_SALONS=0`, aucune route `/api/salons/*` n'existe (même réponse 404 qu'une route inconnue).

Variables :

| Variable | Valeur | Rôle |
|---|---|---|
| `SHH_SALONS` | `0` (défaut) ou `1` | active les routes du salon et son WebSocket |
| `SHH_ORIGIN` | `https://${SHH_DOMAIN}` (posée par `compose.yaml`) | origine publique du site, comparée **exactement** à l'en-tête `Origin` du WebSocket et copiée dans la CSP (`connect-src … wss://hôte`). Obligatoire avec `SHH_SALONS=1`. Forme exigée : `https://hôte[:port]` en minuscules, sans chemin ni barre finale, port par défaut omis ; `http://` seulement pour `localhost` ou `127.0.0.0/8` ; IPv6 refusé, `http://[::1]` compris (la CSP ne l'accepte pas) |
| `SHH_SALONS_MAX` | 1 à 10 000, défaut 200 | salons vivants au plus ; **50 proposé pour un usage personnel** (`deploy/.env`) |

À savoir avant d'activer :

- **Conditions bloquantes d'activation** (sans elles, `SHH_SALONS` reste à `0`) : (1) l'avis du juriste (Q-SAL8) ; (2) un **essai long** du WebSocket à travers Caddy, au-delà de la première coupure possible à 5 min (`read_body 5m`) : `SALON_GARDE=660 CADDY=… make test-proxy`, réussi avec le Caddy de l'image épinglée ; (3) un **essai dans WebKit et dans Chromium à travers Caddy en HTTP/2**, mise à niveau par la RFC 8441 comprise (parcours du salon de C-3). Spec v3 §3.6.1, exigence C-3 21.

- **`SHH_ORIGIN` est vérifiée même salon coupé** : une valeur refusée empêche le serveur de démarrer **et** fait échouer `shhdrop admin` (`deploy.sh admin …`), qui lit la même configuration. Corriger `SHH_DOMAIN` (minuscules) d'abord.
- **Schéma de base 2 sans retour arrière** : le premier démarrage d'une version qui contient le salon ajoute les tables `salons` et `salon_pieces` (schéma 2), **même avec `SHH_SALONS=0`**. Une image plus ancienne refuse ensuite cette base : `deploy.sh rollback` vers une version d'avant le salon ne marche plus sans effacer la base (`admin wipe --yes`, partages perdus). Le schéma 2 n'a jamais été publié avant sa forme finale (colonne `rotation_r` comprise) : une base de développement créée par une version intermédiaire est à effacer, pas à reprendre.
- **Disque** : une conversation est écrite chiffrée sur le disque (`data/salons/`, seconde couche AES-256-GCM dont la clé ne vit qu'en mémoire), les pièces dans `data/salon-pieces/`. Une création de salon exige 2 Gio libres sous `SHH_STORAGE_MAX` (sinon 503) ; au pire environ 1,2 Go de conversation et 3,5 Go de vocaux par salon (plan C-2, point 10) : `SHH_STORAGE_MAX` reste la vraie protection du disque.
- **À la fin d'un salon, la clé de la seconde couche est oubliée** (plus référencée par le serveur, tableau mis à zéro), **pas effacée de la mémoire** au sens strict : Go ne permet pas d'effacer la clé étendue gardée par AES ni d'éventuelles copies du ramasse-miettes. Elle n'est jamais écrite sur disque ; elle disparaît au plus tard à l'arrêt du processus.
- **Un redémarrage du serveur** rend toutes les conversations illisibles : au démarrage, les fichiers de conversation et toutes les pièces sont effacés ; les salons restent (lien et mot de passe valables), les membres reviennent par `rejoindre`.
- **Le redémarrage ou la recréation du conteneur Caddy (après un changement du `Caddyfile` ; `caddy reload` n'est pas possible, l'API d'administration étant coupée, `admin off`) et toute mise à jour du serveur coupent les WebSocket ouverts.** Les pages du salon se reconnectent d'elles-mêmes (reconnexion automatique, avec rattrapage des messages manqués ; exigence du client C-3) ; rien n'est perdu côté serveur tant que le serveur Go ne redémarre pas.
- **Caddy garde l'en-tête `Origin`** et laisse passer la mise à niveau WebSocket (§36 S2) : `test-proxy.sh` (section 7) le prouve, et une ligne `header_up -Origin` ferait échouer le test.
- **Signalements** : « Quitter et signaler » (`POST /api/salons/signaler`) et « Détruire et signaler » comptent dans le même entier horaire que les partages (`reports_alert` de `shhcheck health`). `admin destroy -` accepte aussi un lien de salon `#c…`.
- **Paniques de l'entretien** : une panique dans la passe d'entretien du salon (chaque seconde) est récupérée sans aucune sortie (ni journal ni stderr : un message pourrait citer un identifiant), et l'entretien repart à la seconde suivante. Elles ne sont comptées que dans un entier en mémoire (`Manager.PaniquesTick`, sans identifiant), lu par les tests ; `shhdrop admin`, qui tourne hors du serveur, ne le voit pas, et `/api/health` ne l'expose pas (relecture C-2, N7). Symptôme à surveiller à la place : des salons échus qui ne disparaissent pas.
- **Adresses IP** : le serveur n'en garde aucune pour le salon ; seules les limites en mémoire en tiennent compte (empreintes HMAC à clé du jour ou du processus, jamais l'adresse ; §9.5).

## 11. Capacité du serveur

Aucune limite de capacité n'est fixée en dur (décision du propriétaire du 13 novembre) : chaque valeur se règle dans `deploy/.env` ; laissée vide, elle est **calculée au démarrage** d'après `GOMEMLIMIT` (`compose.yaml`) et la limite de descripteurs (`ulimits.nofile`, 65 536 dans `compose.yaml`). Les limites anti-abus **par personne** (créations, octets par jour, places par connexion et par /48, requêtes par minute) ne changent pas et ne se règlent pas ici.

| Variable | Rôle | Valeur calculée | Avec `compose.yaml` (900 Mio, 65 536) |
|---|---|---|---|
| `SHH_UPLOADS_MAX` | envois de segments simultanés (partages et pièces) | 30 % de `GOMEMLIMIT` ÷ 4 Mio (corps gardé en mémoire), au moins 8 ; 64 sans `GOMEMLIMIT` | 67 |
| `SHH_DOWNLOADS_MAX` | lectures de segments simultanées | 10 % de `GOMEMLIMIT` ÷ 256 Kio (tampon), au moins 16 ; 256 sans `GOMEMLIMIT` | 360 |
| `SHH_WATCH_MAX` | surveillances tenues (`/api/shares/watch`) | autant que de lectures | 360 |
| `SHH_WS_MAX` | WebSocket du salon ouverts | 10 % de `GOMEMLIMIT` ÷ 64 Kio (un lot de rattrapage tenu par un client qui ne lit plus, et la marge de la connexion), au moins 16, au plus 2 000 ; 2 000 sans `GOMEMLIMIT`. Une valeur réglée au-delà de ce budget empêche le serveur de démarrer (message `SHH_WS_MAX=… : … au plus …`) | 1 440 |
| `SHH_SALON_FRAMES_MAX` | trames non volatiles rangées au plus par salon ; au-delà, `0x0C` « Le salon est plein » pour ce salon seulement | 100 000 (≈ 417 Mo de disque, 2,4 Mio de mémoire) | 100 000 |
| `SHH_SALON_FRAMES_TOTAL` | trames non volatiles rangées au plus **en mémoire, tous salons confondus** ; au-delà, `0x0C` quel que soit le salon. Vrai garde-fou de la mémoire du salon (audit adverse du 13 novembre) | 10 % de `GOMEMLIMIT` ÷ 48 o la trame, au moins 1 000 ; 1 000 000 sans `GOMEMLIMIT` | ≈ 1 966 080 |
| `SHH_DISK_OPS_MAX` | appels système de fichiers simultanés (partages et pièces) ; au-delà, ils attendent leur tour. Les fichiers de conversation du salon ont deux bornes à part, chacune du quart de cette valeur : une pour les écritures, une pour les lectures | 64 (conversations : 16 + 16) | 64 (16 + 16) |

**Débit par expéditeur** : `SHH_SEGMENTS_PER_MIN` (1 500 par défaut, 600 avant le 13 novembre) est la seule limite par personne réglable ici : requêtes de segments de 4 Mio par minute et par connexion (10 fois plus par /48), soit environ 840 Mbit/s par expéditeur. La baisser protège la bande passante de la machine ; la monter ne sert qu'au-delà de 1 Gbit/s.

`SHH_DISK_OPS_MAX` borne les fils du système bloqués sur le disque (audit du 13 novembre, D4) : 1,5 fois sa valeur au pire (partages et pièces, plus les écritures et les lectures des conversations ; 96 fils par défaut), quel que soit le nombre de connexions (`SHH_WS_MAX` ne compte plus : les lectures du rattrapage attendent leur tour). **Contrôle au démarrage** : si ce total dépasse la moitié de `pids_limit` (lu dans `/sys/fs/cgroup/pids.max` ; 1 024 dans `compose.yaml`), le serveur refuse de démarrer (message `… plus de la moitié de pids_limit`) : baisser `SHH_DISK_OPS_MAX` ou relever `pids_limit`. Chaque autre catégorie a au plus `nofile / 8` places (une lecture ou un envoi tient 2 descripteurs) ; une valeur réglée au-delà empêche le serveur de démarrer (message `… dépasse la limite de descripteurs`), au lieu de le faire tomber sous la charge.

**Règle de sûreté** : ne monter `SHH_UPLOADS_MAX` qu'avec la mémoire. Chaque envoi garde 4 Mio, que le ramasse-miettes peut doubler : au-delà de `mem_limit`, le noyau tue le serveur (envois en cours perdus). Pour une machine plus grosse, monter `mem_limit` et `GOMEMLIMIT` ensemble (`GOMEMLIMIT` ≈ 90 % de `mem_limit`) et laisser les places se recalculer.

**Mémoire du salon** (audit adverse du 13 novembre) : l'index des trames en mémoire est borné **globalement** par `SHH_SALON_FRAMES_TOTAL` (calé sur `GOMEMLIMIT`), tous salons confondus, en plus du plafond par salon. Monter `SHH_SALONS_MAX` ne peut donc plus faire tuer le serveur faute de mémoire : au pire, des salons reçoivent `0x0C` « plein » plus tôt. **Part de chaque salon** (2ᵉ passage de l'audit, F3) : la moitié de ce plafond est réservée à parts égales entre les `SHH_SALONS_MAX` salons possibles (4 915 trames par salon avec les valeurs livrées) ; un salon n'est jamais refusé sous sa part, quoi que fassent les autres ; l'autre moitié est un pot commun. **Limite connue du pot commun** (audit adverse du 13 novembre, 3ᵉ campagne, F) : un salon plein en prend 95 085 trames ; **11 salons pleins le vident** (3 blocs /48 ou 3 adresses IPv4 à 5 salons chacune, environ 7 h de remplissage à 10 sièges). Les autres salons retombent alors à leur part (4 915 trames depuis leur dernier renouvellement, **trames effacées comprises** : l'index ne rétrécit pas tant que le salon vit), qu'un salon de 10 membres au débit permis épuise dans sa première rafale ; ils reçoivent `0x0C` « plein » jusqu'à la fin ou au renouvellement des salons pleins. Aucune correction simple et sûre n'existe dans le code actuel : retirer de l'index les trames effacées changerait le rattrapage, et borner la part d'un bloc dans le pot demande un compte par bloc tenu sous les verrous de chaque salon. Choix du propriétaire, à reprendre dans la spécification (§18). Parades d'exploitation : `SHH_SALONS_MAX` plus bas (part plus grande) ou `GOMEMLIMIT` plus haut. Le journal des annonces de chaque salon (256 Kio au pire) est hors de ce plafond : c'est le contrôle de démarrage de `SHH_SALONS_MAX` qui le borne (§1). Comme pour les envois, c'est `GOMEMLIMIT` qui fait monter ce plafond avec la machine.

**Part équitable** (audit du 13 novembre, D2) : en plus de ses propres limites, une connexion ou un bloc /48 (une adresse en IPv4) prend au plus **1/8** de chaque plafond global, et le **dernier quart** des places (envois, lectures, surveillances, WebSocket, salons) ne va qu'à un bloc qui n'en tient aucune. Le **dernier huitième du stockage** ne va qu'à une adresse qui n'a rien créé ni envoyé aujourd'hui (UTC) ; un agrandissement et une pièce du salon n'y entrent jamais ; une adresse ne réserve pas plus de `SHH_STORAGE_MAX / 8` octets par jour. Un salon où personne n'est entré est effacé 15 min après sa création. Adresses IPv4 nécessaires pour tout prendre, avec `compose.yaml` : envois 23 (8 avant), lectures 107 (16 avant), salons (200) 80 qui y entrent (40 avant, sans y entrer), stockage environ 43 (34 avant). Ces seuils restent atteignables par un attaquant qui dispose de beaucoup d'adresses : ce sont des limites assumées, à reporter dans la spécification (§18).

## 12. Compte par e-mail (désactivé) : sortie SMTP, secrets, sauvegarde

Le compte (conception `docs/superpowers/specs/2026-11-14-compte-email-design.md`) est **activé** (décision D8 du propriétaire, 19 novembre) : `compose.yaml` pose `SHH_COMPTES: "1"` et le site de l'image est construit avec le compte (`deploy/Dockerfile`, `SHH_SITE_COMPTES=1`, `check-dist.mjs --comptes`). **Risque assumé par le propriétaire** : l'avis du juriste sur la conservation des données de création de compte (LCEN et décret 2021-1362 ; conception §16, §21.18) n'a pas été demandé. `deploy.sh` refuse d'installer tant que les secrets (§12.2) et la configuration SMTP (§12.3) manquent : **ce qui reste à faire avant la mise en ligne est la liste du §12.3** (fournisseur, DNS, secrets, sauvegarde le même jour). Avec `SHH_COMPTES: "0"` : aucune route `/api/compte/*`, aucun fichier lu dans `secrets/`, aucun relais SMTP, aucune connexion sortante.

### 12.1 Sortie SMTP : le seul relais

Le serveur Go reste sur le réseau Docker `interne` (`internal: true`), **sans aucune route vers Internet, même compte activé**. Compte activé, `deploy.sh` démarre un troisième conteneur, `relais-smtp` (profil Compose `comptes`, même image que le serveur, programme `/shhcheck relais`, `shhcheck/relais.go`) :

- il est sur `interne` (172.30.53.3) et sur un réseau `sortie` à lui seul (172.30.53.8/29), sans port publié ;
- dans le conteneur du serveur, `extra_hosts` fait pointer le nom `SHH_SMTP_HOST` vers 172.30.53.3 : le serveur se connecte « au fournisseur », arrive sur le relais, qui recopie les octets vers **`SHH_SMTP_HOST:465` et rien d'autre** (cible fixée à son démarrage ; le serveur ne peut rien choisir : ni hôte, ni port) ;
- TLS est de bout en bout entre le serveur et le fournisseur : le serveur vérifie le certificat pour `SHH_SMTP_HOST` (certificats racine de l'image) ; le relais ne voit que des octets chiffrés, leur taille et l'heure. Il n'écrit rien (journal `none`) ; 4 connexions à la fois, 60 s chacune au plus ; compte 65532, lecture seule, sans capacité ;
- il résout `SHH_SMTP_HOST` à chaque connexion (résolveur de Docker, donc celui de la machine) : un changement d'adresse du fournisseur ne demande rien.

**Écart au plan, voulu** : le plan prévoyait le serveur sur un réseau non interne et une règle de pare-feu de la machine (TCP 465 vers les adresses de `SHH_SMTP_HOST`). Refusé parce qu'il échoue **ouvert** : sans la règle (pare-feu vidé, `iptables -F`, Docker en mode nftables où `DOCKER-USER` n'existe pas, adresses du fournisseur changées puis élargies à la main), le serveur aurait eu une sortie complète vers Internet. Avec le relais, c'est Docker (`internal: true`) qui garantit l'absence de route, comme avant le compte. **Limite** : le conteneur du relais, lui, a une sortie ordinaire (réseau `sortie`) ; c'est son code, fixe et testé (`go test` de `shhcheck`), qui la borne à une seule cible. Défense de plus, facultative, à poser par l'exploitant selon son pare-feu : n'autoriser depuis 172.30.53.8/29 que TCP 465 et la résolution DNS par la machine.

Contrôles : `deploy.sh` vérifie, après chaque installation compte activé, que le fournisseur répond à travers le relais en TLS vérifié (`shhcheck smtp` : accueil SMTP puis `QUIT`, ni authentification ni e-mail) ; un échec n'est qu'un **avertissement** (une panne du fournisseur ne fait pas revenir à l'image d'avant), mais il veut dire qu'**aucun code n'arrive** et rien d'autre ne le dit (aucun journal). Tests : `make test-sortie` (configuration résolue ; réseau réel avec un démon Docker), `make lint-deploy` (tests du relais).

**Fournisseur d'envoi** (décision D1, encore ouverte : la conception recommande un fournisseur dans l'UE, SMTP standard) : SMTP authentifié en **TLS implicite sur 465** ; suivi des ouvertures et des clics **désactivé** ; contrat de sous-traitance (RGPD art. 28) ; durée de conservation de ses journaux la plus courte possible (ils gardent adresse, heure et code, conception §21.3). Il apprend l'adresse IP de la machine.

**DNS du domaine d'envoi** (celui de `SHH_MAIL_FROM`), sans quoi les codes finissent en indésirables (conception §18) : les enregistrements que donne le fournisseur, exactement :

- **SPF** : un seul enregistrement `TXT` à la racine, `v=spf1 include:<valeur du fournisseur> -all` (fusionner avec un SPF existant, jamais deux) ;
- **DKIM** : l'enregistrement `TXT` (ou `CNAME`) `<sélecteur>._domainkey` du fournisseur ;
- **DMARC** : `_dmarc TXT "v=DMARC1; p=quarantine; adkim=s; aspf=r"` pour commencer, puis `p=reject` une fois les envois vérifiés. Aucune adresse `rua`/`ruf` n'est nécessaire (les rapports contiendraient les adresses IP des serveurs d'envoi, pas celles des personnes ; à décider) ;
- vérifier depuis un autre poste : `dig +short TXT <domaine>`, `dig +short TXT <sélecteur>._domainkey.<domaine>`, `dig +short TXT _dmarc.<domaine>`, puis un envoi réel vers une boîte de test (en-têtes `spf=pass`, `dkim=pass`, `dmarc=pass`).

### 12.2 Secrets : clé du serveur et mot de passe SMTP

Deux fichiers dans `/srv/shhdrop/secrets/` (volume chiffré, **hors** de `data/`, donc hors de la sauvegarde), montés en lecture seule dans `/run/secrets` du serveur. Le dépôt, `deploy/.env`, la configuration du conteneur (`docker inspect`) et l'environnement du processus n'en contiennent que les **chemins**. `deploy.sh` refuse d'installer, compte activé, si un fichier manque ou n'a pas exactement ces droits ; le serveur refuse aussi de démarrer (clé de 32 octets, 0400 ou 0600).

```sh
install -d -o root -g 65532 -m 0750 /srv/shhdrop/secrets   # déjà fait au §2
cd /srv/shhdrop/secrets
# Clé du serveur K_serveur : 32 octets tirés au hasard, une fois pour toutes.
(umask 077 && head -c 32 /dev/urandom > shh_comptes_cle)
# Mot de passe SMTP du fournisseur : tapé sans écho, jamais en argument ni dans l'historique.
(umask 077 && IFS= read -rs MDP && printf '%s' "$MDP" > shh_smtp_mdp; unset MDP)
chown 65532:65532 shh_comptes_cle shh_smtp_mdp && chmod 0400 shh_comptes_cle shh_smtp_mdp
```

**La clé du serveur ne se perd pas** : sans elle, **tous les comptes sont perdus**, sans recours (plus aucune adresse ne retrouve son compte, plus aucun mot de passe ne se vérifie, les profils séquestrés ne s'ouvrent plus) ; elle ne se change pas non plus (conception §5.2). Une sauvegarde de `comptes.db` sans elle ne sert à rien. Donc, dès sa création :

- **copie hors ligne obligatoire**, par exemple sur papier : `base64 < shh_comptes_cle` (44 caractères, à recopier puis à relire ; effacer ensuite l'écran : `clear`), ou sur une clé USB chiffrée ; restauration : `base64 -d > shh_comptes_cle`, puis les droits ci-dessus ;
- cette copie est rangée **à part** de la clé privée age des sauvegardes (§12.4) : qui a les deux et une sauvegarde lit les profils séquestrés et peut essayer des adresses une à une (conception R19) ;
- elle ne va jamais dans le dépôt, dans `deploy/.env`, dans un gestionnaire de mots de passe synchronisé avec la machine, ni dans la sauvegarde.

Le mot de passe SMTP, lui, se remplace (nouveau mot de passe chez le fournisseur, nouveau fichier, `deploy.sh`) : pas de copie hors ligne nécessaire.

### 12.3 Activer le compte (décision D8 prise)

1. Fournisseur choisi (D1), DNS du §12.1 posés et vérifiés.
2. Secrets du §12.2 créés ; copie hors ligne de la clé faite.
3. `deploy/.env` : `SHH_SMTP_HOST`, `SHH_SMTP_USER`, `SHH_MAIL_FROM` (entre apostrophes), modèle dans `env.example`.
4. `compose.yaml` : `SHH_SALONS: "1"` et `SHH_COMPTES: "1"` (fichier relu et commité, comme le salon).
5. `deploy/deploy.sh sha256:<empreinte>` : relais démarré, secrets contrôlés, fournisseur contrôlé.
6. Sauvegarde du §12.4 installée **le même jour**, puis une restauration essayée (§12.5).

Désactiver : `SHH_COMPTES: "0"`, `deploy.sh` (le relais est arrêté). `comptes.db` reste sur le volume, intacte.

### 12.4 Sauvegarde quotidienne chiffrée de `comptes.db` et de `paiements.db`

Ce qui est sauvegardé : **`comptes.db`** (comptes, sessions, bannis) et **`paiements.db`** (empreintes des pass, commandes en attente, références des prestataires, jetons dépensés des deux derniers jours ; aucune identité, aucun montant, aucun pays ; les **clés privées d'émission des jetons sont retirées de la copie** avant le chiffrement, `VACUUM` compris), chacune dans son propre fichier ; une base absente (compte ou paiement désactivé) est sautée. Jamais `shares.db`, les fichiers des partages, les salons, les conversations, ni la clé du serveur. Comment (`sauvegarder.sh`, minuteur `systemd/shhdrop-sauvegarde.timer`, chaque jour vers 03:17 UTC) : copie cohérente par `sqlite3 .backup`, serveur en marche (sous le compte 65532, dans `/srv/shhdrop/sauvegarde/` : le clair ne quitte jamais le volume chiffré, refus sinon) ; `PRAGMA integrity_check` ; chiffrement par **age** (`age-encryption.org/v1`, X25519) vers la clé **publique** de l'exploitant ; clair effacé aussitôt ; envoi du seul chiffré, nommé `comptes-AAAA-MM-JJTHHMMSSZ.db.age` et `paiements-AAAA-MM-JJTHHMMSSZ.db.age`, sous le même `SHH_SAUVEGARDE_URL`. Aucune crypto maison, rien dans le serveur Go. La lecture de la base dure environ une seconde ; si une suppression de compte tombe pendant ce temps, son vidage du journal (`comptes.db-wal`) attend le suivant (au plus la passe quotidienne).

Mise en place, une fois :

1. **Outils** sur la machine : `apt install sqlite3 age curl` (ou `age` construit depuis ses sources ou paquet signé), puis `age --version` recopié dans `deploy/.env` (`SHH_AGE_VERSION`) : le script refuse une autre version.
2. **Clés age, sur le poste de l'exploitant** (jamais sur la machine) : `age-keygen -o sauvegarde.cle` (la ligne `Public key: age1…` est la clé publique), idéalement protégée par une phrase : `age-keygen | age -p > sauvegarde.cle.age` (age demandera la phrase à chaque restauration). Clé publique dans `deploy/.env` (`SHH_SAUVEGARDE_DESTINATAIRE`). Clé privée **hors ligne** (papier ou clé USB chiffrée), **à part** de la copie de la clé du serveur (§12.2) : les deux sont nécessaires à une restauration.
3. **Stockage objet** chez un **autre fournisseur** que l'hébergeur, **dans l'UE** (contrat de sous-traitance) : un seau dédié ; **gestion des versions activée** (ou verrouillage d'objet, « Object Lock », 30 jours) : l'accès en écriture seule ne peut ni lire ni effacer, mais sans versions il pourrait **écraser** une copie sous le même nom ; **règle de cycle de vie : effacer les objets (et leurs anciennes versions) après 30 jours** (rotation de 30 copies, dite dans la page Confidentialité, conception R18) ; un **compte d'accès en écriture seule** (droit `PutObject` sur ce seau seulement : ni lecture, ni liste, ni effacement), pour qu'un pirate de la machine ne puisse ni lire ni détruire les copies. Un **second accès, en lecture**, reste sur le poste de l'exploitant, pour les restaurations.
4. **Accès d'écriture** sur la machine, dans `/srv/shhdrop/sauvegarde-acces.curl` (root 0600, sur le volume chiffré, hors de `secrets/` que le serveur voit) : un fichier de configuration curl, pour que les identifiants n'apparaissent jamais dans la liste des processus :

   ```sh
   (umask 077 && cat > /srv/shhdrop/sauvegarde-acces.curl) <<'FIN'
   user = "<clé d'accès>:<secret>"
   aws-sigv4 = "aws:amz:<région>:s3"
   FIN
   ```

   et dans `deploy/.env` : `SHH_SAUVEGARDE_URL=https://<seau>.<point d'accès S3>/comptes/` (barre finale comprise).
5. **Dossier temporaire et minuteur** :

   ```sh
   install -d -o 65532 -g 65532 -m 0700 /srv/shhdrop/sauvegarde
   cp deploy/systemd/shhdrop-sauvegarde.service deploy/systemd/shhdrop-sauvegarde.timer /etc/systemd/system/
   # Remplacer /opt/shhdrop par le chemin de la copie du dépôt, dans le .service.
   systemctl daemon-reload && systemctl enable --now shhdrop-sauvegarde.timer
   systemctl start shhdrop-sauvegarde.service && journalctl -u shhdrop-sauvegarde.service -n 5   # « sauvegarde envoyée : … »
   ```

À savoir : le volume doit avoir deux fois la taille de `comptes.db` de libre (clair puis chiffré, un instant) ; au pire 10 000 comptes × deux coffres de 256 Kio ≈ 5 Go. Une sauvegarde ratée ne se voit que dans `systemctl status shhdrop-sauvegarde.service` (journald en mémoire, aucune alerte : §9, « Surveillance ») ; vérifier aussi chaque semaine qu'un objet du jour est arrivé (accès en lecture). Machine redémarrée : rien n'est sauvegardé tant que le volume n'est pas déverrouillé (refus du script).

**Ce que voit le fournisseur de stockage** : la taille de chaque copie et l'heure d'envoi (conception S79), jamais le contenu. **Effet sur le droit à l'effacement** : un compte supprimé reste dans les copies jusqu'à 30 jours (dit dans la page Confidentialité, conception §21.13).

### 12.5 Restauration

**Essai mensuel** (décision du propriétaire du 14 novembre), sur le poste de l'exploitant (Linux : `age`, `sqlite3`, `/dev/shm`) : télécharger la copie la plus récente avec l'accès en lecture, puis

```sh
deploy/restaurer.sh verifier comptes-<date>.db.age sauvegarde.cle   # « intégrité : ok ; schéma 2 ; N comptes »
deploy/restaurer.sh verifier paiements-<date>.db.age sauvegarde.cle # « intégrité : ok ; base des paiements ; schéma 2 ; N pass »
```

(déchiffrée en mémoire, `/dev/shm`, puis effacée ; rien n'est installé). À chaque changement du schéma de `comptes.db`, et à chaque changement des scripts : `sudo make test-restauration` (compte de test créé par le vrai serveur, sauvegarde serveur en marche, effacement, restauration, reconnexion réussie ; avec une autre clé du serveur, connexion refusée ; puis `paiements.db` créée par le serveur avec le paiement en bac à sable, un pass factice sauvegardé sans son empreinte en clair ni clé de jetons, restauré).

**Restauration réelle** (base perdue ou abîmée, nouvelle machine) :

1. Machine prête (§1, §2), volume monté, **clé du serveur remise** depuis sa copie hors ligne dans `secrets/` (§12.2). Une image **au moins aussi récente** que celle qui a écrit la sauvegarde (une plus ancienne refuse la base : « créée par une version plus récente »).
2. Serveur **arrêté** : `docker stop shhdrop-shhdrop-1` (le script refuse si un processus a encore la base ouverte).
3. Copier la **plus récente** des sauvegardes sur la machine, et l'identité age le temps de la restauration (protégée par sa phrase, §12.4 : seule sa forme chiffrée passe sur la machine), puis :

   ```sh
   deploy/restaurer.sh installer [--remplacer] comptes-<date>.db.age sauvegarde.cle /srv/shhdrop/data
   shred -u sauvegarde.cle   # l'identité ne reste pas sur la machine (au mieux : ext4, SSD)
   deploy/deploy.sh "$(cat deploy/.release)"
   ```

   La même commande restaure `paiements-<date>.db.age` (la base est reconnue à ses tables et installée sous `paiements.db`). Le clair est déchiffré dans le dossier de données lui-même (volume chiffré), vérifié (`integrity_check`, tables), installé (compte 65532, 0600). `--remplacer` garde l'ancienne base à côté (`comptes.db.avant-restauration`, avec son `-wal`) : l'effacer une fois un compte de contrôle reconnecté.
4. Se connecter avec un compte de contrôle.

Règles et effets :

- **toujours la plus récente** : les suppressions de comptes antérieures y sont appliquées ; une copie plus ancienne ferait revenir des comptes supprimés (interdit par la procédure, conception §21.13) ;
- **toutes les sessions sont effacées** à la restauration : chacun se reconnecte (une session fermée depuis la sauvegarde, après un vol par exemple, ne revient pas) ;
- **ce qui a changé depuis la sauvegarde est perdu** (24 h au plus) : un mot de passe changé **revient à l'ancien**, une adresse changée aussi, un compte créé disparaît, **un compte supprimé depuis revient**, un bannissement posé depuis disparaît ; aucun e-mail ne peut prévenir les personnes (le serveur ne garde pas les adresses). À noter dans le registre de l'incident ; un bannissement se repose depuis le tableau de bord ;
- partages et salons d'avant la perte sont perdus (éphémères, jamais sauvegardés), le lien compte ↔ salon aussi ;
- **paiements** : la copie n'a **aucune clé de jetons** (retirées à la sauvegarde, et encore à la restauration ; de nouvelles sont tirées à la première demande) : tout jeton émis avant ne passe plus (un jeton dépensé depuis la sauvegarde ne peut donc pas resservir) ; chacun en reprend sans rien faire, dans la limite du jour. **Un pass payé depuis la sauvegarde est inconnu de la copie** (24 h au plus) : sa commande aussi, et un webhook rejoué ensuite ne le recrée pas. La personne le signale au contact avec la date, le montant et le moyen de paiement ; l'exploitant retrouve le paiement dans le tableau de bord du prestataire (qui, lui, connaît l'acheteur) et le rembourse : rien chez nous ne relie un pass à une personne. Une révocation posée à la main depuis la sauvegarde (`shhdrop admin paiement revoquer`) disparaît : la reposer.

## 13. Paiement des offres Plus et Pro (désactivé) : relais de sortie, secrets, sauvegarde

Conception : `docs/superpowers/specs/2026-11-19-paiement-design.md`. **Désactivé** : `compose.yaml` pose `SHH_PAIEMENT: "0"` ; ce qui manque avant de l'activer est la liste du §13 de la conception (comptes chez les prestataires, régime de TVA, mentions légales des notes de vente, contrat et CGV). Avec `"0"` : aucune route `/api/paiement/*`, aucun fichier de `secrets/` lu pour le paiement, aucun relais de paiement, aucune connexion sortante de plus.

### 13.1 Sorties : un relais par prestataire

Même modèle que le relais SMTP (§12.1), pour la même raison (échec fermé) : le serveur reste sur `interne` (`internal: true`), **sans route vers Internet, même paiement activé**. Pour chaque prestataire configuré, `deploy.sh` démarre son relais (même image, `/shhcheck relais`, 16 connexions à la fois, 60 s chacune au plus, compte 65532, lecture seule, sans capacité, aucun journal) :

| Relais (profil) | Adresse interne | Seule cible (production ; bac à sable avec `SHH_PAIEMENT_ESSAI: "1"`) |
| --- | --- | --- |
| `relais-stripe` (`paiement-stripe`) | 172.30.53.4:443 | `api.stripe.com:443` (le même en essai) |
| `relais-paypal` (`paiement-paypal`) | 172.30.53.5:443 | `api-m.paypal.com:443` (`api-m.sandbox.paypal.com:443`) |
| `relais-nowpayments` (`paiement-nowpayments`) | 172.30.53.6:443 | `api.nowpayments.io:443` (`api-sandbox.nowpayments.io:443`) |

Dans le conteneur du serveur, `extra_hosts` fait pointer chacun de ces noms vers son relais ; le serveur vérifie le certificat TLS pour ce nom (TLS de bout en bout : le relais ne voit que des octets chiffrés, leur taille et l'heure). Le client HTTP du paiement ouvre une connexion par appel (aucune connexion gardée que le relais couperait au milieu d'un paiement) et ne lit aucune variable de proxy. Les hôtes sont fixés par `deploy.sh` d'après `SHH_PAIEMENT_ESSAI` (dans `compose.yaml`), jamais par `deploy/.env`. Les webhooks des prestataires **entrent** par Caddy, comme le reste du site : rien à ouvrir pour eux. Défense de plus, facultative (comme §12.1) : n'autoriser depuis 172.30.53.8/29 que TCP 465 et 443 et la résolution DNS par la machine. **Limite** : un relais joint toute adresse que le DNS donne pour son hôte ; il ne choisit pas l'hôte.

Tests : `make test-sortie` (configuration résolue : relais, adresses, cibles, profils, aucun port publié, serveur sur `interne` seul ; avec un démon Docker : chaque API jointe à travers son relais en TLS vérifié, injoignable relais arrêté), `make lint-deploy` (tests du relais, dont son plafond de connexions).

### 13.2 Secrets et réglages

Fichiers de `<SHH_DATA_ROOT>/secrets` (compte 65532, droits 0400, comme §12.2), jamais des variables ; un prestataire est **configuré quand ses fichiers sont là** :

| Prestataire | Fichiers | Dans `deploy/.env` |
| --- | --- | --- |
| Stripe (carte) | `shh_stripe_cle` (clé secrète restreinte `rk_…`/`sk_…`), `shh_stripe_webhook` (`whsec_…`) | `SHH_STRIPE_TAXE=1` si Stripe Tax calcule la TVA |
| PayPal | `shh_paypal_secret` | `SHH_PAYPAL_CLIENT_ID`, `SHH_PAYPAL_WEBHOOK_ID`, `SHH_PAYPAL_PLANS` |
| NOWPayments (crypto) | `shh_nowpayments_cle`, `shh_nowpayments_ipn` | rien |

et, pour tous, `SHH_TVA` (`franchise`, `france` ou `oss` : régime choisi par le propriétaire avec son comptable). Paiement activé, `deploy.sh` refuse d'installer sans `SHH_TVA`, sans aucun prestataire, ou si un fichier attendu manque, est un lien ou n'a pas le bon propriétaire et les bons droits. Le serveur, lui, refuse de démarrer avec une clé Stripe de production en essai ou l’inverse, ou un prestataire à moitié configuré (message sans valeur).

```sh
(umask 077 && cat > /srv/shhdrop/secrets/shh_stripe_cle)   # coller la clé, Entrée, Ctrl-D
chown 65532:65532 /srv/shhdrop/secrets/shh_stripe_cle && chmod 0400 /srv/shhdrop/secrets/shh_stripe_cle
```

### 13.3 Sauvegarde et restauration

`paiements.db` (empreintes des pass, commandes en attente, références des prestataires ; aucune identité, aucun montant, aucun pays ; jamais les clés privées des jetons) est sauvegardée **avec `comptes.db`**, chaque jour, dans son propre fichier chiffré (§12.4), et se restaure de la même façon (§12.5 : clés de jetons effacées ; un pass payé depuis la sauvegarde est à rembourser depuis le tableau de bord du prestataire). La sauvegarde doit être en place **le jour de l'activation** : perdre `paiements.db` rendrait inutilisables tous les pass payés.

## 14. Appels audio et vidéo du salon : relais TURN intégré

Conception : `docs/superpowers/specs/2026-11-20-appels-design.md`. Les appels sont **activés par défaut** et **rien n'est à installer**, ni sur la machine ni chez les utilisateurs : le relais fait partie de notre image (`/shhcheck turn`, `deploy/shhcheck/turn.go`, bibliothèque pion/turn épinglée), lancé par `compose.yaml` (service `relais-turn`, profil « appels »).

`deploy.sh` fait tout à chaque installation :

1. il tire le secret partagé du relais s'il n'existe pas (`<SHH_DATA_ROOT>/secrets/shh_turn_secret`, compte 65532, 0400) et ne l'affiche jamais ;
2. il pose `SHH_TURN_URLS` (`turn:<SHH_DOMAIN>:3478`, UDP et TCP : le nom du site, aucun DNS de plus) et `SHH_TURN_SECRET_FILE` pour le serveur ;
3. pare-feu ufw actif : il ouvre 3478 (UDP et TCP) et 49160 à 49999 (UDP) s'ils ne le sont pas, et le dit ; autre pare-feu : il rappelle ces ports ;
4. après le démarrage, il vérifie que le relais répond (requête STUN sur 127.0.0.1:3478) ; sinon, un avertissement (le reste du site n'est pas touché).

Le relais utilise le réseau de la machine (adresse publique, plage de ports UDP), sous le compte 65532, en lecture seule, sans capacité ni journal. Il ne voit que des paquets chiffrés de bout en bout et les adresses IP des deux bouts, en mémoire ; il ne relaie vers aucune adresse privée, ni vers un autre port de la machine que sa propre plage.

Réglages facultatifs, dans `deploy/.env` :

- `SHH_TURN_IP` : adresse IPv4 publique, si la machine est derrière un routeur (l'adresse détectée serait privée : le relais refuse alors de démarrer et le dit). Rediriger alors 3478 et 49160 à 49999 vers la machine ;
- `SHH_TURN_ALLOCATIONS` (60) et `SHH_TURN_KBPS` (2 500) : allocations simultanées et débit par allocation. Un appel vidéo à 6 en prend 30 à environ 500 kbit/s ; les valeurs par défaut plafonnent le relais à environ 150 Mbit/s ;
- `SHH_APPELS=0` : coupe les appels (relais arrêté, aucune route ni bouton d'appel).

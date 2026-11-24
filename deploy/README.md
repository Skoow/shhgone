# Déploiement de Shhdrop

Caddy (TLS) devant le serveur Go, dans Docker. Références : spécification §8, §9.4, §10, §15, §22, §28.7, §30, §36 ; audits du 5 novembre (confidentialité P5 et P6, sécurité F3).

| Fichier | Rôle |
|---|---|
| `Caddyfile` | TLS 1.3, échange de clés hybride, remplacement de `X-Shh-Client-IP`, aucun journal |
| `Dockerfile` | image du serveur : binaire Go statique + site, sur `scratch`, compte 65532 |
| `compose.yaml` | les deux conteneurs (plus les relais du paiement et des appels, §13 et §14), en lecture seule, sans capacité, sans journal |
| `deploy.sh` | installe une version par empreinte, contrôle, revient en arrière ; commandes d'administration |
| `shhcheck/` | petit programme Go : santé du conteneur, test TLS hybride, relais de sortie du paiement (§13), contrôle d'un hôte joignable en TLS (`joindre`), relais TURN (§14) ; `salonws_test.go` et `compte_test.go` : essais de banc (tests seulement, hors du binaire) |
| `test-proxy.sh` | test du proxy : le Caddyfile devant le vrai serveur (salon activé), sur la boucle locale |
| `journaux.sh`, `test-journaux.sh` | contrôles des journaux de la machine (aucune adresse IP sur le disque, une heure au plus en mémoire), bloquants dans `deploy.sh` ; leur banc d'essai, sur une machine factice (§1) |
| `test-sortie.sh` | test des sorties : configuration résolue de `compose.yaml` (aucun relais SMTP, relais du paiement), puis réseau réel avec Docker (§12.1, §13.1) |
| `compose.yaml` : `relais-stripe`, `relais-paypal`, `relais-nowpayments` | seules sorties du paiement, une par prestataire, paiement activé (§13) |
| `systemd/shhdrop-journal.*`, `systemd/00-shhdrop-connexions.conf` | purge du journal de plus d'une heure, tous les quarts d'heure ; registres des connexions (`wtmp`, `btmp`, `lastlog`) vers `/dev/null` (§1) |
| `sauvegarder.sh`, `systemd/` | sauvegarde quotidienne chiffrée (age) de `comptes.db` et de `paiements.db`, et son minuteur (§12.4) |
| `restaurer.sh` | vérification mensuelle et restauration d'une sauvegarde (§12.5) |
| `test-restauration.sh` | sauvegarde, effacement, restauration et reconnexion d'un compte de test, puis de `paiements.db` avec un pass factice, en mémoire (§12.5) |
| `env.example` | modèle de `deploy/.env` |

Ce kit réduit les risques ; il ne rend pas le service invulnérable. Les limites sont listées en fin de page.

## 1. Avant d'installer

Chez l'hébergeur et le registraire :

- serveur **dédié** loué (spécification §15.1 ; proposition du 22 novembre, §17.1 : en France, chez OVH), jamais un VPS (voir « Hébergeur et certificat » plus bas), trafic sortant inclus vérifié, aucun CDN ni proxy devant ;
- instantanés et sauvegardes de la machine **désactivés** chez l'hébergeur, aucun agent de surveillance de l'hébergeur ;
- **aucun outil qui ouvre `shares.db` pendant que le serveur tourne** (seule exception, pour `comptes.db` et non `shares.db` : la sauvegarde quotidienne du compte, §12.4, qui la lit une seconde environ) (sauvegarde à chaud, réplication de type Litestream, `sqlite3` pour « regarder ») : un lecteur d'un autre processus empêche le vidage du journal de la base (`shares.db-wal`), qui garde alors les lignes des partages et des salons déjà effacés. Le tableau de bord d'administration l'affiche (« Vidages de la base ratés ») ; le compte doit rester à 0 (audit adverse du 13 novembre, stockage, F3) ;
- DNS : `A` et `AAAA` vers le serveur ; **DNSSEC** activé ; `CAA 0 issue "letsencrypt.org"`, puis, après le premier certificat, lié à **notre** compte ACME : `CAA 0 issue "letsencrypt.org; accounturi=<URI du compte>"` (l'URI est dans le fichier du compte, sous `<SHH_DATA_ROOT>/caddy/acme/acme-v02.api.letsencrypt.org-directory/users/`) et `CAA 0 issuewild ";"` (aucun certificat générique) ; double authentification et verrou de transfert (§15.4).

### Hébergeur et certificat (22 novembre)

Ce que l'hébergeur (ou qui prend la machine) peut faire, et ce qui l'en empêche ou le fait voir :

- **Le contenu reste hors de portée** : fichiers, messages, noms de fichiers, clés et mots de passe des utilisateurs sont chiffrés dans le navigateur ; le serveur ne les a jamais en clair, même en mémoire. Lire la mémoire ne donne que des métadonnées passagères (adresses des connexions en cours, tailles, heures).
- **Le volume chiffré se déverrouille par SSH seulement** (§5), jamais par la console KVM/IPMI de l'hébergeur, qui peut voir ce qu'on y tape. La phrase n'est écrite nulle part. Couper l'accès IPMI dans l'espace client quand il ne sert pas.
- **Dédié plutôt que VPS** : sur un VPS, l'hébergeur lit la mémoire de la machine (donc la clé du volume ouvert et la clé TLS) d'une simple commande ; sur un dédié, il lui faut une intervention physique. Chiffrement de la mémoire par le processeur (AMD SME/TSME, Intel TME) : à activer dans le BIOS si le modèle l'a (pas le Xeon-D 2141I du SYS-2, trop ancien).
- **Certificats de 6 jours** (profil « shortlived » de Let's Encrypt, `Caddyfile`) : une clé volée ne sert que quelques jours. Caddy renouvelle seul vers 2 jours restants ; chaque renouvellement crée une **nouvelle clé**, sur la machine, qui ne voyage jamais (seule une preuve de contrôle du domaine passe par le réseau) : aucun risque de plus par renouvellement. Alerte URGENT sous 36 h restantes ; panne de Let's Encrypt de plusieurs jours : retirer le bloc `issuer acme` du `Caddyfile` et redéployer, retour aux certificats de 90 jours. Sonde externe adaptée (36 h pour un certificat de 6 jours, 14 jours sinon).
- **Redémarrage** : alerte URGENT `redemarre` dès que la machine a redémarré (lire le disque ou la mémoire à froid passe presque toujours par là), puis `volume` tant que le volume est verrouillé. Redémarrage inattendu, sans maintenance annoncée par l'hébergeur : ne pas déverrouiller avant d'avoir compris (espace client, tickets, intervention), et en cas de doute suivre le plan d'incident (§6).
- **Le vrai risque est la clé du certificat TLS** : avec elle (ou avec le DNS), on peut se faire passer pour Shhgone et servir un site modifié qui volerait les clés. Défenses : DNSSEC, verrou de transfert, CAA lié à notre compte ACME (plus haut), et **surveillance des journaux publics de certificats** : `alerte.sh` envoie une alerte URGENT `certificat-inconnu` si un certificat émis ces 3 derniers jours pour le nom n'est pas celui que sert le site (crt.sh, une fois par jour ; seul le nom du domaine, public, est envoyé). Si l'alerte n'est pas un renouvellement de Caddy : révoquer le certificat, changer les clés, vérifier le DNS, prévenir les utilisateurs (§6).
- **Limite qui reste** (dite dans la page Sécurité) : le site est servi par le serveur à chaque visite ; un serveur pris peut servir un autre code. Les applications natives prévues (D42-20), signées et installées une fois, et le build reproductible (§28.1, empreintes publiées) la réduisent.

Sur la machine (Linux récent, Docker Engine 25 ou plus avec Compose 2.24 ou plus) :

- **2 processeurs et 2 Gio de mémoire au moins** : `compose.yaml` plafonne le serveur à 1,5 processeur et 1 Gio, Caddy à 1 processeur et 256 Mio (raisons dans le fichier). Avec moins de 2 processeurs, Docker refuse de démarrer le serveur ;

- **disque** : `SHH_STORAGE_MAX` + 1 Gio libres au moins (201 Gio par défaut), sinon le serveur refuse de démarrer ;
- **dimensionnement des salons** : au pire, 2 Go de fichiers × `SHH_SALONS_MAX` (plus leurs conversations) ; le garde-fou `SHH_STORAGE_MAX` protège le disque (au-delà, plus de pièce ni de nouveau salon), et `SHH_SALONS_MAX=50` est conseillé pour un petit serveur. **`SHH_SALONS_MAX` est croisé avec la mémoire au démarrage** : le serveur refuse de démarrer, avec un message qui dit quoi changer, si les journaux des salons (256 Kio par salon au pire) dépasseraient 10 % de `GOMEMLIMIT` (360 salons au plus avec les 900 Mio livrés) ou si la part de trames garantie à chaque salon tomberait sous 1 000 (§11). Les appels disque des conversations ne dépendent plus du nombre de salons ni de connexions : ils ont leurs propres bornes (§11) ;
- **volume chiffré** LUKS2 (AES-256-XTS, Argon2id) pour toutes les données, monté avec **`noatime`** ; la phrase de déverrouillage n'est jamais stockée sur le serveur (§22) ;
- **pas de mémoire d'échange** : `swapoff -a`, ligne retirée de `/etc/fstab` (`deploy.sh` refuse d'installer sinon) ;
- **Caddy non root** (D9, 22 novembre) : dans `/etc/sysctl.d/60-shhdrop.conf`, `net.ipv4.ip_unprivileged_port_start=80`, puis `sysctl --system` (`deploy.sh` refuse d'installer sinon). Caddy tourne sous le compte 65532 sans aucune capacité et peut quand même écouter sur 80 et 443. Contrepartie : sur la machine elle-même, n'importe quel compte pourrait prendre 80 ou 443 pendant un redémarrage de Caddy ; la machine ne fait tourner que `sshd`, Docker, Caddy et le serveur (les conteneurs ont leur propre réseau), donc aucun compte ordinaire. Installation déjà faite : `chown -R 65532:65532 /srv/shhdrop/caddy` ;
- **vidages mémoire coupés** : `kernel.core_pattern=|/bin/false` dans `/etc/sysctl.d/`, en plus de la limite posée sur les conteneurs ;
- **journaux de la machine sans adresse IP sur le disque, et une heure au plus en mémoire** (inventaire des adresses IP du 22 novembre). `deploy.sh` **refuse d'installer** tant qu'un de ces réglages manque, et dit lequel et quoi faire (`journaux.sh`, banc d'essai `test-journaux.sh`) :
  - **pas de syslog** : sur Ubuntu, `rsyslog` est installé et actif par défaut ; il recopie le journal dans `/var/log/auth.log` (adresse de chaque connexion SSH, réussie ou non), `kern.log`, `ufw.log` et `syslog`, **sur le disque**, même avec journald en mémoire. `apt purge rsyslog` (ou `syslog-ng`), puis `rm -f /var/log/auth.log* /var/log/syslog* /var/log/kern.log* /var/log/ufw.log* /var/log/messages*`. Ce qui a déjà été écrit peut rester dans les blocs libérés du disque système (non chiffré) : faire ces réglages avant d'ouvrir SSH au public, ou réinstaller la machine si le doute compte ;
  - **journald en mémoire, une heure au plus** : fichier `/etc/systemd/journald.conf.d/60-shhdrop.conf` :

    ```ini
    [Journal]
    Storage=volatile
    MaxRetentionSec=1h
    MaxFileSec=15min
    ```

    puis `systemctl restart systemd-journald` et `rm -rf /var/log/journal/*` (journaux persistants d'avant ; `deploy.sh` refuse s'il en reste). `Storage=volatile` garde le journal dans `/run` (mémoire) jusqu'au redémarrage : sans les deux limites, les adresses écrites par `sshd` ou le noyau y restaient des semaines. journald n'efface que des fichiers entiers déjà fermés, et vérifie ces limites quand il écrit : `MaxFileSec` ferme le fichier en cours tous les quarts d'heure (1 mois par défaut), `MaxRetentionSec` efface ceux de plus d'une heure ; une entrée vit donc environ 1 h 15 au plus. Comme journald ne vérifie qu'en écrivant, le minuteur **`shhdrop-journal.timer`** fait en plus, tous les quarts d'heure, `journalctl --rotate --vacuum-time=1h` (1 h 15 au plus même sur une machine calme ; une passe par heure laisserait près de 2 h, un fichier fermé n'étant effacé que quand sa dernière entrée a plus d'une heure) : `cp deploy/systemd/shhdrop-journal.service deploy/systemd/shhdrop-journal.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now shhdrop-journal.timer` (`deploy.sh` refuse tant qu'il n'est pas activé). Vérifier : `journalctl -o short-iso | head -n 1` (plus ancienne entrée) ;
  - **`sshd` silencieux** : fichier `/etc/ssh/sshd_config.d/10-shhdrop.conf` (préfixe 10 : `sshd` garde la **première** valeur lue, et Ubuntu pose parfois `PasswordAuthentication yes` dans `50-cloud-init.conf`) :

    ```
    LogLevel QUIET
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    ```

    puis `sshd -t && systemctl reload ssh`, et vérifier depuis **une deuxième session** que la connexion par clé marche encore avant de fermer la première. Ce réglage ne change que les journaux et interdit le mot de passe (déjà exigé plus bas ; avec lui, PAM écrirait l'adresse, `rhost=`, à chaque échec) : la connexion par clé de l'administrateur n'est pas touchée. `deploy.sh` lit la configuration effective (`sshd -T`). Contrepartie : plus aucune trace des connexions SSH, réussies ou non ; une intrusion par SSH ne se lirait plus dans les journaux (l'alerte `redemarre` et la sonde restent). Variante plus forte, à choisir par l'exploitant : SSH joignable seulement par un VPN (WireGuard sur la machine, port 22 fermé au public dans le pare-feu) ; les robots ne joignent plus `sshd`, `LogLevel QUIET` reste exigé ;
  - **pare-feu sans journal** : `ufw logging off` (sinon chaque paquet refusé, avec ses adresses, va dans le journal du noyau) ;
  - **suivi des connexions du pare-feu raccourci** : le noyau garde en mémoire, pour chaque connexion vue par le pare-feu, les adresses IP des deux bouts, jusqu'à **5 jours** par défaut pour une connexion TCP établie, même inactive. Dans `/etc/sysctl.d/` : `net.netfilter.nf_conntrack_tcp_timeout_established=1800` (30 min ; nos connexions longues envoient un signe de vie toutes les 25 à 45 s, WebSocket et relais, elles ne sont pas coupées). Vérifier : `sysctl net.netfilter.nf_conntrack_tcp_timeout_established` (au-delà de 1800, `deploy.sh` refuse ; ce n'était qu'un avertissement avant le 22 novembre) ;
  - **registres des connexions vers `/dev/null`** : hors de tout journal et quel que soit `LogLevel`, l'adresse de chaque connexion réussie va dans un registre (`last`), et sur Ubuntu 24.04 celle de chaque tentative avec un nom de compte inconnu (les robots) dans `/var/log/btmp` (`lastb`), sur le disque. **Ubuntu 24.04** : `sshd` écrit lui-même `/var/log/wtmp`, `/var/log/btmp` et `/var/log/lastlog`. Les remplacer par des liens vers `/dev/null`, à chaque démarrage aussi :

    ```sh
    install -m 0644 deploy/systemd/00-shhdrop-connexions.conf /etc/tmpfiles.d/
    systemd-tmpfiles --create /etc/tmpfiles.d/00-shhdrop-connexions.conf   # remplace les fichiers par les liens
    rm -f /etc/logrotate.d/wtmp /etc/logrotate.d/btmp /var/log/wtmp.1 /var/log/btmp.1
    ```

    Le préfixe 00 l'emporte sur les lignes de `/usr/lib/tmpfiles.d/var.conf` qui recréent ces fichiers (essayé avec systemd 255, celui d'Ubuntu 24.04) ; sans les règles de logrotate, rien ne remet de fichier à la place des liens. `sshd` n'en souffre pas (il écrit dans `/dev/null`, ou saute le registre qui n'est pas un fichier) ; `last`, `lastb` et l'accueil « Last login » n'affichent plus rien. **Ubuntu 26.04** (si `wtmpdb` et `lastlog2` remplacent ces fichiers : bases `/var/lib/wtmpdb/wtmp.db` et `/var/lib/lastlog/lastlog2.db`, écrites par les modules PAM `pam_wtmpdb` et `pam_lastlog2`) : `pam-auth-update --disable wtmpdb lastlog2` (retire ces modules de `common-session`), `systemctl mask wtmpdb-update-boot.service`, puis `rm -f /var/lib/wtmpdb/wtmp.db /var/lib/lastlog/lastlog2.db`. Les deux versions : aucune ligne active `pam_lastlog.so`, `pam_lastlog2.so` ni `pam_wtmpdb.so` dans `/etc/pam.d/sshd`, `common-session` ni `common-session-noninteractive` (retirer ou commenter la ligne). Ces modules ne font qu'écrire le registre : la connexion n'en dépend pas, mais **vérifier depuis une deuxième session SSH** que l'on se connecte encore avant de fermer la première. `deploy.sh` refuse si l'un des trois fichiers de `/var/log` existe sans être un lien vers `/dev/null` (même vide : `sshd` y écrirait), si une des deux bases est un fichier non vide, si un de ces modules est actif, ou si une règle logrotate `wtmp` ou `btmp` reste ;
- **heure** synchronisée (NTP : `timedatectl set-ntp true`) ;
- **mises à jour de sécurité automatiques**, sans redémarrage automatique de la machine (`unattended-upgrades`, `Automatic-Reboot "false"`, §22) ;
- compte (§12) : paquets `sqlite3` et `age` (version exacte, notée dans `deploy/.env`), `curl` ;
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
install -d -o 65532 -g 65532 -m 0700 /srv/shhdrop/caddy
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

### Surveillance (22 novembre)

- **Sonde externe** (`.github/workflows/sonde.yml`) : toutes les 15 min, GitHub vérifie que l'accueil répond en HTTPS et que le certificat a encore au moins 14 jours (Caddy n'écrit aucun journal : un renouvellement raté ne se verrait pas autrement). Un échec : e-mail de GitHub. À activer après la mise en ligne : variable du dépôt `SHH_SONDE_HOTE` (ex. `shhgone.com`).
- **Alerte de la machine** (`deploy/alerte.sh`, minuteur `systemd/shhdrop-alerte.timer`, toutes les 15 min ; banc d'essai `deploy/test-alerte.sh`, en CI) : e-mail à `SHH_ALERTE_A` (dans `deploy/.env`, par exemple `contact@shhgone.com`) pour prévenir **avant** que le problème n'arrive. Chaque sujet revient au plus une fois par période : 1 h pour l'urgent, 1 jour ou 7 jours pour ce qui se prévoit.
  - **URGENT** : machine redémarrée (accès possible : vérifier avant de déverrouiller) ; volume chiffré verrouillé ; certificat inconnu dans les journaux publics ; serveur muet ; 5 signalements dans l'heure ; conteneur malade ; disque (données ou système) ou inodes à 90 % ; mémoire disponible sous 10 % ; certificat TLS à moins de 7 jours ; domaine ou location du serveur à moins de 7 jours de l'échéance ; nom de domaine qui ne pointe plus vers la machine (détournement, expiration) ; aucune sauvegarde réussie depuis 26 h ; disque qui annonce une panne (`smartctl`, paquet `smartmontools`).
  - **À prévoir** : disque à 75 %, ou plein dans moins de 14 jours au rythme du jour ; certificat à moins de 21 jours (Caddy renouvelle à 30 : le renouvellement échoue) ; domaine ou location à moins de 45 jours ; échéance du domaine illisible ; mises à jour de sécurité du système en attente ; redémarrage demandé ; commits de retard sur GitHub (correctif à déployer) ; horloge non synchronisée ; unité systemd en échec ; charge trop haute.
  - **Rappel** tous les 30 jours : essayer une restauration (§12). **Bilan** chaque semaine, même sans problème (disque, jours restants du certificat, du domaine et de la location, mises à jour, retard) : s'il n'arrive pas, c'est l'alerte qui ne marche plus (fournisseur d'envoi, minuteur).
  - Réglages : `SHH_SERVEUR_ECHEANCE` (fin de la location, à remettre à jour après chaque renouvellement), `SHH_DOMAINE_ECHEANCE` seulement si RDAP ne répond pas. L'échéance du domaine se lit par RDAP (`rdap.org`, qui renvoie au registre : seul le nom du domaine, public, est envoyé). Le retard sur GitHub suppose que la copie du dépôt est un clone `git` lisible par root (`git config --global --add safe.directory /opt/shhdrop`).
  - Envoi depuis la machine (pas depuis le conteneur, qui n'a pas de sortie) par un fournisseur SMTP : `SHH_ALERTE_SMTP_HOST` (TLS implicite sur 465), avec un **identifiant réservé aux alertes** (par exemple `alertes@shhgone.com`, envoi seulement) dans `SHH_ALERTE_SMTP_USER`, et `SHH_ALERTE_FROM`. Le mot de passe va dans `/etc/shhdrop/alerte_smtp_mdp` (`install -d -m 0700 /etc/shhdrop`, fichier root 0600), hors du volume chiffré pour que l'alerte parte même volume verrouillé après un redémarrage. Un envoi raté est retenté au passage suivant. Avant le 22 novembre, ces réglages s'appelaient `SHH_SMTP_HOST` et `SHH_MAIL_FROM` et servaient aussi au compte. Ces noms sont maintenant refusés : les renommer. Ce mot de passe est sur le disque système, en clair : quelqu'un qui lirait ce disque pourrait envoyer des e-mails avec, rien d'autre, d'où un identifiant à part, que l'on change s'il fuit. Aucune donnée d'utilisateur ni adresse IP dans les e-mails ni dans l'état (`/var/lib/shhdrop-alerte` : des dates et un pourcentage par jour). Santé lisible à la main : `deploy/deploy.sh health`.
- Les **demandes des autorités** (Pharos, injonctions) arrivent à `contact@shhgone.com` : notification activée sur le téléphone. Chaque demande traitée va au registre des retraits (`docs/juridique/registre-retraits-modele.md`, tenu hors du serveur).

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
3. Réinstaller le serveur depuis zéro (nouvelle machine, nouveau volume chiffré, §1 et §2). Ne pas reprendre `/srv/shhdrop/caddy` : nouvelles clés TLS, et révoquer les anciens certificats. Compte activé : la **clé du serveur** (§12.2) est à tenir pour connue de l'attaquant, avec `comptes.db`. Il peut alors tester des pseudos un à un. Il ne peut ni ouvrir les coffres, ni se faire passer pour une passkey, ni utiliser une clé de récupération : `v_r` est l'empreinte d'un secret de 128 bits. Elle ne peut pas être changée sans perdre l'unicité des pseudos existants (conception §5.2) : la décision revient au propriétaire, avant de reprendre la base. Changer aussi l'identifiant SMTP des alertes et l'accès au stockage des sauvegardes.
4. Publier un avis sur le site.
5. **Violation de données personnelles (RGPD art. 33 et 34 ; ajouté le 24 novembre).** Elle est probable dès qu'un tiers a pu lire `comptes.db` (pseudos sous forme d'empreinte, clés publiques des passkeys, `v_r`, coffres chiffrés), `paiements.db` (empreintes des pass, commandes, références des prestataires) ou une de leurs sauvegardes, ou dès que le serveur a été pris (il voit en direct les adresses IP, les pass `P` aux routes du paiement, et peut servir un code du site modifié qui lirait les clés des visiteurs). Les partages et les salons sont chiffrés sur l'appareil : leur seule lecture n'est pas, en soi, une violation à risque, sauf code du site modifié.
   - **Notifier la CNIL dans les 72 heures** après en avoir eu connaissance (art. 33), par le téléservice de notification de la CNIL, même incomplet (on complète ensuite). Au-delà de 72 h, dire pourquoi. Pas de notification seulement si la violation n'engendre **aucun risque** pour les personnes (par exemple, seules des données chiffrées illisibles, clés non touchées) : la raison s'écrit au registre.
   - **Informer les personnes concernées** quand le risque est **élevé** (art. 34), sans tarder, en termes simples : ce qui s'est passé, ce qui est touché, ce qu'il faut faire (par exemple, ne plus utiliser le site jusqu'à l'avis de fin d'incident, recréer un partage ou un salon, ranger de nouveau son pass). Nous n'avons **ni e-mail ni téléphone** de personne : l'information passe par un **avis sur le site** (page d'accueil, page Sécurité), gardé en ligne aussi longtemps que nécessaire, ce que l'art. 34.3 c permet quand une information individuelle est impossible. Inutile si les données touchées étaient illisibles pour un tiers (art. 34.3 a).
   - **Tenir le registre des violations** (art. 33.5), hors du serveur, comme le registre des retraits : modèle `docs/juridique/registre-violations-modele.md`. Toute violation y entre, même sans notification.

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
make lint-deploy                                  # bash -n, ShellCheck, bancs de l'alerte et des journaux, go vet et tests de shhcheck
SHH_IMAGE=shhdrop:ci make test-sortie             # sorties : configuration, puis réseau réel (démon Docker ; code 3 sans démon)
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
- ~~**Surveillance (§15.2)** : ni sonde externe, ni script horaire d'alerte.~~ **22 novembre** : sonde externe et alerte de la machine en place (§4, « Surveillance »).
- **Déverrouillage (§22)** : pas de `deploy/unlock.sh` ; les trois commandes du §5 en tiennent lieu. Pas d'alerte « redémarrage nécessaire ».
- **Dates et tailles des fichiers** (audit adverse du 13 novembre, stockage, F4). Les dates de contenu et d'accès sont au 1er janvier 1970 ; la date de changement d'inode (`ctime`) de tous les fichiers est ramenée, une fois par minute, à l'heure de ce passage. Restent lisibles par qui lit le disque déverrouillé : la **date de création** (`btime`, sur ext4) de chaque fichier de partage, de pièce et de conversation, qu'aucun appel système ne permet de changer, donc l'heure de création de chaque partage vivant et du premier message de chaque salon ; pendant une minute au plus, le `ctime` d'un fichier qui vient d'être écrit ; la taille d'une conversation, par paliers de 64 messages (plus le nombre exact) ; l'ordre de création (numéros d'inode). Le dossier de données lui-même, `frozen`, `kill/`, `kill.key`, `shares.db`, `shares.db-wal` et `shares.db-shm` ont, depuis la 3ᵉ campagne de l'audit adverse (stockage, F5), leurs dates de contenu et d'accès remises à l'epoch à chaque passage du janitor (une fois par minute) et leur `ctime` ramené à l'heure de ce passage : l'heure du dernier gel, dégel, destruction par l'administrateur ou écriture en base ne se lit plus qu'à la minute près ; un gel et un dégel remettent aussi les dates aussitôt. Restent : la **date de création de `frozen`**, qui donne l'heure du gel en cours tant qu'il dure, et celle de `kill/`, créé au premier passage du serveur (heure du démarrage, sans rapport avec une destruction). Seuls le volume chiffré et l'absence d'instantanés les protègent.
- **Sauvegardes** : aucune pour les partages et les salons, et c'est voulu. La spécification les interdit pour les données (§9.2 : « aucune sauvegarde de ce dossier ») : des partages chiffrés qui vivent 24 h n'ont rien à restaurer, et une sauvegarde garderait ce qui doit disparaître. **Seules exceptions : `comptes.db` (compte activé) et `paiements.db` (paiement activé)**, chiffrées chaque jour (§12.4 ; conception du compte §21.13, décision du propriétaire du 14 novembre ; conception du paiement §5.1, S11 : perdre `paiements.db` rendrait inutilisables les pass payés). À sauvegarder ailleurs que sur le serveur : `deploy/.env` et la phrase du volume, plus, compte activé, la **clé du serveur** (§12.2), chacun à part. `deploy/.env` ne contient aucun secret qui ouvre quoi que ce soit : avec le tableau de bord, seulement l'**empreinte** du jeton (§4), qui ne permet pas de le retrouver ; le jeton lui-même se garde dans le gestionnaire de mots de passe de l'exploitant, jamais avec cette sauvegarde. Un `SHH_ADMIN_TOKEN` en clair n'y a pas sa place (le serveur refuse de démarrer avec lui, §4). Le dossier `caddy/` se recrée seul (nouveau certificat).
- **Durcissement de la machine** : les réglages du §1 (journald, pare-feu, SSH, mises à jour) sont à faire à la main ; aucun script ne les pose. `deploy.sh` en vérifie une partie et refuse d'installer sinon : `noatime`, la mémoire d'échange, Caddy non root, et depuis le 22 novembre les journaux (aucun syslog, journald en mémoire une heure au plus, `sshd` en `LogLevel QUIET` sans mot de passe, `ufw logging off`, suivi des connexions à 30 min ; `journaux.sh`), registres des connexions vers `/dev/null` et minuteur de purge du journal (§1). Ne sont pas vérifiés : le pare-feu lui-même, les mises à jour automatiques, l'heure.
- **Hébergeur** : il voit les adresses IP et peut lire la mémoire de la machine. Hors de portée (§18.3).
- ~~**Caddy tourne en root dans son conteneur**~~ **Corrigé le 22 novembre (D9, voie (a))** : compte 65532, aucune capacité, réglage de la machine `net.ipv4.ip_unprivileged_port_start=80` (§1) ; essayé avec l'image épinglée (Caddy répond sur 80 et 443 en 65532 ; sans le réglage, refus « permission denied »). Historique de la décision : (audit du 13 novembre, D9). Il n'a aucune capacité sauf `NET_BIND_SERVICE` (écouter sur 80 et 443), sous `no-new-privileges`, avec un système de fichiers en lecture seule. Le passer en `user: "65532:65532"` ne marche pas avec l'image officielle épinglée : son binaire porte la capacité de fichier `cap_net_bind_service=+p` (lu dans la couche `sha256:5000c332…` de `caddy:2.11.9` : attribut `security.capability`, bit « effectif » absent), et `no-new-privileges` fait de toute façon ignorer les capacités de fichier. Un Caddy non root ne pourrait donc pas écouter sur 443. Deux voies, à choisir : (a) `sysctl net.ipv4.ip_unprivileged_port_start=80` sur la machine (réglage global : tout processus de la machine pourrait alors prendre 80 ou 443 pendant un redémarrage de Caddy ; `network_mode: host` interdit de le poser pour le seul conteneur), puis `user: "65532:65532"` et le dossier `caddy/` donné à 65532 ; (b) garder root, comme aujourd'hui.
- **Confiance accordée à `X-Shh-Client-IP`** : le serveur Go croit cet en-tête, qui donne l'adresse du client pour les limites, de la seule passerelle `172.30.53.1/32` (`SHH_TRUSTED_PROXY`, `compose.yaml`), c'est-à-dire de la machine où Caddy écoute. **Tout processus de la machine** peut donc joindre `172.30.53.2:8080` et annoncer l'adresse qu'il veut : il contourne toutes les limites par adresse (quotas, places, salons). C'est accepté : la machine ne doit faire tourner que `sshd`, Docker, Caddy et le serveur, et un accès à la machine donne déjà bien plus (mémoire, volume déverrouillé). Caddy, lui, remplace toujours l'en-tête par l'adresse du pair TCP (`header_up X-Shh-Client-IP {remote_host}`, contrôlé par `test-proxy.sh`) ; un pair qui n'est pas la passerelle reçoit 500 (échec fermé).
- **Envoi complet à travers Caddy** : `test-proxy.sh` prouve le relais (`/api/captcha`, corps d'un segment, en-têtes, octets), pas la création puis l'ouverture d'un partage par un navigateur. À faire à la main après la première installation (tests manuels de la §14).
- **WebSocket du salon** : `test-proxy.sh` le garde ouvert 75 s à travers Caddy, en HTTP/1.1. Un WebSocket par HTTP/2 (RFC 8441, que certains navigateurs emploient) n'est pas essayé, et l'essai court ne dépasse pas les délais de Caddy : la première coupure possible est à **5 min** (`read_body 5m`). L'essai long se lance avec `SALON_GARDE=660`. Conditions bloquantes d'activation : §10.

## 10. Salon (activé)

Le salon (spécification §39 et `docs/superpowers/specs/2026-11-11-salon-v3-design.md`) est **activé et ouvert au public dès le premier déploiement** (décisions du propriétaire du 19 et du 24 novembre ; le compte, ouvert le même jour, l'exige) : `compose.yaml` pose `SHH_SALONS: "1"`. **Risque assumé par le propriétaire** (24 novembre) : ouverture sans l'avis du juriste sur l'hébergement des conversations chiffrées (Q-SAL8, §39.7) et sans le passage manuel sur appareils réels. Le couper : `SHH_SALONS: "0"` (et `SHH_COMPTES: "0"`, qui l'exige). Avec `SHH_SALONS=0`, aucune route `/api/salons/*` n'existe (même réponse 404 qu'une route inconnue).

Variables :

| Variable | Valeur | Rôle |
|---|---|---|
| `SHH_SALONS` | `0` (défaut) ou `1` | active les routes du salon et son WebSocket |
| `SHH_ORIGIN` | `https://${SHH_DOMAIN}` (posée par `compose.yaml`) | origine publique du site, comparée **exactement** à l'en-tête `Origin` du WebSocket et copiée dans la CSP (`connect-src … wss://hôte`). Obligatoire avec `SHH_SALONS=1`. Forme exigée : `https://hôte[:port]` en minuscules, sans chemin ni barre finale, port par défaut omis ; `http://` seulement pour `localhost` ou `127.0.0.0/8` ; IPv6 refusé, `http://[::1]` compris (la CSP ne l'accepte pas) |
| `SHH_SALONS_MAX` | 1 à 10 000, défaut 200 | salons vivants au plus ; **50 proposé pour un usage personnel** (`deploy/.env`) |

À savoir avant d'activer :

- **Conditions d'activation prévues à l'origine** (le propriétaire a ouvert le salon sans attendre la première, risque assumé le 24 novembre ; les deux essais restent à passer et à refaire à chaque changement de Caddy) : (1) l'avis du juriste (Q-SAL8) ; (2) un **essai long** du WebSocket à travers Caddy, au-delà de la première coupure possible à 5 min (`read_body 5m`) : `SALON_GARDE=660 CADDY=… make test-proxy`, réussi avec le Caddy de l'image épinglée ; (3) un **essai dans WebKit et dans Chromium à travers Caddy en HTTP/2**, mise à niveau par la RFC 8441 comprise (parcours du salon de C-3). Spec v3 §3.6.1, exigence C-3 21.

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

**Sortie par partage** (décision du propriétaire du 24 novembre, avant la première vente) : `SHH_SHARE_EGRESS_MAX`, en octets, **250 Gio par défaut** (268 435 456 000), au moins 32 Gio (un téléchargement complet du plus grand partage payant, 30 Go). Un partage, toutes ouvertures confondues, ne sert pas plus que ce plafond ; ensuite le serveur refuse ses segments (403 `egress_limit`) et toute nouvelle ouverture dont le téléchargement complet ne tiendrait plus (403 `egress_limit`, sans consommer d'ouverture ni d'essai ; seulement après le bon mot de passe). Le compteur vit **en mémoire seulement** (aucune colonne, aucune adresse) : un redémarrage le remet à zéro, mais invalide aussi tous les jetons, et chaque lecteur doit alors consommer une nouvelle ouverture. Un partage gratuit (2 Go, 5 ouvertures) ne l'atteint jamais ; un Plus (10 Go, 10 ouvertures) seulement en relisant beaucoup ; un Pro de 30 Go sert environ 8 téléchargements complets (au lieu de 20 × 5 lectures possibles, environ 3 To, avant). Baisser la valeur réduit la facture de sortie au pire ; la monter (600 Gio : 30 Go × 20 ouvertures) rend au Pro toutes ses ouvertures complètes. Spec §38.6, §38.8.1.

**Débit par expéditeur** : `SHH_SEGMENTS_PER_MIN` (1 500 par défaut, 600 avant le 13 novembre) est la seule limite par personne réglable ici : requêtes de segments de 4 Mio par minute et par connexion (10 fois plus par /48), soit environ 840 Mbit/s par expéditeur. La baisser protège la bande passante de la machine ; la monter ne sert qu'au-delà de 1 Gbit/s.

`SHH_DISK_OPS_MAX` borne les fils du système bloqués sur le disque (audit du 13 novembre, D4) : 1,5 fois sa valeur au pire (partages et pièces, plus les écritures et les lectures des conversations ; 96 fils par défaut), quel que soit le nombre de connexions (`SHH_WS_MAX` ne compte plus : les lectures du rattrapage attendent leur tour). **Contrôle au démarrage** : si ce total dépasse la moitié de `pids_limit` (lu dans `/sys/fs/cgroup/pids.max` ; 1 024 dans `compose.yaml`), le serveur refuse de démarrer (message `… plus de la moitié de pids_limit`) : baisser `SHH_DISK_OPS_MAX` ou relever `pids_limit`. Chaque autre catégorie a au plus `nofile / 8` places (une lecture ou un envoi tient 2 descripteurs) ; une valeur réglée au-delà empêche le serveur de démarrer (message `… dépasse la limite de descripteurs`), au lieu de le faire tomber sous la charge.

**Règle de sûreté** : ne monter `SHH_UPLOADS_MAX` qu'avec la mémoire. Chaque envoi garde 4 Mio, que le ramasse-miettes peut doubler : au-delà de `mem_limit`, le noyau tue le serveur (envois en cours perdus). Pour une machine plus grosse, monter `mem_limit` et `GOMEMLIMIT` ensemble (`GOMEMLIMIT` ≈ 90 % de `mem_limit`) et laisser les places se recalculer.

**Mémoire du salon** (audit adverse du 13 novembre) : l'index des trames en mémoire est borné **globalement** par `SHH_SALON_FRAMES_TOTAL` (calé sur `GOMEMLIMIT`), tous salons confondus, en plus du plafond par salon. Monter `SHH_SALONS_MAX` ne peut donc plus faire tuer le serveur faute de mémoire : au pire, des salons reçoivent `0x0C` « plein » plus tôt. **Part de chaque salon** (2ᵉ passage de l'audit, F3) : la moitié de ce plafond est réservée à parts égales entre les `SHH_SALONS_MAX` salons possibles (4 915 trames par salon avec les valeurs livrées) ; un salon n'est jamais refusé sous sa part, quoi que fassent les autres ; l'autre moitié est un pot commun. **Limite connue du pot commun** (audit adverse du 13 novembre, 3ᵉ campagne, F) : un salon plein en prend 95 085 trames ; **11 salons pleins le vident** (3 blocs /48 ou 3 adresses IPv4 à 5 salons chacune, environ 7 h de remplissage à 10 sièges). Les autres salons retombent alors à leur part (4 915 trames depuis leur dernier renouvellement, **trames effacées comprises** : l'index ne rétrécit pas tant que le salon vit), qu'un salon de 10 membres au débit permis épuise dans sa première rafale ; ils reçoivent `0x0C` « plein » jusqu'à la fin ou au renouvellement des salons pleins. Aucune correction simple et sûre n'existe dans le code actuel : retirer de l'index les trames effacées changerait le rattrapage, et borner la part d'un bloc dans le pot demande un compte par bloc tenu sous les verrous de chaque salon. Choix du propriétaire, à reprendre dans la spécification (§18). Parades d'exploitation : `SHH_SALONS_MAX` plus bas (part plus grande) ou `GOMEMLIMIT` plus haut. Le journal des annonces de chaque salon (256 Kio au pire) est hors de ce plafond : c'est le contrôle de démarrage de `SHH_SALONS_MAX` qui le borne (§1). Comme pour les envois, c'est `GOMEMLIMIT` qui fait monter ce plafond avec la machine.

**Part équitable** (audit du 13 novembre, D2) : en plus de ses propres limites, une connexion ou un bloc /48 (une adresse en IPv4) prend au plus **1/8** de chaque plafond global, et le **dernier quart** des places (envois, lectures, surveillances, WebSocket, salons) ne va qu'à un bloc qui n'en tient aucune. Le **dernier huitième du stockage** ne va qu'à une adresse qui n'a rien créé ni envoyé aujourd'hui (UTC) ; un agrandissement et une pièce du salon n'y entrent jamais ; une adresse ne réserve pas plus de `SHH_STORAGE_MAX / 8` octets par jour. Un salon où personne n'est entré est effacé 15 min après sa création. Adresses IPv4 nécessaires pour tout prendre, avec `compose.yaml` : envois 23 (8 avant), lectures 107 (16 avant), salons (200) 80 qui y entrent (40 avant, sans y entrer), stockage environ 43 (34 avant). Ces seuils restent atteignables par un attaquant qui dispose de beaucoup d'adresses : ce sont des limites assumées, à reporter dans la spécification (§18).

## 12. Compte par passkey : clé du serveur, sauvegarde

Le compte est **activé** (décision D8 du propriétaire, 19 novembre). Depuis le 22 novembre, il fonctionne **sans e-mail** : une passkey et une clé de récupération (conception `docs/superpowers/specs/2026-11-22-compte-passkey-design.md`, qui remplace la partie e-mail de `2026-11-14-compte-email-design.md`). `compose.yaml` pose `SHH_COMPTES: "1"`, et le site de l'image est construit avec le compte (`deploy/Dockerfile`, `SHH_SITE_COMPTES=1`, `check-dist.mjs --comptes`).

**Ouvert au public dès le premier déploiement** (décision du propriétaire, 24 novembre). **Risque assumé par le propriétaire** : ni l'avis du juriste sur la conservation des données de création de compte (LCEN et décret 2021-1362 ; conception §12), ni le passage manuel sur appareils réels (conception par passkey §14) n'ont été faits avant l'ouverture.

Avec `SHH_COMPTES: "0"` : aucune route `/api/compte/*` et aucun fichier lu dans `secrets/` pour le compte.

### 12.1 Plus de sortie SMTP

Le serveur Go reste sur le réseau Docker `interne` (`internal: true`), **sans aucune route vers Internet**. Il n'envoie plus aucun e-mail : le relais `relais-smtp`, son profil Compose `comptes` et ses variables ont disparu. Les seules sorties du serveur qui restent sont celles du paiement (§13).

Garde-fous :
- le serveur refuse de démarrer si une ancienne variable `SHH_SMTP_*` ou `SHH_MAIL_FROM` est encore posée ;
- `deploy.sh` refuse ces variables dans `deploy/.env` ;
- `deploy.sh` refuse aussi un fichier `secrets/shh_smtp_mdp` resté en place : l'effacer avec `shred -u`, puis révoquer le mot de passe chez l'ancien fournisseur.

Le relais générique (`/shhcheck relais`, `shhcheck/relais.go`) sert toujours au paiement.

Tests :
- `make test-sortie` : configuration résolue (aucun relais SMTP, serveur sur `interne` seul ; relais du paiement, §13) ;
- `make lint-deploy` : tests du relais.

**Nom du site.** Le `rp.id` des passkeys découle de `SHH_ORIGIN`. Une passkey créée pour un nom ne marche jamais pour un autre, et changer de domaine perdrait toutes les passkeys. Avec `SHH_COMPTES=1`, `deploy.sh` refuse donc tout autre nom que `shhgone.com`. Pour les apps futures, le serveur lit `SHH_APPLE_APP_IDS`, `SHH_ANDROID_APP_PACKAGE` et `SHH_ANDROID_APP_SHA256` : les fichiers d'association ne sont servis que si ces variables sont posées. Elles ne sont pas encore dans `compose.yaml` ; les y ajouter quand une app existera (conception §6.5).

### 12.2 Secret : clé du serveur

Un fichier dans `/srv/shhdrop/secrets/`. Ce dossier est sur le volume chiffré, **hors** de `data/`, donc hors de la sauvegarde ; il est monté en lecture seule dans `/run/secrets` du serveur.

Le dépôt, `deploy/.env`, la configuration du conteneur (`docker inspect`) et l'environnement du processus n'en contiennent que le **chemin**.

Compte activé, `deploy.sh` refuse d'installer si le fichier manque ou n'a pas exactement ces droits. Le serveur refuse aussi de démarrer (clé de 32 octets, droits 0400 ou 0600).

```sh
install -d -o root -g 65532 -m 0750 /srv/shhdrop/secrets   # déjà fait au §2
cd /srv/shhdrop/secrets
# Clé du serveur K_serveur : 32 octets tirés au hasard, une fois pour toutes.
(umask 077 && head -c 32 /dev/urandom > shh_comptes_cle)
chown 65532:65532 shh_comptes_cle && chmod 0400 shh_comptes_cle
```

**Elle ne sert plus qu'aux pseudos.** Le serveur en tire `K_pseudo`, qui sert à calculer l'empreinte `p_empreinte`, garante de l'unicité d'un pseudo sans le garder en clair. Elle n'ouvre aucun coffre, ne vérifie aucune passkey et ne retrouve aucun compte.

Si elle est perdue :
- les comptes restent utilisables (passkeys, clé de récupération, coffres) ;
- l'unicité des pseudos est perdue : un pseudo déjà pris ne se reconnaît plus, et deux personnes pourraient avoir le même.

Elle ne se change pas non plus (conception §5.2). Donc, dès sa création :

- **faire une copie hors ligne**, par exemple sur papier : `base64 < shh_comptes_cle` donne 44 caractères à recopier puis à relire ; effacer ensuite l'écran avec `clear`. Une clé USB chiffrée convient aussi. Pour la restaurer : `base64 -d > shh_comptes_cle`, puis les droits ci-dessus ;
- ranger cette copie **à part** de la clé privée age des sauvegardes (§12.4) : qui a les deux et une sauvegarde peut tester des pseudos un à un pour savoir s'ils ont un compte ;
- ne jamais la mettre dans le dépôt, dans `deploy/.env`, dans un gestionnaire de mots de passe synchronisé avec la machine, ni dans la sauvegarde.

### 12.3 Activer le compte (décision D8 prise)

1. Créer le secret du §12.2 et en faire la copie hors ligne.
2. Dans `deploy/.env`, mettre `SHH_DOMAIN=shhgone.com` et ne laisser aucune variable `SHH_SMTP_*` ni `SHH_MAIL_FROM` (modèle dans `env.example`). On peut y régler aussi `SHH_COMPTES_JOUR`, le plafond d'inscriptions par jour pour tout le site (500 par défaut).
3. Dans `compose.yaml`, poser `SHH_SALONS: "1"` et `SHH_COMPTES: "1"` (fichier relu et commité, comme pour le salon).
4. Lancer `deploy/deploy.sh sha256:<empreinte>` : le secret est contrôlé.
5. Installer la sauvegarde du §12.4 **le même jour**, puis essayer une restauration (§12.5).

Désactiver : poser `SHH_COMPTES: "0"`, puis lancer `deploy.sh`. `comptes.db` reste intacte sur le volume.

### 12.4 Sauvegarde quotidienne chiffrée de `comptes.db` et de `paiements.db`

Ce qui est sauvegardé : **`comptes.db`** (comptes, sessions, bannis) et **`paiements.db`** (empreintes des pass, commandes en attente, références des prestataires, jetons dépensés des deux derniers jours ; aucune identité, aucun montant, aucun pays ; les **clés privées d'émission des jetons sont retirées de la copie** avant le chiffrement, `VACUUM` compris), chacune dans son propre fichier ; une base absente (compte ou paiement désactivé) est sautée. Jamais `shares.db`, les fichiers des partages, les salons, les conversations, ni la clé du serveur. Comment (`sauvegarder.sh`, minuteur `systemd/shhdrop-sauvegarde.timer`, chaque jour vers 03:17 UTC) : copie cohérente par `sqlite3 .backup`, serveur en marche (sous le compte 65532, dans `/srv/shhdrop/sauvegarde/` : le clair ne quitte jamais le volume chiffré, refus sinon) ; `PRAGMA integrity_check` ; chiffrement par **age** (`age-encryption.org/v1`, X25519) vers la clé **publique** de l'exploitant ; clair effacé aussitôt ; envoi du seul chiffré, nommé `comptes-AAAA-MM-JJTHHMMSSZ.db.age` et `paiements-AAAA-MM-JJTHHMMSSZ.db.age`, sous le même `SHH_SAUVEGARDE_URL`. Aucune crypto maison, rien dans le serveur Go. La lecture de la base dure environ une seconde ; si une suppression de compte tombe pendant ce temps, son vidage du journal (`comptes.db-wal`) attend le suivant (au plus la passe quotidienne).

Mise en place, une fois :

1. **Outils** sur la machine : `apt install sqlite3 age curl` (ou `age` construit depuis ses sources ou paquet signé), puis `age --version` recopié dans `deploy/.env` (`SHH_AGE_VERSION`) : le script refuse une autre version.
2. **Clés age, sur le poste de l'exploitant** (jamais sur la machine) : `age-keygen -o sauvegarde.cle` (la ligne `Public key: age1…` est la clé publique), idéalement protégée par une phrase : `age-keygen | age -p > sauvegarde.cle.age` (age demandera la phrase à chaque restauration). Clé publique dans `deploy/.env` (`SHH_SAUVEGARDE_DESTINATAIRE`). Clé privée **hors ligne** (papier ou clé USB chiffrée), **à part** de la copie de la clé du serveur (§12.2) : les deux sont nécessaires à une restauration.
3. **Stockage objet** chez un **autre fournisseur** que l'hébergeur, **dans l'UE** (contrat de sous-traitance) : un seau dédié ; **gestion des versions activée** (ou verrouillage d'objet, « Object Lock », 7 jours) : l'accès en écriture seule ne peut ni lire ni effacer, mais sans versions il pourrait **écraser** une copie sous le même nom ; **règle de cycle de vie : effacer les objets (et leurs anciennes versions) après 7 jours** (rotation de 7 copies, dite dans la page Confidentialité, conception R18 ; 30 jours avant le 22 novembre, réduit par le propriétaire : garder le moins longtemps) ; un **compte d'accès en écriture seule** (droit `PutObject` sur ce seau seulement : ni lecture, ni liste, ni effacement), pour qu'un pirate de la machine ne puisse ni lire ni détruire les copies. Un **second accès, en lecture**, reste sur le poste de l'exploitant, pour les restaurations.
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

À savoir : le volume doit avoir deux fois la taille de `comptes.db` de libre (clair puis chiffré, un instant) ; au pire 10 000 comptes × deux coffres de 256 Kio ≈ 5 Go. Une sauvegarde ratée se voit dans `systemctl status shhdrop-sauvegarde.service` et, après 26 h sans réussite, par l'alerte (§4, « Surveillance » : `sauvegarder.sh` écrit l'heure de sa dernière réussite dans `/var/lib/shhdrop-sauvegarde/ok`) ; vérifier aussi chaque semaine qu'un objet du jour est arrivé (accès en lecture). Machine redémarrée : rien n'est sauvegardé tant que le volume n'est pas déverrouillé (refus du script).

**Ce que voit le fournisseur de stockage** : la taille de chaque copie et l'heure d'envoi (conception S79), jamais le contenu. **Effet sur le droit à l'effacement** : un compte supprimé reste dans les copies jusqu'à 7 jours (dit dans la page Confidentialité, conception §21.13).

### 12.5 Restauration

**Essai mensuel** (décision du propriétaire du 14 novembre), sur le poste de l'exploitant (Linux : `age`, `sqlite3`, `/dev/shm`) : télécharger la copie la plus récente avec l'accès en lecture, puis

```sh
deploy/restaurer.sh verifier comptes-<date>.db.age sauvegarde.cle   # « intégrité : ok ; schéma 3 ; N comptes »
deploy/restaurer.sh verifier paiements-<date>.db.age sauvegarde.cle # « intégrité : ok ; base des paiements ; schéma 2 ; N pass »
```

(déchiffrée en mémoire, `/dev/shm`, puis effacée ; rien n'est installé). À chaque changement du schéma de `comptes.db`, et à chaque changement des scripts : `sudo make test-restauration` (compte de test créé par le vrai serveur avec une passkey logicielle, sauvegarde serveur en marche, effacement, restauration, reconnexion par la passkey réussie ; avec une autre clé du serveur, la connexion réussit aussi : la clé ne sert plus qu'aux pseudos ; puis `paiements.db` créée par le serveur avec le paiement en bac à sable, un pass factice sauvegardé sans son empreinte en clair ni clé de jetons, restauré).

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
4. Se connecter avec un compte de contrôle (sa passkey).

Règles et effets :

- **toujours la plus récente** : les suppressions de comptes antérieures y sont appliquées ; une copie plus ancienne ferait revenir des comptes supprimés (interdit par la procédure, conception §21.13) ;
- **toutes les sessions sont effacées** à la restauration : chacun se reconnecte (une session fermée depuis la sauvegarde, après un vol par exemple, ne revient pas) ;
- **ce qui a changé depuis la sauvegarde est perdu** (24 h au plus) :
  - **une passkey retirée depuis revient**, par exemple celle d'un appareil volé ;
  - **une clé de récupération renouvelée revient à l'ancienne** ;
  - une passkey ajoutée disparaît ;
  - un compte créé disparaît ;
  - **un compte supprimé depuis revient** ;
  - un bannissement posé depuis disparaît.

  Aucun moyen de prévenir les personnes : le serveur n'a aucune adresse. L'avis sur le site (§6) leur demande de vérifier leurs passkeys et, au besoin, de retirer de nouveau une passkey et de renouveler leur clé de récupération. À noter dans le registre de l'incident ; un bannissement se repose depuis le tableau de bord ;
- partages et salons d'avant la perte sont perdus (éphémères, jamais sauvegardés), le lien compte ↔ salon aussi ;
- **paiements** : la copie n'a **aucune clé de jetons** (retirées à la sauvegarde, et encore à la restauration ; de nouvelles sont tirées à la première demande) : tout jeton émis avant ne passe plus (un jeton dépensé depuis la sauvegarde ne peut donc pas resservir) ; chacun en reprend sans rien faire, dans la limite du jour. **Un pass payé depuis la sauvegarde est inconnu de la copie** (24 h au plus) : sa commande aussi, et un webhook rejoué ensuite ne le recrée pas. La personne le signale au contact avec la date, le montant et le moyen de paiement ; l'exploitant retrouve le paiement dans le tableau de bord du prestataire (qui, lui, connaît l'acheteur) et le rembourse : rien chez nous ne relie un pass à une personne. Une révocation posée à la main depuis la sauvegarde (`shhdrop admin paiement revoquer`) disparaît : la reposer.

## 13. Paiement des offres Plus et Pro (désactivé) : relais de sortie, secrets, sauvegarde

Conception : `docs/superpowers/specs/2026-11-19-paiement-design.md`. **Désactivé** : `compose.yaml` pose `SHH_PAIEMENT: "0"` ; ce qui manque avant de l'activer est la liste du §13 de la conception (comptes chez les prestataires, régime de TVA, mentions légales des notes de vente, contrat et CGV). Avec `"0"` : aucune route `/api/paiement/*`, aucun fichier de `secrets/` lu pour le paiement, aucun relais de paiement, aucune connexion sortante de plus.

### 13.1 Sorties : un relais par prestataire

Un relais par sortie, pour échouer fermé (c'était aussi le modèle du relais SMTP du compte par e-mail, retiré le 22 novembre) : le serveur reste sur `interne` (`internal: true`), **sans route vers Internet, même paiement activé**. Pour chaque prestataire configuré, `deploy.sh` démarre son relais (même image, `/shhcheck relais`, 16 connexions à la fois, 60 s chacune au plus, compte 65532, lecture seule, sans capacité, aucun journal) :

| Relais (profil) | Adresse interne | Seule cible (production ; bac à sable avec `SHH_PAIEMENT_ESSAI: "1"`) |
| --- | --- | --- |
| `relais-stripe` (`paiement-stripe`) | 172.30.53.4:443 | `api.stripe.com:443` (le même en essai) |
| `relais-paypal` (`paiement-paypal`) | 172.30.53.5:443 | `api-m.paypal.com:443` (`api-m.sandbox.paypal.com:443`) |
| `relais-nowpayments` (`paiement-nowpayments`) | 172.30.53.6:443 | `api.nowpayments.io:443` (`api-sandbox.nowpayments.io:443`) |

Dans le conteneur du serveur, `extra_hosts` fait pointer chacun de ces noms vers son relais ; le serveur vérifie le certificat TLS pour ce nom (TLS de bout en bout : le relais ne voit que des octets chiffrés, leur taille et l'heure). Le client HTTP du paiement ouvre une connexion par appel (aucune connexion gardée que le relais couperait au milieu d'un paiement) et ne lit aucune variable de proxy. Les hôtes sont fixés par `deploy.sh` d'après `SHH_PAIEMENT_ESSAI` (dans `compose.yaml`), jamais par `deploy/.env`. Les webhooks des prestataires **entrent** par Caddy, comme le reste du site : rien à ouvrir pour eux. Défense de plus, facultative (comme §12.1) : n'autoriser depuis 172.30.53.8/29 que TCP 443 et la résolution DNS par la machine. **Limite** : un relais joint toute adresse que le DNS donne pour son hôte ; il ne choisit pas l'hôte.

Tests : `make test-sortie` (configuration résolue : relais, adresses, cibles, profils, aucun port publié, serveur sur `interne` seul ; avec un démon Docker : chaque API jointe à travers son relais en TLS vérifié, injoignable relais arrêté), `make lint-deploy` (tests du relais, dont son plafond de connexions).

### 13.2 Secrets et réglages

Fichiers de `<SHH_DATA_ROOT>/secrets` (compte 65532, droits 0400, comme §12.2), jamais des variables ; un prestataire est **configuré quand ses fichiers sont là** :

| Prestataire | Fichiers | Dans `deploy/.env` |
| --- | --- | --- |
| Stripe (carte) | `shh_stripe_cle` (clé secrète restreinte `rk_…`/`sk_…`), `shh_stripe_webhook` (`whsec_…`) | `SHH_STRIPE_TAXE=1` si Stripe Tax calcule la TVA |
| PayPal | `shh_paypal_secret` | `SHH_PAYPAL_CLIENT_ID`, `SHH_PAYPAL_WEBHOOK_ID`, `SHH_PAYPAL_PLANS` |
| NOWPayments (crypto) | `shh_nowpayments_cle`, `shh_nowpayments_ipn` | rien |

et, pour tous, `SHH_TVA` (`franchise`, `france` ou `oss` : régime choisi par le propriétaire avec son comptable ; en `oss`, la crypto n'est ni proposée ni acceptée, même avec les secrets NOWPayments en place, car elle ne donne qu'une preuve de localisation : décision du 24 novembre, conception du paiement §9.1 ; ses webhooks restent traités). Paiement activé, `deploy.sh` refuse d'installer sans `SHH_TVA`, sans aucun prestataire, ou si un fichier attendu manque, est un lien ou n'a pas le bon propriétaire et les bons droits. Le serveur, lui, refuse de démarrer avec une clé Stripe de production en essai ou l’inverse, ou un prestataire à moitié configuré (message sans valeur).

```sh
(umask 077 && cat > /srv/shhdrop/secrets/shh_stripe_cle)   # coller la clé, Entrée, Ctrl-D
chown 65532:65532 /srv/shhdrop/secrets/shh_stripe_cle && chmod 0400 /srv/shhdrop/secrets/shh_stripe_cle
```

### 13.3 Sauvegarde et restauration

`paiements.db` (empreintes des pass, commandes en attente, références des prestataires ; aucune identité, aucun montant, aucun pays ; jamais les clés privées des jetons) est sauvegardée **avec `comptes.db`**, chaque jour, dans son propre fichier chiffré (§12.4), et se restaure de la même façon (§12.5 : clés de jetons effacées ; un pass payé depuis la sauvegarde est à rembourser depuis le tableau de bord du prestataire). La sauvegarde doit être en place **le jour de l'activation** : perdre `paiements.db` rendrait inutilisables tous les pass payés.

## 14. Appels audio et vidéo du salon : relais TURN intégré

Conception : `docs/superpowers/specs/2026-11-20-appels-design.md`. Les appels sont **activés par défaut** et **rien n'est à installer**, ni sur la machine ni chez les utilisateurs : le relais fait partie de notre image (`/shhcheck turn`, `deploy/shhcheck/turn.go`, bibliothèque pion/turn épinglée), lancé par `compose.yaml` (service `relais-turn`, profil « appels »). **Depuis le 24 novembre, les appels sont réservés aux offres Plus et Pro** (conception des appels §5.1) : le serveur ne les propose (route `/api/salons/appel`, `calls: true`, boutons) que si le paiement est aussi ouvert (`SHH_PAIEMENT=1`). Paiement fermé, le relais tourne sans servir : `SHH_APPELS=0` l'arrête d'ici là.

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

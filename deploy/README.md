# Déploiement de Shhdrop

Caddy (TLS) devant le serveur Go, dans Docker. Références : spécification §8, §9.4, §10, §15, §22, §28.7, §30, §36.

| Fichier | Rôle |
|---|---|
| `Caddyfile` | TLS 1.3, échange de clés hybride, remplacement de `X-Shh-Client-IP`, aucun journal |
| `Dockerfile` | image du serveur : binaire Go statique + site, sur `scratch`, compte 65532 |
| `compose.yaml` | les deux conteneurs (plus les relais du paiement et des appels, §13 et §14), en lecture seule, sans capacité, sans journal |
| `deploy.sh` | installe une version par empreinte, après vérification de sa provenance (§3), contrôle, revient en arrière ; commandes d'administration |
| `commun.sh` | partie commune de `deploy.sh` et `preprod.sh` : réglages, verrous, contrôles de la machine, démarrage, contrôle de santé, retour arrière |
| `bases.sh`, `test-bases.sh` | copie des bases avant chaque mise à jour et remise des bases migrées en cas de retour arrière (§3.4), chargé par `commun.sh` ; son banc d'essai, avec de vraies bases SQLite |
| `maintenance.sh`, `annonce.sh`, `test-maintenance.sh` | maintenance programmée (§5) : bandeau sur le site, puis créations refusées avant un redémarrage ; lecture de l'annonce (aussi par `etat.sh` et le bilan du lundi) ; son banc d'essai |
| `preprod.sh`, `maintenance.html`, `test-preprod.sh` | préproduction (§15) : version de développement construite sur le serveur, derrière la barrière du `Caddyfile` ; page servie au public ; banc d'essai de la barrière (lancé par `test-proxy.sh`) |
| `provenance.sh`, `test-provenance.sh` | vérification de l'image (signée, liée au manifeste par `image.json`) et de la provenance du site (manifeste signé par cosign, spec §28.7), chargée par `deploy.sh` ; son banc d'essai, sans réseau (§3) |
| `construire-image.sh` | build reproductible de l'image (`ghcr.io/skoow/shhgone`), lancé par `release.yml` sur deux machines et par qui veut refaire l'image (§3.2) |
| `verrous.sh`, `test-verrous.sh` | verrous de mise en ligne V1 à V3 (commits signés par une clé autorisée, aucune histoire réécrite, commit confirmé par le propriétaire), chargés par `deploy.sh` ; leur banc d'essai, avec un dépôt et des clés SSH temporaires (§3.5) |
| `shhcheck/` | petit programme Go : santé du conteneur, test TLS hybride, relais de sortie du paiement (§13), contrôle d'un hôte joignable en TLS (`joindre`), relais TURN (§14) ; `salonws_test.go` et `compte_test.go` : essais de banc (tests seulement, hors du binaire) |
| `test-proxy.sh` | test du proxy : le Caddyfile devant le vrai serveur (salon activé), sur la boucle locale |
| `journaux.sh`, `test-journaux.sh` | contrôles des journaux de la machine (aucune adresse IP sur le disque, une heure au plus en mémoire), bloquants dans `deploy.sh` ; leur banc d'essai, sur une machine factice (§1) |
| `test-sortie.sh` | test des sorties : configuration résolue de `compose.yaml` (aucun relais SMTP, relais du paiement), puis réseau réel avec Docker (§12.1, §13.1) |
| `compose.yaml` : `relais-stripe`, `relais-paypal`, `relais-nowpayments` | seules sorties du paiement, une par prestataire, paiement activé (§13) |
| `systemd/shhdrop-journal.*`, `systemd/00-shhdrop-connexions.conf` | purge du journal de plus d'une heure, tous les quarts d'heure ; registres des connexions (`wtmp`, `btmp`, `lastlog`) vers `/dev/null` (§1) |
| `sauvegarder.sh`, `systemd/` | sauvegarde quotidienne chiffrée (age) de `comptes.db` et de `paiements.db`, et son minuteur (§12.4) |
| `restaurer.sh` | vérification mensuelle et restauration d'une sauvegarde (§12.5) |
| `test-restauration.sh` | sauvegarde, effacement, restauration et reconnexion d'un compte de test, puis de `paiements.db` avec un pass factice, en mémoire (§12.5) |
| `integrite.sh`, `test-integrite.sh`, `systemd/shhdrop-integrite.*` | empreinte du serveur sain vérifiée chaque nuit (dpkg, AIDE, bases, conteneurs, conformité), base refaite après chaque installation ; son banc d'essai, sur un faux système avec le vrai AIDE (§4, « Intégrité du serveur ») |
| `installer-surveillance.sh` | pose et tient à jour, à chaque `deploy.sh`/`preprod.sh` : AIDE, `jq`, `dig`, minuteurs, alerte SSH (PAM), SFTP coupé (§4) |
| `ssh-connexion.sh`, `test-ssh-connexion.sh` | e-mail à chaque connexion SSH (heure, compte, clé ; jamais d'adresse IP), sans jamais bloquer la connexion ; son banc d'essai (§4) |
| `courriel.sh` | envoi des e-mails de l'exploitant, partagé par `alerte.sh`, `integrite.sh` et `ssh-connexion.sh` |
| `analyse-acceptes.sh`, `analyse/`, `test-analyse.sh` | résultats de gosec et de Semgrep comparés aux exceptions motivées, ligne par ligne (§8) |
| `env.example` | modèle de `deploy/.env` |
| `etat.sh`, `secret.sh`, `lien-acces.sh`, `admin-jeton.sh` | commandes du quotidien (section « Commandes du quotidien ») : résumé sans secret, saisie masquée d'un secret, lien de la préproduction, jeton du tableau de bord |
| `fichiers-secrets.sh`, `lire-env.sh`, `test-outils.sh` | secrets en fichiers (tirage, écriture atomique, droits exacts, formats) ; lecture de `deploy/.env` sans l'exécuter ; leur banc d'essai et celui des commandes du quotidien (§8) |

Ce kit réduit les risques ; il ne rend pas le service invulnérable. Les limites sont listées en fin de page.

## 1. Avant d'installer

Chez l'hébergeur et le registraire :

- serveur **dédié** loué (spécification §15.1, §17.1 : en France, chez OVH), jamais un VPS (voir « Hébergeur et certificat » plus bas), trafic sortant inclus vérifié, aucun CDN ni proxy devant ;
- instantanés et sauvegardes de la machine **désactivés** chez l'hébergeur, aucun logiciel de surveillance de l'hébergeur ;
- **aucun outil qui ouvre `shares.db` pendant que le serveur tourne** (seule exception, pour `comptes.db` et non `shares.db` : la sauvegarde quotidienne du compte, §12.4, qui la lit une seconde environ ; la copie des bases avant une mise à jour, §3.4, se fait serveur arrêté) (sauvegarde à chaud, réplication de type Litestream, `sqlite3` pour « regarder ») : un lecteur d'un autre processus empêche le vidage du journal de la base (`shares.db-wal`), qui garde alors les lignes des partages et des salons déjà effacés. Le tableau de bord d'administration l'affiche (« Vidages de la base ratés ») ; le compte doit rester à 0 ;
- DNS : `A` et `AAAA` vers le serveur ; **DNSSEC** activé ; `CAA 0 issue "letsencrypt.org"`, puis, après le premier certificat, lié à **notre** compte ACME : `CAA 0 issue "letsencrypt.org; accounturi=<URI du compte>"` (l'URI est dans le fichier du compte, sous `<SHH_DATA_ROOT>/caddy/acme/acme-v02.api.letsencrypt.org-directory/users/`) et `CAA 0 issuewild ";"` (aucun certificat générique) ; double authentification et verrou de transfert (§15.4).
- **`www`** : `www.shhgone.com` redirige en 308 vers `https://shhgone.com`, chemin et requête gardés (`Caddyfile`, bloc `www.{$SHH_DOMAIN}` ; rien d'autre n'y est servi, aucun journal). Enregistrements à ajouter chez le registraire, aux mêmes adresses que le nom du site :

  | Nom | Type | Valeur |
  |---|---|---|
  | `www` | `A` | `54.38.93.126` |
  | `www` | `AAAA` | `2001:41d0:403:1f7e::` |

  Pas de `CNAME` (un `CNAME` vers le nom du site marcherait aussi, mais des adresses directes ne dépendent que d'une seule zone signée). Conséquences : (1) Caddy demande **un second certificat**, pour `www.shhgone.com`, au même Let's Encrypt, avec **le même compte ACME** et le même profil de 6 jours (bloc `tls` commun) ; tant que l'enregistrement n'existe pas, cette demande échoue et Caddy la réessaie en silence (journaux coupés), sans gêner le site ; (2) **CAA** : un enregistrement CAA du nom vaut aussi pour `www` (la recherche remonte au nom parent tant que `www` n'a pas le sien) ; `issue "letsencrypt.org; accounturi=…"` laisse donc passer `www`, puisque c'est le même compte ; ne **pas** poser de CAA propre à `www`, ou alors identique ; `issuewild ";"` ne change rien (le certificat de `www` n'est pas générique) ; (3) DNSSEC couvre `www` dès qu'il est dans la zone signée ; (4) **surveillance** : `alerte.sh` lit aussi le certificat servi pour `www` et les certificats de `www` dans les journaux publics (crt.sh, deuxième requête, seul le nom public envoyé) : le certificat de `www` servi par Caddy est connu, tout autre certificat de `www` émis ces 3 derniers jours donne l'alerte URGENT `certificat-inconnu`. L'échéance du certificat de `www` n'est pas surveillée à part : s'il expire, seule la redirection tombe (le site reste servi), et le même renouvellement que celui du site est en cause, déjà surveillé.

### Hébergeur et certificat

Ce que l'hébergeur (ou qui prend la machine) peut faire, et ce qui l'en empêche ou le fait voir :

- **Le contenu reste hors de portée** : fichiers, messages, noms de fichiers, clés et mots de passe des utilisateurs sont chiffrés dans le navigateur ; le serveur ne les a jamais en clair, même en mémoire. Lire la mémoire ne donne que des métadonnées passagères (adresses des connexions en cours, tailles, heures).
- **Le volume chiffré se déverrouille par SSH seulement** (§5), jamais par la console KVM/IPMI de l'hébergeur, qui peut voir ce qu'on y tape. La phrase n'est écrite nulle part. Couper l'accès IPMI dans l'espace client quand il ne sert pas.
- **Dédié plutôt que VPS** : sur un VPS, l'hébergeur lit la mémoire de la machine (donc la clé du volume ouvert et la clé TLS) d'une simple commande ; sur un dédié, il lui faut une intervention physique. Chiffrement de la mémoire par le processeur (AMD SME/TSME, Intel TME) : à activer dans le BIOS si le modèle l'a (pas le Xeon-D 2141I du SYS-2, trop ancien).
- **Certificats de 6 jours** (profil « shortlived » de Let's Encrypt, `Caddyfile`) : une clé volée ne sert que quelques jours. Caddy renouvelle seul vers 2 jours restants ; chaque renouvellement crée une **nouvelle clé**, sur la machine, qui ne voyage jamais (seule une preuve de contrôle du domaine passe par le réseau) : aucun risque de plus par renouvellement. Alerte URGENT sous 36 h restantes ; panne de Let's Encrypt de plusieurs jours : retirer le bloc `issuer acme` du `Caddyfile` et redéployer, retour aux certificats de 90 jours. Sonde externe adaptée (36 h pour un certificat de 6 jours, 14 jours sinon).
- **Redémarrage** : alerte URGENT `redemarre` dès que la machine a redémarré (lire le disque ou la mémoire à froid passe presque toujours par là), puis `volume` tant que le volume est verrouillé. Redémarrage inattendu, sans maintenance annoncée par l'hébergeur : ne pas déverrouiller avant d'avoir compris (espace client, tickets, intervention), et en cas de doute suivre le plan d'incident (§6).
- **Le vrai risque est la clé du certificat TLS** : avec elle (ou avec le DNS), on peut se faire passer pour Shhgone et servir un site modifié qui volerait les clés. Défenses : DNSSEC, verrou de transfert, CAA lié à notre compte ACME (plus haut), et **surveillance des journaux publics de certificats** : `alerte.sh` envoie une alerte URGENT `certificat-inconnu` si un certificat émis ces 3 derniers jours pour le nom ou pour `www` n'est pas l'un de ceux que sert le site (crt.sh, une fois par jour ; seul le nom du domaine, public, est envoyé). Si l'alerte n'est pas un renouvellement de Caddy : révoquer le certificat, changer les clés, vérifier le DNS, prévenir les utilisateurs (§6).
- **Limite qui reste** (dite dans la page Sécurité) : le site est servi par le serveur à chaque visite ; un serveur pris peut servir un autre code. Les applications natives prévues (D42-20), signées et installées une fois, et le build reproductible (§28.1, empreintes publiées) la réduisent.

Sur la machine (Linux récent, Docker Engine 25 ou plus avec Compose 2.24 ou plus) :

- **2 processeurs et 2 Gio de mémoire au moins** : `compose.yaml` plafonne le serveur à 1,5 processeur et 1 Gio, Caddy à 1 processeur et 256 Mio (raisons dans le fichier). Avec moins de 2 processeurs, Docker refuse de démarrer le serveur ;

- **disque** : `SHH_STORAGE_MAX` + 1 Gio libres au moins (201 Gio par défaut), sinon le serveur refuse de démarrer ;
- **dimensionnement des salons** : au pire, 2 Go de fichiers × `SHH_SALONS_MAX` (plus leurs conversations) ; le garde-fou `SHH_STORAGE_MAX` protège le disque (au-delà, plus de pièce ni de nouveau salon), et `SHH_SALONS_MAX=50` est conseillé pour un petit serveur. **`SHH_SALONS_MAX` est croisé avec la mémoire au démarrage** : le serveur refuse de démarrer, avec un message qui dit quoi changer, si les journaux des salons (256 Kio par salon au pire) dépasseraient 10 % de `GOMEMLIMIT` (360 salons au plus avec les 900 Mio livrés) ou si la part de trames garantie à chaque salon tomberait sous 1 000 (§11). Les appels disque des conversations ne dépendent pas du nombre de salons ni de connexions : ils ont leurs propres bornes (§11) ;
- **volume chiffré** LUKS2 (AES-256-XTS, Argon2id) pour toutes les données, monté avec **`noatime`** ; la phrase de déverrouillage n'est jamais stockée sur le serveur (§22) ;
- **pas de mémoire d'échange** : `swapoff -a`, ligne retirée de `/etc/fstab` (`deploy.sh` refuse d'installer sinon) ;
- **Caddy non root** : dans `/etc/sysctl.d/60-shhdrop.conf`, `net.ipv4.ip_unprivileged_port_start=80`, puis `sysctl --system` (`deploy.sh` refuse d'installer sinon). Caddy tourne sous le compte 65532 sans aucune capacité et peut quand même écouter sur 80 et 443. Contrepartie : sur la machine elle-même, n'importe quel compte pourrait prendre 80 ou 443 pendant un redémarrage de Caddy ; la machine ne fait tourner que `sshd`, Docker, Caddy et le serveur (les conteneurs ont leur propre réseau), donc aucun compte ordinaire. Installation déjà faite : `chown -R 65532:65532 /srv/shhdrop/caddy` ;
- **vidages mémoire coupés** : `kernel.core_pattern=|/bin/false` dans `/etc/sysctl.d/`, en plus de la limite posée sur les conteneurs. **Ubuntu : apport réécrit cette valeur à chaque démarrage**, après `/etc/sysctl.d/` (constaté sur Ubuntu 26.04) : `systemctl mask apport.service apport-autoreport.path apport-autoreport.service apport-forward.socket`, `enabled=0` dans `/etc/default/apport`, puis `sysctl --system`. Vérifier après un redémarrage : `sysctl kernel.core_pattern` doit afficher `|/bin/false` (`deploy.sh` refuse sinon) ;
- **Docker sans journal sur le disque par défaut** : `/etc/docker/daemon.json` contient `{ "log-driver": "none" }`, puis `systemctl restart docker` (`compose.yaml` le coupe déjà pour nos conteneurs ; ceci couvre tout conteneur lancé à la main ; `deploy.sh` refuse sinon). `docker-buildx-plugin` sert à refaire l'image (`deploy/construire-image.sh`, §3.2) et à la préproduction (`preprod.sh` construit l'image, §15) : `deploy.sh` ne construit rien ; `docker-ce-rootless-extras` peut être retiré ;
- **journaux de la machine sans adresse IP sur le disque, et une heure au plus en mémoire**. `deploy.sh` **refuse d'installer** tant qu'un de ces réglages manque, et dit lequel et quoi faire (`journaux.sh`, banc d'essai `test-journaux.sh`) :
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
    X11Forwarding no
    ```

    SFTP et scp : coupés par `deploy.sh` (ligne `Subsystem sftp` mise en commentaire, §4, « Intégrité du serveur ») ; rien à faire ici.

    OpenSSH 10 (Ubuntu 26.04) affiche ce niveau `loglevel SILENT` dans `sshd -T` : c'est le même, `deploy.sh` accepte les deux noms. `X11Forwarding no` : inutile sur un serveur (Ubuntu le met à `yes`).

    puis `sshd -t && systemctl reload ssh`, et vérifier depuis **une deuxième session** que la connexion par clé marche encore avant de fermer la première. Ce réglage ne change que les journaux et interdit le mot de passe (déjà exigé plus bas ; avec lui, PAM écrirait l'adresse, `rhost=`, à chaque échec) : la connexion par clé de l'administrateur n'est pas touchée. `deploy.sh` lit la configuration effective (`sshd -T`). Contrepartie : plus aucune trace des connexions SSH, réussies ou non ; une intrusion par SSH ne se lirait plus dans les journaux (l'alerte `redemarre` et la sonde restent). Variante plus forte, à choisir par l'exploitant : SSH joignable seulement par un VPN (WireGuard sur la machine, port 22 fermé au public dans le pare-feu) ; les robots ne joignent plus `sshd`, `LogLevel QUIET` reste exigé ;
  - **pare-feu sans journal** : `ufw logging off` (sinon chaque paquet refusé, avec ses adresses, va dans le journal du noyau) ;
  - **suivi des connexions du pare-feu raccourci** : le noyau garde en mémoire, pour chaque connexion vue par le pare-feu, les adresses IP des deux bouts, jusqu'à **5 jours** par défaut pour une connexion TCP établie, même inactive. Dans `/etc/sysctl.d/` : `net.netfilter.nf_conntrack_tcp_timeout_established=1800` (30 min ; nos connexions longues envoient un signe de vie toutes les 25 à 45 s, WebSocket et relais, elles ne sont pas coupées). Le réglage ne s'applique que si le module `nf_conntrack` est déjà chargé quand `sysctl` passe au démarrage : le faire charger tôt, `echo nf_conntrack > /etc/modules-load.d/shhdrop-conntrack.conf` (sinon, chargé plus tard par le pare-feu ou Docker, il reprend ses 5 jours). Vérifier : `sysctl net.netfilter.nf_conntrack_tcp_timeout_established` (au-delà de 1800, `deploy.sh` refuse) ;
  - **registres des connexions vers `/dev/null`** : hors de tout journal et quel que soit `LogLevel`, l'adresse de chaque connexion réussie va dans un registre (`last`), et sur Ubuntu 24.04 celle de chaque tentative avec un nom de compte inconnu (les robots) dans `/var/log/btmp` (`lastb`), sur le disque. **Ubuntu 24.04** : `sshd` écrit lui-même `/var/log/wtmp`, `/var/log/btmp` et `/var/log/lastlog`. Les remplacer par des liens vers `/dev/null`, à chaque démarrage aussi :

    ```sh
    install -m 0644 deploy/systemd/00-shhdrop-connexions.conf /etc/tmpfiles.d/
    systemd-tmpfiles --create /etc/tmpfiles.d/00-shhdrop-connexions.conf   # remplace les fichiers par les liens
    rm -f /etc/logrotate.d/wtmp /etc/logrotate.d/btmp /var/log/wtmp.1 /var/log/btmp.1
    ```

    Le préfixe 00 l'emporte sur les lignes de `/usr/lib/tmpfiles.d/var.conf` qui recréent ces fichiers (essayé avec systemd 255, celui d'Ubuntu 24.04) ; sans les règles de logrotate, rien ne remet de fichier à la place des liens. `sshd` n'en souffre pas (il écrit dans `/dev/null`, ou saute le registre qui n'est pas un fichier) ; `last`, `lastb` et l'accueil « Last login » n'affichent plus rien. **Ubuntu 26.04** (si `wtmpdb` et `lastlog2` remplacent ces fichiers : bases `/var/lib/wtmpdb/wtmp.db` et `/var/lib/lastlog/lastlog2.db`, écrites par les modules PAM `pam_wtmpdb` et `pam_lastlog2`) : `pam-auth-update --disable wtmpdb lastlog2` (retire ces modules de `common-session`), `systemctl mask wtmpdb-update-boot.service`, puis `rm -f /var/lib/wtmpdb/wtmp.db /var/lib/lastlog/lastlog2.db`. Les deux versions : aucune ligne active `pam_lastlog.so`, `pam_lastlog2.so` ni `pam_wtmpdb.so` dans `/etc/pam.d/sshd`, `common-session` ni `common-session-noninteractive` (retirer ou commenter la ligne). Ces modules ne font qu'écrire le registre : la connexion n'en dépend pas, mais **vérifier depuis une deuxième session SSH** que l'on se connecte encore avant de fermer la première. `deploy.sh` refuse si l'un des trois fichiers de `/var/log` existe sans être un lien vers `/dev/null` (même vide : `sshd` y écrirait), si une des deux bases est un fichier non vide, si un de ces modules est actif, ou si une règle logrotate `wtmp` ou `btmp` reste ;
- **heure** synchronisée (NTP : `timedatectl set-ntp true`) ;
- **mises à jour de sécurité automatiques**, sans redémarrage automatique de la machine (`unattended-upgrades`, `Automatic-Reboot "false"`, §22) ;
- paquets `sqlite3` (exigé par `deploy.sh` et `preprod.sh` : copie des bases avant une mise à jour, §3.4) et, pour le compte (§12), `age` (version exacte, notée dans `deploy/.env`) et `curl` ;
- **SSH par clé seulement** (`PasswordAuthentication no`), **pare-feu** : 22, 80 et 443 en TCP, **443 en UDP** (HTTP/3, QUIC), et les ports du relais des appels (3478 en UDP et TCP, 49160 à 49999 en UDP : `deploy.sh` les ouvre lui-même avec ufw, §14), rien d'autre. Avec ufw : `ufw allow 22/tcp`, `ufw allow 80/tcp`, `ufw allow 443/tcp`, `ufw allow 443/udp`. Sans l'ouverture UDP, les navigateurs restent en HTTP/2 (rien ne casse). Tampons UDP conseillés par la bibliothèque QUIC de Caddy, dans `/etc/sysctl.d/` : `net.core.rmem_max=7500000` et `net.core.wmem_max=7500000` (sinon HTTP/3 marche, plus lentement).

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

# Copie du dépôt : /opt/shhdrop, à root, clone public en https sans identifiant.
git clone https://github.com/Skoow/shhgone.git /opt/shhdrop
chown -R root:root /opt/shhdrop && chmod 0755 /opt/shhdrop
cd /opt/shhdrop

# Réglages, cosign (§3.2), signataires autorisés (§3.5), puis installation d'une version
# (empreinte de l'image, numéro de sa Release signée et commit confirmé : procédure exacte au §3.2).
cp deploy/env.example deploy/.env && editor deploy/.env
deploy/deploy.sh sha256:<empreinte> <x.y.z> <commit>
```

La copie du dépôt est **`/opt/shhdrop`** : un clone public en https, **sans identifiant** (ni jeton, ni clé de déploiement, ni assistant d'identifiants) ; **le serveur ne détient jamais d'accès en écriture à GitHub**. Elle appartient à root et n'est modifiable que par lui (`chown -R root:root /opt/shhdrop`) : `deploy.sh` tourne en root depuis elle, et ses verrous lancent git sans `safe.directory`, donc refusent une copie d'un autre compte. Elle n'est mise à jour **que par `git fetch origin`**, jamais par `git pull` (§3.5) : `deploy.sh` l'avance lui-même au commit vérifié.

Ne pas inscrire le volume dans `/etc/fstab` ni `/etc/crypttab` avec une clé : il se déverrouille à la main (§5).

**Machine installée sans `secrets/`** : le créer (dernière ligne ci-dessus) avant le prochain `deploy.sh`, qui refuse sinon.

**`deploy/.env` est lu, jamais exécuté** (`lire-env.sh`, par `deploy.sh`, `preprod.sh`, `alerte.sh` et `sauvegarder.sh`, tous en root). Il doit appartenir à root et n'être modifiable que par lui (`chown root:root deploy/.env && chmod 0644 deploy/.env`), sinon tout est refusé. Chaque ligne est vide, un commentaire (`#…`) ou `SHH_…=valeur` (`export` devant est toléré) ; une valeur avec une espace se met entre guillemets simples. Refusés, avec le numéro de la ligne : toute autre variable (`PATH`, `COMPOSE_FILE`…), et dans une valeur sans guillemets simples `$`, `` ` ``, `\`, `;`, `&`, `|`, `<`, `>`, `(`, `)`. Ce qui était accepté avant garde la même valeur.

## 3. Mise à jour et retour arrière

### 3.1 Publier une version : étiquette, Release signée

Une version publique est une **étiquette `web-v<x.y.z>`** posée par le propriétaire sur un commit de `main` dont la CI est verte (`git tag web-v1.0.0 <commit> && git push origin web-v1.0.0`). Le workflow `.github/workflows/release.yml` (spec §28.2) :

1. relance toute la CI sur ce commit (tests, `repro` sur deux machines, `repro-docker` : le site de l'image = celui des builds de la CI) ; exige que le commit soit dans `main` ;
2. reconstruit le site (`SHH_SITE_COMPTES=1`, comme l'image), vérifie qu'il est identique aux builds du job `repro`, et écrit `release.json` (version, commit, chemin, taille et SHA-256 de chaque fichier, `web/scripts/release-manifest.mjs`), `SHA256SUMS` et `dist.tar.gz` (archive déterministe) ;
3. construit **l'image du serveur** deux fois, sur deux machines (job `image`, `deploy/construire-image.sh`, §3.2), sans aucun droit d'écriture ;
4. dans un job à part, qui ne lance aucun code npm (`publier-image`, seul à avoir `packages: write`) : exige la même empreinte des deux builds, vérifie que le `/site` de l'image est `release.json` octet pour octet et que ses deux binaires sont là, la pousse telle quelle sur **`ghcr.io/skoow/shhgone`** (étiquette `web-v<x.y.z>`, empreinte inchangée), vérifie qu'elle se lit **sans identifiant** (paquet public, §3.2), puis la signe **sans clé** (`cosign sign`, même identité que le manifeste) et revérifie cette signature comme `deploy.sh` ;
5. dans un dernier job, sans code npm non plus (`signer`) : écrit `image.json` (version, commit, `ghcr.io/skoow/shhgone@sha256:…`, SHA-256 de `release.json` : ce fichier lie l'image au site), signe `release.json` et `image.json` **sans clé** (`cosign sign-blob`, jeton OIDC de GitHub Actions, certificat Fulcio, inscription dans le journal public Rekor), revérifie les trois signatures avec l'identité exacte qu'utilise `deploy.sh`, et publie la Release GitHub : `release.json`, `release.json.sigstore.json` (le bundle), `image.json`, `image.json.sigstore.json`, `SHA256SUMS`, `dist.tar.gz` ; ses notes donnent l'empreinte de l'image et la commande `deploy.sh`.

Aucun secret : les signatures viennent de l'identité du workflow (`id-token: write` dans ces deux jobs seulement), la publication de l'image du `GITHUB_TOKEN` (`packages: write` dans `publier-image` seulement). Ce que les signatures prouvent : « site **et** image (binaires du serveur et de `shhcheck` compris) construits par `release.yml` de `Skoow/shhgone`, depuis ce commit public ». Ce qu'elles ne prouvent pas : que ce code est sain. Un compte GitHub volé peut signer une version piégée : elle sera publique et inscrite dans Rekor (détectable, pas empêché ; c'est le rôle des verrous du §3.5).

Le manifeste n'est **pas** commité dans le dépôt avant l'étiquette : le numéro de version du site est le commit lui-même (`SHH_BUILD_ID`), un commit ne peut donc pas contenir le manifeste de son propre build (spec §28.2). Pour prouver « build local = build CI », reconstruire le site de ce commit (§3.3) et comparer à `release.json` de la Release.

### 3.2 L'image : construite, publiée et signée par GitHub, puis installée

L'image n'est jamais construite à la main : `release.yml` la construit (§3.1), la publie sur **`ghcr.io/skoow/shhgone`** (seul dépôt accepté par `deploy.sh` : `SHH_IMAGE_REPO` vaut cela par défaut, et toute autre valeur dans `deploy/.env` fait refuser l'installation) et la signe. Le serveur la télécharge **sans identifiant** : le paquet doit être public.

**Build reproductible de l'image** (`deploy/construire-image.sh`, le même script en CI et pour qui veut refaire l'image) : `SHH_BUILD_ID` = les 7 premiers chiffres du commit (le numéro affiché par le site ; c'est lui qui rend le `/site` de l'image identique aux builds de la CI, donc au manifeste), `SOURCE_DATE_EPOCH` = date du commit, dates des fichiers réécrites (`rewrite-timestamp`), BuildKit **v0.34.2 épinglé par empreinte** (constructeur `docker-container` recréé à chaque fois), une seule plateforme (`linux/amd64`), aucune attestation (`--provenance=false --sbom=false` : elles portent l'heure du build), archive OCI poussée telle quelle par `crane` (empreinte inchangée). `release.yml` exige la même empreinte de deux builds sur deux machines. Essayé sur le commit `41748bc` : deux builds sans cache, dans deux dossiers différents, à des heures différentes, ont donné la même archive, octet pour octet (le build de la CI, lui, n'est prouvé qu'à la première Release). Pour refaire l'image soi-même et comparer à celle de la Release (Docker avec buildx, linux/amd64, arbre propre) :

```sh
git checkout web-v<x.y.z>
deploy/construire-image.sh /tmp/image     # écrit /tmp/image/image.tar et /tmp/image/empreinte
cat /tmp/image/empreinte                  # doit être l'empreinte des notes de la Release (et d'image.json)
```

**Visibilité du paquet (une fois, après la première publication).** Sur un compte personnel, GitHub crée tout nouveau paquet **privé**. `release.yml` le détecte : l'étape « Image lisible sans identifiant (paquet public) » du job `publier-image` échoue, **avant toute signature**, avec un message qui le dit. Le propriétaire, connecté à GitHub :

1. ouvrir `https://github.com/users/Skoow/packages/container/shhgone/settings` (ou : photo du profil en haut à droite, **Your profile**, onglet **Packages**, paquet **shhgone**, puis **Package settings** en bas de la colonne de droite) ;
2. dans **Danger Zone**, cliquer **Change visibility**, choisir **Public**, taper `shhgone` pour confirmer, puis **I understand the consequences, change package visibility** ;
3. sur la même page, **Manage Actions access** : `Skoow/shhgone` doit y être, avec le rôle **Write** (posé seul quand `release.yml` crée le paquet ; sinon **Add Repository**, `shhgone`, rôle **Write**) ;
4. revenir à l'exécution de `release.yml` (onglet **Actions**), **Re-run jobs**, puis **Re-run failed jobs** : l'image est repoussée (même empreinte), lue sans identifiant, signée, et la Release est publiée.

Vérifier ensuite, depuis n'importe quel poste sans être connecté : `docker pull ghcr.io/skoow/shhgone@sha256:<empreinte>` doit réussir. Un paquet public ne peut plus redevenir privé ; il ne contient que ce que le dépôt public permet déjà de reconstruire (aucun secret : l'image n'en a aucun).

**Première mise en ligne** (dans l'ordre ; le serveur est prêt : §1, §2, §3.5) :

1. `main` est vert (onglet **Actions**, workflow `ci`, dernier commit de `main`), et la conversation de développement a donné le **commit complet** à publier (40 chiffres hexadécimaux) : c'est le commit de `main` que l'on étiquette.
2. Poser l'étiquette depuis le poste du propriétaire : `git fetch origin && git tag web-v1.0.0 <commit> && git push origin web-v1.0.0`.
3. Attendre la fin de `release.yml` (onglet **Actions**, exécution « release » de `web-v1.0.0` ; CI entière, deux builds de l'image, environ une heure). Au premier passage, s'il échoue sur « Image lisible sans identifiant » : rendre le paquet public (ci-dessus), puis **Re-run failed jobs**.
4. Ouvrir la Release `web-v1.0.0` (`https://github.com/Skoow/shhgone/releases/tag/web-v1.0.0`) : ses notes donnent l'**empreinte** de l'image (`sha256:…`, 64 chiffres hexadécimaux) et le **commit**. Le commit doit être, chiffre pour chiffre, celui que donne la conversation de développement (verrou V3, §3.5 : c'est cette comparaison qui compte, pas la copie depuis GitHub) ; s'il diffère, ne rien installer.
5. Sur le serveur, en root, dans `/opt/shhdrop` (§2), avec `git fetch` seulement, **jamais `git pull`** (§3.5) :

```sh
cd /opt/shhdrop
git fetch origin
deploy/deploy.sh sha256:<empreinte> 1.0.0 <commit>
```

Pour les versions suivantes, la même suite, avec `web-v<x.y.z>` et `<x.y.z>`.

**cosign sur le serveur** (une fois, puis à chaque montée de version ; version et empreinte épinglées, les mêmes que `deploy/provenance.sh`, qui refuse tout autre binaire) : cosign **v3.1.4** (publiée le 20 octobre 2026 ; empreinte relevée le 24 novembre 2026 dans `cosign_checksums.txt` de la Release et recalculée sur le binaire téléchargé). La v3.1.5, publiée le 24 novembre, est trop récente (règle des 7 jours, spec §24) : à réexaminer.

```sh
curl -fsSL -o /tmp/cosign https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-amd64
echo "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa  /tmp/cosign" | sha256sum -c -
install -m 0755 -o root -g root /tmp/cosign /usr/local/bin/cosign && rm /tmp/cosign
```

**Hôtes que le serveur doit joindre pendant `deploy.sh`** (HTTPS, port 443, en sortie ; un pare-feu sortant doit les laisser passer, rien d'autre n'est demandé) :

| Hôte | Pour quoi |
|---|---|
| `github.com` | `git fetch` de la copie du dépôt ; téléchargement de `release.json`, `image.json` et de leurs bundles (Release) |
| `release-assets.githubusercontent.com`, `objects.githubusercontent.com` | fichiers de la Release (GitHub y redirige les téléchargements) |
| `ghcr.io` | l'image et sa signature (`cosign verify`, `docker pull`, sans identifiant) |
| `pkg-containers.githubusercontent.com` | couches de l'image (ghcr.io y redirige les téléchargements) |
| `tuf-repo-cdn.sigstore.dev` | racine de confiance de Sigstore (TUF), lue par cosign et gardée dans `/root/.sigstore` |
| `rekor.sigstore.dev` | journal de transparence, si cosign doit y lire une inscription que le bundle ou la signature n'emporte pas |
| `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com` | images épinglées de `compose.yaml` (Caddy) et du contrôle (Node du `Dockerfile`) |

Ni Fulcio (`fulcio.sigstore.dev`) ni aucun accès en écriture : le serveur ne signe rien et ne publie rien. Les deux hôtes de Sigstore ne sont pas encore essayés depuis le serveur (première mise en ligne). Après la mise en ligne, le site lui-même ne fait aucune connexion sortante, sauf celles des relais du paiement (§13).

Commandes courantes, sur le serveur (jamais `git pull` : voir §3.5) :

```sh
git fetch origin                                       # télécharge les commits, ne change aucun fichier
deploy/deploy.sh sha256:<empreinte> <x.y.z> <commit>   # verrous (§3.5), image et provenance, installe, contrôle, revient en arrière si le contrôle échoue
deploy/deploy.sh status                                # version, commit en service et précédents, commit installé, conteneurs
deploy/deploy.sh rollback                              # réinstalle la version précédente (image, provenance et verrous revérifiés)
```

`<commit>` : le commit complet (40 chiffres hexadécimaux) de l'étiquette `web-v<x.y.z>`, donné par la conversation de développement ; celui des notes de la Release doit lui être identique, mais c'est celui de la conversation qui compte (§3.5, V3). `<empreinte>` : celle des notes de la Release ; une empreinte fausse est refusée (elle doit être celle d'`image.json`, signé).

**Vérification de l'image et de la provenance** (spec §28.7 ; `deploy/provenance.sh`), sans option, variable ni commande pour la sauter (spec §28.8, C2) :

1. le binaire `cosign` a l'empreinte épinglée ;
2. **avant tout téléchargement de l'image** (`verifier_image`) : `release.json`, `image.json` et leurs bundles sont téléchargés depuis la Release `web-v<x.y.z>` (https seulement, 4 Mio au plus ; gardés dans `deploy/.provenance/<x.y.z>/` une fois vérifiés, mais revérifiés à chaque installation) ; `cosign verify-blob` de chacun avec l'émetteur `https://token.actions.githubusercontent.com` et l'identité **exacte** `https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v<x.y.z>` (jamais d'expression ouverte, jamais `--insecure-ignore-tlog`) ; `image.json` doit être, octet pour octet, celui que `deploy.sh` recalcule de la version, du commit de `release.json`, de **l'empreinte donnée en argument** et du SHA-256 de `release.json` (une autre empreinte est refusée, en nommant celle qui est signée) ; enfin `cosign verify ghcr.io/skoow/shhgone@<empreinte>` avec la même identité exacte et le même émetteur (signature de l'image dans le registre) ;
3. seulement alors `docker pull ghcr.io/skoow/shhgone@<empreinte>` (par empreinte : Docker vérifie le contenu) ;
4. avant tout démarrage, le dossier `/site` de l'image (copié sans la lancer) doit redonner `release.json` **octet pour octet** : mêmes fichiers, ni plus ni moins, mêmes tailles, mêmes empreintes, même version. Le manifeste est recalculé en shell (`manifeste_de`, identique à `release-manifest.mjs`, prouvé par le banc d'essai et par `release.yml`) : aucun analyseur JSON ne lit un fichier reçu.

Un refus arrête tout (`installation refusée`) : le site en service n'est pas touché. Une Release sans `image.json` ne peut pas être installée.

### 3.3 Vérifier soi-même un site en ligne

Depuis un autre poste, avec une copie du dépôt qui ne vient pas du site, et cosign :

```sh
v=<x.y.z>
curl -fsSLO https://github.com/Skoow/shhgone/releases/download/web-v$v/release.json
curl -fsSLO https://github.com/Skoow/shhgone/releases/download/web-v$v/release.json.sigstore.json
cosign verify-blob release.json --bundle release.json.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$v"
node web/scripts/verify-site.mjs https://shhgone.com release.json
# L'image du serveur (empreinte : ligne « image » d'image.json, signé comme release.json) :
curl -fsSLO https://github.com/Skoow/shhgone/releases/download/web-v$v/image.json
curl -fsSLO https://github.com/Skoow/shhgone/releases/download/web-v$v/image.json.sigstore.json
cosign verify-blob image.json --bundle image.json.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$v"
cosign verify "$(sed -n 's/^  "image": "\(.*\)",$/\1/p' image.json)" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$v"
```

Pour prouver en plus « build local = build CI » : se placer sur l'étiquette (`git checkout web-v$v`), puis `cd web && npm ci --ignore-scripts && SHH_SITE_COMPTES=1 SHH_BUILD_ID=$(git rev-parse --short=7 HEAD) SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run build`, et `node scripts/release-manifest.mjs dist --name shhdrop-web --version $v --commit $(git rev-parse HEAD) --out /tmp/rel && cmp /tmp/rel/release.json ../release.json`. La section « Vérifier cette version » de la page Sécurité du site (adresse directe `/verifier`) dit la même chose, en clair.

### 3.4 Contrôles et limites

Contrôle fait par `deploy.sh` après le démarrage, sans option pour le sauter : conteneur en bonne santé (`/healthz` local) ; `https://<site>/api/captcha` répond 200 à travers Caddy ; page d'accueil avec HSTS ; poignée de main TLS 1.3 limitée à `X25519MLKEM768` (test bloquant de la §30) ; **le site servi à travers Caddy est celui du manifeste signé** (`web/scripts/verify-site.mjs` de la copie du dépôt, lancé dans l'image Node épinglée du `Dockerfile` : chaque fichier, ses variantes `.br`/`.gz` et le repli monopage ; spec §28.7). Un échec ramène la version précédente.

À savoir :

- **un redémarrage du serveur, propre ou brutal, ne perd plus les envois en cours ni les ouvertures** (D42-31, 28 novembre) : chaque segment acquitté est sur le disque, l'état de l'envoi et des ouvertures est dans `shares.db` (tables `shares_envoi` et `shares_ouvertures`) ; les pages ouvertes reprennent d'elles-mêmes l'envoi au premier segment manquant (jeton neuf par `S_gestion`) et la lecture (par l'octroi, sans consommer d'ouverture). Un envoi échu pendant l'arrêt, ou dont la page ne revient pas dans les 15 min, est effacé. Les salons ouverts sont repris aussi (salons persistants, §10), même après un arrêt brutal (dernière seconde au plus perdue), **pièces encore en envoi comprises** depuis D42-32 (la page reprend au premier segment non acquitté). Ne sont pas repris : limites de débit et défis anti-robot (remis à neuf), étapes d'inscription et d'ajout de passkey (à refaire ; la page fait oublier la passkey créée au gestionnaire, là où le navigateur le permet). `shares.db` passe au schéma 7 (D42-32) ; relancer `deploy.sh` avec la même empreinte ne redémarre rien ;
- **retour arrière sûr malgré une migration de schéma** (D42-32, `bases.sh`) : une image plus ancienne refuse une base de schéma plus récent (`shares.db`, `comptes.db`, `paiements.db`). Avant chaque changement d'image, `deploy.sh` et `preprod.sh` **arrêtent proprement le serveur en service et copient ses bases** (API de sauvegarde de SQLite, sous le compte 65532, intégrité vérifiée, 0600, dans `<SHH_DATA_ROOT>/retour/` sur le volume chiffré ; refus si ce dossier est ailleurs ; l'ancienne copie est d'abord effacée par `shred`), puis démarrent la nouvelle image. Contrôle réussi : la copie est effacée (`shred`). Contrôle raté : le nouveau serveur est arrêté, **chaque base dont le schéma a changé est remise à la copie** avant de relancer l'ancienne image ; une base au même schéma est gardée telle quelle. **Ce qui est perdu dans une base remise** : tout ce qui y a été écrit entre la mise à jour et le retour arrière (quelques minutes au plus : la durée du contrôle) : partages créés ou envois commencés pendant ce temps (leurs fichiers sont effacés au démarrage), messages et pièces des salons de ces minutes ; et, pour `comptes.db` ou `paiements.db` si leur schéma avait changé, comptes créés et pass payés pendant ces minutes (un pass payé perdu se rétablit par l'accès offert, §13). Risque (faible, rare) : un salon actif pendant ces minutes peut redonner des numéros de message déjà vus par les membres connectés (la copie précède les rangs donnés par la nouvelle image) ; ils retrouvent la suite en rechargeant la page. Pour l'éviter : annoncer la mise à jour (§5) quand elle change un schéma. La copie arrête le site quelques secondes de plus qu'avant (le temps de copier les bases, serveur arrêté). Un `deploy.sh rollback` lancé plus tard (hors de ce retour automatique) vers une image d'un schéma plus ancien échoue au contrôle et revient de lui-même à la version en service : sans copie de ce moment-là, il n'y a rien à remettre ;
- le retour arrière ne concerne que l'image : `Caddyfile`, `compose.yaml` et `deploy.sh` restent ceux du commit installé (§3.5). Pour les ramener en arrière : un nouveau commit signé qui les rétablit, une nouvelle Release, puis `deploy.sh` (une copie modifiée à la main, `git checkout <commit> -- deploy/` par exemple, est refusée par les verrous) ;
- une version installée avant la vérification de provenance n'a pas de numéro (`deploy/.release.version` absent), et une version installée avant les verrous n'a pas de commit (`deploy/.release.commit` absent) : `rollback` vers elle est refusé, et le contrôle d'un retour arrière automatique vers une version sans numéro échoue (le site reste alors à vérifier à la main) ;
- `deploy/deploy.sh "$(cat deploy/.release)"` (après un redémarrage, §5) réinstalle l'image en service avec sa version et son commit déjà vérifiés (`deploy/.release.version`, `deploy/.release.commit`) : la provenance et les verrous sont revérifiés (§3.5), ce qui demande Sigstore et `ghcr.io` (et `github.com` si les manifestes ne sont pas déjà gardés dans `deploy/.provenance/`) ;
- si le serveur refuse de démarrer, son message n'est écrit nulle part (aucun journal). Pour le lire : `deploy/deploy.sh diagnose`.

### 3.5 Verrous de mise en ligne

Risque visé : un compte GitHub volé pousse un code piégé (dans le site, le serveur, ou `deploy.sh` lui-même), signe une Release avec `release.yml` (§3.1 : la signature cosign prouve « construit par ce workflow », pas « voulu par le propriétaire »), et le propriétaire l'installe par erreur. Trois verrous, **tous obligatoires**, sans option, variable ni commande pour les sauter (`deploy/verrous.sh` ; spec §28.7) :

| Verrou | Ce que `deploy.sh` exige | Contre quoi |
|---|---|---|
| **V1** signatures | le commit du manifeste signé (`release.json`, champ `commit`) est dans la copie du dépôt et passe `git verify-commit` avec `/etc/shhdrop/signataires-autorises` ; puis **chaque** commit entre le commit installé et le nouveau, fusions et leurs branches comprises, a une bonne signature d'un signataire autorisé (`%G?` = `G`) | un commit poussé par quelqu'un qui n'a pas la clé de signature : non signé, signé par une autre clé, ou fait sur le site de GitHub (signé par la clé GPG de GitHub, jamais acceptée : seules les signatures SSH du fichier comptent, gpg est désactivé pour cette vérification) |
| **V2** histoire | le commit installé (`/etc/shhdrop/commit-installe`) est un ancêtre du nouveau (`git merge-base --is-ancestor`) | une histoire réécrite (`push --force`) qui retirerait ou remplacerait des commits déjà vérifiés, ou ferait revenir à un ancien commit (et à ses failles corrigées depuis) |
| **V3** confirmation | le commit complet donné en argument (`deploy.sh sha256:<empreinte> <x.y.z> <commit>`) est celui du manifeste signé | une Release ou une étiquette posée sur un autre commit que celui que le propriétaire a voulu ; le commit vient de la conversation de développement, un autre canal que GitHub |

Avant d'installer, `deploy.sh` affiche le résumé des changements depuis le commit installé : `git log --oneline` (30 commits au plus, puis le nombre restant) et `git diff --stat` (30 fichiers au plus, puis la ligne de total), sans caractère de contrôle. Le lire : un changement dans `deploy/`, `server/` ou un fichier inattendu se voit ici.

**Fichiers du serveur**, hors de la copie du dépôt, à root :

```sh
install -d -o root -g root -m 0755 /etc/shhdrop
cat >/etc/shhdrop/signataires-autorises <<'EOF'
shhgone-dev namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKy87HxSEheG8vEPhSs9u2KZCtVErAQfpmprtUJCZ2w7
EOF
chown root:root /etc/shhdrop/signataires-autorises && chmod 0644 /etc/shhdrop/signataires-autorises
# Contrôle : l'empreinte doit être SHA256:32dP45eSMmVSt/G/CGvcxl/P+MO3Nwj9xeTh/GSA2wc
cut -d' ' -f3,4 /etc/shhdrop/signataires-autorises | ssh-keygen -lf -
```

- `signataires-autorises` : format `allowedSignersFile` de git (une ligne par clé : principal, `namespaces="git"`, clé publique SSH). `shhgone-dev` est la clé qui signe tous les commits de ce dépôt (empreinte `SHA256:32dP45eSMmVSt/G/CGvcxl/P+MO3Nwj9xeTh/GSA2wc`, clé publique tirée de la signature SSH d'un commit, `git cat-file -p HEAD`, et recalculée). `deploy.sh` refuse si le fichier manque, n'est pas un fichier ordinaire à root (lien refusé), a des droits plus larges que 0644, ne nomme aucune clé, ou si `/etc/shhdrop` est modifiable par le groupe ou les autres.
- **V4, plus tard** : la clé du propriétaire, sur son propre appareil, en deuxième ligne `proprietaire namespaces="git" ssh-ed25519 AAAA…`. Pas encore exigée : tant qu'elle n'y est pas, tout commit signé par `shhgone-dev` passe V1.
- `commit-installe` : écrit par `deploy.sh` seulement, après une installation réussie (contrôle de santé compris), jamais à la main. Un fichier présent mais mal réglé ou illisible est refusé, jamais pris pour une absence.
- Outils : `git` et `ssh-keygen` (paquet `openssh-client`). La copie du dépôt est **celle de `deploy.sh`** (pas de variable dans `deploy/.env`) : ce sont ses `Caddyfile`, `compose.yaml`, `deploy.sh` et `verify-site.mjs` que l'installation emploie, c'est donc elle qui doit être au commit vérifié.

**Procédure** :

1. `git fetch origin` dans la copie du dépôt, **jamais `git pull`**. `deploy.sh` ne fait aucun accès réseau pour les verrous (choix : la copie n'est mise à jour que par l'exploitant, et `git fetch` ne change aucun fichier ; `alerte.sh` en fait déjà un par jour, §4). Le serveur n'a aucun accès en écriture à GitHub (§2).
2. `deploy/deploy.sh sha256:<empreinte> <x.y.z> <commit>`. Le `deploy.sh` qui tourne est celui du commit installé (déjà vérifié) : il vérifie le nouveau commit (V1, V2), avance la copie (`git merge --ff-only <commit>`, sans réseau ; refusé si la copie n'est pas propre ou pas sur le commit installé), puis relance le `deploy.sh` de ce commit vérifié, qui refait toutes les vérifications, affiche le résumé, puis vérifie la provenance et V3 avant que rien ne démarre.
3. Après une installation réussie, `/etc/shhdrop/commit-installe` et `deploy/.release.commit` nomment le nouveau commit.

Pourquoi jamais `git pull` : il mettrait dans la copie le `deploy.sh` venu de GitHub **avant** toute vérification, et c'est lui qui tournerait. Un `deploy.sh` piégé ne vérifie rien. Si la copie n'est pas sur le commit installé, `deploy.sh` refuse et dit de revenir au commit installé (`git reset --hard $(cat /etc/shhdrop/commit-installe)`, les fichiers non suivis comme `deploy/.env` restent).

**Première installation sous verrous** (`/etc/shhdrop/commit-installe` absent) : seul V1 s'applique, au commit installé ; l'histoire qui le précède n'est pas vérifiée, et `deploy.sh` le dit (« PREMIÈRE installation sous verrous »). Un `deploy.sh` en place qui n'a pas encore les verrous ne vérifie rien : cette fois-là, vérifier à la main avant d'avancer la copie, puis installer :

```sh
git fetch origin
S=/etc/shhdrop/signataires-autorises
git -c gpg.ssh.program=ssh-keygen -c gpg.ssh.allowedSignersFile=$S -c gpg.program=false verify-commit <commit>   # « Good "git" signature for shhgone-dev »
git merge --ff-only <commit>
deploy/deploy.sh sha256:<empreinte> <x.y.z> <commit>
```

**Retour arrière et réinstallation** : `deploy.sh rollback` et `deploy.sh "$(cat deploy/.release)"` reprennent le commit noté avec l'image (`deploy/.release.prev.commit`, `deploy/.release.commit`). Les verrous y sont revérifiés autrement : le commit doit passer V1 et être le commit installé ou **l'un de ses ancêtres** (histoire déjà vérifiée), son manifeste doit le nommer (V3), et la copie doit être sur le commit installé (ou sur un descendant qui passe V1 et V2 : après une installation qui a échoué au contrôle, la copie reste sur le nouveau commit). Un retour arrière ne change **pas** `commit-installe` : il reste le plus récent commit installé, et la prochaine installation devra en descendre. Un code fautif se corrige donc par un nouveau commit signé (un `git revert`), jamais en réécrivant l'histoire. Une version installée avant les verrous n'a pas de commit noté : `rollback` vers elle est refusé.

**Limites, honnêtement** :

- La clé `shhgone-dev` est **partagée par l'environnement de développement** : elle signe tout commit fait dans une session de cet environnement qui a accès à ce dépôt. Qui contrôle **à la fois** le compte GitHub **et** une telle session peut signer un commit piégé, qui passera V1 et V2. Il reste V3 (le propriétaire doit confirmer ce commit, depuis la conversation de développement) et le résumé des changements. **V4** (la clé du propriétaire, seule exigée sur le commit installé) fermera ce cas.
- V3 ne vaut que si le propriétaire tire le commit de la conversation de développement et lit le résumé : un commit copié depuis GitHub ne prouve rien.
- Les verrous prouvent qui a signé, pas que le code est sain.
- Le premier `deploy.sh` sous verrous, et la copie du dépôt à ce moment-là, sont à vérifier à la main (ci-dessus) ; ensuite, chaque `deploy.sh` qui tourne est celui d'un commit vérifié, tant que personne ne fait `git pull` ni ne modifie la copie à la main.
- Qui est root sur le serveur peut tout changer (fichiers de `/etc/shhdrop`, copie du dépôt) : les verrous protègent contre GitHub, pas contre le serveur.
- Les verrous portent sur le commit du manifeste ; l'image est liée à ce manifeste par `image.json` et construite par `release.yml` depuis ce même commit (deux builds, même empreinte, §3.2) : ses binaires (serveur, `shhcheck`) sont donc couverts aussi.
- git identifie les objets par SHA-1 (avec détection des collisions connues) : une signature couvre l'empreinte SHA-1 de l'arbre et des parents.

## Commandes du quotidien

Sur le serveur, dans `/opt/shhdrop`. **Règle** : un secret ne s'affiche que dans **votre propre fenêtre SSH** (PowerShell, `ssh ubuntu@…`), jamais dans une session Claude, et ne se colle dans aucune conversation. Les commandes qui affichent ou demandent un secret refusent de tourner sans terminal (session Claude, tuyau, fichier).

| Commande | Ce qu'elle fait | Secret affiché ? |
|---|---|---|
| `sudo deploy/etat.sh` | résumé : version, préproduction ou production, maintenance programmée, conteneurs, certificat HTTPS et son échéance, disque, volume chiffré, secrets présents ou absents, paiement et appels, tableau de bord, mises à jour du système | non (utilisable depuis Claude) |
| `sudo deploy/maintenance.sh annoncer "AAAA-MM-JJ HH:MM" <min>` | annonce une maintenance (heure de Paris, durée en minutes) : bandeau sur le site, puis nouvelles créations refusées 10 min avant (§5) ; `annuler`, `etat` | non (utilisable depuis Claude) |
| `sudo deploy/secret.sh --liste` | noms des secrets attendus : présent, absent ou mal réglé | non |
| `sudo deploy/secret.sh shh_stripe_cle` | saisie masquée, deux fois, d'un secret que vous seul possédez ; forme vérifiée ; écrit avec ses droits exacts | non : tapé, jamais affiché |
| `sudo deploy/secret.sh --remplacer <nom>` | remplace un secret existant (passage du test au réel, §13.5) | non |
| `sudo deploy/lien-acces.sh` | lien de la préproduction `https://shhgone.com/acces/<jeton>` (§15.2), puis efface l'écran | **oui** : votre fenêtre seulement |
| `sudo deploy/admin-jeton.sh` | jeton du tableau de bord (§4) : tiré, empreinte et `SHH_ADMIN_LISTEN` mis dans `deploy/.env`, jeton affiché une fois, puis commande du tunnel depuis Windows et réinstallation proposée | **oui**, une fois : votre fenêtre seulement |

**Secrets de `secret.sh`** (que seul le propriétaire possède) :

| Nom | Quoi | Où, droits |
|---|---|---|
| `shh_stripe_cle` | clé Stripe : `sk_test_`/`rk_test_` en essai (`SHH_PREPROD_PAIEMENT_ESSAI=1`), `sk_live_`/`rk_live_` en réel | `<SHH_DATA_ROOT>/secrets`, compte 65532, 0400 |
| `shh_stripe_webhook` | secret de signature du webhook Stripe, `whsec_…` | idem |
| `shh_paypal_secret` | « Secret » de l'application PayPal | idem |
| `shh_nowpayments_cle`, `shh_nowpayments_ipn` | clé d'API et secret IPN de NOWPayments | idem |
| `alerte_smtp_mdp` | mot de passe SMTP des alertes (§4, « Surveillance ») ; ni accent, ni `"`, ni `\` | `/etc/shhdrop`, root, 0600 |
| `alerte_github_jeton` | jeton GitHub « fine-grained » en lecture seule du bilan du lundi (`github_pat_…`, §4, « Jeton GitHub en lecture seule ») | `/etc/shhdrop`, root, 0600 |

Les secrets du serveur ne s'écrivent que volume chiffré ouvert (jamais sur le disque du dessous). Un secret existant n'est jamais remplacé sans `--remplacer`. La valeur n'apparaît ni à l'écran, ni dans l'historique du shell (ce n'est pas un argument), ni dans la liste des processus. Pris en compte : à la prochaine installation (la commande exacte est donnée), au prochain passage de l'alerte pour `alerte_smtp_mdp`.

**Tirés par la machine elle-même**, à chaque `deploy.sh` ou `preprod.sh`, s'ils manquent (une ligne « créé » ou « présent », jamais la valeur, jamais d'écrasement) : jeton de la préproduction (§15), clé du serveur du compte (§12.2 ; **en faire ensuite une copie hors ligne**), secret du relais des appels (§14).

## 4. Commandes d'administration (§15.3)

Elles s'exécutent dans le conteneur en marche. Codes de sortie : 0 réussite, 1 échec, 2 erreur d'usage.

```sh
deploy/deploy.sh admin freeze        # suspend les nouveaux envois
deploy/deploy.sh admin unfreeze      # les rétablit
deploy/deploy.sh admin destroy -     # signalement : coller le lien, Entrée, puis Ctrl-D
deploy/deploy.sh admin wipe --yes    # urgence : gèle, puis efface tous les partages
```

Le lien signalé ne se donne **jamais** en argument (il irait dans l'historique du shell) : toujours sur l'entrée standard.

### Surveillance

- **Sonde externe** (`.github/workflows/sonde.yml`) : toutes les 15 min, GitHub vérifie que l'accueil répond en HTTPS et que le certificat a encore au moins 14 jours (Caddy n'écrit aucun journal : un renouvellement raté ne se verrait pas autrement). Un échec : e-mail de GitHub. À activer après la mise en ligne : variable du dépôt `SHH_SONDE_HOTE` (ex. `shhgone.com`).
- **Code servi** (`.github/workflows/verifier-site.yml` ; spec §28.7) : toutes les heures, GitHub prend les trois dernières Releases `web-v<x.y.z>`, vérifie la signature de chaque manifeste (cosign épinglé, identité exacte de §3.2), puis lance `web/scripts/verify-site.mjs` contre `https://$SHH_SONDE_HOTE` : chaque fichier, ses variantes compressées et le repli monopage doivent être ceux de l'une d'elles (la plus récente, ou l'une des deux d'avant, pour le temps d'une mise en ligne ou d'un retour arrière). Un écart, une signature refusée ou une erreur réseau : échec, donc e-mail de GitHub (jamais « vert » sur une erreur). Inactive, comme la sonde, tant que `SHH_SONDE_HOTE` n'est pas posée, et sans Release. Limites : il ne voit que ce que le serveur lui sert (un serveur compromis peut piéger une seule victime, selon son adresse ou son navigateur) ; un retour à une des deux versions d'avant passe sans alerte (le journal dit laquelle est servie) ; les en-têtes ne sont pas contrôlés. **Préproduction (§15)** : tant que le site rend exactement la page de maintenance (503, marqueur `X-Shhdrop-Etat: maintenance`, corps de `deploy/maintenance.html`), ce job conclut « préproduction, rien à vérifier » sans échouer, et la sonde accepte ce 503 ; tout autre écart reste une erreur. **Trou assumé, à retirer à l'ouverture** (§15.5, risque PP3).
- **Alerte de la machine** (`deploy/alerte.sh`, minuteur `systemd/shhdrop-alerte.timer`, toutes les 15 min ; banc d'essai `deploy/test-alerte.sh`, en CI) : e-mail à `SHH_ALERTE_A` (dans `deploy/.env`, par exemple `contact@shhgone.com`) pour prévenir **avant** que le problème n'arrive. Chaque sujet revient au plus une fois par période : 1 h pour l'urgent, 1 jour ou 7 jours pour ce qui se prévoit.
  - **URGENT** : machine redémarrée (accès possible : vérifier avant de déverrouiller) ; volume chiffré verrouillé ; certificat inconnu dans les journaux publics ; serveur muet ; 5 signalements dans l'heure ; conteneur malade ; disque (données ou système) ou inodes à 90 % ; mémoire disponible sous 10 % ; certificat TLS à moins de 7 jours ; domaine ou location du serveur à moins de 7 jours de l'échéance ; nom de domaine qui ne pointe plus vers la machine (détournement, expiration) ; aucune sauvegarde réussie depuis 26 h ; disque qui annonce une panne (`smartctl`, paquet `smartmontools`).
  - **À prévoir** : disque à 75 %, ou plein dans moins de 14 jours au rythme du jour ; certificat à moins de 21 jours (Caddy renouvelle à 30 : le renouvellement échoue) ; domaine ou location à moins de 45 jours ; échéance du domaine illisible ; mises à jour de sécurité du système en attente ; redémarrage demandé ; commits de retard sur GitHub (correctif à déployer) ; horloge non synchronisée ; unité systemd en échec ; charge trop haute.
  - **Rappel** tous les 30 jours : essayer une restauration (§12). **Bilan du lundi**, un seul e-mail résumé, même sans problème (plus bas, « Bilan du lundi ») : **pas d'e-mail le lundi = alerte** (machine, minuteur ou fournisseur d'envoi).
  - **Intégrité** (URGENT) : différences constatées par le contrôle de la nuit (rappel quotidien ; la liste est dans l'e-mail « URGENT intégrité ») ; contrôle muet depuis 36 h (plus bas, « Intégrité du serveur »).
  - Réglages : `SHH_SERVEUR_ECHEANCE` (fin de la location, à remettre à jour après chaque renouvellement), `SHH_DOMAINE_ECHEANCE` seulement si RDAP ne répond pas. L'échéance du domaine se lit par RDAP (`rdap.org`, qui renvoie au registre : seul le nom du domaine, public, est envoyé). Le retard sur GitHub suppose que la copie du dépôt est un clone `git` à root (§2 ; un `safe.directory` ne suffit pas aux verrous de `deploy.sh`, §3.5). Le message dit `git fetch`, jamais `git pull` (§3.5).
  - Envoi depuis la machine (pas depuis le conteneur, qui n'a pas de sortie) par un fournisseur SMTP : `SHH_ALERTE_SMTP_HOST` (TLS implicite sur 465), avec un **identifiant réservé aux alertes** (par exemple `alertes@shhgone.com`, envoi seulement) dans `SHH_ALERTE_SMTP_USER`, et `SHH_ALERTE_FROM`. Le mot de passe va dans `/etc/shhdrop/alerte_smtp_mdp` (fichier root 0600 : `sudo deploy/secret.sh alerte_smtp_mdp`, saisie masquée), hors du volume chiffré pour que l'alerte parte même volume verrouillé après un redémarrage. Un envoi raté est retenté au passage suivant. Les anciens noms `SHH_SMTP_HOST` et `SHH_MAIL_FROM`, qui servaient aussi au compte par e-mail, sont refusés : les renommer. Ce mot de passe est sur le disque système, en clair : quelqu'un qui lirait ce disque pourrait envoyer des e-mails avec, rien d'autre, d'où un identifiant à part, que l'on change s'il fuit. Aucune donnée d'utilisateur ni adresse IP dans les e-mails ni dans l'état (`/var/lib/shhdrop-alerte` : des dates et un pourcentage par jour). Santé lisible à la main : `deploy/deploy.sh health`.
- Les **demandes des autorités** (Pharos, injonctions) arrivent à `contact@shhgone.com` : notification activée sur le téléphone. Chaque demande traitée va au registre des retraits (`docs/juridique/registre-retraits-modele.md`, tenu hors du serveur).

### Bilan du lundi (un seul e-mail)

Chaque lundi matin (heure UTC, au premier passage de l'alerte après minuit), le serveur envoie **un seul e-mail**, « Shhgone Bilan du lundi : tout va bien » ou « … : N à traiter, M à voir », en quatre sections, une ligne par point avec un verdict (✅ bon, ⚠️ à voir, ❌ à traiter) :

1. **Intégrité du serveur** : empreinte (rien de changé depuis la base), fichiers des paquets Debian conformes, image en cours = image signée vérifiée par `deploy.sh`, et l'empreinte de la base (à comparer, plus bas).
2. **Mises à jour à faire** : système (mises à jour en attente, dont de sécurité ; redémarrage nécessaire ?), retard sur GitHub, et côté GitHub le résultat du dernier passage de `securite.yml` job par job (failles Go, npm, Rust, Caddy, outils épinglés en retard, gosec, Semgrep, contrôle externe du site) et les propositions Dependabot ouvertes (dont une nouvelle image de Caddy).
3. **Santé**, avec les dates et états réels : certificat HTTPS (émetteur, date de fin, renouvellement automatique), nom de domaine (échéance, verrou de transfert lu par RDAP), hébergement (`SHH_SERVEUR_ECHEANCE`), DNSSEC, CAA, SPF, DKIM, DMARC (`dig`), site joignable et temps de réponse, version servie (image vérifiée, et contrôle horaire de GitHub `verifier-site.yml`), disque, mémoire, dernière sauvegarde réussie, maintenance programmée (annoncée, faite, ou ⚠️ dépassée sans redémarrage), dernier redémarrage, mises à jour en attente.
4. **Connexions SSH de la semaine** : nombre, heure, compte, clé (jamais d'adresse IP) ; vérifier que ce sont bien les vôtres.

Les alertes urgentes restent immédiates (toutes les 15 min, et l'alerte SSH à chaque connexion) ; le bilan ne les remplace pas. Rien n'y dépend d'un second serveur.

**Pas d'e-mail le lundi = alerte** : la machine, son minuteur ou son envoi ne marche plus, ou quelqu'un l'a coupé. Vérifier la sonde de GitHub (`sonde.yml` : le site répond-il ?), puis se connecter et lancer `sudo deploy/etat.sh` ; en cas de doute, suivre « Que faire si une alerte d'intégrité arrive ».

DKIM : le bilan essaie les sélecteurs courants (`default`, `google`, `selector1`, `selector2`, `k1`, `mail`, `dkim`, `protonmail`, `s1`, `s2`) ; si celui de votre fournisseur d'e-mail est autre, l'écrire dans `deploy/.env` : `SHH_ALERTE_DKIM_SELECTEURS=<sélecteur>`.

#### Jeton GitHub en lecture seule (partie GitHub du bilan)

Sans lui, la section dit « GitHub : non configuré » et rien n'échoue. Le jeton ne peut **que lire** ce dépôt (résultats des workflows, liste des propositions) : il ne peut ni pousser, ni fusionner, ni lire un autre dépôt. Il est rangé sur le serveur dans `/etc/shhdrop/alerte_github_jeton` (root 0600), jamais affiché.

1. Sur github.com, connecté au compte **Skoow** : photo de profil en haut à droite → **Settings** → tout en bas de la colonne de gauche, **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → bouton **Generate new token**.
2. **Token name** : `shhgone-bilan-lundi`. **Description** : « Bilan du lundi du serveur, lecture seule ». **Resource owner** : `Skoow`. **Expiration** : **Custom**, un an au plus (noter la date : à refaire avant, le bilan dira « jeton expiré » sinon).
3. **Repository access** : **Only select repositories** → choisir **Skoow/shhgone** (et lui seul).
4. **Permissions** → **Repository permissions** : **Actions** : **Read-only** ; **Pull requests** : **Read-only** ; **Metadata** : **Read-only** (ajouté d'office). Tout le reste sur **No access**. Rien dans **Account permissions**.
5. **Generate token**, puis **Copy** (le jeton commence par `github_pat_`). Ne le coller dans aucun message ni conversation.
6. Dans **votre propre fenêtre SSH** sur le serveur : `sudo deploy/secret.sh alerte_github_jeton`, coller le jeton (saisie masquée), Entrée, recommencer pour confirmer. Un jeton classique (`ghp_…`, qui ouvre tous les dépôts du compte) est refusé.
7. Remplacer un jeton expiré ou perdu : en créer un autre (étapes 1 à 5), puis `sudo deploy/secret.sh --remplacer alerte_github_jeton` ; supprimer l'ancien sur la page **Fine-grained tokens** (**Delete**).

### Intégrité du serveur

Décision du propriétaire du 28 novembre. **Tout s'installe et se met à jour par `deploy.sh` ou `preprod.sh`** (`installer-surveillance.sh`, à chaque installation) : rien à taper, aucun secret. Ce qui est posé :

- **AIDE** (paquet Debian, sans ses recommandations ; le contrôle quotidien propre au paquet, s'il est là, est masqué), `jq` et `dig` (bilan du lundi) ;
- les minuteurs `shhdrop-alerte.timer` (15 min), `shhdrop-journal.timer` (purge du journal) et **`shhdrop-integrite.timer`** (chaque nuit, 02:43 UTC), avec le chemin de la copie du dépôt ;
- l'**alerte à chaque connexion SSH** (ci-dessous) ;
- **SFTP et scp coupés** : la ligne `Subsystem sftp` de la configuration de `sshd` est mise en commentaire, après `sshd -t` (sinon elle est remise telle quelle), puis `sshd` est rechargé (les sessions ouvertes restent). La connexion SSH par clé, les commandes à distance et le tunnel du tableau de bord (`ssh -N -L`) marchent toujours ; aucun script ne se sert de SFTP ni de scp (vérifié le 28 novembre). Pour copier un fichier, passer par `ssh … cat`.

**Contrôle de la nuit** (`deploy/integrite.sh verifier`), comparé à l'« empreinte du serveur sain » :

1. **Fichiers des paquets Debian** : `dpkg --verify`, qui compare aux sommes des paquets officiels ; après une mise à jour automatique, le fichier remplacé est de nouveau conforme (pas de fausse alerte). Les fichiers de configuration sont laissés à AIDE. Un écart déjà là à la première base (par exemple des fichiers de documentation absents d'une image minimale) est accepté et dit dans l'e-mail de la base.
2. **AIDE**, limité à ce que les paquets ne couvrent pas : dans `/etc`, ce qui commande l'accès et le démarrage (SSH, sudo, systemd, Docker, APT, cron, comptes, PAM, chargeur, `sysctl`, `/etc/shhdrop`, pare-feu…) ; `~/.ssh` (sans `known_hosts`) et fichiers de démarrage du shell de root et des comptes ; crontabs ; `/usr/local` ; `/opt` dont la copie du dépôt (scripts, `compose.yaml`, `Caddyfile`, `deploy/.env`, `.git/config` et `.git/hooks` ; pas les objets de git, que `alerte.sh` change chaque jour et que les verrous vérifient) ; binaires et unités système hors paquets (présence et droits ; leur contenu est celui de `dpkg --verify`) ; volume chiffré monté : ses dossiers (droits) et ses secrets (empreinte et droits, **jamais la valeur dans un rapport**). Exclusions motivées : tout ce qui change normalement (le reste de `/etc`, données, `caddy/`, journal de git, verrou d'installation). Un fichier changé ou ajouté dont le contenu est **exactement** celui d'un paquet officiel (mise à jour automatique), ou retiré par dpkg, est accepté : la base se met à jour seule et un e-mail « Intégrité : base mise à jour » le dit.
3. **Bases de données** : pas leur contenu (il change sans cesse) ; propriétaire et droits (65532, 0600), version du schéma (en-tête du fichier, lu sans ouvrir SQLite : aucun verrou) égale à celle du code installé, et aucun autre programme que le serveur (ou la sauvegarde de la nuit) qui les a ouvertes en écriture.
4. **Conteneurs** : chaque conteneur en marche tourne sur l'image signée vérifiée par `deploy.sh` (`deploy/.release`) ou sur le Caddy épinglé de `compose.yaml`, à l'empreinte près ; aucun autre conteneur.
5. **Conformité** : SFTP coupé, alerte SSH en place, journaux sans adresse IP (mêmes contrôles que `deploy.sh`).

Toute différence → e-mail **« URGENT intégrité »** avec la liste (chemins et contrôles, jamais de contenu, jamais d'adresse IP), chaque nuit tant qu'elle dure, plus un rappel URGENT par jour de `alerte.sh` ; rien de changé → silence (le bilan du lundi le dit). Contrôle muet depuis 36 h → URGENT `integrite-muette`.

**Réinitialisation automatique** après un changement légitime : `deploy.sh` et `preprod.sh` (à la fin, réussite ou échec, dès que les verrous sont passés), `secret.sh` et `admin-jeton.sh` refont la base et envoient « Intégrité : base refaite (raison) » avec **la liste de ce qu'elle accepte**. Lire cette liste : un chemin que vous n'attendiez pas (par exemple `/root/.ssh/authorized_keys` alors que vous n'avez touché à aucune clé) est une alerte. Après une modification à la main de `deploy/.env` sans réinstaller : `sudo deploy/integrite.sh refaire "deploy/.env modifié"`.

**Copie hors du serveur, et comment comparer** : chaque e-mail « Intégrité : base … » donne la nouvelle empreinte de la base et la précédente (`Base d'intégrité : 3f2a-91c0-77de-0b12 (précédente : …)`), et chaque e-mail URGENT et chaque bilan du lundi l'empreinte en service. Règle, une seule : **l'empreinte du bilan du lundi doit être la « Base d'intégrité » du dernier e-mail « Intégrité : base » reçu** (chercher « Intégrité : base » dans la boîte). Une autre empreinte sans e-mail qui l'annonce : la base a été changée en douce, suivre la section suivante. Garder ces e-mails (ne pas les supprimer) : ils sont la copie hors du serveur. `sudo deploy/integrite.sh empreinte` affiche l'empreinte en service.

**Choix écarté** : verrouiller les fichiers de déploiement par `chattr +i` (contournable par root en une commande, et source de blocages pendant les mises à jour).

**Limites** : un attaquant devenu root peut tout réécrire sur la machine, base, scripts, e-mails compris ; ce contrôle voit un attaquant pressé ou maladroit, pas un attaquant qui prend son temps. C'est pourquoi le bilan du lundi (s'il cesse, c'est une alerte), la sonde de GitHub (`sonde.yml`, `verifier-site.yml`, contrôle externe du lundi) et la comparaison des empreintes dans la boîte de réception, hors du serveur, comptent autant. `dpkg --verify` compare à des sommes (MD5) gardées sur la machine elle-même ; les bibliothèques (`/usr/lib`) ne sont contrôlées que par lui (un fichier ajouté hors paquet n'y est pas vu).

### Alerte à chaque connexion SSH

À chaque ouverture de session SSH (connexion, commande à distance, tunnel), **un e-mail part aussitôt** : heure, compte, empreinte de la clé utilisée (et le nom de cette clé dans `authorized_keys`), **jamais l'adresse IP** (`PAM_RHOST`, `SSH_CONNECTION` ne sont jamais lus). Ligne `pam_exec` « optional » de `/etc/pam.d/sshd`, posée par `deploy.sh` ; le script rend la main tout de suite et envoie en arrière-plan : un e-mail raté ou lent **ne bloque jamais la connexion**. Il garde aussi la connexion (heure, compte, clé ; aucune adresse) 35 jours dans `/var/lib/shhdrop-ssh/connexions`, pour le bilan du lundi. `user_readenv=1` est retiré de `/etc/pam.d/sshd` (l'environnement d'un compte ne doit pas atteindre un programme lancé en root par PAM). Journal de `sshd` : `LogLevel QUIET`, journald en mémoire une heure au plus, aucun syslog, registres des connexions vers `/dev/null` (§1, vérifiés par `deploy.sh` et chaque nuit) : aucune adresse sur le disque. Une connexion que vous n'avez pas faite : section suivante.

### Que faire si une alerte d'intégrité arrive

« URGENT intégrité », connexion SSH que vous n'avez pas faite, contrôle muet, empreinte qui ne correspond pas, ou pas de bilan le lundi :

1. **Ne rien toucher sur le serveur, ne pas redémarrer** (un redémarrage efface la mémoire, seule trace de ce qui tourne), **ne lancer aucune installation** (`deploy.sh sha256:…`, `preprod.sh`, `secret.sh` : elles referaient la base et accepteraient la différence ; `deploy.sh admin freeze` reste possible).
2. **Garder tous les e-mails** (alertes, bases, bilans) : ne rien supprimer, les transférer à une deuxième adresse si possible.
3. Se demander si c'est vous : une mise à jour, `secret.sh`, une modification de `deploy/.env`, une clé SSH ajoutée, à l'heure dite ? Si oui, et que la liste ne contient **que** cela : `sudo deploy/integrite.sh refaire "ce que vous avez fait"`, puis vérifier l'e-mail « base refaite ».
4. Sinon, depuis votre poste, regarder sans rien changer : `ssh … sudo deploy/integrite.sh verifier` (relit, renvoie la liste), `ssh … sudo deploy/etat.sh`, `ssh … 'sudo docker ps -a'`. Ne pas éditer ni effacer les fichiers listés.
5. Doute qui reste : **plan d'incident (§6)** : geler (`deploy/deploy.sh admin freeze`), changer la clé SSH depuis un autre poste et les accès (GitHub, registraire, SMTP des alertes), demander à l'hébergeur une copie du disque si une enquête est envisagée, puis réinstaller une machine neuve (§1, §2) plutôt que réparer celle-ci.

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

Une page qui réunit tout ce qu'un administrateur peut voir et faire sans SSH, **en nombres seulement** (jamais un identifiant, une adresse IP, un pseudo, un pass, une commande, un montant ni un contenu ; rien n'est enregistré, les compteurs « depuis le démarrage » repartent de zéro à chaque redémarrage). Conception : `docs/conception/specs/2026-11-13-tableau-de-bord-admin-design.md` (§ « Tableau de bord finalisé » et « Version finale »).

- **État** : santé, stockage, activité, appels audio et vidéo (relais configuré, appels proposés, salons aux appels ouverts, identifiants du relais donnés), charge et places, mémoire.
- **Signalements**, **Bannissements**, **Comptes** (nombre, inscrits aujourd'hui et ces 7 jours, ancienneté, passkeys, sessions, bannis).
- **Paiement** (avec `SHH_PAIEMENT: "1"`) : pass Plus et Pro valables, abonnements, commandes en attente, anomalies ; par prestataire (Stripe, PayPal, NOWPayments) les pages créées, paiements crédités, remboursements et litiges, **webhooks refusés** ; jetons anonymes émis, dépensés, rendus.
- **Usage** : partages et salons créés, partages payants par offre, volume chiffré reçu et servi, plafond de sortie par partage (`SHH_SHARE_EGRESS_MAX`) et refus à ce plafond.
- **Actions** : geler et dégeler les créations ; **suspendre et rétablir les ventes** (jusqu'au prochain redémarrage ; les paiements en cours sont crédités, les pass payés gardent leurs droits) ; détruire un lien signalé. `wipe` n'y est pas, volontairement : il reste en ligne de commande. Couper les appels : `sudo docker stop shhdrop-relais-turn-1` par SSH (il repart à la prochaine installation).

Elle est servie par un **écouteur à part**, jamais par Caddy, jamais sur le port public, et sur aucun port publié par Docker : l'adresse `172.30.53.2` est celle du conteneur sur le réseau interne (`internal: true`), que seule la machine elle-même peut joindre. On y arrive depuis son poste par un **tunnel SSH**. Sans `SHH_ADMIN_LISTEN`, elle n'existe pas.

**Prérequis dans `compose.yaml`** (service `shhdrop`, section `environment`) : les deux lignes ci-dessous doivent y être, sinon les réglages de `deploy/.env` ne parviennent pas au conteneur et rien ne se passe. Elles sont sans effet tant que `deploy/.env` ne pose pas `SHH_ADMIN_LISTEN` :

```yaml
      SHH_ADMIN_LISTEN: ${SHH_ADMIN_LISTEN:-}
      SHH_ADMIN_TOKEN_SHA256: ${SHH_ADMIN_TOKEN_SHA256:-}
```

#### Le plus simple : `admin-jeton.sh`, sur le serveur

Dans **votre propre fenêtre SSH** (jamais dans une session Claude) : `cd /opt/shhdrop && sudo deploy/admin-jeton.sh`. Le script tire le jeton (256 bits), écrit `SHH_ADMIN_LISTEN=172.30.53.2:9191` et l'**empreinte** dans `deploy/.env` (mêmes propriétaire et droits ; une ancienne ligne `SHH_ADMIN_TOKEN` en clair est retirée), affiche le jeton **une seule fois**, attend Entrée puis efface l'écran et son historique de défilement, donne la commande exacte du tunnel à lancer depuis PowerShell (étape 5 ci-dessous), et propose de réinstaller la version en service (étape 4). Le jeton n'est écrit nulle part sur le serveur. Changer de jeton : `sudo deploy/admin-jeton.sh --remplacer` (sans cette option, un jeton existant n'est jamais remplacé).

Différence avec la méthode ci-dessous : le jeton est tiré **sur le serveur** et passe par sa mémoire et votre terminal. Root du serveur a déjà tout ce que le tableau de bord donne ; une session Claude sur le serveur ne peut pas lancer le script (terminal exigé). Effacer aussi le presse-papiers de Windows (Win+V) après l'avoir rangé.

#### Mise en route depuis un poste Windows (PowerShell), préproduction ou production

1. **Tirer le jeton, sur son poste** (méthode sans `admin-jeton.sh` : le jeton ne passe jamais par le serveur). Ouvrir PowerShell (pas en administrateur) et coller :

   ```powershell
   $b = New-Object byte[] 32
   [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   $jeton = -join ($b | ForEach-Object { $_.ToString('x2') })
   $sha = [System.Security.Cryptography.SHA256]::Create()
   $empreinte = -join ($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($jeton)) | ForEach-Object { $_.ToString('x2') })
   "Jeton (à ranger, ne va jamais sur le serveur) : $jeton"
   "Empreinte (va dans deploy/.env)              : $empreinte"
   ```

   Le jeton fait 64 caractères (0-9, a-f), l'empreinte aussi : ne pas les confondre. Commandes équivalentes sous Linux ou macOS : `JETON=$(openssl rand -hex 32)` puis `printf '%s' "$JETON" | sha256sum | cut -c1-64` (`printf '%s'`, jamais `echo`, qui ajouterait un saut de ligne et changerait l'empreinte).

2. **Ranger le jeton dans Apple Mots de passe** (application « Mots de passe » d'iCloud pour Windows, ou sur l'iPhone) : nouvelle entrée, site `127.0.0.1`, identifiant `admin-preprod` ou `admin-prod`, mot de passe = le jeton. **Un jeton différent par serveur** (préproduction et production). Ne pas le laisser enregistrer par le navigateur. Puis effacer les variables : `Remove-Variable b, jeton, empreinte, sha`. Si on l'a copié avec Ctrl-C, l'historique du presse-papiers de Windows (Win+V) le garde : l'y effacer.

3. **Mettre l'empreinte sur le serveur.** Se connecter (`ssh ubuntu@54.38.93.126`), puis ouvrir le fichier de réglages : `sudo nano /opt/shhdrop/deploy/.env`, et ajouter :

   ```sh
   SHH_ADMIN_LISTEN=172.30.53.2:9191
   SHH_ADMIN_TOKEN_SHA256=<l'empreinte, 64 caractères>
   ```

   Jamais le jeton lui-même : ni dans `deploy/.env`, ni dans `compose.yaml`, ni dans un message. Le serveur ne compare que des empreintes, dont on ne peut pas retrouver le jeton.

4. **Relancer** la version en service : `cd /opt/shhdrop && sudo deploy/deploy.sh status` (relever l'empreinte `sha256:…` en service), puis `sudo deploy/deploy.sh sha256:<cette empreinte>`. Contrôle : `sudo deploy/deploy.sh status` montre le serveur en bonne santé (une empreinte mal formée l'empêche de démarrer et l'installation revient en arrière ; lire la raison avec `sudo deploy/deploy.sh diagnose`). Le conteneur n'a aucun journal : la preuve que la page répond, c'est l'étape 6.

5. **Ouvrir le tunnel, depuis PowerShell sur son poste** (OpenSSH est fourni avec Windows 10 et 11) :

   ```powershell
   ssh -N -L 127.0.0.1:9191:172.30.53.2:9191 ubuntu@54.38.93.126
   ```

   La fenêtre reste ouverte sans rien afficher : c'est normal, le tunnel vit tant qu'elle est ouverte (Ctrl-C le ferme). `-N` : aucune commande sur le serveur. Si le port 9191 est déjà pris sur le poste, prendre un autre port à gauche (`127.0.0.1:9292:172.30.53.2:9191`) et l'ouvrir à l'étape suivante.

6. **Ouvrir `http://127.0.0.1:9191`** dans le navigateur (exactement `127.0.0.1`, pas `localhost` : si `[::1]:9191` est pris sur le poste, un navigateur qui essaie `::1` d'abord enverrait le jeton à l'autre programme). Coller le jeton depuis Apple Mots de passe, « Ouvrir ». `http` est normal : le trafic passe chiffré dans le tunnel SSH.

7. **Fermer** : fermer l'onglet (le jeton est oublié), puis Ctrl-C dans la fenêtre du tunnel.

Le serveur ne répond qu'à la boucle locale et à la machine (`SHH_TRUSTED_PROXY`), et seulement sous les noms `localhost`, `127.0.0.1` ou `172.30.53.2` (en-tête `Host`, n'importe quel port) : un autre nom reçoit la même réponse qu'une route inconnue (protection contre le « DNS rebinding » et contre une ligne de Caddy qui relaierait le nom public vers ce port). Changer le jeton : en tirer un autre (étape 1), changer l'empreinte (étape 3) et relancer (étape 4). Le couper : retirer `SHH_ADMIN_LISTEN` de `deploy/.env` et relancer.

**Variable refusée en production.** `SHH_ADMIN_TOKEN` (le jeton en clair) n'est accepté que pour le développement local (sans `SHH_BEHIND_PROXY`). Derrière le proxy déclaré, sa seule présence empêche le serveur de démarrer, tableau de bord activé ou non, avec un message qui donne la commande ci-dessus ; `shhdrop admin` refuse aussi (même configuration). Les deux variables ensemble : refusé. Une empreinte mal formée (pas 64 chiffres hexadécimaux en minuscules, ou celle d'un jeton vide) : refusé, sans afficher la valeur. Si l'écouteur d'administration ne s'ouvre pas (port pris), le site public démarre quand même. Contrepartie : le serveur ne peut plus vérifier la qualité du jeton (une empreinte ne dit rien de ce qu'elle résume) ; c'est la commande de tirage qui la garantit : n'en employer aucune autre.

Le jeton reste dans la mémoire de l'onglet, jamais dans le stockage du navigateur : il se redemande après un rechargement. La page l'oublie et revient à la saisie dès qu'une lecture de l'état est refusée (le serveur ne le reconnaît pas : redémarré avec une autre empreinte, ou autre programme sur le port) ou reste sans réponse trois fois de suite (tunnel coupé), et quand l'onglet est fermé : sinon elle le renverrait toutes les 5 s à quiconque répond ensuite sur ce port.

**Essais de jetons faux** : chaque jeton faux retarde de 250 ms toutes les réponses du tableau de bord, bonnes ou fausses (délai global, rien n'est gardé par adresse), jusqu'à 2 s au plus. Une suite d'essais sur une connexion est donc ralentie à 4 par seconde au plus ; des connexions simultanées en font plus (au plus une par connexion toutes les 2 s) : c'est un frein, pas un verrou, et le jeton de 256 bits reste la vraie protection. L'exploitant n'est jamais refusé : pendant une attaque, chaque lecture lui prend au plus 2 s.

**Accès offerts** (paiement activé, onglet Paiement) : « Offrir un accès » crée un accès Pro sans paiement (1 mois, 1 an ou « sans fin » = 10 ans ; conception du paiement §5.8) et affiche **une seule fois** le lien `https://<domaine>/offres/offert#…` : le copier, le transmettre à la personne par un canal privé (il donne l'accès à qui le possède), puis « Transmis : effacer de la page » et vider le presse-papiers. Un nom ou pseudo peut être donné à chaque accès (à la création ou par « Nommer », 40 caractères au plus) : il est gardé en clair sur le serveur avec l'accès (paiements.db, donc aussi dans la sauvegarde), visible depuis tout navigateur ouvert avec le jeton, et effacé avec l'accès 31 jours après sa fin ; n'y mettre que ce qui suffit pour savoir à qui l'accès a été donné. Les noms gardés avant dans le navigateur sont repris une fois sur le serveur à l'ouverture de la liste, puis effacés du navigateur. « Révoquer » coupe l'accès tout de suite (les jetons déjà reçus valent au plus jusqu'au surlendemain). La personne qui se connecte à son compte sur la page du lien (ou après) y range l'accès et le retrouve sur ses autres appareils.

À savoir : tout compte local de la machine peut joindre le port ; le jeton est alors la seule barrière. La mémoire du serveur garde, le temps que le ramasse-miettes la récrive, la copie des en-têtes des dernières requêtes du tableau de bord, jeton compris, et le lien collé dans « Détruire » dans le tampon de lecture de la connexion (le serveur n'en garde lui-même aucune copie : il le traite en octets et efface les siens). Changer le jeton = en tirer un autre, changer l'empreinte dans `deploy/.env` et relancer.

## 5. Redémarrer la machine (maintenance programmée)

Le site reste hors service tant que le volume n'est pas déverrouillé (les conteneurs ne démarrent pas sans lui). Un redémarrage ne perd plus rien de ce que les visiteurs font (envois, lectures, salons, pièces de salon : §3.4, §10) ; l'annonce sert à ce qu'ils sachent pourquoi le site ne répond pas, et à ce qu'aucune nouvelle création ne commence juste avant.

**Procédure** (D42-32), sur le serveur, dans `/opt/shhdrop` :

```sh
# 1. Annoncer, au moins quelques heures avant (heure de Paris ; durée honnête, voir plus bas).
#    Bandeau sur tout le site dans les 5 minutes (heure locale de chaque visiteur) ;
#    10 min avant l'heure (réglable : 4e argument, de 1 à 120), le serveur refuse les NOUVELLES
#    créations (partage, salon, pièce de salon, inscription au compte, commande de paiement) et
#    le site désactive ces boutons ; ce qui est en cours continue. Sans secret : utilisable
#    depuis une session Claude.
sudo deploy/maintenance.sh annoncer "2026-12-02 06:00" 30
sudo deploy/maintenance.sh etat          # où en est l'annonce (aussi dans etat.sh)
# 2. À l'heure : redémarrer.
sudo reboot
# 3. Se reconnecter en SSH (1 à 3 min ; l'e-mail « URGENT redemarre » de l'alerte arrive : c'est
#    vous), puis, dans VOTRE fenêtre SSH (la phrase de passe du volume se tape au clavier, saisie
#    masquée ; jamais dans une session Claude) :
sudo cryptsetup open /dev/sdb shhdrop
sudo mount -o noatime,nodev,nosuid,noexec /dev/mapper/shhdrop /srv/shhdrop
# 4. Remettre le service (provenance et verrous revérifiés, §3.4, §3.5) :
sudo deploy/deploy.sh "$(cat deploy/.release)"
# Préproduction (deploy/.release commence par « preprod: ») : sudo deploy/preprod.sh "$(cat deploy/.release.commit)" (§15)
# 5. Vérifier : « Maintenance programmée : faite », conteneurs en bonne santé, certificat.
sudo deploy/etat.sh
```

**Temps à annoncer, honnêtement** : arrêt et redémarrage de la machine, 1 à 3 min ; **déverrouillage du volume par le propriétaire, l'étape la plus longue** : il faut être devant son ordinateur, se reconnecter et taper la phrase de passe, compter 5 à 15 min selon votre disponibilité (rien ne se fait sans vous) ; réinstallation et contrôle de santé, 2 à 4 min (vérification de la provenance par le réseau, démarrage, contrôle à travers Caddy) ; reprise des salons au démarrage, quelques secondes. **Annoncer 30 min** laisse de la marge ; si l'heure est dépassée, rien ne casse : le bandeau disparaît et les créations rouvrent à la fin annoncée même sans redémarrage (jamais de site fermé sans fin), et l'annonce reste visible dans `etat.sh` et le bilan du lundi (« dépassée »).

**Après** : rien à faire. Le serveur, une fois redémarré, ne refuse plus rien, et efface l'annonce de lui-même quand la durée est passée (`sudo deploy/maintenance.sh annuler` l'efface tout de suite, ou annule une maintenance qui n'aura pas lieu). Une mise à jour (`deploy.sh` avec une nouvelle Release) peut se faire de la même façon : annoncer, puis lancer `deploy.sh` à l'heure (le redémarrage du conteneur compte comme le redémarrage annoncé) ; c'est conseillé quand la mise à jour change un schéma de base (§3.4).

Ce que l'annonce montre au public : la date, l'heure de début et la durée, rien d'autre (route `GET /api/etat-service`, lue au chargement de chaque page puis toutes les 2 à 5 min ; aucune donnée d'utilisateur ; les apps liront la même). Le fichier de l'annonce (`<SHH_DATA_ROOT>/data/maintenance`, une ligne, compte 65532, 0600) est sur le volume chiffré : il survit au redémarrage du conteneur, et le serveur le relit au démarrage. Une annonce illisible est ignorée par le serveur (jamais de créations fermées par erreur) et signalée par `etat.sh`.

## 6. Plan d'incident (§15.5)

En cas de doute sur la sécurité du serveur ou du code :

1. `deploy/deploy.sh admin freeze`, puis `deploy/deploy.sh admin wipe --yes` si nécessaire.
2. Changer les accès : clés SSH, GitHub, registraire, registre d'images.
3. Réinstaller le serveur depuis zéro (nouvelle machine, nouveau volume chiffré, §1 et §2). Ne pas reprendre `/srv/shhdrop/caddy` : nouvelles clés TLS, et révoquer les anciens certificats. Compte activé : la **clé du serveur** (§12.2) est à tenir pour connue de l'attaquant, avec `comptes.db`. Il peut alors tester des pseudos un à un. Il ne peut ni ouvrir les coffres, ni se faire passer pour une passkey, ni utiliser une clé de récupération : `v_r` est l'empreinte d'un secret de 128 bits. Elle ne peut pas être changée sans perdre l'unicité des pseudos existants (conception §5.2) : la décision revient au propriétaire, avant de reprendre la base. Changer aussi l'identifiant SMTP des alertes et l'accès au stockage des sauvegardes.
4. Publier un avis sur le site.
5. **Violation de données personnelles (RGPD art. 33 et 34).** Elle est probable dès qu'un tiers a pu lire `comptes.db` (pseudos sous forme d'empreinte, clés publiques des passkeys, `v_r`, coffres chiffrés), `paiements.db` (empreintes des pass, commandes, références des prestataires) ou une de leurs sauvegardes, ou dès que le serveur a été pris (il voit en direct les adresses IP, les pass `P` aux routes du paiement, et peut servir un code du site modifié qui lirait les clés des visiteurs). Les partages et les salons sont chiffrés sur l'appareil : leur seule lecture n'est pas, en soi, une violation à risque, sauf code du site modifié.
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
# www : 308 vers le site, chemin et requête gardés (attendu : « 308 https://$D/a?b=1 »).
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://www.$D/a?b=1"

# 5. DNS.
dig +short CAA $D ; dig +dnssec +short $D | head -n 2
dig +short A www.$D ; dig +short AAAA www.$D   # 54.38.93.126 et 2001:41d0:403:1f7e::
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
  --entrypoint /shhcheck "ghcr.io/skoow/shhgone@$(cat deploy/.release)" tls 127.0.0.1:443 $D    # « TLS 1.3, X25519MLKEM768 »
```

## 8. Tester le kit

```sh
CADDY=/chemin/vers/caddy deploy/test-proxy.sh     # Caddy 2.10 ou plus, curl 7.83 ou plus, Go, python3, web/dist construit (≈ 2 min 30 : WebSocket gardé 75 s) ; lance aussi test-preprod.sh (barrière, §15)
CADDY=/chemin/vers/caddy deploy/test-preprod.sh   # barrière de préproduction seule (≈ 10 s)
make lint-deploy                                  # bash -n, ShellCheck, bancs de l'alerte, des journaux, de l'image et de la provenance (Node exigé), des verrous (git, ssh-keygen ; partie préproduction de preprod.sh en root seulement : sudo deploy/test-verrous.sh) et des outils (test-outils.sh : deploy/.env, secrets ; commandes du quotidien pour de vrai en root seulement, avec python3 : sudo deploy/test-outils.sh), go vet et tests de shhcheck
SHH_IMAGE=shhdrop:ci make test-sortie             # sorties : configuration, puis réseau réel (démon Docker ; code 3 sans démon)
sudo make test-restauration                       # sauvegarde et restauration d'un compte de test, en mémoire (≈ 45 s)
```

Le binaire Caddy à donner est celui de l'image épinglée par empreinte dans `compose.yaml` : `docker create` de cette image puis `docker cp …:/usr/bin/caddy` (ce que fait la CI), ou, sans démon Docker, l'index de l'image, son manifeste linux/amd64 et ses couches lus dans le registre, chacun contrôlé par son empreinte SHA-256 avant d'extraire `/usr/bin/caddy`. L'essai long du WebSocket du salon (condition d'activation, §10) : `SALON_GARDE=660` (≈ 14 min en tout).

La CI fait les deux à chaque push : `deploy-lint` (ShellCheck 0.11.0 épinglé), et `repro-docker`, qui construit l'image complète puis lance `test-proxy.sh` avec ses binaires, son site et le Caddy de l'image épinglée dans `compose.yaml`.

`test-proxy.sh` est à relancer à chaque changement du `Caddyfile` ou de version de Caddy : c'est le seul test de la ligne dont dépendent les quotas et l'anti-robot.

### Vérification de sécurité hebdomadaire

`.github/workflows/securite.yml` tourne chaque lundi à 04:17 UTC et à la demande (onglet Actions, « Run workflow »). Jobs : `govulncheck ./...` (server/, relais), failles du binaire de Caddy, outils épinglés à la main en retard (`deploy/outils-a-jour.sh`, dont gosec et Semgrep), fuzzing, `npm audit --omit=dev --audit-level=moderate` (web/, plus un audit complet informatif qui ne fait pas échouer), `cargo audit --deny warnings` (engine/, mêmes exceptions que la CI : `engine/.cargo/audit.toml`), et, décision du 28 novembre :

- **gosec** v2.30.0 sur `server/` et `deploy/shhcheck`, et **Semgrep OSS** 1.186.0 (règles publiques `semgrep/semgrep-rules` à un commit épinglé, dossiers `go`, `javascript`, `typescript`) sur Go, TypeScript et JavaScript, **sans compte ni envoi de code** (`--metrics=off`, règles lues depuis leur dépôt). Chaque résultat actuel a été relu le 28 novembre (aucun vrai problème) et figure, avec son motif, dans `deploy/analyse/gosec-acceptes.txt` ou `semgrep-acceptes.txt`, une ligne par résultat (règle, fichier, ligne de code : aucune règle coupée partout). **Un résultat nouveau fait échouer le job** (`deploy/analyse-acceptes.sh`) : le corriger avec un test, ou, faux positif, ajouter sa ligne sous le bon motif ;
- **contrôle externe du site** (`site`, si `SHH_SONDE_HOTE` est posée) : ports TCP ouverts attendus seulement (22, 80, 443, 3478 ; 80 et 443 exigés), relais des appels en UDP 3478 (STUN ; un balayage UDP ne prouverait rien), TLS 1.3 avec X25519MLKEM768 (`shhcheck`), TLS 1.2 refusé, HTTP redirigé en 308, les 8 en-têtes de sécurité une fois chacun (HSTS long, `nosniff`, CSP sans `unsafe-inline` ni `*`). En préproduction, les en-têtes du serveur sont derrière la barrière : non vérifiés, et c'est dit (aucun jeton dans la CI). La version servie = la version signée est déjà vérifiée toutes les heures par `verifier-site.yml`, et la réponse du site toutes les 15 min par `sonde.yml` : rien de refait. IPv4 seulement.

Aucun secret. Le résultat de chaque job est aussi repris dans le bilan du lundi du serveur (jeton GitHub en lecture seule, §4).

Un job rouge = une faille connue : GitHub envoie un e-mail d'échec au propriétaire (vérifier que les notifications Actions sont actives pour le dépôt). Pas d'issue automatique. Marche à suivre : lire le journal du job, mettre la dépendance à jour (tests), ou noter l'exception et sa date de réexamen (jamais d'ignore silencieux). Si GitHub n'a lancé aucune exécution pendant 60 jours sans activité sur le dépôt, il désactive les workflows planifiés : les réactiver dans l'onglet Actions.

## 9. Ce que ce kit ne fait pas

- **Démarches légales (§17)** : avis d'un juriste sur la conservation des données d'identification (LCEN, décret 2021-1362, en conflit avec « aucune adresse IP enregistrée »), point de contact DSA, déclaration ANSSI, mentions légales, CGU. Rien n'ouvre au public avant.
- **Provenance du code (§28.7)** : en place, `release.yml` signe le manifeste du site (cosign sans clé), `deploy.sh` refuse une image dont le site n'est pas celui d'un manifeste signé et vérifie le site servi à travers Caddy (§3), une surveillance horaire compare le site en ligne aux derniers manifestes signés (`.github/workflows/verifier-site.yml`, §4), les verrous de mise en ligne V1 à V3 s'appliquent (§3.5 : commits signés par une clé autorisée, aucune histoire réécrite, commit confirmé par le propriétaire), et l'image est construite par `release.yml` sur deux machines (même empreinte exigée, `deploy/construire-image.sh`), publiée sur `ghcr.io/skoow/shhgone`, signée sans clé, liée au manifeste par `image.json` signé ; `deploy.sh` vérifie tout cela avant de la télécharger (§3.2). **Reste** : (0) V4, la clé du propriétaire (la clé de développement est partagée par l'environnement de développement, §3.5) ; (1) la reproductibilité de l'image sur les machines de GitHub, la signature de l'image sur ghcr.io et sa vérification sans identifiant ne seront prouvées qu'à la première Release ; (2) la première étiquette `web-v<x.y.z>` et la protection des étiquettes `web-v*` (règle du dépôt, création réservée au propriétaire) sont à faire par le propriétaire ; (3) la vérification ne protège pas une victime ciblée par un serveur compromis (spec §28.8) ; (4) `verify-site.mjs` ne contrôle pas les en-têtes (CSP…) ; (5) la démo (GitHub Pages) n'est pas signée (Q-C3).
- **Déverrouillage (§22)** : pas de `deploy/unlock.sh` ; les commandes du §5 en tiennent lieu (la phrase de passe ne se tape que dans votre fenêtre SSH). Pas d'alerte « redémarrage nécessaire ».
- **Dates et tailles des fichiers**. Les dates de contenu et d'accès sont au 1er janvier 1970 ; la date de changement d'inode (`ctime`) de tous les fichiers est ramenée, une fois par minute, à l'heure de ce passage. Restent lisibles par qui lit le disque déverrouillé : la **date de création** (`btime`, sur ext4) de chaque fichier de partage, de pièce et de conversation, qu'aucun appel système ne permet de changer, donc l'heure de création de chaque partage vivant et du premier message de chaque salon ; pendant une minute au plus, le `ctime` d'un fichier qui vient d'être écrit ; la taille d'une conversation, par paliers de 64 messages (plus le nombre exact) ; l'ordre de création (numéros d'inode). Le dossier de données lui-même, `frozen`, `kill/`, `kill.key`, `shares.db`, `shares.db-wal` et `shares.db-shm` ont leurs dates de contenu et d'accès remises à l'epoch à chaque passage du janitor (une fois par minute) et leur `ctime` ramené à l'heure de ce passage : l'heure du dernier gel, dégel, destruction par l'administrateur ou écriture en base ne se lit plus qu'à la minute près ; un gel et un dégel remettent aussi les dates aussitôt. Restent : la **date de création de `frozen`**, qui donne l'heure du gel en cours tant qu'il dure, et celle de `kill/`, créé au premier passage du serveur (heure du démarrage, sans rapport avec une destruction). Seuls le volume chiffré et l'absence d'instantanés les protègent.
- **Sauvegardes** : aucune pour les partages et les salons, et c'est voulu. La spécification les interdit pour les données (§9.2 : « aucune sauvegarde de ce dossier ») : des partages chiffrés qui vivent 24 h n'ont rien à restaurer, et une sauvegarde garderait ce qui doit disparaître. **Seules exceptions : `comptes.db` (compte activé) et `paiements.db` (paiement activé)**, chiffrées chaque jour (§12.4 ; conception du compte §21.13 ; conception du paiement §5.1 : perdre `paiements.db` rendrait inutilisables les pass payés). À sauvegarder ailleurs que sur le serveur : `deploy/.env` et la phrase du volume, plus, compte activé, la **clé du serveur** (§12.2), chacun à part. `deploy/.env` ne contient aucun secret qui ouvre quoi que ce soit : avec le tableau de bord, seulement l'**empreinte** du jeton (§4), qui ne permet pas de le retrouver ; le jeton lui-même se garde dans le gestionnaire de mots de passe de l'exploitant, jamais avec cette sauvegarde. Un `SHH_ADMIN_TOKEN` en clair n'y a pas sa place (le serveur refuse de démarrer avec lui, §4). Le dossier `caddy/` se recrée seul (nouveau certificat).
- **Durcissement de la machine** : les réglages du §1 (journald, pare-feu, SSH, mises à jour) sont à faire à la main ; `deploy.sh` ne pose lui-même que la surveillance (§4, « Intégrité du serveur » : AIDE, minuteurs de l'alerte, de la purge du journal et de l'intégrité, alerte SSH, SFTP coupé). `deploy.sh` en vérifie une partie et refuse d'installer sinon : `noatime`, la mémoire d'échange, Caddy non root, et les journaux (aucun syslog, journald en mémoire une heure au plus, `sshd` en `LogLevel QUIET` sans mot de passe, `ufw logging off`, suivi des connexions à 30 min ; `journaux.sh`), registres des connexions vers `/dev/null` et minuteur de purge du journal (§1). Ne sont pas vérifiés : le pare-feu lui-même, les mises à jour automatiques, l'heure.
- **Hébergeur** : il voit les adresses IP et peut lire la mémoire de la machine. Hors de portée (§18.3).
- **Caddy non root, par un réglage global de la machine** : Caddy tourne sous le compte 65532, sans aucune capacité, sous `no-new-privileges`, avec un système de fichiers en lecture seule ; il écoute sur 80 et 443 grâce à `net.ipv4.ip_unprivileged_port_start=80` (§1 ; essayé avec l'image épinglée : sans ce réglage, refus « permission denied »). La capacité de fichier du binaire officiel (`cap_net_bind_service=+p`, lue dans la couche `sha256:5000c332…` de `caddy:2.11.9` : attribut `security.capability`, bit « effectif » absent) ne sert pas : `no-new-privileges` fait ignorer les capacités de fichier. Contrepartie : le réglage vaut pour toute la machine (`network_mode: host` interdit de le poser pour le seul conteneur), et tout processus de la machine pourrait prendre 80 ou 443 pendant un redémarrage de Caddy.
- **Confiance accordée à `X-Shh-Client-IP`** : le serveur Go croit cet en-tête, qui donne l'adresse du client pour les limites, de la seule passerelle `172.30.53.1/32` (`SHH_TRUSTED_PROXY`, `compose.yaml`), c'est-à-dire de la machine où Caddy écoute. **Tout processus de la machine** peut donc joindre `172.30.53.2:8080` et annoncer l'adresse qu'il veut : il contourne toutes les limites par adresse (quotas, places, salons). C'est accepté : la machine ne doit faire tourner que `sshd`, Docker, Caddy et le serveur, et un accès à la machine donne déjà bien plus (mémoire, volume déverrouillé). Caddy, lui, remplace toujours l'en-tête par l'adresse du pair TCP (`header_up X-Shh-Client-IP {remote_host}`, contrôlé par `test-proxy.sh`) ; un pair qui n'est pas la passerelle reçoit 500 (échec fermé).
- **Envoi complet à travers Caddy** : `test-proxy.sh` prouve le relais (`/api/captcha`, corps d'un segment, en-têtes, octets), pas la création puis l'ouverture d'un partage par un navigateur. À faire à la main après la première installation (tests manuels de la §14).
- **WebSocket du salon** : `test-proxy.sh` le garde ouvert 75 s à travers Caddy, en HTTP/1.1. Un WebSocket par HTTP/2 (RFC 8441, que certains navigateurs emploient) n'est pas essayé, et l'essai court ne dépasse pas les délais de Caddy : la première coupure possible est à **5 min** (`read_body 5m`). L'essai long se lance avec `SALON_GARDE=660`. Conditions bloquantes d'activation : §10.

## 10. Salon (activé)

Le salon (spécification §39 et `docs/conception/specs/2026-11-11-salon-v3-design.md`) est **activé et ouvert au public dès le premier déploiement** (le compte, ouvert en même temps, l'exige) : `compose.yaml` pose `SHH_SALONS: "1"`. **Risque assumé** : ouverture sans l'avis du juriste sur l'hébergement des conversations chiffrées (Q-SAL8, §39.7) et sans le passage manuel sur appareils réels. Le couper : `SHH_SALONS: "0"` (et `SHH_COMPTES: "0"`, qui l'exige). Avec `SHH_SALONS=0`, aucune route `/api/salons/*` n'existe (même réponse 404 qu'une route inconnue).

Variables :

| Variable | Valeur | Rôle |
|---|---|---|
| `SHH_SALONS` | `0` (défaut) ou `1` | active les routes du salon et son WebSocket |
| `SHH_ORIGIN` | `https://${SHH_DOMAIN}` (posée par `compose.yaml`) | origine publique du site, comparée **exactement** à l'en-tête `Origin` du WebSocket et copiée dans la CSP (`connect-src … wss://hôte`). Obligatoire avec `SHH_SALONS=1`. Forme exigée : `https://hôte[:port]` en minuscules, sans chemin ni barre finale, port par défaut omis ; `http://` seulement pour `localhost` ou `127.0.0.0/8` ; IPv6 refusé, `http://[::1]` compris (la CSP ne l'accepte pas) |
| `SHH_SALONS_MAX` | 1 à 10 000, défaut 200 | salons vivants au plus ; **50 proposé pour un usage personnel** (`deploy/.env`) |
| `SHH_SALONS_CLE_FILE` | `/run/secrets/shh_salons_cle` (posée par `compose.yaml`) | clé maîtresse des **salons persistants** (32 octets, compte 65532, 0400), tirée par `deploy.sh` à la première installation (`secrets_auto`, rien à taper) ; vide : aucun salon n'est repris après un redémarrage |

À savoir avant d'activer :

- **Conditions d'activation** (le salon est ouvert sans attendre la première, risque assumé ; les deux essais restent à passer et à refaire à chaque changement de Caddy) : (1) l'avis du juriste (Q-SAL8) ; (2) un **essai long** du WebSocket à travers Caddy, au-delà de la première coupure possible à 5 min (`read_body 5m`) : `SALON_GARDE=660 CADDY=… make test-proxy`, réussi avec le Caddy de l'image épinglée ; (3) un **essai dans WebKit et dans Chromium à travers Caddy en HTTP/2**, mise à niveau par la RFC 8441 comprise (parcours complet du salon). Spec v3 §3.6.1.

- **`SHH_ORIGIN` est vérifiée même salon coupé** : une valeur refusée empêche le serveur de démarrer **et** fait échouer `shhdrop admin` (`deploy.sh admin …`), qui lit la même configuration. Corriger `SHH_DOMAIN` (minuscules) d'abord.
- **Schéma de base 2 sans retour arrière** : le premier démarrage d'une version qui contient le salon ajoute les tables `salons` et `salon_pieces` (schéma 2), **même avec `SHH_SALONS=0`**. Une image plus ancienne refuse ensuite cette base : `deploy.sh rollback` vers une version d'avant le salon ne marche plus sans effacer la base (`admin wipe --yes`, partages perdus). Le schéma 2 n'a jamais été publié avant sa forme finale (colonne `rotation_r` comprise) : une base de développement créée par une version intermédiaire est à effacer, pas à reprendre.
- **Disque** : une conversation est écrite chiffrée sur le disque (`data/salons/`, seconde couche AES-256-GCM dont la clé ne vit qu'en mémoire tant que le serveur tourne), les pièces dans `data/salon-pieces/`. Une création de salon exige 2 Gio libres sous `SHH_STORAGE_MAX` (sinon 503) ; au pire environ 1,2 Go de conversation et 3,5 Go de vocaux par salon : `SHH_STORAGE_MAX` reste la vraie protection du disque.
- **À la fin d'un salon, la clé de la seconde couche est oubliée** (plus référencée par le serveur, tableau mis à zéro), **pas effacée de la mémoire** au sens strict : Go ne permet pas d'effacer la clé étendue gardée par AES ni d'éventuelles copies du ramasse-miettes. En marche, elle n'est jamais écrite sur disque ; seul un arrêt propre l'y range, enveloppée (salons persistants, ci-dessous).
- **Salons persistants (25 et 26 novembre) : un redémarrage du serveur, propre (mise à jour) ou brutal (panne, manque de mémoire, coupure de courant, `kill -9`), garde les salons ouverts.** En marche, chaque salon ouvert a une ligne dans `shares.db` (tables `salons_reprise` et `salons_reprise_blocs`) : la clé de sa conversation **enveloppée** par la clé maîtresse `shh_salons_cle` (AES-256-GCM), et son état (sièges, empreintes des jetons, annonces, index des messages, pièces prêtes) chiffré sous la clé de la conversation, par blocs. Elle est écrite avant la réponse à chaque entrée, départ, exclusion, retrait, renouvellement et ouverture des appels, et au plus une seconde après tout autre changement (messages, lectures, effacements), après un `fsync` du fichier de conversation. Au démarrage, avant l'écoute, les lignes sont relues, les salons repris puis leurs lignes récrites ; les lignes des salons échus ou détruits sont réécrites de zéros puis supprimées (et le WAL vidé). Les pages ouvertes se reconnectent d'elles-mêmes et continuent dans le même groupe, les absents rattrapent l'historique. Ne sont pas repris : présences (tous hors ligne jusqu'à leur retour), limites de débit (remises à neuf), places anti-abus par bloc d'adresses. Les pièces encore en envoi sont reprises depuis D42-32 : chaque segment acquitté est synchronisé sur le disque et noté dans `salon_pieces.segments_mask` avant l'accusé, la pièce est dans l'état rangé avant la réponse de sa création, et la page reprend l'envoi au premier segment non acquitté (jeton d'envoi neuf par `POST /api/salons/pieces/reprendre`, jeton de membre). **Après un arrêt brutal**, en plus : les messages, lectures et effacements de la dernière seconde au plus (les pages qui les ont vus les gardent ; un membre qui a vu un changement de groupe perdu se remet à niveau seul) ; aucun numéro de message n'est redonné, aucun exclu ne revient, aucun message retiré ne revient. Coût disque : environ 10 à 20 Ko écrits (plus le WAL) par seconde et par salon actif, rien pour un salon calme. Un salon échu pendant l'arrêt est effacé au démarrage.
- **Ce que change la persistance pour qui lit le disque** : la clé enveloppée de chaque conversation ouverte est **en permanence** dans `shares.db`, et la clé maîtresse sur le même volume chiffré (LUKS) : qui a le volume ouvert (serveur en marche ou arrêté) a les deux, donc la seconde couche ôtée et l'état des salons ouverts : nombre de sièges, rangs, heures de réception à la milliseconde, siège de chaque message, règles d'effacement, empreintes des jetons ; jamais le contenu, qui reste chiffré de bout en bout par MLS (le serveur n'en a pas la clé). C'est ce que le serveur sait déjà en mémoire. La clé maîtresse n'est ni dans la base ni dans les sauvegardes : une copie de `shares.db` seule ne donne rien de plus. Perdre `shh_salons_cle` ne perd que les salons ouverts (repli : `rejoindre`, refondation du groupe par le créateur) : il n'y a rien à en garder hors ligne.
- **Destruction** (en marche, ou pendant l'arrêt par `shhdrop admin destroy`, `wipe`) : la ligne de reprise (enveloppe et blocs compris) est réécrite de zéros puis supprimée, et le fichier de conversation effacé ; rien n'est repris.
- **Retour arrière** : la mise à jour du 26 novembre passe `shares.db` au schéma 5 (comptes sur mesure retirés, table `salons_reprise_blocs`), celle du 28 novembre au schéma 6 (D42-31), puis au schéma 7 (D42-32 : têtes des salons avec les pièces en envoi) ; une image plus ancienne refuse alors de démarrer (`base créée par une version plus récente`). Le retour arrière automatique d'une installation ratée remet la copie des bases prise juste avant (§3.4) ; un `deploy.sh rollback` lancé plus tard vers une image d'avant n'est possible qu'en effaçant `shares.db` (partages et salons en cours perdus ; les comptes et paiements, dans leurs propres bases, ne sont pas touchés). Les lignes écrites à l'arrêt propre par l'image du 25 novembre (fichiers `<id>.r`) sont reprises une fois, à la mise à jour.
- **Le redémarrage ou la recréation du conteneur Caddy (après un changement du `Caddyfile` ; `caddy reload` n'est pas possible, l'API d'administration étant coupée, `admin off`) et toute mise à jour du serveur coupent les WebSocket ouverts.** Les pages du salon se reconnectent d'elles-mêmes (reconnexion automatique, avec rattrapage des messages manqués).
- **Caddy garde l'en-tête `Origin`** et laisse passer la mise à niveau WebSocket (§36 S2) : `test-proxy.sh` (section 7) le prouve, et une ligne `header_up -Origin` ferait échouer le test.
- **Signalements** : « Quitter et signaler » (`POST /api/salons/signaler`) et « Détruire et signaler » comptent dans le même entier horaire que les partages (`reports_alert` de `shhcheck health`). `admin destroy -` accepte aussi un lien de salon `#c…`.
- **Paniques de l'entretien** : une panique dans la passe d'entretien du salon (chaque seconde) est récupérée sans aucune sortie (ni journal ni stderr : un message pourrait citer un identifiant), et l'entretien repart à la seconde suivante. Elles ne sont comptées que dans un entier en mémoire (`Manager.PaniquesTick`, sans identifiant), lu par les tests ; `shhdrop admin`, qui tourne hors du serveur, ne le voit pas, et `/api/health` ne l'expose pas. Symptôme à surveiller à la place : des salons échus qui ne disparaissent pas.
- **Adresses IP** : le serveur n'en garde aucune pour le salon ; seules les limites en mémoire en tiennent compte (empreintes HMAC à clé du jour ou du processus, jamais l'adresse ; §9.5).

## 11. Capacité du serveur

Aucune limite de capacité n'est fixée en dur : chaque valeur se règle dans `deploy/.env` ; laissée vide, elle est **calculée au démarrage** d'après `GOMEMLIMIT` (`compose.yaml`) et la limite de descripteurs (`ulimits.nofile`, 65 536 dans `compose.yaml`). Les limites anti-abus **par personne** (créations, octets par jour, places par connexion et par /48, requêtes par minute) ne changent pas et ne se règlent pas ici.

| Variable | Rôle | Valeur calculée | Avec `compose.yaml` (900 Mio, 65 536) |
|---|---|---|---|
| `SHH_UPLOADS_MAX` | envois de segments simultanés (partages et pièces) | 30 % de `GOMEMLIMIT` ÷ 4 Mio (corps gardé en mémoire), au moins 8 ; 64 sans `GOMEMLIMIT` | 67 |
| `SHH_DOWNLOADS_MAX` | lectures de segments simultanées | 10 % de `GOMEMLIMIT` ÷ 256 Kio (tampon), au moins 16 ; 256 sans `GOMEMLIMIT` | 360 |
| `SHH_WATCH_MAX` | surveillances tenues (`/api/shares/watch`) | autant que de lectures | 360 |
| `SHH_WS_MAX` | WebSocket du salon ouverts | 10 % de `GOMEMLIMIT` ÷ 64 Kio (un lot de rattrapage tenu par un client qui ne lit plus, et la marge de la connexion), au moins 16, au plus 2 000 ; 2 000 sans `GOMEMLIMIT`. Une valeur réglée au-delà de ce budget empêche le serveur de démarrer (message `SHH_WS_MAX=… : … au plus …`) | 1 440 |
| `SHH_SALON_FRAMES_MAX` | trames non volatiles rangées au plus par salon ; au-delà, `0x0C` « Le salon est plein » pour ce salon seulement | 100 000 (≈ 417 Mo de disque, 2,4 Mio de mémoire) | 100 000 |
| `SHH_SALON_FRAMES_TOTAL` | trames non volatiles rangées au plus **en mémoire, tous salons confondus** ; au-delà, `0x0C` quel que soit le salon. Vrai garde-fou de la mémoire du salon | 10 % de `GOMEMLIMIT` ÷ 48 o la trame, au moins 1 000 ; 1 000 000 sans `GOMEMLIMIT` | ≈ 1 966 080 |
| `SHH_DISK_OPS_MAX` | appels système de fichiers simultanés (partages et pièces) ; au-delà, ils attendent leur tour. Les fichiers de conversation du salon ont deux bornes à part, chacune du quart de cette valeur : une pour les écritures, une pour les lectures | 64 (conversations : 16 + 16) | 64 (16 + 16) |

**Sortie par partage** : `SHH_SHARE_EGRESS_MAX`, en octets, **250 Gio par défaut** (268 435 456 000), au moins 32 Gio (un téléchargement complet du plus grand partage payant, 30 Go). Un partage, toutes ouvertures confondues, ne sert pas plus que ce plafond ; ensuite le serveur refuse ses segments (403 `egress_limit`) et toute nouvelle ouverture dont le téléchargement complet ne tiendrait plus (403 `egress_limit`, sans consommer d'ouverture ni d'essai ; seulement après le bon mot de passe). Le compteur est la somme des octets lus par les ouvertures du partage, rangée chaque seconde dans `shares_ouvertures.lus` (D42-31 ; aucune adresse) : un redémarrage ne le remet plus à zéro (au pire, la dernière seconde de lecture est oubliée, en faveur du lecteur), et les lecteurs reprennent leur ouverture sans en consommer une nouvelle. Un partage gratuit (2 Go, 5 ouvertures) ne l'atteint jamais ; un Plus (10 Go, 10 ouvertures) seulement en relisant beaucoup ; un Pro de 30 Go sert environ 8 téléchargements complets (sans ce plafond : 20 × 5 lectures possibles, environ 3 To). Baisser la valeur réduit la facture de sortie au pire ; la monter (600 Gio : 30 Go × 20 ouvertures) rend au Pro toutes ses ouvertures complètes. Spec §38.6, §38.8.1.

**Débit par expéditeur** : `SHH_SEGMENTS_PER_MIN` (1 500 par défaut) est la seule limite par personne réglable ici : requêtes de segments de 4 Mio par minute et par connexion (10 fois plus par /48), soit environ 840 Mbit/s par expéditeur. La baisser protège la bande passante de la machine ; la monter ne sert qu'au-delà de 1 Gbit/s.

`SHH_DISK_OPS_MAX` borne les fils du système bloqués sur le disque : 1,5 fois sa valeur au pire (partages et pièces, plus les écritures et les lectures des conversations ; 96 fils par défaut), quel que soit le nombre de connexions (`SHH_WS_MAX` ne compte pas : les lectures du rattrapage attendent leur tour). **Contrôle au démarrage** : si ce total dépasse la moitié de `pids_limit` (lu dans `/sys/fs/cgroup/pids.max` ; 1 024 dans `compose.yaml`), le serveur refuse de démarrer (message `… plus de la moitié de pids_limit`) : baisser `SHH_DISK_OPS_MAX` ou relever `pids_limit`. Chaque autre catégorie a au plus `nofile / 8` places (une lecture ou un envoi tient 2 descripteurs) ; une valeur réglée au-delà empêche le serveur de démarrer (message `… dépasse la limite de descripteurs`), au lieu de le faire tomber sous la charge.

**Règle de sûreté** : ne monter `SHH_UPLOADS_MAX` qu'avec la mémoire. Chaque envoi garde 4 Mio, que le ramasse-miettes peut doubler : au-delà de `mem_limit`, le noyau tue le serveur (envois en cours perdus). Pour une machine plus grosse, monter `mem_limit` et `GOMEMLIMIT` ensemble (`GOMEMLIMIT` ≈ 90 % de `mem_limit`) et laisser les places se recalculer.

**Mémoire du salon** : l'index des trames en mémoire est borné **globalement** par `SHH_SALON_FRAMES_TOTAL` (calé sur `GOMEMLIMIT`), tous salons confondus, en plus du plafond par salon. Monter `SHH_SALONS_MAX` ne peut donc plus faire tuer le serveur faute de mémoire : au pire, des salons reçoivent `0x0C` « plein » plus tôt. **Part de chaque salon** : la moitié de ce plafond est réservée à parts égales entre les `SHH_SALONS_MAX` salons possibles (4 915 trames par salon avec les valeurs livrées) ; un salon n'est jamais refusé sous sa part, quoi que fassent les autres ; l'autre moitié est un pot commun. **Limite connue du pot commun** : un salon plein en prend 95 085 trames ; **11 salons pleins le vident** (3 blocs /48 ou 3 adresses IPv4 à 5 salons chacune, environ 7 h de remplissage à 10 sièges). Les autres salons retombent alors à leur part (4 915 trames depuis leur dernier renouvellement, **trames effacées comprises** : l'index ne rétrécit pas tant que le salon vit), qu'un salon de 10 membres au débit permis épuise dans sa première rafale ; ils reçoivent `0x0C` « plein » jusqu'à la fin ou au renouvellement des salons pleins. Aucune correction simple et sûre n'existe dans le code actuel : retirer de l'index les trames effacées changerait le rattrapage, et borner la part d'un bloc dans le pot demande un compte par bloc tenu sous les verrous de chaque salon. Limite assumée, à reporter dans la spécification (§18). Parades d'exploitation : `SHH_SALONS_MAX` plus bas (part plus grande) ou `GOMEMLIMIT` plus haut. Le journal des annonces de chaque salon (256 Kio au pire) est hors de ce plafond : c'est le contrôle de démarrage de `SHH_SALONS_MAX` qui le borne (§1). Comme pour les envois, c'est `GOMEMLIMIT` qui fait monter ce plafond avec la machine.

**Part équitable** : en plus de ses propres limites, une connexion ou un bloc /48 (une adresse en IPv4) prend au plus **1/8** de chaque plafond global, et le **dernier quart** des places (envois, lectures, surveillances, WebSocket, salons) ne va qu'à un bloc qui n'en tient aucune. Le **dernier huitième du stockage** ne va qu'à une adresse qui n'a rien créé ni envoyé aujourd'hui (UTC) ; un agrandissement et une pièce du salon n'y entrent jamais ; une adresse ne réserve pas plus de `SHH_STORAGE_MAX / 8` octets par jour. Un salon où personne n'est entré est effacé 15 min après sa création. Adresses IPv4 nécessaires pour tout prendre, avec `compose.yaml` : envois 23, lectures 107, salons (200) 80 qui y entrent, stockage environ 43. Ces seuils restent atteignables par un attaquant qui dispose de beaucoup d'adresses : ce sont des limites assumées, à reporter dans la spécification (§18).

## 12. Compte par passkey : clé du serveur, sauvegarde

Le compte est **activé** et fonctionne **sans e-mail** : une passkey et une clé de récupération (conception `docs/conception/specs/2026-11-22-compte-passkey-design.md`, qui remplace la partie e-mail de `2026-11-14-compte-email-design.md`). `compose.yaml` pose `SHH_COMPTES: "1"`, et le site de l'image est construit avec le compte (`deploy/Dockerfile`, `SHH_SITE_COMPTES=1`, `check-dist.mjs --comptes`).

**Ouvert au public dès le premier déploiement.** **Risque assumé** : ni l'avis du juriste sur la conservation des données de création de compte (LCEN et décret 2021-1362 ; conception §12), ni le passage manuel sur appareils réels (conception par passkey §14) n'ont été faits avant l'ouverture.

Avec `SHH_COMPTES: "0"` : aucune route `/api/compte/*` et aucun fichier lu dans `secrets/` pour le compte.

### 12.1 Aucune sortie SMTP

Le serveur Go reste sur le réseau Docker `interne` (`internal: true`), **sans aucune route vers Internet**. Il n'envoie aucun e-mail : ni relais SMTP, ni profil Compose `comptes`, ni variable d'envoi. Les seules sorties du serveur qui restent sont celles du paiement (§13).

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

**Tirée par `deploy.sh` (ou `preprod.sh`) elle-même** à la première installation, si elle manque : 32 octets de `/dev/urandom`, compte 65532, 0400, jamais affichée ; la ligne « compte : clé du serveur : créé » le dit. Elle n'est **jamais** tirée si `data/comptes.db` existe déjà : une base sans sa clé est une restauration incomplète, et une nouvelle clé perdrait l'unicité des pseudos sans rien dire ; l'installation est alors refusée, jusqu'à ce que la clé soit remise depuis sa copie hors ligne. Ensuite, `deploy.sh` refuse d'installer si le fichier manque ou n'a pas exactement ces droits. Le serveur refuse aussi de démarrer (clé de 32 octets, droits 0400 ou 0600).

Même chose à la main (inutile d'habitude) :

```sh
install -d -o root -g 65532 -m 0750 /srv/shhdrop/secrets   # déjà fait au §2
cd /srv/shhdrop/secrets
# Clé du serveur K_serveur : 32 octets tirés au hasard, une fois pour toutes.
(umask 077 && head -c 32 /dev/urandom > shh_comptes_cle)
chown 65532:65532 shh_comptes_cle && chmod 0400 shh_comptes_cle
```

**Elle ne sert qu'aux pseudos.** Le serveur en tire `K_pseudo`, qui sert à calculer l'empreinte `p_empreinte`, garante de l'unicité d'un pseudo sans le garder en clair. Elle n'ouvre aucun coffre, ne vérifie aucune passkey et ne retrouve aucun compte.

Si elle est perdue :
- les comptes restent utilisables (passkeys, clé de récupération, coffres) ;
- l'unicité des pseudos est perdue : un pseudo déjà pris ne se reconnaît plus, et deux personnes pourraient avoir le même.

Elle ne se change pas non plus (conception §5.2). Donc, dès sa création :

- **faire une copie hors ligne**, par exemple sur papier : `base64 < shh_comptes_cle` donne 44 caractères à recopier puis à relire ; effacer ensuite l'écran avec `clear`. Une clé USB chiffrée convient aussi. Pour la restaurer : `base64 -d > shh_comptes_cle`, puis les droits ci-dessus ;
- ranger cette copie **à part** de la clé privée age des sauvegardes (§12.4) : qui a les deux et une sauvegarde peut tester des pseudos un à un pour savoir s'ils ont un compte ;
- ne jamais la mettre dans le dépôt, dans `deploy/.env`, dans un gestionnaire de mots de passe synchronisé avec la machine, ni dans la sauvegarde.

### 12.3 Activer le compte

1. Créer le secret du §12.2 et en faire la copie hors ligne.
2. Dans `deploy/.env`, mettre `SHH_DOMAIN=shhgone.com` et ne laisser aucune variable `SHH_SMTP_*` ni `SHH_MAIL_FROM` (modèle dans `env.example`). On peut y régler aussi `SHH_COMPTES_JOUR`, le plafond d'inscriptions par jour pour tout le site (500 par défaut).
3. Dans `compose.yaml`, poser `SHH_SALONS: "1"` et `SHH_COMPTES: "1"` (fichier relu et commité, comme pour le salon).
4. Lancer `deploy/deploy.sh sha256:<empreinte> <x.y.z> <commit>` (§3.2) : le secret est contrôlé.
5. Installer la sauvegarde du §12.4 **le même jour**, puis essayer une restauration (§12.5).

Désactiver : poser `SHH_COMPTES: "0"`, puis lancer `deploy.sh`. `comptes.db` reste intacte sur le volume.

### 12.4 Sauvegarde quotidienne chiffrée de `comptes.db` et de `paiements.db`

Ce qui est sauvegardé : **`comptes.db`** (comptes, sessions, bannis) et **`paiements.db`** (empreintes des pass, commandes en attente, références des prestataires, jetons dépensés des deux derniers jours ; aucune identité, aucun montant, aucun pays ; les **clés privées d'émission des jetons sont retirées de la copie** avant le chiffrement, `VACUUM` compris), chacune dans son propre fichier ; une base absente (compte ou paiement désactivé) est sautée. Jamais `shares.db`, les fichiers des partages, les salons, les conversations, ni la clé du serveur. Comment (`sauvegarder.sh`, minuteur `systemd/shhdrop-sauvegarde.timer`, chaque jour vers 03:17 UTC) : copie cohérente par `sqlite3 .backup`, serveur en marche (sous le compte 65532, dans `/srv/shhdrop/sauvegarde/` : le clair ne quitte jamais le volume chiffré, refus sinon) ; `PRAGMA integrity_check` ; chiffrement par **age** (`age-encryption.org/v1`, X25519) vers la clé **publique** de l'exploitant ; clair effacé aussitôt ; envoi du seul chiffré, nommé `comptes-AAAA-MM-JJTHHMMSSZ.db.age` et `paiements-AAAA-MM-JJTHHMMSSZ.db.age`, sous le même `SHH_SAUVEGARDE_URL`. Aucune crypto maison, rien dans le serveur Go. La lecture de la base dure environ une seconde ; si une suppression de compte tombe pendant ce temps, son vidage du journal (`comptes.db-wal`) attend le suivant (au plus la passe quotidienne).

Mise en place, une fois :

1. **Outils** sur la machine : `apt install sqlite3 age curl` (ou `age` construit depuis ses sources ou paquet signé), puis `age --version` recopié dans `deploy/.env` (`SHH_AGE_VERSION`) : le script refuse une autre version.
2. **Clés age, sur le poste de l'exploitant** (jamais sur la machine) : `age-keygen -o sauvegarde.cle` (la ligne `Public key: age1…` est la clé publique), idéalement protégée par une phrase : `age-keygen | age -p > sauvegarde.cle.age` (age demandera la phrase à chaque restauration). Clé publique dans `deploy/.env` (`SHH_SAUVEGARDE_DESTINATAIRE`). Clé privée **hors ligne** (papier ou clé USB chiffrée), **à part** de la copie de la clé du serveur (§12.2) : les deux sont nécessaires à une restauration.
3. **Stockage objet** chez un **autre fournisseur** que l'hébergeur, **dans l'UE** (contrat de sous-traitance) : un seau dédié ; **gestion des versions activée** (ou verrouillage d'objet, « Object Lock », 7 jours) : l'accès en écriture seule ne peut ni lire ni effacer, mais sans versions il pourrait **écraser** une copie sous le même nom ; **règle de cycle de vie : effacer les objets (et leurs anciennes versions) après 7 jours** (rotation de 7 copies, dite dans la page Confidentialité, conception R18 : garder le moins longtemps) ; un **compte d'accès en écriture seule** (droit `PutObject` sur ce seau seulement : ni lecture, ni liste, ni effacement), pour qu'un pirate de la machine ne puisse ni lire ni détruire les copies. Un **second accès, en lecture**, reste sur le poste de l'exploitant, pour les restaurations.
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

**Essai mensuel**, sur le poste de l'exploitant (Linux : `age`, `sqlite3`, `/dev/shm`) : télécharger la copie la plus récente avec l'accès en lecture, puis

```sh
deploy/restaurer.sh verifier comptes-<date>.db.age sauvegarde.cle   # « intégrité : ok ; schéma 3 ; N comptes »
deploy/restaurer.sh verifier paiements-<date>.db.age sauvegarde.cle # « intégrité : ok ; base des paiements ; schéma 2 ; N pass »
```

(déchiffrée en mémoire, `/dev/shm`, puis effacée ; rien n'est installé). À chaque changement du schéma de `comptes.db`, et à chaque changement des scripts : `sudo make test-restauration` (compte de test créé par le vrai serveur avec une passkey logicielle, sauvegarde serveur en marche, effacement, restauration, reconnexion par la passkey réussie ; avec une autre clé du serveur, la connexion réussit aussi : la clé ne sert qu'aux pseudos ; puis `paiements.db` créée par le serveur avec le paiement en bac à sable, un pass factice sauvegardé sans son empreinte en clair ni clé de jetons, restauré).

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

Conception : `docs/conception/specs/2026-11-19-paiement-design.md`. **Désactivé** : `compose.yaml` pose `SHH_PAIEMENT: "0"` ; ce qui manque avant de l'activer est la liste du §13 de la conception (comptes chez les prestataires, régime de TVA, mentions légales des notes de vente, contrat et CGV). Avec `"0"` : aucune route `/api/paiement/*`, aucun fichier de `secrets/` lu pour le paiement, aucun relais de paiement, aucune connexion sortante de plus.

### 13.1 Sorties : un relais par prestataire

Un relais par sortie, pour échouer fermé : le serveur reste sur `interne` (`internal: true`), **sans route vers Internet, même paiement activé**. Pour chaque prestataire configuré, `deploy.sh` démarre son relais (même image, `/shhcheck relais`, 16 connexions à la fois, 60 s chacune au plus, compte 65532, lecture seule, sans capacité, aucun journal) :

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

et, pour tous, `SHH_TVA` (`franchise`, `france` ou `oss` : régime choisi par le propriétaire avec son comptable ; en `oss`, la crypto n'est ni proposée ni acceptée, même avec les secrets NOWPayments en place, car elle ne donne qu'une preuve de localisation : conception du paiement §9.1 ; ses webhooks restent traités). Paiement activé, `deploy.sh` refuse d'installer sans `SHH_TVA`, sans aucun prestataire, ou si un fichier attendu manque, est un lien ou n'a pas le bon propriétaire et les bons droits. Le serveur, lui, refuse de démarrer avec une clé Stripe de production en essai ou l’inverse, ou un prestataire à moitié configuré (message sans valeur).

```sh
sudo deploy/secret.sh shh_stripe_cle   # saisie masquée, deux fois ; forme et droits vérifiés
sudo deploy/secret.sh --liste          # présent ou absent, jamais la valeur
```

`secret.sh` (section « Commandes du quotidien ») vérifie la forme (Stripe : clé de test en essai, réelle sinon, comme le serveur) et écrit le fichier d'un coup, compte 65532, 0400. Sans lui : `(umask 077 && cat > <SHH_DATA_ROOT>/secrets/<nom>)`, coller, Entrée, Ctrl-D, puis `chown 65532:65532` et `chmod 0400`.

### 13.3 Sauvegarde et restauration

`paiements.db` (empreintes des pass, commandes en attente, références des prestataires ; aucune identité, aucun montant, aucun pays ; jamais les clés privées des jetons) est sauvegardée **avec `comptes.db`**, chaque jour, dans son propre fichier chiffré (§12.4), et se restaure de la même façon (§12.5 : clés de jetons effacées ; un pass payé depuis la sauvegarde est à rembourser depuis le tableau de bord du prestataire). La sauvegarde doit être en place **le jour de l'activation** : perdre `paiements.db` rendrait inutilisables tous les pass payés.

### 13.4 Essai en préproduction (bacs à sable des prestataires)

But : payer « pour de faux » sur `https://shhgone.com` (barrière d'accès de la préproduction en place) avec les clés de **test** des trois prestataires, et voir le pass s'activer. Aucune adresse n'est à écrire nulle part : le serveur construit lui-même, depuis `SHH_ORIGIN` (`https://${SHH_DOMAIN}`, `compose.yaml`), l'adresse de retour `https://shhgone.com/offres/retour` (réussite et abandon, sans paramètre) et l'adresse IPN de NOWPayments ; les API (production ou bac à sable) sont fixées dans le code d'après `SHH_PAIEMENT_ESSAI`.

**Les secrets ne passent jamais par le chat, le dépôt ni `deploy/.env`** : le propriétaire les tape lui-même sur le serveur, dans sa propre fenêtre SSH, un par un : `sudo deploy/secret.sh <nom>` (§13.2 : saisie masquée, compte 65532 parce que c'est lui qui fait tourner le serveur et doit les lire). `deploy/.env` ne reçoit que des réglages publics (identifiants PayPal, régime de TVA).

**1. Interrupteurs** : le jour où les secrets d'au moins un prestataire sont en place, et seulement alors (sans secret, `deploy.sh` refuse d'installer). **En préproduction** (`SHH_PREPROD=1`, §15), sans commit, dans `deploy/.env` (refusés sans la barrière ; `compose.yaml` garde les valeurs de production, `"0"`) :

```sh
SHH_PREPROD_PAIEMENT=1
SHH_PREPROD_PAIEMENT_ESSAI=1
```

puis `deploy/preprod.sh <commit>` (ou `deploy.sh` avec la Release). Hors préproduction, ils se règlent dans `compose.yaml` (commité) : `SHH_PAIEMENT: "${SHH_PAIEMENT_SERVI:-1}"` (le chiffre après `:-` est la valeur ; `SHH_PAIEMENT_SERVI` est posée par `deploy.sh` seulement). **`SHH_PAIEMENT_ESSAI=1` sans `SHH_PREPROD=1` est refusé par `deploy.sh`** (en essai, toute carte de test « paie »).

**2. `deploy/.env`** :

| Variable | Valeur en essai |
| --- | --- |
| `SHH_TVA` | `franchise` ou `france` pour essayer aussi la crypto (en `oss`, la crypto n'est ni montrée ni acceptée) ; le régime réel est choisi plus tard avec le comptable |
| `SHH_STRIPE_TAXE` | vide (ou `1` pour essayer Stripe Tax, à activer d'abord dans le tableau de bord de test) |
| `SHH_PAYPAL_CLIENT_ID` | « Client ID » de l'application PayPal **Sandbox** |
| `SHH_PAYPAL_WEBHOOK_ID` | « Webhook ID » du webhook Sandbox |
| `SHH_PAYPAL_PLANS` | `plus-mois=P-…,plus-an=P-…,pro-mois=P-…,pro-an=P-…` (plans Sandbox) |

**3. Chez chaque prestataire (comptes de test)** — les noms de menus changent souvent : chercher le libellé le plus proche.

- **Stripe** (dashboard.stripe.com, **mode test** ou « bac à sable » activé en haut de l'écran) :
  - *Développeurs → Clés API* : créer une **clé restreinte** `rk_test_…` (droits : *Checkout Sessions* en écriture, *Subscriptions* en écriture, rien d'autre) ou, à défaut, la clé secrète `sk_test_…` → fichier `shh_stripe_cle`.
  - *Développeurs → Webhooks* (« Destinations d'événements ») → ajouter un point de terminaison : URL **`https://shhgone.com/api/paiement/webhook/stripe`**, **version d'API `2026-02-25.clover`**, événements `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`, `invoice_payment.paid`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created` (cocher **ceux-là seulement**) → révéler le **secret de signature** `whsec_…` → fichier `shh_stripe_webhook`.
  - Payer avec la carte de test `4242 4242 4242 4242` (date future, CVC quelconque) ; refus : `4000 0000 0000 0002` ; authentification 3-D Secure : `4000 0027 6000 3184`. Remboursement et litige d'essai : depuis la page du paiement dans le tableau de bord (le pass doit passer « Offre arrêtée »).
  - `stripe trigger …` (CLI) envoie des événements **sans nos métadonnées** : ils reçoivent 200 et ne changent rien ; essayer avec de vrais paiements de test depuis la page Offres.
- **PayPal** (developer.paypal.com, interrupteur **Sandbox**) :
  - *Apps & Credentials → Create App* (type marchand) → **Client ID** (`SHH_PAYPAL_CLIENT_ID`) et **Secret** → fichier `shh_paypal_secret`.
  - Dans l'application, *Add Webhook* : URL **`https://shhgone.com/api/paiement/webhook/paypal`**, événements `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.EXPIRED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `PAYMENT.SALE.COMPLETED`, `PAYMENT.SALE.REFUNDED`, `PAYMENT.SALE.REVERSED`, `CUSTOMER.DISPUTE.CREATED` → **Webhook ID** (`SHH_PAYPAL_WEBHOOK_ID`).
  - *Testing Tools → Sandbox Accounts* : un compte « Business » (le vendeur, celui de l'application) et un compte « Personal » (l'acheteur, pour payer). Connecté à www.sandbox.paypal.com avec le compte Business : un **produit** (service numérique) et **quatre plans** d'abonnement en EUR, prix **TTC sans taxe ajoutée par PayPal**, sans essai gratuit ni frais d'installation, un seul échec de paiement toléré : Plus mensuel 7,00 €, Plus annuel 70,00 €, Pro mensuel 20,00 €, Pro annuel 200,00 € → leurs identifiants `P-…` dans `SHH_PAYPAL_PLANS`. Un montant différent du nôtre met la commande en « anomalie » (aucun crédit).
  - Le **simulateur de webhooks** de PayPal envoie des événements que l'API de vérification refuse : 400 attendu, sans effet. Essayer avec de vrais paiements Sandbox.
- **NOWPayments** (compte du **bac à sable**, distinct du compte réel : account-sandbox.nowpayments.io) :
  - *Settings → Payments → API keys* : clé d'API → fichier `shh_nowpayments_cle` ; *Instant payment notifications* : générer le **secret IPN** → fichier `shh_nowpayments_ipn` ; une adresse de versement (payout) par monnaie activée.
  - Adresse IPN : rien à déclarer, le serveur la donne à chaque facture (`https://shhgone.com/api/paiement/webhook/nowpayments`) ; si le tableau de bord en demande une par défaut, mettre la même.
  - Le bac à sable ne transfère aucune monnaie : suivre sa documentation pour simuler un paiement « finished » (ou partiel, ou expiré). Un paiement partiel reste « en attente » (jamais crédité, §8 de la conception).

**4. Webhooks et barrière de la préproduction** : les trois adresses `https://shhgone.com/api/paiement/webhook/{stripe,paypal,nowpayments}` passent la barrière (POST, chemins exacts, `Caddyfile`, prouvé par `test-preprod.sh`) : les prestataires n'ont pas le témoin ; leur signature est vérifiée par le serveur. Tout le reste, `/offres/retour` compris, reste derrière : le témoin de la préproduction (SameSite=Lax) est envoyé au retour depuis Stripe ou PayPal (navigation de premier niveau). Sans cette exception, les webhooks recevraient la page de maintenance (503) et aucun paiement ne s'activerait.

**5. Contrôles** après `deploy.sh` : `curl -s -H "X-Shh-Preprod: $(cat /etc/shhdrop/preprod-jeton)" https://shhgone.com/api/paiement` (sur le serveur, en root ; jeton de la barrière, §15) rend `"moyens":["carte",…]` ; un webhook mal signé est refusé (`curl -s -o /dev/null -w '%{http_code}' -X POST https://shhgone.com/api/paiement/webhook/stripe -d '{}'` : **400**, ni 503 ni 404) ; puis, sur la page Offres : payer, revenir sur « Paiement reçu », faire un envoi Plus ou Pro (Options), arrêter le renouvellement (lien « Une offre est gardée sur cet appareil » de la page Offres), rembourser depuis le tableau de bord → « Offre arrêtée ». Le tableau de bord de chaque prestataire montre l'état de livraison de chaque webhook (code de réponse de notre serveur).

**Attention, essai ouvert au public** : en essai, n'importe quelle carte de test « paie ». Ne jamais retirer la barrière d'accès tant que l'essai est actif : `deploy.sh` et `preprod.sh` refusent `SHH_PAIEMENT_ESSAI=1` sans `SHH_PREPROD=1`.

### 13.5 Passer du test au réel

1. Avoir fait la liste « Avant la première vente réelle » de la conception (§13 : statut, régime de TVA, CGV, mentions légales, médiateur, mentions de la note de vente, `cargo audit`, `govulncheck`).
2. Chez chaque prestataire, en mode **réel** (Stripe : mode test désactivé ; PayPal : interrupteur *Live*, application *Live* ; NOWPayments : compte réel account.nowpayments.io) : **nouvelles** clés (`sk_live_…`/`rk_live_…`, secret *Live*, clé d'API réelle), **nouveaux** webhooks aux mêmes adresses (nouveau `whsec_…`, nouveau *Webhook ID*, nouveau secret IPN), **nouveaux** plans PayPal (nouveaux `P-…`). Rien des comptes de test ne sert en réel.
3. Sur le serveur : `docker compose down` ; remplacer chaque fichier de `secrets/` par sa valeur réelle (même commande, le propriétaire tape) ; mettre à jour `SHH_PAYPAL_CLIENT_ID`, `SHH_PAYPAL_WEBHOOK_ID`, `SHH_PAYPAL_PLANS` et le vrai `SHH_TVA` dans `deploy/.env`.
4. **Écarter la base d'essai** : `mv <SHH_DATA_ROOT>/data/paiements.db* <dossier hors du volume>/` (puis l'effacer une fois le réel vérifié). Le serveur **refuse de démarrer en réel sur une base créée en essai** (marquée à sa création) : sans cela, les pass « payés » avec des cartes de test resteraient valables. L'inverse (base réelle ouverte en essai) est refusé aussi. La sauvegarde (§12.4) ne doit pas garder d'ancienne copie d'essai comme référence.
5. `SHH_PAIEMENT_ESSAI: "0"` dans `compose.yaml` (commité), puis `deploy.sh` (le serveur refuse une clé Stripe de test en réel, et l'inverse ; les relais passent aux hôtes de production).
6. Sur les appareils d'essai : « Oublier cette commande » (ou effacer les données du site) : leurs pass d'essai sont inconnus du nouveau serveur, et les clés de jetons vues pendant l'essai feraient croire à une clé changée (avertissement « clé de jetons différente », jusqu'à 8 jours).
7. Premier achat réel de faible montant (Plus mensuel), puis remboursement depuis le tableau de bord : le pass doit passer « Offre arrêtée ».

## 14. Appels audio et vidéo du salon : relais TURN intégré

Conception : `docs/conception/specs/2026-11-20-appels-design.md`. Les appels sont **activés par défaut** et **rien n'est à installer**, ni sur la machine ni chez les utilisateurs : le relais fait partie de notre image (`/shhcheck turn`, `deploy/shhcheck/turn.go`, bibliothèque pion/turn épinglée), lancé par `compose.yaml` (service `relais-turn`, profil « appels »). **Les appels sont réservés aux offres Plus et Pro** (conception des appels §5.1) : le serveur ne les propose (route `/api/salons/appel`, `calls: true`, boutons) que si le paiement est aussi ouvert (`SHH_PAIEMENT=1`). Paiement fermé, le relais tourne sans servir : `SHH_APPELS=0` l'arrête d'ici là.

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

## 15. Préproduction : site fermé au public, version de développement

Le serveur de production tourne **avant l'ouverture** sur `https://shhgone.com`, mais **le public ne voit qu'une page « en cours de maintenance »**. Le propriétaire, lui, a le vrai site, pour essayer ce qui ne marche que sur le vrai domaine : passkeys (identifiant `shhgone.com`), retours et webhooks de Stripe, PayPal et NOWPayments (§13.4), appels. Et il installe une version de développement en quelques minutes, sans attendre une Release signée.

| Élément | Où |
|---|---|
| barrière | `Caddyfile`, snippets `barriere-0` (production : rien) et `barriere-1` (préproduction), choisis par `SHH_PREPROD` |
| page servie au public | `maintenance.html` (HTML et CSS en ligne, aucun script ni ressource externe), montée dans Caddy |
| jeton d'accès | `/etc/shhdrop/preprod-jeton` : 64 chiffres hexadécimaux, root 0600, **jamais dans git, dans `deploy/.env` ni dans un message** |
| version de développement | `preprod.sh <commit>` ; partie commune avec `deploy.sh` : `commun.sh` |
| essais | `test-preprod.sh` (barrière, lancé par `test-proxy.sh`), `test-verrous.sh` §14 (`preprod.sh`, jeton, réglages), `test-provenance.sh` §12 et §17 |

### 15.1 Ce que fait la barrière (`SHH_PREPROD=1`)

- **Public** : toute requête reçoit `maintenance.html`, statut **503**, `Retry-After: 3600`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`, le marqueur **`X-Shhdrop-Etat: maintenance`**, et les en-têtes de sécurité du site (HSTS, CSP sans aucun script, feuille de style autorisée par son empreinte, etc.). Rien n'est relayé au serveur Go.
- **Propriétaire** : il ouvre **une fois par appareil et par navigateur** le lien `https://shhgone.com/acces/<jeton>`. Caddy pose le témoin `__Host-shh_preprod=<jeton>` (`Secure`, `HttpOnly`, `SameSite=Lax`, 30 jours) et redirige vers `/`. `Lax` et non `Strict` : le retour depuis Stripe ou PayPal est une navigation venue d'un autre site, où un témoin `Strict` ne serait pas envoyé. Un faux lien rend la page de maintenance, sans témoin. Le témoin est envoyé avec toute requête de même origine qui porte des témoins, même avec son propre `Authorization` (envoi de segments, `Bearer` ; appels, `PrivateToken`) et à l'ouverture du WebSocket du salon. (Une barrière `basic_auth` ne marcherait pas : le navigateur n'ajoute pas ses identifiants à une requête qui a déjà un `Authorization`.)
- **Passent sans témoin, et rien d'autre** :
  1. les **webhooks** des prestataires : `POST /api/paiement/webhook/stripe`, `…/paypal`, `…/nowpayments`, chemins exacts (les prestataires n'ont pas le témoin ; leur signature est vérifiée par le serveur) ;
  2. le **défi ACME** de Let's Encrypt : traité par Caddy lui-même avant la barrière (port 80, ou TLS-ALPN sur 443), sans exemption à écrire ;
  3. les requêtes **qui ne sont pas des navigations et que le navigateur dit venir d'une page de cette origine** (`Sec-Fetch-Site: same-origin`, hors `Sec-Fetch-Mode: navigate`). **Pourquoi** : le site envoie une partie de ses appels (API du salon et du paiement, WebAssembly, preuve anti-robot) avec `credentials: "omit"`, donc **sans aucun témoin** (choix de confidentialité du site, à ne pas changer pour la préproduction). Sans cette exception, ces appels recevraient la page de maintenance et le site ne marcherait pas. Un navigateur n'envoie `same-origin` que depuis une page déjà ouverte sur `shhgone.com`, donc derrière le témoin. **Limite : risque PP1 ci-dessous** ;
  4. les **contrôles automatiques** de `deploy.sh` et `preprod.sh` : en-tête `X-Shh-Preprod: <jeton>` (lu depuis un descripteur, jamais sur la ligne de commande ; `verify-site.mjs` le reçoit par l'environnement, `SHH_PREPROD_JETON`). `alerte.sh` ne passe pas par Caddy (certificat TLS et `deploy.sh health`, dans le conteneur) : rien à changer. La sonde externe et `verifier-site.yml` acceptent la page de maintenance (risque PP3).
- **Aucun cache navigateur** : `Cache-Control: no-store` sur toutes les réponses, fichiers à empreinte de `/assets/` compris ; chaque version se voit au prochain chargement. Le site n'a pas de service worker (spec Q-C1) : rien d'autre ne peut garder une ancienne version. Sans `SHH_PREPROD`, les en-têtes de cache de production sont inchangés (prouvé par `test-preprod.sh`).
- Ni le jeton, ni le témoin n'atteignent le serveur Go (`Cookie` et `X-Shh-Preprod` retirés vers l'amont) ; aucun journal de Caddy (global `log … discard`, aucun journal d'accès : le jeton n'est écrit nulle part ; `test-preprod.sh` le cherche dans les sorties de Caddy). Le tableau de bord (§4) reste sur son écouteur interne `172.30.53.2:9191` : Caddy ne relaie que vers `:8080`, barrière ou pas.
- **Ce qui marche derrière la barrière** (même origine, `https://shhgone.com`) : passkeys WebAuthn (le témoin ne change ni l'origine ni l'identifiant), `fetch` du site (témoin, ou exception 3), WebSocket du salon (témoin envoyé à l'ouverture ; **Safari non essayé** : à vérifier sur l'iPhone), appels (relais TURN, hors HTTP), retours de paiement. Prouvé avec un client HTTP (`test-preprod.sh`), **pas avec un vrai navigateur** : liste à faire à la main au §15.4.

**Échec fermé** : `SHH_PREPROD` hors de `0` et `1` est refusé (par `deploy.sh` et par Caddy) ; avec `SHH_PREPROD=1`, sans jeton bien réglé (absent, lien, autre propriétaire, droits plus larges que 0600, contenu hors format), `deploy.sh` et `preprod.sh` refusent de démarrer ; un jeton vide dans Caddy ne laisse rien passer ; après le démarrage, le contrôle de santé exige que `/` et `/api/captcha` rendent la page de maintenance à qui n'a pas le jeton, sinon retour arrière.

### 15.2 Commandes du propriétaire, dans l'ordre

Sur le serveur, en root, dans `/opt/shhdrop`, la machine prête (§1, §2, §3.5 ; paquet `docker-buildx-plugin` installé : `preprod.sh` construit l'image) :

```sh
# 1. Jeton : rien à faire. preprod.sh (ou deploy.sh) le tire SUR LE SERVEUR à la première
#    installation (/etc/shhdrop/preprod-jeton, root 0600, jamais affiché ni remplacé ;
#    « préproduction : jeton d'accès : créé »), après les verrous.

# 2. Réglages : ajouter la ligne SHH_PREPROD=1 à deploy/.env (et, pour l'essai du paiement,
#    §13.4 : SHH_PREPROD_PAIEMENT=1 et SHH_PREPROD_PAIEMENT_ESSAI=1).
editor deploy/.env

# 3. Une version de développement : le commit complet (40 chiffres), donné par la conversation
#    de développement (V3), jamais copié depuis GitHub. git fetch seulement, jamais git pull.
git fetch origin
deploy/preprod.sh <commit>

# 4. Le lien d'accès, à ouvrir sur chaque appareil (ne le coller dans aucun message), dans
#    VOTRE PROPRE fenêtre SSH (jamais dans une session Claude : le script refuse sans terminal) :
sudo deploy/lien-acces.sh
```

**Sur chaque appareil** : ouvrir ce lien une fois. PC : dans chaque navigateur utilisé. iPhone : dans Safari, **pas en navigation privée** (le témoin y est oublié à la fermeture). On arrive sur l'accueil du vrai site ; le témoin dure 30 jours (rouvrir le lien ensuite). Pour faire passer le lien à l'iPhone sans le confier à un service tiers : le taper, ou l'afficher dans une session SSH ouverte depuis l'iPhone (Termius, Blink : §4). **Le lien reste dans l'historique du navigateur**, synchronisé par iCloud ou Chrome si la synchronisation est active : après l'avoir ouvert, effacer cette entrée de l'historique.

**Changer le jeton** (lien diffusé par erreur, appareil perdu, ou par précaution) : `shred -u /etc/shhdrop/preprod-jeton` (un nouveau est tiré à l'installation qui suit), puis `deploy/preprod.sh "$(cat deploy/.release.commit)"` (ou `deploy/deploy.sh "$(cat deploy/.release)"` si une Release est en service) : Caddy est recréé avec le nouveau jeton, tous les témoins existants deviennent inutiles ; rouvrir le nouveau lien sur chaque appareil.

**Versions suivantes** : `git fetch origin && deploy/preprod.sh <nouveau commit>`. Réinstaller la même (après un redémarrage, §5) : `deploy/preprod.sh "$(cat deploy/.release.commit)"`. `deploy/deploy.sh status` dit « PRÉPRODUCTION ». Place disque : les images `shhdrop-preprod:<commit>` et le cache de construction s'accumulent ; de temps en temps, `docker image ls shhdrop-preprod`, `docker rmi` des anciennes (jamais celle en service ni la précédente), `docker builder prune`.

### 15.3 `preprod.sh` : ce qui est vérifié, et ce qui ne l'est pas

Vérifié, sans option pour le sauter : `SHH_PREPROD=1` (sinon refus) ; **verrous V1, V2 et V3** de `verrous.sh`, comme `deploy.sh` (commit complet en argument ; signé par une clé de `/etc/shhdrop/signataires-autorises`, et chaque commit depuis le commit installé aussi ; descendant du commit installé ; la copie est avancée par `git merge --ff-only`, puis le `preprod.sh` du commit vérifié est relancé) ; les contrôles de la machine (`preflight`, journaux compris) ; après le démarrage, le contrôle de santé de `deploy.sh` (barrière comprise ; `verify-site.mjs` contre un manifeste calculé du `/site` de l'image construite, `deploy/.preprod/<commit>/release.json`) ; retour à la version d'avant s'il échoue. L'image est construite par le Docker du serveur depuis les **fichiers suivis du commit vérifié seulement** (`git archive` de ce commit, extrait dans un dossier temporaire effacé à la fin : un fichier non suivi ou ignoré de la copie, que les verrous ne regardent pas, n'entre jamais dans l'image), avec le même `Dockerfile` et le même contexte qu'avant (`docker build`, mêmes arguments que `release.yml`, contexte limité par `.dockerignore` : ni `deploy/.env` ni secret), étiquetée `shhdrop-preprod:<commit>`. `/etc/shhdrop/commit-installe` avance comme avec `deploy.sh` : la Release d'ouverture devra être posée sur un commit **descendant** du dernier commit installé en préproduction (V2).

Hôtes de plus pendant `preprod.sh` (construction) : registres npm, crates.io, proxy Go et Docker Hub (images de base du `Dockerfile`).

**Pas vérifié (compromis assumé, sans utilisateurs ni données réelles)** : aucune signature Sigstore, aucun build de `release.yml`, aucune comparaison avec un build public (risque PP2).

`deploy.sh` (Release signée) reste utilisable pendant la préproduction, avec la barrière si `SHH_PREPROD=1`. Il n'installe jamais une image de préproduction : `deploy.sh preprod:…` et un `rollback` vers elle renvoient à `preprod.sh`.

### 15.4 À essayer à la main au premier passage

Sur le PC et sur l'iPhone, après le lien d'accès : l'accueil dans une fenêtre privée (sans le témoin) rend la page de maintenance ; création et ouverture d'un partage (envoi par segments) ; création d'un compte par passkey, connexion, déconnexion ; un salon ouvert sur deux appareils (WebSocket, **Safari surtout**) ; un appel ; un paiement d'essai complet (§13.4 : retour sur « Paiement reçu », webhook livré d'après le tableau de bord du prestataire). Tout échec : le noter et ne pas ouvrir.

### 15.5 Ouverture au public (jour J)

1. Avoir fait la liste du §9 (démarches légales) et, si le paiement s'ouvre, le §13.5 (passage au réel, base d'essai écartée).
2. Poser la Release `web-v1.0.0` (§3.2) sur un commit de `main` **descendant du dernier commit installé en préproduction**, qui retire aussi de `verifier-site.yml` et de `sonde.yml` leur branche « préproduction » (marquée « À retirer à l'ouverture »).
3. Sur le serveur : retirer de `deploy/.env` les lignes `SHH_PREPROD`, `SHH_PREPROD_PAIEMENT` et `SHH_PREPROD_PAIEMENT_ESSAI` (sans la barrière, `deploy.sh` refuse ces deux dernières, et l'essai du paiement).
4. `git fetch origin && deploy/deploy.sh sha256:<empreinte> 1.0.0 <commit>` (§3.2) : Caddy est recréé sans barrière ; le contrôle de santé vérifie le site servi contre la Release signée.
5. Supprimer le jeton : `shred -u /etc/shhdrop/preprod-jeton`. Les témoins restés dans les navigateurs ne servent plus à rien ; les effacer des appareils (données du site) par propreté.
6. Après vérification de l'ouverture : `docker rmi $(docker image ls -q shhdrop-preprod)`, `rm -rf deploy/.preprod`, `docker builder prune`.
7. Depuis un autre réseau : `curl -sI https://shhgone.com/` rend 200, sans `X-Shhdrop-Etat`.

### 15.5.1 Référencement : Google Search Console et Bing (le propriétaire, par ses comptes)

Rien à installer sur le site : ni balise, ni fichier de vérification, ni script (aucune ressource tierce). La propriété du domaine se prouve par **un enregistrement DNS TXT chez OVH**, qui ne contient qu'un jeton sans donnée personnelle (il est public, comme tout le DNS).

**Avant** : utiliser de préférence un compte Google et un compte Microsoft **dédiés au site** (pas le compte personnel), protégés par passkey. Ces deux entreprises sauront quel compte gère `shhgone.com` (rien n'est publié, mais l'éditeur du site reste anonyme pour le public seulement s'il l'est aussi pour elles).

**Google Search Console**

1. https://search.google.com/search-console, « Ajouter une propriété », type **Domaine** (pas « Préfixe d'URL »), saisir `shhgone.com`.
2. Google affiche une valeur `google-site-verification=…` : la copier.
3. OVH, espace client : Noms de domaine, `shhgone.com`, onglet **Zone DNS**, « Ajouter une entrée », type **TXT**, sous-domaine **vide** (le domaine lui-même), TTL par défaut, valeur = celle de Google. Valider. Ne pas toucher aux autres entrées (A, AAAA, CAA, MX…).
4. Attendre quelques minutes (jusqu'à quelques heures), puis « Valider » dans Search Console. Vérifier soi-même : `dig +short TXT shhgone.com` affiche la valeur.
5. **Une fois la barrière levée** (§15.5) : Search Console, « Sitemaps », saisir `sitemap.xml` (adresse complète `https://shhgone.com/sitemap.xml`), « Envoyer ». Tant que la barrière est en place, le site répond 503 et `noindex` : Google ne peut ni lire le plan du site ni indexer quoi que ce soit (envoyer le plan avant ne sert à rien, il le relira plus tard).
6. Laisser l'enregistrement TXT en place : le retirer fait perdre la propriété.

**Bing Webmaster Tools** (sert aussi DuckDuckGo, Ecosia, Qwant en partie)

1. https://www.bing.com/webmasters, se connecter.
2. Le plus simple : « **Importer depuis Google Search Console** » (domaine et plan du site repris, aucune entrée DNS de plus). Il faut autoriser Bing à lire Search Console ; sinon :
3. « Ajouter un site » `https://shhgone.com/`, vérification **par DNS** : Bing donne un enregistrement **CNAME** (un nom au hasard qui pointe vers `verify.bing.com`). OVH, Zone DNS, « Ajouter une entrée », type CNAME, sous-domaine = le nom donné par Bing, cible = `verify.bing.com.` (avec le point final). Puis « Vérifier » dans Bing.
4. Une fois la barrière levée : « Sitemaps », `https://shhgone.com/sitemap.xml`, « Envoyer ».

**Contrôle après l'ouverture** : dans Search Console, « Inspection de l'URL » sur `https://shhgone.com/` et `https://shhgone.com/en` : « L'URL est sur Google » ou « peut être indexée ». Les pages d'envoi, de compte, de salon et `/s` doivent rester « Exclue par la balise noindex » (voulu).

### 15.6 Risques et limites (à relire avant l'ouverture)

| # | Gravité | Endroit | Problème | Correction |
|---|---|---|---|---|
| PP1 | Moyenne | `Caddyfile`, exception 3 | `Sec-Fetch-Site` s'écrit à la main : un client qui n'est pas un navigateur (curl, script) joint l'API et les fichiers du site sans le témoin. Le public « navigateur » ne voit que la maintenance ; un curieux technique peut créer des partages, des salons, des comptes (aux limites habituelles : anti-robot, quotas par adresse) et, paiement d'essai ouvert, des pass d'essai | Préproduction courte ; `deploy.sh admin freeze` si un abus se voit (tableau de bord) ; correction forte possible, non faite : en préproduction seulement, envoyer le témoin avec les appels du site (`credentials: "same-origin"`, code du site à changer et à revoir) puis retirer l'exception 3 |
| PP2 | Élevée tant qu'elle dure | `preprod.sh` (spec §28.8, C8) | Image construite sur le serveur, sans signature ni build public : sa provenance n'est pas prouvée | Barrière exigée ; verrous V1 à V3 gardés ; ouverture seulement par `deploy.sh` et une Release signée (§15.5) |
| PP3 | Faible | `verifier-site.yml`, `sonde.yml` | Tant qu'ils voient exactement la page de maintenance (503, marqueur, corps de `maintenance.html`), ils concluent « préproduction, rien à vérifier » : un serveur compromis qui leur servirait cette page passerait inaperçu | Branches à retirer à l'ouverture (§15.5, étape 2) |
| PP4 | Faible | Caddy | Comparaison du jeton pas en temps constant | Jeton de 256 bits : une mesure de temps à travers le réseau ne le retrouve pas |
| PP5 | Faible | lien d'accès | Le jeton est dans l'adresse : historique du navigateur et sa synchronisation | Effacer l'entrée de l'historique ; changer le jeton au moindre doute (§15.2) |
| PP6 | Faible | `docker inspect` du conteneur Caddy | Le jeton est dans l'environnement du conteneur (lisible par root, comme le fichier) | Accepté : root a déjà tout ; jeton supprimé à l'ouverture |
| PP7 | Faible | `SHH_PREPROD_PAIEMENT*` | Réglage du paiement sans commit relu | Seulement avec la barrière, refusé sinon ; essai du paiement refusé sans barrière |

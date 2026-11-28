#!/usr/bin/env bash
# Banc d'essai de deploy/integrite.sh (make lint-deploy, job deploy-lint) : un faux système dans
# un dossier temporaire (racine préfixée), le vrai AIDE (paquet aide, exigé), dpkg, sshd, Docker
# et /proc remplacés par des sorties fixes ; les e-mails sont recueillis dans un fichier (aucun
# réseau). On vérifie : base refaite ; rien de changé → silence ; fichier changé, ajouté ou
# secret modifié → « URGENT intégrité » avec le chemin ; mise à jour d'un paquet officiel →
# base mise à jour sans alerte ; image, bases de données, conformité ; aucun contenu, aucun
# secret ni adresse IP dans les sorties.
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
command -v aide >/dev/null 2>&1 || {
	echo "test-integrite : AIDE absent (apt-get install --no-install-recommends aide)" >&2
	exit 3
}
w=$(mktemp -d)
trap 'rm -rf -- "$w"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}
SECRET=valeur-secrete-de-test-7f3a
IP=203.0.113.77
moi=$(id -u):$(id -g)

# Copie du dépôt (scripts, compose.yaml, versions des schémas) : .release y est écrit.
depot=$w/depot
mkdir -p "$depot/deploy" "$depot/server/internal/store" "$depot/server/internal/compte" "$depot/server/internal/paiement"
cp "$here"/integrite.sh "$here"/courriel.sh "$here"/lire-env.sh "$here"/journaux.sh "$here"/compose.yaml "$depot/deploy/"
printf 'package store\n\nconst SchemaVersion = 4\n' >"$depot/server/internal/store/store.go"
printf 'package compte\n\nconst VersionBase = 5\n' >"$depot/server/internal/compte/base.go"
printf 'package paiement\n\nconst VersionBase = 4\n' >"$depot/server/internal/paiement/base.go"
D=sha256:$(printf 'a%.0s' {1..64})
printf '%s\n' "$D" >"$depot/deploy/.release"
CADDY=$(grep -m1 -oE 'caddy:[0-9.]+@sha256:[0-9a-f]{64}' "$here/compose.yaml")

# Faux système.
r=$w/r
mkdir -p "$r/etc/ssh" "$r/etc/pam.d" "$r/etc/shhdrop" "$r/etc/systemd/system/timers.target.wants" \
	"$r/root/.ssh" "$r/home/debian/.ssh" "$r/usr/bin" "$r/usr/sbin" "$r/usr/local/bin" "$r/var/lib/dpkg/info" \
	"$r/srv/shhdrop/data" "$r/srv/shhdrop/caddy" "$r/srv/shhdrop/secrets"
printf 'root:x:0:0:root:/root:/bin/bash\ndebian:x:1000:1000::/home/debian:/bin/bash\nnobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n' >"$r/etc/passwd"
printf 'Include /etc/ssh/sshd_config.d/*.conf\n# Retiré par Shhdrop : Subsystem sftp /usr/lib/openssh/sftp-server\n' >"$r/etc/ssh/sshd_config"
printf 'moduli-v1\n' >"$r/etc/ssh/moduli"
printf '@include common-session\nsession optional pam_exec.so quiet type=open_session /bin/bash -p /opt/shhdrop/deploy/ssh-connexion.sh\n' >"$r/etc/pam.d/sshd"
printf '[Journal]\nStorage=volatile\nMaxRetentionSec=1h\nMaxFileSec=15min\n' >"$r/etc/systemd/journald.conf"
ln -s /etc/systemd/system/shhdrop-journal.timer "$r/etc/systemd/system/timers.target.wants/shhdrop-journal.timer"
printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexemple proprietaire\n' >"$r/home/debian/.ssh/authorized_keys"
printf 'binaire\n' >"$r/usr/bin/ls"
printf '%s\n' "$SECRET" >"$r/etc/shhdrop/alerte_smtp_mdp"
printf '%s\n' "$SECRET" >"$r/srv/shhdrop/secrets/shh_salons_cle"
# dpkg : ls (paquet coreutils) et moduli (fichier de configuration d'openssh-server).
printf '/usr/bin/ls\n/bin/ls\n' >"$r/var/lib/dpkg/info/coreutils.list"
printf '%s  bin/ls\n' "$(md5sum <"$r/usr/bin/ls" | cut -d' ' -f1)" >"$r/var/lib/dpkg/info/coreutils.md5sums"
printf '/etc/ssh/moduli\n' >"$r/var/lib/dpkg/info/openssh-server.list"
conffile() { printf 'Package: openssh-server\nStatus: install ok installed\nConffiles:\n /etc/ssh/moduli %s\n\n' "$(md5sum <"$r/etc/ssh/moduli" | cut -d' ' -f1)" >"$r/var/lib/dpkg/status"; }
conffile
# Base SQLite factice : en-tête de 100 octets, version du schéma 5 à l'octet 60.
base() { # <fichier> <version>
	{
		printf 'SQLite format 3\0'
		head -c 44 /dev/zero
		# shellcheck disable=SC2059 # octet calculé, écrit par printf (\\xHH)
		printf "\\x00\\x00\\x00\\x$(printf %02x "$2")"
		head -c 36 /dev/zero
	} >"$1"
	chmod 0600 "$1"
}
base "$r/srv/shhdrop/data/comptes.db" 5
base "$r/srv/shhdrop/data/shares.db" 4
chmod 0700 "$r/srv/shhdrop/data" "$r/srv/shhdrop/caddy"
# /proc : le serveur (/shhdrop) a comptes.db ouverte en écriture : normal.
proc=$w/proc
mkdir -p "$proc/100/fd" "$proc/100/fdinfo"
ln -s /shhdrop "$proc/100/exe"
ln -s /srv/shhdrop/data/comptes.db "$proc/100/fd/3"
printf 'pos:\t0\nflags:\t0100002\n' >"$proc/100/fdinfo/3"
# Docker : le serveur sur l'image vérifiée, et Caddy.
cat >"$w/docker" <<EOF
#!/usr/bin/env bash
case "\$1 \$2" in
"ps -q") cat "$w/docker-ps" ;;
"inspect -f") grep "^\$4 " "$w/docker-inspect" | cut -d' ' -f2- ;;
"image inspect") case "\$5" in "ghcr.io/skoow/shhgone@$D") echo sha256:image-serveur ;; "$CADDY") echo sha256:image-caddy ;; *) exit 1 ;; esac ;;
esac
EOF
chmod +x "$w/docker"
printf 'c1\nc2\n' >"$w/docker-ps"
printf 'c1 /shhdrop-shhdrop-1 ghcr.io/skoow/shhgone@%s sha256:image-serveur\nc2 /shhdrop-caddy-1 %s sha256:image-caddy\n' "$D" "$CADDY" >"$w/docker-inspect"

cat >"$w/env" <<EOF
SHH_DATA_ROOT=/srv/shhdrop
SHH_ALERTE_A=alerte@exemple.test
SHH_ALERTE_SMTP_HOST=smtp.exemple.test
SHH_ALERTE_SMTP_USER=u
SHH_ALERTE_FROM=a@exemple.test
EOF
export SHH_ENV_FILE=$w/env SHH_INTEGRITE_RACINE=$r SHH_INTEGRITE_ETAT=$w/etat SHH_INTEGRITE_PROC=$proc
export SHH_INTEGRITE_DOCKER=$w/docker SHH_INTEGRITE_MONTE=oui SHH_INTEGRITE_COMPTE=$moi
export SHH_INTEGRITE_SSHD_T='printf "loglevel QUIET\npasswordauthentication no\nkbdinteractiveauthentication no\n"'
export SHH_INTEGRITE_DPKG_VERIFY='true'
export SHH_COURRIEL_ENVOI="cat >>'$w/courriels'"
export PAM_RHOST=$IP SSH_CONNECTION="$IP 50000 192.0.2.1 22"

# lance <nom> <commande…> : sortie dans $w/<nom>.out, e-mails de ce passage dans $w/<nom>.mail.
lance() {
	local n=$1
	shift
	: >"$w/courriels"
	"$depot/deploy/integrite.sh" "$@" >"$w/$n.out" 2>"$w/$n.err" || ko "$n : code $? ($(cat "$w/$n.err"))"
	cp "$w/courriels" "$w/$n.mail"
}
etat() { sed -n "s/^$1=//p" "$w/etat/etat"; }
propre() { # aucune valeur de secret, aucune adresse IP, aucune empreinte de fichier
	local f
	for f in "$w/$1.out" "$w/$1.err" "$w/$1.mail" "$w/etat/etat"; do
		grep -qF "$SECRET" "$f" && ko "$1 : valeur d'un secret dans $(basename "$f")"
		grep -qF "$IP" "$f" && ko "$1 : adresse IP dans $(basename "$f")"
		grep -qE '[A-Za-z0-9+/]{43}=' "$f" && ko "$1 : empreinte de fichier dans $(basename "$f")"
	done
	return 0
}

# 1. Première base : e-mail « base refaite », état ok, image vérifiée.
lance base refaire "première installation"
grep -q '^Subject: Shhgone Intégrité : base refaite' "$w/base.mail" || ko "base : pas d'e-mail de base"
[ "$(etat resultat)" = ok ] || ko "base : état $(etat resultat)"
[ "$(etat image)" = ok ] || ko "base : image $(etat image)"
b1=$(etat base)
[[ $b1 =~ ^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$ ]] || ko "base : empreinte « $b1 »"
grep -q "Base d'intégrité : $b1 (précédente : aucune)" "$w/base.mail" || ko "base : empreinte absente de l'e-mail"
propre base

# 2. Rien de changé : silence (aucun e-mail), même empreinte.
lance rien verifier
[ ! -s "$w/rien.mail" ] || ko "rien : e-mail envoyé sans changement : $(grep Subject "$w/rien.mail")"
[ "$(etat resultat)" = ok ] || ko "rien : état $(etat resultat) ($(cat "$w/rien.out"))"
[ "$(etat base)" = "$b1" ] || ko "rien : empreinte changée"
propre rien

# 3. Fichiers changés : configuration SSH, clé ajoutée, binaire hors paquet, secret du volume.
printf 'PermitRootLogin yes\n%s\n' "$SECRET" >>"$r/etc/ssh/sshd_config"
printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIattaquant\n' >>"$r/home/debian/.ssh/authorized_keys"
printf 'porte\n' >"$r/usr/bin/porte"
printf 'autre-%s\n' "$SECRET" >"$r/srv/shhdrop/secrets/shh_salons_cle"
lance change verifier
grep -q '^Subject: Shhgone URGENT intégrité : ' "$w/change.mail" || ko "change : pas d'URGENT"
for p in "changé : /etc/ssh/sshd_config" "changé : /home/debian/.ssh/authorized_keys" "ajouté : /usr/bin/porte" \
	"changé : /srv/shhdrop/secrets/shh_salons_cle"; do
	grep -qF -- "- $p" "$w/change.mail" || ko "change : « $p » absent de l'e-mail"
done
[ "$(etat resultat)" = alerte ] || ko "change : état $(etat resultat)"
[ "$(etat base)" = "$b1" ] || ko "change : la base a changé malgré une différence"
propre change
# Toujours là la nuit suivante (la base n'a pas pris le changement).
lance change2 verifier
grep -q 'URGENT intégrité' "$w/change2.mail" || ko "change2 : différence oubliée"

# 4. Réinitialisation après une mise à jour légitime (deploy.sh) : la liste acceptée est dite,
#    puis plus rien.
lance refaite refaire "deploy.sh web-v1.2.3"
grep -qF -- "- changé : /etc/ssh/sshd_config" "$w/refaite.mail" || ko "refaite : changement accepté non listé"
b2=$(etat base)
[ "$b2" != "$b1" ] || ko "refaite : même empreinte"
grep -q "Base d'intégrité : $b2 (précédente : $b1)" "$w/refaite.mail" || ko "refaite : chaîne des empreintes"
propre refaite
lance apres verifier
[ ! -s "$w/apres.mail" ] || ko "apres : e-mail après réinitialisation : $(grep Subject "$w/apres.mail")"

# 5. Mise à jour automatique d'un paquet officiel (fichier de configuration identique au
#    paquet) : pas d'alerte, base mise à jour seule, e-mail « base mise à jour ».
printf 'moduli-v2\n' >"$r/etc/ssh/moduli"
conffile
lance paquet verifier
grep -q 'URGENT' "$w/paquet.mail" && ko "paquet : URGENT pour une mise à jour officielle"
grep -q '^Subject: Shhgone Intégrité : base mise à jour' "$w/paquet.mail" || ko "paquet : pas d'e-mail de base mise à jour"
[ "$(etat resultat)" = ok ] || ko "paquet : état $(etat resultat)"
b3=$(etat base)
[ "$b3" != "$b2" ] || ko "paquet : base inchangée"
lance paquet2 verifier
[ ! -s "$w/paquet2.mail" ] || ko "paquet2 : bavard"
# Même fichier, contenu qui n'est PAS celui du paquet : différence.
printf 'moduli-pirate\n' >"$r/etc/ssh/moduli"
lance pirate verifier
grep -qF -- "- changé : /etc/ssh/moduli" "$w/pirate.mail" || ko "pirate : conffile modifié non signalé"
printf 'moduli-v2\n' >"$r/etc/ssh/moduli"

# 6. dpkg --verify : fichier d'un paquet modifié.
export SHH_INTEGRITE_DPKG_VERIFY='printf "??5??????   /usr/bin/ls\n??5?????? c /etc/ssh/moduli\n"'
lance dpkg verifier
grep -qF -- "- fichier de paquet modifié (dpkg --verify) : /usr/bin/ls" "$w/dpkg.mail" || ko "dpkg : /usr/bin/ls non signalé"
grep -qF -- "/etc/ssh/moduli" "$w/dpkg.mail" && ko "dpkg : fichier de configuration signalé par dpkg (laissé à AIDE)"
export SHH_INTEGRITE_DPKG_VERIFY='true'

# 7. Conteneurs : image différente, conteneur en plus.
printf 'c1 /shhdrop-shhdrop-1 ghcr.io/skoow/shhgone@%s sha256:autre\nc2 /shhdrop-caddy-1 %s sha256:image-caddy\nc3 /mineur alpine:latest sha256:x\n' "$D" "$CADDY" >"$w/docker-inspect"
printf 'c1\nc2\nc3\n' >"$w/docker-ps"
lance image verifier
grep -qF "conteneur shhdrop-shhdrop-1 : ne tourne pas sur l'image" "$w/image.mail" || ko "image : empreinte différente non signalée"
grep -qF "conteneur mineur : image alpine:latest inattendue" "$w/image.mail" || ko "image : conteneur en plus non signalé"
[ "$(etat image)" != ok ] || ko "image : état ok"
printf 'c1 /shhdrop-shhdrop-1 ghcr.io/skoow/shhgone@%s sha256:image-serveur\nc2 /shhdrop-caddy-1 %s sha256:image-caddy\n' "$D" "$CADDY" >"$w/docker-inspect"
printf 'c1\nc2\n' >"$w/docker-ps"

# 8. Bases de données : version, droits, autre programme en écriture.
base "$r/srv/shhdrop/data/comptes.db" 3
chmod 0644 "$r/srv/shhdrop/data/shares.db"
mkdir -p "$proc/200/fd" "$proc/200/fdinfo"
ln -s /usr/bin/python3 "$proc/200/exe"
ln -s /srv/shhdrop/data/shares.db "$proc/200/fd/5"
printf 'flags:\t0100002\n' >"$proc/200/fdinfo/5"
lance bases verifier
grep -qF "base comptes.db : version du schéma 3 au lieu de 5" "$w/bases.mail" || ko "bases : version non signalée"
grep -qF "base shares.db : propriétaire ou droits inattendus" "$w/bases.mail" || ko "bases : droits non signalés"
grep -qF "base shares.db : ouverte en écriture par un autre programme que le serveur (/usr/bin/python3)" "$w/bases.mail" || ko "bases : écrivain non signalé"
base "$r/srv/shhdrop/data/comptes.db" 5
chmod 0600 "$r/srv/shhdrop/data/shares.db"
rm -rf "$proc/200"

# 9. Conformité : SFTP rouvert, alerte SSH retirée, journal de sshd bavard.
export SHH_INTEGRITE_SSHD_T='printf "loglevel INFO\npasswordauthentication no\nkbdinteractiveauthentication no\nsubsystem sftp /usr/lib/openssh/sftp-server\n"'
cp "$r/etc/pam.d/sshd" "$w/pam"
printf '@include common-session\n' >"$r/etc/pam.d/sshd"
lance conforme verifier
grep -qF "SFTP (et scp) de nouveau ouvert" "$w/conforme.mail" || ko "conforme : SFTP non signalé"
grep -qF "alerte de connexion SSH absente" "$w/conforme.mail" || ko "conforme : PAM non signalé"
grep -qF "LogLevel n'est pas QUIET" "$w/conforme.mail" || ko "conforme : journal de sshd non signalé"
cp "$w/pam" "$r/etc/pam.d/sshd"
export SHH_INTEGRITE_SSHD_T='printf "loglevel QUIET\npasswordauthentication no\nkbdinteractiveauthentication no\n"'

# 10. Volume verrouillé : non vérifié, dit dans l'état ; AIDE retiré : URGENT.
lance refaite2 refaire "essai"
export SHH_INTEGRITE_MONTE=non
lance verrouille verifier
[ ! -s "$w/verrouille.mail" ] || ko "verrouille : e-mail : $(grep Subject "$w/verrouille.mail")"
case $(etat volume) in "non monté"*) ;; *) ko "verrouille : volume « $(etat volume) »" ;; esac
export SHH_INTEGRITE_MONTE=oui SHH_INTEGRITE_AIDE=$w/aide-absent
lance sans-aide verifier
grep -qF "AIDE absent" "$w/sans-aide.mail" || ko "sans-aide : non signalé"
unset SHH_INTEGRITE_AIDE

# 11. Base effacée : URGENT ; empreinte affichée sur demande.
lance empreinte empreinte
[ "$(cat "$w/empreinte.out")" = "$(etat base)" ] || ko "empreinte : $(cat "$w/empreinte.out")"
rm -f "$w/etat/systeme.db"
lance effacee verifier
grep -qF "base d'intégrité absente" "$w/effacee.mail" || ko "effacee : non signalé"

# 12. installer-surveillance.sh (deploy.sh) : PAM, SFTP coupé, unités ; idempotent.
s=$w/s
mkdir -p "$s/etc/pam.d" "$s/etc/ssh/sshd_config.d"
printf 'session required pam_env.so user_readenv=1 envfile=/etc/default/locale\n@include common-session\n' >"$s/etc/pam.d/sshd"
printf 'Include /etc/ssh/sshd_config.d/*.conf\nSubsystem\tsftp\t/usr/lib/openssh/sftp-server\nUsePAM yes\n' >"$s/etc/ssh/sshd_config"
printf 'subsystem sftp internal-sftp\n' >"$s/etc/ssh/sshd_config.d/50-autre.conf"
cp "$here/installer-surveillance.sh" "$depot/deploy/"
cp -r "$here/systemd" "$depot/deploy/"
surv() { # <nom> : lance l'installation sur le faux /etc
	SHH_SURV_RACINE=$s SHH_SURV_SYSTEMCTL="$w/systemctl" SHH_SURV_SSHD="$w/sshd" SHH_SURV_APT=true SHH_SURV_AIDE=aide \
		"$depot/deploy/installer-surveillance.sh" >"$w/$1.out" 2>"$w/$1.err"
}
# shellcheck disable=SC2016 # script écrit tel quel
printf '#!/bin/sh\necho "$@" >>%s/systemctl.log\ncase $1 in is-*) exit 1 ;; esac\n' "$w" >"$w/systemctl"
printf '#!/bin/sh\nexit 0\n' >"$w/sshd"
chmod +x "$w/systemctl" "$w/sshd"
surv surv1 || ko "surv1 : code ($(cat "$w/surv1.err"))"
grep -qxF "session optional pam_exec.so quiet type=open_session /bin/bash -p $depot/deploy/ssh-connexion.sh" "$s/etc/pam.d/sshd" || ko "surv1 : ligne PAM absente"
grep -q 'user_readenv=1' "$s/etc/pam.d/sshd" && ko "surv1 : user_readenv=1 resté"
grep -qiE '^[[:space:]]*subsystem[[:space:]]+sftp' "$s/etc/ssh/sshd_config" "$s/etc/ssh/sshd_config.d/50-autre.conf" && ko "surv1 : SFTP resté ouvert"
grep -q '^UsePAM yes' "$s/etc/ssh/sshd_config" || ko "surv1 : configuration de sshd abîmée"
grep -q 'try-reload-or-restart ssh.service' "$w/systemctl.log" || ko "surv1 : sshd non rechargé"
grep -qxF "ExecStart=$depot/deploy/integrite.sh verifier" "$s/etc/systemd/system/shhdrop-integrite.service" || ko "surv1 : unité d'intégrité (chemin)"
grep -q 'enable --now shhdrop-integrite.timer' "$w/systemctl.log" || ko "surv1 : minuteur d'intégrité non activé"
# Deuxième passage : rien ne change (PAM identique, aucune unité réécrite).
cp "$s/etc/pam.d/sshd" "$w/pam1"
: >"$w/systemctl.log"
surv surv2 || ko "surv2 : code"
cmp -s "$w/pam1" "$s/etc/pam.d/sshd" || ko "surv2 : PAM réécrit ($(diff "$w/pam1" "$s/etc/pam.d/sshd"))"
[ "$(grep -c 'ssh-connexion' "$s/etc/pam.d/sshd")" = 1 ] || ko "surv2 : ligne PAM en double"
grep -q 'daemon-reload' "$w/systemctl.log" && ko "surv2 : unités réécrites sans changement"
# sshd -t refuse : configuration remise telle quelle, échec dit.
printf 'Subsystem sftp /usr/lib/openssh/sftp-server\n' >"$s/etc/ssh/sshd_config"
cp "$s/etc/ssh/sshd_config" "$w/sshd1"
printf '#!/bin/sh\nexit 1\n' >"$w/sshd"
if surv surv3; then ko "surv3 : succès malgré sshd -t"; fi
cmp -s "$w/sshd1" "$s/etc/ssh/sshd_config" || ko "surv3 : configuration non remise"
grep -q 'remise telle quelle' "$w/surv3.err" || ko "surv3 : message ($(cat "$w/surv3.err"))"

[ "$echec" = 0 ] && printf 'test-integrite : ok\n'
exit "$echec"

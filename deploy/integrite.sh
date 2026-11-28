#!/usr/bin/env bash
# Empreinte du serveur sain, vérifiée chaque nuit (décision du propriétaire du 28 novembre ;
# README, « Intégrité du serveur »). Lancé par systemd/shhdrop-integrite.timer (verifier), et
# par deploy.sh, preprod.sh, secret.sh et admin-jeton.sh après un changement légitime (refaire).
#
#   deploy/integrite.sh verifier           contrôle de la nuit ; e-mail « URGENT intégrité » si
#                                          quelque chose a changé (chemins seulement)
#   deploy/integrite.sh refaire [raison]   nouvelle base après une mise à jour légitime ; e-mail
#                                          « Intégrité : base refaite » avec la liste acceptée
#   deploy/integrite.sh empreinte          affiche l'empreinte de la base en service
#
# Ce qui est contrôlé :
#   1. fichiers des paquets Debian : « dpkg --verify » (sommes des paquets officiels ; un fichier
#      remplacé par une mise à jour redevient conforme). Les fichiers de configuration (« c »)
#      sont laissés à AIDE. Un écart déjà présent à la base (rare : fichier qu'un paquet réécrit
#      lui-même) est accepté, et dit dans l'e-mail de la base ;
#   2. AIDE (paquet Debian), limité à ce que les paquets ne couvrent pas : une partie de /etc
#      (SSH, sudo, systemd, Docker, APT, cron, comptes, PAM, chargeur, sysctl, /etc/shhdrop…),
#      ~/.ssh et fichiers de démarrage du shell des comptes, crontabs, /usr/local, /opt (dont la
#      copie du dépôt, hors objets de git), binaires et unités système hors paquets (présence et
#      droits seulement : leur contenu est celui de dpkg --verify), et, volume chiffré monté, ses
#      dossiers et ses secrets (empreinte et droits, jamais la valeur dans un rapport). Un
#      fichier changé ou ajouté dont le contenu est exactement celui d'un paquet officiel (mise à
#      jour automatique), ou retiré par dpkg, est accepté : la base est alors mise à jour seule
#      (e-mail « base mise à jour »). Tout le reste est une différence ;
#   3. bases de données (pas leur contenu, qui change sans cesse) : propriétaire, droits,
#      version du schéma (en-tête du fichier, lu sans ouvrir SQLite : aucun verrou) égale à celle
#      du code installé, et aucun autre programme que le serveur (ou la sauvegarde) qui les a
#      ouvertes en écriture ;
#   4. conteneurs en marche = image signée vérifiée par deploy.sh (deploy/.release) et Caddy
#      épinglé par compose.yaml ; aucun autre conteneur ;
#   5. conformité : SFTP coupé, alerte de connexion SSH en place, journaux sans adresse IP
#      (journaux.sh, comme deploy.sh).
#
# Jamais dans un e-mail, une sortie ou l'état : le contenu d'un fichier, une empreinte d'un
# fichier, une adresse IP. Le rapport d'AIDE (qui contient des empreintes) reste en mémoire.
# État (aucun chemin) : /var/lib/shhdrop-integrite/etat, lu par alerte.sh pour le bilan du lundi.
#
# Essais (deploy/test-integrite.sh) : SHH_INTEGRITE_RACINE (préfixe de tous les chemins lus),
# SHH_INTEGRITE_ETAT, SHH_INTEGRITE_MAINTENANT, SHH_INTEGRITE_AIDE (binaire),
# SHH_INTEGRITE_DPKG_VERIFY, SHH_INTEGRITE_SSHD_T, SHH_INTEGRITE_DOCKER, SHH_INTEGRITE_MONTE
# (« oui »/« non »), SHH_INTEGRITE_PROC ; SHH_ENV_FILE ; SHH_COURRIEL_ENVOI (courriel.sh).
set -euo pipefail
export LC_ALL=C
umask 077
here=$(cd "$(dirname "$0")" && pwd)
depot=$(cd "$here/.." && pwd)
die() {
	printf 'intégrité : %s\n' "$*" >&2
	exit 1
}
usage() {
	printf 'usage: integrite.sh verifier | refaire [raison] | empreinte\n' >&2
	exit 2
}
[ $# -ge 1 ] || usage
cmd=$1
shift

r=${SHH_INTEGRITE_RACINE:-}
etat=${SHH_INTEGRITE_ETAT:-/var/lib/shhdrop-integrite}
confdir=$r/etc/shhdrop
now=${SHH_INTEGRITE_MAINTENANT:-$(date +%s)}
aide_bin=${SHH_INTEGRITE_AIDE:-aide}
# Compte du serveur (propriétaire des bases) ; changé seulement par les essais.
compte=${SHH_INTEGRITE_COMPTE:-65532:65532}

env_file=${SHH_ENV_FILE:-$here/.env}
if [ -f "$env_file" ]; then
	# shellcheck source=deploy/lire-env.sh
	. "$here/lire-env.sh"
	lire_env "$env_file" 0 || die "$env_file refusé (voir ci-dessus)"
fi
# shellcheck source=deploy/courriel.sh
. "$here/courriel.sh"
# shellcheck source=deploy/journaux.sh
. "$here/journaux.sh"
donnees=$r${SHH_DATA_ROOT:-/srv/shhdrop}

mkdir -p "$etat"
chmod 0700 "$etat"
exec 8>"$etat/verrou"
flock -w 600 8 || die "un autre contrôle d'intégrité est en cours"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

# propre <texte> : un chemin ou une ligne sans caractère de contrôle (un nom de fichier choisi
# par un attaquant ne doit rien ajouter à l'e-mail).
propre() { printf '%s' "$1" | tr -c '[:print:]' '?'; }
# re <chemin> : chemin en expression régulière d'AIDE.
# shellcheck disable=SC2016 # « $ » est un caractère à échapper, pas une variable
re() { printf '%s' "$1" | sed 's/[]*.[\\^$()+?{}|]/\\&/g'; }

# --- Configuration d'AIDE -------------------------------------------------------------------------
entete() { # <nom de la base>
	printf 'database_in=file:%s/%s.db\ndatabase_out=file:%s/%s.db.neuf\ngzip_dbout=no\n' "$etat" "$1" "$etat" "$1"
	if [ -n "$r" ]; then printf 'root_prefix=%s\n' "$r"; fi
	cat <<'EOF'
report_level=list_entries
report_url=stdout
log_level=warning
# Contenu : droits, propriétaire, taille, empreinte, type, cible d'un lien, capacités.
Contenu = p+u+g+s+sha256+ftype+l+caps
# Presence : sans le contenu (celui des fichiers des paquets est contrôlé par dpkg --verify).
Presence = p+u+g+ftype+l+caps
# Dossier : ni taille ni dates (elles changent à chaque fichier ajouté ou retiré).
Dossier = p+u+g+ftype
EOF
}
arbre() { # <chemin> <règle des fichiers et liens>
	local p
	p=$(re "$1")
	printf '%s f %s\n%s l %s\n%s d Dossier\n' "$p" "$2" "$p" "$2" "$p"
}
fichier() { printf '%s$ f Contenu\n%s$ l Contenu\n' "$(re "$1")" "$(re "$1")"; }

conf_systeme() {
	local d h
	entete systeme
	echo "# /etc : seulement ce qui commande l'accès et le démarrage (le reste change avec les paquets)."
	for d in ssh sudoers.d systemd docker apt cron.d cron.daily cron.hourly cron.weekly cron.monthly \
		pam.d security ld.so.conf.d profile.d sysctl.d modprobe.d modules-load.d shhdrop ufw \
		tmpfiles.d update-motd.d; do
		arbre "/etc/$d" Contenu
	done
	for f in sudoers sudo.conf crontab anacrontab passwd shadow group gshadow subuid subgid \
		ld.so.preload ld.so.conf profile bash.bashrc environment sysctl.conf modules hosts \
		nsswitch.conf rc.local; do
		fichier "/etc/$f"
	done
	echo "# Comptes : clés SSH et démarrage du shell (known_hosts exclu : il change à chaque hôte joint)."
	while IFS=: read -r _ _ uid _ _ h _; do
		[ -n "$h" ] && [ "$h" != / ] && [ -d "$r$h" ] || continue
		[[ $uid =~ ^[0-9]+$ ]] || continue
		[ "$uid" = 0 ] || { [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ]; } || continue
		arbre "$h/.ssh" Contenu
		printf '!%s/\\.ssh/known_hosts\n' "$(re "$h")"
		for f in .bashrc .profile .bash_profile .bash_login .bash_logout; do fichier "$h/$f"; done
	done <"$r/etc/passwd"
	arbre /var/spool/cron/crontabs Contenu
	echo "# Hors paquets : contenu complet."
	arbre /usr/local Contenu
	arbre /opt Contenu
	# Copie du dépôt : ses objets et références changent à chaque « git fetch » (alerte.sh, une
	# fois par jour) ; ils sont vérifiés par les verrous de deploy.sh (commits signés). Restent
	# contrôlés : les fichiers suivis, .git/config, .git/hooks, .git/HEAD.
	d=$(re "$depot")
	printf '!%s/\\.git/(objects|refs|logs|FETCH_HEAD|ORIG_HEAD|packed-refs|index|COMMIT_EDITMSG|AUTO_MERGE|shallow|lost-found|gc\\.log|gc\\.pid)\n' "$d"
	printf '!%s/deploy/\\.deploy\\.lock$\n' "$d"
	if [[ $depot != /opt/* ]]; then arbre "$depot" Contenu; fi
	echo "# Binaires et unités système : présence et droits (leur contenu : dpkg --verify)."
	arbre /usr/bin Presence
	arbre /usr/sbin Presence
	arbre /usr/lib/systemd/system Presence
}
conf_volume() {
	local v
	v=$(re "${donnees#"$r"}")
	entete volume
	echo "# Volume chiffré : ses dossiers (droits seulement), jamais les données ; ses secrets"
	echo "# (empreinte et droits : la valeur n'est jamais dans un rapport)."
	printf '=%s$ Dossier\n=%s/data$ Dossier\n=%s/caddy$ Dossier\n' "$v" "$v" "$v"
	arbre "${donnees#"$r"}/secrets" Contenu
}

# aide_lancer <systeme|volume> <--init|--check|--update> : rapport (liste des entrées, gardé en
# mémoire) dans aide_rapport, code d'AIDE dans aide_code (0 rien, 1 à 7 des différences, 14 et plus : erreur).
aide_code=0 aide_rapport=""
aide_lancer() {
	aide_code=0
	aide_rapport=$("$aide_bin" -c "$confdir/integrite-$1.conf" "$2" 2>"$tmp/aide.err") || aide_code=$?
}
# entrees <rapport> : « ajouté|retiré|changé <chemin> » par ligne.
entrees() {
	local s="" l
	while IFS= read -r l; do
		case $l in
		"Added entries:") s=ajouté ;;
		"Removed entries:") s=retiré ;;
		"Changed entries:") s=changé ;;
		"The attributes of"*) s="" ;;
		*)
			if [ -n "$s" ] && [[ $l =~ ^[^/]*:\ (/.*)$ ]]; then printf '%s %s\n' "$s" "${BASH_REMATCH[1]}"; fi
			;;
		esac
	done <<<"$1"
}

# --- Paquets officiels --------------------------------------------------------------------------
# possedes : chemins installés par un paquet (avec /bin… → /usr/bin… : /usr fusionné) ; sommes :
# « md5  chemin » de chaque fichier ordinaire et de chaque fichier de configuration.
usrmerge() { sed -E 'p; s#^(/?)(bin|sbin|lib|lib32|lib64|libx32)/#\1usr/\2/#' | sort -u; }
preparer_paquets() {
	local info=$r/var/lib/dpkg/info
	cat "$info"/*.list 2>/dev/null | usrmerge >"$tmp/possedes" || true
	{
		cat "$info"/*.md5sums 2>/dev/null || true
		# Fichiers de configuration (Conffiles de /var/lib/dpkg/status) : « /etc/x md5 ».
		awk '/^Conffiles:/{c=1; next} /^[^ ]/{c=0} c && $1 ~ /^\// {sub(/^\//, "", $1); print $2 "  " $1}' \
			"$r/var/lib/dpkg/status" 2>/dev/null || true
	} | usrmerge >"$tmp/sommes"
}
# officiel <ajouté|changé|retiré> <chemin> : 0 si le changement vient d'un paquet officiel.
officiel() {
	local quoi=$1 p=$2 f=$r$2 m
	if [ "$quoi" = retiré ]; then
		# Retiré par dpkg : il était installé par un paquet à la base, il ne l'est plus.
		grep -qxF -- "$p" "$etat/paquets-avant" 2>/dev/null && ! grep -qxF -- "$p" "$tmp/possedes"
		return
	fi
	if grep -qxF -- "$p" "$tmp/possedes"; then
		if [ -f "$f" ] && [ ! -L "$f" ]; then
			m=$(md5sum <"$f" | cut -d' ' -f1)
			grep -qxF -- "$m  ${p#/}" "$tmp/sommes"
			return
		fi
		return 0 # dossier ou lien d'un paquet
	fi
	# Lien géré par update-alternatives (/usr/bin/x → /etc/alternatives/x).
	[ -L "$f" ] && [[ $(readlink "$f") == /etc/alternatives/* ]]
}
dpkg_ecarts() { # lignes de dpkg --verify hors fichiers de configuration, triées
	local s
	if [ -n "${SHH_INTEGRITE_DPKG_VERIFY:-}" ]; then
		s=$(bash -c "$SHH_INTEGRITE_DPKG_VERIFY" 2>/dev/null) || true
	else
		s=$(dpkg --verify 2>/dev/null) || true
	fi
	printf '%s\n' "$s" | grep -vE '^.{9} c /' | grep -E ' /' | sort -u || true
}

# --- Bases de données, conteneurs, conformité ---------------------------------------------------
version_attendue() { # <fichier source> <constante>
	sed -nE "s/^const $2 = ([0-9]+)\$/\\1/p" "$depot/$1" 2>/dev/null | head -n 1
}
controle_bases() { # écrit un problème par ligne
	local nom src cst f v attendu ext m
	for nom in shares:server/internal/store/store.go:SchemaVersion comptes:server/internal/compte/base.go:VersionBase \
		paiements:server/internal/paiement/base.go:VersionBase; do
		IFS=: read -r nom src cst <<<"$nom"
		f=$donnees/data/$nom.db
		[ -e "$f" ] || continue
		for ext in "" -wal -shm; do
			[ -e "$f$ext" ] || continue
			m=$(stat -c '%u:%g %a %F' "$f$ext")
			[ "$m" = "$compte 600 regular file" ] || [ "$m" = "$compte 600 regular empty file" ] ||
				echo "base $nom.db$ext : propriétaire ou droits inattendus ($(propre "${m%% regular*}") au lieu de $compte 600)"
		done
		attendu=$(version_attendue "$src" "$cst")
		# Version du schéma : 4 octets (grand-boutiste) à l'octet 60 de l'en-tête de SQLite.
		v=$(od -An -tu1 -j60 -N4 "$f" 2>/dev/null | awk '{print $1*16777216 + $2*65536 + $3*256 + $4}')
		if [ -n "$attendu" ] && [ -n "$v" ] && [ "$v" != "$attendu" ]; then
			# Juste après une migration, l'en-tête peut attendre le vidage du journal (-wal).
			if [ -s "$f-wal" ]; then continue; fi
			echo "base $nom.db : version du schéma $v au lieu de $attendu (code installé)"
		fi
	done
}
controle_ecrivains() { # programmes autres que le serveur qui ont une base ouverte en écriture
	local proc=${SHH_INTEGRITE_PROC:-$r/proc} d fd cible exe flags vus=""
	for d in "$proc"/[0-9]*; do
		[ -d "$d/fd" ] || continue
		for fd in "$d"/fd/*; do
			cible=$(readlink "$fd" 2>/dev/null) || continue
			case $cible in "${donnees#"$r"}"/data/*.db | "${donnees#"$r"}"/data/*.db-wal) ;; *) continue ;; esac
			flags=$(sed -n 's/^flags:[[:space:]]*//p' "$d/fdinfo/${fd##*/}" 2>/dev/null)
			[ -n "$flags" ] && [ $((8#$flags & 3)) -ne 0 ] || continue # O_WRONLY ou O_RDWR
			exe=$(readlink "$d/exe" 2>/dev/null || echo "?")
			case $exe in /shhdrop) continue ;; esac
			# La sauvegarde quotidienne (sqlite3, unité shhdrop-sauvegarde) copie comptes.db.
			if [ "${exe##*/}" = sqlite3 ] && grep -q 'shhdrop-sauvegarde' "$d/cgroup" 2>/dev/null; then continue; fi
			case " $vus " in *" $exe:${cible##*/} "*) continue ;; esac
			vus="$vus $exe:${cible##*/}"
			echo "base ${cible##*/} : ouverte en écriture par un autre programme que le serveur ($(propre "$exe"))"
		done
	done
}
image_etat="" # ok, ou la raison de l'écart (sans chemin ni adresse)
controle_images() {
	local docker=${SHH_INTEGRITE_DOCKER:-docker} cur attendue caddy id nom ref img voulu vu=0
	cur=$(cat "$here/.release" 2>/dev/null || true)
	case $cur in
	sha256:*) attendue="ghcr.io/skoow/shhgone@$cur" ;;
	preprod:*) attendue="shhdrop-preprod:${cur#preprod:}" ;;
	*)
		image_etat="aucune version installée"
		return 0
		;;
	esac
	caddy=$(grep -m1 -oE 'caddy:[0-9.]+@sha256:[0-9a-f]{64}' "$here/compose.yaml" || true)
	image_etat=ok
	for id in $("$docker" ps -q 2>/dev/null); do
		read -r nom ref img < <("$docker" inspect -f '{{.Name}} {{.Config.Image}} {{.Image}}' "$id" 2>/dev/null) || continue
		nom=${nom#/}
		if [ "$ref" != "$attendue" ] && [ "$ref" != "$caddy" ]; then
			echo "conteneur $(propre "$nom") : image $(propre "$ref") inattendue (ni la version vérifiée par deploy.sh, ni Caddy de compose.yaml)"
			image_etat="conteneur inattendu"
			continue
		fi
		voulu=$("$docker" image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)
		if [ -z "$voulu" ] || [ "$img" != "$voulu" ]; then
			echo "conteneur $(propre "$nom") : ne tourne pas sur l'image $(propre "$ref") (empreinte différente)"
			image_etat="empreinte différente"
		fi
		[ "$ref" = "$attendue" ] && vu=1
	done
	if [ "$vu" = 0 ] && [ "$image_etat" = ok ]; then image_etat="serveur arrêté"; fi
}
controle_conformite() {
	local sshd_t pam=$r/etc/pam.d/sshd
	if [ -n "${SHH_INTEGRITE_SSHD_T:-}" ]; then
		sshd_t=$(bash -c "$SHH_INTEGRITE_SSHD_T" 2>/dev/null) || sshd_t=
	else
		sshd_t=$(PATH=$PATH:/usr/sbin sshd -T 2>/dev/null) || sshd_t=
	fi
	if [ -z "$sshd_t" ]; then
		echo "conformité : configuration de sshd illisible (sshd -T)"
	elif grep -qiE '^subsystem[[:space:]]+sftp' <<<"$sshd_t"; then
		echo "conformité : SFTP (et scp) de nouveau ouvert dans sshd (Subsystem sftp)"
	fi
	grep -qE '^[[:space:]]*session[[:space:]]+optional[[:space:]]+pam_exec\.so[[:space:]].*ssh-connexion\.sh' "$pam" 2>/dev/null ||
		echo "conformité : alerte de connexion SSH absente de /etc/pam.d/sshd"
	if grep -qE '^[[:space:]]*[^#].*user_readenv=1' "$pam" 2>/dev/null; then
		echo "conformité : /etc/pam.d/sshd lit l'environnement des comptes (user_readenv=1)"
	fi
	local pbs
	if ! pbs=$(controle_journaux "$r" "${sshd_t:-absent}"); then
		while IFS= read -r l; do printf 'conformité : %s\n' "$l"; done <<<"$pbs"
	fi
}

# --- Empreinte de la base, état -----------------------------------------------------------------
empreinte() {
	local f
	for f in "$etat/systeme.db" "$etat/volume.db" "$confdir/integrite-systeme.conf" "$confdir/integrite-volume.conf" \
		"$etat/dpkg-acceptes" "$etat/paquets-avant"; do
		[ -f "$f" ] && sha256sum <"$f" | cut -d' ' -f1
	done | sha256sum | cut -c1-16 | sed -E 's/(....)(....)(....)(....)/\1-\2-\3-\4/'
}
n_paquets=0 n_ecarts=0
ecrire_etat() { # <resultat> <volume>
	printf 'resultat=%s\ndate=%s\nbase=%s\nimage=%s\nvolume=%s\npaquets=%s\necarts=%s\n' "$1" "$now" "$(empreinte)" "$image_etat" "$2" "$n_paquets" "$n_ecarts" >"$etat/etat.neuf"
	mv -f "$etat/etat.neuf" "$etat/etat"
}
journal_base() { # <ancienne> <nouvelle> <raison>
	printf '%s %s %s %s\n' "$now" "$1" "$2" "$(propre "$3")" >>"$etat/journal-base"
}
volume_monte() {
	if [ -n "${SHH_INTEGRITE_MONTE:-}" ]; then [ "$SHH_INTEGRITE_MONTE" = oui ]; else mountpoint -q "$donnees"; fi
}
installee() { command -v "$aide_bin" >/dev/null 2>&1 && [ -f "$etat/systeme.db" ]; }

# --- refaire ------------------------------------------------------------------------------------
refaire() {
	local raison=${1:-mise à jour} avant apres volume=vérifié liste="" n=0 q p
	command -v "$aide_bin" >/dev/null 2>&1 || die "AIDE absent (apt-get install aide ; deploy.sh l'installe)"
	avant=$(installee && empreinte || echo aucune)
	# Ce qui a changé depuis l'ancienne base (accepté par cette nouvelle base) : chemins seulement.
	if installee; then
		aide_lancer systeme --check
		while read -r q p; do
			[ -n "$p" ] || continue
			if [ "$n" -lt 200 ]; then liste+="- $q : $(propre "$p")"$'\n'; fi
			n=$((n + 1))
		done < <(entrees "$aide_rapport")
		if volume_monte && [ -f "$etat/volume.db" ]; then
			aide_lancer volume --check
			while read -r q p; do
				[ -n "$p" ] || continue
				if [ "$n" -lt 200 ]; then liste+="- $q : $(propre "$p")"$'\n'; fi
				n=$((n + 1))
			done < <(entrees "$aide_rapport")
		fi
	fi
	mkdir -p "$confdir"
	conf_systeme >"$confdir/integrite-systeme.conf"
	conf_volume >"$confdir/integrite-volume.conf"
	chmod 0600 "$confdir"/integrite-*.conf
	aide_lancer systeme --init
	[ "$aide_code" -lt 14 ] && [ -f "$etat/systeme.db.neuf" ] || die "AIDE : base du système impossible ($(head -c 300 "$tmp/aide.err" | tr -c '[:print:]\n' '?'))"
	mv -f "$etat/systeme.db.neuf" "$etat/systeme.db"
	if volume_monte; then
		aide_lancer volume --init
		[ "$aide_code" -lt 14 ] && [ -f "$etat/volume.db.neuf" ] || die "AIDE : base du volume impossible"
		mv -f "$etat/volume.db.neuf" "$etat/volume.db"
	else
		volume="non monté (base du volume gardée)"
	fi
	dpkg_ecarts >"$etat/dpkg-acceptes"
	preparer_paquets
	cp "$tmp/possedes" "$etat/paquets-avant"
	controle_images >/dev/null || true
	apres=$(empreinte)
	journal_base "$avant" "$apres" "$raison"
	ecrire_etat ok "$volume"
	local texte
	texte="Nouvelle base d'intégrité du serveur ($(propre "$raison")).
Base d'intégrité : $apres (précédente : $avant)

Changements acceptés par cette base depuis la précédente (chemins seulement) : $n"
	if [ -n "$liste" ]; then texte+=$'\n'"$liste"; fi
	if [ -s "$etat/dpkg-acceptes" ]; then
		texte+=$'\n'"Fichiers de paquets déjà différents des paquets officiels, acceptés : $(wc -l <"$etat/dpkg-acceptes")"$'\n'
		while read -r _ p; do texte+="- $(propre "${p##* }")"$'\n'; done < <(head -n 30 "$etat/dpkg-acceptes")
		if [ "$(wc -l <"$etat/dpkg-acceptes")" -gt 30 ]; then texte+="- … (30 premiers seulement ; souvent des fichiers de documentation absents, sans effet)"$'\n'; fi
	fi
	texte+="
Si vous n'avez lancé ni mise à jour ni commande ces dernières minutes : README, « Que faire si une alerte d'intégrité arrive »."
	printf '%s\n' "$texte"
	courriel_envoyer Info integrite-base "$texte" "Shhgone Intégrité : base refaite ($apres)" || true
}

# --- verifier -----------------------------------------------------------------------------------
verifier() {
	local pbs=() maj=() q p l volume=vérifié avant apres rapport code
	image_etat=""
	if ! command -v "$aide_bin" >/dev/null 2>&1; then
		pbs+=("AIDE absent : il a été retiré (deploy.sh le réinstalle)")
	elif [ ! -f "$etat/systeme.db" ]; then
		pbs+=("base d'intégrité absente (effacée ?) : deploy.sh la refait après vérification")
	else
		avant=$(empreinte)
		preparer_paquets
		aide_lancer systeme --update
		code=$aide_code rapport=$aide_rapport
		if [ "$code" -ge 14 ]; then
			pbs+=("AIDE en erreur (code $code) sur la base du système")
		else
			while read -r q p; do
				[ -n "$p" ] || continue
				if officiel "$q" "$p"; then maj+=("$q : $(propre "$p")"); else pbs+=("$q : $(propre "$p")"); fi
			done < <(entrees "$rapport")
		fi
		# Seulement des mises à jour officielles : la base les prend (e-mail « base mise à jour »).
		while IFS= read -r l; do
			[ -n "$l" ] || continue
			grep -qxF -- "$l" "$etat/dpkg-acceptes" 2>/dev/null && continue
			pbs+=("fichier de paquet modifié (dpkg --verify) : $(propre "${l##* }")")
			n_paquets=$((n_paquets + 1))
		done < <(dpkg_ecarts)
		if [ ${#pbs[@]} -eq 0 ] && [ ${#maj[@]} -gt 0 ] && [ -f "$etat/systeme.db.neuf" ]; then
			mv -f "$etat/systeme.db.neuf" "$etat/systeme.db"
			cp "$tmp/possedes" "$etat/paquets-avant"
			apres=$(empreinte)
			journal_base "$avant" "$apres" "mises à jour des paquets officiels"
			local t="La base d'intégrité a pris ${#maj[@]} changement(s) venus des paquets officiels (mises à jour automatiques ; contenu identique à celui des paquets Debian) :"
			for l in "${maj[@]}"; do t+=$'\n'"- $l"; done
			t+=$'\n\n'"Base d'intégrité : $apres (précédente : $avant)"
			printf '%s\n' "$t"
			courriel_envoyer Info integrite-base "$t" "Shhgone Intégrité : base mise à jour ($apres)" || true
		fi
		rm -f "$etat/systeme.db.neuf"
	fi
	if volume_monte; then
		if [ -f "$etat/volume.db" ] && command -v "$aide_bin" >/dev/null 2>&1; then
			aide_lancer volume --check
			if [ "$aide_code" -ge 14 ]; then pbs+=("AIDE en erreur (code $aide_code) sur la base du volume"); fi
			while read -r q p; do [ -n "$p" ] && pbs+=("$q : $(propre "$p")"); done < <(entrees "$aide_rapport")
		fi
		while IFS= read -r l; do [ -n "$l" ] && pbs+=("$l"); done < <(controle_bases; controle_ecrivains)
	else
		volume="non monté (non vérifié)"
	fi
	controle_images >"$tmp/images" # dans ce shell : image_etat est lu par ecrire_etat
	while IFS= read -r l; do [ -n "$l" ] && pbs+=("$l"); done <"$tmp/images"
	while IFS= read -r l; do [ -n "$l" ] && pbs+=("$l"); done < <(controle_conformite)
	if [ ${#pbs[@]} -eq 0 ]; then
		ecrire_etat ok "$volume"
		echo "intégrité : rien de changé (base $(empreinte))"
		return 0
	fi
	n_ecarts=${#pbs[@]}
	ecrire_etat alerte "$volume"
	local texte="Contrôle d'intégrité de la nuit (deploy/integrite.sh) : ${#pbs[@]} différence(s) avec l'empreinte du serveur sain.
NE RIEN TOUCHER, NE PAS REDÉMARRER : suivre README, « Que faire si une alerte d'intégrité arrive ».

En cause (chemins et contrôles seulement, jamais de contenu) :"
	for l in "${pbs[@]:0:200}"; do texte+=$'\n'"- $l"; done
	if [ ${#pbs[@]} -gt 200 ]; then texte+=$'\n'"- … et $((${#pbs[@]} - 200)) autre(s) (liste complète : sudo deploy/integrite.sh verifier)"; fi
	texte+="

Base d'intégrité : $(empreinte) (inchangée ; elle doit être celle du dernier e-mail « Intégrité : base » reçu)
Volume chiffré : $volume
Si c'est vous (modification voulue) : sudo deploy/integrite.sh refaire \"raison\""
	printf '%s\n' "$texte"
	courriel_envoyer URGENT integrite "$texte" "Shhgone URGENT intégrité : ${#pbs[@]} différence(s)" || true
	return 0
}

case $cmd in
verifier)
	[ $# -eq 0 ] || usage
	verifier
	;;
refaire)
	[ $# -le 1 ] || usage
	refaire "${1:-}"
	;;
empreinte)
	[ $# -eq 0 ] || usage
	installee || die "aucune base d'intégrité"
	empreinte
	;;
*) usage ;;
esac

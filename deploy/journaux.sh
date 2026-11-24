#!/usr/bin/env bash
# Contrôles des journaux de la machine (README §1 ; inventaire des adresses IP du 22 novembre) :
# aucune adresse IP écrite sur le disque, et aucune gardée en mémoire plus d'une heure par les
# journaux. Fichier chargé par deploy.sh (preflight), qui refuse d'installer si un contrôle
# échoue ; banc d'essai : deploy/test-journaux.sh (make lint-deploy).
#
#   controle_journaux <racine> <sortie de « sshd -T », ou « absent »>
#
# <racine> préfixe tous les chemins lus ("" sur le serveur ; un dossier factice dans les essais).
# Écrit un problème par ligne, avec ce qu'il faut faire, et rend 1 s'il y en a ; rien et 0 sinon.
# Ne change rien sur la machine.

# duree_s <durée systemd> : la durée en secondes (« 1h », « 30min », « 3600 », « 1h 30min »,
# « 900s ») ; rend 1 pour une unité inconnue ou une valeur vide.
duree_s() {
	local reste=$1 total=0 n u
	reste=${reste// /}
	[ -n "$reste" ] || return 1
	while [ -n "$reste" ]; do
		[[ $reste =~ ^([0-9]+)([a-z]*)(.*)$ ]] || return 1
		n=$((10#${BASH_REMATCH[1]})) u=${BASH_REMATCH[2]} reste=${BASH_REMATCH[3]}
		case $u in
		'' | s | sec | second | seconds) ;;
		m | min | minute | minutes) n=$((n * 60)) ;;
		h | hr | hour | hours) n=$((n * 3600)) ;;
		d | day | days) n=$((n * 86400)) ;;
		*) return 1 ;;
		esac
		total=$((total + n))
	done
	printf '%s\n' "$total"
}

# journald_valeur <racine> <clé> : dernière valeur de la clé dans journald.conf puis dans ses
# fichiers complémentaires (/usr/lib, /run, /etc : journald.conf.d/*.conf, dans l'ordre de leur
# nom, celui de /etc l'emportant à nom égal), comme systemd les lit ; vide si absente.
journald_valeur() {
	local r=$1 cle=$2 f nom ligne v=
	local -A choisi=()
	local fichiers=("$r/etc/systemd/journald.conf")
	for f in "$r"/usr/lib/systemd/journald.conf.d/*.conf "$r"/run/systemd/journald.conf.d/*.conf \
		"$r"/etc/systemd/journald.conf.d/*.conf; do
		[ -f "$f" ] || continue
		choisi[${f##*/}]=$f
	done
	while IFS= read -r nom; do
		[ -n "$nom" ] && fichiers+=("${choisi[$nom]}")
	done < <(printf '%s\n' "${!choisi[@]}" | LC_ALL=C sort)
	for f in "${fichiers[@]}"; do
		[ -f "$f" ] || continue
		while IFS= read -r ligne || [ -n "$ligne" ]; do
			[[ $ligne =~ ^[[:space:]]*${cle}[[:space:]]*=[[:space:]]*(.*[^[:space:]])?[[:space:]]*$ ]] &&
				v=${BASH_REMATCH[1]}
		done <"$f"
	done
	printf '%s\n' "$v"
}

controle_journaux() {
	local r=$1 sshd_t=$2 pb=() f v s max_s
	# 1. Aucun démon syslog : sur Ubuntu, rsyslog écrit /var/log/auth.log (adresses des
	#    connexions SSH), kern.log et ufw.log sur le disque, quel que soit le réglage de journald.
	for f in usr/sbin/rsyslogd usr/sbin/syslog-ng; do
		[ -e "$r/$f" ] &&
			pb+=("/$f présent : démon syslog qui écrit des adresses IP sur le disque (/var/log/auth.log) ; apt purge rsyslog (ou syslog-ng), puis effacer les anciens journaux (README §1)")
	done
	# 2. Anciens journaux texte ou persistants restés sur le disque.
	for f in "$r"/var/log/auth.log* "$r"/var/log/syslog* "$r"/var/log/kern.log* "$r"/var/log/ufw.log* \
		"$r"/var/log/messages*; do
		[ -e "$f" ] && pb+=("${f#"$r"} présent : ancien journal texte (adresses IP) ; l'effacer (README §1)")
	done
	if compgen -G "$r/var/log/journal/*/*.journal*" >/dev/null; then
		pb+=("/var/log/journal contient des journaux persistants : Storage=volatile, systemctl restart systemd-journald, puis rm -rf /var/log/journal/* (README §1)")
	fi
	# 3. journald en mémoire seulement, entrées gardées une heure au plus.
	v=$(journald_valeur "$r" Storage)
	[ "$v" = volatile ] || [ "$v" = none ] ||
		pb+=("journald : Storage=${v:-<absent>} ; poser Storage=volatile (journald.conf, README §1)")
	for f in MaxRetentionSec MaxFileSec; do
		v=$(journald_valeur "$r" "$f")
		if ! s=$(duree_s "$v") || [ "$s" -eq 0 ] || [ "$s" -gt 3600 ]; then
			max_s=1h
			[ "$f" = MaxFileSec ] && max_s=15min
			pb+=("journald : $f=${v:-<absent>} ; poser $f=$max_s (une heure au plus, README §1)")
		fi
	done
	# 4. sshd silencieux : ni adresse des connexions, ni refus, dans le journal.
	if [ "$sshd_t" != absent ]; then
		# OpenSSH 10 affiche « silent », autre nom de QUIET (Ubuntu 26.04).
		grep -qixE 'loglevel (quiet|silent)' <<<"$sshd_t" ||
			pb+=("sshd : LogLevel n'est pas QUIET (sshd -T) ; poser LogLevel QUIET dans /etc/ssh/sshd_config.d/10-shhdrop.conf, puis sshd -t && systemctl reload ssh (README §1)")
		# Mot de passe ou clavier : PAM écrirait l'adresse (rhost=) à chaque échec.
		for v in passwordauthentication kbdinteractiveauthentication; do
			grep -qix "$v no" <<<"$sshd_t" ||
				pb+=("sshd : $v n'est pas « no » (sshd -T) ; SSH par clé seulement (README §1)")
		done
	fi
	# 5. Pare-feu sans journal des paquets refusés (ufw logging off).
	if [ -e "$r/usr/sbin/ufw" ]; then
		v=
		if [ -f "$r/etc/ufw/ufw.conf" ]; then
			v=$(sed -nE 's/^[[:space:]]*LOGLEVEL[[:space:]]*=[[:space:]]*([a-z]+)[[:space:]]*$/\1/p' "$r/etc/ufw/ufw.conf" | tail -n 1)
		fi
		[ "$v" = off ] || pb+=("ufw : journal des paquets ${v:-<réglage absent>} (adresses IP dans le journal du noyau) ; ufw logging off (README §1)")
	fi
	# 6. Suivi des connexions du pare-feu : adresses des deux bouts gardées 5 jours par défaut.
	f=$r/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established
	if [ -r "$f" ]; then
		v=$(cat "$f")
		[[ $v =~ ^[0-9]+$ ]] && [ "$v" -le 1800 ] ||
			pb+=("nf_conntrack_tcp_timeout_established = $v s (adresses gardées en mémoire) ; le ramener à 1800 (/etc/sysctl.d/, README §1)")
	fi
	# 7. Registres des connexions, hors journaux (IP5) : sshd écrit lui-même l'adresse de chaque
	#    connexion dans wtmp et lastlog, de chaque échec dans btmp, quel que soit LogLevel
	#    (Ubuntu 24.04) ; ils doivent être des liens vers /dev/null (ou absents).
	for f in var/log/wtmp var/log/btmp var/log/lastlog; do
		if [ -L "$r/$f" ]; then
			[ "$(readlink "$r/$f")" = /dev/null ] ||
				pb+=("/$f : lien vers $(readlink "$r/$f") ; lien vers /dev/null attendu (tmpfiles 00-shhdrop-connexions.conf, README §1)")
		elif [ -e "$r/$f" ]; then
			pb+=("/$f : fichier sur le disque (sshd y écrit l'adresse des connexions) ; le remplacer par un lien vers /dev/null (tmpfiles 00-shhdrop-connexions.conf, README §1)")
		fi
	done
	#    Ubuntu 26.04 : wtmpdb et lastlog2, écrits par PAM (pam_wtmpdb, pam_lastlog2).
	for f in var/lib/wtmpdb/wtmp.db var/lib/lastlog/lastlog2.db; do
		[ -f "$r/$f" ] && [ ! -L "$r/$f" ] && [ -s "$r/$f" ] &&
			pb+=("/$f : base non vide (adresses des connexions) ; pam-auth-update --disable wtmpdb lastlog2, systemctl mask wtmpdb-update-boot.service, puis l'effacer (README §1)")
	done
	for f in etc/pam.d/sshd etc/pam.d/common-session etc/pam.d/common-session-noninteractive; do
		[ -f "$r/$f" ] || continue
		for v in pam_lastlog pam_lastlog2 pam_wtmpdb; do
			grep -Eq "^[[:space:]]*[^#[:space:]].*[[:space:]/]$v\.so([[:space:]]|\$)" "$r/$f" &&
				pb+=("/$f : $v actif (écrit l'adresse des connexions) ; retirer la ligne, ou pam-auth-update --disable wtmpdb lastlog2 (README §1)")
		done
	done
	for f in etc/logrotate.d/wtmp etc/logrotate.d/btmp; do
		[ -e "$r/$f" ] &&
			pb+=("/$f présent : logrotate recréerait un fichier à la place du lien vers /dev/null ; l'effacer (README §1)")
	done
	# 8. Purge du journal en mémoire tous les quarts d'heure (IP6 ; journald n'applique
	#    MaxRetentionSec qu'en écrivant).
	f=$r/etc/systemd/system/timers.target.wants/shhdrop-journal.timer
	[ -L "$f" ] || [ -e "$f" ] ||
		pb+=("minuteur shhdrop-journal.timer non activé ; l'installer depuis deploy/systemd/, puis systemctl enable --now shhdrop-journal.timer (README §1)")
	[ ${#pb[@]} -eq 0 ] && return 0
	printf '%s\n' "${pb[@]}"
	return 1
}

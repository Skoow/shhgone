#!/usr/bin/env bash
# Banc d'essai de deploy/journaux.sh (make lint-deploy, job deploy-lint) : une machine factice
# (dossier temporaire) est réglée comme le demande le README §1, puis chaque réglage est cassé à
# son tour ; controle_journaux doit refuser, avec un message qui dit quoi faire. Aucun accès à
# la vraie machine.
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/journaux.sh
. "$here/journaux.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}

SSHD_BON=$'port 22\nloglevel QUIET\npasswordauthentication no\nkbdinteractiveauthentication no'

# machine <nom> : machine factice conforme au README §1, dans $work/<nom>.
machine() {
	local r=$work/$1
	mkdir -p "$r/usr/sbin" "$r/etc/systemd" "$r/etc/ufw" "$r/proc/sys/net/netfilter" "$r/var/log/journal"
	printf '[Journal]\n#Storage=auto\nStorage=volatile\nMaxRetentionSec=1h\nMaxFileSec=15min\n' >"$r/etc/systemd/journald.conf"
	: >"$r/usr/sbin/ufw"
	printf 'ENABLED=yes\nLOGLEVEL=off\n' >"$r/etc/ufw/ufw.conf"
	echo 1800 >"$r/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established"
	# Registres des connexions : liens vers /dev/null ; PAM d'Ubuntu 24.04 sans pam_lastlog
	# (ligne commentée), minuteur de purge activé.
	mkdir -p "$r/etc/pam.d" "$r/etc/logrotate.d" "$r/etc/systemd/system/timers.target.wants"
	ln -s /dev/null "$r/var/log/wtmp"
	ln -s /dev/null "$r/var/log/btmp"
	ln -s /dev/null "$r/var/log/lastlog"
	printf '@include common-auth\naccount required pam_nologin.so\n# session optional pam_lastlog.so\nsession optional pam_motd.so motd=/run/motd.dynamic\n@include common-session\n' >"$r/etc/pam.d/sshd"
	printf 'session [default=1] pam_permit.so\nsession required pam_unix.so\nsession optional pam_systemd.so\n' >"$r/etc/pam.d/common-session"
	printf '[Unit]\n' >"$r/etc/logrotate.d/apt"
	ln -s /etc/systemd/system/shhdrop-journal.timer "$r/etc/systemd/system/timers.target.wants/shhdrop-journal.timer"
	printf '%s\n' "$r"
}

# refuse <essai> <racine> <sortie sshd -T> <motif attendu dans le message>
refuse() {
	local out
	if out=$(controle_journaux "$2" "$3"); then
		ko "$1 : accepté"
	elif ! grep -q -- "$4" <<<"$out"; then
		ko "$1 : message sans « $4 » : $out"
	fi
}
accepte() {
	local out
	out=$(controle_journaux "$2" "$3") || ko "$1 : refusé : $out"
}

# Durées systemd.
for cas in "1h=3600" "60min=3600" "15min=900" "3600=3600" "900s=900" "1h 30min=5400" "2d=172800"; do
	[ "$(duree_s "${cas%=*}")" = "${cas#*=}" ] || ko "duree_s ${cas%=*}"
done
for cas in "" "1y" "abc" "1h-"; do
	if duree_s "$cas" >/dev/null; then ko "duree_s « $cas » acceptée"; fi
done

# Machine conforme : acceptée ; sans sshd, sans ufw, sans conntrack : acceptée aussi.
r=$(machine bon)
accepte "machine conforme" "$r" "$SSHD_BON"
r=$(machine sans-outils)
rm -f "$r/usr/sbin/ufw" "$r/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established"
accepte "sans sshd ni ufw ni conntrack" "$r" absent
# Storage=none : rien n'est gardé, accepté.
r=$(machine none)
sed -i 's/^Storage=volatile/Storage=none/' "$r/etc/systemd/journald.conf"
accepte "Storage=none" "$r" "$SSHD_BON"

# 1. rsyslog (Ubuntu : installé par défaut) ou syslog-ng.
r=$(machine rsyslog)
: >"$r/usr/sbin/rsyslogd"
refuse "rsyslog installé" "$r" "$SSHD_BON" "apt purge rsyslog"
r=$(machine syslog-ng)
: >"$r/usr/sbin/syslog-ng"
refuse "syslog-ng installé" "$r" "$SSHD_BON" "syslog-ng"
# 2. Anciens journaux restés sur le disque.
r=$(machine auth-log)
: >"$r/var/log/auth.log.1"
refuse "ancien auth.log" "$r" "$SSHD_BON" "/var/log/auth.log.1 présent"
r=$(machine persistant)
mkdir -p "$r/var/log/journal/0123abcd"
: >"$r/var/log/journal/0123abcd/system.journal"
refuse "journal persistant" "$r" "$SSHD_BON" "rm -rf /var/log/journal"

# 3. journald.
r=$(machine storage-auto)
sed -i '/^Storage=/d' "$r/etc/systemd/journald.conf"
refuse "Storage absent" "$r" "$SSHD_BON" "Storage=<absent> ; poser Storage=volatile"
r=$(machine storage-persistent)
mkdir -p "$r/etc/systemd/journald.conf.d"
printf '[Journal]\nStorage=persistent\n' >"$r/etc/systemd/journald.conf.d/10-autre.conf"
refuse "Storage=persistent en complément" "$r" "$SSHD_BON" "Storage=persistent"
# Le complément l'emporte sur journald.conf, et /etc sur /usr/lib à nom égal.
r=$(machine complement)
sed -i '/^Storage=/d;/^MaxRetentionSec=/d' "$r/etc/systemd/journald.conf"
mkdir -p "$r/etc/systemd/journald.conf.d" "$r/usr/lib/systemd/journald.conf.d"
printf '[Journal]\nStorage=persistent\nMaxRetentionSec=1month\n' >"$r/usr/lib/systemd/journald.conf.d/60-shhdrop.conf"
printf '[Journal]\nStorage=volatile\nMaxRetentionSec=30min\n' >"$r/etc/systemd/journald.conf.d/60-shhdrop.conf"
accepte "complément de /etc" "$r" "$SSHD_BON"
r=$(machine retention-absente)
sed -i '/^MaxRetentionSec=/d' "$r/etc/systemd/journald.conf"
refuse "MaxRetentionSec absent" "$r" "$SSHD_BON" "poser MaxRetentionSec=1h"
r=$(machine retention-longue)
sed -i 's/^MaxRetentionSec=.*/MaxRetentionSec=2h/' "$r/etc/systemd/journald.conf"
refuse "MaxRetentionSec=2h" "$r" "$SSHD_BON" "MaxRetentionSec=2h"
r=$(machine retention-zero)
sed -i 's/^MaxRetentionSec=.*/MaxRetentionSec=0/' "$r/etc/systemd/journald.conf"
refuse "MaxRetentionSec=0 (sans limite)" "$r" "$SSHD_BON" "MaxRetentionSec=0"
r=$(machine fichier-long)
sed -i '/^MaxFileSec=/d' "$r/etc/systemd/journald.conf"
refuse "MaxFileSec absent (1 mois)" "$r" "$SSHD_BON" "poser MaxFileSec=15min"

# 4. sshd.
r=$(machine sshd)
refuse "sshd LogLevel INFO" "$r" "${SSHD_BON/loglevel QUIET/loglevel INFO}" "LogLevel QUIET"
refuse "sshd sans sortie (sshd -T échoue)" "$r" "" "LogLevel QUIET"
refuse "sshd mot de passe" "$r" "${SSHD_BON/passwordauthentication no/passwordauthentication yes}" "passwordauthentication"
refuse "sshd clavier" "$r" "${SSHD_BON/kbdinteractiveauthentication no/kbdinteractiveauthentication yes}" "kbdinteractiveauthentication"

# 5. ufw.
r=$(machine ufw-low)
sed -i 's/^LOGLEVEL=off/LOGLEVEL=low/' "$r/etc/ufw/ufw.conf"
refuse "ufw logging low" "$r" "$SSHD_BON" "ufw logging off"
r=$(machine ufw-sans-conf)
rm "$r/etc/ufw/ufw.conf"
refuse "ufw sans ufw.conf" "$r" "$SSHD_BON" "ufw logging off"

# 6. conntrack (refus, plus un avertissement).
r=$(machine conntrack)
echo 432000 >"$r/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established"
refuse "conntrack 5 jours" "$r" "$SSHD_BON" "le ramener à 1800"

# 7. Registres des connexions (IP5). Ubuntu 24.04 : wtmp, btmp, lastlog écrits par sshd.
for f in wtmp btmp lastlog; do
	r=$(machine "registre-$f")
	rm "$r/var/log/$f"
	: >"$r/var/log/$f" # même vide : sshd y écrira
	refuse "/var/log/$f fichier" "$r" "$SSHD_BON" "/var/log/$f : fichier sur le disque"
	r=$(machine "registre-$f-lien")
	ln -sfn ../autre "$r/var/log/$f"
	refuse "/var/log/$f lien ailleurs" "$r" "$SSHD_BON" "lien vers /dev/null attendu"
	r=$(machine "registre-$f-absent")
	rm "$r/var/log/$f"
	accepte "/var/log/$f absent" "$r" "$SSHD_BON"
done
for f in wtmp btmp; do
	r=$(machine "logrotate-$f")
	: >"$r/etc/logrotate.d/$f"
	refuse "règle logrotate $f" "$r" "$SSHD_BON" "/etc/logrotate.d/$f présent"
done
# Ubuntu 26.04 : wtmpdb et lastlog2, écrits par PAM.
r=$(machine wtmpdb)
mkdir -p "$r/var/lib/wtmpdb" "$r/var/lib/lastlog"
: >"$r/var/lib/wtmpdb/wtmp.db"
: >"$r/var/lib/lastlog/lastlog2.db"
accepte "bases vides" "$r" "$SSHD_BON"
echo SQLite >"$r/var/lib/wtmpdb/wtmp.db"
refuse "wtmp.db non vide" "$r" "$SSHD_BON" "/var/lib/wtmpdb/wtmp.db : base non vide"
r=$(machine lastlog2)
mkdir -p "$r/var/lib/lastlog"
echo SQLite >"$r/var/lib/lastlog/lastlog2.db"
refuse "lastlog2.db non vide" "$r" "$SSHD_BON" "lastlog2.db : base non vide"
for cas in "sshd:session optional pam_lastlog.so:pam_lastlog actif" \
	"common-session:session optional			pam_wtmpdb.so skip_if=sshd:pam_wtmpdb actif" \
	"common-session:-session optional pam_lastlog2.so:pam_lastlog2 actif" \
	"common-session-noninteractive:session optional /usr/lib/security/pam_lastlog2.so:pam_lastlog2 actif"; do
	IFS=: read -r fichier ligne motif <<<"$cas"
	r=$(machine "pam-$fichier-${motif%% *}")
	printf '%s\n' "$ligne" >>"$r/etc/pam.d/$fichier"
	refuse "PAM $fichier : $ligne" "$r" "$SSHD_BON" "/etc/pam.d/$fichier : $motif"
done
r=$(machine pam-commente)
printf '#session optional pam_wtmpdb.so\n  # session optional pam_lastlog2.so\nsession optional pam_lastlogx.so\n' >>"$r/etc/pam.d/common-session"
accepte "PAM : modules commentés ou autre nom" "$r" "$SSHD_BON"

# 8. Minuteur de purge du journal (IP6).
r=$(machine minuteur)
rm "$r/etc/systemd/system/timers.target.wants/shhdrop-journal.timer"
refuse "minuteur non activé" "$r" "$SSHD_BON" "shhdrop-journal.timer non activé"

# Plusieurs problèmes : tous dits d'un coup.
r=$(machine tout)
: >"$r/usr/sbin/rsyslogd"
echo 432000 >"$r/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established"
if out=$(controle_journaux "$r" absent); then ko "tout : accepté"; fi
[ "$(wc -l <<<"$out")" = 2 ] || ko "tout : deux problèmes attendus : $out"

if [ "$echec" = 0 ]; then echo "test-journaux : tous les contrôles passent"; fi
exit "$echec"

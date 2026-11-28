#!/usr/bin/env bash
# Installe et tient à jour la surveillance de la machine (README, « Intégrité du serveur ») ;
# lancé en root par deploy.sh et preprod.sh (commun.sh, preflight), à chaque installation, sans
# rien à taper ni aucun secret. Idempotent : ne change que ce qui diffère, et le dit.
#
#   1. AIDE (paquet Debian, sans ses recommandations) ; le contrôle quotidien d'aide-common, s'il
#      est là, est masqué (il couvrirait tout /etc avec sa propre base : doublon bruyant) ;
#   2. unités systemd de deploy/systemd : alerte (toutes les 15 min), purge du journal (tous les
#      quarts d'heure), intégrité (chaque nuit), avec le chemin de cette copie du dépôt ;
#   3. alerte à chaque connexion SSH : ligne pam_exec « optional » dans /etc/pam.d/sshd, et
#      « user_readenv=1 » retiré (l'environnement d'un compte ne doit pas atteindre un
#      programme lancé en root par PAM) ;
#   4. SFTP et scp coupés : ligne « Subsystem sftp » mise en commentaire dans la configuration de
#      sshd, après « sshd -t » (sinon remise telle quelle), puis rechargement de sshd (les
#      sessions ouvertes ne sont pas coupées ; la connexion SSH par clé et les tunnels -L restent).
#
# Code 0 : tout est en place ; 1 : un point n'a pas pu être posé (dit sur la sortie d'erreur) :
# deploy.sh continue (une panne du miroir Debian ne doit pas bloquer un correctif), l'intégrité
# de la nuit et le bilan du lundi le disent.
#
# Essais (deploy/test-integrite.sh) : SHH_SURV_RACINE (préfixe des fichiers de /etc),
# SHH_SURV_SYSTEMCTL, SHH_SURV_SSHD, SHH_SURV_APT, SHH_SURV_AIDE (commandes de remplacement).
set -uo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
depot=$(cd "$here/.." && pwd)
r=${SHH_SURV_RACINE:-}
systemctl_=${SHH_SURV_SYSTEMCTL:-systemctl}
sshd_=${SHH_SURV_SSHD:-$(command -v sshd || echo /usr/sbin/sshd)}
apt_=${SHH_SURV_APT:-apt-get}
aide_=${SHH_SURV_AIDE:-aide}
ko=0
pb() {
	printf 'surveillance : %s\n' "$*" >&2
	ko=1
}

# 1. AIDE.
if ! command -v "$aide_" >/dev/null 2>&1; then
	echo "surveillance : installation d'AIDE (paquet aide)"
	DEBIAN_FRONTEND=noninteractive "$apt_" install -y --no-install-recommends aide >/dev/null ||
		pb "AIDE non installé (apt-get install aide) : l'intégrité ne sera pas vérifiée"
fi
# Outils du bilan du lundi (alerte.sh) : jq (réponses de l'API de GitHub), dig (DNSSEC, CAA,
# SPF, DKIM, DMARC). Paquets Debian.
manque=()
command -v jq >/dev/null 2>&1 || manque+=(jq)
command -v dig >/dev/null 2>&1 || manque+=(bind9-dnsutils)
if [ ${#manque[@]} -gt 0 ]; then
	echo "surveillance : installation de ${manque[*]} (bilan du lundi)"
	DEBIAN_FRONTEND=noninteractive "$apt_" install -y --no-install-recommends "${manque[@]}" >/dev/null ||
		pb "${manque[*]} non installé(s) : le bilan du lundi le dira"
fi
for u in dailyaidecheck.timer dailyaidecheck.service; do
	if [ -e "$r/lib/systemd/system/$u" ] || [ -e "$r/usr/lib/systemd/system/$u" ]; then
		[ -L "$r/etc/systemd/system/$u" ] || "$systemctl_" mask --now "$u" >/dev/null 2>&1 || true
	fi
done

# 2. Unités systemd (chemin de cette copie du dépôt).
recharger=0
actives=()
for u in shhdrop-alerte.service shhdrop-alerte.timer shhdrop-journal.service shhdrop-journal.timer \
	shhdrop-integrite.service shhdrop-integrite.timer; do
	neuf=$(sed "s#/opt/shhdrop/#$depot/#g" "$here/systemd/$u") || {
		pb "deploy/systemd/$u illisible"
		continue
	}
	f=$r/etc/systemd/system/$u
	if [ "$(cat "$f" 2>/dev/null)" != "$neuf" ]; then
		if mkdir -p "${f%/*}" && printf '%s\n' "$neuf" >"$f.neuf" && chmod 0644 "$f.neuf" && mv -f "$f.neuf" "$f"; then
			echo "surveillance : unité $u posée"
			recharger=1
		else
			pb "$u : écriture impossible"
		fi
	fi
	case $u in *.timer) actives+=("$u") ;; esac
done
if [ "$recharger" = 1 ]; then "$systemctl_" daemon-reload || pb "systemctl daemon-reload"; fi
for u in "${actives[@]}"; do
	"$systemctl_" is-enabled --quiet "$u" 2>/dev/null && "$systemctl_" is-active --quiet "$u" 2>/dev/null && continue
	if "$systemctl_" enable --now "$u" >/dev/null 2>&1; then
		echo "surveillance : minuteur $u activé"
	else
		pb "$u : activation impossible"
	fi
done

# 3. PAM : alerte de connexion SSH.
pam=$r/etc/pam.d/sshd
ligne="session optional pam_exec.so quiet type=open_session /bin/bash -p $depot/deploy/ssh-connexion.sh"
if [ -f "$pam" ]; then
	avant=$(cat "$pam")
	apres=$(grep -vE 'ssh-connexion\.sh|^# Alerte de connexion SSH \(Shhdrop' "$pam" | sed -E 's/[[:space:]]+user_readenv=1([[:space:]]|$)/\1/')
	apres+=$'\n'"# Alerte de connexion SSH (Shhdrop, deploy/installer-surveillance.sh) : optional, ne bloque jamais."$'\n'"$ligne"
	if [ "$avant" != "$apres" ]; then
		if printf '%s\n' "$apres" >"$pam.neuf" && chmod --reference="$pam" "$pam.neuf" && mv -f "$pam.neuf" "$pam"; then
			echo "surveillance : alerte de connexion SSH posée dans /etc/pam.d/sshd"
		else
			pb "/etc/pam.d/sshd : écriture impossible"
		fi
	fi
else
	pb "/etc/pam.d/sshd absent : alerte de connexion SSH non posée"
fi

# 4. SFTP coupé.
sauve=$(mktemp -d)
trap 'rm -rf -- "$sauve"' EXIT
change=0
for f in "$r/etc/ssh/sshd_config" "$r"/etc/ssh/sshd_config.d/*.conf; do
	[ -f "$f" ] || continue
	grep -qiE '^[[:space:]]*Subsystem[[:space:]]+sftp([[:space:]]|$)' "$f" || continue
	n=$(printf '%s' "$f" | sha256sum | cut -c1-16)
	cp -p "$f" "$sauve/$n" && printf '%s\n' "$f" >>"$sauve/liste"
	sed -i -E 's/^([[:space:]]*[Ss][Uu][Bb][Ss][Yy][Ss][Tt][Ee][Mm][[:space:]]+sftp([[:space:]].*)?)$/# Retiré par Shhdrop (SFTP et scp coupés, README « Intégrité du serveur ») : \1/' "$f"
	change=1
done
if [ "$change" = 1 ]; then
	if "$sshd_" -t >/dev/null 2>&1; then
		"$systemctl_" try-reload-or-restart ssh.service >/dev/null 2>&1 ||
			"$systemctl_" try-reload-or-restart sshd.service >/dev/null 2>&1 || true
		echo "surveillance : SFTP et scp coupés (Subsystem sftp retiré de la configuration de sshd)"
	else
		while IFS= read -r f; do
			cp -p "$sauve/$(printf '%s' "$f" | sha256sum | cut -c1-16)" "$f"
		done <"$sauve/liste"
		pb "sshd -t refuse la configuration sans SFTP : remise telle quelle, SFTP reste ouvert"
	fi
fi
exit "$ko"

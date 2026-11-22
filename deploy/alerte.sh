#!/usr/bin/env bash
# Alerte de l'exploitant (spec §15.2 ; README §4), lancée toutes les 15 min par
# systemd/shhdrop-alerte.timer. Envoie un e-mail, au plus un par heure et par sujet, quand :
#   - les signalements s'accumulent (reports_alert de /healthz : au moins 5 dans l'heure) ;
#   - le disque des données dépasse 80 % ;
#   - le serveur ne répond pas à son contrôle de santé.
# Aucune donnée d'utilisateur : l'e-mail ne contient que le sujet et un pourcentage.
#
# Réglages, dans deploy/.env :
#   SHH_ALERTE_A     adresse qui reçoit les alertes (par exemple contact@shhgone.com)
#   SHH_SMTP_HOST, SHH_SMTP_USER, SHH_MAIL_FROM : ceux du compte (README §12) ; mot de passe
#                    dans $SHH_DATA_ROOT/secrets/shh_smtp_mdp (jamais une variable)
#   SHH_DATA_ROOT    racine du volume chiffré (défaut /srv/shhdrop)
# Sans SHH_ALERTE_A : rien n'est envoyé, le constat est écrit sur la sortie (journald en mémoire).
# Essais : SHH_ENV_FILE (autre fichier de réglages), SHH_ALERTE_SANTE (commande de santé),
# SHH_ALERTE_ETAT (dossier des dates d'envoi, défaut /run/shhdrop-alerte : en mémoire).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
die() { printf 'alerte : %s\n' "$*" >&2; exit 1; }
env_file=${SHH_ENV_FILE:-$here/.env}
[ -f "$env_file" ] || die "$env_file absent"
# shellcheck disable=SC1090
. "$env_file"
root=${SHH_DATA_ROOT:-/srv/shhdrop}
etat=${SHH_ALERTE_ETAT:-/run/shhdrop-alerte}
mkdir -p "$etat" && chmod 0700 "$etat"

envoyer() { # $1 : sujet court (nom de fichier d'état), $2 : texte
	local cle=$1 texte=$2 now last=0
	now=$(date +%s)
	[ -f "$etat/$cle" ] && last=$(cat "$etat/$cle")
	if [ $((now - last)) -lt 3600 ]; then return 0; fi
	printf '%s\n' "$now" >"$etat/$cle"
	printf 'ALERTE %s : %s\n' "$cle" "$texte"
	[ -n "${SHH_ALERTE_A:-}" ] || return 0
	[ -n "${SHH_SMTP_HOST:-}" ] && [ -n "${SHH_SMTP_USER:-}" ] && [ -n "${SHH_MAIL_FROM:-}" ] ||
		die "SHH_ALERTE_A sans SHH_SMTP_HOST, SHH_SMTP_USER et SHH_MAIL_FROM"
	local mdp="$root/secrets/shh_smtp_mdp" de
	[ -r "$mdp" ] || die "$mdp illisible"
	de=$(printf '%s' "$SHH_MAIL_FROM" | sed -n 's/.*<\(.*\)>.*/\1/p')
	[ -n "$de" ] || de=$SHH_MAIL_FROM
	# Mot de passe lu par curl depuis un fichier de configuration (jamais sur la ligne de commande).
	{
		printf 'From: %s\r\nTo: %s\r\nSubject: Shhgone : %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
			"$SHH_MAIL_FROM" "$SHH_ALERTE_A" "$cle" "$texte"
	} | curl -sS --fail --ssl-reqd --url "smtps://$SHH_SMTP_HOST:465" \
		--mail-from "$de" --mail-rcpt "$SHH_ALERTE_A" --upload-file - \
		-K <(printf 'user = "%s:%s"\n' "$SHH_SMTP_USER" "$(cat "$mdp")") >/dev/null
}

sante=$(${SHH_ALERTE_SANTE:-"$here/deploy.sh" health} 2>/dev/null) || sante=""
if [ -z "$sante" ] || ! printf '%s' "$sante" | grep -q '"ok":true'; then
	envoyer serveur "le serveur ne répond pas à son contrôle de santé (deploy/deploy.sh status ; diagnose)"
elif printf '%s' "$sante" | grep -q '"reports_alert":true'; then
	envoyer signalements "au moins 5 signalements dans l'heure : tableau de bord ou contact@ à regarder"
fi
if [ -d "$root" ]; then
	pct=$(df --output=pcent "$root" | tail -1 | tr -dc '0-9')
	if [ -n "$pct" ] && [ "$pct" -ge 80 ]; then envoyer disque "disque des données plein à $pct %"; fi
fi

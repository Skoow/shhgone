#!/bin/bash -p
# Alerte à chaque connexion SSH (décision du propriétaire du 28 novembre ; README, « Intégrité
# du serveur »). Lancé par PAM à l'ouverture de chaque session SSH, ligne posée dans
# /etc/pam.d/sshd par installer-surveillance.sh (deploy.sh) :
#
#   session optional pam_exec.so quiet type=open_session /bin/bash -p <dépôt>/deploy/ssh-connexion.sh
#
# Envoie aussitôt un e-mail : heure, compte, empreinte de la clé utilisée (SSH_AUTH_INFO_0, que
# sshd donne à PAM) et le commentaire de cette clé dans authorized_keys. JAMAIS l'adresse IP :
# PAM_RHOST, SSH_CONNECTION et SSH_CLIENT ne sont jamais lus. Note la connexion (heure, compte,
# empreinte ; aucune adresse) dans /var/lib/shhdrop-ssh/connexions pour le bilan du lundi
# (alerte.sh), 35 jours au plus.
#
# Ne bloque jamais la connexion : « optional » dans PAM, et le script rend la main tout de suite
# (l'envoi part en arrière-plan, détaché, 60 s au plus) ; une erreur ou un e-mail raté n'y change
# rien.
#
# « bash -p » : ni BASH_ENV, ni fonctions, ni SHELLOPTS venus de l'environnement de PAM ; puis
# l'envoi repart avec un environnement vidé (env -i) ne gardant que le compte et l'empreinte.
# Aucune variable d'essai n'est lue : test-ssh-connexion.sh lance une copie de ce script, à côté
# d'un faux courriel.sh.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd) || exit 0

if [ "${1:-}" != --envoyer ]; then
	[ "${PAM_TYPE:-}" = open_session ] || exit 0
	# Compte : un nom de compte Unix, rien d'autre ; clé : la ligne « publickey <type> <clé> ».
	compte=${PAM_USER:-}
	[[ $compte =~ ^[a-z_][a-z0-9_.-]{0,31}$ ]] || compte=inconnu
	cle=""
	while IFS= read -r l; do
		if [ ${#l} -le 16384 ] && [[ $l =~ ^publickey\ ([a-z0-9@.-]+\ [A-Za-z0-9+/=]+)$ ]]; then
			cle=${BASH_REMATCH[1]}
			break
		fi
	done <<<"${SSH_AUTH_INFO_0:-}"
	env -i PATH="$PATH" LC_ALL=C SHH_SSH_COMPTE="$compte" SHH_SSH_CLE="$cle" \
		setsid /bin/bash -p "$here/ssh-connexion.sh" --envoyer </dev/null >/dev/null 2>&1 &
	exit 0
fi

# --- Envoi, détaché de la connexion -------------------------------------------------------------
set -u
umask 077
compte=${SHH_SSH_COMPTE:-inconnu}
cle=${SHH_SSH_CLE:-}
quand=$(date -u +%s)
heure=$(date -u -d "@$quand" '+%Y-%m-%d %H:%M:%S UTC')
empreinte="inconnue (connexion sans clé publique ?)"
nom_cle=""
if [ -n "$cle" ]; then
	e=$(printf '%s\n' "$cle" | ssh-keygen -l -f /dev/stdin 2>/dev/null | awk '{print $2}')
	[[ $e =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] && empreinte=$e
	# Commentaire de la clé dans authorized_keys du compte (nom donné par le propriétaire).
	maison=$(getent passwd "$compte" | cut -d: -f6)
	if [ -n "$maison" ] && [ -f "$maison/.ssh/authorized_keys" ]; then
		nom_cle=$(grep -F -- "${cle#* }" "$maison/.ssh/authorized_keys" 2>/dev/null | head -n 1 |
			awk -v k="${cle#* }" '{for (i = 1; i <= NF; i++) if ($i == k) {for (j = i + 1; j <= NF; j++) printf "%s%s", (j > i + 1 ? " " : ""), $j; exit}}' |
			tr -c '[:alnum:] @._-' '?' | cut -c1-64)
	fi
fi
machine=$(hostname 2>/dev/null || true)
machine=$(printf '%s' "$machine" | tr -c '[:alnum:].-' '?' | cut -c1-64)

# Registre de la semaine (aucune adresse) : 35 jours au plus.
registre=/var/lib/shhdrop-ssh/connexions
if mkdir -p "${registre%/*}" 2>/dev/null && chmod 0700 "${registre%/*}" 2>/dev/null; then
	(
		flock -w 10 9 || exit 0
		{
			awk -v lim=$((quand - 35 * 86400)) '$1 >= lim' "$registre" 2>/dev/null || true
			printf '%s %s %s\n' "$quand" "$compte" "${empreinte%% *}"
		} >"$registre.neuf" && mv -f "$registre.neuf" "$registre"
	) 9>"${registre%/*}/verrou" 2>/dev/null || true
fi

[ -f "$here/.env" ] || exit 0
# shellcheck source=deploy/lire-env.sh
. "$here/lire-env.sh" || exit 0
lire_env "$here/.env" 0 2>/dev/null || exit 0
# shellcheck source=deploy/courriel.sh
. "$here/courriel.sh" || exit 0
texte="Connexion SSH ouverte sur ${machine:-le serveur}.
Heure : $heure
Compte : $compte
Clé utilisée : $empreinte${nom_cle:+ ($nom_cle)}

Aucune adresse IP n'est lue, enregistrée ni envoyée.
Si ce n'est pas vous : README, « Que faire si une alerte d'intégrité arrive » (ne rien toucher, ne pas redémarrer)."
courriel_envoyer Connexion ssh "$texte" "Shhgone Connexion SSH : $compte, $heure" >/dev/null 2>&1 || true
exit 0

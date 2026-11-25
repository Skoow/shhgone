#!/usr/bin/env bash
# Jeton du tableau de bord d'administration (README §4) : le tire au hasard, met son EMPREINTE
# (SHA-256) et SHH_ADMIN_LISTEN dans deploy/.env, puis l'affiche UNE seule fois. Le jeton n'est
# écrit nulle part sur le serveur (seule l'empreinte l'est, dont on ne peut pas le retrouver).
# En root, dans SA PROPRE fenêtre SSH, jamais dans une session Claude :
#
#   sudo deploy/admin-jeton.sh               premier jeton
#   sudo deploy/admin-jeton.sh --remplacer   nouveau jeton (l'ancien ne marche plus)
#
# Refusé si l'entrée ou la sortie n'est pas un terminal (session Claude, tuyau, fichier). Après
# Entrée, l'écran et son historique de défilement sont effacés ; puis la commande exacte du
# tunnel SSH à lancer depuis Windows (PowerShell) est donnée, et la réinstallation qui active
# le tableau de bord est proposée.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here"
usage() {
	printf 'usage: admin-jeton.sh [--remplacer]\n' >&2
	exit 2
}
remplacer=0
case $# in
0) ;;
1)
	[ "$1" = --remplacer ] || usage
	remplacer=1
	;;
*) usage ;;
esac
if [ "$(id -u)" != 0 ]; then
	printf 'erreur: à lancer en root : sudo deploy/admin-jeton.sh\n' >&2
	exit 1
fi
if [ ! -t 0 ] || [ ! -t 1 ]; then
	printf 'erreur: le jeton est un secret : lancez cette commande vous-même, dans votre propre fenêtre SSH (jamais dans une session Claude, jamais vers un fichier ou un tuyau)\n' >&2
	exit 1
fi
# shellcheck disable=SC2034 # lue par commun.sh : le site n'est pas joint
jeton_preprod=sans
# shellcheck source=deploy/commun.sh
. ./commun.sh

readonly ADMIN_ECOUTE=172.30.53.2:9191
# shellcheck disable=SC2016 # lignes littérales de compose.yaml
if ! grep -qxF '      SHH_ADMIN_LISTEN: ${SHH_ADMIN_LISTEN:-}' compose.yaml ||
	! grep -qxF '      SHH_ADMIN_TOKEN_SHA256: ${SHH_ADMIN_TOKEN_SHA256:-}' compose.yaml; then
	die "compose.yaml ne transmet pas SHH_ADMIN_LISTEN et SHH_ADMIN_TOKEN_SHA256 au serveur (README §4)"
fi
if [ -n "${SHH_ADMIN_TOKEN_SHA256:-}" ] && [ "$remplacer" = 0 ]; then
	die "un jeton existe déjà (empreinte dans deploy/.env). Pour en changer : sudo deploy/admin-jeton.sh --remplacer (l'ancien ne marchera plus)"
fi
[ ! -L .env ] || die "deploy/.env est un lien symbolique : refusé"

jeton=$(od -An -v -N32 -tx1 /dev/urandom | tr -d ' \n')
[[ $jeton =~ ^[0-9a-f]{64}$ ]] || die "tirage du jeton impossible"
# printf est interne au shell : le jeton n'est l'argument d'aucune commande (ps).
empreinte=$(printf '%s' "$jeton" | sha256sum | cut -c1-64)
[[ $empreinte =~ ^[0-9a-f]{64}$ ]] || die "empreinte impossible"

# deploy/.env : les anciennes lignes du tableau de bord retirées (dont SHH_ADMIN_TOKEN, le jeton
# en clair, refusé en production), les deux nouvelles ajoutées ; même propriétaire et mêmes
# droits ; remplacé d'un coup.
if grep -qE '^[[:space:]]*(export[[:space:]]+)?SHH_ADMIN_TOKEN=' .env; then
	echo "deploy/.env : ancienne ligne SHH_ADMIN_TOKEN (jeton en clair) retirée."
fi
tmp=$(mktemp .env.XXXXXX)
trap 'rm -f -- "$tmp"' EXIT
grep -vE '^[[:space:]]*(export[[:space:]]+)?SHH_ADMIN_(LISTEN|TOKEN_SHA256|TOKEN)=' .env >"$tmp" || true
if [ -s "$tmp" ] && [ -n "$(tail -c1 -- "$tmp")" ]; then printf '\n' >>"$tmp"; fi
printf 'SHH_ADMIN_LISTEN=%s\nSHH_ADMIN_TOKEN_SHA256=%s\n' "$ADMIN_ECOUTE" "$empreinte" >>"$tmp"
chown --reference=.env -- "$tmp" && chmod --reference=.env -- "$tmp"
mv -fT -- "$tmp" .env
trap - EXIT

# Adresse de la machine pour le tunnel : celle de la connexion SSH en cours si elle est connue,
# sinon l'adresse publique de la machine, sinon le nom du site.
hote=
if [ -n "${SSH_CONNECTION:-}" ]; then
	read -r _ _ hote _ <<<"$SSH_CONNECTION"
fi
if [ -z "$hote" ]; then
	hote=$(ip -4 -o route get 192.0.2.1 2>/dev/null | sed -nE 's/.* src ([0-9.]+).*/\1/p') || hote=
	case $hote in 10.* | 127.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | "") hote=$SHH_DOMAIN ;; esac
fi
compte=${SUDO_USER:-$(id -un)}

printf '\nJeton du tableau de bord (affiché une seule fois, gardé nulle part sur le serveur) :\n\n'
printf '  %s\n\n' "$jeton"
jeton=
printf 'Rangez-le maintenant dans votre gestionnaire de mots de passe (site 127.0.0.1,\n'
printf 'identifiant admin-preprod ou admin-prod). Ne le collez dans aucun message ni\n'
printf 'conversation (Claude compris). Perdu : relancer sudo deploy/admin-jeton.sh --remplacer.\n'
read -rs -p "Une fois rangé, appuyez sur Entrée : l'écran sera effacé. " _ || true
printf '\033[H\033[2J\033[3J'

echo "Empreinte du jeton et SHH_ADMIN_LISTEN=$ADMIN_ECOUTE enregistrées dans deploy/.env."
echo
echo "Ensuite :"
echo "1. Tunnel, depuis PowerShell sur votre poste (la fenêtre reste ouverte sans rien afficher) :"
echo "     ssh -N -L 127.0.0.1:9191:$ADMIN_ECOUTE $compte@$hote"
echo "2. Dans le navigateur : http://127.0.0.1:9191 (exactement 127.0.0.1), coller le jeton."
echo "3. Fermer : l'onglet, puis Ctrl-C dans la fenêtre du tunnel."
r=$(commande_reinstallation)
if [ -z "$r" ]; then
	echo "Le tableau de bord s'ouvrira après la première installation (deploy.sh ou preprod.sh)."
	exit 0
fi
echo
echo "Le tableau de bord s'active quand le site est réinstallé : $r"
read -r -p "Réinstaller maintenant ? (o/N) " ok || ok=
case $ok in
o | O | oui | Oui | OUI)
	# Même procédure que tapée à la main (verrous et contrôles revérifiés), dans un environnement
	# propre : rien de ce que ce script a posé ou lu de l'ancien deploy/.env n'est transmis.
	propre=(env -i "PATH=$PATH" "TERM=${TERM:-dumb}" "LANG=${LANG:-C.UTF-8}")
	if [[ $cur == preprod:* ]]; then exec "${propre[@]}" "$here/preprod.sh" "${cur#preprod:}"; fi
	exec "${propre[@]}" "$here/deploy.sh" "$cur"
	;;
*) echo "Non réinstallé. Plus tard : $r" ;;
esac

#!/usr/bin/env bash
# Affiche le lien d'accès de la préproduction, https://<domaine>/acces/<jeton> (README §15.2).
# Le lien est un secret : qui l'a voit le site fermé. En root, dans SA PROPRE fenêtre SSH,
# jamais dans une session Claude :
#
#   sudo deploy/lien-acces.sh
#
# Refusé si la sortie n'est pas un terminal (session Claude, tuyau, fichier) : le lien ne
# s'affiche que sur un écran. Après Entrée, l'écran et son historique de défilement sont effacés.
# Le jeton est tiré par deploy/preprod.sh (ou deploy.sh) à la première installation.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here"
[ $# -eq 0 ] || {
	printf 'usage: lien-acces.sh\n' >&2
	exit 2
}
if [ "$(id -u)" != 0 ]; then
	printf 'erreur: à lancer en root : sudo deploy/lien-acces.sh\n' >&2
	exit 1
fi
if [ ! -t 1 ]; then
	printf 'erreur: le lien est un secret : lancez cette commande vous-même, dans votre propre fenêtre SSH (jamais dans une session Claude, jamais vers un fichier ou un tuyau)\n' >&2
	exit 1
fi
# shellcheck disable=SC2034 # lue par commun.sh : jeton exigé et contrôlé (lire_jeton_preprod)
jeton_preprod=lire
# shellcheck source=deploy/commun.sh
. ./commun.sh
[ "$preprod" = 1 ] || die "pas de préproduction (SHH_PREPROD=1 absent de deploy/.env) : le site est public, aucun lien d'accès"

printf '\nATTENTION : ce lien ouvre le site fermé. Ne le collez dans aucun message, aucune\n'
printf 'conversation (Claude compris), aucun service en ligne.\n\n'
printf '  https://%s/acces/%s\n\n' "$SHH_DOMAIN" "$SHH_PREPROD_JETON"
printf 'Ouvrez-le une fois dans chaque navigateur (iPhone : Safari, pas en navigation privée),\n'
printf "puis effacez-le de l'historique du navigateur. Il reste valable 30 jours par appareil.\n"
SHH_PREPROD_JETON=
if [ -t 0 ]; then
	read -rs -p "Appuyez sur Entrée pour effacer l'écran. " _ || true
	# Écran, puis historique de défilement (Windows Terminal, PowerShell, xterm).
	printf '\033[H\033[2J\033[3J'
	echo "Écran effacé."
fi

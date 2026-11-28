#!/usr/bin/env bash
# Maintenance programmée (D42-32 ; README « Redémarrer la machine ») : annonce un redémarrage au
# public, sans aucun secret à taper. Peut être lancé depuis une session Claude.
#
#   sudo deploy/maintenance.sh annoncer "AAAA-MM-JJ HH:MM" <durée en min> [<avance en min>]
#        heure de Paris ; bandeau sur tout le site dès maintenant (heure locale du visiteur) ;
#        <avance> min avant (10 par défaut, de 1 à 120), le serveur refuse les NOUVELLES
#        créations (partage, salon, pièce de salon, inscription, commande) jusqu'à son
#        redémarrage ; ce qui est en cours continue. Une nouvelle annonce remplace l'ancienne.
#   sudo deploy/maintenance.sh annuler    retire l'annonce (bandeau effacé, créations rouvertes)
#   sudo deploy/maintenance.sh etat       où en est l'annonce
#
# Après la maintenance, rien à faire : le serveur efface l'annonce de lui-même une fois redémarré
# et la durée passée. Le fichier (<SHH_DATA_ROOT>/data/maintenance) est sur le volume chiffré :
# l'annonce survit au redémarrage du conteneur, et ne se lit qu'une fois le volume rouvert.
set -uo pipefail
export LC_ALL=C.UTF-8

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here" || exit 1
usage() {
	printf 'usage: maintenance.sh annoncer "AAAA-MM-JJ HH:MM" <durée en min> [<avance en min>] | annuler | etat\n' >&2
	exit 2
}
[ $# -ge 1 ] || usage
if [ "$(id -u)" != 0 ]; then
	printf 'erreur: à lancer en root : sudo deploy/maintenance.sh %s\n' "$1" >&2
	exit 1
fi
# shellcheck disable=SC2034 # lue par commun.sh : aucun jeton n'est lu
jeton_preprod=sans
# shellcheck source=deploy/commun.sh
. ./commun.sh
# shellcheck source=deploy/annonce.sh
. ./annonce.sh

fichier=$SHH_DATA_ROOT/data/maintenance
mountpoint -q "$SHH_DATA_ROOT" || die "$SHH_DATA_ROOT n'est pas monté : volume chiffré à déverrouiller d'abord (README §5)"

case $1 in
annoncer)
	[ $# -eq 3 ] || [ $# -eq 4 ] || usage
	annonce_ecrire "$fichier" "$2" "$3" "${4:-$ANNONCE_AVANCE_DEFAUT}" || exit $?
	echo "ensuite : attendre l'heure, sudo reboot, déverrouiller le volume, réinstaller, vérifier (README « Redémarrer la machine »)"
	;;
annuler)
	[ $# -eq 1 ] || usage
	annonce_annuler "$fichier"
	;;
etat)
	[ $# -eq 1 ] || usage
	annonce_etat "$fichier" "$(date +%s)" "$(annonce_demarrage)"
	exit 0
	;;
*) usage ;;
esac

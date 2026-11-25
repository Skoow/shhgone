#!/usr/bin/env bash
# Mise en ligne de Shhdrop (spec §15.3, D3, §28.7) : installe une version précise, désignée par
# l'empreinte de son image (ghcr.io/skoow/shhgone, publiée et signée par release.yml) et le
# numéro de sa Release signée, vérifie que l'image et son site sont ceux de la Release signée,
# contrôle la santé, et revient à la version précédente si le contrôle échoue. Lancé à la main,
# sur le serveur, depuis une copie du dépôt (/opt/shhdrop, README §2).
#
#   deploy/deploy.sh sha256:<64 chiffres hexadécimaux> <x.y.z> <commit de 40 chiffres hexadécimaux>
#                                                         installe cette image, qui doit être
#                                                         celle de la Release web-v<x.y.z>,
#                                                         construite depuis ce commit (confirmé
#                                                         par le propriétaire, verrous V1 à V3)
#   deploy/deploy.sh sha256:<empreinte en service>        la réinstalle (après un redémarrage),
#                                                         avec sa version et son commit déjà vérifiés
#   deploy/deploy.sh rollback                             réinstalle la version précédente
#   deploy/deploy.sh status                               versions et état des conteneurs
#   deploy/deploy.sh admin freeze|unfreeze|destroy -|wipe --yes
#                                                         commandes de la spec §15.3
#   deploy/deploy.sh diagnose                             serveur au premier plan, pour lire
#                                                         un refus de démarrer (rien n'est écrit)
#
# Réglages : deploy/.env (modèle : deploy/env.example). Aucun secret qui ouvre quoi que ce soit :
# le tableau de bord n'y a que l'EMPREINTE de son jeton (SHH_ADMIN_TOKEN_SHA256, README §4), le
# jeton reste chez l'exploitant ; la clé du serveur du compte est un fichier de
# <SHH_DATA_ROOT>/secrets (README §12), jamais une variable. Tout deploy/.env est exporté aux
# commandes de ce script (set -a). Compte par passkey activé (SHH_COMPTES: "1" dans
# compose.yaml) : clé vérifiée avant l'installation, SHH_DOMAIN exigé à shhgone.com (rp.id des
# passkeys, définitif) ; aucun e-mail, aucun relais (une ancienne variable SHH_SMTP_* ou
# SHH_MAIL_FROM, ou un ancien secret shh_smtp_mdp, fait refuser l'installation). Paiement
# activé (SHH_PAIEMENT: "1") : un relais par prestataire dont les secrets sont dans
# <SHH_DATA_ROOT>/secrets (README §13).
# État : deploy/.release (empreinte en service) et deploy/.release.prev (la précédente), leurs
# versions dans deploy/.release.version et deploy/.release.prev.version, leurs commits dans
# deploy/.release.commit et deploy/.release.prev.commit ; manifestes vérifiés dans
# deploy/.provenance/<x.y.z>/ ; dernier commit installé (verrou V2) dans
# /etc/shhdrop/commit-installe.
#
# Provenance (spec §28.7 ; deploy/provenance.sh, README §3) : avant tout téléchargement de
# l'image, cosign (binaire contrôlé par son empreinte épinglée) vérifie que release.json et
# image.json de la Release web-v<x.y.z> sont signés par release.yml de ce dépôt sur cette
# étiquette exactement, qu'image.json nomme ghcr.io/skoow/shhgone@<empreinte donnée> avec ce
# manifeste, et que l'image est signée dans le registre par la même identité ; puis, avant tout
# démarrage, le /site de l'image doit être ce manifeste, octet pour octet, ni plus ni moins. Après le
# démarrage, le contrôle de santé lance verify-site.mjs à travers Caddy (le retour arrière suit
# un écart). Aucune option, variable ni commande ne saute ces vérifications (spec §28.8, C2).
#
# Verrous (deploy/verrous.sh, README §3.5), avant tout démarrage, sans option non plus : V1, le
# commit du manifeste et chaque commit depuis le commit installé sont signés par une clé de
# /etc/shhdrop/signataires-autorises ; V2, le commit installé est un ancêtre du nouveau ;
# V3, le commit donné en argument est celui du manifeste. La copie du dépôt (celle de ce script)
# est mise à jour par l'exploitant avec « git fetch origin » seulement (jamais « git pull ») : ce
# script, celui du commit installé, vérifie le nouveau commit, avance la copie (git merge
# --ff-only), puis relance le deploy.sh de ce commit vérifié, qui refait toutes les vérifications.
#
# Préproduction (README §15) : SHH_PREPROD=1 dans deploy/.env met la barrière du Caddyfile, avec
# ce script comme avec deploy/preprod.sh (version de développement construite sur le serveur,
# sans signature). Ce script n'installe jamais une image de préproduction. Partie commune aux
# deux : deploy/commun.sh.
#
# Limites, dites aussi dans le README :
#   - le retour arrière ne concerne que l'image ; Caddyfile et compose.yaml viennent de la
#     copie du dépôt, au commit installé (pour les ramener en arrière : un nouveau commit signé,
#     une nouvelle Release, puis ce script ; README §3.4) ;
#   - la signature prouve « construit par release.yml depuis ce commit », pas que le code est
#     sain (README §3.1).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here"
usage() {
	printf 'usage: deploy.sh sha256:<empreinte> [<x.y.z> <commit>] | rollback | status | admin <commande> | health | diagnose\n' >&2
	exit 2
}
[ $# -ge 1 ] || usage
# Arguments gardés pour relancer le deploy.sh du commit vérifié (verrous, commun.sh).
args=("$@")
# shellcheck disable=SC2034 # lue par commun.sh (verrous)
relance=deploy.sh
# Réglages de deploy/.env, verrous, contrôles de la machine, démarrage et contrôle de santé :
# partie commune avec preprod.sh (README §15).
# shellcheck source=deploy/commun.sh
. ./commun.sh

# install_version <empreinte> <x.y.z> <commit> <suite|retour>
install_version() {
	local new=$1 new_v=$2 new_c=$3 mode=$4 cosign
	valid "$new" || usage
	commit_valide "$new_c" ||
		die "commit refusé : « $new_c » (le commit complet, 40 chiffres hexadécimaux, donné par la conversation de développement : README §3.5)" 2
	# Une seule installation à la fois (status et admin restent possibles pendant ce temps).
	exec 9>.deploy.lock
	flock -n 9 || die "une autre installation est en cours"
	# Verrous V1 et V2, avant tout le reste (README §3.5).
	verrous "$new_c" "$mode"
	preflight
	cosign=$(command -v cosign || true)
	controle_cosign "$cosign" "$COSIGN_SHA256" || exit 1
	secret_turn
	ports_turn
	# Image (README §3.2), avant tout téléchargement : image.json et release.json signés par
	# release.yml sur web-v<x.y.z>, image.json lie cette empreinte au manifeste, et l'image est
	# signée dans le registre par la même identité.
	verifier_image "$cosign" curl "$new" "$new_v" "$here/.provenance" ||
		die "installation refusée : $new n'est pas l'image signée de la Release web-v$new_v (README §3.2)"
	# Image absente : téléchargée par empreinte (le contenu est donc vérifié par Docker).
	docker image inspect "$SHH_IMAGE_REPO@$new" >/dev/null 2>&1 || docker pull "$SHH_IMAGE_REPO@$new"
	# Provenance (spec §28.7), avant tout démarrage : rien de l'image ne tourne tant que son site
	# n'est pas celui du manifeste signé web-v<x.y.z>.
	verifier_provenance "$cosign" docker curl "$SHH_IMAGE_REPO@$new" "$new_v" "$here/.provenance" ||
		die "installation refusée : le site de $new n'est pas prouvé conforme à la Release web-v$new_v (README §3)"
	# V3 : le commit confirmé par le propriétaire est celui du manifeste signé.
	controle_commit_annonce "$here/.provenance/$new_v/release.json" "$new_c" ||
		die "installation refusée : commit non confirmé (V3, README §3.5)"

	mettre_en_service "$new" "$new_v" "$new_c" "$mode"
}

case $1 in
sha256:*)
	if [ $# -eq 3 ]; then
		install_version "$1" "$2" "$3" suite
	elif [ $# -eq 1 ] && [ "$1" = "$cur" ] && version_valide "$cur_v" && commit_valide "$cur_c"; then
		# Réinstallation (après un redémarrage) : provenance et verrous revérifiés.
		install_version "$1" "$cur_v" "$cur_c" retour
	elif [ $# -eq 1 ] && [ "$1" = "$cur" ] && version_valide "$cur_v"; then
		die "commit de la version en service inconnu (installée avant les verrous) : deploy/deploy.sh $1 $cur_v <commit> (README §3.5)" 2
	elif [ $# -le 2 ]; then
		die "version ou commit manquant : deploy/deploy.sh $1 <x.y.z> <commit> (Release web-v<x.y.z> dont le manifeste signé décrit le site de cette image, et son commit complet, confirmé par la conversation de développement : README §3.5)" 2
	else
		usage
	fi
	;;
preprod:*)
	# Image de préproduction (construite sur le serveur, sans signature) : jamais par ce script.
	die "$1 : version de préproduction, à réinstaller par deploy/preprod.sh ${1#preprod:} (README §15)" 2
	;;
rollback)
	[ $# -eq 1 ] || usage
	if [[ $prev == preprod:* ]]; then
		die "la version précédente est une version de préproduction : deploy/preprod.sh ${prev#preprod:} (README §15)"
	fi
	valid "$prev" || die "aucune version précédente (deploy/.release.prev absent)"
	version_valide "$prev_v" ||
		die "version de la précédente inconnue (installée avant la vérification de provenance) : retour arrière impossible"
	commit_valide "$prev_c" ||
		die "commit de la précédente inconnu (installée avant les verrous) : retour arrière impossible (README §3.5)"
	install_version "$prev" "$prev_v" "$prev_c" retour
	;;
status)
	[ $# -eq 1 ] || usage
	echo "en service : ${cur:-aucune}${cur_v:+ (web-v$cur_v)}${cur_c:+, commit $cur_c}"
	echo "précédente : ${prev:-aucune}${prev_v:+ (web-v$prev_v)}${prev_c:+, commit $prev_c}"
	echo "commit installé (V2) : $(cat "$VERROUS_COMMIT_INSTALLE" 2>/dev/null || echo aucun)"
	if [ "$preprod" = 1 ]; then echo "PRÉPRODUCTION (SHH_PREPROD=1) : le public ne voit que la page de maintenance (README §15)"; fi
	if etat_valide "$cur"; then dc "$cur" ps -a; fi
	;;
admin)
	# Dans le conteneur en marche : même dossier de données, même compte. L'entrée standard
	# est transmise (destroy - lit le lien dessus). Le code de sortie est celui de la commande.
	[ $# -ge 2 ] || usage
	need_current
	shift
	dc "$cur" exec -T shhdrop /shhdrop admin "$@"
	;;
health)
	# Santé du serveur en marche (JSON de /healthz : ok, reports_alert ; aucune donnée
	# d'utilisateur). Lue par alerte.sh (README §4).
	[ $# -eq 1 ] || usage
	need_current
	dc "$cur" exec -T shhdrop /shhcheck health
	;;
diagnose)
	# Le pilote de journal est « none » : un refus de démarrer ne se lit nulle part. Ici le
	# serveur est arrêté puis lancé au premier plan ; Ctrl-C pour finir, puis réinstaller.
	[ $# -eq 1 ] || usage
	need_current
	dc "$cur" stop shhdrop
	echo "serveur au premier plan (Ctrl-C pour arrêter), puis : deploy/deploy.sh $cur"
	dc "$cur" run --rm --no-deps shhdrop serve
	;;
*) usage ;;
esac

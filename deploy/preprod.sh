#!/usr/bin/env bash
# Préproduction (README §15) : installe vite une version
# de développement, construite SUR LE SERVEUR depuis un commit précis, derrière la barrière du
# Caddyfile (SHH_PREPROD=1 : le public ne voit que la page de maintenance). Lancé à la main, en
# root, depuis la copie du dépôt (/opt/shhdrop, mise à jour par « git fetch origin » seulement).
#
#   deploy/preprod.sh <commit de 40 chiffres hexadécimaux>
#
# Ce qui est vérifié, sans option pour le sauter :
#   - SHH_PREPROD=1 dans deploy/.env, avec le jeton bien réglé (commun.sh) : sinon
#     refus (une image non signée n'est jamais servie au public) ;
#   - verrous V1 (commit, et chaque commit depuis le commit installé, signés par une clé
#     autorisée), V2 (descendant du commit installé) et V3 (commit complet donné en argument)
#     de verrous.sh, comme deploy.sh ; la copie du dépôt est avancée au commit, puis le
#     preprod.sh de ce commit vérifié est relancé ;
#   - contrôles de la machine (preflight), puis, après le démarrage, le contrôle de santé de
#     deploy.sh (barrière comprise), avec retour à la version d'avant s'il échoue.
# Ce qui ne l'est PAS (compromis assumé de la préproduction, sans utilisateurs ni données ;
# README §15, spec §28.7) : aucune signature Sigstore, aucun build reproductible comparé à celui
# de GitHub. L'image (étiquette locale shhdrop-preprod:<commit>) est construite par le Docker du
# serveur depuis la copie du dépôt au commit vérifié ; son site est comparé à ce qu'elle contient
# (manifeste calculé ici, deploy/.preprod/<commit>/release.json), pas à une Release signée.
# Ouverture au public : retirer SHH_PREPROD de deploy/.env, puis deploy.sh avec la Release.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here"
usage() {
	printf 'usage: preprod.sh <commit de 40 chiffres hexadécimaux>\n' >&2
	exit 2
}
[ $# -eq 1 ] || usage
args=("$@")
# shellcheck disable=SC2034 # lue par commun.sh (verrous)
relance=preprod.sh
# Le jeton de préproduction qui manque est tiré par preflight (commun.sh), après les verrous.
# shellcheck disable=SC2034 # lue par commun.sh
jeton_preprod=installer
# shellcheck source=deploy/commun.sh
. ./commun.sh

[ "$preprod" = 1 ] ||
	die "SHH_PREPROD=1 exigé dans deploy/.env : preprod.sh ne sert qu'avec la barrière de préproduction (README §15)"
c=$1
# V3 : le commit complet, donné par la conversation de développement (jamais une forme courte).
commit_valide "$c" ||
	die "commit refusé : « $c » (le commit complet, 40 chiffres hexadécimaux, donné par la conversation de développement : README §3.5)" 2
etat=preprod:$c

# Une seule installation à la fois (même verrou que deploy.sh).
exec 9>.deploy.lock
flock -n 9 || die "une autre installation est en cours"
# Verrous V1 et V2, avant tout le reste (README §3.5) ; la copie est alors propre, au commit $c.
verrous "$c" suite
preflight
ports_turn

# Image construite depuis les fichiers SUIVIS du commit vérifié seulement : « git archive » de
# ce commit, extrait dans un dossier temporaire (effacé à la fin), jamais la copie de travail,
# où un fichier non suivi ou ignoré (un .go déposé dans server/) serait compilé sans que les
# verrous le voient (ils ne regardent que les fichiers suivis). Même Dockerfile, même contexte
# (filtré par .dockerignore : ni deploy/.env, ni bases, ni secrets), mêmes arguments que
# release.yml (construire-image.sh) ; le cache de Docker garde les étapes qui n'ont pas changé.
build_id=$(git_sur "$depot" "$VERROUS_SIGNATAIRES" rev-parse --short=7 "$c")
date_commit=$(git_sur "$depot" "$VERROUS_SIGNATAIRES" log -1 --format=%ct "$c")
image=$(ref_image "$etat")
ctx=$(mktemp -d)
trap 'rm -rf -- "$ctx"; integrite_fin' EXIT # integrite_fin : nouvelle base d'intégrité (commun.sh)
contexte_du_commit "$depot" "$VERROUS_SIGNATAIRES" "$c" "$ctx" || die "contexte de construction illisible (git archive $c)"
echo "construction de $image (SHH_BUILD_ID=$build_id, fichiers suivis du commit $c)"
SHH_BUILD_ID=$build_id SOURCE_DATE_EPOCH=$date_commit docker build -f "$ctx/deploy/Dockerfile" \
	--build-arg SHH_BUILD_ID --build-arg SOURCE_DATE_EPOCH --platform linux/amd64 \
	-t "$image" "$ctx" || die "construction de l'image refusée"
rm -rf -- "$ctx"

# Manifeste du site de l'image, calculé ici (non signé), pour que le contrôle de santé compare
# octet pour octet le site servi à travers Caddy à celui de l'image (verify-site.mjs).
tmp=$(mktemp -d)
if ! site_de_l_image docker "$image" "$tmp" || ! mkdir -p ".preprod/$c" ||
	! manifeste_de "$tmp/site" 0.0.0 "$c" >".preprod/$c/release.json"; then
	rm -rf -- "$tmp"
	die "site de $image illisible"
fi
rm -rf -- "$tmp"

mettre_en_service "$etat" preprod "$c" suite

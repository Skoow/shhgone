#!/usr/bin/env bash
# Image du serveur, construite de façon reproductible (spec §28.1, §28.7 ; README §3.2) : même
# commit, même empreinte, sur n'importe quelle machine linux/amd64 avec Docker et buildx.
# Lancé par release.yml (job « image », sur deux machines dont les empreintes doivent être
# égales), et par quiconque veut refaire l'image publiée et comparer son empreinte.
#
#   deploy/construire-image.sh <dossier de sortie>
#
# Écrit <dossier>/image.tar (archive OCI, non chargée dans Docker) et <dossier>/empreinte
# (sha256:…, empreinte du manifeste de l'image : celle de ghcr.io/skoow/shhgone@sha256:…, que
# reçoit deploy.sh).
#
# Ce qui fixe les octets : le commit (SHH_BUILD_ID, sa date pour SOURCE_DATE_EPOCH), les images
# de base épinglées par empreinte (Dockerfile), BuildKit épinglé par empreinte (ci-dessous,
# constructeur docker-container recréé à chaque fois), dates des fichiers réécrites
# (rewrite-timestamp), une seule plateforme, aucune attestation (--provenance=false, --sbom=false :
# elles portent l'heure du build).
set -euo pipefail

# BuildKit v0.34.2 (publié le 3 novembre 2026), index multi-architecture relevé le 25 novembre
# 2026 sur registry-1.docker.io et mirror.gcr.io (identiques). Le changer change l'empreinte
# de l'image : à monter avec une Release.
readonly BUILDKIT_IMAGE=moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe
readonly CONSTRUCTEUR=shhdrop-repro

die() {
	printf 'construire-image : %s\n' "$1" >&2
	exit 1
}
[ $# -eq 1 ] && [ -n "$1" ] || {
	echo "usage : deploy/construire-image.sh <dossier de sortie>" >&2
	exit 2
}
out=$1
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
# shellcheck source=deploy/provenance.sh
. "$here/provenance.sh"
cd "$repo"
# Des modifications non commitées entreraient dans l'image sans changer SHH_BUILD_ID.
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "fichiers suivis modifiés (git status) : construire depuis un arbre propre"
SHH_BUILD_ID=$(git rev-parse --short=7 HEAD)
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
export SHH_BUILD_ID SOURCE_DATE_EPOCH
mkdir -p -- "$out"
rm -f -- "$out/image.tar" "$out/empreinte"

# Constructeur recréé : un ancien, d'une autre version de BuildKit, donnerait une autre image.
docker buildx rm "$CONSTRUCTEUR" >/dev/null 2>&1 || true
docker buildx create --name "$CONSTRUCTEUR" --driver docker-container --driver-opt "image=$BUILDKIT_IMAGE" --bootstrap >/dev/null
docker buildx build --builder "$CONSTRUCTEUR" -f deploy/Dockerfile \
	--build-arg SHH_BUILD_ID --build-arg SOURCE_DATE_EPOCH \
	--platform linux/amd64 --provenance=false --sbom=false \
	--output "type=oci,dest=$out/image.tar,rewrite-timestamp=true" .
docker buildx rm "$CONSTRUCTEUR" >/dev/null 2>&1 || true

empreinte_oci "$out/image.tar" >"$out/empreinte.tmp" || die "$out/image.tar : archive OCI refusée"
mv -- "$out/empreinte.tmp" "$out/empreinte"
echo "image $PROVENANCE_IMAGE@$(cat "$out/empreinte") (commit $(git rev-parse HEAD), SHH_BUILD_ID=$SHH_BUILD_ID, SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"

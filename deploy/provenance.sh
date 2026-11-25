#!/usr/bin/env bash
# Provenance du site (spec §28.2, §28.7) : le site contenu dans une image n'est installé que
# s'il est, octet pour octet, celui d'un manifeste de version (release.json) signé sans clé par
# le workflow .github/workflows/release.yml de ce dépôt, sur une étiquette web-v<x.y.z>.
# Fichier chargé par deploy.sh (après deploy/.env : les constantes ci-dessous, en lecture
# seule, ne peuvent pas venir de lui), par le banc d'essai deploy/test-provenance.sh
# (make lint-deploy) et par le job « signer » de release.yml (contrôle croisé de manifeste_de).
#
# Chaque fonction reçoit les commandes qu'elle lance (cosign, docker, curl) en argument : le banc
# d'essai leur substitue des imitations, sans réseau. deploy.sh passe toujours les vraies
# commandes ; il n'existe AUCUNE option, variable ou commande pour sauter la vérification
# (spec §28.8, C2).
#
# L'image elle-même (décision du propriétaire du 25 novembre) : construite par release.yml sur
# la même étiquette (deux builds sur deux machines, même empreinte exigée), publiée sur
# ghcr.io/skoow/shhgone et signée sans clé par la même identité ; son empreinte est liée au
# manifeste par image.json, signé lui aussi, que deploy.sh exige égal, octet pour octet, à celui
# qu'il recalcule de l'empreinte donnée (verifier_image, avant tout téléchargement de l'image).
#
# Ce que la vérification prouve : l'image (binaires du serveur et de shhcheck compris) et son
# site ont été construits par release.yml, depuis le commit public nommé dans le manifeste
# (journal public Rekor). Ce qu'elle ne prouve pas : que ce code est sain.

# Dépôt public et identité exacte du signataire. Le nom du dépôt est celui que GitHub inscrit
# dans le certificat (remote du dépôt, 24 novembre : Skoow/shhgone).
readonly PROVENANCE_DEPOT=Skoow/shhgone
readonly PROVENANCE_EMETTEUR=https://token.actions.githubusercontent.com
# Seul dépôt d'images accepté (en minuscules, comme l'exige le registre), public : le serveur le
# lit sans identifiant.
readonly PROVENANCE_IMAGE=ghcr.io/skoow/shhgone
# cosign épinglé (README §3) : v3.1.4, publiée le 20 octobre 2026 ; empreinte du binaire
# cosign-linux-amd64 relevée le 24 novembre 2026 dans cosign_checksums.txt de la Release et
# recalculée sur le binaire téléchargé (identiques). À chaque montée de version : changer les
# deux ensemble, ici et dans le README (et dans les workflows release.yml et verifier-site.yml).
readonly COSIGN_VERSION=v3.1.4
# shellcheck disable=SC2034 # lue par deploy.sh et le banc d'essai
readonly COSIGN_SHA256=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa
# Taille maximale d'un fichier téléchargé (manifeste, bundle) : le manifeste du site fait
# quelques dizaines de kio.
readonly PROVENANCE_MAX_OCTETS=4194304

# version_valide <x.y.z> : rend 0 si la version a la forme des étiquettes web-v<x.y.z>.
version_valide() {
	[[ $1 =~ ^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$ ]]
}

# identite_release <x.y.z> : identité exacte du certificat (jamais une expression ouverte).
identite_release() {
	printf 'https://github.com/%s/.github/workflows/release.yml@refs/tags/web-v%s' "$PROVENANCE_DEPOT" "$1"
}

# url_release <x.y.z> <fichier> : adresse d'un fichier publié dans la Release GitHub.
url_release() {
	printf 'https://github.com/%s/releases/download/web-v%s/%s' "$PROVENANCE_DEPOT" "$1" "$2"
}

# controle_cosign <binaire> <empreinte attendue> : le binaire est un fichier ordinaire, et
# son SHA-256 est l'empreinte épinglée. Écrit le problème et rend 1 sinon.
controle_cosign() {
	local bin=$1 attendu=$2 vu
	if [ -z "$bin" ] || [ ! -f "$bin" ] || [ ! -x "$bin" ]; then
		echo "cosign introuvable : installer cosign $COSIGN_VERSION, binaire vérifié par son empreinte (README §3)" >&2
		return 1
	fi
	vu=$(sha256sum -- "$bin" | cut -d' ' -f1)
	if [ "$vu" != "$attendu" ]; then
		echo "$bin : empreinte $vu, pas celle de cosign $COSIGN_VERSION épinglée ($attendu) : réinstaller (README §3)" >&2
		return 1
	fi
}

# verifier_signature <cosign> <x.y.z> <release.json> <bundle> : signature sans clé, identité
# et émetteur exacts, journal de transparence exigé (jamais --insecure-ignore-tlog).
verifier_signature() {
	local cosign=$1 version=$2 json=$3 bundle=$4
	"$cosign" verify-blob "$json" --bundle "$bundle" \
		--certificate-oidc-issuer "$PROVENANCE_EMETTEUR" \
		--certificate-identity "$(identite_release "$version")" >&2 || {
		echo "signature refusée : $json n'est pas signé par release.yml sur l'étiquette web-v$version de $PROVENANCE_DEPOT" >&2
		return 1
	}
}

# manifeste_de <dossier> <x.y.z> <commit> : écrit sur la sortie standard le release.json que
# web/scripts/release-manifest.mjs écrirait pour ce dossier (même ordre, mêmes octets ; le banc
# d'essai et release.yml le vérifient). Sans Node ni jq sur le serveur. Refuse ce qui ne peut pas
# être un fichier du site : lien, fichier spécial, nom hors de [A-Za-z0-9._@+-] (aucun nom du
# site n'en a d'autre ; il n'y a donc rien à échapper en JSON), dossier sans fichier.
manifeste_de() {
	local dir=$1 version=$2 commit=$3 rel taille somme autre n=0 sep=
	if [ ! -d "$dir" ] || [ -L "$dir" ]; then
		echo "$dir : dossier du site absent" >&2
		return 1
	fi
	autre=$(cd "$dir" && find . -mindepth 1 ! -type f ! -type d -print -quit)
	if [ -n "$autre" ]; then
		echo "${autre#./} : ni fichier ordinaire ni dossier (lien refusé)" >&2
		return 1
	fi
	printf '{\n  "schema": 1,\n  "name": "shhdrop-web",\n  "version": "%s",\n  "commit": "%s",\n  "files": [\n' "$version" "$commit"
	while IFS= read -r -d '' rel; do
		rel=${rel#./}
		if ! [[ $rel =~ ^[A-Za-z0-9._@+-]+(/[A-Za-z0-9._@+-]+)*$ ]]; then
			echo "nom de fichier refusé : $(printf '%q' "$rel")" >&2
			return 1
		fi
		taille=$(stat -c %s -- "$dir/$rel")
		somme=$(sha256sum -- "$dir/$rel" | cut -d' ' -f1)
		printf '%s    {\n      "path": "%s",\n      "size": %s,\n      "sha256": "%s"\n    }' "$sep" "$rel" "$taille" "$somme"
		sep=$',\n'
		n=$((n + 1))
	done < <(cd "$dir" && find . -type f -print0 | LC_ALL=C sort -z)
	if [ "$n" = 0 ]; then
		echo "$dir : aucun fichier" >&2
		return 1
	fi
	printf '\n  ]\n}\n'
}

# commit_du_manifeste <release.json> : le commit (ligne 5, forme exacte de release-manifest.mjs).
commit_du_manifeste() {
	local ligne
	ligne=$(sed -n '5p' -- "$1")
	[[ $ligne =~ ^\ \ \"commit\":\ \"([0-9a-f]{7,40})\",$ ]] || {
		echo "$1 : commit illisible (ligne 5 : forme de release-manifest.mjs attendue)" >&2
		return 1
	}
	printf '%s' "${BASH_REMATCH[1]}"
}

# controle_site <dossier> <release.json> <x.y.z> : le dossier est exactement le manifeste
# (mêmes fichiers, ni plus ni moins, mêmes tailles et empreintes, même version). Le manifeste
# est relu ici entier, octet pour octet : aucun analyseur JSON n'interprète un fichier reçu.
controle_site() {
	local dir=$1 json=$2 version=$3 commit attendu
	commit=$(commit_du_manifeste "$json") || return 1
	attendu=$(mktemp)
	if ! manifeste_de "$dir" "$version" "$commit" >"$attendu"; then
		rm -f -- "$attendu"
		return 1
	fi
	if ! cmp -s -- "$attendu" "$json"; then
		echo "le site de l'image n'est pas celui du manifeste signé web-v$version (premiers écarts : - signé, + image) :" >&2
		diff -- "$json" "$attendu" | grep -E '^[<>]' | head -n 12 | sed 's/^</-/; s/^>/+/' >&2 || true
		rm -f -- "$attendu"
		return 1
	fi
	rm -f -- "$attendu"
}

# site_de_l_image <docker> <image> <dossier> : copie /site de l'image (sans la lancer) dans
# <dossier>/site.
site_de_l_image() {
	local docker=$1 image=$2 dest=$3 id
	id=$("$docker" create "$image") || {
		echo "$image : image introuvable" >&2
		return 1
	}
	if ! "$docker" cp "$id:/site" "$dest/site" >/dev/null; then
		"$docker" rm "$id" >/dev/null 2>&1 || true
		echo "$image : /site illisible" >&2
		return 1
	fi
	"$docker" rm "$id" >/dev/null 2>&1 || true
}

# telecharger <curl> <adresse> <fichier> : https seulement (redirections comprises), taille bornée.
telecharger() {
	"$1" -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 60 \
		--max-filesize "$PROVENANCE_MAX_OCTETS" -o "$3" -- "$2" || {
		echo "téléchargement impossible : $2" >&2
		return 1
	}
}

# verifier_provenance <cosign> <docker> <curl> <image> <x.y.z> <cache> :
#   1. le manifeste et son bundle de la Release web-v<x.y.z> (téléchargés une fois dans
#      <cache>/<x.y.z>/, mais revérifiés à chaque appel) ;
#   2. signature : release.yml de ce dépôt, étiquette web-v<x.y.z> exactement ;
#   3. le site de l'image (/site) est exactement le manifeste.
# Rend 0 seulement si tout passe ; écrit chaque refus sur la sortie d'erreur. Le manifeste
# vérifié reste dans <cache>/<x.y.z>/release.json (lu ensuite par verify-site.mjs).
verifier_provenance() {
	local cosign=$1 docker=$2 curl=$3 image=$4 version=$5 cache=$6 dir src tmp ok=0
	version_valide "$version" || {
		echo "version refusée : « $version » (x.y.z attendu, étiquette web-v<x.y.z>)" >&2
		return 1
	}
	dir=$cache/$version
	tmp=$(mktemp -d)
	# Fichiers absents du cache : téléchargés à part, mis en cache seulement une fois vérifiés.
	if [ ! -f "$dir/release.json" ] || [ ! -f "$dir/release.json.sigstore.json" ]; then
		if telecharger "$curl" "$(url_release "$version" release.json)" "$tmp/release.json" &&
			telecharger "$curl" "$(url_release "$version" release.json.sigstore.json)" "$tmp/release.json.sigstore.json"; then
			src=$tmp
		else
			rm -rf -- "$tmp"
			return 1
		fi
	else
		src=$dir
	fi
	if verifier_signature "$cosign" "$version" "$src/release.json" "$src/release.json.sigstore.json" &&
		site_de_l_image "$docker" "$image" "$tmp" &&
		controle_site "$tmp/site" "$src/release.json" "$version"; then
		ok=1
		if [ "$src" = "$tmp" ]; then
			mkdir -p -- "$dir"
			cp -- "$tmp/release.json" "$tmp/release.json.sigstore.json" "$dir/"
		fi
	fi
	rm -rf -- "$tmp"
	[ "$ok" = 1 ] || {
		echo "provenance refusée : $image n'est pas installée" >&2
		return 1
	}
	echo "provenance : site de $image conforme au manifeste signé web-v$version ($(commit_du_manifeste "$dir/release.json"))"
}

# image_node <Dockerfile> : l'image Node épinglée par empreinte (étape « web » du Dockerfile).
image_node() {
	local img
	img=$(grep -oE 'node:[0-9][^ ]*@sha256:[0-9a-f]{64}' -- "$1")
	[ -n "$img" ] && [ "$(printf '%s\n' "$img" | wc -l)" = 1 ] || {
		echo "$1 : image node épinglée introuvable" >&2
		return 1
	}
	printf '%s' "$img"
}

# verifier_site_servi <docker> <image node> <verify-site.mjs> <release.json> <domaine> <autorités> :
# verify-site.mjs (copie du dépôt, pas du site) contre https://<domaine>, résolu en 127.0.0.1 :
# chaque fichier du manifeste, ses variantes compressées et le repli monopage, à travers Caddy
# (spec §28.7). Node vient de l'image épinglée du Dockerfile : rien à installer sur la machine.
verifier_site_servi() {
	local docker=$1 node=$2 script=$3 json=$4 domaine=$5 ca=$6
	"$docker" run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
		--log-driver none --user 65532:65532 --add-host "$domaine:127.0.0.1" \
		-v "$script:/v/verify-site.mjs:ro" -v "$json:/v/release.json:ro" -v "$ca:/v/ca.pem:ro" \
		-e NODE_EXTRA_CA_CERTS=/v/ca.pem --entrypoint node "$node" \
		/v/verify-site.mjs "https://$domaine" /v/release.json
}

# empreinte_valide <sha256:…> : forme d'une empreinte d'image (64 chiffres hexadécimaux).
empreinte_valide() {
	[[ $1 =~ ^sha256:[0-9a-f]{64}$ ]]
}

# depot_image_valide <dépôt> : le dépôt d'images est exactement PROVENANCE_IMAGE (deploy/.env ne
# peut pas en désigner un autre). Écrit le problème et rend 1 sinon.
depot_image_valide() {
	[ "$1" = "$PROVENANCE_IMAGE" ] || {
		echo "SHH_IMAGE_REPO=« $1 » refusé : seule l'image signée $PROVENANCE_IMAGE est acceptée (ôter SHH_IMAGE_REPO de deploy/.env, README §3.2)" >&2
		return 1
	}
}

# description_image <x.y.z> <commit> <sha256:…> <SHA-256 de release.json> : écrit image.json, qui
# lie l'image au manifeste du site. Même fonction dans release.yml, qui le signe, et dans
# deploy.sh, qui le recalcule et compare octet pour octet : aucun analyseur JSON ne lit le
# fichier reçu.
description_image() {
	printf '{\n  "schema": 1,\n  "name": "shhdrop-image",\n  "version": "%s",\n  "commit": "%s",\n  "image": "%s@%s",\n  "release.json": "%s"\n}\n' \
		"$1" "$2" "$PROVENANCE_IMAGE" "$3" "$4"
}

# controle_description_image <image.json> <release.json> <x.y.z> <sha256:…> : image.json est
# exactement celui de cette image, de cette version, du commit et des octets de ce release.json.
controle_description_image() {
	local json=$1 manifeste=$2 version=$3 digest=$4 commit attendu ligne
	commit=$(commit_du_manifeste "$manifeste") || return 1
	attendu=$(mktemp)
	description_image "$version" "$commit" "$digest" "$(sha256sum -- "$manifeste" | cut -d' ' -f1)" >"$attendu"
	if cmp -s -- "$attendu" "$json"; then
		rm -f -- "$attendu"
		return 0
	fi
	rm -f -- "$attendu"
	# Pour le message seulement : l'empreinte signée, si la ligne 6 a exactement la forme attendue.
	ligne=$(sed -n '6p' -- "$json")
	if [[ $ligne =~ ^\ \ \"image\":\ \"[a-z0-9./-]+@(sha256:[0-9a-f]{64})\",$ ]] && [ "${BASH_REMATCH[1]}" != "$digest" ]; then
		echo "image refusée : la Release web-v$version a signé l'image ${BASH_REMATCH[1]}, pas $digest" >&2
	else
		echo "image.json de la Release web-v$version ne correspond pas à $PROVENANCE_IMAGE@$digest, au commit $commit et à ce release.json" >&2
	fi
	return 1
}

# verifier_signature_image <cosign> <x.y.z> <sha256:…> : signature sans clé de l'image, lue dans
# le registre, identité et émetteur exacts, journal de transparence exigé.
verifier_signature_image() {
	local cosign=$1 version=$2 digest=$3
	"$cosign" verify "$PROVENANCE_IMAGE@$digest" \
		--certificate-oidc-issuer "$PROVENANCE_EMETTEUR" \
		--certificate-identity "$(identite_release "$version")" >/dev/null || {
		echo "signature refusée : $PROVENANCE_IMAGE@$digest n'est pas signée par release.yml sur l'étiquette web-v$version de $PROVENANCE_DEPOT" >&2
		return 1
	}
}

# verifier_image <cosign> <curl> <sha256:…> <x.y.z> <cache> : AVANT tout téléchargement de
# l'image (deploy.sh),
#   1. release.json, image.json et leurs bundles de la Release web-v<x.y.z> (téléchargés une fois
#      dans <cache>/<x.y.z>/, mis en cache seulement une fois vérifiés, revérifiés à chaque appel) ;
#   2. signatures de release.json et d'image.json : release.yml, étiquette web-v<x.y.z> exactement ;
#   3. image.json lie cette empreinte, cette version, le commit et les octets de release.json ;
#   4. signature de l'image elle-même dans le registre (cosign verify), même identité.
# Rend 0 seulement si tout passe ; écrit chaque refus sur la sortie d'erreur.
verifier_image() {
	local cosign=$1 curl=$2 digest=$3 version=$4 cache=$5 dir tmp src f ok=0
	local fichiers=(release.json release.json.sigstore.json image.json image.json.sigstore.json)
	version_valide "$version" || {
		echo "version refusée : « $version » (x.y.z attendu, étiquette web-v<x.y.z>)" >&2
		return 1
	}
	empreinte_valide "$digest" || {
		echo "empreinte refusée : « $digest » (sha256:<64 chiffres hexadécimaux>)" >&2
		return 1
	}
	dir=$cache/$version
	tmp=$(mktemp -d)
	src=$dir
	for f in "${fichiers[@]}"; do
		[ -f "$dir/$f" ] || src=$tmp
	done
	if [ "$src" = "$tmp" ]; then
		for f in "${fichiers[@]}"; do
			telecharger "$curl" "$(url_release "$version" "$f")" "$tmp/$f" || {
				rm -rf -- "$tmp"
				return 1
			}
		done
	fi
	if verifier_signature "$cosign" "$version" "$src/release.json" "$src/release.json.sigstore.json" &&
		verifier_signature "$cosign" "$version" "$src/image.json" "$src/image.json.sigstore.json" &&
		controle_description_image "$src/image.json" "$src/release.json" "$version" "$digest" &&
		verifier_signature_image "$cosign" "$version" "$digest"; then
		ok=1
		if [ "$src" = "$tmp" ]; then
			mkdir -p -- "$dir"
			for f in "${fichiers[@]}"; do cp -- "$tmp/$f" "$dir/$f"; done
		fi
	fi
	rm -rf -- "$tmp"
	[ "$ok" = 1 ] || {
		echo "image refusée : $PROVENANCE_IMAGE@$digest n'est pas téléchargée" >&2
		return 1
	}
	echo "image : $PROVENANCE_IMAGE@$digest signée par release.yml (web-v$version) et liée à son manifeste signé"
}

# empreinte_oci <image.tar> : écrit l'empreinte (sha256:…) de la seule image d'une archive OCI
# (deploy/construire-image.sh, release.yml) : index.json ne nomme qu'un manifeste, d'image (pas
# d'attestation ni d'autre plateforme), et ce manifeste a bien cette empreinte.
empreinte_oci() {
	local tar=$1 tmp d n
	tmp=$(mktemp -d)
	if ! tar -xf "$tar" -C "$tmp" index.json 2>/dev/null; then
		echo "$tar : index.json absent" >&2
		rm -rf -- "$tmp"
		return 1
	fi
	n=$(grep -oE '"digest": *"sha256:[0-9a-f]{64}"' "$tmp/index.json" | wc -l)
	d=$(grep -oE '"digest": *"sha256:[0-9a-f]{64}"' "$tmp/index.json" | head -n 1 | grep -oE 'sha256:[0-9a-f]{64}' || true)
	if [ "$n" != 1 ] || ! grep -qE '"mediaType": *"application/vnd\.oci\.image\.manifest\.v1\+json", *"digest": *"'"$d"'"' "$tmp/index.json"; then
		echo "$tar : un seul manifeste d'image attendu dans index.json (attestation ou autre plateforme ?)" >&2
		rm -rf -- "$tmp"
		return 1
	fi
	if ! tar -xf "$tar" -C "$tmp" "blobs/sha256/${d#sha256:}" 2>/dev/null ||
		[ "$(sha256sum -- "$tmp/blobs/sha256/${d#sha256:}" | cut -d' ' -f1)" != "${d#sha256:}" ]; then
		echo "$tar : manifeste $d absent ou altéré" >&2
		rm -rf -- "$tmp"
		return 1
	fi
	rm -rf -- "$tmp"
	printf '%s\n' "$d"
}

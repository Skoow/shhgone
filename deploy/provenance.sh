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
# Ce que la vérification prouve : le site de l'image a été construit par release.yml, depuis
# le commit public nommé dans le manifeste (journal public Rekor). Ce qu'elle ne prouve pas :
# que ce code est sain, ni que les deux binaires de l'image (serveur, shhcheck) viennent de ce
# commit (non signés : README §9).

# Dépôt public et identité exacte du signataire. Le nom du dépôt est celui que GitHub inscrit
# dans le certificat (remote du dépôt, 24 novembre : Skoow/shhgone).
readonly PROVENANCE_DEPOT=Skoow/shhgone
readonly PROVENANCE_EMETTEUR=https://token.actions.githubusercontent.com
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

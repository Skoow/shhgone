#!/usr/bin/env bash
# Outils épinglés à la main, hors de portée de Dependabot (spec §24) : signale une version plus
# récente publiée depuis au moins 7 jours (même délai que Dependabot, le temps qu'une version
# piégée soit repérée et retirée). Lancé chaque semaine par .github/workflows/securite.yml ; un
# échec envoie un e-mail au propriétaire. Lecture seule : aucune donnée envoyée, aucun jeton
# requis (GITHUB_TOKEN en lecture seule s'il est présent, pour la limite de l'API GitHub).
#
# Chaque version actuelle est lue dans le fichier qui l'épingle : rien à tenir à jour ici.
#
# Usage : deploy/outils-a-jour.sh          (depuis la racine du dépôt)
# Sortie : 0 à jour ; 1 au moins un outil en retard ; 2 erreur (réseau, réponse illisible).
set -euo pipefail

readonly DELAI_JOURS=7
racine=$(cd "$(dirname "$0")/.." && pwd)
cd "$racine"

en_retard=0
erreur=0
maintenant=$(date -u +%s)

# lire FICHIER REGEX : première capture de REGEX (ERE) dans FICHIER.
lire() {
	local ligne v=""
	ligne=$(grep -m1 -oE "$2" "$1") || true
	if [[ $ligne =~ $2 ]]; then v=${BASH_REMATCH[1]}; fi
	if [ -z "$v" ]; then
		echo "ERREUR : version introuvable dans $1 ($2)" >&2
		return 1
	fi
	printf '%s\n' "$v"
}

# telecharger URL : corps JSON (curl), avec le jeton GitHub pour api.github.com s'il existe.
telecharger() {
	local entetes=(-H "User-Agent: shhgone-outils-a-jour")
	case "$1" in
	https://api.github.com/*)
		entetes+=(-H "Accept: application/vnd.github+json")
		if [ -n "${GITHUB_TOKEN:-}" ]; then entetes+=(-H "Authorization: Bearer $GITHUB_TOKEN"); fi
		;;
	esac
	curl -fsS --max-time 30 --retry 2 "${entetes[@]}" "$1"
}

# comparer NOM ACTUELLE DERNIERE DATE_ISO OU : signale DERNIERE si elle diffère et a plus de
# DELAI_JOURS jours.
comparer() {
	local nom=$1 actuelle=$2 derniere=$3 date=$4 ou=$5 age
	if [ -z "$derniere" ] || [ -z "$date" ]; then
		echo "ERREUR : $nom : réponse illisible" >&2
		erreur=1
		return
	fi
	age=$(((maintenant - $(date -u -d "$date" +%s)) / 86400))
	if [ "$derniere" = "$actuelle" ]; then
		printf '%-14s %-10s à jour\n' "$nom" "$actuelle"
	elif [ "$age" -lt "$DELAI_JOURS" ]; then
		printf '%-14s %-10s %s publiée il y a %s j : attendre %s j\n' "$nom" "$actuelle" "$derniere" "$age" "$DELAI_JOURS"
	else
		printf '%-14s %-10s EN RETARD : %s (publiée le %s) ; épinglée dans %s\n' "$nom" "$actuelle" "$derniere" "${date%%T*}" "$ou"
		en_retard=1
	fi
}

# github NOM DEPOT ACTUELLE OU : dernière version publiée (releases/latest, sans préversion).
github() {
	local json
	if ! json=$(telecharger "https://api.github.com/repos/$2/releases/latest"); then
		echo "ERREUR : $1 : api.github.com injoignable" >&2
		erreur=1
		return
	fi
	comparer "$1" "$3" "$(jq -r '.tag_name // empty' <<<"$json")" "$(jq -r '.published_at // empty' <<<"$json")" "$4"
}

# BuildKit : construction reproductible de l'image (deploy/construire-image.sh).
buildkit=$(lire deploy/construire-image.sh 'moby/buildkit:(v[0-9]+\.[0-9]+\.[0-9]+)')
github buildkit moby/buildkit "$buildkit" deploy/construire-image.sh

# cosign : signature de l'image et des manifestes (release.yml) et vérification (deploy.sh).
cosign=$(lire .github/workflows/release.yml 'cosign/releases/download/(v[0-9]+\.[0-9]+\.[0-9]+)')
github cosign sigstore/cosign "$cosign" ".github/workflows/release.yml, deploy/"

# crane : envoi de l'image vers ghcr.io (release.yml).
crane=$(lire .github/workflows/release.yml 'go-containerregistry/releases/download/(v[0-9]+\.[0-9]+\.[0-9]+)')
github crane google/go-containerregistry "$crane" .github/workflows/release.yml

# govulncheck : recherche des failles Go (ci.yml, securite.yml) ; publié par le proxy Go.
govuln=$(lire .github/workflows/securite.yml 'govulncheck@(v[0-9]+\.[0-9]+\.[0-9]+)')
if json=$(telecharger "https://proxy.golang.org/golang.org/x/vuln/@latest"); then
	comparer govulncheck "$govuln" "$(jq -r '.Version // empty' <<<"$json")" "$(jq -r '.Time // empty' <<<"$json")" ".github/workflows/{ci,securite}.yml"
else
	echo "ERREUR : govulncheck : proxy.golang.org injoignable" >&2
	erreur=1
fi

# cargo-audit : recherche des failles Rust (ci.yml, securite.yml) ; publié sur crates.io.
caudit=$(lire .github/workflows/securite.yml 'cargo-audit --version ([0-9]+\.[0-9]+\.[0-9]+)')
if json=$(telecharger "https://crates.io/api/v1/crates/cargo-audit"); then
	v=$(jq -r '.crate.max_stable_version // empty' <<<"$json")
	d=$(jq -r --arg v "$v" '[.versions[] | select(.num == $v)][0].created_at // empty' <<<"$json")
	comparer cargo-audit "$caudit" "$v" "$d" ".github/workflows/{ci,securite}.yml"
else
	echo "ERREUR : cargo-audit : crates.io injoignable" >&2
	erreur=1
fi

# gosec : analyse de notre code Go (securite.yml) ; publié par le proxy Go.
gosec=$(lire .github/workflows/securite.yml 'gosec/v2/cmd/gosec@(v[0-9]+\.[0-9]+\.[0-9]+)')
if json=$(telecharger "https://proxy.golang.org/github.com/securego/gosec/v2/@latest"); then
	comparer gosec "$gosec" "$(jq -r '.Version // empty' <<<"$json")" "$(jq -r '.Time // empty' <<<"$json")" .github/workflows/securite.yml
else
	echo "ERREUR : gosec : proxy.golang.org injoignable" >&2
	erreur=1
fi

# Semgrep : analyse de notre code (securite.yml) ; publié sur PyPI. (Ses règles, épinglées à un
# commit de semgrep/semgrep-rules, sont remontées à la main avec lui.)
semgrep=$(lire .github/workflows/securite.yml 'semgrep==([0-9]+\.[0-9]+\.[0-9]+)')
if json=$(telecharger "https://pypi.org/pypi/semgrep/json"); then
	v=$(jq -r '.info.version // empty' <<<"$json")
	d=$(jq -r --arg v "$v" '.releases[$v][0].upload_time_iso_8601 // empty' <<<"$json")
	comparer semgrep "$semgrep" "$v" "$d" .github/workflows/securite.yml
else
	echo "ERREUR : semgrep : pypi.org injoignable" >&2
	erreur=1
fi

if [ "$erreur" -ne 0 ]; then exit 2; fi
exit "$en_retard"

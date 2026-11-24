#!/usr/bin/env bash
# Banc d'essai de deploy/provenance.sh (make lint-deploy, job deploy-lint), sans réseau : cosign,
# docker et curl sont remplacés par des imitations. L'imitation de cosign « signe » un manifeste
# en écrivant son SHA-256 et l'identité attendue dans le bundle, et ne « vérifie » que si le
# manifeste, l'identité et l'émetteur sont exactement ceux-là : un manifeste modifié après
# signature, ou signé pour une autre étiquette, est donc refusé comme par le vrai cosign. Ce que
# seul le vrai cosign contrôle (certificat Fulcio, journal Rekor) n'est essayé que par release.yml,
# qui revérifie sa propre signature avec l'identité de deploy.sh.
# Exige Node (release-manifest.mjs : manifeste_de doit en donner les mêmes octets).
# shellcheck disable=SC2016 # motifs cherchés tels quels dans deploy.sh
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
# shellcheck source=deploy/provenance.sh
. "$here/provenance.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}
command -v node >/dev/null || {
	echo "test-provenance : Node introuvable (release-manifest.mjs sert de référence)" >&2
	exit 1
}

V=1.2.3
COMMIT=0123456789abcdef0123456789abcdef01234567

# site <dossier> : un petit site, avec sous-dossiers, variantes compressées, fichier vide, et des
# noms dont l'ordre diffère selon qu'on trie par octets ou autrement (« a-b » avant « a/b »).
site() {
	mkdir -p "$1/assets/a" "$1/fonts"
	printf '<!doctype html><title>t</title>\n' >"$1/index.html"
	printf 'x' | gzip -n >"$1/index.html.gz"
	printf 'console.log(1)\n' >"$1/assets/app-A1.js"
	printf 'b\n' >"$1/assets/a-b.css"
	printf 'c\n' >"$1/assets/a/b.css"
	printf 'B' >"$1/Zeta.txt"
	: >"$1/fonts/vide.woff2"
	printf 'User-agent: *\n' >"$1/robots.txt"
}

# 1. manifeste_de donne exactement les octets de web/scripts/release-manifest.mjs.
site "$work/ref"
node "$repo/web/scripts/release-manifest.mjs" "$work/ref" --name shhdrop-web --version "$V" --commit "$COMMIT" --out "$work/ref-out" >/dev/null
manifeste_de "$work/ref" "$V" "$COMMIT" >"$work/ref-bash.json" || ko "manifeste_de : échec sur un site valide"
cmp -s "$work/ref-out/release.json" "$work/ref-bash.json" ||
	ko "manifeste_de diffère de release-manifest.mjs : $(diff "$work/ref-out/release.json" "$work/ref-bash.json" | head -5)"
[ "$(commit_du_manifeste "$work/ref-out/release.json")" = "$COMMIT" ] || ko "commit_du_manifeste : commit mal lu"

# 2. manifeste_de refuse un lien, un nom à échapper, un dossier vide ou absent.
site "$work/lien"
ln -s index.html "$work/lien/autre.html"
manifeste_de "$work/lien" "$V" "$COMMIT" >/dev/null 2>"$work/lien.err" && ko "lien symbolique accepté"
grep -q "autre.html : ni fichier ordinaire" "$work/lien.err" || ko "lien : message $(cat "$work/lien.err")"
site "$work/nom"
printf 'x' >"$work/nom/a b.js"
manifeste_de "$work/nom" "$V" "$COMMIT" >/dev/null 2>&1 && ko "nom avec espace accepté"
mkdir -p "$work/vide/sous"
manifeste_de "$work/vide" "$V" "$COMMIT" >/dev/null 2>&1 && ko "dossier sans fichier accepté"
manifeste_de "$work/absent" "$V" "$COMMIT" >/dev/null 2>&1 && ko "dossier absent accepté"

# 3. Formes : version, identité exacte, adresse de la Release.
for bonne in 0.0.1 1.2.3 10.20.30; do version_valide "$bonne" || ko "version $bonne refusée"; done
for mauvaise in "" 1.2 1.2.3.4 01.2.3 v1.2.3 "1.2.3 " "1.2.3;x" "1.2.3
4.5.6" ../1.2.3 1.2.3-rc1; do
	version_valide "$mauvaise" && ko "version $(printf '%q' "$mauvaise") acceptée"
done
[ "$(identite_release 1.2.3)" = "https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v1.2.3" ] ||
	ko "identité : $(identite_release 1.2.3)"
[ "$(url_release 1.2.3 release.json)" = "https://github.com/Skoow/shhgone/releases/download/web-v1.2.3/release.json" ] ||
	ko "adresse : $(url_release 1.2.3 release.json)"
# Les constantes ne peuvent pas être remplacées après coup (deploy/.env est lu avant).
(PROVENANCE_DEPOT=autre/depot) 2>/dev/null && ko "PROVENANCE_DEPOT modifiable"

# 4. controle_cosign : empreinte épinglée exigée.
printf '#!/bin/sh\nexit 0\n' >"$work/cosign-x"
chmod +x "$work/cosign-x"
sum=$(sha256sum "$work/cosign-x" | cut -d' ' -f1)
controle_cosign "$work/cosign-x" "$sum" 2>/dev/null || ko "controle_cosign : bonne empreinte refusée"
controle_cosign "$work/cosign-x" "$COSIGN_SHA256" 2>/dev/null && ko "controle_cosign : autre binaire accepté"
controle_cosign "" "$sum" 2>/dev/null && ko "controle_cosign : binaire absent accepté"
controle_cosign "$work/nulle-part" "$sum" 2>/dev/null && ko "controle_cosign : chemin absent accepté"
[[ $COSIGN_SHA256 =~ ^[0-9a-f]{64}$ ]] || ko "COSIGN_SHA256 hors format"
grep -qF "$COSIGN_SHA256" "$here/README.md" || ko "README : empreinte de cosign absente"
grep -qF "cosign/releases/download/$COSIGN_VERSION/cosign-linux-amd64" "$here/README.md" || ko "README : adresse de cosign $COSIGN_VERSION absente"
for wf in release.yml verifier-site.yml; do
	grep -qF "$COSIGN_SHA256" "$repo/.github/workflows/$wf" || ko "$wf : autre empreinte de cosign que deploy/provenance.sh"
	grep -qF "download/$COSIGN_VERSION/" "$repo/.github/workflows/$wf" || ko "$wf : autre version de cosign que deploy/provenance.sh"
done

# Imitations. cosign : « verify-blob <fichier> --bundle <b> --certificate-oidc-issuer <é>
# --certificate-identity <i> », rien d'autre ; le bundle contient « <sha256 du fichier> <identité> ».
cat >"$work/cosign" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAUX_JOURNAL"
[ "$#" = 8 ] && [ "$1" = verify-blob ] && [ "$3" = --bundle ] && [ "$5" = --certificate-oidc-issuer ] &&
	[ "$6" = https://token.actions.githubusercontent.com ] && [ "$7" = --certificate-identity ] || exit 9
[ "$(cat "$4")" = "$(sha256sum "$2" | cut -d' ' -f1) $8" ] || { echo "Error: none of the expected identities matched" >&2; exit 1; }
echo "Verified OK" >&2
EOF
# docker : « create <image> » rend un identifiant, « cp <id>:/site <dest> » copie $FAUX_SITE.
cat >"$work/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAUX_JOURNAL"
case $1 in
create) [ "$2" = "$FAUX_IMAGE" ] && echo c0ffee || exit 1 ;;
cp) [ "$2" = c0ffee:/site ] && cp -a "$FAUX_SITE" "$3" ;;
rm) [ "$2" = c0ffee ] ;;
run) exit "${FAUX_RUN:-0}" ;;
*) exit 2 ;;
esac
EOF
# curl : sert $FAUX_RELEASE/<fichier> pour l'adresse de la Release, et note l'appel.
cat >"$work/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAUX_JOURNAL"
url=${!#} out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
case $url in
https://github.com/Skoow/shhgone/releases/download/web-v*/*) f=$FAUX_RELEASE/${url##*/}; [ -f "$f" ] && cp "$f" "$out" || exit 22 ;;
*) exit 6 ;;
esac
EOF
chmod +x "$work/cosign" "$work/docker" "$work/curl"
export FAUX_JOURNAL=$work/journal FAUX_IMAGE=depot/shhdrop@sha256:aaaa FAUX_SITE FAUX_RELEASE FAUX_RUN

# publie <version> <site> : release.json signé (imitation) dans $work/rel-<version>.
publie() {
	FAUX_RELEASE=$work/rel-$1
	mkdir -p "$FAUX_RELEASE"
	node "$repo/web/scripts/release-manifest.mjs" "$2" --name shhdrop-web --version "$1" --commit "$COMMIT" --out "$FAUX_RELEASE" >/dev/null
	printf '%s %s' "$(sha256sum "$FAUX_RELEASE/release.json" | cut -d' ' -f1)" "$(identite_release "$1")" >"$FAUX_RELEASE/release.json.sigstore.json"
}
# essai <nom> <version> : verifier_provenance avec les imitations ; code dans $work/<nom>.code.
essai() {
	: >"$FAUX_JOURNAL"
	local code=0
	verifier_provenance "$work/cosign" "$work/docker" "$work/curl" "$FAUX_IMAGE" "$2" "$work/cache-$1" >"$work/$1.out" 2>"$work/$1.err" || code=$?
	echo "$code" >"$work/$1.code"
}
refuse() { # <nom> <motif attendu dans la sortie d'erreur>
	[ "$(cat "$work/$1.code")" != 0 ] || ko "$1 : accepté"
	grep -q -- "$2" "$work/$1.err" || ko "$1 : message attendu « $2 », obtenu : $(cat "$work/$1.err")"
	[ ! -e "$work/cache-$1/$V/release.json" ] || [ "${3:-}" = garde ] || ko "$1 : manifeste refusé mis en cache"
}

# 5. Tout est conforme : accepté, appels exacts, manifeste mis en cache.
site "$work/bon"
FAUX_SITE=$work/bon
publie "$V" "$work/bon"
essai bon "$V"
[ "$(cat "$work/bon.code")" = 0 ] || ko "bon : refusé ($(cat "$work/bon.err"))"
grep -q "conforme au manifeste signé web-v$V ($COMMIT)" "$work/bon.out" || ko "bon : sortie $(cat "$work/bon.out")"
grep -qx -- "verify-blob .*/release.json --bundle .*/release.json.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$V" "$FAUX_JOURNAL" ||
	ko "bon : appel de cosign inattendu : $(grep verify-blob "$FAUX_JOURNAL")"
grep -qE -- "--proto =https --proto-redir =https .*--max-filesize $PROVENANCE_MAX_OCTETS .* https://github.com/Skoow/shhgone/releases/download/web-v$V/release.json\$" "$FAUX_JOURNAL" ||
	ko "bon : appel de curl inattendu : $(grep -- -fsSL "$FAUX_JOURNAL" | head -1)"
grep -q -- "regexp\|insecure" "$FAUX_JOURNAL" && ko "bon : option ouverte passée à cosign"
cmp -s "$work/cache-bon/$V/release.json" "$FAUX_RELEASE/release.json" || ko "bon : manifeste absent du cache"
# Deuxième passage : rien n'est retéléchargé, mais la signature est revérifiée.
: >"$FAUX_JOURNAL"
verifier_provenance "$work/cosign" "$work/docker" "$work/curl" "$FAUX_IMAGE" "$V" "$work/cache-bon" >/dev/null 2>&1 || ko "bon : refusé au deuxième passage"
grep -q -- -fsSL "$FAUX_JOURNAL" && ko "bon : retéléchargé alors qu'en cache"
grep -q verify-blob "$FAUX_JOURNAL" || ko "bon : signature non revérifiée depuis le cache"
# Manifeste du cache modifié après coup : la signature ne correspond plus.
cp -r "$work/cache-bon" "$work/cache-altere"
sed -i 's/"size": 1,/"size": 2,/' "$work/cache-altere/$V/release.json"
: >"$FAUX_JOURNAL"
code=0
verifier_provenance "$work/cosign" "$work/docker" "$work/curl" "$FAUX_IMAGE" "$V" "$work/cache-altere" >/dev/null 2>"$work/altere.err" || code=$?
[ "$code" != 0 ] || ko "cache altéré : accepté"
grep -q "signature refusée" "$work/altere.err" || ko "cache altéré : $(cat "$work/altere.err")"

# 6. Signature refusée : manifeste modifié après signature (une empreinte changée).
publie "$V" "$work/bon"
sed -i '0,/"sha256": "[0-9a-f]\{64\}"/s//"sha256": "'"$(printf '0%.0s' {1..64})"'"/' "$FAUX_RELEASE/release.json"
essai modifie "$V"
refuse modifie "signature refusée"

# 7. Manifeste signé pour une autre étiquette (1.2.2), présenté comme 1.2.3.
publie 1.2.2 "$work/bon"
mkdir -p "$work/rel-mal"
cp "$work/rel-1.2.2/"* "$work/rel-mal/"
FAUX_RELEASE=$work/rel-mal
essai autre-etiquette "$V"
refuse autre-etiquette "signature refusée"

# 8. Signé, mais le site de l'image diffère : fichier modifié, en plus, en moins, lien.
publie "$V" "$work/bon"
for cas in modifie plus moins lien; do
	rm -rf "$work/img-$cas"
	cp -a "$work/bon" "$work/img-$cas"
	case $cas in
	modifie) printf 'console.log(2)\n' >"$work/img-$cas/assets/app-A1.js" ;;
	plus) printf 'x' >"$work/img-$cas/assets/espion.js" ;;
	moins) rm "$work/img-$cas/robots.txt" ;;
	lien) ln -s /etc/passwd "$work/img-$cas/assets/lien.js" ;;
	esac
	FAUX_SITE=$work/img-$cas
	essai "site-$cas" "$V"
	case $cas in
	lien) refuse "site-$cas" "ni fichier ordinaire" ;;
	*) refuse "site-$cas" "n'est pas celui du manifeste signé" ;;
	esac
done
grep -q '^+.*espion.js' "$work/site-plus.err" || ko "site-plus : écart non montré"
FAUX_SITE=$work/bon

# 9. Version hors format : rien n'est demandé à personne.
essai version-mal "1.2.3/../../x"
refuse version-mal "version refusée"
[ ! -s "$FAUX_JOURNAL" ] || ko "version-mal : commandes lancées : $(cat "$FAUX_JOURNAL")"

# 10. Release absente (téléchargement impossible) ; image introuvable.
FAUX_RELEASE=$work/nulle-part
essai absente 9.9.9
refuse absente "téléchargement impossible"
publie "$V" "$work/bon"
verifier_provenance "$work/cosign" "$work/docker" "$work/curl" depot/inconnue@sha256:cccc "$V" "$work/cache-image" >/dev/null 2>"$work/image.err" &&
	ko "image introuvable : acceptée"
grep -q "image introuvable" "$work/image.err" || ko "image introuvable : $(cat "$work/image.err")"
[ ! -e "$work/cache-image/$V" ] || ko "image introuvable : manifeste mis en cache"

# 11. verify-site à travers Caddy : arguments de docker run ; un échec est rendu.
printf 'FROM rust AS a\nFROM node:26.13.0-alpine@sha256:%s AS web\n' "$(printf 'a%.0s' {1..64})" >"$work/Dockerfile"
node_img=$(image_node "$work/Dockerfile") || ko "image_node : introuvable"
[ "$node_img" = "node:26.13.0-alpine@sha256:$(printf 'a%.0s' {1..64})" ] || ko "image_node : $node_img"
image_node "$repo/deploy/Dockerfile" >/dev/null || ko "image_node : rien dans deploy/Dockerfile"
printf 'FROM node:1@sha256:%s\nFROM node:2@sha256:%s\n' "$(printf 'b%.0s' {1..64})" "$(printf 'c%.0s' {1..64})" >"$work/Dockerfile2"
image_node "$work/Dockerfile2" >/dev/null 2>&1 && ko "image_node : deux images acceptées"
: >"$FAUX_JOURNAL"
verifier_site_servi "$work/docker" "$node_img" /r/web/scripts/verify-site.mjs /c/release.json exemple.test /ca.pem || ko "verify-site : échec inattendu"
grep -qx -- "run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true --log-driver none --user 65532:65532 --add-host exemple.test:127.0.0.1 -v /r/web/scripts/verify-site.mjs:/v/verify-site.mjs:ro -v /c/release.json:/v/release.json:ro -v /ca.pem:/v/ca.pem:ro -e NODE_EXTRA_CA_CERTS=/v/ca.pem --entrypoint node $node_img /v/verify-site.mjs https://exemple.test /v/release.json" "$FAUX_JOURNAL" ||
	ko "verify-site : appel $(cat "$FAUX_JOURNAL")"
FAUX_RUN=1 verifier_site_servi "$work/docker" "$node_img" /s /j exemple.test /ca && ko "verify-site : échec non rendu"

# 12. deploy.sh : la provenance est vérifiée avant tout démarrage, sans option pour la sauter, et
#     verify-site fait partie du contrôle (donc du retour arrière).
d=$here/deploy.sh
ligne() { grep -n -m1 -- "$1" "$d" | cut -d: -f1; }
p=$(ligne 'verifier_provenance "$cosign"')
u=$(ligne 'dc "$new" up -d --remove-orphans')
[ -n "$p" ] && [ -n "$u" ] && [ "$p" -lt "$u" ] || ko "deploy.sh : verifier_provenance absent ou après le démarrage"
grep -q 'controle_cosign "$cosign" "$COSIGN_SHA256"' "$d" || ko "deploy.sh : cosign non contrôlé par son empreinte"
grep -q 'verifier_site_servi docker' "$d" || ko "deploy.sh : verify-site absent du contrôle"
grep -qiE -- '--(no|skip|sans)-?(verif|provenance)|SHH_(SKIP|SANS)_|PROVENANCE=0' "$d" && ko "deploy.sh : option pour sauter la vérification"
grep -qE '^\. \./provenance\.sh' "$d" || ko "deploy.sh : provenance.sh non chargé"
e=$(ligne '^\. \./\.env')
l=$(ligne '^\. \./provenance\.sh')
[ -n "$e" ] && [ -n "$l" ] && [ "$e" -lt "$l" ] || ko "deploy.sh : provenance.sh chargé avant deploy/.env (constantes remplaçables)"

if [ "$echec" = 0 ]; then
	echo "test-provenance : tous les essais passent"
else
	exit 1
fi

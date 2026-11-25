#!/usr/bin/env bash
# Banc d'essai de deploy/provenance.sh (make lint-deploy, job deploy-lint), sans réseau : cosign,
# docker et curl sont remplacés par des imitations. L'imitation de cosign « signe » un manifeste
# en écrivant son SHA-256 et l'identité attendue dans le bundle, et ne « vérifie » que si le
# manifeste, l'identité et l'émetteur sont exactement ceux-là : un manifeste modifié après
# signature, ou signé pour une autre étiquette, est donc refusé comme par le vrai cosign. Ce que
# seul le vrai cosign contrôle (certificat Fulcio, journal Rekor) n'est essayé que par release.yml,
# qui revérifie sa propre signature avec l'identité de deploy.sh.
# Exige Node (release-manifest.mjs : manifeste_de doit en donner les mêmes octets).
# shellcheck disable=SC2016,SC2030,SC2031 # motifs cherchés tels quels dans deploy.sh ; constantes
# essayées en lecture seule dans un sous-shell
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
# --certificate-identity <i> », le bundle contenant « <sha256 du fichier> <identité> » ; ou
# « verify <image> --certificate-oidc-issuer <é> --certificate-identity <i> », la signature de
# l'image étant une ligne « <image> <identité> » de $FAUX_SIGNATURES (le registre). Rien d'autre.
cat >"$work/cosign" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAUX_JOURNAL"
if [ "$1" = verify ]; then
	[ "$#" = 6 ] && [ "$3" = --certificate-oidc-issuer ] && [ "$4" = https://token.actions.githubusercontent.com ] &&
		[ "$5" = --certificate-identity ] || exit 9
	grep -qxF -- "$2 $6" "$FAUX_SIGNATURES" 2>/dev/null || { echo "Error: no matching signatures" >&2; exit 1; }
	echo '[{"critical":{"identity":{"docker-reference":"x"}}}]'
	exit 0
fi
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
export FAUX_JOURNAL=$work/journal FAUX_IMAGE=depot/shhdrop@sha256:aaaa FAUX_SITE FAUX_RELEASE FAUX_RUN FAUX_SIGNATURES=$work/signatures

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
grep -qx -- "run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true --log-driver none --user 65532:65532 --add-host exemple.test:127.0.0.1 -v /r/web/scripts/verify-site.mjs:/v/verify-site.mjs:ro -v /c/release.json:/v/release.json:ro -v /ca.pem:/v/ca.pem:ro -e NODE_EXTRA_CA_CERTS=/v/ca.pem -e SHH_PREPROD_JETON --entrypoint node $node_img /v/verify-site.mjs https://exemple.test /v/release.json" "$FAUX_JOURNAL" ||
	ko "verify-site : appel $(cat "$FAUX_JOURNAL")"
FAUX_RUN=1 verifier_site_servi "$work/docker" "$node_img" /s /j exemple.test /ca && ko "verify-site : échec non rendu"

# 12. deploy.sh : la provenance est vérifiée avant tout démarrage (mettre_en_service, commun.sh),
#     sans option pour la sauter, et verify-site fait partie du contrôle (donc du retour arrière).
#     Réglages de deploy/.env, contrôle et démarrage : deploy/commun.sh, partagé avec preprod.sh.
d=$here/deploy.sh
com=$here/commun.sh
ligne() { grep -n -m1 -- "$1" "$d" | cut -d: -f1; }
lignec() { grep -n -m1 -- "$1" "$com" | cut -d: -f1; }
p=$(ligne 'verifier_provenance "$cosign"')
u=$(ligne 'mettre_en_service "$new" "$new_v" "$new_c" "$mode"')
[ -n "$p" ] && [ -n "$u" ] && [ "$p" -lt "$u" ] || ko "deploy.sh : verifier_provenance absent ou après le démarrage"
if [ "$(cat "$d" "$com" "$here/preprod.sh" | grep -c 'dc "$new" up -d --remove-orphans')" != 1 ] ||
	! grep -q 'dc "$new" up -d --remove-orphans' "$com"; then
	ko "commun.sh : démarrage ailleurs que dans mettre_en_service"
fi
grep -q '^\. \./commun\.sh$' "$d" || ko "deploy.sh : commun.sh non chargé"
grep -q 'controle_cosign "$cosign" "$COSIGN_SHA256"' "$d" || ko "deploy.sh : cosign non contrôlé par son empreinte"
grep -q 'verifier_site_servi docker' "$com" || ko "commun.sh : verify-site absent du contrôle"
grep -qiE -- '--(no|skip|sans)-?(verif|provenance)|SHH_(SKIP|SANS)_|PROVENANCE=0' "$d" "$com" "$here/preprod.sh" && ko "deploy.sh : option pour sauter la vérification"
grep -qE '^\. \./provenance\.sh' "$com" || ko "commun.sh : provenance.sh non chargé"
e=$(lignec '^\. \./\.env')
l=$(lignec '^\. \./provenance\.sh')
[ -n "$e" ] && [ -n "$l" ] && [ "$e" -lt "$l" ] || ko "commun.sh : provenance.sh chargé avant deploy/.env (constantes remplaçables)"
# preprod.sh n'emploie ni cosign ni l'image de la Release, et deploy.sh n'installe jamais une
# image de préproduction.
grep -qE 'cosign|verifier_image|docker pull' "$here/preprod.sh" && ko "preprod.sh : chemin de la Release mêlé à la préproduction"
if ! grep -q 'preprod:\*)$' "$d" || ! grep -q 'deploy/preprod.sh \${1#preprod:}' "$d"; then
	ko "deploy.sh : une image de préproduction n'est pas renvoyée à preprod.sh"
fi

# 13. Image : dépôt imposé, empreinte, image.json (forme exacte).
[ "$PROVENANCE_IMAGE" = ghcr.io/skoow/shhgone ] || ko "PROVENANCE_IMAGE : $PROVENANCE_IMAGE"
(PROVENANCE_IMAGE=ghcr.io/autre/image) 2>/dev/null && ko "PROVENANCE_IMAGE modifiable"
depot_image_valide ghcr.io/skoow/shhgone || ko "dépôt ghcr.io/skoow/shhgone refusé"
for mauvais in "" ghcr.io/Skoow/shhgone ghcr.io/skoow/shhgone/ "ghcr.io/skoow/shhgone " ghcr.io/skoow/shhgone:latest \
	docker.io/skoow/shhgone registre.example/shhdrop ghcr.io/skoow/shhgonex ghcr.io/skoow/autre; do
	depot_image_valide "$mauvais" 2>/dev/null && ko "dépôt d'images $(printf '%q' "$mauvais") accepté"
done
depot_image_valide registre.example/shhdrop 2>"$work/depot.err" || true
grep -q "seule l'image signée ghcr.io/skoow/shhgone" "$work/depot.err" || ko "dépôt refusé : message $(cat "$work/depot.err")"
D=sha256:$(printf 'd%.0s' {1..64})
D2=sha256:$(printf 'e%.0s' {1..64})
empreinte_valide "$D" || ko "empreinte valide refusée"
for mauvaise in "" "${D#sha256:}" "sha256:abc" "$D " "sha512:${D#sha256:}" "$(printf '%s' "$D" | tr d D)" "$D
$D2"; do
	empreinte_valide "$mauvaise" && ko "empreinte $(printf '%q' "$mauvaise") acceptée"
done
description_image 1.2.3 "$COMMIT" "$D" "$(printf 'f%.0s' {1..64})" >"$work/image-ref.json"
printf '{\n  "schema": 1,\n  "name": "shhdrop-image",\n  "version": "1.2.3",\n  "commit": "%s",\n  "image": "ghcr.io/skoow/shhgone@%s",\n  "release.json": "%s"\n}\n' \
	"$COMMIT" "$D" "$(printf 'f%.0s' {1..64})" | cmp -s - "$work/image-ref.json" || ko "description_image : forme $(cat "$work/image-ref.json")"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (j.image !== "ghcr.io/skoow/shhgone@" + process.argv[2] || j.version !== "1.2.3") process.exit(1)' "$work/image-ref.json" "$D" ||
	ko "description_image : JSON invalide"

# 14. verifier_image : signatures de release.json, d'image.json et de l'image, liaison exacte.
# publie_image <version> <empreinte> [<version signée>] : image.json pour le release.json de
# $FAUX_RELEASE, signé (imitation) pour l'étiquette <version signée> (défaut : <version>).
publie_image() {
	description_image "$1" "$(commit_du_manifeste "$FAUX_RELEASE/release.json")" "$2" "$(sha256sum "$FAUX_RELEASE/release.json" | cut -d' ' -f1)" >"$FAUX_RELEASE/image.json"
	printf '%s %s' "$(sha256sum "$FAUX_RELEASE/image.json" | cut -d' ' -f1)" "$(identite_release "${3:-$1}")" >"$FAUX_RELEASE/image.json.sigstore.json"
}
signe_image() { # <empreinte> <version> : signature de l'image dans le « registre »
	printf '%s@%s %s\n' "$PROVENANCE_IMAGE" "$1" "$(identite_release "$2")" >>"$FAUX_SIGNATURES"
}
essai_image() { # <nom> <empreinte> <version>
	: >"$FAUX_JOURNAL"
	local code=0
	verifier_image "$work/cosign" "$work/curl" "$2" "$3" "$work/cimg-$1" >"$work/$1.out" 2>"$work/$1.err" || code=$?
	echo "$code" >"$work/$1.code"
}
refuse_image() { # <nom> <motif>
	[ "$(cat "$work/$1.code")" != 0 ] || ko "$1 : accepté"
	grep -q -- "$2" "$work/$1.err" || ko "$1 : message attendu « $2 », obtenu : $(cat "$work/$1.err")"
	[ ! -e "$work/cimg-$1/$V" ] || ko "$1 : fichiers refusés mis en cache"
}
publie "$V" "$work/bon"
publie_image "$V" "$D"
: >"$FAUX_SIGNATURES"
signe_image "$D" "$V"
essai_image img-bon "$D" "$V"
[ "$(cat "$work/img-bon.code")" = 0 ] || ko "img-bon : refusé ($(cat "$work/img-bon.err"))"
grep -q "ghcr.io/skoow/shhgone@$D signée par release.yml (web-v$V)" "$work/img-bon.out" || ko "img-bon : sortie $(cat "$work/img-bon.out")"
grep -q "docker-reference" "$work/img-bon.out" && ko "img-bon : sortie JSON de cosign verify affichée"
grep -qx -- "verify ghcr.io/skoow/shhgone@$D --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$V" "$FAUX_JOURNAL" ||
	ko "img-bon : appel de cosign verify inattendu : $(grep '^verify ' "$FAUX_JOURNAL")"
grep -qx -- "verify-blob .*/image.json --bundle .*/image.json.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/Skoow/shhgone/.github/workflows/release.yml@refs/tags/web-v$V" "$FAUX_JOURNAL" ||
	ko "img-bon : image.json non vérifié par cosign"
grep -qE -- "--proto =https .* https://github.com/Skoow/shhgone/releases/download/web-v$V/image.json.sigstore.json\$" "$FAUX_JOURNAL" ||
	ko "img-bon : bundle d'image.json non téléchargé de la Release"
grep -q -- "regexp\|insecure" "$FAUX_JOURNAL" && ko "img-bon : option ouverte passée à cosign"
for f in release.json release.json.sigstore.json image.json image.json.sigstore.json; do
	cmp -s "$work/cimg-img-bon/$V/$f" "$FAUX_RELEASE/$f" || ko "img-bon : $f absent du cache"
done
# Deuxième passage : rien n'est retéléchargé, tout est revérifié.
: >"$FAUX_JOURNAL"
verifier_image "$work/cosign" "$work/curl" "$D" "$V" "$work/cimg-img-bon" >/dev/null 2>&1 || ko "img-bon : refusé au deuxième passage"
grep -q -- -fsSL "$FAUX_JOURNAL" && ko "img-bon : retéléchargé alors qu'en cache"
[ "$(grep -c '^verify' "$FAUX_JOURNAL")" = 3 ] || ko "img-bon : signatures non revérifiées depuis le cache ($(cat "$FAUX_JOURNAL"))"
# Puis verifier_provenance (site) se sert du même cache, sans rien télécharger.
: >"$FAUX_JOURNAL"
verifier_provenance "$work/cosign" "$work/docker" "$work/curl" "$FAUX_IMAGE" "$V" "$work/cimg-img-bon" >/dev/null 2>&1 || ko "img-bon : provenance du site refusée après verifier_image"
grep -q -- -fsSL "$FAUX_JOURNAL" && ko "img-bon : release.json retéléchargé par verifier_provenance"

# Cache laissé par une installation d'avant image.json (release.json seul) : tout est téléchargé.
cp -r "$work/cache-bon" "$work/cimg-ancien-cache"
[ ! -e "$work/cimg-ancien-cache/$V/image.json" ] || ko "ancien-cache : cas d'essai faux"
essai_image ancien-cache "$D" "$V"
[ "$(cat "$work/ancien-cache.code")" = 0 ] || ko "ancien-cache : refusé ($(cat "$work/ancien-cache.err"))"
cmp -s "$work/cimg-ancien-cache/$V/image.json" "$FAUX_RELEASE/image.json" || ko "ancien-cache : image.json non mis en cache"

# Signature de l'image absente du registre, ou d'une autre étiquette.
: >"$FAUX_SIGNATURES"
essai_image img-sans-signature "$D" "$V"
refuse_image img-sans-signature "signature refusée : ghcr.io/skoow/shhgone@$D n'est pas signée par release.yml sur l'étiquette web-v$V"
signe_image "$D" 1.2.2
essai_image img-autre-identite "$D" "$V"
refuse_image img-autre-identite "signature refusée : ghcr.io/skoow/shhgone@$D"
# Une autre image signée pour cette étiquette, mais pas celle d'image.json.
: >"$FAUX_SIGNATURES"
signe_image "$D" "$V"
signe_image "$D2" "$V"
essai_image img-empreinte "$D2" "$V"
refuse_image img-empreinte "la Release web-v$V a signé l'image $D, pas $D2"
grep -q "^verify ghcr" "$FAUX_JOURNAL" && ko "img-empreinte : signature de l'image demandée avant la liaison"
# image.json modifié après signature (empreinte remplacée).
publie_image "$V" "$D"
sed -i "s/${D#sha256:}/${D2#sha256:}/" "$FAUX_RELEASE/image.json"
essai_image img-modifie "$D2" "$V"
refuse_image img-modifie "signature refusée : .*image.json"
# image.json signé, mais pour un autre release.json (un fichier de plus dans le site).
site "$work/autre-site"
printf 'x' >"$work/autre-site/autre.js"
publie "$V" "$work/autre-site"
cp "$FAUX_RELEASE/release.json" "$work/release-autre.json"
publie "$V" "$work/bon"
cp "$FAUX_RELEASE/release.json" "$work/release-bon.json"
cp "$work/release-autre.json" "$FAUX_RELEASE/release.json"
publie_image "$V" "$D"
cp "$work/release-bon.json" "$FAUX_RELEASE/release.json"
printf '%s %s' "$(sha256sum "$FAUX_RELEASE/release.json" | cut -d' ' -f1)" "$(identite_release "$V")" >"$FAUX_RELEASE/release.json.sigstore.json"
essai_image img-autre-manifeste "$D" "$V"
refuse_image img-autre-manifeste "ne correspond pas à ghcr.io/skoow/shhgone@$D"
# image.json signé pour une autre étiquette ; image.json d'une autre version re-signé pour celle-ci.
publie "$V" "$work/bon"
publie_image "$V" "$D" 1.2.2
essai_image img-json-autre-etiquette "$D" "$V"
refuse_image img-json-autre-etiquette "signature refusée : .*image.json"
publie_image 1.2.2 "$D" "$V"
essai_image img-json-autre-version "$D" "$V"
refuse_image img-json-autre-version "ne correspond pas"
# Release sans image.json (publiée avant ce changement) : rien n'est installé.
publie "$V" "$work/bon"
rm -f "$FAUX_RELEASE/image.json" "$FAUX_RELEASE/image.json.sigstore.json"
essai_image img-absent "$D" "$V"
refuse_image img-absent "téléchargement impossible : .*image.json"
# Empreinte ou version hors format : rien n'est demandé à personne.
publie_image "$V" "$D"
for mauvaise in "${D#sha256:}" "sha256:abc" "$D;x"; do
	essai_image img-forme "$mauvaise" "$V"
	refuse_image img-forme "empreinte refusée"
	[ ! -s "$FAUX_JOURNAL" ] || ko "img-forme : commandes lancées : $(cat "$FAUX_JOURNAL")"
done
essai_image img-version "$D" "1.2"
refuse_image img-version "version refusée"
[ ! -s "$FAUX_JOURNAL" ] || ko "img-version : commandes lancées"
# Cache altéré après coup : refusé (signature d'image.json revérifiée).
essai_image img-cache "$D" "$V"
[ "$(cat "$work/img-cache.code")" = 0 ] || ko "img-cache : refusé ($(cat "$work/img-cache.err"))"
sed -i "s/${D#sha256:}/${D2#sha256:}/" "$work/cimg-img-cache/$V/image.json"
code=0
verifier_image "$work/cosign" "$work/curl" "$D2" "$V" "$work/cimg-img-cache" >/dev/null 2>"$work/img-cache2.err" || code=$?
[ "$code" != 0 ] || ko "img-cache : image.json du cache altéré accepté"

# 15. empreinte_oci : la seule image d'une archive OCI, manifeste présent et intact.
oci() { # <dossier> <index.json> : archive $work/<dossier>.tar
	(cd "$work/$1" && printf '%s' "$2" >index.json && printf '{"imageLayoutVersion":"1.0.0"}' >oci-layout && tar -cf "$work/$1.tar" index.json oci-layout blobs)
}
mkdir -p "$work/oci/blobs/sha256"
printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}' >"$work/m.json"
hm=$(sha256sum "$work/m.json" | cut -d' ' -f1)
cp "$work/m.json" "$work/oci/blobs/sha256/$hm"
entree='{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:'$hm'","size":80,"platform":{"architecture":"amd64","os":"linux"}}'
oci oci '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":['"$entree"']}'
[ "$(empreinte_oci "$work/oci.tar")" = "sha256:$hm" ] || ko "empreinte_oci : $(empreinte_oci "$work/oci.tar" 2>&1)"
oci oci '{"schemaVersion":2,"manifests":['"$entree"','"$entree"']}'
empreinte_oci "$work/oci.tar" >/dev/null 2>&1 && ko "empreinte_oci : deux manifestes acceptés"
oci oci '{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"sha256:'"$hm"'","size":80}]}'
empreinte_oci "$work/oci.tar" >/dev/null 2>&1 && ko "empreinte_oci : index (attestations) accepté"
printf 'x' >>"$work/oci/blobs/sha256/$hm"
oci oci '{"schemaVersion":2,"manifests":['"$entree"']}'
empreinte_oci "$work/oci.tar" >/dev/null 2>&1 && ko "empreinte_oci : manifeste altéré accepté"
rm "$work/oci/blobs/sha256/$hm"
oci oci '{"schemaVersion":2,"manifests":['"$entree"']}'
empreinte_oci "$work/oci.tar" >/dev/null 2>&1 && ko "empreinte_oci : manifeste absent accepté"
empreinte_oci "$work/nulle-part.tar" >/dev/null 2>&1 && ko "empreinte_oci : archive absente acceptée"

# 16. construire-image.sh, avec une imitation de docker : BuildKit épinglé, options de la
#     reproductibilité, identifiants tirés du commit, arbre propre exigé.
cr=$work/cr
mkdir -p "$cr/deploy" "$work/bin"
cp "$here/construire-image.sh" "$here/provenance.sh" "$cr/deploy/"
printf 'FROM scratch\n' >"$cr/deploy/Dockerfile"
git -C "$cr" init -q
git -C "$cr" add deploy
GIT_COMMITTER_DATE=@1790000000 git -C "$cr" -c user.name=t -c user.email=t@example.test commit -q --no-gpg-sign --date=@1790000000 -m image
cp "$work/m.json" "$work/oci/blobs/sha256/$hm"
oci oci '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":['"$entree"']}'
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s | SHH_BUILD_ID=%s SOURCE_DATE_EPOCH=%s\n' "$*" "${SHH_BUILD_ID:-}" "${SOURCE_DATE_EPOCH:-}" >>"$FAUX_JOURNAL"
[ "$1" = buildx ] || exit 2
case $2 in
rm | create) exit 0 ;;
build)
	for a in "$@"; do
		case $a in type=oci,dest=*) d=${a#type=oci,dest=}; cp "$FAUX_OCI" "${d%%,*}" ;; esac
	done
	;;
*) exit 2 ;;
esac
EOF
chmod +x "$work/bin/docker"
: >"$FAUX_JOURNAL"
FAUX_OCI=$work/oci.tar PATH=$work/bin:$PATH "$cr/deploy/construire-image.sh" "$work/sortie" >"$work/cr.out" 2>&1 || ko "construire-image : échec ($(cat "$work/cr.out"))"
[ "$(cat "$work/sortie/empreinte" 2>/dev/null)" = "sha256:$hm" ] || ko "construire-image : empreinte écrite $(cat "$work/sortie/empreinte" 2>&1)"
cid=$(git -C "$cr" rev-parse --short=7 HEAD)
grep -qx -- "buildx create --name shhdrop-repro --driver docker-container --driver-opt image=moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe --bootstrap | .*" "$FAUX_JOURNAL" ||
	ko "construire-image : BuildKit non épinglé ($(grep create "$FAUX_JOURNAL"))"
grep -qx -- "buildx build --builder shhdrop-repro -f deploy/Dockerfile --build-arg SHH_BUILD_ID --build-arg SOURCE_DATE_EPOCH --platform linux/amd64 --provenance=false --sbom=false --output type=oci,dest=$work/sortie/image.tar,rewrite-timestamp=true . | SHH_BUILD_ID=$cid SOURCE_DATE_EPOCH=1790000000" "$FAUX_JOURNAL" ||
	ko "construire-image : build inattendu ($(grep ' build ' "$FAUX_JOURNAL"))"
[ "$(grep -c '^buildx rm shhdrop-repro' "$FAUX_JOURNAL")" = 2 ] || ko "construire-image : constructeur non recréé"
grep -q "ghcr.io/skoow/shhgone@sha256:$hm" "$work/cr.out" || ko "construire-image : sortie $(cat "$work/cr.out")"
printf '# modifié\n' >>"$cr/deploy/Dockerfile"
: >"$FAUX_JOURNAL"
FAUX_OCI=$work/oci.tar PATH=$work/bin:$PATH "$cr/deploy/construire-image.sh" "$work/sortie2" >"$work/cr2.out" 2>&1 && ko "construire-image : arbre modifié accepté"
grep -q "fichiers suivis modifiés" "$work/cr2.out" || ko "construire-image : arbre modifié, message $(cat "$work/cr2.out")"
grep -q build "$FAUX_JOURNAL" && ko "construire-image : build lancé sur un arbre modifié"
git -C "$cr" checkout -q -- deploy/Dockerfile
printf '{"schemaVersion":2,"manifests":[%s,%s]}' "$entree" "$entree" >"$work/deux.json"
oci oci "$(cat "$work/deux.json")"
FAUX_OCI=$work/oci.tar PATH=$work/bin:$PATH "$cr/deploy/construire-image.sh" "$work/sortie3" >/dev/null 2>&1 && ko "construire-image : archive à deux manifestes acceptée"
[ ! -e "$work/sortie3/empreinte" ] || ko "construire-image : empreinte écrite pour une archive refusée"

# 17. deploy.sh : image vérifiée avant tout téléchargement, dépôt imposé, rien pour sauter.
vi=$(ligne 'verifier_image "$cosign" curl "$new" "$new_v" "$here/.provenance"')
pu=$(ligne 'docker pull "$SHH_IMAGE_REPO@$new"')
ii=$(ligne 'docker image inspect "$SHH_IMAGE_REPO@$new"')
cc=$(ligne 'controle_cosign "$cosign" "$COSIGN_SHA256"')
[ -n "$vi" ] && [ -n "$pu" ] && [ -n "$ii" ] && [ -n "$cc" ] && [ "$cc" -lt "$vi" ] && [ "$vi" -lt "$pu" ] && [ "$vi" -lt "$ii" ] && [ "$vi" -lt "$p" ] ||
	ko "deploy.sh : verifier_image absent ou après le téléchargement de l'image"
[ "$(cat "$d" "$com" "$here/preprod.sh" | grep -c 'docker pull')" = 1 ] || ko "deploy.sh : autre docker pull"
grep -qx 'SHH_IMAGE_REPO=${SHH_IMAGE_REPO:-$PROVENANCE_IMAGE}' "$com" || ko "commun.sh : SHH_IMAGE_REPO sans défaut ghcr.io/skoow/shhgone"
di=$(lignec '^depot_image_valide "$SHH_IMAGE_REPO" || exit 1$')
[ -n "$di" ] && [ "$l" -lt "$di" ] || ko "commun.sh : SHH_IMAGE_REPO non contrôlé"
grep -q 'SHH_IMAGE_REPO:?' "$d" "$com" && ko "deploy.sh : SHH_IMAGE_REPO encore exigé dans deploy/.env"
grep -qiE -- '--(no|skip|sans)-?(verif|image|sign)|SHH_(SKIP|SANS)_|IMAGE_NON_SIGNEE' "$d" "$com" && ko "deploy.sh : option pour sauter la vérification de l'image"

# 18. release.yml : image construite deux fois par construire-image.sh, publiée sur ghcr.io par
#     le seul job qui en a le droit, signée, image.json signé et publié.
rel=$repo/.github/workflows/release.yml
[ "$(grep -c 'packages: write' "$rel")" = 1 ] || ko "release.yml : packages: write ailleurs que dans publier-image"
grep -q 'run: deploy/construire-image.sh "$RUNNER_TEMP/image"' "$rel" || ko "release.yml : image non construite par construire-image.sh"
grep -q '"$RUNNER_TEMP/cosign" sign --yes "$PROVENANCE_IMAGE@$EMPREINTE"' "$rel" || ko "release.yml : image non signée"
grep -q 'sign-blob --yes --bundle image.json.sigstore.json image.json' "$rel" || ko "release.yml : image.json non signé"
grep -q 'verifier_signature_image "$RUNNER_TEMP/cosign" "$NUMERO" "$EMPREINTE"' "$rel" || ko "release.yml : signature de l'image non revérifiée"
# shellcheck disable=SC1003 # barre oblique inverse cherchée telle quelle (suite de ligne)
grep -qF '"$rel/release.json" "$rel/release.json.sigstore.json" "$rel/image.json" "$rel/image.json.sigstore.json" \' "$rel" ||
	ko "release.yml : image.json absent de la Release"
grep -q 'description_image "$NUMERO" "$(git rev-parse HEAD)" "$EMPREINTE"' "$rel" || ko "release.yml : image.json pas écrit par description_image"
grep -q 'controle_site "$racine/site" "$RUNNER_TEMP/release/release.json" "$NUMERO"' "$rel" || ko "release.yml : site de l'image non comparé au manifeste"
grep -qE 'uses: [^@]+@[0-9a-f]{40}( |$)' "$rel" || ko "release.yml : aucune action épinglée"
grep -E '^\s+- uses: ' "$rel" | grep -vE '@[0-9a-f]{40} # v' | grep -v 'uses: \./' | grep . && ko "release.yml : action non épinglée par empreinte"
grep -q 'secrets\.' "$rel" && ko "release.yml : secret employé"

if [ "$echec" = 0 ]; then
	echo "test-provenance : tous les essais passent"
else
	exit 1
fi

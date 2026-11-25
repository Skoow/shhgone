#!/usr/bin/env bash
# Banc d'essai de deploy/verrous.sh (make lint-deploy, job deploy-lint), sans réseau : un dépôt
# git temporaire, de vraies clés SSH tirées par ssh-keygen, et, pour V3, les imitations de cosign,
# docker et curl du banc de la provenance (deploy/test-provenance.sh). Exige git, ssh-keygen et
# Node (release-manifest.mjs) ; gpg, s'il est là, sert au cas « modifié sur le site de GitHub »
# signé en GPG (sinon ce cas est essayé avec une autre clé SSH seulement).
# shellcheck disable=SC2016,SC2030,SC2031 # motifs cherchés tels quels dans deploy.sh ; sous-shells
# voulus (constantes essayées en lecture seule, variables GIT_* posées par git_sur)
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
# shellcheck source=deploy/provenance.sh
. "$here/provenance.sh"
# shellcheck source=deploy/verrous.sh
. "$here/verrous.sh"
work=$(mktemp -d)
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GNUPGHOME=$work/gnupg
mkdir -m 0700 "$GNUPGHOME"
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf -- "$work"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}
for outil in git ssh-keygen node; do
	command -v "$outil" >/dev/null || {
		echo "test-verrous : $outil introuvable" >&2
		exit 1
	}
done
moi=$(id -u)
V=1.2.3
CLE_DEV_EMPREINTE=SHA256:32dP45eSMmVSt/G/CGvcxl/P+MO3Nwj9xeTh/GSA2wc

# Clés : « dev » est autorisée ; « autre » et « web » ne le sont pas.
for k in dev autre web; do ssh-keygen -q -t ed25519 -N '' -C "$k" -f "$work/k-$k"; done
etc=$work/etc
mkdir -m 0755 "$etc"
sign=$etc/signataires-autorises
{
	echo "# signataires autorisés (essai)"
	printf 'shhgone-dev namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$work/k-dev.pub")"
} >"$sign"
chmod 0644 "$sign"

# Dépôt d'essai.
d=$work/depot
git init -q -b main "$d"
echo 0 >"$work/n"
change() { # ajoute un fichier, pour que git diff --stat ait de quoi dire (compteur dans un
	# fichier : signe et nonsigne tournent dans $(…))
	local n
	n=$(($(cat "$work/n") + 1))
	echo "$n" >"$work/n"
	printf '%s\n' "$n" >"$d/f$n.txt"
	git -C "$d" add -- "f$n.txt"
}
ident=(-c user.name=Dev -c user.email=dev@example.test -c gpg.ssh.program=ssh-keygen)
signe() { # <clé> <message> : commit signé, écrit son empreinte
	change
	git -C "$d" "${ident[@]}" -c gpg.format=ssh -c "user.signingkey=$work/k-$1" commit -q -S -m "$2"
	git -C "$d" rev-parse HEAD
}
nonsigne() { # <message>
	change
	git -C "$d" "${ident[@]}" commit -q --no-gpg-sign -m "$1"
	git -C "$d" rev-parse HEAD
}
fusion() { # <clé ou -> <branche> : fusion (--no-ff) de <branche> dans la branche courante
	if [ "$1" = - ]; then
		git -C "$d" "${ident[@]}" merge -q --no-ff --no-gpg-sign -m "fusion $2" "$2"
	else
		git -C "$d" "${ident[@]}" -c gpg.format=ssh -c "user.signingkey=$work/k-$1" merge -q --no-ff -S -m "fusion $2" "$2"
	fi
	git -C "$d" rev-parse HEAD
}
branche() { git -C "$d" checkout -q -b "$1" "$2"; }

c0=$(signe dev base)
c1=$(signe dev un)
c2=$(signe dev deux)
branche nonsigne "$c2"
u=$(nonsigne "non signé")
branche inconnu "$c2"
k=$(signe autre "clé inconnue")
# « Modifié sur le site de GitHub » : un commit signé par une autre clé, puis un commit de la
# clé autorisée par-dessus (la pointe est bien signée, pas l'intervalle).
branche web "$c2"
w=$(signe web "édité sur le site")
w2=$(signe dev "par-dessus")
branche reecrit "$c1"
r=$(signe dev "histoire réécrite")
branche f "$c2"
signe dev f1 >/dev/null
branche m "$c2"
signe dev m1 >/dev/null
mg=$(fusion dev f)
branche f2 "$c2"
f2ns=$(nonsigne "branche non signée")
branche m2 "$c2"
signe dev m2 >/dev/null
mgb=$(fusion dev f2)
branche m3 "$c2"
signe dev m3 >/dev/null
mgn=$(fusion - f)
branche esc "$c2"
esc=$(signe dev "$(printf 'sujet \033[2J\033]0;piège\007 \r fin')")
branche long "$c2"
for i in $(seq 1 35); do lg=$(signe dev "long $i"); done
gpg_ok=0
if command -v gpg >/dev/null 2>&1 &&
	gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key "Web <web@example.test>" ed25519 sign never >/dev/null 2>&1; then
	gpg_ok=1
	branche gpg "$c2"
	change
	git -C "$d" "${ident[@]}" -c gpg.format=openpgp -c user.signingkey=web@example.test commit -q -S -m "signé par GitHub (GPG)"
	g=$(git -C "$d" rev-parse HEAD)
	g2=$(signe dev "par-dessus GPG")
	# Sans les réglages de git_sur, git dit « G » : la clé est de confiance dans le trousseau.
	[ "$(git -C "$d" log -1 --format=%G? "$g")" = G ] || ko "gpg : le cas d'essai ne donne pas G sans git_sur"
else
	echo "test-verrous : gpg absent, cas GPG non essayé" >&2
fi
git -C "$d" checkout -q main

# essai <nom> <installé> <commit> <mode> : verifier_commit ; code dans $work/<nom>.code.
essai() {
	local nom=$1 code=0
	shift
	verifier_commit "$d" "$sign" "$@" >"$work/$nom.out" 2>"$work/$nom.err" || code=$?
	echo "$code" >"$work/$nom.code"
}
accepte() { # <nom> [motif attendu sur la sortie]
	[ "$(cat "$work/$1.code")" = 0 ] || ko "$1 : refusé ($(cat "$work/$1.err"))"
	[ -z "${2:-}" ] || grep -q -- "$2" "$work/$1.out" || ko "$1 : sortie attendue « $2 », obtenue : $(cat "$work/$1.out")"
}
refuse() { # <nom> <motif attendu sur la sortie d'erreur>
	[ "$(cat "$work/$1.code")" != 0 ] || ko "$1 : accepté"
	grep -q -- "$2" "$work/$1.err" || ko "$1 : message attendu « $2 », obtenu : $(cat "$work/$1.err")"
}

# 1. Bon chemin, première installation, fusion signée.
essai bon "$c0" "$c2" suite
accepte bon "descendant de $c0, 2 commit(s) signés"
essai premiere "" "$c2" suite
accepte premiere "PREMIÈRE installation sous verrous"
essai meme "$c2" "$c2" suite
accepte meme "0 commit(s)"
essai fusion "$c2" "$mg" suite
accepte fusion "3 commit(s) signés"

# 2. V1 : pointe non signée, signée par une clé inconnue, intervalle signé par une autre clé
#    (site de GitHub), fusion dont une branche ou la fusion elle-même n'est pas signée.
essai nonsigne "$c2" "$u" suite
refuse nonsigne "V1 : le commit $u n'est pas signé"
essai inconnu "$c2" "$k" suite
refuse inconnu "V1 : le commit $k n'est pas signé"
essai premiere-inconnu "" "$k" suite
refuse premiere-inconnu "V1 : le commit $k"
essai web "$c2" "$w2" suite
refuse web "V1 : commit(s) entre"
grep -q "^$w U$" "$work/web.err" || ko "web : commit fautif non nommé ($(cat "$work/web.err"))"
grep -q "^$w2 " "$work/web.err" && ko "web : commit bien signé nommé comme fautif"
essai fusion-branche "$c2" "$mgb" suite
refuse fusion-branche "V1 : commit(s) entre"
grep -q "^$f2ns N$" "$work/fusion-branche.err" || ko "fusion-branche : commit non signé non nommé ($(cat "$work/fusion-branche.err"))"
essai fusion-nonsignee "$c2" "$mgn" suite
refuse fusion-nonsignee "V1 : le commit $mgn"
if [ "$gpg_ok" = 1 ]; then
	essai gpg "$c2" "$g" suite
	refuse gpg "V1 : le commit $g"
	essai gpg-milieu "$c2" "$g2" suite
	refuse gpg-milieu "V1 : commit(s) entre"
	grep -q "^$g N$" "$work/gpg-milieu.err" || ko "gpg-milieu : commit GPG non nommé ($(cat "$work/gpg-milieu.err"))"
fi

# 3. V2 : histoire réécrite ; commit installé absent de la copie.
essai reecrit "$c2" "$r" suite
refuse reecrit "V2 : histoire réécrite"
essai arriere "$c2" "$c1" suite
refuse arriere "V2 : histoire réécrite"
essai installe-absent "$(printf 'e%.0s' {1..40})" "$c2" suite
refuse installe-absent "V2 : le commit installé"

# 4. Commit donné : forme courte, majuscules, absent de la copie.
essai court "$c0" "${c2:0:12}" suite
refuse court "commit refusé"
essai majuscules "$c0" "$(printf '%s' "$c2" | tr a-f A-F)" suite
refuse majuscules "commit refusé"
essai absent "$c0" "$(printf 'd%.0s' {1..40})" suite
refuse absent "absent de la copie du dépôt"

# 5. Retour arrière et réinstallation : le commit installé ou l'un de ses ancêtres, signé.
essai retour "$c2" "$c1" retour
accepte retour
essai reinstalle "$c2" "$c2" retour
accepte reinstalle
essai retour-descendant "$c1" "$c2" retour
refuse retour-descendant "ni le commit installé"
essai retour-sans "" "$c1" retour
refuse retour-sans "retour arrière impossible"
essai retour-autre "$c2" "$r" retour
refuse retour-autre "ni le commit installé"

# 6. Isolement de git : variables GIT_* (deploy/.env est exporté) et réglages du dépôt sans effet.
code=0
GIT_DIR=$work/nulle-part GIT_ALLOW_PROTOCOL=x verifier_commit "$d" "$sign" "$c0" "$c2" suite >/dev/null 2>&1 || code=$?
[ "$code" = 0 ] || ko "GIT_DIR hérité : la vérification ne lit plus la copie"
printf 'tous namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$work/k-autre.pub")" >"$work/tout-le-monde"
git -C "$d" config gpg.ssh.allowedSignersFile "$work/tout-le-monde"
git -C "$d" config gpg.ssh.program /bin/true
essai config-depot "$c2" "$k" suite
refuse config-depot "V1 : le commit $k"
git -C "$d" config --unset gpg.ssh.allowedSignersFile
git -C "$d" config --unset gpg.ssh.program

# 7. Fichier des signataires : absent, mal réglé, sans clé ; autre fichier sans la clé.
cs() { # <nom> <fichier> <uid> : controle_signataires ; code dans $work/<nom>.code
	local code=0
	controle_signataires "$2" "$3" >/dev/null 2>"$work/$1.err" || code=$?
	echo "$code" >"$work/$1.code"
}
cs sign-bon "$sign" "$moi"
[ "$(cat "$work/sign-bon.code")" = 0 ] || ko "signataires : bon fichier refusé ($(cat "$work/sign-bon.err"))"
for m in 0600 0444 0400; do
	chmod "$m" "$sign"
	cs "sign-$m" "$sign" "$moi"
	[ "$(cat "$work/sign-$m.code")" = 0 ] || ko "signataires : mode $m refusé ($(cat "$work/sign-$m.err"))"
done
for m in 0666 0664 0646 0755 0744 4644; do
	chmod "$m" "$sign"
	cs "sign-$m" "$sign" "$moi"
	refuse "sign-$m" "droits"
done
chmod 0644 "$sign"
cs sign-absent "$etc/nulle-part" "$moi"
refuse sign-absent "absent"
cs sign-proprio "$sign" $((moi + 1))
refuse sign-proprio "appartient au compte $moi"
ln -s "$sign" "$etc/lien"
cs sign-lien "$etc/lien" "$moi"
refuse sign-lien "lien symbolique"
rm "$etc/lien"
mkdir "$etc/dossier"
cs sign-dossier "$etc/dossier" "$moi"
refuse sign-dossier "pas un fichier ordinaire"
rmdir "$etc/dossier"
chmod 0777 "$etc"
cs sign-etc "$sign" "$moi"
refuse sign-etc "dossier absent ou mal réglé"
chmod 0775 "$etc"
cs sign-etc-groupe "$sign" "$moi"
refuse sign-etc-groupe "dossier absent ou mal réglé"
chmod 0755 "$etc"
printf '# rien\n\n' >"$etc/vide"
chmod 0644 "$etc/vide"
cs sign-vide "$etc/vide" "$moi"
refuse sign-vide "aucune clé"
printf 'shhgone-dev namespaces="git" %s\n' "$(cut -d' ' -f1,2 "$work/k-autre.pub")" >"$etc/autre"
chmod 0644 "$etc/autre"
code=0
verifier_commit "$d" "$etc/autre" "" "$c2" suite >/dev/null 2>&1 || code=$?
[ "$code" != 0 ] || ko "signataires sans la clé du commit : accepté"

# 8. Commit installé : absent (première installation), lu, mal formé, mal réglé ; écriture.
ci=$etc/commit-installe
[ -z "$(lire_commit_installe "$ci" "$moi")" ] || ko "commit installé absent : lu quelque chose"
ecrire_commit_installe "$ci" "$c0" || ko "ecrire_commit_installe : échec"
[ "$(lire_commit_installe "$ci" "$moi")" = "$c0" ] || ko "commit installé : mal relu"
[ "$(stat -c %a "$ci")" = 644 ] || ko "commit installé : mode $(stat -c %a "$ci")"
[ ! -e "$ci.tmp" ] || ko "commit installé : fichier temporaire laissé"
ecrire_commit_installe "$ci" "${c0:0:7}" 2>/dev/null && ko "ecrire_commit_installe : forme courte acceptée"
[ "$(cat "$ci")" = "$c0" ] || ko "commit installé : écrasé par une forme courte"
for contenu in "abc" "$c0$c0" "$(printf '%s\n%s' "$c0" "$c1")" "$(printf '%s' "$c0" | tr a-f A-F)"; do
	printf '%s\n' "$contenu" >"$etc/ci-mal"
	chmod 0644 "$etc/ci-mal"
	lire_commit_installe "$etc/ci-mal" "$moi" >/dev/null 2>&1 && ko "commit installé mal formé accepté : $(printf '%q' "$contenu")"
done
printf '%s' "$c0" >"$etc/ci-mal"
lire_commit_installe "$etc/ci-mal" "$moi" >/dev/null 2>&1 && ko "commit installé sans fin de ligne accepté"
chmod 0666 "$ci"
lire_commit_installe "$ci" "$moi" >/dev/null 2>&1 && ko "commit installé modifiable par tous : accepté"
chmod 0644 "$ci"
lire_commit_installe "$ci" $((moi + 1)) >/dev/null 2>&1 && ko "commit installé d'un autre compte : accepté"
ln -s "$ci" "$etc/ci-lien"
lire_commit_installe "$etc/ci-lien" "$moi" >/dev/null 2>&1 && ko "commit installé en lien : accepté"
rm "$etc/ci-lien"

# 9. V3 avec les imitations du banc de la provenance : le commit du manifeste signé.
cat >"$work/cosign" <<'EOF'
#!/usr/bin/env bash
[ "$#" = 8 ] && [ "$1" = verify-blob ] && [ "$3" = --bundle ] && [ "$5" = --certificate-oidc-issuer ] &&
	[ "$6" = https://token.actions.githubusercontent.com ] && [ "$7" = --certificate-identity ] || exit 9
[ "$(cat "$4")" = "$(sha256sum "$2" | cut -d' ' -f1) $8" ] || exit 1
EOF
cat >"$work/docker" <<'EOF'
#!/usr/bin/env bash
case $1 in
create) echo c0ffee ;;
cp) [ "$2" = c0ffee:/site ] && cp -a "$FAUX_SITE" "$3" ;;
rm) : ;;
*) exit 2 ;;
esac
EOF
cat >"$work/curl" <<'EOF'
#!/usr/bin/env bash
url=${!#} out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
f=$FAUX_RELEASE/${url##*/}
[ -f "$f" ] && cp "$f" "$out" || exit 22
EOF
chmod +x "$work/cosign" "$work/docker" "$work/curl"
export FAUX_SITE=$work/site FAUX_RELEASE
mkdir -p "$FAUX_SITE"
printf '<!doctype html><title>t</title>\n' >"$FAUX_SITE/index.html"
publie() { # <commit> <dossier> : release.json signé (imitation) pour ce commit
	FAUX_RELEASE=$2
	mkdir -p "$2"
	node "$repo/web/scripts/release-manifest.mjs" "$FAUX_SITE" --name shhdrop-web --version "$V" --commit "$1" --out "$2" >/dev/null
	printf '%s %s' "$(sha256sum "$2/release.json" | cut -d' ' -f1)" "$(identite_release "$V")" >"$2/release.json.sigstore.json"
}
publie "$c2" "$work/rel"
verifier_provenance "$work/cosign" "$work/docker" "$work/curl" depot/shhdrop@sha256:aaaa "$V" "$work/cache" >/dev/null 2>&1 ||
	ko "V3 : provenance refusée sur le bon chemin"
manif=$work/cache/$V/release.json
controle_commit_annonce "$manif" "$c2" 2>/dev/null || ko "V3 : bon commit refusé"
controle_commit_annonce "$manif" "$c1" 2>"$work/v3.err" && ko "V3 : autre commit accepté"
grep -q "V3 : le manifeste signé nomme le commit $c2, pas celui donné ($c1)" "$work/v3.err" || ko "V3 : message $(cat "$work/v3.err")"
controle_commit_annonce "$manif" "${c2:0:7}" 2>/dev/null && ko "V3 : forme courte acceptée"
publie "${c2:0:7}" "$work/rel-court"
verifier_provenance "$work/cosign" "$work/docker" "$work/curl" depot/shhdrop@sha256:aaaa "$V" "$work/cache-court" >/dev/null 2>&1 ||
	ko "V3 : provenance refusée (manifeste au commit court)"
controle_commit_annonce "$work/cache-court/$V/release.json" "$c2" 2>/dev/null && ko "V3 : manifeste au commit court accepté"

# 10. Copie du dépôt du serveur : au commit, avancée sans réseau, propre, sur le commit installé.
copie=$work/copie
git clone -q "$d" "$copie"
git -C "$copie" checkout -q --detach "$c0"
copie_au_commit "$copie" "$sign" "$c0" 2>/dev/null || ko "copie : au commit $c0 refusée"
copie_au_commit "$copie" "$sign" "$c2" 2>/dev/null && ko "copie : autre commit accepté"
# Un crochet de la copie ne tourne pas (deploy.sh est lancé par root).
printf '#!/bin/sh\ntouch "%s/crochet"\n' "$work" >"$copie/.git/hooks/post-merge"
chmod +x "$copie/.git/hooks/post-merge"
avancer_copie "$copie" "$sign" "$c0" "$c2" 2>"$work/av.err" || ko "copie : avance refusée ($(cat "$work/av.err"))"
[ "$(git -C "$copie" rev-parse HEAD)" = "$c2" ] || ko "copie : pas avancée"
[ ! -e "$work/crochet" ] || ko "copie : crochet post-merge lancé"
rm -f "$copie/.git/hooks/post-merge"
git -C "$copie" checkout -q --detach "$c0"
printf 'piège\n' >>"$copie/f1.txt"
avancer_copie "$copie" "$sign" "$c0" "$c2" 2>"$work/av.err" && ko "copie modifiée : avancée"
grep -q "fichiers suivis modifiés" "$work/av.err" || ko "copie modifiée : $(cat "$work/av.err")"
copie_au_commit "$copie" "$sign" "$c0" 2>/dev/null && ko "copie modifiée : acceptée au commit"
git -C "$copie" checkout -q -- f1.txt
printf 'x\n' >"$copie/non-suivi.txt"
copie_au_commit "$copie" "$sign" "$c0" 2>/dev/null || ko "copie : fichier non suivi refusé (deploy/.env en est un)"
git -C "$copie" checkout -q --detach "$c1"
avancer_copie "$copie" "$sign" "$c0" "$c2" 2>"$work/av.err" && ko "copie hors du commit installé : avancée"
grep -q "pas sur le commit installé $c0" "$work/av.err" || ko "copie hors du commit installé : $(cat "$work/av.err")"
avancer_copie "$copie" "$sign" "" "$c2" 2>/dev/null || ko "copie : avance à la première installation refusée"
git -C "$copie" checkout -q --detach "$r"
avancer_copie "$copie" "$sign" "" "$c2" 2>"$work/av.err" && ko "copie sur une autre branche : avancée"
grep -q "pas un ancêtre de $c2" "$work/av.err" || ko "copie sur une autre branche : $(cat "$work/av.err")"
# Retour arrière, réinstallation : copie sur le commit installé ou un descendant vérifié.
git -C "$copie" checkout -q --detach "$c2"
copie_verifiee "$copie" "$sign" "$c2" 2>/dev/null || ko "copie_verifiee : commit installé refusé"
copie_verifiee "$copie" "$sign" "$c0" 2>/dev/null || ko "copie_verifiee : descendant vérifié refusé"
git -C "$copie" checkout -q --detach "$w2"
copie_verifiee "$copie" "$sign" "$c2" 2>/dev/null && ko "copie_verifiee : descendant mal signé accepté"
git -C "$copie" checkout -q --detach "$c1"
copie_verifiee "$copie" "$sign" "$c2" 2>/dev/null && ko "copie_verifiee : ancêtre du commit installé accepté"
git -C "$copie" checkout -q --detach "$c2"
printf 'piège\n' >>"$copie/f1.txt"
copie_verifiee "$copie" "$sign" "$c2" 2>/dev/null && ko "copie_verifiee : copie modifiée acceptée"
git -C "$copie" checkout -q -- f1.txt

# 11. Résumé des changements : sujets et fichiers, borné, sans caractère de contrôle.
resume_changements "$d" "$sign" "$c0" "$c2" >"$work/res.out"
grep -q "(2 commit(s))" "$work/res.out" || ko "résumé : nombre de commits ($(cat "$work/res.out"))"
{ grep -q " deux$" "$work/res.out" && grep -q " un$" "$work/res.out"; } || ko "résumé : sujets absents"
grep -q "2 files changed" "$work/res.out" || ko "résumé : git diff --stat absent"
resume_changements "$d" "$sign" "$c2" "$lg" >"$work/long.out"
[ "$(wc -l <"$work/long.out")" -le $((2 * VERROUS_RESUME_MAX + 4)) ] || ko "résumé : $(wc -l <"$work/long.out") lignes"
grep -q "… et 5 autre(s)$" "$work/long.out" || ko "résumé long : commits en plus non dits"
grep -q "… et 5 autre(s) fichier(s)" "$work/long.out" || ko "résumé long : fichiers en plus non dits"
grep -q "35 files changed" "$work/long.out" || ko "résumé long : ligne de total absente"
resume_changements "$d" "$sign" "$c2" "$esc" >"$work/esc.out"
LC_ALL=C grep -q $'[\001-\010\013-\037\177]' "$work/esc.out" && ko "résumé : caractère de contrôle affiché"
grep -q "sujet" "$work/esc.out" || ko "résumé : sujet nettoyé absent"
resume_changements "$d" "$sign" "" "$c2" | grep -q "première installation" || ko "résumé : première installation"

# 12. deploy.sh : verrous avant tout démarrage, V3 avant le démarrage, commit installé écrit après
#     le contrôle seulement, aucune option pour sauter, forme à deux arguments refusée.
dsh=$here/deploy.sh
ligne() { grep -n -m1 -- "$1" "$dsh" | cut -d: -f1; }
vr=$(ligne '^	verrous "$new_c" "$mode"$')
pf=$(ligne '^	preflight$')
pv=$(ligne 'verifier_provenance "$cosign"')
an=$(ligne 'controle_commit_annonce "$here/.provenance/$new_v/release.json" "$new_c"')
up=$(ligne 'dc "$new" up -d --remove-orphans')
ck=$(ligne 'if check "$new" "$new_v"; then')
ec=$(ligne 'ecrire_commit_installe "$VERROUS_COMMIT_INSTALLE" "$new_c"')
for x in vr pf pv an up ck ec; do [ -n "${!x}" ] || ko "deploy.sh : ligne $x introuvable"; done
if [ -n "$vr$pf$pv$an$up$ck$ec" ]; then
	[ "$vr" -lt "$pf" ] && [ "$vr" -lt "$pv" ] || ko "deploy.sh : verrous après preflight ou la provenance"
	[ "$pv" -lt "$an" ] && [ "$an" -lt "$up" ] || ko "deploy.sh : V3 absent entre la provenance et le démarrage"
	[ "$ck" -lt "$ec" ] || ko "deploy.sh : commit installé écrit avant le contrôle"
fi
grep -q 'controle_signataires "$VERROUS_SIGNATAIRES" 0 ' "$dsh" || ko "deploy.sh : signataires non contrôlés (root)"
grep -q 'lire_commit_installe "$VERROUS_COMMIT_INSTALLE" 0)' "$dsh" || ko "deploy.sh : commit installé non contrôlé (root)"
grep -q 'install_version "$1" "$2" "$3" suite$' "$dsh" || ko "deploy.sh : forme à trois arguments absente"
grep -qE 'install_version "\$1" "\$2"$|\[ \$# -eq 2 \]' "$dsh" && ko "deploy.sh : forme sans commit acceptée"
grep -q 'install_version "$prev" "$prev_v" "$prev_c" retour$' "$dsh" || ko "deploy.sh : retour arrière hors verrous"
grep -q 'install_version "$1" "$cur_v" "$cur_c" retour$' "$dsh" || ko "deploy.sh : réinstallation hors verrous"
grep -qiE -- '--(no|skip|sans)-?(verrou|sign|commit)|SHH_(SKIP|SANS)_(VERROU|SIGN|COMMIT)|VERROUS=0' "$dsh" "$here/verrous.sh" &&
	ko "deploy.sh : option pour sauter les verrous"
grep -q '^depot=$(cd "$here/.." && pwd)$' "$dsh" || ko "deploy.sh : la copie vérifiée n'est pas celle du script"
av=$(ligne 'avancer_copie "$depot"')
ex=$(ligne 'exec "$here/deploy.sh" "${args\[@\]}"')
[ -n "$av" ] && [ -n "$ex" ] && [ "$av" -lt "$ex" ] || ko "deploy.sh : relance du deploy.sh vérifié absente"
e=$(ligne '^\. \./\.env')
l=$(ligne '^\. \./verrous\.sh')
[ -n "$e" ] && [ -n "$l" ] && [ "$e" -lt "$l" ] || ko "deploy.sh : verrous.sh chargé avant deploy/.env (constantes remplaçables)"
(VERROUS_SIGNATAIRES=/tmp/x) 2>/dev/null && ko "VERROUS_SIGNATAIRES modifiable"
(VERROUS_COMMIT_INSTALLE=/tmp/x) 2>/dev/null && ko "VERROUS_COMMIT_INSTALLE modifiable"
[ "$VERROUS_SIGNATAIRES" = /etc/shhdrop/signataires-autorises ] || ko "VERROUS_SIGNATAIRES : $VERROUS_SIGNATAIRES"
[ "$VERROUS_COMMIT_INSTALLE" = /etc/shhdrop/commit-installe ] || ko "VERROUS_COMMIT_INSTALLE : $VERROUS_COMMIT_INSTALLE"

# 13. README : la ligne des signataires est la clé de développement (empreinte annoncée).
cle=$(grep -m1 -E '^shhgone-dev namespaces="git" ssh-ed25519 [A-Za-z0-9+/=]+$' "$here/README.md" | cut -d' ' -f3,4) ||
	ko "README : ligne shhgone-dev absente"
[ "$(printf '%s\n' "$cle" | ssh-keygen -lf - 2>/dev/null | cut -d' ' -f2)" = "$CLE_DEV_EMPREINTE" ] ||
	ko "README : la clé shhgone-dev n'a pas l'empreinte $CLE_DEV_EMPREINTE"
grep -qF "$CLE_DEV_EMPREINTE" "$here/README.md" || ko "README : empreinte de la clé absente"
grep -qF 'deploy/deploy.sh sha256:<empreinte> <x.y.z> <commit>' "$here/README.md" || ko "README : commande d'installation sans commit"

if [ "$echec" = 0 ]; then
	echo "test-verrous : tous les essais passent"
else
	exit 1
fi

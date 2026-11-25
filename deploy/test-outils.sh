#!/usr/bin/env bash
# shellcheck disable=SC2016 # motifs et valeurs littéraux (grep, valeurs de deploy/.env)
# Banc d'essai des outils du quotidien (README « Commandes du quotidien ») et de ce qu'ils
# partagent avec deploy.sh et preprod.sh, sans réseau ni Docker. Lancé par make lint-deploy.
#   1. lire-env.sh : deploy/.env lu en NOM=valeur, jamais exécuté ; propriétaire et droits.
#   2. fichiers-secrets.sh : formats refusés, droits exacts, aucun écrasement, aucune valeur dans
#      la sortie, tirage des secrets de la machine.
#   3. verrous.sh, contexte_du_commit : seuls les fichiers suivis du commit (preprod.sh).
#   4. Contrôles du texte des scripts (ordre, aucune exécution de deploy/.env).
#   5. En root seulement (sudo deploy/test-outils.sh), dans un espace de montage à part (volume
#      en mémoire, /etc recouvert : rien n'est écrit dans le vrai /etc) : secret.sh, --liste,
#      lien-acces.sh, admin-jeton.sh, etat.sh et secrets_auto (commun.sh), pour de vrai, avec un
#      terminal simulé (python3, pty). Sinon, sauté (dit).
set -uo pipefail
export LC_ALL=C.UTF-8

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$1" >&2
	echec=1
}
moi=$(id -u) groupe=$(id -g)

# shellcheck source=deploy/lire-env.sh
. "$here/lire-env.sh"
# shellcheck source=deploy/verrous.sh
. "$here/verrous.sh"
# shellcheck source=deploy/fichiers-secrets.sh
. "$here/fichiers-secrets.sh"

# --- 1. lire-env.sh -----------------------------------------------------------------------------
e=$work/env
cat >"$e" <<'EOF'
# commentaire
  # commentaire indenté

SHH_DOMAIN=shhgone.com
export SHH_DATA_ROOT=/srv/shhdrop
SHH_PAYPAL_PLANS=plus-mois=P-1,plus-an=P-2 # commentaire de fin
SHH_A="deux mots"
SHH_B='a $b `c` ; d'
SHH_C=a#b
SHH_VIDE=
SHH_CR=fin
EOF
printf 'SHH_DERNIERE=sans-fin-de-ligne' >>"$e"
sed -i 's/^SHH_CR=fin$/SHH_CR=fin\r/' "$e"
chmod 0644 "$e"
(
	lire_env "$e" 1 || exit 1
	[ "$SHH_DOMAIN" = shhgone.com ] && [ "$SHH_DATA_ROOT" = /srv/shhdrop ] &&
		[ "$SHH_PAYPAL_PLANS" = plus-mois=P-1,plus-an=P-2 ] && [ "$SHH_A" = "deux mots" ] &&
		[ "$SHH_B" = 'a $b `c` ; d' ] && [ "$SHH_C" = 'a#b' ] && [ -z "$SHH_VIDE" ] &&
		[ "$SHH_CR" = fin ] && [ "$SHH_DERNIERE" = sans-fin-de-ligne ] || exit 2
	[ "$(bash -c 'printf %s "$SHH_A"')" = "deux mots" ] || exit 3
) || ko "lire_env : fichier valable mal lu (code $?)"
# Même valeur qu'au shell d'avant (« . .env ») pour chaque forme acceptée.
(
	set -a
	# shellcheck disable=SC1090
	. "$e"
	set +a
	printf '%s|' "$SHH_PAYPAL_PLANS" "$SHH_A" "$SHH_B" "$SHH_C" "$SHH_VIDE"
) >"$work/env-shell"
(
	lire_env "$e" 0
	printf '%s|' "$SHH_PAYPAL_PLANS" "$SHH_A" "$SHH_B" "$SHH_C" "$SHH_VIDE"
) >"$work/env-lu"
cmp -s "$work/env-shell" "$work/env-lu" || ko "lire_env : valeurs différentes de celles du shell"
(
	lire_env "$e" 0
	[ -z "$(bash -c 'printf %s "${SHH_A-}"')" ]
) || ko "lire_env 0 : variables exportées"
# Refus : chaque ligne seule, aucune commande exécutée, aucune valeur dans le message.
refuse_env() { # <nom de l'essai> <ligne> <motif attendu>
	local f=$work/env-$1 sortie
	printf 'SHH_DOMAIN=ok\n%s\n' "$2" >"$f"
	chmod 0644 "$f"
	if sortie=$( (lire_env "$f" 1) 2>&1); then
		ko "lire_env $1 : accepté"
	else
		grep -qF -- "$3" <<<"$sortie" || ko "lire_env $1 : message « $sortie » (attendu : $3)"
		grep -qF -- "VALEUR-SECRETE" <<<"$sortie" && ko "lire_env $1 : valeur dans le message"
	fi
	[ ! -e "$work/execute" ] || ko "lire_env $1 : commande exécutée"
}
refuse_env subst "SHH_X=\$(touch $work/execute)VALEUR-SECRETE" "valeur refusée"
refuse_env backtick "SHH_X=\`touch $work/execute\`VALEUR-SECRETE" "valeur refusée"
refuse_env pointvirgule "SHH_X=VALEUR-SECRETE;touch $work/execute" "valeur refusée"
refuse_env espace "SHH_X=VALEUR-SECRETE touch $work/execute" "valeur refusée"
refuse_env dollar "SHH_X=\${HOME}VALEUR-SECRETE" "valeur refusée"
refuse_env guillemets "SHH_X=\"\$(touch $work/execute)VALEUR-SECRETE\"" "valeur refusée"
refuse_env commande "touch $work/execute" "forme NOM=valeur attendue"
refuse_env path "PATH=/tmp/VALEUR-SECRETE" "PATH refusée"
refuse_env ldpreload "LD_PRELOAD=/tmp/VALEUR-SECRETE.so" "LD_PRELOAD refusée"
refuse_env compose "COMPOSE_FILE=VALEUR-SECRETE.yaml" "COMPOSE_FILE refusée"
refuse_env minuscules "here=/tmp/VALEUR-SECRETE" "here refusée"
refuse_env fonction "SHH_F() { touch $work/execute; }" "forme NOM=valeur attendue"
printf 'SHH_DOMAIN=ok\n' >"$work/env-droits"
chmod 0664 "$work/env-droits"
(lire_env "$work/env-droits" 1) 2>/dev/null && ko "lire_env : fichier modifiable par le groupe accepté"
chmod 0646 "$work/env-droits"
(lire_env "$work/env-droits" 1) 2>/dev/null && ko "lire_env : fichier modifiable par tous accepté"
chmod 0600 "$work/env-droits"
(lire_env "$work/env-droits" 1) 2>/dev/null || ko "lire_env : 0600 refusé"
ln -s "$work/env-droits" "$work/env-lien"
(lire_env "$work/env-lien" 1) 2>/dev/null && ko "lire_env : lien symbolique accepté"
if [ "$moi" = 0 ]; then
	chown 65532 "$work/env-droits"
	(lire_env "$work/env-droits" 1) 2>/dev/null && ko "lire_env : fichier d'un autre compte accepté"
	chown 0 "$work/env-droits"
fi

# --- 2. fichiers-secrets.sh ---------------------------------------------------------------------
format_ok() { # <nom> <essai> <valeur>
	verifier_format "$1" "$3" "$2" 2>/dev/null || ko "format $1 (essai $2) : valeur valable refusée"
}
format_ko() { # <nom> <essai> <valeur> <motif attendu>
	local m
	if m=$(verifier_format "$1" "$3" "$2" 2>&1); then
		ko "format $1 (essai $2) : valeur fausse acceptée"
	else
		grep -qF -- "$4" <<<"$m" || ko "format $1 : message « $m » (attendu : $4)"
		[ -z "$3" ] || ! grep -qF -- "$3" <<<"$m" || ko "format $1 : la valeur est dans le message"
	fi
}
format_ok shh_stripe_cle 1 sk_test_51AbcdEFGhij0123456789
format_ok shh_stripe_cle 1 rk_test_51AbcdEFGhij0123456789
format_ok shh_stripe_cle 0 sk_live_51AbcdEFGhij0123456789
format_ok shh_stripe_cle 0 rk_live_51AbcdEFGhij0123456789
format_ko shh_stripe_cle 1 sk_live_51AbcdEFGhij0123456789 "clé de TEST attendue"
format_ko shh_stripe_cle 0 sk_test_51AbcdEFGhij0123456789 "clé RÉELLE attendue"
format_ko shh_stripe_cle 1 pk_test_51AbcdEFGhij0123456789 "clé publique"
format_ko shh_stripe_cle 1 whsec_AbcdEFGhij0123456789 "shh_stripe_webhook"
format_ko shh_stripe_cle 1 "sk_test_51Abcd EFGhij0123456789" "espace"
format_ok shh_stripe_webhook 1 whsec_AbcdEFGhij0123456789
format_ko shh_stripe_webhook 1 sk_test_51AbcdEFGhij0123456789 "whsec_"
format_ok shh_paypal_secret 1 EKx-0123456789_abcdefghijABCDEFGHIJ
format_ko shh_paypal_secret 1 court "PayPal"
format_ok shh_nowpayments_cle 0 ABC1DEF-GHI2JKL-MNO3PQR-STU4VWX
format_ko shh_nowpayments_cle 0 ABC1DEFGHI2JKLMNO3PQR "NOWPayments"
format_ok shh_nowpayments_ipn 0 AbCdEfGhIjKlMnOpQrStUvWx
format_ko shh_nowpayments_ipn 0 court "IPN"
format_ok alerte_smtp_mdp 0 'mot de passe: avec $ et ;'
format_ko alerte_smtp_mdp 0 'avec"guillemet' "guillemet"
format_ko alerte_smtp_mdp 0 'avec\barre' "barre oblique"
format_ko alerte_smtp_mdp 0 'accentué-é' "accents"
format_ko alerte_smtp_mdp 0 "" "vide"
format_ko shh_turn_secret 0 abcdefabcdefabcdef "inconnu"

# fiche_secret : emplacements et droits attendus (README §12.2, §13.2, §14, §15, §4).
secrets=$work/vol/secrets
fiche_secret shh_stripe_cle && [ "$s_fichier $s_proprio $s_mode" = "$secrets/shh_stripe_cle 65532:65532 400" ] ||
	ko "fiche shh_stripe_cle : $s_fichier $s_proprio $s_mode"
fiche_secret alerte_smtp_mdp && [ "$s_fichier $s_proprio $s_mode" = "/etc/shhdrop/alerte_smtp_mdp 0:0 600" ] ||
	ko "fiche alerte_smtp_mdp : $s_fichier $s_proprio $s_mode"
fiche_secret preprod-jeton && [ "$s_fichier" = "$PREPROD_JETON_FICHIER" ] || ko "fiche preprod-jeton : $s_fichier"
grep -qF '/etc/shhdrop/alerte_smtp_mdp' "$here/alerte.sh" || ko "alerte.sh ne lit plus /etc/shhdrop/alerte_smtp_mdp"
fiche_secret inconnu && ko "fiche : nom inconnu accepté"
for n in $SECRETS_SAISIS $SECRETS_TIRES; do fiche_secret "$n" || ko "fiche $n absente"; done
(SECRETS_ETC=/tmp) 2>/dev/null && ko "SECRETS_ETC modifiable"

# tirer_secret : créé une fois, droits exacts, jamais la valeur, jamais retiré ensuite.
d=$work/tire
mkdir -m 0750 "$d"
moi_g="$moi:$groupe"
s1=$(tirer_secret "$d/hex" "$moi_g" 400 hex24 "essai hex") || ko "tirer_secret hex : refusé"
[ "$s1" = "essai hex : créé" ] || ko "tirer_secret hex : sortie « $s1 »"
[ "$(stat -c '%u %a %s' "$d/hex")" = "$moi 400 49" ] || ko "tirer_secret hex : $(stat -c '%u %a %s' "$d/hex")"
grep -qxE '[0-9a-f]{48}' "$d/hex" || ko "tirer_secret hex : contenu hors format"
v=$(cat "$d/hex")
grep -qF -- "$v" <<<"$s1" && ko "tirer_secret : valeur affichée"
s2=$(tirer_secret "$d/hex" "$moi_g" 400 hex24 "essai hex") || ko "tirer_secret hex (présent) : refusé"
[ "$s2" = "essai hex : présent" ] || ko "tirer_secret présent : sortie « $s2 »"
[ "$(cat "$d/hex")" = "$v" ] || ko "tirer_secret : secret présent écrasé"
tirer_secret "$d/brut" "$moi_g" 400 octets32 "essai brut" >/dev/null || ko "tirer_secret octets : refusé"
[ "$(stat -c '%a %s' "$d/brut")" = "400 32" ] || ko "tirer_secret octets : $(stat -c '%a %s' "$d/brut")"
tirer_secret "$d/jeton" "$moi_g" 600 hex32 "essai jeton" >/dev/null && [ "$(stat -c '%a %s' "$d/jeton")" = "600 65" ] ||
	ko "tirer_secret jeton : $(stat -c '%a %s' "$d/jeton" 2>&1)"
lire_jeton_preprod "$d/jeton" "$moi" >/dev/null 2>&1 || ko "tirer_secret : jeton refusé par lire_jeton_preprod"
chmod 0444 "$d/hex"
tirer_secret "$d/hex" "$moi_g" 400 hex24 "essai" >/dev/null 2>&1 && ko "tirer_secret : droits trop larges acceptés"
[ "$(cat "$d/hex")" = "$v" ] || ko "tirer_secret : secret mal réglé écrasé"
ln -s "$d/brut" "$d/lien"
tirer_secret "$d/lien" "$moi_g" 400 octets32 "essai" >/dev/null 2>&1 && ko "tirer_secret : lien symbolique accepté"
mkdir -m 0777 "$work/ouvert"
tirer_secret "$work/ouvert/x" "$moi_g" 400 hex24 "essai" >/dev/null 2>&1 && ko "tirer_secret : dossier ouvert à tous accepté"
[ ! -e "$work/ouvert/x" ] || ko "tirer_secret : écrit dans un dossier ouvert à tous"
tirer_secret "$work/absent/x" "$moi_g" 400 hex24 "essai" >/dev/null 2>&1 && ko "tirer_secret : dossier absent accepté"
[ -z "$(find "$d" -name '.*')" ] || ko "tirer_secret : fichier temporaire resté"

# ecrire_secret : atomique, droits exacts, jamais d'écrasement sans remplacer=1, lien non suivi.
d=$work/saisi
mkdir -m 0700 "$d"
ecrire_secret "$d/s" "$moi_g" 400 0 "sk_test_PREMIER" || ko "ecrire_secret : refusé"
[ "$(stat -c '%u %a' "$d/s")" = "$moi 400" ] && [ "$(cat "$d/s")" = sk_test_PREMIER ] || ko "ecrire_secret : fichier ou droits"
code=0
ecrire_secret "$d/s" "$moi_g" 400 0 "sk_test_SECOND" || code=$?
[ "$code" = 3 ] || ko "ecrire_secret : écrasement sans remplacer (code $code)"
[ "$(cat "$d/s")" = sk_test_PREMIER ] || ko "ecrire_secret : secret existant changé"
ecrire_secret "$d/s" "$moi_g" 400 1 "sk_test_SECOND" && [ "$(cat "$d/s")" = sk_test_SECOND ] || ko "ecrire_secret : remplacement refusé"
echo garde >"$work/cible"
ln -s "$work/cible" "$d/l"
code=0
ecrire_secret "$d/l" "$moi_g" 400 0 "x" || code=$?
[ "$code" = 3 ] && [ "$(cat "$work/cible")" = garde ] || ko "ecrire_secret : lien suivi (code $code)"
ecrire_secret "$d/l" "$moi_g" 400 1 "y" && [ ! -L "$d/l" ] && [ "$(cat "$work/cible")" = garde ] || ko "ecrire_secret --remplacer : lien suivi"
ecrire_secret "$work/ouvert/s" "$moi_g" 400 0 "x" 2>/dev/null && ko "ecrire_secret : dossier ouvert à tous accepté"
[ -z "$(find "$d" -name '.*')" ] || ko "ecrire_secret : fichier temporaire resté"

# etat_secret et liste_secrets : états, jamais la valeur.
[ "$(etat_secret "$d/s" "$moi_g" 400)" = présent ] || ko "etat_secret : présent"
[ "$(etat_secret "$d/rien" "$moi_g" 400)" = absent ] || ko "etat_secret : absent"
[[ "$(etat_secret "$d/s" "$moi_g" 600)" == "mal réglé"* ]] || ko "etat_secret : mauvais droits"
mkdir -p "$secrets"
printf 'whsec_VALEURLISTE1234\n' >"$secrets/shh_stripe_webhook"
chmod 0400 "$secrets/shh_stripe_webhook"
l=$(liste_secrets 1)
grep -qE '^  shh_stripe_cle +absent ' <<<"$l" || ko "liste : shh_stripe_cle absent"
grep -qE '^  shh_stripe_webhook +(présent|mal réglé)' <<<"$l" || ko "liste : shh_stripe_webhook"
grep -q VALEURLISTE <<<"$l" && ko "liste : valeur affichée"
grep -qE '^  shh_paypal_secret +inconnu' <<<"$(liste_secrets 0)" || ko "liste : volume fermé non dit"
for n in $SECRETS_SAISIS $SECRETS_TIRES; do grep -qE "^  $n " <<<"$l" || ko "liste : $n absent"; done

# --- 3. contexte_du_commit : fichiers suivis du commit, rien d'autre ----------------------------
g=$work/depot
git init -q "$g"
mkdir -p "$g/server" "$g/deploy"
echo 'package main' >"$g/server/main.go"
echo 'FROM scratch' >"$g/deploy/Dockerfile"
echo '*.log' >"$g/.gitignore"
git -C "$g" add -A
git -C "$g" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m un
c=$(git -C "$g" rev-parse HEAD)
echo 'package main // piégé' >"$g/server/main.go"
echo 'package main' >"$g/server/porte.go"
echo x >"$g/server/ignore.log"
ctx=$work/ctx
mkdir "$ctx"
contexte_du_commit "$g" /dev/null "$c" "$ctx" || ko "contexte_du_commit : refusé"
[ "$(cat "$ctx/server/main.go" 2>/dev/null)" = 'package main' ] || ko "contexte_du_commit : modification de la copie de travail reprise"
[ ! -e "$ctx/server/porte.go" ] || ko "contexte_du_commit : fichier non suivi repris"
[ ! -e "$ctx/server/ignore.log" ] || ko "contexte_du_commit : fichier ignoré repris"
[ -f "$ctx/deploy/Dockerfile" ] && [ -f "$ctx/.gitignore" ] || ko "contexte_du_commit : fichier suivi manquant"
contexte_du_commit "$g" /dev/null "$c" "$ctx" 2>/dev/null && ko "contexte_du_commit : dossier non vide accepté"
mkdir "$work/ctx2"
contexte_du_commit "$g" /dev/null "$(printf '%040d' 7)" "$work/ctx2" 2>/dev/null && ko "contexte_du_commit : commit inconnu accepté"
# Le vrai dépôt : même liste de fichiers que git ls-files (contexte d'aujourd'hui, filtré ensuite
# par le même .dockerignore).
if git -C "$here/.." rev-parse --verify -q HEAD >/dev/null 2>&1; then
	mkdir "$work/vrai"
	if contexte_du_commit "$here/.." /dev/null HEAD "$work/vrai"; then
		diff <(git -C "$here/.." ls-tree -r --name-only HEAD | sort) <(cd "$work/vrai" && find . -type f -o -type l | sed 's|^\./||' | sort) >/dev/null ||
			ko "contexte_du_commit : fichiers différents de ceux du commit"
	else
		ko "contexte_du_commit : dépôt du kit refusé"
	fi
	rm -rf "$work/vrai"
fi

# --- 4. Texte des scripts -----------------------------------------------------------------------
for f in commun.sh alerte.sh sauvegarder.sh; do
	grep -qE '^[[:space:]]*(\.|source) .*(\.env|env_file)' "$here/$f" && ko "$f : deploy/.env encore exécuté"
	grep -q 'lire_env ' "$here/$f" || ko "$f : deploy/.env non lu par lire_env"
done
grep -q -- '-t "$image" "$depot"' "$here/preprod.sh" && ko "preprod.sh : construit depuis la copie de travail"
grep -q 'contexte_du_commit "$depot" "$VERROUS_SIGNATAIRES" "$c" "$ctx"' "$here/preprod.sh" || ko "preprod.sh : contexte du commit absent"
grep -q -- '-t "$image" "$ctx"' "$here/preprod.sh" || ko "preprod.sh : construction hors du contexte du commit"
grep -q -- '-f "$ctx/deploy/Dockerfile"' "$here/preprod.sh" || ko "preprod.sh : Dockerfile hors du contexte du commit"
grep -qx 'jeton_preprod=installer' "$here/preprod.sh" || ko "preprod.sh : jeton non tiré à l'installation"
grep -q 'sha256:\* | rollback) jeton_preprod=installer' "$here/deploy.sh" || ko "deploy.sh : jeton non tiré à l'installation"
for f in secret.sh etat.sh admin-jeton.sh; do grep -qx 'jeton_preprod=sans' "$here/$f" || ko "$f : lit le jeton de préproduction"; done
# secrets_auto : seulement dans preflight, après le contrôle de secrets/ et avant celui de la clé.
com=$here/commun.sh
a=$(grep -n -m1 'die "$secrets absent ou mal réglé' "$com" | cut -d: -f1)
b=$(grep -n '^	secrets_auto$' "$com" | cut -d: -f1)
k=$(grep -n -m1 '\[ -f "$secrets/shh_comptes_cle" \]' "$com" | cut -d: -f1)
[ -n "$a" ] && [ -n "$b" ] && [ -n "$k" ] && [ "$a" -lt "$b" ] && [ "$b" -lt "$k" ] || ko "commun.sh : secrets_auto mal placé"
[ "$(grep -c 'secrets_auto$' "$com")" = 1 ] || ko "commun.sh : secrets_auto appelé ailleurs"
# Aucune valeur de secret en argument d'une commande externe (echo et printf sont internes).
grep -nE '(cat|echo|printf)[^|]*\$(v1|v2)\b' "$here/secret.sh" | grep -v 'printf -v' && ko "secret.sh : valeur affichée"
grep -qE 'read -rs -p "Valeur' "$here/secret.sh" || ko "secret.sh : saisie non masquée"
grep -qE '^\[ -t 0 \] \|\|' "$here/secret.sh" || ko "secret.sh : terminal non exigé"
grep -q '\[ ! -t 1 \]' "$here/lien-acces.sh" || ko "lien-acces.sh : terminal non exigé"
grep -q '\[ ! -t 0 \] || \[ ! -t 1 \]' "$here/admin-jeton.sh" || ko "admin-jeton.sh : terminal non exigé"

# --- 5. Pour de vrai, en root : espace de montage à part ----------------------------------------
if [ "$moi" != 0 ] || ! command -v unshare >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1 ||
	! unshare -m sh -c "mount -t tmpfs none $work" 2>/dev/null; then
	echo "test-outils : outils sous root non essayés (root, unshare et python3 exigés : sudo deploy/test-outils.sh)" >&2
else
	etc_avant=$(find /etc/shhdrop -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort | tr '\n' ' ')
	k=$work/kit
	mkdir -p "$k/deploy" "$work/vol" "$work/ov-u" "$work/ov-w"
	cp -a "$here/." "$k/deploy/"
	rm -rf "$k/deploy/shhcheck" "$k/deploy/.env" "$k/deploy/.release"* "$k/deploy/.preprod" "$k/deploy/.provenance"
	# Terminal simulé : attend chaque invite, puis envoie la réponse (jamais d'écho du secret,
	# read -s coupe l'écho avant l'invite) ; écrit tout ce que le terminal a affiché.
	cat >"$work/pty.py" <<'EOF'
import os, pty, select, sys, time
args = sys.argv[1:]
sep = args.index("--")
cmd, paires = args[:sep], args[sep + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(cmd[0], cmd)
out = b""
def lire(motif, t):
    global out
    fin = time.time() + t
    while (motif is None or motif not in out) and time.time() < fin:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return
            if not d:
                return
            out += d
for i in range(0, len(paires), 2):
    motif = paires[i].encode()
    lire(motif, 20)
    out = out.replace(motif, motif.replace(b" ", b"\x01"), 1)
    os.write(fd, paires[i + 1].encode() + b"\r")
lire(None, 30)
_, st = os.waitpid(pid, 0)
sys.stdout.buffer.write(out.replace(b"\x01", b" "))
sys.exit(os.waitstatus_to_exitcode(st))
EOF
	cat >"$work/ns.sh" <<'EOF'
set -u
mount -t tmpfs -o mode=0755 none "$W/vol"
mount -t overlay overlay -o "lowerdir=/etc,upperdir=$W/ov-u,workdir=$W/ov-w" /etc
rm -rf /etc/shhdrop
install -d -o root -g root -m 0755 /etc/shhdrop
install -d -o root -g 65532 -m 0750 "$W/vol/secrets"
install -d -o 65532 -g 65532 -m 0700 "$W/vol/data"
D=$K/deploy
cat >"$D/.env" <<FIN
SHH_DOMAIN=shhgone.com
SHH_DATA_ROOT=$W/vol
SHH_PREPROD=1
SHH_PREPROD_PAIEMENT=1
SHH_PREPROD_PAIEMENT_ESSAI=1
FIN
chmod 0644 "$D/.env"
pty() { python3 -I "$W/pty.py" "$@"; }
o=$W/o
# secret.sh
pty "$D/secret.sh" shh_stripe_cle -- "Valeur : " sk_live_VALEURLIVE0123456789 "confirmer : " sk_live_VALEURLIVE0123456789 >"$o-live" 2>&1; echo $? >"$o-live.code"
pty "$D/secret.sh" shh_stripe_cle -- "Valeur : " sk_test_VALEURTEST0123456789 "confirmer : " sk_test_VALEURAUTRE0123456789 >"$o-diff" 2>&1; echo $? >"$o-diff.code"
pty "$D/secret.sh" shh_stripe_cle -- "Valeur : " " sk_test_VALEURTEST0123456789 " "confirmer : " sk_test_VALEURTEST0123456789 >"$o-bon" 2>&1; echo $? >"$o-bon.code"
stat -c '%u:%g %a' "$W/vol/secrets/shh_stripe_cle" >"$o-bon.stat" 2>&1
cat "$W/vol/secrets/shh_stripe_cle" >"$o-bon.contenu" 2>&1
pty "$D/secret.sh" shh_stripe_cle -- >"$o-encore" 2>&1; echo $? >"$o-encore.code"
cat "$W/vol/secrets/shh_stripe_cle" >"$o-encore.contenu" 2>&1
pty "$D/secret.sh" --remplacer shh_stripe_cle -- "Valeur : " rk_test_VALEURREMPL0123456789 "confirmer : " rk_test_VALEURREMPL0123456789 >"$o-rempl" 2>&1; echo $? >"$o-rempl.code"
cat "$W/vol/secrets/shh_stripe_cle" >"$o-rempl.contenu" 2>&1
pty "$D/secret.sh" alerte_smtp_mdp -- "Valeur : " "VALEURSMTP mdp" "confirmer : " "VALEURSMTP mdp" >"$o-smtp" 2>&1; echo $? >"$o-smtp.code"
stat -c '%u:%g %a' /etc/shhdrop/alerte_smtp_mdp >"$o-smtp.stat" 2>&1
cat /etc/shhdrop/alerte_smtp_mdp >"$o-smtp.contenu" 2>&1
printf 'whsec_VALEURTUYAU0123456789\nwhsec_VALEURTUYAU0123456789\n' | "$D/secret.sh" shh_stripe_webhook >"$o-tuyau" 2>&1; echo $? >"$o-tuyau.code"
pty "$D/secret.sh" shh_turn_secret -- >"$o-tire" 2>&1; echo $? >"$o-tire.code"
pty "$D/secret.sh" --liste -- >"$o-liste" 2>&1; echo $? >"$o-liste.code"
# secrets_auto (commun.sh, comme preflight l'appelle) : tout tiré, puis tout présent.
auto() { (cd "$D" && here=$PWD jeton_preprod=installer bash -c '. ./commun.sh && secrets_auto && printf "%s" "$SHH_PREPROD_JETON" >"$1"' _ "$1"); }
auto "$o-auto1.jeton" >"$o-auto1" 2>&1; echo $? >"$o-auto1.code"
for f in shh_comptes_cle shh_salons_cle shh_turn_secret; do stat -c "$f %u:%g %a %s" "$W/vol/secrets/$f"; done >"$o-auto1.stat" 2>&1
stat -c 'preprod-jeton %u:%g %a %s' /etc/shhdrop/preprod-jeton >>"$o-auto1.stat" 2>&1
cat "$W/vol/secrets/shh_comptes_cle" "$W/vol/secrets/shh_salons_cle" "$W/vol/secrets/shh_turn_secret" /etc/shhdrop/preprod-jeton | sha256sum >"$o-auto1.somme"
auto "$o-auto2.jeton" >"$o-auto2" 2>&1; echo $? >"$o-auto2.code"
cat "$W/vol/secrets/shh_comptes_cle" "$W/vol/secrets/shh_salons_cle" "$W/vol/secrets/shh_turn_secret" /etc/shhdrop/preprod-jeton | sha256sum >"$o-auto2.somme"
# Base de comptes sans sa clé (restauration incomplète) : refus, rien n'est tiré.
mv "$W/vol/secrets/shh_comptes_cle" "$W/cle-de-cote"
touch "$W/vol/data/comptes.db"
auto "$o-auto3.jeton" >"$o-auto3" 2>&1; echo $? >"$o-auto3.code"
[ ! -e "$W/vol/secrets/shh_comptes_cle" ]; echo $? >"$o-auto3.absente"
mv "$W/cle-de-cote" "$W/vol/secrets/shh_comptes_cle"
# lien-acces.sh
"$D/lien-acces.sh" >"$o-lien-tuyau" 2>&1; echo $? >"$o-lien-tuyau.code"
pty "$D/lien-acces.sh" -- "effacer l'écran. " "" >"$o-lien" 2>&1; echo $? >"$o-lien.code"
# admin-jeton.sh (aucune version installée : rien à réinstaller)
"$D/admin-jeton.sh" </dev/null >"$o-admin-tuyau" 2>&1; echo $? >"$o-admin-tuyau.code"
printf 'SHH_ADMIN_TOKEN=ancien\n' >>"$D/.env"
pty "$D/admin-jeton.sh" -- "sera effacé. " "" >"$o-admin" 2>&1; echo $? >"$o-admin.code"
cp "$D/.env" "$o-admin.env"
stat -c '%u %a' "$D/.env" >"$o-admin.stat"
pty "$D/admin-jeton.sh" -- >"$o-admin2" 2>&1; echo $? >"$o-admin2.code"
cmp -s "$D/.env" "$o-admin.env"; echo $? >"$o-admin2.inchange"
# etat.sh
pty "$D/etat.sh" -- >"$o-etat" 2>&1; echo $? >"$o-etat.code"
cat /etc/shhdrop/preprod-jeton >"$o-jeton-final"
EOF
	W=$work K=$k unshare -m bash "$work/ns.sh" || ko "outils sous root : banc interrompu"
	o=$work/o
	code() { cat "$o-$1.code" 2>/dev/null; }
	attendu() { # <cas> <code> <motif>
		[ "$(code "$1")" = "$2" ] || ko "$1 : code $(code "$1") (attendu $2) : $(tr -d '\r' <"$o-$1")"
		grep -qF -- "$3" "$o-$1" || ko "$1 : « $3 » absent de : $(tr -d '\r' <"$o-$1")"
	}
	attendu live 1 "clé de TEST attendue"
	attendu diff 1 "les deux saisies diffèrent"
	attendu bon 0 "Enregistré : shh_stripe_cle"
	[ "$(cat "$o-bon.stat")" = "65532:65532 400" ] || ko "secret.sh : droits $(cat "$o-bon.stat")"
	[ "$(cat "$o-bon.contenu")" = sk_test_VALEURTEST0123456789 ] || ko "secret.sh : contenu écrit faux"
	attendu encore 1 "existe déjà"
	[ "$(cat "$o-encore.contenu")" = sk_test_VALEURTEST0123456789 ] || ko "secret.sh : secret existant écrasé"
	attendu rempl 0 "Enregistré : shh_stripe_cle"
	[ "$(cat "$o-rempl.contenu")" = rk_test_VALEURREMPL0123456789 ] || ko "secret.sh --remplacer : non remplacé"
	grep -q "À faire aussi : sudo deploy/secret.sh shh_stripe_webhook" "$o-rempl" || ko "secret.sh : second secret de Stripe non rappelé"
	attendu smtp 0 "Enregistré : alerte_smtp_mdp"
	[ "$(cat "$o-smtp.stat")" = "0:0 600" ] || ko "secret.sh smtp : droits $(cat "$o-smtp.stat")"
	[ "$(cat "$o-smtp.contenu")" = "VALEURSMTP mdp" ] || ko "secret.sh smtp : contenu faux"
	attendu tuyau 1 "saisie au clavier exigée"
	attendu tire 1 "tiré par la machine"
	attendu liste 0 "Secrets (valeurs jamais affichées)"
	grep -qE '^  shh_stripe_cle +présent' "$o-liste" || ko "--liste : shh_stripe_cle non présent"
	grep -qE '^  shh_paypal_secret +absent' "$o-liste" || ko "--liste : shh_paypal_secret non absent"
	grep -qE '^  alerte_smtp_mdp +présent' "$o-liste" || ko "--liste : alerte_smtp_mdp non présent"
	attendu auto1 0 "compte : clé du serveur : créé"
	grep -qx "appels : secret du relais : créé" "$o-auto1" || ko "secrets_auto : relais non créé ($(cat "$o-auto1"))"
	grep -qx "salons : clé maîtresse : créé" "$o-auto1" || ko "secrets_auto : clé des salons non créée ($(cat "$o-auto1"))"
	grep -qx "préproduction : jeton d'accès : créé" "$o-auto1" || ko "secrets_auto : jeton non créé"
	printf 'shh_comptes_cle 65532:65532 400 32\nshh_salons_cle 65532:65532 400 32\nshh_turn_secret 65532:65532 400 49\npreprod-jeton 0:0 600 65\n' |
		cmp -s - "$o-auto1.stat" || ko "secrets_auto : droits $(cat "$o-auto1.stat")"
	[ "$(cat "$o-auto1.jeton")" = "$(cat "$o-jeton-final")" ] || ko "secrets_auto : jeton tiré non donné à Caddy"
	attendu auto2 0 "compte : clé du serveur : présent"
	if ! grep -qx "appels : secret du relais : présent" "$o-auto2" || ! grep -qx "salons : clé maîtresse : présent" "$o-auto2" || ! grep -qx "préproduction : jeton d'accès : présent" "$o-auto2"; then
		ko "secrets_auto (2e fois) : $(cat "$o-auto2")"
	fi
	grep -q créé "$o-auto2" && ko "secrets_auto : recréé"
	cmp -s "$o-auto1.somme" "$o-auto2.somme" || ko "secrets_auto : secret existant écrasé"
	attendu auto3 1 "remettre la clé depuis sa copie hors ligne"
	[ "$(cat "$o-auto3.absente")" = 0 ] || ko "secrets_auto : clé tirée alors qu'une base de comptes existe"
	attendu lien-tuyau 1 "le lien est un secret"
	attendu lien 0 "https://shhgone.com/acces/$(cat "$o-jeton-final")"
	attendu admin-tuyau 1 "le jeton est un secret"
	attendu admin 0 "ssh -N -L 127.0.0.1:9191:172.30.53.2:9191"
	jt=$(tr -d '\r' <"$o-admin" | sed -nE 's/^  ([0-9a-f]{64})$/\1/p')
	if [ -z "$jt" ]; then
		ko "admin-jeton.sh : jeton non affiché"
	else
		grep -qx "SHH_ADMIN_TOKEN_SHA256=$(printf '%s' "$jt" | sha256sum | cut -c1-64)" "$o-admin.env" || ko "admin-jeton.sh : empreinte fausse"
		grep -qF "$jt" "$o-admin.env" && ko "admin-jeton.sh : jeton écrit dans deploy/.env"
	fi
	grep -qx 'SHH_ADMIN_LISTEN=172.30.53.2:9191' "$o-admin.env" || ko "admin-jeton.sh : SHH_ADMIN_LISTEN absent"
	grep -q 'SHH_ADMIN_TOKEN=' "$o-admin.env" && ko "admin-jeton.sh : jeton en clair gardé"
	grep -qx 'SHH_PREPROD_PAIEMENT_ESSAI=1' "$o-admin.env" || ko "admin-jeton.sh : autres réglages perdus"
	[ "$(cat "$o-admin.stat")" = "0 644" ] || ko "admin-jeton.sh : droits de deploy/.env changés"
	attendu admin2 1 "un jeton existe déjà"
	[ "$(cat "$o-admin2.inchange")" = 0 ] || ko "admin-jeton.sh : deploy/.env changé sans --remplacer"
	attendu etat 0 "Mode : PRÉPRODUCTION"
	for m in "Volume chiffré" "Certificat HTTPS" "Disque" "Secrets" "paiement : activé, ESSAI" "Mises à jour du système"; do
		grep -qF "$m" "$o-etat" || ko "etat.sh : « $m » absent"
	done
	grep -qE '^  shh_comptes_cle +présent' <(tr -d '\r' <"$o-etat") || ko "etat.sh : secrets non listés"
	# Aucune valeur de secret dans aucune sortie (sauf le lien et le jeton du tableau de bord,
	# affichés exprès, sur un terminal seulement).
	for v in VALEURLIVE VALEURTEST VALEURAUTRE VALEURREMPL VALEURSMTP VALEURTUYAU; do
		grep -l "$v" "$o"-* 2>/dev/null | grep -vE 'contenu$' && ko "secret « $v » affiché"
	done
	j=$(cat "$o-jeton-final")
	grep -l "$j" "$o"-* 2>/dev/null | grep -vE '/o-(lien|jeton-final|auto[12]\.jeton)$' && ko "jeton de préproduction affiché ailleurs que par lien-acces.sh"
	if [ -n "$jt" ]; then
		grep -l "$jt" "$o"-* 2>/dev/null | grep -vE '/o-admin$' && ko "jeton du tableau de bord affiché ailleurs"
	fi
	[ "$(find /etc/shhdrop -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort | tr '\n' ' ')" = "$etc_avant" ] || ko "vrai /etc/shhdrop touché"
fi

if [ "$echec" = 0 ]; then
	echo "test-outils : tous les essais passent"
else
	exit 1
fi

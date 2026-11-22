#!/usr/bin/env bash
# Test de la sauvegarde et de la restauration de comptes.db (conception du compte §21.13 ;
# plan, lot 8) et de paiements.db (conception du paiement §5.1, S11), sur des données factices,
# en mémoire (/dev/shm), avec le vrai serveur Go.
#
# Ce qui est prouvé :
#   1. un compte de test est créé par le vrai parcours (ALTCHA, code reçu par un faux SMTP sur
#      la boucle locale, inscription/fin), serveur lancé sous le compte 65532 comme en
#      production ;
#   2. sauvegarder.sh refuse de tourner sans clé publique, avec une autre version d'age, hors
#      d'un point de montage, ou si le clair temporaire serait hors du volume (autre système de
#      fichiers, lien symbolique) ; aucun refus ne laisse de fichier ;
#   3. sauvegarde serveur EN MARCHE : un seul fichier envoyé, qui commence par
#      « age-encryption.org/v1 » et ne contient ni « h » du compte, ni adresse (exacte,
#      minuscule), ni pseudo, ni en-tête SQLite ; aucun clair laissé ;
#   4. effacement de la base, puis : mauvaise identité et fichier tronqué refusés sans rien
#      installer ; « verifier » ; « installer » (propriétaire 65532, 0600) ; réinstallation
#      refusée sans --remplacer, et refusée base ouverte même avec --remplacer ;
#   5. serveur relancé sur la base restaurée et la même clé : connexion du compte de test
#      réussie, mêmes h, enveloppe, séquestre et coffre de profil ; avec une autre clé du
#      serveur : connexion refusée (les deux copies hors ligne sont nécessaires) ;
#   6. l'adresse n'est nulle part dans la base restaurée ni dans les sorties du serveur ;
#   7. paiements.db (créée par le vrai serveur, SHH_PAIEMENT=1 en bac à sable, un pass factice) :
#      sauvegardée dans son propre fichier chiffré, sans l'empreinte du pass en clair ;
#      restaurée (65532, 0600), pass gardé, clés de jetons effacées.
#
# Ce qui n'est PAS prouvé ici : l'envoi https vers un vrai stockage objet (curl --aws-sigv4,
# droits en écriture seule, règle de cycle de vie : README §12), le minuteur systemd, le
# volume LUKS (ici : tmpfs).
#
# Usage (root : montage tmpfs, compte 65532) : deploy/test-restauration.sh
#   SHHDROP_BIN=…  binaire du serveur (défaut : construit depuis server/)
#   PORT_BASE=…    premier de 2 ports locaux libres (défaut : 18470)
#   KEEP=1         garde le dossier de travail
# Outils : age et age-keygen, sqlite3, curl, setpriv, Go (chaîne de deploy/shhcheck/go.mod).
set -euo pipefail
export LC_ALL=C

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(dirname "$here")
base=${PORT_BASE:-18470}
p_srv=$base p_smtp=$((base + 1))

fails=0
ok() { printf 'ok    %s\n' "$1"; }
ko() {
	printf 'ÉCHEC %s\n' "$1"
	fails=$((fails + 1))
}
check() { # check <description> <commande…>
	local d=$1
	shift
	if "$@" >/dev/null 2>&1; then ok "$d"; else ko "$d"; fi
}
refuse() { # refuse <description> <commande…> : la commande doit échouer
	local d=$1
	shift
	if "$@" >/dev/null 2>&1; then ko "$d"; else ok "$d"; fi
}
die() {
	printf 'erreur: %s\n' "$1" >&2
	exit 2
}

[ "$(id -u)" = 0 ] || die "à lancer en root (montage tmpfs de test, serveur sous le compte 65532)"
for c in age age-keygen sqlite3 curl setpriv go mountpoint findmnt; do
	command -v "$c" >/dev/null || die "$c introuvable"
done
[ -d /dev/shm ] || die "/dev/shm absent"

work=$(mktemp -d /dev/shm/shh-restau.XXXXXX)
chmod 0711 "$work"
racine=$work/racine  # « volume chiffré » de test : un tmpfs monté ici
depot=$work/depot    # « stockage objet » de test (file://), hors du volume
pid_srv=
arreter() {
	if [ -n "$pid_srv" ]; then
		kill "$pid_srv" 2>/dev/null || true
		wait "$pid_srv" 2>/dev/null || true
		pid_srv=
	fi
}
cleanup() {
	arreter
	for m in "$racine/sauvegarde" "$racine"; do
		if mountpoint -q "$m" 2>/dev/null; then umount "$m" || true; fi
	done
	if [ "${KEEP:-0}" = 1 ]; then echo "dossier gardé : $work"; else rm -rf -- "$work"; fi
}
trap cleanup EXIT

mkdir -p "$racine" "$depot" "$work/bin" "$work/autre"
# 1,1 Gio : le serveur exige SHH_STORAGE_MAX + 1 Gio libres (tmpfs : rien n'est réservé).
mount -t tmpfs -o size=1100m,mode=0755 tmpfs "$racine"
install -d -o 65532 -g 65532 -m 0700 "$racine/data" "$racine/sauvegarde"
install -d -o root -g 65532 -m 0750 "$racine/secrets"
head -c 32 /dev/urandom >"$racine/secrets/shh_comptes_cle"
printf 'mot-de-passe-smtp-factice' >"$racine/secrets/shh_smtp_mdp"
chown 65532:65532 "$racine/secrets/shh_comptes_cle" "$racine/secrets/shh_smtp_mdp"
chmod 0400 "$racine/secrets/shh_comptes_cle" "$racine/secrets/shh_smtp_mdp"
head -c 32 /dev/urandom >"$work/autre-cle"
chown 65532:65532 "$work/autre-cle"
chmod 0400 "$work/autre-cle"

age-keygen -o "$work/identite.txt" 2>/dev/null
pub=$(age-keygen -y "$work/identite.txt")
age-keygen -o "$work/autre-identite.txt" 2>/dev/null
version=$(age --version)

shhdrop=${SHHDROP_BIN:-}
if [ -z "$shhdrop" ]; then
	shhdrop=$work/bin/shhdrop
	(cd "$repo/server" && CGO_ENABLED=0 go build -trimpath -o "$shhdrop" ./cmd/shhdrop)
fi
chmod 0755 "$work/bin" "$shhdrop"

# demarrer <fichier de clé> : serveur Go, compte et salon activés, SMTP en clair vers la
# boucle locale (accepté seulement là), sous le compte 65532 ; attend SHH_LISTENING.
demarrer() {
	: >"$work/srv.stdout"
	env -i PATH="$PATH" SHH_DATA_DIR="$racine/data" SHH_LISTEN="127.0.0.1:$p_srv" SHH_STORAGE_MAX=1048576 \
		SHH_SALONS=1 SHH_ORIGIN="http://127.0.0.1:$p_srv" SHH_COMPTES=1 SHH_COMPTES_CLE_FILE="$1" \
		SHH_SMTP_HOST=127.0.0.1 SHH_SMTP_PORT="$p_smtp" SHH_SMTP_USER=essai \
		SHH_SMTP_PASSWORD_FILE="$racine/secrets/shh_smtp_mdp" SHH_MAIL_FROM='Shhgone <ne-pas-repondre@shhgone.test>' \
		setpriv --reuid=65532 --regid=65532 --clear-groups -- "$shhdrop" serve \
		>>"$work/srv.stdout" 2>>"$work/srv.stderr" &
	pid_srv=$!
	local _
	for _ in $(seq 1 100); do
		grep -q '^SHH_LISTENING ' "$work/srv.stdout" && return 0
		kill -0 "$pid_srv" 2>/dev/null || break
		sleep 0.1
	done
	cat "$work/srv.stderr" >&2
	die "le serveur ne démarre pas"
}

# compte <étape> : go test du compte de test (deploy/shhcheck/compte_test.go).
compte() {
	(cd "$here/shhcheck" && SHH_COMPTE_URL="http://127.0.0.1:$p_srv" SHH_COMPTE_ETAPE="$1" \
		SHH_COMPTE_ETAT="$work/etat.json" SHH_COMPTE_SMTP="127.0.0.1:$p_smtp" \
		go test -count=1 -run '^TestCompteRestauration$' -v . >"$work/compte-$1.txt" 2>&1) &&
		grep -q '^--- PASS: TestCompteRestauration' "$work/compte-$1.txt"
}

# env_sauvegarde <fichier> <racine> <destinataire> <version> : réglages de sauvegarder.sh.
env_sauvegarde() {
	printf 'SHH_DATA_ROOT=%s\nSHH_SAUVEGARDE_DESTINATAIRE=%s\nSHH_SAUVEGARDE_URL=file://%s/\nSHH_AGE_VERSION=%s\n' \
		"$2" "$3" "$depot" "$4" >"$1"
}
sauvegarder() { SHH_ENV_FILE=$1 SHH_SAUVEGARDE_OK="$work/sauvegarde-ok" "$here/sauvegarder.sh"; }
vides() { # vides <dossier…> : aucun fichier
	local d
	for d in "$@"; do [ -z "$(find "$d" -mindepth 1 -print -quit)" ] || return 1; done
}

# comptes_et_restes : fichiers de la base et restes de restauration du dossier de données
# (le reste, shares.db et les dossiers du serveur, n'est pas concerné).
comptes_et_restes() { find "$racine/data" -mindepth 1 -maxdepth 1 \( -name 'comptes*' -o -name '.restauration*' \) -printf '%f\n' | sort | tr '\n' ' '; }

# --- 1. Compte de test ------------------------------------------------------------------------
demarrer "$racine/secrets/shh_comptes_cle"
check "compte de test créé (ALTCHA, code reçu par e-mail, inscription/fin)" compte inscrire
[ -s "$work/etat.json" ] || {
	cat "$work/compte-inscrire.txt" >&2
	die "compte de test non créé"
}
h_hex=$(sed -nE 's/.*"h_hex":"([0-9a-f]{32})".*/\1/p' "$work/etat.json")
[ ${#h_hex} = 32 ] || die "h du compte de test illisible"
check "comptes.db sous le compte 65532, 0600" test "$(stat -c %u:%a "$racine/data/comptes.db")" = 65532:600

# contient <hex> <fichier…> : ces octets sont dans l'un des fichiers.
contient() {
	local x=$1
	shift
	cat -- "$@" | od -An -v -tx1 | tr -d ' \n' | grep -q "$x"
}
check "le h du compte est dans comptes.db ou son WAL (la recherche qui suit a un sens)" \
	contient "$h_hex" "$racine/data/comptes.db" "$racine/data/comptes.db-wal"

# --- 2. Refus de sauvegarder.sh -----------------------------------------------------------------
env_sauvegarde "$work/env.sans-cle" "$racine" "" "$version"
refuse "sauvegarde refusée sans clé publique" sauvegarder "$work/env.sans-cle"
env_sauvegarde "$work/env.mauvaise-cle" "$racine" "age1pasunecle" "$version"
refuse "sauvegarde refusée avec une clé publique mal formée" sauvegarder "$work/env.mauvaise-cle"
env_sauvegarde "$work/env.version" "$racine" "$pub" "0.0.1"
refuse "sauvegarde refusée avec une autre version d'age" sauvegarder "$work/env.version"
mkdir -p "$work/pas-monte/data" "$work/pas-monte/sauvegarde"
env_sauvegarde "$work/env.pas-monte" "$work/pas-monte" "$pub" "$version"
refuse "sauvegarde refusée hors d'un point de montage" sauvegarder "$work/env.pas-monte"
env_sauvegarde "$work/env" "$racine" "$pub" "$version"
mount -t tmpfs -o size=8m,mode=0700 tmpfs "$racine/sauvegarde"
refuse "sauvegarde refusée : clair temporaire sur un autre système de fichiers" sauvegarder "$work/env"
umount "$racine/sauvegarde"
mv "$racine/sauvegarde" "$racine/sauvegarde.vrai"
ln -s "$work/autre" "$racine/sauvegarde"
refuse "sauvegarde refusée : dossier temporaire en lien symbolique" sauvegarder "$work/env"
rm "$racine/sauvegarde"
mv "$racine/sauvegarde.vrai" "$racine/sauvegarde"
check "aucun refus n'a rien envoyé ni laissé" vides "$depot" "$racine/sauvegarde" "$work/autre"

# --- 3. Sauvegarde, serveur en marche -----------------------------------------------------------
check "sauvegarde faite serveur en marche" sauvegarder "$work/env"
n=$(find "$depot" -type f | wc -l)
check "un seul fichier envoyé" test "$n" = 1
copie=$(find "$depot" -type f -name 'comptes-*.db.age' | head -n 1)
[ -n "$copie" ] || die "aucune sauvegarde dans le dépôt de test"
# shellcheck disable=SC2016 # expression évaluée par le bash fils
check "nom daté, en UTC (comptes-AAAA-MM-JJTHHMMSSZ.db.age)" \
	bash -c '[[ ${1##*/} =~ ^comptes-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.db\.age$ ]]' _ "$copie"
check "le fichier commence par age-encryption.org/v1" test "$(head -c 22 "$copie")" = "age-encryption.org/v1"
refuse "le fichier ne contient pas le h du compte" contient "$h_hex" "$copie"
email='Restauration.Repere+essai@exemple-shhdrop.org'
for r in "$email" "${email,,}" "repererestauratlon" "SQLite format 3"; do
	refuse "le fichier ne contient pas « $r »" grep -qaF -- "$r" "$copie"
done
check "aucun clair laissé dans le dossier temporaire" vides "$racine/sauvegarde"
check "dossier de données inchangé (base, -wal, -shm seulement)" \
	test "$(comptes_et_restes)" = "comptes.db comptes.db-shm comptes.db-wal "
check "base toujours sous le compte 65532 après la sauvegarde" \
	test "$(find "$racine/data" -maxdepth 1 -name 'comptes*' ! -user 65532 | wc -l)" = 0

# --- 4. Effacement, puis restauration -------------------------------------------------------------
arreter
rm -f -- "$racine/data/comptes.db" "$racine/data/comptes.db-wal" "$racine/data/comptes.db-shm"
refuse "mauvaise identité : refusée" "$here/restaurer.sh" installer "$copie" "$work/autre-identite.txt" "$racine/data"
head -c 1000 "$copie" >"$work/tronquee.age"
refuse "fichier tronqué : refusé" "$here/restaurer.sh" installer "$work/tronquee.age" "$work/identite.txt" "$racine/data"
check "aucun refus n'a rien installé ni laissé" test -z "$(comptes_et_restes)"
check "verifier : intégrité, tables, sans rien installer" "$here/restaurer.sh" verifier "$copie" "$work/identite.txt"
check "verifier n'a rien laissé en mémoire" test -z "$(find /dev/shm -maxdepth 1 -name 'shh-verif.*' -print -quit)"
"$here/restaurer.sh" verifier "$copie" "$work/identite.txt" >"$work/verifier.txt" 2>&1 || true
check "verifier compte un compte" grep -q '^intégrité : ok ; schéma [0-9]* ; 1 comptes$' "$work/verifier.txt"
check "installer : base restaurée" "$here/restaurer.sh" installer "$copie" "$work/identite.txt" "$racine/data"
check "base restaurée : 65532, 0600, sans -wal, -shm ni reste" \
	test "$(stat -c %u:%a "$racine/data/comptes.db") $(comptes_et_restes)" = "65532:600 comptes.db "
check "base restaurée : integrity_check ok" test "$(sqlite3 "$racine/data/comptes.db" 'PRAGMA integrity_check;')" = ok
check "base restaurée : le h du compte y est" contient "$h_hex" "$racine/data/comptes.db"
check "base restaurée : aucune session (chacun se reconnecte)" \
	test "$(sqlite3 "$racine/data/comptes.db" 'SELECT count(*) FROM sessions;')" = 0
# shellcheck disable=SC2016 # expression évaluée par le bash fils
check "la sauvegarde, elle, avait la session de l'inscription" \
	bash -c '"$1" verifier "$2" "$3" >/dev/null && age -d -i "$3" "$2" >"$4" && test "$(sqlite3 "$4" "SELECT count(*) FROM sessions;")" = 1' \
	_ "$here/restaurer.sh" "$copie" "$work/identite.txt" "$work/clair-controle.db"
rm -f -- "$work/clair-controle.db"*
for r in "$email" "${email,,}" "repererestauratlon"; do
	refuse "base restaurée : pas de « $r »" grep -qaiF -- "$r" "$racine/data/comptes.db"
done
refuse "réinstallation refusée sans --remplacer" "$here/restaurer.sh" installer "$copie" "$work/identite.txt" "$racine/data"
(
	exec 3<"$racine/data/comptes.db"
	sleep 30
) &
tient=$!
refuse "remplacement refusé : base ouverte par un processus" \
	"$here/restaurer.sh" installer --remplacer "$copie" "$work/identite.txt" "$racine/data"
kill "$tient" 2>/dev/null || true
wait "$tient" 2>/dev/null || true
check "remplacement accepté, ancienne base gardée à côté" \
	"$here/restaurer.sh" installer --remplacer "$copie" "$work/identite.txt" "$racine/data"
check "ancienne base : comptes.db.avant-restauration" test -f "$racine/data/comptes.db.avant-restauration"
rm -f -- "$racine/data/comptes.db.avant-restauration"

# --- 5. Connexion sur la base restaurée ------------------------------------------------------------
demarrer "$racine/secrets/shh_comptes_cle"
check "connexion du compte de test réussie sur la base restaurée (mêmes h, enveloppe, profil)" compte connecter
arreter
demarrer "$work/autre-cle"
check "avec une autre clé du serveur : connexion refusée" compte refuser
arreter

# --- 7. paiements.db ---------------------------------------------------------------------------------
printf 'sk_test_restauration' >"$racine/secrets/stripe_cle"
printf 'whsec_restauration' >"$racine/secrets/stripe_webhook"
chown 65532:65532 "$racine/secrets/stripe_cle" "$racine/secrets/stripe_webhook"
chmod 0400 "$racine/secrets/stripe_cle" "$racine/secrets/stripe_webhook"
: >"$work/srv.stdout"
env -i PATH="$PATH" SHH_DATA_DIR="$racine/data" SHH_LISTEN="127.0.0.1:$p_srv" SHH_STORAGE_MAX=1048576 \
	SHH_ORIGIN="http://127.0.0.1:$p_srv" SHH_PAIEMENT=1 SHH_PAIEMENT_ESSAI=1 SHH_TVA=oss \
	SHH_STRIPE_CLE_FILE="$racine/secrets/stripe_cle" SHH_STRIPE_WEBHOOK_FILE="$racine/secrets/stripe_webhook" \
	setpriv --reuid=65532 --regid=65532 --clear-groups -- "$shhdrop" serve \
	>>"$work/srv.stdout" 2>>"$work/srv.stderr" &
pid_srv=$!
for _ in $(seq 1 100); do
	grep -q '^SHH_LISTENING ' "$work/srv.stdout" && break
	sleep 0.1
done
arreter
pdb=$racine/data/paiements.db
check "paiements.db créée par le serveur (65532, 0600)" test "$(stat -c %u:%a "$pdb" 2>/dev/null)" = 65532:600
q_hex=5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e
setpriv --reuid=65532 --regid=65532 --clear-groups -- sqlite3 "$pdb" \
	"INSERT INTO passes(q, offre, debut_jour, fin_jour, jetons, recharge_jour, revoque) VALUES(x'$q_hex', 2, 86400, 864000, 100, 172800, 0);
	 INSERT INTO cles_jetons(jour, offre, sk) VALUES(86400, 2, x'$(printf 'c3%.0s' $(seq 1 1190))');"
rm -f -- "$depot"/*
check "sauvegarde des deux bases" sauvegarder "$work/env"
pcopie=$(find "$depot" -type f -name 'paiements-*.db.age' | head -n 1)
check "deux fichiers envoyés, dont paiements-….db.age" test "$(find "$depot" -type f | wc -l):${pcopie:+1}" = 2:1
check "paiements : le fichier commence par age-encryption.org/v1" test "$(head -c 22 "$pcopie")" = "age-encryption.org/v1"
refuse "paiements : pas l'empreinte du pass en clair" contient "$q_hex" "$pcopie"
refuse "paiements : pas d'en-tête SQLite en clair" grep -qaF -- "SQLite format 3" "$pcopie"
"$here/restaurer.sh" verifier "$pcopie" "$work/identite.txt" >"$work/verifier-p.txt" 2>&1 || true
age -d -i "$work/identite.txt" -o "$work/pclair.db" "$pcopie"
check "paiements : la copie n'a aucune clé de jetons (retirées avant le chiffrement)" test "$(sqlite3 "$work/pclair.db" 'SELECT count(*) FROM cles_jetons;')" = 0
refuse "paiements : aucun octet d'une clé de jetons dans la copie déchiffrée" grep -qaF -- "$(printf '\303%.0s' $(seq 1 64))" "$work/pclair.db"
check "paiements : la copie déchiffrée garde le pass" test "$(sqlite3 "$work/pclair.db" "SELECT count(*) FROM passes WHERE q=x'$q_hex';")" = 1
rm -f -- "$work/pclair.db"
check "paiements : verifier compte un pass" grep -q '^intégrité : ok ; base des paiements ; schéma [0-9]* ; 1 pass$' "$work/verifier-p.txt"
rm -f -- "$pdb" "$pdb-wal" "$pdb-shm"
check "paiements : installer" "$here/restaurer.sh" installer "$pcopie" "$work/identite.txt" "$racine/data"
check "paiements restaurée : 65532, 0600" test "$(stat -c %u:%a "$pdb")" = 65532:600
check "paiements restaurée : le pass y est" test "$(sqlite3 "$pdb" "SELECT count(*) FROM passes WHERE q=x'$q_hex';")" = 1
check "paiements restaurée : clés de jetons effacées (jetons d'avant refusés)" test "$(sqlite3 "$pdb" 'SELECT count(*) FROM cles_jetons;')" = 0
check "comptes.db intacte à côté" test -f "$racine/data/comptes.db"

# --- 6. Adresse absente des sorties ---------------------------------------------------------------
for f in "$work/srv.stdout" "$work/srv.stderr"; do
	refuse "${f##*/} : pas d'adresse" grep -qaiF -- "${email,,}" "$f"
done

if [ "$fails" -ne 0 ]; then
	for f in "$work"/compte-*.txt; do
		printf -- '--- %s\n' "${f##*/}"
		tail -n 20 "$f"
	done
	echo "$fails échec(s)"
	exit 1
fi
echo "tous les contrôles passent"

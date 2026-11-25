#!/usr/bin/env bash
# Sauvegarde quotidienne chiffrée de comptes.db et de paiements.db (conception du compte §21.13 ;
# conception du paiement §5.1 : perdre paiements.db perdrait les pass payés).
# Lancée par le minuteur systemd deploy/systemd/shhdrop-sauvegarde.timer, en root, sur la
# machine (jamais dans le conteneur : le serveur Go n'a aucune sortie de plus pour elle).
#
# Ce qu'elle fait, dans l'ordre :
#   pour chaque base présente (comptes.db, puis paiements.db ; une base absente est sautée) :
#   1. copie cohérente de la base (« sqlite3 .backup », serveur en marche ou non), faite
#      sous le compte propriétaire de la base (65532), dans <SHH_DATA_ROOT>/sauvegarde/ : le
#      clair temporaire ne quitte jamais le volume chiffré (refus sinon) ;
#   2. PRAGMA integrity_check de la copie (une copie abîmée n'est pas envoyée) ; pour
#      paiements.db, les clés privées d'émission des jetons sont retirées de la copie ;
#   3. chiffrement par age (format age-encryption.org/v1, X25519) vers la clé PUBLIQUE de
#      l'exploitant ; le clair est effacé aussitôt après ;
#   4. envoi du seul chiffré au stockage objet (compte en écriture seule, chez un autre
#      fournisseur que l'hébergeur), puis effacement du chiffré local.
# Chaque base part dans son propre fichier : comptes-<date>.db.age, paiements-<date>.db.age.
# Rien d'autre n'est sauvegardé : ni shares.db, ni partages, ni salons, ni la clé du serveur
# (K_serveur), qui se garde à part, hors ligne (README §12). La rotation (7 jours, README §12) est la
# règle de cycle de vie du stockage, pas ce script : le compte en écriture seule ne peut ni
# lister ni effacer.
#
# Réglages, dans deploy/.env (ou le fichier désigné par SHH_ENV_FILE, pour les essais) :
#   SHH_DATA_ROOT                 point de montage du volume chiffré (comme deploy.sh)
#   SHH_SAUVEGARDE_DESTINATAIRE   clé publique age de l'exploitant (age1…, X25519)
#   SHH_SAUVEGARDE_URL            préfixe de destination, barre finale comprise :
#                                 https://<seau>.<point d'accès S3>/<dossier>/ (production) ou
#                                 file:///<dossier>/ (essais : test-restauration.sh)
#   SHH_AGE_VERSION               version exacte d'age attendue (« age --version »)
#   SHH_SAUVEGARDE_ACCES          (facultatif) fichier de configuration curl de l'accès en
#                                 écriture seule, root 0600 ; défaut :
#                                 <SHH_DATA_ROOT>/sauvegarde-acces.curl (README §12)
#
# Codes de sortie : 0 sauvegardes envoyées (ou rien à sauvegarder : compte et paiement
# désactivés), 1 échec.
# La sortie ne contient ni clé, ni adresse, ni contenu : le nom du fichier envoyé et sa taille.
set -euo pipefail
umask 077
export LC_ALL=C

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
die() {
	printf 'sauvegarde : %s\n' "$1" >&2
	exit 1
}

env_file=${SHH_ENV_FILE:-$here/.env}
[ -f "$env_file" ] || die "$env_file absent"
# Lu en NOM=valeur, jamais exécuté (lire-env.sh : refusé s'il n'est pas à root ou modifiable par
# d'autres) ; ses variables sont exportées, comme avant.
# shellcheck source=deploy/lire-env.sh
. "$here/lire-env.sh"
lire_env "$env_file" 1 || die "$env_file refusé (voir ci-dessus)"

root=${SHH_DATA_ROOT:-}
dest=${SHH_SAUVEGARDE_DESTINATAIRE:-}
url=${SHH_SAUVEGARDE_URL:-}
version=${SHH_AGE_VERSION:-}
[[ $root =~ ^/[A-Za-z0-9/._-]+$ ]] || die "SHH_DATA_ROOT manquant ou invalide (chemin absolu, [A-Za-z0-9/._-])"
[[ $dest =~ ^age1[02-9ac-hj-np-z]{58}$ ]] ||
	die "SHH_SAUVEGARDE_DESTINATAIRE manquant ou invalide (clé publique age X25519 : age1…)"
case $url in
https://?*/ | file:///?*/) ;;
*) die "SHH_SAUVEGARDE_URL invalide : https://…/ (ou file:///…/ pour les essais), barre finale comprise" ;;
esac
[[ $url =~ ^[A-Za-z0-9:/._~%-]+$ ]] || die "SHH_SAUVEGARDE_URL : caractère non permis"
[ -n "$version" ] || die "SHH_AGE_VERSION manquant (version exacte d'age, README §12)"
for c in age sqlite3 curl findmnt mountpoint flock; do
	command -v "$c" >/dev/null || die "$c introuvable"
done
v=$(age --version)
[ "${v#v}" = "${version#v}" ] || die "age $v installé, $version attendu (SHH_AGE_VERSION)"

# --- Le clair temporaire reste sur le volume chiffré ----------------------------------------
mountpoint -q "$root" || die "$root n'est pas un point de montage : volume chiffré non monté ?"
tmp=$root/sauvegarde
cible=$(findmnt -no TARGET -T "$root")
[ -d "$tmp" ] && [ ! -L "$tmp" ] ||
	die "$tmp absent (install -d -o 65532 -g 65532 -m 0700 $tmp, README §12)"
[ "$(findmnt -no TARGET -T "$tmp")" = "$cible" ] && [ "$(stat -c %d "$tmp")" = "$(stat -c %d "$root")" ] ||
	die "$tmp n'est pas sur le volume chiffré $root : refus (le clair n'en sort jamais)"

# Une seule sauvegarde à la fois ; restes d'un passage interrompu (clair compris) effacés.
exec 9<"$tmp"
flock -n 9 || die "une sauvegarde est déjà en cours"
find "$tmp" -mindepth 1 -maxdepth 1 \( -name 'comptes-*' -o -name 'paiements-*' \) -exec rm -f -- {} + 2>/dev/null || true
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
clair="" chiffre=""
effacer_clair() { [ -z "$clair" ] || rm -f -- "$clair" "$clair-journal" "$clair-wal" "$clair-shm"; }
trap 'effacer_clair; [ -z "$chiffre" ] || rm -f -- "$chiffre"' EXIT

# sauver <base> <table> <table> <table> : une base, ses trois tables attendues.
sauver() {
	local base=$1 db=$root/data/$1.db
	if [ ! -e "$db" ]; then
		echo "sauvegarde : aucun $base.db (désactivé) : sautée"
		return 0
	fi
	[ -f "$db" ] && [ ! -L "$db" ] && [ "$(findmnt -no TARGET -T "$db")" = "$cible" ] ||
		die "$db : fichier ordinaire sur le volume chiffré attendu"

	# SQLite sous le compte propriétaire de la base : ses fichiers -wal et -shm, s'il les crée
	# (serveur arrêté), restent lisibles par le serveur.
	local owner_uid owner_gid as_owner
	owner_uid=$(stat -c %u "$db")
	owner_gid=$(stat -c %g "$db")
	as_owner=()
	if [ "$(id -u)" = 0 ] && [ "$owner_uid" != 0 ]; then
		command -v setpriv >/dev/null || die "setpriv introuvable (util-linux)"
		as_owner=(setpriv --reuid="$owner_uid" --regid="$owner_gid" --clear-groups --)
	fi

	clair=$tmp/$base-$stamp.db
	chiffre=$clair.age
	local nom=${chiffre##*/} ok n taille

	# 1. Copie cohérente (API de sauvegarde de SQLite ; attend au plus 10 s une écriture en cours).
	"${as_owner[@]}" sqlite3 -bail "$db" ".timeout 10000" ".backup '$clair'" ||
		die "copie de $base.db impossible"

	# 2. Intégrité, et c'est bien la base attendue (ses trois tables).
	ok=$("${as_owner[@]}" sqlite3 -bail "$clair" "PRAGMA integrity_check;") || ok=
	[ "$ok" = ok ] || die "copie de $base.db abîmée (integrity_check) : rien n'est envoyé"
	n=$("${as_owner[@]}" sqlite3 -bail "$clair" \
		"SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('$2','$3','$4');") || n=
	[ "$n" = 3 ] || die "copie de $base.db sans les tables $2, $3 et $4 : rien n'est envoyé"

	# 2 bis. paiements.db : clés privées d'émission des jetons retirées de la copie (jamais dans
	# une sauvegarde : une copie volée ne doit pas permettre de signer des jetons ; elles ne
	# servent que deux jours et la restauration les retire de toute façon, S9). VACUUM : aucune
	# page libre ne garde leurs octets.
	if [ "$base" = paiements ]; then
		"${as_owner[@]}" sqlite3 -bail "$clair" "PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; DELETE FROM cles_jetons; VACUUM;" >/dev/null ||
			die "retrait des clés de jetons de la copie impossible : rien n'est envoyé"
		n=$("${as_owner[@]}" sqlite3 -bail "$clair" "SELECT count(*) FROM cles_jetons;") || n=
		[ "$n" = 0 ] || die "clés de jetons encore dans la copie : rien n'est envoyé"
	fi

	# 3. Chiffrement, puis effacement du clair.
	age -r "$dest" -o "$chiffre" "$clair" || die "chiffrement par age impossible"
	effacer_clair
	[ "$(head -c 22 "$chiffre")" = "age-encryption.org/v1" ] || die "fichier chiffré inattendu (en-tête age absent)"
	taille=$(stat -c %s "$chiffre")

	# 4. Envoi du seul chiffré. Accès https : fichier de configuration curl (identifiants hors de la
	#    ligne de commande, invisibles dans la liste des processus).
	local args acces
	args=(-sS --fail --max-time 3600 --retry 3 --retry-delay 30 -o /dev/null -T "$chiffre")
	case $url in
	https://*)
		acces=${SHH_SAUVEGARDE_ACCES:-$root/sauvegarde-acces.curl}
		[ -f "$acces" ] && [ ! -L "$acces" ] || die "$acces absent (accès au stockage, README §12)"
		[ "$(stat -c %u "$acces")" = "$(id -u)" ] && [[ $(stat -c %a "$acces") =~ ^[46]00$ ]] ||
			die "$acces : propriétaire $(id -un) et droits 0600 attendus"
		args+=(--proto "=https" --proto-redir "=https" -K "$acces")
		;;
	file://*) args+=(--proto "=file") ;;
	esac
	curl "${args[@]}" "$url$nom" || die "envoi de $nom impossible"
	printf 'sauvegarde envoyée : %s (%s octets)\n' "$nom" "$taille"
	rm -f -- "$chiffre"
	chiffre=
}

sauver comptes comptes sessions bannis
sauver paiements passes commandes refs
# Réussite datée (heure Unix seulement), lue par alerte.sh : rien depuis 26 h → alerte.
ok=${SHH_SAUVEGARDE_OK:-/var/lib/shhdrop-sauvegarde/ok}
mkdir -p "$(dirname "$ok")"
date +%s >"$ok"

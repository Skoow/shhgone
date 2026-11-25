#!/usr/bin/env bash
# Restauration de comptes.db ou de paiements.db depuis une sauvegarde chiffrée par
# deploy/sauvegarder.sh (conception du compte §21.13 ; conception du paiement §5.1).
# La base est reconnue à ses tables (comptes, sessions, bannis, ou passes, commandes, refs).
# Linux, outils : age, sqlite3, coreutils.
#
#   restaurer.sh verifier <sauvegarde.age> <identité age>
#       Essai mensuel : déchiffre en mémoire (/dev/shm), vérifie l'intégrité et les tables,
#       affiche la version du schéma et le nombre de comptes, efface le clair. Ne touche à
#       aucune base.
#
#   restaurer.sh installer [--remplacer] <sauvegarde.age> <identité age> <dossier de données>
#       Sur la machine, SERVEUR ARRÊTÉ : déchiffre dans le dossier de données lui-même (le clair
#       ne quitte pas le volume chiffré), vérifie, efface les sessions de la copie (chacun se
#       reconnecte : une session fermée depuis la sauvegarde ne revient pas), puis installe
#       <dossier>/comptes.db
#       (propriétaire du dossier, 0600). Refus si un processus a encore la base ouverte. Une
#       base présente n'est remplacée qu'avec --remplacer : elle est alors gardée à côté
#       (comptes.db.avant-restauration, avec son -wal et son -shm), à effacer une fois le
#       compte de contrôle reconnecté. Un -wal ou un -shm orphelin est mis de côté aussi :
#       SQLite l'appliquerait à la base restaurée.
#
# Règles (README §12) : toujours la sauvegarde la PLUS RÉCENTE (les suppressions de comptes
# antérieures y sont appliquées ; en restaurer une plus ancienne ferait revenir des comptes
# supprimés) ; sans la même clé du serveur (K_serveur, copie hors ligne), les comptes restent
# utilisables mais l'unicité des pseudos est perdue (README §12.2). L'identité age peut être
# protégée par une phrase (age la demande).
#
# Codes de sortie : 0 réussite, 1 échec, 2 erreur d'usage.
set -euo pipefail
umask 077
export LC_ALL=C

die() {
	printf 'restauration : %s\n' "$1" >&2
	exit 1
}
usage() {
	printf 'usage: restaurer.sh verifier <sauvegarde.age> <identité age>\n' >&2
	printf '       restaurer.sh installer [--remplacer] <sauvegarde.age> <identité age> <dossier de données>\n' >&2
	exit 2
}

for c in age sqlite3; do
	command -v "$c" >/dev/null || die "$c introuvable"
done

# base_de <clair> : « comptes » ou « paiements » selon les tables ; sinon refus.
base_de() {
	local f=$1
	if [ "$(sqlite3 -bail "$f" "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('comptes','sessions','bannis');")" = 3 ]; then
		echo comptes
	elif [ "$(sqlite3 -bail "$f" "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN ('passes','commandes','refs');")" = 3 ]; then
		echo paiements
	else
		die "ni une base des comptes (comptes, sessions, bannis) ni une base des paiements (passes, commandes, refs)"
	fi
}
# verifier_copie <clair> : intégrité, tables, version ; affiche le résumé (aucune donnée).
verifier_copie() {
	local f=$1 ok v nb base
	ok=$(sqlite3 -bail "$f" "PRAGMA integrity_check;" 2>/dev/null) || ok=
	[ "$ok" = ok ] || die "base déchiffrée abîmée (integrity_check)"
	base=$(base_de "$f")
	v=$(sqlite3 -bail "$f" "PRAGMA user_version;")
	if [ "$base" = comptes ]; then
		nb=$(sqlite3 -bail "$f" "SELECT count(*) FROM comptes;")
		printf 'intégrité : ok ; schéma %s ; %s comptes\n' "$v" "$nb"
	else
		nb=$(sqlite3 -bail "$f" "SELECT count(*) FROM passes;")
		printf 'intégrité : ok ; base des paiements ; schéma %s ; %s pass\n' "$v" "$nb"
	fi
}

# dechiffrer <sauvegarde> <identité> <clair>
dechiffrer() {
	[ -f "$1" ] || die "$1 absent"
	[ -f "$2" ] || die "$2 absent"
	[ "$(head -c 22 "$1")" = "age-encryption.org/v1" ] || die "$1 n'est pas un fichier age"
	age -d -i "$2" -o "$3" "$1" || die "déchiffrement impossible (mauvaise identité, ou fichier abîmé)"
}

# ouverte <fichier> : un processus de la machine (conteneurs compris) a ce fichier ouvert.
# Comparaison par périphérique et inode : le chemin vu dans un conteneur n'est pas celui-ci.
ouverte() {
	local id fd
	[ -e "$1" ] || return 1
	id=$(stat -L -c %d:%i "$1")
	for fd in /proc/[0-9]*/fd/*; do
		[ "$(stat -L -c %d:%i "$fd" 2>/dev/null)" = "$id" ] && return 0
	done
	return 1
}

[ $# -ge 1 ] || usage
mode=$1
shift
case $mode in
verifier)
	[ $# -eq 2 ] || usage
	[ -d /dev/shm ] || die "/dev/shm absent : le clair ne s'écrit qu'en mémoire"
	w=$(mktemp -d /dev/shm/shh-verif.XXXXXX)
	trap 'rm -rf -- "$w"' EXIT
	dechiffrer "$1" "$2" "$w/copie.db"
	verifier_copie "$w/copie.db"
	;;
installer)
	remplacer=0
	if [ "${1:-}" = --remplacer ]; then
		remplacer=1
		shift
	fi
	[ $# -eq 3 ] || usage
	[ "$(id -u)" = 0 ] || die "installer se lance en root (processus des conteneurs, propriétaire du fichier)"
	src=$1 id=$2 dir=$3
	[ -d "$dir" ] && [ ! -L "$dir" ] || die "$dir : dossier de données absent"
	w=$(mktemp -d "$dir/.restauration.XXXXXX")
	trap 'rm -rf -- "$w"' EXIT
	dechiffrer "$src" "$id" "$w/copie.db"
	verifier_copie "$w/copie.db"
	base=$(base_de "$w/copie.db")
	db=$dir/$base.db
	for f in "$db" "$db-wal" "$db-shm"; do
		if ouverte "$f"; then die "$f est ouvert par un processus : arrêter le serveur d'abord (deploy.sh, README §12)"; fi
	done
	if [ -e "$db" ] && [ "$remplacer" = 0 ]; then
		die "$db existe : --remplacer pour la remplacer (elle sera gardée à côté)"
	fi
	for f in "$db" "$db-wal" "$db-shm"; do
		[ ! -e "$f.avant-restauration" ] || die "$f.avant-restauration existe déjà (restauration précédente) : l'effacer d'abord"
	done
	if [ "$base" = comptes ]; then
		# Sessions effacées : une session fermée après la sauvegarde (déconnexion, mot de passe
		# changé, appareil retiré) ne doit pas revenir. Chacun se reconnecte (README §12.5).
		sqlite3 -bail "$w/copie.db" "PRAGMA secure_delete=ON; DELETE FROM sessions; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null ||
			die "effacement des sessions de la copie impossible"
		[ "$(sqlite3 -bail "$w/copie.db" "SELECT count(*) FROM sessions;")" = 0 ] || die "sessions encore présentes"
	else
		# Paiements : jetons dépensés depuis la sauvegarde inconnus de la copie ; leurs clés du
		# jour aussi : effacées, de nouvelles sont tirées (un jeton d'avant ne passe plus, S9).
		sqlite3 -bail "$w/copie.db" "PRAGMA secure_delete=ON; DELETE FROM cles_jetons; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null ||
			die "effacement des clés de jetons de la copie impossible"
	fi
	rm -f -- "$w/copie.db-wal" "$w/copie.db-shm" "$w/copie.db-journal"
	chown --reference="$dir" "$w/copie.db"
	chmod 0600 "$w/copie.db"
	for f in "$db" "$db-wal" "$db-shm"; do
		if [ -e "$f" ]; then mv -T -- "$f" "$f.avant-restauration"; fi
	done
	mv -T -- "$w/copie.db" "$db"
	sync -f "$db" 2>/dev/null || sync
	printf 'installée : %s (sauvegarde %s)\n' "$db" "${src##*/}"
	if [ "$remplacer" = 1 ]; then
		printf 'ancienne base gardée : %s.avant-restauration (à effacer après contrôle)\n' "$db"
	fi
	if [ "$base" = comptes ]; then
		echo "suite : relancer le serveur (deploy/deploy.sh \"\$(cat deploy/.release)\"), puis se connecter avec le compte de contrôle."
	else
		echo "suite : relancer le serveur (deploy/deploy.sh \"\$(cat deploy/.release)\"), puis vérifier l'état d'un pass de contrôle (page /offres/retour)."
	fi
	;;
*) usage ;;
esac

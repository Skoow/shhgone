#!/usr/bin/env bash
# Banc d'essai de deploy/bases.sh et du retour arrière de mettre_en_service (commun.sh) malgré
# une migration de schéma (D42-32 ; make lint-deploy). Sans réseau ni Docker : de vraies bases
# SQLite (sqlite3 exigé) dans un dossier temporaire ; mettre_en_service est extrait de commun.sh
# et lancé avec des imitations de dc et de check (rien d'autre n'est imité). En root, les bases
# appartiennent au compte 65532 comme sur le serveur (sqlite3 lancé sous ce compte, setpriv).
#
# Ce qui est prouvé :
#   1. copie : chaque base présente copiée (API de sauvegarde), intégrité vérifiée, 0600, dossier
#      0700 du propriétaire des données, versions des schémas notées, ancienne copie effacée ;
#      refus d'un dossier de copie mal réglé ou sur un autre système de fichiers ; base abîmée :
#      échec, rien de gardé ;
#   2. remise : la base dont le schéma a changé revient à la copie (ce qui a été écrit depuis est
#      perdu, -wal et -shm effacés), celle au même schéma est gardée telle quelle ;
#   3. mettre_en_service, contrôle réussi : ancien serveur arrêté AVANT la copie, nouvelle image
#      démarrée après, copie effacée, état noté ;
#   4. contrôle raté après une migration : nouveau serveur arrêté, bases remises AVANT de relancer
#      l'ancienne image, copie effacée, état inchangé ;
#   5. copie impossible : mise à jour annulée, ancienne image relancée, nouvelle jamais démarrée.
set -euo pipefail
export LC_ALL=C.UTF-8
here=$(cd "$(dirname "$0")" && pwd)
command -v sqlite3 >/dev/null || {
	echo "test-bases : sqlite3 introuvable" >&2
	exit 1
}
# shellcheck source=deploy/bases.sh
. "$here/bases.sh"

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
chmod 0755 "$work"
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}
ok() { printf 'ok    %s\n' "$*"; }
proprio=$(id -u):$(id -g)
[ "$(id -u)" != 0 ] || proprio=65532:65532

# donnees <dossier> : shares.db (schéma 6, un partage) et comptes.db (schéma 6, un compte) ;
# pas de paiements.db (paiement désactivé).
donnees() {
	local d=$1
	mkdir -p "$d"
	sqlite3 "$d/shares.db" "PRAGMA journal_mode=WAL; CREATE TABLE shares(id TEXT PRIMARY KEY); INSERT INTO shares VALUES('avant'); PRAGMA user_version=6;" >/dev/null
	sqlite3 "$d/comptes.db" "PRAGMA journal_mode=WAL; CREATE TABLE comptes(h BLOB PRIMARY KEY); INSERT INTO comptes VALUES(x'01'); PRAGMA user_version=6;" >/dev/null
	chmod 0700 "$d"
	chmod 0600 "$d"/*.db
	chown -R "$proprio" "$d"
}
compte() { sqlite3 -bail "$1" "SELECT count(*) FROM $2;"; }
version() { sqlite3 -bail "$1" "PRAGMA user_version;"; }
# migrer <dossier> : ce que ferait une image plus récente : schéma de shares.db monté, lignes
# écrites dans les deux bases ; un -wal et un -shm restent (serveur arrêté brutalement).
migrer() {
	sqlite3 "$1/shares.db" "INSERT INTO shares VALUES('pendant'); PRAGMA user_version=7;"
	sqlite3 "$1/comptes.db" "INSERT INTO comptes VALUES(x'02');"
	: >"$1/shares.db-shm"
	chown "$proprio" "$1"/shares.db*
}

# --- 1. Copie ---------------------------------------------------------------------------------
d=$work/v1/data r=$work/v1/retour
donnees "$d"
sortie=$(copie_bases "$d" "$r") || ko "copie refusée"
[ "$(stat -c '%u:%g %a' "$r")" = "$proprio 700" ] || ko "dossier de copie : $(stat -c '%u:%g %a' "$r")"
for b in shares comptes; do
	[ "$(stat -c %a "$r/$b.db")" = 600 ] || ko "$b.db : droits $(stat -c %a "$r/$b.db")"
	[ "$(sqlite3 -bail "$r/$b.db" 'PRAGMA integrity_check;')" = ok ] || ko "$b.db : copie abîmée"
done
[ ! -e "$r/paiements.db" ] || ko "base absente copiée"
[ "$(cat "$r/versions")" = "shares 6
comptes 6" ] || ko "versions notées : $(cat "$r/versions")"
grep -q 'shares.db (schéma 6)' <<<"$sortie" || ko "sortie de la copie : $sortie"
ok "copie cohérente, 0600, versions notées"
# Copie suivante : l'ancienne est effacée d'abord (une base disparue n'y reste pas).
mv "$d/comptes.db" "$work/comptes.db.de-cote"
copie_bases "$d" "$r" >/dev/null || ko "seconde copie refusée"
[ ! -e "$r/comptes.db" ] && [ "$(cat "$r/versions")" = "shares 6" ] || ko "ancienne copie restée"
mv "$work/comptes.db.de-cote" "$d/comptes.db"
copie_bases "$d" "$r" >/dev/null
ok "ancienne copie effacée avant la nouvelle"
# Dossier de copie mal réglé, ou sur un autre système de fichiers : refus.
chmod 0755 "$r"
if copie_bases "$d" "$r" >/dev/null 2>&1; then ko "dossier de copie en 0755 accepté"; else ok "dossier de copie mal réglé : refus"; fi
chmod 0700 "$r"
if [ -d /dev/shm ] && [ "$(stat -c %d /dev/shm)" != "$(stat -c %d "$d")" ]; then
	ailleurs=$(mktemp -d /dev/shm/test-bases.XXXXXX)
	chown "$proprio" "$ailleurs"
	if copie_bases "$d" "$ailleurs" >/dev/null 2>&1; then ko "copie hors du volume des données acceptée"; else ok "copie hors du volume des données : refus"; fi
	rm -rf -- "$ailleurs"
fi
# Base abîmée : échec, rien de gardé.
d2=$work/v2/data r2=$work/v2/retour
donnees "$d2"
printf 'pas une base SQLite, mais assez long pour en avoir lair...........................' >"$d2/comptes.db"
chown "$proprio" "$d2/comptes.db"
if copie_bases "$d2" "$r2" >/dev/null 2>&1; then ko "base abîmée copiée"; fi
[ -z "$(ls -A "$r2")" ] || ko "copie partielle gardée : $(ls -A "$r2")"
ok "base abîmée : échec, rien de gardé"

# --- 2. Remise --------------------------------------------------------------------------------
migrer "$d"
sortie=$(restaurer_bases "$d" "$r") || ko "remise refusée"
[ "$(version "$d/shares.db")" = 6 ] && [ "$(compte "$d/shares.db" shares)" = 1 ] || ko "shares.db non remise"
[ ! -e "$d/shares.db-shm" ] && [ ! -e "$d/shares.db-wal" ] || ko "fichiers du WAL restés"
[ "$(compte "$d/comptes.db" comptes)" = 2 ] || ko "comptes.db (schéma inchangé) remise : $(compte "$d/comptes.db" comptes) comptes"
[ "$(stat -c '%u:%g %a' "$d/shares.db")" = "$proprio 600" ] || ko "shares.db remise : $(stat -c '%u:%g %a' "$d/shares.db")"
if ! grep -q 'shares.db : remise à la copie' <<<"$sortie" || ! grep -q 'comptes.db : schéma inchangé' <<<"$sortie"; then ko "sortie de la remise : $sortie"; fi
ok "remise : base migrée revenue à la copie, base au même schéma gardée"
effacer_copie "$r"
[ -z "$(ls -A "$r")" ] || ko "copie non effacée : $(ls -A "$r")"
if restaurer_bases "$d" "$r" >/dev/null 2>&1; then ko "remise sans copie acceptée"; fi
ok "copie effacée ; remise sans copie : refus"

# --- 3 à 5. mettre_en_service (commun.sh), avec dc et check imités ----------------------------
eval "$(sed -n '/^mettre_en_service() {$/,/^}$/p' "$here/commun.sh")"
declare -F mettre_en_service >/dev/null || {
	echo "test-bases : mettre_en_service introuvable dans commun.sh" >&2
	exit 1
}
# lancer <dossier> <issue du contrôle de la nouvelle image : ok|ko> <migrer : 0|1> : rend la
# liste des appels à dc et l'état noté.
lancer() {
	local racine=$1
	# shellcheck disable=SC2034,SC2329 # variables et fonctions lues par mettre_en_service (eval)
	(
		cd "$racine"
		SHH_DATA_ROOT=$racine cur=sha256:ancienne cur_v=1.0.0 cur_c=$(printf 'a%.0s' {1..40}) VERROUS_COMMIT_INSTALLE=$racine/commit
		avec_stripe=1 avec_paypal=1 avec_nowpayments=1 appels=1 issue=$2 migre=$3
		printf '%s\n' "$cur" >.release
		etat_valide() { [ -n "$1" ]; }
		commit_valide() { [ ${#1} = 40 ]; }
		ecrire_commit_installe() { printf '%s\n' "$2" >"$1"; }
		die() {
			printf 'erreur: %s\n' "$1" >&2
			exit "${2:-1}"
		}
		dc() {
			printf '%s\n' "$*" >>"$racine/dc.log"
			if [ "$1 $2" = "sha256:nouvelle up" ] && [ "$migre" = 1 ]; then migrer "$racine/data"; fi
			if [ "$1 $2 $3" = "sha256:ancienne stop shhdrop" ]; then
				[ -z "$(ls -A "$racine/retour" 2>/dev/null)" ] || echo "COPIE DÉJÀ LÀ AVANT L'ARRÊT" >>"$racine/dc.log"
			fi
			if [ "$1 $2" = "sha256:ancienne up" ] && [ "$(version "$racine/data/shares.db")" != 6 ]; then
				echo "ANCIENNE IMAGE SUR UNE BASE PLUS RÉCENTE" >>"$racine/dc.log"
			fi
		}
		check() {
			printf 'check %s\n' "$1" >>"$racine/dc.log"
			[ "$1" = sha256:ancienne ] || [ "$issue" = ok ]
		}
		mettre_en_service sha256:nouvelle 2.0.0 "$(printf 'b%.0s' {1..40})" suite
	)
}
appels() { grep -v '^rm -sf' "$1/dc.log" | tr '\n' '|'; }

# 3. Contrôle réussi.
racine=$work/ms-ok
donnees "$racine/data"
lancer "$racine" ok 1 >/dev/null 2>&1 || ko "mise en service réussie : échec"
[ "$(appels "$racine")" = "sha256:ancienne stop shhdrop|sha256:nouvelle up -d --remove-orphans|check sha256:nouvelle|" ] ||
	ko "mise en service réussie, appels : $(appels "$racine")"
[ "$(cat "$racine/.release")" = sha256:nouvelle ] && [ "$(cat "$racine/.release.prev")" = sha256:ancienne ] || ko "état non noté"
[ -z "$(ls -A "$racine/retour")" ] || ko "copie gardée après une mise à jour réussie"
[ "$(version "$racine/data/shares.db")" = 7 ] || ko "base migrée remise après une mise à jour réussie"
ok "contrôle réussi : arrêt, copie, nouvelle image ; copie effacée"

# 4. Contrôle raté après une migration.
racine=$work/ms-ko
donnees "$racine/data"
if lancer "$racine" ko 1 >"$racine/sortie" 2>&1; then ko "contrôle raté : succès rendu"; fi
[ "$(appels "$racine")" = "sha256:ancienne stop shhdrop|sha256:nouvelle up -d --remove-orphans|check sha256:nouvelle|sha256:nouvelle stop shhdrop|sha256:ancienne up -d --remove-orphans|check sha256:ancienne|" ] ||
	ko "retour arrière, appels : $(appels "$racine")"
[ "$(version "$racine/data/shares.db")" = 6 ] && [ "$(compte "$racine/data/shares.db" shares)" = 1 ] || ko "shares.db non remise avant l'ancienne image"
[ "$(compte "$racine/data/comptes.db" comptes)" = 2 ] || ko "comptes.db (même schéma) remise"
[ "$(cat "$racine/.release")" = sha256:ancienne ] || ko "état changé par un retour arrière"
[ -z "$(ls -A "$racine/retour")" ] || ko "copie gardée après le retour arrière"
grep -q 'shares.db : remise à la copie' "$racine/sortie" || ko "perte non dite : $(cat "$racine/sortie")"
ok "contrôle raté : nouveau serveur arrêté, base migrée remise, ancienne image relancée"
# Sans migration : rien n'est remis (rien de perdu).
racine=$work/ms-ko-sans
donnees "$racine/data"
sqlite3 "$racine/data/shares.db" "INSERT INTO shares VALUES('apres-copie');" # écrit par la nouvelle image
if lancer "$racine" ko 0 >"$racine/sortie" 2>&1; then ko "contrôle raté (sans migration) : succès rendu"; fi
[ "$(compte "$racine/data/shares.db" shares)" = 2 ] || ko "base au même schéma remise (perte inutile)"
ok "contrôle raté sans migration : bases gardées telles quelles"

# 5. Copie impossible : mise à jour annulée.
racine=$work/ms-copie
donnees "$racine/data"
install -d -m 0755 "$racine/retour" # mal réglé : la copie est refusée
if lancer "$racine" ok 1 >"$racine/sortie" 2>&1; then ko "copie impossible : mise à jour faite"; fi
[ "$(appels "$racine")" = "sha256:ancienne stop shhdrop|sha256:ancienne up -d --remove-orphans|" ] || ko "copie impossible, appels : $(appels "$racine")"
grep -q 'mise à jour annulée' "$racine/sortie" || ko "copie impossible : message $(cat "$racine/sortie")"
ok "copie impossible : mise à jour annulée, ancienne image relancée"

if [ "$echec" != 0 ]; then
	echo "test-bases : ÉCHEC" >&2
	exit 1
fi
echo "test-bases : tout passe"

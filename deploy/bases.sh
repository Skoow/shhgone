#!/usr/bin/env bash
# Chargé (source) par commun.sh et test-bases.sh, jamais lancé seul.
# Copie des bases avant une mise à jour, et retour en arrière sûr malgré les migrations de schéma
# (D42-32 de la spécification, README « Mise à jour et retour arrière »).
#
# Une image plus récente peut faire monter le schéma d'une base (PRAGMA user_version : shares.db,
# comptes.db, paiements.db) ; une image plus ancienne refuse alors de l'ouvrir. Le retour arrière
# automatique de deploy.sh et de preprod.sh, après un contrôle de santé raté, laisserait donc le
# service arrêté. Ici :
#   - copie_bases : serveur ARRÊTÉ (README §1 : aucun outil n'ouvre shares.db pendant qu'il
#     tourne), copie cohérente de chaque base présente par l'API de sauvegarde de SQLite
#     (« sqlite3 .backup », sous le compte propriétaire de la base), intégrité vérifiée, droits
#     0600, sur le volume chiffré (dossier <SHH_DATA_ROOT>/retour, même système de fichiers que
#     les données, refus sinon), avec la version du schéma de chaque base ; l'ancienne copie est
#     d'abord effacée (shred) ;
#   - restaurer_bases : retour arrière, serveur arrêté : chaque base dont le schéma a changé depuis
#     la copie est remise à la copie (l'ancienne image ne l'ouvrirait pas) ; une base au même
#     schéma est gardée telle quelle (rien de perdu). Dit ce qui est perdu ;
#   - effacer_copie : la copie est effacée (shred) dès que la mise à jour est validée, ou après le
#     retour arrière : elle garderait sinon des lignes que le serveur a effacées depuis (partages
#     détruits, salons finis).
#
# Limites (dites dans le README) : shred réécrit les fichiers en place, ce qui suffit sur ext4
# (sans journal des données) au-dessus de LUKS ; sur un autre système de fichiers ou un disque à
# copie sur écriture, des blocs anciens peuvent rester (le volume reste chiffré). Une base remise
# perd tout ce qui a été écrit entre la mise à jour et le retour arrière.

# Bases du dossier de données, dans l'ordre de la copie.
BASES_NOMS=(shares comptes paiements)

# _base_sql <base> <arguments de sqlite3…> : sqlite3 sous le compte propriétaire de la base (ses
# fichiers -wal et -shm, s'il les crée, restent ceux du serveur) ; root seulement le change.
_base_sql() {
	local db=$1 uid gid
	shift
	uid=$(stat -c %u "$db") || return 1
	gid=$(stat -c %g "$db") || return 1
	if [ "$(id -u)" = 0 ] && [ "$uid" != 0 ]; then
		setpriv --reuid="$uid" --regid="$gid" --clear-groups -- sqlite3 -bail "$db" "$@"
	else
		sqlite3 -bail "$db" "$@"
	fi
}

# _effacer <fichier…> : effacement sûr (shred), sinon simple suppression ; absent : rien.
_effacer() {
	local f
	for f in "$@"; do
		[ -e "$f" ] || [ -L "$f" ] || continue
		if [ -f "$f" ] && [ ! -L "$f" ] && command -v shred >/dev/null 2>&1; then
			shred -u -- "$f" 2>/dev/null || rm -f -- "$f"
		else
			rm -f -- "$f"
		fi
	done
}

# effacer_copie <dossier de la copie> : la copie (bases, versions) effacée ; le dossier reste.
effacer_copie() {
	local d=$1
	[ -d "$d" ] && [ ! -L "$d" ] || return 0
	_effacer "$d"/*.db "$d"/*.db-wal "$d"/*.db-shm "$d"/*.db-journal "$d/versions"
}

# copie_bases <dossier des données> <dossier de la copie> : copie cohérente de chaque base
# présente, serveur arrêté. Rend 1 (et efface ce qui a été copié) si une copie échoue.
copie_bases() {
	local data=$1 dest=$2 b db v ok uid gid
	command -v sqlite3 >/dev/null 2>&1 ||
		{ echo "copie des bases : sqlite3 introuvable (apt install sqlite3, README §1)" >&2 && return 1; }
	[ -d "$data" ] && [ ! -L "$data" ] || { echo "copie des bases : $data absent" >&2 && return 1; }
	uid=$(stat -c %u "$data") gid=$(stat -c %g "$data")
	if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
		install -d -o "$uid" -g "$gid" -m 0700 "$dest" || return 1
	fi
	[ -d "$dest" ] && [ ! -L "$dest" ] && [ "$(stat -c '%u:%g %a' "$dest")" = "$uid:$gid 700" ] ||
		{ echo "copie des bases : $dest doit être un dossier $uid:$gid 0700" >&2 && return 1; }
	# Même système de fichiers que les données : le clair des bases ne quitte jamais le volume
	# chiffré, et la remise est un simple renommage.
	[ "$(stat -c %d "$dest")" = "$(stat -c %d "$data")" ] ||
		{ echo "copie des bases : $dest n'est pas sur le volume des données : refus" >&2 && return 1; }
	effacer_copie "$dest"
	_effacer "$dest/versions.tmp"
	(umask 077 && : >"$dest/versions.tmp") || return 1
	for b in "${BASES_NOMS[@]}"; do
		db=$data/$b.db
		[ -e "$db" ] || [ -L "$db" ] || continue
		if [ ! -f "$db" ] || [ -L "$db" ] || ! _base_sql "$db" ".timeout 10000" ".backup '$dest/$b.db'" ||
			! ok=$(_base_sql "$dest/$b.db" "PRAGMA integrity_check;") || [ "$ok" != ok ] ||
			! v=$(_base_sql "$dest/$b.db" "PRAGMA user_version;") || ! [[ $v =~ ^[0-9]+$ ]] ||
			! chmod 0600 "$dest/$b.db"; then
			echo "copie des bases : copie de $b.db impossible ou abîmée" >&2
			effacer_copie "$dest"
			_effacer "$dest/versions.tmp"
			return 1
		fi
		printf '%s %s\n' "$b" "$v" >>"$dest/versions.tmp"
	done
	mv -f -- "$dest/versions.tmp" "$dest/versions"
	sed 's/^/  copie : /; s/ \([0-9]*\)$/.db (schéma \1)/' "$dest/versions"
}

# restaurer_bases <dossier des données> <dossier de la copie> : serveur arrêté ; chaque base dont
# le schéma a changé depuis la copie est remise à la copie. Rend 1 si une remise échoue (la
# copie de cette base reste alors dans le dossier de la copie).
restaurer_bases() {
	local data=$1 dest=$2 b v n db err=0
	[ -f "$dest/versions" ] || { echo "retour arrière : aucune copie des bases ($dest/versions absent)" >&2 && return 1; }
	while read -r b v; do
		[[ $b =~ ^(shares|comptes|paiements)$ ]] && [[ $v =~ ^[0-9]+$ ]] && [ -f "$dest/$b.db" ] || {
			echo "retour arrière : copie illisible ($dest/versions)" >&2
			err=1
			continue
		}
		db=$data/$b.db
		n=
		[ -f "$db" ] && n=$(_base_sql "$db" ".timeout 10000" "PRAGMA user_version;" 2>/dev/null)
		if [ "$n" = "$v" ]; then
			echo "  $b.db : schéma inchangé ($v), gardée telle quelle (rien de perdu)"
			continue
		fi
		# Copie d'abord à côté de la base (même dossier : renommage atomique), puis base,
		# journal et fichiers du WAL effacés, puis la copie à sa place.
		if mv -f -- "$dest/$b.db" "$db.retour" && _effacer "$db" "$db-wal" "$db-shm" "$db-journal" && mv -f -- "$db.retour" "$db"; then
			echo "  $b.db : remise à la copie d'avant la mise à jour (schéma ${n:-?} → $v) ; perdu : ce qui y a été écrit depuis la mise à jour"
		else
			echo "retour arrière : remise de $b.db impossible" >&2
			err=1
		fi
	done <"$dest/versions"
	return "$err"
}

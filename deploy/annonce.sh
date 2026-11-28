#!/usr/bin/env bash
# Annonce d'une maintenance programmée (D42-32 de la spécification ; README « Redémarrer la
# machine ») : écriture et lecture du fichier <SHH_DATA_ROOT>/data/maintenance que lit le serveur
# (server/internal/maintenance). Chargé (source) par maintenance.sh, etat.sh, alerte.sh et
# test-maintenance.sh, jamais lancé seul.
#
# Format (une ligne, le même que maintenance.Analyser côté serveur) :
#   v1 <annonce> <début> <durée en min> <avance en min>
# annonce et début en secondes Unix. Aucune donnée d'utilisateur : rien que l'horaire public.

# Bornes : les mêmes que le serveur (maintenance.DureeMax, AvanceMax).
ANNONCE_DUREE_MAX=1440
ANNONCE_AVANCE_MAX=120
ANNONCE_AVANCE_DEFAUT=10
# L'heure tapée est celle de Paris (heure du propriétaire), dite aussi en UTC.
ANNONCE_FUSEAU=Europe/Paris

# annonce_heure <secondes Unix> : « mercredi 2 décembre 2026 à 06:00 (Paris, 05:00 UTC) ».
annonce_heure() {
	printf '%s (Paris, %s UTC)' "$(LC_ALL=fr_FR.UTF-8 TZ=$ANNONCE_FUSEAU date -d "@$1" '+%A %-d %B %Y à %H:%M' 2>/dev/null || TZ=$ANNONCE_FUSEAU date -d "@$1" '+%Y-%m-%d %H:%M')" \
		"$(TZ=UTC date -d "@$1" '+%H:%M')"
}

# annonce_ecrire <fichier> <« AAAA-MM-JJ HH:MM », heure de Paris> <durée en min> [<avance en min>]
# [<maintenant>] : annonce vérifiée (date valide, dans le futur et à moins de 60 jours ; bornes du
# serveur) puis écrite d'un coup (fichier temporaire du même dossier, renommé), au propriétaire du
# dossier, en 0600. Dit ce qui est annoncé. Rend 2 si l'annonce est refusée.
annonce_ecrire() {
	local f=$1 quand=$2 duree=$3 avance=${4:-$ANNONCE_AVANCE_DEFAUT} now=${5:-$(date +%s)} debut dir tmp
	if ! [[ $quand =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9]{2}:[0-9]{2}$ ]]; then
		echo "date refusée : « $quand » (attendu : \"AAAA-MM-JJ HH:MM\", heure de Paris)" >&2
		return 2
	fi
	debut=$(TZ=$ANNONCE_FUSEAU date -d "${quand/T/ }" +%s 2>/dev/null) &&
		[ "$(TZ=$ANNONCE_FUSEAU date -d "@$debut" '+%Y-%m-%d %H:%M')" = "${quand/T/ }" ] || {
		echo "date refusée : « $quand » n'existe pas (heure de Paris)" >&2
		return 2
	}
	[[ $duree =~ ^[1-9][0-9]{0,3}$ ]] && [ "$duree" -le "$ANNONCE_DUREE_MAX" ] ||
		{ echo "durée refusée : « $duree » (minutes, de 1 à $ANNONCE_DUREE_MAX)" >&2 && return 2; }
	[[ $avance =~ ^[1-9][0-9]{0,2}$ ]] && [ "$avance" -le "$ANNONCE_AVANCE_MAX" ] ||
		{ echo "avance refusée : « $avance » (minutes, de 1 à $ANNONCE_AVANCE_MAX)" >&2 && return 2; }
	if [ "$debut" -le "$now" ] || [ "$debut" -gt $((now + 60 * 86400)) ]; then
		echo "date refusée : $(annonce_heure "$debut") doit être dans le futur, à moins de 60 jours" >&2
		return 2
	fi
	dir=$(dirname -- "$f")
	[ -d "$dir" ] && [ ! -L "$dir" ] || { echo "$dir absent (volume chiffré déverrouillé ?)" >&2 && return 1; }
	tmp=$(mktemp "$dir/.maintenance.XXXXXX") || return 1
	if ! printf 'v1 %s %s %s %s\n' "$now" "$debut" "$duree" "$avance" >"$tmp" || ! chmod 0600 "$tmp" ||
		! chown "$(stat -c %u:%g "$dir")" "$tmp" || ! mv -f -- "$tmp" "$f"; then
		rm -f -- "$tmp"
		echo "annonce non écrite ($f)" >&2
		return 1
	fi
	echo "maintenance annoncée : $(annonce_heure "$debut"), environ $duree min"
	echo "  bandeau sur le site : dans les 5 minutes (à chaque chargement de page, puis toutes les 2 à 5 min)"
	echo "  nouvelles créations refusées à partir de $(annonce_heure $((debut - avance * 60))) ($avance min avant), jusqu'au redémarrage du serveur"
	echo "  retour annoncé aux visiteurs : $(annonce_heure $((debut + duree * 60)))"
}

# annonce_lire <fichier> : pose ann_annonce, ann_debut, ann_duree, ann_avance (secondes Unix,
# minutes) ; rend 1 si le fichier est absent, 2 s'il est illisible (le serveur l'ignore alors).
annonce_lire() {
	local f=$1 l v
	[ -e "$f" ] || [ -L "$f" ] || return 1
	[ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %s "$f")" -le 128 ] || return 2
	l=$(cat -- "$f") || return 2
	read -r v ann_annonce ann_debut ann_duree ann_avance <<<"$l"
	[ "$l" = "v1 $ann_annonce $ann_debut $ann_duree $ann_avance" ] && [ "$v" = v1 ] &&
		[[ $ann_annonce =~ ^[1-9][0-9]{0,11}$ ]] && [[ $ann_debut =~ ^[1-9][0-9]{0,11}$ ]] && [ "$ann_debut" -ge "$ann_annonce" ] &&
		[[ $ann_duree =~ ^[1-9][0-9]{0,3}$ ]] && [ "$ann_duree" -le "$ANNONCE_DUREE_MAX" ] &&
		[[ $ann_avance =~ ^[1-9][0-9]{0,2}$ ]] && [ "$ann_avance" -le "$ANNONCE_AVANCE_MAX" ] || return 2
}

# annonce_etat <fichier> <maintenant> [<démarrage du serveur, secondes Unix>] : une ligne lisible ;
# code rendu : 0 aucune, 1 annoncée, 2 imminente (créations refusées), 3 faite (serveur redémarré
# depuis ; le serveur efface l'annonce après la durée), 4 dépassée sans redémarrage, 5 illisible.
annonce_etat() {
	local f=$1 now=$2 dem=${3:-} seuil fin r=0
	annonce_lire "$f" || r=$?
	case $r in
	1)
		echo "aucune maintenance annoncée"
		return 0
		;;
	2)
		echo "annonce illisible ($f), ignorée par le serveur : sudo deploy/maintenance.sh annuler"
		return 5
		;;
	esac
	seuil=$((ann_debut - ann_avance * 60)) fin=$((ann_debut + ann_duree * 60))
	if [[ $dem =~ ^[0-9]+$ ]] && [ "$dem" -ge "$seuil" ] && [ "$dem" -ge "$ann_annonce" ]; then
		echo "faite : serveur redémarré le $(annonce_heure "$dem") ; l'annonce s'efface d'elle-même après $(annonce_heure "$fin")"
		return 3
	fi
	if [ "$now" -ge "$fin" ]; then
		echo "DÉPASSÉE sans redémarrage du serveur (prévue $(annonce_heure "$ann_debut"), environ $ann_duree min) : plus rien n'est refusé ; redémarrer, ou sudo deploy/maintenance.sh annuler"
		return 4
	fi
	if [ "$now" -ge "$seuil" ]; then
		echo "IMMINENTE : nouvelles créations refusées jusqu'au redémarrage du serveur (prévu $(annonce_heure "$ann_debut"), environ $ann_duree min)"
		return 2
	fi
	echo "annoncée : $(annonce_heure "$ann_debut"), environ $ann_duree min ; créations refusées à partir de $(annonce_heure "$seuil")"
	return 1
}

# annonce_demarrage : heure de démarrage (secondes Unix) du conteneur du serveur en marche
# (projet compose « shhdrop », service « shhdrop »), ou rien (arrêté, docker absent).
annonce_demarrage() {
	local id t
	command -v docker >/dev/null 2>&1 || return 0
	id=$(docker ps -q --filter label=com.docker.compose.project=shhdrop --filter label=com.docker.compose.service=shhdrop 2>/dev/null | head -n 1)
	[ -n "$id" ] || return 0
	t=$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null) || return 0
	date -d "$t" +%s 2>/dev/null || true
}

# annonce_annuler <fichier> : l'annonce est retirée (bandeau effacé, créations rouvertes dans
# les 15 s : le serveur relit le fichier). Absente : rien.
annonce_annuler() {
	local f=$1
	if [ ! -e "$f" ] && [ ! -L "$f" ]; then
		echo "aucune maintenance annoncée"
		return 0
	fi
	rm -f -- "$f" && echo "annonce retirée : bandeau effacé, créations rouvertes (dans les 15 secondes)"
}

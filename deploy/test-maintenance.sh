#!/usr/bin/env bash
# Banc d'essai de deploy/annonce.sh (maintenance programmée, D42-32 ; make lint-deploy), sans
# réseau ni Docker : annonces écrites dans un dossier temporaire, lues comme le serveur et comme
# etat.sh.
#
# Ce qui est prouvé :
#   1. annonce : heure de Paris (heure d'hiver et d'été), une ligne « v1 <annonce> <début>
#      <durée> <avance> » (le format de server/internal/maintenance), écrite d'un coup, 0600, au
#      propriétaire du dossier des données ; une nouvelle annonce remplace l'ancienne ;
#   2. refus : date mal écrite, inexistante (passage à l'heure d'été), passée, à plus de 60 jours ;
#      durée et avance hors des bornes du serveur ; rien n'est écrit ;
#   3. état : aucune, annoncée, imminente (au seuil), faite (serveur redémarré depuis), dépassée
#      sans redémarrage, illisible ;
#   4. annulation : fichier retiré ; sans annonce : rien.
set -euo pipefail
export LC_ALL=C.UTF-8
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=deploy/annonce.sh
. "$here/annonce.sh"

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}
ok() { printf 'ok    %s\n' "$*"; }
d=$work/data
mkdir -m 0700 "$d"
proprio=$(id -u):$(id -g)
if [ "$(id -u)" = 0 ]; then
	proprio=65532:65532
	chown "$proprio" "$d"
fi
f=$d/maintenance
# Lundi 30 novembre 2026, 10:00 UTC.
NOW=$(date -u -d '2026-11-30 10:00' +%s)

# --- 1. Annonce ---------------------------------------------------------------------------------
sortie=$(annonce_ecrire "$f" "2026-12-02 06:00" 30 "" "$NOW" 2>&1) || ko "annonce refusée : $sortie"
debut=$(date -u -d '2026-12-02 05:00' +%s) # 06:00 à Paris (heure d'hiver, UTC+1)
[ "$(cat "$f")" = "v1 $NOW $debut 30 10" ] || ko "contenu : $(cat "$f")"
[ "$(stat -c '%u:%g %a' "$f")" = "$proprio 600" ] || ko "droits : $(stat -c '%u:%g %a' "$f")"
[ -z "$(find "$d" -name '.maintenance.*')" ] || ko "fichier temporaire resté"
grep -q '06:00 (Paris, 05:00 UTC)' <<<"$sortie" || ko "heure dite : $sortie"
grep -q 'à partir de .*05:50 (Paris, 04:50 UTC)' <<<"$sortie" || ko "seuil dit : $sortie"
ok "annonce écrite (heure de Paris, format du serveur, 0600)"
# Forme « AAAA-MM-JJTHH:MM », avance réglée ; remplace l'annonce précédente.
annonce_ecrire "$f" "2027-01-10T08:15" 90 25 "$NOW" >/dev/null || ko "seconde annonce refusée"
[ "$(cat "$f")" = "v1 $NOW $(date -u -d '2027-01-10 07:15' +%s) 90 25" ] || ko "seconde annonce : $(cat "$f")"
annonce_ecrire "$f" "2026-12-20 23:59" 1440 120 "$NOW" >/dev/null || ko "bornes hautes refusées"
ok "nouvelle annonce : remplace l'ancienne ; bornes hautes acceptées"
NOW_ETE=$(date -u -d '2027-06-01 10:00' +%s)
annonce_ecrire "$f" "2027-06-03 06:00" 10 1 "$NOW_ETE" >/dev/null || ko "annonce d'été refusée"
[ "$(cut -d' ' -f3 "$f")" = "$(date -u -d '2027-06-03 04:00' +%s)" ] || ko "heure d'été : $(cat "$f")"
ok "heure d'été : 06:00 à Paris = 04:00 UTC"

# --- 2. Refus -----------------------------------------------------------------------------------
annonce_ecrire "$f" "2026-12-02 06:00" 30 10 "$NOW" >/dev/null
avant=$(cat "$f")
refus() { # <description> <arguments d'annonce_ecrire après le fichier…>
	local desc=$1 r=0
	shift
	annonce_ecrire "$f" "$@" >/dev/null 2>&1 || r=$?
	[ "$r" = 2 ] || ko "$desc : accepté (code $r)"
	[ "$(cat "$f")" = "$avant" ] || ko "$desc : annonce changée"
}
refus "date sans heure" "2026-12-02" 30 10 "$NOW"
refus "date en clair" "demain 6h" 30 10 "$NOW"
refus "date avec une zone" "2026-12-02 06:00 UTC" 30 10 "$NOW"
refus "31 novembre" "2026-11-31 06:00" 30 10 "$NOW"
refus "heure qui n'existe pas (passage à l'heure d'été)" "2027-03-28 02:30" 30 10 "$NOW"
refus "date passée" "2026-11-30 10:59" 30 10 "$NOW"
refus "à plus de 60 jours" "2027-02-01 06:00" 30 10 "$NOW"
refus "durée nulle" "2026-12-02 06:00" 0 10 "$NOW"
refus "durée trop longue" "2026-12-02 06:00" 1441 10 "$NOW"
refus "durée écrite en lettres" "2026-12-02 06:00" "30m" 10 "$NOW"
refus "durée avec un zéro devant" "2026-12-02 06:00" 030 10 "$NOW"
refus "avance nulle" "2026-12-02 06:00" 30 0 "$NOW"
refus "avance trop longue" "2026-12-02 06:00" 30 121 "$NOW"
ok "refus : date, durée et avance hors des règles ; rien d'écrit"

# --- 3. État ------------------------------------------------------------------------------------
etat() { # <maintenant> [<démarrage du serveur>] : code rendu, puis la ligne
	local r=0 l
	l=$(annonce_etat "$f" "$@") || r=$?
	printf '%s %s' "$r" "$l"
}
seuil=$((debut - 600)) fin=$((debut + 1800))
case $(etat "$NOW" $((NOW - 86400))) in "1 annoncée : "*) ;; *) ko "annoncée : $(etat "$NOW")" ;; esac
case $(etat $((seuil - 1)) $((NOW - 86400))) in "1 "*) ;; *) ko "juste avant le seuil : $(etat $((seuil - 1)))" ;; esac
case $(etat "$seuil" $((NOW - 86400))) in "2 IMMINENTE"*) ;; *) ko "au seuil : $(etat "$seuil")" ;; esac
case $(etat $((debut + 300)) $((debut + 120))) in "3 faite : serveur redémarré"*) ;; *) ko "faite : $(etat $((debut + 300)) $((debut + 120)))" ;; esac
case $(etat "$fin" $((NOW - 86400))) in "4 DÉPASSÉE"*) ;; *) ko "dépassée : $(etat "$fin")" ;; esac
case $(etat "$fin") in "4 DÉPASSÉE"*) ;; *) ko "dépassée (serveur arrêté) : $(etat "$fin")" ;; esac
# Démarré après le seuil mais avant l'annonce (annonce tardive) : pas encore faite.
annonce_ecrire "$f" "2026-11-30 11:05" 15 10 "$NOW" >/dev/null
case $(etat $((NOW + 60)) $((NOW - 60))) in "2 IMMINENTE"*) ;; *) ko "annonce tardive : $(etat $((NOW + 60)) $((NOW - 60)))" ;; esac
printf 'v1 1 2 3\n' >"$f"
case $(etat "$NOW") in "5 annonce illisible"*) ;; *) ko "illisible : $(etat "$NOW")" ;; esac
printf 'v1 %s %s 30 10\r\n' "$NOW" "$debut" >"$f"
case $(etat "$NOW") in "5 "*) ;; *) ko "fin de ligne CRLF acceptée" ;; esac
ok "état : annoncée, imminente au seuil, faite, dépassée, illisible"

# --- 4. Annulation ------------------------------------------------------------------------------
annonce_ecrire "$f" "2026-12-02 06:00" 30 10 "$NOW" >/dev/null
annonce_annuler "$f" | grep -q 'annonce retirée' || ko "annulation : message"
[ ! -e "$f" ] || ko "annulation : fichier resté"
annonce_annuler "$f" | grep -q 'aucune maintenance annoncée' || ko "annulation sans annonce"
case $(etat "$NOW") in "0 aucune maintenance annoncée") ;; *) ko "aucune : $(etat "$NOW")" ;; esac
ok "annulation"

if [ "$echec" != 0 ]; then
	echo "test-maintenance : ÉCHEC" >&2
	exit 1
fi
echo "test-maintenance : tout passe"

#!/usr/bin/env bash
# Banc d'essai de deploy/alerte.sh (make lint-deploy, job deploy-lint) : chaque contrôle est
# remplacé par une sortie fixe (variables SHH_ALERTE_*), rien n'est envoyé (pas de SHH_ALERTE_A),
# aucun accès au réseau. On vérifie quels sujets sortent, à quel niveau, et le rythme d'envoi.
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}

NOW=1795000000 # heure fixe des essais
jour() { date -u -d "@$((NOW + $1 * 86400))" +%Y-%m-%d; }

cat >"$work/env" <<EOF
SHH_DOMAIN=exemple.test
SHH_DATA_ROOT=$work/donnees
SHH_SAUVEGARDE_URL=file:///nulle-part/
EOF
mkdir -p "$work/donnees"

# Tout va bien : chaque remplacement donne un état sain.
sain() {
	export SHH_ENV_FILE="$work/env" SHH_ALERTE_MAINTENANT=$NOW
	export SHH_ALERTE_SANTE='echo "{\"ok\":true,\"reports_alert\":false}"'
	export SHH_ALERTE_DOCKER='true'
	export SHH_ALERTE_DF='printf "Use%% IUse%%\n 40%%  2%%\n"'
	export SHH_ALERTE_SMART_DISQUES='echo "sda disk"' SHH_ALERTE_SMART='echo "SMART overall-health self-assessment test result: PASSED"'
	export SHH_ALERTE_MEMINFO='printf "MemTotal: 1000 kB\nMemAvailable: 600 kB\n"'
	export SHH_ALERTE_LOADAVG='echo "0.5 0.4 0.3 1/100 42"' SHH_ALERTE_NPROC='echo 2'
	export SHH_ALERTE_CERT_FIN
	SHH_ALERTE_CERT_FIN="$(jour 60) 12:00:00 GMT"
	export SHH_ALERTE_RDAP
	SHH_ALERTE_RDAP="echo '{\"events\":[{\"eventAction\":\"registration\",\"eventDate\":\"2026-01-01T00:00:00Z\"},{\"eventAction\":\"expiration\",\"eventDate\":\"$(jour 300)T00:00:00Z\"}]}'"
	# Certificate Transparency (format de crt.sh) : le certificat servi (série 0a:1b, émis hier) et
	# un ancien de 40 jours (renouvelé depuis) : rien de suspect.
	export SHH_ALERTE_CERT_SERIE='0A1B' SHH_ALERTE_CT
	SHH_ALERTE_CT="echo '[{\"id\":1,\"entry_timestamp\":\"x\",\"not_before\":\"$(jour -1)T10:00:00\",\"serial_number\":\"0a1b\"},{\"id\":2,\"not_before\":\"$(jour -40)T10:00:00\",\"serial_number\":\"ffee\"}]'"
	export SHH_ALERTE_DNS='echo "192.0.2.10 STREAM exemple.test"' SHH_ALERTE_IPS='echo "1: lo inet 127.0.0.1/8"; echo "2: eth0 inet 192.0.2.10/24"'
	export SHH_ALERTE_SAUVEGARDE_OK="$work/sauvegarde-ok"
	echo $((NOW - 3600)) >"$work/sauvegarde-ok"
	export SHH_ALERTE_APT='echo "Inst libc6 [2.36-9] (2.36-9+deb12u9 Debian:12.9/stable [amd64])"'
	export SHH_ALERTE_REBOOT="$work/pas-de-redemarrage"
	export SHH_ALERTE_RETARD='echo 0' SHH_ALERTE_NTP='echo yes' SHH_ALERTE_UNITES='true'
	unset SHH_SERVEUR_ECHEANCE SHH_ALERTE_A
}

# lance <nom de l'essai> : nouvel état, sortie dans $work/<nom>.out
lance() {
	export SHH_ALERTE_ETAT="$work/etat-$1"
	"$here/alerte.sh" >"$work/$1.out" 2>"$work/$1.err" || ko "$1 : code $? ($(cat "$work/$1.err"))"
}
relance() { "$here/alerte.sh" >"$work/$1.out2" 2>>"$work/$1.err" || ko "$1 (2e passage) : code $?"; }
sujets() { sed -n 's/^ALERTE \(URGENT\|À prévoir\|Bilan\|Rappel\) \([^ ]*\) :.*/\1 \2/p' "$1" | sort; }
attendu() { # <essai> <lignes « niveau sujet » attendues, triées, séparées par des virgules>
	local got want
	got=$(sujets "$work/$1.out" | paste -sd, -)
	want=$(printf '%s' "$2" | tr ',' '\n' | sort | paste -sd, -)
	[ "$got" = "$want" ] || ko "$1 : attendu [$want], obtenu [$got]"
}

# 1. Tout va bien : seul le bilan sort, « Rien à signaler » ; le passage suivant ne dit rien.
sain
lance sain
attendu sain "Bilan bilan,Rappel restauration"
grep -q "Rien à signaler." "$work/sain.out" || ko "sain : bilan sans « Rien à signaler »"
grep -q "Domaine : 299 jour(s)" "$work/sain.out" || ko "sain : échéance RDAP non lue"
grep -q "Certificat TLS : 60 jour" "$work/sain.out" || ko "sain : jours du certificat"
grep -q "Location du serveur : non renseignée" "$work/sain.out" || ko "sain : location non renseignée"
relance sain
[ ! -s "$work/sain.out2" ] || ko "sain : deuxième passage bavard : $(cat "$work/sain.out2")"
# Une semaine plus tard : nouveau bilan.
SHH_ALERTE_MAINTENANT=$((NOW + 604800)) relance sain
grep -q "^ALERTE Bilan bilan" "$work/sain.out2" || ko "sain : pas de bilan la semaine suivante"

# 2. Urgences.
sain
export SHH_ALERTE_SANTE='echo "{\"ok\":false}"' SHH_ALERTE_DOCKER='echo abc123'
export SHH_ALERTE_DF='printf "Use%% IUse%%\n 93%%  95%%\n"' SHH_ALERTE_SMART='echo "test result: FAILED!"'
export SHH_ALERTE_MEMINFO='printf "MemTotal: 1000 kB\nMemAvailable: 50 kB\n"'
SHH_ALERTE_CERT_FIN="$(jour 3) 12:00:00 GMT"
SHH_ALERTE_RDAP="echo '{\"events\":[{\"eventDate\":\"$(jour 2)T00:00:00Z\",\"eventAction\":\"expiration\"}]}'"
SHH_ALERTE_CT="echo '[{\"not_before\":\"$(jour -1)T10:00:00\",\"serial_number\":\"0a1b\"},{\"serial_number\":\"c0ffee\",\"not_before\":\"$(jour -2)T08:00:00\"}]'"
export SHH_ALERTE_DNS='echo "203.0.113.99 STREAM exemple.test"' SHH_SERVEUR_ECHEANCE
SHH_SERVEUR_ECHEANCE=$(jour 5)
echo $((NOW - 30 * 3600)) >"$work/sauvegarde-ok"
lance urgent
attendu urgent "Bilan bilan,URGENT certificat,URGENT certificat-inconnu,URGENT conteneur,URGENT disque-données,URGENT disque-données-inodes,URGENT disque-système,URGENT disque-système-inodes,URGENT dns,URGENT domaine,URGENT hebergement,URGENT memoire,URGENT sauvegarde,URGENT serveur,URGENT smart,Rappel restauration"
grep -q "203.0.113.99\|192.0.2.10" "$work/urgent.out" && ko "urgent : une adresse IP dans l'alerte"
grep -q "Constats en cours" "$work/urgent.out" || ko "urgent : bilan sans les constats"
# Une heure plus tard : les urgences reviennent (période 1 h), pas le bilan ; la sauvegarde
# (6 h) non plus.
SHH_ALERTE_MAINTENANT=$((NOW + 3600)) relance urgent
s2=$(sujets "$work/urgent.out2" | paste -sd, -)
case $s2 in *"URGENT serveur"*) ;; *) ko "urgent : serveur pas répété après 1 h ($s2)" ;; esac
case $s2 in *bilan* | *sauvegarde*) ko "urgent : bilan ou sauvegarde répétés trop tôt ($s2)" ;; esac

# 3. À prévoir.
sain
export SHH_ALERTE_SANTE='echo "{\"ok\":true,\"reports_alert\":true}"'
export SHH_ALERTE_DF='printf "Use%% IUse%%\n 84%%  2%%\n"'
export SHH_ALERTE_LOADAVG='echo "9 9 9 1/100 42"'
SHH_ALERTE_CERT_FIN="$(jour 15) 12:00:00 GMT"
SHH_ALERTE_RDAP="echo '{\"events\":[{\"eventAction\":\"expiration\",\"eventDate\":\"$(jour 30)T00:00:00Z\"}]}'"
export SHH_SERVEUR_ECHEANCE
SHH_SERVEUR_ECHEANCE=$(jour 40)
export SHH_ALERTE_APT='printf "Inst openssl [3.0.15-1] (3.0.16-1~deb12u1 Debian-Security:12/stable-security [amd64])\nInst libssl3 [3.0.15-1] (3.0.16-1~deb12u1 Debian-Security:12/stable-security [amd64])\n"'
export SHH_ALERTE_REBOOT="$work/redemarrage"
: >"$work/redemarrage"
export SHH_ALERTE_RETARD='echo 3' SHH_ALERTE_NTP='echo no' SHH_ALERTE_UNITES='echo "shhdrop-sauvegarde.service failed"'
# Rythme : 70 % il y a deux jours, 84 % aujourd'hui → 7 points par jour, plein dans ~1 jour.
mkdir -p "$work/etat-prevoir"
echo "$((NOW - 2 * 86400)) 70" >"$work/etat-prevoir/echantillon-données"
lance prevoir
attendu prevoir "Bilan bilan,URGENT signalements,À prévoir certificat-bientot,À prévoir charge,À prévoir disque-données-bientot,À prévoir disque-données-rythme-bientot,À prévoir disque-système-bientot,À prévoir domaine-bientot,À prévoir hebergement-bientot,À prévoir horloge,À prévoir maj-securite,À prévoir maj-service,À prévoir redemarrage,Rappel restauration,À prévoir unites"
grep -q "2 mise(s) à jour de sécurité" "$work/prevoir.out" || ko "prevoir : nombre de mises à jour"
grep -q "plein dans environ 1 jour" "$work/prevoir.out" || ko "prevoir : rythme du disque"
[ "$(cut -d' ' -f2 "$work/etat-prevoir/echantillon-données")" = 84 ] || ko "prevoir : échantillon non mis à jour"

# 4. Domaine illisible (RDAP muet, pas de date notée) puis date notée en secours.
sain
export SHH_ALERTE_RDAP='false'
lance domaine
attendu domaine "Bilan bilan,Rappel restauration,À prévoir domaine-illisible"
printf 'SHH_DOMAINE_ECHEANCE=%s\n' "$(jour 20)" >>"$work/env"
lance domaine2
attendu domaine2 "Bilan bilan,Rappel restauration,À prévoir domaine-bientot"
sed -i '/^SHH_DOMAINE_ECHEANCE=/d' "$work/env"

# 5. Sans SHH_SAUVEGARDE_URL : ni sauvegarde ni rappel de restauration surveillés.
sain
sed -i '/^SHH_SAUVEGARDE_URL=/d' "$work/env"
rm -f "$work/sauvegarde-ok"
lance sans-sauvegarde
attendu sans-sauvegarde "Bilan bilan"

# 6. Destinataire sans SMTP : refus clair, code non nul.
sain
printf 'SHH_ALERTE_A=alerte@exemple.test\n' >>"$work/env"
export SHH_ALERTE_ETAT="$work/etat-smtp"
if "$here/alerte.sh" >/dev/null 2>"$work/smtp.err"; then ko "smtp : accepté sans SHH_SMTP_HOST"; fi
grep -q "SHH_SMTP_HOST" "$work/smtp.err" || ko "smtp : message $(cat "$work/smtp.err")"

[ "$echec" = 0 ] && printf 'test-alerte : ok\n'
exit "$echec"

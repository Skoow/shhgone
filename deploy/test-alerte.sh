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

NOW=1794827200 # heure fixe des essais : lundi 16 novembre 2026, 11:06 UTC (bilan du lundi)
jour() { date -u -d "@$((NOW + $1 * 86400))" +%Y-%m-%d; }

cat >"$work/env" <<EOF
SHH_DOMAIN=exemple.test
SHH_DATA_ROOT=$work/donnees
SHH_SAUVEGARDE_URL=file:///nulle-part/
EOF
mkdir -p "$work/donnees"

# API de GitHub (bilan du lundi) : réponses d'essai selon $work/gh-mode (vert, rouge, panne).
cat >"$work/gh.sh" <<EOF
#!/usr/bin/env bash
mode=\$(cat "$work/gh-mode" 2>/dev/null || echo vert)
[ "\$mode" = panne ] && exit 22
case \$1 in
/actions/workflows/securite.yml/runs*) echo '{"workflow_runs":[{"id":4242,"conclusion":"success","created_at":"$(jour -0)T04:20:00Z"}]}' ;;
/actions/workflows/verifier-site.yml/runs*) echo '{"workflow_runs":[{"id":77,"conclusion":"success","created_at":"$(jour -0)T10:41:00Z"}]}' ;;
/actions/runs/4242/jobs*)
	if [ "\$mode" = rouge ]; then c=failure s=skipped; else c=success s=success; fi
	echo '{"jobs":[{"name":"go","conclusion":"success"},{"name":"gosec","conclusion":"'\$c'"},{"name":"outils","conclusion":"'\$c'"},{"name":"site","conclusion":"'\$s'"}]}' ;;
/pulls*)
	if [ "\$mode" = rouge ]; then
		echo '[{"title":"build(deps): bump caddy from 2.11.9 to 2.11.10 in /deploy","user":{"login":"dependabot[bot]"}},{"title":"autre","user":{"login":"Skoow"}}]'
	else
		echo '[{"title":"autre","user":{"login":"Skoow"}}]'
	fi ;;
*) exit 22 ;;
esac
EOF
chmod +x "$work/gh.sh"
# DNS (dig +short) : tout présent.
cat >"$work/dig.sh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
"DS exemple.test") echo "2371 13 2 ABCDEF" ;;
"CAA exemple.test") echo '0 issue "letsencrypt.org; accounturi=https://acme/1"' ;;
"TXT exemple.test") echo '"v=spf1 include:_spf.exemple.test -all"' ;;
"TXT _dmarc.exemple.test") echo '"v=DMARC1; p=reject"' ;;
"TXT default._domainkey.exemple.test") [ -e "${0%/*}/sans-dkim" ] || echo '"v=DKIM1; k=rsa; p=MIIB"' ;;
esac
EOF
chmod +x "$work/dig.sh"
# Registre des connexions SSH (ssh-connexion.sh) : une cette semaine, une vieille.
printf '%s debian SHA256:YyVEEg6JAlVene7LI/FZlR/WRtBxP+UbvCD83BdgZWQ\n%s debian SHA256:vieillevieillevieillevieillevieillevieille00\n' \
	$((NOW - 2 * 86400)) $((NOW - 20 * 86400)) >"$work/ssh"

# Tout va bien : chaque remplacement donne un état sain.
sain() {
	export SHH_ALERTE_GITHUB="$work/gh.sh \"\$1\"" SHH_ALERTE_DIG="$work/dig.sh \"\$@\"" SHH_ALERTE_SSH="$work/ssh"
	export SHH_ALERTE_TEMPS='echo "200 0.123"' SHH_ALERTE_CERT_EMETTEUR="Let's Encrypt"
	echo vert >"$work/gh-mode"
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
	SHH_ALERTE_RDAP="echo '{\"status\":[\"client transfer prohibited\"],\"events\":[{\"eventAction\":\"registration\",\"eventDate\":\"2026-01-01T00:00:00Z\"},{\"eventAction\":\"expiration\",\"eventDate\":\"$(jour 300)T00:00:00Z\"}]}'"
	# Certificate Transparency (format de crt.sh) : le certificat servi (série 0a:1b, émis hier) et
	# un ancien de 40 jours (renouvelé depuis) : rien de suspect.
	export SHH_ALERTE_CERT_SERIE='0A1B' SHH_ALERTE_CT
	SHH_ALERTE_CT="echo '[{\"id\":1,\"entry_timestamp\":\"x\",\"not_before\":\"$(jour -1)T10:00:00\",\"serial_number\":\"0a1b\"},{\"id\":2,\"not_before\":\"$(jour -40)T10:00:00\",\"serial_number\":\"ffee\"}]'"
	# www.<nom> (redirection 308) : son certificat (série 0c:1d, émis hier) est servi aussi.
	export SHH_ALERTE_CERT_WWW='echo serial=0C1D' SHH_ALERTE_CT_WWW
	SHH_ALERTE_CT_WWW="echo '[{\"id\":3,\"not_before\":\"$(jour -1)T11:00:00\",\"serial_number\":\"0c1d\"}]'"
	export SHH_ALERTE_DNS='echo "192.0.2.10 STREAM exemple.test"' SHH_ALERTE_IPS='echo "1: lo inet 127.0.0.1/8"; echo "2: eth0 inet 192.0.2.10/24"'
	export SHH_ALERTE_SAUVEGARDE_OK="$work/sauvegarde-ok"
	echo $((NOW - 3600)) >"$work/sauvegarde-ok"
	export SHH_ALERTE_APT='echo "Inst libc6 [2.36-9] (2.36-9+deb12u9 Debian:12.9/stable [amd64])"'
	export SHH_ALERTE_REBOOT="$work/pas-de-redemarrage"
	export SHH_ALERTE_RETARD='echo 0' SHH_ALERTE_NTP='echo yes' SHH_ALERTE_UNITES='true'
	export SHH_ALERTE_INTEGRITE="$work/integrite-etat"
	printf "resultat=ok\ndate=%s\nbase=3f2a-91c0-77de-0b12\nimage=ok\nvolume=vérifié\npaquets=0\necarts=0\n" $((NOW - 8 * 3600)) >"$work/integrite-etat"
	export SHH_ALERTE_BOOT_ID='echo boot-1' SHH_ALERTE_DEMARRAGE='echo "2026-11-22 03:12:00"' SHH_ALERTE_MONTE='echo oui'
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
grep -q "^✅ Nom de domaine : échéance le $(jour 300) (299 jours)" "$work/sain.out" || ko "sain : échéance RDAP non lue"
grep -q "^✅ Certificat HTTPS (Let's Encrypt) : fin le $(jour 60) 12:00 UTC, renouvellement automatique OK" "$work/sain.out" || ko "sain : certificat"
grep -q "^⚠️ Hébergement : échéance non renseignée" "$work/sain.out" || ko "sain : location non renseignée"
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

# 3 bis. Certificat de 6 jours : sain à 4 jours de la fin, URGENT à 20 h.
sain
export SHH_ALERTE_CERT_DEBUT
SHH_ALERTE_CERT_DEBUT="$(jour -2) 12:00:00 GMT"
SHH_ALERTE_CERT_FIN="$(jour 4) 12:00:00 GMT"
lance court-sain
attendu court-sain "Bilan bilan,Rappel restauration"
SHH_ALERTE_CERT_DEBUT="$(date -u -d "@$((NOW - 5 * 86400))" '+%Y-%m-%d %H:%M:%S GMT')"
SHH_ALERTE_CERT_FIN="$(date -u -d "@$((NOW + 20 * 3600))" '+%Y-%m-%d %H:%M:%S GMT')"
lance court-fin
attendu court-fin "Bilan bilan,Rappel restauration,URGENT certificat"
grep -q "à 20 h de sa fin" "$work/court-fin.out" || ko "court-fin : heures restantes"
unset SHH_ALERTE_CERT_DEBUT

# 3 ter. Deux certificats légitimes dans la fenêtre : l'ancien (série 0a1a) a été servi au
# passage précédent, le nouveau (0a1b) maintenant ; rien de suspect. Un troisième jamais servi : alerte.
sain
export SHH_ALERTE_CERT_SERIE='0a1a'
SHH_ALERTE_CT="echo '[{\"not_before\":\"$(jour -2)T10:00:00\",\"serial_number\":\"0a1a\"}]'"
lance renouv
case $(sujets "$work/renouv.out" | paste -sd, -) in *certificat-inconnu*) ko "renouv : certificat servi pris pour suspect" ;; esac
export SHH_ALERTE_CERT_SERIE='0a1b'
SHH_ALERTE_CT="echo '[{\"not_before\":\"$(jour -2)T10:00:00\",\"serial_number\":\"0a1a\"},{\"not_before\":\"$(jour -1)T10:00:00\",\"serial_number\":\"0A:1B\"}]'"
SHH_ALERTE_MAINTENANT=$((NOW + 900)) relance renouv
case $(sujets "$work/renouv.out2" | paste -sd, -) in *certificat-inconnu*) ko "renouv : renouvellement pris pour suspect" ;; esac
SHH_ALERTE_CT="echo '[{\"not_before\":\"$(jour -1)T10:00:00\",\"serial_number\":\"dead\"}]'"
SHH_ALERTE_MAINTENANT=$((NOW + 1800)) relance renouv
case $(sujets "$work/renouv.out2" | paste -sd, -) in *"URGENT certificat-inconnu"*) ;; *) ko "renouv : certificat jamais servi non signalé" ;; esac

# 3 ter bis. www.<nom> : son certificat servi est connu ; un certificat www jamais servi : alerte ;
# www sans certificat (enregistrement pas encore posé) : le site seul compte.
sain
lance www
case $(sujets "$work/www.out" | paste -sd, -) in *certificat-inconnu*) ko "www : certificat servi de www pris pour suspect" ;; esac
SHH_ALERTE_CT_WWW="echo '[{\"not_before\":\"$(jour -1)T10:00:00\",\"serial_number\":\"beef\"}]'"
lance www-inconnu
case $(sujets "$work/www-inconnu.out" | paste -sd, -) in *"URGENT certificat-inconnu"*) ;; *) ko "www : certificat www jamais servi non signalé" ;; esac
grep -q "pour exemple.test ou www.exemple.test" "$work/www-inconnu.out" || ko "www : message sans www"
export SHH_ALERTE_CERT_WWW='true' SHH_ALERTE_CT_WWW="echo '[]'"
lance www-absent
attendu www-absent "Bilan bilan,Rappel restauration"

# 3 quater. Redémarrage : premier passage, l'identifiant est retenu sans alerte ; nouveau
# démarrage → URGENT redemarre et volume verrouillé ; ensuite, plus d'alerte de redémarrage.
sain
lance boot
attendu boot "Bilan bilan,Rappel restauration"
export SHH_ALERTE_BOOT_ID='echo boot-2' SHH_ALERTE_MONTE='echo non'
SHH_ALERTE_MAINTENANT=$((NOW + 900)) relance boot
s2=$(sujets "$work/boot.out2" | paste -sd, -)
[ "$s2" = "URGENT redemarre,URGENT volume" ] || ko "boot : attendu redemarre et volume, obtenu [$s2]"
grep -q "démarrage : 2026-11-22 03:12:00" "$work/boot.out2" || ko "boot : heure de démarrage"
export SHH_ALERTE_MONTE='echo oui'
SHH_ALERTE_MAINTENANT=$((NOW + 2 * 3600)) relance boot
[ ! -s "$work/boot.out2" ] || ko "boot : alerte répétée après le même démarrage : $(cat "$work/boot.out2")"
# Volume verrouillé, aucun mot de passe lisible avec un destinataire : pas d'arrêt du script.
printf 'SHH_ALERTE_A=alerte@exemple.test\nSHH_ALERTE_SMTP_HOST=smtp.exemple.test\nSHH_ALERTE_SMTP_USER=u\nSHH_ALERTE_FROM=a@exemple.test\n' >>"$work/env"
export SHH_ALERTE_MDP_FICHIER="$work/absent" SHH_ALERTE_BOOT_ID='echo boot-3' SHH_ALERTE_MONTE='echo non'
export SHH_ALERTE_ETAT="$work/etat-boot"
SHH_ALERTE_MAINTENANT=$((NOW + 3 * 3600)) "$here/alerte.sh" >"$work/boot3.out" 2>"$work/boot3.err" || ko "boot3 : arrêt sans mot de passe lisible ($(cat "$work/boot3.err"))"
grep -q "aucun mot de passe SMTP lisible" "$work/boot3.err" || ko "boot3 : constat absent"
grep -q "^ALERTE URGENT redemarre" "$work/boot3.out" || ko "boot3 : redémarrage non constaté"
[ "$(cat "$work/etat-boot/boot-id")" = boot-1 ] || [ "$(cat "$work/etat-boot/boot-id")" = boot-2 ] || ko "boot3 : identifiant retenu sans envoi"
sed -i '/^SHH_ALERTE_A=/d;/^SHH_ALERTE_SMTP_HOST=/d;/^SHH_ALERTE_SMTP_USER=/d;/^SHH_ALERTE_FROM=/d' "$work/env"
unset SHH_ALERTE_MDP_FICHIER

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
if "$here/alerte.sh" >/dev/null 2>"$work/smtp.err"; then ko "smtp : accepté sans SHH_ALERTE_SMTP_HOST"; fi
grep -q "SHH_ALERTE_SMTP_HOST" "$work/smtp.err" || ko "smtp : message $(cat "$work/smtp.err")"

sed -i '/^SHH_ALERTE_A=/d' "$work/env"

# 7. Bilan du lundi, tout vert : un seul e-mail, quatre sections, « tout va bien ».
{
	printf "SHH_SAUVEGARDE_URL=file:///nulle-part/\nSHH_SERVEUR_ECHEANCE=%s\n" "$(jour 200)"
	printf 'SHH_ALERTE_A=alerte@exemple.test\nSHH_ALERTE_SMTP_HOST=smtp.exemple.test\nSHH_ALERTE_SMTP_USER=u\n'
	printf "SHH_ALERTE_FROM='Shhgone <a@exemple.test>'\n"
} >>"$work/env"
export SHH_COURRIEL_ENVOI="cat >>'$work/courriels'"
courriel() { # <essai> : lance, puis garde le bilan envoyé dans $work/<essai>.mail
	: >"$work/courriels"
	lance "$1"
	sed -n '/^Subject: Shhgone Bilan du lundi/,$p' "$work/courriels" >"$work/$1.mail"
}
propre() { # aucun secret, aucune adresse IP dans le bilan
	grep -qE '192\.0\.2\.10|203\.0\.113' "$work/$1.mail" && ko "$1 : adresse IP dans le bilan"
	grep -qF 'jeton-secret-de-test' "$work/$1.mail" && ko "$1 : jeton dans le bilan"
	return 0
}
sain
export SHH_ALERTE_APT='true'
courriel vert
m=$work/vert.mail
grep -q "^Subject: Shhgone Bilan du lundi : tout va bien" "$m" || ko "vert : objet ($(grep '^Subject' "$work/courriels" | head -3))"
for s in "1. Intégrité du serveur" "2. Mises à jour à faire" "3. Santé" "4. Connexions SSH de la semaine"; do
	grep -q "^$s" "$m" || ko "vert : section « $s » absente"
done
grep -q '^⚠️\|^❌' "$m" && ko "vert : avertissement dans un bilan tout vert : $(grep '^⚠️\|^❌' "$m" | head -3)"
for l in "✅ Empreinte du serveur : rien de changé" "✅ Fichiers des paquets Debian conformes" "✅ Image en cours = image signée" \
	"   Base d'intégrité : 3f2a-91c0-77de-0b12" "✅ Système à jour" "✅ Aucun redémarrage nécessaire" \
	"✅ analyse de notre code Go (gosec) : rien trouvé" "✅ Dependabot : aucune proposition ouverte" \
	"✅ DNSSEC : actif" "✅ CAA : présent, lié au compte ACME" "✅ SPF : présent" "✅ DKIM : présent (sélecteur default)" \
	"✅ DMARC : présent" "✅ Site joignable : https://exemple.test/ répond 200 en 123 ms" "✅ Version servie = Release signée" \
	"✅ Nom de domaine : verrou de transfert actif" "✅ Hébergement : fin de la location le $(jour 200)" \
	"✅ Mémoire : 60 % disponible" "✅ Sauvegarde : dernière réussie le" "   Dernier redémarrage de la machine : 2026-11-22 03:12:00" \
	"   1 connexion(s) ces 7 derniers jours" "     - $(date -u -d "@$((NOW - 2 * 86400))" '+%Y-%m-%d %H:%M UTC'), compte debian, clé SHA256:YyVEEg6J" \
	"Rien à signaler : tout va bien."; do
	grep -qF -- "$l" "$m" || ko "vert : « $l » absent"
done
grep -qF "vieille" "$m" && ko "vert : connexion de plus de 7 jours listée"
grep -q "^To: alerte@exemple.test" "$work/courriels" || ko "vert : destinataire"
propre vert
# Un autre jour que le lundi : pas de bilan.
sain
export SHH_ALERTE_MAINTENANT=$((NOW + 86400))
lance mardi
attendu mardi "Rappel restauration"

# 8. Avertissements : mises à jour, Dependabot (dont Caddy), DKIM absent, jeton GitHub absent.
sain
export SHH_ALERTE_APT='printf "Inst openssl [3.0.15-1] (3.0.16-1~deb12u1 Debian-Security:12/stable-security [amd64])\nInst vim [9] (9.1 Debian:12/stable [amd64])\n"'
export SHH_ALERTE_REBOOT="$work/redemarrage"
: >"$work/redemarrage"
echo rouge >"$work/gh-mode"
: >"$work/sans-dkim"
courriel avert
m=$work/avert.mail
grep -q "^Subject: Shhgone Bilan du lundi : [1-9][0-9]* à traiter, [1-9][0-9]* à voir" "$m" || ko "avert : objet $(head -1 "$m")"
for l in "⚠️ Système : 1 mise(s) à jour de sécurité en attente (sur 2)" "⚠️ Redémarrage nécessaire" \
	"❌ analyse de notre code Go (gosec) : failure" "❌ outils épinglés à jour (deploy/outils-a-jour.sh) : failure" \
	"⚠️ contrôle externe du site (ports, TLS, en-têtes) : sauté" "⚠️ Dependabot : 1 proposition(s) ouverte(s)" \
	"     - build(deps): bump caddy from 2.11.9 to 2.11.10 in /deploy" "⚠️ Image de Caddy : nouvelle version proposée" \
	"⚠️ DKIM : introuvable"; do
	grep -qF -- "$l" "$m" || ko "avert : « $l » absent"
done
grep -qF "autre" "$m" && ko "avert : proposition qui n'est pas de Dependabot listée"
propre avert
rm -f "$work/sans-dkim" "$work/redemarrage"
# Jeton absent (aucun remplacement, fichier introuvable) : « non configuré », sans échouer.
sain
unset SHH_ALERTE_GITHUB
export SHH_ALERTE_GITHUB_JETON="$work/pas-de-jeton"
courriel sans-jeton
grep -qF "⚠️ GitHub : non configuré (jeton en lecture seule absent" "$work/sans-jeton.mail" || ko "sans-jeton : section GitHub"
grep -qF "Version servie = Release signée" "$work/sans-jeton.mail" && ko "sans-jeton : contrôle GitHub inventé"
# API en panne : dit, sans échouer.
sain
echo panne >"$work/gh-mode"
courriel panne
grep -qF "⚠️ GitHub : vérification de sécurité illisible" "$work/panne.mail" || ko "panne : non dit"
unset SHH_ALERTE_GITHUB_JETON

# 9. Échecs : intégrité en différence, sauvegarde ancienne, certificat non renouvelé, site muet ;
#    rappel URGENT des différences ; contrôle muet depuis 36 h.
sain
printf "resultat=alerte\ndate=%s\nbase=3f2a-91c0-77de-0b12\nimage=conteneur inattendu\npaquets=2\necarts=5\n" $((NOW - 3600)) >"$work/integrite-etat"
echo $((NOW - 30 * 3600)) >"$work/sauvegarde-ok"
SHH_ALERTE_CERT_FIN="$(jour 3) 12:00:00 GMT"
export SHH_ALERTE_TEMPS='false' SHH_ALERTE_DNS='echo "203.0.113.99 STREAM exemple.test"'
courriel echecs
m=$work/echecs.mail
for l in "❌ Empreinte du serveur : 5 différence(s)" "❌ Fichiers des paquets Debian : 2 fichier(s)" "❌ Image : conteneur inattendu" \
	"❌ Sauvegarde : dernière réussie le" "❌ Certificat HTTPS (Let's Encrypt) : fin le $(jour 3) 12:00 UTC, renouvellement automatique EN ÉCHEC" \
	"❌ Site : https://exemple.test/ ne répond pas" "Constats en cours"; do
	grep -qF -- "$l" "$m" || ko "echecs : « $l » absent"
done
grep -q "^ALERTE URGENT integrite-differences" "$work/echecs.out" || ko "echecs : pas de rappel URGENT des différences"
propre echecs
sain
printf "resultat=ok\ndate=%s\nbase=3f2a-91c0-77de-0b12\nimage=ok\npaquets=0\necarts=0\n" $((NOW - 40 * 3600)) >"$work/integrite-etat"
courriel muette
grep -q "^ALERTE URGENT integrite-muette" "$work/muette.out" || ko "muette : pas d'URGENT"
grep -qF "❌ Empreinte du serveur : contrôle muet depuis plus de 36 h" "$work/muette.mail" || ko "muette : bilan"
# Non installée (aucun état) : rien d'urgent, dit dans le bilan.
sain
rm -f "$work/integrite-etat"
courriel sans-integrite
grep -q "^ALERTE URGENT integrite" "$work/sans-integrite.out" && ko "sans-integrite : URGENT"
grep -qF "⚠️ Empreinte du serveur : contrôle non installé" "$work/sans-integrite.mail" || ko "sans-integrite : bilan"

# 10. Envoi raté : la date n'est pas retenue, le prochain passage réessaie.
sain
export SHH_COURRIEL_ENVOI='cat >/dev/null; false'
lance courriel-rate
[ ! -f "$work/etat-courriel-rate/bilan" ] || ko "courriel-rate : date retenue malgré l'échec"
grep -q "impossible (SMTP)" "$work/courriel-rate.err" || ko "courriel-rate : constat absent"
unset SHH_COURRIEL_ENVOI

[ "$echec" = 0 ] && printf 'test-alerte : ok\n'
exit "$echec"

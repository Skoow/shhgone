#!/usr/bin/env bash
# Alerte de l'exploitant (spec §15.2 ; README §4, « Surveillance »), lancée toutes les 15 min par
# systemd/shhdrop-alerte.timer. Prévient par e-mail AVANT que le problème n'arrive, chaque sujet
# au plus une fois par période (1 h pour l'urgent, 1 jour ou 7 jours pour ce qui se prévoit) :
#
#   urgent (« URGENT ») :
#     redemarre      la machine a redémarré (accès possible : vérifier avant de déverrouiller)
#     volume         le volume chiffré n'est pas déverrouillé (site arrêté)
#     serveur        le contrôle de santé ne répond pas
#     signalements   au moins 5 signalements dans l'heure (reports_alert de /healthz)
#     disque         données ou système à 90 % ou plus ; inodes à 90 % ou plus
#     memoire        moins de 10 % de mémoire disponible
#     conteneur      un conteneur « unhealthy » ou qui redémarre en boucle
#     certificat     certificat TLS du site à moins de 7 jours de sa fin (36 h pour un
#                    certificat de 6 jours, profil « shortlived »)
#     domaine        nom de domaine à moins de 7 jours de son échéance
#     hebergement    serveur loué à moins de 7 jours de son échéance (SHH_SERVEUR_ECHEANCE)
#     dns            le nom de domaine ne pointe plus vers cette machine
#     sauvegarde     aucune sauvegarde réussie depuis 26 h
#     smart          un disque annonce une panne (smartctl)
#   et, une fois par jour :
#     certificat-inconnu  un certificat émis pour le nom ou pour www.<nom> ces 3 derniers jours
#                    n'est pas l'un de ceux que sert le site (journaux publics Certificate
#                    Transparency, via crt.sh)
#   à prévoir (« À prévoir ») :
#     disque-bientot  75 % ou plus, ou plein (95 %) dans moins de 14 jours au rythme du jour
#     certificat-bientot  moins de 21 jours (Caddy renouvelle à 30 : le renouvellement échoue)
#     domaine-bientot / hebergement-bientot  moins de 45 jours avant l'échéance
#     domaine-illisible  l'échéance du domaine ne se lit plus (RDAP), ni SHH_DOMAINE_ECHEANCE
#     maj-securite   mises à jour de sécurité du système en attente
#     redemarrage    redémarrage demandé par une mise à jour (noyau, bibliothèques)
#     maj-service    la copie du dépôt a des commits de retard sur GitHub (à déployer)
#     horloge        horloge non synchronisée (NTP) : échéances et codes à usage unique faussés
#     unites         une unité systemd en échec (sauvegarde, minuteur…)
#     charge         charge moyenne sur 15 min au-dessus de deux fois le nombre de cœurs
#   rappel (« Rappel ») :
#     restauration   tous les 30 jours : essayer une restauration (README §12)
#   bilan            chaque semaine, même sans problème : chiffres du jour et constats en cours.
#                    S'il n'arrive pas le lundi, c'est l'alerte elle-même qui ne marche plus.
#
# Aucune donnée d'utilisateur, aucune adresse IP : les e-mails ne contiennent que des sujets,
# des pourcentages, des nombres et des dates. L'état (dates d'envoi, un échantillon d'occupation
# du disque par jour) est dans SHH_ALERTE_ETAT (défaut /var/lib/shhdrop-alerte, StateDirectory).
#
# Réglages, dans deploy/.env :
#   SHH_ALERTE_A          adresse qui reçoit les alertes (par exemple contact@shhgone.com)
#   SHH_ALERTE_SMTP_HOST  fournisseur d'envoi des alertes (SMTP authentifié, TLS implicite sur 465)
#   SHH_ALERTE_SMTP_USER  identifiant SMTP réservé aux alertes ; son mot de passe dans
#                         /etc/shhdrop/alerte_smtp_mdp (root 0600, disque système : lisible après un
#                         redémarrage ; jamais une variable)
#   SHH_ALERTE_FROM       expéditeur (« Shhgone <alertes@shhgone.com> » ou une adresse)
#   Ces réglages ne servent qu'aux alertes de l'exploitant, envoyées depuis la machine : le
#   serveur Go et le compte (par passkey depuis le 22 novembre) n'envoient aucun e-mail, et
#   SHH_SMTP_* / SHH_MAIL_FROM (anciens réglages du compte) font refuser deploy.sh.
#   SHH_DOMAIN            nom du site (certificat, DNS, échéance du domaine)
#   SHH_DATA_ROOT         racine du volume chiffré (défaut /srv/shhdrop)
#   SHH_SERVEUR_ECHEANCE  (facultatif) date AAAA-MM-JJ de fin de la location du serveur
#   SHH_DOMAINE_ECHEANCE  (facultatif) date AAAA-MM-JJ de fin du domaine, si RDAP ne répond pas
#   SHH_SAUVEGARDE_URL    (de sauvegarder.sh) : sans elle, la sauvegarde n'est pas surveillée
# Sans SHH_ALERTE_A : rien n'est envoyé, le constat est écrit sur la sortie (journald en mémoire).
#
# Essais (deploy/test-alerte.sh) : SHH_ENV_FILE, SHH_ALERTE_ETAT, SHH_ALERTE_MAINTENANT (heure
# Unix), et une commande ou un fichier de remplacement par contrôle : SHH_ALERTE_SANTE,
# SHH_ALERTE_DF (sortie « pcent ipcent » d'un dossier), SHH_ALERTE_MEMINFO, SHH_ALERTE_LOADAVG,
# SHH_ALERTE_NPROC, SHH_ALERTE_DOCKER, SHH_ALERTE_CERT_FIN, SHH_ALERTE_CERT_DEBUT, SHH_ALERTE_CERT_SERIE, SHH_ALERTE_CERT_WWW (sortie « serial=… » du certificat de www), SHH_ALERTE_CT, SHH_ALERTE_CT_WWW, SHH_ALERTE_RDAP, SHH_ALERTE_DNS,
# SHH_ALERTE_IPS, SHH_ALERTE_SAUVEGARDE_OK, SHH_ALERTE_SMART, SHH_ALERTE_APT,
# SHH_ALERTE_REBOOT, SHH_ALERTE_RETARD, SHH_ALERTE_NTP, SHH_ALERTE_UNITES, SHH_ALERTE_BOOT_ID,
# SHH_ALERTE_DEMARRAGE, SHH_ALERTE_MONTE (« oui » ou « non »), SHH_ALERTE_MDP_FICHIER.
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
die() { printf 'alerte : %s\n' "$*" >&2; exit 1; }
env_file=${SHH_ENV_FILE:-$here/.env}
[ -f "$env_file" ] || die "$env_file absent"
# shellcheck disable=SC1090
. "$env_file"
root=${SHH_DATA_ROOT:-/srv/shhdrop}
etat=${SHH_ALERTE_ETAT:-/var/lib/shhdrop-alerte}
mkdir -p "$etat" && chmod 0700 "$etat"
now=${SHH_ALERTE_MAINTENANT:-$(date +%s)}
HEURE=3600
JOUR=86400
SEMAINE=604800
constats=()

# Commande de remplacement (essais) ou commande réelle ; sortie vide si elle échoue.
lire() { # $1 : nom de la variable de remplacement, puis la commande réelle
	local var=$1
	shift
	if [ -n "${!var:-}" ]; then
		bash -c "${!var}" 2>/dev/null || true
	else
		"$@" 2>/dev/null || true
	fi
}

# Jours entiers jusqu'à une date (AAAA-MM-JJ ou toute date que « date -d » lit) ; vide sinon.
jours_jusqua() {
	local fin
	fin=$(date -u -d "$1" +%s 2>/dev/null) || return 0
	printf '%s' $(((fin - now) / JOUR))
}

envoyer() { # $1 : sujet (nom du fichier d'état), $2 : période en secondes, $3 : texte
	local cle=$1 periode=$2 texte=$3 last=0 niveau="À prévoir"
	case $cle in
	*-bientot | maj-* | redemarrage | horloge | unites | charge | domaine-illisible) ;;
	bilan) niveau="Bilan" ;;
	restauration) niveau="Rappel" ;;
	*) niveau="URGENT" ;;
	esac
	case $niveau in Bilan | Rappel) ;; *) constats+=("$niveau · $cle : $texte") ;; esac
	[ -f "$etat/$cle" ] && last=$(cat "$etat/$cle")
	[[ $last =~ ^[0-9]+$ ]] || last=0
	if [ $((now - last)) -lt "$periode" ]; then return 0; fi
	printf 'ALERTE %s %s : %s\n' "$niveau" "$cle" "$texte"
	if [ -z "${SHH_ALERTE_A:-}" ]; then
		printf '%s\n' "$now" >"$etat/$cle"
		return 0
	fi
	if [ -z "${SHH_ALERTE_SMTP_HOST:-}" ] || [ -z "${SHH_ALERTE_SMTP_USER:-}" ] || [ -z "${SHH_ALERTE_FROM:-}" ]; then
		die "SHH_ALERTE_A sans SHH_ALERTE_SMTP_HOST, SHH_ALERTE_SMTP_USER et SHH_ALERTE_FROM"
	fi
	# Mot de passe d'envoi des alertes : celui de /etc/shhdrop (disque système, lisible juste
	# après un redémarrage, quand le volume chiffré est encore verrouillé). Illisible : constat
	# sur la sortie, nouvel essai plus tard.
	local utilisateur=$SHH_ALERTE_SMTP_USER de
	local mdp=${SHH_ALERTE_MDP_FICHIER:-/etc/shhdrop/alerte_smtp_mdp}
	if [ ! -r "$mdp" ]; then
		printf 'alerte : aucun mot de passe SMTP lisible (/etc/shhdrop/alerte_smtp_mdp absent) : « %s » non envoyée\n' "$cle" >&2
		return 0
	fi
	de=$(printf '%s' "$SHH_ALERTE_FROM" | sed -n 's/.*<\(.*\)>.*/\1/p')
	[ -n "$de" ] || de=$SHH_ALERTE_FROM
	# Mot de passe lu par curl depuis un fichier de configuration (jamais sur la ligne de commande).
	# Envoi raté : la date n'est pas écrite, l'essai reprend au passage suivant.
	if {
		printf 'From: %s\r\nTo: %s\r\nSubject: Shhgone %s : %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
			"$SHH_ALERTE_FROM" "$SHH_ALERTE_A" "$niveau" "$cle" "$texte"
	} | curl -sS --fail --max-time 60 --ssl-reqd --url "smtps://$SHH_ALERTE_SMTP_HOST:465" \
		--mail-from "$de" --mail-rcpt "$SHH_ALERTE_A" --upload-file - \
		-K <(printf 'user = "%s:%s"\n' "$utilisateur" "$(cat "$mdp")") >/dev/null; then
		printf '%s\n' "$now" >"$etat/$cle"
	else
		printf 'alerte : envoi de « %s » impossible (SMTP), nouvel essai au prochain passage\n' "$cle" >&2
	fi
}

# --- Redémarrage, volume ------------------------------------------------------------------------
# Un redémarrage que personne n'a demandé peut cacher un accès à la machine (lecture du disque
# ou de la mémoire à froid, démarrage sur un autre système) : prévenir aussitôt. L'identifiant
# de démarrage du noyau change à chaque démarrage ; il n'est retenu qu'une fois l'alerte partie.
boot=$(lire SHH_ALERTE_BOOT_ID cat /proc/sys/kernel/random/boot_id)
if [ -n "$boot" ]; then
	if [ -f "$etat/boot-id" ] && [ "$(cat "$etat/boot-id")" != "$boot" ]; then
		depuis=$(lire SHH_ALERTE_DEMARRAGE uptime -s)
		envoyer redemarre $HEURE "la machine a redémarré (démarrage : ${depuis:-?}). Si ce n'est ni toi ni une maintenance annoncée par l'hébergeur : quelqu'un a pu accéder à la machine. Ne pas déverrouiller le volume avant d'avoir vérifié (README, « Hébergeur et certificat »)"
		if [ "$(cat "$etat/redemarre" 2>/dev/null)" = "$now" ]; then printf '%s\n' "$boot" >"$etat/boot-id"; fi
	else
		printf '%s\n' "$boot" >"$etat/boot-id"
	fi
fi
if [ -n "${SHH_ALERTE_MONTE:-}" ]; then
	monte=$(bash -c "$SHH_ALERTE_MONTE" 2>/dev/null || true)
elif mountpoint -q "$root" 2>/dev/null; then
	monte=oui
else
	monte=non
fi
if [ "$monte" != oui ]; then
	envoyer volume $HEURE "le volume chiffré ($root) n'est pas déverrouillé : le site est arrêté. Le déverrouiller par SSH (README §5), après avoir vérifié la raison du redémarrage"
fi

# --- Service ------------------------------------------------------------------------------------
sante=$(lire SHH_ALERTE_SANTE "$here/deploy.sh" health)
if [ -z "$sante" ] || ! printf '%s' "$sante" | grep -q '"ok":true'; then
	envoyer serveur $HEURE "le serveur ne répond pas à son contrôle de santé (deploy/deploy.sh status ; diagnose)"
elif printf '%s' "$sante" | grep -q '"reports_alert":true'; then
	envoyer signalements $HEURE "au moins 5 signalements dans l'heure : tableau de bord ou contact@ à regarder"
fi
docker_ko=$(lire SHH_ALERTE_DOCKER docker ps -a --filter health=unhealthy --filter status=restarting -q | grep -c . || true)
if [ "${docker_ko:-0}" -gt 0 ]; then
	envoyer conteneur $HEURE "$docker_ko conteneur(s) en mauvaise santé ou qui redémarrent (docker ps -a ; deploy.sh diagnose)"
fi

# --- Disques ------------------------------------------------------------------------------------
pct_donnees=""
for d in "$root" /; do
	[ -n "${SHH_ALERTE_DF:-}" ] || [ -d "$d" ] || continue
	nom=$([ "$d" = / ] && echo système || echo données)
	read -r pct ipct < <(lire SHH_ALERTE_DF df --output=pcent,ipcent "$d" | tail -1 | tr -d '%') || true
	[[ ${pct:-} =~ ^[0-9]+$ ]] || continue
	[ "$nom" = données ] && pct_donnees=$pct
	if [ "$pct" -ge 90 ]; then
		envoyer "disque-$nom" $HEURE "disque $nom plein à $pct % : libérer de la place maintenant"
	elif [ "$pct" -ge 75 ]; then
		envoyer "disque-$nom-bientot" $JOUR "disque $nom à $pct % : prévoir de la place (ou SHH_STORAGE_MAX)"
	fi
	if [[ ${ipct:-} =~ ^[0-9]+$ ]] && [ "$ipct" -ge 90 ]; then
		envoyer "disque-$nom-inodes" $HEURE "inodes du disque $nom à $ipct %"
	fi
	# Rythme : un échantillon par jour ; plein (95 %) dans moins de 14 jours → à prévoir.
	ech="$etat/echantillon-$nom"
	if [ -f "$ech" ]; then
		read -r t0 p0 <"$ech" || true
		if [[ ${t0:-} =~ ^[0-9]+$ ]] && [[ ${p0:-} =~ ^[0-9]+$ ]] && [ $((now - t0)) -ge $JOUR ]; then
			jours=$(((now - t0) / JOUR))
			hausse=$(((pct - p0 + jours - 1) / jours)) # points par jour, arrondi au-dessus
			if [ "$hausse" -gt 0 ] && [ "$pct" -lt 95 ] && [ $(((95 - pct) / hausse)) -lt 14 ]; then
				envoyer "disque-$nom-rythme-bientot" $JOUR "disque $nom à $pct %, +$hausse point(s) par jour : plein dans environ $(((95 - pct) / hausse)) jour(s)"
			fi
			printf '%s %s\n' "$now" "$pct" >"$ech"
		fi
	else
		printf '%s %s\n' "$now" "$pct" >"$ech"
	fi
done
for disque in $(lire SHH_ALERTE_SMART_DISQUES lsblk -dno NAME,TYPE | awk '$2=="disk"{print $1}'); do
	command -v smartctl >/dev/null 2>&1 || [ -n "${SHH_ALERTE_SMART:-}" ] || break
	r=$(SHH_DISQUE=$disque lire SHH_ALERTE_SMART smartctl -H "/dev/$disque")
	if printf '%s' "$r" | grep -Eq 'FAILED|FAILING'; then
		envoyer smart $HEURE "le disque $disque annonce une panne (smartctl -H) : sauvegarde et remplacement à demander à l'hébergeur"
	fi
done

# --- Mémoire, charge ----------------------------------------------------------------------------
meminfo=$(lire SHH_ALERTE_MEMINFO cat /proc/meminfo)
total=$(printf '%s\n' "$meminfo" | awk '/^MemTotal:/{print $2}')
dispo=$(printf '%s\n' "$meminfo" | awk '/^MemAvailable:/{print $2}')
if [[ ${total:-} =~ ^[0-9]+$ ]] && [[ ${dispo:-} =~ ^[0-9]+$ ]] && [ "$total" -gt 0 ] && [ $((dispo * 100 / total)) -lt 10 ]; then
	envoyer memoire $HEURE "mémoire disponible : $((dispo * 100 / total)) % seulement"
fi
charge=$(lire SHH_ALERTE_LOADAVG cat /proc/loadavg | awk '{print int($3)}')
coeurs=$(lire SHH_ALERTE_NPROC nproc)
if [[ ${charge:-} =~ ^[0-9]+$ ]] && [[ ${coeurs:-} =~ ^[0-9]+$ ]] && [ "$charge" -gt $((2 * coeurs)) ]; then
	envoyer charge $JOUR "charge moyenne sur 15 min : $charge pour $coeurs cœur(s)"
fi

# --- Certificat, domaine, DNS, hébergement ------------------------------------------------------
jours_cert="" jours_dom="" jours_serv=""
if [ -n "${SHH_DOMAIN:-}" ]; then
	cert_servi=""
	if [ -z "${SHH_ALERTE_CERT_FIN:-}" ] || [ -z "${SHH_ALERTE_CERT_SERIE:-}" ]; then
		cert_servi=$(openssl s_client -connect "$SHH_DOMAIN:443" -servername "$SHH_DOMAIN" </dev/null 2>/dev/null |
			openssl x509 -noout -startdate -enddate -serial 2>/dev/null || true)
	fi
	fin_cert=${SHH_ALERTE_CERT_FIN:-$(printf '%s\n' "$cert_servi" | sed -n 's/^notAfter=//p')}
	debut_cert=${SHH_ALERTE_CERT_DEBUT:-$(printf '%s\n' "$cert_servi" | sed -n 's/^notBefore=//p')}
	serie_servie=${SHH_ALERTE_CERT_SERIE:-$(printf '%s\n' "$cert_servi" | sed -n 's/^serial=//p')}
	# www.<nom> (redirection 308 vers le site, Caddyfile) : son propre certificat, demandé par
	# le même Caddy avec le même compte ACME ; sa série est connue comme celle du site. Lu sur
	# la même adresse (le nom du site) : aucun enregistrement www n'est nécessaire pour le lire.
	# shellcheck disable=SC2016 # $1 est développé par le bash -c, pas ici
	serie_www=$(lire SHH_ALERTE_CERT_WWW bash -c 'openssl s_client -connect "$1:443" -servername "www.$1" </dev/null 2>/dev/null |
		openssl x509 -noout -serial' _ "$SHH_DOMAIN" | sed -n 's/^serial=//p')
	jours_cert="" heures_cert="" court=0
	if [ -n "$fin_cert" ]; then
		jours_cert=$(jours_jusqua "$fin_cert")
		t_fin=$(date -u -d "$fin_cert" +%s 2>/dev/null || true)
		[ -n "$t_fin" ] && heures_cert=$(((t_fin - now) / HEURE))
		# Certificat court (profil « shortlived », 6 jours, Caddyfile) : Caddy le renouvelle
		# quand il lui reste environ 2 jours ; moins de 36 h, c'est que le renouvellement échoue.
		t_debut=""
		# Date vide : « date -d "" » rendrait minuit du jour, jamais l'utiliser.
		if [ -n "${debut_cert:-}" ]; then t_debut=$(date -u -d "$debut_cert" +%s 2>/dev/null || true); fi
		if [ -n "$t_fin" ] && [ -n "$t_debut" ] && [ $((t_fin - t_debut)) -le $((10 * JOUR)) ]; then court=1; fi
	fi
	if [ -z "$jours_cert" ]; then
		if [ -n "$sante" ]; then envoyer certificat-bientot $JOUR "certificat TLS illisible sur $SHH_DOMAIN:443"; fi
	elif [ "$court" = 1 ]; then
		if [ "$heures_cert" -lt 36 ]; then
			envoyer certificat $HEURE "certificat TLS de 6 jours expiré ou à $heures_cert h de sa fin : Caddy ne le renouvelle pas (Let's Encrypt en panne ? DNS, port 80). En cas de panne longue : retirer le bloc « issuer acme » du Caddyfile pour revenir aux certificats de 90 jours"
		fi
	elif [ "$jours_cert" -lt 7 ]; then
		envoyer certificat $HEURE "certificat TLS expiré ou à $jours_cert jour(s) de sa fin : Caddy ne le renouvelle pas (journal de Caddy, DNS, port 80)"
	elif [ "$jours_cert" -lt 21 ]; then
		envoyer certificat-bientot $JOUR "certificat TLS à $jours_cert jours de sa fin : le renouvellement automatique échoue"
	fi

	# Échéance du domaine : RDAP (registre du domaine, une fois par jour au plus), sinon la date notée.
	rdap_cache="$etat/domaine-echeance"
	fin_dom=""
	if [ -f "$rdap_cache" ] && [ $((now - $(stat -c %Y "$rdap_cache"))) -lt $JOUR ] && [ -z "${SHH_ALERTE_RDAP:-}" ]; then
		fin_dom=$(cat "$rdap_cache")
	else
		rdap=$(lire SHH_ALERTE_RDAP curl -sS --fail -L --max-time 20 --proto '=https' --proto-redir '=https' \
			-H 'Accept: application/rdap+json' "https://rdap.org/domain/$SHH_DOMAIN")
		fin_dom=$(printf '%s' "$rdap" | tr '{' '\n' | tr '}' '\n' | grep '"eventAction" *: *"expiration"' |
			sed -n 's/.*"eventDate" *: *"\([^"]*\)".*/\1/p' | head -1 || true)
		[ -n "$fin_dom" ] && printf '%s' "$fin_dom" >"$rdap_cache"
	fi
	[ -n "$fin_dom" ] || fin_dom=${SHH_DOMAINE_ECHEANCE:-}
	jours_dom=""
	if [ -n "$fin_dom" ]; then jours_dom=$(jours_jusqua "$fin_dom"); fi
	if [ -z "$jours_dom" ]; then
		envoyer domaine-illisible $SEMAINE "échéance du domaine $SHH_DOMAIN illisible (RDAP) : la noter dans SHH_DOMAINE_ECHEANCE et vérifier le renouvellement automatique chez le registraire"
	elif [ "$jours_dom" -lt 7 ]; then
		envoyer domaine $HEURE "le domaine $SHH_DOMAIN expire dans $jours_dom jour(s) : le renouveler maintenant"
	elif [ "$jours_dom" -lt 45 ]; then
		envoyer domaine-bientot $SEMAINE "le domaine $SHH_DOMAIN expire dans $jours_dom jours : vérifier le renouvellement automatique et le moyen de paiement"
	fi

	# Certificats émis pour le nom (journaux publics Certificate Transparency, via crt.sh, une
	# fois par jour) : tout certificat émis ces 3 derniers jours qui n'est pas celui que sert
	# Caddy est suspect (DNS détourné, autorité trompée, clé du serveur volée qui sert ailleurs).
	# Une erreur de renouvellement suivie d'un nouvel essai le même jour peut aussi le déclencher.
	ct_cache="$etat/ct"
	if [ -f "$ct_cache" ] && [ $((now - $(stat -c %Y "$ct_cache"))) -lt $JOUR ] && [ -z "${SHH_ALERTE_CT:-}" ]; then
		ct=$(cat "$ct_cache")
	else
		# Le nom, puis www.<nom> (crt.sh ne rend que les certificats du nom exact demandé).
		ct=$(lire SHH_ALERTE_CT curl -sS --fail --max-time 60 --proto '=https' \
			"https://crt.sh/?q=$SHH_DOMAIN&output=json&exclude=expired")
		ct=$ct$(lire SHH_ALERTE_CT_WWW curl -sS --fail --max-time 60 --proto '=https' \
			"https://crt.sh/?q=www.$SHH_DOMAIN&output=json&exclude=expired")
		printf '%s' "$ct" >"$ct_cache"
	fi
	norm() { tr 'A-F' 'a-f' | tr -d ':' | sed 's/^0*//'; }
	serie_ok=$(printf '%s' "$serie_servie" | norm)
	# Numéros de série servis ces 10 derniers jours (vus toutes les 15 min) : avec des
	# certificats de 6 jours, deux certificats légitimes peuvent tomber dans la fenêtre.
	series="$etat/series-servies"
	touch "$series"
	for vue in "$serie_ok" "$(printf '%s' "$serie_www" | norm)"; do
		if [ -n "$vue" ] && ! grep -q " $vue\$" "$series"; then printf '%s %s\n' "$now" "$vue" >>"$series"; fi
	done
	awk -v lim=$((now - 10 * JOUR)) '$1 >= lim' "$series" >"$series.n" && mv "$series.n" "$series"
	if [ -n "$ct" ] && [ -n "$serie_ok" ]; then
		inconnus=0
		while IFS='|' read -r debut serie; do
			if [ -z "$debut" ] || [ -z "$serie" ]; then continue; fi
			t=$(date -u -d "$debut" +%s 2>/dev/null) || continue
			[ $((now - t)) -le $((3 * JOUR)) ] || continue
			grep -q " $(printf '%s' "$serie" | norm)\$" "$series" || inconnus=$((inconnus + 1))
		done < <(printf '%s' "$ct" | tr '{' '\n' | tr '}' '\n' | grep '"serial_number"' |
			sed -n 's/.*"not_before" *: *"\([^"]*\)".*"serial_number" *: *"\([^"]*\)".*/\1|\2/p; t; s/.*"serial_number" *: *"\([^"]*\)".*"not_before" *: *"\([^"]*\)".*/\2|\1/p' || true)
		if [ "$inconnus" -gt 0 ]; then
			envoyer certificat-inconnu $JOUR "$inconnus certificat(s) émis pour $SHH_DOMAIN ou www.$SHH_DOMAIN ces 3 derniers jours, autre(s) que ceux que sert le site : vérifier sur crt.sh ; si ce n'est pas un renouvellement de Caddy, le DNS ou la clé est compromis (README, « Hébergeur et certificat »)"
		fi
	fi

	# DNS : le nom pointe-t-il vers une adresse de cette machine ? (Rien n'est écrit ni envoyé.)
	dns=$(lire SHH_ALERTE_DNS getent ahosts "$SHH_DOMAIN" | awk '{print $1}' | sort -u)
	ips=$(lire SHH_ALERTE_IPS ip -o addr show | awk '{sub(/\/.*/, "", $4); print $4}' | sort -u)
	if [ -n "$dns" ] && [ -n "$ips" ] && [ -z "$(comm -12 <(printf '%s\n' "$dns") <(printf '%s\n' "$ips"))" ]; then
		envoyer dns $HEURE "le nom $SHH_DOMAIN ne pointe vers aucune adresse de cette machine : enregistrements DNS à vérifier (détournement, expiration)"
	fi
fi
if [ -n "${SHH_SERVEUR_ECHEANCE:-}" ]; then
	jours_serv=$(jours_jusqua "$SHH_SERVEUR_ECHEANCE")
	if [ -z "$jours_serv" ]; then
		envoyer hebergement-bientot $SEMAINE "SHH_SERVEUR_ECHEANCE illisible (attendu : AAAA-MM-JJ)"
	elif [ "$jours_serv" -lt 7 ]; then
		envoyer hebergement $HEURE "la location du serveur se termine dans $jours_serv jour(s) : la renouveler maintenant (sinon tout est effacé)"
	elif [ "$jours_serv" -lt 45 ]; then
		envoyer hebergement-bientot $SEMAINE "la location du serveur se termine dans $jours_serv jours : renouvellement automatique et moyen de paiement à vérifier, puis SHH_SERVEUR_ECHEANCE à mettre à jour"
	fi
fi

# --- Sauvegarde ---------------------------------------------------------------------------------
if [ -n "${SHH_SAUVEGARDE_URL:-}" ]; then
	ok_fichier=${SHH_ALERTE_SAUVEGARDE_OK:-/var/lib/shhdrop-sauvegarde/ok}
	derniere=$(cat "$ok_fichier" 2>/dev/null || true)
	if ! [[ $derniere =~ ^[0-9]+$ ]] || [ $((now - derniere)) -gt $((26 * HEURE)) ]; then
		envoyer sauvegarde $((6 * HEURE)) "aucune sauvegarde réussie depuis plus de 26 h (systemctl status shhdrop-sauvegarde.service)"
	fi
	envoyer restauration $((30 * JOUR)) "rappel mensuel : essayer de restaurer la dernière sauvegarde sur une autre machine (README §12)"
fi

# --- Mises à jour, horloge, unités --------------------------------------------------------------
# Système : au plus une simulation par jour (« apt-get -s » ne change rien).
apt_cache="$etat/maj-securite-nombre"
if [ -f "$apt_cache" ] && [ $((now - $(stat -c %Y "$apt_cache"))) -lt $JOUR ] && [ -z "${SHH_ALERTE_APT:-}" ]; then
	n_secu=$(cat "$apt_cache")
else
	n_secu=$(lire SHH_ALERTE_APT apt-get -s -o Debug::NoLocking=1 upgrade | grep '^Inst ' | grep -ci 'security' || true)
	printf '%s' "${n_secu:-0}" >"$apt_cache"
fi
if [[ ${n_secu:-} =~ ^[0-9]+$ ]] && [ "$n_secu" -gt 0 ]; then
	envoyer maj-securite $JOUR "$n_secu mise(s) à jour de sécurité du système en attente (apt upgrade, ou vérifier unattended-upgrades)"
fi
if [ -e "${SHH_ALERTE_REBOOT:-/var/run/reboot-required}" ]; then
	envoyer redemarrage $JOUR "une mise à jour demande un redémarrage (noyau ou bibliothèques) : le prévoir, puis déverrouiller le volume chiffré"
fi
# Service : retard de la copie du dépôt sur GitHub (une vérification par jour).
retard_cache="$etat/maj-service-retard"
if [ -f "$retard_cache" ] && [ $((now - $(stat -c %Y "$retard_cache"))) -lt $JOUR ] && [ -z "${SHH_ALERTE_RETARD:-}" ]; then
	retard=$(cat "$retard_cache")
elif [ -n "${SHH_ALERTE_RETARD:-}" ]; then
	retard=$(bash -c "$SHH_ALERTE_RETARD" 2>/dev/null || true)
else
	retard=""
	if git -C "$here/.." rev-parse --git-dir >/dev/null 2>&1 &&
		timeout 60 git -C "$here/.." fetch -q origin main 2>/dev/null; then
		retard=$(git -C "$here/.." rev-list --count HEAD..FETCH_HEAD 2>/dev/null || true)
	fi
	printf '%s' "$retard" >"$retard_cache"
fi
if [[ ${retard:-} =~ ^[0-9]+$ ]] && [ "$retard" -gt 0 ]; then
	envoyer maj-service $JOUR "$retard commit(s) de retard sur GitHub (correctifs possibles) : vérifier la CI, puis deploy.sh avec le commit confirmé (git fetch, jamais git pull : README §3.5)"
fi
ntp=$(lire SHH_ALERTE_NTP timedatectl show -p NTPSynchronized --value)
if [ -n "$ntp" ] && [ "$ntp" != yes ]; then
	envoyer horloge $JOUR "horloge non synchronisée (timedatectl) : échéances des liens et codes à usage unique faussés"
fi
unites=$(lire SHH_ALERTE_UNITES systemctl --failed --no-legend --plain | awk '{print $1}' | grep -c . || true)
if [ "${unites:-0}" -gt 0 ]; then
	envoyer unites $JOUR "$unites unité(s) systemd en échec (systemctl --failed)"
fi

# --- Bilan de la semaine (preuve que l'alerte fonctionne) ---------------------------------------
bilan="Bilan de la machine (deploy/alerte.sh), chaque semaine même sans problème.
Disque des données : ${pct_donnees:-?} %
Certificat TLS : ${jours_cert:-?} jour(s) restant(s)
Domaine : ${jours_dom:-?} jour(s) avant l'échéance
Location du serveur : ${jours_serv:+$jours_serv jour(s)}${jours_serv:-non renseignée (SHH_SERVEUR_ECHEANCE)}
Mises à jour de sécurité en attente : ${n_secu:-?}
Commits de retard sur GitHub : ${retard:-?}"
if [ ${#constats[@]} -eq 0 ]; then
	bilan+=$'\n\nRien à signaler.'
else
	bilan+=$'\n\nConstats en cours :'
	for c in "${constats[@]}"; do bilan+=$'\n- '"$c"; done
fi
envoyer bilan $SEMAINE "$bilan"

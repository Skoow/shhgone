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
#     integrite-differences  le contrôle d'intégrité de la nuit a trouvé des différences (rappel ;
#                    la liste des chemins est dans l'e-mail « URGENT intégrité » d'integrite.sh)
#     integrite-muette  ce contrôle n'a pas tourné depuis 36 h (coupé ?)
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
#   bilan            chaque lundi, même sans problème : un seul e-mail résumé, en sections
#                    (intégrité, mises à jour à faire dont résultats de securite.yml et Dependabot,
#                    santé avec dates et états réels, connexions SSH de la semaine), un verdict
#                    ✅ ⚠️ ❌ par ligne.
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
#   serveur Go et le compte (par passkey) n'envoient aucun e-mail, et
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
# SHH_ALERTE_DEMARRAGE, SHH_ALERTE_MONTE (« oui » ou « non »), SHH_ALERTE_MDP_FICHIER,
# SHH_ALERTE_INTEGRITE, SHH_ALERTE_SSH, SHH_ALERTE_GITHUB (commande, chemin de l'API en $1),
# SHH_ALERTE_GITHUB_JETON, SHH_ALERTE_DIG (commande, arguments de dig), SHH_ALERTE_TEMPS,
# SHH_ALERTE_CERT_EMETTEUR ; SHH_COURRIEL_ENVOI (courriel.sh).
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
die() { printf 'alerte : %s\n' "$*" >&2; exit 1; }
env_file=${SHH_ENV_FILE:-$here/.env}
[ -f "$env_file" ] || die "$env_file absent"
# Lu en NOM=valeur, jamais exécuté (lire-env.sh : refusé s'il n'est pas à root ou modifiable par
# d'autres).
# shellcheck source=deploy/lire-env.sh
. "$here/lire-env.sh"
lire_env "$env_file" 0 || die "$env_file refusé (voir ci-dessus)"
# shellcheck source=deploy/courriel.sh
. "$here/courriel.sh"
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

envoyer() { # $1 : sujet (nom du fichier d'état), $2 : période en secondes, $3 : texte, [$4 : objet de l'e-mail]
	local cle=$1 periode=$2 texte=$3 objet=${4:-} last=0 niveau="À prévoir"
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
	# Envoi (courriel.sh). Raté, ou mot de passe illisible : la date n'est pas écrite, l'essai
	# reprend au passage suivant. Sans SHH_ALERTE_A : constat sur la sortie seulement.
	local code=0
	courriel_envoyer "$niveau" "$cle" "$texte" "$objet" || code=$?
	case $code in
	0 | 2) printf '%s\n' "$now" >"$etat/$cle" ;;
	3) die "SHH_ALERTE_A sans SHH_ALERTE_SMTP_HOST, SHH_ALERTE_SMTP_USER et SHH_ALERTE_FROM" ;;
	esac
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
mem_pct=""
if [[ ${total:-} =~ ^[0-9]+$ ]] && [[ ${dispo:-} =~ ^[0-9]+$ ]] && [ "$total" -gt 0 ]; then mem_pct=$((dispo * 100 / total)); fi
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
			openssl x509 -noout -startdate -enddate -serial -issuer 2>/dev/null || true)
	fi
	fin_cert=${SHH_ALERTE_CERT_FIN:-$(printf '%s\n' "$cert_servi" | sed -n 's/^notAfter=//p')}
	debut_cert=${SHH_ALERTE_CERT_DEBUT:-$(printf '%s\n' "$cert_servi" | sed -n 's/^notBefore=//p')}
	serie_servie=${SHH_ALERTE_CERT_SERIE:-$(printf '%s\n' "$cert_servi" | sed -n 's/^serial=//p')}
	# Émetteur (bilan du lundi) : organisation de l'autorité, sinon son nom commun.
	emetteur=${SHH_ALERTE_CERT_EMETTEUR:-$(printf '%s\n' "$cert_servi" | sed -n 's/^issuer=//p' | sed -nE 's/(^|.*, )O ?= ?([^,]+).*/\2/p; t; s/(^|.*, )CN ?= ?([^,]+).*/\2/p')}
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
		# Verrou de transfert chez le registraire (statut RDAP « client transfer prohibited »),
		# pour le bilan du lundi : oui, non, ou rien si RDAP n'a pas répondu.
		if [ -n "$rdap" ]; then
			if printf '%s' "$rdap" | grep -qi '"client transfer prohibited"'; then echo oui; else echo non; fi >"$etat/domaine-verrou"
		fi
	fi
	dom_verrou=$(cat "$etat/domaine-verrou" 2>/dev/null || true)
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
	simu=$(lire SHH_ALERTE_APT apt-get -s -o Debug::NoLocking=1 upgrade | grep '^Inst ' || true)
	n_secu=$(printf '%s\n' "$simu" | grep -ci 'security' || true)
	n_maj=$(printf '%s\n' "$simu" | grep -c . || true)
	printf '%s' "${n_maj:-0}" >"$etat/maj-total-nombre"
	printf '%s' "${n_secu:-0}" >"$apt_cache"
fi
n_maj=$(cat "$etat/maj-total-nombre" 2>/dev/null || echo "?")
redemarrage_demande=non
if [ -e "${SHH_ALERTE_REBOOT:-/var/run/reboot-required}" ]; then redemarrage_demande=oui; fi
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

# --- Intégrité (deploy/integrite.sh, chaque nuit) -----------------------------------------------
# Son état (aucun chemin, aucune valeur : des résultats, des nombres, des dates et l'empreinte de
# la base) est lu ici. Installée (état présent) mais muette depuis 36 h : quelqu'un a pu couper le
# contrôle (minuteur arrêté, AIDE retiré) ; URGENT. Différences : rappel URGENT une fois par jour
# (la liste des chemins est dans l'e-mail de la nuit).
integ_etat=${SHH_ALERTE_INTEGRITE:-/var/lib/shhdrop-integrite/etat}
integ_resultat="" integ_date="" integ_base="" integ_image="" integ_volume="" integ_paquets="" integ_ecarts=""
if [ -f "$integ_etat" ]; then
	while IFS='=' read -r k v; do
		case $k in
		resultat) integ_resultat=$v ;;
		date) integ_date=$v ;;
		base) integ_base=$v ;;
		image) integ_image=$v ;;
		volume) integ_volume=$v ;;
		paquets) integ_paquets=$v ;;
		ecarts) integ_ecarts=$v ;;
		esac
	done <"$integ_etat"
fi
integ_muette=0
if [ -f "$integ_etat" ] && { ! [[ $integ_date =~ ^[0-9]+$ ]] || [ $((now - integ_date)) -gt $((36 * HEURE)) ]; }; then
	integ_muette=1
	envoyer integrite-muette $HEURE "le contrôle d'intégrité de la nuit n'a pas tourné depuis plus de 36 h (systemctl status shhdrop-integrite.timer) : il a pu être coupé. Suivre README, « Que faire si une alerte d'intégrité arrive »"
fi
if [ "$integ_resultat" = alerte ]; then
	envoyer integrite-differences $JOUR "le contrôle d'intégrité de la nuit a trouvé ${integ_ecarts:-des} différence(s) (liste dans l'e-mail « URGENT intégrité » ; sinon : sudo deploy/integrite.sh verifier). Suivre README, « Que faire si une alerte d'intégrité arrive »"
fi

# --- Bilan du lundi (un seul e-mail, résumé ; preuve que l'alerte fonctionne) -------------------
# Chaque lundi (heure UTC), même sans problème, en sections, une ligne par point, avec un verdict :
# ✅ bon, ⚠️ à voir, ❌ à traiter. Pas d'e-mail le lundi = l'alerte, ou la machine, ne marche plus
# (README §4). La partie GitHub (dernier passage de securite.yml, propositions Dependabot) est
# lue par l'API de GitHub avec un jeton en LECTURE SEULE (/etc/shhdrop/alerte_github_jeton,
# deploy/secret.sh) ; sans lui : « non configuré ». Connexions SSH de la semaine : registre de
# ssh-connexion.sh (heure, compte, clé ; jamais d'adresse).
v() { # <ok|av|ko> <texte> : une ligne et son verdict (comptés ensuite dans le texte)
	case $1 in
	ok) printf '✅ %s\n' "$2" ;;
	av) printf '⚠️ %s\n' "$2" ;;
	ko) printf '❌ %s\n' "$2" ;;
	esac
}
quand() { date -u -d "@$1" '+%Y-%m-%d %H:%M UTC'; }
# Texte venu de GitHub (titres) : une ligne imprimable, 120 caractères au plus.
net() { sed 's/[^[:print:]]/ /g' | cut -c1-120; }

github() { # <chemin sous /repos/<dépôt>> : JSON sur la sortie ; code non nul si illisible
	if [ -n "${SHH_ALERTE_GITHUB:-}" ]; then
		bash -c "$SHH_ALERTE_GITHUB" _ "$1"
		return
	fi
	# Jeton lu par curl depuis un fichier de configuration (jamais sur la ligne de commande).
	curl -sS --fail --max-time 30 --proto '=https' -H 'Accept: application/vnd.github+json' \
		-H 'X-GitHub-Api-Version: 2022-11-28' \
		-K <(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$jeton_gh")") \
		"https://api.github.com/repos/${SHH_ALERTE_GITHUB_DEPOT:-Skoow/shhgone}$1"
}
# Noms lisibles des jobs de .github/workflows/securite.yml.
nom_job() {
	case $1 in
	go) echo "failles des dépendances Go (govulncheck : serveur, relais)" ;;
	caddy) echo "failles du binaire de Caddy (govulncheck)" ;;
	outils) echo "outils épinglés à jour (deploy/outils-a-jour.sh)" ;;
	fuzz) echo "fuzzing des analyseurs" ;;
	web) echo "failles des dépendances du site (npm audit)" ;;
	engine) echo "failles du moteur Rust (cargo audit)" ;;
	gosec) echo "analyse de notre code Go (gosec)" ;;
	semgrep) echo "analyse de notre code Go et TypeScript (Semgrep)" ;;
	site) echo "contrôle externe du site (ports, TLS, en-têtes)" ;;
	*) printf '%s\n' "$1" | net ;;
	esac
}

jeton_gh=${SHH_ALERTE_GITHUB_JETON:-/etc/shhdrop/alerte_github_jeton}
gh_pret() { { [ -n "${SHH_ALERTE_GITHUB:-}" ] || [ -r "$jeton_gh" ]; } && command -v jq >/dev/null 2>&1; }
bilan_dernier=$(cat "$etat/bilan" 2>/dev/null || echo 0)
[[ $bilan_dernier =~ ^[0-9]+$ ]] || bilan_dernier=0
if [ "$(date -u -d "@$now" +%u)" = 1 ] && [ $((now - bilan_dernier)) -ge $((3 * JOUR)) ]; then
	# 1. Intégrité.
	s1=$(
		if [ -z "$integ_resultat" ]; then
			v av "Empreinte du serveur : contrôle non installé (deploy.sh l'installe)"
		elif [ "$integ_muette" = 1 ]; then
			v ko "Empreinte du serveur : contrôle muet depuis plus de 36 h (coupé ?)"
		elif [ "$integ_resultat" = ok ]; then
			v ok "Empreinte du serveur : rien de changé (dernière vérification le $(quand "$integ_date"))"
		else
			v ko "Empreinte du serveur : ${integ_ecarts:-des} différence(s) (e-mail « URGENT intégrité »)"
		fi
		case $integ_paquets in
		0) v ok "Fichiers des paquets Debian conformes aux paquets officiels (dpkg --verify)" ;;
		"") v av "Fichiers des paquets Debian : pas encore vérifiés" ;;
		*) v ko "Fichiers des paquets Debian : $integ_paquets fichier(s) différent(s) des paquets officiels" ;;
		esac
		case $integ_image in
		ok) v ok "Image en cours = image signée vérifiée par deploy.sh (et Caddy épinglé)" ;;
		"serveur arrêté" | "aucune version installée") v av "Image : $integ_image" ;;
		"") v av "Image : pas encore vérifiée" ;;
		*) v ko "Image : $integ_image" ;;
		esac
		printf '   Base d%sintégrité : %s%s (doit être celle du dernier e-mail « Intégrité : base »)\n' "'" "${integ_base:-?}" "${integ_volume:+ ; volume : $integ_volume}"
	)
	# 2. Mises à jour à faire.
	s2=$(
		if [[ ${n_secu:-} =~ ^[0-9]+$ ]] && [ "$n_secu" -gt 0 ]; then
			v av "Système : $n_secu mise(s) à jour de sécurité en attente (sur ${n_maj:-?}) : vérifier unattended-upgrades"
		elif [[ ${n_maj:-} =~ ^[0-9]+$ ]] && [ "$n_maj" -gt 0 ]; then
			v av "Système : $n_maj mise(s) à jour en attente, aucune de sécurité"
		else
			v ok "Système à jour"
		fi
		if [ "$redemarrage_demande" = oui ]; then
			v av "Redémarrage nécessaire (noyau ou bibliothèques) : le prévoir, puis déverrouiller le volume"
		else
			v ok "Aucun redémarrage nécessaire"
		fi
		if [[ ${retard:-} =~ ^[0-9]+$ ]] && [ "$retard" -gt 0 ]; then
			v av "Service : $retard commit(s) de retard sur GitHub (à déployer après la CI)"
		elif [[ ${retard:-} =~ ^[0-9]+$ ]]; then
			v ok "Service : à jour avec GitHub"
		fi
		if [ -z "${SHH_ALERTE_GITHUB:-}" ] && [ ! -r "$jeton_gh" ]; then
			v av "GitHub : non configuré (jeton en lecture seule absent : README §4, sudo deploy/secret.sh alerte_github_jeton)"
		elif ! command -v jq >/dev/null 2>&1; then
			v av "GitHub : jq absent (deploy.sh l'installe)"
		else
			runs=$(github "/actions/workflows/securite.yml/runs?per_page=1&status=completed" 2>/dev/null) || runs=
			run_id=$(printf '%s' "$runs" | jq -r '.workflow_runs[0].id // empty' 2>/dev/null) || run_id=
			if [[ ! $run_id =~ ^[0-9]+$ ]]; then
				v av "GitHub : vérification de sécurité illisible (réseau, jeton expiré ou sans droit Actions)"
			else
				run_date=$(printf '%s' "$runs" | jq -r '.workflow_runs[0].created_at // empty' | net)
				t_run=$(date -u -d "$run_date" +%s 2>/dev/null || echo 0)
				if [ $((now - t_run)) -gt $((8 * JOUR)) ]; then
					v av "Vérification de sécurité : aucun passage depuis le ${run_date%%T*} (workflows planifiés désactivés par GitHub ? les réactiver dans l'onglet Actions)"
				fi
				jobs=$(github "/actions/runs/$run_id/jobs?per_page=50" 2>/dev/null | jq -r '.jobs[] | "\(.conclusion // "en cours") \(.name)"' 2>/dev/null) || jobs=
				if [ -z "$jobs" ]; then
					v av "Vérification de sécurité du ${run_date%%T*} : jobs illisibles"
				fi
				while read -r c j; do
					[ -n "$j" ] || continue
					case $c in
					success) v ok "$(nom_job "$j") : rien trouvé (${run_date%%T*})" ;;
					skipped) v av "$(nom_job "$j") : sauté (${run_date%%T*})" ;;
					*) v ko "$(nom_job "$j") : $(printf '%s' "$c" | net) (${run_date%%T*}) : lire le journal du job (onglet Actions)" ;;
					esac
				done <<<"$jobs"
			fi
			prs=$(github "/pulls?state=open&per_page=100" 2>/dev/null | jq -r '.[] | select(.user.login == "dependabot[bot]") | .title' 2>/dev/null) || prs="?"
			if [ "$prs" = "?" ]; then
				v av "Dependabot : propositions illisibles (jeton sans droit Pull requests ?)"
			elif [ -z "$prs" ]; then
				v ok "Dependabot : aucune proposition ouverte (dont l'image de Caddy)"
			else
				n=$(printf '%s\n' "$prs" | grep -c .)
				v av "Dependabot : $n proposition(s) ouverte(s), à relire puis fusionner :"
				printf '%s\n' "$prs" | net | head -n 15 | sed 's/^/     - /'
				if printf '%s\n' "$prs" | grep -qi 'caddy'; then
					v av "Image de Caddy : nouvelle version proposée (ci-dessus)"
				fi
			fi
		fi
	)
	# 3. Santé : dates et état réels (ce que ce script a déjà lu plus haut ; DNS par dig).
	s3=$(
		# Certificat HTTPS.
		fin_txt=""
		if [ -n "${fin_cert:-}" ]; then fin_txt=$(date -u -d "$fin_cert" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || true); fi
		emet=$(printf '%s' "${emetteur:-?}" | net)
		if ! [[ ${jours_cert:-} =~ ^-?[0-9]+$ ]]; then
			v ko "Certificat HTTPS : illisible sur ${SHH_DOMAIN:-?}:443"
		elif [ "${court:-0}" = 1 ]; then
			if [ "${heures_cert:-0}" -lt 36 ]; then
				v ko "Certificat HTTPS ($emet, 6 jours) : fin le $fin_txt, renouvellement automatique EN ÉCHEC"
			else
				v ok "Certificat HTTPS ($emet, 6 jours) : fin le $fin_txt, renouvellement automatique OK"
			fi
		elif [ "$jours_cert" -lt 7 ]; then
			v ko "Certificat HTTPS ($emet) : fin le $fin_txt, renouvellement automatique EN ÉCHEC"
		elif [ "$jours_cert" -lt 21 ]; then
			v av "Certificat HTTPS ($emet) : fin le $fin_txt, renouvellement automatique en retard"
		else
			v ok "Certificat HTTPS ($emet) : fin le $fin_txt, renouvellement automatique OK"
		fi
		# Domaine, hébergement.
		if ! [[ ${jours_dom:-} =~ ^-?[0-9]+$ ]]; then
			v av "Nom de domaine : échéance illisible (RDAP) et non notée (SHH_DOMAINE_ECHEANCE)"
		else
			t="Nom de domaine : échéance le ${fin_dom%%T*} ($jours_dom jours)"
			if [ "$jours_dom" -lt 7 ]; then v ko "$t"; elif [ "$jours_dom" -lt 45 ]; then v av "$t"; else v ok "$t"; fi
		fi
		case ${dom_verrou:-} in
		oui) v ok "Nom de domaine : verrou de transfert actif chez le registraire" ;;
		non) v av "Nom de domaine : verrou de transfert NON actif (l'activer chez le registraire, §15.4)" ;;
		*) v av "Nom de domaine : verrou de transfert illisible (RDAP)" ;;
		esac
		if ! [[ ${jours_serv:-} =~ ^-?[0-9]+$ ]]; then
			v av "Hébergement : échéance non renseignée (SHH_SERVEUR_ECHEANCE dans deploy/.env)"
		else
			t="Hébergement : fin de la location le $SHH_SERVEUR_ECHEANCE ($jours_serv jours)"
			if [ "$jours_serv" -lt 7 ]; then v ko "$t"; elif [ "$jours_serv" -lt 45 ]; then v av "$t"; else v ok "$t"; fi
		fi
		# DNS : DNSSEC (délégation signée : enregistrement DS chez le parent), CAA, SPF, DKIM, DMARC.
		if [ -n "${SHH_DOMAIN:-}" ] && { [ -n "${SHH_ALERTE_DIG:-}" ] || command -v dig >/dev/null 2>&1; }; then
			dg() {
				if [ -n "${SHH_ALERTE_DIG:-}" ]; then bash -c "$SHH_ALERTE_DIG" _ "$@" 2>/dev/null || true; else dig +short +time=5 +tries=2 "$@" 2>/dev/null || true; fi
			}
			if [ -n "$(dg DS "$SHH_DOMAIN")" ]; then v ok "DNSSEC : actif (délégation signée)"; else v ko "DNSSEC : absent (aucun enregistrement DS)"; fi
			caa=$(dg CAA "$SHH_DOMAIN")
			if printf '%s' "$caa" | grep -q 'accounturi='; then
				v ok "CAA : présent, lié au compte ACME"
			elif [ -n "$caa" ]; then
				v av "CAA : présent, pas encore lié au compte ACME (accounturi, §1)"
			else
				v ko "CAA : absent"
			fi
			if dg TXT "$SHH_DOMAIN" | grep -q 'v=spf1'; then v ok "SPF : présent"; else v av "SPF : absent"; fi
			if dg TXT "_dmarc.$SHH_DOMAIN" | grep -q 'v=DMARC1'; then v ok "DMARC : présent"; else v av "DMARC : absent"; fi
			dkim=""
			for sel in ${SHH_ALERTE_DKIM_SELECTEURS:-default google selector1 selector2 k1 mail dkim protonmail s1 s2}; do
				[[ $sel =~ ^[A-Za-z0-9._-]+$ ]] || continue
				if dg TXT "$sel._domainkey.$SHH_DOMAIN" | grep -q 'p='; then dkim=$sel && break; fi
			done
			if [ -n "$dkim" ]; then v ok "DKIM : présent (sélecteur $dkim)"; else v av "DKIM : introuvable (sélecteur de votre fournisseur dans SHH_ALERTE_DKIM_SELECTEURS)"; fi
		else
			v av "DNS (DNSSEC, CAA, SPF, DKIM, DMARC) : non vérifié (dig absent ; deploy.sh l'installe)"
		fi
		# Site joignable, version servie.
		if [ -n "${SHH_DOMAIN:-}" ]; then
			rep=$(lire SHH_ALERTE_TEMPS curl -sS -o /dev/null --max-time 20 --proto '=https' -w '%{http_code} %{time_total}' "https://$SHH_DOMAIN/")
			read -r code_site temps <<<"$rep"
			if [ "${code_site:-}" = 200 ] || [ "${code_site:-}" = 503 ]; then
				ms=$(awk -v t="${temps:-0}" 'BEGIN{printf "%d", t * 1000}')
				t="Site joignable : https://$SHH_DOMAIN/ répond $code_site en $ms ms"
				[ "$code_site" = 503 ] && t+=" (préproduction : page de maintenance)"
				if [ "$ms" -gt 3000 ]; then v av "$t (lent)"; else v ok "$t"; fi
			else
				v ko "Site : https://$SHH_DOMAIN/ ne répond pas (${code_site:-aucune réponse})"
			fi
		fi
		version=$(cat "$here/.release.version" 2>/dev/null || true)
		case $integ_image in
		ok) v ok "Version servie : ${version:+web-v$version, }image signée vérifiée par deploy.sh, en cours d'exécution" ;;
		*) v av "Version servie : ${version:+web-v$version, }image ${integ_image:-pas encore vérifiée}" ;;
		esac
		# Contrôle horaire de GitHub (verifier-site.yml) : site en ligne = une Release signée.
		if gh_pret; then
			vs=$(github "/actions/workflows/verifier-site.yml/runs?per_page=1&status=completed" 2>/dev/null |
				jq -r '.workflow_runs[0] | "\(.conclusion) \(.created_at)"' 2>/dev/null | net) || vs=
			case $vs in
			"success "*) v ok "Version servie = Release signée (contrôle de GitHub du ${vs#success })" ;;
			"failure "*) v ko "Version servie : le contrôle de GitHub du ${vs#failure } a ÉCHOUÉ (verifier-site.yml)" ;;
			*) v av "Version servie : contrôle de GitHub illisible ou pas encore lancé (verifier-site.yml)" ;;
			esac
		fi
		# Machine.
		if ! [[ ${pct_donnees:-} =~ ^[0-9]+$ ]]; then
			v av "Disque des données : illisible"
		elif [ "$pct_donnees" -ge 90 ]; then
			v ko "Disque des données : $pct_donnees % occupé"
		elif [ "$pct_donnees" -ge 75 ]; then
			v av "Disque des données : $pct_donnees % occupé"
		else
			v ok "Disque des données : $pct_donnees % occupé"
		fi
		if ! [[ ${mem_pct:-} =~ ^[0-9]+$ ]]; then
			v av "Mémoire : illisible"
		elif [ "$mem_pct" -lt 10 ]; then
			v ko "Mémoire : $mem_pct % disponible"
		else
			v ok "Mémoire : $mem_pct % disponible"
		fi
		if [ -z "${SHH_SAUVEGARDE_URL:-}" ]; then
			v av "Sauvegarde : non surveillée (SHH_SAUVEGARDE_URL absente)"
		elif [[ ${derniere:-} =~ ^[0-9]+$ ]] && [ $((now - derniere)) -le $((26 * HEURE)) ]; then
			v ok "Sauvegarde : dernière réussie le $(quand "$derniere")"
		elif [[ ${derniere:-} =~ ^[0-9]+$ ]]; then
			v ko "Sauvegarde : dernière réussie le $(quand "$derniere") (plus de 26 h)"
		else
			v ko "Sauvegarde : aucune réussie"
		fi
		demarrage=$(lire SHH_ALERTE_DEMARRAGE uptime -s)
		printf '   Dernier redémarrage de la machine : %s\n' "$(printf '%s' "${demarrage:-?}" | net)"
		printf '   Mises à jour en attente : %s (dont sécurité : %s) ; redémarrage nécessaire : %s (section 2)\n' "${n_maj:-?}" "${n_secu:-?}" "$redemarrage_demande"
	)
	# 4. Connexions SSH de la semaine (registre de ssh-connexion.sh).
	registre_ssh=${SHH_ALERTE_SSH:-/var/lib/shhdrop-ssh/connexions}
	semaine=$(awk -v lim=$((now - 7 * JOUR)) '$1 ~ /^[0-9]+$/ && $1 >= lim' "$registre_ssh" 2>/dev/null || true)
	s4=$(
		if [ -z "$semaine" ]; then
			printf '   Aucune connexion SSH ces 7 derniers jours.\n'
		else
			printf '   %s connexion(s) ces 7 derniers jours (vérifier que ce sont bien les vôtres) :\n' "$(printf '%s\n' "$semaine" | grep -c .)"
			printf '%s\n' "$semaine" | tail -n 30 | while read -r t c k; do
				printf '     - %s, compte %s, clé %s\n' "$(quand "$t")" "$(printf '%s' "$c" | net)" "$(printf '%s' "$k" | net)"
			done
		fi
	)
	n_ko=$(printf '%s\n%s\n%s\n' "$s1" "$s2" "$s3" | grep -c '^❌' || true)
	n_av=$(printf '%s\n%s\n%s\n' "$s1" "$s2" "$s3" | grep -c '^⚠️' || true)
	bilan="Bilan du lundi de la machine (deploy/alerte.sh). ✅ bon, ⚠️ à voir, ❌ à traiter.

1. Intégrité du serveur
$s1

2. Mises à jour à faire
$s2

3. Santé
$s3

4. Connexions SSH de la semaine (jamais d'adresse IP)
$s4"
	if [ ${#constats[@]} -gt 0 ]; then
		bilan+=$'\n\nConstats en cours (alertes de la semaine encore vraies) :'
		for c in "${constats[@]}"; do bilan+=$'\n- '"$c"; done
	fi
	if [ "$n_ko" = 0 ] && [ "$n_av" = 0 ] && [ ${#constats[@]} -eq 0 ]; then
		bilan+=$'\n\nRien à signaler : tout va bien.'
		objet_bilan="Shhgone Bilan du lundi : tout va bien"
	else
		objet_bilan="Shhgone Bilan du lundi : $n_ko à traiter, $n_av à voir"
	fi
	bilan+=$'\n\nPas d\'e-mail un lundi = alerte : la machine ou son alerte ne marche plus (README §4).'
	envoyer bilan $((3 * JOUR)) "$bilan" "$objet_bilan"
fi

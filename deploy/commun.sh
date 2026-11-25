#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2034 # here, args, relance : posées par deploy.sh et preprod.sh ; prev* : lues par deploy.sh
# Partie commune de deploy.sh (Release signée) et de preprod.sh (version de développement en
# préproduction, README §15) : réglages de deploy/.env, verrous V1 et V2, contrôles de la machine,
# démarrage, contrôle de santé, retour arrière. Chargé par ces deux scripts seulement, depuis leur
# dossier, après qu'ils ont posé :
#   here     dossier du script (deploy/ de la copie du dépôt ; le script s'y est placé)
#   args     ses arguments, pour relancer le script du commit vérifié (verrous)
#   relance  nom du script à relancer (deploy.sh ou preprod.sh)
# Aucune option, variable ni commande ici ne saute un verrou ou un contrôle.
#
# État (deploy/.release et voisins, README §3) : « sha256:<64> » pour une image de Release
# (ghcr.io/skoow/shhgone@sha256:…, provenance vérifiée par deploy.sh), « preprod:<commit> » pour
# une image construite sur le serveur par preprod.sh (étiquette locale shhdrop-preprod:<commit>,
# sans signature : compromis de la préproduction, README §15).

# shellcheck source=deploy/journaux.sh
. ./journaux.sh

die() {
	printf 'erreur: %s\n' "$1" >&2
	exit "${2:-1}"
}

# jeton_preprod (posée par le script appelant, avant ce fichier ; lue avant deploy/.env) :
# « lire » (défaut) : jeton de préproduction exigé dès maintenant ; « installer » (deploy.sh et
# preprod.sh qui installent) : s'il manque, il est tiré par preflight (secrets_auto), après les
# verrous ; « sans » (outils qui ne joignent pas le site : secret.sh, etat.sh, admin-jeton.sh).
mode_jeton=${jeton_preprod:-lire}
case $mode_jeton in lire | installer | sans) ;; *) die "jeton_preprod : « $mode_jeton » inconnu" ;; esac

[ -f .env ] || die "deploy/.env absent (copier deploy/env.example et l'adapter)"
# Lu en NOM=valeur, jamais exécuté ; refusé s'il n'est pas à root ou modifiable par d'autres
# (lire-env.sh). Toutes ses variables sont exportées, comme avant.
# shellcheck source=deploy/lire-env.sh
. ./lire-env.sh
lire_env ./.env 1 || die "deploy/.env refusé (voir ci-dessus)"
: "${SHH_DOMAIN:?SHH_DOMAIN manquant dans deploy/.env}"
: "${SHH_DATA_ROOT:?SHH_DATA_ROOT manquant dans deploy/.env}"
# Après deploy/.env : ses constantes (dépôt, identité, image, cosign épinglé) sont en lecture
# seule et l'emportent sur toute variable du même nom venue de deploy/.env.
# shellcheck source=deploy/provenance.sh
. ./provenance.sh
# Image : ghcr.io/skoow/shhgone seulement (publiée et signée par release.yml, README §3.2) ;
# SHH_IMAGE_REPO, s'il reste dans deploy/.env, doit valoir exactement cela.
SHH_IMAGE_REPO=${SHH_IMAGE_REPO:-$PROVENANCE_IMAGE}
depot_image_valide "$SHH_IMAGE_REPO" || exit 1
# shellcheck source=deploy/verrous.sh
. ./verrous.sh
# shellcheck source=deploy/fichiers-secrets.sh
. ./fichiers-secrets.sh
# Copie du dépôt vérifiée par les verrous : celle de ce script (ses Caddyfile, compose.yaml et
# verify-site.mjs sont ceux qu'utilise l'installation), jamais une autre.
depot=$(cd "$here/.." && pwd)
# Autorités pour le contrôle TLS. Changé seulement par les essais (autorité interne de Caddy).
ca=${SHH_CHECK_CA:-/etc/ssl/certs/ca-certificates.crt}

# Caddyfile et page de maintenance (montés tous deux dans Caddy) : si l'un change, le conteneur
# est recréé (un fichier monté seul garde l'ancien contenu après un git merge).
SHH_CADDYFILE_SHA256=$(cat Caddyfile maintenance.html | sha256sum | cut -d' ' -f1)
export SHH_CADDYFILE_SHA256

cur=$(cat .release 2>/dev/null || true)
prev=$(cat .release.prev 2>/dev/null || true)
cur_v=$(cat .release.version 2>/dev/null || true)
prev_v=$(cat .release.prev.version 2>/dev/null || true)
cur_c=$(cat .release.commit 2>/dev/null || true)
prev_c=$(cat .release.prev.commit 2>/dev/null || true)
# valid : image de Release (empreinte). etat_valide : Release ou préproduction.
valid() { [[ $1 =~ ^sha256:[0-9a-f]{64}$ ]]; }
etat_valide() { valid "$1" || [[ $1 =~ ^preprod:[0-9a-f]{40}$ ]]; }
# ref_image <état> : référence Docker de l'image d'un état.
ref_image() {
	case $1 in
	sha256:*) printf '%s@%s' "$SHH_IMAGE_REPO" "$1" ;;
	preprod:*) printf 'shhdrop-preprod:%s' "${1#preprod:}" ;;
	*) return 1 ;;
	esac
}

# Préproduction (README §15) : SHH_PREPROD=1 dans deploy/.env met la barrière du Caddyfile (le
# public ne voit que la page de maintenance). Échec fermé : sans jeton bien réglé, rien ne
# démarre (aucune ouverture au public par erreur). Le jeton ne vient jamais de deploy/.env :
# seulement du fichier root 0600 de /etc/shhdrop, lu ici par root et donné à Caddy par son
# environnement (Caddy ne lit pas le fichier).
preprod=${SHH_PREPROD:-0}
[ "$preprod" = 0 ] || [ "$preprod" = 1 ] || die "SHH_PREPROD doit valoir 0 ou 1 (deploy/.env, README §15)"
[ -z "${SHH_PREPROD_JETON+x}" ] || die "deploy/.env : SHH_PREPROD_JETON n'a rien à y faire (le jeton est dans $PREPROD_JETON_FICHIER, README §15) : l'ôter"
SHH_PREPROD_JETON=""
if [ "$preprod" = 1 ] && [ "$mode_jeton" != sans ]; then
	if [ "$mode_jeton" = installer ] && [ ! -e "$PREPROD_JETON_FICHIER" ] && [ ! -L "$PREPROD_JETON_FICHIER" ]; then
		: # absent : tiré par preflight (secrets_auto), après les verrous ; rien ne démarre avant
	else
		SHH_PREPROD_JETON=$(lire_jeton_preprod "$PREPROD_JETON_FICHIER" 0) ||
			die "SHH_PREPROD=1 : jeton de préproduction illisible ($PREPROD_JETON_FICHIER, README §15) : rien ne démarre sans lui"
	fi
fi
SHH_PREPROD=$preprod
export SHH_PREPROD SHH_PREPROD_JETON

# Compte par passkey (README §12) : activé seulement par compose.yaml (SHH_COMPTES: "1", fichier
# relu et commité), jamais par deploy/.env. Aucun relais : le compte n'a aucune sortie.
[ "$(grep -cE '^ +SHH_COMPTES:' compose.yaml)" = 1 ] ||
	die "compose.yaml : une seule ligne SHH_COMPTES attendue"
comptes=$(sed -nE 's/^ +SHH_COMPTES: "([01])"$/\1/p' compose.yaml)
[ "$comptes" = 0 ] || [ "$comptes" = 1 ] || die "compose.yaml : SHH_COMPTES doit valoir \"0\" ou \"1\""
# Compte par e-mail retiré : une variable d'envoi d'e-mails restée dans deploy/.env désigne
# un secret qui traîne ou une installation ancienne ; elle fait refuser, jamais ignorer.
for v in $(compgen -v); do
	case $v in
	SHH_SMTP_* | SHH_MAIL_FROM) die "deploy/.env : $v ne sert plus (le compte se crée par passkey) : l'ôter (README §12)" ;;
	esac
done
# rp.id des passkeys = hôte de SHH_ORIGIN (https://SHH_DOMAIN) : définitif, le changer rend
# toutes les passkeys inutilisables (conception du compte par passkey).
if [ "$comptes" = 1 ] && [ "$SHH_DOMAIN" != shhgone.com ]; then
	die "compte activé : SHH_DOMAIN doit valoir shhgone.com (identifiant des passkeys, définitif ; README §12)"
fi
profils=
secrets=$SHH_DATA_ROOT/secrets

# Paiement (README §13 ; conception du paiement §10) : interrupteurs dans compose.yaml
# seulement. Un prestataire est configuré quand ses fichiers de secrets sont là ; ce script pose
# alors ses chemins (…_FILE) et démarre son relais, vers l'hôte de son API (production ou bac à
# sable). Tout ce qui vient de deploy/.env pour ces chemins et ces hôtes est remplacé ici.
# une_ligne <variable> : valeur "0" ou "1" de l'unique ligne de compose.yaml, écrite
# « <variable>: "${<variable>_SERVI:-0}" » (ou 1) : le chiffre est la valeur de production, commitée ;
# <variable>_SERVI est posée par ce script seulement (plus bas).
une_ligne() {
	[ "$(grep -cE "^ +$1:" compose.yaml)" = 1 ] || die "compose.yaml : une seule ligne $1 attendue"
	local v
	v=$(sed -nE "s/^ +$1: \"\\$\\{$1_SERVI:-([01])\\}\"\$/\\1/p" compose.yaml)
	[ "$v" = 0 ] || [ "$v" = 1 ] || die "compose.yaml : $1 doit valoir \"\${$1_SERVI:-0}\" ou \"\${$1_SERVI:-1}\""
	printf '%s' "$v"
}
paiement=$(une_ligne SHH_PAIEMENT)
essai=$(une_ligne SHH_PAIEMENT_ESSAI)
for v in SHH_PAIEMENT_SERVI SHH_PAIEMENT_ESSAI_SERVI; do
	[ -z "${!v+x}" ] || die "deploy/.env : $v est posée par deploy.sh seulement : l'ôter (préproduction : SHH_PREPROD_PAIEMENT, README §15)"
done
# Préproduction seulement (README §15) : SHH_PREPROD_PAIEMENT et SHH_PREPROD_PAIEMENT_ESSAI de
# deploy/.env remplacent les valeurs de compose.yaml, pour essayer les bacs à sable des
# prestataires derrière la barrière, sans commit. Hors préproduction, leur présence est refusée :
# à l'ouverture, rien ne reste ouvert en douce.
for v in SHH_PREPROD_PAIEMENT SHH_PREPROD_PAIEMENT_ESSAI; do
	[ -n "${!v+x}" ] || continue
	[ "$preprod" = 1 ] || die "deploy/.env : $v ne sert qu'en préproduction (SHH_PREPROD=1) : l'ôter (README §15)"
	[ "${!v}" = 0 ] || [ "${!v}" = 1 ] || die "deploy/.env : $v doit valoir 0 ou 1"
done
if [ "$preprod" = 1 ]; then
	paiement=${SHH_PREPROD_PAIEMENT:-$paiement}
	essai=${SHH_PREPROD_PAIEMENT_ESSAI:-$essai}
fi
# Verrou : en essai, n'importe quelle carte de test « paie » ; le site n'est donc
# jamais public dans ce mode.
if [ "$essai" = 1 ] && [ "$preprod" != 1 ]; then
	die "SHH_PAIEMENT_ESSAI=1 (bacs à sable : toute carte de test « paie ») exige la barrière de préproduction (SHH_PREPROD=1, README §13.4, §15)"
fi
SHH_PAIEMENT_SERVI=$paiement SHH_PAIEMENT_ESSAI_SERVI=$essai
export SHH_PAIEMENT_SERVI SHH_PAIEMENT_ESSAI_SERVI
SHH_HOTE_STRIPE=api.stripe.com
SHH_HOTE_PAYPAL=api-m.paypal.com
SHH_HOTE_NOWPAYMENTS=api.nowpayments.io
if [ "$essai" = 1 ]; then
	SHH_HOTE_PAYPAL=api-m.sandbox.paypal.com
	SHH_HOTE_NOWPAYMENTS=api-sandbox.nowpayments.io
fi
export SHH_HOTE_STRIPE SHH_HOTE_PAYPAL SHH_HOTE_NOWPAYMENTS
# present <fichier de secrets/> : là (lien symbolique compris : refusé ensuite par preflight).
present() { [ -e "$secrets/$1" ] || [ -L "$secrets/$1" ]; }
avec_stripe=0 avec_paypal=0 avec_nowpayments=0
if [ "$paiement" = 1 ]; then
	if present shh_stripe_cle || present shh_stripe_webhook; then avec_stripe=1; fi
	if present shh_paypal_secret; then avec_paypal=1; fi
	if present shh_nowpayments_cle || present shh_nowpayments_ipn; then avec_nowpayments=1; fi
fi
SHH_STRIPE_CLE_FILE="" SHH_STRIPE_WEBHOOK_FILE="" SHH_PAYPAL_SECRET_FILE="" SHH_NOWPAYMENTS_CLE_FILE="" SHH_NOWPAYMENTS_IPN_FILE=""
if [ "$avec_stripe" = 1 ]; then
	profils=${profils:+$profils,}paiement-stripe
	SHH_STRIPE_CLE_FILE=/run/secrets/shh_stripe_cle SHH_STRIPE_WEBHOOK_FILE=/run/secrets/shh_stripe_webhook
fi
if [ "$avec_paypal" = 1 ]; then
	profils=${profils:+$profils,}paiement-paypal
	SHH_PAYPAL_SECRET_FILE=/run/secrets/shh_paypal_secret
else
	# Sans son secret, PayPal n'est pas configuré : ses réglages de deploy/.env sont ignorés
	# (sinon le serveur refuserait de démarrer : « vont ensemble »).
	SHH_PAYPAL_CLIENT_ID="" SHH_PAYPAL_WEBHOOK_ID="" SHH_PAYPAL_PLANS=""
fi
if [ "$avec_nowpayments" = 1 ]; then
	profils=${profils:+$profils,}paiement-nowpayments
	SHH_NOWPAYMENTS_CLE_FILE=/run/secrets/shh_nowpayments_cle SHH_NOWPAYMENTS_IPN_FILE=/run/secrets/shh_nowpayments_ipn
fi
export SHH_STRIPE_CLE_FILE SHH_STRIPE_WEBHOOK_FILE SHH_PAYPAL_SECRET_FILE SHH_NOWPAYMENTS_CLE_FILE SHH_NOWPAYMENTS_IPN_FILE
export SHH_PAYPAL_CLIENT_ID SHH_PAYPAL_WEBHOOK_ID SHH_PAYPAL_PLANS

# Appels audio et vidéo (README §14) : ACTIVÉS par défaut, sans rien à installer. Le relais
# TURN est dans notre image (profil « appels ») ; son secret, partagé avec le serveur, est tiré
# ici à la première installation et gardé sur le volume chiffré. SHH_APPELS=0 dans deploy/.env :
# coupés (relais arrêté, aucune route ni bouton d'appel).
appels=${SHH_APPELS:-1}
[ "$appels" = 0 ] || [ "$appels" = 1 ] || die "SHH_APPELS doit valoir 0 ou 1 (deploy/.env)"
SHH_TURN_URLS="" SHH_TURN_SECRET_FILE=""
if [ "$appels" = 1 ]; then
	profils=${profils:+$profils,}appels
	SHH_TURN_URLS="turn:$SHH_DOMAIN:3478?transport=udp,turn:$SHH_DOMAIN:3478?transport=tcp"
	SHH_TURN_SECRET_FILE=/run/secrets/shh_turn_secret
fi
export SHH_TURN_URLS SHH_TURN_SECRET_FILE

# secrets_auto : tire les secrets que la machine peut tirer seule, s'ils manquent (fichiers-secrets.sh :
# jamais affichés, jamais écrasés, droits exacts ; une ligne « créé » ou « présent » chacun,
# sans la valeur). Appelé par preflight seulement : volume chiffré monté, secrets/ contrôlé,
# après les verrous.
secrets_auto() {
	local cle=$secrets/shh_comptes_cle
	if [ "$comptes" = 1 ]; then
		# Clé du serveur du compte (README §12.2) : tirée seulement s'il n'existe encore aucun
		# compte. Une base de comptes sans sa clé, c'est une restauration où la clé manque : en
		# tirer une autre perdrait l'unicité des pseudos sans rien dire. Refus : la remettre.
		if [ ! -e "$cle" ] && [ ! -L "$cle" ] && [ -e "$SHH_DATA_ROOT/data/comptes.db" ]; then
			die "$cle absente, mais $SHH_DATA_ROOT/data/comptes.db existe : remettre la clé depuis sa copie hors ligne (base64 -d, README §12.2), jamais en tirer une autre"
		fi
		tirer_secret "$cle" 65532:65532 400 octets32 "compte : clé du serveur" ||
			die "$cle absent ou mal réglé : fichier du compte 65532, droits 0400 (README §12)"
		if [ "$secret_cree" = 1 ]; then
			echo "  à faire une fois : une copie hors ligne de cette clé, dans votre propre fenêtre SSH (README §12.2)"
		fi
	fi
	# Clé maîtresse des salons persistants (conception du salon v3 §5.2, README « Salons
	# persistants ») : enveloppe, le temps d'un redémarrage, la clé de chaque conversation ouverte.
	# La perdre ne perd que les salons ouverts à ce moment-là (repli : les membres rentrent) : elle
	# se tire sans condition et ne se sauvegarde pas.
	tirer_secret "$secrets/shh_salons_cle" 65532:65532 400 octets32 "salons : clé maîtresse" ||
		die "$secrets/shh_salons_cle mal réglé : fichier du compte 65532, droits 0400 (README, salons persistants)"
	if [ "$appels" = 1 ]; then
		tirer_secret "$secrets/shh_turn_secret" 65532:65532 400 hex24 "appels : secret du relais" ||
			die "$secrets/shh_turn_secret mal réglé : fichier du compte 65532, droits 0400 (README §14)"
	fi
	if [ "$preprod" = 1 ]; then
		if [ -n "$SHH_PREPROD_JETON" ]; then
			# Déjà lu et contrôlé au chargement (lire_jeton_preprod : 0600 ou 0400).
			secret_cree=0
			echo "préproduction : jeton d'accès : présent"
		else
			tirer_secret "$PREPROD_JETON_FICHIER" 0:0 600 hex32 "préproduction : jeton d'accès" ||
				die "jeton de préproduction : $PREPROD_JETON_FICHIER mal réglé (README §15)"
			SHH_PREPROD_JETON=$(lire_jeton_preprod "$PREPROD_JETON_FICHIER" 0) ||
				die "SHH_PREPROD=1 : jeton de préproduction illisible ($PREPROD_JETON_FICHIER, README §15) : rien ne démarre sans lui"
			export SHH_PREPROD_JETON
		fi
		if [ "$secret_cree" = 1 ]; then
			echo "  lien d'accès : sudo deploy/lien-acces.sh, dans votre propre fenêtre SSH (README §15)"
		fi
	fi
}

# commande_reinstallation : la commande qui réinstalle la version en service (prise en compte
# d'un secret ou d'un réglage) ; vide si aucune version n'est installée.
commande_reinstallation() {
	case $cur in
	preprod:*) printf 'sudo deploy/preprod.sh %s' "${cur#preprod:}" ;;
	sha256:*) printf 'sudo deploy/deploy.sh %s' "$cur" ;;
	esac
}

# ports_turn : ports du relais ouverts dans le pare-feu de la machine. ufw actif : les règles
# manquantes sont ajoutées (et dites) ; autre pare-feu : un avertissement avec les ports.
ports_turn() {
	[ "$appels" = 1 ] || return 0
	local r
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
		for r in 3478/udp 3478/tcp 49160:49999/udp; do
			if ! ufw status 2>/dev/null | grep -qE "^${r}[[:space:]]+ALLOW"; then
				ufw allow "$r" >/dev/null && echo "appels : pare-feu ouvert pour $r (relais TURN)"
			fi
		done
	else
		echo "appels : si un pare-feu filtre la machine, ouvrir 3478 (UDP et TCP) et 49160 à 49999 (UDP) pour le relais (README §14)."
	fi
}

# dc <état> <arguments de docker compose…>
# « -f compose.yaml » explicite : sans lui, docker compose fusionne de lui-même un
# compose.override.yaml posé à côté et suit COMPOSE_FILE (deploy/.env), qui pourraient changer
# l'environnement du serveur sans rien dire. Un seul fichier fait foi : celui de la copie du
# dépôt.
# Même raison pour COMPOSE_PROFILES : posé ici, d'après compose.yaml seulement (une valeur venue
# de deploy/.env démarrerait un relais, compte ou paiement désactivé).
dc() {
	local image
	image=$(ref_image "$1") || die "état d'image illisible : « $1 »"
	shift
	COMPOSE_PROFILES="$profils" SHH_IMAGE="$image" docker compose -f compose.yaml "$@"
}
need_current() { etat_valide "$cur" || die "aucune version installée (deploy/.release absent)"; }

# Contrôles de la machine, bloquants (spec §15.1, §22).
preflight() {
	local opts src
	docker compose version >/dev/null 2>&1 || die "docker compose introuvable"
	mountpoint -q "$SHH_DATA_ROOT" ||
		die "$SHH_DATA_ROOT n'est pas un point de montage : volume chiffré non déverrouillé ?"
	opts=$(findmnt -no OPTIONS -T "$SHH_DATA_ROOT")
	[[ ",$opts," == *,noatime,* ]] ||
		die "$SHH_DATA_ROOT n'est pas monté avec noatime (options : $opts)"
	[ -d "$SHH_DATA_ROOT/data" ] && [ -d "$SHH_DATA_ROOT/caddy" ] ||
		die "$SHH_DATA_ROOT doit contenir data/ et caddy/ (compte 65532) : voir le README"
	# Caddy non root : son dossier lui appartient, et la machine laisse un
	# compte ordinaire écouter sur 80 et 443.
	[ "$(stat -c '%u:%g %a' "$SHH_DATA_ROOT/caddy")" = "65532:65532 700" ] ||
		die "$SHH_DATA_ROOT/caddy doit appartenir à 65532:65532, mode 0700 (Caddy non root) : chown -R 65532:65532 $SHH_DATA_ROOT/caddy && chmod 0700 $SHH_DATA_ROOT/caddy"
	port=$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)
	[ "$port" -le 80 ] ||
		die "net.ipv4.ip_unprivileged_port_start vaut $port : le poser à 80 (README §1, Caddy non root)"
	[ "$(wc -l </proc/swaps)" -le 1 ] ||
		die "mémoire d'échange active (swapon --show) : la désactiver (spec §22)"
	# Secrets du compte (README §12) : dossier exigé même compte désactivé (monté dans le
	# conteneur, jamais créé par Docker).
	[ -d "$secrets" ] && [ ! -L "$secrets" ] && [ "$(stat -c '%u:%g %a' "$secrets")" = "0:65532 750" ] ||
		die "$secrets absent ou mal réglé : install -d -o root -g 65532 -m 0750 $secrets (README §12)"
	secrets_auto
	if [ "$comptes" = 1 ]; then
		grep -qE '^ +SHH_SALONS: "1"$' compose.yaml || die "SHH_COMPTES=1 exige SHH_SALONS: \"1\" dans compose.yaml"
		[ -f "$secrets/shh_comptes_cle" ] && [ ! -L "$secrets/shh_comptes_cle" ] &&
			[ "$(stat -c '%u %a' "$secrets/shh_comptes_cle")" = "65532 400" ] ||
			die "$secrets/shh_comptes_cle absent ou mal réglé : fichier du compte 65532, droits 0400 (README §12)"
		[ "$(stat -c %s "$secrets/shh_comptes_cle")" = 32 ] ||
			die "$secrets/shh_comptes_cle : 32 octets attendus (README §12)"
	fi
	# Ancien mot de passe SMTP (compte par e-mail, retiré) : un secret qui ne sert plus ne reste pas.
	if [ -e "$secrets/shh_smtp_mdp" ] || [ -L "$secrets/shh_smtp_mdp" ]; then
		die "$secrets/shh_smtp_mdp ne sert plus (le compte se crée par passkey) : l'effacer (shred -u), puis révoquer ce mot de passe chez le fournisseur (README §12)"
	fi
	if [ "$paiement" = 1 ]; then
		[ -n "${SHH_TVA:-}" ] || die "paiement activé : SHH_TVA manque dans deploy/.env (franchise, france ou oss, README §13)"
		[ $((avec_stripe + avec_paypal + avec_nowpayments)) -ge 1 ] ||
			die "paiement activé : aucun prestataire (fichiers shh_stripe_…, shh_paypal_secret ou shh_nowpayments_… dans $secrets, README §13)"
		local attendus=()
		if [ "$avec_stripe" = 1 ]; then attendus+=(shh_stripe_cle shh_stripe_webhook); fi
		if [ "$avec_paypal" = 1 ]; then
			attendus+=(shh_paypal_secret)
			[ -n "${SHH_PAYPAL_CLIENT_ID:-}" ] && [ -n "${SHH_PAYPAL_WEBHOOK_ID:-}" ] && [ -n "${SHH_PAYPAL_PLANS:-}" ] ||
				die "PayPal : SHH_PAYPAL_CLIENT_ID, SHH_PAYPAL_WEBHOOK_ID et SHH_PAYPAL_PLANS manquent dans deploy/.env (README §13)"
		fi
		if [ "$avec_nowpayments" = 1 ]; then attendus+=(shh_nowpayments_cle shh_nowpayments_ipn); fi
		for f in "${attendus[@]}"; do
			[ -f "$secrets/$f" ] && [ ! -L "$secrets/$f" ] && [ "$(stat -c '%u %a' "$secrets/$f")" = "65532 400" ] ||
				die "$secrets/$f absent ou mal réglé : fichier du compte 65532, droits 0400 (README §13)"
		done
	fi
	# Journaux de la machine (README §1, journaux.sh) :
	# aucun syslog ni ancien journal sur le disque, journald en mémoire une heure au plus, sshd
	# silencieux, ufw sans journal, suivi des connexions ramené à 30 min, registres des connexions
	# (wtmp, btmp, lastlog, wtmpdb, lastlog2) vers /dev/null, minuteur de purge du journal. Bloquant.
	local sshd_t=absent pbs
	if command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ]; then
		sshd_t=$(PATH=$PATH:/usr/sbin sshd -T 2>/dev/null) || sshd_t=
	fi
	pbs=$(controle_journaux "" "$sshd_t") ||
		die "journaux de la machine (adresses IP), à corriger avant d'installer (README §1) :
$pbs"
	# Simple avertissement : la détection ne connaît que dm-crypt (LUKS), pas d'autre montage.
	src=$(findmnt -no SOURCE -T "$SHH_DATA_ROOT")
	if ! lsblk -s -n -o TYPE "$src" 2>/dev/null | grep -qx crypt; then
		printf 'AVERTISSEMENT : %s (%s) ne semble pas être sur un volume LUKS (spec §22).\n' "$SHH_DATA_ROOT" "$src" >&2
	fi
}

# manifeste_etat <état> <version> : manifeste du site de cet état. Release : celui de la Release
# signée, vérifié par deploy.sh (.provenance/<x.y.z>/) ; préproduction : celui que preprod.sh a
# calculé du /site de l'image qu'il a construite (.preprod/<commit>/, non signé).
manifeste_etat() {
	case $1 in
	sha256:*) version_valide "$2" && printf '%s' "$here/.provenance/$2/release.json" ;;
	preprod:*) printf '%s' "$here/.preprod/${1#preprod:}/release.json" ;;
	*) return 1 ;;
	esac
}

# site <arguments de curl…> : curl vers https://SHH_DOMAIN, résolu en 127.0.0.1, sans proxy. En
# préproduction, avec le jeton (en-tête X-Shh-Preprod, lu depuis un descripteur : jamais sur la
# ligne de commande, que ps montre).
site() {
	if [ "$preprod" = 1 ]; then
		curl -sS --noproxy '*' --max-time 10 --cacert "$ca" --resolve "$SHH_DOMAIN:443:127.0.0.1" \
			-H @<(printf 'X-Shh-Preprod: %s\n' "$SHH_PREPROD_JETON") "$@"
	else
		curl -sS --noproxy '*' --max-time 10 --cacert "$ca" --resolve "$SHH_DOMAIN:443:127.0.0.1" "$@"
	fi
}

# Contrôle de santé d'une version en service : check <état> <version>. Rend 0 si tout passe.
check() {
	local i code node image manifeste
	image=$(ref_image "$1") || return 1
	# 1. Le conteneur du serveur se dit en bonne santé (/healthz local, via shhcheck).
	dc "$1" up -d --wait --wait-timeout 120 >/dev/null 2>&1 || {
		echo "contrôle : conteneurs pas en bonne santé (attente : 120 s au plus)" >&2
		return 1
	}
	# 2. De bout en bout à travers Caddy, sans dépendre du DNS : /api ne répond 200 que si
	#    Caddy pose X-Shh-Client-IP et que le serveur lui fait confiance. Jusqu'à 2 min :
	#    à la première installation, Caddy doit d'abord obtenir son certificat.
	code=000
	for i in $(seq 1 40); do
		code=$(site -o /dev/null -w '%{http_code}' "https://$SHH_DOMAIN/api/captcha" 2>/dev/null) || true
		[ "$code" = 200 ] && break
		sleep 3
	done
	[ "$code" = 200 ] || {
		echo "contrôle : https://$SHH_DOMAIN/api/captcha répond $code après $i essais (attendu : 200)" >&2
		return 1
	}
	# 3. La page d'accueil arrive avec les en-têtes du serveur Go.
	site -o /dev/null -D - "https://$SHH_DOMAIN/" | grep -qi '^strict-transport-security:' || {
		echo "contrôle : page d'accueil sans Strict-Transport-Security" >&2
		return 1
	}
	# 3 bis. Préproduction : la barrière est en place. Sans le jeton, l'accueil et l'API ne
	#    rendent que la page de maintenance (503, marqueur) : jamais d'ouverture par erreur.
	if [ "$preprod" = 1 ]; then
		for i in / /api/captcha; do
			curl -sS --noproxy '*' --max-time 10 --cacert "$ca" --resolve "$SHH_DOMAIN:443:127.0.0.1" \
				-o /dev/null -D - "https://$SHH_DOMAIN$i" | tr -d '\r' | grep -qix 'x-shhdrop-etat: maintenance' || {
				echo "contrôle : préproduction, mais https://$SHH_DOMAIN$i ne rend pas la page de maintenance au public" >&2
				return 1
			}
		done
	fi
	# 4. Test bloquant de la spec §30 : échange de clés hybride X25519MLKEM768.
	docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
		--log-driver none -v "$ca:/ca.pem:ro" -e SSL_CERT_FILE=/ca.pem --entrypoint /shhcheck \
		"$image" tls 127.0.0.1:443 "$SHH_DOMAIN" || {
		echo "contrôle : pas d'échange de clés X25519MLKEM768 en TLS 1.3" >&2
		return 1
	}
	# 5. Appels : le relais TURN répond sur la machine (requête STUN « Binding » en UDP, sans
	#    identifiants). Simple avertissement : sans lui, les appels échouent, le reste marche.
	if [ "$appels" = 1 ]; then
		docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
			--log-driver none --entrypoint /shhcheck "$image" stun 127.0.0.1:3478 ||
			echo "AVERTISSEMENT : le relais des appels ne répond pas sur 127.0.0.1:3478 (README §14) : les appels ne marcheront pas." >&2
	fi
	# 6. Le site servi à travers Caddy est celui du manifeste (spec §28.7) : chaque fichier, ses
	#    variantes compressées et le repli monopage (web/scripts/verify-site.mjs de la copie du
	#    dépôt, lancé par le Node épinglé du Dockerfile). Release : manifeste signé ;
	#    préproduction : manifeste du /site de l'image construite.
	if ! manifeste=$(manifeste_etat "$1" "$2") || [ ! -f "$manifeste" ]; then
		echo "contrôle : aucun manifeste vérifié pour « $1 » (version « $2 » ; installée avant la vérification de provenance ?)" >&2
		return 1
	fi
	node=$(image_node Dockerfile) || return 1
	verifier_site_servi docker "$node" "$here/../web/scripts/verify-site.mjs" "$manifeste" "$SHH_DOMAIN" "$ca" || {
		echo "contrôle : le site servi par https://$SHH_DOMAIN n'est pas celui du manifeste $manifeste" >&2
		return 1
	}
}

# verrous <commit> <suite|retour> : V1 et V2 (deploy/verrous.sh, README §3.5), puis la copie du
# dépôt au bon commit. suite : nouveau commit ; si la copie n'y est pas encore, elle y est
# avancée, puis le script de ce commit (vérifié) est relancé avec les mêmes arguments et refait
# tout. retour : retour arrière ou réinstallation ; la copie doit être sur le commit installé
# (ou sur un descendant qui passe V1 et V2).
verrous() {
	local c=$1 mode=$2 installe
	if ! command -v git >/dev/null 2>&1 || ! command -v ssh-keygen >/dev/null 2>&1; then
		die "git et ssh-keygen exigés par les verrous (paquets git et openssh-client, README §3.5)"
	fi
	controle_signataires "$VERROUS_SIGNATAIRES" 0 || die "installation refusée : signataires autorisés (V1, README §3.5)"
	installe=$(lire_commit_installe "$VERROUS_COMMIT_INSTALLE" 0) || die "installation refusée : commit installé illisible (V2, README §3.5)"
	verifier_commit "$depot" "$VERROUS_SIGNATAIRES" "$installe" "$c" "$mode" ||
		die "installation refusée : commit $c non vérifié (README §3.5)"
	if [ "$mode" = retour ]; then
		copie_verifiee "$depot" "$VERROUS_SIGNATAIRES" "$installe" ||
			die "refusé : la copie du dépôt doit être sur le commit installé $installe (ou un descendant vérifié), sans modification (README §3.5)"
		return 0
	fi
	if ! copie_au_commit "$depot" "$VERROUS_SIGNATAIRES" "$c" 2>/dev/null; then
		avancer_copie "$depot" "$VERROUS_SIGNATAIRES" "$installe" "$c" ||
			die "installation refusée : copie du dépôt à remettre sur le commit installé (README §3.5)"
		echo "copie du dépôt avancée au commit $c (signé, vérifié) : relance du $relance de ce commit"
		# Toute la commande « case » en cours a été lue avant de s'exécuter : rien de plus n'est
		# lu de l'ancien fichier. Le verrou est rendu, le nouveau script le reprend.
		exec 9>&-
		# Sans les variables que ce fichier pose lui-même (sinon le script relancé les croirait
		# venues de deploy/.env et refuserait, test-verrous.sh).
		exec env -u SHH_PREPROD_JETON -u SHH_PAIEMENT_SERVI -u SHH_PAIEMENT_ESSAI_SERVI "$here/$relance" "${args[@]}"
	fi
	resume_changements "$depot" "$VERROUS_SIGNATAIRES" "$installe" "$c"
}

# mettre_en_service <état> <version> <commit> <suite|retour> : démarre l'image de cet état, la
# contrôle (check), puis note l'état ; si le contrôle échoue, remet la version en service avant.
# Appelé seulement après les verrous et les vérifications propres à chaque chemin (provenance et
# V3 pour deploy.sh ; construction depuis le commit vérifié pour preprod.sh).
mettre_en_service() {
	local new=$1 new_v=$2 new_c=$3 mode=$4
	echo "installation de $new"
	dc "$new" up -d --remove-orphans || true # l'échec éventuel est constaté par check
	# Relais des prestataires absents ou paiement désactivé : ceux d'une activation précédente ne
	# doivent pas rester (un service hors profil n'est pas un « orphelin » pour --remove-orphans ;
	# l'ancien relais SMTP, retiré de compose.yaml, l'est).
	if [ "$avec_stripe" = 0 ]; then dc "$new" rm -sf relais-stripe >/dev/null 2>&1 || true; fi
	if [ "$avec_paypal" = 0 ]; then dc "$new" rm -sf relais-paypal >/dev/null 2>&1 || true; fi
	if [ "$avec_nowpayments" = 0 ]; then dc "$new" rm -sf relais-nowpayments >/dev/null 2>&1 || true; fi
	if [ "$appels" = 0 ]; then dc "$new" rm -sf relais-turn >/dev/null 2>&1 || true; fi
	if check "$new" "$new_v"; then
		if [ "$new" != "$cur" ]; then
			if etat_valide "$cur"; then
				printf '%s\n' "$cur" >.release.prev
				printf '%s\n' "$cur_v" >.release.prev.version
				if commit_valide "$cur_c"; then printf '%s\n' "$cur_c" >.release.prev.commit; else rm -f .release.prev.commit; fi
			fi
			printf '%s\n' "$new" >.release.tmp && mv .release.tmp .release
		fi
		printf '%s\n' "$new_v" >.release.version.tmp && mv .release.version.tmp .release.version
		printf '%s\n' "$new_c" >.release.commit.tmp && mv .release.commit.tmp .release.commit
		# V2 : le commit installé n'avance qu'après une installation réussie, et jamais en arrière
		# (un retour arrière ou une réinstallation le laisse tel quel).
		if [ "$mode" = suite ]; then
			ecrire_commit_installe "$VERROUS_COMMIT_INSTALLE" "$new_c" ||
				die "en service, mais $VERROUS_COMMIT_INSTALLE n'a pas pu être écrit : le corriger avant la prochaine installation (README §3.5)"
		fi
		if [ "$new_v" = preprod ]; then
			echo "en service : $new (préproduction, commit $new_c)"
		else
			echo "en service : $new (web-v$new_v, commit $new_c)"
		fi
		return 0
	fi

	if etat_valide "$cur" && [ "$cur" != "$new" ]; then
		echo "ÉCHEC du contrôle : retour à $cur" >&2
		dc "$cur" up -d --remove-orphans || true
		if check "$cur" "$cur_v"; then
			echo "retour arrière fait : $cur est en service" >&2
		else
			echo "ATTENTION : le retour arrière échoue aussi au contrôle. Site à vérifier à la main." >&2
		fi
	else
		echo "ÉCHEC du contrôle, et aucune autre version à remettre : pile arrêtée." >&2
		dc "$new" down || true
	fi
	exit 1
}

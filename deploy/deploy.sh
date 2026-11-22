#!/usr/bin/env bash
# Mise en ligne de Shhdrop (spec §15.3, D3) : installe une version précise, désignée par
# l'empreinte de son image, contrôle la santé, et revient à la version précédente si le
# contrôle échoue. Lancé à la main, sur le serveur, depuis une copie du dépôt.
#
#   deploy/deploy.sh sha256:<64 chiffres hexadécimaux>   installe cette version
#   deploy/deploy.sh rollback                             réinstalle la version précédente
#   deploy/deploy.sh status                               versions et état des conteneurs
#   deploy/deploy.sh admin freeze|unfreeze|destroy -|wipe --yes
#                                                         commandes de la spec §15.3
#   deploy/deploy.sh diagnose                             serveur au premier plan, pour lire
#                                                         un refus de démarrer (rien n'est écrit)
#
# Réglages : deploy/.env (modèle : deploy/env.example). Aucun secret qui ouvre quoi que ce soit :
# le tableau de bord n'y a que l'EMPREINTE de son jeton (SHH_ADMIN_TOKEN_SHA256, README §4), le
# jeton reste chez l'exploitant ; la clé du serveur et le mot de passe SMTP du compte sont des
# fichiers de <SHH_DATA_ROOT>/secrets (README §12), jamais des variables. Tout deploy/.env est
# exporté aux commandes de ce script (set -a). Compte activé (SHH_COMPTES: "1" dans
# compose.yaml) : relais SMTP démarré, secrets vérifiés avant l'installation, fournisseur
# d'envoi contrôlé après (avertissement seulement). Paiement activé (SHH_PAIEMENT: "1") : un
# relais par prestataire dont les secrets sont dans <SHH_DATA_ROOT>/secrets (README §13).
# État : deploy/.release (empreinte en service) et deploy/.release.prev (la précédente).
#
# Limites, dites aussi dans le README :
#   - le retour arrière ne concerne que l'image ; Caddyfile et compose.yaml viennent de la
#     copie du dépôt (pour les ramener en arrière : git, puis relancer ce script) ;
#   - la vérification de provenance de la spec §28.7 n'est pas faite : web/scripts/
#     release-manifest.mjs et verify-site.mjs existent, mais ni release.yml ni signature cosign
#     (aucun release.json signé à vérifier) ; ce script ne la fait pas, et le rappelle à chaque
#     installation (README, §3 et §9).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here"
# shellcheck source=deploy/journaux.sh
. ./journaux.sh

die() {
	printf 'erreur: %s\n' "$1" >&2
	exit "${2:-1}"
}
usage() {
	printf 'usage: deploy.sh sha256:<empreinte> | rollback | status | admin <commande> | health | diagnose\n' >&2
	exit 2
}

[ $# -ge 1 ] || usage
[ -f .env ] || die "deploy/.env absent (copier deploy/env.example et l'adapter)"
set -a
# shellcheck disable=SC1091 # fichier propre à chaque serveur
. ./.env
set +a
: "${SHH_DOMAIN:?SHH_DOMAIN manquant dans deploy/.env}"
: "${SHH_DATA_ROOT:?SHH_DATA_ROOT manquant dans deploy/.env}"
: "${SHH_IMAGE_REPO:?SHH_IMAGE_REPO manquant dans deploy/.env}"
# Autorités pour le contrôle TLS. Changé seulement par les essais (autorité interne de Caddy).
ca=${SHH_CHECK_CA:-/etc/ssl/certs/ca-certificates.crt}

SHH_CADDYFILE_SHA256=$(sha256sum Caddyfile | cut -d' ' -f1)
export SHH_CADDYFILE_SHA256

cur=$(cat .release 2>/dev/null || true)
prev=$(cat .release.prev 2>/dev/null || true)
valid() { [[ $1 =~ ^sha256:[0-9a-f]{64}$ ]]; }

# Compte par e-mail (README §12) : activé seulement par compose.yaml (SHH_COMPTES: "1", fichier
# relu et commité), jamais par deploy/.env. Activé, le relais SMTP (profil « comptes ») est
# démarré ; désactivé, il est arrêté s'il tournait encore.
[ "$(grep -cE '^ +SHH_COMPTES:' compose.yaml)" = 1 ] ||
	die "compose.yaml : une seule ligne SHH_COMPTES attendue"
comptes=$(sed -nE 's/^ +SHH_COMPTES: "([01])"$/\1/p' compose.yaml)
[ "$comptes" = 0 ] || [ "$comptes" = 1 ] || die "compose.yaml : SHH_COMPTES doit valoir \"0\" ou \"1\""
profils=
if [ "$comptes" = 1 ]; then profils=comptes; fi
secrets=$SHH_DATA_ROOT/secrets

# Paiement (README §13 ; conception du paiement §10, S1) : interrupteurs dans compose.yaml
# seulement. Un prestataire est configuré quand ses fichiers de secrets sont là ; ce script pose
# alors ses chemins (…_FILE) et démarre son relais, vers l'hôte de son API (production ou bac à
# sable). Tout ce qui vient de deploy/.env pour ces chemins et ces hôtes est remplacé ici.
une_ligne() { # une_ligne <variable> : valeur "0" ou "1" de l'unique ligne de compose.yaml
	[ "$(grep -cE "^ +$1:" compose.yaml)" = 1 ] || die "compose.yaml : une seule ligne $1 attendue"
	local v
	v=$(sed -nE "s/^ +$1: \"([01])\"\$/\\1/p" compose.yaml)
	[ "$v" = 0 ] || [ "$v" = 1 ] || die "compose.yaml : $1 doit valoir \"0\" ou \"1\""
	printf '%s' "$v"
}
paiement=$(une_ligne SHH_PAIEMENT)
essai=$(une_ligne SHH_PAIEMENT_ESSAI)
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

# secret_turn : crée le secret du relais s'il manque (48 caractères hexadécimaux, compte 65532,
# 0400), sans jamais l'afficher ; un secret présent est gardé tel quel.
secret_turn() {
	local f=$secrets/shh_turn_secret
	[ "$appels" = 1 ] || return 0
	if [ ! -e "$f" ] && [ ! -L "$f" ]; then
		(umask 077 && od -An -N24 -tx1 /dev/urandom | tr -d ' \n' >"$f.tmp" && printf '\n' >>"$f.tmp")
		chown 65532:65532 "$f.tmp" && chmod 0400 "$f.tmp" && mv "$f.tmp" "$f"
		echo "appels : secret du relais créé ($f)"
	fi
	[ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c '%u %a' "$f")" = "65532 400" ] ||
		die "$f mal réglé : fichier du compte 65532, droits 0400 (README §14)"
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

# dc <empreinte> <arguments de docker compose…>
# « -f compose.yaml » explicite : sans lui, docker compose fusionne de lui-même un
# compose.override.yaml posé à côté et suit COMPOSE_FILE (deploy/.env), qui pourraient changer
# l'environnement du serveur sans rien dire (audit adverse du 13 novembre, stockage, H1). Un
# seul fichier fait foi : celui de la copie du dépôt.
# Même raison pour COMPOSE_PROFILES : posé ici, d'après compose.yaml seulement (une valeur venue
# de deploy/.env démarrerait un relais, compte ou paiement désactivé).
dc() {
	local digest=$1
	shift
	COMPOSE_PROFILES="$profils" SHH_IMAGE="$SHH_IMAGE_REPO@$digest" docker compose -f compose.yaml "$@"
}
need_current() { valid "$cur" || die "aucune version installée (deploy/.release absent)"; }

# Contrôles de la machine, bloquants (spec §15.1, §22 ; audits de confidentialité P5, P6).
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
	# Caddy non root (D9, 22 novembre) : son dossier lui appartient, et la machine laisse un
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
	if [ "$comptes" = 1 ]; then
		grep -qE '^ +SHH_SALONS: "1"$' compose.yaml || die "SHH_COMPTES=1 exige SHH_SALONS: \"1\" dans compose.yaml"
		[ -n "${SHH_SMTP_HOST:-}" ] && [ -n "${SHH_SMTP_USER:-}" ] && [ -n "${SHH_MAIL_FROM:-}" ] ||
			die "compte activé : SHH_SMTP_HOST, SHH_SMTP_USER et SHH_MAIL_FROM manquent dans deploy/.env (README §12)"
		local f
		for f in shh_comptes_cle shh_smtp_mdp; do
			[ -f "$secrets/$f" ] && [ ! -L "$secrets/$f" ] && [ "$(stat -c '%u %a' "$secrets/$f")" = "65532 400" ] ||
				die "$secrets/$f absent ou mal réglé : fichier du compte 65532, droits 0400 (README §12)"
		done
		[ "$(stat -c %s "$secrets/shh_comptes_cle")" = 32 ] ||
			die "$secrets/shh_comptes_cle : 32 octets attendus (README §12)"
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
	# Journaux de la machine (README §1 ; inventaire des adresses IP du 22 novembre, journaux.sh) :
	# aucun syslog ni ancien journal sur le disque, journald en mémoire une heure au plus, sshd
	# silencieux, ufw sans journal, suivi des connexions ramené à 30 min. Bloquant.
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

# Contrôle de santé d'une version en service. Rend 0 si tout passe.
check() {
	local i code
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
		code=$(curl -sS --noproxy '*' --max-time 10 --cacert "$ca" --resolve "$SHH_DOMAIN:443:127.0.0.1" \
			-o /dev/null -w '%{http_code}' "https://$SHH_DOMAIN/api/captcha" 2>/dev/null) || true
		[ "$code" = 200 ] && break
		sleep 3
	done
	[ "$code" = 200 ] || {
		echo "contrôle : https://$SHH_DOMAIN/api/captcha répond $code après $i essais (attendu : 200)" >&2
		return 1
	}
	# 3. La page d'accueil arrive avec les en-têtes du serveur Go.
	curl -sS --noproxy '*' --max-time 10 --cacert "$ca" --resolve "$SHH_DOMAIN:443:127.0.0.1" \
		-o /dev/null -D - "https://$SHH_DOMAIN/" | grep -qi '^strict-transport-security:' || {
		echo "contrôle : page d'accueil sans Strict-Transport-Security" >&2
		return 1
	}
	# 4. Test bloquant de la spec §30 : échange de clés hybride X25519MLKEM768.
	docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
		--log-driver none -v "$ca:/ca.pem:ro" -e SSL_CERT_FILE=/ca.pem --entrypoint /shhcheck \
		"$SHH_IMAGE_REPO@$1" tls 127.0.0.1:443 "$SHH_DOMAIN" || {
		echo "contrôle : pas d'échange de clés X25519MLKEM768 en TLS 1.3" >&2
		return 1
	}
	# 5. Appels : le relais TURN répond sur la machine (requête STUN « Binding » en UDP, sans
	#    identifiants). Simple avertissement : sans lui, les appels échouent, le reste marche.
	if [ "$appels" = 1 ]; then
		docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
			--log-driver none --entrypoint /shhcheck "$SHH_IMAGE_REPO@$1" stun 127.0.0.1:3478 ||
			echo "AVERTISSEMENT : le relais des appels ne répond pas sur 127.0.0.1:3478 (README §14) : les appels ne marcheront pas." >&2
	fi
	# 6. Compte activé : le fournisseur d'envoi répond, à travers le relais, en TLS vérifié pour
	#    SHH_SMTP_HOST (accueil SMTP puis QUIT ; ni connexion au compte, ni e-mail). Simple
	#    avertissement : une panne du fournisseur ne doit pas faire revenir à l'image d'avant,
	#    mais sans lui, aucun code n'arrive et rien d'autre ne le dit (aucun journal).
	if [ "$comptes" = 1 ]; then
		dc "$1" exec -T shhdrop /shhcheck smtp "$SHH_SMTP_HOST:465" ||
			echo "AVERTISSEMENT : $SHH_SMTP_HOST:465 injoignable depuis le serveur (relais SMTP, README §12) : aucun e-mail ne partira." >&2
	fi
}

install_version() {
	local new=$1
	valid "$new" || usage
	# Une seule installation à la fois (status et admin restent possibles pendant ce temps).
	exec 9>.deploy.lock
	flock -n 9 || die "une autre installation est en cours"
	preflight
	secret_turn
	ports_turn
	echo "RAPPEL : vérification de provenance (spec §28.7) NON faite : aucun release.json signé (cosign) à vérifier ; verify-site.mjs se lance à la main, depuis un autre poste (README, §3)."
	# Image absente : téléchargée par empreinte (le contenu est donc vérifié par Docker).
	docker image inspect "$SHH_IMAGE_REPO@$new" >/dev/null 2>&1 || docker pull "$SHH_IMAGE_REPO@$new"

	echo "installation de $new"
	dc "$new" up -d --remove-orphans || true # l'échec éventuel est constaté par check
	# Compte désactivé : le relais SMTP d'une activation précédente ne doit pas rester (un
	# service hors profil n'est pas un « orphelin » pour --remove-orphans).
	if [ "$comptes" = 0 ]; then dc "$new" rm -sf relais-smtp >/dev/null 2>&1 || true; fi
	# Même chose pour les relais des prestataires absents ou paiement désactivé.
	if [ "$avec_stripe" = 0 ]; then dc "$new" rm -sf relais-stripe >/dev/null 2>&1 || true; fi
	if [ "$avec_paypal" = 0 ]; then dc "$new" rm -sf relais-paypal >/dev/null 2>&1 || true; fi
	if [ "$avec_nowpayments" = 0 ]; then dc "$new" rm -sf relais-nowpayments >/dev/null 2>&1 || true; fi
	if [ "$appels" = 0 ]; then dc "$new" rm -sf relais-turn >/dev/null 2>&1 || true; fi
	if check "$new"; then
		if [ "$new" != "$cur" ]; then
			if valid "$cur"; then printf '%s\n' "$cur" >.release.prev; fi
			printf '%s\n' "$new" >.release.tmp && mv .release.tmp .release
		fi
		echo "en service : $new"
		return 0
	fi

	if valid "$cur" && [ "$cur" != "$new" ]; then
		echo "ÉCHEC du contrôle : retour à $cur" >&2
		dc "$cur" up -d --remove-orphans || true
		if check "$cur"; then
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

case $1 in
sha256:*)
	[ $# -eq 1 ] || usage
	install_version "$1"
	;;
rollback)
	[ $# -eq 1 ] || usage
	valid "$prev" || die "aucune version précédente (deploy/.release.prev absent)"
	install_version "$prev"
	;;
status)
	[ $# -eq 1 ] || usage
	echo "en service : ${cur:-aucune}"
	echo "précédente : ${prev:-aucune}"
	if valid "$cur"; then dc "$cur" ps -a; fi
	;;
admin)
	# Dans le conteneur en marche : même dossier de données, même compte. L'entrée standard
	# est transmise (destroy - lit le lien dessus). Le code de sortie est celui de la commande.
	[ $# -ge 2 ] || usage
	need_current
	shift
	dc "$cur" exec -T shhdrop /shhdrop admin "$@"
	;;
health)
	# Santé du serveur en marche (JSON de /healthz : ok, reports_alert ; aucune donnée
	# d'utilisateur). Lue par alerte.sh (README §4).
	[ $# -eq 1 ] || usage
	need_current
	dc "$cur" exec -T shhdrop /shhcheck health
	;;
diagnose)
	# Le pilote de journal est « none » : un refus de démarrer ne se lit nulle part. Ici le
	# serveur est arrêté puis lancé au premier plan ; Ctrl-C pour finir, puis réinstaller.
	[ $# -eq 1 ] || usage
	need_current
	dc "$cur" stop shhdrop
	echo "serveur au premier plan (Ctrl-C pour arrêter), puis : deploy/deploy.sh $cur"
	dc "$cur" run --rm --no-deps shhdrop serve
	;;
*) usage ;;
esac

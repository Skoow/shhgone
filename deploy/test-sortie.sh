#!/usr/bin/env bash
# Test des sorties (conception du paiement §4) : le serveur Go n'a aucune route vers Internet,
# même compte ou paiement activé ; le compte par passkey n'a aucune sortie (aucun relais SMTP) ;
# les seules sorties sont les relais des prestataires de paiement, qui ne joignent chacun que
# l'hôte de son API, sur 443.
#
# 1. Statique (docker compose config, sans démon) : sur la vraie compose.yaml,
#    - SHH_COMPTES vaut "1", sans aucune variable SHH_SMTP_* ni
#      SHH_MAIL_FROM ; aucun relais SMTP ; sans profil, ni relais ni réseau « sortie » ; aucun
#      service ne publie de port ;
#    - le serveur n'est que sur le réseau « interne » (internal: true) ;
#    - secrets : /run/secrets en lecture seule, hors de /data, chemins seulement dans
#      l'environnement (aucune valeur de clé ni de mot de passe) ;
#    - paiement : SHH_PAIEMENT et SHH_PAIEMENT_ESSAI valent "0" ou "1" ; un relais par
#      prestataire (profils « paiement-stripe », « -paypal », « -nowpayments »), 172.30.53.4 à .6,
#      cible api.stripe.com, api-m.paypal.com, api.nowpayments.io sur 443 ; leurs noms désignent
#      les relais dans /etc/hosts du serveur ; compte 65532, lecture seule, sans capacité,
#      no-new-privileges, sans journal.
# 2. Avec un démon Docker et l'image construite (SHH_IMAGE, binaires de cet arbre) : pile de
#    test (projet à part, mêmes réseaux que la production : à ne PAS lancer sur la machine de
#    production), faux prestataires en TLS sur la machine (certificat pour les vrais noms) ;
#    - depuis un conteneur du service shhdrop (shhcheck joindre) : chaque API joignable à
#      travers son relais, TLS vérifié ; une adresse d'Internet (TCP 443, 465, 25), un nom à
#      résoudre et le faux prestataire joint directement : injoignables ; relais arrêté :
#      injoignable.
#
# Usage : deploy/test-sortie.sh            (statique, puis dynamique si un démon répond)
#         deploy/test-sortie.sh --statique (statique seulement)
#   SHH_IMAGE=…  image construite depuis cet arbre (ex. shhdrop:ci) ; partie dynamique
#   PORT_FAUX=…  port du faux prestataire sur la machine (défaut : 18465)
# Outils : docker (Compose 2.24 ou plus), jq ; partie dynamique : openssl, python3.
# Code de sortie : 0 tout passe ; 1 un contrôle échoue ; 2 erreur d'usage ; 3 partie
# dynamique non faite (aucun démon Docker) : rien n'est alors prouvé sur le réseau réel.
set -euo pipefail
export LC_ALL=C

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
statique=0
[ "${1:-}" = --statique ] && statique=1

fails=0
ok() { printf 'ok    %s\n' "$1"; }
ko() {
	printf 'ÉCHEC %s\n' "$1"
	fails=$((fails + 1))
}
check() {
	local d=$1
	shift
	if "$@" >/dev/null 2>&1; then ok "$d"; else ko "$d"; fi
}
refuse() {
	local d=$1
	shift
	if "$@" >/dev/null 2>&1; then ko "$d"; else ok "$d"; fi
}
die() {
	printf 'erreur: %s\n' "$1" >&2
	exit 2
}
command -v docker >/dev/null || die "docker introuvable"
command -v jq >/dev/null || die "jq introuvable"

work=$(mktemp -d "${TMPDIR:-/tmp}/shh-sortie.XXXXXX")
proj=shhsortie$$
pid_faux=
dyn=0
cleanup() {
	if [ "$dyn" = 1 ]; then
		COMPOSE_PROFILES=$tous "${dcp[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
	fi
	if [ -n "$pid_faux" ]; then kill "$pid_faux" 2>/dev/null || true; fi
	rm -rf -- "$work"
}
trap cleanup EXIT

# --- 1. Statique ------------------------------------------------------------------------------
cfg() { # cfg <profils> : configuration résolue, en JSON
	env -i PATH="$PATH" HOME="${HOME:-/root}" SHH_IMAGE="${SHH_IMAGE:-registre.test/shhdrop@sha256:$(printf '0%.0s' {1..64})}" \
		SHH_DOMAIN=shhdrop.test SHH_DATA_ROOT="$work/racine" COMPOSE_PROFILES="$1" \
		docker compose -p "$proj" -f "$here/compose.yaml" config --format json
}
cfg "" >"$work/sans.json" || die "docker compose config (sans profil) échoue"
tous=paiement-stripe,paiement-paypal,paiement-nowpayments
cfg "$tous" >"$work/tous.json" || die "docker compose config (tous les profils) échoue"
j() { jq -e "$1" "$2" >/dev/null; }
cfg appels >"$work/appels.json" || die "docker compose config (profil appels) échoue"
S=$work/sans.json T=$work/tous.json P=$work/appels.json

check "SHH_COMPTES vaut \"1\" dans compose.yaml" j '.services.shhdrop.environment.SHH_COMPTES == "1"' "$S"
check "compte par passkey : aucune variable d'e-mail (SHH_SMTP_*, SHH_MAIL_FROM)" \
	j '[.services[] | .environment // {} | keys[] | select(startswith("SHH_SMTP_") or . == "SHH_MAIL_FROM")] == []' "$T"
check "aucun relais SMTP, quel que soit le profil" j '[.services | keys[] | select(. == "relais-smtp")] == []' "$T"
check "sans profil : ni relais ni réseau « sortie »" j '(.services | keys) == ["caddy","shhdrop"] and (.networks | keys) == ["interne"]' "$S"
check "aucun port publié" j '[.services[] | .ports // [] | length] | add == 0' "$S"
check "serveur : réseau interne seul, internal: true" \
	j '(.services.shhdrop.networks | keys) == ["interne"] and .networks.interne.internal == true' "$S"
check "serveur : chaque nom d'API de paiement désigne son relais, rien d'autre" \
	j '(.services.shhdrop.extra_hosts | map(sub("=";":")) | sort) == (["api.stripe.com:172.30.53.4","api-m.paypal.com:172.30.53.5","api.nowpayments.io:172.30.53.6"] | sort)' "$S"
check "secrets : /run/secrets en lecture seule, hors de /data, jamais créé par Docker" \
	j '[.services.shhdrop.volumes[] | select(.target == "/run/secrets")] | length == 1 and .[0].read_only == true and .[0].bind.create_host_path == false and (.[0].source | endswith("/secrets"))' "$S"
check "secrets : chemins seulement (…_FILE sous /run/secrets)" \
	j '.services.shhdrop.environment.SHH_COMPTES_CLE_FILE == "/run/secrets/shh_comptes_cle"' "$S"
# Exceptions : …_SHA256 (empreinte d'un jeton, jamais le jeton : tableau de bord, README §4) ;
# SHH_PREPROD_JETON (jeton de la barrière de préproduction, donné à Caddy seul par deploy.sh depuis
# /etc/shhdrop/preprod-jeton, vide hors préproduction ; risque faible assumé, README §15).
check "aucune variable de secret en valeur (mot de passe, clé, jeton) : des chemins …_FILE seulement" \
	j '[.services[] | .environment // {} | keys[] | select(test("PASSWORD|MDP|SECRET|TOKEN|CLE|KEY|JETON") and (endswith("_FILE") or endswith("_SHA256") or . == "SHH_PREPROD_JETON" | not))] == []' "$S"

# Appels (README §14) : relais TURN de notre image, profil « appels », réseau de la machine
# (adresse publique) mais sans aucun accès au réseau interne du serveur ni au disque.
check "profil « appels » : le seul relais TURN" j '(.services | keys) == ["caddy","relais-turn","shhdrop"]' "$P"
check "relais TURN : même image, /shhcheck turn, réseau de la machine" \
	j '.services["relais-turn"].image == .services.shhdrop.image and (.services["relais-turn"] | .entrypoint == ["/shhcheck"] and .command == ["turn"] and .network_mode == "host" and .profiles == ["appels"])' "$P"
check "relais TURN : compte 65532, lecture seule, sans capacité, no-new-privileges, sans journal" \
	j '.services["relais-turn"] | .user == "65532:65532" and .read_only == true and .cap_drop == ["ALL"] and .security_opt == ["no-new-privileges:true"] and .logging.driver == "none" and .cap_add == null and .privileged != true' "$P"
check "relais TURN : seul montage, les secrets en lecture seule (ni données, ni socket Docker)" \
	j '[.services["relais-turn"].volumes[] | .target] == ["/run/secrets"] and (.services["relais-turn"].volumes[0].read_only == true)' "$P"
check "relais TURN : secret par fichier seulement" \
	j '.services["relais-turn"].environment.SHH_TURN_SECRET_FILE == "/run/secrets/shh_turn_secret" and ([.services["relais-turn"].environment | keys[] | select(test("SECRET") and (endswith("_FILE") | not))] == [])' "$P"

# Paiement : interrupteurs dans compose.yaml seulement, un relais par prestataire.
check "SHH_PAIEMENT et SHH_PAIEMENT_ESSAI valent \"0\" ou \"1\" (fichier commité)" \
	j '.services.shhdrop.environment | (.SHH_PAIEMENT == "0" or .SHH_PAIEMENT == "1") and (.SHH_PAIEMENT_ESSAI == "0" or .SHH_PAIEMENT_ESSAI == "1")' "$T"
check "sans profil de paiement : aucun relais de paiement" j '[.services | keys[] | select(startswith("relais-"))] == []' "$S"
check "tous les profils : les trois relais" \
	j '(.services | keys) == ["caddy","relais-nowpayments","relais-paypal","relais-stripe","shhdrop"] and (.networks | keys) == ["interne","sortie"]' "$T"
check "tous les profils : serveur sur le réseau interne seul" j '(.services.shhdrop.networks | keys) == ["interne"] and .networks.interne.internal == true' "$T"
check "tous les profils : seuls les relais sont sur « sortie »" \
	j '[.services | to_entries[] | select(.value.networks.sortie != null) | .key] == ["relais-nowpayments","relais-paypal","relais-stripe"]' "$T"
check "tous les profils : aucun port publié" j '[.services[] | .ports // [] | length] | add == 0' "$T"
check "tous les profils : aucune variable de secret en valeur" \
	j '[.services[] | .environment // {} | keys[] | select(test("PASSWORD|MDP|SECRET|TOKEN|CLE|KEY|JETON|IPN|WEBHOOK_FILE") and (endswith("_FILE") or endswith("_SHA256") or . == "SHH_PREPROD_JETON" | not))] == []' "$T"
# shellcheck disable=SC2016 # filtre jq
check "caddy : non root (65532), aucune capacité, no-new-privileges, lecture seule" \
	j '.services.caddy | .user == "65532:65532" and .cap_drop == ["ALL"] and (.cap_add // [] | length) == 0 and (.security_opt | index("no-new-privileges:true")) != null and .read_only == true' "$T"
# jr <filtre> : filtre jq sur la configuration de tous les profils, avec $n (relais), $ip et $h.
jr() { jq -e --arg n "$n" --arg ip "$ip" --arg h "$h" "$1" "$T" >/dev/null; }
# shellcheck disable=SC2016 # variables de jq, pas du shell
for r in stripe:4:api.stripe.com paypal:5:api-m.paypal.com nowpayments:6:api.nowpayments.io; do
	n=${r%%:*} ip=172.30.53.$(cut -d: -f2 <<<"$r") h=${r##*:}
	check "relais-$n : profil « paiement-$n », interne $ip et sortie" \
		jr '.services["relais-" + $n] | .profiles == ["paiement-" + $n] and (.networks | keys) == ["interne","sortie"] and .networks.interne.ipv4_address == $ip'
	check "relais-$n : écoute $ip:443, cible $h:443, 16 connexions" \
		jr '.services["relais-" + $n] | .entrypoint == ["/shhcheck"] and .command == ["relais", $ip + ":443", $h + ":443", "16"]'
	check "relais-$n : même image, 65532, lecture seule, sans capacité, no-new-privileges, sans journal, bornes" \
		jr '.services as $s | $s["relais-" + $n] | .image == $s.shhdrop.image and .user == "65532:65532" and .read_only == true and .cap_drop == ["ALL"] and .security_opt == ["no-new-privileges:true"] and .logging.driver == "none" and .restart == "unless-stopped" and .pids_limit == 64 and .mem_limit != null'
done

if [ "$statique" = 1 ]; then
	[ "$fails" -eq 0 ] || {
		echo "$fails échec(s)"
		exit 1
	}
	echo "partie statique : tous les contrôles passent (partie dynamique non demandée)"
	exit 0
fi

# --- 2. Dynamique -----------------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
	echo "$fails échec(s) statique(s) ; partie dynamique NON FAITE : aucun démon Docker" >&2
	[ "$fails" -eq 0 ] || exit 1
	exit 3
fi
: "${SHH_IMAGE:?SHH_IMAGE manquant : image construite depuis cet arbre (docker build -f deploy/Dockerfile …)}"
for c in openssl python3; do command -v "$c" >/dev/null || die "$c introuvable"; done
port=${PORT_FAUX:-18465}

# Faux prestataire : TLS (certificat pour les vrais noms des API, autorité de test), sur toutes
# les interfaces de la machine : les relais le joignent par host-gateway ; le serveur ne doit pas.
# Ces noms ne sont résolus que par les /etc/hosts des conteneurs de test.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=api.stripe.com" \
	-addext "subjectAltName=DNS:api.stripe.com,DNS:api-m.paypal.com,DNS:api.nowpayments.io" \
	-keyout "$work/faux.key" -out "$work/faux.pem" >/dev/null 2>&1
chmod 0644 "$work/faux.pem"
cat >"$work/faux.py" <<'EOF'
import socket, ssl, sys, threading
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(sys.argv[2], sys.argv[3])
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", int(sys.argv[1]))); s.listen(16)
def servir(c):
    try:
        t = ctx.wrap_socket(c, server_side=True); t.settimeout(5)
        t.recv(64); t.close()
    except Exception:
        c.close()
while True:
    c, _ = s.accept()
    threading.Thread(target=servir, args=(c,), daemon=True).start()
EOF
python3 -I "$work/faux.py" "$port" "$work/faux.pem" "$work/faux.key" &
pid_faux=$!

mkdir -p "$work/racine/data" "$work/racine/caddy" "$work/racine/secrets"
cat >"$work/override.yaml" <<EOF
services:
  relais-stripe:
    command: ["relais", "172.30.53.4:443", "api.stripe.com:$port", "16"]
    extra_hosts: ["api.stripe.com:host-gateway"]
  relais-paypal:
    command: ["relais", "172.30.53.5:443", "api-m.paypal.com:$port", "16"]
    extra_hosts: ["api-m.paypal.com:host-gateway"]
  relais-nowpayments:
    command: ["relais", "172.30.53.6:443", "api.nowpayments.io:$port", "16"]
    extra_hosts: ["api.nowpayments.io:host-gateway"]
EOF
dcp=(env SHH_IMAGE="$SHH_IMAGE" SHH_DOMAIN=shhdrop.test SHH_DATA_ROOT="$work/racine"
	docker compose -p "$proj" -f "$here/compose.yaml" -f "$work/override.yaml")
dyn=1
COMPOSE_PROFILES=$tous "${dcp[@]}" up -d --wait relais-stripe relais-paypal relais-nowpayments >/dev/null 2>&1 ||
	die "relais de test non démarrés"
# sonde <hôte:port> : shhcheck joindre dans un conteneur du service shhdrop (mêmes réseaux,
# /etc/hosts, lecture seule), autorité du faux prestataire acceptée.
sonde() {
	COMPOSE_PROFILES=$tous "${dcp[@]}" run --rm --no-deps -T -v "$work/faux.pem:/ca.pem:ro" -e SSL_CERT_FILE=/ca.pem \
		--entrypoint /shhcheck shhdrop joindre "$1"
}
refuse "serveur → Internet (1.1.1.1:443) : injoignable" sonde 1.1.1.1:443
refuse "serveur → Internet (9.9.9.9:465) : injoignable" sonde 9.9.9.9:465
refuse "serveur → Internet (8.8.8.8:25) : injoignable" sonde 8.8.8.8:25
refuse "serveur → nom à résoudre (example.com:443) : injoignable" sonde example.com:443
gw=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)
refuse "serveur → faux prestataire joint directement ($gw) : injoignable" sonde "$gw:$port"
check "aucun port publié (docker port)" test -z "$(COMPOSE_PROFILES=$tous "${dcp[@]}" port relais-stripe 443 2>/dev/null)"
# Paiement : seul compte ici le TLS vérifié pour le vrai nom de l'API, à travers son relais.
for h in api.stripe.com api-m.paypal.com api.nowpayments.io; do
	check "serveur → $h:443, à travers son relais, TLS vérifié" sonde "$h:443"
done
refuse "serveur → api.stripe.com sur un autre port (8443) : injoignable" sonde api.stripe.com:8443
COMPOSE_PROFILES=$tous "${dcp[@]}" rm -sf relais-stripe relais-paypal relais-nowpayments >/dev/null 2>&1
for h in api.stripe.com api-m.paypal.com api.nowpayments.io; do
	refuse "relais arrêté (paiement désactivé) : $h injoignable" sonde "$h:443"
done

if [ "$fails" -ne 0 ]; then
	echo "$fails échec(s)"
	exit 1
fi
echo "tous les contrôles passent"

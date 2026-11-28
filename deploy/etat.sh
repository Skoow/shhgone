#!/usr/bin/env bash
# Résumé lisible de la machine, en une commande, SANS AUCUN SECRET (README « Commandes du
# quotidien ») : version installée, préproduction ou production, conteneurs, certificat HTTPS,
# disque, volume chiffré, secrets présents ou absents, paiement et appels, tableau de bord,
# mises à jour du système. Ne change rien. Peut être lancé depuis une session Claude.
#
#   sudo deploy/etat.sh
set -uo pipefail
export LC_ALL=C.UTF-8

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here" || exit 1
[ $# -eq 0 ] || {
	printf 'usage: etat.sh\n' >&2
	exit 2
}
if [ "$(id -u)" != 0 ]; then
	printf 'erreur: à lancer en root : sudo deploy/etat.sh\n' >&2
	exit 1
fi
# shellcheck disable=SC2034 # lue par commun.sh : aucun jeton n'est lu
jeton_preprod=sans
# shellcheck source=deploy/commun.sh
. ./commun.sh
# shellcheck source=deploy/annonce.sh
. ./annonce.sh

titre() { printf '\n%s\n' "$1"; }

printf 'Shhdrop : %s, %s\n' "$SHH_DOMAIN" "$(date '+%d/%m/%Y %H:%M')"
if [ "$preprod" = 1 ]; then
	echo "Mode : PRÉPRODUCTION (le public ne voit que la page de maintenance)"
else
	echo "Mode : production (site public)"
fi

titre "Version"
case $cur in
preprod:*) echo "  en service : préproduction, commit ${cur#preprod:}" ;;
sha256:*) echo "  en service : web-v${cur_v:-?}, commit ${cur_c:-?}" ;;
*) echo "  aucune version installée" ;;
esac
case $prev in
preprod:*) echo "  précédente : préproduction, commit ${prev#preprod:}" ;;
sha256:*) echo "  précédente : web-v${prev_v:-?}, commit ${prev_c:-?}" ;;
esac

titre "Volume chiffré ($SHH_DATA_ROOT)"
volume=0
if mountpoint -q "$SHH_DATA_ROOT"; then
	volume=1
	src=$(findmnt -no SOURCE -T "$SHH_DATA_ROOT" 2>/dev/null)
	if lsblk -s -n -o TYPE "$src" 2>/dev/null | grep -qx crypt; then
		echo "  ouvert (chiffré, $src)"
	else
		echo "  monté, mais pas reconnu comme chiffré ($src)"
	fi
else
	echo "  FERMÉ : le site est arrêté. L'ouvrir (README §5) :"
	echo "    sudo cryptsetup open <disque> shhdrop && sudo mount -o noatime,nodev,nosuid,noexec /dev/mapper/shhdrop $SHH_DATA_ROOT"
fi

titre "Maintenance programmée (deploy/maintenance.sh)"
if [ "$volume" = 1 ]; then
	echo "  $(annonce_etat "$SHH_DATA_ROOT/data/maintenance" "$(date +%s)" "$(annonce_demarrage)")"
else
	echo "  illisible : volume fermé"
fi

titre "Conteneurs"
if ! command -v docker >/dev/null 2>&1; then
	echo "  docker introuvable"
elif etat_valide "$cur"; then
	dc "$cur" ps -a --format '  {{.Service}}\t{{.Status}}' 2>/dev/null | sort || echo "  illisibles (docker compose ps)"
	n=$(dc "$cur" ps -q 2>/dev/null | grep -c . || true)
	[ "$n" -gt 0 ] || echo "  aucun conteneur en marche"
else
	echo "  aucune version installée"
fi

titre "Certificat HTTPS"
fin=$(timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$SHH_DOMAIN" </dev/null 2>/dev/null |
	openssl x509 -noout -enddate 2>/dev/null | sed -n 's/^notAfter=//p')
if [ -n "$fin" ] && fin_s=$(date -d "$fin" +%s 2>/dev/null); then
	jours=$(((fin_s - $(date +%s)) / 86400))
	avis=""
	[ "$jours" -ge 21 ] || avis="  ← À SURVEILLER (Caddy renouvelle à 30 jours)"
	echo "  expire le $(date -d "$fin" '+%d/%m/%Y') (dans $jours jours)$avis"
else
	echo "  illisible (Caddy arrêté, ou port 443 fermé)"
fi

titre "Disque"
# (Volume fermé : les deux lignes sont celles de /, gardées une fois.)
df -h --output=target,size,used,avail,pcent / "$SHH_DATA_ROOT" 2>/dev/null | uniq | sed 's/^/  /'

titre "Secrets (valeurs jamais affichées)"
volume_secrets=0
if [ "$volume" = 1 ] && [ -d "$secrets" ] && [ ! -L "$secrets" ] && [ "$(stat -c '%u:%g %a' "$secrets")" = "0:65532 750" ]; then
	volume_secrets=1
fi
liste_secrets "$volume_secrets"
echo "  enregistrer un secret : sudo deploy/secret.sh <nom>, dans votre propre fenêtre SSH"

titre "Fonctions"
if [ "$paiement" = 1 ]; then
	m="réel"
	[ "$essai" = 0 ] || m="ESSAI (bacs à sable, clés de test)"
	p=""
	[ "$avec_stripe" = 0 ] || p="$p Stripe"
	[ "$avec_paypal" = 0 ] || p="$p PayPal"
	[ "$avec_nowpayments" = 0 ] || p="$p NOWPayments"
	echo "  paiement : activé, $m ; prestataires :${p:- aucun}"
else
	echo "  paiement : désactivé"
fi
if [ "$appels" = 1 ]; then
	if [ "$paiement" = 1 ]; then echo "  appels : activés"; else echo "  appels : relais en marche, appels proposés seulement avec le paiement (README §14)"; fi
else
	echo "  appels : désactivés (SHH_APPELS=0)"
fi
[ "$comptes" = 1 ] && echo "  compte par passkey : activé" || echo "  compte par passkey : désactivé"
if [ -n "${SHH_ADMIN_LISTEN:-}" ]; then
	echo "  tableau de bord : activé ($SHH_ADMIN_LISTEN, par tunnel SSH)"
else
	echo "  tableau de bord : désactivé (sudo deploy/admin-jeton.sh pour l'activer)"
fi

titre "Mises à jour du système"
if command -v apt-get >/dev/null 2>&1; then
	inst=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ' || true)
	n=$(printf '%s' "$inst" | grep -c . || true)
	ns=$(printf '%s' "$inst" | grep -ci security || true)
	echo "  en attente : $n, dont $ns de sécurité (installées seules chaque nuit par unattended-upgrades)"
else
	echo "  apt-get introuvable"
fi
if [ -e /var/run/reboot-required ]; then
	echo "  REDÉMARRAGE DEMANDÉ par une mise à jour : à faire à un moment calme ; ensuite, volume à rouvrir (README §5)"
else
	echo "  aucun redémarrage demandé"
fi

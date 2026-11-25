#!/usr/bin/env bash
# Enregistre un secret que seul le propriétaire possède (README « Commandes du quotidien »,
# §13.2, §13.4, §4 « Surveillance ») : clés et secrets de Stripe, PayPal, NOWPayments, mot de
# passe SMTP des alertes. En root, dans SA PROPRE fenêtre SSH (jamais depuis une session Claude) :
#
#   sudo deploy/secret.sh <nom>              saisie masquée, deux fois ; refusé s'il existe déjà
#   sudo deploy/secret.sh --remplacer <nom>  remplace celui qui existe (passage du test au réel)
#   sudo deploy/secret.sh --liste            noms attendus : présent ou absent (jamais la valeur)
#
# La valeur est tapée (ou collée) au clavier, sans écho (read -s), puis retapée pour confirmer ;
# elle n'apparaît ni à l'écran, ni dans l'historique du shell (ce n'est pas un argument), ni dans
# la liste des processus (elle ne passe que par des commandes internes du shell). Sa forme est
# vérifiée (Stripe : clé de test ou réelle selon le mode du paiement), puis elle est écrite de
# façon atomique, avec ses droits exacts (fichiers-secrets.sh) : compte 65532, 0400 pour ce que
# lit le serveur (<SHH_DATA_ROOT>/secrets, volume chiffré ouvert exigé), root 0600 pour le mot de
# passe des alertes (/etc/shhdrop). L'entrée doit être un terminal : rien ne s'enregistre par un
# tuyau ou un fichier, où le secret serait déjà passé ailleurs.
# Codes de sortie : 0 enregistré (ou liste affichée), 1 refus, 2 erreur d'usage.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$here"
usage() {
	printf 'usage: secret.sh <nom> | --remplacer <nom> | --liste\n' >&2
	exit 2
}
remplacer=0 liste=0
case ${1:-} in
--liste)
	[ $# -eq 1 ] || usage
	liste=1
	;;
--remplacer)
	[ $# -eq 2 ] || usage
	remplacer=1
	shift
	;;
-* | "") usage ;;
*) [ $# -eq 1 ] || usage ;;
esac
if [ "$(id -u)" != 0 ]; then
	printf 'erreur: à lancer en root : sudo deploy/secret.sh %s\n' "$*" >&2
	exit 1
fi
# shellcheck disable=SC2034 # lue par commun.sh : aucun secret n'est lu pour le site
jeton_preprod=sans
# shellcheck source=deploy/commun.sh
. ./commun.sh

volume=0
if mountpoint -q "$SHH_DATA_ROOT" && [ -d "$secrets" ] && [ ! -L "$secrets" ] &&
	[ "$(stat -c '%u:%g %a' "$secrets")" = "0:65532 750" ]; then
	volume=1
fi

if [ "$liste" = 1 ]; then
	echo "Secrets (valeurs jamais affichées) :"
	liste_secrets "$volume"
	if [ "$paiement" = 1 ]; then
		echo "Paiement : activé ($([ "$essai" = 1 ] && echo "essai, clés de TEST" || echo "réel, clés RÉELLES"))."
	else
		echo "Paiement : désactivé (ses secrets ne servent pas encore)."
	fi
	echo "Enregistrer : sudo deploy/secret.sh <nom>, dans votre propre fenêtre SSH."
	exit 0
fi

nom=$1
fiche_secret "$nom" || die "nom inconnu : « $nom » (noms attendus : sudo deploy/secret.sh --liste)" 2
case " $SECRETS_SAISIS " in
*" $nom "*) ;;
*) die "$nom est tiré par la machine elle-même (deploy.sh, preprod.sh) : rien à taper" ;;
esac
[ -t 0 ] ||
	die "saisie au clavier exigée : lancez cette commande vous-même, dans votre propre fenêtre SSH (jamais depuis une session Claude, jamais avec un tuyau ou un fichier)"

if [ "${s_fichier#"$SECRETS_ETC"/}" = "$s_fichier" ]; then
	# Lu par le serveur : sur le volume chiffré, jamais sur le disque du dessous.
	[ "$volume" = 1 ] ||
		die "volume chiffré fermé, ou $secrets mal réglé : l'ouvrir d'abord (README §5 ; dossier : install -d -o root -g 65532 -m 0750 $secrets)"
elif [ ! -e "$SECRETS_ETC" ]; then
	install -d -o root -g root -m 0755 "$SECRETS_ETC"
fi
if [ "$remplacer" = 0 ] && { [ -e "$s_fichier" ] || [ -L "$s_fichier" ]; }; then
	die "$nom existe déjà (rien n'est changé). Pour le remplacer : sudo deploy/secret.sh --remplacer $nom"
fi

echo "$s_quoi"
if [ "$nom" = shh_stripe_cle ]; then
	if [ "$essai" = 1 ]; then echo "Mode essai : clé de TEST attendue (sk_test_… ou rk_test_…)."; else echo "Mode réel : clé RÉELLE attendue (sk_live_… ou rk_live_…)."; fi
fi
echo "Collez ou tapez la valeur (rien ne s'affiche, c'est normal), puis Entrée."
v1='' v2=''
IFS= read -rs -p "Valeur : " v1 || true
echo >&2
IFS= read -rs -p "Encore une fois, pour confirmer : " v2 || true
echo >&2
v1=${v1%$'\r'} v2=${v2%$'\r'}
if [ "$nom" != alerte_smtp_mdp ]; then
	# Espaces collées par mégarde autour d'une clé (une clé n'en contient jamais).
	v1=${v1#"${v1%%[![:space:]]*}"} v1=${v1%"${v1##*[![:space:]]}"}
	v2=${v2#"${v2%%[![:space:]]*}"} v2=${v2%"${v2##*[![:space:]]}"}
fi
if [ "$v1" != "$v2" ]; then
	v1='' v2=''
	die "les deux saisies diffèrent : rien n'est enregistré, recommencez"
fi
v2=
raison=$(verifier_format "$nom" "$v1" "$essai" 2>&1) || {
	v1=
	die "format refusé : $raison. Rien n'est enregistré."
}
code=0
ecrire_secret "$s_fichier" "$s_proprio" "$s_mode" "$remplacer" "$v1" || code=$?
v1=
case $code in
0) ;;
3) die "$nom existe déjà (rien n'est changé). Pour le remplacer : sudo deploy/secret.sh --remplacer $nom" ;;
*) die "$s_fichier : écriture impossible (rien n'est changé)" ;;
esac
[ "$(etat_secret "$s_fichier" "$s_proprio" "$s_mode")" = présent ] || die "$s_fichier mal réglé après l'écriture"

echo "Enregistré : $nom ($s_fichier, compte ${s_proprio%%:*}, droits 0$s_mode). La valeur n'a été affichée nulle part."
if [ "$nom" = alerte_smtp_mdp ]; then
	echo "Pris en compte au prochain passage de l'alerte (15 min au plus)."
else
	r=$(commande_reinstallation)
	if [ -n "$r" ]; then
		echo "Pris en compte à la prochaine installation : $r"
	else
		echo "Pris en compte à la prochaine installation (deploy.sh ou preprod.sh)."
	fi
	case $nom in
	shh_stripe_cle | shh_stripe_webhook) autre=" shh_stripe_cle shh_stripe_webhook " ;;
	shh_nowpayments_cle | shh_nowpayments_ipn) autre=" shh_nowpayments_cle shh_nowpayments_ipn " ;;
	*) autre= ;;
	esac
	for a in $autre; do
		fiche_secret "$a"
		[ "$(etat_secret "$s_fichier" "$s_proprio" "$s_mode")" = présent ] ||
			echo "À faire aussi : sudo deploy/secret.sh $a (les deux vont ensemble)."
	done
fi

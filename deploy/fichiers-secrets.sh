#!/usr/bin/env bash
# shellcheck disable=SC2034 # s_* : lues par les scripts qui chargent ce fichier
# Secrets en fichiers (README « Commandes du quotidien », §12.2, §13.2, §14, §15) : ceux que la
# machine tire elle-même (tirer_secret, appelé par commun.sh pendant deploy.sh et preprod.sh) et
# ceux que seul le propriétaire possède (deploy/secret.sh, saisie masquée). Règles communes :
#   - une valeur n'est jamais affichée, ni passée en argument d'une commande externe (ps la
#     montrerait) : écrite par la redirection du printf du shell, ou tirée de /dev/urandom ;
#   - écriture atomique : un fichier temporaire du même dossier (mktemp, 0600), ses droits
#     exacts posés, puis mis en place d'un coup ;
#   - jamais d'écrasement sans --remplacer (secret.sh) : « ln » échoue si le nom existe, même
#     si deux commandes écrivent à la fois.
# Chargé par commun.sh (après deploy/.env : constantes en lecture seule) et par test-outils.sh.
# $secrets (dossier des secrets du serveur, sur le volume chiffré) est posé par commun.sh.

# Dossier des secrets de la machine (hors volume chiffré : jeton de préproduction, mot de passe
# SMTP des alertes, lisibles après un redémarrage, volume encore fermé).
readonly SECRETS_ETC=/etc/shhdrop

# Secrets que seul le propriétaire possède (deploy/secret.sh), puis ceux que la machine tire
# elle-même. Ordre de « deploy/secret.sh --liste » et de deploy/etat.sh.
readonly SECRETS_SAISIS="shh_stripe_cle shh_stripe_webhook shh_paypal_secret shh_nowpayments_cle shh_nowpayments_ipn alerte_smtp_mdp"
readonly SECRETS_TIRES="shh_comptes_cle shh_salons_cle shh_turn_secret preprod-jeton"

# fiche_secret <nom> : pose s_fichier, s_proprio (uid:gid), s_mode (sans le 0 de tête, comme
# stat %a), s_quoi (description, jamais la valeur). Rend 1 pour un nom inconnu.
fiche_secret() {
	s_proprio=65532:65532 s_mode=400 s_fichier=${secrets:-?}/$1
	case $1 in
	shh_stripe_cle) s_quoi="Stripe : clé secrète (sk_… ou rk_…)" ;;
	shh_stripe_webhook) s_quoi="Stripe : secret de signature du webhook (whsec_…)" ;;
	shh_paypal_secret) s_quoi="PayPal : « Secret » de l'application" ;;
	shh_nowpayments_cle) s_quoi="NOWPayments : clé d'API" ;;
	shh_nowpayments_ipn) s_quoi="NOWPayments : secret IPN" ;;
	alerte_smtp_mdp) s_quoi="alertes : mot de passe SMTP" s_proprio=0:0 s_mode=600 s_fichier=$SECRETS_ETC/$1 ;;
	shh_comptes_cle) s_quoi="compte : clé du serveur (tirée par deploy.sh)" ;;
	shh_salons_cle) s_quoi="salons : clé maîtresse des salons persistants (tirée par deploy.sh)" ;;
	shh_turn_secret) s_quoi="appels : secret du relais TURN (tiré par deploy.sh)" ;;
	preprod-jeton) s_quoi="préproduction : jeton d'accès (tiré par preprod.sh)" s_proprio=0:0 s_mode=600 s_fichier=$SECRETS_ETC/$1 ;;
	*) return 1 ;;
	esac
}

# etat_secret <fichier> <uid:gid> <mode> : écrit « présent », « absent » ou « mal réglé (…) »,
# d'après le type, le propriétaire et les droits seulement (jamais le contenu). Mêmes critères
# que preflight (commun.sh) : fichier ordinaire, pas un lien, ce compte, ces droits.
etat_secret() {
	local f=$1 u=${2%%:*} m=$3
	if [ -L "$f" ]; then
		echo "mal réglé (lien symbolique)"
	elif [ ! -e "$f" ]; then
		echo absent
	elif [ ! -f "$f" ]; then
		echo "mal réglé (pas un fichier ordinaire)"
	elif [ "$(stat -c '%u %a' -- "$f")" != "$u $m" ]; then
		echo "mal réglé (attendu : compte $u, droits 0$m)"
	elif [ ! -s "$f" ]; then
		echo "mal réglé (vide)"
	else
		echo présent
	fi
}

# dossier_sur <dossier> : dossier réel (pas un lien), à soi (root sur le serveur), ni groupe ni
# autres en écriture. Un secret ne s'écrit jamais ailleurs.
dossier_sur() {
	local u m
	[ -d "$1" ] && [ ! -L "$1" ] || return 1
	read -r u m < <(stat -c '%u %a' -- "$1") || return 1
	[ "$u" = "$(id -u)" ] && ! ((8#$m & 8#022))
}

# installer_fichier <tmp> <fichier> <uid:gid> <mode> <remplacer 0|1> : met en place <tmp> (écrit,
# du même dossier) sous le nom <fichier>, avec ce propriétaire et ces droits. remplacer=0 : jamais
# d'écrasement (rend 3 si le nom existe). <tmp> est toujours effacé.
installer_fichier() {
	local tmp=$1 f=$2
	if ! chown "$3" -- "$tmp" || ! chmod "$4" -- "$tmp"; then
		rm -f -- "$tmp"
		return 1
	fi
	if [ "$5" = 1 ]; then
		# Renommage : remplace le nom (même un lien symbolique, jamais suivi), d'un coup.
		mv -fT -- "$tmp" "$f" || {
			rm -f -- "$tmp"
			return 1
		}
		return 0
	fi
	# Lien physique : échoue si le nom existe déjà (fichier, lien ou dossier), sans rien toucher.
	if ln -T -- "$tmp" "$f" 2>/dev/null; then
		rm -f -- "$tmp"
		return 0
	fi
	rm -f -- "$tmp"
	if [ -e "$f" ] || [ -L "$f" ]; then return 3; fi
	return 1
}

# ecrire_secret <fichier> <uid:gid> <mode> <remplacer 0|1> <valeur> : écrit la valeur et une fin
# de ligne (deploy/secret.sh). La valeur ne passe que par le printf du shell. Rend 3 si le
# fichier existe et remplacer=0 (rien n'est écrit).
ecrire_secret() {
	local f=$1 d tmp
	d=$(dirname -- "$f")
	dossier_sur "$d" || {
		echo "$d : dossier absent ou mal réglé (à root, ni groupe ni autres en écriture)" >&2
		return 1
	}
	if [ "$4" != 1 ] && { [ -e "$f" ] || [ -L "$f" ]; }; then return 3; fi
	tmp=$(umask 077 && mktemp -- "$d/.${f##*/}.XXXXXX") || return 1
	if ! printf '%s\n' "$5" >"$tmp"; then
		rm -f -- "$tmp"
		return 1
	fi
	installer_fichier "$tmp" "$f" "$2" "$3" "$4"
}

# tirer_secret <fichier> <uid:gid> <mode> <hex<n>|octets<n>> <libellé> : tire le secret s'il
# manque (hex<n> : n octets au hasard écrits en 2n chiffres hexadécimaux et une fin de ligne ;
# octets<n> : n octets bruts), puis contrôle le fichier. Écrit une ligne « <libellé> : créé »
# ou « <libellé> : présent », jamais la valeur. Un secret présent n'est jamais touché. Pose
# secret_cree (1 : créé à l'instant). Rend 1 si le dossier ou le fichier est mal réglé.
tirer_secret() {
	local f=$1 d tmp n taille e=0
	secret_cree=0
	if [ ! -e "$f" ] && [ ! -L "$f" ]; then
		d=$(dirname -- "$f")
		dossier_sur "$d" || {
			echo "$d : dossier absent ou mal réglé (à root, ni groupe ni autres en écriture)" >&2
			return 1
		}
		tmp=$(umask 077 && mktemp -- "$d/.${f##*/}.XXXXXX") || return 1
		case $4 in
		hex[1-9]*)
			n=${4#hex} taille=$((2 * ${4#hex} + 1))
			{ od -An -v -N"$n" -tx1 /dev/urandom | tr -d ' \n' && printf '\n'; } >"$tmp" || e=1
			;;
		octets[1-9]*)
			n=${4#octets} taille=$n
			head -c "$n" /dev/urandom >"$tmp" || e=1
			;;
		*) e=1 taille=0 ;;
		esac
		if [ "$e" = 1 ] || [ "$(stat -c %s -- "$tmp")" != "$taille" ]; then
			rm -f -- "$tmp"
			echo "$f : tirage impossible" >&2
			return 1
		fi
		installer_fichier "$tmp" "$f" "$2" "$3" 0 || e=$?
		case $e in
		0) secret_cree=1 ;;
		3) ;; # écrit entre-temps par une autre commande : gardé tel quel
		*)
			echo "$f : écriture impossible" >&2
			return 1
			;;
		esac
	fi
	if [ "$(etat_secret "$f" "$2" "$3")" != présent ]; then
		echo "$f mal réglé : fichier ordinaire du compte ${2%%:*}, droits 0$3" >&2
		return 1
	fi
	if [ "$secret_cree" = 1 ]; then
		printf '%s : créé\n' "$5"
	else
		printf '%s : présent\n' "$5"
	fi
}

# verifier_format <nom> <valeur> <essai 0|1> : 0 si la valeur a la forme attendue pour ce secret ;
# sinon la raison sur la sortie d'erreur (jamais la valeur), et 1. essai : clés de test (bacs à
# sable) ou réelles, comme le serveur (server/internal/paiement/secrets.go).
verifier_format() {
	local nom=$1 v=$2 essai=$3 mode
	if [ "$nom" = alerte_smtp_mdp ]; then
		# Écrit tel quel dans la configuration de curl (alerte.sh, user = "…:…") : ni guillemet
		# ni barre oblique inverse, qui la casseraient.
		if [ -z "$v" ] || [ "${#v}" -gt 256 ]; then
			echo "mot de passe vide ou trop long (256 caractères au plus)" >&2
			return 1
		fi
		if ! [[ $v =~ ^[\ -~]+$ ]] || [[ $v == *[\"\\]* ]]; then
			echo "caractère refusé : accents, guillemet (\") et barre oblique inverse (\\) ne passent pas dans l'envoi des alertes (changer le mot de passe chez le fournisseur)" >&2
			return 1
		fi
		return 0
	fi
	# Secrets lus par le serveur : 1 à 1 024 caractères ASCII imprimables, sans espace.
	if [ -z "$v" ] || [ "${#v}" -gt 1024 ] || ! [[ $v =~ ^[!-~]+$ ]]; then
		echo "valeur vide, trop longue, ou avec une espace ou un caractère non imprimable" >&2
		return 1
	fi
	case $nom in
	shh_stripe_cle)
		mode='live'
		if [ "$essai" = 1 ]; then mode='test'; fi
		if [[ $v == pk_* ]]; then
			echo "c'est la clé publique (pk_…) : il faut la clé secrète (sk_$mode…) ou restreinte (rk_$mode…)" >&2
			return 1
		fi
		if [[ $v == whsec_* ]]; then
			echo "c'est le secret du webhook (whsec_…) : il va dans shh_stripe_webhook" >&2
			return 1
		fi
		if ! [[ $v =~ ^[sr]k_${mode}_[A-Za-z0-9]{10,}$ ]]; then
			if [ "$essai" = 1 ]; then
				echo "clé de TEST attendue (sk_test_… ou rk_test_…) : la préproduction est en essai (SHH_PREPROD_PAIEMENT_ESSAI=1)" >&2
			else
				echo "clé RÉELLE attendue (sk_live_… ou rk_live_…) : le paiement n'est pas en essai. Pour essayer avec une clé de test : SHH_PREPROD_PAIEMENT=1 et SHH_PREPROD_PAIEMENT_ESSAI=1 dans deploy/.env d'abord (README §13.4)" >&2
			fi
			return 1
		fi
		;;
	shh_stripe_webhook)
		[[ $v =~ ^whsec_[A-Za-z0-9]{10,}$ ]] || {
			echo "secret de signature du webhook attendu (whsec_…)" >&2
			return 1
		}
		;;
	shh_paypal_secret)
		[[ $v =~ ^[A-Za-z0-9_-]{20,}$ ]] || {
			echo "« Secret » de l'application PayPal attendu (lettres, chiffres, - et _, 20 au moins)" >&2
			return 1
		}
		;;
	shh_nowpayments_cle)
		[[ $v =~ ^[A-Za-z0-9]+(-[A-Za-z0-9]+)+$ ]] && [ "${#v}" -ge 16 ] || {
			echo "clé d'API NOWPayments attendue (groupes de lettres et de chiffres séparés par des -)" >&2
			return 1
		}
		;;
	shh_nowpayments_ipn)
		[[ $v =~ ^[A-Za-z0-9+/=_-]{16,}$ ]] || {
			echo "secret IPN NOWPayments attendu (16 caractères au moins, lettres et chiffres)" >&2
			return 1
		}
		;;
	*)
		echo "$nom : secret inconnu" >&2
		return 1
		;;
	esac
}

# liste_secrets <volume ouvert 0|1> : un nom par ligne, son état et sa description ; jamais la
# valeur. Volume fermé : les secrets du serveur sont dits « inconnu ».
liste_secrets() {
	local nom e
	for nom in $SECRETS_SAISIS - $SECRETS_TIRES; do
		if [ "$nom" = - ]; then
			echo "  tirés par la machine elle-même (rien à taper) :"
			continue
		fi
		fiche_secret "$nom"
		if [ "$1" != 1 ] && [ "${s_fichier#"$SECRETS_ETC"/}" = "$s_fichier" ]; then
			e="inconnu (volume chiffré fermé)"
		else
			e=$(etat_secret "$s_fichier" "$s_proprio" "$s_mode")
		fi
		printf '  %-20s %-10s %s\n' "$nom" "$e" "$s_quoi"
	done
}

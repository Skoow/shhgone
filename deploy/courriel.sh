#!/usr/bin/env bash
# Envoi d'un e-mail à l'exploitant (README §4, « Surveillance »), partagé par alerte.sh,
# integrite.sh et ssh-connexion.sh. Chargé par eux (« . courriel.sh »), après deploy/.env (lu par
# lire-env.sh) ; aucune adresse IP ni donnée d'utilisateur ne doit être dans le texte donné.
#
#   courriel_envoyer <niveau> <sujet court> <texte> [<objet complet>]
#
# Codes : 0 envoyé ; 1 non envoyé (constat sur la sortie d'erreur : mot de passe illisible, envoi
# SMTP raté ; à retenter) ; 2 aucun destinataire (SHH_ALERTE_A absente : rien n'est envoyé) ;
# 3 réglages incomplets (SHH_ALERTE_A sans SHH_ALERTE_SMTP_HOST, SHH_ALERTE_SMTP_USER et
# SHH_ALERTE_FROM).
#
# Réglages (deploy/.env) : SHH_ALERTE_A, SHH_ALERTE_SMTP_HOST (TLS implicite sur 465),
# SHH_ALERTE_SMTP_USER, SHH_ALERTE_FROM ; mot de passe dans /etc/shhdrop/alerte_smtp_mdp (root
# 0600, jamais une variable ; SHH_ALERTE_MDP_FICHIER pour les essais).
# Essais seulement : SHH_COURRIEL_ENVOI, commande qui reçoit le message complet sur son entrée
# au lieu de curl (bancs d'essai ; jamais transmise par ssh-connexion.sh, qui vide son
# environnement).

courriel_envoyer() {
	local niveau=$1 cle=$2 texte=$3 objet=${4:-} de mdp
	[ -n "${SHH_ALERTE_A:-}" ] || return 2
	if [ -z "${SHH_ALERTE_SMTP_HOST:-}" ] || [ -z "${SHH_ALERTE_SMTP_USER:-}" ] || [ -z "${SHH_ALERTE_FROM:-}" ]; then
		return 3
	fi
	[ -n "$objet" ] || objet="Shhgone $niveau : $cle"
	# Objet sur une seule ligne (aucun en-tête ajouté par un texte venu d'ailleurs).
	objet=${objet//[$'\r\n']/ }
	_courriel_message() {
		printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
			"$SHH_ALERTE_FROM" "$SHH_ALERTE_A" "$objet" "$texte"
	}
	if [ -n "${SHH_COURRIEL_ENVOI:-}" ]; then
		if _courriel_message | bash -c "$SHH_COURRIEL_ENVOI"; then return 0; fi
		printf 'alerte : envoi de « %s » impossible (SMTP), nouvel essai au prochain passage\n' "$cle" >&2
		return 1
	fi
	# Mot de passe d'envoi des alertes : celui de /etc/shhdrop (disque système, lisible juste
	# après un redémarrage, quand le volume chiffré est encore verrouillé). Illisible : constat
	# sur la sortie, nouvel essai plus tard.
	mdp=${SHH_ALERTE_MDP_FICHIER:-/etc/shhdrop/alerte_smtp_mdp}
	if [ ! -r "$mdp" ]; then
		printf 'alerte : aucun mot de passe SMTP lisible (/etc/shhdrop/alerte_smtp_mdp absent) : « %s » non envoyée\n' "$cle" >&2
		return 1
	fi
	de=$(printf '%s' "$SHH_ALERTE_FROM" | sed -n 's/.*<\(.*\)>.*/\1/p')
	[ -n "$de" ] || de=$SHH_ALERTE_FROM
	# Mot de passe lu par curl depuis un fichier de configuration (jamais sur la ligne de commande).
	if _courriel_message | curl -sS --fail --max-time 60 --ssl-reqd --url "smtps://$SHH_ALERTE_SMTP_HOST:465" \
		--mail-from "$de" --mail-rcpt "$SHH_ALERTE_A" --upload-file - \
		-K <(printf 'user = "%s:%s"\n' "$SHH_ALERTE_SMTP_USER" "$(cat "$mdp")") >/dev/null; then
		return 0
	fi
	printf 'alerte : envoi de « %s » impossible (SMTP), nouvel essai au prochain passage\n' "$cle" >&2
	return 1
}

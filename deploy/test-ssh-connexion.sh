#!/usr/bin/env bash
# Banc d'essai de deploy/ssh-connexion.sh (make lint-deploy) : une copie du script, à côté d'un
# faux courriel.sh qui écrit le message dans un fichier, est lancée comme le ferait pam_exec.
# On vérifie : e-mail avec l'heure, le compte et l'empreinte de la clé, SANS adresse IP même si
# PAM_RHOST et SSH_CONNECTION sont fournis ; registre de la semaine sans adresse ; rien à la
# fermeture de session ; un envoi qui échoue ou qui traîne ne retient pas la connexion ; aucune
# variable de l'environnement de PAM n'atteint l'envoi.
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
w=$(mktemp -d)
trap 'rm -rf -- "$w"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}
IP=198.51.100.23
d=$w/deploy
mkdir -p "$d"
cp "$here/lire-env.sh" "$d/"
# Registre de la copie : dans le dossier d'essai.
sed "s|^registre=/var/lib/shhdrop-ssh/connexions\$|registre=$w/registre/connexions|" "$here/ssh-connexion.sh" >"$d/ssh-connexion.sh"
grep -q "^registre=$w/registre/connexions\$" "$d/ssh-connexion.sh" || ko "registre : ligne introuvable dans ssh-connexion.sh"
printf 'SHH_ALERTE_A=alerte@exemple.test\n' >"$d/.env"
chmod 0644 "$d/.env"
# Faux envoi : écrit l'objet, le texte et l'environnement reçu ; sinon attend ou échoue.
cat >"$d/courriel.sh" <<EOF
courriel_envoyer() {
	case \$(cat "$w/mode" 2>/dev/null) in
	lent) sleep 20 ;;
	echec) return 1 ;;
	esac
	{ printf 'OBJET %s\n%s\n' "\$4" "\$3"; env; } >>"$w/courriel"
}
EOF
ssh-keygen -t ed25519 -N '' -q -f "$w/cle" -C proprietaire
empreinte=$(ssh-keygen -l -f "$w/cle.pub" | awk '{print $2}')
auth="publickey $(cut -d' ' -f1,2 "$w/cle.pub")"

# pam <type> : lance la copie comme pam_exec (environnement de PAM, avec l'adresse du client).
pam() {
	env -i PATH="$PATH" PAM_TYPE="$1" PAM_USER=debian PAM_SERVICE=sshd PAM_RHOST="$IP" \
		SSH_CONNECTION="$IP 51000 192.0.2.1 22" SSH_CLIENT="$IP 51000 22" SSH_AUTH_INFO_0="$auth" \
		BASH_ENV="$w/piege" SHH_COURRIEL_ENVOI="touch $w/piege-envoi" \
		/bin/bash -p "$d/ssh-connexion.sh"
}
printf 'touch %s/piege-lu\n' "$w" >"$w/piege"
attendre() { # <fichier> : jusqu'à 10 s

	for _ in $(seq 1 50); do
		[ -s "$1" ] && return 0
		sleep 0.2
	done
	return 1
}

# 1. Ouverture de session : e-mail, sans IP.
debut=$(date +%s)
pam open_session || ko "ouverture : code $?"
attendre "$w/courriel" || ko "ouverture : aucun e-mail"
grep -q "^OBJET Shhgone Connexion SSH : debian, " "$w/courriel" || ko "ouverture : objet ($(head -1 "$w/courriel"))"
grep -q "^Compte : debian$" "$w/courriel" || ko "ouverture : compte"
grep -qF "Clé utilisée : $empreinte" "$w/courriel" || ko "ouverture : empreinte de la clé ($empreinte)"
grep -q "^Heure : $(date -u +%Y-%m-%d)" "$w/courriel" || ko "ouverture : heure"
grep -qF "$IP" "$w/courriel" && ko "ouverture : adresse IP dans l'e-mail ou dans l'environnement de l'envoi"
grep -q '^PAM_\|^SSH_AUTH_INFO\|^BASH_ENV\|^SHH_COURRIEL' "$w/courriel" && ko "ouverture : environnement de PAM transmis à l'envoi"
[ ! -e "$w/piege-lu" ] || ko "ouverture : BASH_ENV lu"
[ ! -e "$w/piege-envoi" ] || ko "ouverture : commande d'essai venue de PAM exécutée"
attendre "$w/registre/connexions" || ko "registre : vide"
grep -qE "^[0-9]+ debian SHA256:" "$w/registre/connexions" || ko "registre : $(cat "$w/registre/connexions")"
grep -qF "$IP" "$w/registre/connexions" && ko "registre : adresse IP"
[ "$(stat -c %a "$w/registre")" = 700 ] || ko "registre : droits du dossier"

# 2. Fermeture de session : rien.
: >"$w/courriel"
pam close_session || ko "fermeture : code $?"
sleep 1
[ ! -s "$w/courriel" ] || ko "fermeture : e-mail envoyé"

# 3. Envoi qui traîne (20 s) : la connexion n'attend pas ; envoi qui échoue : code 0.
echo lent >"$w/mode"
debut=$(date +%s%N)
pam open_session || ko "lent : code $?"
duree=$((($(date +%s%N) - debut) / 1000000))
[ "$duree" -lt 2000 ] || ko "lent : la connexion a attendu ${duree} ms"
echo echec >"$w/mode"
pam open_session || ko "echec : code non nul"
# Sans deploy/.env : rien n'est envoyé, code 0.
rm -f "$d/.env"
: >"$w/mode"
pam open_session || ko "sans-env : code non nul"

# 4. Connexion sans clé publique, compte bizarre : ni plantage ni injection.
printf 'SHH_ALERTE_A=alerte@exemple.test\n' >"$d/.env"
chmod 0644 "$d/.env"
: >"$w/courriel"
env -i PATH="$PATH" PAM_TYPE=open_session PAM_USER=$'x\nSubject: faux' PAM_RHOST="$IP" /bin/bash -p "$d/ssh-connexion.sh" || ko "sans-cle : code"
attendre "$w/courriel" || ko "sans-cle : aucun e-mail"
grep -q "^Compte : inconnu$" "$w/courriel" || ko "sans-cle : compte non nettoyé"
grep -q "Clé utilisée : inconnue" "$w/courriel" || ko "sans-cle : empreinte"
grep -q "^Subject: faux" "$w/courriel" && ko "sans-cle : en-tête injecté"
grep -qF "$IP" "$w/courriel" && ko "sans-cle : adresse IP"

[ "$echec" = 0 ] && printf 'test-ssh-connexion : ok\n'
exit "$echec"

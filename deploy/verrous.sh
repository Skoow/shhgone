#!/usr/bin/env bash
# Verrous de mise en ligne (décision du propriétaire du 25 novembre ; README §3.5, spec §28.7) :
# contre un compte GitHub volé qui pousserait un code piégé que le propriétaire installerait
# ensuite par erreur. Trois verrous, tous obligatoires, sans option, variable ni commande pour
# les sauter :
#   V1  le commit installé (champ « commit » du release.json vérifié) est dans la copie du dépôt
#       et signé par une clé du fichier des signataires autorisés ; chaque commit depuis le
#       commit installé précédent aussi (fusions comprises) ;
#   V2  aucune histoire réécrite : le commit installé précédent est un ancêtre du nouveau ;
#   V3  le propriétaire confirme le commit exact (40 chiffres hexadécimaux, donnés par la
#       conversation de développement, un autre canal que GitHub) : il doit être celui du
#       manifeste signé.
# Fichier chargé par deploy.sh (après deploy/.env : les constantes ci-dessous, en lecture seule,
# ne peuvent pas venir de lui) et par le banc d'essai deploy/test-verrous.sh (make lint-deploy).
# Chaque fonction reçoit ses chemins et le propriétaire attendu en argument : le banc d'essai lui
# donne un dépôt, des clés et des fichiers temporaires. deploy.sh passe toujours les constantes.
# Aucun accès réseau ici : la copie du dépôt est mise à jour par l'exploitant (git fetch).

# Fichier des signataires autorisés (format allowedSignersFile de git, signatures SSH) et commit
# installé : hors de la copie du dépôt, à root, modifiables par root seulement.
# shellcheck disable=SC2034 # lue par deploy.sh
readonly VERROUS_SIGNATAIRES=/etc/shhdrop/signataires-autorises
readonly VERROUS_COMMIT_INSTALLE=/etc/shhdrop/commit-installe
# Résumé des changements : lignes de « git log --oneline » et fichiers de « git diff --stat » au plus.
readonly VERROUS_RESUME_MAX=30

# commit_valide <commit> : 40 chiffres hexadécimaux en minuscules (jamais une forme courte).
commit_valide() {
	[[ $1 =~ ^[0-9a-f]{40}$ ]]
}

# git_sur <dépôt> <signataires> <arguments de git…> : git sans configuration du système ni de
# l'utilisateur (donc sans safe.directory : la copie doit appartenir au compte qui lance
# deploy.sh), sans variable GIT_* héritée (deploy/.env est exporté), sans crochet, sans
# fsmonitor ni pager. Vérification des signatures : SSH seulement, par ssh-keygen et le fichier
# des signataires ; gpg et x509 sont remplacés par « false » (une signature GPG, celle des
# modifications faites sur le site de GitHub par exemple, n'est donc jamais « bonne », même si
# une clé de confiance traîne dans un trousseau de la machine).
git_sur() {
	local depot=$1 signataires=$2 v
	shift 2
	(
		for v in $(compgen -e GIT_ || true); do unset "$v"; done
		export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 LC_ALL=C
		exec git -C "$depot" \
			-c gpg.ssh.program=ssh-keygen -c "gpg.ssh.allowedSignersFile=$signataires" \
			-c gpg.program=false -c gpg.x509.program=false \
			-c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false \
			-c core.quotePath=true "$@"
	)
}

# sans_controle : retire les caractères de contrôle (sauf tabulation et fin de ligne) d'un texte
# venu du dépôt (sujets de commit, noms de fichiers) avant de l'afficher dans le terminal de root.
sans_controle() {
	LC_ALL=C tr -d '\000-\010\013-\037\177'
}

# droits_surs <chemin> <uid> <masque octal interdit> : appartient à <uid>, n'est pas un lien, et
# aucun bit du masque n'est posé. Écrit le problème et rend 1 sinon.
droits_surs() {
	local f=$1 uid=$2 masque=$3 u m
	if [ -L "$f" ]; then
		echo "$f : lien symbolique refusé" >&2
		return 1
	fi
	read -r u m < <(stat -c '%u %a' -- "$f") || return 1
	if [ "$u" != "$uid" ]; then
		echo "$f : appartient au compte $u, pas à $uid" >&2
		return 1
	fi
	if ((8#$m & 8#$masque)); then
		echo "$f : droits $m trop larges (fichier : 0644 au plus ; dossier : ni groupe ni autres en écriture)" >&2
		return 1
	fi
}

# fichier_sur <fichier> <uid> : fichier ordinaire, à <uid>, droits 0644 au plus ; son dossier à
# <uid>, ni groupe ni autres en écriture.
fichier_sur() {
	local f=$1 uid=$2 d
	d=$(dirname -- "$f")
	if [ ! -d "$d" ] || ! droits_surs "$d" "$uid" 022; then
		echo "$d : dossier absent ou mal réglé (install -d -o root -g root -m 0755 $d, README §3.5)" >&2
		return 1
	fi
	if [ ! -L "$f" ] && [ ! -f "$f" ]; then
		echo "$f : pas un fichier ordinaire" >&2
		return 1
	fi
	droits_surs "$f" "$uid" 7133
}

# controle_signataires <fichier> <uid> : le fichier des signataires est là, bien réglé, et nomme
# au moins une clé.
controle_signataires() {
	local f=$1 uid=$2
	if [ ! -e "$f" ] && [ ! -L "$f" ]; then
		echo "$f absent : y mettre la ligne des signataires autorisés (README §3.5), à root, mode 0644" >&2
		return 1
	fi
	fichier_sur "$f" "$uid" || {
		echo "$f mal réglé : chown root:root $f && chmod 0644 $f (README §3.5)" >&2
		return 1
	}
	grep -qE '^[^#[:space:]][^[:space:]]*[[:space:]].*ssh-' -- "$f" || {
		echo "$f : aucune clé (ligne « principal namespaces=\"git\" ssh-… », README §3.5)" >&2
		return 1
	}
}

# lire_commit_installe <fichier> <uid> : écrit le dernier commit installé, ou rien s'il n'y en a
# pas encore (première installation sous verrous). Un fichier présent mais mal réglé ou illisible
# est refusé, jamais pris pour une absence.
lire_commit_installe() {
	local f=$1 uid=$2 c
	if [ ! -e "$f" ] && [ ! -L "$f" ]; then
		return 0
	fi
	fichier_sur "$f" "$uid" || {
		echo "$f mal réglé (écrit par deploy.sh seulement, à root, mode 0644)" >&2
		return 1
	}
	c=$(cat -- "$f")
	if ! commit_valide "$c" || [ "$(stat -c %s -- "$f")" != 41 ]; then
		echo "$f : contenu illisible (un commit de 40 chiffres hexadécimaux attendu)" >&2
		return 1
	fi
	printf '%s' "$c"
}

# ecrire_commit_installe <fichier> <commit> : remplace le fichier d'un coup (mode 0644).
ecrire_commit_installe() {
	local f=$1 c=$2
	commit_valide "$c" || return 1
	(umask 022 && printf '%s\n' "$c" >"$f.tmp") && chmod 0644 -- "$f.tmp" && mv -f -- "$f.tmp" "$f"
}

# objet_commit <dépôt> <signataires> <commit> : le commit est dans la copie du dépôt.
objet_commit() {
	[ "$(git_sur "$1" "$2" rev-parse --verify --quiet "$3^{commit}" 2>/dev/null)" = "$3" ]
}

# verifier_commit <dépôt> <signataires> <installé ou vide> <commit> <suite|retour> :
#   suite  : installation d'un nouveau commit. V1 sur le commit ; puis, s'il y a un commit
#            installé, V2 (ancêtre du nouveau) et V1 sur chaque commit entre les deux, fusions
#            comprises (%G? = G : bonne signature d'un signataire autorisé). Sans commit installé
#            (première installation sous verrous) : V1 sur le commit seulement, dit clairement.
#   retour : retour arrière ou réinstallation d'une image déjà installée. V1 sur le commit, qui
#            doit être le commit installé ou l'un de ses ancêtres (histoire déjà vérifiée).
verifier_commit() {
	local depot=$1 sign=$2 installe=$3 c=$4 mode=$5 err liste n mauvais
	if ! commit_valide "$c"; then
		echo "commit refusé : « $c » (40 chiffres hexadécimaux en minuscules attendus)" >&2
		return 1
	fi
	if ! git_sur "$depot" "$sign" rev-parse --git-dir >/dev/null 2>&1; then
		echo "$depot : copie du dépôt illisible par git (elle doit appartenir au compte qui lance deploy.sh : chown -R root:root, README §3.5)" >&2
		return 1
	fi
	if ! objet_commit "$depot" "$sign" "$c"; then
		echo "commit $c absent de la copie du dépôt : git fetch origin, puis relancer (README §3.5)" >&2
		return 1
	fi
	# V1 : le commit lui-même.
	if ! err=$(git_sur "$depot" "$sign" verify-commit "$c" 2>&1); then
		echo "V1 : le commit $c n'est pas signé par une clé autorisée ($sign) :" >&2
		printf '%s\n' "$err" | head -n 5 | sans_controle >&2
		return 1
	fi
	if [ -z "$installe" ]; then
		if [ "$mode" != suite ]; then
			echo "aucun commit installé ($VERROUS_COMMIT_INSTALLE absent) : retour arrière impossible sous verrous" >&2
			return 1
		fi
		echo "PREMIÈRE installation sous verrous ($VERROUS_COMMIT_INSTALLE absent) : seule la signature du commit $c est vérifiée (V1), pas l'histoire qui le précède (V2)."
		return 0
	fi
	if ! objet_commit "$depot" "$sign" "$installe"; then
		echo "V2 : le commit installé $installe est absent de la copie du dépôt (histoire réécrite ?)" >&2
		return 1
	fi
	if [ "$mode" = retour ]; then
		git_sur "$depot" "$sign" merge-base --is-ancestor "$c" "$installe" || {
			echo "V2 : $c n'est ni le commit installé ($installe) ni l'un de ses ancêtres : retour arrière refusé" >&2
			return 1
		}
		return 0
	fi
	# V2 : aucune histoire réécrite.
	git_sur "$depot" "$sign" merge-base --is-ancestor "$installe" "$c" || {
		echo "V2 : histoire réécrite : le commit installé $installe n'est pas un ancêtre de $c (installation refusée ; jamais de retour en arrière par une autre branche, README §3.5)" >&2
		return 1
	}
	# V1 sur chaque commit de l'intervalle (fusions et leurs branches comprises).
	if ! liste=$(git_sur "$depot" "$sign" log --format='%H %G?' "$installe..$c" 2>/dev/null); then
		echo "V1 : histoire de $installe à $c illisible" >&2
		return 1
	fi
	n=$(printf '%s\n' "$liste" | grep -c . || true)
	mauvais=$(printf '%s\n' "$liste" | grep -vE '^[0-9a-f]{40} G$' | grep . || true)
	if [ -n "$mauvais" ]; then
		echo "V1 : commit(s) entre $installe et $c sans bonne signature d'une clé autorisée (G attendu ; N : aucune, U ou E : clé inconnue, B : mauvaise) :" >&2
		printf '%s\n' "$mauvais" | head -n "$VERROUS_RESUME_MAX" | sans_controle >&2
		return 1
	fi
	echo "verrous : $c signé par une clé autorisée, descendant de $installe, $n commit(s) signés entre les deux."
}

# controle_commit_annonce <release.json vérifié> <commit> : V3, le commit confirmé par le
# propriétaire est celui du manifeste signé.
controle_commit_annonce() {
	local m
	m=$(commit_du_manifeste "$1") || return 1
	if [ "$m" != "$2" ]; then
		echo "V3 : le manifeste signé nomme le commit $m, pas celui donné ($2) : installation refusée" >&2
		return 1
	fi
}

# copie_au_commit <dépôt> <signataires> <commit> : HEAD de la copie est ce commit, et aucun
# fichier suivi n'est modifié (Caddyfile, compose.yaml, deploy.sh… sont ceux du commit vérifié).
copie_au_commit() {
	local depot=$1 sign=$2 c=$3 head modifs
	head=$(git_sur "$depot" "$sign" rev-parse --verify --quiet HEAD) || head=
	if [ "$head" != "$c" ]; then
		echo "copie du dépôt sur ${head:-?}, pas sur le commit $c" >&2
		return 1
	fi
	modifs=$(git_sur "$depot" "$sign" status --porcelain --untracked-files=no) || {
		echo "copie du dépôt : git status illisible" >&2
		return 1
	}
	if [ -n "$modifs" ]; then
		echo "copie du dépôt : fichiers suivis modifiés (git status), à remettre comme au commit (git checkout -- <fichier>) :" >&2
		printf '%s\n' "$modifs" | head -n "$VERROUS_RESUME_MAX" | sans_controle >&2
		return 1
	fi
}

# copie_verifiee <dépôt> <signataires> <installé> : pour un retour arrière ou une réinstallation,
# la copie (Caddyfile, compose.yaml, deploy.sh…) est sur le commit installé, ou sur un descendant
# qui passe V1 et V2 (après une installation qui a échoué au contrôle, la copie reste sur le
# nouveau commit, vérifié), sans fichier suivi modifié.
copie_verifiee() {
	local depot=$1 sign=$2 installe=$3 head
	head=$(git_sur "$depot" "$sign" rev-parse --verify --quiet HEAD) || head=
	if [ "$head" != "$installe" ] && ! verifier_commit "$depot" "$sign" "$installe" "$head" suite >/dev/null; then
		echo "copie du dépôt sur ${head:-?}, ni le commit installé $installe ni un descendant vérifié" >&2
		return 1
	fi
	copie_au_commit "$depot" "$sign" "$head"
}

# avancer_copie <dépôt> <signataires> <installé ou vide> <commit> : avance la copie au commit,
# déjà vérifié par verifier_commit (git merge --ff-only, sans réseau). Exige une copie propre
# sur le commit installé (le deploy.sh qui fait les vérifications est alors celui d'un commit
# vérifié), ou, à la première installation, sur un ancêtre du commit.
avancer_copie() {
	local depot=$1 sign=$2 installe=$3 c=$4 head
	head=$(git_sur "$depot" "$sign" rev-parse --verify --quiet HEAD) || head=
	if [ -n "$installe" ] && [ "$head" != "$installe" ]; then
		echo "copie du dépôt sur ${head:-?}, pas sur le commit installé $installe (git pull ?) : le deploy.sh qui tourne n'est pas celui d'un commit vérifié. Revenir au commit installé (git reset --hard $installe), git fetch origin, puis relancer (README §3.5)" >&2
		return 1
	fi
	copie_au_commit "$depot" "$sign" "$head" 2>/dev/null || {
		echo "copie du dépôt : fichiers suivis modifiés (git status) : rien n'est avancé" >&2
		return 1
	}
	git_sur "$depot" "$sign" merge-base --is-ancestor "$head" "$c" || {
		echo "copie du dépôt sur $head, qui n'est pas un ancêtre de $c : rien n'est avancé" >&2
		return 1
	}
	git_sur "$depot" "$sign" merge --ff-only --quiet "$c" >/dev/null || {
		echo "copie du dépôt : git merge --ff-only $c impossible" >&2
		return 1
	}
	copie_au_commit "$depot" "$sign" "$c"
}

# resume_changements <dépôt> <signataires> <installé ou vide> <commit> : ce qui change depuis le
# commit installé, borné (VERROUS_RESUME_MAX lignes de journal et de fichiers), sans caractère
# de contrôle.
resume_changements() {
	local depot=$1 sign=$2 installe=$3 c=$4 n stat lignes
	if [ -z "$installe" ]; then
		echo "commit à installer (première installation sous verrous, aucun résumé d'histoire) :"
		git_sur "$depot" "$sign" log -1 --oneline --no-decorate "$c" | sans_controle
		return 0
	fi
	if [ "$installe" = "$c" ]; then
		echo "aucun changement : $c est déjà le commit installé."
		return 0
	fi
	n=$(git_sur "$depot" "$sign" rev-list --count "$installe..$c")
	echo "changements depuis le commit installé $installe ($n commit(s)) :"
	git_sur "$depot" "$sign" log --oneline --no-decorate -n "$VERROUS_RESUME_MAX" "$installe..$c" | sans_controle
	if [ "$n" -gt "$VERROUS_RESUME_MAX" ]; then echo "… et $((n - VERROUS_RESUME_MAX)) autre(s)"; fi
	stat=$(git_sur "$depot" "$sign" diff --stat=100 --no-ext-diff --no-textconv "$installe" "$c" | sans_controle)
	lignes=$(printf '%s\n' "$stat" | grep -c . || true)
	if [ "$lignes" -gt $((VERROUS_RESUME_MAX + 1)) ]; then
		printf '%s\n' "$stat" | head -n "$VERROUS_RESUME_MAX"
		echo " … et $((lignes - 1 - VERROUS_RESUME_MAX)) autre(s) fichier(s)"
		printf '%s\n' "$stat" | tail -n 1
	else
		printf '%s\n' "$stat"
	fi
}

# --- Préproduction (README §15) -----------------------------------------------------------------
# Jeton de préproduction : 64 chiffres hexadécimaux tirés sur le serveur, accepté par Caddy à la
# place d'un mot de passe : en-tête X-Shh-Preprod (contrôles de deploy.sh et preprod.sh) ou
# témoin posé par le lien /acces/<jeton> (navigateurs du propriétaire). Hors de la copie du
# dépôt, jamais dans deploy/.env ni dans git ; lu par root seulement (deploy.sh, preprod.sh), donné
# à Caddy par son environnement. En lecture seule, comme les constantes ci-dessus (fichier chargé
# après deploy/.env).
# shellcheck disable=SC2034 # lue par commun.sh
readonly PREPROD_JETON_FICHIER=/etc/shhdrop/preprod-jeton

# lire_jeton_preprod <fichier> <uid> : écrit le jeton. Le fichier est ordinaire (pas un lien), à
# <uid>, droits 0600 ou 0400 ; son dossier à <uid>, ni groupe ni autres en écriture ; contenu :
# 64 chiffres hexadécimaux en minuscules et une fin de ligne, rien d'autre.
lire_jeton_preprod() {
	local f=$1 uid=$2 d j
	d=$(dirname -- "$f")
	if [ ! -e "$f" ] && [ ! -L "$f" ]; then
		echo "$f absent : (umask 077 && openssl rand -hex 32 >$f) (README §15)" >&2
		return 1
	fi
	if [ ! -d "$d" ] || ! droits_surs "$d" "$uid" 022 || [ -L "$f" ] || [ ! -f "$f" ] || ! droits_surs "$f" "$uid" 7177; then
		echo "$f mal réglé : fichier ordinaire à root, chmod 0600 $f (README §15)" >&2
		return 1
	fi
	j=$(cat -- "$f")
	if ! [[ $j =~ ^[0-9a-f]{64}$ ]] || [ "$(stat -c %s -- "$f")" != 65 ]; then
		echo "$f : contenu illisible (64 chiffres hexadécimaux attendus : openssl rand -hex 32)" >&2
		return 1
	fi
	printf '%s' "$j"
}

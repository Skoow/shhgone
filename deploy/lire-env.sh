#!/usr/bin/env bash
# Lecture de deploy/.env SANS l'exécuter (commun.sh, alerte.sh, sauvegarder.sh, tous en root) :
# avant, le fichier était chargé par « . .env », donc exécuté par root ; une ligne glissée dedans
# aurait tourné en root. Il est maintenant lu ligne à ligne, en NOM=valeur, et refusé (code 1,
# raison sur la sortie d'erreur, numéro de ligne et nom, jamais la valeur) s'il :
#   - n'est pas un fichier ordinaire (lien refusé), n'appartient pas au compte qui le lit (root
#     sur le serveur) ou est modifiable par le groupe ou les autres ;
#   - contient une ligne autre que : vide, commentaire (#…), ou [export ]SHH_…=valeur.
# Valeur : brute (sans espace ni aucun de " ' \ $ ` ; & | < > ( ), un « # » précédé d'une espace
# commence un commentaire), entre guillemets doubles (sans " \ $ `) ou simples (sans '). Ces
# formes donnent la même valeur au shell d'avant et à Docker Compose, qui lit aussi ce fichier
# (substitution de compose.yaml) : rien de ce qu'il accepte ne change de sens. Seules les
# variables SHH_… sont lues : ni PATH, ni LD_PRELOAD, ni COMPOSE_FILE, ni une variable interne
# des scripts (en minuscules).
#
#   lire_env <fichier> <exporter 0|1>

lire_env() {
	local f=$1 exporter=$2 u m n=0 ligne nom val
	if [ -L "$f" ] || [ ! -f "$f" ]; then
		echo "$f : fichier ordinaire attendu (pas un lien)" >&2
		return 1
	fi
	read -r u m < <(stat -c '%u %a' -- "$f") || return 1
	if [ "$u" != "$(id -u)" ]; then
		echo "$f : appartient au compte $u, pas à $(id -un) : chown root:root $f" >&2
		return 1
	fi
	if ((8#$m & 8#022)); then
		echo "$f : modifiable par d'autres comptes (droits 0$m) : chmod 0644 $f (ou 0600)" >&2
		return 1
	fi
	while IFS= read -r ligne || [ -n "$ligne" ]; do
		n=$((n + 1))
		ligne=${ligne%$'\r'}
		[[ $ligne =~ ^[[:space:]]*(#.*)?$ ]] && continue
		if ! [[ $ligne =~ ^(export[[:space:]]+)?(SHH_[A-Z0-9_]+)=(.*)$ ]]; then
			if [[ $ligne =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]]; then
				echo "$f, ligne $n : ${BASH_REMATCH[2]} refusée (seules les variables SHH_… sont lues)" >&2
			else
				echo "$f, ligne $n : forme NOM=valeur attendue" >&2
			fi
			return 1
		fi
		nom=${BASH_REMATCH[2]} val=${BASH_REMATCH[3]}
		if [[ $val =~ ^\"([^\"\\\$\`]*)\"[[:space:]]*(#.*)?$ ]]; then
			val=${BASH_REMATCH[1]}
		elif [[ $val =~ ^\'([^\']*)\'[[:space:]]*(#.*)?$ ]]; then
			val=${BASH_REMATCH[1]}
		else
			[[ $val =~ ^([^[:space:]]*)([[:space:]]+#.*)?[[:space:]]*$ ]] && val=${BASH_REMATCH[1]}
			if [[ $val =~ [[:space:]\"\'\\\$\`\;\&\|\<\>\(\)] ]]; then
				echo "$f, ligne $n : $nom : valeur refusée (espace, guillemet, \$, \`, \\, ; & | < > ( ) : mettre la valeur entre guillemets simples)" >&2
				return 1
			fi
		fi
		printf -v "$nom" '%s' "$val" || return 1
		if [ "$exporter" = 1 ]; then export "${nom?}"; fi
	done <"$f"
}

#!/usr/bin/env bash
# Résultats de gosec et de Semgrep comparés aux exceptions motivées (job gosec et semgrep de
# .github/workflows/securite.yml ; README §8, « Vérification de sécurité hebdomadaire »).
#
#   deploy/analyse-acceptes.sh gosec|semgrep <rapport JSON> <fichier des acceptés>
#
# Chaque résultat devient une clé « règle <tab> fichier <tab> ligne de code » (ligne du fichier,
# espaces resserrés : la clé suit le code quand des lignes sont ajoutées au-dessus, et redevient
# nouvelle si la ligne elle-même change). Le fichier des acceptés liste ces clés, une par ligne,
# sous un commentaire qui dit pourquoi (faux positif, risque assumé) ; une même ligne de code
# présente deux fois s'y écrit deux fois. Code 1 : au moins un résultat nouveau (listé) ; une
# exception qui ne sert plus est seulement signalée (à retirer). Exécuté depuis la racine du dépôt.
# Aucune exception globale : ni règle coupée partout, ni dossier exclu.
set -euo pipefail
export LC_ALL=C.UTF-8
[ $# -eq 3 ] || {
	echo "usage: analyse-acceptes.sh gosec|semgrep <rapport JSON> <acceptés>" >&2
	exit 2
}
outil=$1 rapport=$2 acceptes=$3
racine=$(pwd)
command -v jq >/dev/null 2>&1 || {
	echo "jq exigé" >&2
	exit 2
}
w=$(mktemp -d)
trap 'rm -rf -- "$w"' EXIT

case $outil in
gosec)
	# Une erreur de compilation ou d'analyse n'est pas « rien trouvé ».
	if [ "$(jq '."Golang errors" | length' "$rapport")" != 0 ]; then
		echo "gosec : erreurs d'analyse :" >&2
		jq -r '."Golang errors"' "$rapport" >&2
		exit 1
	fi
	jq -r '.Issues[] | [.rule_id, .file, (.line | split("-")[0])] | @tsv' "$rapport" >"$w/brut"
	;;
semgrep)
	jq -r '.results[] | [(.check_id | split(".") | last), .path, (.start.line | tostring)] | @tsv' "$rapport" >"$w/brut"
	;;
*)
	echo "outil inconnu : $outil" >&2
	exit 2
	;;
esac

while IFS=$'\t' read -r regle fichier ligne; do
	fichier=${fichier#"$racine"/}
	code=$(sed -n "${ligne}p" "$fichier" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
	printf '%s\t%s\t%s\n' "$regle" "$fichier" "$code"
done <"$w/brut" | sort >"$w/trouves"
grep -v '^#' "$acceptes" | grep . | sort >"$w/acceptes" || true

# Multiensembles : comm sur des lignes numérotées par occurrence.
numerote() { awk -F'\t' '{n[$0]++; print $0 "\t#" n[$0]}' "$1" | sort; }
numerote "$w/trouves" >"$w/t"
numerote "$w/acceptes" >"$w/a"
comm -23 "$w/t" "$w/a" | sed 's/\t#[0-9]*$//' >"$w/nouveaux"
comm -13 "$w/t" "$w/a" | sed 's/\t#[0-9]*$//' >"$w/inutiles"

echo "$outil : $(wc -l <"$w/trouves") résultat(s), $(wc -l <"$w/acceptes") exception(s) motivée(s) dans $acceptes"
if [ -s "$w/inutiles" ]; then
	echo "$outil : exception(s) qui ne servent plus (code corrigé ou changé : à retirer de $acceptes) :"
	sed 's/^/  /' "$w/inutiles"
fi
if [ -s "$w/nouveaux" ]; then
	echo "::error::$outil : $(wc -l <"$w/nouveaux") résultat(s) nouveau(x) : corriger (avec un test), ou, faux positif, ajouter la ligne à $acceptes sous un commentaire qui dit pourquoi :"
	sed 's/^/  /' "$w/nouveaux"
	exit 1
fi
echo "$outil : aucun résultat nouveau"

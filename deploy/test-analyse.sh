#!/usr/bin/env bash
# Banc d'essai de deploy/analyse-acceptes.sh (make lint-deploy) : rapports gosec et Semgrep
# factices. Accepté → succès ; nouveau résultat (ou une occurrence de plus d'une ligne acceptée
# une fois) → échec qui le liste ; exception inutile → dite, sans échec ; erreur d'analyse de
# gosec → échec.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
w=$(mktemp -d)
trap 'rm -rf -- "$w"' EXIT
echec=0
ko() {
	printf 'ÉCHEC : %s\n' "$*" >&2
	echec=1
}
cd "$w"
mkdir -p server
printf 'package x\n\nfunc f() {\n\tdb.Close()\n\tdb.Close()\n\tos.Remove(p)\n}\n' >server/x.go
issue() { printf '{"rule_id":"%s","file":"%s/server/x.go","line":"%s"}' "$1" "$w" "$2"; }
printf '{"Golang errors":{},"Issues":[%s,%s,%s]}\n' "$(issue G104 4)" "$(issue G104 5)" "$(issue G104 6)" >g.json
printf '# G104 : motif\nG104\tserver/x.go\tdb.Close()\nG104\tserver/x.go\tdb.Close()\nG104\tserver/x.go\tos.Remove(p)\n' >ok.txt
"$here/analyse-acceptes.sh" gosec g.json ok.txt >o1 || ko "acceptés : échec ($(cat o1))"
# Une seule occurrence acceptée de db.Close() : la seconde est nouvelle.
printf 'G104\tserver/x.go\tdb.Close()\nG104\tserver/x.go\tos.Remove(p)\n' >un.txt
if "$here/analyse-acceptes.sh" gosec g.json un.txt >o2; then ko "doublon : accepté"; fi
grep -qF "G104	server/x.go	db.Close()" o2 || ko "doublon : non listé ($(cat o2))"
# Exception inutile : dite, sans échec.
printf 'G104\tserver/x.go\tdb.Close()\nG104\tserver/x.go\tdb.Close()\nG104\tserver/x.go\tos.Remove(p)\nG304\tserver/x.go\tvieux()\n' >trop.txt
"$here/analyse-acceptes.sh" gosec g.json trop.txt >o3 || ko "inutile : échec"
grep -q "ne servent plus" o3 || ko "inutile : non dit"
# La clé suit le code : une ligne ajoutée au-dessus ne change rien.
sed -i '3a\\t// commentaire' server/x.go
printf '{"Golang errors":{},"Issues":[%s,%s,%s]}\n' "$(issue G104 5)" "$(issue G104 6)" "$(issue G104 7)" >g2.json
"$here/analyse-acceptes.sh" gosec g2.json ok.txt >o4 || ko "décalage : échec ($(cat o4))"
# Erreur d'analyse : échec.
printf '{"Golang errors":{"x":[{"error":"ne compile pas"}]},"Issues":[]}\n' >e.json
if "$here/analyse-acceptes.sh" gosec e.json ok.txt >o5 2>&1; then ko "erreur d'analyse : acceptée"; fi
# Semgrep : chemin relatif, identifiant court de la règle.
printf '{"results":[{"check_id":"go.lang.security.audit.x.regle-y","path":"server/x.go","start":{"line":7}}]}\n' >s.json
printf 'regle-y\tserver/x.go\tos.Remove(p)\n' >s.txt
"$here/analyse-acceptes.sh" semgrep s.json s.txt >o6 || ko "semgrep : échec ($(cat o6))"
if "$here/analyse-acceptes.sh" semgrep s.json /dev/null >o7; then ko "semgrep : nouveau accepté"; fi

[ "$echec" = 0 ] && printf 'test-analyse : ok\n'
exit "$echec"

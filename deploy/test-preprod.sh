#!/usr/bin/env bash
# Banc d'essai de la barrière de préproduction du Caddyfile (README §15), sur la boucle locale :
# le Caddyfile de production (plus les 2 lignes de l'autorité interne, comme test-proxy.sh) devant
# un amont « écho » qui rend la méthode, le chemin et les en-têtes reçus. Lancé par
# test-proxy.sh, ou seul :
#   CADDY=/chemin/vers/caddy deploy/test-preprod.sh      (Caddy de l'image épinglée de compose.yaml)
#   PORT_BASE=…  premier de 7 ports locaux libres (défaut : 18460) ; KEEP=1 garde le dossier
# Exige caddy, curl et python3 (empreinte du <style> de la page).
#
# Ce qui est prouvé :
#   1. SHH_PREPROD hors de 0 et 1 : Caddy refuse la configuration ;
#   2. public : toute requête (navigation, API, requête d'un autre site, chemins en majuscules,
#      faux lien d'accès) reçoit la page de maintenance, octet pour octet deploy/maintenance.html,
#      en 503, avec Retry-After, X-Robots-Tag, Cache-Control: no-store, X-Shhdrop-Etat:
#      maintenance, les en-têtes de sécurité, et une CSP dont l'empreinte est celle du <style> ;
#   3. /acces/<jeton> : 303 vers / et le témoin __Host-shh_preprod (Secure, HttpOnly,
#      SameSite=Lax, 30 jours), rien relayé à l'amont ; faux jeton, jeton en majuscules, tronqué,
#      vide : 503, aucun témoin ;
#   4. le témoin ou l'en-tête X-Shh-Preprod portant le jeton : relayé, Authorization: Bearer
#      compris (transmis tel quel) ; témoin ou en-tête faux, tronqué, vide : maintenance ; ni le
#      jeton ni le témoin n'atteignent l'amont ; jeton vide dans la configuration : rien ne passe ;
#   5. webhooks des trois prestataires (POST, chemin exact) : relayés sans témoin ; GET, autre
#      nom, majuscules, suffixe : maintenance ;
#   6. Sec-Fetch-Site: same-origin sans témoin (en-tête forgeable, risque PP1) : maintenance, quel
#      que soit Sec-Fetch-Mode ; avec le témoin : relayé ;
#   7. aucun cache en préproduction : Cache-Control de l'amont (immutable) remplacé par no-store,
#      une seule valeur ; sans préproduction (SHH_PREPROD absent), Cache-Control de l'amont
#      inchangé, ni marqueur, /acces/<jeton> relayé comme tout chemin, aucun témoin posé.
# Pas prouvé ici : un vrai navigateur (WebAuthn, WebSocket du salon derrière la barrière : voir
# README §15), le serveur Go réel derrière la barrière (test-proxy.sh le fait sans barrière).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
caddy=${CADDY:-caddy}
base=${PORT_BASE:-18460}
p_echo=$base p_http=$((base + 1)) p_https=$((base + 2)) p_http0=$((base + 3)) p_https0=$((base + 4))
p_httpv=$((base + 5)) p_httpsv=$((base + 6))
name=shhdrop.test
jeton=$(printf 'a%063d' 0 | tr 0 7) # 64 chiffres hexadécimaux, propre au banc
faux=${jeton%?}0

fails=0
ok() { printf 'ok    %s\n' "$1"; }
ko() {
	printf 'ÉCHEC %s\n' "$1"
	fails=$((fails + 1))
}
check() { # check <description> <commande…>
	local d=$1
	shift
	if "$@" >/dev/null 2>&1; then ok "$d"; else ko "$d"; fi
}
die() {
	printf 'erreur: %s\n' "$1" >&2
	exit 2
}
for outil in "$caddy" curl python3; do command -v "$outil" >/dev/null || die "$outil introuvable"; done

work=$(mktemp -d "${TMPDIR:-/tmp}/shh-preprod.XXXXXX")
pids=()
cleanup() {
	for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
	wait 2>/dev/null || true
	if [ "${KEEP:-0}" = 1 ]; then echo "gardé : $work"; else rm -rf "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP PIPE
for port in $(seq "$base" $((base + 6))); do
	if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then die "port $port déjà pris (PORT_BASE=…)"; fi
done

v() { env -i PATH="$PATH" HOME="$work" SHH_DOMAIN=$name "$@" "$caddy" validate --config "$here/Caddyfile" --adapter caddyfile; }
refuse() { ! v "$@"; }

# --- 1. Configuration -------------------------------------------------------------------------
check "SHH_PREPROD=1 avec jeton : configuration valide" v SHH_PREPROD=1 SHH_PREPROD_JETON="$jeton"
check "SHH_PREPROD=oui : configuration refusée" refuse SHH_PREPROD=oui
check "SHH_PREPROD=2 : configuration refusée" refuse SHH_PREPROD=2
check "SHH_PREPROD absent : configuration valide (production)" v

# --- Démarrage --------------------------------------------------------------------------------
sed -e 's/^\tadmin off$/&\n\tskip_install_trust/' \
	-e 's/^\ttls {$/&\n\t\tissuer internal/' "$here/Caddyfile" >"$work/Caddyfile"
[ "$(diff "$here/Caddyfile" "$work/Caddyfile" | grep -c '^>' || true)" = 2 ] || die "Caddyfile de test : production plus 2 lignes attendu"
mkdir -p "$work/echo"
# shellcheck disable=SC2016 # gabarit de Caddy, pas des variables du shell
printf '{{.OriginalReq.Method}} {{.OriginalReq.URL.Path}}\n{{range $k, $v := .Req.Header}}{{$k}}:{{range $v}} [{{.}}]{{end}}\n{{end}}' >"$work/echo/echo.txt"
cat >"$work/echo.Caddyfile" <<EOF
{
	admin off
	persist_config off
	auto_https off
	log default {
		output discard
	}
}
http://:$p_echo {
	bind 127.0.0.1
	header Cache-Control "public, max-age=31536000, immutable"
	root * $work/echo
	method * GET
	rewrite * /echo.txt
	templates
	file_server
}
EOF
ce=(env -i PATH="$PATH" HOME="$work" XDG_CONFIG_HOME="$work/xdg")
lance() { # lance <nom> <port http> <port https> <variables…>
	local n=$1 h=$2 s=$3
	shift 3
	"${ce[@]}" XDG_DATA_HOME="$work/d-$n" SHH_DOMAIN=$name SHH_UPSTREAM="127.0.0.1:$p_echo" SHH_HTTP_PORT="$h" SHH_HTTPS_PORT="$s" \
		SHH_MAINTENANCE="$here/maintenance.html" "$@" "$caddy" run --config "$work/Caddyfile" --adapter caddyfile >"$work/c-$n.log" 2>&1 &
	pids+=($!)
}
"${ce[@]}" XDG_DATA_HOME="$work/d-echo" "$caddy" run --config "$work/echo.Caddyfile" --adapter caddyfile >"$work/echo.log" 2>&1 &
pids+=($!)
lance 1 "$p_http" "$p_https" SHH_PREPROD=1 SHH_PREPROD_JETON="$jeton"
lance 0 "$p_http0" "$p_https0"
lance v "$p_httpv" "$p_httpsv" SHH_PREPROD=1 SHH_PREPROD_JETON=
P=https://$name:$p_https Q=https://$name:$p_https0 V=https://$name:$p_httpsv
cc() { # cc <instance> <port> <arguments de curl…>
	local n=$1 port=$2
	shift 2
	curl -sS --noproxy '*' --max-time 20 --cacert "$work/d-$n/caddy/pki/authorities/local/root.crt" \
		--resolve "$name:$port:127.0.0.1" "$@"
}
c1() { cc 1 "$p_https" "$@"; }
c0() { cc 0 "$p_https0" "$@"; }
cv() { cc v "$p_httpsv" "$@"; }
ready=0
for _ in $(seq 1 100); do
	if c1 -o /dev/null "$P/" 2>/dev/null && c0 -o /dev/null "$Q/" 2>/dev/null && cv -o /dev/null "$V/" 2>/dev/null; then
		ready=1
		break
	fi
	sleep 0.2
done
[ "$ready" = 1 ] || {
	cat "$work"/*.log >&2 || true
	die "démarrage raté"
}
code() { "$@" -o /dev/null -w '%{http_code}'; }
# hdr <fichier> <nom> : valeurs de l'en-tête (une par ligne), sans \r.
hdr() { tr -d '\r' <"$1" | sed -n "s/^$2: //Ip"; }
# maint <curl…> : « code-marqueur » de la réponse.
maint() { "$@" -D "$work/h-m" -o /dev/null -w '%{http_code}' | tr -d '\n'; printf -- '-%s' "$(hdr "$work/h-m" X-Shhdrop-Etat)"; }

# --- 2. Public : page de maintenance ------------------------------------------------------------
c1 -D "$work/h-pub" -o "$work/b-pub" "$P/"
check "public, GET / : 503" grep -q '^HTTP/[0-9.]* 503' "$work/h-pub"
check "public : corps = deploy/maintenance.html (sans le dernier saut de ligne)" cmp "$work/b-pub" <(head -c -1 "$here/maintenance.html")
check "public : X-Shhdrop-Etat: maintenance" test "$(hdr "$work/h-pub" X-Shhdrop-Etat)" = maintenance
check "public : Retry-After: 3600" test "$(hdr "$work/h-pub" Retry-After)" = 3600
check "public : X-Robots-Tag: noindex, nofollow" test "$(hdr "$work/h-pub" X-Robots-Tag)" = "noindex, nofollow"
check "public : Cache-Control: no-store, une seule valeur" test "$(hdr "$work/h-pub" Cache-Control)" = no-store
check "public : Content-Type HTML UTF-8" test "$(hdr "$work/h-pub" Content-Type)" = "text/html; charset=utf-8"
for h in Strict-Transport-Security Referrer-Policy X-Content-Type-Options X-Frame-Options Permissions-Policy \
	Cross-Origin-Opener-Policy Cross-Origin-Resource-Policy Content-Security-Policy; do
	check "public : $h présent une fois" test "$(hdr "$work/h-pub" "$h" | grep -c .)" = 1
done
check "public : ni Server, ni Via, ni Set-Cookie" bash -c "! grep -qiE '^(server|via|set-cookie):' '$work/h-pub'"
style=$(python3 -I -c 'import re,sys,hashlib,base64; s=open(sys.argv[1],encoding="utf-8").read(); print(base64.b64encode(hashlib.sha256(re.search(r"<style>(.*?)</style>",s,re.S).group(1).encode()).digest()).decode())' "$here/maintenance.html")
check "public : CSP sans script, style par l'empreinte de la page (sha256-$style)" \
	test "$(hdr "$work/h-pub" Content-Security-Policy)" = "default-src 'none'; style-src 'sha256-$style'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
check "page de maintenance : ni script ni ressource externe" bash -c "! grep -qiE '<script|src=|href=|@import|url\\(' '$here/maintenance.html'"
for r in "GET /api/captcha" "POST /api/shares" "GET /assets/x.js" "GET /robots.txt" "GET /.well-known/acme-challenge/x" \
	"POST /API/PAIEMENT/WEBHOOK/STRIPE" "GET /api/paiement/webhook/stripe" "POST /api/paiement/webhook/faux" \
	"POST /api/paiement/webhook/stripe/x" "POST /api/paiement/webhook/stripex" "GET /acces/$faux" "GET /acces/${jeton^^}" \
	"GET /acces/${jeton%?}" "GET /acces/" "GET /acces/$jeton/x" "GET /x/acces/$jeton"; do
	read -r m p <<<"$r"
	check "public, $m ${p:0:40} : 503 maintenance" test "$(maint c1 -X "$m" "$P$p")" = 503-maintenance
done
check "navigation depuis une page de l'origine sans témoin (Sec-Fetch-Site: same-origin, navigate) : 503" \
	test "$(maint c1 -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: navigate' "$P/")" = 503-maintenance
check "requête d'un autre site (Sec-Fetch-Site: cross-site, cors) : 503" \
	test "$(maint c1 -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: cors' "$P/api/captcha")" = 503-maintenance
check "requête avec Authorization: Bearer mais sans témoin : 503" \
	test "$(maint c1 -H 'Authorization: Bearer x' "$P/api/shares/segments/0")" = 503-maintenance
check "HTTP → HTTPS inchangé (308)" test "$(curl -sS --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' -H "Host: $name" "http://127.0.0.1:$p_http/x")" = 308

# --- 3. Lien d'accès du propriétaire --------------------------------------------------------------
c1 -D "$work/h-in" -o "$work/b-in" "$P/acces/$jeton"
check "/acces/<jeton> : 303 vers /" bash -c "grep -q '^HTTP/[0-9.]* 303' '$work/h-in' && test \"\$(tr -d '\r' <'$work/h-in' | sed -n 's/^location: //Ip')\" = /"
check "/acces/<jeton> : témoin __Host-shh_preprod=<jeton>, Path=/, 30 jours, Secure, HttpOnly, SameSite=Lax" \
	test "$(hdr "$work/h-in" Set-Cookie)" = "__Host-shh_preprod=$jeton; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax"
check "/acces/<jeton> : rien n'est relayé à l'amont (corps vide), no-store" bash -c "test ! -s '$work/b-in' && test \"\$(tr -d '\r' <'$work/h-in' | sed -n 's/^cache-control: //Ip')\" = no-store"
for p in "$faux" "${jeton^^}" "${jeton%?}" ""; do
	check "/acces/${p:0:12}… : aucun Set-Cookie" bash -c "! curl -sS --noproxy '*' --max-time 20 --cacert '$work/d-1/caddy/pki/authorities/local/root.crt' --resolve '$name:$p_https:127.0.0.1' -D - -o /dev/null '$P/acces/$p' | grep -qiE '^set-cookie:'"
done

# --- 4. Jeton : témoin et en-tête ---------------------------------------------------------------
c1 -H "Cookie: a=1; __Host-shh_preprod=$jeton; b=2" -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: cross-site' \
	-D "$work/h-ck" -o "$work/b-ck" "$P/offres/retour"
check "témoin, navigation venue d'un autre site (retour de paiement) : relayé (200)" grep -q '^HTTP/[0-9.]* 200' "$work/h-ck"
check "témoin : l'amont reçoit la requête, sans Cookie ni jeton" bash -c "grep -q '^GET /offres/retour' '$work/b-ck' && ! grep -qi '^cookie:' '$work/b-ck' && ! grep -qF '$jeton' '$work/b-ck'"
check "réponse relayée : X-Shhdrop-Etat: preprod" test "$(hdr "$work/h-ck" X-Shhdrop-Etat)" = preprod
c1 -X PUT -H "Cookie: __Host-shh_preprod=$jeton" -H 'Authorization: Bearer jeton-du-site' -D "$work/h-br" -o "$work/b-br" "$P/api/shares/segments/0"
check "témoin + Authorization: Bearer (envoi d'un segment) : relayé, Authorization transmis tel quel" \
	bash -c "grep -q '^HTTP/[0-9.]* 200' '$work/h-br' && grep -q '^PUT /api/shares/segments/0' '$work/b-br' && grep -qixF 'Authorization: [Bearer jeton-du-site]' '$work/b-br'"
check "témoin + Authorization: PrivateToken (appel du salon) : relayé" \
	test "$(code c1 -X POST -H "Cookie: __Host-shh_preprod=$jeton" -H 'Authorization: PrivateToken token=abc' "$P/api/salons/appel")" = 200
check "témoin, mise à niveau WebSocket (GET /api/salons/ws) : relayée" \
	test "$(code c1 -H "Cookie: __Host-shh_preprod=$jeton" -H 'Sec-Fetch-Mode: websocket' -H 'Sec-Fetch-Site: same-origin' "$P/api/salons/ws")" = 200
check "témoin faux : 503" test "$(maint c1 -H "Cookie: __Host-shh_preprod=$faux" "$P/")" = 503-maintenance
check "témoin tronqué : 503" test "$(maint c1 -H "Cookie: __Host-shh_preprod=${jeton%?}" "$P/")" = 503-maintenance
check "témoin vide : 503" test "$(maint c1 -H "Cookie: __Host-shh_preprod=" "$P/")" = 503-maintenance
check "autre nom de témoin portant le jeton : 503" test "$(maint c1 -H "Cookie: shh_preprod=$jeton" "$P/")" = 503-maintenance
c1 -H "X-Shh-Preprod: $jeton" -D "$work/h-tk" -o "$work/b-tk" "$P/api/captcha"
check "en-tête X-Shh-Preprod juste (contrôles de deploy.sh) : relayé (200)" grep -q '^HTTP/[0-9.]* 200' "$work/h-tk"
check "en-tête : l'amont ne reçoit ni X-Shh-Preprod ni le jeton" bash -c "! grep -qiF 'X-Shh-Preprod' '$work/b-tk' && ! grep -qF '$jeton' '$work/b-tk'"
check "en-tête X-Shh-Preprod faux : 503" test "$(maint c1 -H "X-Shh-Preprod: $faux" "$P/api/captcha")" = 503-maintenance
check "en-tête X-Shh-Preprod tronqué : 503" test "$(maint c1 -H "X-Shh-Preprod: ${jeton%?}" "$P/api/captcha")" = 503-maintenance
check "en-tête X-Shh-Preprod vide : 503" test "$(maint c1 -H "X-Shh-Preprod;" "$P/api/captcha")" = 503-maintenance
check "jeton vide dans la configuration : en-tête vide → 503" test "$(maint cv -H "X-Shh-Preprod;" "$V/")" = 503-maintenance
check "jeton vide dans la configuration : témoin vide → 503" test "$(maint cv -H "Cookie: __Host-shh_preprod=" "$V/")" = 503-maintenance
check "jeton vide dans la configuration : /acces/ → 503, aucun témoin" \
	bash -c "test \"\$(curl -sS --noproxy '*' --max-time 20 --cacert '$work/d-v/caddy/pki/authorities/local/root.crt' --resolve '$name:$p_httpsv:127.0.0.1' -D '$work/h-v' -o /dev/null -w '%{http_code}' '$V/acces/')\" = 503 && ! grep -qi '^set-cookie:' '$work/h-v'"

# --- 5. Webhooks ----------------------------------------------------------------------------------
for p in stripe paypal nowpayments; do
	c1 -X POST -H 'Content-Type: application/json' -d '{}' -D "$work/h-wh" -o "$work/b-wh" "$P/api/paiement/webhook/$p"
	check "webhook $p (POST, sans témoin) : relayé à l'amont" bash -c "grep -q '^HTTP/[0-9.]* 200' '$work/h-wh' && grep -q '^POST /api/paiement/webhook/$p\$' '$work/b-wh'"
done

# --- 6. Sec-Fetch-Site ne suffit pas (risque PP1) ------------------------------------------------
# Le site envoie tout en credentials: "same-origin" : ses appels portent le témoin.
for m in cors no-cors same-origin websocket; do
	check "Sec-Fetch-Site: same-origin, Sec-Fetch-Mode: $m, sans témoin : 503" \
		test "$(maint c1 -H 'Sec-Fetch-Site: same-origin' -H "Sec-Fetch-Mode: $m" "$P/api/salons/x")" = 503-maintenance
	check "Sec-Fetch-Site: same-origin, Sec-Fetch-Mode: $m, avec le témoin : relayé (200)" \
		test "$(code c1 -H "Cookie: __Host-shh_preprod=$jeton" -H 'Sec-Fetch-Site: same-origin' -H "Sec-Fetch-Mode: $m" "$P/api/salons/x")" = 200
done

# --- 7. Cache, et production inchangée --------------------------------------------------------------
c1 -H "X-Shh-Preprod: $jeton" -D "$work/h-cache" -o /dev/null "$P/assets/index-abc.js"
check "préproduction : Cache-Control de l'amont (immutable) remplacé par no-store, une seule valeur" \
	test "$(hdr "$work/h-cache" Cache-Control)" = no-store
c1 -H "Cookie: __Host-shh_preprod=$jeton" -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: no-cors' -D "$work/h-cache2" -o /dev/null "$P/assets/index-abc.js"
check "préproduction, fichier demandé par une page : no-store aussi" test "$(hdr "$work/h-cache2" Cache-Control)" = no-store
c0 -D "$work/h-prod" -o "$work/b-prod" "$Q/assets/index-abc.js"
check "production : Cache-Control de l'amont inchangé" test "$(hdr "$work/h-prod" Cache-Control)" = "public, max-age=31536000, immutable"
check "production : ni X-Shhdrop-Etat, ni Retry-After" bash -c "! grep -qiE '^(x-shhdrop-etat|retry-after):' '$work/h-prod'"
c0 -D "$work/h-prod2" -o "$work/b-prod2" "$Q/acces/$jeton"
check "production : /acces/<jeton> relayé comme tout chemin, aucun témoin posé" \
	bash -c "grep -q '^GET /acces/' '$work/b-prod2' && ! grep -qi '^set-cookie:' '$work/h-prod2'"
check "production : X-Shh-Preprod retiré vers l'amont" bash -c "! curl -sS --noproxy '*' --cacert '$work/d-0/caddy/pki/authorities/local/root.crt' --resolve '$name:$p_https0:127.0.0.1' -H 'X-Shh-Preprod: $jeton' '$Q/' | grep -qiF x-shh-preprod"
check "sorties de Caddy : aucune trace du jeton" bash -c "! grep -qF '$jeton' '$work'/c-*.log"

echo
if [ "$fails" -eq 0 ]; then
	echo "RÉUSSI : barrière de préproduction, tous les contrôles passent."
else
	echo "ÉCHEC : $fails contrôle(s) en échec."
	exit 1
fi

package api

import (
	"net/http"
	"strings"
)

// securityHeaders : en-têtes de la spec §10, posés sur toutes les réponses
// Trusted Types (10 novembre) : toute chaîne brute donnée à un point d'injection de script
// est refusée ; seules deux politiques existent, celle des gabarits de Svelte et « shhdrop »
// (web/src/app/trusted.ts : nos fichiers de assets/ et les Blob de cette origine).
// Cache-Control: no-store par défaut : exigé pour /api/* et le HTML (bfcache, spec §21), gardé
// pour tout fichier du site dont le nom ne porte pas d'empreinte. Seule exception, posée par
// le gestionnaire des fichiers du site (cmd/shhdrop/static.go, immutableAsset) : les fichiers
// à empreinte de /assets/ (contenu fixe sous ce nom), en cache un an.
// worker-src blob: (seul) : les Workers d'Argon2id et de la preuve anti-robot sont lancés depuis
// un Blob dont les octets viennent d'un fetch avec `integrity` (web/src/engine/source.verified.ts,
// web/src/captcha/pow-source.verified.ts) ; new Worker(url) n'a pas de contrôle d'intégrité
// (spec §28.3). Plus aucun Worker n'est lancé sur un fichier : 'self' retiré (revue du
// 21 novembre), un script injecté ne peut plus lancer un fichier du site comme Worker.
// connect-src … blob: : Chrome (156) relit lui-même une image blob: qu'il ne sait pas décoder
// (HEIC) et la CSP bloquait cette relecture (CI du 10 novembre). Une adresse blob: ne désigne
// que des données déjà présentes dans la page : rien ne peut sortir par là.
var securityHeaders = [][2]string{
	{"Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
		"img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' blob:; worker-src blob:; frame-src 'self'; " +
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types svelte-trusted-html shhdrop"},
	{"Referrer-Policy", "no-referrer"},
	{"X-Content-Type-Options", "nosniff"},
	// X-Frame-Options: DENY double frame-ancestors 'none' (ceinture et bretelles, audit adverse
	// du 13 novembre, Si2) : un très vieux navigateur sans CSP niveau 2 ne cadre pas non plus les
	// pages qui détiennent des clés. Le cadre PDF (/pdf-frame.html), volontairement embarqué par
	// l'application en même origine, repasse à SAMEORIGIN (pathHeaders).
	{"X-Frame-Options", "DENY"},
	// camera=(self) : photo et vidéo prises dans l'interface (Q-REC1 acceptée par le propriétaire,
	// spec §35.3) ; /pdf-frame.html n'a besoin ni du micro ni de la caméra (pathHeaders).
	// Le reste est refusé explicitement (audit F3) : fonctions puissantes inutilisées, qui
	// valent sinon « self » et serviraient à un script injecté (capture d'écran, lecture du
	// presse-papiers, périphériques, capteurs). clipboard-write, web-share, screen-wake-lock,
	// fullscreen restent à leur défaut (self) : utilisés ou prévus (§37.9). Passkeys du compte
	// (conception du compte par passkey §6.5) : publickey-credentials-create et -get posés
	// explicitement à self (le défaut aujourd'hui, mais un changement de défaut ne doit rien
	// ouvrir ni fermer en silence), refusés au cadre PDF.
	{"Permissions-Policy", "microphone=(self), camera=(self), publickey-credentials-create=(self), publickey-credentials-get=(self), " + deniedFeatures},
	{"Cross-Origin-Opener-Policy", "same-origin"},
	{"Cross-Origin-Resource-Policy", "same-origin"},
	{"Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"},
	{"Cache-Control", "no-store"},
}

// deniedFeatures : fonctions refusées sur toutes les pages (spec §10, audit F3).
const deniedFeatures = "geolocation=(), display-capture=(), clipboard-read=(), usb=(), serial=(), hid=(), " +
	"payment=(), gyroscope=(), accelerometer=(), magnetometer=(), midi=(), " +
	"xr-spatial-tracking=(), browsing-topics=(), interest-cohort=()"

// cspFor : CSP commune. Salon actif (origin non vide, déjà vérifiée par config.originOK) :
// connect-src permet aussi le WebSocket de cette origine (wss://, ou ws:// pour une origine
// http:// de boucle locale) ; 'self' ne couvre pas ws(s) dans tous les navigateurs. Sans
// salon, la CSP reste exactement celle d'avant le salon.
func cspFor(origin string) string {
	var ws string
	switch {
	case origin == "":
		return securityHeaders[0][1]
	case strings.HasPrefix(origin, "https://"):
		ws = "wss://" + origin[len("https://"):]
	case strings.HasPrefix(origin, "http://"):
		ws = "ws://" + origin[len("http://"):]
	default:
		// Inaccessible (origine vérifiée au démarrage) : rien n'est ajouté.
		return securityHeaders[0][1]
	}
	return strings.Replace(securityHeaders[0][1], cspConnect, "connect-src 'self' blob: "+ws+";", 1)
}

// cspConnect : directive connect-src de la CSP commune (unique dans securityHeaders[0]).
const cspConnect = "connect-src 'self' blob:;"

// withHeaders : en-têtes communs, CSP calculée une fois par cspFor.
func withHeaders(csp string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		for _, kv := range securityHeaders {
			h.Set(kv[0], kv[1])
		}
		h.Set("Content-Security-Policy", csp)
		pathHeaders(h, r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

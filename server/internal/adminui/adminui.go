// Package adminui : tableau de bord d'administration (conception
// docs/conception/specs/2026-11-13-tableau-de-bord-admin-design.md). Servi par un écouteur
// distinct du site public (SHH_ADMIN_LISTEN), jamais par Caddy. Il ne montre que des
// agrégats : aucun identifiant, aucune adresse, aucun contenu, aucune date de partage ; il
// n'écrit rien sur disque hors du fichier de gel, et ne garde rien (ni journal ni dernier
// accès), sauf, en mémoire et une minute au plus, les compteurs lents (lent.go). Pas d'effacement d'urgence ici : « wipe » reste en ligne de commande.
package adminui

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Erreurs d'une destruction demandée depuis la page.
var (
	// ErrLienInvalide : ce qui a été collé n'est pas un lien de partage ou de salon.
	ErrLienInvalide = errors.New("adminui : lien invalide")
	// ErrIntrouvable : aucun partage ni salon pour ce lien (déjà détruit, expiré ou inconnu).
	ErrIntrouvable = errors.New("adminui : introuvable")
)

// Config : ce dont la page a besoin, fourni par cmd/shhdrop. Les fonctions sont celles de
// la ligne de commande (shhdrop admin freeze|unfreeze|destroy -), dans le processus en marche.
type Config struct {
	// TokenHash : SHA-256 du jeton d'administration (config.Config.AdminTokenHash).
	TokenHash [32]byte
	// Host : hôte de l'adresse d'écoute (SHH_ADMIN_LISTEN, sans le port ; IPv6 sans crochets),
	// seul nom servi en plus de localhost et 127.0.0.1 (hoteOK). Vide : ces deux-là seulement.
	Host string
	// Peers : pairs servis en plus de la boucle locale (SHH_TRUSTED_PROXY : dans le conteneur
	// de production, la machine elle-même, par où arrive le tunnel SSH).
	Peers []netip.Prefix
	// State : état agrégé, lu à chaque demande ; seuls ses compteurs lents sont gardés (lent.go).
	State func() (State, error)
	// Freeze, Unfreeze : gel et dégel des créations (fichier « frozen »).
	Freeze, Unfreeze func() error
	// Destroy : détruit le partage ou le salon du lien signalé ; rend « partage », « salon »
	// (ligne et fichiers effacés) ou « salon-reste » (salon détruit pour tous, un effacement de
	// fichier reste à finir par l'entretien), ErrLienInvalide ou ErrIntrouvable. link est effacé
	// par l'appelant au retour : Destroy ne doit en garder aucune copie (ni chaîne ni tranche).
	Destroy func(link []byte) (string, error)

	// Comptes (conception du compte §21.14). Now : horloge des refs (nil :
	// time.Now). Signales, ActionSalon : salons signalés en cours (SHH_SALONS=1 ; nil sinon :
	// routes refusées comme inconnues) ; ActionSalon reçoit l'identifiant interne retrouvé par la
	// ref et l'action « detruire », « bannir » (durée, motif vérifiés) ou « anciennete ».
	// Comptes : bannissements et agrégats (SHH_COMPTES=1 ; nil sinon).
	Now         func() time.Time
	Signales    func() ([]Signale, error)
	ActionSalon func(cle, action string, dureeJours int, motif uint8) (Resultat, error)
	Comptes     *Comptes
	// Paiement : agrégats et suspension des ventes (SHH_PAIEMENT=1 ; nil sinon : routes refusées
	// comme inconnues).
	Paiement *Paiement
}

// maxLink : longueur maximale du lien signalé (comme maxStdinLink de la ligne de commande).
const maxLink = 4096

//go:embed page/index.html page/admin.css page/admin.js
var page embed.FS

// csp : politique propre à la page d'administration, plus stricte que celle du site : rien
// hors de cette origine, aucun style ni script en ligne, aucun cadre, aucun formulaire
// envoyé ; Trusted Types sans aucune politique (la page n'écrit que du texte).
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'"

var headers = [][2]string{
	{"Content-Security-Policy", csp},
	{"Cache-Control", "no-store"},
	{"X-Frame-Options", "DENY"},
	{"X-Content-Type-Options", "nosniff"},
	{"Referrer-Policy", "no-referrer"},
	{"Cross-Origin-Opener-Policy", "same-origin"},
	{"Cross-Origin-Resource-Policy", "same-origin"},
	{"Permissions-Policy", "geolocation=(), camera=(), microphone=(), display-capture=(), clipboard-read=(), payment=(), usb=()"},
}

type admin struct {
	c     Config
	files [3]file
	frein frein
	refs  refs
	lents lents
}

// Délai global après un jeton faux (variables : écourtées par les tests).
var (
	// delaiFaux : ce que chaque jeton faux ajoute au délai en cours.
	delaiFaux = 250 * time.Millisecond
	// delaiFauxMax : plafond du délai, donc de l'attente de l'exploitant légitime.
	delaiFauxMax = 2 * time.Second
)

// frein : délai global après un jeton faux (26 900 essais par seconde, sans aucun frein). Rien
// n'est gardé par adresse :
// une seule heure, en mémoire, « fin du délai en cours ».
//
//   - Chaque jeton faux repousse cette fin de delaiFaux (à partir de maintenant si le délai
//     était écoulé), sans jamais dépasser maintenant + delaiFauxMax.
//   - La réponse à TOUTE vérification de jeton, bonne ou fausse, n'est rendue qu'à la fin du
//     délai en cours à son arrivée (pour une fausse : prolongement compris). Une réussite ne se
//     voit donc pas plus tôt qu'un échec : couper la connexion sans attendre n'apprend rien.
//   - Sans jeton faux récent, aucune attente. L'exploitant légitime n'est jamais refusé : au
//     pire, pendant une attaque, il attend delaiFauxMax par requête.
//
// Ce que cela borne, honnêtement : une connexion qui essaie à la suite fait au plus un essai
// par delaiFaux ; C connexions simultanées en font au plus C par delaiFauxMax (le plafond qui
// protège l'exploitant est aussi ce qui laisse passer une rafale). Ce n'est pas un verrouillage :
// la vraie défense reste un jeton de 256 bits tiré au hasard.
type frein struct {
	mu  sync.Mutex
	fin time.Time
}

// passer attend la fin du délai en cours (prolongé d'abord si le jeton est faux) ; faux si le
// client est parti entretemps (plus rien à répondre).
func (f *frein) passer(ctx context.Context, juste bool) bool {
	now := time.Now()
	f.mu.Lock()
	fin := f.fin
	if !juste {
		if fin.Before(now) {
			fin = now
		}
		if fin = fin.Add(delaiFaux); fin.After(now.Add(delaiFauxMax)) {
			fin = now.Add(delaiFauxMax)
		}
		f.fin = fin
	}
	f.mu.Unlock()
	d := fin.Sub(now)
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

type file struct {
	path, ctype string
	body        []byte
}

// New : gestionnaire de l'écouteur d'administration.
//
//	GET  /, /admin.css, /admin.js   la page (aucune donnée, aucun secret : servie sans jeton)
//	GET  /api/etat                  état agrégé (State)
//	POST /api/geler, /api/degeler   gel et dégel des créations
//	POST /api/detruire              lien signalé dans le CORPS (text/plain), jamais dans l'URL
//	GET  /api/signalements          salons signalés en cours, par ref éphémère
//	POST /api/salons/action         { ref, action, duree_jours?, motif? }
//	POST /api/bannis                { filtre, page } (liste ; jamais de paramètre d'URL)
//	POST /api/bannis/action         { id, action, jusqu? }
//	POST /api/bannir                { lien, duree_jours, motif }
//	GET  /api/comptes               agrégats des comptes
//	GET  /api/paiement              agrégats du paiement (SHH_PAIEMENT=1)
//	POST /api/paiement/suspendre    ventes suspendues jusqu'au redémarrage (réversible)
//	POST /api/paiement/retablir     ventes rétablies
//	POST /api/paiement/offrir       { duree, nom? } : accès offert créé, lien rendu une seule fois
//	GET  /api/paiement/offerts      accès offerts (empreinte, nom, jours, jetons, état ; jamais le pass)
//	POST /api/paiement/offerts/revoquer { id } : accès offert révoqué
//	POST /api/paiement/offerts/nommer { id, nom } : nom de l'exploitant posé ou effacé (vide)
//
// Tout /api/* exige « Authorization: Bearer <jeton> ». Jeton absent, faux, de mauvaise
// longueur, route inconnue, mauvaise méthode, pair hors boucle locale, requête relayée, hôte
// étranger (hoteOK) : la même réponse (refuse), sans rien qui les distingue dans son contenu.
// Seule sa date diffère : un jeton faux est répondu après le délai global (frein) ; un pair ou
// un hôte refusé, qui n'a jamais droit à une vérification de jeton, tout de suite.
func New(c Config) http.Handler {
	a := &admin{c: c}
	for i, f := range []file{
		{path: "/", ctype: "text/html; charset=utf-8"},
		{path: "/admin.css", ctype: "text/css; charset=utf-8"},
		{path: "/admin.js", ctype: "text/javascript; charset=utf-8"},
	} {
		name := "page" + f.path
		if f.path == "/" {
			name = "page/index.html"
		}
		b, err := page.ReadFile(name)
		if err != nil {
			panic(err) // fichiers embarqués à la compilation
		}
		f.body = b
		a.files[i] = f
	}
	return a
}

// Server : serveur HTTP de la page, délais courts (aucun transfert long ici), en-têtes
// plafonnés, messages internes de net/http jetés (ils peuvent contenir l'adresse du pair).
func Server(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8 << 10,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
}

func refuse(w http.ResponseWriter) {
	write(w, http.StatusNotFound, []byte(`{"error":"not_found"}`))
}

func write(w http.ResponseWriter, code int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	w.Write(body)
}

func writeJSON(w http.ResponseWriter, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
		return
	}
	write(w, http.StatusOK, b)
}

func (a *admin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	for _, kv := range headers {
		h.Set(kv[0], kv[1])
	}
	// Une panique d'un gestionnaire d'administration ne sort pas d'ici : 500 sans détail, rien
	// de journalisé ; le serveur public (autre écouteur) n'est pas touché.
	defer func() {
		if v := recover(); v != nil {
			if v == http.ErrAbortHandler {
				panic(v)
			}
			write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
		}
	}()
	if !a.peerOK(r) || relayed(r) || !a.hoteOK(r.Host) {
		refuse(w)
		return
	}
	if r.Method == http.MethodGet && r.URL.RawQuery == "" {
		for _, f := range a.files {
			if r.URL.Path == f.path {
				h.Set("Content-Type", f.ctype)
				w.Write(f.body)
				return
			}
		}
	}
	// Le jeton est toujours vérifié, avant de regarder la route : une route inconnue et un
	// jeton faux prennent le même chemin.
	juste := a.authorized(r)
	if !a.frein.passer(r.Context(), juste) {
		return // client parti pendant le délai : rien à répondre, rien d'appelé
	}
	if !juste {
		refuse(w)
		return
	}
	// Aucun paramètre d'URL n'est accepté : rien de sensible ne doit pouvoir y être mis.
	if r.URL.RawQuery != "" {
		refuse(w)
		return
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/etat":
		st, err := a.c.State()
		if err != nil {
			write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
			return
		}
		writeJSON(w, a.ralentirEtat(st))
	case "POST /api/geler":
		a.act(w, r, a.c.Freeze)
	case "POST /api/degeler":
		a.act(w, r, a.c.Unfreeze)
	case "POST /api/detruire":
		a.destroy(w, r)
	case "GET /api/signalements":
		if a.c.Signales == nil {
			refuse(w)
			return
		}
		a.signalements(w)
	case "POST /api/salons/action":
		if a.c.Signales == nil || a.c.ActionSalon == nil {
			refuse(w)
			return
		}
		a.actionSalon(w, r)
	case "POST /api/bannis", "POST /api/bannis/action", "POST /api/bannir", "GET /api/comptes":
		if a.c.Comptes == nil {
			refuse(w)
			return
		}
		switch r.URL.Path {
		case "/api/bannis":
			a.bannisListe(w, r)
		case "/api/bannis/action":
			a.bannisAction(w, r)
		case "/api/bannir":
			a.bannir(w, r)
		default:
			a.comptes(w)
		}
	case "GET /api/paiement", "POST /api/paiement/suspendre", "POST /api/paiement/retablir":
		if a.c.Paiement == nil {
			refuse(w)
			return
		}
		a.paiement(w, r)
	case "GET /api/paiement/offerts", "POST /api/paiement/offrir", "POST /api/paiement/offerts/revoquer",
		"POST /api/paiement/offerts/nommer":
		if a.c.Paiement == nil || !a.c.Paiement.offertsActifs() {
			refuse(w)
			return
		}
		a.paiement(w, r)
	default:
		refuse(w)
	}
}

// peerOK : pair de la connexion en boucle locale, ou parmi Peers. Seul endroit du paquet qui
// lit l'adresse du pair ; elle n'est ni gardée, ni journalisée, ni recopiée (spec §36 S2).
func (a *admin) peerOK(r *http.Request) bool {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := ap.Addr().Unmap()
	if ip.IsLoopback() {
		return true
	}
	for _, p := range a.c.Peers {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// hoteOK : nom sous lequel la page est demandée (en-tête Host de la requête, lu par net/http
// dans http.Request.Host). Servis : localhost, 127.0.0.1 et l'adresse d'écoute (Config.Host),
// écrits exactement ainsi, avec ou sans port, quel que soit le port (le tunnel SSH choisit le
// port local). Tout autre nom est refusé comme une route inconnue : un site qui fait pointer
// son nom vers la boucle locale (« DNS rebinding ») ne devient pas de même origine que la
// page, et un Caddy mal réglé, qui relaierait le nom public vers cet écouteur, n'est pas
// servi. Le nom n'est ni gardé, ni journalisé, ni recopié.
func (a *admin) hoteOK(hote string) bool {
	h := hote
	if i := strings.LastIndexByte(hote, ':'); i >= 0 && !strings.HasSuffix(hote, "]") {
		port := hote[i+1:]
		if len(port) == 0 || len(port) > 5 {
			return false
		}
		n := 0
		for _, c := range []byte(port) {
			if c < '0' || c > '9' {
				return false
			}
			n = n*10 + int(c-'0')
		}
		if n < 1 || n > 65535 {
			return false
		}
		h = hote[:i]
	}
	if h == "localhost" || h == "127.0.0.1" {
		return true
	}
	if a.c.Host == "" {
		return false
	}
	if strings.Contains(a.c.Host, ":") { // adresse IPv6 : entre crochets dans Host
		return h == "["+a.c.Host+"]"
	}
	return h == a.c.Host
}

// relayed : requête passée par Caddy (qui pose toujours X-Shh-Client-IP). La page ne se sert
// jamais à travers le proxy public : refusée comme une route inconnue.
func relayed(r *http.Request) bool { return len(r.Header.Values("X-Shh-Client-IP")) != 0 }

// authorized : « Authorization: Bearer <jeton> », comparé par empreinte SHA-256 en temps
// constant : ni la longueur ni le premier octet faux ne changent la durée. L'empreinte est
// calculée même sans en-tête.
func (a *admin) authorized(r *http.Request) bool {
	var tok string
	vs := r.Header.Values("Authorization")
	if len(vs) == 1 {
		tok, _ = strings.CutPrefix(vs[0], "Bearer ")
		if tok == vs[0] {
			tok = ""
		}
	}
	sum := sha256.Sum256([]byte(tok))
	return subtle.ConstantTimeCompare(sum[:], a.c.TokenHash[:]) == 1 && tok != ""
}

// act : gel ou dégel. Pas de contrôle d'origine en plus : une requête forgée par un autre
// site ne peut pas poser l'en-tête Authorization (il exige une autorisation CORS que ce
// serveur ne donne jamais), et le serveur ne lit aucun en-tête hors de sa liste blanche (§36 S2).
func (a *admin) act(w http.ResponseWriter, r *http.Request, f func() error) {
	if err := f(); err != nil {
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
		return
	}
	write(w, http.StatusOK, []byte(`{"ok":true}`))
}

// destroy : le lien signalé est lu dans le corps, dans UN seul tampon de taille fixe (jamais
// recopié par une croissance), effacé au retour ; Destroy le traite en octets et efface ses
// propres copies (clés). Effacé au mieux : il reste, hors de portée de ce code, le tampon de
// lecture de la connexion (net/http), récrit par la requête suivante ou rendu au ramasse-miettes
// à la fermeture, et l'état interne du calcul de K_accès (le commentaire promettait « effacé de
// la mémoire », alors que le lien, clé comprise, restait en neuf exemplaires). La réponse ne
// reprend jamais le lien, ni aucun identifiant : seulement ce qui a été détruit.
func (a *admin) destroy(w http.ResponseWriter, r *http.Request) {
	tampon := make([]byte, maxLink+1)
	defer clear(tampon)
	n, err := io.ReadFull(r.Body, tampon)
	if (err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF)) || n > maxLink {
		write(w, http.StatusBadRequest, []byte(`{"error":"lien_invalide"}`))
		return
	}
	body := tampon[:n]
	kind, err := a.c.Destroy(body)
	switch {
	case errors.Is(err, ErrLienInvalide):
		write(w, http.StatusBadRequest, []byte(`{"error":"lien_invalide"}`))
	case errors.Is(err, ErrIntrouvable):
		write(w, http.StatusOK, []byte(`{"detruit":"aucun"}`))
	case err != nil:
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
	case kind == "salon":
		write(w, http.StatusOK, []byte(`{"detruit":"salon"}`))
	case kind == "salon-reste":
		write(w, http.StatusOK, []byte(`{"detruit":"salon","reste":true}`))
	default:
		write(w, http.StatusOK, []byte(`{"detruit":"partage"}`))
	}
}

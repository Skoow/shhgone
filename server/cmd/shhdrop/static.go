package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// staticHandler sert le site (web/dist) depuis dir (audit F7) :
//   - dir et dir/index.html doivent exister au démarrage ;
//   - os.Root : aucun lien symbolique ne sort du dossier ;
//   - tout nom qui commence par « . » (.env, .git/…) → 404 ;
//   - un dossier n'est jamais listé : son index.html, sinon 404 ;
//   - un fichier n'est servi qu'à son chemin exact (exactPath) : « /x.html/ », « /x.html//… »
//     → 404. Les en-têtes de sécurité propres à un fichier (CSP sandbox du cadre PDF,
//     api.pathHeaders) suivent le chemin de la requête : aucun autre chemin ne doit donc
//     rendre les mêmes octets (audit adverse du 13 novembre, site, N1) ;
//   - repli de l'application monopage : un chemin inconnu dont le dernier segment n'a pas
//     d'extension sert index.html ; un fichier absent (x.js) → 404. Les liens sont à la
//     racine (« /#clé », spec §32) : plus de repli particulier sous /s/ ni /m/ ; un chemin
//     abîmé sans extension charge l'application, qui retire le « # » (UI §12.1) ;
//   - statut réel (audit de performance, point 5) : seules les routes de l'application
//     (appRoutes, mêmes que web/src/app/router.svelte.ts) répondent 200 ; tout autre chemin
//     sans extension reçoit index.html avec le statut 404 (l'application y affiche « Cette
//     page n'existe pas. »), jamais un « soft 404 » en 200.
//
// Les en-têtes de sécurité sont posés par api.New autour de ce gestionnaire.
//
// comptes (SHH_COMPTES=1) : les pages du compte (compteRoutes) répondent 200 aussi ; sans le
// compte, 404 comme toute page inconnue.
func staticHandler(dir string, comptes, salons bool) (http.Handler, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("SHH_STATIC_DIR %s : %w", dir, err)
	}
	if fi, err := root.Stat("index.html"); err != nil || !fi.Mode().IsRegular() {
		root.Close()
		return nil, shownf("SHH_STATIC_DIR %s : index.html absent", dir)
	}
	fsys := root.FS()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "méthode non permise", http.StatusMethodNotAllowed)
			return
		}
		name, ok := staticName(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		f, fi, err := openRegular(fsys, name)
		if err == nil && !exactPath(r.URL.Path, name, isDir(fsys, name)) {
			f.Close()
			http.NotFound(w, r)
			return
		}
		status := http.StatusOK
		// Pages séparées (conception du 16 novembre) : une page d'information a son propre fichier
		// (« /securite » → securite.html). Liste fermée : aucun autre fichier .html n'est servi
		// sans son extension (le cadre PDF garde ses en-têtes propres à son seul chemin, N1).
		if file, ok := pageFiles[r.URL.Path]; ok && errors.Is(err, fs.ErrNotExist) {
			if f2, fi2, err2 := openRegular(fsys, file); err2 == nil {
				name, f, fi, err = file, f2, fi2, nil
			}
		}
		if errors.Is(err, fs.ErrNotExist) && !strings.Contains(path.Base(name), ".") && !isDir(fsys, name) {
			if !appRoutes[r.URL.Path] && !(comptes && compteRoutes[r.URL.Path]) && !(salons && salonRoutes[r.URL.Path]) {
				status = http.StatusNotFound
			}
			// app.html (18 novembre) : la page de l'application sans l'accueil écrit au build
			// (référencement), pour que « /envoyer », « /envois » ou un 404 ne l'affichent pas
			// avant le script ; index.html si le build n'en a pas (anciens dossiers, tests).
			name = "app.html"
			f, fi, err = openRegular(fsys, name)
			if errors.Is(err, fs.ErrNotExist) {
				name = "index.html"
				f, fi, err = openRegular(fsys, name)
			}
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		rs, ok := f.(io.ReadSeeker)
		if !ok {
			http.NotFound(w, r)
			return
		}
		if status == http.StatusNotFound {
			// ServeContent répondrait 200 : en-têtes posés à la main, corps entier (pas de plage).
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
			w.WriteHeader(http.StatusNotFound)
			if r.Method != http.MethodHead {
				io.Copy(w, rs)
			}
			return
		}
		h := w.Header()
		// Cache : no-store partout, posé par api.New, sauf pour un fichier à empreinte de
		// /assets/ qui existe (jamais pour un 404 ni pour le repli vers index.html) : un an,
		// immuable (revue du 10 novembre ; remplace « aucun cache », retours CLEAN4).
		if immutableAsset.MatchString("/"+name) && path.Base(name) == fi.Name() {
			h.Set("Cache-Control", immutableCache)
		} else if dayAsset.MatchString("/"+name) && path.Base(name) == fi.Name() {
			h.Set("Cache-Control", dayCache)
		}
		// Variante précompressée au build (vite.config.ts, precompress) : mêmes octets une fois
		// décompressés (SRI inchangée), jamais de compression à la volée ni sur /api/*.
		if compressible(name) {
			h.Add("Vary", "Accept-Encoding")
			if ef, enc := encodedVariant(fsys, name, r.Header.Get("Accept-Encoding")); ef != nil {
				defer ef.Close()
				if t := mime.TypeByExtension(path.Ext(name)); t != "" {
					h.Set("Content-Type", t)
				}
				h.Set("Content-Encoding", enc)
				http.ServeContent(w, r, fi.Name(), time.Time{}, ef)
				return
			}
		}
		// Date nulle : pas de Last-Modified (no-store, ou contenu immuable sous ce nom).
		http.ServeContent(w, r, fi.Name(), time.Time{}, rs)
	}), nil
}

// immutableAsset : fichiers de /assets/ dont le nom porte une empreinte du contenu (vite :
// nom-EMPREINTE.ext, 8 caractères base64url ou plus). Leur contenu ne change jamais sous ce
// nom : cache d'un an. Tout le reste garde le no-store posé par api.New (HTML, routes,
// cadre PDF, polices de /fonts/ et images sans empreinte, robots.txt, sitemap.xml, manifeste).
var immutableAsset = regexp.MustCompile(`^/assets/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2|png|webp|svg|wasm)$`)

const immutableCache = "public, max-age=31536000, immutable"

// dayAsset : icônes, manifeste, polices et images fixes sans empreinte (audit de vitesse du
// 20 novembre) : un jour de cache au lieu de no-store. Rien de secret ni de propre à quelqu'un ;
// un changement met au plus un jour à être vu. HTML, cadre PDF (intégrité vérifiée), robots.txt
// et sitemap.xml restent en no-store.
var dayAsset = regexp.MustCompile(`^/(?:fonts/[a-z0-9-]+\.woff2|assets/[a-z0-9-]+\.(?:png|svg|webp)|favicon\.(?:svg|ico)|favicon-32\.png|apple-touch-icon\.png|icon-(?:192|512)\.png|logo\.svg|manifest\.webmanifest)$`)

const dayCache = "public, max-age=86400"

// compressible : types précompressés par le build : texte, et le moteur WebAssembly (481 Ko,
// 141 Ko en brotli, spec moteur §7) ; les images et polices le sont déjà.
func compressible(name string) bool {
	switch path.Ext(name) {
	case ".js", ".css", ".html", ".svg", ".webmanifest", ".xml", ".txt", ".wasm":
		return true
	}
	return false
}

// encodedVariant : name.br, sinon name.gz, si le client les accepte et qu'ils existent.
func encodedVariant(fsys fs.FS, name, accept string) (interface {
	io.ReadSeeker
	io.Closer
}, string) {
	for _, enc := range [...]struct{ token, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if !accepts(accept, enc.token) {
			continue
		}
		f, _, err := openRegular(fsys, name+enc.ext)
		if err != nil {
			continue
		}
		rsc, ok := f.(interface {
			io.ReadSeeker
			io.Closer
		})
		if !ok {
			f.Close()
			continue
		}
		return rsc, enc.token
	}
	return nil, ""
}

// accepts : vrai si Accept-Encoding contient token sans « q=0 ».
func accepts(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), token) {
			continue
		}
		for _, p := range fields[1:] {
			p = strings.ReplaceAll(strings.TrimSpace(p), " ", "")
			if p == "q=0" || p == "q=0.0" || p == "q=0.00" || p == "q=0.000" {
				return false
			}
		}
		return true
	}
	return false
}

// appRoutes : chemins de l'application qui répondent 200 (voir match() dans
// web/src/app/router.svelte.ts ; un test compare les deux listes).
var appRoutes = map[string]bool{
	"/":                 true,
	"/securite":         true,
	"/confidentialite":  true,
	"/conditions":       true,
	"/mentions-legales": true,
	"/signaler":         true,
	"/offres":           true,
	"/envoyer":          true,
	"/envois":           true,
	"/telechargements":  true,
}

// compteRoutes : pages du compte (table COMPTE_PATHS de web/src/app/router.svelte.ts, lot 10),
// servies en 200 seulement avec SHH_COMPTES=1.
// pageFiles : pages servies par leur propre fichier HTML : pages d'information (web/vite.config.ts,
// PAGE_PATHS ; web/scripts/check-dist.mjs, INFO_PAGES) et page d'ouverture « /s » (s.html).
var pageFiles = map[string]string{
	"/securite":        "securite.html",
	"/confidentialite": "confidentialite.html",
	"/offres":          "offres.html",
	// Retour de la page hébergée du prestataire de paiement (conception du paiement §2 point 5) :
	// même page que les Offres, qui lit l'état chez le serveur ; aucune donnée dans l'adresse.
	"/offres/retour":    "offres.html",
	"/conditions":       "conditions.html",
	"/mentions-legales": "mentions-legales.html",
	"/signaler":         "signaler.html",
	// Liens de partage et de gestion sous « /s » (16 novembre) : page d'ouverture seule.
	"/s": "s.html",
	// Versions anglaises des pages bilingues (20 novembre, web/vite.config.ts, infoPages).
	"/en":                  "en.html",
	"/en/securite":         "en-securite.html",
	"/en/confidentialite":  "en-confidentialite.html",
	"/en/offres":           "en-offres.html",
	"/en/conditions":       "en-conditions.html",
	"/en/mentions-legales": "en-mentions-legales.html",
	"/en/signaler":         "en-signaler.html",
}

// enVersion : page française → sa version anglaise (web/src/app/langues.ts, PAGES_BILINGUES).
// Aucun renvoi selon la langue : le serveur ne lit pas Accept-Language (spec §36 S2, Caddy le
// retire) ; c'est l'adresse qui donne la langue de ces pages.
var enVersion = map[string]string{
	"/":                 "/en",
	"/securite":         "/en/securite",
	"/confidentialite":  "/en/confidentialite",
	"/offres":           "/en/offres",
	"/conditions":       "/en/conditions",
	"/mentions-legales": "/en/mentions-legales",
	"/signaler":         "/en/signaler",
}

// salonRoutes : pages du salon (table SALON_PATHS de web/src/app/router.svelte.ts, plan C-3),
// servies en 200 seulement avec SHH_SALONS=1 et SHH_COMPTES=1 (le site n'a les écrans du salon
// qu'avec le compte : créer un salon l'exige). Aucun secret dans le chemin (lien « #c… »).
var salonRoutes = map[string]bool{
	"/salon":         true,
	"/salon/nouveau": true,
}

var compteRoutes = map[string]bool{
	"/compte":              true,
	"/compte/inscription":  true,
	"/compte/connexion":    true,
	"/compte/recuperation": true,
	"/compte/profil":       true,
}

// staticName : chemin de l'URL → nom dans le dossier ; refuse les segments cachés.
func staticName(p string) (string, bool) {
	if !strings.HasPrefix(p, "/") {
		return "", false
	}
	for _, seg := range strings.Split(p, "/") {
		if strings.HasPrefix(seg, ".") {
			return "", false // « . », « .. », .env, .git…
		}
	}
	name := strings.TrimPrefix(path.Clean(p), "/")
	if name == "" {
		name = "index.html"
	}
	return name, true
}

// exactPath : le chemin p de la requête est exactement celui du fichier name du dossier (nom
// nettoyé par staticName) : « /name » ; pour un dossier (son index.html), « /name » ou
// « /name/ » ; pour la racine, « / ». Tout autre chemin qui se nettoie en name (barre finale
// après un fichier, barres doublées) n'est pas exact.
func exactPath(p, name string, dir bool) bool {
	return p == "/"+name || dir && p == "/"+name+"/" || p == "/" && name == "index.html"
}

func isDir(fsys fs.FS, name string) bool {
	fi, err := fs.Stat(fsys, name)
	return err == nil && fi.IsDir()
}

// openRegular ouvre name, ou name/index.html si c'est un dossier ; fichier ordinaire seulement.
func openRegular(fsys fs.FS, name string) (fs.File, fs.FileInfo, error) {
	if isDir(fsys, name) {
		name = path.Join(name, "index.html")
	}
	f, err := fsys.Open(name)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil, fs.ErrNotExist
	}
	return f, fi, nil
}

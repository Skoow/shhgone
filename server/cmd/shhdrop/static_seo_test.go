package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Référencement (audit du 28 novembre) : « noindex » dans l'en-tête de toute page HTML qui n'est
// pas une page publique indexée ; 404 précompressé ; barre oblique finale redirigée (301) vers la
// page sans elle ; image d'aperçu de lien en cache un jour.
func TestReferencementStatique(t *testing.T) {
	static := t.TempDir()
	for n, b := range map[string]string{
		"index.html":       "ACCUEIL",
		"app.html":         "APP",
		"app.html.br":      "APP-BR",
		"app.html.gz":      "APP-GZ",
		"en.html":          "HOME",
		"s.html":           "S",
		"securite.html":    "SECURITE",
		"en-securite.html": "SECURITY",
		"offres.html":      "OFFRES",
		"verifier.html":    "VERIFIER",
		"og-image.png":     "png",
	} {
		if err := os.WriteFile(filepath.Join(static, n), []byte(b), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := baseCfg(t.TempDir())
	cfg.StaticDir = static
	addr := startServe(t, cfg)
	get := func(p, accept string) (*http.Response, string) {
		t.Helper()
		r, _ := http.NewRequest("GET", "http://"+addr+p, nil)
		r.Header.Set("Accept-Encoding", accept)
		res, err := http.DefaultTransport.RoundTrip(r)
		if err != nil {
			t.Fatal(p, err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}

	for _, c := range []struct {
		path    string
		code    int
		noindex bool
	}{
		{"/", 200, false},
		{"/en", 200, false},
		{"/securite", 200, false},
		{"/en/securite", 200, false},
		{"/offres", 200, false},
		{"/offres/retour", 200, true}, // retour du paiement : même page, jamais indexée
		{"/index.html", 200, true},    // doublon de « / »
		{"/securite.html", 200, true}, // doublon de « /securite »
		{"/verifier", 200, true},      // section de la page Sécurité
		{"/s", 200, true},
		{"/envoyer", 200, true},
		{"/nexiste", 404, true},
		{"/og-image.png", 200, false},
	} {
		res, _ := get(c.path, "")
		if res.StatusCode != c.code || (res.Header.Get("X-Robots-Tag") == "noindex") != c.noindex {
			t.Errorf("%s : %d, X-Robots-Tag %q ; attendu %d, noindex %v", c.path, res.StatusCode, res.Header.Get("X-Robots-Tag"), c.code, c.noindex)
		}
	}

	// 404 : la variante précompressée, comme pour un 200, statut gardé.
	for accept, want := range map[string][2]string{"br, gzip": {"br", "APP-BR"}, "gzip": {"gzip", "APP-GZ"}, "": {"", "APP"}} {
		res, body := get("/nexiste", accept)
		if res.StatusCode != 404 || res.Header.Get("Content-Encoding") != want[0] || body != want[1] || !strings.Contains(res.Header.Get("Vary"), "Accept-Encoding") {
			t.Errorf("404 (%q) : %d %q %q Vary %q", accept, res.StatusCode, res.Header.Get("Content-Encoding"), body, res.Header.Get("Vary"))
		}
	}

	// Barre oblique finale : 301 vers la page connue, requête gardée ; rien pour « /s/ », une page
	// inconnue ou une page du compte désactivé.
	for p, want := range map[string]string{"/securite/": "/securite", "/en/": "/en", "/en/securite/": "/en/securite", "/envoyer/": "/envoyer", "/offres/retour/?x=1": "/offres/retour?x=1"} {
		res, _ := get(p, "")
		if res.StatusCode != 301 || res.Header.Get("Location") != want {
			t.Errorf("%s : %d → %q, 301 → %q attendu", p, res.StatusCode, res.Header.Get("Location"), want)
		}
	}
	for _, p := range []string{"/s/", "/nexiste/", "/compte/", "/securite/x/"} {
		if res, _ := get(p, ""); res.StatusCode == 301 {
			t.Errorf("%s : redirigé vers %q", p, res.Header.Get("Location"))
		}
	}
	if res, _ := get("/og-image.png", ""); res.Header.Get("Cache-Control") != dayCache {
		t.Errorf("og-image.png : Cache-Control %q", res.Header.Get("Cache-Control"))
	}
}

// indexedPaths suit la liste du site (web/src/app/seo.ts, INDEXED), en français et en anglais.
func TestPagesIndexeesMemeListeQueLeSite(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "web", "src", "app", "seo.ts"))
	if err != nil {
		t.Fatal(err)
	}
	i := strings.Index(string(src), "export const INDEXED")
	if i < 0 {
		t.Fatal("INDEXED introuvable")
	}
	bloc := string(src)[i:]
	bloc = bloc[:strings.Index(bloc, "};")]
	n := 0
	for _, m := range regexp.MustCompile(`:\s*"(/[a-z-]*)"`).FindAllStringSubmatch(bloc, -1) {
		if !indexedPaths[m[1]] || !indexedPaths[enVersion[m[1]]] {
			t.Errorf("%s : absent de indexedPaths (ou sa version anglaise)", m[1])
		}
		n++
	}
	if n == 0 || 2*n != len(indexedPaths) {
		t.Fatalf("%d pages indexées sur le site, %d adresses au serveur (2 par page attendues)", n, len(indexedPaths))
	}
}

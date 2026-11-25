package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Pages bilingues : « /en… » sert la version anglaise ; la version française reste
// la même quelle que soit la langue du navigateur (Accept-Language n'est jamais lu, §36 S2).
func TestPagesBilingues(t *testing.T) {
	static := t.TempDir()
	for n, b := range map[string]string{
		"index.html":       "ACCUEIL FR",
		"app.html":         "APP",
		"en.html":          "HOME EN",
		"securite.html":    "SECURITE FR",
		"en-securite.html": "SECURITY EN",
	} {
		if err := os.WriteFile(filepath.Join(static, n), []byte(b), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := baseCfg(t.TempDir())
	cfg.StaticDir = static
	addr := startServe(t, cfg)
	get := func(p, lang string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", "http://"+addr+p, nil)
		if lang != "" {
			req.Header.Set("Accept-Language", lang)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(p, err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	for _, tc := range []struct{ path, lang, want string }{
		{"/", "en-US", "ACCUEIL FR"},
		{"/securite", "en-GB", "SECURITE FR"},
		{"/en", "fr", "HOME EN"},
		{"/en/securite", "", "SECURITY EN"},
	} {
		if code, b := get(tc.path, tc.lang); code != 200 || b != tc.want {
			t.Errorf("%s (%q) : %d %q, %q attendu", tc.path, tc.lang, code, b, tc.want)
		}
	}
	if code, _ := get("/en/envoyer", ""); code != 404 {
		t.Fatalf("/en/envoyer : %d, 404 attendu", code)
	}
}

// Les deux listes du serveur suivent celle du site (web/src/app/langues.ts, PAGES_BILINGUES).
func TestPagesBilinguesMemeListeQueLeSite(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "web", "src", "app", "langues.ts"))
	if err != nil {
		t.Fatal(err)
	}
	i := strings.Index(string(src), "PAGES_BILINGUES: readonly string[] = [")
	if i < 0 {
		t.Fatal("PAGES_BILINGUES introuvable")
	}
	list := string(src)[i+len("PAGES_BILINGUES: readonly string[] = ["):]
	list = list[:strings.Index(list, "]")]
	n := 0
	for _, q := range strings.Split(list, ",") {
		p := strings.Trim(strings.TrimSpace(q), `"`)
		en := "/en" + p
		if p == "/" {
			en = "/en"
		}
		if enVersion[p] != en || pageFiles[en] == "" {
			t.Errorf("%s : enVersion %q, pageFiles[%s] %q", p, enVersion[p], en, pageFiles[en])
		}
		n++
	}
	if n != len(enVersion) {
		t.Fatalf("%d pages bilingues sur le site, %d au serveur", n, len(enVersion))
	}
}

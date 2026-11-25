package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Accueil écrit au build (référencement) : « / » sert index.html (accueil écrit) ;
// les autres adresses de l'application et le 404 servent app.html (même page sans l'accueil
// écrit), pour qu'elles n'affichent jamais l'accueil avant le script.
func TestAccueilEcritSeulementSurLaRacine(t *testing.T) {
	static := t.TempDir()
	for n, b := range map[string]string{
		"index.html": "<!doctype html><title>Shhgone</title><div id=\"app\">ACCUEIL ECRIT</div>",
		"app.html":   "<!doctype html><title>Shhgone</title><div id=\"app\"></div>",
	} {
		if err := os.WriteFile(filepath.Join(static, n), []byte(b), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := baseCfg(t.TempDir())
	cfg.StaticDir = static
	addr := startServe(t, cfg)
	get := func(p string) (int, string) {
		t.Helper()
		res, err := http.Get("http://" + addr + p)
		if err != nil {
			t.Fatal(p, err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if code, body := get("/"); code != 200 || !strings.Contains(body, "ACCUEIL ECRIT") {
		t.Fatalf("/ : %d, accueil écrit attendu", code)
	}
	for _, p := range []string{"/envoyer", "/envois", "/telechargements"} {
		if code, body := get(p); code != 200 || strings.Contains(body, "ACCUEIL ECRIT") {
			t.Fatalf("%s : %d, app.html attendu (sans l'accueil écrit)", p, code)
		}
	}
	if code, body := get("/inconnu"); code != 404 || strings.Contains(body, "ACCUEIL ECRIT") {
		t.Fatalf("/inconnu : %d, 404 sans l'accueil écrit attendu", code)
	}
}

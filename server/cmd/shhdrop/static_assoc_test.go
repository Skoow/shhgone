package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Fichiers d'association des apps natives (conception du compte par passkey §6.5) : sans
// identifiants d'app, 404 identique à une page inconnue ; avec, application/json exact, sans
// redirection ; ils ne disent rien des personnes.
func TestFichiersAssociationApps(t *testing.T) {
	static := t.TempDir()
	if err := os.WriteFile(filepath.Join(static, "index.html"), []byte("<!doctype html><title>Shhgone</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(addr, p string) (int, string, string) {
		t.Helper()
		res, err := client.Get("http://" + addr + p)
		if err != nil {
			t.Fatal(p, err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, res.Header.Get("Content-Type"), string(b)
	}
	const aasa, links = "/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"
	cfg := baseCfg(t.TempDir())
	cfg.StaticDir = static
	addr := startServe(t, cfg)
	refCode, refType, refCorps := get(addr, "/.well-known/inconnu")
	for _, p := range []string{aasa, links} {
		if c, ty, b := get(addr, p); c != 404 || c != refCode || ty != refType || b != refCorps {
			t.Fatalf("%s sans identifiants : %d %q %q", p, c, ty, b)
		}
	}
	fp := strings.TrimSuffix(strings.Repeat("AB:", 32), ":")
	cfg = baseCfg(t.TempDir())
	cfg.StaticDir = static
	cfg.AppleAppIDs = []string{"ABCDE12345.com.shhgone.app"}
	cfg.AndroidPaquet, cfg.AndroidEmpreintes = "com.shhgone.app", []string{fp}
	addr = startServe(t, cfg)
	c, ty, b := get(addr, aasa)
	if c != 200 || ty != "application/json" || b != `{"webcredentials":{"apps":["ABCDE12345.com.shhgone.app"]}}` {
		t.Fatal(c, ty, b)
	}
	c, ty, b = get(addr, links)
	var l []map[string]any
	if c != 200 || ty != "application/json" || json.Unmarshal([]byte(b), &l) != nil || len(l) != 1 ||
		!strings.Contains(b, `"relation":["delegate_permission/common.get_login_creds"]`) ||
		!strings.Contains(b, `"target":{"namespace":"android_app","package_name":"com.shhgone.app","sha256_cert_fingerprints":["`+fp+`"]}`) {
		t.Fatal(c, ty, b)
	}
	// Seulement GET (et HEAD) : une autre méthode n'est pas servie.
	res, err := http.Post("http://"+addr+aasa, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == 200 {
		t.Fatal("POST servi")
	}
}

package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/config"
	"github.com/skoow/shhdrop/server/internal/paiement"
)

func secretTest(t *testing.T, dir, nom, val string) string {
	t.Helper()
	p := filepath.Join(dir, nom)
	if err := os.WriteFile(p, []byte(val+"\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	return p
}

func cfgPaiement(t *testing.T) config.Config {
	dir, sec := t.TempDir(), t.TempDir()
	return config.Config{DataDir: dir, Origin: "https://shhgone.test", Now: time.Now, Paiement: true, Pay: config.Paiement{
		Essai: true, TVA: "oss",
		StripeCleFile: secretTest(t, sec, "s", "sk_test_cle"), StripeWebhookFile: secretTest(t, sec, "w", "whsec_x"),
		NOWPaymentsCleFile: secretTest(t, sec, "n", "np"), NOWPaymentsIPNFile: secretTest(t, sec, "i", "ipn"),
	}}
}

func TestSetupPaiementDesactive(t *testing.T) {
	dir := t.TempDir()
	p, err := setupPaiement(config.Config{DataDir: dir})
	if p != nil || err != nil {
		t.Fatal(p, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "paiements.db")); !os.IsNotExist(err) {
		t.Fatal("paiements.db créée sans SHH_PAIEMENT=1")
	}
}

func TestSetupPaiement(t *testing.T) {
	cfg := cfgPaiement(t)
	p, err := setupPaiement(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer p.db.Close()
	fi, err := os.Stat(filepath.Join(cfg.DataDir, "paiements.db"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatal(fi, err)
	}
	// Régime OSS : la crypto n'est pas proposée (décision du 24 novembre), ses webhooks restent lus.
	if m := p.svc.Moyens(); len(m) != 1 || m[0] != paiement.Carte || p.svc.PrestataireDe("nowpayments") == nil {
		t.Fatal("moyens", m)
	}
}

func TestSetupPaiementRefus(t *testing.T) {
	cas := map[string]func(*config.Config, string){
		"clé réelle en essai": func(c *config.Config, d string) { c.Pay.StripeCleFile = secretTest(t, d, "x", "sk_live_cle") },
		"secret sans whsec_":  func(c *config.Config, d string) { c.Pay.StripeWebhookFile = secretTest(t, d, "y", "abc") },
		"fichier absent":      func(c *config.Config, d string) { c.Pay.NOWPaymentsIPNFile = filepath.Join(d, "absent") },
		"droits larges": func(c *config.Config, d string) {
			p := secretTest(t, d, "z", "np")
			os.Chmod(p, 0o644)
			c.Pay.NOWPaymentsCleFile = p
		},
	}
	for nom, mod := range cas {
		cfg := cfgPaiement(t)
		mod(&cfg, t.TempDir())
		p, err := setupPaiement(cfg)
		if err == nil {
			p.db.Close()
			t.Errorf("%s accepté", nom)
			continue
		}
		if msg := publicMessage(err); strings.Contains(msg, "sk_live_cle") || msg == "" {
			t.Errorf("%s : message %q", nom, msg)
		}
		if _, err := os.Stat(filepath.Join(cfg.DataDir, "paiements.db")); !os.IsNotExist(err) {
			t.Errorf("%s : base créée malgré le refus", nom)
		}
	}
}

// TestSetupPaiementModeBase : une paiements.db créée en essai (préproduction) fait refuser le
// démarrage en production, message dit à l'exploitant (revue du 25 novembre).
func TestSetupPaiementModeBase(t *testing.T) {
	cfg := cfgPaiement(t)
	p, err := setupPaiement(cfg)
	if err != nil {
		t.Fatal(err)
	}
	p.db.Close()
	sec := t.TempDir()
	cfg.Pay.Essai = false
	cfg.Pay.StripeCleFile = secretTest(t, sec, "s", "sk_live_cle")
	p, err = setupPaiement(cfg)
	if err == nil {
		p.db.Close()
		t.Fatal("base d'essai ouverte en production")
	}
	if msg := publicMessage(err); !strings.Contains(msg, "mode essai") {
		t.Errorf("message %q", msg)
	}
	cfg.Pay.Essai = true
	cfg.Pay.StripeCleFile = secretTest(t, sec, "t", "sk_test_cle")
	if p, err = setupPaiement(cfg); err != nil {
		t.Fatal("retour en essai :", err)
	}
	p.db.Close()
}

// TestRetourOffresServi : /offres/retour sert la page des Offres (aucune donnée dans l'adresse).
func TestRetourOffresServi(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html>index"), 0o644)
	os.WriteFile(filepath.Join(dir, "offres.html"), []byte("<!doctype html>offres"), 0o644)
	h, err := staticHandler(dir, false, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/offres/retour", "/offres"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), "offres") {
			t.Errorf("%s : %d %q", p, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/offres/autre", nil))
	if w.Code != 404 {
		t.Error("/offres/autre :", w.Code)
	}
}

// TestAdminPaiementRevoquer : révocation à la main par l'identifiant de commande.
func TestAdminPaiementRevoquer(t *testing.T) {
	cfg, _ := adminSetup(t)
	cfg.Now = time.Now
	c := "a1b2c3d4e5f60718293a4b5c6d7e8f90"
	if code, _, e := run(cfg, "paiement", "revoquer", c); code != 1 || !strings.Contains(e, "paiements.db") {
		t.Fatal("sans base :", code, e)
	}
	db, err := paiement.OuvrirBase(filepath.Join(cfg.DataDir, "paiements.db"))
	if err != nil {
		t.Fatal(err)
	}
	id, _ := paiement.CommandeDe(c)
	q := make([]byte, 32)
	if _, err := db.Exec(`INSERT INTO commandes VALUES(?,?,1,30,1,1,2,NULL,0,86400000)`, id[:], q); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO passes(q, offre, debut_jour, fin_jour, jetons, recharge_jour, revoque) VALUES(?,1,0,8640000000,30,0,0)`, q); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if code, o, e := run(cfg, "paiement", "revoquer", c); code != 0 || !strings.Contains(o, "révoqué") {
		t.Fatal(code, o, e)
	}
	db, _ = paiement.OuvrirBase(filepath.Join(cfg.DataDir, "paiements.db"))
	defer db.Close()
	var rev, etat int
	db.QueryRow(`SELECT revoque FROM passes`).Scan(&rev)
	db.QueryRow(`SELECT etat FROM commandes`).Scan(&etat)
	if rev != 1 || etat != 5 {
		t.Fatal(rev, etat)
	}
	if code, _, _ := run(cfg, "paiement", "revoquer", "b1b2c3d4e5f60718293a4b5c6d7e8f90"); code != 1 {
		t.Fatal("commande inconnue")
	}
	for _, a := range [][]string{{"paiement"}, {"paiement", "revoquer"}, {"paiement", "revoquer", "XYZ"}, {"paiement", "lister", c}} {
		if code, _, _ := run(cfg, a...); code != 2 {
			t.Errorf("%v : %d", a, code)
		}
	}
}

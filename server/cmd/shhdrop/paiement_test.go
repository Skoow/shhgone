package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/adminui"
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
	// Régime OSS : la crypto n'est pas proposée, ses webhooks restent lus.
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
// démarrage en production, message dit à l'exploitant.
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

// TestRetourOffresServi : /offres/retour sert la page des Offres (aucune donnée dans l'adresse) ;
// /offres/offert, l'application en 200 (le pass d'un accès offert suit « # »).
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
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/offres/offert", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "index") {
		t.Errorf("/offres/offert : %d %q", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
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

// Tableau de bord, paiement activé : agrégats (nombres et booléens, ni pass, ni commande, ni
// montant, ni pays) et suspension des ventes, réversible, sans redémarrage.
func TestAdminPaiementAgregats(t *testing.T) {
	cfg := cfgPaiement(t)
	p, err := setupPaiement(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer p.db.Close()
	cfg.AdminTokenHash = sha256.Sum256([]byte(jetonAdmin))
	h := adminui.New(adminConfig(cfg, adminDeps{pai: p.svc}))
	appel := func(method, path string) (int, string) {
		r := httptest.NewRequest(method, path, nil)
		r.RemoteAddr, r.Host = "127.0.0.1:4000", "localhost:9191"
		r.Header.Set("Authorization", "Bearer "+jetonAdmin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code, w.Body.String()
	}
	code, body := appel("GET", "/api/paiement")
	var v any
	if code != 200 || json.Unmarshal([]byte(body), &v) != nil {
		t.Fatal(code, body)
	}
	var chaines []string
	chainesDe(v, &chaines)
	if len(chaines) != 0 {
		t.Fatalf("chaînes dans les agrégats du paiement : %q", chaines)
	}
	var a paiement.Agregats
	json.Unmarshal([]byte(body), &a)
	if !a.Stripe.Configure || !a.Stripe.Vendable || a.PayPal.Configure || !a.NOWPayments.Configure || a.NOWPayments.Vendable ||
		!a.JetonsActif || a.Suspendu {
		t.Fatalf("%+v", a)
	}
	if c, _ := appel("POST", "/api/paiement/suspendre"); c != 200 {
		t.Fatal("suspendre", c)
	}
	if _, err := p.svc.Commander(context.Background(), paiement.Pass{1}, paiement.Formule{Offre: paiement.Plus,
		Jours: 30, Renouvelle: true, Moyen: paiement.Carte}, "FR", true); !errors.Is(err, paiement.ErrSuspendu) {
		t.Fatal("commande pendant la suspension :", err)
	}
	if _, body := appel("GET", "/api/paiement"); !strings.Contains(body, `"ventes_suspendues":true`) {
		t.Fatal(body)
	}
	if c, _ := appel("POST", "/api/paiement/retablir"); c != 200 {
		t.Fatal("rétablir", c)
	}
	if _, body := appel("GET", "/api/paiement"); !strings.Contains(body, `"ventes_suspendues":false`) {
		t.Fatal(body)
	}
}

// TestAdminAccesOffert : de bout en bout par le tableau de bord, paiement activé : le lien rendu
// pointe vers SHH_ORIGIN/offres/offert#P, P donne l'état Pro payé, la liste ne montre que
// l'empreinte, paiements.db ne contient jamais P, et la révocation coupe l'accès.
func TestAdminAccesOffert(t *testing.T) {
	cfg := cfgPaiement(t)
	p, err := setupPaiement(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer p.db.Close()
	cfg.AdminTokenHash = sha256.Sum256([]byte(jetonAdmin))
	h := adminui.New(adminConfig(cfg, adminDeps{pai: p.svc}))
	appel := func(method, path, corps string) (int, http.Header, string) {
		r := httptest.NewRequest(method, path, strings.NewReader(corps))
		r.RemoteAddr, r.Host = "127.0.0.1:4000", "localhost:9191"
		r.Header.Set("Authorization", "Bearer "+jetonAdmin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code, w.Header(), w.Body.String()
	}
	code, hd, body := appel("POST", "/api/paiement/offrir", `{"duree":"sans_fin"}`)
	if code != 200 || hd.Get("Cache-Control") != "no-store" {
		t.Fatal(code, hd, body)
	}
	var v struct {
		Lien  string               `json:"lien"`
		Acces paiement.AccesOffert `json:"acces"`
	}
	json.Unmarshal([]byte(body), &v)
	b64, ok := strings.CutPrefix(v.Lien, "https://shhgone.test/offres/offert#")
	if !ok {
		t.Fatal(v.Lien)
	}
	pass, err := paiement.PassDe(b64)
	if err != nil {
		t.Fatal(err)
	}
	e, err := p.svc.EtatDe(pass)
	if err != nil || e.Etat != "payee" || e.Offre != paiement.Pro {
		t.Fatalf("%+v %v", e, err)
	}
	q := pass.Empreinte()
	if v.Acces.ID != hex.EncodeToString(q[:]) {
		t.Fatal(v.Acces)
	}
	_, _, liste := appel("GET", "/api/paiement/offerts", "")
	if strings.Contains(liste, b64) || strings.Contains(liste, hex.EncodeToString(pass[:])) || !strings.Contains(liste, v.Acces.ID) {
		t.Fatal(liste)
	}
	fichiers, _ := filepath.Glob(filepath.Join(cfg.DataDir, "paiements.db*"))
	if len(fichiers) == 0 {
		t.Fatal("aucun fichier de base")
	}
	for _, f := range fichiers {
		c, _ := os.ReadFile(f)
		if bytes.Contains(c, pass[:]) || bytes.Contains(c, []byte(b64)) {
			t.Fatal("P écrit dans", f)
		}
	}
	if code, _, body := appel("POST", "/api/paiement/offerts/revoquer", `{"id":"`+v.Acces.ID+`"}`); code != 200 || body != `{"revoque":true}` {
		t.Fatal(code, body)
	}
	if e, _ := p.svc.EtatDe(pass); e.Etat != "revoquee" {
		t.Fatalf("%+v", e)
	}
	if _, _, body := appel("GET", "/api/paiement", ""); !strings.Contains(body, `"acces_offerts":0`) {
		t.Fatal(body)
	}
}

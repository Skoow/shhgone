package config

import (
	"maps"
	"strings"
	"testing"
)

func TestFromEnvSansDataDir(t *testing.T) {
	t.Setenv("SHH_DATA_DIR", "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("erreur attendue sans SHH_DATA_DIR")
	}
}

func TestFromEnvDefauts(t *testing.T) {
	t.Setenv("SHH_DATA_DIR", "/tmp/x")
	t.Setenv("SHH_LISTEN", "")
	t.Setenv("SHH_STORAGE_MAX", "")
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.DataDir != "/tmp/x" || c.Listen != "127.0.0.1:8080" || c.StorageMaxBytes != 214748364800 { // 200 Gio (spec §24, §41.2)
		t.Fatalf("défauts inattendus: %+v", c)
	}
	if c.Now == nil || c.Now().IsZero() {
		t.Fatal("Now doit être renseigné")
	}
}

func TestFromEnvValeurs(t *testing.T) {
	t.Setenv("SHH_DATA_DIR", "/d")
	t.Setenv("SHH_LISTEN", "127.0.0.1:9")
	t.Setenv("SHH_STORAGE_MAX", "100")
	c, err := FromEnv()
	if err != nil || c.Listen != "127.0.0.1:9" || c.StorageMaxBytes != 100 {
		t.Fatalf("%+v %v", c, err)
	}
}

func TestFromEnvStorageMaxInvalide(t *testing.T) {
	t.Setenv("SHH_DATA_DIR", "/d")
	t.Setenv("SHH_STORAGE_MAX", "abc")
	if _, err := FromEnv(); err == nil {
		t.Fatal("erreur attendue")
	}
	t.Setenv("SHH_STORAGE_MAX", "-5")
	if _, err := FromEnv(); err == nil {
		t.Fatal("erreur attendue pour négatif")
	}
}

func TestFromEnvProxyEtStatique(t *testing.T) {
	t.Setenv("SHH_DATA_DIR", "/d")
	t.Setenv("SHH_BEHIND_PROXY", "")
	t.Setenv("SHH_STATIC_DIR", "")
	c, err := FromEnv()
	if err != nil || c.BehindProxy || c.StaticDir != "" {
		t.Fatalf("défauts: %+v %v", c, err)
	}
	t.Setenv("SHH_BEHIND_PROXY", "1")
	t.Setenv("SHH_STATIC_DIR", "/web/dist")
	c, err = FromEnv()
	if err != nil || !c.BehindProxy || c.StaticDir != "/web/dist" {
		t.Fatalf("valeurs: %+v %v", c, err)
	}
	t.Setenv("SHH_BEHIND_PROXY", "0")
	if c, err := FromEnv(); err != nil || c.BehindProxy {
		t.Fatalf("0: %+v %v", c, err)
	}
	for _, v := range []string{"true", "yes", "2", " 1"} {
		t.Setenv("SHH_BEHIND_PROXY", v)
		if _, err := FromEnv(); err == nil {
			t.Fatalf("%q accepté", v)
		}
	}
}

// Salon (plan C-2, Task 2) : désactivé par défaut, 200 salons vivants au plus (spec §39.3.2).
func TestSalonsDefautDesactive(t *testing.T) {
	env(t, map[string]string{"SHH_DATA_DIR": "/d"})
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.Salons || c.SalonsMax != 200 || c.Origin != "" {
		t.Fatalf("défauts du salon : Salons=%v SalonsMax=%d Origin=%q", c.Salons, c.SalonsMax, c.Origin)
	}
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": "0"})
	if c, err := FromEnv(); err != nil || c.Salons {
		t.Fatalf("SHH_SALONS=0 : %+v %v", c, err)
	}
	for _, v := range []string{"2", "true", " 1", "01"} {
		env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": v, "SHH_ORIGIN": "https://shhdrop.app"})
		if _, err := FromEnv(); err == nil {
			t.Errorf("SHH_SALONS=%q accepté", v)
		}
	}
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": "1", "SHH_ORIGIN": "https://shhdrop.app", "SHH_SALONS_MAX": "500"})
	c, err = FromEnv()
	if err != nil || !c.Salons || c.Origin != "https://shhdrop.app" || c.SalonsMax != 500 {
		t.Fatalf("salon activé : %+v %v", c, err)
	}
	// Audit adverse du 13 novembre, front serveur : SHH_SALONS_MAX est croisé avec la mémoire
	// au démarrage (checkSalons). 10 000 salons demandent un plafond global de trames à leur
	// mesure : refus sans lui, accepté avec ; sans effet si le salon est désactivé.
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": "1", "SHH_ORIGIN": "https://shhdrop.app", "SHH_SALONS_MAX": "10000"})
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "SHH_SALONS_MAX=10000") {
		t.Fatal("10 000 salons sans la mémoire pour acceptés :", err)
	}
	t.Setenv("SHH_SALON_FRAMES_TOTAL", "20000000")
	if c, err = FromEnv(); err != nil || c.SalonsMax != 10000 {
		t.Fatalf("10 000 salons avec un plafond global à leur mesure : %+v %v", c, err)
	}
	t.Setenv("SHH_SALON_FRAMES_TOTAL", "")
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS_MAX": "10000"})
	if c, err = FromEnv(); err != nil || c.Salons || c.SalonsMax != 10000 {
		t.Fatalf("salon désactivé : %+v %v", c, err)
	}
}

// Point 13 du plan : SHH_ORIGIN sert au contrôle d'Origin du WebSocket et à la CSP.
func TestOriginObligatoire(t *testing.T) {
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": "1"})
	if _, err := FromEnv(); err == nil {
		t.Fatal("SHH_SALONS=1 sans SHH_ORIGIN accepté")
	}
}

func TestOriginInvalide(t *testing.T) {
	for _, c := range []struct {
		v  string
		ok bool
	}{
		{"https://a.test/", false},
		{"https://a.test/x", false},
		{"ftp://a.test", false},
		{"http://a.test", false},
		{"https://a.test?x", false},
		{"https://user@a.test", false},
		{"https://a.test#x", false},
		{"https://a.test?", false},
		{"https://A.test", false},       // l'en-tête Origin est en minuscules
		{"HTTPS://a.test", false},       // idem
		{"https://a.test:443", false},   // le navigateur omet le port par défaut
		{"http://127.0.0.1:80", false},  // idem
		{"https://a.test:0", false},     // port hors limites
		{"https://a.test:65536", false}, // port hors limites
		{"https://a.test:08080", false}, // forme non canonique
		{"https://a.test:", false},
		{"https://a.test.", false},
		{"https://a..test", false},
		{"https://*.a.test", false},            // joker : il serait copié dans la CSP
		{"https://a.test;script-src", false},   // injection dans la CSP
		{"https://a.test wss://b.test", false}, // idem
		{"https://[::1]:8080", false},          // IPv6 : non pris en charge par la CSP (host-source)
		{"http://[::1]:8080", false},           // idem
		{"http://192.168.1.2:8080", false},     // http hors boucle locale
		{"https://", false},
		{"https:a.test", false},
		{"//a.test", false},
		{"a.test", false},
		{"https://shhdrop.app", true},
		{"https://shhdrop.app:8443", true},
		{"https://xn--bcher-kva.example", true},
		{"https://203.0.113.5", true},
		{"http://127.0.0.1:8080", true},
		{"http://localhost:5173", true},
		{"http://localhost", true},
	} {
		env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": "1", "SHH_ORIGIN": c.v})
		got, err := FromEnv()
		if c.ok && (err != nil || got.Origin != c.v) {
			t.Errorf("SHH_ORIGIN=%q refusé : %v", c.v, err)
		}
		if !c.ok && err == nil {
			t.Errorf("SHH_ORIGIN=%q accepté", c.v)
		}
	}
	// Une origine invalide est refusée même salon désactivé (erreur de configuration visible).
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_ORIGIN": "https://a.test/"})
	if _, err := FromEnv(); err == nil {
		t.Error("SHH_ORIGIN invalide accepté avec SHH_SALONS=0")
	}
}

func TestSalonsMaxInvalide(t *testing.T) {
	for _, v := range []string{"0", "-1", "007", "x", "10001", "+5", " 5", "5 ", "1e3", "0x10"} {
		env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": "1", "SHH_ORIGIN": "https://shhdrop.app", "SHH_SALONS_MAX": v})
		if _, err := FromEnv(); err == nil {
			t.Errorf("SHH_SALONS_MAX=%q accepté", v)
		}
	}
	for _, v := range []string{"1", "50", "10000"} {
		env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS_MAX": v})
		if _, err := FromEnv(); err != nil {
			t.Errorf("SHH_SALONS_MAX=%q refusé : %v", v, err)
		}
	}
}

// Compte (conception du compte par passkey) : désactivé par défaut, rien d'autre n'est exigé.
func TestComptesDefautDesactive(t *testing.T) {
	env(t, map[string]string{"SHH_DATA_DIR": "/d"})
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.Comptes || c.ComptesCleFile != "" || c.ComptesMax != 10000 || c.ComptesJour != 500 {
		t.Fatalf("défauts du compte : %+v %d %d", c.Comptes, c.ComptesMax, c.ComptesJour)
	}
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_COMPTES": "0"})
	if c, err := FromEnv(); err != nil || c.Comptes {
		t.Fatalf("SHH_COMPTES=0 : %v %v", c.Comptes, err)
	}
}

// comptesOK : configuration complète et valide avec SHH_COMPTES=1 (aucune variable d'e-mail).
func comptesOK() map[string]string {
	return map[string]string{
		"SHH_DATA_DIR": "/d", "SHH_SALONS": "1", "SHH_ORIGIN": "https://shhgone.com",
		"SHH_COMPTES": "1", "SHH_COMPTES_CLE_FILE": "/run/secrets/shh_comptes_cle",
	}
}

func avec(kv map[string]string, k, v string) map[string]string {
	m := maps.Clone(kv)
	m[k] = v
	return m
}

func TestComptesConfigValide(t *testing.T) {
	env(t, comptesOK())
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !c.Comptes || c.ComptesCleFile != "/run/secrets/shh_comptes_cle" || c.ComptesMax != 10000 || c.ComptesJour != 500 {
		t.Fatalf("%v %q %d %d", c.Comptes, c.ComptesCleFile, c.ComptesMax, c.ComptesJour)
	}
	env(t, avec(comptesOK(), "SHH_COMPTES_MAX", "1000000"))
	if c, err := FromEnv(); err != nil || c.ComptesMax != 1000000 {
		t.Fatal(c.ComptesMax, err)
	}
	// Tests du compte : localhost (les navigateurs refusent une adresse IP comme rp.id).
	env(t, avec(comptesOK(), "SHH_ORIGIN", "http://localhost:8080"))
	if c, err := FromEnv(); err != nil || RPID(c.Origin) != "localhost" {
		t.Fatal(err)
	}
}

// TestComptesJour : SHH_COMPTES_JOUR de 1 à 100 000 (plafond global, conception §7.2).
func TestComptesJour(t *testing.T) {
	for v, n := range map[string]int{"1": 1, "500": 500, "100000": 100000} {
		env(t, avec(comptesOK(), "SHH_COMPTES_JOUR", v))
		if c, err := FromEnv(); err != nil || c.ComptesJour != n {
			t.Errorf("%s : %d %v", v, c.ComptesJour, err)
		}
	}
	for _, v := range []string{"0", "100001", "010", "-1", "dix", " 5"} {
		env(t, avec(comptesOK(), "SHH_COMPTES_JOUR", v))
		if _, err := FromEnv(); err == nil {
			t.Errorf("SHH_COMPTES_JOUR=%q accepté", v)
		}
	}
}

// TestRPIDProduction : rp.id = hôte de SHH_ORIGIN (shhgone.com en production, R1) ; jamais une
// adresse IP.
func TestRPIDProduction(t *testing.T) {
	for o, w := range map[string]string{"https://shhgone.com": "shhgone.com", "http://localhost:8080": "localhost",
		"https://a.b.example:8443": "a.b.example", "http://127.0.0.1:8080": "", "": "", "shhgone.com": ""} {
		if g := RPID(o); g != w {
			t.Errorf("RPID(%q) = %q, attendu %q", o, g, w)
		}
	}
	env(t, avec(comptesOK(), "SHH_ORIGIN", "http://127.0.0.1:8080"))
	if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "rp.id") {
		t.Fatal("origine en adresse IP acceptée avec les comptes :", err)
	}
	// Sans compte, une origine en adresse IP reste permise (salon, tests e2e).
	m := avec(comptesOK(), "SHH_ORIGIN", "http://127.0.0.1:8080")
	m["SHH_COMPTES"] = "0"
	env(t, m)
	if _, err := FromEnv(); err != nil {
		t.Fatal(err)
	}
}

// TestConfigSMTPRefuse : le compte par e-mail est retiré ; chaque ancienne variable d'envoi
// d'e-mails, encore posée, fait refuser le démarrage, compte activé ou non (conception §17).
func TestConfigSMTPRefuse(t *testing.T) {
	for _, k := range []string{"SHH_SMTP_HOST", "SHH_SMTP_PORT", "SHH_SMTP_USER", "SHH_SMTP_PASSWORD_FILE", "SHH_MAIL_FROM",
		"SHH_SMTP_AUTRE"} {
		for _, base := range []map[string]string{comptesOK(), {"SHH_DATA_DIR": "/d"}} {
			env(t, base)
			t.Setenv(k, "x")
			_, err := FromEnv()
			if err == nil || !strings.Contains(err.Error(), k) || !strings.Contains(err.Error(), "retiré") {
				t.Errorf("%s accepté : %v", k, err)
			}
		}
	}
}

func TestComptesConfigRefusee(t *testing.T) {
	sans := func(k string) map[string]string { m := comptesOK(); delete(m, k); return m }
	cas := map[string]map[string]string{
		"SHH_COMPTES=2":               {"SHH_DATA_DIR": "/d", "SHH_COMPTES": "2"},
		"SHH_COMPTES=true":            {"SHH_DATA_DIR": "/d", "SHH_COMPTES": "true"},
		"sans SHH_SALONS=1":           avec(comptesOK(), "SHH_SALONS", "0"),
		"sans clé":                    sans("SHH_COMPTES_CLE_FILE"),
		"clé relative":                avec(comptesOK(), "SHH_COMPTES_CLE_FILE", "cle"),
		"clé dans SHH_DATA_DIR":       avec(comptesOK(), "SHH_COMPTES_CLE_FILE", "/d/cle"),
		"clé = SHH_DATA_DIR":          avec(comptesOK(), "SHH_COMPTES_CLE_FILE", "/d"),
		"clé sous SHH_DATA_DIR (..)":  avec(comptesOK(), "SHH_COMPTES_CLE_FILE", "/x/../d/sous/cle"),
		"clé sous SHH_DATA_DIR (..x)": avec(comptesOK(), "SHH_COMPTES_CLE_FILE", "/d/..x/cle"),
		"max 0":                       avec(comptesOK(), "SHH_COMPTES_MAX", "0"),
		"max 1000001":                 avec(comptesOK(), "SHH_COMPTES_MAX", "1000001"),
		"max 010":                     avec(comptesOK(), "SHH_COMPTES_MAX", "010"),
		"max texte":                   avec(comptesOK(), "SHH_COMPTES_MAX", "dix"),
		// Valeur fausse refusée même compte désactivé (comme SHH_SALONS_MAX, SHH_ORIGIN).
		"max faux, compte coupé":  {"SHH_DATA_DIR": "/d", "SHH_COMPTES_MAX": "0"},
		"jour faux, compte coupé": {"SHH_DATA_DIR": "/d", "SHH_COMPTES_JOUR": "0"},
	}
	for nom, kv := range cas {
		env(t, kv)
		if _, err := FromEnv(); err == nil {
			t.Errorf("%s accepté", nom)
		}
	}
}

// SHH_WEBAUTHN_ORIGINES_APPS : vide par défaut ; chaque origine exactement
// android:apk-key-hash:<43 caractères base64url> (conception du compte par passkey §6.2).
func TestOriginesApps(t *testing.T) {
	env(t, comptesOK())
	if c, err := FromEnv(); err != nil || c.WebAuthnOriginesApps != nil {
		t.Fatal(c.WebAuthnOriginesApps, err)
	}
	a := "android:apk-key-hash:" + strings.Repeat("A", 42) + "E"
	b := "android:apk-key-hash:" + strings.Repeat("_", 42) + "w"
	env(t, avec(comptesOK(), "SHH_WEBAUTHN_ORIGINES_APPS", a+","+b))
	if c, err := FromEnv(); err != nil || len(c.WebAuthnOriginesApps) != 2 || c.WebAuthnOriginesApps[1] != b {
		t.Fatal(c.WebAuthnOriginesApps, err)
	}
	for _, v := range []string{"android:apk-key-hash:", a + "A", a[:len(a)-1], a + ", " + b, a + ",", "https://shhgone.com",
		"android:apk-key-hash:" + strings.Repeat("A", 42) + "B", "ios:" + strings.Repeat("A", 43)} {
		env(t, avec(comptesOK(), "SHH_WEBAUTHN_ORIGINES_APPS", v))
		if _, err := FromEnv(); err == nil {
			t.Errorf("%q accepté", v)
		}
	}
}

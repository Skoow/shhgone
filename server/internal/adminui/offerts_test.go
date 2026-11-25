package adminui

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	"github.com/skoow/shhdrop/server/internal/paiement"
)

// bancOfferts : page avec les crochets des accès offerts, qui comptent leurs appels.
type bancOfferts struct {
	*banc
	offrir, listes, revoques []string
	pass                     paiement.Pass
}

func nouveauBancOfferts(t *testing.T, mod func(*Paiement)) *bancOfferts {
	t.Helper()
	b := &bancOfferts{banc: &banc{}}
	for i := range b.pass {
		b.pass[i] = byte(i + 1)
	}
	p := &Paiement{
		Agregats:  func() (paiement.Agregats, error) { return paiement.Agregats{AccesOfferts: 2}, nil },
		Suspendre: func(bool) {},
		Offrir: func(jours int) (paiement.Pass, paiement.AccesOffert, error) {
			b.offrir = append(b.offrir, map[int]string{30: "mois", 365: "an", 3650: "sans_fin"}[jours])
			return b.pass, paiement.AccesOffert{ID: strings.Repeat("ab", 32), Court: "ababab", Cree: "2026-11-25", Fin: "2027-11-25", Jetons: 1000, Etat: "actif"}, nil
		},
		Offerts: func() ([]paiement.AccesOffert, error) {
			b.listes = append(b.listes, "")
			return []paiement.AccesOffert{{ID: strings.Repeat("cd", 32), Court: "cdcdcd", Cree: "2026-11-01", Fin: "2026-12-01", Jetons: 990, Etat: "actif"}}, nil
		},
		RevoquerOffert: func(id string) (bool, error) {
			b.revoques = append(b.revoques, id)
			return id == strings.Repeat("cd", 32), nil
		},
		Origine: "https://shhgone.test",
	}
	if mod != nil {
		mod(p)
	}
	b.h = New(Config{TokenHash: sha256.Sum256([]byte(jeton)), Peers: []netip.Prefix{netip.MustParsePrefix("172.30.53.1/32")},
		State: func() (State, error) { return State{}, nil }, Paiement: p})
	return b
}

func (b *bancOfferts) appels() int { return len(b.offrir) + len(b.listes) + len(b.revoques) }

// TestOffertsRefus : sans jeton (une page d'un autre site ne peut pas poser Authorization : c'est
// la protection contre les requêtes forgées de toute la page), avec un paramètre, la mauvaise
// méthode, sans paiement, sans crochets ou avec une origine douteuse : la réponse d'une route
// inconnue, et rien n'est appelé.
func TestOffertsRefus(t *testing.T) {
	ref := nouveauBanc().faire(req{method: "GET", path: "/api/nimporte"})
	routes := []req{
		{method: "POST", path: "/api/paiement/offrir", corps: `{"duree":"an"}`},
		{method: "GET", path: "/api/paiement/offerts"},
		{method: "POST", path: "/api/paiement/offerts/revoquer", corps: `{"id":"` + strings.Repeat("cd", 32) + `"}`},
	}
	pareil := func(nom string, b *bancOfferts, q req) {
		t.Helper()
		w := b.faire(q)
		if w.Code != ref.Code || !bytes.Equal(w.Body.Bytes(), ref.Body.Bytes()) || b.appels() != 0 {
			t.Errorf("%s : %d %s (%d appels)", nom, w.Code, w.Body.String(), b.appels())
		}
	}
	for _, r := range routes {
		b := nouveauBancOfferts(t, nil)
		// Requête forgée par un autre site : en-têtes d'un formulaire ou d'un fetch sans CORS.
		forge := r
		forge.hdr = [][2]string{{"Origin", "https://malveillant.example"}, {"Content-Type", "text/plain"}, {"Cookie", "a=b"}}
		pareil(r.path+" forgée", b, forge)
		faux := r
		faux.hdr = [][2]string{{"Authorization", "Bearer " + strings.Repeat("f", 64)}}
		pareil(r.path+" jeton faux", b, faux)
		param := r
		param.path += "?duree=an"
		param.hdr = [][2]string{bon()}
		pareil(r.path+" paramètre", b, param)
		autre := r
		autre.hdr = [][2]string{bon()}
		autre.method = map[string]string{"GET": "POST", "POST": "GET"}[r.method]
		pareil(r.path+" méthode", b, autre)
		relaye := r
		relaye.hdr = [][2]string{bon(), {"X-Shh-Client-IP", "203.0.113.9"}}
		pareil(r.path+" relayée", b, relaye)
		avec := r
		avec.hdr = [][2]string{bon()}
		pareil(r.path+" sans paiement", &bancOfferts{banc: nouveauBanc()}, avec)
		for nom, mod := range map[string]func(*Paiement){
			"sans Offrir":        func(p *Paiement) { p.Offrir = nil },
			"sans origine":       func(p *Paiement) { p.Origine = "" },
			"origine ftp":        func(p *Paiement) { p.Origine = "ftp://shhgone.test" },
			"origine nue":        func(p *Paiement) { p.Origine = "https://" },
			"origine guillemet":  func(p *Paiement) { p.Origine = `https://x"y` },
			"origine espace":     func(p *Paiement) { p.Origine = "https://x y" },
			"origine contrôle":   func(p *Paiement) { p.Origine = "https://x\ny" },
			"origine anti-barre": func(p *Paiement) { p.Origine = `https://x\y` },
		} {
			pareil(r.path+" "+nom, nouveauBancOfferts(t, mod), avec)
		}
	}
}

// TestOffrir : le lien rendu porte le pass après « # », sur l'origine publique ; réponse
// « no-store » ; durée inconnue, champ en trop ou corps illisible : 400 sans rien créer.
func TestOffrir(t *testing.T) {
	b := nouveauBancOfferts(t, nil)
	for _, corps := range []string{``, `{}`, `{"duree":"illimite"}`, `{"duree":"an","note":"Alice"}`, `{"duree":30}`, `{"duree":"an"}{}`, `[]`} {
		w := b.faire(req{method: "POST", path: "/api/paiement/offrir", corps: corps, hdr: [][2]string{bon()}})
		if w.Code != 400 || w.Body.String() != `{"error":"bad_request"}` {
			t.Errorf("%s : %d %s", corps, w.Code, w.Body.String())
		}
	}
	if len(b.offrir) != 0 {
		t.Fatal("créé malgré un refus :", b.offrir)
	}
	for _, d := range []string{"mois", "an", "sans_fin"} {
		w := b.faire(req{method: "POST", path: "/api/paiement/offrir", corps: `{"duree":"` + d + `"}`, hdr: [][2]string{bon()}})
		if w.Code != 200 {
			t.Fatal(d, w.Code, w.Body.String())
		}
		if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
			t.Fatal("Cache-Control :", cc)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/json" {
			t.Fatal("Content-Type :", ct)
		}
		var v struct {
			Lien  string               `json:"lien"`
			Acces paiement.AccesOffert `json:"acces"`
		}
		d2 := json.NewDecoder(bytes.NewReader(w.Body.Bytes()))
		d2.DisallowUnknownFields()
		if err := d2.Decode(&v); err != nil {
			t.Fatal(err, w.Body.String())
		}
		want := "https://shhgone.test/offres/offert#" + base64.RawURLEncoding.EncodeToString(b.pass[:])
		if v.Lien != want || v.Acces.Court != "ababab" || v.Acces.Jetons != 1000 {
			t.Fatalf("%+v", v)
		}
	}
	if strings.Join(b.offrir, ",") != "mois,an,sans_fin" {
		t.Fatal(b.offrir)
	}
}

// TestOffertsListeEtRevoquer : la liste ne rend que ce que le service donne (empreintes) ;
// révoquer exige un identifiant de 64 caractères dans le corps.
func TestOffertsListeEtRevoquer(t *testing.T) {
	b := nouveauBancOfferts(t, nil)
	w := b.faire(req{method: "GET", path: "/api/paiement/offerts", hdr: [][2]string{bon()}})
	if w.Code != 200 || !strings.HasPrefix(w.Body.String(), `{"offerts":[{"id":"cdcd`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), base64.RawURLEncoding.EncodeToString(b.pass[:])) {
		t.Fatal("pass dans la liste")
	}
	for _, corps := range []string{`{}`, `{"id":"cdcd"}`, `{"id":"` + strings.Repeat("cd", 33) + `"}`, `{"id":1}`} {
		w := b.faire(req{method: "POST", path: "/api/paiement/offerts/revoquer", corps: corps, hdr: [][2]string{bon()}})
		if w.Code != 400 {
			t.Errorf("%s : %d", corps, w.Code)
		}
	}
	if len(b.revoques) != 0 {
		t.Fatal(b.revoques)
	}
	w = b.faire(req{method: "POST", path: "/api/paiement/offerts/revoquer", corps: `{"id":"` + strings.Repeat("cd", 32) + `"}`, hdr: [][2]string{bon()}})
	if w.Code != 200 || w.Body.String() != `{"revoque":true}` {
		t.Fatal(w.Code, w.Body.String())
	}
	w = b.faire(req{method: "POST", path: "/api/paiement/offerts/revoquer", corps: `{"id":"` + strings.Repeat("ef", 32) + `"}`, hdr: [][2]string{bon()}})
	if w.Code != 200 || w.Body.String() != `{"revoque":false}` {
		t.Fatal(w.Code, w.Body.String())
	}
	// Agrégats : le nombre d'accès offerts est lu à l'instant.
	w = b.faire(req{method: "GET", path: "/api/paiement", hdr: [][2]string{bon()}})
	if !strings.Contains(w.Body.String(), `"acces_offerts":2`) {
		t.Fatal(w.Body.String())
	}
}

// Les noms des accès offerts restent dans le navigateur de l'exploitant : la création n'envoie
// que la durée, et le script ne fait aucun autre envoi qui porterait un nom.
func TestNomsOffertsRestentDansLeNavigateur(t *testing.T) {
	js, err := page.ReadFile("page/admin.js")
	if err != nil {
		t.Fatal(err)
	}
	s := string(js)
	if !strings.Contains(s, "envoyer('POST', '/api/paiement/offrir', { duree })") {
		t.Fatal("la création d'un accès offert envoie autre chose que la durée")
	}
	if strings.Count(s, "localStorage.") != 2 || !strings.Contains(s, "localStorage.getItem(CLE_NOMS)") || !strings.Contains(s, "localStorage.setItem(CLE_NOMS,") {
		t.Fatal("le stockage du navigateur ne doit servir qu'aux noms des accès offerts")
	}
	if strings.Contains(s, "localStorage.setItem(CLE_NOMS, jeton") || strings.Contains(s, "sessionStorage") || strings.Contains(s, "document.cookie") {
		t.Fatal("aucun autre stockage dans la page")
	}
}

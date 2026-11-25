package adminui

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	"github.com/skoow/shhdrop/server/internal/paiement"
)

// Onglet Paiement (25 novembre) : routes refusées comme inconnues sans SHH_PAIEMENT=1, sans
// jeton, avec un paramètre ou la mauvaise méthode ; avec le jeton, agrégats (nombres et
// booléens seulement) et suspension réversible.
func TestPaiementRoutes(t *testing.T) {
	var suspendu []bool
	avec := &banc{}
	avec.h = New(Config{TokenHash: sha256.Sum256([]byte(jeton)), Peers: []netip.Prefix{netip.MustParsePrefix("172.30.53.1/32")},
		State: func() (State, error) { return State{}, nil },
		Paiement: &Paiement{
			Agregats: func() (paiement.Agregats, error) {
				return paiement.Agregats{PassPlus: 3, JetonsEmis: [2]int64{7, 1}}, nil
			},
			Suspendre: func(v bool) { suspendu = append(suspendu, v) },
		}})
	sans := nouveauBanc()
	ref := sans.faire(req{method: "GET", path: "/api/nimporte"})
	routes := [][2]string{{"GET", "/api/paiement"}, {"POST", "/api/paiement/suspendre"}, {"POST", "/api/paiement/retablir"}}
	pareil := func(nom string, b *banc, q req) {
		t.Helper()
		w := b.faire(q)
		if w.Code != ref.Code || !bytes.Equal(w.Body.Bytes(), ref.Body.Bytes()) {
			t.Errorf("%s : %d %s", nom, w.Code, w.Body.String())
		}
	}
	for _, r := range routes {
		pareil(r[1]+" sans paiement", sans, req{method: r[0], path: r[1], hdr: [][2]string{bon()}})
		pareil(r[1]+" sans jeton", avec, req{method: r[0], path: r[1]})
		pareil(r[1]+" paramètre", avec, req{method: r[0], path: r[1] + "?x=1", hdr: [][2]string{bon()}})
		autre := "POST"
		if r[0] == "POST" {
			autre = "GET"
		}
		pareil(r[1]+" méthode", avec, req{method: autre, path: r[1], hdr: [][2]string{bon()}})
	}
	if len(suspendu) != 0 {
		t.Fatal("suspension appelée malgré un refus :", suspendu)
	}

	w := avec.faire(req{method: "GET", path: "/api/paiement", hdr: [][2]string{bon()}})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var v map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil || v["pass_plus"] != float64(3) {
		t.Fatal(err, v)
	}
	if strings.Contains(w.Body.String(), `"`+"montant") || strings.Contains(w.Body.String(), "pays") {
		t.Fatal("montant ou pays dans la réponse :", w.Body.String())
	}
	for _, c := range chainesDe(v) {
		t.Errorf("chaîne dans les agrégats du paiement : %q", c)
	}
	if w := avec.faire(req{method: "POST", path: "/api/paiement/suspendre", hdr: [][2]string{bon()}}); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := avec.faire(req{method: "POST", path: "/api/paiement/retablir", hdr: [][2]string{bon()}}); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if len(suspendu) != 2 || !suspendu[0] || suspendu[1] {
		t.Fatal("suspension :", suspendu)
	}
}

// chainesDe : toutes les chaînes (valeurs) d'un JSON décodé.
func chainesDe(x any) (out []string) {
	switch y := x.(type) {
	case map[string]any:
		for _, e := range y {
			out = append(out, chainesDe(e)...)
		}
	case []any:
		for _, e := range y {
			out = append(out, chainesDe(e)...)
		}
	case string:
		out = append(out, y)
	}
	return out
}

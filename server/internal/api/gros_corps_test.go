package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/skoow/shhdrop/server/internal/compte"
)

// Gros corps JSON (audit du 20 novembre) : refusés avant toute lecture sans longueur annoncée,
// au-delà du plafond, ou quand les places sont prises ; les petits corps ne sont pas touchés.
//
// Places tenues sous la clé HMAC du jour du limiteur (inventaire des adresses IP du
// 22 novembre) : jamais sous le préfixe /64 ou /48 en clair.
func TestGrosCorpsBornes(t *testing.T) {
	const gros = 1 << 20
	e := newEnv(t, false, nil)
	lire := e.srv.lireGros
	req := func(body string, ip string) *http.Request {
		r := httptest.NewRequest("POST", "/api/compte/inscription/fin", strings.NewReader(body))
		return r.WithContext(context.WithValue(r.Context(), ctxIP{}, netip.MustParseAddr(ip)))
	}
	var v struct {
		A string `json:"a"`
	}
	// Corps valable, longueur annoncée : lu.
	if err := lire(httptest.NewRecorder(), req(`{"a":"x"}`, "2001:db8:1::1"), &v, gros); err != nil || v.A != "x" {
		t.Fatalf("corps valable : %v %q", err, v.A)
	}
	// Envoi par blocs (longueur inconnue) : refusé sans lecture, connexion fermée.
	r := req(`{"a":"x"}`, "2001:db8:1::1")
	r.ContentLength = -1
	w := httptest.NewRecorder()
	if err := lire(w, r, &v, gros); !errors.Is(err, errBadRequest) || w.Header().Get("Connection") != "close" {
		t.Fatalf("par blocs : %v %q", err, w.Header().Get("Connection"))
	}
	// Longueur annoncée au-delà du plafond : refusé sans lecture.
	r = req(`{"a":"x"}`, "2001:db8:1::1")
	r.ContentLength = gros + 1
	if err := lire(httptest.NewRecorder(), r, &v, gros); !errors.Is(err, errBadRequest) {
		t.Fatalf("trop long : %v", err)
	}
	// Deux lectures en cours depuis la même connexion : la troisième est refusée (503 busy),
	// une autre connexion du même bloc passe encore, puis le bloc est plein à 4.
	// Clés du limiteur : si lireGros prenait encore le préfixe en clair, ces deux places ne
	// compteraient pas pour la connexion et la troisième lecture passerait.
	k64, k48 := e.srv.lim.Key(netip.MustParseAddr("2001:db8:1::1"))
	var rendre []func()
	for i := 0; i < 2; i++ {
		f, err := grosCorps.Acquire(k64, k48)
		if err != nil {
			t.Fatal(err)
		}
		rendre = append(rendre, f)
	}
	w = httptest.NewRecorder()
	if err := lire(w, req(`{"a":"x"}`, "2001:db8:1::1"), &v, gros); !errors.Is(err, compte.ErrBusy) || w.Header().Get("Connection") != "close" {
		t.Fatalf("connexion pleine : %v", err)
	}
	if err := lire(httptest.NewRecorder(), req(`{"a":"y"}`, "2001:db8:1:1::1"), &v, gros); err != nil {
		t.Fatalf("autre connexion du bloc : %v", err)
	}
	// Un petit corps (plafond ordinaire) ne prend aucune place.
	if err := e.srv.lireGros(httptest.NewRecorder(), req(`{"a":"z"}`, "2001:db8:1::1"), &v, maxJSON); err != nil || v.A != "z" {
		t.Fatalf("petit corps : %v", err)
	}
	for _, f := range rendre {
		f()
	}
	// Places rendues : la connexion relit.
	if err := lire(httptest.NewRecorder(), req(`{"a":"x"}`, "2001:db8:1::1"), &v, gros); err != nil {
		t.Fatalf("après libération : %v", err)
	}
	if n, _ := grosCorps.InUse(); n != 0 {
		t.Fatalf("places tenues après les lectures : %d", n)
	}
}

// lire refuse d'office un gros corps (erreur de programmation) : sans place prise, il passerait
// outre les bornes de grosCorps.
func TestLireGrosCorpsInterdit(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("lire a accepté un plafond de gros corps")
		}
	}()
	r := httptest.NewRequest("POST", "/", strings.NewReader(`{}`))
	var v struct{}
	_ = lire(httptest.NewRecorder(), r, &v, maxJSON+1)
}

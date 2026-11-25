package adminui

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/compte"
)

// bancSurMesure : page avec les crochets des comptes sur mesure (faux service en mémoire).
type bancSurMesure struct {
	*banc
	clk     time.Time
	comptes map[[16]byte]*compte.CompteAdmin
	appels  []string
}

var hLea = [16]byte{0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0}

func nouveauBancSurMesure(t *testing.T, mod func(*SurMesure)) *bancSurMesure {
	t.Helper()
	b := &bancSurMesure{banc: &banc{}, clk: time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC), comptes: map[[16]byte]*compte.CompteAdmin{
		hLea: {H: hLea, Court: "1a2b3c4d", CreeLe: "2026-11-14", Palier: "confirme", Limites: compte.LimitesVue{Salons: 3, Places: 10, Heures: 24}},
	}}
	sm := &SurMesure{
		Chercher: func(p string) (*compte.CompteAdmin, error) {
			b.appels = append(b.appels, "chercher "+p)
			if p == "Lea" {
				return b.comptes[hLea], nil
			}
			if p == "a" {
				return nil, compte.ErrRequete
			}
			return nil, nil
		},
		Liste: func() ([]compte.CompteAdmin, error) {
			b.appels = append(b.appels, "liste")
			out := []compte.CompteAdmin{}
			for _, c := range b.comptes {
				if c.SurMesure != nil {
					out = append(out, *c)
				}
			}
			return out, nil
		},
		Poser: func(h [16]byte, m compte.SurMesure) (*compte.CompteAdmin, error) {
			b.appels = append(b.appels, "poser "+hex.EncodeToString(h[:2])+" "+m.Nom)
			c := b.comptes[h]
			m.Depuis = "2026-11-25"
			c.SurMesure = &m
			c.Limites = compte.LimitesVue{Salons: m.Salons, Places: m.Places, Heures: m.Jours * 24}
			return c, nil
		},
		Retirer: func(h [16]byte) (*compte.CompteAdmin, error) {
			b.appels = append(b.appels, "retirer "+hex.EncodeToString(h[:2]))
			c := b.comptes[h]
			c.SurMesure = nil
			c.Limites = compte.LimitesVue{Salons: 3, Places: 10, Heures: 24}
			return c, nil
		},
	}
	if mod != nil {
		mod(sm)
	}
	b.h = New(Config{TokenHash: sha256.Sum256([]byte(jeton)), Peers: []netip.Prefix{netip.MustParsePrefix("172.30.53.1/32")},
		State: func() (State, error) { return State{}, nil }, Now: func() time.Time { return b.clk },
		Comptes: &Comptes{Agregats: func() (Agregats, error) { return Agregats{}, nil },
			Liste:     func(string, int) ([]compte.BanVue, int, error) { return nil, 0, nil },
			Action:    func(string, string, string) (compte.BanVue, *compte.BanVue, error) { return compte.BanVue{}, nil, nil },
			Bannir:    func([]byte, int, uint8) (Resultat, error) { return Resultat{}, nil },
			SurMesure: sm}})
	return b
}

func (b *bancSurMesure) post(path, corps string) (int, string) {
	w := b.faire(req{method: "POST", path: path, corps: corps, hdr: [][2]string{bon()}})
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
		panic("en-têtes de réponse : " + w.Header().Get("Cache-Control"))
	}
	return w.Code, w.Body.String()
}

// refDe : ref rendue pour le compte d'une réponse { compte }.
func refDe(t *testing.T, corps string) string {
	t.Helper()
	var v struct {
		Compte struct {
			Ref string `json:"ref"`
		} `json:"compte"`
	}
	if err := json.Unmarshal([]byte(corps), &v); err != nil || len(v.Compte.Ref) != 22 {
		t.Fatalf("pas de ref : %s %v", corps, err)
	}
	return v.Compte.Ref
}

// TestSurMesureRefus : jeton absent ou faux, requête forgée par un autre site, relayée par le
// proxy public, paramètre d'URL, mauvaise méthode, hôte étranger, sans crochets : la réponse
// d'une route inconnue, rien d'appelé.
func TestSurMesureRefus(t *testing.T) {
	ref := nouveauBanc().faire(req{method: "GET", path: "/api/nimporte"})
	routes := []req{
		{method: "POST", path: "/api/comptes/chercher", corps: `{"pseudo":"Lea"}`},
		{method: "GET", path: "/api/comptes/surmesure"},
		{method: "POST", path: "/api/comptes/surmesure/poser", corps: `{"ref":"AAAAAAAAAAAAAAAAAAAAAA","salons":1,"places":2,"jours":1,"nom":"x"}`},
		{method: "POST", path: "/api/comptes/surmesure/retirer", corps: `{"ref":"AAAAAAAAAAAAAAAAAAAAAA"}`},
	}
	for _, r := range routes {
		pareil := func(nom string, b *bancSurMesure, q req) {
			t.Helper()
			w := b.faire(q)
			if w.Code != ref.Code || !bytes.Equal(w.Body.Bytes(), ref.Body.Bytes()) || len(b.appels) != 0 {
				t.Errorf("%s %s : %d %s (%v)", r.path, nom, w.Code, w.Body.String(), b.appels)
			}
		}
		pareil("sans jeton", nouveauBancSurMesure(t, nil), r)
		forge := r
		forge.hdr = [][2]string{{"Origin", "https://malveillant.example"}, {"Content-Type", "text/plain"}, {"Cookie", "a=b"}}
		pareil("forgée", nouveauBancSurMesure(t, nil), forge)
		faux := r
		faux.hdr = [][2]string{{"Authorization", "Bearer " + strings.Repeat("f", 64)}}
		pareil("jeton faux", nouveauBancSurMesure(t, nil), faux)
		param := r
		param.path += "?pseudo=Lea"
		param.hdr = [][2]string{bon()}
		pareil("paramètre", nouveauBancSurMesure(t, nil), param)
		autre := r
		autre.hdr = [][2]string{bon()}
		autre.method = map[string]string{"GET": "POST", "POST": "GET"}[r.method]
		pareil("méthode", nouveauBancSurMesure(t, nil), autre)
		relaye := r
		relaye.hdr = [][2]string{bon(), {"X-Shh-Client-IP", "203.0.113.9"}}
		pareil("relayée", nouveauBancSurMesure(t, nil), relaye)
		hote := r
		hote.hdr = [][2]string{bon()}
		hote.hote = "shhgone.com"
		pareil("hôte étranger", nouveauBancSurMesure(t, nil), hote)
		avec := r
		avec.hdr = [][2]string{bon()}
		pareil("sans crochet", nouveauBancSurMesure(t, func(s *SurMesure) { s.Poser = nil }), avec)
	}
}

// TestChercherEtPoser : recherche (ref, limites ; jamais h ni le pseudo tapé dans la réponse) ;
// inconnu : réponse neutre ; bornes vérifiées avant le service ; ref échue après 10 minutes.
func TestChercherEtPoser(t *testing.T) {
	b := nouveauBancSurMesure(t, nil)
	code, corps := b.post("/api/comptes/chercher", `{"pseudo":"Lea"}`)
	if code != 200 || !strings.Contains(corps, `"court":"1a2b3c4d"`) || !strings.Contains(corps, `"sur_mesure":null`) {
		t.Fatal(code, corps)
	}
	if strings.Contains(corps, hex.EncodeToString(hLea[:])) || strings.Contains(corps, b64.EncodeToString(hLea[:])) || strings.Contains(corps, "Lea") {
		t.Fatal("h ou pseudo dans la réponse :", corps)
	}
	r := refDe(t, corps)
	for _, p := range []string{"Inconnu", "admin"} {
		if code, corps := b.post("/api/comptes/chercher", `{"pseudo":"`+p+`"}`); code != 200 || corps != `{"introuvable":true}` {
			t.Fatal(p, code, corps)
		}
	}
	for _, c := range []string{`{}`, `{"pseudo":""}`, `{"pseudo":"a"}`, `{"pseudo":1}`, `{"pseudo":"Lea","x":1}`} {
		if code, _ := b.post("/api/comptes/chercher", c); code != 400 {
			t.Error(c, code)
		}
	}
	n := len(b.appels)
	poser := func(salons, places, jours int, nom string) string {
		v, _ := json.Marshal(map[string]any{"ref": r, "salons": salons, "places": places, "jours": jours, "nom": nom})
		return string(v)
	}
	for _, c := range []string{poser(0, 2, 1, "x"), poser(11, 2, 1, "x"), poser(1, 1, 1, "x"), poser(1, 51, 1, "x"),
		poser(1, 2, 0, "x"), poser(1, 2, 31, "x"), poser(1, 2, 1, ""), poser(1, 2, 1, " "), poser(1, 2, 1, strings.Repeat("a", 41)),
		poser(1, 2, 1, "a\nb"), poser(1, 2, 1, "a\u202eb"), `{"ref":"court","salons":1,"places":2,"jours":1,"nom":"x"}`} {
		if code, corps := b.post("/api/comptes/surmesure/poser", c); code != 400 {
			t.Error(c, code, corps)
		}
	}
	if len(b.appels) != n {
		t.Fatal("service appelé malgré un refus :", b.appels[n:])
	}
	code, corps = b.post("/api/comptes/surmesure/poser", poser(2, 50, 30, " Léa "))
	if code != 200 || !strings.Contains(corps, `"limites":{"salons":2,"places":50,"heures":720}`) ||
		!strings.Contains(corps, `"nom":"Léa"`) || b.appels[len(b.appels)-1] != "poser a1a2 Léa" {
		t.Fatal(code, corps, b.appels)
	}
	code, corps = b.faireGet("/api/comptes/surmesure")
	if code != 200 || !strings.Contains(corps, `"comptes":[{"ref":"`+r+`"`) {
		t.Fatal(code, corps)
	}
	code, corps = b.post("/api/comptes/surmesure/retirer", `{"ref":"`+r+`"}`)
	if code != 200 || !strings.Contains(corps, `"sur_mesure":null`) || !strings.Contains(corps, `"heures":24`) {
		t.Fatal(code, corps)
	}
	// Ref inconnue ou échue : introuvable, rien d'appelé.
	n = len(b.appels)
	if code, corps := b.post("/api/comptes/surmesure/retirer", `{"ref":"AAAAAAAAAAAAAAAAAAAAAA"}`); code != 200 || corps != `{"introuvable":true}` {
		t.Fatal(code, corps)
	}
	b.clk = b.clk.Add(10*time.Minute + time.Second)
	if code, corps := b.post("/api/comptes/surmesure/poser", poser(1, 2, 1, "x")); code != 200 || corps != `{"introuvable":true}` {
		t.Fatal(code, corps)
	}
	if len(b.appels) != n {
		t.Fatal(b.appels[n:])
	}
}

func (b *bancSurMesure) faireGet(path string) (int, string) {
	w := b.faire(req{method: "GET", path: path, hdr: [][2]string{bon()}})
	return w.Code, w.Body.String()
}

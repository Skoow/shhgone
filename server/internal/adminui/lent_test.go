package adminui

import (
	"crypto/sha256"
	"encoding/json"
	"net/netip"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/paiement"
	"github.com/skoow/shhdrop/server/internal/salon"
	"github.com/skoow/shhdrop/server/internal/usage"
)

// Compteurs lents : avec une lecture toutes les 5 s, un achat, une inscription ou un appel
// ouvert se datait à 5 s près. Les compteurs qui les trahissent ne changent qu'une fois par
// periodeLente ; l'état de ce que l'exploitant règle lui-même (gel, ventes, bannissements) et
// la charge restent lus à l'instant.
func TestCompteursLents(t *testing.T) {
	clk := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	n := int64(1) // valeur de tous les compteurs à l'instant
	gele := false
	st := func() (State, error) {
		return State{
			Sante: Sante{Gele: gele},
			Usage: Usage{Snapshot: usage.Snapshot{PartagesCrees: n, PartagesPayants: [2]int64{n, n}, AppelsOuverts: n,
				IdentifiantsTurn: n}},
			Salon: &salon.Stats{AppelsOuverts: int(n), Connexions: n},
		}, nil
	}
	pai := func() (paiement.Agregats, error) {
		p := paiement.AgregatsPrestataire{Configure: gele, Vendable: gele, Commandes: n, Credits: n}
		return paiement.Agregats{Suspendu: gele, Stripe: p, PayPal: p, NOWPayments: p, PassPlus: int(n), Recentes: n,
			RecentesMax: int(n), JetonsActif: gele, JetonsEmis: [2]int64{n, n}, JetonsDepenses: [2]int64{n, n}}, nil
	}
	cpt := func() (Agregats, error) {
		var a Agregats
		a.Comptes, a.InscritsJour, a.Inscrits7Jours, a.Sessions, a.Inscriptions = int(n), int(n), int(n), int(n), n
		a.Max, a.BannisActifs, a.BannisSuspendus, a.BannisBientot, a.SalonsDeComptes = int(n), int(n), int(n), int(n), int(n)
		return a, nil
	}
	b := &banc{}
	b.h = New(Config{TokenHash: sha256.Sum256([]byte(jeton)), Peers: []netip.Prefix{netip.MustParsePrefix("172.30.53.1/32")},
		Now: func() time.Time { return clk }, State: st, Paiement: &Paiement{Agregats: pai, Suspendre: func(bool) {}},
		Comptes: &Comptes{Agregats: cpt}})
	lire := func(path string) map[string]any {
		t.Helper()
		w := b.faire(req{method: "GET", path: path, hdr: [][2]string{bon()}})
		if w.Code != 200 {
			t.Fatal(path, w.Code)
		}
		var v map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	champ := func(v map[string]any, cles ...any) any {
		var x any = v
		for _, c := range cles {
			switch c := c.(type) {
			case string:
				x = x.(map[string]any)[c]
			case int:
				x = x.([]any)[c]
			}
		}
		return x
	}
	type attendu struct {
		path   string
		chemin []any
		lent   bool
	}
	cas := []attendu{
		{"/api/etat", []any{"usage", "partages_payants", 0}, true},
		{"/api/etat", []any{"usage", "partages_payants", 1}, true},
		{"/api/etat", []any{"usage", "appels_ouverts"}, true},
		{"/api/etat", []any{"usage", "identifiants_turn"}, true},
		{"/api/etat", []any{"salon", "salons_appels_ouverts"}, true},
		{"/api/etat", []any{"salon", "connexions"}, false},
		{"/api/paiement", []any{"stripe", "commandes"}, true},
		{"/api/paiement", []any{"paypal", "paiements_credites"}, true},
		{"/api/paiement", []any{"nowpayments", "commandes"}, true},
		{"/api/paiement", []any{"pass_plus"}, true},
		{"/api/paiement", []any{"commandes_recentes"}, true},
		{"/api/paiement", []any{"jetons_emis", 0}, true},
		{"/api/paiement", []any{"jetons_depenses", 1}, true},
		{"/api/paiement", []any{"commandes_recentes_max"}, false},
		{"/api/comptes", []any{"inscrits_aujourdhui"}, true},
		{"/api/comptes", []any{"inscrits_7_jours"}, true},
		{"/api/comptes", []any{"comptes"}, true},
		{"/api/comptes", []any{"sessions"}, true},
		{"/api/comptes", []any{"inscriptions"}, true},
		{"/api/comptes", []any{"comptes_max"}, false},
		{"/api/comptes", []any{"bannis_actifs"}, false},
		{"/api/comptes", []any{"bannis_suspendus"}, false},
		{"/api/comptes", []any{"bannis_echeant_30_jours"}, false},
		{"/api/comptes", []any{"salons_de_comptes"}, false},
	}
	booleens := [][]any{{"/api/etat", "sante", "creations_gelees"}, {"/api/paiement", "ventes_suspendues"},
		{"/api/paiement", "jetons_actif"}, {"/api/paiement", "stripe", "vendable"}, {"/api/paiement", "paypal", "configure"},
		{"/api/paiement", "nowpayments", "vendable"}}
	verifier := func(quand string, lents, frais float64) {
		t.Helper()
		vus := map[string]map[string]any{}
		for _, p := range []string{"/api/etat", "/api/paiement", "/api/comptes"} {
			vus[p] = lire(p)
		}
		for _, c := range cas {
			want := frais
			if c.lent {
				want = lents
			}
			if got := champ(vus[c.path], c.chemin...); got != want {
				t.Errorf("%s : %s %v = %v, attendu %v", quand, c.path, c.chemin, got, want)
			}
		}
		for _, c := range booleens {
			if got := champ(vus[c[0].(string)], c[1:]...); got != gele {
				t.Errorf("%s : %v = %v, attendu %v (état lu à l'instant)", quand, c, got, gele)
			}
		}
	}

	verifier("première lecture", 1, 1)
	// Événements pendant la période : les compteurs lents ne bougent pas, l'état réglé par
	// l'exploitant si.
	n, gele = 2, true
	for _, d := range []time.Duration{5 * time.Second, 30 * time.Second, periodeLente - time.Nanosecond} {
		clk = time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC).Add(d)
		verifier("pendant la période", 1, 2)
	}
	// Période échue : la nouvelle valeur, gardée à son tour pour une période.
	clk = time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC).Add(periodeLente)
	verifier("période échue", 2, 2)
	n = 3
	clk = clk.Add(periodeLente / 2)
	verifier("période suivante", 2, 3)
}

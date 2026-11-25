package compte

import (
	"errors"
	"fmt"
	"net/netip"
	"testing"
	"time"
)

// Table des étapes WebAuthn (20 000) : environ 7 blocs /48 la remplissaient et plus personne ne
// pouvait se connecter. Part équitable : 2 500 étapes au plus par bloc, et le dernier quart ne va
// qu'à un bloc qui n'en tient aucune.
func TestEtapesPartEquitable(t *testing.T) {
	b := nouveauBanc(t)
	s := b.s
	now := b.clk.Now()
	ajouter := func(bloc string) error {
		s.mu.Lock()
		defer s.mu.Unlock()
		_, err := s.nouvelleEtapeLocked(&etape{sorte: etapeConnexion, bloc: bloc}, now)
		return err
	}
	// Un bloc : sa part, pas plus.
	for i := range partEtapes {
		if err := ajouter("a"); err != nil {
			t.Fatalf("étape %d du bloc refusée : %v", i+1, err)
		}
	}
	if err := ajouter("a"); !errors.Is(err, ErrBusy) {
		t.Fatal("étape au-delà de la part du bloc acceptée :", err)
	}
	// D'autres blocs remplissent la partie partagée (les 3/4).
	for i := 0; len(s.et.m) < etapesMax-reserveEtapes; i++ {
		if err := ajouter(fmt.Sprint("b", i/partEtapes)); err != nil {
			t.Fatal(err)
		}
	}
	// Réserve : refusée à un bloc qui tient déjà une étape, ouverte à un nouveau venu (une
	// chacun).
	if err := ajouter("b0"); !errors.Is(err, ErrBusy) {
		t.Fatal("réserve prise par un bloc qui tient déjà des étapes :", err)
	}
	if err := ajouter("nouveau"); err != nil {
		t.Fatal("nouveau venu refusé :", err)
	}
	if err := ajouter("nouveau"); !errors.Is(err, ErrBusy) {
		t.Fatal("deuxième étape d'un nouveau venu prise dans la réserve :", err)
	}
	// Échéance : les places reviennent, celles du bloc comprises (aucune fuite du compte par bloc).
	b.clk.Add(dureeInscription + time.Second)
	now = b.clk.Now()
	for range partEtapes {
		if err := ajouter("a"); err != nil {
			t.Fatal("places non rendues à l'échéance :", err)
		}
	}
	s.mu.Lock()
	n, nb := len(s.et.m), s.et.parBloc["a"]
	s.mu.Unlock()
	if n != partEtapes || nb != partEtapes || len(s.et.parBloc) != 1 {
		t.Fatalf("après échéance : %d étapes, %d pour le bloc, %d blocs", n, nb, len(s.et.parBloc))
	}
}

// Étapes rendues : à l'usage (connexion/fin) comme à l'échéance, la place du bloc revient ; la
// clé du bloc n'est jamais l'adresse en clair.
func TestEtapesBlocIP(t *testing.T) {
	b := nouveauBanc(t)
	b.s.wa = ceremoniesTest(t)
	ip := netip.MustParseAddr("2001:db8:5:1::1")
	jeton, _, err := b.s.ConnexionDebut(ip)
	if err != nil {
		t.Fatal(err)
	}
	b.s.mu.Lock()
	for k := range b.s.et.parBloc {
		if k == ip.String() || len(k) < 10 {
			t.Errorf("clé de bloc %q", k)
		}
	}
	if len(b.s.et.parBloc) != 1 {
		t.Error("blocs :", len(b.s.et.parBloc))
	}
	b.s.et.retirerLocked(jeton)
	if len(b.s.et.parBloc) != 0 || len(b.s.et.m) != 0 {
		t.Error("place du bloc non rendue au retrait")
	}
	b.s.mu.Unlock()
	// Même /48, autre /64 : même bloc.
	b.s.ConnexionDebut(ip)
	b.s.ConnexionDebut(netip.MustParseAddr("2001:db8:5:2::1"))
	b.s.mu.Lock()
	defer b.s.mu.Unlock()
	if len(b.s.et.parBloc) != 1 {
		t.Fatal("un /48 compté comme plusieurs blocs :", len(b.s.et.parBloc))
	}
}

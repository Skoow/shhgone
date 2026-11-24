package paiement

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// fauxNomme : faux prestataire au nom propre (chemin de webhook distinct).
type fauxNomme struct {
	*faux
	nom string
}

func (f fauxNomme) Nom() string { return f.nom }

// TestCryptoRefuseEnOSS : sous le régime OSS, la crypto n'est ni proposée ni acceptée (décision
// du propriétaire, 24 novembre ; conception §9.1, S3 : une seule preuve de localisation), mais
// ses webhooks restent lus (paiement tardif ou remboursement d'une commande d'avant le changement).
func TestCryptoRefuseEnOSS(t *testing.T) {
	db, err := OuvrirBase(filepath.Join(t.TempDir(), "paiements.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	now := func() time.Time { return time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC) }
	for _, r := range []Regime{Franchise, France, OSS} {
		carte := &faux{moyen: Carte, url: "https://paie.example/c/1"}
		crypto := fauxNomme{&faux{moyen: Crypto, url: "https://paie.example/x/1"}, "crypto"}
		s, err := NewService(Config{DB: db, Now: now, Origine: "https://shhgone.test", Regime: r,
			Prestataires: []Prestataire{crypto, carte}})
		if err != nil {
			t.Fatal(err)
		}
		m := s.Moyens()
		_, cerr := s.Commander(context.Background(), passN(byte(r)), Formule{Plus, JoursAn, false, Crypto}, "FR", true)
		if r == OSS {
			if len(m) != 1 || m[0] != Carte || cerr != ErrMoyen || len(crypto.vu) != 0 {
				t.Errorf("oss : moyens %v, commande %v, appels %d", m, cerr, len(crypto.vu))
			}
		} else if len(m) != 2 || m[1] != Crypto || cerr != nil || len(crypto.vu) != 1 {
			t.Errorf("%v : moyens %v, commande %v", r, m, cerr)
		}
		// Webhooks de la crypto toujours reconnus.
		if s.PrestataireDe("crypto") != Prestataire(crypto) {
			t.Error(r, "webhooks de la crypto plus lus")
		}
	}
}

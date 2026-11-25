package paiement

import (
	"errors"
	"path/filepath"
	"testing"
)

// TestMarquerMode : une base créée en essai (préproduction, cartes de test) n'est jamais ouverte
// en production, ni l'inverse ; une base neuve ou d'avant le marquage prend le mode courant.
func TestMarquerMode(t *testing.T) {
	for _, essai := range []bool{true, false} {
		chemin := filepath.Join(t.TempDir(), "paiements.db")
		db, err := OuvrirBase(chemin)
		if err != nil {
			t.Fatal(err)
		}
		if err := MarquerMode(db, essai); err != nil {
			t.Fatal("base neuve :", err)
		}
		if err := MarquerMode(db, essai); err != nil {
			t.Fatal("même mode :", err)
		}
		db.Close()
		// Rouverte (en-tête du fichier) dans l'autre mode : refus.
		db, err = OuvrirBase(chemin)
		if err != nil {
			t.Fatal(err)
		}
		attendu := ErrBaseEssai
		if !essai {
			attendu = ErrBaseReelle
		}
		if err := MarquerMode(db, !essai); !errors.Is(err, attendu) {
			t.Errorf("essai=%v puis %v : %v", essai, !essai, err)
		}
		if err := MarquerMode(db, essai); err != nil {
			t.Error("mode d'origine refusé après un refus :", err)
		}
		db.Close()
	}
}

// TestDroitsDisponibles : l'état ne rend que les droits codés : ni la
// première ouverture ni les salons payants, pas encore disponibles.
func TestDroitsDisponibles(t *testing.T) {
	for _, o := range []Offre{Plus, Pro} {
		for _, d := range []string{"premiere_ouverture", "salon_plus", "salon_pro"} {
			if o.A(d) {
				t.Errorf("%s annonce %s, pas encore codé", o, d)
			}
		}
	}
	if !Plus.A("partage_plus") || !Pro.A("partage_pro") {
		t.Error("droits de partage")
	}
}

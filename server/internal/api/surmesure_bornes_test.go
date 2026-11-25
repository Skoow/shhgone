package api

import (
	"testing"

	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/salon"
)

// Les bornes des comptes sur mesure sont les mêmes côté compte (ce que l'exploitant peut poser)
// et côté salons (ce que le gestionnaire accepte) : sinon un sur mesure posé serait refusé à la
// création, ou le gestionnaire accepterait plus que le tableau de bord ne permet.
func TestBornesSurMesureCommunes(t *testing.T) {
	if compte.SurMesurePlacesMax != salon.SurMesurePlacesMax {
		t.Fatal("places :", compte.SurMesurePlacesMax, salon.SurMesurePlacesMax)
	}
	if compte.SurMesureJoursMax*24 != salon.HeuresSurMesureMax {
		t.Fatal("durée :", compte.SurMesureJoursMax, salon.HeuresSurMesureMax)
	}
	if salon.HeuresLongues[len(salon.HeuresLongues)-1] != salon.HeuresSurMesureMax {
		t.Fatal("la plus longue durée proposée n'est pas le plafond :", salon.HeuresLongues)
	}
	for _, h := range salon.HeuresLongues {
		if h <= salon.HeuresStandardMax || h%24 != 0 {
			t.Fatal("durée longue :", h)
		}
	}
	if salon.SalonPlacesMax != salon.PlacesStandardMax || salon.PlacesStandardMax != 10 || salon.HeuresStandardMax != 24 {
		t.Fatal("bornes d'un salon ordinaire changées")
	}
}

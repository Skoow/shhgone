package usage

import (
	"reflect"
	"testing"
)

func TestCompteurs(t *testing.T) {
	var c Counters
	if c.Snapshot() != (Snapshot{}) {
		t.Fatal("valeur zéro non nulle")
	}
	c.PartageCree()
	c.EnvoiTermine()
	c.Deverrouillage()
	c.Deverrouillage()
	c.Destruction()
	c.RefusDebit()
	c.Recu(10)
	c.Recu(5)
	c.Servi(7)
	c.SalonCree()
	c.EntreeSalon()
	want := Snapshot{PartagesCrees: 1, EnvoisTermines: 1, Deverrouillages: 2, Destructions: 1, RefusDebit: 1,
		OctetsRecus: 15, OctetsServis: 7, SalonsCrees: 1, EntreesSalon: 1}
	if got := c.Snapshot(); got != want {
		t.Fatalf("%+v", got)
	}
}

// Rien par personne ni par partage : les deux types ne portent que des entiers, ou des
// tableaux de taille fixe d'entiers (un par catégorie de signalement). Une table, une liste,
// une chaîne ou une date ajoutée plus tard fait échouer ce test.
func TestQueDesEntiers(t *testing.T) {
	entier := func(ty reflect.Type) bool { return ty.Kind() == reflect.Int64 || ty.String() == "atomic.Int64" }
	for _, ty := range []reflect.Type{reflect.TypeOf(Snapshot{}), reflect.TypeOf(Counters{})} {
		for i := 0; i < ty.NumField(); i++ {
			f := ty.Field(i)
			if !entier(f.Type) && !(f.Type.Kind() == reflect.Array && entier(f.Type.Elem())) {
				t.Errorf("%s.%s : %s (seuls des entiers sont permis)", ty.Name(), f.Name, f.Type)
			}
		}
	}
}

// Signalements par catégorie (conception du compte §21.10.3) : un entier par
// catégorie (codes 1 à 10) et par sorte (partage, salon), en mémoire ; un code hors de 1 à 10
// n'est jamais compté (programmation : l'API refuse avant).
func TestCompteursParCategorie(t *testing.T) {
	var c Counters
	c.SignalementPartage(1)
	c.SignalementPartage(10)
	c.SignalementPartage(10)
	c.SignalementSalon(6)
	c.SignalementSalon(0)
	c.SignalementSalon(11)
	c.SignalementPartage(255)
	s := c.Snapshot()
	var p, sa [10]int64
	p[0], p[9], sa[5] = 1, 2, 1
	if s.SignalementsPartage != p || s.SignalementsSalon != sa {
		t.Fatalf("%v %v", s.SignalementsPartage, s.SignalementsSalon)
	}
	if s.Destructions != 0 {
		t.Fatal("un signalement n'est pas une destruction ici :", s.Destructions)
	}
}

// Partages payants par offre, appels ouverts et identifiants du relais (tableau de bord
// finalisé) : un entier chacun ; une offre hors de 1 et 2 n'est pas comptée.
func TestCompteursPaiementAppels(t *testing.T) {
	var c Counters
	c.PartagePayant(1)
	c.PartagePayant(2)
	c.PartagePayant(2)
	c.PartagePayant(0)
	c.PartagePayant(3)
	c.AppelsOuverts()
	c.IdentifiantsTurn()
	c.IdentifiantsTurn()
	s := c.Snapshot()
	if s.PartagesPayants != [2]int64{1, 2} || s.AppelsOuverts != 1 || s.IdentifiantsTurn != 2 {
		t.Fatalf("%+v", s)
	}
}

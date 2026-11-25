package salon

import (
	"errors"
	"testing"
	"time"
)

// Comptes sur mesure (décision du propriétaire, 25 novembre) : jusqu'à 50 places et 30 jours,
// seulement par le palier du compte créateur ; un compte ordinaire et un salon sans compte
// restent à 10 places et 24 h.

var palierSurMesure = Palier{Salons: 2, Places: SurMesurePlacesMax, Heures: HeuresSurMesureMax}

// Un salon de 30 jours et 50 places est créé pour un compte sur mesure ; ses 50 sièges se
// remplissent (le 51e est refusé), chacun a son bit de lecture attendue.
func TestSurMesureTrenteJoursCinquantePlaces(t *testing.T) {
	p := palierSurMesure
	b := bancCompte(t, &p, nil)
	h := compteTest(1)
	c, err := b.creerPour(h, 50, 720)
	if err != nil {
		t.Fatal("salon de 30 jours et 50 places refusé :", err)
	}
	var exp int64
	var places int
	if err := b.db.QueryRow(`SELECT expires_at, max_members FROM salons WHERE compte=?`, h[:]).Scan(&exp, &places); err != nil {
		t.Fatal(err)
	}
	if d := time.Duration(exp-b.h.Now().Unix()) * time.Second; places != 50 || d < 720*time.Hour || d > 720*time.Hour+15*time.Minute {
		t.Fatal("ligne :", places, d)
	}
	b.entrer(t, c, true)
	for i := 1; i < 50; i++ {
		b.entrer(t, c, false)
	}
	if _, err := b.m.Rejoindre(c.acces, c.preuve, nil); !errors.Is(err, ErrFull) {
		t.Fatal("51e personne :", err)
	}
	s := b.etat(t, c)
	if n := occupes(s); n != 50 {
		t.Fatal("sièges occupés :", n)
	}
	var a uint64
	sous(s, func() { a = s.attendusLocked(0) })
	if a != (uint64(1)<<50-1)&^1 || a&bitSiege(49) == 0 {
		t.Fatalf("lecteurs attendus : %b", a)
	}
	// Renouvellement long permis par le palier ; places au plus 50.
	if res, err := b.m.Regler(c.gestion, ReglagesReq{Heures: 336}, nil); err != nil || res.ExpiresIn < 336*time.Hour {
		t.Fatal("renouvellement de 14 jours :", res, err)
	}
	if _, err := b.m.Regler(c.gestion, ReglagesReq{Places: 51}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatal("51 places :", err)
	}
}

// Les mêmes valeurs sont refusées pour un compte ordinaire (palier) et sans compte (forme).
func TestSurMesureRefuseHorsSurMesure(t *testing.T) {
	p := paliersConfirme
	b := bancCompte(t, &p, nil)
	h := compteTest(1)
	for _, v := range [][2]int{{50, 720}, {11, 24}, {10, 72}, {2, 168}} {
		if _, err := b.creerPour(h, v[0], v[1]); !palierDepasse(err) {
			t.Errorf("compte confirmé, %d places, %d h : %v", v[0], v[1], err)
		}
	}
	for _, v := range [][2]int{{50, 720}, {11, 24}, {10, 72}} {
		if _, err := b.creerPour(nil, v[0], v[1]); !errors.Is(err, ErrBadRequest) {
			t.Errorf("sans compte, %d places, %d h : %v", v[0], v[1], err)
		}
	}
	for _, v := range [][2]int{{51, 24}, {10, 48}, {10, 721}, {10, 0}} {
		if _, err := b.creerPour(h, v[0], v[1]); !errors.Is(err, ErrBadRequest) {
			t.Errorf("forme %d places, %d h : %v", v[0], v[1], err)
		}
	}
	if n := b.lignesSalons(t); n != 0 {
		t.Fatal("lignes après refus :", n)
	}
	// Sur mesure retiré (palier normal rendu) : le salon long reste, mais ne se renouvelle plus
	// au-delà du palier, ni ne garde 50 places par un renouvellement seul.
	p = palierSurMesure
	c, err := b.creerPour(h, 50, 168)
	if err != nil {
		t.Fatal(err)
	}
	p = paliersConfirme
	for _, r := range []ReglagesReq{{Heures: 24}, {Heures: 168, Places: 10}, {Places: 20}} {
		if _, err := b.m.Regler(c.gestion, r, nil); !palierDepasse(err) {
			t.Errorf("%+v après retrait : %v", r, err)
		}
	}
	if _, err := b.m.Regler(c.gestion, ReglagesReq{Places: 10, Heures: 24}, nil); err != nil {
		t.Fatal("retour aux limites du palier :", err)
	}
	// Sans crochet (SHH_COMPTES=0) : un salon ordinaire se règle, jamais au-delà.
	b.m.cfg.Palier = nil
	sans := b.creer(t, 4)
	if _, err := b.m.Regler(sans.gestion, ReglagesReq{Places: 11}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatal("11 places sans compte :", err)
	}
	if _, err := b.m.Regler(sans.gestion, ReglagesReq{Heures: 72}, nil); !errors.Is(err, ErrBadRequest) {
		t.Fatal("72 h sans compte :", err)
	}
}

// Appels d'un salon long : un jeton les ouvre pour 24 h 15 min au plus, jamais 30 jours.
func TestAppelsSalonLong(t *testing.T) {
	p := palierSurMesure
	b := bancCompte(t, &p, nil)
	c, err := b.creerPour(compteTest(1), 50, 720)
	if err != nil {
		t.Fatal(err)
	}
	e := b.entrer(t, c, true)
	mb, err := b.m.Membre(e.Jeton[:])
	if err != nil {
		t.Fatal(err)
	}
	reste, deja, err := b.m.OuvrirAppels(mb)
	if err != nil || deja || reste != AppelsParJetonMax {
		t.Fatal("ouverture :", reste, deja, err)
	}
	b.h.avancer(AppelsParJetonMax)
	if _, ok, err := b.m.AppelsOuverts(mb); ok || err != nil {
		t.Fatal("encore ouverts après 24 h 15 :", ok, err)
	}
	if reste, deja, err := b.m.OuvrirAppels(mb); err != nil || deja || reste != AppelsParJetonMax {
		t.Fatal("réouverture par un nouveau jeton :", reste, deja, err)
	}
}

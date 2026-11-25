package salon

import (
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

// Appels réservés aux offres payantes (24 novembre) : fermés à la création ; ouverts par un
// membre jusqu'à la fin du salon, pour tous ; un second ouvreur l'apprend (deja) pour rendre son
// jeton ; un membre parti, exclu ou un salon échu n'ouvre ni ne lit rien.
func TestAppelsOuverture(t *testing.T) {
	b := nouveauBanc(t, 200)
	c := b.creer(t, 4)
	ea := b.entrer(t, c, false)
	eb := b.entrer(t, c, false)
	ma, err := b.m.Membre(ea.Jeton[:])
	if err != nil {
		t.Fatal(err)
	}
	mbb, err := b.m.Membre(eb.Jeton[:])
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := b.m.AppelsOuverts(ma); ok || err != nil {
		t.Fatalf("fermés à la création : %v %v", ok, err)
	}
	if n := b.m.Stats().AppelsOuverts; n != 0 {
		t.Fatal("tableau de bord, avant l'ouverture :", n)
	}
	s := b.etat(t, c)
	var fin time.Time
	sous(s, func() { fin = s.expires })

	reste, deja, err := b.m.OuvrirAppels(ma)
	if err != nil || deja || reste != fin.Sub(b.h.Now()) {
		t.Fatalf("ouverture : %v %v %v", reste, deja, err)
	}
	// Ouverts pour tous les membres, jusqu'à la fin du salon.
	if r, ok, err := b.m.AppelsOuverts(mbb); !ok || err != nil || r != fin.Sub(b.h.Now()) {
		t.Fatalf("autre membre : %v %v %v", r, ok, err)
	}
	if n := b.m.Stats().AppelsOuverts; n != 1 {
		t.Fatal("tableau de bord, salons aux appels ouverts :", n)
	}
	// Second ouvreur : déjà ouverts (son jeton est à rendre).
	if _, deja, err := b.m.OuvrirAppels(mbb); err != nil || !deja {
		t.Fatalf("second ouvreur : %v %v", deja, err)
	}
	// Rien qui désigne l'ouvreur : seule l'heure de fin est gardée.
	sous(s, func() {
		if !s.appelsJusqua.Equal(fin) {
			t.Fatalf("fin des appels : %v, salon : %v", s.appelsJusqua, fin)
		}
	})

	// Membre exclu (jeton révoqué) : refusé.
	h := sha256.Sum256(eb.Jeton[:])
	sous(s, func() {
		delete(s.jetons, h)
		s.revoques[h] = struct{}{}
	})
	if _, _, err := b.m.AppelsOuverts(mbb); !errors.Is(err, ErrExcluded) {
		t.Fatal("exclu :", err)
	}
	if _, _, err := b.m.OuvrirAppels(mbb); !errors.Is(err, ErrExcluded) {
		t.Fatal("exclu, ouverture :", err)
	}
	// Membre parti (siège libéré) : introuvable.
	b.depart(s, ma.siege)
	if _, _, err := b.m.AppelsOuverts(ma); !errors.Is(err, ErrNotFound) {
		t.Fatal("parti :", err)
	}
	// Membre zéro (jamais donné par Membre) : introuvable.
	if _, _, err := b.m.OuvrirAppels(Membre{}); !errors.Is(err, ErrNotFound) {
		t.Fatal("membre vide :", err)
	}
	// Salon échu : introuvable.
	ec := b.entrer(t, c, false)
	mc, err := b.m.Membre(ec.Jeton[:])
	if err != nil {
		t.Fatal(err)
	}
	b.h.avancer(fin.Sub(b.h.Now()))
	if _, _, err := b.m.AppelsOuverts(mc); !errors.Is(err, ErrNotFound) {
		t.Fatal("échu :", err)
	}
	if n := b.m.Stats().AppelsOuverts; n != 0 {
		t.Fatal("tableau de bord, salon échu :", n)
	}
}

// Fermés dans la dernière seconde : rien à donner (des identifiants de moins d'une seconde ne
// serviraient pas) ; un membre qui a une offre les rouvre alors jusqu'à la fin, s'il en reste.
func TestAppelsDerniereSeconde(t *testing.T) {
	b := nouveauBanc(t, 200)
	c := b.creer(t, 4)
	e := b.entrer(t, c, false)
	mb, err := b.m.Membre(e.Jeton[:])
	if err != nil {
		t.Fatal(err)
	}
	s := b.etat(t, c)
	sous(s, func() { s.appelsJusqua = b.h.Now().Add(500 * time.Millisecond) })
	if _, ok, err := b.m.AppelsOuverts(mb); ok || err != nil {
		t.Fatalf("moins d'une seconde : %v %v", ok, err)
	}
	if _, deja, err := b.m.OuvrirAppels(mb); deja || err != nil {
		t.Fatalf("réouverture : %v %v", deja, err)
	}
}

package compte

import (
	"bytes"
	"crypto/rand"
	"errors"
	"testing"
)

// Nom d'appareil posé après la connexion (lot 10) : il est chiffré par une clé tirée de
// K_compte, que l'appareil n'a qu'après la réponse de connexion. Seule la session courante
// change ; 64 octets exactement ; jamais en clair (le serveur garde les octets reçus).
func TestEtiquetteApresConnexion(t *testing.T) {
	b := nouveauBanc(t)
	h, j1, _ := b.inscrire(t, "lea")
	o, err := b.connecter(h)
	if err != nil {
		t.Fatal(err)
	}
	c2, err := b.s.Session(o.Jeton)
	if err != nil {
		t.Fatal(err)
	}
	etiq := make([]byte, 64)
	rand.Read(etiq)
	for _, mauvais := range [][]byte{nil, etiq[:63], append(bytes.Clone(etiq), 0)} {
		if err := b.s.EtiquetterSession(c2, mauvais); !errors.Is(err, ErrRequete) {
			t.Fatalf("%d octets : %v", len(mauvais), err)
		}
	}
	if err := b.s.EtiquetterSession(c2, etiq); err != nil {
		t.Fatal(err)
	}
	c1, err := b.s.Session(j1)
	if err != nil {
		t.Fatal(err)
	}
	vs, err := b.s.Sessions(c1)
	if err != nil || len(vs) != 2 {
		t.Fatal(len(vs), err)
	}
	for _, v := range vs {
		if v.Courante && v.Etiquette != nil {
			t.Fatal("la session 1 a changé")
		}
		if !v.Courante && !bytes.Equal(v.Etiquette, etiq) {
			t.Fatalf("session 2 : %x", v.Etiquette)
		}
	}
	// Session fermée : refus.
	if err := b.s.Deconnexion(c2); err != nil {
		t.Fatal(err)
	}
	if err := b.s.EtiquetterSession(c2, etiq); !errors.Is(err, ErrSession) {
		t.Fatal(err)
	}
}

package maintenance

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type horloge struct{ t time.Time }

func (h *horloge) now() time.Time { return h.t }

// ecrire : annonce faite à annonce, début à debut, durée et avance en minutes.
func ecrire(t *testing.T, p string, annonce, debut time.Time, duree, avance int) []byte {
	t.Helper()
	b := fmt.Appendf(nil, "v1 %d %d %d %d\n", annonce.Unix(), debut.Unix(), duree, avance)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAnalyser(t *testing.T) {
	bons := []string{"v1 1 1 1 1\n", "v1 100 200 1440 120\n"}
	for _, b := range bons {
		if _, ok := Analyser([]byte(b)); !ok {
			t.Errorf("%q refusée", b)
		}
	}
	mauvais := []string{"", "v1 1 1 1 1", "v2 1 1 1 1\n", "v1 1 1 1\n", "v1 1 1 1 1 1\n", "v1 0 1 1 1\n",
		"v1 2 1 1 1\n", "v1 1 1 0 1\n", "v1 1 1 1441 1\n", "v1 1 1 1 0\n", "v1 1 1 1 121\n", "v1 01 1 1 1\n",
		"v1 -1 1 1 1\n", "v1 +1 1 1 1\n", "v1 1  1 1 1\n", "v1 1 1 1 1\r\n", "v1 1 1 1 1\n\n", "v1 1 x 1 1\n",
		"v1 9999999999999 9999999999999 1 1\n"}
	for _, b := range mauvais {
		if _, ok := Analyser([]byte(b)); ok {
			t.Errorf("%q acceptée", b)
		}
	}
}

// Cycle complet : annoncée, imminente 10 min avant, toujours imminente après le début tant que
// le processus n'a pas redémarré ; un processus démarré après (redémarrage) ne refuse rien et
// efface l'annonce une fois la durée passée.
func TestCycle(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "maintenance")
	t0 := time.Unix(1_800_000_000, 0)
	h := &horloge{t0}
	s := Nouveau(p, h.now)
	if e := s.Etat(); e.Annonce != nil {
		t.Fatal("sans fichier : annonce")
	}
	debut := t0.Add(time.Hour)
	ecrire(t, p, t0, debut, 30, 10)
	h.t = t0.Add(relecture) // relu
	e := s.Etat()
	if e.Annonce == nil || e.Imminente || !e.Annonce.Debut.Equal(debut) || e.Annonce.Fin() != debut.Add(30*time.Minute) {
		t.Fatalf("annoncée : %+v", e)
	}
	h.t = debut.Add(-10*time.Minute - time.Second)
	if e := s.Etat(); e.Imminente {
		t.Fatal("imminente trop tôt")
	}
	h.t = debut.Add(-10 * time.Minute)
	if e := s.Etat(); !e.Imminente {
		t.Fatal("pas imminente au seuil")
	}
	h.t = debut.Add(5 * time.Minute) // redémarrage en retard : toujours imminente
	if e := s.Etat(); !e.Imminente {
		t.Fatal("plus imminente avant le redémarrage")
	}
	// Redémarrage (nouveau processus) pendant la maintenance : plus rien de refusé, annonce gardée
	// jusqu'à la fin, puis effacée.
	h.t = debut.Add(8 * time.Minute)
	s2 := Nouveau(p, h.now)
	if e := s2.Etat(); e.Annonce != nil {
		t.Fatalf("après le redémarrage : %+v", e)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("annonce effacée avant la fin")
	}
	h.t = debut.Add(30 * time.Minute)
	s2.Etat() // pas encore relu (15 s)
	h.t = debut.Add(31 * time.Minute)
	if e := s2.Etat(); e.Annonce != nil {
		t.Fatal("annonce après la fin")
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("annonce non effacée : %v", err)
	}
	// Le premier processus (s'il tournait encore) ne refuse plus rien après la fin.
	if e := s.Etat(); e.Annonce != nil || e.Imminente {
		t.Fatal("ancien processus : annonce après la fin")
	}
}

// État qui survit à un redémarrage du conteneur avant le seuil : le fichier est relu au
// démarrage, l'annonce reste, et le mode imminent vient à son heure.
func TestRedemarrageAvantLeSeuil(t *testing.T) {
	p := filepath.Join(t.TempDir(), "maintenance")
	t0 := time.Unix(1_800_000_000, 0)
	h := &horloge{t0}
	debut := t0.Add(2 * time.Hour)
	ecrire(t, p, t0, debut, 20, 10)
	h.t = t0.Add(30 * time.Minute) // redémarrage sans rapport (mise à jour)
	s := Nouveau(p, h.now)
	if e := s.Etat(); e.Annonce == nil || e.Imminente {
		t.Fatalf("annonce perdue au redémarrage : %+v", e)
	}
	h.t = debut.Add(-time.Minute)
	if e := s.Etat(); !e.Imminente {
		t.Fatal("pas imminente")
	}
}

// Annonce faite alors que le processus a démarré après le seuil (maintenance dans 5 min) :
// imminente tout de suite (le processus n'a pas redémarré depuis l'annonce).
func TestAnnonceTardive(t *testing.T) {
	p := filepath.Join(t.TempDir(), "maintenance")
	t0 := time.Unix(1_800_000_000, 0)
	h := &horloge{t0}
	s := Nouveau(p, h.now)
	h.t = t0.Add(time.Minute)
	ecrire(t, p, h.t, h.t.Add(5*time.Minute), 15, 10)
	h.t = h.t.Add(relecture)
	if e := s.Etat(); !e.Imminente {
		t.Fatalf("annonce tardive : %+v", e)
	}
}

// Fin passée sans redémarrage : rien n'est refusé, le fichier reste (etat.sh le signale).
func TestFinSansRedemarrage(t *testing.T) {
	p := filepath.Join(t.TempDir(), "maintenance")
	t0 := time.Unix(1_800_000_000, 0)
	h := &horloge{t0}
	ecrire(t, p, t0, t0.Add(time.Hour), 10, 10)
	s := Nouveau(p, h.now)
	h.t = t0.Add(time.Hour + 10*time.Minute)
	if e := s.Etat(); e.Annonce != nil {
		t.Fatal("annonce après la fin")
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("fichier effacé sans redémarrage")
	}
}

// Fichier abîmé, trop long, lien symbolique : aucune maintenance (jamais de créations fermées
// par une annonce illisible).
func TestFichierRefuse(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "maintenance")
	t0 := time.Unix(1_800_000_000, 0)
	h := &horloge{t0.Add(50 * time.Minute)}
	for _, b := range [][]byte{[]byte("n'importe quoi\n"), make([]byte, tailleMax+1)} {
		os.WriteFile(p, b, 0o600)
		if e := Nouveau(p, h.now).Etat(); e.Annonce != nil {
			t.Fatalf("%q accepté", b)
		}
	}
	os.Remove(p)
	vrai := filepath.Join(dir, "vrai")
	ecrire(t, vrai, t0, t0.Add(time.Hour), 10, 10)
	os.Symlink(vrai, p)
	if e := Nouveau(p, h.now).Etat(); e.Annonce != nil {
		t.Fatal("lien symbolique suivi")
	}
}

// Une nouvelle annonce écrite entre la lecture et l'effacement n'est jamais effacée.
func TestNouvelleAnnonceGardee(t *testing.T) {
	p := filepath.Join(t.TempDir(), "maintenance")
	t0 := time.Unix(1_800_000_000, 0)
	h := &horloge{t0}
	ecrire(t, p, t0, t0.Add(10*time.Minute), 10, 10)
	h.t = t0.Add(5 * time.Minute)
	s := Nouveau(p, h.now) // redémarré pendant la maintenance
	h.t = t0.Add(25 * time.Minute)
	ecrire(t, p, h.t, h.t.Add(24*time.Hour), 10, 10) // la suivante, déjà annoncée
	s.mu.Lock()
	s.lu = h.t // le suivi croit encore à l'ancienne
	s.mu.Unlock()
	s.Etat()
	if _, err := os.Stat(p); err != nil {
		t.Fatal("nouvelle annonce effacée")
	}
}

func TestSansSuivi(t *testing.T) {
	var s *Suivi
	if e := s.Etat(); e.Annonce != nil || e.Imminente {
		t.Fatal("nil : annonce")
	}
}

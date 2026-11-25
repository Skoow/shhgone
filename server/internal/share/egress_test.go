package share

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/store"
)

// Plafond de sortie par partage (décision du propriétaire du 24 novembre, décision 12 ; spec
// §38.6, §38.8.1, Q-P11) : toutes ouvertures confondues, un partage ne sert pas plus que
// EgressMax octets ; au-delà, ErrEgressLimit, et aucune nouvelle ouverture n'est consommée
// tant qu'un téléchargement complet ne tient plus sous le plafond.
func TestEgressLimitPerShare(t *testing.T) {
	s, _ := newSvc(t)
	k := newKeys()
	const bucket = 160 // 3 segments
	id := ready(t, s, k, bucket, 1, 5)
	f := totalSize(bucket)
	// Place pour deux téléchargements complets et un peu plus, moins d'un troisième.
	s.egressMax = 2*f + f/2
	read := func(o int) error {
		for n := 0; n < SegmentCount(bucket); n++ {
			if _, err := readSegment(s, id, n, o); err != nil {
				return err
			}
		}
		return nil
	}
	o1, _, err := s.Unlock(id, k.acces, k.preuve)
	if err != nil {
		t.Fatal(err)
	}
	o2, _, err := s.Unlock(id, k.acces, k.preuve)
	if err != nil {
		t.Fatal(err)
	}
	if err := read(o1); err != nil {
		t.Fatal(err)
	}
	if err := read(o2); err != nil {
		t.Fatal(err)
	}
	// Plus de place pour un téléchargement complet : nouvelle ouverture refusée, sans en
	// consommer et sans compter d'essai.
	var left, failed int
	s.DB.QueryRow(`SELECT opens_left, failed_attempts FROM shares WHERE id=?`, id).Scan(&left, &failed)
	if _, _, err := s.Unlock(id, k.acces, k.preuve); !errors.Is(err, ErrEgressLimit) {
		t.Fatal("ouverture au-delà du plafond :", err)
	}
	var left2, failed2 int
	s.DB.QueryRow(`SELECT opens_left, failed_attempts FROM shares WHERE id=?`, id).Scan(&left2, &failed2)
	if left2 != left || failed2 != failed {
		t.Fatal("ouverture ou essai consommé :", left, left2, failed, failed2)
	}
	// Un mot de passe faux reste un essai faux (le plafond ne se lit qu'avec le mot de passe).
	var bp *BadPassword
	if _, _, err := s.Unlock(id, k.acces, rnd(32)); !errors.As(err, &bp) {
		t.Fatal("mot de passe faux :", err)
	}
	// Une ouverture déjà donnée lit encore ce qui reste, puis ErrEgressLimit (son propre budget
	// n'est pas épuisé).
	var last error
	for i := 0; i < 10 && last == nil; i++ {
		last = read(o1)
	}
	if !errors.Is(last, ErrEgressLimit) {
		t.Fatal("au-delà du plafond :", last)
	}
	// Tableau de bord : deux refus comptés (l'ouverture, puis le segment), un entier sans partage.
	if n := s.RefusSortie.Load(); n != 2 {
		t.Fatal("refus du plafond comptés :", n)
	}
	// Le plafond est celui du partage : un autre partage n'est pas touché.
	k2 := newKeys()
	id2 := ready(t, s, k2, bucket, 1, 2)
	o, _, err := s.Unlock(id2, k2.acces, k2.preuve)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readSegment(s, id2, 0, o); err != nil {
		t.Fatal(err)
	}
}

// Le plafond par défaut et sa configuration.
func TestEgressMaxConfig(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	base := Config{DB: db, Blobs: &blob.Store{Dir: filepath.Join(dir, "blobs")}, Now: (&clock{}).Now,
		StorageMax: 1 << 40, FrozenFile: filepath.Join(dir, "frozen")}
	s, err := NewService(base)
	if err != nil || s.egressMax != DefaultEgressMax || DefaultEgressMax != 250<<30 {
		t.Fatal("défaut", err)
	}
	// Le plus grand partage payant doit pouvoir être téléchargé au moins une fois en entier.
	if DefaultEgressMax < totalSize(PaidBuckets[len(PaidBuckets)-1]) || MinEgressMax < totalSize(PaidBuckets[len(PaidBuckets)-1]) {
		t.Fatal("plafond sous un téléchargement complet")
	}
	c := base
	c.EgressMax = 300 << 30
	if s, err := NewService(c); err != nil || s.egressMax != 300<<30 {
		t.Fatal("réglé", err)
	}
	c.EgressMax = -1
	if _, err := NewService(c); err == nil {
		t.Fatal("négatif accepté")
	}
}

// Le compteur du partage vit en mémoire, sans adresse, et s'oublie après l'échéance.
func TestEgressCounterForgotten(t *testing.T) {
	var b readBudget
	k1 := openKey{"AAAAAAAAAAAAAAAAAAAAAA", 1}
	k2 := openKey{"AAAAAAAAAAAAAAAAAAAAAA", 2}
	if b.chargeAll(k1, 6, 100, 10, 1000) != nil || b.chargeAll(k2, 4, 100, 10, 1000) != nil {
		t.Fatal("sous le plafond")
	}
	if err := b.chargeAll(k2, 1, 100, 10, 1000); !errors.Is(err, ErrEgressLimit) {
		t.Fatal("plafond du partage :", err)
	}
	if b.shareUsed("AAAAAAAAAAAAAAAAAAAAAA", 1000) != 10 {
		t.Fatal("compteur")
	}
	b.chargeAll(openKey{"BBBBBBBBBBBBBBBBBBBBBB", 1}, 1, 100, 10, 1000+purgeWindow+60)
	if b.shareUsed("AAAAAAAAAAAAAAAAAAAAAA", 1000+purgeWindow+60) != 0 {
		t.Fatal("compteur échu gardé")
	}
}

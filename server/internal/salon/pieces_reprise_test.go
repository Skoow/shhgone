package salon

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/share"
)

// Pièces en envoi reprises après un redémarrage ou un plantage (D42-32) : chaque segment
// acquitté est sur le disque (fdatasync) et noté en base (segments_mask) avant l'accusé ; la
// pièce elle-même est dans la tête de l'état, rangée avant la réponse de sa création.

// recusDe : segments reçus de la pièce id (en mémoire).
func recusDe(t *testing.T, mb Membre, id string) []bool {
	t.Helper()
	s := mb.salon
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.lesPieces[id]
	if p == nil {
		t.Fatal("pièce inconnue")
	}
	return append([]bool(nil), p.recus...)
}

// Plantage au milieu d'un envoi (aucune passe de persistance après la création, aucun arrêt
// propre) : la pièce est reprise avec ses deux segments acquittés ; l'auteur la reprend, envoie
// le dernier, finalise ; un autre membre lit exactement ce qui a été envoyé.
func TestPlantagePieceEnvoi(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	e1, _ := b.entrerMembre(t, c, false)
	const bucket = 160 // 3 segments
	id := b.creerPiece(t, g, bucket, false)
	segs := segments(bucket, 7)
	for n := range 2 {
		if err := b.m.PutSegment(id, n, segs[n]); err != nil {
			t.Fatal("PutSegment :", n, err)
		}
	}
	b2 := b.planter(t)
	g2, l2 := b2.membreDe(t, e0), b2.membreDe(t, e1)
	if vocal, ok := b2.m.PieceEnvoi(id); !ok || vocal {
		t.Fatal("pièce en envoi perdue au plantage")
	}
	if r := recusDe(t, g2, id); len(r) != 3 || !r[0] || !r[1] || r[2] {
		t.Fatal("segments reçus après le plantage :", r)
	}
	// Seul l'auteur reprend ; un autre membre reçoit la même réponse qu'une pièce inconnue.
	if _, _, _, err := b2.m.RepriseEnvoi(l2, id); !errors.Is(err, ErrNotFound) {
		t.Fatal("reprise par un autre membre :", err)
	}
	bk, vocal, deja, err := b2.m.RepriseEnvoi(g2, id)
	if err != nil || bk != bucket || vocal || deja {
		t.Fatal("RepriseEnvoi :", bk, vocal, deja, err)
	}
	// Finalisation refusée tant qu'il manque un segment.
	if err := b2.m.FinalizePiece(id, 0, 0); !errors.Is(err, ErrBadRequest) {
		t.Fatal("finalisée sans le dernier segment :", err)
	}
	if err := b2.m.PutSegment(id, 2, segs[2]); err != nil {
		t.Fatal("dernier segment :", err)
	}
	if err := b2.m.FinalizePiece(id, 0, 0); err != nil {
		t.Fatal("FinalizePiece :", err)
	}
	b2.lier(t, g2, 0, id)
	for n := range 3 {
		got, err := b2.lire(t, l2, id, n)
		if err != nil || !bytes.Equal(got, segs[n]) {
			t.Fatal("segment relu après la reprise :", n, err)
		}
	}
	// Plus rien à reprendre : la pièce est prête.
	if _, _, deja, err := b2.m.RepriseEnvoi(g2, id); err != nil || !deja {
		t.Fatal("reprise d'une pièce prête :", deja, err)
	}
	// Un second plantage garde la pièce prête et liée.
	b3 := b2.planter(t)
	if got, err := b3.lire(t, b3.membreDe(t, e1), id, 1); err != nil || !bytes.Equal(got, segs[1]) {
		t.Fatal("pièce perdue au second plantage :", err)
	}
}

// Finalisée après la dernière passe (la tête la dit encore en envoi, la ligne est « ready ») :
// reprise prête, et l'auteur qui reprend apprend qu'il n'a rien à renvoyer.
func TestPlantagePieceFinaliseeApresLaPasse(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	id := b.creerPiece(t, g, 1, false)
	if err := b.m.PutSegment(id, 0, segments(1, 3)[0]); err != nil {
		t.Fatal(err)
	}
	if err := b.m.FinalizePiece(id, 0, 0); err != nil {
		t.Fatal(err)
	}
	b2 := b.planter(t)
	g2 := b2.membreDe(t, e0)
	if _, _, deja, err := b2.m.RepriseEnvoi(g2, id); err != nil || !deja {
		t.Fatal("pièce finalisée reprise :", deja, err)
	}
	if _, ok := b2.m.PieceEnvoi(id); ok {
		t.Fatal("pièce prête encore en envoi")
	}
	b2.lier(t, g2, 0, id)
}

// Arrêt propre au milieu d'un vocal : repris de même ; une pièce en envoi oubliée par son
// auteur est effacée PieceSansSegment après la reprise (délai reparti du démarrage), budget rendu.
func TestReprisePieceEnvoiPuisAbandon(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	vocal := b.creerPiece(t, g, 16, true)
	fichier := b.creerPiece(t, g, 80, false)
	if err := b.m.PutSegment(vocal, 0, segments(16, 1)[0]); err != nil {
		t.Fatal(err)
	}
	b.h.avancer(10 * time.Minute)
	b2 := b.redemarrer(t)
	g2 := b2.membreDe(t, e0)
	if v, ok := b2.m.PieceEnvoi(vocal); !ok || !v {
		t.Fatal("vocal en envoi perdu")
	}
	if err := b2.m.FinalizePiece(vocal, 0, 0); err != nil {
		t.Fatal("vocal finalisé après la reprise :", err)
	}
	if n := b2.budgetPris(t, g2.salon); n != share.TotalSize(80) {
		t.Fatal("budget du fichier en envoi :", n)
	}
	b2.h.avancer(PieceSansSegment - time.Second)
	b2.m.Tick()
	if _, ok := b2.m.PieceEnvoi(fichier); !ok {
		t.Fatal("pièce effacée avant son délai (reparti de la reprise)")
	}
	b2.h.avancer(2 * time.Second)
	b2.m.Tick()
	if f, l := b2.surDisque(t, fichier); f || l {
		t.Fatal("pièce abandonnée gardée :", f, l)
	}
	if n := b2.budgetPris(t, g2.salon); n != 0 {
		t.Fatal("budget non rendu :", n)
	}
}

// Sans clé maîtresse : rien n'est noté en base à chaque segment (aucune reprise possible), comme
// avant.
func TestPieceSansPersistanceRienNote(t *testing.T) {
	b := nouveauBanc(t, 200)
	c := b.creer(t, 4)
	_, g := b.entrerMembre(t, c, true)
	id := b.creerPiece(t, g, 160, false)
	if err := b.m.PutSegment(id, 1, segments(160, 1)[1]); err != nil {
		t.Fatal(err)
	}
	var masque []byte
	if err := b.db.QueryRow(`SELECT segments_mask FROM salon_pieces WHERE id=?`, id).Scan(&masque); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(masque, []byte{0}) {
		t.Fatal("masque noté sans persistance :", masque)
	}
}

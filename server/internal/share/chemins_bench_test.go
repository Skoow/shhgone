package share

// Chemins chauds d'un partage : création, envoi d'un segment, ouverture et lecture d'un
// segment, sur le disque du dossier temporaire.
//
//	go test -run '^$' -bench 'Creer|Envoyer|Lire' -benchmem ./internal/share/

import (
	"io"
	"testing"
)

func BenchmarkCreer(b *testing.B) {
	s, _ := newSvc(b)
	b.ReportAllocs()
	for b.Loop() {
		b.StopTimer() // requête du client (clés, en-tête et manifeste du banc) hors mesure
		r := newKeys().req(1, 24, 1)
		b.StartTimer()
		if _, _, err := s.createAny(r); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkEnvoyer : segments de 1 Mio (palier 16) et de 4 Mio (palier 1600), envoyés à la
// suite (le premier envoi de chaque segment pose son bit, les suivants sont des reprises).
func BenchmarkEnvoyer(b *testing.B) {
	for _, c := range []struct {
		nom    string
		bucket int
	}{{"1Mio", 16}, {"4Mio", 1600}} {
		b.Run(c.nom, func(b *testing.B) {
			s, _ := newSvc(b)
			id, segs, err := s.createAny(newKeys().req(c.bucket, 24, 1))
			if err != nil {
				b.Fatal(err)
			}
			corps := segBody(c.bucket, 0, 7)
			b.SetBytes(int64(len(corps)))
			b.ReportAllocs()
			n := 0
			for b.Loop() {
				if SegmentSize(c.bucket, n) != len(corps) {
					n = 0
				}
				if err := s.PutSegment(id, n, corps); err != nil {
					b.Fatal(err)
				}
				n = (n + 1) % segs
			}
		})
	}
}

// BenchmarkLire : ouverture et lecture complète d'un segment de 1 Mio (palier 16) par une
// ouverture déverrouillée. Le budget de lecture de l'ouverture est remis à zéro hors mesure
// quand il s'épuise (il borne un lecteur réel, pas ce banc).
func BenchmarkLire(b *testing.B) {
	s, _ := newSvc(b)
	k := newKeys()
	id, segs, err := s.createAny(k.req(16, 24, 1))
	if err != nil {
		b.Fatal(err)
	}
	for n := range segs {
		if err := s.PutSegment(id, n, segBody(16, n, byte(n+1))); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := s.Finalize(id, fin(id)); err != nil {
		b.Fatal(err)
	}
	openN, _, err := s.Unlock(id, k.acces, k.preuve)
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(SegmentSize(16, 0)))
	b.ReportAllocs()
	for b.Loop() {
		seg, err := s.OpenSegment(id, 0, openN)
		if err == ErrBudget {
			b.StopTimer()
			s.budget.mu.Lock()
			s.budget.m, s.budget.shares = nil, nil
			s.budget.mu.Unlock()
			b.StartTimer()
			seg, err = s.OpenSegment(id, 0, openN)
		}
		if err != nil {
			b.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, seg); err != nil {
			b.Fatal(err)
		}
		seg.Close()
	}
}

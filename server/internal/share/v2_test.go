package share

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
)

// Envoi v2 de 7 segments (palier 400), segments reçus sauf ceux de skip.
func upload400(t *testing.T, s *Service, k keys, skip ...int) string {
	t.Helper()
	id, segs, err := s.createAny(k.req(400, 1, 2))
	if err != nil {
		t.Fatal(err)
	}
	if segs != 7 {
		t.Fatal(segs)
	}
outer:
	for n := 0; n < segs; n++ {
		for _, x := range skip {
			if x == n {
				continue outer
			}
		}
		if err := s.PutSegment(id, n, segBody(400, n, byte(n+1))); err != nil {
			t.Fatal(n, err)
		}
	}
	return id
}

// Spec H-5 : l'ancienne finalisation désignait le bourrage [fill_from, fill_to) et refusait
// tout autre segment manquant. Le brouillon (seule finalisation) remplit d'aléa tout morceau
// manquant du palier final, sans plage à désigner : ce qui était refusé (trou hors bourrage,
// segment 0 ou dernier segment absent) devient un trou rempli d'aléa, sous la seule borne
// padAllowed des morceaux reçus (TestFinalizePaddingBoundedByReceived, amplify_test.go). Les
// segments envoyés restent intacts, l'en-tête et le manifeste sont ceux de la finalisation.
func TestFinalizeFillsAnyMissingSegment(t *testing.T) {
	for _, skip := range [][]int{{3, 4, 5}, {2, 3, 4, 5}, {0, 1}, {6}, {4}, {1, 2, 3, 4, 5}, nil} {
		t.Run(fmt.Sprint(skip), func(t *testing.T) {
			s, _ := newSvc(t)
			k := newKeys()
			id := upload400(t, s, k, skip...)
			r := draftFin(id, 400)
			if _, err := s.Finalize(id, r); err != nil {
				t.Fatal(err)
			}
			f := fileBytes(t, s, id)
			if int64(len(f)) != totalSize(400) || !bytes.Equal(f[:Header], r.Header) || !bytes.Equal(f[len(f)-ChunkCT:], r.Tail) {
				t.Fatal("taille, en-tête ou manifeste")
			}
			for n := 0; n < 7; n++ {
				seg := f[segOffset(400, n) : segOffset(400, n)+int64(SegmentSize(400, n))]
				// Hors en-tête (segment 0) et manifeste (dernier morceau) : écrits à part.
				lo, hi := 0, len(seg)
				if n == 0 {
					lo = Header
				}
				if n == 6 {
					hi -= ChunkCT
				}
				sent := !slices.Contains(skip, n)
				if want := segBody(400, n, byte(n+1))[lo:hi]; sent != bytes.Equal(seg[lo:hi], want) {
					t.Fatalf("segment %d : envoyé %v, intact %v", n, sent, !sent)
				}
				// Bourrage tiré de crypto/rand : aucune suite de 4 096 zéros.
				if !sent && bytes.Contains(seg[lo:hi], make([]byte, 4096)) {
					t.Fatal("suite de 4 096 zéros dans le bourrage", n)
				}
			}
		})
	}
}

func TestUnlockEnvelopeOnlyWhenReady(t *testing.T) {
	s, _ := newSvc(t)
	k := newKeys()
	id := upload400(t, s, k, 3, 4, 5)
	// Avant finalize : proof_v NULL → 404 uniforme, aucun essai compté.
	if _, _, err := s.Unlock(id, k.acces, k.preuve); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, _, err := s.Unlock(id, k.acces, rnd(32)); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if failed(t, s, id) != 0 {
		t.Fatal("essai compté avant finalize")
	}
	if _, err := s.Meta(k.acces); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	r := fin(id)
	if _, err := s.Finalize(id, r); err != nil {
		t.Fatal(err)
	}
	// Rejeu de finalize : plus en envoi → 404.
	if _, err := s.Finalize(id, r); !errors.Is(err, ErrNotFound) {
		t.Fatal("finalize rejoué", err)
	}
	n, env, err := s.Unlock(id, k.acces, k.preuve)
	if err != nil || n != 1 || !bytes.Equal(env, r.Envelope) {
		t.Fatal(n, err)
	}
	if _, env, err := s.Unlock(id, k.acces, rnd(32)); env != nil {
		t.Fatal("enveloppe rendue à un mauvais mot de passe", err)
	}
	m, err := s.Meta(k.acces)
	if err != nil || !bytes.Equal(m.Salt, r.Salt) || m.Bucket != 400 {
		t.Fatal(m, err)
	}
}

// Une création ne heurte un partage existant que
// par V_accès ou V_gestion, c'est-à-dire si son auteur connaît K_accès ou S_gestion. L'id
// interne vient du serveur ; un id déjà pris (impossible en pratique) est refusé aussi.
func TestCreateConflict(t *testing.T) {
	s, _ := newSvc(t)
	k := newKeys()
	r := k.req(1, 1, 1)
	if _, _, err := s.createAny(r); err != nil {
		t.Fatal(err)
	}
	if err := s.PutSegment(r.ID, 0, segBody(1, 0, 9)); err != nil {
		t.Fatal(err)
	}
	sameAccess := newKeys()
	sameAccess.acces = k.acces
	sameManage := newKeys()
	sameManage.gestion = k.gestion
	sameID := newKeys().req(16, 1, 1)
	sameID.ID = r.ID
	for name, c := range map[string]CreateReq{"V_accès": sameAccess.req(16, 1, 1), "V_gestion": sameManage.req(16, 1, 1), "id": sameID} {
		if _, _, err := s.createAny(c); !errors.Is(err, ErrConflict) {
			t.Fatal(name, err)
		}
		if _, err := os.Stat(filepath.Join(s.Blobs.Dir, c.ID)); c.ID != r.ID && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(name, "fichier réservé malgré le conflit")
		}
	}
	// Le partage existant est intact (fichier et ligne).
	f, _ := os.ReadFile(filepath.Join(s.Blobs.Dir, r.ID))
	if !bytes.Equal(f, segBody(1, 0, 9)) || rowCount(t, s, r.ID) != 1 {
		t.Fatal("partage existant touché")
	}
	// D'autres secrets : création acceptée, quel que soit l'état du partage existant.
	if _, _, err := s.createAny(newKeys().req(1, 1, 1)); err != nil {
		t.Fatal(err)
	}
	// Fichier orphelin du même nom : conflit aussi, jamais écrasé.
	orphan := newKeys().req(1, 1, 1)
	if err := os.WriteFile(filepath.Join(s.Blobs.Dir, orphan.ID), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.createAny(orphan); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(s.Blobs.Dir, orphan.ID)); string(b) != "x" {
		t.Fatal("orphelin écrasé")
	}
}

// OnAbandon : appelé pour un envoi effacé avant finalize (destruction ou balayage), jamais
// pour un partage finalisé.
func TestOnAbandon(t *testing.T) {
	s, c := newSvc(t)
	var mu sync.Mutex
	got := map[string]int{}
	s.OnAbandon = func(id string, bucket int) { mu.Lock(); got[id] = bucket; mu.Unlock() }
	k, k2 := newKeys(), newKeys()
	destroyed, _, _ := s.createAny(k.req(16, 1, 1))
	swept, _, _ := s.createAny(newKeys().req(1, 1, 1))
	ready(t, s, k2, 1, 1, 1)
	if err := s.DestroyManaged(k.gestion); err != nil {
		t.Fatal(err)
	}
	c.Add(20 * 60e9) // envoi sans segment : effacé 5 à 20 min après la création
	if _, err := s.Sweep(); err != nil {
		t.Fatal(err)
	}
	if err := s.DestroyManaged(k2.gestion); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[destroyed] != 16 || got[swept] != 1 {
		t.Fatal(got)
	}
}

// N finalize simultanés sur le même envoi → un seul écrit le bourrage ;
// les autres repartent aussitôt (ErrBusy) ou trouvent l'envoi déjà finalisé (404).
func TestFinalizeConcurrentFillsOnce(t *testing.T) {
	s, _ := newSvc(t)
	k := newKeys()
	id := upload400(t, s, k, 1, 2, 3, 4, 5)
	var writes atomic.Int64
	orig := fillWrite
	fillWrite = func(w io.WriterAt, off int64, b []byte) error {
		writes.Add(int64(len(b)))
		return orig(w, off, b)
	}
	defer func() { fillWrite = orig }()
	const N = 20
	var wg sync.WaitGroup
	var mu sync.Mutex
	got := map[string]int{}
	r := fin(id)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Finalize(id, r)
			key := "ok"
			switch {
			case errors.Is(err, ErrBusy):
				key = "busy"
			case errors.Is(err, ErrNotFound):
				key = "404"
			case err != nil:
				key = err.Error()
			}
			mu.Lock()
			got[key]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	pad := segOffset(400, 6) - segOffset(400, 1)
	if got["ok"] != 1 || got["ok"]+got["busy"]+got["404"] != N {
		t.Fatal(got)
	}
	if w := writes.Load(); w != pad {
		t.Fatalf("bourrage écrit %d octets, attendu %d (une seule fois)", w, pad)
	}
	s.finalizing.mu.Lock()
	left := len(s.finalizing.ids)
	s.finalizing.mu.Unlock()
	if left != 0 {
		t.Fatal("verrou par id non libéré", left)
	}
}

// Après finalize, le masque des segments ne garde plus la frontière du bourrage.
func TestFinalizeResetsSegmentsMask(t *testing.T) {
	s, _ := newSvc(t)
	k := newKeys()
	id := upload400(t, s, k, 3, 4, 5)
	if _, err := s.Finalize(id, fin(id)); err != nil {
		t.Fatal(err)
	}
	var mask []byte
	if err := s.DB.QueryRow(`SELECT segments_mask FROM shares WHERE id=?`, id).Scan(&mask); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(mask, []byte{0x7f}) {
		t.Fatalf("masque après finalize : %08b (le bourrage ne doit plus s'y voir)", mask)
	}
}

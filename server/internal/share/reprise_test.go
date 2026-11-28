package share

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/store"
)

// Reprise après un redémarrage (D42-31). Un « redémarrage » est ici un nouveau Service sur la
// même base, rouverte, et le même dossier, après PurgeAtStart ; un « plantage » est le même
// redémarrage sans aucun rangement de l'ancien Service (ni RangerLectures, ni arrêt) : tout ce
// qui a été acquitté doit être là quand même.

type banc struct {
	dir string
	c   *clock
}

func nouveauBanc(t *testing.T) (*banc, *Service) {
	t.Helper()
	b := &banc{dir: t.TempDir(), c: &clock{t: time.Date(2026, 11, 28, 10, 2, 0, 0, time.UTC)}}
	return b, b.service(t)
}

// service : un Service neuf sur la base et les fichiers du banc (base rouverte).
func (b *banc) service(t *testing.T) *Service {
	t.Helper()
	db, err := store.Open(filepath.Join(b.dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	s, err := NewService(Config{DB: db, Blobs: &blob.Store{Dir: filepath.Join(b.dir, "blobs")}, Now: b.c.Now,
		StorageMax: 1 << 40, FrozenFile: filepath.Join(b.dir, "frozen")})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// redemarrer : base de l'ancien service fermée (sans rien ranger), service neuf, purge du démarrage.
func (b *banc) redemarrer(t *testing.T, old *Service) *Service {
	t.Helper()
	old.bgSync.Wait()
	old.DB.Close()
	s := b.service(t)
	if _, err := s.PurgeAtStart(); err != nil {
		t.Fatal(err)
	}
	return s
}

// creerRepris : création comme par l'API (S_gestion donné : l'envoi a sa ligne de reprise).
func creerRepris(t *testing.T, s *Service, k keys, bucket int, tier Tier) string {
	t.Helper()
	r := k.req(bucket, 1, 2)
	r.Manage, r.Tier = k.gestion, tier
	id, _, err := s.create(r, validCreate)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func fichier(t *testing.T, s *Service, id string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(s.Blobs.Dir, id))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// attendu : contenu final d'un envoi complet de segments segBody(bucket, n, n+1), avec
// l'en-tête et le manifeste de fin(id).
func attendu(bucket int, f FinalizeReq) []byte {
	var out []byte
	for n := 0; n < SegmentCount(bucket); n++ {
		out = append(out, segBody(bucket, n, byte(n+1))...)
	}
	copy(out, f.Header)
	copy(out[Header+int64(bucket-1)*ChunkCT:], f.Tail)
	return out
}

// Envoi interrompu par un redémarrage (propre ou plantage, segment écrit sans être acquitté) :
// segments acquittés gardés, jeton neuf par S_gestion, reprise au premier segment manquant,
// partage final identique (SHA-256) à un envoi sans interruption ; aucun morceau compté deux fois.
func TestRepriseEnvoi(t *testing.T) {
	for _, plantage := range []bool{false, true} {
		t.Run(map[bool]string{false: "redémarrage", true: "plantage"}[plantage], func(t *testing.T) {
			b, s := nouveauBanc(t)
			k := newKeys()
			id := creerRepris(t, s, k, 400, Gratuit)
			for n := 0; n < 3; n++ {
				if err := s.PutSegment(id, n, segBody(400, n, byte(n+1))); err != nil {
					t.Fatal(err)
				}
			}
			if plantage {
				// Segment 3 écrit mais le serveur tué avant le masque et la réponse : jamais acquitté.
				if err := s.Blobs.WriteAt(id, segOffset(400, 3), segBody(400, 3, 4)); err != nil {
					t.Fatal(err)
				}
			}
			recvAvant, topAvant := s.received(id)
			s2 := b.redemarrer(t, s)
			// Avant la reprise : rien n'est accepté (formule encore chiffrée), l'envoi reste vivant.
			if err := s2.PutSegment(id, 3, segBody(400, 3, 4)); !errors.Is(err, ErrNotFound) {
				t.Fatal("segment accepté avant la reprise :", err)
			}
			if _, err := s2.Resume(rnd(32)); !errors.Is(err, ErrNotFound) {
				t.Fatal("reprise avec un autre S_gestion :", err)
			}
			rp, err := s2.Resume(k.gestion)
			if err != nil {
				t.Fatal(err)
			}
			if rp.ID != id || rp.Bucket != 400 || rp.Tier != Gratuit || !rp.Deadline.Equal(time.Unix(ceil15(b.c.Now().Unix()+uploadWindow), 0)) {
				t.Fatal(rp)
			}
			// Masque : 0, 1, 2 reçus ; 3 (jamais acquitté) manquant : le client reprend à 3.
			if rp.Mask[0] != 0b111 {
				t.Fatalf("masque %08b", rp.Mask[0])
			}
			if recv, top := s2.received(id); recv != recvAvant || top != topAvant {
				t.Fatal("morceaux reçus non repris :", recv, top, recvAvant, topAvant)
			}
			for n := 3; n < 7; n++ {
				if err := s2.PutSegment(id, n, segBody(400, n, byte(n+1))); err != nil {
					t.Fatal(n, err)
				}
			}
			// Chaque morceau compté une fois : 3 segments avant, 4 après.
			if recv, _ := s2.received(id); recv != 400 {
				t.Fatal("morceaux comptés", recv)
			}
			if _, err := s2.Finalize(id, fin(id)); err != nil {
				t.Fatal(err)
			}
			want := sha256.Sum256(attendu(400, fin(id)))
			if got := sha256.Sum256(fichier(t, s2, id)); got != want {
				t.Fatal("partage final différent d'un envoi sans interruption")
			}
			var n int
			s2.DB.QueryRow(`SELECT count(*) FROM shares_envoi`).Scan(&n)
			if n != 0 {
				t.Fatal("ligne de reprise restée après la finalisation")
			}
			// Le destinataire lit le bon contenu.
			if _, _, err := s2.Unlock(id, k.acces, k.preuve); err != nil {
				t.Fatal(err)
			}
			var lu []byte
			for n := 0; n < 7; n++ {
				g, err := s2.OpenSegment(id, n, 1)
				if err != nil {
					t.Fatal(err)
				}
				p, _ := io.ReadAll(g)
				g.Close()
				lu = append(lu, p...)
			}
			if sha256.Sum256(lu) != want {
				t.Fatal("contenu lu différent")
			}
		})
	}
}

// Plages de morceaux (petits éléments, fin d'un grand) acquittées avant un redémarrage : gardées
// telles quelles, comptées, jamais recouvertes d'aléa à la finalisation ; un segment complété
// après la reprise passe au masque.
func TestRepriseMorceaux(t *testing.T) {
	b, s := nouveauBanc(t)
	k := newKeys()
	id := creerRepris(t, s, k, 400, Gratuit)
	a := bytes.Repeat([]byte{0xA1}, 10*ChunkCT)
	c := bytes.Repeat([]byte{0xC3}, 5*ChunkCT)
	if err := s.PutChunks(id, 1, 0, a); err != nil {
		t.Fatal(err)
	}
	if err := s.PutChunks(id, 2, 7, c); err != nil {
		t.Fatal(err)
	}
	s2 := b.redemarrer(t, s)
	if _, err := s2.Resume(k.gestion); err != nil {
		t.Fatal(err)
	}
	if p := s2.partOf(id); p[1] != 1<<10-1 || p[2] != (1<<5-1)<<7 {
		t.Fatalf("morceaux non repris : %x", p)
	}
	if recv, top := s2.received(id); recv != 15 || top != 3 {
		t.Fatal(recv, top)
	}
	// Fin du segment 1 après la reprise : complet, au masque.
	if err := s2.PutChunks(id, 1, 10, bytes.Repeat([]byte{0xB2}, 54*ChunkCT)); err != nil {
		t.Fatal(err)
	}
	_, mask, _ := s2.draftRow(id)
	if mask[0] != 0b10 {
		t.Fatalf("masque %08b", mask[0])
	}
	f := fin(id)
	if _, err := s2.Finalize(id, f); err != nil {
		t.Fatal(err)
	}
	got := fichier(t, s2, id)
	if !bytes.Equal(got[chunkOffset(400, 1, 0):chunkOffset(400, 1, 10)], a) ||
		!bytes.Equal(got[chunkOffset(400, 2, 7):chunkOffset(400, 2, 12)], c) {
		t.Fatal("morceaux acquittés recouverts")
	}
}

// Formule payante : chiffrée sous S_gestion dans la base (jamais en clair), rendue à la reprise ;
// un autre S_gestion ou un autre envoi ne l'ouvre pas.
func TestRepriseFormule(t *testing.T) {
	b, s := nouveauBanc(t)
	k := newKeys()
	id := creerRepris(t, s, k, 400, Pro)
	var f []byte
	if err := s.DB.QueryRow(`SELECT formule FROM shares_envoi WHERE share_id=?`, id).Scan(&f); err != nil {
		t.Fatal(err)
	}
	if len(f) != formuleLen {
		t.Fatal(len(f))
	}
	if tt, ok := ouvrirFormule(k.gestion, id, f); !ok || tt != Pro {
		t.Fatal(tt, ok)
	}
	if _, ok := ouvrirFormule(rnd(32), id, f); ok {
		t.Fatal("ouverte sous une autre clé")
	}
	if _, ok := ouvrirFormule(k.gestion, NewID(), f); ok {
		t.Fatal("ouverte pour un autre envoi")
	}
	s2 := b.redemarrer(t, s)
	rp, err := s2.Resume(k.gestion)
	if err != nil || rp.Tier != Pro || s2.tierOf(id) != Pro {
		t.Fatal(rp, err)
	}
	// Fenêtre d'envoi payante (24 h) gardée.
	if !rp.Deadline.Equal(time.Unix(ceil15(b.c.Now().Unix()+paidUploadWindow), 0)) {
		t.Fatal(rp.Deadline)
	}
	// Reprise rejouée (aucun redémarrage entre-temps) : même envoi, rien ne change.
	if rp2, err := s2.Resume(k.gestion); err != nil || rp2.ID != id || rp2.Tier != Pro {
		t.Fatal(rp2, err)
	}
}

// Brouillon échu pendant l'arrêt : purgé au démarrage (fichier et ligne). Brouillon jamais repris :
// effacé 15 min après le démarrage. Envoi créé sans S_gestion (outils) : purgé, comme avant.
func TestRepriseEchue(t *testing.T) {
	t.Run("échu pendant l'arrêt", func(t *testing.T) {
		b, s := nouveauBanc(t)
		k := newKeys()
		id := creerRepris(t, s, k, 400, Gratuit)
		if err := s.PutSegment(id, 0, segBody(400, 0, 1)); err != nil {
			t.Fatal(err)
		}
		b.c.Add(6*time.Hour + 15*time.Minute)
		s2 := b.redemarrer(t, s)
		gone(t, s2, id)
		if _, err := s2.Resume(k.gestion); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
	})
	t.Run("jamais repris", func(t *testing.T) {
		b, s := nouveauBanc(t)
		k := newKeys()
		id := creerRepris(t, s, k, 400, Gratuit)
		s2 := b.redemarrer(t, s)
		b.c.Add(14 * time.Minute)
		if _, err := s2.Sweep(); err != nil || rowCount(t, s2, id) != 1 {
			t.Fatal("effacé trop tôt", err)
		}
		b.c.Add(2 * time.Minute)
		if _, err := s2.Sweep(); err != nil {
			t.Fatal(err)
		}
		gone(t, s2, id)
	})
	t.Run("repris puis tenu en vie", func(t *testing.T) {
		b, s := nouveauBanc(t)
		k := newKeys()
		id := creerRepris(t, s, k, 400, Gratuit)
		s2 := b.redemarrer(t, s)
		b.c.Add(10 * time.Minute)
		if _, err := s2.Resume(k.gestion); err != nil {
			t.Fatal(err)
		}
		b.c.Add(10 * time.Minute)
		if err := s2.Keep(id); err != nil {
			t.Fatal(err)
		}
		b.c.Add(10 * time.Minute)
		if _, err := s2.Sweep(); err != nil || rowCount(t, s2, id) != 1 {
			t.Fatal("brouillon repris effacé", err)
		}
	})
	t.Run("sans S_gestion", func(t *testing.T) {
		b, s := nouveauBanc(t)
		id, _, err := s.createAny(newKeys().req(400, 1, 2))
		if err != nil {
			t.Fatal(err)
		}
		gone(t, b.redemarrer(t, s), id)
	})
	t.Run("fichier abîmé", func(t *testing.T) {
		b, s := nouveauBanc(t)
		k := newKeys()
		id := creerRepris(t, s, k, 400, Gratuit)
		if err := os.Truncate(filepath.Join(s.Blobs.Dir, id), 10); err != nil {
			t.Fatal(err)
		}
		gone(t, b.redemarrer(t, s), id)
	})
	t.Run("détruit par l'expéditeur avant la reprise", func(t *testing.T) {
		b, s := nouveauBanc(t)
		k := newKeys()
		id := creerRepris(t, s, k, 400, Gratuit)
		s2 := b.redemarrer(t, s)
		if err := s2.DestroyManaged(k.gestion); err != nil {
			t.Fatal(err)
		}
		gone(t, s2, id)
	})
}

// Ouvertures reprises : un lecteur qui revient avec son octroi après un redémarrage (propre ou
// plantage) rouvre la même ouverture, sans en consommer une de plus ; retours, octets lus
// (rangés) et voix de signalement repris.
func TestRepriseOuvertures(t *testing.T) {
	for _, plantage := range []bool{false, true} {
		t.Run(map[bool]string{false: "redémarrage", true: "plantage"}[plantage], func(t *testing.T) {
			b, s := nouveauBanc(t)
			k := newKeys()
			id := ready(t, s, k, 16, 24, 3)
			o1, err := s.UnlockGrant(id, k.acces, k.preuve, "")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.UnlockGrant(id, k.acces, k.preuve, o1.Grant); err != nil { // un retour
				t.Fatal(err)
			}
			g, err := s.OpenSegment(id, 0, 1)
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, g)
			g.Close()
			if gone, _, err := s.Report(k.acces, k.preuve, o1.Grant); err != nil || gone {
				t.Fatal(gone, err)
			}
			lu := int64(SegmentSize(16, 0))
			if !plantage {
				if err := s.RangerLectures(); err != nil {
					t.Fatal(err)
				}
			}
			s2 := b.redemarrer(t, s)
			o, err := s2.UnlockGrant(id, k.acces, k.preuve, o1.Grant)
			if err != nil || o.N != 1 || o.Grant != o1.Grant {
				t.Fatal("octroi non repris :", o, err)
			}
			if left, issued, _ := opensOf(t, s2, id); left != 2 || issued != 1 {
				t.Fatal("ouverture consommée par le redémarrage :", left, issued)
			}
			s2.gone.mu.Lock()
			reopens := s2.grantReopensLocked(openKey{id, 1})
			s2.gone.unlock()
			if reopens != 2 {
				t.Fatal("retours", reopens)
			}
			want := lu
			if plantage {
				want = 0 // rangés chaque seconde : la dernière seconde est oubliée, en faveur du lecteur
			}
			if got := s2.budget.shareUsed(id, s2.now()); got != want {
				t.Fatal("octets lus repris", got, want)
			}
			// La voix d'avant compte : une seconde ouverture qui signale efface le partage (2 sur 3).
			o2, err := s2.UnlockGrant(id, k.acces, k.preuve, "")
			if err != nil {
				t.Fatal(err)
			}
			if gone, _, err := s2.Report(k.acces, k.preuve, o2.Grant); err != nil || !gone {
				t.Fatal("voix d'avant le redémarrage perdue :", gone, err)
			}
		})
	}
}

// « draining » (toutes les ouvertures prises) : gardé jusqu'à son échéance ; sa dernière
// détentrice y revient (meta, unlock) et peut le détruire ; une fois échu, purgé au démarrage.
func TestRepriseDraining(t *testing.T) {
	b, s := nouveauBanc(t)
	k := newKeys()
	id := ready(t, s, k, 16, 1, 1)
	o, err := s.UnlockGrant(id, k.acces, k.preuve, "")
	if err != nil || !o.LastOpen {
		t.Fatal(o, err)
	}
	if err := s.Done(id, 1); err != nil {
		t.Fatal(err)
	}
	_ = o
	// Done de la dernière ouverture : partage retiré, comme avant.
	gone(t, s, id)

	id = ready(t, s, k, 16, 1, 1)
	o, err = s.UnlockGrant(id, k.acces, k.preuve, "")
	if err != nil {
		t.Fatal(err)
	}
	s2 := b.redemarrer(t, s)
	if _, err := s2.MetaGrant(k.acces, o.Grant); err != nil {
		t.Fatal("« draining » perdu au redémarrage :", err)
	}
	if o2, err := s2.UnlockGrant(id, k.acces, k.preuve, o.Grant); err != nil || o2.N != 1 || !o2.LastOpen {
		t.Fatal(o2, err)
	}
	if err := s2.DestroyWithProof(k.acces, k.preuve, o.Grant); err != nil {
		t.Fatal(err)
	}
	gone(t, s2, id)

	id = ready(t, s2, k, 16, 1, 1)
	if _, err := s2.UnlockGrant(id, k.acces, k.preuve, ""); err != nil {
		t.Fatal(err)
	}
	b.c.Add(2 * time.Hour)
	gone(t, b.redemarrer(t, s2), id)
}

// Une ouverture terminée garde la preuve de son octroi (signalement) mais ne rouvre plus rien,
// avant comme après un redémarrage.
func TestRepriseOuvertureTerminee(t *testing.T) {
	b, s := nouveauBanc(t)
	k := newKeys()
	id := ready(t, s, k, 16, 24, 3)
	o, err := s.UnlockGrant(id, k.acces, k.preuve, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Done(id, o.N); err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		sv := s
		if i == 1 {
			sv = b.redemarrer(t, s)
		}
		if _, err := sv.UnlockGrant(id, k.acces, k.preuve, o.Grant); !errors.Is(err, ErrGrantInvalid) {
			t.Fatal("ouverture terminée rouverte :", err)
		}
		if _, ok := sv.verifyGrant(id, o.Grant); !ok {
			t.Fatal("preuve de l'ouverture perdue")
		}
	}
}

// Pro : 20 ouvertures, toutes lisibles et terminables (maxOpenN valait 10 : les ouvertures 11 à 20
// étaient consommées puis refusées).
func TestVingtOuvertures(t *testing.T) {
	s, _ := newSvc(t)
	k := newKeys()
	r := k.req(16, 24, 20)
	r.Tier = Pro
	id, segs, err := s.create(r, validCreate)
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < segs; n++ {
		if err := s.PutSegment(id, n, segBody(16, n, 1)); err != nil {
			t.Fatal(err)
		}
	}
	f := fin(id)
	f.MaxOpens = 20
	if _, err := s.Finalize(id, f); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 20; i++ {
		o, err := s.UnlockGrant(id, k.acces, k.preuve, "")
		if err != nil || o.N != i {
			t.Fatal(i, o.N, err)
		}
		g, err := s.OpenSegment(id, 0, o.N)
		if err != nil {
			t.Fatal("ouverture", o.N, err)
		}
		g.Close()
		if i < 20 {
			if err := s.Done(id, o.N); err != nil {
				t.Fatal("done", o.N, err)
			}
		}
	}
}

// Le serveur ne voit rien de plus : ni S_gestion, ni K_accès, ni K_preuve, ni l'octroi dans la
// base, son journal ou les fichiers, après envoi repris et ouvertures rangées.
func TestRepriseNeGardeRienEnClair(t *testing.T) {
	b, s := nouveauBanc(t)
	k := newKeys()
	id := creerRepris(t, s, k, 400, Plus)
	if err := s.PutChunks(id, 1, 0, bytes.Repeat([]byte{7}, 3*ChunkCT)); err != nil {
		t.Fatal(err)
	}
	s2 := b.redemarrer(t, s)
	if _, err := s2.Resume(k.gestion); err != nil {
		t.Fatal(err)
	}
	k2 := newKeys()
	id2 := ready(t, s2, k2, 16, 24, 3)
	o, err := s2.UnlockGrant(id2, k2.acces, k2.preuve, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s2.RangerLectures(); err != nil {
		t.Fatal(err)
	}
	raw, _ := DecodeB64(o.Grant, grantLen)
	secrets := map[string][]byte{"S_gestion": k.gestion, "K_accès": k.acces, "K_preuve": k.preuve,
		"S_gestion 2": k2.gestion, "K_accès 2": k2.acces, "K_preuve 2": k2.preuve, "octroi": raw, "octroi (texte)": []byte(o.Grant),
		"aléa de l'octroi": raw[8:]}
	_ = id2
	filepath.Walk(b.dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return nil
		}
		data, _ := os.ReadFile(p)
		for nom, x := range secrets {
			if bytes.Contains(data, x) {
				t.Errorf("%s en clair dans %s", nom, filepath.Base(p))
			}
		}
		return nil
	})
}

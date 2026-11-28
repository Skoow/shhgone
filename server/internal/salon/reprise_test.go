package salon

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/share"
	"github.com/skoow/shhdrop/server/internal/store"
)

// Salons persistants (reprise.go ; conception du salon v3 §5.2) : un arrêt propre range les
// salons ouverts, le démarrage suivant les reprend.

// cleTest : clé maîtresse des tests.
var cleTest = [32]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32}

// nouveauBancReprise : nouveauBanc, avec la clé maîtresse des salons.
func nouveauBancReprise(t *testing.T) *banc {
	t.Helper()
	b := nouveauBanc(t, 200)
	k := cleTest
	b.cfg.CleReprise = &k
	b.m.cfg.CleReprise = &k
	return b
}

// arreter : arrêt propre du serveur (main.go) : connexions fermées et attendues, salons rangés,
// base fermée. Rend le nombre de salons rangés.
func (b *banc) arreter(t *testing.T) int {
	t.Helper()
	b.m.FermerTout()
	if !b.m.AttendreConnexions(time.Minute) {
		t.Fatal("connexions encore ouvertes")
	}
	n, err := b.m.Sauvegarder()
	if err != nil {
		t.Fatal("Sauvegarder :", err)
	}
	b.db.Close()
	return n
}

// demarrer : nouveau processus sur les mêmes fichiers (base, conversations, pièces) et la même
// horloge ; cle : sa clé maîtresse (nil : aucune). Purge et reprise du démarrage faites.
func (b *banc) demarrer(t *testing.T, cle *[32]byte) *banc {
	t.Helper()
	db, err := store.Open(filepath.Join(b.dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cfg := b.cfg
	cfg.DB = db
	cfg.Pieces = &blob.Store{Dir: b.cfg.Pieces.Dir}
	cfg.CleReprise = cle
	m, err := NewManager(cfg)
	if err != nil {
		t.Fatal(err)
	}
	m.sansLimiteSiege = true
	if err := m.PurgerAuDemarrage(); err != nil {
		t.Fatal("PurgerAuDemarrage :", err)
	}
	return &banc{m: m, db: db, h: b.h, dir: b.dir, cfg: cfg}
}

// redemarrer : arrêt propre puis démarrage avec la même clé maîtresse.
func (b *banc) redemarrer(t *testing.T) *banc {
	t.Helper()
	b.arreter(t)
	return b.demarrer(t, b.cfg.CleReprise)
}

// cleDe : copie de la clé de la conversation du salon s (tests seulement).
func cleDe(s *salon) [32]byte {
	s.mu.Lock()
	c := s.conv
	s.mu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cle
}

// fichiersContiennent : un fichier sous dir contient aiguille.
func fichiersContiennent(t *testing.T, dir string, aiguille []byte) string {
	t.Helper()
	var trouve string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || trouve != "" {
			return nil
		}
		b, err := os.ReadFile(p)
		if err == nil && bytes.Contains(b, aiguille) {
			trouve = p
		}
		return nil
	})
	return trouve
}

func lignesReprise(t *testing.T, b *banc) int {
	t.Helper()
	var n int
	if err := b.db.QueryRow(`SELECT count(*) FROM salons_reprise`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Bout en bout avec le relais : deux membres échangent, l'un se déconnecte, le serveur
// redémarre ; après le démarrage, le salon est là avec les mêmes sièges et jetons, le membre
// resté en ligne revient avec son depuis sans rien perdre, l'absent rattrape tout l'historique
// d'avant le redémarrage (mêmes octets), et la conversation continue au rang suivant.
func TestRepriseBoutEnBout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		b := nouveauBancReprise(t)
		c := b.creer(t, 4)
		e0, g := b.entrerMembre(t, c, true)
		ea, a := b.entrerMembre(t, c, false)
		lg := b.connecter(e0.Jeton, e0.Seq)
		la := b.connecter(ea.Jeton, ea.Seq)
		synctest.Wait()
		var rangsAvant []uint64
		for i := range 5 {
			rangsAvant = append(rangsAvant, b.recevoir(t, g, trameD(0, i)))
		}
		b.recevoir(t, a, trameD(dVolatile, 99)) // volatile : jamais écrite ni reprise
		rangsAvant = append(rangsAvant, b.recevoir(t, a, trameD(0, 5)))
		synctest.Wait()
		finir(t, la) // l'invité s'en va avant l'arrêt : il rattrapera
		seqA := ea.Seq
		for i := 6; i < 9; i++ {
			rangsAvant = append(rangsAvant, b.recevoir(t, g, trameD(0, i)))
		}
		synctest.Wait()
		dernierAvant := dernierSeq(g.salon)
		vuG := rangs(lg.enrs())
		if n := b.arreter(t); n != 1 {
			t.Fatal("salons rangés :", n)
		}
		attendreFin(t, lg)
		if code := lg.codeFerme(); code != CodeArret {
			t.Fatal("fermeture à l'arrêt :", code)
		}
		b2 := b.demarrer(t, b.cfg.CleReprise)
		if n := lignesReprise(t, b2); n != 1 {
			t.Fatal("ligne de reprise non récrite au démarrage :", n)
		}
		// Mêmes jetons : Membre les reconnaît, sur les mêmes sièges.
		g2, a2 := b2.membreDe(t, e0), b2.membreDe(t, ea)
		if g2.siege != 0 || a2.siege != ea.Siege || g2.emis != g.emis || a2.emis != a.emis {
			t.Fatal("sièges ou rangs d'émission changés")
		}
		s2 := g2.salon
		if dernierSeq(s2) != dernierAvant || occupes(s2) != 2 {
			t.Fatal("état repris :", dernierSeq(s2), occupes(s2))
		}
		// Le créateur revient avec son dernier rang vu : 0x0D au même rang, rien de rejoué.
		lg2 := b2.connecter(e0.Jeton, vuG[len(vuG)-1])
		// L'invité absent revient avec son depuis d'avant l'arrêt : il rattrape tout.
		la2 := b2.connecter(ea.Jeton, seqA)
		synctest.Wait()
		if e := lg2.enrs()[0]; e.ty != 0x0D || e.seq != dernierAvant {
			t.Fatalf("0x0D du créateur : %x %d", e.ty, e.seq)
		}
		if r := rangs(lg2.enrs()); len(r) != 0 {
			t.Fatal("créateur : rangs rejoués", r)
		}
		var recues []uint64
		for i, r := range la2.enrs() {
			if r.ty != 0x01 {
				continue
			}
			e := lireEnr(t, la2.brut(i))
			recues = append(recues, e.seq)
			k := len(recues) - 1
			if k < len(rangsAvant) && !bytes.Equal(e.trame, trameD(0, k)) {
				t.Fatalf("trame %d : octets changés", e.seq)
			}
		}
		attendues := rangsAvant[:]
		for len(attendues) > 0 && attendues[0] <= seqA {
			attendues = attendues[1:]
		}
		if !egaux(recues, attendues) {
			t.Fatalf("rattrapage de l'absent : %v, attendu %v", recues, attendues)
		}
		// La conversation continue au rang suivant, relayée aux deux.
		if seq := b2.recevoir(t, a2, trameD(0, 42)); seq != dernierAvant+1 {
			t.Fatal("rang après la reprise :", seq)
		}
		synctest.Wait()
		for _, l := range []*fauxLien{lg2, la2} {
			if r := rangs(l.enrs()); len(r) == 0 || r[len(r)-1] != dernierAvant+1 {
				t.Fatal("trame d'après la reprise non relayée :", r)
			}
		}
		finir(t, lg2, la2)
	})
}

func egaux(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Minuteries recalculées après l'arrêt : une échéance « vu par tous + 1 min » passée pendant
// l'arrêt efface la trame au premier passage (0x0E à la reconnexion) ; un siège jamais connecté
// est libéré au bout de ses 10 min ; l'échéance du salon reste celle de la base.
func TestRepriseMinuteries(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		b := nouveauBancReprise(t)
		c := b.creer(t, 4)
		e0, g := b.entrerMembre(t, c, true)
		ea, a := b.entrerMembre(t, c, false)
		b.connecte(t, a)() // connecté une fois : réservé
		seq := b.recevoir(t, g, trameD(dUneMinute, 1))
		if err := b.m.Lu(a, seq); err != nil { // lue par tous : effacée 1 min plus tard
			t.Fatal(err)
		}
		eb := b.entrer(t, c, false) // jamais connecté
		exp := g.salon.expires
		b.arreter(t)
		b.h.avancer(11 * time.Minute) // arrêt de 11 min
		b2 := b.demarrer(t, b.cfg.CleReprise)
		s2 := b2.membreDe(t, e0).salon
		if !s2.expires.Equal(exp) {
			t.Fatal("échéance du salon changée :", s2.expires, exp)
		}
		b2.m.Tick()
		if _, err := b2.m.Membre(eb.Jeton[:]); !errors.Is(err, ErrNotFound) {
			t.Fatal("siège jamais connecté gardé après 10 min :", err)
		}
		if !s2.effaceeDepuis(seq) {
			t.Fatal("trame échue pendant l'arrêt encore servie")
		}
		la := b2.connecter(ea.Jeton, seq)
		synctest.Wait()
		var vu bool
		for _, e := range la.enrs() {
			if e.ty == 0x0E && len(e.corps) == 8 && bytesSeq(e.corps) == seq {
				vu = true
			}
		}
		if !vu {
			t.Fatal("0x0E de la trame échue absent à la reconnexion")
		}
		finir(t, la)
		// Fin du salon à son échéance d'avant l'arrêt.
		b2.h.avancer(exp.Sub(b2.h.Now()))
		b2.m.Tick()
		if !s2.estFini() {
			t.Fatal("salon repris non fini à son échéance")
		}
	})
}

func bytesSeq(b []byte) uint64 {
	var v uint64
	for _, x := range b[:8] {
		v = v<<8 | uint64(x)
	}
	return v
}

// Salon échu pendant l'arrêt : rien n'est repris, ligne, ligne de reprise, conversation et
// pièces effacées.
func TestRepriseEchuPendantArret(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	_, g := b.entrerMembre(t, c, true)
	b.recevoir(t, g, trameD(0, 1))
	id := b.pretePiece(t, g, 1, false)
	b.lier(t, g, 0, id)
	sid := g.salon.id
	if n := b.arreter(t); n != 1 {
		t.Fatal("salons rangés :", n)
	}
	if _, err := os.Stat(filepath.Join(b.cfg.DossierConversations, sid)); err != nil {
		t.Fatal("conversation absente après l'arrêt :", err)
	}
	b.h.avancer(25 * time.Hour)
	b2 := b.demarrer(t, b.cfg.CleReprise)
	b2.m.mu.Lock()
	n := len(b2.m.salons)
	b2.m.mu.Unlock()
	if n != 0 {
		t.Fatal("salon échu repris")
	}
	if lignesReprise(t, b2) != 0 {
		t.Fatal("ligne de reprise restée")
	}
	var k int
	b2.db.QueryRow(`SELECT count(*) FROM salons`).Scan(&k)
	if k != 0 {
		t.Fatal("ligne du salon échu restée")
	}
	es, _ := os.ReadDir(b.cfg.DossierConversations)
	if len(es) != 0 {
		t.Fatal("fichiers de conversation restés :", len(es))
	}
	if f, l := b2.surDisque(t, id); f || l {
		t.Fatal("pièce du salon échu restée :", f, l)
	}
}

// Pièces : une pièce prête liée à une trame est reprise (lisible, budget recompté) ; une pièce
// encore en envoi est effacée ; un salon sans pièce garde un budget nul.
func TestReprisePieces(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	id := b.pretePiece(t, g, 1, false)
	seq := b.lier(t, g, 0, id)
	enCours := b.creerPiece(t, g, 1, false)
	b2 := b.redemarrer(t)
	g2 := b2.membreDe(t, e0)
	if f, l := b2.surDisque(t, id); !f || !l {
		t.Fatal("pièce prête perdue :", f, l)
	}
	if f, l := b2.surDisque(t, enCours); f || l {
		t.Fatal("pièce en envoi gardée :", f, l)
	}
	lec, err := b2.m.OuvrirSegment(t.Context(), g2, id, 0)
	if err != nil {
		t.Fatal("pièce reprise illisible :", err)
	}
	lec.Close()
	var octets int64
	b2.db.QueryRow(`SELECT pieces_bytes FROM salons WHERE id=?`, g2.salon.id).Scan(&octets)
	if octets != share.TotalSize(1) {
		t.Fatal("budget recompté :", octets)
	}
	// La pièce suit toujours sa trame : retirée avec elle.
	if err := b2.m.Retirer(g2, seq); err != nil {
		t.Fatal(err)
	}
	if f, l := b2.surDisque(t, id); f || l {
		t.Fatal("pièce non effacée avec sa trame :", f, l)
	}
}

// Jeton révoqué (exclusion) avant l'arrêt : toujours refusé en 4002 après la reprise.
func TestRepriseRevoques(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	b.entrerMembre(t, c, true)
	ea, a := b.entrerMembre(t, c, false)
	s := a.salon
	s.mu.Lock()
	b.m.sortirLocked(s, a.siege, func(seq uint64) []byte { return EnrExclusion(seq, a.siege, ea.Nonce, 1) }, true)
	s.mu.Unlock()
	b2 := b.redemarrer(t)
	if _, err := b2.m.Membre(ea.Jeton[:]); !errors.Is(err, ErrExcluded) {
		t.Fatal("jeton révoqué après la reprise :", err)
	}
}

// Aucun octet de la clé d'une conversation en clair sur le disque, ni en marche (ligne écrite,
// clé enveloppée), ni à l'arrêt, ni après la reprise ; aucune trame en clair non plus.
func TestRepriseCleJamaisEnClair(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	for i := range 3 {
		b.recevoir(t, g, trameD(0, i))
	}
	b.passe(t) // ligne écrite en marche (persistance continue) : enveloppée, jamais en clair
	cle := cleDe(g.salon)
	verifier := func(quand string) {
		if p := fichiersContiennent(t, b.dir, cle[:]); p != "" {
			t.Fatalf("%s : clé de conversation en clair dans %s", quand, filepath.Base(p))
		}
		if p := fichiersContiennent(t, b.dir, trameD(0, 1)[len(marque)+1:]); p != "" {
			t.Fatalf("%s : trame en clair dans %s", quand, filepath.Base(p))
		}
	}
	verifier("en marche")
	b.arreter(t)
	verifier("à l'arrêt")
	b2 := b.demarrer(t, b.cfg.CleReprise)
	if got := cleDe(b2.membreDe(t, e0).salon); got != cle {
		t.Fatal("clé reprise différente")
	}
	verifier("après la reprise")
}

// Destruction hors ligne d'un salon rangé (shhdrop admin destroy, serveur arrêté) : ligne de
// reprise (enveloppe) et fichier mis de côté effacés ; l'enveloppe ne traîne ni dans la base ni
// dans son WAL ; rien n'est repris.
func TestRepriseDestructionEfface(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	_, g := b.entrerMembre(t, c, true)
	b.recevoir(t, g, trameD(0, 1))
	sid := g.salon.id
	b.arreter(t)
	db, err := store.OpenExisting(filepath.Join(b.dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	var env []byte
	if err := db.QueryRow(`SELECT cle FROM salons_reprise WHERE salon_id=?`, sid).Scan(&env); err != nil {
		t.Fatal("ligne de reprise absente :", err)
	}
	if complet, err := DetruireHorsLigne(db, &blob.Store{Dir: b.cfg.Pieces.Dir}, b.cfg.DossierConversations, c.acces); err != nil || !complet {
		t.Fatal("DetruireHorsLigne :", complet, err)
	}
	if err := store.Checkpoint(db); err != nil {
		t.Fatal(err)
	}
	var n int
	db.QueryRow(`SELECT count(*) FROM salons_reprise`).Scan(&n)
	db.Close()
	if n != 0 {
		t.Fatal("ligne de reprise restée")
	}
	if _, err := os.Stat(filepath.Join(b.cfg.DossierConversations, sid+suffixeReprise)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("conversation mise de côté restée :", err)
	}
	if p := fichiersContiennent(t, b.dir, env); p != "" {
		t.Fatal("enveloppe encore lisible dans", filepath.Base(p))
	}
	b2 := b.demarrer(t, b.cfg.CleReprise)
	b2.m.mu.Lock()
	defer b2.m.mu.Unlock()
	if len(b2.m.salons) != 0 {
		t.Fatal("salon détruit repris")
	}
}

// Au démarrage, la ligne est récrite (nouvelle enveloppe, nouvelle tête) : ni la base ni son WAL ne
// contiennent plus l'enveloppe ni l'état chiffré.
func TestRepriseLignesEffaceesAuDemarrage(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	_, g := b.entrerMembre(t, c, true)
	b.recevoir(t, g, trameD(0, 1))
	b.arreter(t)
	db, err := store.OpenExisting(filepath.Join(b.dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	var env, etat []byte
	if err := db.QueryRow(`SELECT cle, etat FROM salons_reprise`).Scan(&env, &etat); err != nil {
		t.Fatal(err)
	}
	db.Close()
	b2 := b.demarrer(t, b.cfg.CleReprise)
	if lignesReprise(t, b2) != 1 {
		t.Fatal("ligne de reprise non récrite au démarrage")
	}
	for nom, v := range map[string][]byte{"enveloppe": env, "état": etat[:64]} {
		if p := fichiersContiennent(t, b.dir, v); p != "" {
			t.Fatalf("%s encore dans %s après la reprise", nom, filepath.Base(p))
		}
	}
}

// Autre clé maîtresse (ou aucune) au démarrage : rien n'est repris (repli : rejoindre et
// refondation), lignes de reprise effacées, conversation et pièces purgées comme avant ; le
// salon lui-même reste (lien et mot de passe valables).
func TestRepriseAutreCleOuSansCle(t *testing.T) {
	for nom, cle := range map[string]*[32]byte{"autre clé": {9}, "sans clé": nil} {
		t.Run(nom, func(t *testing.T) {
			b := nouveauBancReprise(t)
			c := b.creer(t, 4)
			e0, g := b.entrerMembre(t, c, true)
			b.recevoir(t, g, trameD(0, 1))
			b.arreter(t)
			b2 := b.demarrer(t, cle)
			if _, err := b2.m.Membre(e0.Jeton[:]); !errors.Is(err, ErrNotFound) {
				t.Fatal("salon repris sans la bonne clé :", err)
			}
			if lignesReprise(t, b2) != 0 {
				t.Fatal("ligne de reprise restée")
			}
			if es, _ := os.ReadDir(b.cfg.DossierConversations); len(es) != 0 {
				t.Fatal("conversation restée")
			}
			if _, err := b2.m.Meta(c.acces); err != nil {
				t.Fatal("salon perdu :", err)
			}
			b2.entrer(t, c, true) // repli : nouvelle entrée
		})
	}
}

// Sans clé maîtresse, l'arrêt ne range rien (comportement d'avant le 25 novembre).
func TestSauvegarderSansCle(t *testing.T) {
	b := nouveauBanc(t, 200)
	c := b.creer(t, 4)
	b.entrerMembre(t, c, true)
	b.m.FermerTout()
	if n, err := b.m.Sauvegarder(); n != 0 || err != nil {
		t.Fatal(n, err)
	}
	if lignesReprise(t, b) != 0 {
		t.Fatal("ligne écrite sans clé")
	}
}

// Un salon figé par l'arrêt ne change plus : une trame arrivée après Sauvegarder n'est pas
// rangée (aucun rang donné qui serait redonné après la reprise).
func TestRepriseFigeApresArret(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	_, g := b.entrerMembre(t, c, true)
	b.recevoir(t, g, trameD(0, 1))
	b.m.FermerTout()
	if _, err := b.m.Sauvegarder(); err != nil {
		t.Fatal(err)
	}
	if _, err := b.m.Recevoir(g, trameD(0, 2), nil); !errors.Is(err, ErrNotFound) {
		t.Fatal("trame rangée après l'arrêt :", err)
	}
	if err := b.m.Lu(g, 1); !errors.Is(err, ErrNotFound) {
		t.Fatal("lecture acceptée après l'arrêt :", err)
	}
}

// État rangé abîmé (ou d'un format inconnu) : le salon n'est pas repris, sans panique.
func TestRepriseEtatAbime(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	b.recevoir(t, g, trameD(0, 1))
	s := g.salon
	s.mu.Lock()
	corps := s.encoderV1Locked()
	s.mu.Unlock()
	for i := range corps {
		for _, v := range []byte{0xFF, corps[i] ^ 1} {
			abime := bytes.Clone(corps)
			abime[i] = v
			x := nouveauSalon("x", time.Now(), 4, nil, time.Now)
			_, _ = x.decoderV1(abime, 1) // jamais de panique
		}
	}
	for _, n := range []int{0, 1, len(corps) / 2, len(corps) - 1} {
		x := nouveauSalon("x", time.Now(), 4, nil, time.Now)
		if _, err := x.decoderV1(corps[:n], 1); err == nil {
			t.Fatal("état tronqué accepté à", n)
		}
	}
	if _, err := nouveauSalon("x", time.Now(), 4, nil, time.Now).decoderV1(append(bytes.Clone(corps), 0), 1); err == nil {
		t.Fatal("octet de trop accepté")
	}
	// Ligne abîmée dans la base : salon non repris.
	b.arreter(t)
	db, _ := store.OpenExisting(filepath.Join(b.dir, "shares.db"))
	db.Exec(`UPDATE salons_reprise SET etat=randomblob(length(etat))`)
	db.Close()
	b2 := b.demarrer(t, b.cfg.CleReprise)
	if _, err := b2.m.Membre(e0.Jeton[:]); !errors.Is(err, ErrNotFound) {
		t.Fatal("état abîmé repris :", err)
	}
}

// Clé maîtresse : absente → tirée (32 octets, 0400) puis relue à l'identique ; mauvais droits,
// lien symbolique, mauvaise taille, clé nulle → refus clair (chemin, jamais le contenu).
func TestLireCleMaitresse(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "shh_salons_cle")
	k1, cree, err := LireCleMaitresse(p)
	if err != nil || !cree || k1 == [32]byte{} {
		t.Fatal("création :", err, cree)
	}
	fi, err := os.Stat(p)
	if err != nil || fi.Mode().Perm() != 0o400 || fi.Size() != 32 {
		t.Fatal("fichier tiré :", fi.Mode(), fi.Size(), err)
	}
	k2, cree, err := LireCleMaitresse(p)
	if err != nil || cree || k2 != k1 {
		t.Fatal("relue :", err, cree)
	}
	ecrire := func(nom string, contenu []byte, mode os.FileMode) string {
		q := filepath.Join(dir, nom)
		if err := os.WriteFile(q, contenu, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(q, mode); err != nil {
			t.Fatal(err)
		}
		return q
	}
	lien := filepath.Join(dir, "lien")
	if err := os.Symlink(p, lien); err != nil {
		t.Fatal(err)
	}
	for nom, c := range map[string]struct {
		chemin, attendu string
	}{
		"droits":  {ecrire("ouverte", k1[:], 0o644), "droits 644"},
		"groupe":  {ecrire("groupe", k1[:], 0o440), "droits 440"},
		"courte":  {ecrire("courte", k1[:31], 0o400), "32 octets"},
		"longue":  {ecrire("longue", append(k1[:], 0), 0o400), "32 octets"},
		"nulle":   {ecrire("nulle", make([]byte, 32), 0o400), "clé nulle"},
		"lien":    {lien, "illisible"},
		"relatif": {"secrets/cle", "chemin absolu"},
		"lecture": {filepath.Join(dir, "absent", "cle"), "impossible à créer"},
		"dossier": {dir, "fichier ordinaire"},
		"ok 0600": {ecrire("ok", k1[:], 0o600), ""},
	} {
		_, _, err := LireCleMaitresse(c.chemin)
		if c.attendu == "" {
			if err != nil {
				t.Errorf("%s : %v", nom, err)
			}
			continue
		}
		var ec *ErrCleMaitresse
		if err == nil || !errors.As(err, &ec) || !strings.Contains(err.Error(), c.attendu) {
			t.Errorf("%s : %v", nom, err)
			continue
		}
		if bytes.Contains([]byte(err.Error()), k1[:4]) {
			t.Errorf("%s : contenu de la clé dans le message", nom)
		}
	}
}

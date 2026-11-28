package salon

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/store"
)

// Persistance continue (persistance.go ; conception du salon v3 §5.2) : un plantage (fermeture
// sans Sauvegarder, ni FermerTout, ni passe finale) ne perd plus les salons.

// planter : le processus s'arrête net (aucune écriture de plus), puis un nouveau démarre sur les
// mêmes fichiers.
func (b *banc) planter(t *testing.T) *banc {
	t.Helper()
	b.db.Close()
	return b.demarrer(t, b.cfg.CleReprise)
}

func (b *banc) passe(t *testing.T) {
	t.Helper()
	if err := b.m.persister(b.m.copieSalons(nil)...); err != nil {
		t.Fatal("passe de persistance :", err)
	}
}

// Plantage : salon repris avec ses sièges et jetons ; l'absent rattrape les messages d'avant ;
// les trames arrivées après la dernière passe sont perdues mais leurs rangs ne sont JAMAIS
// redonnés ; le jeton exclu et le jeton parti restent refusés ; la conversation continue.
func TestPlantageReprise(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	ea, a := b.entrerMembre(t, c, false)
	ex, x := b.entrerMembre(t, c, false)
	eq, q := b.entrerMembre(t, c, false)
	var avant []uint64
	for i := range 4 {
		avant = append(avant, b.recevoir(t, g, trameD(0, i)))
	}
	// Exclusion (rangée avant la réponse) et départ (rangé avant la réponse).
	if err := b.m.Exclure(reqExclure(c, invitation(c), siegeP(ex.Siege), &ex.Nonce, 1)); err != nil {
		t.Fatal(err)
	}
	if err := b.m.Quitter(q); err != nil {
		t.Fatal(err)
	}
	_ = x
	b.passe(t)
	// Après la dernière passe : trames et volatiles jamais rangées.
	perdue := b.recevoir(t, a, trameD(0, 50))
	for i := range 30 {
		b.recevoir(t, a, trameD(dVolatile, i))
	}
	plusHaut := dernierSeq(g.salon)
	b2 := b.planter(t)
	g2, a2 := b2.membreDe(t, e0), b2.membreDe(t, ea)
	if g2.siege != 0 || a2.siege != ea.Siege || occupes(g2.salon) != 2 {
		t.Fatal("sièges repris :", g2.siege, a2.siege, occupes(g2.salon))
	}
	if _, err := b2.m.Membre(ex.Jeton[:]); !errors.Is(err, ErrExcluded) {
		t.Fatal("jeton exclu après le plantage :", err)
	}
	if _, err := b2.m.Membre(eq.Jeton[:]); !errors.Is(err, ErrNotFound) {
		t.Fatal("jeton parti après le plantage :", err)
	}
	// L'absent rattrape les messages d'avant (mêmes octets), pas la trame perdue.
	la := b2.connecter(ea.Jeton, ea.Seq)
	time.Sleep(50 * time.Millisecond)
	var recues []uint64
	for i, r := range la.enrs() {
		if r.ty == 0x01 {
			e := lireEnr(t, la.brut(i))
			if k := slices.Index(avant, e.seq); k < 0 || !bytes.Equal(e.trame, trameD(0, k)) {
				t.Fatalf("trame %d rattrapée : inconnue ou changée", e.seq)
			}
			recues = append(recues, e.seq)
		}
	}
	if !slices.Equal(recues, avant) || slices.Contains(recues, perdue) {
		t.Fatalf("rattrapage : %v, attendu %v", recues, avant)
	}
	finir(t, la)
	// Aucun rang redonné.
	if seq := b2.recevoir(t, a2, trameD(0, 99)); seq <= plusHaut {
		t.Fatalf("rang %d redonné (déjà donné jusqu'à %d)", seq, plusHaut)
	}
	// Second plantage juste après : toujours cohérent.
	b3 := b2.planter(t)
	if _, err := b3.m.Membre(ex.Jeton[:]); !errors.Is(err, ErrExcluded) {
		t.Fatal("jeton exclu après le second plantage :", err)
	}
	if mb := b3.membreDe(t, ea); dernierSeq(mb.salon) <= plusHaut {
		t.Fatal("réserve des rangs perdue au second démarrage")
	}
}

// Rotation écrite en base mais exclusion pas encore rangée (plantage entre les deux) : la ligne
// n'est pas reprise, et le jeton de l'exclu ne revient jamais.
func TestPlantageRotationNonRangee(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	b.entrerMembre(t, c, true)
	ea, a := b.entrerMembre(t, c, false)
	b.passe(t)
	if _, err := b.db.Exec(`UPDATE salons SET rotation_r=1 WHERE id=?`, a.salon.id); err != nil {
		t.Fatal(err)
	}
	b2 := b.planter(t)
	if _, err := b2.m.Membre(ea.Jeton[:]); !errors.Is(err, ErrNotFound) {
		t.Fatal("salon repris malgré une rotation non rangée :", err)
	}
	if n := lignesReprise(t, b2); n != 0 {
		t.Fatal("ligne restée :", n)
	}
}

// Renouvellement : la ligne est effacée avant tout changement ; un plantage pendant la
// suspension ne reprend jamais l'ancienne conversation ; après, la ligne porte la nouvelle.
func TestPlantageRenouvellement(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	b.recevoir(t, g, trameD(0, 1))
	b.passe(t)
	ancienne := cleDe(g.salon)
	if err := b.m.suspendre(g.salon); err != nil {
		t.Fatal(err)
	}
	if n := lignesReprise(t, b); n != 0 {
		t.Fatal("ligne pendant la suspension :", n)
	}
	b.m.leverSuspension(g.salon)
	b.regler(t, c, ReglagesReq{Heures: 6})
	if cleDe(g.salon) == ancienne {
		t.Fatal("conversation non renouvelée")
	}
	seq := b.recevoir(t, g, trameD(0, 2))
	b.passe(t)
	b2 := b.planter(t)
	g2 := b2.membreDe(t, e0)
	if cleDe(g2.salon) == ancienne || len(g2.salon.index) != 1 || g2.salon.index[0].seq != seq {
		t.Fatal("état repris après le renouvellement :", len(g2.salon.index))
	}
}

// Retrait : l'emplacement n'est écrasé qu'une fois l'effacement rangé ; après un plantage, la
// trame retirée n'est jamais servie (et son emplacement est écrasé à la reprise si besoin).
func TestPlantageRetrait(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	seq := b.recevoir(t, g, trameD(0, 1))
	b.recevoir(t, g, trameD(0, 2))
	b.passe(t)
	s := g.salon
	// Marqué effacé sans passe : rien à écraser encore.
	if err := b.m.retirer(s, g, seq); err != nil {
		t.Fatal(err)
	}
	if _, l := s.prendreAEcraser(); len(l) != 0 {
		t.Fatal("écrasé avant d'être rangé :", l)
	}
	if err := b.m.Retirer(g, seq); err != nil { // rangé, puis écrasé
		t.Fatal(err)
	}
	s.mu.Lock()
	reste := len(s.aEcraser)
	s.mu.Unlock()
	if reste != 0 {
		t.Fatal("emplacement non écrasé après la passe :", reste)
	}
	b2 := b.planter(t)
	s2 := b2.membreDe(t, e0).salon
	if i := s2.chercherLocked(seq); i < 0 || !s2.index[i].efface() {
		t.Fatal("trame retirée revenue après le plantage")
	}
}

// Après un plantage, le fichier peut être plus long que la dernière ligne (trames écrites
// ensuite) : il est ramené à sa taille, la fin du palier écrasée d'aléa, et le salon repris.
func TestPlantageFichierPlusLong(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	b.recevoir(t, g, trameD(0, 1))
	b.passe(t)
	for i := range 70 { // un palier de plus, jamais rangé
		b.recevoir(t, g, trameD(0, 100+i))
	}
	id := g.salon.id
	b2 := b.planter(t)
	s2 := b2.membreDe(t, e0).salon
	if len(s2.index) != 1 {
		t.Fatal("index repris :", len(s2.index))
	}
	fi, err := os.Stat(filepath.Join(b.cfg.DossierConversations, id))
	if err != nil || fi.Size() != TaillePalier {
		t.Fatal("taille après la reprise :", fi.Size(), err)
	}
	if p := fichiersContiennent(t, b.cfg.DossierConversations, trameD(0, 120)[len(marque)+1:]); p != "" {
		t.Fatal("trame en clair dans le fichier")
	}
}

// Les rangs ne dépassent jamais la réserve écrite : sans passe réussie, le salon refuse au-delà
// (attente), sans rien perdre ni redonner.
func TestBorneDesRangs(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	_, g := b.entrerMembre(t, c, true)
	s := g.salon
	s.mu.Lock()
	s.p.borne = s.seq + margeDeparts + 1
	s.mu.Unlock()
	b.recevoir(t, g, trameD(dVolatile, 1))
	var at *Attente
	if _, err := b.m.Recevoir(g, trameD(0, 2), nil); !errors.As(err, &at) {
		t.Fatal("rang au-delà de la borne :", err)
	}
	if _, err := b.m.Recevoir(g, trameD(dVolatile, 3), nil); !errors.As(err, &at) {
		t.Fatal("volatile au-delà de la borne :", err)
	}
	b.passe(t) // nouvelle réserve
	b.recevoir(t, g, trameD(0, 4))
}

// Toutes les sortes de changements de l'index (ajouts, lectures, départ, échéances, retrait)
// rangées par des passes successives se reprennent à l'identique après un plantage.
func TestPersistanceIndexIdentique(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	_, a := b.entrerMembre(t, c, false)
	_, q := b.entrerMembre(t, c, false)
	var seqs []uint64
	for i := range 3*blocIndex + 17 {
		seqs = append(seqs, b.recevoir(t, g, trameD(dUneMinute, i)))
		if i%97 == 0 {
			b.passe(t)
		}
	}
	for _, k := range []int{3, blocIndex + 5, 2 * blocIndex} {
		b.lu(t, a, seqs[k])
	}
	b.passe(t)
	if err := b.m.Quitter(q); err != nil { // q n'est plus attendu nulle part
		t.Fatal(err)
	}
	b.lu(t, a, seqs[7])
	b.echoir(2 * time.Minute) // échéances : trames effacées
	if err := b.m.Retirer(g, seqs[blocIndex+40]); err != nil {
		t.Fatal(err)
	}
	b.lu(t, a, seqs[len(seqs)-1])
	b.passe(t)
	s := g.salon
	s.mu.Lock()
	index, ech := slices.Clone(s.index), slices.Clone(s.echeances)
	journal := len(s.journal)
	s.mu.Unlock()
	b2 := b.planter(t)
	s2 := b2.membreDe(t, e0).salon
	if !slices.Equal(s2.index, index) || len(s2.journal) != journal {
		t.Fatal("index ou journal repris différents")
	}
	cmp := func(x, y echeance) int { return int(x.seq) - int(y.seq) }
	slices.SortFunc(ech, cmp)
	e2 := slices.Clone(s2.echeances)
	slices.SortFunc(e2, cmp)
	if !slices.Equal(e2, ech) {
		t.Fatal("échéances reprises différentes")
	}
}

// Une ligne de la version 1 (arrêt propre du binaire du 25 novembre : fichier {id}.r) est
// reprise à la mise à jour, puis récrite en version 2.
func TestRepriseLigneV1(t *testing.T) {
	b := nouveauBancReprise(t)
	c := b.creer(t, 4)
	e0, g := b.entrerMembre(t, c, true)
	ea, _ := b.entrerMembre(t, c, false)
	seq := b.recevoir(t, g, trameD(0, 1))
	s := g.salon
	s.mu.Lock()
	corps := s.encoderV1Locked()
	s.fini = true
	s.mu.Unlock()
	k := cleDe(s)
	n := s.conv.nA.Load()
	clair := binary.BigEndian.AppendUint32([]byte{versionEtat}, n)
	etat, _ := sceller(k[:], adEtat, s.id, append(clair, corps...))
	env, _ := sceller(cleTest[:], adCle, s.id, k[:])
	if err := effacerReprises(b.db); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(`INSERT INTO salons_reprise(salon_id,cle,etat) VALUES(?,?,?)`, s.id, env, etat); err != nil {
		t.Fatal(err)
	}
	d := b.cfg.DossierConversations
	if err := os.Rename(filepath.Join(d, s.id), filepath.Join(d, s.id+suffixeReprise)); err != nil {
		t.Fatal(err)
	}
	b2 := b.planter(t)
	g2 := b2.membreDe(t, e0)
	b2.membreDe(t, ea)
	if len(g2.salon.index) != 1 || g2.salon.index[0].seq != seq || dernierSeq(g2.salon) != seq {
		t.Fatal("ligne v1 reprise :", len(g2.salon.index))
	}
	db, _ := store.OpenExisting(filepath.Join(b.dir, "shares.db"))
	defer db.Close()
	var v []byte
	db.QueryRow(`SELECT etat FROM salons_reprise`).Scan(&v)
	if clairV2, err := ouvrir(k[:], adEtat, s.id, v); err != nil || clairV2[0] != versionTete {
		t.Fatal("ligne non récrite en version 2 :", err)
	}
}

package compte

import (
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/limits"
)

// Banc d'essai du compte : horloge figée, base dans un dossier temporaire (TMPDIR), limiteur
// partagé. Un compte de test se crée directement (creerCompteTx) ou par
// une vraie cérémonie WebAuthn (authentificateur logiciel, webauthn_test.go).

type horloge struct {
	mu sync.Mutex
	t  time.Time
}

func (h *horloge) Now() time.Time      { h.mu.Lock(); defer h.mu.Unlock(); return h.t }
func (h *horloge) Add(d time.Duration) { h.mu.Lock(); h.t = h.t.Add(d); h.mu.Unlock() }

type banc struct {
	s      *Service
	db     *sql.DB
	clk    *horloge
	lim    *limits.Limiter
	cles   Cles
	chemin string
}

func clesTest(b byte) Cles {
	var c Cles
	for i := range c.Pseudo {
		c.Pseudo[i] = b
	}
	return c
}

func nouveauBanc(t *testing.T) *banc {
	t.Helper()
	chemin := filepath.Join(t.TempDir(), "comptes.db")
	db, err := OuvrirBase(chemin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	b := &banc{db: db, clk: &horloge{t: time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)}, cles: clesTest(7), chemin: chemin}
	b.lim = limits.New(b.clk.Now)
	b.relancer(t)
	return b
}

// relancer : un nouveau Service sur la même base (redémarrage : la mémoire est perdue).
func (b *banc) relancer(t *testing.T) {
	t.Helper()
	s, err := NewService(Config{DB: b.db, Cles: b.cles, Limites: b.lim, Now: b.clk.Now, Max: 100})
	if err != nil {
		t.Fatal(err)
	}
	b.s = s
}

// coffreTest : coffre de la forme du serveur (en-tête, gen, nonce, chiffré au palier, étiquette),
// contenu aléatoire (le serveur ne l'ouvre jamais).
func coffreTest(magic string, gen uint64, palier int) []byte {
	b := make([]byte, palier+45)
	rand.Read(b)
	copy(b, magic)
	binary.BigEndian.PutUint64(b[9:], gen)
	return b
}

func alea32() (k [32]byte) { rand.Read(k[:]); return }

// canonTest : pseudo_canon du moteur pour un pseudo ASCII (minuscules ; i et 1 → l ; 0 → o ;
// m → rn), complété à 2 caractères pour les pseudos d'une lettre.
func canonTest(p string) string {
	r := strings.NewReplacer("i", "l", "1", "l", "0", "o", "m", "rn").Replace(strings.ToLower(p))
	if len(r) == 1 {
		r += "x"
	}
	return r
}

// nouveauCompteTest : ce que l'appareil enverrait (v_r, Env_r, coffres au palier 4 Kio).
func nouveauCompteTest(pseudo string) NouveauCompte {
	nc := NouveauCompte{PCanon: []byte(canonTest(pseudo)), VR: alea32(),
		BlobProfil: coffreTest("SHH-PROF1", 1, 4096), BlobPrive: coffreTest("SHH-ACCT1", 1, 4096)}
	rand.Read(nc.EnvR[:])
	return nc
}

// passkeyTest : une passkey de forme valide (clé publique aléatoire : jamais vérifiée ici).
func passkeyTest() Passkey {
	p := Passkey{CredID: make([]byte, 32), ClePub: make([]byte, 77), Alg: -7, BE: true, Env: make([]byte, 60)}
	rand.Read(p.CredID)
	rand.Read(p.ClePub)
	rand.Read(p.Env)
	return p
}

// inscrire : un compte complet créé directement (sans cérémonie) ; rend h et le jeton d'une
// session récente, et ce que l'appareil a envoyé.
func (b *banc) inscrire(t *testing.T, pseudo string) ([16]byte, [32]byte, NouveauCompte) {
	t.Helper()
	var h [16]byte
	rand.Read(h[:])
	var tok [32]byte
	nc := nouveauCompteTest(pseudo)
	err := b.s.tx(func(tx *sql.Tx) error {
		var err error
		tok, err = b.s.creerCompteTx(tx, h, nc, passkeyTest(), OptionsSession{}, b.clk.Now())
		return err
	})
	if err != nil {
		t.Fatalf("création du compte %s : %v", pseudo, err)
	}
	return h, tok, nc
}

// ouvertureTest : une connexion réussie (jeton de session).
type ouvertureTest struct{ Jeton [32]byte }

// connecter : une nouvelle session (récente) du compte h, sans cérémonie.
func (b *banc) connecter(h [16]byte) (ouvertureTest, error) {
	var o ouvertureTest
	err := b.s.tx(func(tx *sql.Tx) error {
		var err error
		o.Jeton, err = b.s.creerSessionTx(tx, h, OptionsSession{}, false, b.clk.Now())
		return err
	})
	return o, err
}

// session : la session du jeton.
func (b *banc) session(t *testing.T, j [32]byte) Courante {
	t.Helper()
	c, err := b.s.Session(j)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (b *banc) nComptes(t *testing.T) int {
	t.Helper()
	var n int
	if err := b.db.QueryRow(`SELECT count(*) FROM comptes`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (b *banc) nSessions(t *testing.T) int {
	t.Helper()
	var n int
	if err := b.db.QueryRow(`SELECT count(*) FROM sessions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// fichiers : base et WAL lus en entier.
func (b *banc) fichiers(t *testing.T) []byte {
	t.Helper()
	var out []byte
	for _, f := range []string{b.chemin, b.chemin + "-wal"} {
		c, err := os.ReadFile(f)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		out = append(out, c...)
	}
	return out
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

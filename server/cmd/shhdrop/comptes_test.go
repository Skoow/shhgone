package main

import (
	"bytes"
	"errors"
	"github.com/skoow/shhdrop/server/internal/api"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/config"
	"github.com/skoow/shhdrop/server/internal/limits"
	"github.com/skoow/shhdrop/server/internal/salon"
	"github.com/skoow/shhdrop/server/internal/share"
	"github.com/skoow/shhdrop/server/internal/store"
)

// Compte désactivé : setupComptes ne lit rien et ne crée rien.
func TestSetupComptesDesactive(t *testing.T) {
	dir := t.TempDir()
	c, err := setupComptes(config.Config{DataDir: dir, ComptesCleFile: filepath.Join(dir, "absente")})
	if err != nil || c != nil {
		t.Fatalf("%v %v", c, err)
	}
	if es, _ := os.ReadDir(dir); len(es) != 0 {
		t.Fatalf("fichiers créés : %v", es)
	}
}

// Compte activé : clé du serveur lue (refus au démarrage si elle est fausse), comptes.db créée
// en 0600 dans SHH_DATA_DIR ; rien n'est encore servi (lot 4).
func TestSetupComptesActive(t *testing.T) {
	dir, secrets := t.TempDir(), t.TempDir()
	cle := filepath.Join(secrets, "cle")
	if err := os.WriteFile(cle, bytes.Repeat([]byte{9}, 32), 0o400); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{DataDir: dir, Comptes: true, ComptesCleFile: cle}
	c, err := setupComptes(cfg)
	if err != nil || c == nil || c.db == nil || c.cles.Pseudo == [32]byte{} {
		t.Fatalf("%v %v", c, err)
	}
	c.db.Close()
	st, err := os.Stat(filepath.Join(dir, "comptes.db"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("comptes.db : %v %v", st, err)
	}
	if err := os.Chmod(cle, 0o644); err != nil {
		t.Fatal(err)
	}
	if c, err := setupComptes(cfg); err == nil {
		c.db.Close()
		t.Fatal("clé lisible par tous acceptée")
	} else if msg := publicMessage(err); !strings.Contains(msg, "SHH_COMPTES_CLE_FILE") {
		t.Fatal("message pour l'exploitant attendu :", msg)
	}
}

// SHH_COMPTES=0 : ni service, ni routes du compte.
func TestBrancherComptesDesactive(t *testing.T) {
	if err := brancherComptes(config.Config{}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if s := salonsOf(config.Config{Salons: true}, nil, &comptes{}, api.Turn{}); s.Comptes != nil {
		t.Fatal("service du compte sans SHH_COMPTES")
	}
}

// SHH_COMPTES=1 : service créé (aucun secret d'e-mail lu), routes servies (salonsOf les donne à
// l'API).
func TestBrancherComptesActive(t *testing.T) {
	dir, secrets := t.TempDir(), t.TempDir()
	cle := filepath.Join(secrets, "cle")
	os.WriteFile(cle, bytes.Repeat([]byte{9}, 32), 0o400)
	cfg := config.Config{DataDir: dir, Salons: true, Comptes: true, ComptesCleFile: cle, ComptesMax: 10, ComptesJour: 500}
	cpt, err := setupComptes(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cpt.db.Close()
	if err := brancherComptes(cfg, cpt, limits.New(time.Now), nil); err != nil || cpt.svc == nil {
		t.Fatal(err)
	}
	if s := salonsOf(cfg, nil, cpt, api.Turn{}); s.Comptes != cpt.svc {
		t.Fatal("service non donné à l'API")
	}
}

// SHH_COMPTES=1 et SHH_SALONS=1 (lot 6) : le gestionnaire lit le palier dans le service du
// compte (une création pour un compte inconnu est refusée), et le service voit les salons du
// compte (liste) par les crochets du gestionnaire.
func TestBrancherComptesSalons(t *testing.T) {
	dir, secrets := t.TempDir(), t.TempDir()
	cle := filepath.Join(secrets, "cle")
	os.WriteFile(cle, bytes.Repeat([]byte{9}, 32), 0o400)
	cfg := config.Config{DataDir: dir, Salons: true, SalonsMax: 10, StorageMaxBytes: 1 << 40, Now: time.Now,
		Comptes: true, ComptesCleFile: cle, ComptesMax: 10}
	db, err := store.Open(filepath.Join(dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc, err := share.NewService(share.Config{DB: db, Blobs: &blob.Store{Dir: filepath.Join(dir, "blobs")}, Now: time.Now,
		StorageMax: 1 << 40, FrozenFile: filepath.Join(dir, "frozen")})
	if err != nil {
		t.Fatal(err)
	}
	cpt, err := setupComptes(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer cpt.db.Close()
	lim := limits.New(time.Now)
	sm, err := setupSalons(cfg, db, svc, lim, blob.NewGate(4), store.NewVidage(db), cpt)
	if err != nil {
		t.Fatal(err)
	}
	if err := brancherComptes(cfg, cpt, lim, sm); err != nil {
		t.Fatal(err)
	}
	h := [16]byte{7}
	r := salon.CreerReq{AccessV: bytes.Repeat([]byte{1}, 32), ManageV: bytes.Repeat([]byte{2}, 32),
		ProofV: bytes.Repeat([]byte{3}, 32), Salt: make([]byte, 16), TTLHours: 1, MaxMembers: 2, KdfOps: 3,
		KdfMem: 67108864, Bloc: [32]byte{1}, Compte: &h}
	if _, err := sm.Creer(r); !errors.Is(err, compte.ErrSession) {
		t.Fatal("création pour un compte inconnu :", err)
	}
	if _, err := db.Exec(`INSERT INTO salons(id,access_v,manage_v,proof_v,salt,kdf_ops,kdf_mem,expires_at,max_members,
		members_can_destroy,compte) VALUES('salonsalonsalonsalonsa',?,?,?,?,3,67108864,?,2,0,?)`, r.AccessV, r.ManageV,
		r.ProofV, r.Salt, time.Now().Unix()/900*900+3600, h[:]); err != nil {
		t.Fatal(err)
	}
	if ls, err := cpt.svc.SalonsListe(compte.Courante{H: h}); err != nil || len(ls) != 1 {
		t.Fatal("salons du compte :", ls, err)
	}
}

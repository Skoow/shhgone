package paiement

import (
	"database/sql"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/nom"
)

func nomEnBase(t *testing.T, db *sql.DB, id string) (string, bool) {
	t.Helper()
	q, _ := hex.DecodeString(id)
	var n []byte
	err := db.QueryRow(`SELECT nom FROM noms_offerts WHERE q=?`, q).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(n), true
}

// TestOffrirAvecNom : le nom est rangé avec le pass (dans la même transaction), rendu par la
// liste ; un nom invalide ne crée rien.
func TestOffrirAvecNom(t *testing.T) {
	b := nouveauBanc(t)
	_, a, err := b.s.Offrir(JoursOffertAn, "  Léa (cousine) ")
	if err != nil || a.Nom != "Léa (cousine)" {
		t.Fatal(a, err)
	}
	if n, ok := nomEnBase(t, b.db, a.ID); !ok || n != "Léa (cousine)" {
		t.Fatal(n, ok)
	}
	_, sans, _ := b.s.Offrir(JoursOffertMois, "   ")
	if _, ok := nomEnBase(t, b.db, sans.ID); ok || sans.Nom != "" {
		t.Fatal("nom vide gardé")
	}
	for _, faux := range []string{strings.Repeat("a", nom.Max+1), "a\nb", "a\u202eb", "a\x00b"} {
		if _, _, err := b.s.Offrir(JoursOffertAn, faux); !errors.Is(err, nom.ErrNom) {
			t.Fatalf("%q : %v", faux, err)
		}
	}
	l, err := b.s.AccesOfferts()
	if err != nil || len(l) != 2 {
		t.Fatal(l, err)
	}
	for _, x := range l {
		if x.ID == a.ID && x.Nom != "Léa (cousine)" || x.ID == sans.ID && x.Nom != "" {
			t.Fatalf("%+v", x)
		}
	}
}

// TestNommerOffert : nommer, renommer, effacer (nom vide) ; bornes ; jamais un pass payé ni
// un identifiant inconnu ou mal formé ; un accès révoqué se renomme encore.
func TestNommerOffert(t *testing.T) {
	b := nouveauBanc(t)
	_, a, _ := b.s.Offrir(JoursOffertAn, "")
	if ok, err := b.s.NommerOffert(a.ID, "Alice"); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if ok, err := b.s.NommerOffert(a.ID, strings.Repeat("é", nom.Max)); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if n, _ := nomEnBase(t, b.db, a.ID); n != strings.Repeat("é", nom.Max) {
		t.Fatal(n)
	}
	for _, faux := range []string{strings.Repeat("é", nom.Max+1), "a\tb", "a\u2028b", "\xff"} {
		if ok, err := b.s.NommerOffert(a.ID, faux); ok || !errors.Is(err, nom.ErrNom) {
			t.Fatalf("%q : %v %v", faux, ok, err)
		}
	}
	if n, _ := nomEnBase(t, b.db, a.ID); n != strings.Repeat("é", nom.Max) {
		t.Fatal("nom changé par un refus :", n)
	}
	if ok, err := b.s.NommerOffert(a.ID, ""); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if _, ok := nomEnBase(t, b.db, a.ID); ok {
		t.Fatal("nom pas effacé")
	}
	c := b.commander(t, passN(7), Formule{Pro, JoursMois, true, Carte})
	b.webhook(t, confirme(c, "pi_7", 2000))
	qPaye := passN(7).Empreinte()
	for _, id := range []string{"", "zz", a.ID[:6], strings.ToUpper(a.ID), hex.EncodeToString(qPaye[:]), strings.Repeat("0", 64)} {
		if ok, err := b.s.NommerOffert(id, "Bob"); ok || err != nil {
			t.Fatal("nommé :", id, err)
		}
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM noms_offerts`).Scan(&n)
	if n != 0 {
		t.Fatal(n, "noms pour un pass payé ou inconnu")
	}
	b.s.RevoquerOffert(a.ID)
	if ok, err := b.s.NommerOffert(a.ID, "Alice (révoqué)"); !ok || err != nil {
		t.Fatal(ok, err)
	}
}

// TestNomEffaceAvecLePass : la purge d'un accès offert (31 jours après sa fin) efface son nom
// (ON DELETE CASCADE) ; la base refuse un nom sans pass, vide ou trop long.
func TestNomEffaceAvecLePass(t *testing.T) {
	b := nouveauBanc(t)
	_, a, _ := b.s.Offrir(JoursOffertMois, "Alice")
	_, garde, _ := b.s.Offrir(JoursOffertAn, "Bob")
	b.s.RevoquerOffert(a.ID)
	b.now = b.now.Add(31 * 24 * time.Hour)
	b.s.Purger()
	if _, ok := nomEnBase(t, b.db, a.ID); ok {
		t.Fatal("nom gardé après la purge du pass")
	}
	if n, ok := nomEnBase(t, b.db, garde.ID); !ok || n != "Bob" {
		t.Fatal("autre nom effacé")
	}
	for _, v := range [][2]any{
		{make([]byte, 32), []byte("x")},                    // pass inconnu
		{mustHex(garde.ID), []byte{}},                      // vide
		{mustHex(garde.ID), make([]byte, nom.OctetsMax+1)}, // trop long
		{mustHex(garde.ID), "texte"},                       // TEXT, pas BLOB
	} {
		if _, err := b.db.Exec(`INSERT OR REPLACE INTO noms_offerts(q, nom) VALUES(?,?)`, v[0], v[1]); err == nil {
			t.Errorf("%v accepté", v)
		}
	}
}

func mustHex(s string) []byte { b, _ := hex.DecodeString(s); return b }

// TestMigrationV3 : une base de la version 3 (accès offerts sans noms) reçoit la table
// noms_offerts, ses pass gardés ; la cascade y vaut comme dans une base neuve.
func TestMigrationV3(t *testing.T) {
	chemin := baseAncienne(t, schemaPaiements, `INSERT INTO passes VALUES(?,2,0,86400,100,0,0,0,0,1)`, 3)
	db, err := OuvrirBase(chemin)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var v, n int
	db.QueryRow(`PRAGMA user_version`).Scan(&v)
	db.QueryRow(`SELECT count(*) FROM passes WHERE offert=1`).Scan(&n)
	if VersionBase != 4 || v != VersionBase || n != 1 {
		t.Fatal(v, n)
	}
	q := make([]byte, 32)
	if _, err := db.Exec(`INSERT INTO noms_offerts(q, nom) VALUES(?,?)`, q, []byte("Alice")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM passes WHERE q=?`, q); err != nil {
		t.Fatal(err)
	}
	db.QueryRow(`SELECT count(*) FROM noms_offerts`).Scan(&n)
	if n != 0 {
		t.Fatal("cascade absente après migration")
	}
	schema := func(d *sql.DB) string {
		var s string
		d.QueryRow(`SELECT sql FROM sqlite_master WHERE name='noms_offerts'`).Scan(&s)
		return s
	}
	neuve, err := OuvrirBase(filepath.Join(t.TempDir(), "n.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer neuve.Close()
	if a, b := schema(db), schema(neuve); a != b || a == "" {
		t.Fatalf("table migrée %q, neuve %q", a, b)
	}
	db.Close()
	db2, err := OuvrirBase(chemin) // rouverte : rien à refaire
	if err != nil {
		t.Fatal(err)
	}
	db2.Close()
}

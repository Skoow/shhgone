package store

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Table de reprise des salons (salons persistants, 25 novembre) : ajoutée à une base du schéma 4
// sans la changer de version (un binaire plus ancien l'ignore, le retour arrière reste possible),
// salons gardés ; enveloppe de 60 octets exactement ; ligne effacée avec son salon.
func TestTableReprise(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := insSalon(db, "a"); err != nil {
		t.Fatal(err)
	}
	// Base du schéma 4 d'avant la table : retirée, puis rouverte.
	if _, err := db.Exec(`DROP TABLE salons_reprise`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if v := pragma(t, db, "user_version"); v != strconv.Itoa(SchemaVersion) {
		t.Fatal("user_version", v)
	}
	if got := strings.Join(masterNames(t, db), ","); got != wantMaster {
		t.Fatalf("sqlite_master = %s", got)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM salons WHERE id='a'`).Scan(&n); err != nil || n != 1 {
		t.Fatal("salon perdu :", n, err)
	}
	for _, v := range []string{"zeroblob(59)", "zeroblob(61)", "'texte'"} {
		if _, err := db.Exec(`INSERT INTO salons_reprise(salon_id,cle,etat) VALUES('a',` + v + `,x'00')`); err == nil {
			t.Errorf("enveloppe %s acceptée", v)
		}
	}
	if _, err := db.Exec(`INSERT INTO salons_reprise(salon_id,cle,etat) VALUES('inconnu',zeroblob(60),x'00')`); err == nil {
		t.Error("ligne de reprise sans salon acceptée")
	}
	if _, err := db.Exec(`INSERT INTO salons_reprise(salon_id,cle,etat) VALUES('a',randomblob(60),randomblob(100))`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM salons WHERE id='a'`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM salons_reprise`).Scan(&n); err != nil || n != 0 {
		t.Fatal("ligne de reprise restée après son salon :", n, err)
	}
}

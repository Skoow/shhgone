package store

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Tables de reprise des partages (D42-31) : ajoutées à une base du schéma 5 qui ne les a pas
// (partage gardé), bornes vérifiées, lignes effacées avec leur partage (ON DELETE CASCADE).
func TestTablesReprisePartages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO shares(id,state,bucket,opens_left,segments_mask,access_v,manage_v) VALUES('u','uploading',16,0,x'00',x'01',x'02')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE shares_envoi; DROP TABLE shares_ouvertures; PRAGMA user_version=5`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if db, err = Open(path); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if v := pragma(t, db, "user_version"); v != strconv.Itoa(SchemaVersion) {
		t.Fatal("user_version", v)
	}
	for _, q := range []string{
		`INSERT INTO shares_envoi(share_id,echeance,formule) VALUES('u',901,zeroblob(29))`,       // pas au quart d'heure
		`INSERT INTO shares_envoi(share_id,echeance,formule) VALUES('u',900,zeroblob(28))`,       // formule mal formée
		`INSERT INTO shares_envoi(share_id,echeance,formule) VALUES('inconnu',900,zeroblob(29))`, // sans partage
		`INSERT INTO shares_envoi(share_id,echeance,formule,partiels) VALUES('u',900,zeroblob(29),zeroblob(11))`,
		`INSERT INTO shares_ouvertures(share_id,n,octroi) VALUES('u',0,zeroblob(32))`,
		`INSERT INTO shares_ouvertures(share_id,n,octroi) VALUES('u',1,zeroblob(31))`,
		`INSERT INTO shares_ouvertures(share_id,n,octroi,voix) VALUES('u',1,zeroblob(32),2)`,
		`INSERT INTO shares_ouvertures(share_id,n,octroi) VALUES('inconnu',1,zeroblob(32))`,
	} {
		if _, err := db.Exec(q); err == nil {
			t.Errorf("accepté : %s", q)
		}
	}
	for _, q := range []string{
		`INSERT INTO shares_envoi(share_id,echeance,formule,partiels) VALUES('u',900,zeroblob(29),zeroblob(24))`,
		`INSERT INTO shares_ouvertures(share_id,n,octroi,voix) VALUES('u',20,zeroblob(32),1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	if _, err := db.Exec(`DELETE FROM shares WHERE id='u'`); err != nil {
		t.Fatal(err)
	}
	for _, tb := range []string{"shares_envoi", "shares_ouvertures"} {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM ` + tb).Scan(&n); err != nil || n != 0 {
			t.Fatal("ligne restée après son partage :", tb, n, err)
		}
	}
}

// Tables de reprise des salons (salons persistants, 25 et 26 novembre) : ajoutées à une base
// qui ne les a pas ; enveloppe de 60 octets, blocs bornés ; tout effacé avec le salon (en chaîne).
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
	for _, q := range []string{`INSERT INTO salons_reprise_blocs VALUES('a',2,0,x'00')`, `INSERT INTO salons_reprise_blocs VALUES('a',0,-1,x'00')`,
		`INSERT INTO salons_reprise_blocs VALUES('inconnu',0,0,x'00')`, `INSERT INTO salons_reprise_blocs VALUES('a',0,0,'texte')`} {
		if _, err := db.Exec(q); err == nil {
			t.Errorf("bloc accepté : %s", q)
		}
	}
	if _, err := db.Exec(`INSERT INTO salons_reprise_blocs VALUES('a',1,0,randomblob(100))`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM salons WHERE id='a'`); err != nil {
		t.Fatal(err)
	}
	for _, tb := range []string{"salons_reprise", "salons_reprise_blocs"} {
		if err := db.QueryRow(`SELECT count(*) FROM ` + tb).Scan(&n); err != nil || n != 0 {
			t.Fatal("ligne de reprise restée après son salon :", tb, n, err)
		}
	}
}

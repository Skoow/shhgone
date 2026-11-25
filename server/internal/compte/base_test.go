package compte

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func ouvrir(t *testing.T) (*sql.DB, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "comptes.db")
	db, err := OuvrirBase(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, p
}

func lignes(t *testing.T, db *sql.DB, q string, args ...any) []string {
	t.Helper()
	rs, err := db.Query(q, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	var out []string
	for rs.Next() {
		var s string
		if err := rs.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

// Conception du compte par passkey §6.3 : schéma 3 exact de comptes.db (tables, colonnes,
// index), rien d'autre ; aucune colonne texte ; aucune colonne d'adresse, de mot de passe, de
// TOTP, de séquestre, d'AAGUID, de BS ni de date d'usage. Schéma 4 : sign_count, compteur de
// signatures WebAuthn (refus d'un compteur qui recule, demande de l'audit du 25 novembre).
// Schéma 5 : sur_mesure (limites et nom donnés par l'exploitant, décision du 25 novembre).
func TestSchemaComptes(t *testing.T) {
	db, _ := ouvrir(t)
	const wantMaster = "index:bannis_h,index:comptes_p_empreinte,index:comptes_v_r,index:passkeys_h," +
		"index:sessions_h,index:sessions_sid,table:bannis,table:comptes,table:enveloppes,table:passkeys,table:sessions,table:sur_mesure"
	if got := strings.Join(lignes(t, db, `SELECT type || ':' || name FROM sqlite_master ORDER BY 1`), ","); got != wantMaster {
		t.Fatalf("sqlite_master = %s\nattendu        %s", got, wantMaster)
	}
	want := map[string]string{
		"comptes": "h:BLOB,p_empreinte:BLOB,pseudo_jour:INTEGER,v_r:BLOB,env_r:BLOB,blob_profil:BLOB,gen_profil:INTEGER," +
			"blob_prive:BLOB,gen_prive:INTEGER,cree_jour:INTEGER,compte_des:INTEGER,vu_mois:INTEGER",
		"passkeys":   "cred_id:BLOB,h:BLOB,cle_pub:BLOB,alg:INTEGER,be:INTEGER,etiquette:BLOB,ajoutee_mois:INTEGER,sign_count:INTEGER",
		"enveloppes": "cred_id:BLOB,n:INTEGER,env:BLOB",
		"sessions": "t_v:BLOB,sid:BLOB,h:BLOB,etiquette:BLOB,cree_mois:INTEGER,expire_jour:INTEGER,persistante:INTEGER," +
			"par_recup:INTEGER",
		"bannis":     "id:BLOB,h:BLOB,debut_jour:INTEGER,jusqu_jour:INTEGER,actif:INTEGER,motif:INTEGER,salons_fermes:INTEGER",
		"sur_mesure": "h:BLOB,salons:INTEGER,places:INTEGER,jours:INTEGER,nom:BLOB,depuis_jour:INTEGER",
	}
	interdits := []string{"e_", "email", "adresse", "mdp", "cle_profil", "totp", "recup_jour", "aaguid", "compteur",
		"bs", "vu_jour", "transport", "attestation", "ip", "heure", "pseudo_canon", "p_canon"}
	for table, w := range want {
		got := strings.Join(lignes(t, db, `SELECT name || ':' || type FROM pragma_table_info(?) ORDER BY cid`, table), ",")
		if got != w {
			t.Errorf("%s : %s\nattendu %s", table, got, w)
		}
		for _, c := range strings.Split(got, ",") {
			n, ty, _ := strings.Cut(c, ":")
			if ty != "BLOB" && ty != "INTEGER" {
				t.Errorf("%s.%s : type %s (seuls BLOB et INTEGER)", table, n, ty)
			}
			for _, x := range interdits {
				if n == x || (strings.HasSuffix(x, "_") && strings.HasPrefix(n, x)) {
					t.Errorf("%s.%s : colonne interdite", table, n)
				}
			}
		}
	}
	if v := lignes(t, db, `PRAGMA user_version`); len(v) != 1 || v[0] != "5" {
		t.Fatalf("user_version = %v", v)
	}
	for p, w := range map[string]string{"secure_delete": "1", "journal_mode": "wal", "foreign_keys": "1", "temp_store": "2",
		"journal_size_limit": "0", "synchronous": "2"} {
		if v := lignes(t, db, "PRAGMA "+p); len(v) != 1 || v[0] != w {
			t.Errorf("PRAGMA %s = %v, attendu %s", p, v, w)
		}
	}
}

func TestComptesWithoutRowid(t *testing.T) {
	db, _ := ouvrir(t)
	for _, table := range []string{"comptes", "passkeys", "sessions", "bannis"} {
		var v int
		if err := db.QueryRow("SELECT rowid FROM " + table).Scan(&v); err == nil || !strings.Contains(err.Error(), "rowid") {
			t.Errorf("%s a un rowid : %v", table, err)
		}
	}
}

const (
	jour = 86400 * 20000 // 4 octobre 2024, minuit UTC
	mois = 1727740800    // 1er octobre 2024, minuit UTC
	p4k  = 4096 + 45     // coffre au palier 4 Kio
)

// colonnes de comptes, dans l'ordre du schéma.
var colsCompte = []string{"h", "p_empreinte", "pseudo_jour", "v_r", "env_r", "blob_profil", "gen_profil", "blob_prive",
	"gen_prive", "cree_jour", "compte_des", "vu_mois"}

// insCompte : une ligne comptes valide, colonne col remplacée par v (SQL) si col n'est pas vide.
func insCompte(db *sql.DB, h string, col, v string) error {
	vals := map[string]string{
		"h": "x'" + h + "'", "p_empreinte": "randomblob(32)", "pseudo_jour": itoa(jour), "v_r": "randomblob(32)",
		"env_r": "randomblob(60)", "blob_profil": "randomblob(" + itoa(p4k) + ")", "gen_profil": "1",
		"blob_prive": "randomblob(" + itoa(p4k) + ")", "gen_prive": "1", "cree_jour": itoa(jour), "compte_des": itoa(jour),
		"vu_mois": itoa(mois),
	}
	if col != "" {
		vals[col] = v
	}
	var vs []string
	for _, c := range colsCompte {
		vs = append(vs, vals[c])
	}
	_, err := db.Exec(`INSERT INTO comptes(` + strings.Join(colsCompte, ",") + `) VALUES(` + strings.Join(vs, ",") + `)`)
	return err
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

const h1 = "00112233445566778899aabbccddeeff"

// Dates au jour (multiple de 86 400) ou au mois (premier du mois, minuit UTC), jamais d'heure ;
// longueurs exactes des empreintes, enveloppes et coffres (paliers 4, 16, 64, 256 Kio).
func TestDatesAuJour(t *testing.T) {
	db, _ := ouvrir(t)
	if err := insCompte(db, h1, "", ""); err != nil {
		t.Fatal("compte valide refusé :", err)
	}
	refus := map[string][2]string{
		"cree_jour 86 401":        {"cree_jour", itoa(jour + 1)},
		"compte_des à 1 h":        {"compte_des", itoa(jour + 3600)},
		"pseudo_jour négatif":     {"pseudo_jour", "-86400"},
		"vu_mois au 2 du mois":    {"vu_mois", itoa(mois + 86400)},
		"vu_mois à 1 h":           {"vu_mois", itoa(mois + 3600)},
		"h de 15":                 {"h", "x'00112233445566778899aabbccddee'"},
		"p_empreinte de 16":       {"p_empreinte", "randomblob(16)"},
		"v_r de 31":               {"v_r", "randomblob(31)"},
		"v_r NULL":                {"v_r", "NULL"},
		"env_r de 59":             {"env_r", "randomblob(59)"},
		"env_r de 61":             {"env_r", "randomblob(61)"},
		"blob_profil hors palier": {"blob_profil", "randomblob(4096)"},
		"blob_prive hors palier":  {"blob_prive", "randomblob(" + itoa(p4k+1) + ")"},
		"blob_prive de 512 Kio":   {"blob_prive", "randomblob(" + itoa(524288+45) + ")"},
		"gen_profil négatif":      {"gen_profil", "-1"},
		"h texte":                 {"h", "'0011223344556677'"},
	}
	for nom, c := range refus {
		h := "ffeeddccbbaa99887766554433221100"
		if err := insCompte(db, h, c[0], c[1]); err == nil {
			t.Errorf("%s accepté", nom)
			db.Exec(`DELETE FROM comptes WHERE h=x'` + h + `'`)
		}
	}
	for _, palier := range []int64{4096, 16384, 65536, 262144} {
		h := "aa" + h1[2:]
		if err := insCompte(db, h, "blob_prive", "randomblob("+itoa(palier+45)+")"); err != nil {
			t.Errorf("palier %d refusé : %v", palier, err)
		}
		db.Exec(`DELETE FROM comptes WHERE h=x'` + h + `'`)
	}
	// v_r unique : la clé de récupération seule retrouve le compte.
	if _, err := db.Exec(`UPDATE comptes SET v_r=x'` + strings.Repeat("11", 32) + `'`); err != nil {
		t.Fatal(err)
	}
	if err := insCompte(db, "cc"+h1[2:], "v_r", "x'"+strings.Repeat("11", 32)+"'"); err == nil {
		t.Error("v_r en double accepté")
	}
}

// Passkeys : longueurs (cred_id 1 à 1 023, clé publique ≤ 1 024, libellé 64), algorithmes −7,
// −8, −257 seulement, mois d'ajout ; effacées avec le compte. Enveloppes : 60 octets, n de 0 à 3
// (4 par passkey), passkey existante, effacées avec la passkey (et donc avec le compte).
func TestPasskeysContraintes(t *testing.T) {
	db, _ := ouvrir(t)
	if err := insCompte(db, h1, "", ""); err != nil {
		t.Fatal(err)
	}
	ins := func(v ...string) error {
		_, err := db.Exec(`INSERT INTO passkeys(cred_id,h,cle_pub,alg,be,etiquette,ajoutee_mois) VALUES(` +
			strings.Join(v, ",") + `)`)
		return err
	}
	ok := []string{"randomblob(32)", "x'" + h1 + "'", "randomblob(77)", "-7", "1", "randomblob(64)", itoa(mois)}
	if err := ins(ok...); err != nil {
		t.Fatal("passkey valide refusée :", err)
	}
	for i, bads := range [][]string{{"randomblob(1024)", "x''", "'id'"}, {"x'" + strings.Repeat("00", 16) + "'"},
		{"randomblob(1025)", "x''"}, {"-35", "1", "-47", "-7.5"}, {"2", "-1"},
		{"randomblob(63)", "randomblob(65)"}, {itoa(mois + 86400), itoa(mois + 1)}} {
		for _, bad := range bads {
			v := append([]string(nil), ok...)
			v[i] = bad
			if err := ins(v...); err == nil {
				t.Errorf("passkeys : colonne %d = %s acceptée", i, bad)
			}
		}
	}
	for _, alg := range []string{"-8", "-257"} {
		v := append([]string(nil), ok...)
		v[3] = alg
		if err := ins(v...); err != nil {
			t.Errorf("algorithme %s refusé : %v", alg, err)
		}
	}
	v := append([]string(nil), ok...)
	v[0], v[5] = "x'"+strings.Repeat("ab", 1023)+"'", "NULL"
	if err := ins(v...); err != nil {
		t.Error("passkey sans libellé refusée :", err)
	}
	// Enveloppes de la passkey de 1 023 octets.
	cred := "x'" + strings.Repeat("ab", 1023) + "'"
	env := func(c, n, e string) error {
		_, err := db.Exec(`INSERT INTO enveloppes(cred_id,n,env) VALUES(` + c + `,` + n + `,` + e + `)`)
		return err
	}
	for n := range 4 {
		if err := env(cred, itoa(int64(n)), "randomblob(60)"); err != nil {
			t.Fatalf("enveloppe %d refusée : %v", n, err)
		}
	}
	for _, bad := range [][3]string{{cred, "4", "randomblob(60)"}, {cred, "-1", "randomblob(60)"},
		{cred, "0", "randomblob(60)"}, {cred, "1.5", "randomblob(60)"}, {cred, "'1'", "randomblob(60)"},
		{"randomblob(32)", "0", "randomblob(60)"}} {
		if err := env(bad[0], bad[1], bad[2]); err == nil {
			t.Errorf("enveloppe %v acceptée", bad[1:])
		}
	}
	if _, err := db.Exec(`DELETE FROM enveloppes WHERE cred_id=` + cred + ` AND n=3`); err != nil {
		t.Fatal(err)
	}
	for _, e := range []string{"randomblob(59)", "randomblob(61)", "NULL", "'x'"} {
		if err := env(cred, "3", e); err == nil {
			t.Errorf("enveloppe %s acceptée", e)
		}
	}
	if _, err := db.Exec(`DELETE FROM passkeys WHERE cred_id=` + cred); err != nil {
		t.Fatal(err)
	}
	if n := lignes(t, db, `SELECT count(*) FROM enveloppes`); n[0] != "0" {
		t.Error("enveloppes d'une passkey retirée restantes :", n)
	}
	v[0] = "x'01'"
	if err := ins(v...); err != nil {
		t.Fatal(err)
	}
	if err := env("x'01'", "0", "randomblob(60)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM comptes WHERE h=x'` + h1 + `'`); err != nil {
		t.Fatal(err)
	}
	if n := lignes(t, db, `SELECT (SELECT count(*) FROM passkeys) || '/' || (SELECT count(*) FROM enveloppes)`); n[0] != "0/0" {
		t.Error("passkeys ou enveloppes d'un compte supprimé restantes :", n)
	}
}

func TestSessionsEtBannisContraintes(t *testing.T) {
	db, _ := ouvrir(t)
	if err := insCompte(db, h1, "", ""); err != nil {
		t.Fatal(err)
	}
	ins := func(v ...string) error {
		_, err := db.Exec(`INSERT INTO sessions(t_v,sid,h,etiquette,cree_mois,expire_jour,persistante,par_recup) VALUES(` +
			strings.Join(v, ",") + `)`)
		return err
	}
	ok := []string{"randomblob(32)", "randomblob(16)", "x'" + h1 + "'", "randomblob(64)", itoa(mois), itoa(jour), "1", "0"}
	if err := ins(ok...); err != nil {
		t.Fatal("session valide refusée :", err)
	}
	for i, bad := range []string{"randomblob(31)", "randomblob(17)", "x'" + strings.Repeat("00", 16) + "'", "randomblob(63)",
		itoa(mois + 86400), itoa(jour + 1), "2", "2"} {
		v := append([]string(nil), ok...)
		v[i] = bad
		if err := ins(v...); err == nil {
			t.Errorf("session : colonne %d = %s acceptée", i, bad)
		}
	}
	// Session sans étiquette : permise.
	v := append([]string(nil), ok...)
	v[3] = "NULL"
	if err := ins(v...); err != nil {
		t.Error("étiquette NULL refusée :", err)
	}
	insB := func(v ...string) error {
		_, err := db.Exec(`INSERT INTO bannis(id,h,debut_jour,jusqu_jour,actif,motif,salons_fermes) VALUES(` +
			strings.Join(v, ",") + `)`)
		return err
	}
	okB := []string{"randomblob(8)", "x'" + h1 + "'", itoa(jour), itoa(jour + 86400*365), "1", "10", "0"}
	for i, bad := range []string{"randomblob(9)", "x'" + strings.Repeat("ab", 16) + "'", itoa(jour + 1), itoa(jour + 7200), "2", "0", "-1"} {
		v := append([]string(nil), okB...)
		v[i] = bad
		if err := insB(v...); err == nil {
			t.Errorf("bannis : colonne %d = %s acceptée", i, bad)
		}
	}
	v = append([]string(nil), okB...)
	v[5] = "11"
	if err := insB(v...); err == nil {
		t.Error("motif 11 accepté")
	}
	if err := insB(okB...); err != nil {
		t.Fatal("bannissement valide refusé :", err)
	}
	// Compte supprimé : ses sessions et son bannissement avec lui (conception §7.4).
	if _, err := db.Exec(`DELETE FROM comptes WHERE h=x'` + h1 + `'`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sessions", "bannis"} {
		if n := lignes(t, db, `SELECT count(*) FROM `+table); n[0] != "0" {
			t.Errorf("%s d'un compte supprimé restantes : %v", table, n)
		}
	}
}

// Base d'une version plus récente : refusée sans rien toucher ; fichiers en 0600 ; réouverture au
// même schéma : comptes gardés.
func TestBaseVersionEtDroits(t *testing.T) {
	db, p := ouvrir(t)
	if err := insCompte(db, h1, "", ""); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{p, p + "-wal"} {
		st, err := os.Stat(f)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("%s : droits %o", filepath.Base(f), st.Mode().Perm())
		}
	}
	if _, err := db.Exec(`PRAGMA user_version=6`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if db2, err := OuvrirBase(p); !errors.Is(err, ErrBasePlusRecente) {
		if db2 != nil {
			db2.Close()
		}
		t.Fatal("base plus récente acceptée :", err)
	}
	raw, _ := sql.Open("sqlite", "file:"+p)
	raw.Exec(`PRAGMA user_version=3`)
	raw.Close()
	os.Chmod(p, 0o644)
	db3, err := OuvrirBase(p)
	if err != nil {
		t.Fatal(err)
	}
	defer db3.Close()
	if n := lignes(t, db3, `SELECT count(*) FROM comptes`); n[0] != "1" {
		t.Fatal("compte perdu à la réouverture", n)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Errorf("droits non resserrés : %o", st.Mode().Perm())
	}
}

// schema2 : comptes.db du compte par e-mail (version 2), refaite à la main.
const schema2 = `CREATE TABLE comptes(h BLOB PRIMARY KEY, e_canon BLOB NOT NULL, e_envoi BLOB NOT NULL,
  v_mdp BLOB NOT NULL, env_mdp BLOB NOT NULL, cle_profil BLOB NOT NULL, p_empreinte BLOB NOT NULL,
  pseudo_jour INTEGER NOT NULL, blob_profil BLOB NOT NULL, gen_profil INTEGER NOT NULL, blob_prive BLOB NOT NULL,
  gen_prive INTEGER NOT NULL, totp BLOB, totp_retrait_jour INTEGER, recup_jour INTEGER, cree_jour INTEGER NOT NULL,
  compte_des INTEGER NOT NULL, vu_mois INTEGER NOT NULL) WITHOUT ROWID;
CREATE UNIQUE INDEX comptes_e_canon ON comptes(e_canon);
CREATE TABLE sessions(t_v BLOB PRIMARY KEY, sid BLOB NOT NULL, h BLOB NOT NULL REFERENCES comptes(h) ON DELETE CASCADE,
  etiquette BLOB, cree_mois INTEGER NOT NULL, expire_jour INTEGER NOT NULL, persistante INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE bannis(id BLOB PRIMARY KEY, e_canon BLOB NOT NULL, debut_jour INTEGER NOT NULL, jusqu_jour INTEGER NOT NULL,
  actif INTEGER NOT NULL, motif INTEGER NOT NULL, salons_fermes INTEGER NOT NULL) WITHOUT ROWID;
CREATE UNIQUE INDEX bannis_e_canon ON bannis(e_canon);
PRAGMA user_version=2`

func base2(t *testing.T, avecCompte bool) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "comptes.db")
	raw, err := sql.Open("sqlite", "file:"+p)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.Exec(schema2); err != nil {
		t.Fatal(err)
	}
	// Un bannissement sans compte (adresse bannie) : la base reste « sans compte ».
	if _, err := raw.Exec(`INSERT INTO bannis VALUES(randomblob(8), randomblob(32), 0, 86400, 1, 1, 0)`); err != nil {
		t.Fatal(err)
	}
	if avecCompte {
		if _, err := raw.Exec(`INSERT INTO comptes VALUES(randomblob(16), randomblob(32), randomblob(32), randomblob(32),
			randomblob(60), randomblob(60), randomblob(32), 0, x'00', 1, x'00', 1, NULL, NULL, NULL, 0, 0, 0)`); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

// Conception du compte par passkey §15 : une base de schéma 2 sans compte est recréée au schéma 3.
func TestSchema2VideRecree(t *testing.T) {
	p := base2(t, false)
	db, err := OuvrirBase(p)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if v := lignes(t, db, `PRAGMA user_version`); v[0] != "5" {
		t.Fatal(v)
	}
	if c := lignes(t, db, `SELECT name FROM pragma_table_info('comptes') WHERE name='e_canon'`); len(c) != 0 {
		t.Fatal("colonne e_canon gardée")
	}
	if n := lignes(t, db, `SELECT count(*) FROM bannis`); n[0] != "0" {
		t.Fatal("bannissement par adresse gardé", n)
	}
	if err := insCompte(db, h1, "", ""); err != nil {
		t.Fatal(err)
	}
}

// Une base de schéma 2 qui contient un compte n'est jamais effacée : refus, base intacte.
func TestSchema2NonVideRefuse(t *testing.T) {
	p := base2(t, true)
	if db, err := OuvrirBase(p); !errors.Is(err, ErrBaseEmail) {
		if db != nil {
			db.Close()
		}
		t.Fatal("base de schéma 2 avec un compte acceptée :", err)
	}
	raw, _ := sql.Open("sqlite", "file:"+p)
	defer raw.Close()
	if n := lignes(t, raw, `SELECT count(*) FROM comptes`); n[0] != "1" {
		t.Fatal("compte touché", n)
	}
	if v := lignes(t, raw, `PRAGMA user_version`); v[0] != "2" {
		t.Fatal("version touchée", v)
	}
	if strings.Contains(ErrBaseEmail.Error(), p) {
		t.Fatal("chemin dans le message")
	}
}

// Migration 3 → 4 : colonne sign_count ajoutée en place, 0 pour les passkeys déjà
// enregistrées (gardées, comme leurs comptes) ; rejouée sans erreur.
func TestMigrationCompteur(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, "lea")
	if _, err := b.db.Exec(`ALTER TABLE passkeys DROP COLUMN sign_count`); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(`PRAGMA user_version=3`); err != nil {
		t.Fatal(err)
	}
	b.db.Close()
	db, err := OuvrirBase(b.chemin)
	if err != nil {
		t.Fatal("migration 3 → 4 :", err)
	}
	defer db.Close()
	if v := lignes(t, db, `PRAGMA user_version`); v[0] != "5" {
		t.Fatal(v)
	}
	var n int64
	if err := db.QueryRow(`SELECT sign_count FROM passkeys WHERE h=?`, h[:]).Scan(&n); err != nil || n != 0 {
		t.Fatal("passkey après migration :", n, err)
	}
	if _, err := db.Exec(`UPDATE passkeys SET sign_count=-1`); err == nil {
		t.Fatal("compteur négatif accepté")
	}
}

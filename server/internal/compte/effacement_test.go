package compte

import (
	"bytes"
	"errors"
	"os"
	"testing"
	"time"
)

// Suppression du compte et effacements (conception du compte §8.5, §12.4, §21.12 ; conception du
// compte par passkey §3.6 : plus d'attente, bannissement effacé avec le compte).

// Suppression : lignes du compte, de ses passkeys, de ses sessions et de son bannissement,
// coffres, v_r, Env_r, enveloppes, clés publiques et pseudo effacés (fichier et WAL, après
// fermeture) ; salons du compte fermés par le crochet ; pseudo libre aussitôt.
func TestSuppressionEfface(t *testing.T) {
	b := nouveauBanc(t)
	var fermes [][16]byte
	b.s.fermerSalons = func(h [16]byte) (int, error) {
		fermes = append(fermes, h)
		if len(fermes) > 1 {
			return 0, nil // seconde passe (lot 6), après l'effacement : plus rien
		}
		return 2, nil
	}
	_, jLeo, _ := b.inscrire(t, "leo")
	h, j, _ := b.inscrire(t, "lea")
	b.connecter(h)
	if _, err := b.db.Exec(`INSERT INTO bannis VALUES(?,?,?,?,1,4,0)`, alea8(), h[:], jourDe(b.clk.Now()),
		jourDe(b.clk.Now())+30*jourS); err != nil {
		t.Fatal(err)
	}
	var vr, envr, pe, bp, bv, cred, pub, env []byte
	b.db.QueryRow(`SELECT v_r, env_r, p_empreinte, blob_profil, blob_prive FROM comptes WHERE h=?`, h[:]).Scan(
		&vr, &envr, &pe, &bp, &bv)
	b.db.QueryRow(`SELECT cred_id, cle_pub, env FROM passkeys WHERE h=?`, h[:]).Scan(&cred, &pub, &env)
	b.clk.Add(5 * time.Minute)
	if _, err := b.s.Supprimer(b.session(t, j)); !errors.Is(err, ErrRecent) {
		t.Fatal("non récente :", err)
	}
	b.s.rendreRecente(b.session(t, j))
	n, err := b.s.Supprimer(b.session(t, j))
	if err != nil || n != 2 || len(fermes) != 2 || fermes[0] != h || fermes[1] != h {
		t.Fatal(n, err, fermes)
	}
	for _, table := range []string{"comptes", "sessions", "passkeys", "bannis"} {
		var k int
		b.db.QueryRow(`SELECT count(*) FROM `+table+` WHERE h=?`, h[:]).Scan(&k)
		if k != 0 {
			t.Errorf("%s : %d lignes gardées", table, k)
		}
	}
	if _, err := b.s.Session(j); !errors.Is(err, ErrSession) {
		t.Fatal(err)
	}
	// Pseudo libre aussitôt.
	if libre, err := b.s.PseudoVerifier(b.session(t, jLeo), []byte("lea")); err != nil || !libre {
		t.Fatal("pseudo encore pris :", err)
	}
	b.db.Close()
	f := b.fichiers(t)
	for nom, v := range map[string][]byte{"h": h[:], "v_r": vr, "env_r": envr, "p_empreinte": pe, "cred_id": cred,
		"cle_pub": pub, "env": env, "blob_profil": bp[45:1045], "blob_prive": bv[45:1045]} {
		if bytes.Contains(f, v) {
			t.Errorf("%s encore dans les fichiers", nom)
		}
	}
	if st, err := os.Stat(b.chemin + "-wal"); err == nil && st.Size() != 0 {
		t.Errorf("WAL de %d octets", st.Size())
	}
}

// Sans crochet de salons : aucune fermeture, 0 ; un échec du crochet arrête la suppression (le
// compte reste, on peut réessayer).
func TestSuppressionCrochetSalons(t *testing.T) {
	b := nouveauBanc(t)
	_, j, _ := b.inscrire(t, "lea")
	b.s.fermerSalons = func([16]byte) (int, error) { return 0, errors.New("salons") }
	if _, err := b.s.Supprimer(b.session(t, j)); err == nil || b.nComptes(t) != 1 {
		t.Fatal("suppression malgré l'échec du crochet :", err)
	}
	b.s.fermerSalons = nil
	if n, err := b.s.Supprimer(b.session(t, j)); err != nil || n != 0 || b.nComptes(t) != 0 {
		t.Fatal(n, err)
	}
}

// Comptes sans connexion depuis 13 mois (vu_mois au mois : effacés au début du 14e mois, jamais
// avant 13 mois pleins), avec leurs passkeys ; sessions échues effacées.
func TestInactifs13Mois(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, "lea") // vu en novembre 2026
	h2, _, _ := b.inscrire(t, "leo")
	b.clk.Add(time.Date(2027, 12, 31, 23, 0, 0, 0, time.UTC).Sub(b.clk.Now()))
	// leo se connecte en décembre 2027 (vu_mois mis à jour par l'usage de la session).
	o, _ := b.connecter(h2)
	b.session(t, o.Jeton)
	if n, err := b.s.Effacer(b.clk.Now()); err != nil || n != 0 || b.nComptes(t) != 2 {
		t.Fatal("décembre 2027 :", n, err)
	}
	b.clk.Add(time.Hour)
	n, err := b.s.Effacer(b.clk.Now())
	if err != nil || n != 1 {
		t.Fatal("janvier 2028 :", n, err)
	}
	var x int
	if b.db.QueryRow(`SELECT 1 FROM comptes WHERE h=?`, h[:]).Scan(&x) == nil ||
		b.db.QueryRow(`SELECT 1 FROM passkeys WHERE h=?`, h[:]).Scan(&x) == nil {
		t.Fatal("inactif gardé")
	}
	if b.db.QueryRow(`SELECT 1 FROM comptes WHERE h=?`, h2[:]).Scan(&x) != nil {
		t.Fatal("actif effacé")
	}
	// Sessions échues (celles de 2026) effacées ; reste la session simple de décembre 2027.
	if ns := b.nSessions(t); ns != 1 {
		t.Fatal(ns, "sessions échues gardées")
	}
}

// Bannissements échus (échéance passée, suspendus compris) effacés ; les autres gardés.
func TestBannisEchus(t *testing.T) {
	b := nouveauBanc(t)
	aujourd := jourDe(b.clk.Now())
	for i, v := range []struct {
		jusqu int64
		actif int
	}{{aujourd, 1}, {aujourd - jourS, 0}, {aujourd + jourS, 1}, {aujourd + jourS, 0}} {
		h := b.compte(t, i)
		if _, err := b.db.Exec(`INSERT INTO bannis VALUES(?,?,?,?,?,10,0)`, []byte{byte(i), 1, 2, 3, 4, 5, 6, 7}, h[:],
			aujourd-30*jourS, v.jusqu, v.actif); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.s.Effacer(b.clk.Now()); err != nil {
		t.Fatal(err)
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM bannis WHERE jusqu_jour > ?`, aujourd).Scan(&n)
	var tous int
	b.db.QueryRow(`SELECT count(*) FROM bannis`).Scan(&tous)
	if n != 2 || tous != 2 {
		t.Fatal(n, tous)
	}
}

func alea8() []byte { k := alea32(); return k[:8] }

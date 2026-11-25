package paiement

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// contientDansBase : une valeur d'une table de paiements.db contient x.
func contientDansBase(t *testing.T, b *banc, x []byte) bool {
	t.Helper()
	tables, err := b.db.Query(`SELECT name FROM sqlite_master WHERE type='table'`)
	if err != nil {
		t.Fatal(err)
	}
	var noms []string
	for tables.Next() {
		var n string
		tables.Scan(&n)
		noms = append(noms, n)
	}
	tables.Close()
	for _, n := range noms {
		rows, err := b.db.Query(`SELECT * FROM ` + n)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			v := make([]any, len(cols))
			p := make([]any, len(cols))
			for i := range v {
				p[i] = &v[i]
			}
			rows.Scan(p...)
			for _, c := range v {
				if bb, ok := c.([]byte); ok && bytes.Contains(bb, x) {
					rows.Close()
					return true
				}
			}
		}
		rows.Close()
	}
	return false
}

// TestOffrirDurees : chaque durée crée une ligne Pro marquée offert, du jour à jour + durée,
// réserve pleine ; seule l'empreinte Q est gardée, jamais P (ni dans une valeur, ni dans les
// fichiers de la base) ; le pass rendu est valable pour l'état.
func TestOffrirDurees(t *testing.T) {
	for nom, jours := range map[string]int{"mois": 30, "an": 365, "sans_fin": 3650} {
		t.Run(nom, func(t *testing.T) {
			b := nouveauBanc(t)
			j, ok := DureeOffertDe(nom)
			if !ok || j != jours {
				t.Fatal(nom, j, ok)
			}
			p, a, err := b.s.Offrir(j)
			if err != nil {
				t.Fatal(err)
			}
			if p == (Pass{}) {
				t.Fatal("pass nul")
			}
			q := p.Empreinte()
			auj := jourDe(b.now)
			var offre, offert, rev, jetons int
			var debut, fin, recharge int64
			if err := b.db.QueryRow(`SELECT offre, offert, revoque, jetons, debut_jour, fin_jour, recharge_jour FROM passes WHERE q=?`, q[:]).
				Scan(&offre, &offert, &rev, &jetons, &debut, &fin, &recharge); err != nil {
				t.Fatal(err)
			}
			if offre != int(Pro) || offert != 1 || rev != 0 || jetons != JetonsOffert || debut != auj ||
				fin != auj+int64(jours)*jourS || recharge != auj+periodeJetons {
				t.Fatal(offre, offert, rev, jetons, debut, fin, recharge)
			}
			if a.ID != hex.EncodeToString(q[:]) || a.Court != a.ID[:6] || a.Cree != "2026-11-19" ||
				a.Fin != time.Unix(fin, 0).UTC().Format("2006-01-02") || a.Etat != "actif" || a.Jetons != JetonsOffert {
				t.Fatalf("%+v", a)
			}
			if contientDansBase(t, b, p[:]) {
				t.Fatal("P gardé dans paiements.db")
			}
			e := b.etat(t, p)
			if e.Etat != "payee" || e.Offre != Pro || e.Fin != fin || e.Renouvelle {
				t.Fatalf("%+v", e)
			}
			// Aucune commande : rien à résilier, aucun prestataire en jeu.
			var n int
			b.db.QueryRow(`SELECT count(*) FROM commandes`).Scan(&n)
			if n != 0 {
				t.Fatal("commande créée", n)
			}
		})
	}
}

// TestOffrirJamaisPSurDisque : les octets de P n'apparaissent dans aucun fichier de la base
// (base, -wal, -shm), même avant tout point de contrôle.
func TestOffrirJamaisPSurDisque(t *testing.T) {
	dir := t.TempDir()
	db, err := OuvrirBase(filepath.Join(dir, "paiements.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s, err := NewService(Config{DB: db, Now: time.Now, Origine: "https://shhgone.test", Regime: OSS,
		Prestataires: []Prestataire{&faux{moyen: Carte}}})
	if err != nil {
		t.Fatal(err)
	}
	var passes []Pass
	for i := 0; i < 5; i++ {
		p, _, err := s.Offrir(JoursOffertAn)
		if err != nil {
			t.Fatal(err)
		}
		passes = append(passes, p)
	}
	fichiers, _ := filepath.Glob(filepath.Join(dir, "paiements.db*"))
	if len(fichiers) == 0 {
		t.Fatal("aucun fichier")
	}
	vus := 0
	for _, f := range fichiers {
		c, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range passes {
			if bytes.Contains(c, p[:]) || bytes.Contains(c, []byte(base64.RawURLEncoding.EncodeToString(p[:]))) {
				t.Fatalf("P écrit dans %s", filepath.Base(f))
			}
			if q := p.Empreinte(); bytes.Contains(c, q[:]) {
				vus++
			}
		}
	}
	if vus < len(passes) {
		t.Fatal("Q absent des fichiers : le test ne lit pas la bonne base", vus)
	}
}

func TestOffrirDureeInvalide(t *testing.T) {
	b := nouveauBanc(t)
	for _, j := range []int{0, 1, 29, 31, 366, 3651, -30} {
		if _, _, err := b.s.Offrir(j); !errors.Is(err, ErrDureeOffert) {
			t.Error(j, err)
		}
	}
	for _, s := range []string{"", "Mois", "illimite", "10ans", "3650"} {
		if _, ok := DureeOffertDe(s); ok {
			t.Error(s)
		}
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM passes`).Scan(&n)
	if n != 0 {
		t.Fatal(n)
	}
}

// TestOffertReserve1000 : 1000 jetons par période de 30 jours (Pro payé : 100), recharge
// normale, sans report.
func TestOffertReserve1000(t *testing.T) {
	b := nouveauBanc(t)
	p, _, _ := b.s.Offrir(JoursOffertAn)
	n, o, err := b.s.Prendre(p, 5000)
	if err != nil || n != JetonsOffert || o != Pro || JetonsOffert != 1000 {
		t.Fatal(n, o, err)
	}
	if n, _, _ := b.s.Prendre(p, 1); n != 0 {
		t.Fatal("réserve vide attendue", n)
	}
	b.now = b.now.Add(30 * 24 * time.Hour)
	if n, _, _ := b.s.Prendre(p, 5000); n != JetonsOffert {
		t.Fatal("recharge", n)
	}
	// Un pass Pro payé garde 100.
	c := b.commander(t, passN(7), Formule{Pro, JoursMois, true, Carte})
	if err := b.webhook(t, confirme(c, "pi_7", 2000)); err != nil {
		t.Fatal(err)
	}
	if n, _, _ := b.s.Prendre(passN(7), 5000); n != 100 {
		t.Fatal("Pro payé", n)
	}
}

// TestOffertEmissionsDuJour : un accès offert reçoit jusqu'à EmisParJourOffert (100) jetons par
// jour, signés par la même clé Pro du jour qu'un pass payé (rien ne les distingue à la dépense) ;
// un pass Pro payé reste à 20.
func TestOffertEmissionsDuJour(t *testing.T) {
	b, j := bancJetons(t)
	p, _, _ := b.s.Offrir(JoursOffertMois)
	spki := clePour(t, j, Pro, 0)
	var finir func([]byte) []byte
	for lot := 0; lot < EmisParJourOffert/5; lot++ {
		reqs := make([][]byte, 5)
		var fins []func([]byte) []byte
		for i := range reqs {
			var f func([]byte) []byte
			reqs[i], f = client(t, spki, "shhgone.test")
			fins = append(fins, f)
		}
		sigs, o, err := j.Emettre(b.s, p, reqs)
		if err != nil || o != Pro || len(sigs) != 5 {
			t.Fatal(lot, o, err)
		}
		if lot == 0 {
			finir = fins[0]
			tok := finir(sigs[0])
			if o, err := j.Depenser(tok); err != nil || o != Pro {
				t.Fatal("jeton d'accès offert refusé :", o, err)
			}
		}
	}
	req, _ := client(t, spki, "shhgone.test")
	if _, _, err := j.Emettre(b.s, p, [][]byte{req}); !errors.Is(err, ErrPasDeJetons) {
		t.Fatal("101e jeton du jour émis :", err)
	}
	b.now = b.now.Add(24 * time.Hour)
	spki = clePour(t, j, Pro, 0)
	req, _ = client(t, spki, "shhgone.test")
	if _, _, err := j.Emettre(b.s, p, [][]byte{req}); err != nil {
		t.Fatal("lendemain :", err)
	}
	if EmisParJour(Pro) != 20 || emisParJour(Pro, false) != 20 || emisParJour(Pro, true) != 100 {
		t.Fatal("bornes")
	}
}

// TestRevoquerOffert : plus aucun jeton émis tout de suite ; l'état dit révoqué ; un pass payé,
// un identifiant mal formé ou déjà révoqué ne sont pas touchés.
func TestRevoquerOffert(t *testing.T) {
	b, j := bancJetons(t)
	p, a, _ := b.s.Offrir(JoursOffertSansFin)
	c := b.commander(t, passN(3), Formule{Pro, JoursMois, true, Carte})
	if err := b.webhook(t, confirme(c, "pi_3", 2000)); err != nil {
		t.Fatal(err)
	}
	qPaye := passN(3).Empreinte()
	for _, id := range []string{"", "zz", a.ID[:6], strings.ToUpper(a.ID), a.ID + "00", hex.EncodeToString(qPaye[:])} {
		if ok, err := b.s.RevoquerOffert(id); ok || err != nil {
			t.Fatal("révoqué :", id, err)
		}
	}
	if e := b.etat(t, passN(3)); e.Etat != "payee" {
		t.Fatal("pass payé touché", e)
	}
	if ok, err := b.s.RevoquerOffert(a.ID); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if ok, _ := b.s.RevoquerOffert(a.ID); ok {
		t.Fatal("révoqué deux fois")
	}
	req, _ := client(t, clePour(t, j, Pro, 0), "shhgone.test")
	if _, _, err := j.Emettre(b.s, p, [][]byte{req}); !errors.Is(err, ErrPasDeJetons) {
		t.Fatal("jeton émis après révocation :", err)
	}
	if n, _, _ := b.s.Prendre(p, 1); n != 0 {
		t.Fatal("réserve après révocation", n)
	}
	if e := b.etat(t, p); e.Etat != "revoquee" {
		t.Fatalf("%+v", e)
	}
	l, err := b.s.AccesOfferts()
	if err != nil || len(l) != 1 || l[0].Etat != "revoque" || l[0].Jetons != 0 || l[0].Fin != "2026-11-19" {
		t.Fatalf("%+v %v", l, err)
	}
	// Purgé 31 jours après sa fin, comme tout pass.
	b.now = b.now.Add(31 * 24 * time.Hour)
	b.s.Purger()
	if l, _ := b.s.AccesOfferts(); len(l) != 0 {
		t.Fatal("pas purgé", l)
	}
}

// TestAccesOffertsListe : seulement les accès offerts, du plus récent ; jamais P (ni en octets,
// ni en base64url, ni en hexadécimal) ; échu après sa fin ; réserve rechargée affichée pleine.
func TestAccesOffertsListe(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(4), Formule{Pro, JoursMois, true, Carte})
	b.webhook(t, confirme(c, "pi_4", 2000))
	p1, a1, _ := b.s.Offrir(JoursOffertMois)
	b.now = b.now.Add(24 * time.Hour)
	p2, a2, _ := b.s.Offrir(JoursOffertAn)
	b.s.Prendre(p2, 10)
	l, err := b.s.AccesOfferts()
	if err != nil || len(l) != 2 || l[0].ID != a2.ID || l[1].ID != a1.ID || l[0].Jetons != JetonsOffert-10 || l[0].Cree != "2026-11-20" {
		t.Fatalf("%+v %v", l, err)
	}
	js, _ := json.Marshal(l)
	for _, p := range []Pass{p1, p2} {
		for _, f := range []string{string(p[:]), base64.RawURLEncoding.EncodeToString(p[:]), base64.StdEncoding.EncodeToString(p[:]), hex.EncodeToString(p[:])} {
			if strings.Contains(string(js), f) {
				t.Fatal("P dans la liste")
			}
		}
	}
	b.now = b.now.Add(30 * 24 * time.Hour)
	l, _ = b.s.AccesOfferts()
	if l[1].Etat != "echu" || l[1].Jetons != 0 || l[0].Etat != "actif" || l[0].Jetons != JetonsOffert {
		t.Fatalf("%+v", l)
	}
}

// TestAgregatsOfferts : les accès offerts sont comptés à part, jamais comme pass payés.
func TestAgregatsOfferts(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(5), Formule{Pro, JoursMois, true, Carte})
	b.webhook(t, confirme(c, "pi_5", 2000))
	b.s.Offrir(JoursOffertMois)
	_, a, _ := b.s.Offrir(JoursOffertAn)
	b.s.RevoquerOffert(a.ID)
	ag, err := b.s.Agregats()
	if err != nil || ag.PassPro != 1 || ag.PassPlus != 0 || ag.PassRevoques != 0 || ag.AccesOfferts != 1 {
		t.Fatalf("%+v %v", ag, err)
	}
}

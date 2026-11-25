package compte

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/nom"
)

// CanonPseudo donne, pour tout pseudo valable des vecteurs du moteur, exactement son p_canon
// (pseudo_canon du moteur Rust) ; les pseudos refusés par le moteur sont refusés ici aussi.
func TestCanonPseudoVecteurs(t *testing.T) {
	v := lireVecteursV3(t)
	n := 0
	for _, p := range v.Pseudo {
		entree := string(unhex(t, p.EntreeHex))
		got, ok := CanonPseudo(entree)
		if p.Error != "" {
			if ok {
				t.Errorf("%s : %q accepté (%q), refusé par le moteur (%s)", p.Label, entree, got, p.Error)
			}
			continue
		}
		n++
		if want := unhex(t, p.PCanonHex); !ok || !bytes.Equal(got, want) {
			t.Errorf("%s : CanonPseudo(%q) = %q, %v ; moteur %q", p.Label, entree, got, ok, want)
		}
	}
	if n < 10 {
		t.Fatal("trop peu de vecteurs valables :", n)
	}
	for entree, want := range map[string]string{" Emma ": "ernrna", "AIice": "allce", "B0B1": "bobl", "mIMI": "rnlrnl"} {
		if got, ok := CanonPseudo(entree); !ok || string(got) != want {
			t.Errorf("%q : %q %v", entree, got, ok)
		}
	}
	for _, faux := range []string{"", "a", strings.Repeat("a", 25), "lé", "a b", "a-b", "a_b", "a\x00", "\uff41\uff42"} {
		if _, ok := CanonPseudo(faux); ok {
			t.Errorf("%q accepté", faux)
		}
	}
}

// Recherche par pseudo : le pseudo tapé est canonisé (casse et sosies), le compte retrouvé par
// son empreinte ; inconnu ou réservé : nil sans erreur (réponse neutre) ; forme fausse :
// ErrRequete. La vue ne porte ni h, ni pseudo, ni empreinte.
func TestCompteParPseudo(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, "Emma")
	for _, tape := range []string{"Emma", "emma", " EMMA ", "Ernrna", "EMMA"} {
		v, err := b.s.CompteParPseudo(tape)
		if err != nil || v == nil || v.H != h || v.Court != courtDe(h) || len(v.Court) != 8 || v.Palier != "neuf" ||
			v.Limites != (LimitesVue{1, 4, 24}) || v.SurMesure != nil || v.Ban != nil || v.CreeLe != "2026-11-14" {
			t.Fatalf("%q : %+v %v", tape, v, err)
		}
	}
	for _, inconnu := range []string{"Emmb", "admin", "Admin"} {
		if v, err := b.s.CompteParPseudo(inconnu); v != nil || err != nil {
			t.Fatalf("%q : %+v %v", inconnu, v, err)
		}
	}
	for _, faux := range []string{"", "a", "é é", strings.Repeat("x", 25)} {
		if _, err := b.s.CompteParPseudo(faux); !errors.Is(err, ErrRequete) {
			t.Fatalf("%q : %v", faux, err)
		}
	}
	v, _ := b.s.CompteParPseudo("emma")
	js := vueJSON(t, v)
	for _, interdit := range []string{"emma", "erurna", `"h"`, "p_empreinte"} {
		if strings.Contains(strings.ToLower(js), interdit) {
			t.Fatalf("la vue contient %q : %s", interdit, js)
		}
	}
}

// Poser, changer, retirer : limites en vigueur pour Palier et Etat ; bornes ; nom exigé ;
// le jour de la première pose est gardé.
func TestSurMesure(t *testing.T) {
	b := nouveauBanc(t)
	h, j, _ := b.inscrire(t, "lea")
	m := SurMesure{Salons: 2, Places: 50, Jours: 30, Nom: " Léa, ma sœur "}
	v, err := b.s.PoserSurMesure(h, m)
	if err != nil || v.SurMesure == nil || v.SurMesure.Nom != "Léa, ma sœur" || v.SurMesure.Depuis != "2026-11-14" ||
		v.Limites != (LimitesVue{2, 50, 720}) || v.Palier != "neuf" {
		t.Fatalf("%+v %v", v, err)
	}
	if l, err := b.s.Palier(h); err != nil || l != (Limites{2, 50, 720}) {
		t.Fatal(l, err)
	}
	et, err := b.s.Etat(b.session(t, j))
	if err != nil || !et.SurMesure || et.Limites != (Limites{2, 50, 720}) || et.Palier != "neuf" {
		t.Fatalf("%+v %v", et, err)
	}
	b.clk.t = b.clk.t.Add(3 * 24 * time.Hour)
	if v, err = b.s.PoserSurMesure(h, SurMesure{Salons: 10, Places: 2, Jours: 1, Nom: "Léa"}); err != nil ||
		v.SurMesure.Depuis != "2026-11-14" || v.Limites != (LimitesVue{10, 2, 24}) {
		t.Fatalf("%+v %v", v, err)
	}
	for _, faux := range []SurMesure{
		{Salons: 0, Places: 2, Jours: 1, Nom: "x"}, {Salons: 11, Places: 2, Jours: 1, Nom: "x"},
		{Salons: 1, Places: 1, Jours: 1, Nom: "x"}, {Salons: 1, Places: 51, Jours: 1, Nom: "x"},
		{Salons: 1, Places: 2, Jours: 0, Nom: "x"}, {Salons: 1, Places: 2, Jours: 31, Nom: "x"},
		{Salons: 1, Places: 2, Jours: 1, Nom: ""}, {Salons: 1, Places: 2, Jours: 1, Nom: "   "},
	} {
		if _, err := b.s.PoserSurMesure(h, faux); !errors.Is(err, ErrRequete) {
			t.Errorf("%+v : %v", faux, err)
		}
	}
	for _, n := range []string{strings.Repeat("a", nom.Max+1), "a\nb", "a\u202eb", "a\x07"} {
		if _, err := b.s.PoserSurMesure(h, SurMesure{Salons: 1, Places: 2, Jours: 1, Nom: n}); !errors.Is(err, nom.ErrNom) {
			t.Errorf("%q : %v", n, err)
		}
	}
	if l, _ := b.s.Palier(h); l != (Limites{10, 2, 24}) {
		t.Fatal("limites changées par un refus :", l)
	}
	if _, err := b.s.PoserSurMesure([16]byte{9}, m); !errors.Is(err, ErrEtape) {
		t.Fatal("compte inconnu :", err)
	}
	if v, err = b.s.RetirerSurMesure(h); err != nil || v.SurMesure != nil || v.Limites != (LimitesVue{1, 4, 24}) {
		t.Fatalf("%+v %v", v, err)
	}
	if l, _ := b.s.Palier(h); l != limitesNeuf {
		t.Fatal(l)
	}
	o, _ := b.connecter(h)
	if et, _ := b.s.Etat(b.session(t, o.Jeton)); et.SurMesure || et.Limites != limitesNeuf {
		t.Fatalf("%+v", et)
	}
	if _, err := b.s.RetirerSurMesure(h); err != nil {
		t.Fatal("retirer deux fois :", err)
	}
	if _, err := b.s.RetirerSurMesure([16]byte{9}); !errors.Is(err, ErrEtape) {
		t.Fatal(err)
	}
}

// Bannissement prioritaire : un compte sur mesure banni ne crée ni ne règle aucun salon.
func TestSurMesureBanniPrioritaire(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, "lea")
	b.s.PoserSurMesure(h, SurMesure{Salons: 10, Places: 50, Jours: 30, Nom: "Léa"})
	b.ban(t, h, 30, 6)
	var bn ErrBanni
	if _, err := b.s.Palier(h); !errors.As(err, &bn) {
		t.Fatal("sur mesure plus fort que le bannissement :", err)
	}
	v, err := b.s.VueAdmin(h)
	if err != nil || v.Ban == nil || !v.Ban.Actif || v.SurMesure == nil {
		t.Fatalf("%+v %v", v, err)
	}
}

// Liste : tous les comptes sur mesure, par nom ; effacés avec le compte (ON DELETE CASCADE).
func TestListeSurMesureEtEffacement(t *testing.T) {
	b := nouveauBanc(t)
	h1, _, _ := b.inscrire(t, "lea")
	h2, _, _ := b.inscrire(t, "leo")
	b.inscrire(t, "max")
	b.s.PoserSurMesure(h1, SurMesure{Salons: 3, Places: 20, Jours: 7, Nom: "zoé"})
	b.s.PoserSurMesure(h2, SurMesure{Salons: 1, Places: 50, Jours: 30, Nom: "Albert"})
	l, err := b.s.ListeSurMesure()
	if err != nil || len(l) != 2 || l[0].H != h2 || l[1].H != h1 || l[1].Limites != (LimitesVue{3, 20, 168}) {
		t.Fatalf("%+v %v", l, err)
	}
	o, _ := b.connecter(h1)
	if _, err := b.s.Supprimer(b.session(t, o.Jeton)); err != nil {
		t.Fatal(err)
	}
	if n := lignes(t, b.db, `SELECT count(*) FROM sur_mesure`); n[0] != "1" {
		t.Fatal("sur mesure gardé après la suppression du compte :", n)
	}
	if l, _ := b.s.ListeSurMesure(); len(l) != 1 || l[0].H != h2 {
		t.Fatalf("%+v", l)
	}
	for _, v := range [][]any{
		{h2[:], 1, 2, 1, []byte{}},                      // nom vide
		{h2[:], 1, 2, 1, "texte"},                       // TEXT
		{h2[:], 1, 2, 1, make([]byte, nom.OctetsMax+1)}, // trop long
		{h2[:], 1, 51, 1, []byte("x")},                  // places
		{h2[:], 11, 2, 1, []byte("x")},                  // salons
		{h2[:], 1, 2, 31, []byte("x")},                  // jours
		{make([]byte, 16), 1, 2, 1, []byte("x")},        // compte inconnu
	} {
		if _, err := b.db.Exec(`INSERT OR REPLACE INTO sur_mesure(h, salons, places, jours, nom, depuis_jour) VALUES(?,?,?,?,?,0)`, v...); err == nil {
			t.Errorf("%v accepté", v)
		}
	}
}

// Migration 4 → 5 : la table sur_mesure apparaît, vide ; comptes gardés ; même schéma qu'une
// base neuve ; rouverte sans rien refaire.
func TestMigrationSurMesure(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, "lea")
	if _, err := b.db.Exec(`DROP TABLE sur_mesure`); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(`PRAGMA user_version=4`); err != nil {
		t.Fatal(err)
	}
	b.db.Close()
	db, err := OuvrirBase(b.chemin)
	if err != nil {
		t.Fatal("migration 4 → 5 :", err)
	}
	if v := lignes(t, db, `PRAGMA user_version`); v[0] != "5" {
		t.Fatal(v)
	}
	if n := lignes(t, db, `SELECT count(*) FROM comptes`); n[0] != "1" {
		t.Fatal("compte perdu", n)
	}
	sch := func(d *sql.DB) string {
		return strings.Join(lignes(t, d, `SELECT sql FROM sqlite_master WHERE name='sur_mesure'`), "")
	}
	neuve, err := OuvrirBase(b.chemin + ".neuve")
	if err != nil {
		t.Fatal(err)
	}
	defer neuve.Close()
	defer os.Remove(b.chemin + ".neuve")
	if a, n := sch(db), sch(neuve); a != n || a == "" {
		t.Fatalf("migrée %q, neuve %q", a, n)
	}
	if _, err := db.Exec(`INSERT INTO sur_mesure VALUES(?,1,2,1,?,0)`, h[:], []byte("x")); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db2, err := OuvrirBase(b.chemin)
	if err != nil {
		t.Fatal(err)
	}
	db2.Close()
}

func vueJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

package compte

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"slices"
	"strings"
	"testing"
)

// Conception §21.5 : liste des pseudos réservés, sous leurs formes canoniques (squelette
// UTS #39 : « m » devient « rn »), exactement celles de constants.reserves de compte-v3.json.
func TestPseudoReserve(t *testing.T) {
	v := lireVecteursV3(t)
	var want []string
	for _, r := range v.Constants.Reserves {
		want = append(want, string(unhex(t, r.PCanonHex)))
	}
	if len(want) != 18 {
		t.Fatalf("%d réservés dans les vecteurs", len(want))
	}
	got := slices.Clone(reserves)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("reserves.txt = %q\nattendu       %q", got, want)
	}
	for _, w := range want {
		if _, err := clesTest(1).EmpreintePseudo([]byte(w)); !errors.Is(err, ErrPseudoReserve) {
			t.Errorf("%q : %v", w, err)
		}
	}
}

// Les p_canon des vecteurs pseudo sont acceptés (ou refusés comme réservés), et l'empreinte
// vaut HMAC-SHA-256(K_pseudo, « pseudo » ‖ 0 ‖ p_canon) ; même entrée, même empreinte.
func TestPseudoVecteurs(t *testing.T) {
	v := lireVecteursV3(t)
	c := clesTest(3)
	n, plusLong := 0, 0
	for _, p := range v.Pseudo {
		if p.Error != "" {
			continue
		}
		n++
		pc := unhex(t, p.PCanonHex)
		plusLong = max(plusLong, len(pc))
		e, err := c.EmpreintePseudo(pc)
		if p.Reserve {
			if !errors.Is(err, ErrPseudoReserve) {
				t.Errorf("%s : réservé accepté (%v)", p.Label, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s : %v", p.Label, err)
			continue
		}
		m := hmac.New(sha256.New, c.Pseudo[:])
		m.Write(append([]byte("pseudo\x00"), pc...))
		if !bytes.Equal(e[:], m.Sum(nil)) {
			t.Errorf("%s : empreinte", p.Label)
		}
		if e2, _ := c.EmpreintePseudo(pc); e2 != e {
			t.Errorf("%s : empreinte instable", p.Label)
		}
		if e3, _ := clesTest(4).EmpreintePseudo(pc); e3 == e {
			t.Errorf("%s : autre clé, même empreinte", p.Label)
		}
	}
	if n < 20 {
		t.Fatalf("%d cas valides seulement", n)
	}
	// Depuis le 20 novembre (A-Z, a-z, 0-9), un p_canon valide fait au plus 48 octets (24
	// caractères, « m » devenant « rn ») ; la borne du serveur (PseudoCanonMax) reste plus large.
	if plusLong < 2 || plusLong > PseudoCanonMax {
		t.Fatalf("p_canon le plus long des vecteurs : %d octets (borne %d)", plusLong, PseudoCanonMax)
	}
}

func TestEmpreintePseudoRefus(t *testing.T) {
	c := clesTest(5)
	for nom, pc := range map[string][]byte{
		"vide":           {},
		"nil":            nil,
		"513 octets":     []byte(strings.Repeat("a", PseudoCanonMax+1)),
		"UTF-8 invalide": {'a', 0xff, 'b'},
		"UTF-8 tronqué":  []byte("l\xc3"),
	} {
		if _, err := c.EmpreintePseudo(pc); !errors.Is(err, ErrPseudoCanon) {
			t.Errorf("%s : %v", nom, err)
		}
	}
	// Forme canonique (22 novembre) : 2 à 48 octets, a-z sans i ni m, 2-9.
	for _, ok := range []string{"ab", strings.Repeat("rn", 24), "lea", "adrnlnx", "z29"} {
		if _, err := c.EmpreintePseudo([]byte(ok)); err != nil {
			t.Errorf("%q refusé : %v", ok, err)
		}
	}
	for _, ko := range []string{"a", strings.Repeat("a", 49), "Lea", "LEA", "lia", "1ea", "0scar", "emma", "le a", "lé", "le-a", "le_a", "ｌｅａ", strings.Repeat("a", PseudoCanonMax)} {
		if _, err := c.EmpreintePseudo([]byte(ko)); !errors.Is(err, ErrPseudoCanon) {
			t.Errorf("%q : %v", ko, err)
		}
	}
	if PseudoCanonMax != 512 {
		t.Fatal("borne", PseudoCanonMax)
	}
}

// Demande du propriétaire (14 novembre) : rôles, marques, autorités et insultes refusés, sur la
// forme canonique du moteur (formes tirées de pseudo_canon : « m » → « rn », « 1 » et « i » → « l ») ;
// rôles et autorités en mot entier, marques et insultes aussi en sous-chaîne. Les mots courts
// ou ambigus (« nazi » dans « Nazim », « rapist » dans « therapist ») restent en mot entier.
func TestPseudoInterdits(t *testing.T) {
	c := clesTest(1)
	for _, p := range []string{
		"staff", "tearn", "root", "fondateur", "offlclal", "noreply", "postrnaster", "abuse", "securlty",
		"pollce", "gendarrnerle", "pharos", "gouvfr", "gouv",
		"shhgone", "leshhgoneofflclel", "shhdropsupport",
		"connard", "grosconnard", "salope", "enculé", "nlquetarnère", "fuck", "motherfucker", "bltchx",
		"nazl", "raplst", "pute", "kkk", "l488",
	} {
		if _, err := c.EmpreintePseudo([]byte(p)); !errors.Is(err, ErrPseudoReserve) {
			t.Errorf("%q accepté (%v)", p, err)
		}
	}
	for _, p := range []string{
		"lea", "constance", "dlspute", "badrnlnton", "technlque", "nazlrn", "scunthorpe", "theraplst",
		"cornputer", "grape", "rooted", "staffan", "pollces", "connaltre", "retardatalre", "shhg", "drop",
	} {
		if _, err := c.EmpreintePseudo([]byte(p)); err != nil {
			t.Errorf("%q refusé (%v)", p, err)
		}
	}
}

// interdits.txt : chaque ligne est « exact <forme> » ou « contient <forme> », forme canonique
// (minuscules, sans espace ni ponctuation ASCII, « i » déjà replié en « l ») ; aucune forme en double ; aucune forme
// « exact » n'est déjà dans reserves.txt (liste commune au moteur, à ne pas dédoubler ; une
// marque de reserves.txt peut être reprise en « contient »).
func TestListeInterdits(t *testing.T) {
	if len(interditsExacts) < 25 || len(interditsContient) < 20 {
		t.Fatal(len(interditsExacts), len(interditsContient))
	}
	vu := map[string]bool{}
	for i, f := range append(slices.Clone(interditsExacts), interditsContient...) {
		if vu[f] || (i < len(interditsExacts) && slices.Contains(reserves, f)) || f == "" || strings.ToLower(f) != f || strings.ContainsAny(f, " .-_'i") {
			t.Errorf("forme %q", f)
		}
		vu[f] = true
	}
	if _, err := lireInterdits("exact a\nautre b\n"); err == nil {
		t.Fatal("ligne invalide acceptée")
	}
}

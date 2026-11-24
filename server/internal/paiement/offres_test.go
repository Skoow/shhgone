package paiement

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
)

// TestOffresCommeLeSite : prix du serveur = PAID de web/src/limits.ts (euros entiers TTC).
func TestOffresCommeLeSite(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "web", "src", "limits.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range []Offre{Plus, Pro} {
		re := regexp.MustCompile(`(?m)^\s*` + o.String() + `: \{[^}]*month: (\d+), year: (\d+) \}`)
		m := re.FindSubmatch(src)
		if m == nil {
			t.Fatalf("%s introuvable dans PAID (limits.ts)", o)
		}
		mois, _ := strconv.ParseInt(string(m[1]), 10, 64)
		an, _ := strconv.ParseInt(string(m[2]), 10, 64)
		if Prix(o, JoursMois) != mois*100 || Prix(o, JoursAn) != an*100 {
			t.Errorf("%s : serveur %d/%d centimes, site %d/%d €", o, Prix(o, JoursMois), Prix(o, JoursAn), mois, an)
		}
	}
	if Prix(Plus, 31) != 0 || Prix(0, JoursMois) != 0 || Prix(3, JoursAn) != 0 {
		t.Error("prix d'une période ou d'une offre inconnue")
	}
}

func TestFormulesPermises(t *testing.T) {
	cas := []struct {
		f  Formule
		ok bool
	}{
		{Formule{Plus, JoursMois, true, Carte}, true},
		{Formule{Plus, JoursMois, false, Carte}, false}, // mensuel : abonnement seulement (D41-34)
		{Formule{Pro, JoursAn, false, Carte}, true},
		{Formule{Pro, JoursAn, true, PayPal}, true},
		{Formule{Pro, JoursMois, false, PayPal}, false},
		{Formule{Plus, JoursMois, false, Crypto}, true}, // DP-1
		{Formule{Plus, JoursAn, true, Crypto}, false},   // aucun prélèvement en crypto
		{Formule{Plus, 31, true, Carte}, false},
		{Formule{0, JoursAn, false, Carte}, false},
		{Formule{Plus, JoursAn, false, 4}, false},
	}
	for _, c := range cas {
		if c.f.Valide() != c.ok {
			t.Errorf("%+v : Valide = %v", c.f, !c.ok)
		}
	}
	if d := (Formule{Pro, JoursAn, false, Carte}).Description(); d != "Shhgone Pro, 365 jours" {
		t.Error(d)
	}
}

// TestDroitsAppels : Plus et Pro comprennent l'audio et la vidéo (décision du propriétaire,
// 24 novembre), devenus un vrai droit le même jour (conception des appels §5.1) : plus rien
// n'est « bientôt » (liste vide, jamais nil, pour que l'API rende [] et non null).
func TestDroitsAppels(t *testing.T) {
	for _, o := range []Offre{Plus, Pro} {
		if !o.A("appel_video") || !o.A("appel_audio") {
			t.Error(o, "droits d'appel")
		}
	}
	if Offre(0).A("appel_audio") || Offre(3).A("appel_audio") || Plus.A("partage_pro") || Pro.A("inconnu") {
		t.Error("droit hors de l'offre")
	}
	if Bientot == nil || len(Bientot) != 0 {
		t.Errorf("bientôt : %#v", Bientot)
	}
	if Plus.Detail().JetonsPeriod != 30 || Pro.Detail().JetonsPeriod != 100 {
		t.Error("réserves de jetons (spec §38.8.1)")
	}
}

func TestVentiler(t *testing.T) {
	cas := []struct {
		r      Regime
		pays   string
		ttc    int64
		ht, tv int64
	}{
		{OSS, "FR", 700, 583, 117},      // 7 / 1,2 = 5,8333
		{OSS, "DE", 700, 588, 112},      // 7 / 1,19 = 5,882
		{OSS, "HU", 20000, 15748, 4252}, // 200 / 1,27 = 157,48
		{OSS, "FI", 7000, 5578, 1422},   // 70 / 1,255 = 55,777
		{OSS, "LU", 2000, 1709, 291},    // 20 / 1,17 = 17,094
		{France, "DE", 700, 583, 117},
		{Franchise, "DE", 700, 700, 0},
	}
	for _, c := range cas {
		v, err := Ventiler(c.r, c.pays, c.ttc)
		if err != nil || v.HT != c.ht || v.TVA != c.tv || v.HT+v.TVA != c.ttc {
			t.Errorf("%v %s %d : %+v %v", c.r, c.pays, c.ttc, v, err)
		}
	}
	for _, p := range []string{"GB", "CH", "fr", "", "EL", "XX"} {
		if _, err := Ventiler(OSS, p, 700); err != ErrPays {
			t.Errorf("%q accepté", p)
		}
	}
	if _, err := Ventiler(0, "FR", 700); err == nil {
		t.Error("régime inconnu accepté")
	}
	// Taux publiés pour la note de vente du site : ceux de Ventiler, pour les 27 pays.
	for _, r := range []Regime{Franchise, France, OSS} {
		ta := TauxAppliques(r)
		if len(ta) != 27 {
			t.Fatalf("%v : %d pays", r, len(ta))
		}
		for _, p := range Pays() {
			v, _ := Ventiler(r, p, 700)
			if ta[p] != v.Taux {
				t.Errorf("%v %s : %d, %d attendu", r, p, ta[p], v.Taux)
			}
		}
	}
	if TauxAppliques(Franchise)["DE"] != 0 || TauxAppliques(France)["DE"] != 2000 || TauxAppliques(OSS)["DE"] != 1900 {
		t.Error("taux appliqués")
	}
	if Franchise.String() != "franchise" || France.String() != "france" || OSS.String() != "oss" || Regime(0).String() != "" {
		t.Error("noms des régimes")
	}
	// Chaque pays, chaque prix : HT + TVA = TTC, TVA ≥ 0, et l'arrondi est le plus proche.
	for _, p := range Pays() {
		for _, ttc := range []int64{700, 2000, 7000, 20000} {
			v, err := Ventiler(OSS, p, ttc)
			if err != nil || v.HT+v.TVA != ttc || v.TVA < 0 {
				t.Fatal(p, ttc, v, err)
			}
			exact := float64(ttc) * 10000 / float64(10000+v.Taux)
			if d := float64(v.HT) - exact; d > 0.5 || d < -0.5 {
				t.Errorf("%s %d : HT %d, exact %f", p, ttc, v.HT, exact)
			}
		}
	}
	if len(Pays()) != 27 {
		t.Error("27 États membres attendus", len(Pays()))
	}
	for i := 1; i < len(tauxUE); i++ {
		if tauxUE[i-1].pays >= tauxUE[i].pays {
			t.Error("table non triée", tauxUE[i].pays)
		}
	}
}

func TestRegimeDe(t *testing.T) {
	for s, r := range map[string]Regime{"franchise": Franchise, "france": France, "oss": OSS} {
		if g, ok := RegimeDe(s); !ok || g != r {
			t.Error(s)
		}
	}
	if _, ok := RegimeDe("OSS"); ok {
		t.Error("casse")
	}
}

// TestEmpreinteVecteurs : Q sur engine/vectors/paiement.json (calculé par un autre outil).
func TestEmpreinteVecteurs(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "engine", "vectors", "paiement.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Pass []struct {
			P string `json:"p_hex"`
			Q string `json:"q_hex"`
		} `json:"pass"`
	}
	if err := json.Unmarshal(b, &v); err != nil || len(v.Pass) < 4 {
		t.Fatal(err, len(v.Pass))
	}
	for _, c := range v.Pass {
		var p Pass
		raw, _ := hex.DecodeString(c.P)
		copy(p[:], raw)
		q := p.Empreinte()
		if hex.EncodeToString(q[:]) != c.Q {
			t.Errorf("P %s : Q %x, attendu %s", c.P, q, c.Q)
		}
		// Aller-retour par l'en-tête.
		p2, err := PassDe(b64.EncodeToString(p[:]))
		if err != nil || p2 != p {
			t.Error("PassDe", err)
		}
	}
}

func TestPassDe(t *testing.T) {
	ok := b64.EncodeToString(make([]byte, 32))
	for _, s := range []string{"", ok[:42], ok + "A", ok[:42] + "=", ok[:42] + "+", ok[:42] + "B" /* bits de fin non nuls */} {
		if _, err := PassDe(s); err != ErrPass {
			t.Errorf("%q accepté", s)
		}
	}
}

func TestCommandeHex(t *testing.T) {
	c, err := nouvelleCommande()
	if err != nil {
		t.Fatal(err)
	}
	s := c.String()
	if len(s) != 32 {
		t.Fatal(s)
	}
	if c2, ok := CommandeDe(s); !ok || c2 != c {
		t.Error("aller-retour")
	}
	for _, s := range []string{"", s[:31], s + "0", "0123456789ABCDEF0123456789abcdef", "0123456789abcdef0123456789abcdeg"} {
		if _, ok := CommandeDe(s); ok {
			t.Errorf("%q accepté", s)
		}
	}
}

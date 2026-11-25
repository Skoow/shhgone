package paiement

import "errors"

// Régime de TVA choisi par l'exploitant (SHH_TVA, conception §9.1) : aucune valeur par défaut.
type Regime uint8

const (
	// Franchise en base (art. 293 B du CGI) : aucune TVA facturée.
	Franchise Regime = 1
	// France : TVA française pour tous les pays de l'UE (sous le seuil de 10 000 €).
	France Regime = 2
	// OSS : TVA du pays du client (guichet unique).
	OSS Regime = 3
)

// RegimeDe : « franchise », « france » ou « oss ».
func RegimeDe(s string) (Regime, bool) {
	switch s {
	case "franchise":
		return Franchise, true
	case "france":
		return France, true
	case "oss":
		return OSS, true
	}
	return 0, false
}

// String : « franchise », « france » ou « oss » ; "" pour un régime inconnu.
func (r Regime) String() string {
	switch r {
	case Franchise:
		return "franchise"
	case France:
		return "france"
	case OSS:
		return "oss"
	}
	return ""
}

// TauxAppliques : taux appliqué sous ce régime pour chaque pays de l'UE (points de base), le même
// que Ventiler. Public (aucun secret) : la note de vente du site le recopie (conception §9.3).
func TauxAppliques(r Regime) map[string]int64 {
	out := make(map[string]int64, len(tauxUE))
	for _, t := range tauxUE {
		if v, err := Ventiler(r, t.pays, 10000); err == nil {
			out[t.pays] = v.Taux
		}
	}
	return out
}

// tauxUE : taux normaux de TVA des 27 États membres, en points de base (2000 = 20 %), au
// 19 novembre 2026, à vérifier par le comptable dans la base TEDB de la Commission avant la
// première vente et à chaque changement (conception §9.1). Liste triée par code ISO 3166-1.
var tauxUE = [...]struct {
	pays string
	bp   int64
}{
	{"AT", 2000}, {"BE", 2100}, {"BG", 2000}, {"CY", 1900}, {"CZ", 2100}, {"DE", 1900}, {"DK", 2500},
	{"EE", 2400}, {"ES", 2100}, {"FI", 2550}, {"FR", 2000}, {"GR", 2400}, {"HR", 2500}, {"HU", 2700},
	{"IE", 2300}, {"IT", 2200}, {"LT", 2100}, {"LU", 1700}, {"LV", 2100}, {"MT", 1800}, {"NL", 2100},
	{"PL", 2300}, {"PT", 2300}, {"RO", 2100}, {"SE", 2500}, {"SI", 2200}, {"SK", 2300},
}

// ErrPays : pays hors des 27 États membres (ventes limitées à l'UE, DP-9).
var ErrPays = errors.New("pays non pris en charge")

// Pays : codes des 27 États membres, triés (pour le site et les tests).
func Pays() []string {
	out := make([]string, len(tauxUE))
	for i, t := range tauxUE {
		out[i] = t.pays
	}
	return out
}

func tauxDe(p string) (int64, bool) {
	for _, t := range tauxUE {
		if t.pays == p {
			return t.bp, true
		}
	}
	return 0, false
}

// Ventilation d'un prix TTC (centimes) : HT + TVA = TTC.
type Ventilation struct {
	HT, TVA int64
	Taux    int64 // points de base
}

// Ventiler : HT = arrondi au plus proche (moitié vers le haut) de TTC × 10 000 / (10 000 + taux),
// TVA = TTC − HT (conception §9.1). Prix identique dans tous les pays ; le HT varie.
func Ventiler(r Regime, pays string, ttc int64) (Ventilation, error) {
	bp, ok := tauxDe(pays)
	if !ok {
		return Ventilation{}, ErrPays
	}
	switch r {
	case Franchise:
		return Ventilation{HT: ttc}, nil
	case France:
		bp, _ = tauxDe("FR")
	case OSS:
	default:
		return Ventilation{}, errors.New("régime de TVA inconnu")
	}
	d := 10000 + bp
	ht := (ttc*10000*2 + d) / (2 * d)
	return Ventilation{HT: ht, TVA: ttc - ht, Taux: bp}, nil
}

package paiement

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

// Accès offerts (conception du paiement, « Accès offerts ») : un pass Pro créé par l'exploitant
// depuis le tableau de bord, sans commande ni prestataire, pour quelques personnes qu'il
// connaît. Le serveur ne relie toujours aucun pass à un compte, un partage ou un salon : il tire
// P, garde son empreinte Q marquée « offert », et rend P une seule fois à la page
// d'administration, qui en fait le lien à transmettre (/offres/offert#P). P n'est jamais écrit
// sur disque ni journalisé ; aucun nom ni aucune note n'est gardé (l'exploitant note lui-même
// qui a quel identifiant court).

// Durées d'un accès offert, en jours : un mois, un an, ou « sans fin » (borne fixe de dix ans :
// le schéma n'a pas de fin infinie, et un pass gardé sans limite ne serait jamais purgé).
const (
	JoursOffertMois    = JoursMois
	JoursOffertAn      = JoursAn
	JoursOffertSansFin = 3650
)

// DureeOffertDe : « mois », « an » ou « sans_fin » → jours.
func DureeOffertDe(s string) (int, bool) {
	switch s {
	case "mois":
		return JoursOffertMois, true
	case "an":
		return JoursOffertAn, true
	case "sans_fin":
		return JoursOffertSansFin, true
	}
	return 0, false
}

// ErrDureeOffert : durée hors de la liste.
var ErrDureeOffert = errors.New("durée d'accès offert invalide")

// AccesOffert : une ligne de la liste du tableau de bord. ID : Q en hexadécimal (l'empreinte,
// jamais P : elle ne donne aucun droit et sert seulement à révoquer) ; Court : ses 6 premiers
// caractères, que l'exploitant note. Dates au jour (AAAA-MM-JJ, UTC) ; Fin exclue.
type AccesOffert struct {
	ID     string `json:"id"`
	Court  string `json:"court"`
	Cree   string `json:"cree"`
	Fin    string `json:"fin"`
	Jetons int    `json:"jetons"`
	Etat   string `json:"etat"` // actif, revoque, echu
}

func dateJour(j int64) string { return time.Unix(j, 0).UTC().Format("2006-01-02") }

// Offrir : tire un pass P, garde son empreinte comme un pass Pro offert de `jours` jours
// (JoursOffert…) à partir d'aujourd'hui, réserve pleine, et rend P. L'appelant le donne une
// seule fois puis l'efface (clear).
func (s *Service) Offrir(jours int) (Pass, AccesOffert, error) {
	var p Pass
	if jours != JoursOffertMois && jours != JoursOffertAn && jours != JoursOffertSansFin {
		return p, AccesOffert{}, ErrDureeOffert
	}
	if _, err := rand.Read(p[:]); err != nil {
		return Pass{}, AccesOffert{}, err
	}
	q := p.Empreinte()
	auj := jourDe(s.now())
	fin := auj + int64(jours)*jourS
	// Aucune collision possible en pratique (256 bits) ; une clé primaire déjà prise ferait
	// échouer l'insertion, jamais écraser un pass existant.
	if _, err := s.db.Exec(`INSERT INTO passes(q, offre, debut_jour, fin_jour, jetons, recharge_jour, revoque, offert)
		VALUES(?,?,?,?,?,?,0,1)`, q[:], Pro, auj, fin, JetonsOffert, auj+periodeJetons); err != nil {
		clear(p[:])
		return Pass{}, AccesOffert{}, err
	}
	id := hex.EncodeToString(q[:])
	return p, AccesOffert{ID: id, Court: id[:6], Cree: dateJour(auj), Fin: dateJour(fin), Jetons: JetonsOffert, Etat: "actif"}, nil
}

// AccesOfferts : accès offerts encore gardés (un accès échu ou révoqué est purgé 31 jours après
// sa fin, comme tout pass), du plus récent au plus ancien. Jetons : réserve de la période en
// cours (pleine si une recharge est due).
func (s *Service) AccesOfferts() ([]AccesOffert, error) {
	auj := jourDe(s.now())
	rows, err := s.db.Query(`SELECT q, debut_jour, fin_jour, jetons, recharge_jour, revoque FROM passes
		WHERE offert=1 ORDER BY debut_jour DESC, q`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AccesOffert{}
	for rows.Next() {
		var q []byte
		var debut, fin, recharge int64
		var jetons, rev int
		if err := rows.Scan(&q, &debut, &fin, &jetons, &recharge, &rev); err != nil {
			return nil, err
		}
		a := AccesOffert{ID: hex.EncodeToString(q), Cree: dateJour(debut), Fin: dateJour(fin), Jetons: jetons, Etat: "actif"}
		a.Court = a.ID[:6]
		switch {
		case rev == 1:
			a.Etat, a.Jetons = "revoque", 0
		case auj >= fin:
			a.Etat, a.Jetons = "echu", 0
		case recharge <= auj:
			a.Jetons = JetonsOffert
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RevoquerOffert : révoque l'accès offert d'empreinte id (64 caractères hexadécimaux) : plus
// aucun jeton émis dès maintenant ; ceux déjà émis meurent au plus tard le surlendemain
// (clés du jour, jetons.go). Comme une révocation de pass payé : réserve vidée, fin ramenée à
// aujourd'hui (la ligne est purgée 31 jours plus tard). false : aucun accès offert actif de cet
// identifiant (inconnu, pass payé, déjà révoqué).
func (s *Service) RevoquerOffert(id string) (bool, error) {
	q, err := hex.DecodeString(id)
	if err != nil || len(q) != 32 || hex.EncodeToString(q) != id {
		return false, nil
	}
	auj := jourDe(s.now())
	res, err := s.db.Exec(`UPDATE passes SET revoque=1, jetons=0, fin_jour=MIN(fin_jour, ?)
		WHERE q=? AND offert=1 AND revoque=0`, auj, q)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

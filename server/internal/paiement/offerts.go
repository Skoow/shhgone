package paiement

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/skoow/shhdrop/server/internal/nom"
)

// Accès offerts (conception du paiement, « Accès offerts ») : un pass Pro créé par l'exploitant
// depuis le tableau de bord, sans commande ni prestataire, pour quelques personnes qu'il
// connaît. Le serveur ne relie toujours aucun pass à un compte, un partage ou un salon : il tire
// P, garde son empreinte Q marquée « offert », et rend P une seule fois à la page
// d'administration, qui en fait le lien à transmettre (/offres/offert#P). P n'est jamais écrit
// sur disque ni journalisé. L'exploitant peut donner un nom à l'accès (décision du propriétaire,
// 25 novembre : « c'est moi qui décide, pour des personnes que je connais ») : gardé en clair
// dans noms_offerts, à côté de Q, effacé avec la ligne du pass ; il ne quitte que vers la page
// d'administration.

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
// jamais P : elle ne donne aucun droit et sert seulement à révoquer et à nommer) ; Court : ses
// 6 premiers caractères. Dates au jour (AAAA-MM-JJ, UTC) ; Fin exclue. Nom : celui que
// l'exploitant a donné ("" : aucun).
type AccesOffert struct {
	ID     string `json:"id"`
	Court  string `json:"court"`
	Nom    string `json:"nom"`
	Cree   string `json:"cree"`
	Fin    string `json:"fin"`
	Jetons int    `json:"jetons"`
	Etat   string `json:"etat"` // actif, revoque, echu
}

func dateJour(j int64) string { return time.Unix(j, 0).UTC().Format("2006-01-02") }

// Offrir : tire un pass P, garde son empreinte comme un pass Pro offert de `jours` jours
// (JoursOffert…) à partir d'aujourd'hui, réserve pleine, avec le nom n (nom.Propre ; "" :
// aucun), et rend P. L'appelant le donne une seule fois puis l'efface (clear). Nom invalide :
// nom.ErrNom, rien n'est créé.
func (s *Service) Offrir(jours int, n string) (Pass, AccesOffert, error) {
	var p Pass
	if jours != JoursOffertMois && jours != JoursOffertAn && jours != JoursOffertSansFin {
		return p, AccesOffert{}, ErrDureeOffert
	}
	n, err := nom.Propre(n)
	if err != nil {
		return p, AccesOffert{}, err
	}
	if _, err := rand.Read(p[:]); err != nil {
		return Pass{}, AccesOffert{}, err
	}
	q := p.Empreinte()
	auj := jourDe(s.now())
	fin := auj + int64(jours)*jourS
	// Aucune collision possible en pratique (256 bits) ; une clé primaire déjà prise ferait
	// échouer l'insertion, jamais écraser un pass existant. Pass et nom dans une transaction :
	// jamais l'un sans l'autre.
	err = func() error {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.Exec(`INSERT INTO passes(q, offre, debut_jour, fin_jour, jetons, recharge_jour, revoque, offert)
			VALUES(?,?,?,?,?,?,0,1)`, q[:], Pro, auj, fin, JetonsOffert, auj+periodeJetons); err != nil {
			return err
		}
		if n != "" {
			if _, err := tx.Exec(`INSERT INTO noms_offerts(q, nom) VALUES(?,?)`, q[:], []byte(n)); err != nil {
				return err
			}
		}
		return tx.Commit()
	}()
	if err != nil {
		clear(p[:])
		return Pass{}, AccesOffert{}, err
	}
	id := hex.EncodeToString(q[:])
	return p, AccesOffert{ID: id, Court: id[:6], Nom: n, Cree: dateJour(auj), Fin: dateJour(fin), Jetons: JetonsOffert, Etat: "actif"}, nil
}

// AccesOfferts : accès offerts encore gardés (un accès échu ou révoqué est purgé 31 jours après
// sa fin, comme tout pass, avec son nom), du plus récent au plus ancien. Jetons : réserve de la
// période en cours (pleine si une recharge est due).
func (s *Service) AccesOfferts() ([]AccesOffert, error) {
	auj := jourDe(s.now())
	rows, err := s.db.Query(`SELECT p.q, p.debut_jour, p.fin_jour, p.jetons, p.recharge_jour, p.revoque, n.nom
		FROM passes p LEFT JOIN noms_offerts n ON n.q = p.q WHERE p.offert=1 ORDER BY p.debut_jour DESC, p.q`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AccesOffert{}
	for rows.Next() {
		var q, n []byte
		var debut, fin, recharge int64
		var jetons, rev int
		if err := rows.Scan(&q, &debut, &fin, &jetons, &recharge, &rev, &n); err != nil {
			return nil, err
		}
		a := AccesOffert{ID: hex.EncodeToString(q), Nom: string(n), Cree: dateJour(debut), Fin: dateJour(fin), Jetons: jetons, Etat: "actif"}
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

// empreinteOffert : id (64 caractères hexadécimaux minuscules) → Q ; faux sinon.
func empreinteOffert(id string) ([]byte, bool) {
	q, err := hex.DecodeString(id)
	return q, err == nil && len(q) == 32 && hex.EncodeToString(q) == id
}

// NommerOffert : nom n (nom.Propre) donné à l'accès offert d'empreinte id, actif, échu ou
// révoqué tant que sa ligne est gardée ; "" efface le nom. false : aucun accès offert de cet
// identifiant (inconnu, purgé, pass payé : un pass payé n'a jamais de nom). Nom invalide :
// nom.ErrNom, rien n'est changé.
func (s *Service) NommerOffert(id, n string) (bool, error) {
	n, err := nom.Propre(n)
	if err != nil {
		return false, err
	}
	q, ok := empreinteOffert(id)
	if !ok {
		return false, nil
	}
	fait := false
	err = func() error {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		var un int
		switch err := tx.QueryRow(`SELECT 1 FROM passes WHERE q=? AND offert=1`, q).Scan(&un); {
		case errors.Is(err, sql.ErrNoRows):
			return nil
		case err != nil:
			return err
		}
		if n == "" {
			_, err = tx.Exec(`DELETE FROM noms_offerts WHERE q=?`, q)
		} else {
			_, err = tx.Exec(`INSERT INTO noms_offerts(q, nom) VALUES(?,?) ON CONFLICT(q) DO UPDATE SET nom=excluded.nom`, q, []byte(n))
		}
		if err != nil {
			return err
		}
		fait = true
		return tx.Commit()
	}()
	return fait && err == nil, err
}

// RevoquerOffert : révoque l'accès offert d'empreinte id (64 caractères hexadécimaux) : plus
// aucun jeton émis dès maintenant ; ceux déjà émis meurent au plus tard le surlendemain
// (clés du jour, jetons.go). Comme une révocation de pass payé : réserve vidée, fin ramenée à
// aujourd'hui (la ligne, et son nom, sont purgés 31 jours plus tard). false : aucun accès offert
// actif de cet identifiant (inconnu, pass payé, déjà révoqué).
func (s *Service) RevoquerOffert(id string) (bool, error) {
	q, ok := empreinteOffert(id)
	if !ok {
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

package compte

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/skoow/shhdrop/server/internal/nom"
)

// Comptes sur mesure (décision du propriétaire, 25 novembre : « permets-moi d'éditer les comptes
// et les pseudos ; tu peux les garder sur le serveur, c'est moi qui décide, pour des personnes
// que je connais ») : depuis le tableau de bord, l'exploitant retrouve un compte par son pseudo
// exact et lui donne des limites au-delà des paliers (§11), avec un nom ou une note gardés en
// clair dans comptes.db (table sur_mesure, effacée avec le compte). Le pseudo lui-même n'est
// toujours gardé que par son empreinte : il n'existe aucune liste des pseudos, on ne retrouve un
// compte qu'en tapant son pseudo exact.
//
// Un bannissement actif l'emporte toujours : Palier rend ErrBanni avant de lire le sur mesure.
// Retirer le sur mesure rend le palier normal (neuf ou confirmé) ; les salons déjà ouverts
// gardent leurs places et leur échéance, mais ne se règlent ni ne se renouvellent plus au-delà
// du palier normal (salon.Manager.Regler).

// Bornes des limites sur mesure (validées par le propriétaire le 25 novembre) : salons vivants à
// la fois, places par salon (créateur compris), jours au plus pour un salon. Les mêmes bornes
// côté salons : salon.SurMesurePlacesMax, salon.HeuresSurMesureMax (test commun dans api).
const (
	SurMesureSalonsMax = 10
	SurMesurePlacesMax = 50
	SurMesureJoursMax  = 30
)

// SurMesure : limites sur mesure d'un compte et nom donné par l'exploitant. Depuis : jour où il
// a été posé la première fois (AAAA-MM-JJ, UTC ; gardé par un changement de limites).
type SurMesure struct {
	Salons int    `json:"salons"`
	Places int    `json:"places"`
	Jours  int    `json:"jours"`
	Nom    string `json:"nom"`
	Depuis string `json:"depuis"`
}

// valide : bornes des limites (le nom est vérifié à part, nom.Propre).
func (m SurMesure) valide() bool {
	return m.Salons >= 1 && m.Salons <= SurMesureSalonsMax && m.Places >= 2 && m.Places <= SurMesurePlacesMax &&
		m.Jours >= 1 && m.Jours <= SurMesureJoursMax
}

func (m SurMesure) limites() Limites {
	return Limites{Salons: m.Salons, Places: m.Places, Heures: m.Jours * 24}
}

// LimitesVue : Limites en JSON (tableau de bord).
type LimitesVue struct {
	Salons int `json:"salons"`
	Places int `json:"places"`
	Heures int `json:"heures"`
}

// CompteAdmin : un compte tel que le tableau de bord le montre. H : jamais rendu (aucune
// étiquette JSON : la page ne le désigne que par une ref éphémère) ; Court : 8 caractères
// hexadécimaux d'une empreinte de h, pour reconnaître un compte d'une recherche à l'autre (ne
// permet pas de retrouver h). Palier : palier normal (neuf ou confirmé), Limites : limites en
// vigueur (sur mesure si posé), Ban : bannissement en cours (nil : aucun).
type CompteAdmin struct {
	H            [16]byte   `json:"-"`
	Court        string     `json:"court"`
	CreeLe       string     `json:"cree_le"`
	Palier       string     `json:"palier"`
	Limites      LimitesVue `json:"limites"`
	SalonsActifs int        `json:"salons_actifs"`
	Ban          *BanVue    `json:"ban"`
	SurMesure    *SurMesure `json:"sur_mesure"`
}

// courtDe : identifiant court montré au tableau de bord.
func courtDe(h [16]byte) string {
	e := sha256.Sum256(append([]byte("shhdrop/admin/compte\x00"), h[:]...))
	return hex.EncodeToString(e[:4])
}

// CanonPseudo : forme canonique (p_canon, pseudo_canon du moteur) d'un pseudo tel que la
// personne le voit, tapé par l'exploitant : espaces autour retirés, puis 2 à 24 caractères
// A-Z, a-z, 0-9 (pseudo_valide du moteur) ; faux sinon. Pour ces caractères, pseudo_canon se
// réduit à : minuscules ; squelette UTS #39 (« 0 » → « o », « 1 » → « l », « m » → « rn », les
// seules correspondances de confusables.txt entre lettres et chiffres ASCII minuscules) ; puis
// « i » → « l ». Prouvé sur les vecteurs du moteur (engine/vectors/compte-v3.json,
// TestCanonPseudoVecteurs).
func CanonPseudo(pseudo string) ([]byte, bool) {
	p := strings.TrimSpace(pseudo)
	if len(p) < pseudoCanonMin || len(p) > 24 {
		return nil, false
	}
	out := make([]byte, 0, 2*len(p))
	for _, c := range []byte(p) {
		switch {
		case c >= 'A' && c <= 'Z':
			c += 'a' - 'A'
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		default:
			return nil, false
		}
		switch c {
		case '0':
			out = append(out, 'o')
		case '1', 'i':
			out = append(out, 'l')
		case 'm':
			out = append(out, 'r', 'n')
		default:
			out = append(out, c)
		}
	}
	return out, FormeCanonique(out)
}

// lireSurMesure : limites sur mesure du compte h, ou nil.
func lireSurMesure(q interface {
	QueryRow(string, ...any) *sql.Row
}, h [16]byte) (*SurMesure, error) {
	var m SurMesure
	var n []byte
	var depuis int64
	err := q.QueryRow(`SELECT salons, places, jours, nom, depuis_jour FROM sur_mesure WHERE h=?`, h[:]).
		Scan(&m.Salons, &m.Places, &m.Jours, &n, &depuis)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.Nom, m.Depuis = string(n), dateJour(depuis)
	return &m, nil
}

// limitesEnVigueur : palier normal du compte (nom, limites, jour de confirmation), remplacées
// par le sur mesure s'il y en a un.
func (s *Service) limitesEnVigueur(h [16]byte, des int64, now time.Time) (string, Limites, string, *SurMesure, error) {
	p, lim, conf := palier(des, now)
	m, err := lireSurMesure(s.db, h)
	if err != nil {
		return "", Limites{}, "", nil, err
	}
	if m != nil {
		lim = m.limites()
	}
	return p, lim, conf, m, nil
}

// VueAdmin : le compte h vu du tableau de bord ; ErrEtape s'il n'existe pas (ou plus).
func (s *Service) VueAdmin(h [16]byte) (*CompteAdmin, error) {
	now := s.now()
	var cree, des int64
	err := s.db.QueryRow(`SELECT cree_jour, compte_des FROM comptes WHERE h=?`, h[:]).Scan(&cree, &des)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrEtape
	}
	if err != nil {
		return nil, err
	}
	p, lim, _, m, err := s.limitesEnVigueur(h, des, now)
	if err != nil {
		return nil, err
	}
	n, err := s.nSalonsActifs(h)
	if err != nil {
		return nil, err
	}
	ban, err := s.lireBanH(h, jourDe(now))
	if err != nil {
		return nil, err
	}
	return &CompteAdmin{H: h, Court: courtDe(h), CreeLe: dateJour(cree), Palier: p,
		Limites: LimitesVue{lim.Salons, lim.Places, lim.Heures}, SalonsActifs: n, Ban: ban, SurMesure: m}, nil
}

// CompteParPseudo : compte du pseudo tapé par l'exploitant (CanonPseudo puis p_empreinte).
// Forme fausse : ErrRequete ; pseudo réservé, interdit ou d'aucun compte : nil, sans erreur
// (la même réponse « introuvable »).
func (s *Service) CompteParPseudo(pseudo string) (*CompteAdmin, error) {
	pc, ok := CanonPseudo(pseudo)
	if !ok {
		return nil, ErrRequete
	}
	pe, err := s.empreintePseudo(pc)
	if err != nil {
		return nil, err
	}
	if pe == ([32]byte{}) {
		return nil, nil
	}
	var h octets16
	err = s.db.QueryRow(`SELECT h FROM comptes WHERE p_empreinte=?`, pe[:]).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v, err := s.VueAdmin([16]byte(h))
	if errors.Is(err, ErrEtape) {
		return nil, nil // effacé entre les deux lectures
	}
	return v, err
}

// PoserSurMesure : limites sur mesure et nom (nom.Propre, obligatoire) du compte h, posés ou
// changés ; le jour de la première pose est gardé. Bornes fausses ou nom vide : ErrRequete ;
// nom invalide : nom.ErrNom ; compte inconnu : ErrEtape. Rend la vue après le changement.
func (s *Service) PoserSurMesure(h [16]byte, m SurMesure) (*CompteAdmin, error) {
	n, err := nom.Propre(m.Nom)
	if err != nil {
		return nil, err
	}
	if !m.valide() || n == "" {
		return nil, ErrRequete
	}
	res, err := s.db.Exec(`INSERT INTO sur_mesure(h, salons, places, jours, nom, depuis_jour)
		SELECT h, ?, ?, ?, ?, ? FROM comptes WHERE h=?
		ON CONFLICT(h) DO UPDATE SET salons=excluded.salons, places=excluded.places, jours=excluded.jours, nom=excluded.nom`,
		m.Salons, m.Places, m.Jours, []byte(n), jourDe(s.now()), h[:])
	if err != nil {
		return nil, err
	}
	if k, _ := res.RowsAffected(); k != 1 {
		return nil, ErrEtape
	}
	return s.VueAdmin(h)
}

// RetirerSurMesure : retour au palier normal du compte h. Compte inconnu : ErrEtape ; compte
// sans sur mesure : rien à faire, la vue est rendue telle quelle.
func (s *Service) RetirerSurMesure(h [16]byte) (*CompteAdmin, error) {
	if _, err := s.db.Exec(`DELETE FROM sur_mesure WHERE h=?`, h[:]); err != nil {
		return nil, err
	}
	return s.VueAdmin(h)
}

// ListeSurMesure : tous les comptes sur mesure, par nom puis identifiant court.
func (s *Service) ListeSurMesure() ([]CompteAdmin, error) {
	rows, err := s.db.Query(`SELECT h FROM sur_mesure`)
	if err != nil {
		return nil, err
	}
	var hs [][16]byte
	for rows.Next() {
		var h octets16
		if err := rows.Scan(&h); err != nil {
			rows.Close()
			return nil, err
		}
		hs = append(hs, [16]byte(h))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []CompteAdmin{}
	for _, h := range hs {
		v, err := s.VueAdmin(h)
		if errors.Is(err, ErrEtape) {
			continue // compte effacé entre-temps (la ligne part avec lui)
		}
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	slices.SortFunc(out, func(a, b CompteAdmin) int {
		if c := strings.Compare(strings.ToLower(a.SurMesure.Nom), strings.ToLower(b.SurMesure.Nom)); c != 0 {
			return c
		}
		return strings.Compare(a.Court, b.Court)
	})
	return out, nil
}

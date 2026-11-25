package compte

import (
	"database/sql"
	"errors"
	"time"
)

// Paramètres du compte (conception du compte §8.6, §12.4, §21.6.2 ; conception du compte par
// passkey §3.6, §6.4) : état et export. Toujours par une session.

// Limites : ce qu'un palier permet (conception du compte §11) : salons vivants à la fois,
// places (max_members, créateur compris), heures au plus.
type Limites struct{ Salons, Places, Heures int }

var (
	limitesNeuf     = Limites{Salons: 1, Places: 4, Heures: 24}
	limitesConfirme = Limites{Salons: 3, Places: 10, Heures: 24}
)

// joursPalier : un compte est « confirmé » 7 jours pleins après compte_des (§11 ; palier neuf
// gardé à 7 jours, conception du compte par passkey Q5).
const joursPalier = 7

// palier : nom, limites et, pour un compte neuf, le jour où il sera confirmé.
func palier(compteDes int64, now time.Time) (string, Limites, string) {
	j := compteDes + joursPalier*jourS
	if jourDe(now) >= j {
		return "confirme", limitesConfirme, ""
	}
	return "neuf", limitesNeuf, dateJour(j)
}

// Etat : GET /api/compte. Une chaîne vide vaut « aucune » (null en JSON) ; BanniMotif 0 : aucun.
// Plus de TOTP, d'attente de récupération ni de retrait de TOTP. BanniID :
// l'identifiant B-… du bannissement, montré à la personne pour son recours (elle le donne à
// l'adresse de contact ; le fondateur agit par lui, conception du compte par passkey §7.4).
// SurMesure : l'exploitant a donné à ce compte des limites sur mesure (Limites ; Palier reste
// le palier normal, rendu dès qu'il les retire). Ni le nom ni la note de l'exploitant n'y sont.
type Etat struct {
	H                          [16]byte
	CreeLe, Palier, ConfirmeLe string
	Limites                    Limites
	SurMesure                  bool
	SalonsActifs               int
	Banni                      bool
	BanniID, BanniJusqu        string
	BanniMotif                 uint8
}

// ligneEtat : ce que l'état et l'export lisent du compte.
type ligneEtat struct {
	cree, des, vuMois      int64
	banniID                []byte
	banniJusqu, banniMotif int64
	banni                  bool
}

func (s *Service) lireEtat(h [16]byte, now time.Time) (ligneEtat, error) {
	var l ligneEtat
	err := s.db.QueryRow(`SELECT cree_jour, compte_des, vu_mois FROM comptes WHERE h=?`, h[:]).Scan(&l.cree, &l.des, &l.vuMois)
	if errors.Is(err, sql.ErrNoRows) {
		return l, ErrSession
	}
	if err != nil {
		return l, err
	}
	l.banniID, l.banniJusqu, l.banniMotif, l.banni, err = bannieTx(s.db, h, now)
	return l, err
}

func (s *Service) nSalonsActifs(h [16]byte) (int, error) {
	if s.salonsActifs == nil {
		return 0, nil
	}
	return s.salonsActifs(h)
}

// Etat : état du compte de la session.
func (s *Service) Etat(c Courante) (Etat, error) {
	now := s.now()
	l, err := s.lireEtat(c.H, now)
	if err != nil {
		return Etat{}, err
	}
	n, err := s.nSalonsActifs(c.H)
	if err != nil {
		return Etat{}, err
	}
	et := Etat{H: c.H, CreeLe: dateJour(l.cree), SalonsActifs: n, Banni: l.banni}
	var m *SurMesure
	if et.Palier, et.Limites, et.ConfirmeLe, m, err = s.limitesEnVigueur(c.H, l.des, now); err != nil {
		return Etat{}, err
	}
	et.SurMesure = m != nil
	if l.banni {
		et.BanniID, et.BanniJusqu, et.BanniMotif = idBan([8]byte(l.banniID)), dateJour(l.banniJusqu), uint8(l.banniMotif)
	}
	return et, nil
}

// SessionExport : un appareil, au mois, sans nom (le nom chiffré n'est lisible que par
// l'appareil, qui l'ajoute lui-même).
type SessionExport struct {
	Ajoutee     string
	Persistante bool
	ParRecup    bool
}

// PasskeyExport : une passkey dans l'export (conception §3.6) : mois d'ajout, liée ou
// synchronisable, avec ou sans enveloppe PRF, clé publique COSE (portabilité).
type PasskeyExport struct {
	Ajoutee string
	BE, PRF bool
	ClePub  []byte
}

// Export : données du serveur sur ce compte (§12.4) : jours, mois, appareils, passkeys, salons,
// bannissement. Aucune empreinte, enveloppe ni coffre : l'appareil y ajoute ce qu'il a
// déchiffré (profil, listes).
type Export struct {
	CreeLe, AncienneteDepuis, VuMois string
	BanniJusqu                       string
	BanniMotif                       uint8
	SalonsActifs                     int
	Sessions                         []SessionExport
	Passkeys                         []PasskeyExport
}

func (s *Service) Export(c Courante) (Export, error) {
	et, err := s.Etat(c)
	if err != nil {
		return Export{}, err
	}
	l, err := s.lireEtat(c.H, s.now())
	if err != nil {
		return Export{}, err
	}
	vs, err := s.Sessions(c)
	if err != nil {
		return Export{}, err
	}
	x := Export{CreeLe: et.CreeLe, AncienneteDepuis: dateJour(l.des), VuMois: time.Unix(l.vuMois, 0).UTC().Format("2006-01"),
		BanniJusqu: et.BanniJusqu, BanniMotif: et.BanniMotif, SalonsActifs: et.SalonsActifs,
		Sessions: []SessionExport{}, Passkeys: []PasskeyExport{}}
	for _, v := range vs {
		x.Sessions = append(x.Sessions, SessionExport{v.Ajoutee, v.Persistante, v.ParRecup})
	}
	rows, err := s.db.Query(`SELECT ajoutee_mois, be, EXISTS (SELECT 1 FROM enveloppes e WHERE e.cred_id = passkeys.cred_id),
		cle_pub FROM passkeys WHERE h=? ORDER BY ajoutee_mois, cred_id`, c.H[:])
	if err != nil {
		return Export{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var p PasskeyExport
		var m int64
		if err := rows.Scan(&m, &p.BE, &p.PRF, &p.ClePub); err != nil {
			return Export{}, err
		}
		p.Ajoutee = time.Unix(m, 0).UTC().Format("2006-01")
		x.Passkeys = append(x.Passkeys, p)
	}
	return x, rows.Err()
}

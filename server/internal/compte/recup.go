package compte

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/netip"
	"time"
)

// Récupération par la clé de récupération (conception du compte par passkey §3.4, §5.4, §6.4).
// L'appareil tire A_r = HKDF(R, « shhdrop/v3/compte/recup/acces ») de la clé tapée et l'envoie ;
// le serveur cherche v_r = SHA-256(A_r) par l'index unique (aucune comparaison en boucle, aucune
// clé du serveur) et rend Env_r, que seul R ouvre. A_r n'est ni gardé, ni journalisé, ni rendu.

// Ouverture : réponse d'une connexion (par passkey ou par la clé de récupération). Env :
// enveloppe PRF de la passkey utilisée (nil : passkey sans enveloppe) ; EnvR : enveloppe de la
// clé de récupération (rendue seulement par Recup). Rien qui ouvre un coffre à lui seul.
type Ouverture struct {
	Jeton      [32]byte
	H          [16]byte
	CredID     []byte
	Env        []byte
	EnvR       []byte
	BlobProfil []byte
	GenProfil  uint64
	BlobPrive  []byte
	GenPrive   uint64
}

// Recup : POST recup (10 essais par heure par connexion, 30 par /48, justes ou faux). Clé
// inconnue : ErrIdentifiants (même erreur qu'une passkey refusée). Juste : nouvelle session
// récente, marquée « ouverte par la clé de récupération » (R4) ; un compte banni se connecte
// (export et suppression, §13).
func (s *Service) Recup(ip netip.Addr, aR [32]byte, o OptionsSession) (Ouverture, error) {
	if !o.valide() {
		return Ouverture{}, ErrRequete
	}
	now := s.now()
	if !s.lim.AllowRecup(ip) {
		return Ouverture{}, ErrLimit{heureSuivante(now)}
	}
	vr := sha256.Sum256(aR[:])
	clear(aR[:])
	var ov Ouverture
	var vuMois int64
	err := s.db.QueryRow(`SELECT h, env_r, blob_profil, gen_profil, blob_prive, gen_prive, vu_mois FROM comptes WHERE v_r=?`,
		vr[:]).Scan((*octets16)(&ov.H), &ov.EnvR, &ov.BlobProfil, &ov.GenProfil, &ov.BlobPrive, &ov.GenPrive, &vuMois)
	if errors.Is(err, sql.ErrNoRows) {
		s.cpt.echecs.Add(1)
		return Ouverture{}, ErrIdentifiants
	}
	if err != nil {
		return Ouverture{}, err
	}
	if ov.Jeton, err = s.ouvrirSession(ov.H, vuMois, o, true, now); err != nil {
		return Ouverture{}, err
	}
	s.cpt.recuperations.Add(1)
	return ov, nil
}

// ouvrirSession : session créée et vu_mois mis à jour (une fois par mois), dans une transaction.
func (s *Service) ouvrirSession(h [16]byte, vuMois int64, o OptionsSession, parRecup bool, now time.Time) ([32]byte, error) {
	var tok [32]byte
	err := s.tx(func(tx *sql.Tx) error {
		if m := moisDe(now); vuMois != m {
			if _, err := tx.Exec(`UPDATE comptes SET vu_mois=? WHERE h=?`, m, h[:]); err != nil {
				return err
			}
		}
		var err error
		tok, err = s.creerSessionTx(tx, h, o, parRecup, now)
		return err
	})
	return tok, err
}

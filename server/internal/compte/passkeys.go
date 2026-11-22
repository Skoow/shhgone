package compte

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/netip"
	"time"
)

// Passkeys du compte, réauthentification, nouvelle clé de récupération (conception du compte par
// passkey §3.5, §6.4). Toujours par une session ; ajout, retrait et nouvelle clé par une session
// récente (connexion, récupération ou reauth de moins de 5 min).

// ErrPasskeysMax : 10 passkeys déjà (conception §6.3).
var ErrPasskeysMax = errors.New("passkeys_max")

// PasskeyVue : une ligne de GET passkeys. Le serveur ne sait pas quelle passkey a ouvert la
// session (rien ne le garde) : l'appareil le sait (cred_id rendu par connexion/fin).
type PasskeyVue struct {
	CredID    []byte
	Ajoutee   string // « 2026-11 »
	Etiquette []byte // 64 octets chiffrés par l'appareil, ou nil
	BE, PRF   bool
}

// passkeysDe : les passkeys du compte h (ordre d'ajout).
func (s *Service) passkeysDe(h [16]byte) ([]Passkey, []PasskeyVue, error) {
	rows, err := s.db.Query(`SELECT cred_id, cle_pub, alg, be, env, etiquette, ajoutee_mois FROM passkeys WHERE h=?
		ORDER BY ajoutee_mois, cred_id`, h[:])
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var ps []Passkey
	var vs []PasskeyVue
	for rows.Next() {
		var p Passkey
		var be int
		var m int64
		if err := rows.Scan(&p.CredID, &p.ClePub, &p.Alg, &be, &p.Env, &p.Etiquette, &m); err != nil {
			return nil, nil, err
		}
		p.BE = be == 1
		ps = append(ps, p)
		vs = append(vs, PasskeyVue{CredID: p.CredID, Ajoutee: time.Unix(m, 0).UTC().Format("2006-01"), Etiquette: p.Etiquette,
			BE: p.BE, PRF: p.Env != nil})
	}
	return ps, vs, rows.Err()
}

// Passkeys : GET passkeys.
func (s *Service) Passkeys(c Courante) ([]PasskeyVue, error) {
	_, vs, err := s.passkeysDe(c.H)
	if vs == nil {
		vs = []PasskeyVue{}
	}
	return vs, err
}

// ReauthDebut : reauth/debut : options d'une assertion limitée aux passkeys du compte (60 par
// minute par connexion, comme connexion/debut).
func (s *Service) ReauthDebut(ip netip.Addr, c Courante) ([32]byte, json.RawMessage, error) {
	if s.wa == nil {
		return [32]byte{}, nil, errSansCeremonies
	}
	now := s.now()
	if !s.lim.AllowConnexionDebut(ip) {
		return [32]byte{}, nil, ErrLimit{s.lim.MinuteRetry()}
	}
	ps, _, err := s.passkeysDe(c.H)
	if err != nil {
		return [32]byte{}, nil, err
	}
	if len(ps) == 0 {
		return [32]byte{}, nil, ErrSession
	}
	opts, sd, err := s.wa.debutAssertion(c.H[:], ps)
	if err != nil {
		return [32]byte{}, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	jeton, err := s.nouvelleEtapeLocked(&etape{sorte: etapeReauth, h: c.H, defi: sd}, now)
	return jeton, opts, err
}

// ReauthFin : reauth/fin : la passkey doit être du compte de la session ; juste, la session est
// récente 5 min. L'étape sert une fois ; échecs comptés comme ceux de la connexion.
func (s *Service) ReauthFin(ip netip.Addr, c Courante, jeton [32]byte, credential []byte) error {
	if s.wa == nil {
		return errSansCeremonies
	}
	now := s.now()
	if !s.lim.AllowEchecConnexion(ip) {
		return ErrLimit{heureSuivante(now)}
	}
	s.mu.Lock()
	e := s.et.trouverLocked(jeton, etapeReauth, now)
	if e != nil && e.h == c.H {
		s.et.retirerLocked(jeton)
	} else {
		e = nil
	}
	s.mu.Unlock()
	if e == nil {
		return ErrEtape
	}
	ps, _, err := s.passkeysDe(c.H)
	if err != nil {
		return err
	}
	if _, _, err := s.wa.finAssertion(e.defi, credential, nil, &c.H, ps); err != nil {
		if errors.Is(err, ErrIdentifiants) {
			s.lim.NoterEchecConnexion(ip)
			s.cpt.echecs.Add(1)
		}
		return err
	}
	s.rendreRecente(c)
	return nil
}

// PasskeysDebut : passkeys/debut (session récente ; 10 par heure par compte ; 10 passkeys au
// plus) : options de création, passkeys du compte exclues.
func (s *Service) PasskeysDebut(c Courante) ([32]byte, json.RawMessage, error) {
	if s.wa == nil {
		return [32]byte{}, nil, errSansCeremonies
	}
	if !c.Recente {
		return [32]byte{}, nil, ErrRecent
	}
	now := s.now()
	ps, _, err := s.passkeysDe(c.H)
	if err != nil {
		return [32]byte{}, nil, err
	}
	if len(ps) >= PasskeysMax {
		return [32]byte{}, nil, ErrPasskeysMax
	}
	if !s.lim.AllowAjoutPasskey(c.H) {
		return [32]byte{}, nil, ErrLimit{heureSuivante(now)}
	}
	opts, sd, err := s.wa.debutCreation(c.H, ps)
	if err != nil {
		return [32]byte{}, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	jeton, err := s.nouvelleEtapeLocked(&etape{sorte: etapeAjout, h: c.H, defi: sd}, now)
	return jeton, opts, err
}

// PasskeysFin : passkeys/fin (session récente) : la nouvelle passkey est vérifiée pour le compte
// et ajoutée, avec son enveloppe PRF (ou nil) et son libellé chiffré (ou nil). Une passkey déjà
// connue : ErrRequete ; dixième atteinte entre-temps : ErrPasskeysMax.
func (s *Service) PasskeysFin(c Courante, jeton [32]byte, credential, env, etiquette []byte) error {
	if s.wa == nil {
		return errSansCeremonies
	}
	if !c.Recente {
		return ErrRecent
	}
	if (env != nil && len(env) != EnveloppeLen) || (etiquette != nil && len(etiquette) != 64) {
		return ErrRequete
	}
	now := s.now()
	s.mu.Lock()
	e := s.et.trouverLocked(jeton, etapeAjout, now)
	if e != nil && e.h == c.H {
		s.et.retirerLocked(jeton)
	} else {
		e = nil
	}
	s.mu.Unlock()
	if e == nil {
		return ErrEtape
	}
	pk, err := s.wa.finCreation(c.H, e.defi, credential)
	if err != nil {
		return err
	}
	pk.Env, pk.Etiquette = bytes.Clone(env), bytes.Clone(etiquette)
	return s.tx(func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRow(`SELECT count(*) FROM passkeys WHERE h=?`, c.H[:]).Scan(&n); err != nil {
			return err
		}
		if n >= PasskeysMax {
			return ErrPasskeysMax
		}
		var x int
		switch err := tx.QueryRow(`SELECT 1 FROM passkeys WHERE cred_id=?`, pk.CredID).Scan(&x); {
		case err == nil:
			return ErrRequete
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		return insererPasskeyTx(tx, c.H, pk, now)
	})
}

// majPasskey : met à jour une colonne de la passkey cred_id du compte de la session ; passkey
// inconnue ou d'un autre compte : ErrEtape (même réponse).
func (s *Service) majPasskey(c Courante, col string, credID, v []byte) error {
	if len(credID) < 1 || len(credID) > CredIDMax {
		return ErrRequete
	}
	r, err := s.db.Exec(`UPDATE passkeys SET `+col+`=? WHERE cred_id=? AND h=?`, v, credID, c.H[:])
	if err != nil {
		return err
	}
	if n, _ := r.RowsAffected(); n == 0 {
		return ErrEtape
	}
	return nil
}

// PasskeysEnveloppe : passkeys/enveloppe (session) : enveloppe PRF de K_compte pour une passkey
// du compte (obtenue par un get après le create, ou plus tard sur un appareil qui l'offre, R10).
func (s *Service) PasskeysEnveloppe(c Courante, credID, env []byte) error {
	if len(env) != EnveloppeLen {
		return ErrRequete
	}
	return s.majPasskey(c, "env", credID, env)
}

// PasskeysNommer : passkeys/nommer (session) : libellé chiffré par l'appareil (64 octets).
func (s *Service) PasskeysNommer(c Courante, credID, etiquette []byte) error {
	if len(etiquette) != 64 {
		return ErrRequete
	}
	return s.majPasskey(c, "etiquette", credID, etiquette)
}

// PasskeysRetirer : passkeys/retirer (session récente) ; la dernière ne se retire pas
// (ErrDerniere : « Ajoutez d'abord une autre passkey »). WAL vidé ensuite (clé publique effacée).
func (s *Service) PasskeysRetirer(c Courante, credID []byte) error {
	if !c.Recente {
		return ErrRecent
	}
	if len(credID) < 1 || len(credID) > CredIDMax {
		return ErrRequete
	}
	err := s.tx(func(tx *sql.Tx) error {
		var n, x int
		if err := tx.QueryRow(`SELECT count(*) FROM passkeys WHERE h=?`, c.H[:]).Scan(&n); err != nil {
			return err
		}
		switch err := tx.QueryRow(`SELECT 1 FROM passkeys WHERE cred_id=? AND h=?`, credID, c.H[:]).Scan(&x); {
		case errors.Is(err, sql.ErrNoRows):
			return ErrEtape
		case err != nil:
			return err
		}
		if n <= 1 {
			return ErrDerniere
		}
		_, err := tx.Exec(`DELETE FROM passkeys WHERE cred_id=? AND h=?`, credID, c.H[:])
		return err
	})
	if err == nil {
		s.vider()
	}
	return err
}

// RecupRenouveler : recup/renouveler (session récente) : nouvelle clé de récupération (v_r, Env_r
// de la nouvelle R) ; l'ancienne ne sert plus. v_r déjà pris : ErrRequete.
func (s *Service) RecupRenouveler(c Courante, vr [32]byte, envR [60]byte) error {
	if !c.Recente {
		return ErrRecent
	}
	err := s.tx(func(tx *sql.Tx) error {
		var x int
		switch err := tx.QueryRow(`SELECT 1 FROM comptes WHERE v_r=?`, vr[:]).Scan(&x); {
		case err == nil:
			return ErrRequete
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		r, err := tx.Exec(`UPDATE comptes SET v_r=?, env_r=? WHERE h=?`, vr[:], envR[:], c.H[:])
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return ErrSession
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.vider()
	return nil
}

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
	rows, err := s.db.Query(`SELECT cred_id, cle_pub, alg, be, etiquette, ajoutee_mois, sign_count,
		EXISTS (SELECT 1 FROM enveloppes e WHERE e.cred_id = passkeys.cred_id) FROM passkeys WHERE h=?
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
		var prf bool
		if err := rows.Scan(&p.CredID, &p.ClePub, &p.Alg, &be, &p.Etiquette, &m, &p.SignCount, &prf); err != nil {
			return nil, nil, err
		}
		p.BE = be == 1
		ps = append(ps, p)
		vs = append(vs, PasskeyVue{CredID: p.CredID, Ajoutee: time.Unix(m, 0).UTC().Format("2006-01"), Etiquette: p.Etiquette,
			BE: p.BE, PRF: prf})
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
	jeton, err := s.nouvelleEtapeLocked(&etape{sorte: etapeReauth, h: c.H, defi: sd, bloc: s.blocIP(ip)}, now)
	return jeton, opts, err
}

// ReauthFin : reauth/fin : la passkey doit être du compte de la session ; juste, la session est
// récente 5 min et liée à cette passkey (passkeys/enveloppe) ; rend ses enveloppes PRF. L'étape
// sert une fois ; échecs comptés comme ceux de la connexion.
func (s *Service) ReauthFin(ip netip.Addr, c Courante, jeton [32]byte, credential []byte) ([][]byte, error) {
	if s.wa == nil {
		return nil, errSansCeremonies
	}
	now := s.now()
	if !s.lim.AllowEchecConnexion(ip) {
		return nil, ErrLimit{heureSuivante(now)}
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
		return nil, ErrEtape
	}
	ps, _, err := s.passkeysDe(c.H)
	if err != nil {
		return nil, err
	}
	_, cred, n, err := s.wa.verifierAssertion(e.defi, credential, nil, &c.H, ps)
	if err != nil {
		if errors.Is(err, ErrIdentifiants) {
			s.lim.NoterEchecConnexion(ip)
			s.cpt.echecs.Add(1)
		}
		return nil, err
	}
	if err := s.noterCompteur(cred, n); err != nil {
		return nil, err
	}
	s.rendreRecente(c, cred)
	return s.enveloppesDe(cred)
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
	jeton, err := s.nouvelleEtapeLocked(&etape{sorte: etapeAjout, h: c.H, defi: sd, bloc: blocCompte(c.H)}, now)
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

// ErrSansPasskey : la session n'est liée à aucune passkey (ouverte par la clé de récupération,
// ou serveur redémarré depuis) : reauth/debut et reauth/fin d'abord.
var ErrSansPasskey = errors.New("sans_passkey")

// ErrEnveloppesMax : la passkey a déjà ses 4 enveloppes.
var ErrEnveloppesMax = errors.New("enveloppes_max")

// PasskeysEnveloppe : passkeys/enveloppe (session) : une enveloppe PRF de plus pour la passkey
// qui a signé la dernière assertion de CETTE session (jamais un cred_id venu du corps), après
// une ouverture réussie par un autre moyen (sortie PRF différente, « enveloppes multiples »).
// La même enveloppe déjà là : rien à faire ; une cinquième : ErrEnveloppesMax. Aucune route
// n'en retire : elles partent avec la passkey (une session volée ne peut pas effacer le bon
// chemin d'ouverture).
func (s *Service) PasskeysEnveloppe(c Courante, env []byte) error {
	// Session récente exigée : sinon une session volée remplirait les 4 places d'enveloppes
	// inutiles, et aucune route ne les retire (connexion/fin et reauth/fin en donnent une).
	if !c.Recente {
		return ErrRecent
	}
	if len(env) != EnveloppeLen {
		return ErrRequete
	}
	cred := s.credDe(c)
	if cred == nil {
		return ErrSansPasskey
	}
	return s.tx(func(tx *sql.Tx) error {
		var x int
		switch err := tx.QueryRow(`SELECT 1 FROM passkeys WHERE cred_id=? AND h=?`, cred, c.H[:]).Scan(&x); {
		case errors.Is(err, sql.ErrNoRows):
			return ErrSansPasskey // retirée depuis : reauth d'abord
		case err != nil:
			return err
		}
		rows, err := tx.Query(`SELECT n, env FROM enveloppes WHERE cred_id=?`, cred)
		if err != nil {
			return err
		}
		pris := [EnveloppesMax]bool{}
		for rows.Next() {
			var n int
			var e []byte
			if err := rows.Scan(&n, &e); err != nil {
				rows.Close()
				return err
			}
			if bytes.Equal(e, env) {
				rows.Close()
				return nil // idempotent
			}
			if n >= 0 && n < EnveloppesMax {
				pris[n] = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for n, p := range pris {
			if !p {
				_, err := tx.Exec(`INSERT INTO enveloppes(cred_id, n, env) VALUES(?,?,?)`, cred, n, env)
				return err
			}
		}
		return ErrEnveloppesMax
	})
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

// noterCompteur : dernier compteur de signatures de la passkey cred_id, gardé s'il progresse (deux
// connexions simultanées ne le font jamais reculer).
func (s *Service) noterCompteur(credID []byte, n uint32) error {
	if n == 0 {
		return nil
	}
	_, err := s.db.Exec(`UPDATE passkeys SET sign_count=? WHERE cred_id=? AND sign_count<?`, int64(n), credID, int64(n))
	return err
}

package compte

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/netip"
	"time"
)

// Inscription et connexion par passkey (conception du compte par passkey §3.1, §3.2, §5.2,
// §5.3, §6.4, §7.2). Les options sont rendues avant le geste (contrainte de Safari, §3) ; le
// défi vit 5 min dans une étape en mémoire, à usage unique.

var errSansCeremonies = errors.New("compte : cérémonies WebAuthn absentes (Config.Ceremonies)")

// InscriptionDebut : inscription/debut (l'anti-robot est vérifié avant, par l'API) : 20 par
// heure par connexion ; plafonds des comptes (SHH_COMPTES_MAX, SHH_COMPTES_JOUR, 3 par jour par
// connexion) dits dès ici pour ne pas faire créer une passkey qui ne servira pas ; h de 16 octets
// tiré ici (user.id de WebAuthn). Rien n'est écrit.
func (s *Service) InscriptionDebut(ip netip.Addr) ([32]byte, json.RawMessage, error) {
	if s.wa == nil {
		return [32]byte{}, nil, errSansCeremonies
	}
	now := s.now()
	if !s.lim.AllowInscriptionDebut(ip) {
		return [32]byte{}, nil, ErrLimit{heureSuivante(now)}
	}
	if !s.lim.PeutCreerCompte(ip) {
		return [32]byte{}, nil, ErrLimit{jourSuivant(now)}
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM comptes`).Scan(&n); err != nil {
		return [32]byte{}, nil, err
	}
	if n >= s.max {
		return [32]byte{}, nil, ErrBusy
	}
	var h [16]byte
	tirer(h[:])
	opts, sd, err := s.wa.debutCreation(h, nil)
	if err != nil {
		return [32]byte{}, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.plafondJourLocked(now) {
		return [32]byte{}, nil, ErrBusy
	}
	jeton, err := s.nouvelleEtapeLocked(&etape{sorte: etapeInscription, h: h, defi: sd}, now)
	if err != nil {
		return [32]byte{}, nil, err
	}
	return jeton, opts, nil
}

// plafondJourLocked : SHH_COMPTES_JOUR comptes déjà créés aujourd'hui (UTC), pour tout le serveur.
func (s *Service) plafondJourLocked(now time.Time) bool {
	if j := jourDe(now); j != s.jourCrees {
		s.jourCrees, s.creesJour = j, 0
	}
	return s.creesJour >= int64(s.jour)
}

// FinInscription : ce que l'appareil envoie à inscription/fin en plus du compte : la réponse de
// navigator.credentials.create (sortie PRF retirée), l'enveloppe PRF de K_compte (60 octets, ou
// nil si la passkey n'a pas PRF), le libellé chiffré de la passkey (64 octets ou nil).
type FinInscription struct {
	Credential    []byte
	Env           []byte
	CredEtiquette []byte
}

// InscriptionFin : la passkey est vérifiée pour le h de l'étape, puis le compte, la passkey et
// une session sont créés dans une même transaction (le compte n'existe sur disque qu'ici).
// Pseudo pris, réservé par une autre inscription ou interdit : ErrPseudoPris ; plafonds :
// ErrBusy (SHH_COMPTES_MAX, SHH_COMPTES_JOUR) ou ErrLimit (3 par jour par connexion, 10 par
// /48) ; corps faux : ErrRequete. Dans ces cas l'étape reste valable 5 min (même passkey : la
// personne n'a pas à en recréer une, R11). Une passkey refusée par la vérification consomme
// l'étape ; le succès aussi.
func (s *Service) InscriptionFin(ip netip.Addr, jeton [32]byte, nc NouveauCompte, f FinInscription, o OptionsSession) ([32]byte, [16]byte, error) {
	if s.wa == nil {
		return [32]byte{}, [16]byte{}, errSansCeremonies
	}
	if (f.Env != nil && len(f.Env) != EnveloppeLen) || (f.CredEtiquette != nil && len(f.CredEtiquette) != 64) || !o.valide() {
		return [32]byte{}, [16]byte{}, ErrRequete
	}
	now := s.now()
	s.mu.Lock()
	e := s.et.trouverLocked(jeton, etapeInscription, now)
	var h [16]byte
	var sd *defi
	if e != nil {
		h, sd = e.h, e.defi
	}
	s.mu.Unlock()
	if e == nil {
		return [32]byte{}, [16]byte{}, ErrEtape
	}
	if !s.lim.PeutCreerCompte(ip) {
		return [32]byte{}, [16]byte{}, ErrLimit{jourSuivant(now)}
	}
	// Vérification hors du verrou (signature RSA : quelques ms).
	pk, err := s.wa.finCreation(h, sd, f.Credential)
	if err != nil {
		s.mu.Lock()
		s.et.retirerLocked(jeton)
		s.mu.Unlock()
		return [32]byte{}, [16]byte{}, err
	}
	pk.Env, pk.Etiquette = bytes.Clone(f.Env), bytes.Clone(f.CredEtiquette)
	pe, err := s.empreintePseudo(nc.PCanon)
	if err != nil {
		return [32]byte{}, [16]byte{}, err
	}
	k := cleEtape(jeton)
	// « Pris » dit l'existence d'un compte : même limite que pseudo/verifier, par étape.
	if !s.lim.AllowPseudoVerifier(k[:]) {
		return [32]byte{}, [16]byte{}, ErrLimit{heureSuivante(now)}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.et.trouverLocked(jeton, etapeInscription, now) == nil {
		return [32]byte{}, [16]byte{}, ErrEtape
	}
	if s.pseudoReserveLocked(pe, k, now) {
		return [32]byte{}, [16]byte{}, ErrPseudoPris
	}
	if s.plafondJourLocked(now) {
		return [32]byte{}, [16]byte{}, ErrBusy
	}
	var tok [32]byte
	err = s.tx(func(tx *sql.Tx) error {
		var err error
		tok, err = s.creerCompteTx(tx, h, nc, pk, o, now)
		return err
	})
	if err != nil {
		return [32]byte{}, [16]byte{}, err
	}
	s.et.retirerLocked(jeton)
	s.creesJour++
	s.lim.NoterCompte(ip)
	s.cpt.inscriptions.Add(1)
	return tok, h, nil
}

// ConnexionDebut : connexion/debut (sans preuve : la connexion doit rester un clic), 60 par
// minute par connexion ; options d'une connexion découvrable (aucune passkey nommée).
func (s *Service) ConnexionDebut(ip netip.Addr) ([32]byte, json.RawMessage, error) {
	if s.wa == nil {
		return [32]byte{}, nil, errSansCeremonies
	}
	now := s.now()
	if !s.lim.AllowConnexionDebut(ip) {
		return [32]byte{}, nil, ErrLimit{s.lim.MinuteRetry()}
	}
	opts, sd, err := s.wa.debutAssertion(nil, nil)
	if err != nil {
		return [32]byte{}, nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	jeton, err := s.nouvelleEtapeLocked(&etape{sorte: etapeConnexion, defi: sd}, now)
	if err != nil {
		return [32]byte{}, nil, err
	}
	return jeton, opts, nil
}

// passkeyDe : la passkey cred_id et son compte (inconnue : ErrIdentifiants).
func (s *Service) passkeyDe(credID []byte) ([16]byte, Passkey, error) {
	var h [16]byte
	var p Passkey
	var be int
	err := s.db.QueryRow(`SELECT h, cred_id, cle_pub, alg, be, etiquette FROM passkeys WHERE cred_id=?`, credID).Scan(
		(*octets16)(&h), &p.CredID, &p.ClePub, &p.Alg, &be, &p.Etiquette)
	if errors.Is(err, sql.ErrNoRows) {
		return h, p, ErrIdentifiants
	}
	p.BE = be == 1
	return h, p, err
}

// ConnexionFin : connexion/fin. L'étape sert une fois, juste ou fausse. Passkey inconnue,
// signature fausse, userHandle d'un autre compte, BE changé : ErrIdentifiants (même réponse),
// compté dans les échecs de la connexion (20 par heure, 60 par /48). Juste : session, enveloppe
// PRF de cette passkey (ou nil) et coffres ; vu_mois mis à jour. Un compte banni se connecte
// (export et suppression, §13). La session est liée à cette passkey (passkeys/enveloppe).
func (s *Service) ConnexionFin(ip netip.Addr, jeton [32]byte, credential []byte, o OptionsSession) (Ouverture, error) {
	if s.wa == nil {
		return Ouverture{}, errSansCeremonies
	}
	if !o.valide() {
		return Ouverture{}, ErrRequete
	}
	now := s.now()
	if !s.lim.AllowEchecConnexion(ip) {
		return Ouverture{}, ErrLimit{heureSuivante(now)}
	}
	s.mu.Lock()
	e := s.et.trouverLocked(jeton, etapeConnexion, now)
	s.et.retirerLocked(jeton)
	s.mu.Unlock()
	if e == nil {
		return Ouverture{}, ErrEtape
	}
	h, credID, err := s.wa.finAssertion(e.defi, credential, s.passkeyDe, nil, nil)
	if errors.Is(err, ErrIdentifiants) {
		s.lim.NoterEchecConnexion(ip)
		s.cpt.echecs.Add(1)
	}
	if err != nil {
		return Ouverture{}, err
	}
	ov := Ouverture{H: h, CredID: credID}
	if ov.Enveloppes, err = s.enveloppesDe(credID); err != nil {
		return Ouverture{}, err
	}
	var vuMois int64
	if err := s.db.QueryRow(`SELECT blob_profil, gen_profil, blob_prive, gen_prive, vu_mois FROM comptes WHERE h=?`, h[:]).Scan(
		&ov.BlobProfil, &ov.GenProfil, &ov.BlobPrive, &ov.GenPrive, &vuMois); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Ouverture{}, ErrIdentifiants // supprimé entre-temps
		}
		return Ouverture{}, err
	}
	if ov.Jeton, err = s.ouvrirSession(h, vuMois, o, false, now); err != nil {
		return Ouverture{}, err
	}
	s.lierPasskey(ov.Jeton, credID)
	s.cpt.connexions.Add(1)
	return ov, nil
}

// enveloppesDe : les enveloppes PRF de la passkey cred_id (ordre n ; vide : aucune).
func (s *Service) enveloppesDe(credID []byte) ([][]byte, error) {
	rows, err := s.db.Query(`SELECT env FROM enveloppes WHERE cred_id=? ORDER BY n`, credID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := [][]byte{}
	for rows.Next() {
		var e []byte
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

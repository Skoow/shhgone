package compte

import (
	"crypto/rand"
	"crypto/sha256"
	"time"
)

// Étapes en mémoire (conception du compte par passkey §6.2) : une cérémonie WebAuthn commencée
// (inscription, connexion, réauthentification, ajout de passkey), désignée par un jeton de
// 32 octets rendu au client ; la table ne garde que SHA-256 du jeton. Usage unique, 5 min
// (contrainte de Safari, §3 : les options sont chargées avant le clic), 20 000 vivantes au plus
// (au-delà : busy). Rien sur disque : un redémarrage les perd.
const (
	dureeEtape = 5 * time.Minute
	etapesMax  = 20000
)

type sorteEtape uint8

const (
	etapeInscription sorteEtape = iota + 1
	etapeConnexion
	etapeReauth
	etapeAjout
)

// etape : une cérémonie en cours. h : compte (inscription : tiré au début ; reauth et ajout :
// compte de la session ; connexion : nul). pe : empreinte du pseudo réservé pendant
// l'inscription (pseudo/verifier libre, conception §6.4), nulle sinon. defi : données de la
// bibliothèque WebAuthn (défi, rp.id, vérification exigée, passkeys permises), jamais écrites.
type etape struct {
	sorte  sorteEtape
	h      [16]byte
	pe     [32]byte
	defi   *defi
	expire time.Time
}

// etapes : SHA-256 du jeton → étape (allowedMaps de stats_test.go).
type etapes struct {
	m map[[32]byte]*etape
}

func cleEtape(jeton [32]byte) [32]byte { return sha256.Sum256(jeton[:]) }

// trouverLocked : l'étape vivante de cette sorte, ou nil (une étape échue est retirée).
func (t *etapes) trouverLocked(jeton [32]byte, sorte sorteEtape, now time.Time) *etape {
	k := cleEtape(jeton)
	e := t.m[k]
	if e == nil {
		return nil
	}
	if !now.Before(e.expire) {
		delete(t.m, k)
		return nil
	}
	if e.sorte != sorte {
		return nil
	}
	return e
}

func (t *etapes) retirerLocked(jeton [32]byte) { delete(t.m, cleEtape(jeton)) }

// balayerLocked : retire les étapes échues.
func (t *etapes) balayerLocked(now time.Time) {
	for k, e := range t.m {
		if !now.Before(e.expire) {
			delete(t.m, k)
		}
	}
}

// nouvelleEtapeLocked : jeton tiré, étape gardée 5 min (s.mu tenu) ; 20 000 vivantes : busy.
func (s *Service) nouvelleEtapeLocked(e *etape, now time.Time) ([32]byte, error) {
	if len(s.et.m) >= etapesMax {
		s.et.balayerLocked(now)
		if len(s.et.m) >= etapesMax {
			return [32]byte{}, ErrBusy
		}
	}
	var jeton [32]byte
	rand.Read(jeton[:])
	e.expire = now.Add(dureeEtape)
	s.et.m[cleEtape(jeton)] = e
	return jeton, nil
}

// pseudoReserveLocked : une inscription vivante autre que sauf a réservé l'empreinte pe.
func (s *Service) pseudoReserveLocked(pe [32]byte, sauf [32]byte, now time.Time) bool {
	for k, e := range s.et.m {
		if k != sauf && e.sorte == etapeInscription && e.pe == pe && pe != [32]byte{} && now.Before(e.expire) {
			return true
		}
	}
	return false
}

// oublierDefisDe : les étapes du compte h (suppression, bannissement).
func (s *Service) oublierDefisDe(h [16]byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, e := range s.et.m {
		if e.h == h {
			delete(s.et.m, k)
		}
	}
}

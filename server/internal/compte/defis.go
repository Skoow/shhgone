package compte

import (
	"crypto/rand"
	"crypto/sha256"
	"net/netip"
	"time"

	"github.com/skoow/shhdrop/server/internal/limits"
)

// Étapes en mémoire (conception du compte par passkey §6.2) : une cérémonie WebAuthn commencée
// (inscription, connexion, réauthentification, ajout de passkey), désignée par un jeton de
// 32 octets rendu au client ; la table ne garde que SHA-256 du jeton. Usage unique, 5 min (15 pour l'inscription)
// (contrainte de Safari, §3 : les options sont chargées avant le clic), 20 000 vivantes au plus
// (au-delà : busy), partagées équitablement entre les blocs (partEtapes). Rien sur disque : un
// redémarrage les perd.
const (
	dureeEtape = 5 * time.Minute
	// dureeInscription : l'étape d'inscription couvre aussi le temps de noter puis de vérifier la
	// clé de récupération, entre la feuille de passkey et inscription/fin (5 min ne suffisent pas
	// toujours : la passkey resterait orpheline). Le pseudo reste réservé autant.
	dureeInscription = 15 * time.Minute
	etapesMax        = 20000
	// partEtapes, reserveEtapes : part équitable de la table, comme limits.NewFairSlots. Un
	// bloc (/48, ou compte pour un ajout de passkey) tient au plus etapesMax / FairShare étapes
	// (2 500) ; le dernier quart (5 000) ne va qu'à un bloc qui n'en tient aucune. Sans cela,
	// environ 7 blocs /48 remplissaient la table et plus personne ne pouvait se connecter ;
	// il en faut maintenant 5 000 de plus pour fermer la porte aux nouveaux venus.
	partEtapes    = etapesMax / limits.FairShare
	reserveEtapes = etapesMax / limits.FairReserve
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
	// bloc : clé du bloc qui l'a commencée (part équitable) : clé HMAC du jour du /48
	// (limits.Limiter.Key, jamais le préfixe en clair) ou, pour un ajout de passkey, le compte.
	bloc string
}

// etapes : SHA-256 du jeton → étape ; parBloc : étapes vivantes par bloc (allowedMaps de
// stats_test.go).
type etapes struct {
	m       map[[32]byte]*etape
	parBloc map[string]int
}

// oterLocked : retire l'étape de clé k (et sa place dans son bloc).
func (t *etapes) oterLocked(k [32]byte) {
	e := t.m[k]
	if e == nil {
		return
	}
	delete(t.m, k)
	if t.parBloc[e.bloc]--; t.parBloc[e.bloc] <= 0 {
		delete(t.parBloc, e.bloc)
	}
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
		t.oterLocked(k)
		return nil
	}
	if e.sorte != sorte {
		return nil
	}
	return e
}

func (t *etapes) retirerLocked(jeton [32]byte) { t.oterLocked(cleEtape(jeton)) }

// balayerLocked : retire les étapes échues.
func (t *etapes) balayerLocked(now time.Time) {
	for k, e := range t.m {
		if !now.Before(e.expire) {
			t.oterLocked(k)
		}
	}
}

// nouvelleEtapeLocked : jeton tiré, étape gardée 5 min, 15 pour l'inscription (s.mu tenu),
// comptée dans le bloc e.bloc ; 20 000 vivantes, part du bloc atteinte, ou réserve des nouveaux
// venus pour un bloc qui en tient déjà : busy.
func (s *Service) nouvelleEtapeLocked(e *etape, now time.Time) ([32]byte, error) {
	if !s.et.placeLocked(e.bloc) {
		s.et.balayerLocked(now)
		if !s.et.placeLocked(e.bloc) {
			return [32]byte{}, ErrBusy
		}
	}
	var jeton [32]byte
	rand.Read(jeton[:])
	if e.sorte == etapeInscription {
		e.expire = now.Add(dureeInscription)
	} else {
		e.expire = now.Add(dureeEtape)
	}
	s.et.m[cleEtape(jeton)] = e
	s.et.parBloc[e.bloc]++
	return jeton, nil
}

// placeLocked : une étape de plus pour le bloc tient dans la table (part équitable).
func (t *etapes) placeLocked(bloc string) bool {
	n, b := len(t.m), t.parBloc[bloc]
	return n < etapesMax && b < partEtapes && (n < etapesMax-reserveEtapes || b == 0)
}

// blocIP : clé du bloc /48 de ip pour la part équitable des étapes.
func (s *Service) blocIP(ip netip.Addr) string {
	_, k48 := s.lim.Key(ip)
	return "ip|" + k48
}

// blocCompte : bloc d'un ajout de passkey (session du compte h, pas d'adresse).
func blocCompte(h [16]byte) string { return "h|" + string(h[:]) }

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
			s.et.oterLocked(k)
		}
	}
}

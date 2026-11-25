package adminui

import (
	"sync"
	"time"

	"github.com/skoow/shhdrop/server/internal/paiement"
)

// Compteurs lents. Avec très peu de clients, une lecture toutes les 5 s d'un compteur qui monte
// d'un à chaque achat, inscription ou appel ouvert date cet événement à 5 s près. Ces compteurs
// ne sont donc recalculés qu'une fois par periodeLente au plus : la page montre la valeur de la
// première lecture de la période, gardée en mémoire seulement (jamais sur disque), quel que soit
// le nombre de lectures. Le reste (santé, gel, suspension des ventes, bannissements, charge) est
// lu à chaque demande : l'exploitant voit tout de suite l'effet de ses propres actions.
//
// Ce que cela borne : un événement est daté à periodeLente près, pas mieux. Avec un seul client
// dans la période, il reste daté à la minute.

// periodeLente : durée de validité d'une valeur lente (variable : réglée par les tests).
var periodeLente = time.Minute

// lent : une valeur recalculée au plus une fois par periodeLente.
type lent[T any] struct {
	mu    sync.Mutex
	v     T
	jusqu time.Time // zéro : aucune valeur encore
}

// lire : la valeur gardée si elle vaut encore à now, sinon frais (gardé pour la période).
func (l *lent[T]) lire(now time.Time, frais T) T {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.jusqu.IsZero() || !now.Before(l.jusqu) {
		l.v, l.jusqu = frais, now.Add(periodeLente)
	}
	return l.v
}

// lents : les valeurs lentes de la page.
type lents struct {
	etat     lent[etatLent]
	paiement lent[paiement.Agregats]
	comptes  lent[Agregats]
}

// etatLent : ce qui, dans /api/etat, date un achat ou un appel : jetons dépensés (partages
// payants, appels ouverts), identifiants du relais, salons aux appels ouverts.
type etatLent struct {
	partagesPayants  [2]int64
	appelsOuverts    int64
	identifiantsTurn int64
	salonAppels      int
}

// ralentirEtat : st avec ses compteurs lents.
func (a *admin) ralentirEtat(st State) State {
	f := etatLent{partagesPayants: st.Usage.PartagesPayants, appelsOuverts: st.Usage.AppelsOuverts,
		identifiantsTurn: st.Usage.IdentifiantsTurn}
	if st.Salon != nil {
		f.salonAppels = st.Salon.AppelsOuverts
	}
	l := a.lents.etat.lire(a.now(), f)
	st.Usage.PartagesPayants, st.Usage.AppelsOuverts, st.Usage.IdentifiantsTurn = l.partagesPayants, l.appelsOuverts, l.identifiantsTurn
	if st.Salon != nil {
		salon := *st.Salon
		salon.AppelsOuverts = l.salonAppels
		st.Salon = &salon
	}
	return st
}

// ralentirPaiement : tous les agrégats du paiement sont lents (pass, commandes, jetons, compteurs
// par prestataire), sauf ce qui décrit la configuration et l'état des ventes, et les accès offerts,
// lus à l'instant.
func (a *admin) ralentirPaiement(frais paiement.Agregats) paiement.Agregats {
	ag := a.lents.paiement.lire(a.now(), frais)
	ag.Suspendu, ag.JetonsActif, ag.RecentesMax = frais.Suspendu, frais.JetonsActif, frais.RecentesMax
	// Accès offerts : ne changent que par l'exploitant (ni vente ni achat à dater), lus à l'instant.
	ag.AccesOfferts = frais.AccesOfferts
	for _, p := range [][2]*paiement.AgregatsPrestataire{{&ag.Stripe, &frais.Stripe}, {&ag.PayPal, &frais.PayPal},
		{&ag.NOWPayments, &frais.NOWPayments}} {
		p[0].Configure, p[0].Vendable = p[1].Configure, p[1].Vendable
	}
	return ag
}

// ralentirComptes : tous les agrégats des comptes sont lents (inscrits, sessions, connexions…),
// sauf le plafond, les bannissements (qui ne changent que par l'exploitant) et les salons vivants
// créés par un compte (lus à l'instant comme les salons vivants de /api/etat ; un bannissement
// les ferme).
func (a *admin) ralentirComptes(frais Agregats) Agregats {
	ag := a.lents.comptes.lire(a.now(), frais)
	ag.Max, ag.SalonsDeComptes = frais.Max, frais.SalonsDeComptes
	ag.BannisActifs, ag.BannisSuspendus, ag.BannisBientot = frais.BannisActifs, frais.BannisSuspendus, frais.BannisBientot
	return ag
}

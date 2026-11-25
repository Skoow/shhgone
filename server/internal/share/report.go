package share

import (
	"database/sql"
	"errors"
	"sync"
)

// Signalement d'un partage : un signalement n'efface plus le partage à lui seul. Chaque
// ouverture vaut une voix, prouvée par son octroi signé (grant.go) et par K_preuve (le mot de
// passe) ; le partage est effacé pour tous, sans grâce (flux coupés, spec §41.8), quand les voix
// atteignent la moitié des ouvertures permises (max_opens), arrondie au-dessus, et au moins 2
// dès que 2 ouvertures sont permises : 1 sur 1, 2 sur 2, 2 sur 3, 3 sur 5, 5 sur 10, 10 sur 20
// (« 1 sur 2 » laissait un seul destinataire effacer le partage de
// l'autre). Un seul signalement ne suffit donc jamais pour un partage destiné à plusieurs.
// Limite assumée :
// qui a le lien et le mot de passe peut ouvrir lui-même plusieurs fois et voter avec chacune
// (il pourrait aussi bien prendre toutes les ouvertures).
//
// Les voix vivent en mémoire seulement : ni adresse, ni catégorie, ni identité ; seulement
// le numéro d'ouverture, oublié quand le partage est effacé (destroy) ou, au plus tard, par le
// balayage après son échéance (Sweep). Un redémarrage les efface, comme les octrois.

// ErrStillOpen : destruction par un destinataire alors que d'autres ouvertures restent
// possibles, ou par un autre que le dernier (409 still_open) ; seul le dernier destinataire
// (son octroi porte n = opens_issued, partage « draining »), ou l'expéditeur, peut détruire.
var ErrStillOpen = errors.New("d'autres ouvertures restent possibles")

// ReportsNeeded : voix qui effacent un partage de maxOpens ouvertures permises.
func ReportsNeeded(maxOpens int) int {
	return max(min(2, maxOpens), (maxOpens+1)/2, 1)
}

type reportBox struct {
	mu sync.Mutex
	m  map[string]*reportEntry
}

type reportEntry struct {
	exp   int64
	votes map[int]struct{}
}

// vote inscrit la voix de l'ouverture n ; rend le nombre de voix et si elle est nouvelle (la
// même ouverture qui signale de nouveau ne compte ni une voix ni un signalement de plus).
func (b *reportBox) vote(id string, n int, exp int64) (int, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.m == nil {
		b.m = map[string]*reportEntry{}
	}
	e := b.m[id]
	if e == nil {
		e = &reportEntry{votes: map[int]struct{}{}}
		b.m[id] = e
	}
	e.exp = max(e.exp, exp)
	_, deja := e.votes[n]
	e.votes[n] = struct{}{}
	return len(e.votes), !deja
}

// purge oublie les voix des partages échus (appelée par Sweep).
func (b *reportBox) purge(now int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, e := range b.m {
		if e.exp <= now {
			delete(b.m, k)
		}
	}
}

func (b *reportBox) forget(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.m, id)
}

// Report : signalement par un destinataire (K_accès, K_preuve et l'octroi de son ouverture).
// K_preuve faux : un essai de mot de passe, comme Unlock. Octroi faux, d'un autre partage ou
// échu : ErrGrantInvalid, sans essai. Rend si cette voix a effacé le partage, et si elle est
// nouvelle (les compteurs ne comptent qu'une voix nouvelle). Un partage déjà fermé aux
// ouvertures (échu, essais épuisés, détruit) ou encore en envoi : ErrNotFound, rien n'est coupé.
func (s *Service) Report(kAcces, kPreuve []byte, grant string) (gone, nouvelle bool, err error) {
	v := Verifier(kAcces)
	if v == nil {
		return false, false, ErrNotFound
	}
	now := s.now()
	var id, state string
	var proofV []byte
	var maxOpens, exp sql.NullInt64 // NULL pendant l'envoi : introuvable, comme partout (pas de 500)
	err = s.DB.QueryRow(`SELECT id, proof_v, state, max_opens, expires_at FROM shares WHERE access_v=?2 AND `+alive, now, v).
		Scan(&id, &proofV, &state, &maxOpens, &exp)
	if err != nil {
		return false, false, notFound(err)
	}
	if state == "uploading" || !maxOpens.Valid || !exp.Valid {
		return false, false, ErrNotFound
	}
	mu := s.attemptLock(id)
	mu.Lock()
	defer mu.Unlock()
	var failed int
	if err := s.DB.QueryRow(`SELECT failed_attempts FROM shares WHERE id=?`, id).Scan(&failed); err != nil {
		return false, false, notFound(err)
	}
	if failed >= maxAttempts {
		return false, false, ErrNotFound
	}
	if !match(kPreuve, proofV) {
		if _, err := s.countFailure(id); err != nil && !errors.Is(err, ErrNotFound) {
			return false, false, err
		}
		return false, false, ErrNotFound
	}
	idb, ok := idBytes(id)
	if !ok {
		return false, false, ErrNotFound
	}
	n, ok := VerifyGrant(s.grantKey, idb, grant, s.Now())
	if !ok {
		return false, false, ErrGrantInvalid
	}
	voix, nouvelle := s.reports.vote(id, int(n), exp.Int64)
	if voix < ReportsNeeded(int(maxOpens.Int64)) {
		return false, nouvelle, nil
	}
	s.reports.forget(id)
	if err := s.retireOrNotFound(id, false); err != nil {
		return false, nouvelle, err
	}
	return true, nouvelle, nil
}

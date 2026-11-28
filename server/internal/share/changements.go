package share

import "sync"

// Changements des partages, pour « Mes partages » en direct (décision du propriétaire, 28 novembre :
// le compteur d'ouvertures se met à jour tout de suite). Un seul signal pour tous les partages :
// chaque ouverture consommée, chaque disparition (suppression, essais épuisés, échéance,
// administrateur) ferme le canal courant et en tire un neuf. Une surveillance (POST
// /api/manage/surveiller) attend ce canal, relit l'état de SES partages et ne répond que s'il a
// changé. Rien n'est gardé : ni quel partage a changé, ni qui attend.
type changements struct {
	mu sync.Mutex
	ch chan struct{}
}

// Changement : canal fermé au prochain changement d'un partage, quel qu'il soit.
func (s *Service) Changement() <-chan struct{} {
	s.chg.mu.Lock()
	defer s.chg.mu.Unlock()
	if s.chg.ch == nil {
		s.chg.ch = make(chan struct{})
	}
	return s.chg.ch
}

// signalerChangement réveille toutes les surveillances en cours.
func (s *Service) signalerChangement() {
	s.chg.mu.Lock()
	defer s.chg.mu.Unlock()
	if s.chg.ch != nil {
		close(s.chg.ch)
		s.chg.ch = nil
	}
}

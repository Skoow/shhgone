package salon

import "time"

// Appels réservés aux offres payantes (conception des appels §5.1) : un membre qui a Plus ou Pro
// dépense un jeton anonyme pour ouvrir les appels du salon, puis tous ses membres peuvent
// appeler jusqu'à la fin du salon. Le gestionnaire ne garde que l'heure de fin (en mémoire) : ni
// le jeton, ni l'offre, ni le siège qui l'a ouvert.

// AppelsParJetonMax : un jeton ouvre les appels jusqu'à la fin du salon, mais jamais plus de
// 24 h 15 min : la plus longue durée d'un salon ordinaire, arrondie au quart d'heure (aucun
// changement pour eux). Un salon sur
// mesure de 30 jours demande donc un jeton par jour d'appels (sinon un seul jeton payait
// 30 jours de relais TURN pour 50 personnes) ; un membre qui a une offre payante les rouvre.
const AppelsParJetonMax = HeuresStandardMax*time.Hour + quart*time.Second

// membreActuelLocked : mb occupe encore son siège (ni parti, ni exclu, ni remplacé) dans un
// salon vivant à now. Appelé sous s.mu.
func membreActuelLocked(s *salon, mb Membre, now time.Time) error {
	if s.fini || !now.Before(s.expires) {
		return ErrNotFound
	}
	if _, ok := s.revoques[mb.jetonV]; ok {
		return ErrExcluded
	}
	if mb.siege >= nbSieges || s.sieges[mb.siege] == nil || s.sieges[mb.siege].jetonV != mb.jetonV {
		return ErrNotFound
	}
	return nil
}

// finAppelsLocked : fermeture effective des appels, jamais après la fin du salon (un
// renouvellement peut la rapprocher : conception des appels §5). Sous s.mu.
func finAppelsLocked(s *salon) time.Time {
	if s.expires.Before(s.appelsJusqua) {
		return s.expires
	}
	return s.appelsJusqua
}

// AppelsOuverts : temps restant avant la fermeture des appels du salon de mb (au moins une
// seconde), ou faux s'ils sont fermés. Erreur si mb n'est plus membre (comme Membre).
func (m *Manager) AppelsOuverts(mb Membre) (time.Duration, bool, error) {
	s := mb.salon
	if s == nil {
		return 0, false, ErrNotFound
	}
	now := m.cfg.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := membreActuelLocked(s, mb, now); err != nil {
		return 0, false, err
	}
	reste := finAppelsLocked(s).Sub(now)
	if reste < time.Second {
		return 0, false, nil
	}
	return reste, true, nil
}

// OuvrirAppels : ouvre les appels du salon de mb jusqu'à sa fin, AppelsParJetonMax au plus
// (après la vérification d'un jeton payant par l'appelant). Rend le temps restant et deja = vrai s'ils étaient déjà
// ouverts (deux membres en même temps : le second jeton est à rendre). Un renouvellement
// ultérieur du salon ne les prolonge pas : ils se ferment à la fin prévue au moment de
// l'ouverture, et un membre qui a une offre payante les rouvre.
func (m *Manager) OuvrirAppels(mb Membre) (reste time.Duration, deja bool, err error) {
	s := mb.salon
	if s == nil {
		return 0, false, ErrNotFound
	}
	now := m.cfg.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := membreActuelLocked(s, mb, now); err != nil {
		return 0, false, err
	}
	if r := finAppelsLocked(s).Sub(now); r >= time.Second {
		return r, true, nil
	}
	fin := s.expires
	if borne := now.Add(AppelsParJetonMax); fin.After(borne) {
		fin = borne
	}
	s.appelsJusqua = fin
	s.appelsFin.Store(fin.Unix())
	return fin.Sub(now), false, nil
}

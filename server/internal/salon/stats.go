package salon

// Statistiques agrégées pour le tableau de bord d'administration (conception
// docs/conception/specs/2026-11-13-tableau-de-bord-admin-design.md, catégories C, D, F). Que
// des nombres : jamais un identifiant de salon, un siège désigné, un jeton ni une heure.

// Stats : état du salon à l'instant.
type Stats struct {
	// Vivants : salons créés par ce processus et pas encore finis (Manager.vivants) ; Max :
	// SHH_SALONS_MAX.
	Vivants int `json:"salons_vivants"`
	Max     int `json:"salons_max"`
	// Sieges : sièges occupés, tous salons confondus (sans dire où).
	Sieges int `json:"sieges_occupes"`
	// Connexions : WebSocket du salon servis en ce moment.
	Connexions int64 `json:"connexions"`
	// Trames, TramesMax : trames rangées en mémoire et plafond global.
	Trames    int64 `json:"trames_en_memoire"`
	TramesMax int   `json:"trames_max"`
	// OctetsConversations : taille des fichiers de conversation ouverts.
	OctetsConversations int64 `json:"octets_conversations"`
	// Paniques : paniques récupérées dans l'entretien (Tick) depuis le démarrage.
	Paniques int64 `json:"paniques_entretien"`
	// NettoyagesRates : suppressions de lignes échues ou à 10 essais ratées par l'entretien
	// depuis le démarrage (base occupée, disque plein) ; chaque ligne est reprise ensuite.
	NettoyagesRates int64 `json:"nettoyages_rates"`
	// AppelsOuverts : salons vivants dont les appels sont ouverts en ce moment (un jeton payant
	// dépensé). Ce n'est pas le nombre d'appels en cours : le serveur ne voit pas les appels
	// (signalisation chiffrée, média par le relais).
	AppelsOuverts int `json:"salons_appels_ouverts"`
}

// Stats lit l'état agrégé sans prendre le verrou d'aucun salon (la lecture du tableau de bord
// restait suspendue derrière un salon occupé) : les sièges occupés sont un compteur atomique
// par salon (salon.occ, remis à 0 à la fin du salon). Manager.mu n'est tenu que le temps de
// parcourir la liste, en mémoire.
func (m *Manager) Stats() Stats {
	now := m.cfg.Now().Unix()
	m.mu.Lock()
	vivants := len(m.vivants)
	sieges, appels := 0, 0
	for _, s := range m.salons {
		sieges += int(s.occ.Load())
		if s.appelsFin.Load() > now {
			appels++
		}
	}
	m.mu.Unlock()
	return Stats{
		Vivants: vivants, Max: m.cfg.Max, Sieges: sieges, Connexions: m.servis.Load(),
		Trames: m.tramesGlob.Load(), TramesMax: m.tramesTotalMax(),
		OctetsConversations: m.octetsConv.Load(), Paniques: m.paniquesTick.Load(),
		NettoyagesRates: m.nettoyagesRates.Load(), AppelsOuverts: appels,
	}
}

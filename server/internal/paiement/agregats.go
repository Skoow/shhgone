package paiement

import (
	"database/sql"
	"sync/atomic"
)

// Agrégats du paiement pour le tableau de bord d'administration. Que des entiers et des
// booléens : comptés depuis le démarrage, en mémoire (un entier chacun, sans clé : ni pass, ni
// commande, ni montant, ni pays ; perdus au redémarrage, comme internal/usage), ou lus à
// l'instant par COUNT dans paiements.db (aucune ligne n'en sort).
// Aucun montant, même agrégé : le chiffre d'affaires se lit chez le prestataire, jamais ici (le
// serveur ne garde aucun montant, conception du paiement §5.1).

// indiceDe : indice des compteurs du prestataire pr, son Moyen (1 Stripe, 2 PayPal,
// 3 NOWPayments) ; 0 : révocation à la main (shhdrop admin paiement revoquer).
func indiceDe(pr Prestataire) int {
	if _, ok := pr.(revocateur); ok {
		return 0
	}
	if m := pr.Moyen(); m >= Carte && m <= Crypto {
		return int(m)
	}
	return 0
}

// compteursPrestataire : commandes (pages de paiement créées) ; credits (paiements confirmés et
// crédités) ; anomalies (paiements confirmés au montant ou à la devise inattendus : aucun
// crédit) ; revocations (remboursement total, litige ou révocation à la main appliqués) ;
// refuses (webhooks refusés : signature fausse, ou ne visant aucune commande connue).
type compteursPrestataire struct {
	commandes, credits, anomalies, revocations, refuses atomic.Int64
}

type compteurs struct {
	par [4]compteursPrestataire
}

func (c *compteurs) refuse(pr Prestataire) { c.par[indiceDe(pr)].refuses.Add(1) }

// compteursJetons : indice = Offre (1 Plus, 2 Pro) ; rendus : jetons dépensés pour une création
// refusée ensuite, redevenus utilisables.
type compteursJetons struct {
	emis, depenses [3]atomic.Int64
	rendus         atomic.Int64
}

type effet uint8

const (
	effetCredit effet = iota + 1
	effetAnomalie
	effetRevocation
)

// valider : valide la transaction d'un événement, puis le compte (seulement s'il est écrit).
func (s *Service) valider(tx *sql.Tx, pr Prestataire, e effet) error {
	if err := tx.Commit(); err != nil {
		return err
	}
	c := &s.cpt.par[indiceDe(pr)]
	switch e {
	case effetCredit:
		c.credits.Add(1)
	case effetAnomalie:
		c.anomalies.Add(1)
	case effetRevocation:
		c.revocations.Add(1)
	}
	return nil
}

// AgregatsPrestataire : un prestataire, depuis le démarrage. Configure : secrets présents ;
// Vendable : il prend de nouvelles commandes (la crypto ne vend pas sous le régime OSS, mais ses
// webhooks restent traités).
type AgregatsPrestataire struct {
	Configure   bool  `json:"configure"`
	Vendable    bool  `json:"vendable"`
	Commandes   int64 `json:"commandes"`
	Credits     int64 `json:"paiements_credites"`
	Anomalies   int64 `json:"anomalies"`
	Revocations int64 `json:"revocations"`
	Refuses     int64 `json:"webhooks_refuses"`
}

// Agregats : GET /api/paiement du tableau de bord.
type Agregats struct {
	// Suspendu : ventes suspendues par l'exploitant (jusqu'au prochain démarrage).
	Suspendu bool `json:"ventes_suspendues"`
	// Stripe, PayPal, NOWPayments ; RevocationsMain : shhdrop admin paiement revoquer.
	Stripe          AgregatsPrestataire `json:"stripe"`
	PayPal          AgregatsPrestataire `json:"paypal"`
	NOWPayments     AgregatsPrestataire `json:"nowpayments"`
	RevocationsMain int64               `json:"revocations_a_la_main"`
	// Lus à l'instant dans paiements.db : pass valables (payés, non révoqués, non échus) par
	// offre ; pass révoqués encore gardés ; commandes en attente de paiement (gardées 7 jours) ;
	// abonnements payés qui se renouvellent ; anomalies gardées pour les litiges.
	PassPlus       int `json:"pass_plus"`
	PassPro        int `json:"pass_pro"`
	PassRevoques   int `json:"pass_revoques"`
	EnAttente      int `json:"commandes_en_attente"`
	Renouvellement int `json:"abonnements_renouveles"`
	AnomaliesBase  int `json:"anomalies_gardees"`
	// Recentes, RecentesMax : commandes créées ces 4 dernières heures (compteur en mémoire) et
	// plafond des commandes en attente récentes (§8) ; au plafond, les ventes répondent 503.
	Recentes    int64 `json:"commandes_recentes"`
	RecentesMax int   `json:"commandes_recentes_max"`
	// Jetons anonymes depuis le démarrage, par offre (indice 0 Plus, 1 Pro). JetonsActif :
	// émission configurée.
	JetonsActif    bool     `json:"jetons_actif"`
	JetonsEmis     [2]int64 `json:"jetons_emis"`
	JetonsDepenses [2]int64 `json:"jetons_depenses"`
	JetonsRendus   int64    `json:"jetons_rendus"`
}

func (s *Service) prestataire(m Moyen) AgregatsPrestataire {
	c := &s.cpt.par[m]
	return AgregatsPrestataire{Configure: s.prest[m] != nil, Vendable: s.vendable(m), Commandes: c.commandes.Load(),
		Credits: c.credits.Load(), Anomalies: c.anomalies.Load(), Revocations: c.revocations.Load(), Refuses: c.refuses.Load()}
}

// Agregats : lus à l'instant (deux requêtes d'agrégat ; une seule connexion à la base).
func (s *Service) Agregats() (Agregats, error) {
	now := s.now()
	auj := jourDe(now)
	a := Agregats{Suspendu: s.suspendu.Load(), Stripe: s.prestataire(Carte), PayPal: s.prestataire(PayPal),
		NOWPayments: s.prestataire(Crypto), RevocationsMain: s.cpt.par[0].revocations.Load(),
		Recentes: s.nRecentes(now), RecentesMax: maxEnAttente, JetonsActif: s.jetons != nil}
	if err := s.db.QueryRow(`SELECT coalesce(sum(revoque=0 AND fin_jour>?1 AND offre=1), 0),
		coalesce(sum(revoque=0 AND fin_jour>?1 AND offre=2), 0), coalesce(sum(revoque=1), 0) FROM passes`, auj).Scan(
		&a.PassPlus, &a.PassPro, &a.PassRevoques); err != nil {
		return Agregats{}, err
	}
	if err := s.db.QueryRow(`SELECT coalesce(sum(etat=?1), 0), coalesce(sum(etat=?2 AND renouvelle=1), 0),
		coalesce(sum(etat=?3), 0) FROM commandes`, etatAttente, etatPayee, etatAnomalie).Scan(
		&a.EnAttente, &a.Renouvellement, &a.AnomaliesBase); err != nil {
		return Agregats{}, err
	}
	if j := s.jetons; j != nil {
		a.JetonsEmis = [2]int64{j.cpt.emis[Plus].Load(), j.cpt.emis[Pro].Load()}
		a.JetonsDepenses = [2]int64{j.cpt.depenses[Plus].Load(), j.cpt.depenses[Pro].Load()}
		a.JetonsRendus = j.cpt.rendus.Load()
	}
	return a, nil
}

// Suspendre : ventes suspendues (true) ou rétablies (false) par l'exploitant, en mémoire
// seulement (un redémarrage les rétablit). Seules les nouvelles commandes sont refusées
// (ErrSuspendu, 503) : les webhooks restent traités (un paiement en cours est crédité, un
// remboursement révoque) et les pass payés gardent leurs jetons et leurs droits.
func (s *Service) Suspendre(v bool) { s.suspendu.Store(v) }

// Package paiement : vente des offres Plus et Pro par Stripe (carte), PayPal et NOWPayments
// (crypto), par redirection vers la page hébergée du prestataire (conception du paiement,
// docs/superpowers/specs/2026-11-19-paiement-design.md). Le droit est donné à un pass au porteur
// P (32 octets tirés par l'appareil) ; le serveur n'en garde que l'empreinte Q, dans une base à
// part (paiements.db) qui ne contient rien qui désigne une personne, un partage, un salon ou un
// compte. Les webhooks signés des prestataires sont la seule source de vérité d'un paiement.
package paiement

import "fmt"

// Offre : formule payante (1 Plus, 2 Pro), comme le `tier` des partages (spec §38.9.0).
type Offre uint8

const (
	Plus Offre = 1
	Pro  Offre = 2
)

// Moyen de paiement (colonne commandes.moyen).
type Moyen uint8

const (
	Carte  Moyen = 1 // Stripe
	PayPal Moyen = 2
	Crypto Moyen = 3 // NOWPayments
)

// Périodes vendues, en jours (conception §1) : un « mois » est 30 jours, un « an » 365.
const (
	JoursMois = 30
	JoursAn   = 365
)

// Détail d'une offre (conception §1, §11). Prix TTC en centimes d'euro ; mêmes valeurs que PAID
// dans web/src/limits.ts (TestOffresCommeLeSite).
type Detail struct {
	Nom          string // « plus », « pro » (API, métadonnées du prestataire)
	Libelle      string // nom montré par le prestataire
	Mois, An     int64  // prix TTC en centimes
	JetonsPeriod int    // jetons par période de 30 jours (§5.4)
	Droits       []string
}

// details : par offre (tableau indexé, pas de table : rien qui ressemble à un compteur).
var details = [3]Detail{
	{},
	{Nom: "plus", Libelle: "Shhgone Plus", Mois: 700, An: 7000, JetonsPeriod: 30,
		Droits: []string{"partage_plus", "premiere_ouverture", "salon_plus", "appel_audio", "appel_video"}},
	{Nom: "pro", Libelle: "Shhgone Pro", Mois: 2000, An: 20000, JetonsPeriod: 100,
		Droits: []string{"partage_pro", "premiere_ouverture", "salon_pro", "appel_audio", "appel_video"}},
}

// Bientot : droits prévus dans le format mais pas encore disponibles (conception §11) : jamais
// vendus ni promis ; rendus à part par l'API pour que l'écran dise « bientôt ».
var Bientot = []string{"appel_audio", "appel_video"}

// Valide : offre connue.
func (o Offre) Valide() bool { return o == Plus || o == Pro }

// Detail de l'offre (o valide).
func (o Offre) Detail() Detail { return details[o] }

func (o Offre) String() string {
	if !o.Valide() {
		return fmt.Sprintf("offre(%d)", uint8(o))
	}
	return details[o].Nom
}

// OffreDe : « plus » ou « pro ».
func OffreDe(s string) (Offre, bool) {
	switch s {
	case "plus":
		return Plus, true
	case "pro":
		return Pro, true
	}
	return 0, false
}

// Prix TTC en centimes de l'offre o pour une période de jours (30 ou 365) ; 0 sinon.
func Prix(o Offre, jours int) int64 {
	if !o.Valide() {
		return 0
	}
	switch jours {
	case JoursMois:
		return details[o].Mois
	case JoursAn:
		return details[o].An
	}
	return 0
}

// Formule : ce que la personne choisit (conception §1, D41-34).
type Formule struct {
	Offre      Offre
	Jours      int // 30 ou 365
	Renouvelle bool
	Moyen      Moyen
}

// Valide : combinaisons permises. Mensuel par carte ou PayPal : abonnement seulement ;
// annuel par carte ou PayPal : au choix ; crypto : paiement unique (aucun prélèvement
// possible, DP-1).
func (f Formule) Valide() bool {
	if !f.Offre.Valide() || (f.Jours != JoursMois && f.Jours != JoursAn) {
		return false
	}
	switch f.Moyen {
	case Carte, PayPal:
		return f.Jours == JoursAn || f.Renouvelle
	case Crypto:
		return !f.Renouvelle
	}
	return false
}

// Description : texte montré par le prestataire (aucune donnée personnelle).
func (f Formule) Description() string {
	p := "30 jours"
	if f.Jours == JoursAn {
		p = "365 jours"
	}
	return f.Offre.Detail().Libelle + ", " + p
}

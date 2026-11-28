package api

import (
	"math"
	"net/http"
	"strconv"
	"time"
)

// Maintenance programmée (deploy/maintenance.sh, D42-32 de la spécification) : le site lit
// l'annonce (bandeau) et, en mode « redémarrage imminent », le serveur refuse les NOUVELLES
// créations (partage, salon, pièce de salon, inscription au compte, commande de paiement) ; ce
// qui est en cours continue (segments d'un envoi commencé, lectures, messages, reprises).

// offres : services ouverts sur ce serveur (réglages du démarrage), pour GET /api/etat-service.
type offres struct{ salons, appels, compte, paiement bool }

// États d'un service, page « État du service » du site et apps : « ok » ; « maintenance »
// (redémarrage imminent : nouvelles créations fermées, ce qui est en cours continue) ;
// « suspendu » (créations gelées par l'administrateur : partages et salons) ; « ferme » (service
// pas ouvert sur ce serveur). Rien d'autre (ni version, ni charge, ni erreur) : ce que dit ce
// serveur de lui-même, sans détail interne.
const (
	etatOK          = "ok"
	etatMaintenance = "maintenance"
	etatSuspendu    = "suspendu"
	etatFerme       = "ferme"
)

// etatService : GET /api/etat-service. Public, sans donnée d'utilisateur : l'horaire annoncé,
// en secondes Unix (le site l'affiche à l'heure locale du visiteur ; les apps de même), et l'état
// de chaque service. {"maintenance":null,"services":{…}} sans annonce.
func (s *server) etatService(w http.ResponseWriter, _ *http.Request) {
	type annonce struct {
		Debut     int64 `json:"debut"`
		DureeMin  int64 `json:"duree_min"`
		Retour    int64 `json:"retour"`
		Imminente bool  `json:"imminente"`
		// Fermeture : heure (secondes Unix) où les nouvelles créations ferment (bandeau).
		Fermeture int64 `json:"fermeture"`
	}
	type services struct {
		Partages string `json:"partages"`
		Salons   string `json:"salons"`
		Appels   string `json:"appels"`
		Compte   string `json:"compte"`
		Paiement string `json:"paiement"`
	}
	var a *annonce
	imminente := false
	if e := s.maint.Etat(); e.Annonce != nil {
		a = &annonce{e.Annonce.Debut.Unix(), int64(e.Annonce.Duree / time.Minute), e.Annonce.Fin().Unix(), e.Imminente, e.Annonce.Seuil().Unix()}
		imminente = e.Imminente
	}
	gel := s.svc.Frozen()
	etat := func(ouvert, gelable bool) string {
		switch {
		case !ouvert:
			return etatFerme
		case imminente:
			return etatMaintenance
		case gelable && gel:
			return etatSuspendu
		}
		return etatOK
	}
	o := s.offres
	writeJSON(w, http.StatusOK, struct {
		Maintenance *annonce `json:"maintenance"`
		Services    services `json:"services"`
	}{a, services{etat(true, true), etat(o.salons, true), etat(o.appels, false), etat(o.compte, false), etat(o.paiement, false)}})
}

// refusMaintenance : en mode « redémarrage imminent », répond 503 {"error":"maintenance",
// "retour":<secondes Unix>, "retry_after_s"} (Retry-After jusqu'au retour estimé) et rend vrai.
// À appeler en tête des seules routes de création.
func (s *server) refusMaintenance(w http.ResponseWriter) bool {
	e := s.maint.Etat()
	if !e.Imminente {
		return false
	}
	fin := e.Annonce.Fin()
	secs := max(1, int64(math.Ceil(fin.Sub(s.svc.Now()).Seconds())))
	w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
	writeJSON(w, http.StatusServiceUnavailable, struct {
		Error  string `json:"error"`
		Retour int64  `json:"retour"`
		Retry  int64  `json:"retry_after_s"`
	}{"maintenance", fin.Unix(), secs})
	return true
}

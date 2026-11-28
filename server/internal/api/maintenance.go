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

// etatService : GET /api/etat-service. Public, sans donnée d'utilisateur : l'horaire annoncé
// seulement, en secondes Unix (le site l'affiche à l'heure locale du visiteur ; les apps de
// même). {"maintenance":null} sans annonce.
func (s *server) etatService(w http.ResponseWriter, _ *http.Request) {
	type annonce struct {
		Debut     int64 `json:"debut"`
		DureeMin  int64 `json:"duree_min"`
		Retour    int64 `json:"retour"`
		Imminente bool  `json:"imminente"`
	}
	var a *annonce
	if e := s.maint.Etat(); e.Annonce != nil {
		a = &annonce{e.Annonce.Debut.Unix(), int64(e.Annonce.Duree / time.Minute), e.Annonce.Fin().Unix(), e.Imminente}
	}
	writeJSON(w, http.StatusOK, struct {
		Maintenance *annonce `json:"maintenance"`
	}{a})
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

package adminui

import (
	"net/http"

	"github.com/skoow/shhdrop/server/internal/paiement"
)

// Paiement (tableau de bord finalisé, 25 novembre) : agrégats du paiement et suspension des
// ventes. Que des nombres et des booléens : ni pass, ni commande, ni montant, ni pays.

// Paiement : crochets du paiement (SHH_PAIEMENT=1 ; nil sinon : routes refusées comme inconnues).
type Paiement struct {
	Agregats func() (paiement.Agregats, error)
	// Suspendre : true suspend les nouvelles commandes (jusqu'au redémarrage), false les rétablit.
	// Les webhooks restent traités et les pass payés gardent leurs droits.
	Suspendre func(bool)
}

// paiement : GET /api/paiement, POST /api/paiement/suspendre|retablir (corps ignoré).
func (a *admin) paiement(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/paiement/suspendre":
		a.c.Paiement.Suspendre(true)
		write(w, http.StatusOK, []byte(`{"ok":true}`))
	case "/api/paiement/retablir":
		a.c.Paiement.Suspendre(false)
		write(w, http.StatusOK, []byte(`{"ok":true}`))
	default:
		ag, err := a.c.Paiement.Agregats()
		if err != nil {
			write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
			return
		}
		writeJSON(w, ag)
	}
}

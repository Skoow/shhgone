package adminui

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/skoow/shhdrop/server/internal/paiement"
)

// Paiement (tableau de bord finalisé) : agrégats du paiement et suspension des
// ventes. Que des nombres et des booléens : ni pass, ni commande, ni montant, ni pays.
// Accès offerts (conception du paiement, « Accès offerts ») : le seul endroit où un pass passe
// par cette page, une fois, dans la réponse à « Offrir un accès » ; la liste ne montre que
// l'empreinte (identifiant de révocation), jamais le pass.

// Paiement : crochets du paiement (SHH_PAIEMENT=1 ; nil sinon : routes refusées comme inconnues).
type Paiement struct {
	Agregats func() (paiement.Agregats, error)
	// Suspendre : true suspend les nouvelles commandes (jusqu'au redémarrage), false les rétablit.
	// Les webhooks restent traités et les pass payés gardent leurs droits.
	Suspendre func(bool)
	// Offrir, Offerts, RevoquerOffert : accès offerts (paiement.Service) ; nil : leurs routes
	// sont refusées comme inconnues. Origine : SHH_ORIGIN, début du lien donné.
	Offrir         func(jours int) (paiement.Pass, paiement.AccesOffert, error)
	Offerts        func() ([]paiement.AccesOffert, error)
	RevoquerOffert func(id string) (bool, error)
	Origine        string
}

// cheminOffert : page du site qui range le pass d'un accès offert (web/src/ui/OffersGift.svelte) ;
// le pass suit « # » : jamais envoyé au serveur par le navigateur qui ouvre le lien.
const cheminOffert = "/offres/offert#"

// offertsActifs : les crochets des accès offerts sont posés, et l'origine est sûre à recopier
// telle quelle dans le JSON de la réponse (https:// ou http:// suivi de l'hôte, sans guillemet,
// barre oblique inverse ni caractère de contrôle ; config.originOK l'a déjà vérifiée : http
// seulement en développement local).
func (p *Paiement) offertsActifs() bool {
	if p.Offrir == nil || p.Offerts == nil || p.RevoquerOffert == nil ||
		!(strings.HasPrefix(p.Origine, "https://") && len(p.Origine) > 8 || strings.HasPrefix(p.Origine, "http://") && len(p.Origine) > 7) {
		return false
	}
	for _, c := range []byte(p.Origine) {
		if c <= ' ' || c >= 0x7f || c == '"' || c == '\\' {
			return false
		}
	}
	return true
}

// paiement : GET /api/paiement, POST /api/paiement/suspendre|retablir (corps ignoré) ; accès
// offerts : GET /api/paiement/offerts, POST /api/paiement/offrir { duree },
// POST /api/paiement/offerts/revoquer { id }.
func (a *admin) paiement(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/paiement/suspendre":
		a.c.Paiement.Suspendre(true)
		write(w, http.StatusOK, []byte(`{"ok":true}`))
	case "/api/paiement/retablir":
		a.c.Paiement.Suspendre(false)
		write(w, http.StatusOK, []byte(`{"ok":true}`))
	case "/api/paiement/offrir":
		a.offrir(w, r)
	case "/api/paiement/offerts":
		l, err := a.c.Paiement.Offerts()
		if err != nil {
			write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
			return
		}
		writeJSON(w, struct {
			Offerts []paiement.AccesOffert `json:"offerts"`
		}{l})
	case "/api/paiement/offerts/revoquer":
		var q struct {
			ID string `json:"id"`
		}
		tampon, ok := lireJSON(r, &q)
		clear(tampon)
		if !ok || len(q.ID) != 64 {
			requeteFausse(w)
			return
		}
		fait, err := a.c.Paiement.RevoquerOffert(q.ID)
		if err != nil {
			write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
			return
		}
		if !fait {
			write(w, http.StatusOK, []byte(`{"revoque":false}`))
			return
		}
		write(w, http.StatusOK, []byte(`{"revoque":true}`))
	default:
		ag, err := a.c.Paiement.Agregats()
		if err != nil {
			write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
			return
		}
		writeJSON(w, a.ralentirPaiement(ag))
	}
}

// offrir : { duree: "mois"|"an"|"sans_fin" } → { lien, acces }. Le pass P n'existe qu'ici, le
// temps d'écrire la réponse : encodé dans UN tampon de taille fixe (jamais une chaîne), effacé
// avec lui au retour ; rien n'est journalisé ni gardé. Effacé au mieux, comme le lien de
// destroy : il reste, hors de portée de ce code, le tampon d'écriture de la connexion (net/http)
// et la page qui l'affiche (une fois, puis oublié). Réponse « Cache-Control: no-store »
// (en-têtes communs de la page).
func (a *admin) offrir(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Duree string `json:"duree"`
	}
	tampon, ok := lireJSON(r, &q)
	clear(tampon)
	jours, okD := paiement.DureeOffertDe(q.Duree)
	if !ok || !okD {
		requeteFausse(w)
		return
	}
	p, acces, err := a.c.Paiement.Offrir(jours)
	defer clear(p[:])
	if err != nil {
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
		return
	}
	suite, err := json.Marshal(acces) // empreinte et dates seulement, jamais P
	if err != nil {
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
		return
	}
	o := a.c.Paiement.Origine
	n := len(`{"lien":"`) + len(o) + len(cheminOffert) + 43 + len(`","acces":`) + len(suite) + 1
	corps := make([]byte, 0, n)
	defer clear(corps[:cap(corps)])
	corps = append(corps, `{"lien":"`...)
	corps = append(corps, o...)
	corps = append(corps, cheminOffert...)
	debut := len(corps)
	corps = corps[:debut+43]
	base64.RawURLEncoding.Encode(corps[debut:], p[:])
	corps = append(corps, `","acces":`...)
	corps = append(corps, suite...)
	corps = append(corps, '}')
	write(w, http.StatusOK, corps)
}

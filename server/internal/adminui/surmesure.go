package adminui

import (
	"errors"
	"net/http"

	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/nom"
)

// Comptes sur mesure (décision du propriétaire, 25 novembre) : l'exploitant retrouve un compte
// par son pseudo exact (le serveur le canonise et en calcule l'empreinte : aucune liste des
// pseudos n'existe), et lui donne des limites au-delà des paliers, avec un nom ou une note
// gardés sur le serveur. Comme les salons signalés, un compte n'est désigné ici que par une ref
// aléatoire de 10 minutes (a.refsComptes), jamais par h ; la page montre un identifiant court
// (empreinte de h) pour le reconnaître.
//
//	POST /api/comptes/chercher          { pseudo }  → { compte } ou { introuvable: true }
//	GET  /api/comptes/surmesure                     → { comptes: [...] }
//	POST /api/comptes/surmesure/poser   { ref, salons, places, jours, nom } → { compte }
//	POST /api/comptes/surmesure/retirer { ref }     → { compte }

// SurMesure : crochets des comptes sur mesure (compte.Service ; nil : routes refusées comme
// inconnues).
type SurMesure struct {
	Chercher func(pseudo string) (*compte.CompteAdmin, error)
	Liste    func() ([]compte.CompteAdmin, error)
	Poser    func(h [16]byte, m compte.SurMesure) (*compte.CompteAdmin, error)
	Retirer  func(h [16]byte) (*compte.CompteAdmin, error)
}

func (s *SurMesure) actif() bool {
	return s != nil && s.Chercher != nil && s.Liste != nil && s.Poser != nil && s.Retirer != nil
}

// compteVue : un compte avec sa ref éphémère.
type compteVue struct {
	Ref string `json:"ref"`
	compte.CompteAdmin
}

func (a *admin) vuesComptes(l []compte.CompteAdmin) []compteVue {
	cles := make([]string, len(l))
	for i, c := range l {
		cles[i] = string(c.H[:])
	}
	ks := a.refsComptes.attribuer(cles, a.now())
	out := make([]compteVue, len(l))
	for i, c := range l {
		out[i] = compteVue{Ref: b64.EncodeToString(ks[i][:]), CompteAdmin: c}
	}
	return out
}

func (a *admin) repondreCompte(w http.ResponseWriter, c *compte.CompteAdmin, err error) {
	switch {
	case errors.Is(err, nom.ErrNom):
		requeteFausse(w)
	case err != nil:
		erreurAction(w, err)
	case c == nil:
		write(w, http.StatusOK, []byte(`{"introuvable":true}`))
	default:
		writeJSON(w, struct {
			Compte compteVue `json:"compte"`
		}{a.vuesComptes([]compte.CompteAdmin{*c})[0]})
	}
}

// compteDeRef : h du compte de la ref (22 caractères base64url) ; faux si mal formée.
func (a *admin) compteDeRef(ref string) (h [16]byte, forme, trouve bool) {
	var k [16]byte
	if len(ref) != 22 {
		return h, false, false
	}
	if n, err := b64.Strict().Decode(k[:], []byte(ref)); err != nil || n != 16 {
		return h, false, false
	}
	cle, ok := a.refsComptes.trouver(k, a.now())
	if !ok || len(cle) != 16 {
		return h, true, false
	}
	copy(h[:], cle)
	return h, true, true
}

func (a *admin) surMesure(w http.ResponseWriter, r *http.Request) {
	sm := a.c.Comptes.SurMesure
	switch r.URL.Path {
	case "/api/comptes/chercher":
		var q struct {
			Pseudo string `json:"pseudo"`
		}
		tampon, ok := lireJSON(r, &q)
		clear(tampon)
		if !ok || q.Pseudo == "" {
			requeteFausse(w)
			return
		}
		c, err := sm.Chercher(q.Pseudo)
		a.repondreCompte(w, c, err)
	case "/api/comptes/surmesure":
		l, err := sm.Liste()
		if err != nil {
			erreurAction(w, err)
			return
		}
		writeJSON(w, struct {
			Comptes []compteVue `json:"comptes"`
		}{a.vuesComptes(l)})
	case "/api/comptes/surmesure/poser":
		var q struct {
			Ref    string `json:"ref"`
			Salons int    `json:"salons"`
			Places int    `json:"places"`
			Jours  int    `json:"jours"`
			Nom    string `json:"nom"`
		}
		tampon, ok := lireJSON(r, &q)
		clear(tampon)
		n, errN := nom.Propre(q.Nom)
		if !ok || errN != nil || n == "" || q.Salons < 1 || q.Salons > compte.SurMesureSalonsMax || q.Places < 2 ||
			q.Places > compte.SurMesurePlacesMax || q.Jours < 1 || q.Jours > compte.SurMesureJoursMax {
			requeteFausse(w)
			return
		}
		h, forme, trouve := a.compteDeRef(q.Ref)
		if !forme {
			requeteFausse(w)
			return
		}
		if !trouve {
			erreurAction(w, ErrIntrouvable)
			return
		}
		c, err := sm.Poser(h, compte.SurMesure{Salons: q.Salons, Places: q.Places, Jours: q.Jours, Nom: n})
		a.repondreCompte(w, c, err)
	default: // "/api/comptes/surmesure/retirer"
		var q struct {
			Ref string `json:"ref"`
		}
		tampon, ok := lireJSON(r, &q)
		clear(tampon)
		h, forme, trouve := a.compteDeRef(q.Ref)
		if !ok || !forme {
			requeteFausse(w)
			return
		}
		if !trouve {
			erreurAction(w, ErrIntrouvable)
			return
		}
		c, err := sm.Retirer(h)
		a.repondreCompte(w, c, err)
	}
}

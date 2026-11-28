package api

import (
	"errors"
	"io"
	"net/http"

	"github.com/skoow/shhdrop/server/internal/share"
	"github.com/skoow/shhdrop/server/internal/token"
)

// Gestion par l'expéditeur (spec §32, §33) : le lien de gestion ne porte que S_gestion ; le
// partage est trouvé par V_gestion = SHA-256(S_gestion) (index unique). Toute erreur
// (secret mal formé, faux, partage mort) → 404 uniforme ou 400 de format, jamais un détail.

// manageSecret lit S_gestion (X-Shh-Manage, une seule fois, 43 caractères base64url) et
// exige un corps vide : rien d'autre ne transite par ces routes.
func manageSecret(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if _, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 0)); err != nil {
		return nil, errBadRequest
	}
	return headerSecret(r, "X-Shh-Manage")
}

// GET /api/manage/status : ouvertures utilisées, maximum, secondes restantes, état.
func (s *server) manageStatus(w http.ResponseWriter, r *http.Request) {
	sg, err := manageSecret(w, r)
	if err != nil {
		fail(w, err)
		return
	}
	st, err := s.svc.Status(sg)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		OpensUsed int    `json:"opens_used"`
		MaxOpens  int    `json:"max_opens"`
		ExpiresIn int64  `json:"expires_in_s"`
		State     string `json:"state"`
	}{st.OpensUsed, st.MaxOpens, secs(st.ExpiresIn), st.State})
}

// POST /api/manage/resume : l'expéditeur (S_gestion en en-tête, corps vide) reprend son envoi
// en cours après un redémarrage du serveur (D42-31) : jeton d'envoi neuf, valable jusqu'à
// l'échéance de l'envoi, et palier réservé. Tout ce qui a été acquitté avant est gardé ; le
// client renvoie seulement ce qui ne l'a pas été. Envoi inconnu, fini ou échu : 404, le client
// recommence. L'envoi rejoint les limites du jour sous l'adresse qui le reprend (les limites ne
// sont pas reprises), sans refus : rien n'est créé, rien de plus n'est réservé.
func (s *server) manageResume(w http.ResponseWriter, r *http.Request) {
	sg, err := manageSecret(w, r)
	if err != nil {
		fail(w, err)
		return
	}
	rp, err := s.svc.Resume(sg)
	if err != nil {
		fail(w, err)
		return
	}
	s.lim.ResumeUpload(ipOf(r), rp.ID, share.ContentBytes(rp.Bucket), int(rp.Tier))
	writeJSON(w, http.StatusOK, struct {
		Token    string `json:"upload_token"`
		Bucket   int    `json:"bucket"`
		Segments int    `json:"segments"`
	}{s.sig.Issue(token.Upload, rp.ID, 0, rp.Deadline), rp.Bucket, share.SegmentCount(rp.Bucket)})
}

// POST /api/manage/destroy : destruction par l'expéditeur (aussi l'abandon d'un envoi,
// en keepalive).
func (s *server) manageDestroy(w http.ResponseWriter, r *http.Request) {
	sg, err := manageSecret(w, r)
	if err != nil {
		fail(w, err)
		return
	}
	if err := s.svc.DestroyManaged(sg); err != nil {
		fail(w, err)
		return
	}
	s.usage.Destruction()
	w.WriteHeader(http.StatusNoContent)
}

// surveillerMax : partages suivis par une même surveillance (« Mes partages »).
const surveillerMax = 40

// suiviEtat : état d'un partage tel que le client le connaît, et tel que le serveur le rend.
// Introuvable (supprimé, échu, épuisé puis effacé) : State « absent », le reste à zéro.
type suiviEtat struct {
	OpensUsed int    `json:"opens_used"`
	MaxOpens  int    `json:"max_opens"`
	ExpiresIn int64  `json:"expires_in_s"`
	State     string `json:"state"`
}

// POST /api/manage/surveiller (décision du propriétaire, 28 novembre : « Mes partages » en
// direct) : corps {"suivis":[{"gestion":<S_gestion>, "opens_used":n, "state":"…"}]} (40 au plus).
// Répond tout de suite si l'état d'un des partages diffère de celui donné ; sinon attend un
// changement (ouverture consommée, disparition) jusqu'à 25 s, puis répond l'état présent de
// tous, dans l'ordre (le client compare et relance). Les secrets restent dans le corps (jamais
// dans l'adresse). Une seule place de surveillance par page (watchSlots : 2 par connexion).
func (s *server) manageSurveiller(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Suivis []struct {
			Gestion   string `json:"gestion"`
			OpensUsed int    `json:"opens_used"`
			State     string `json:"state"`
		} `json:"suivis"`
	}
	if err := readJSONMax(w, r, &b, 8<<10); err != nil {
		fail(w, err)
		return
	}
	if len(b.Suivis) == 0 || len(b.Suivis) > surveillerMax {
		fail(w, errBadRequest)
		return
	}
	sgs := make([][]byte, len(b.Suivis))
	for i, x := range b.Suivis {
		sg, err := secret(x.Gestion, 32)
		if err != nil {
			fail(w, err)
			return
		}
		sgs[i] = sg
	}
	release, ok := s.slot(w, r, s.watchSlots)
	if !ok {
		return
	}
	defer release()
	lire := func() ([]suiviEtat, error) {
		out := make([]suiviEtat, len(sgs))
		for i, sg := range sgs {
			st, err := s.svc.Status(sg)
			switch {
			case errors.Is(err, share.ErrNotFound):
				out[i] = suiviEtat{State: "absent"}
			case err != nil:
				return nil, err
			default:
				out[i] = suiviEtat{st.OpensUsed, st.MaxOpens, secs(st.ExpiresIn), st.State}
			}
		}
		return out, nil
	}
	differe := func(etats []suiviEtat) bool {
		for i, e := range etats {
			if e.OpensUsed != b.Suivis[i].OpensUsed || e.State != b.Suivis[i].State {
				return true
			}
		}
		return false
	}
	repondre := func(etats []suiviEtat) {
		writeJSON(w, http.StatusOK, struct {
			Etats []suiviEtat `json:"etats"`
		}{etats})
	}
	fin, stop := s.wait(watchHold)
	defer stop()
	for {
		// Canal pris AVANT la lecture : un changement entre les deux réveille quand même.
		chg := s.svc.Changement()
		etats, err := lire()
		if err != nil {
			fail(w, err)
			return
		}
		if differe(etats) {
			repondre(etats)
			return
		}
		select {
		case <-chg:
		case <-fin:
			repondre(etats)
			return
		case <-r.Context().Done():
			return
		}
	}
}

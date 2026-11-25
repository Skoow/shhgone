package api

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/skoow/shhdrop/server/internal/captcha"
	"github.com/skoow/shhdrop/server/internal/paiement"
	"github.com/skoow/shhdrop/server/internal/share"
)

// Routes du paiement (conception du paiement §2, §4, §5.6), enregistrées seulement avec
// SHH_PAIEMENT=1 (sinon la 404 uniforme des routes inconnues). Le pass n'est lu qu'ici
// (X-Shh-Pass, minimize_test.go), comme les en-têtes de signature des prestataires, copiés dans
// un en-tête neuf qui ne contient qu'eux avant d'être donnés au prestataire. Rien de la requête
// n'est gardé ni écrit (aucun journal).

type paiementAPI struct {
	*server
	p *paiement.Service
}

// maxWebhook : corps d'un webhook (conception §4.4).
const maxWebhook = 256 << 10

func (a paiementAPI) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/paiement", a.offre)
	mux.HandleFunc("POST /api/paiement/commande", a.commande)
	mux.HandleFunc("POST /api/paiement/etat", a.etat)
	mux.HandleFunc("POST /api/paiement/resilier", a.resilier)
	mux.HandleFunc("POST /api/paiement/webhook/{nom}", a.webhook)
	if a.p.Jetons() != nil {
		mux.HandleFunc("GET /api/paiement/jetons/cles", a.cles)
		mux.HandleFunc("POST /api/paiement/jetons", a.emettre)
	}
}

// cles : clés publiques des jetons d'aujourd'hui à J+7 (conception du paiement §7, S17) ; les
// mêmes pour tous, sans aucun en-tête lu.
func (a paiementAPI) cles(w http.ResponseWriter, _ *http.Request) {
	cl, err := a.p.Jetons().Cles()
	if err != nil {
		failPaiement(w, errInterne)
		return
	}
	type cle struct {
		Jour  string `json:"jour"`
		Offre string `json:"offre"`
		SPKI  string `json:"spki"`
	}
	out := make([]cle, len(cl))
	for i, c := range cl {
		out[i] = cle{time.Unix(c.Jour, 0).UTC().Format("2006-01-02"), c.Offre.String(), b64.EncodeToString(c.SPKI)}
	}
	writeJSON(w, http.StatusOK, struct {
		V        int    `json:"v"`
		Emetteur string `json:"emetteur"`
		Cles     []cle  `json:"cles"`
	}{1, a.p.Jetons().Emetteur(), out})
}

// emettre : jusqu'à 5 demandes de jetons (TokenRequest, base64url) signées en aveugle avec la clé
// du jour de la formule du pass ; réserve du pass décomptée. 409 aucun_jeton : pass inconnu,
// révoqué, échu ou réserve épuisée (du mois ou du jour).
func (a paiementAPI) emettre(w http.ResponseWriter, r *http.Request) {
	p, err := lirePass(r)
	if err != nil {
		failPaiement(w, err)
		return
	}
	var b struct {
		Requetes []string `json:"requetes"`
	}
	if err := readJSON(w, r, &b); err != nil || len(b.Requetes) == 0 || len(b.Requetes) > 5 {
		failPaiement(w, errBadRequest)
		return
	}
	reqs := make([][]byte, len(b.Requetes))
	for i, x := range b.Requetes {
		if reqs[i], err = b64.DecodeString(x); err != nil {
			failPaiement(w, errBadRequest)
			return
		}
	}
	sigs, offre, err := a.p.Jetons().Emettre(a.p, p, reqs)
	switch {
	case errors.Is(err, paiement.ErrPasDeJetons):
		writeErr(w, http.StatusConflict, "aucun_jeton")
		return
	case errors.Is(err, paiement.ErrJeton):
		failPaiement(w, errBadRequest)
		return
	case err != nil:
		failPaiement(w, errInterne)
		return
	}
	reps := make([]string, len(sigs))
	for i, s := range sigs {
		reps[i] = b64.EncodeToString(s)
	}
	writeJSON(w, http.StatusOK, struct {
		Offre    string   `json:"offre"`
		Reponses []string `json:"reponses"`
	}{offre.String(), reps})
}

// jetonDeCreation : « Authorization: PrivateToken token=<base64url> » (RFC 9577) sur
// POST /api/shares : formule du partage (jeton vérifié puis dépensé). Sans en-tête : gratuit.
// Paiement désactivé, jeton invalide ou déjà dépensé : erreur (400 uniforme).
func (s *server) jetonDeCreation(r *http.Request) (share.Tier, []byte, error) {
	v := r.Header.Values("Authorization")
	if len(v) == 0 {
		return share.Gratuit, nil, nil
	}
	if len(v) != 1 || s.jetons == nil {
		return 0, nil, errBadRequest
	}
	t, ok := strings.CutPrefix(v[0], "PrivateToken token=")
	if !ok {
		return 0, nil, errBadRequest
	}
	t = strings.TrimSuffix(strings.TrimPrefix(t, `"`), `"`)
	jeton, err := b64.DecodeString(t)
	if err != nil {
		return 0, nil, errBadRequest
	}
	o, err := s.jetons.Depenser(jeton)
	if err != nil {
		return 0, nil, errBadRequest
	}
	return share.Tier(o), jeton, nil
}

// rendreJeton : création refusée après la dépense (quota, place, conflit) : le jeton resert.
func (s *server) rendreJeton(jeton []byte) {
	if jeton != nil && s.jetons != nil {
		s.jetons.Rendre(jeton)
	}
}

var nomsMoyens = [...]string{"", "carte", "paypal", "crypto"}

func moyenDe(s string) (paiement.Moyen, bool) {
	for i, n := range nomsMoyens {
		if i > 0 && n == s {
			return paiement.Moyen(i), true
		}
	}
	return 0, false
}

// offre : moyens proposés par ce serveur, pays acceptés, droits « bientôt », régime de TVA et
// taux appliqué par pays (aucun secret ; la note de vente est faite sur l'appareil, §9.3).
func (a paiementAPI) offre(w http.ResponseWriter, _ *http.Request) {
	var moyens []string
	for _, m := range a.p.Moyens() {
		moyens = append(moyens, nomsMoyens[m])
	}
	type tva struct {
		Regime string           `json:"regime"`
		Taux   map[string]int64 `json:"taux"`
	}
	writeJSON(w, http.StatusOK, struct {
		V       int      `json:"v"`
		Moyens  []string `json:"moyens"`
		Pays    []string `json:"pays"`
		Bientot []string `json:"bientot"`
		TVA     tva      `json:"tva"`
	}{1, moyens, paiement.Pays(), paiement.Bientot, tva{a.p.Regime().String(), paiement.TauxAppliques(a.p.Regime())}})
}

// lirePass : X-Shh-Pass présent exactement une fois, 32 octets en base64url.
func lirePass(r *http.Request) (paiement.Pass, error) {
	v := r.Header.Values("X-Shh-Pass")
	if len(v) != 1 {
		return paiement.Pass{}, paiement.ErrPass
	}
	return paiement.PassDe(v[0])
}

// failPaiement : erreur → réponse fixe ; toute autre → 502 (prestataire injoignable) ou 500.
func failPaiement(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, paiement.ErrPass), errors.Is(err, paiement.ErrFormule), errors.Is(err, paiement.ErrPays),
		errors.Is(err, paiement.ErrRenonciation), errors.Is(err, paiement.ErrMoyen), errors.Is(err, errBadRequest),
		errors.Is(err, captcha.ErrInvalid):
		writeErr(w, http.StatusBadRequest, "bad_request")
	case errors.Is(err, paiement.ErrConflit):
		writeErr(w, http.StatusConflict, "conflit")
	case errors.Is(err, paiement.ErrAucunAbonnement):
		writeErr(w, http.StatusConflict, "aucun_abonnement")
	case errors.Is(err, paiement.ErrOccupe), errors.Is(err, paiement.ErrSuspendu):
		// Ventes suspendues par l'exploitant (tableau de bord) : la même réponse qu'un serveur
		// occupé, que le site sait déjà dire (« réessayer plus tard »).
		writeRetry(w, http.StatusServiceUnavailable, "busy", slotRetry)
	case errors.Is(err, errInterne):
		writeErr(w, http.StatusInternalServerError, "internal")
	default:
		// Prestataire injoignable ou réponse refusée : rien n'a été payé.
		writeErr(w, http.StatusBadGateway, "prestataire")
	}
}

func (a paiementAPI) commande(w http.ResponseWriter, r *http.Request) {
	p, err := lirePass(r)
	if err != nil {
		failPaiement(w, err)
		return
	}
	var b struct {
		Offre        string `json:"offre"`
		Jours        int    `json:"jours"`
		Renouvelle   bool   `json:"renouvelle"`
		Moyen        string `json:"moyen"`
		Pays         string `json:"pays"`
		Renonciation bool   `json:"renonciation"`
		Altcha       string `json:"altcha"`
		HP           string `json:"hp"`
		ShownAt      string `json:"shown_at"`
	}
	if err := readJSON(w, r, &b); err != nil {
		failPaiement(w, err)
		return
	}
	o, ok1 := paiement.OffreDe(b.Offre)
	m, ok2 := moyenDe(b.Moyen)
	if !ok1 || !ok2 {
		failPaiement(w, errBadRequest)
		return
	}
	// Preuve anti-robot (audit du 20 novembre, S2 ; conception du paiement §8), comme une
	// création de partage ou de salon : défi consommé, puis la limite par connexion et par /48.
	ip := ipOf(r)
	if err := a.antiRobot(b.Altcha, b.ShownAt, b.HP, ip); err != nil {
		failPaiement(w, err)
		return
	}
	if !a.lim.AllowCommande(ip) {
		writeLimit(w, a.lim.JoinRetry())
		return
	}
	url, err := a.p.Commander(r.Context(), p, paiement.Formule{Offre: o, Jours: b.Jours, Renouvelle: b.Renouvelle, Moyen: m},
		b.Pays, b.Renonciation)
	if err != nil {
		failPaiement(w, err)
		return
	}
	a.cap.RecordCreate(ip) // difficulté qui double pour l'heure suivante (§22 D4)
	writeJSON(w, http.StatusOK, struct {
		URL string `json:"url"`
	}{url})
}

// sansCorps : corps vide ou « {} » seulement.
func sansCorps(w http.ResponseWriter, r *http.Request) error {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSON))
	if err != nil || (len(b) != 0 && string(b) != "{}") {
		return errBadRequest
	}
	return nil
}

func (a paiementAPI) etat(w http.ResponseWriter, r *http.Request) {
	p, err := lirePass(r)
	if err == nil {
		err = sansCorps(w, r)
	}
	if err != nil {
		failPaiement(w, err)
		return
	}
	e, err := a.p.EtatDe(p)
	if err != nil {
		failPaiement(w, errInterne)
		return
	}
	var offre *string
	var fin *string
	droits := []string{}
	if e.Offre.Valide() {
		s := e.Offre.String()
		offre = &s
		if e.Etat == "payee" {
			droits = e.Offre.Detail().Droits
		}
	}
	if e.Fin > 0 {
		s := time.Unix(e.Fin, 0).UTC().Format("2006-01-02")
		fin = &s
	}
	writeJSON(w, http.StatusOK, struct {
		V          int      `json:"v"`
		Etat       string   `json:"etat"`
		Offre      *string  `json:"offre"`
		Fin        *string  `json:"fin"`
		Renouvelle bool     `json:"renouvelle"`
		Droits     []string `json:"droits"`
	}{1, e.Etat, offre, fin, e.Renouvelle, droits})
}

func (a paiementAPI) resilier(w http.ResponseWriter, r *http.Request) {
	p, err := lirePass(r)
	if err == nil {
		err = sansCorps(w, r)
	}
	if err != nil {
		failPaiement(w, err)
		return
	}
	if err := a.p.Resilier(r.Context(), p); err != nil {
		failPaiement(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// webhook : corps brut (≤ 256 Kio, lu en 10 s), en-têtes de signature seuls, puis le service.
// 200 : traité ou ignoré ; 400 : signature fausse ; 500 : à réessayer ; 503 : occupé.
func (a paiementAPI) webhook(w http.ResponseWriter, r *http.Request) {
	pr := a.p.PrestataireDe(r.PathValue("nom"))
	if pr == nil {
		writeErr(w, http.StatusNotFound, "not_found")
		return
	}
	// Place prise avant toute lecture (audit du 20 novembre, comme lire) : sans elle, des
	// centaines de corps de 256 Kio envoyés au ralenti tenaient la mémoire. Occupé : 503, le
	// prestataire réessaie.
	if r.ContentLength > maxWebhook {
		w.Header().Set("Connection", "close")
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	// Webhook PayPal (audit du 20 novembre, S3) : chacun peut coûter un appel sortant
	// authentifié ; limite propre à la route, avant toute lecture (PayPal réessaie après 429).
	ip := ipOf(r)
	if pr.Nom() == "paypal" && !a.lim.AllowWebhookPayPal(ip) {
		w.Header().Set("Connection", "close")
		writeLimit(w, a.lim.MinuteRetry())
		return
	}
	k64, k48 := a.lim.Key(ip) // clé HMAC du jour, jamais le préfixe en clair (22 novembre)
	rendre, errPlace := corpsWebhook.Acquire(k64, k48)
	if errPlace != nil {
		w.Header().Set("Connection", "close")
		writeRetry(w, http.StatusServiceUnavailable, "busy", slotRetry)
		return
	}
	defer rendre()
	rc := http.NewResponseController(w)
	if err := rc.SetReadDeadline(time.Now().Add(jsonReadTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	corps, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhook))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	// Noms écrits un à un (minimize_test.go : seuls des littéraux de la liste paiementHeaders).
	h := http.Header{}
	ajout := func(nom string, vals []string) {
		for _, v := range vals {
			h.Add(nom, v)
		}
	}
	ajout("Stripe-Signature", r.Header.Values("Stripe-Signature"))
	ajout("Paypal-Auth-Algo", r.Header.Values("Paypal-Auth-Algo"))
	ajout("Paypal-Cert-Url", r.Header.Values("Paypal-Cert-Url"))
	ajout("Paypal-Transmission-Id", r.Header.Values("Paypal-Transmission-Id"))
	ajout("Paypal-Transmission-Sig", r.Header.Values("Paypal-Transmission-Sig"))
	ajout("Paypal-Transmission-Time", r.Header.Values("Paypal-Transmission-Time"))
	ajout("X-Nowpayments-Sig", r.Header.Values("X-Nowpayments-Sig"))
	switch err := a.p.Webhook(r.Context(), pr, h, corps); {
	case err == nil:
		writeJSON(w, http.StatusOK, struct{}{})
	case errors.Is(err, paiement.ErrSignature):
		writeErr(w, http.StatusBadRequest, "bad_request")
	case errors.Is(err, paiement.ErrOccupe):
		writeRetry(w, http.StatusServiceUnavailable, "busy", slotRetry)
	default:
		writeErr(w, http.StatusInternalServerError, "internal")
	}
}

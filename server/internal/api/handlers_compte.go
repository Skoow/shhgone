package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/skoow/shhdrop/server/internal/limits"
	"io"
	"net/http"
	"time"

	"github.com/skoow/shhdrop/server/internal/captcha"
	"github.com/skoow/shhdrop/server/internal/compte"
)

// Routes du compte (conception du compte §8.6, §21.6.2 ; conception du compte par passkey §6.4),
// enregistrées seulement avec SHH_COMPTES=1 (sinon la 404 uniforme des routes inconnues). JSON
// strict, sans `null` dans les requêtes (absent ≠ null, §8.6) ; secrets en base64url sans
// bourrage de longueur exacte ; rien dans l'URL. Le jeton de session n'est lu qu'ici
// (X-Shh-Session, minimize_test.go) ; le serveur n'en garde que SHA-256. Ni sortie PRF, ni clé
// de récupération, ni K_compte ne passent par ces routes ; A_r seulement dans la requête recup.

type compteAPI struct {
	*server
	c *compte.Service
}

// Plafonds des corps : inscription/fin porte les deux coffres (256 Kio + 45 octets au plus
// chacun, 349 586 caractères en base64url) ; PUT d'un coffre, un seul.
const (
	maxInscriptionJSON = 1 << 20
	maxCoffreJSON      = 384 << 10
)

func (a compteAPI) routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/compte/inscription/debut", a.inscriptionDebut)
	mux.HandleFunc("POST /api/compte/inscription/fin", a.inscriptionFin)
	mux.HandleFunc("POST /api/compte/connexion/debut", a.connexionDebut)
	mux.HandleFunc("POST /api/compte/connexion/fin", a.connexionFin)
	mux.HandleFunc("POST /api/compte/recup", a.recup)
	// Lot S5 : passkeys du compte, réauthentification, nouvelle clé de récupération.
	mux.HandleFunc("POST /api/compte/reauth/debut", a.reauthDebut)
	mux.HandleFunc("POST /api/compte/reauth/fin", a.reauthFin)
	mux.HandleFunc("GET /api/compte/passkeys", a.passkeys)
	mux.HandleFunc("POST /api/compte/passkeys/debut", a.passkeysDebut)
	mux.HandleFunc("POST /api/compte/passkeys/fin", a.passkeysFin)
	mux.HandleFunc("POST /api/compte/passkeys/enveloppe", a.passkeysEnveloppe)
	mux.HandleFunc("POST /api/compte/passkeys/nommer", a.passkeysNommer)
	mux.HandleFunc("POST /api/compte/passkeys/retirer", a.passkeysRetirer)
	mux.HandleFunc("POST /api/compte/recup/renouveler", a.recupRenouveler)
	mux.HandleFunc("GET /api/compte/sessions", a.sessions)
	mux.HandleFunc("POST /api/compte/sessions/fermer", a.fermer)
	mux.HandleFunc("POST /api/compte/sessions/etiquette", a.etiquette)
	mux.HandleFunc("POST /api/compte/deconnexion", a.deconnexion)
	mux.HandleFunc("GET /api/compte/coffre/profil", a.lireCoffre(compte.Profil))
	mux.HandleFunc("PUT /api/compte/coffre/profil", a.ecrireCoffre(compte.Profil))
	mux.HandleFunc("GET /api/compte/coffre/prive", a.lireCoffre(compte.Prive))
	mux.HandleFunc("PUT /api/compte/coffre/prive", a.ecrireCoffre(compte.Prive))
	mux.HandleFunc("POST /api/compte/pseudo/verifier", a.pseudoVerifier)
	mux.HandleFunc("POST /api/compte/pseudo", a.pseudo)
	mux.HandleFunc("POST /api/compte/pseudo/libre", a.pseudoInvite)
	mux.HandleFunc("GET /api/compte", a.etat)
	mux.HandleFunc("GET /api/compte/export", a.export)
	mux.HandleFunc("POST /api/compte/supprimer", a.supprimer)
	// Lot 6 : salons vivants créés par le compte, désignés par une ref éphémère.
	mux.HandleFunc("GET /api/compte/salons", a.salons)
	mux.HandleFunc("POST /api/compte/salons/detruire", a.salonsDetruire)
}

// failCompte : erreur du service → réponse fixe (§8.6) ; toute autre → 500 sans détail.
func failCompte(w http.ResponseWriter, err error) {
	var lim compte.ErrLimit
	var bn compte.ErrBanni
	var cl compte.ErrConflit
	switch {
	case errors.As(err, &lim):
		writeLimit(w, lim.Retry)
	case errors.As(err, &bn):
		writeJSON(w, http.StatusForbidden, struct {
			Error string `json:"error"`
			Jusqu string `json:"jusqu"`
		}{"banni", bn.Jusqu})
	case errors.As(err, &cl):
		writeJSON(w, http.StatusConflict, struct {
			Error string `json:"error"`
			Gen   uint64 `json:"gen"`
		}{"conflict", cl.Gen})
	case errors.Is(err, compte.ErrRequete), errors.Is(err, errBadRequest), errors.Is(err, captcha.ErrInvalid):
		writeErr(w, http.StatusBadRequest, "bad_request")
	case errors.Is(err, compte.ErrSession):
		writeErr(w, http.StatusUnauthorized, "session")
	case errors.Is(err, compte.ErrIdentifiants):
		writeErr(w, http.StatusForbidden, "identifiants")
	case errors.Is(err, compte.ErrRecent):
		writeErr(w, http.StatusForbidden, "recent")
	case errors.Is(err, compte.ErrEtape):
		writeErr(w, http.StatusNotFound, "not_found")
	case errors.Is(err, compte.ErrDerniere):
		writeErr(w, http.StatusConflict, "derniere")
	case errors.Is(err, compte.ErrPasskeysMax):
		writeErr(w, http.StatusConflict, "passkeys_max")
	case errors.Is(err, compte.ErrEnveloppesMax):
		writeErr(w, http.StatusConflict, "enveloppes_max")
	case errors.Is(err, compte.ErrSansPasskey):
		writeErr(w, http.StatusForbidden, "sans_passkey")
	case errors.Is(err, compte.ErrPseudoPris):
		writeErr(w, http.StatusConflict, "pseudo_pris")
	case errors.Is(err, compte.ErrBusy):
		writeRetry(w, http.StatusServiceUnavailable, "busy", slotRetry)
	default:
		writeErr(w, http.StatusInternalServerError, "internal")
	}
}

// lire : corps JSON strict (readJSONMax) et sans aucun `null`. Même échéance de lecture que
// readJSONMax (audit du 13 novembre, D5), posée avant la première lecture.
//
// Gros corps (max au-delà de maxJSON : coffres, fin d'inscription, récupération ; audit du
// 20 novembre) : le jeton est dans le corps, donc tout est lu avant de pouvoir refuser. Sans
// borne, quelques centaines de connexions tenaient chacune 1 Mio pendant l'échéance de lecture
// et faisaient tuer le serveur par le noyau. Trois garde-fous avant la première lecture :
// longueur annoncée exigée et sous le plafond (pas d'envoi par blocs), et une place de
// grosCorps (16 en tout, 2 par connexion, 4 par bloc /48), sinon 503 busy et connexion fermée :
// lireGros seulement, lire refuse un tel plafond (erreur de programmation).
func lire(w http.ResponseWriter, r *http.Request, v any, max int64) error {
	if max > maxJSON {
		panic("api : gros corps lu sans place (lireGros)")
	}
	return lireCorps(w, r, v, max)
}

// lireGros : lire, avec les garde-fous des gros corps. Places tenues sous la clé HMAC du jour du
// limiteur (inventaire des adresses IP du 22 novembre) : jamais le préfixe /64 ou /48 en clair
// comme clé de table.
func (s *server) lireGros(w http.ResponseWriter, r *http.Request, v any, max int64) error {
	if max > maxJSON {
		if r.ContentLength < 0 || r.ContentLength > max {
			w.Header().Set("Connection", "close")
			return errBadRequest
		}
		k64, k48 := s.lim.Key(ipOf(r))
		rendre, err := grosCorps.Acquire(k64, k48)
		if err != nil {
			w.Header().Set("Connection", "close")
			return compte.ErrBusy
		}
		defer rendre()
	}
	return lireCorps(w, r, v, max)
}

func lireCorps(w http.ResponseWriter, r *http.Request, v any, max int64) error {
	rc := http.NewResponseController(w)
	if err := rc.SetReadDeadline(time.Now().Add(jsonReadTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return errBadRequest
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, max))
	if err != nil || sansNull(body) != nil {
		return errBadRequest
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return readJSONMax(w, r, v, max)
}

// grosCorps : lectures simultanées de gros corps JSON, pour tout le processus (au pire
// 16 × 1 Mio lus, plus leurs copies de décodage : quelques dizaines de Mio).
var grosCorps = limits.NewSlots(16, 2, 4)

// corpsWebhook : lectures simultanées de webhooks de paiement (256 Kio chacun). Les
// prestataires envoient depuis peu d'adresses : 4 par connexion.
var corpsWebhook = limits.NewSlots(8, 4, 8)

func sansNull(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	for {
		tok, err := dec.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil || tok == nil {
			return errBadRequest
		}
	}
}

// session : la session de X-Shh-Session (absente, mal formée, inconnue, échue : 401).
func (a compteAPI) session(r *http.Request) (compte.Courante, error) {
	tok, err := headerSecret(r, "X-Shh-Session")
	if err != nil {
		return compte.Courante{}, compte.ErrSession
	}
	return a.c.Session([32]byte(tok))
}

// sessionCreation : la session de X-Shh-Session pour POST /api/salons (SHH_COMPTES=1), seule
// route hors de /api/compte/* où ce jeton part (conception du compte §8.5 ; appelée seulement
// par salonAPI.creer, TestSessionJamaisLueAilleurs).
func sessionCreation(c *compte.Service, r *http.Request) (compte.Courante, error) {
	return compteAPI{c: c}.session(r)
}

func b32(s string) ([32]byte, error) {
	b, err := secret(s, 32)
	if err != nil {
		return [32]byte{}, err
	}
	return [32]byte(b), nil
}

// options : persistante (exigée) et étiquette ("" : aucune ; sinon 64 octets).
func options(pers *bool, etiq *string) (compte.OptionsSession, error) {
	if pers == nil || etiq == nil {
		return compte.OptionsSession{}, errBadRequest
	}
	o := compte.OptionsSession{Persistante: *pers}
	if *etiq != "" {
		var err error
		if o.Etiquette, err = secret(*etiq, 64); err != nil {
			return o, err
		}
	}
	return o, nil
}

// recup : { a_r, persistante, etiquette } → { session, h, env_r, blob_profil, gen_profil,
// blob_prive, gen_prive } (conception du compte par passkey §6.4) ; session récente, marquée
// « ouverte par la clé de récupération ». A_r n'est gardé nulle part (tampon effacé).
func (a compteAPI) recup(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AR          string  `json:"a_r"`
		Persistante *bool   `json:"persistante"`
		Etiquette   *string `json:"etiquette"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	aR, err := b32(b.AR)
	b.AR = ""
	o, err2 := options(b.Persistante, b.Etiquette)
	if err != nil || err2 != nil {
		failCompte(w, errBadRequest)
		return
	}
	ov, err := a.c.Recup(ipOf(r), aR, o)
	clear(aR[:])
	if err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Session    string `json:"session"`
		H          string `json:"h"`
		EnvR       string `json:"env_r"`
		BlobProfil string `json:"blob_profil"`
		GenProfil  uint64 `json:"gen_profil"`
		BlobPrive  string `json:"blob_prive"`
		GenPrive   uint64 `json:"gen_prive"`
	}{b64.EncodeToString(ov.Jeton[:]), b64.EncodeToString(ov.H[:]), b64.EncodeToString(ov.EnvR),
		b64.EncodeToString(ov.BlobProfil), ov.GenProfil, b64.EncodeToString(ov.BlobPrive), ov.GenPrive})
}

type sessionJSON struct {
	Sid         string `json:"sid"`
	Ajoutee     string `json:"ajoutee"`
	Etiquette   string `json:"etiquette"`
	Courante    bool   `json:"courante"`
	Persistante bool   `json:"persistante"`
	ParRecup    bool   `json:"par_recup"`
}

func (a compteAPI) sessions(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	vs, err := a.c.Sessions(c)
	if err != nil {
		failCompte(w, err)
		return
	}
	out := make([]sessionJSON, 0, len(vs))
	for _, v := range vs {
		out = append(out, sessionJSON{b64.EncodeToString(v.Sid[:]), v.Ajoutee, b64.EncodeToString(v.Etiquette),
			v.Courante, v.Persistante, v.ParRecup})
	}
	writeJSON(w, http.StatusOK, struct {
		Sessions []sessionJSON `json:"sessions"`
	}{out})
}

// fermer : { sid } ou { autres: true }, exactement l'un des deux.
func (a compteAPI) fermer(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	var b struct {
		Sid    *string `json:"sid"`
		Autres *bool   `json:"autres"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil || (b.Sid == nil) == (b.Autres == nil) || (b.Autres != nil && !*b.Autres) {
		failCompte(w, errBadRequest)
		return
	}
	if b.Autres != nil {
		err = a.c.FermerAutres(c)
	} else {
		var sid []byte
		if sid, err = secret(*b.Sid, 16); err == nil {
			err = a.c.FermerSession(c, [16]byte(sid))
		}
	}
	if err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

// etiquette : { etiquette } (64 octets chiffrés par l'appareil) → {} ; nom d'appareil de la
// session courante, posé après la connexion (lot 10 : K_etiquette vient de K_compte, que
// l'appareil n'a qu'après la réponse de connexion).
func (a compteAPI) etiquette(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	var b struct {
		Etiquette string `json:"etiquette"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	etiq, err := secret(b.Etiquette, 64)
	if err != nil {
		failCompte(w, err)
		return
	}
	if err := a.c.EtiquetterSession(c, etiq); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

func (a compteAPI) deconnexion(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	var b struct{}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	if err := a.c.Deconnexion(c); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

func (a compteAPI) lireCoffre(sorte compte.Coffre) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := a.session(r)
		if err != nil {
			failCompte(w, err)
			return
		}
		blob, gen, err := a.c.LireCoffre(c, sorte)
		if err != nil {
			failCompte(w, err)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			Blob string `json:"blob"`
			Gen  uint64 `json:"gen"`
		}{b64.EncodeToString(blob), gen})
	}
}

func (a compteAPI) ecrireCoffre(sorte compte.Coffre) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := a.session(r)
		if err != nil {
			failCompte(w, err)
			return
		}
		var b struct {
			IfGen *uint64 `json:"if_gen"`
			Blob  string  `json:"blob"`
		}
		if err := a.lireGros(w, r, &b, maxCoffreJSON); err != nil || b.IfGen == nil {
			failCompte(w, errBadRequest)
			return
		}
		blob, err := b64.DecodeString(b.Blob)
		if err != nil {
			failCompte(w, errBadRequest)
			return
		}
		gen, err := a.c.EcrireCoffre(c, sorte, *b.IfGen, blob)
		if err != nil {
			failCompte(w, err)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			Gen uint64 `json:"gen"`
		}{gen})
	}
}

// pseudoVerifier : { p_canon } avec une session, ou { etape, p_canon } pendant l'inscription.
func (a compteAPI) pseudoVerifier(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Etape  *string `json:"etape"`
		PCanon string  `json:"p_canon"`
	}
	var c compte.Courante
	var err error
	if len(r.Header.Values("X-Shh-Session")) != 0 {
		if c, err = a.session(r); err != nil {
			failCompte(w, err)
			return
		}
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	var libre bool
	switch {
	case b.Etape != nil:
		var e [32]byte
		if e, err = b32(*b.Etape); err == nil {
			libre, err = a.c.PseudoVerifierEtape(e, []byte(b.PCanon))
		}
	case c.H != [16]byte{}:
		libre, err = a.c.PseudoVerifier(c, []byte(b.PCanon))
	default:
		err = compte.ErrSession
	}
	if err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Libre bool `json:"libre"`
	}{libre})
}

// pseudoInvite : { p_canon } → { libre }, pour l'invité d'un salon (sans compte ni salon).
func (a compteAPI) pseudoInvite(w http.ResponseWriter, r *http.Request) {
	var b struct {
		PCanon string `json:"p_canon"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	libre, err := a.c.PseudoVerifierInvite(ipOf(r), []byte(b.PCanon))
	if err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Libre bool `json:"libre"`
	}{libre})
}

func (a compteAPI) pseudo(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	var b struct {
		PCanon string `json:"p_canon"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	if err := a.c.ChangerPseudo(c, []byte(b.PCanon)); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

// ouNull : chaîne vide → null (absent ≠ null : ces champs sont toujours présents).
func ouNull(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func motifOuNull(m uint8) *uint8 {
	if m == 0 {
		return nil
	}
	return &m
}

// etat : GET /api/compte (§8.6, §21.6.2).
func (a compteAPI) etat(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	et, err := a.c.Etat(c)
	if err != nil {
		failCompte(w, err)
		return
	}
	type limites struct {
		Salons int `json:"salons"`
		Places int `json:"places"`
		Heures int `json:"heures"`
	}
	writeJSON(w, http.StatusOK, struct {
		H            string  `json:"h"`
		CreeLe       string  `json:"cree_le"`
		Palier       string  `json:"palier"`
		ConfirmeLe   *string `json:"confirme_le"`
		Limites      limites `json:"limites"`
		SalonsActifs int     `json:"salons_actifs"`
		Banni        bool    `json:"banni"`
		BanniID      *string `json:"banni_id"`
		BanniJusqu   *string `json:"banni_jusqu"`
		BanniMotif   *uint8  `json:"banni_motif"`
	}{b64.EncodeToString(et.H[:]), et.CreeLe, et.Palier, ouNull(et.ConfirmeLe),
		limites{et.Limites.Salons, et.Limites.Places, et.Limites.Heures}, et.SalonsActifs, et.Banni,
		ouNull(et.BanniID), ouNull(et.BanniJusqu), motifOuNull(et.BanniMotif)})
}

// export : GET export (§12.4 ; conception du compte par passkey §3.6) : données du serveur :
// dates, appareils (au mois, « Rester connecté », ouverts par la clé de récupération), passkeys
// (mois, liée ou synchronisable, avec ou sans enveloppe PRF, clé publique COSE en base64url pour
// la portabilité), salons, bannissement. Ni empreinte, ni enveloppe, ni coffre.
func (a compteAPI) export(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	x, err := a.c.Export(c)
	if err != nil {
		failCompte(w, err)
		return
	}
	type appareil struct {
		Ajoutee     string `json:"ajoutee"`
		Persistante bool   `json:"persistante"`
		ParRecup    bool   `json:"par_recup"`
	}
	type passkey struct {
		Ajoutee string `json:"ajoutee"`
		BE      bool   `json:"be"`
		PRF     bool   `json:"prf"`
		ClePub  string `json:"cle_pub"`
	}
	ss := make([]appareil, 0, len(x.Sessions))
	for _, v := range x.Sessions {
		ss = append(ss, appareil{v.Ajoutee, v.Persistante, v.ParRecup})
	}
	ps := make([]passkey, 0, len(x.Passkeys))
	for _, v := range x.Passkeys {
		ps = append(ps, passkey{v.Ajoutee, v.BE, v.PRF, b64.EncodeToString(v.ClePub)})
	}
	writeJSON(w, http.StatusOK, struct {
		CreeLe           string     `json:"cree_le"`
		AncienneteDepuis string     `json:"anciennete_depuis"`
		VuMois           string     `json:"vu_mois"`
		BanniJusqu       *string    `json:"banni_jusqu"`
		BanniMotif       *uint8     `json:"banni_motif"`
		SalonsActifs     int        `json:"salons_actifs"`
		Sessions         []appareil `json:"sessions"`
		Passkeys         []passkey  `json:"passkeys"`
	}{x.CreeLe, x.AncienneteDepuis, x.VuMois, ouNull(x.BanniJusqu), motifOuNull(x.BanniMotif), x.SalonsActifs, ss, ps})
}

// supprimer : {} → { salons_fermes } (session récente ; plus d'attente, 22 novembre).
func (a compteAPI) supprimer(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	var b struct{}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	n, err := a.c.Supprimer(c)
	if err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Salons int `json:"salons_fermes"`
	}{n})
}

// salons : GET /api/compte/salons (session) → { salons: [{ ref, expire_vers, places, sieges }] } :
// salons vivants créés par ce compte (conception §21.6.2) ; ref : 16 octets aléatoires, valables
// 10 min, en mémoire ; expire_vers : échéance au quart d'heure (« 2026-11-14T21:45Z », déjà la
// seule date de la ligne) ; places : max_members ; sieges : sièges occupés. Aucune valeur de la
// ligne du salon ne sort.
func (a compteAPI) salons(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	ls, err := a.c.SalonsListe(c)
	if err != nil {
		failCompte(w, err)
		return
	}
	type ligne struct {
		Ref        string `json:"ref"`
		ExpireVers string `json:"expire_vers"`
		Places     int    `json:"places"`
		Sieges     int    `json:"sieges"`
	}
	out := make([]ligne, 0, len(ls))
	for _, l := range ls {
		out = append(out, ligne{b64.EncodeToString(l.Ref[:]), time.Unix(l.ExpireVers, 0).UTC().Format("2006-01-02T15:04Z"),
			l.Places, l.Sieges})
	}
	writeJSON(w, http.StatusOK, struct {
		Salons []ligne `json:"salons"`
	}{out})
}

// salonsDetruire : POST /api/compte/salons/detruire (session) { ref } → {} : même effet que
// « Détruire » du créateur. Ref inconnue, échue, d'un autre compte, salon fini : 404 not_found.
func (a compteAPI) salonsDetruire(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	var b struct {
		Ref string `json:"ref"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	ref, err := secret(b.Ref, 16)
	if err != nil {
		failCompte(w, errBadRequest)
		return
	}
	if err := a.c.DetruireParRef(c, [16]byte(ref)); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

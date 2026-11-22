package adminui

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/courriel"
)

// Tableau de bord finalisé (conception du compte §21.14 ; plan lot 7) : salons signalés en
// cours, désignés par une ref éphémère ; bannissements ; agrégats des comptes. Rien qui
// désigne une personne ou un salon : ni adresse, ni empreinte, ni h, ni pseudo, ni lien, ni
// identifiant interne. Tout passe par le corps JSON des requêtes, jamais par l'URL.

// Signale : un salon vivant signalé, tel que cmd/shhdrop le lit. Cle : identifiant interne,
// gardé en mémoire derrière une ref, jamais rendu (aucune étiquette JSON, type non sérialisé).
// Createur : nil pour un salon sans compte (ou dont le compte n'existe plus).
type Signale struct {
	Cle            string
	Categories     [10]int
	Expire         time.Time
	Places, Sieges int
	Createur       *compte.CompteVue
	AutresSalons   int
}

// signaleVue : une ligne de GET /api/signalements.
type signaleVue struct {
	Ref          string            `json:"ref"`
	Categories   [10]int           `json:"categories"`
	Places       int               `json:"places"`
	Sieges       int               `json:"sieges"`
	Efface       string            `json:"efface"` // « moins_6h » ou « 6_24h » (jamais l'heure)
	Createur     *compte.CompteVue `json:"createur"`
	AutresSalons int               `json:"autres_salons"`
}

// Resultat : réponse d'une action sur un salon signalé ou d'un bannissement. Detruit
// (« salon », Reste : un effacement de fichier se finit en arrière-plan) ; Banni (« compte »,
// « adresse » : sans compte, ou « aucun » : salon sans compte), Ban ; Anciennete (« rendue »).
type Resultat struct {
	Detruit      string         `json:"detruit,omitempty"`
	Reste        bool           `json:"reste,omitempty"`
	Banni        string         `json:"banni,omitempty"`
	Ban          *compte.BanVue `json:"ban,omitempty"`
	SalonsFermes int            `json:"salons_fermes,omitempty"`
	Anciennete   string         `json:"anciennete,omitempty"`
}

// Agregats : GET /api/comptes : agrégats des comptes, salons vivants créés par un compte,
// envois d'e-mails.
type Agregats struct {
	compte.AgregatsComptes
	SalonsDeComptes int            `json:"salons_de_comptes"`
	Courriel        courriel.Stats `json:"courriel"`
}

// Comptes : crochets du compte (SHH_COMPTES=1 ; nil sinon : routes refusées comme inconnues).
// Les tampons email et lien sont effacés par la page au retour : les crochets n'en gardent
// aucune copie.
type Comptes struct {
	Agregats func() (Agregats, error)
	Liste    func(filtre string, page int) ([]compte.BanVue, int, error)
	Action   func(id, action, jusqu string) (avant compte.BanVue, apres *compte.BanVue, err error)
	Chercher func(email []byte) (*compte.BanVue, compte.CompteVue, error)
	// Bannir : exactement un de email et lien (lien d'invitation d'un salon).
	Bannir func(email, lien []byte, dureeJours int, motif uint8) (Resultat, error)
}

// dureeRef : une ref de salon signalé vaut 10 min (conception §21.14.3).
const dureeRef = 10 * time.Minute

// maxCorps : corps JSON d'une requête du lot 7 (une adresse ou un lien au plus).
const maxCorps = 8 << 10

// refs : ref aléatoire (16 octets) → identifiant interne d'un salon signalé, en mémoire,
// 10 min ; la même ref pour le même salon tant qu'elle vaut. Perdu au redémarrage.
type refs struct {
	mu sync.Mutex
	m  map[[16]byte]refSalon
}

type refSalon struct {
	cle    string
	expire time.Time
}

// attribuer : ref de chaque clé (refs échues oubliées ici).
func (r *refs) attribuer(cles []string, now time.Time) [][16]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m == nil {
		r.m = map[[16]byte]refSalon{}
	}
	existantes := map[string][16]byte{}
	for k, v := range r.m {
		if !now.Before(v.expire) {
			delete(r.m, k)
		} else {
			existantes[v.cle] = k
		}
	}
	out := make([][16]byte, len(cles))
	for i, c := range cles {
		k, ok := existantes[c]
		if !ok {
			rand.Read(k[:])
			r.m[k] = refSalon{cle: c, expire: now.Add(dureeRef)}
			existantes[c] = k
		}
		out[i] = k
	}
	return out
}

func (r *refs) trouver(k [16]byte, now time.Time) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.m[k]
	if !ok || !now.Before(v.expire) {
		return "", false
	}
	return v.cle, true
}

var b64 = base64.RawURLEncoding

func grave(c [10]int) bool { return c[0]+c[1] > 0 }

func total(c [10]int) (n int) {
	for _, x := range c {
		n += x
	}
	return n
}

func (a *admin) now() time.Time {
	if a.c.Now != nil {
		return a.c.Now()
	}
	return time.Now()
}

// signalements : salons signalés en cours ; codes 1 et 2 d'abord, puis par nombre.
func (a *admin) signalements(w http.ResponseWriter) {
	ss, err := a.c.Signales()
	if err != nil {
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
		return
	}
	sort.SliceStable(ss, func(i, j int) bool {
		if gi, gj := grave(ss[i].Categories), grave(ss[j].Categories); gi != gj {
			return gi
		}
		return total(ss[i].Categories) > total(ss[j].Categories)
	})
	now := a.now()
	cles := make([]string, len(ss))
	for i, s := range ss {
		cles[i] = s.Cle
	}
	ks := a.refs.attribuer(cles, now)
	out := make([]signaleVue, len(ss))
	for i, s := range ss {
		e := "6_24h"
		if s.Expire.Sub(now) < 6*time.Hour {
			e = "moins_6h"
		}
		out[i] = signaleVue{Ref: b64.EncodeToString(ks[i][:]), Categories: s.Categories, Places: s.Places, Sieges: s.Sieges,
			Efface: e, Createur: s.Createur, AutresSalons: s.AutresSalons}
	}
	writeJSON(w, struct {
		Salons []signaleVue `json:"salons"`
	}{out})
}

// lireJSON : corps lu dans UN tampon de taille fixe (effacé par l'appelant via le retour),
// décodé strictement (champ inconnu, valeur de trop, type faux : refus).
func lireJSON(r *http.Request, v any) (tampon []byte, ok bool) {
	tampon = make([]byte, maxCorps+1)
	n, err := io.ReadFull(r.Body, tampon)
	if (err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF)) || n > maxCorps {
		return tampon, false
	}
	d := json.NewDecoder(bytes.NewReader(tampon[:n]))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.More() {
		return tampon, false
	}
	return tampon, true
}

// brut : contenu d'une chaîne JSON sans échappement (une adresse ou un lien n'en ont pas
// besoin) ni caractère de contrôle, en octets (sous-tranche de m, effacée avec lui) ; nil si
// absente ou d'une autre forme.
func brut(m json.RawMessage) ([]byte, bool) {
	if m == nil {
		return nil, true
	}
	if len(m) < 3 || m[0] != '"' || m[len(m)-1] != '"' {
		return nil, false
	}
	s := m[1 : len(m)-1]
	for _, c := range s {
		if c == '\\' || c == '"' || c < 0x20 {
			return nil, false
		}
	}
	return s, true
}

func dureeOK(j int) bool { return j == 30 || j == 365 || j == 1095 }

func motifOK(m uint8) bool { return m >= 1 && m <= 10 }

// erreurAction : réponse d'une action refusée ou échouée. « Introuvable » répond 200 : un
// 404 se confondrait avec le refus uniforme, qui fait oublier le jeton à la page.
func erreurAction(w http.ResponseWriter, err error) {
	var deja compte.ErrDejaBanni
	var lim compte.ErrLimit
	switch {
	case errors.Is(err, compte.ErrRequete):
		write(w, http.StatusBadRequest, []byte(`{"error":"bad_request"}`))
	case errors.Is(err, compte.ErrAdresse):
		write(w, http.StatusBadRequest, []byte(`{"error":"adresse_invalide"}`))
	case errors.Is(err, ErrLienInvalide):
		write(w, http.StatusBadRequest, []byte(`{"error":"lien_invalide"}`))
	case errors.Is(err, ErrIntrouvable), errors.Is(err, compte.ErrEtape):
		write(w, http.StatusOK, []byte(`{"introuvable":true}`))
	case errors.As(err, &lim):
		write(w, http.StatusTooManyRequests, []byte(`{"error":"limit"}`))
	case errors.As(err, &deja):
		b, _ := json.Marshal(struct {
			Error string        `json:"error"`
			Ban   compte.BanVue `json:"ban"`
		}{"deja_banni", deja.Vue})
		write(w, http.StatusConflict, b)
	default:
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
	}
}

func requeteFausse(w http.ResponseWriter) {
	write(w, http.StatusBadRequest, []byte(`{"error":"bad_request"}`))
}

// actionSalon : { ref, action: "detruire"|"bannir"|"anciennete", duree_jours?, motif? }.
func (a *admin) actionSalon(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Ref    string `json:"ref"`
		Action string `json:"action"`
		Duree  int    `json:"duree_jours"`
		Motif  uint8  `json:"motif"`
	}
	tampon, ok := lireJSON(r, &q)
	clear(tampon)
	var k [16]byte
	if ok = ok && len(q.Ref) == 22; ok { // longueur d'abord : Decode écrirait au-delà de k
		n, err := b64.Strict().Decode(k[:], []byte(q.Ref))
		ok = err == nil && n == 16
	}
	switch {
	case !ok:
	case q.Action == "bannir":
		ok = dureeOK(q.Duree) && motifOK(q.Motif)
	case q.Action == "detruire", q.Action == "anciennete":
		ok = q.Duree == 0 && q.Motif == 0
	default:
		ok = false
	}
	if !ok {
		requeteFausse(w)
		return
	}
	cle, ok := a.refs.trouver(k, a.now())
	if !ok {
		erreurAction(w, ErrIntrouvable)
		return
	}
	res, err := a.c.ActionSalon(cle, q.Action, q.Duree, q.Motif)
	if err != nil {
		erreurAction(w, err)
		return
	}
	writeJSON(w, res)
}

// bannisListe : { filtre, page } (dans le corps : aucun paramètre d'URL n'est accepté).
func (a *admin) bannisListe(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Filtre string `json:"filtre"`
		Page   int    `json:"page"`
	}
	tampon, ok := lireJSON(r, &q)
	clear(tampon)
	if !ok {
		requeteFausse(w)
		return
	}
	l, tot, err := a.c.Comptes.Liste(q.Filtre, q.Page)
	if err != nil {
		erreurAction(w, err)
		return
	}
	writeJSON(w, struct {
		Bannis  []compte.BanVue `json:"bannis"`
		Total   int             `json:"total"`
		Page    int             `json:"page"`
		ParPage int             `json:"par_page"`
	}{l, tot, q.Page, 50})
}

// bannisAction : { id, action, jusqu? } ; rend l'état d'avant et d'après (null : effacé).
func (a *admin) bannisAction(w http.ResponseWriter, r *http.Request) {
	var q struct {
		ID     string `json:"id"`
		Action string `json:"action"`
		Jusqu  string `json:"jusqu"`
	}
	tampon, ok := lireJSON(r, &q)
	clear(tampon)
	if !ok {
		requeteFausse(w)
		return
	}
	avant, apres, err := a.c.Comptes.Action(q.ID, q.Action, q.Jusqu)
	if err != nil {
		erreurAction(w, err)
		return
	}
	writeJSON(w, struct {
		Avant compte.BanVue  `json:"avant"`
		Apres *compte.BanVue `json:"apres"`
	}{avant, apres})
}

// bannisChercher : { email } → { ban (ou null), compte }. L'adresse : en octets, tampons
// effacés au retour ; jamais reprise dans la réponse.
func (a *admin) bannisChercher(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Email json.RawMessage `json:"email"`
	}
	tampon, ok := lireJSON(r, &q)
	defer clear(tampon)
	defer clear(q.Email)
	e, okE := brut(q.Email)
	if !ok || !okE || len(e) == 0 {
		requeteFausse(w)
		return
	}
	b, c, err := a.c.Comptes.Chercher(e)
	if err != nil {
		erreurAction(w, err)
		return
	}
	writeJSON(w, struct {
		Ban    *compte.BanVue   `json:"ban"`
		Compte compte.CompteVue `json:"compte"`
	}{b, c})
}

// bannir : { email | lien, duree_jours, motif }.
func (a *admin) bannir(w http.ResponseWriter, r *http.Request) {
	var q struct {
		Email json.RawMessage `json:"email"`
		Lien  json.RawMessage `json:"lien"`
		Duree int             `json:"duree_jours"`
		Motif uint8           `json:"motif"`
	}
	tampon, ok := lireJSON(r, &q)
	defer clear(tampon)
	defer clear(q.Email)
	defer clear(q.Lien)
	e, okE := brut(q.Email)
	l, okL := brut(q.Lien)
	if !ok || !okE || !okL || (e == nil) == (l == nil) || !dureeOK(q.Duree) || !motifOK(q.Motif) {
		requeteFausse(w)
		return
	}
	res, err := a.c.Comptes.Bannir(e, l, q.Duree, q.Motif)
	if err != nil {
		erreurAction(w, err)
		return
	}
	writeJSON(w, res)
}

func (a *admin) comptes(w http.ResponseWriter) {
	ag, err := a.c.Comptes.Agregats()
	if err != nil {
		write(w, http.StatusInternalServerError, []byte(`{"error":"internal"}`))
		return
	}
	writeJSON(w, ag)
}

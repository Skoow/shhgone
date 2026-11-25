package api

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // HMAC-SHA1 imposé par le protocole TURN (identifiants temporaires « REST »), pas un choix
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/skoow/shhdrop/server/internal/paiement"
	"github.com/skoow/shhdrop/server/internal/salon"
	"github.com/skoow/shhdrop/server/internal/share"
)

// Appels audio et vidéo du salon (conception des appels, 20 novembre). Le serveur ne voit ni
// le son, ni l'image, ni la signalisation (messages du salon, chiffrés par MLS) : il donne
// seulement à un membre des identifiants temporaires du relais TURN, par où passe tout le
// média (jamais en direct entre participants : l'adresse IP de chacun resterait visible des
// autres, spec §39.3.1).
//
// Identifiants temporaires (mécanisme « REST » de TURN, vérifié par deploy/shhcheck/turn.go) : nom = « <échéance
// Unix>:<16 octets aléatoires en hex> », mot de passe = base64(HMAC-SHA1(secret partagé, nom)).
// Le nom ne porte ni salon, ni siège, ni compte : le relais ne peut relier une session à
// personne. Rien n'est écrit sur disque.

// Turn : relais des appels. Secret : secret partagé avec le relais (deploy/shhcheck/turn.go).
type Turn struct {
	URLs   []string
	Secret []byte
	// Now : horloge (tests) ; nil : time.Now.
	Now func() time.Time
}

func (t Turn) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

func (t Turn) actif() bool { return len(t.URLs) != 0 && len(t.Secret) != 0 }

// turnTTL : durée de vie des identifiants. Le relais les vérifie à chaque renouvellement de
// l'allocation : un appel de plus de 6 heures est coupé (le client en redemande en rappelant).
const turnTTL = 6 * time.Hour

// identifiantsTurn : nom et mot de passe temporaires valables jusqu'à exp.
func identifiantsTurn(secret []byte, exp time.Time, alea []byte) (nom, mdp string) {
	nom = strconv.FormatInt(exp.Unix(), 10) + ":" + hex.EncodeToString(alea)
	mac := hmac.New(sha1.New, secret)
	mac.Write([]byte(nom))
	return nom, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// appels : les appels sont offerts par ce serveur : relais configuré ET jetons anonymes
// disponibles (SHH_PAIEMENT=1). Les appels sont réservés aux offres Plus et Pro (décision du
// propriétaire, 24 novembre ; conception des appels §5.1) : paiement fermé, personne ne
// pourrait en ouvrir, donc ni route ni boutons (`calls: false`), plutôt qu'une fonction
// montrée et impossible à obtenir.
func (a salonAPI) appels() bool { return a.turn.actif() && a.jetons != nil }

// errOffreRequise : appels fermés dans ce salon et aucun jeton présenté (402 offre_requise).
var errOffreRequise = errors.New("offre requise")

// appel : POST /api/salons/appel (X-Shh-Membre, corps {}, et facultatif « Authorization:
// PrivateToken token=<base64url> », RFC 9577) → {urls, username, credential, ttl_s}.
//
// Appels réservés aux offres payantes : tant que les appels du salon sont fermés, il faut un
// jeton anonyme d'une offre qui comprend `appel_audio` (Plus et Pro, offres.go) ; il est
// dépensé et ouvre les appels du salon jusqu'à sa fin, pour tous ses membres (le droit est
// celui du salon, jamais d'un pass ni d'un compte : conception du paiement §11). Appels déjà
// ouverts : aucun jeton n'est lu ni dépensé. Identifiants valables 6 h au plus, jamais au-delà
// de la fermeture des appels.
//
// En-tête absent ou mal formé, corps autre que {}, jeton invalide ou déjà dépensé, offre sans
// le droit : 400 ; jeton de membre inconnu, salon échu : 404 ; jeton révoqué : 403 excluded ;
// plus de 20 demandes par heure pour ce membre : 429 (avant toute dépense) ; appels fermés
// sans jeton : 402 offre_requise. Route absente (404 uniforme) sans relais ou sans paiement.
func (a salonAPI) appel(w http.ResponseWriter, r *http.Request) {
	var b struct{}
	if err := readJSON(w, r, &b); err != nil {
		failSalon(w, err)
		return
	}
	mb, jeton, err := a.membre(r)
	if err != nil {
		failSalon(w, err)
		return
	}
	v := share.Verifier(jeton)
	if !a.lim.AllowAppel(v[:]) {
		writeLimit(w, time.Hour)
		return
	}
	reste, ouverts, err := a.m.AppelsOuverts(mb)
	if err != nil {
		failSalon(w, err)
		return
	}
	if !ouverts {
		if reste, err = a.ouvrirAppels(r, mb); err != nil {
			if errors.Is(err, errOffreRequise) {
				writeErr(w, http.StatusPaymentRequired, "offre_requise")
				return
			}
			failSalon(w, err)
			return
		}
	}
	var alea [16]byte
	if _, err := rand.Read(alea[:]); err != nil {
		failSalon(w, err)
		return
	}
	ttl := min(turnTTL, reste).Truncate(time.Second)
	nom, mdp := identifiantsTurn(a.turn.Secret, a.turn.now().Add(ttl), alea[:])
	a.usage.IdentifiantsTurn()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
		TTL        int64    `json:"ttl_s"`
	}{a.turn.URLs, nom, mdp, int64(ttl / time.Second)})
}

// ouvrirAppels : dépense le jeton présenté (errOffreRequise sans en-tête) et ouvre les appels du
// salon de mb ; le jeton est rendu si son offre n'a pas le droit, si l'ouverture échoue, ou si un
// autre membre les a ouverts entre-temps. Rend le temps restant avant leur fermeture.
func (a salonAPI) ouvrirAppels(r *http.Request, mb salon.Membre) (time.Duration, error) {
	tier, jp, err := a.jetonDeCreation(r)
	if err != nil {
		return 0, err
	}
	if jp == nil {
		return 0, errOffreRequise
	}
	if !paiement.Offre(tier).A("appel_audio") {
		a.rendreJeton(jp)
		return 0, errBadRequest
	}
	reste, deja, err := a.m.OuvrirAppels(mb)
	if err != nil || deja {
		a.rendreJeton(jp)
	} else {
		a.usage.AppelsOuverts()
	}
	return reste, err
}

package api

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/limits"
)

// ---- Appels du salon : identifiants temporaires du relais (conception des appels), réservés
// aux offres Plus et Pro (conception des appels §5.1) ----

var secretTurn = []byte("0123456789abcdef0123456789abcdef")

var urlsTurn = []string{"turn:turn.example:3478?transport=udp", "turns:turn.example:5349?transport=tcp"}

// appelEnv : salons, paiement (jetons anonymes) et relais configurés ; un salon de 3 places où
// un membre est entré. Rend l'environnement, les clés du salon et le jeton de ce membre.
func appelEnv(t *testing.T) (envPaiement, keys, string) {
	t.Helper()
	e, m := salonEnv(t)
	s, p := servicePaiement(t, e)
	e.h = newHandler(e.srv, htmlStatic(), Salons{Origin: "https://shhdrop.app", M: m, Paiement: s,
		Turn: Turn{URLs: urlsTurn, Secret: secretTurn, Now: e.clk.Now}})
	k := newKeys()
	e.creerSalon(t, k, 3)
	return envPaiement{e, p}, k, entrerAppel(t, e, k)
}

// entrerAppel : un membre de plus ; le serveur annonce les appels.
func entrerAppel(t *testing.T, e *env, k keys) string {
	t.Helper()
	w := e.rejoindre(k, false)
	expect(t, w, 200, "")
	r := jsonOf(t, w)
	if r["calls"] != true {
		t.Fatalf("calls : %v", r["calls"])
	}
	return r["member_token"].(string)
}

func (e *env) appel(hdr map[string]string, body string) *httpResp {
	w := e.do(req{method: "POST", path: "/api/salons/appel", hdr: hdr, body: []byte(body)})
	return &httpResp{w.Code, w.Body.String()}
}

// avecJeton : en-têtes d'une demande d'identifiants qui présente un jeton anonyme.
func avecJeton(membre, jeton string) map[string]string {
	return map[string]string{"X-Shh-Membre": membre, "Authorization": "PrivateToken token=" + jeton}
}

const corpsPro = `{"offre":"pro","jours":30,"renouvelle":true,"moyen":"carte","pays":"FR","renonciation":true}`

// Sans relais configuré : la route n'existe pas (404 uniforme), même pour un membre.
func TestAppelSansRelais(t *testing.T) {
	e, _ := salonEnv(t)
	k := newKeys()
	e.creerSalon(t, k, 3)
	tok := jsonOf(t, e.rejoindre(k, false))["member_token"].(string)
	if r := e.appel(map[string]string{"X-Shh-Membre": tok}, `{}`); r.code != 404 || strings.TrimSpace(r.body) != notFound {
		t.Fatalf("sans relais : %d %q", r.code, r.body)
	}
}

// Relais configuré mais paiement fermé (SHH_PAIEMENT=0, la production d'aujourd'hui) : personne
// ne pourrait ouvrir d'appel, donc ni route ni annonce (`calls: false` : le site n'affiche pas
// les boutons).
func TestAppelSansPaiement(t *testing.T) {
	e, m := salonEnv(t)
	e.h = newHandler(e.srv, htmlStatic(), Salons{Origin: "https://shhdrop.app", M: m, Turn: Turn{URLs: urlsTurn, Secret: secretTurn}})
	k := newKeys()
	e.creerSalon(t, k, 3)
	w := e.rejoindre(k, false)
	r := jsonOf(t, w)
	if w.Code != 200 || r["calls"] != false {
		t.Fatalf("calls sans paiement : %d %v", w.Code, r["calls"])
	}
	tok := r["member_token"].(string)
	if r := e.appel(map[string]string{"X-Shh-Membre": tok}, `{}`); r.code != 404 || strings.TrimSpace(r.body) != notFound {
		t.Fatalf("sans paiement : %d %q", r.code, r.body)
	}
}

// Appels fermés : sans jeton, 402 offre_requise, et rien n'est ouvert.
func TestAppelReserveAuxOffres(t *testing.T) {
	e, _, tok := appelEnv(t)
	for i := 0; i < 2; i++ {
		if r := e.appel(map[string]string{"X-Shh-Membre": tok}, `{}`); r.code != 402 || strings.TrimSpace(r.body) != `{"error":"offre_requise"}` {
			t.Fatalf("sans jeton : %d %q", r.code, r.body)
		}
	}
}

// Un membre qui a Plus ouvre les appels avec un jeton (dépensé) ; ensuite tout membre du salon
// reçoit des identifiants sans jeton, jusqu'à la fin du salon et jamais au-delà ; un jeton
// présenté quand les appels sont ouverts n'est pas dépensé.
func TestAppelOuvertParUnJeton(t *testing.T) {
	e, k, tok := appelEnv(t)
	jetons := e.jetonsPour(t, e.passPaye(t, 1, corpsCommande), "plus", 3)

	w := e.do(req{method: "POST", path: "/api/salons/appel", hdr: avecJeton(tok, jetons[0]), body: []byte(`{}`)})
	expect(t, w, 200, "")
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control : %q", cc)
	}
	r := jsonOf(t, w)
	if got := clesDe(r); !reflect.DeepEqual(got, []string{"credential", "ttl_s", "urls", "username"}) {
		t.Fatalf("clés : %v", got)
	}
	// Salon d'une heure (quart d'heure supérieur) : identifiants jusqu'à sa fin, pas 6 h.
	ttl := int64(r["ttl_s"].(float64))
	if ttl < 3600 || ttl > 3600+900 {
		t.Fatalf("ttl_s : %d", ttl)
	}
	nom := r["username"].(string)
	// Échéance (horloge + ttl) et 16 octets aléatoires : ni salon, ni siège, ni jeton.
	if !regexp.MustCompile(`^` + strconv.FormatInt(e.clk.Now().Unix()+ttl, 10) + `:[0-9a-f]{32}$`).MatchString(nom) {
		t.Fatalf("username : %q", nom)
	}
	mac := hmac.New(sha1.New, secretTurn)
	mac.Write([]byte(nom))
	if r["credential"] != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
		t.Fatalf("credential : %v", r["credential"])
	}
	if !reflect.DeepEqual(r["urls"], []any{urlsTurn[0], urlsTurn[1]}) {
		t.Fatalf("urls : %v", r["urls"])
	}
	if b := w.Body.String(); strings.Contains(b, tok) || strings.Contains(b, jetons[0]) {
		t.Fatal("le jeton de membre ou le jeton anonyme est dans la réponse")
	}

	// Un autre membre, sans jeton : identifiants (appels ouverts pour tout le salon), autre nom.
	autre := entrerAppel(t, e.env, k)
	r2 := jsonOf(t, e.do(req{method: "POST", path: "/api/salons/appel", hdr: map[string]string{"X-Shh-Membre": autre}, body: []byte(`{}`)}))
	if r2["username"] == nom || r2["ttl_s"] != float64(ttl) {
		t.Fatalf("autre membre : %v", r2)
	}
	// Jeton présenté alors que les appels sont ouverts : pas lu, pas dépensé (il sert ailleurs).
	if r := e.appel(avecJeton(autre, jetons[1]), `{}`); r.code != 200 {
		t.Fatalf("jeton en trop : %d %q", r.code, r.body)
	}
	// Plus tard : le temps restant diminue avec l'horloge, jamais au-delà de la fin du salon.
	e.clk.Add(30 * time.Minute)
	if r3 := jsonOf(t, e.do(req{method: "POST", path: "/api/salons/appel", hdr: map[string]string{"X-Shh-Membre": tok}, body: []byte(`{}`)})); r3["ttl_s"] != float64(ttl-1800) {
		t.Fatalf("après 30 min : %v", r3["ttl_s"])
	}

	// Autre salon : le jeton déjà dépensé est refusé (400) et n'ouvre rien ; celui qui n'a pas
	// été dépensé ouvre les appels.
	k2 := newKeys()
	e.creerSalon(t, k2, 3)
	tok2 := entrerAppel(t, e.env, k2)
	if r := e.appel(avecJeton(tok2, jetons[0]), `{}`); r.code != 400 || strings.TrimSpace(r.body) != badRequest {
		t.Fatalf("jeton dépensé : %d %q", r.code, r.body)
	}
	if r := e.appel(map[string]string{"X-Shh-Membre": tok2}, `{}`); r.code != 402 {
		t.Fatalf("toujours fermés : %d %q", r.code, r.body)
	}
	if r := e.appel(avecJeton(tok2, jetons[1]), `{}`); r.code != 200 {
		t.Fatalf("jeton non dépensé : %d %q", r.code, r.body)
	}
	// Tableau de bord : deux salons aux appels ouverts, cinq identifiants délivrés.
	if u := e.srv.usage.Snapshot(); u.AppelsOuverts != 2 || u.IdentifiantsTurn != 5 {
		t.Fatalf("compteurs : appels ouverts %d, identifiants %d", u.AppelsOuverts, u.IdentifiantsTurn)
	}

	// Salon échu : plus rien.
	e.clk.Add(2 * time.Hour)
	if r := e.appel(map[string]string{"X-Shh-Membre": tok}, `{}`); r.code != 404 {
		t.Fatalf("salon échu : %d %q", r.code, r.body)
	}
}

// Pro ouvre aussi les appels (les deux offres comprennent l'audio et la vidéo).
func TestAppelOuvertParPro(t *testing.T) {
	e, _, tok := appelEnv(t)
	j := e.jetonsPour(t, e.passPaye(t, 2, corpsPro), "pro", 1)
	if r := e.appel(avecJeton(tok, j[0]), `{}`); r.code != 200 {
		t.Fatalf("Pro : %d %q", r.code, r.body)
	}
}

// Jetons faux : 400, rien d'ouvert ; un vrai jeton refusé pour une autre raison (membre
// inconnu, limite) n'est pas dépensé.
func TestAppelJetonRefuse(t *testing.T) {
	e, k, tok := appelEnv(t)
	jetons := e.jetonsPour(t, e.passPaye(t, 3, corpsCommande), "plus", 1)
	for _, h := range []string{"PrivateToken token=abc", "PrivateToken " + jetons[0], "Bearer x", "PrivateToken token=" + enc.EncodeToString(rnd(354))} {
		if r := e.appel(map[string]string{"X-Shh-Membre": tok, "Authorization": h}, `{}`); r.code != 400 || strings.TrimSpace(r.body) != badRequest {
			t.Fatalf("%s : %d %q", h, r.code, r.body)
		}
	}
	if r := e.appel(map[string]string{"X-Shh-Membre": tok}, `{}`); r.code != 402 {
		t.Fatalf("rien d'ouvert : %d %q", r.code, r.body)
	}
	// Membre inconnu : 404 avant toute dépense.
	if r := e.appel(avecJeton(enc.EncodeToString(rnd(32)), jetons[0]), `{}`); r.code != 404 {
		t.Fatalf("membre inconnu : %d %q", r.code, r.body)
	}
	// Corps faux : 400 avant toute dépense.
	if r := e.appel(avecJeton(tok, jetons[0]), `{"x":1}`); r.code != 400 {
		t.Fatalf("corps : %d %q", r.code, r.body)
	}
	// Limite du membre atteinte (sans jeton : 402, compté) : 429 avant toute dépense.
	autre := entrerAppel(t, e.env, k)
	for i := 0; i < limits.AppelsParHeure; i++ {
		e.appel(map[string]string{"X-Shh-Membre": autre}, `{}`)
	}
	if r := e.appel(avecJeton(autre, jetons[0]), `{}`); r.code != 429 {
		t.Fatalf("limite : %d %q", r.code, r.body)
	}
	// Le jeton n'a jamais été dépensé : il ouvre encore les appels.
	if r := e.appel(avecJeton(tok, jetons[0]), `{}`); r.code != 200 {
		t.Fatalf("jeton gardé : %d %q", r.code, r.body)
	}
}

// Refus du membre : sans en-tête, en-tête mal formé, corps autre que {}, jeton inconnu.
func TestAppelRefus(t *testing.T) {
	e, _, tok := appelEnv(t)
	for nomCas, c := range map[string]struct {
		hdr  map[string]string
		body string
		code int
		want string
	}{
		"sans en-tête": {nil, `{}`, 400, badRequest},
		"mal formé":    {map[string]string{"X-Shh-Membre": "abc"}, `{}`, 400, badRequest},
		"corps":        {map[string]string{"X-Shh-Membre": tok}, `{"x":1}`, 400, badRequest},
		"inconnu":      {map[string]string{"X-Shh-Membre": enc.EncodeToString(rnd(32))}, `{}`, 404, notFound},
	} {
		if r := e.appel(c.hdr, c.body); r.code != c.code || strings.TrimSpace(r.body) != c.want {
			t.Fatalf("%s : %d %q", nomCas, r.code, r.body)
		}
	}
}

// 20 demandes par heure et par membre, puis 429 ; un autre membre n'est pas touché.
func TestAppelLimite(t *testing.T) {
	e, k, tok := appelEnv(t)
	j := e.jetonsPour(t, e.passPaye(t, 4, corpsCommande), "plus", 1)
	h := map[string]string{"X-Shh-Membre": tok}
	if r := e.appel(avecJeton(tok, j[0]), `{}`); r.code != 200 {
		t.Fatalf("ouverture : %d %q", r.code, r.body)
	}
	for i := 1; i < limits.AppelsParHeure; i++ {
		if r := e.appel(h, `{}`); r.code != 200 {
			t.Fatalf("demande %d : %d %q", i, r.code, r.body)
		}
	}
	if r := e.appel(h, `{}`); r.code != 429 {
		t.Fatalf("au-delà : %d %q", r.code, r.body)
	}
	autre := entrerAppel(t, e.env, k)
	if r := e.appel(map[string]string{"X-Shh-Membre": autre}, `{}`); r.code != 200 {
		t.Fatalf("autre membre : %d %q", r.code, r.body)
	}
}

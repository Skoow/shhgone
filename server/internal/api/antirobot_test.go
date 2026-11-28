package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	altcha "github.com/altcha-org/altcha-lib-go"

	"github.com/skoow/shhdrop/server/internal/limits"
)

// Anti-robot des points d'entrée du compte (décision du 26 novembre ; spec §22 D4 ; conception du
// compte par passkey §6.4) : inscription/debut (avant le geste), connexion/fin (après le geste) et
// recup exigent une preuve ALTCHA vérifiée, à usage unique, liée à la connexion. Absente, fausse,
// réutilisée, échue, d'une autre connexion, trop rapide ou champ piège rempli : la même réponse
// 400 bad_request, sans oracle.

// defiBrut : un défi de GET /api/captcha pour remote, non résolu, et son jeton shown_at.
func (e envCompte) defiBrut(t *testing.T, remote string) (altcha.Challenge, string) {
	t.Helper()
	w := e.do(req{method: "GET", path: "/api/captcha", remote: remote})
	expect(t, w, 200, "")
	var c struct {
		altcha.Challenge
		ShownAt string `json:"shown_at"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &c); err != nil {
		t.Fatal(err)
	}
	return c.Challenge, c.ShownAt
}

func chargeAltcha(ch altcha.Challenge, n int64) string {
	p, _ := json.Marshal(map[string]any{"algorithm": ch.Algorithm, "challenge": ch.Challenge, "number": n,
		"salt": ch.Salt, "signature": ch.Signature})
	return base64.StdEncoding.EncodeToString(p)
}

// preuvesRefusees : les preuves invalides pour remote, chacune avec son nom ; `usee` est une preuve
// déjà acceptée une fois (réutilisation). L'horloge avance (3 s, ou 2 min pour la preuve échue).
func (e envCompte) preuvesRefusees(t *testing.T, remote string, usee map[string]any) []struct {
	nom   string
	champ map[string]any
} {
	t.Helper()
	type cas = struct {
		nom   string
		champ map[string]any
	}
	var l []cas
	l = append(l, cas{"absente", map[string]any{}})
	l = append(l, cas{"vide", map[string]any{"altcha": "", "hp": "", "shown_at": ""}})
	l = append(l, cas{"illisible", map[string]any{"altcha": "%%%", "hp": "", "shown_at": "x"}})
	ch, shown := e.defiBrut(t, remote)
	n := solve(t, ch)
	e.clk.Add(3 * time.Second)
	l = append(l, cas{"fausse", map[string]any{"altcha": chargeAltcha(ch, n+1), "hp": "", "shown_at": shown}})
	l = append(l, cas{"champ piège", map[string]any{"altcha": chargeAltcha(ch, n), "hp": "x", "shown_at": shown}})
	alt, sh := e.captchaFor(t, "198.51.100.200:1")
	l = append(l, cas{"autre connexion", map[string]any{"altcha": alt, "hp": "", "shown_at": sh}})
	// Dernier défi lu : l'horloge n'avance plus, il est encore « trop rapide » (moins de 3 s).
	ch2, shown2 := e.defiBrut(t, remote)
	l = append(l, cas{"shown_at d'un autre défi", map[string]any{"altcha": chargeAltcha(ch, n), "hp": "", "shown_at": shown2}})
	l = append(l, cas{"trop rapide", map[string]any{"altcha": chargeAltcha(ch2, solve(t, ch2)), "hp": "", "shown_at": shown2}})
	l = append(l, cas{"réutilisée", usee})
	return l
}

func avec(m, p map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	for k, v := range p {
		out[k] = v
	}
	return out
}

func TestAntiRobotInscriptionDebut(t *testing.T) {
	e := newEnvCompte(t)
	const ip = "203.0.113.140:1"
	usee := e.preuve(t, ip, map[string]any{})
	expect(t, e.do(req{method: "POST", path: "/api/compte/inscription/debut", remote: ip, body: mustJSON(usee)}), 200, "")
	for _, c := range e.preuvesRefusees(t, ip, usee) {
		w := e.do(req{method: "POST", path: "/api/compte/inscription/debut", remote: ip, body: mustJSON(c.champ)})
		if w.Code != 400 || w.Body.String() != badRequest {
			t.Fatalf("%s : %d %q", c.nom, w.Code, w.Body.String())
		}
	}
	// Échue (2 min) : refusée.
	alt, shown := e.captchaFor(t, ip)
	e.clk.Add(2 * time.Minute)
	expect(t, e.do(req{method: "POST", path: "/api/compte/inscription/debut", remote: ip,
		body: mustJSON(map[string]any{"altcha": alt, "hp": "", "shown_at": shown})}), 400, badRequest)
}

// connexion/fin : preuve vérifiée avant l'étape ; refusée, l'étape reste valable (la même
// assertion passe ensuite avec une bonne preuve, sans nouveau geste) et aucun échec de connexion
// n'est compté. connexion/debut reste sans preuve (chargée avant le geste).
func TestAntiRobotConnexionFin(t *testing.T) {
	e := newEnvCompte(t)
	const ip = "203.0.113.141:1"
	in := e.inscrire(t, ip, "lea")
	usee := e.preuve(t, ip, map[string]any{})
	debut := func() (string, []byte) {
		w := e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: ip, body: []byte(`{}`)})
		expect(t, w, 200, "")
		etape, opts := etapeOptions(t, w.Body.Bytes())
		cred, err := in.auth.Obtenir(opts, origineCompte, in.pk)
		if err != nil {
			t.Fatal(err)
		}
		return etape, cred
	}
	corps := func(etape string, cred []byte) map[string]any {
		return map[string]any{"etape": etape, "credential": json.RawMessage(cred), "persistante": false, "etiquette": ""}
	}
	etape, cred := debut()
	expect(t, e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: ip, body: mustJSON(avec(corps(etape, cred), usee))}), 200, "")
	etape, cred = debut()
	refus := e.preuvesRefusees(t, ip, usee)
	for len(refus) < limits.EchecsConnexionPer64+1 { // plus de refus que d'échecs permis
		refus = append(refus, refus[0])
	}
	for _, c := range refus {
		w := e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: ip, body: mustJSON(avec(corps(etape, cred), c.champ))})
		if w.Code != 400 || w.Body.String() != badRequest {
			t.Fatalf("%s : %d %q", c.nom, w.Code, w.Body.String())
		}
	}
	alt, shown := e.captchaFor(t, ip)
	e.clk.Add(2 * time.Minute)
	expect(t, e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: ip,
		body: mustJSON(avec(corps(etape, cred), map[string]any{"altcha": alt, "hp": "", "shown_at": shown}))}), 400, badRequest)
	// Même étape, même assertion, bonne preuve : connectée (étape gardée, aucun échec compté).
	expect(t, e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: ip,
		body: mustJSON(e.preuve(t, ip, corps(etape, cred)))}), 200, "")
}

// recup : preuve vérifiée avant tout essai de clé (refusée : aucun essai compté) ; clé inconnue :
// la difficulté de la connexion double ; les 10 essais par heure restent.
func TestAntiRobotRecup(t *testing.T) {
	e := newEnvCompte(t)
	in := e.inscrire(t, "203.0.113.142:1", "lea")
	const ip = "203.0.113.143:1"
	corps := func(ar string) map[string]any {
		return map[string]any{"a_r": ar, "persistante": false, "etiquette": ""}
	}
	usee := e.preuve(t, ip, map[string]any{})
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: ip, body: mustJSON(avec(corps(in.aR), usee))}), 200, "")
	refus := e.preuvesRefusees(t, ip, usee)
	for len(refus) < limits.RecupPer64+1 {
		refus = append(refus, refus[0])
	}
	for _, c := range refus {
		w := e.do(req{method: "POST", path: "/api/compte/recup", remote: ip, body: mustJSON(avec(corps(in.aR), c.champ))})
		if w.Code != 400 || w.Body.String() != badRequest {
			t.Fatalf("%s : %d %q", c.nom, w.Code, w.Body.String())
		}
	}
	alt, shown := e.captchaFor(t, ip)
	e.clk.Add(2 * time.Minute)
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: ip,
		body: mustJSON(avec(corps(in.aR), map[string]any{"altcha": alt, "hp": "", "shown_at": shown}))}), 400, badRequest)
	// Aucun essai compté : la bonne clé passe encore (2e essai de l'heure).
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: ip, body: mustJSON(e.preuve(t, ip, corps(in.aR)))}), 200, "")
	// Clé inconnue : 403, et le défi suivant de cette connexion est deux fois plus long.
	const autre = "203.0.113.144:1"
	avant, _ := e.defiBrut(t, autre)
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: autre,
		body: mustJSON(e.preuve(t, autre, corps(enc.EncodeToString(rnd(32)))))}), 403, `{"error":"identifiants"}`)
	apres, _ := e.defiBrut(t, autre)
	if apres.MaxNumber != 2*avant.MaxNumber {
		t.Fatalf("difficulté après une clé inconnue : %d puis %d", avant.MaxNumber, apres.MaxNumber)
	}
	// Une connexion réussie ne change pas la difficulté.
	c0, _ := e.defiBrut(t, ip)
	e.connecter(t, ip, in)
	if c1, _ := e.defiBrut(t, ip); c1.MaxNumber != c0.MaxNumber {
		t.Fatalf("difficulté après une connexion : %d puis %d", c0.MaxNumber, c1.MaxNumber)
	}
}

// Création d'un salon : preuve fausse, réutilisée ou échue → 400 bad_request (absente, champ
// piège et trop rapide : TestCreerSalonSansCaptcha ; partages : TestCreateRefusals).
func TestAntiRobotSalonFausseReutiliseeEchue(t *testing.T) {
	e, _ := salonEnv(t)
	post := func(alt, shown string) *httptest.ResponseRecorder {
		k := newKeys()
		return e.do(req{method: "POST", path: "/api/salons", hdr: k.createHdr(), body: mustJSON(k.salonBody(2, alt, shown))})
	}
	ch, shown := envCompte{env: e}.defiBrut(t, "")
	e.clk.Add(3 * time.Second)
	expect(t, post(chargeAltcha(ch, solve(t, ch)+1), shown), 400, badRequest)
	alt, shown := e.captchaFor(t, "")
	expect(t, post(alt, shown), 201, "")
	expect(t, post(alt, shown), 400, badRequest)
	alt, shown = e.captchaFor(t, "")
	e.clk.Add(2 * time.Minute)
	expect(t, post(alt, shown), 400, badRequest)
}

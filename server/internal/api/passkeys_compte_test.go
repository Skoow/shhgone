package api

import (
	"crypto/sha256"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/compte/webauthntest"
)

// Lot S5 : passkeys du compte, réauthentification, nouvelle clé de récupération (conception du
// compte par passkey §3.5, §6.4).

// etapeOptions : { etape, options } d'une réponse.
func etapeOptions(t *testing.T, body []byte) (string, json.RawMessage) {
	t.Helper()
	var d struct {
		Etape   string          `json:"etape"`
		Options json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(body, &d); err != nil || len(d.Etape) != 43 {
		t.Fatalf("%q", body)
	}
	return d.Etape, d.Options
}

// ajouter : passkeys/debut puis passkeys/fin avec un nouvel authentificateur ; rend le code et
// l'authentificateur.
func (e envCompte) ajouter(t *testing.T, s string, alg int) (int, string, *webauthntest.Authentificateur, *webauthntest.Passkey) {
	t.Helper()
	w := e.do(req{method: "POST", path: "/api/compte/passkeys/debut", hdr: sess(s), body: []byte(`{}`)})
	if w.Code != 200 {
		return w.Code, w.Body.String(), nil, nil
	}
	etape, opts := etapeOptions(t, w.Body.Bytes())
	a := webauthntest.Nouveau(alg)
	cred, p, err := a.Creer(opts, origineCompte, "")
	if err != nil {
		t.Fatal(err)
	}
	w = e.do(req{method: "POST", path: "/api/compte/passkeys/fin", hdr: sess(s), body: mustJSON(map[string]any{
		"etape": etape, "credential": json.RawMessage(cred), "env": "", "etiquette": enc.EncodeToString(rnd(64))})})
	return w.Code, w.Body.String(), a, p
}

// reauth : reauth/debut puis reauth/fin avec la passkey p de a.
func (e envCompte) reauth(t *testing.T, s string, a *webauthntest.Authentificateur, p *webauthntest.Passkey) (int, string) {
	t.Helper()
	w := e.do(req{method: "POST", path: "/api/compte/reauth/debut", hdr: sess(s), body: []byte(`{}`)})
	expect(t, w, 200, "")
	etape, opts := etapeOptions(t, w.Body.Bytes())
	cred, err := a.Obtenir(opts, origineCompte, p)
	if err != nil {
		t.Fatal(err)
	}
	w = e.do(req{method: "POST", path: "/api/compte/reauth/fin", hdr: sess(s),
		body: mustJSON(map[string]any{"etape": etape, "credential": json.RawMessage(cred)})})
	return w.Code, w.Body.String()
}

// Ajout, liste, nommage, enveloppe, retrait ; session non récente refusée partout où elle est
// exigée ; reauth par une passkey du compte seulement ; onzième passkey refusée ; dernière
// passkey non retirable.
func TestPasskeysDuCompteHTTP(t *testing.T) {
	e := newEnvCompte(t)
	in := e.inscrire(t, "203.0.113.120:1", "lea")
	S := in.session
	code, body, a2, p2 := e.ajouter(t, S, webauthntest.EdDSA)
	if code != 200 || body != `{}` {
		t.Fatal(code, body)
	}
	w := e.do(req{method: "GET", path: "/api/compte/passkeys", hdr: sess(S)})
	expect(t, w, 200, "")
	var l struct {
		Passkeys []map[string]any `json:"passkeys"`
	}
	json.Unmarshal(w.Body.Bytes(), &l)
	if len(l.Passkeys) != 2 || cles(l.Passkeys[0]) != "ajoutee,be,cred_id,etiquette,prf" {
		t.Fatal(w.Body.String())
	}
	var nouvelle map[string]any
	for _, p := range l.Passkeys {
		if p["cred_id"] == enc.EncodeToString(p2.ID) {
			nouvelle = p
		}
	}
	if nouvelle == nil || nouvelle["prf"] != false || nouvelle["be"] != true || len(nouvelle["etiquette"].(string)) != 86 {
		t.Fatal(w.Body.String())
	}
	id2 := enc.EncodeToString(p2.ID)
	// Enveloppe posée après coup ; nommage ; passkey d'un autre compte : not_found.
	expect(t, e.do(req{method: "POST", path: "/api/compte/passkeys/enveloppe", hdr: sess(S),
		body: mustJSON(map[string]any{"cred_id": id2, "env": enc.EncodeToString(rnd(60))})}), 200, `{}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/passkeys/nommer", hdr: sess(S),
		body: mustJSON(map[string]any{"cred_id": id2, "etiquette": enc.EncodeToString(rnd(64))})}), 200, `{}`)
	autre := e.inscrire(t, "203.0.113.121:1", "leo")
	for _, x := range []struct{ p, b string }{
		{"/api/compte/passkeys/enveloppe", `{"cred_id":"` + id2 + `","env":"` + enc.EncodeToString(rnd(60)) + `"}`},
		{"/api/compte/passkeys/nommer", `{"cred_id":"` + id2 + `","etiquette":"` + enc.EncodeToString(rnd(64)) + `"}`},
		{"/api/compte/passkeys/retirer", `{"cred_id":"` + id2 + `"}`},
	} {
		expect(t, e.do(req{method: "POST", path: x.p, hdr: sess(autre.session), body: []byte(x.b)}), 404, `{"error":"not_found"}`)
	}
	for _, b := range []string{`{"cred_id":"","env":"` + enc.EncodeToString(rnd(60)) + `"}`, `{"cred_id":"` + id2 + `","env":"` + enc.EncodeToString(rnd(59)) + `"}`,
		`{"cred_id":"` + id2 + `=","env":"` + enc.EncodeToString(rnd(60)) + `"}`} {
		expect(t, e.do(req{method: "POST", path: "/api/compte/passkeys/enveloppe", hdr: sess(S), body: []byte(b)}), 400, badRequest)
	}
	// Session non récente : ajout, retrait, nouvelle clé refusés ; reauth la rend récente.
	e.clk.Add(6 * time.Minute)
	if code, body, _, _ := e.ajouter(t, S, webauthntest.ES256); code != 403 || body != `{"error":"recent"}` {
		t.Fatal(code, body)
	}
	expect(t, e.do(req{method: "POST", path: "/api/compte/passkeys/retirer", hdr: sess(S), body: mustJSON(map[string]any{"cred_id": id2})}), 403, `{"error":"recent"}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup/renouveler", hdr: sess(S), body: mustJSON(map[string]any{
		"v_r": enc.EncodeToString(rnd(32)), "env_r": enc.EncodeToString(rnd(60))})}), 403, `{"error":"recent"}`)
	// Reauth avec la passkey d'un autre compte : identifiants ; avec la sienne : récente.
	if code, body := e.reauth(t, S, autre.auth, autre.pk); code != 403 || body != `{"error":"identifiants"}` {
		t.Fatal("reauth par une passkey d'un autre compte :", code, body)
	}
	if code, body := e.reauth(t, S, a2, p2); code != 200 || body != `{}` {
		t.Fatal(code, body)
	}
	// Jusqu'à 10 passkeys, la onzième refusée.
	for i := 2; i < 10; i++ {
		if code, body, _, _ := e.ajouter(t, S, webauthntest.ES256); code != 200 {
			t.Fatal(i, code, body)
		}
	}
	if code, body, _, _ := e.ajouter(t, S, webauthntest.ES256); code != 409 || body != `{"error":"passkeys_max"}` {
		t.Fatal("onzième :", code, body)
	}
	// Retraits ; la dernière ne se retire pas.
	w = e.do(req{method: "GET", path: "/api/compte/passkeys", hdr: sess(S)})
	json.Unmarshal(w.Body.Bytes(), &l)
	for i, p := range l.Passkeys {
		want, wantBody := 200, `{}`
		if i == len(l.Passkeys)-1 {
			want, wantBody = 409, `{"error":"derniere"}`
		}
		expect(t, e.do(req{method: "POST", path: "/api/compte/passkeys/retirer", hdr: sess(S),
			body: mustJSON(map[string]any{"cred_id": p["cred_id"]})}), want, wantBody)
	}
	if n := compter(t, e, "passkeys"); n != 2 { // la dernière de lea, celle de leo
		t.Fatal("passkeys :", n)
	}
	// La passkey retirée ne connecte plus.
	w = e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: "203.0.113.122:1", body: []byte(`{}`)})
	etape, opts := etapeOptions(t, w.Body.Bytes())
	cred, _ := in.auth.Obtenir(opts, origineCompte, in.pk)
	if strings.Contains(w.Body.String(), "allowCredentials") {
		t.Fatal(w.Body.String())
	}
	r := e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: "203.0.113.122:1", body: mustJSON(map[string]any{
		"etape": etape, "credential": json.RawMessage(cred), "persistante": false, "etiquette": ""})})
	if (r.Code == 200) == (l.Passkeys[len(l.Passkeys)-1]["cred_id"] != enc.EncodeToString(in.pk.ID)) {
		t.Fatal("connexion par une passkey retirée :", r.Code)
	}
}

// Nouvelle clé de récupération : l'ancienne ne retrouve plus le compte, la nouvelle oui ; un v_r
// déjà pris est refusé.
func TestRecupRenouvelerHTTP(t *testing.T) {
	e := newEnvCompte(t)
	in := e.inscrire(t, "203.0.113.130:1", "lea")
	autre := e.inscrire(t, "203.0.113.131:1", "leo")
	aR2 := rnd(32)
	vr2 := sha256.Sum256(aR2)
	aAutre, _ := enc.DecodeString(autre.aR)
	vrAutre := sha256.Sum256(aAutre)
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup/renouveler", hdr: sess(in.session), body: mustJSON(map[string]any{
		"v_r": enc.EncodeToString(vrAutre[:]), "env_r": enc.EncodeToString(rnd(60))})}), 400, badRequest)
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup/renouveler", hdr: sess(in.session), body: mustJSON(map[string]any{
		"v_r": enc.EncodeToString(vr2[:]), "env_r": enc.EncodeToString(rnd(60))})}), 200, `{}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.132:1",
		body: mustJSON(map[string]any{"a_r": in.aR, "persistante": false, "etiquette": ""})}), 403, `{"error":"identifiants"}`)
	w := e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.132:1",
		body: mustJSON(map[string]any{"a_r": enc.EncodeToString(aR2), "persistante": false, "etiquette": ""})})
	if w.Code != 200 || jsonOf(t, w)["h"] != in.h {
		t.Fatal(w.Code, w.Body.String())
	}
}

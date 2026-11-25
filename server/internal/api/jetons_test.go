package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/cloudflare/circl/blindsign/blindrsa"
	"github.com/skoow/shhdrop/server/internal/paiement"
	"github.com/skoow/shhdrop/server/internal/share"
)

// passPaye : un pass Plus (ou Pro) payé par un faux webhook.
func (e envPaiement) passPaye(t *testing.T, n byte, corps string) string {
	t.Helper()
	pass := passB64(n)
	if w := e.do(req{method: "POST", path: "/api/paiement/commande", hdr: map[string]string{"X-Shh-Pass": pass}, body: e.preuve(t, corps, "")}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	c := e.p.vu[len(e.p.vu)-1]
	e.p.evs = []paiement.Evenement{{Sorte: paiement.Confirme, Commande: c.Commande, AvecCommande: true, Ref: fmt.Sprint("pi_", n),
		Montant: paiement.Prix(c.Formule.Offre, c.Formule.Jours), Devise: "eur"}}
	expect(t, e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", body: []byte(`{}`)}), 200, `{}`)
	e.p.evs = nil
	return pass
}

// jetonsPour : n jetons du pass, faits côté client avec circl (le moteur fait de même).
func (e envPaiement) jetonsPour(t *testing.T, pass, offre string, n int) []string {
	t.Helper()
	w := e.do(req{method: "GET", path: "/api/paiement/jetons/cles"})
	var cl struct {
		V        int    `json:"v"`
		Emetteur string `json:"emetteur"`
		Cles     []struct{ Jour, Offre, SPKI string }
	}
	if json.Unmarshal(w.Body.Bytes(), &cl); w.Code != 200 || cl.Emetteur != "shhgone.test" || len(cl.Cles) != 2*(paiement.JoursAvance+1) {
		t.Fatal(w.Code, w.Body.String())
	}
	spki, _ := enc.DecodeString(cl.Cles[map[string]int{"plus": 0, "pro": 1}[offre]].SPKI)
	pk, err := x509.ParsePKCS1PublicKey(spki[72:])
	if err != nil {
		t.Fatal(err)
	}
	c, _ := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, pk)
	kid := sha256.Sum256(spki)
	dd := sha256.Sum256(paiement.Defi("shhgone.test"))
	var reqs []string
	var msgs [][]byte
	var states []blindrsa.State
	for i := 0; i < n; i++ {
		nonce := make([]byte, 32)
		rand.Read(nonce)
		msg := append(append(append([]byte{0, 2}, nonce...), dd[:]...), kid[:]...)
		bl, st, err := c.Blind(rand.Reader, msg)
		if err != nil {
			t.Fatal(err)
		}
		reqs, msgs, states = append(reqs, enc.EncodeToString(append([]byte{0, 2, kid[31]}, bl...))), append(msgs, msg), append(states, st)
	}
	w = e.do(req{method: "POST", path: "/api/paiement/jetons", hdr: map[string]string{"X-Shh-Pass": pass}, body: mustJSON(map[string]any{"requetes": reqs})})
	var rep struct {
		Offre    string   `json:"offre"`
		Reponses []string `json:"reponses"`
	}
	if json.Unmarshal(w.Body.Bytes(), &rep); w.Code != 200 || rep.Offre != offre || len(rep.Reponses) != n {
		t.Fatal(w.Code, w.Body.String())
	}
	var out []string
	for i, r := range rep.Reponses {
		sig, _ := enc.DecodeString(r)
		s, err := c.Finalize(states[i], sig)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, enc.EncodeToString(append(msgs[i], s...)))
	}
	return out
}

var adresse int

// creerAvec : création avec en-têtes de plus (PrivateToken) ; rend le code et la création.
func (e envPaiement) creerAvec(t *testing.T, k keys, bucket int, extra map[string]string) (int, created) {
	t.Helper()
	adresse++ // une connexion par création : 2 envois en cours au plus par connexion
	remote := fmt.Sprintf("198.51.100.%d:4444", adresse)
	alt, shown := e.captchaFor(t, remote)
	h := k.createHdr()
	for a, b := range extra {
		h[a] = b
	}
	w := e.do(req{method: "POST", path: "/api/shares", hdr: h, body: mustJSON(k.createBody(bucket, 1, alt, shown)), remote: remote})
	c := created{k: k}
	json.Unmarshal(w.Body.Bytes(), &c)
	return w.Code, c
}

func finaliser(e envPaiement, c created, opens, ttl int) (int, float64) {
	for n := 0; n < c.Segments; n++ {
		e.do(req{method: "PUT", path: fmt.Sprintf("/api/shares/segments/%d", n), body: rnd(share.SegmentSize(1, n)), hdr: auth(c.UploadToken)})
	}
	w := e.do(req{method: "POST", path: "/api/shares/finalize", hdr: auth(c.UploadToken), body: mustJSON(c.k.finBody(opens, ttl, 1))})
	var m map[string]any
	json.Unmarshal(w.Body.Bytes(), &m)
	s, _ := m["expires_in_s"].(float64)
	return w.Code, s
}

// TestPartagePayantParJeton : un jeton Plus permet 10 ouvertures et 3 jours (jamais 7) ; sans
// jeton, les limites gratuites ; un jeton ne sert qu'une fois ; une création refusée le rend.
func TestPartagePayantParJeton(t *testing.T) {
	e := newEnvPaiement(t)
	pass := e.passPaye(t, 1, corpsCommande)
	jetons := e.jetonsPour(t, pass, "plus", 4)
	pt := func(j string) map[string]string { return map[string]string{"Authorization": "PrivateToken token=" + j} }

	code, c := e.creerAvec(t, newKeys(), 1, pt(jetons[0]))
	if code != 201 {
		t.Fatal(code)
	}
	if code, s := finaliser(e, c, 10, 72); code != 200 || s < 72*3600 || s > 72*3600+900 {
		t.Fatal("Plus : 10 ouvertures, 3 jours", code, s)
	}
	// Le même jeton une seconde fois : refusé.
	if code, _ := e.creerAvec(t, newKeys(), 1, pt(jetons[0])); code != 400 {
		t.Fatal("jeton dépensé deux fois", code)
	}
	// Plus : 7 jours et 11 ouvertures refusés.
	_, c = e.creerAvec(t, newKeys(), 1, pt(jetons[1]))
	if code, _ := finaliser(e, c, 10, 168); code != 400 {
		t.Fatal("Plus à 7 jours", code)
	}
	if code, _ := finaliser(e, c, 11, 72); code != 400 {
		t.Fatal("Plus à 11 ouvertures", code)
	}
	if code, _ := finaliser(e, c, 10, 48); code != 200 {
		t.Fatal("Plus à 2 jours", code)
	}
	// Sans jeton : limites gratuites.
	_, c = e.creerAvec(t, newKeys(), 1, nil)
	if code, _ := finaliser(e, c, 6, 1); code != 400 {
		t.Fatal("gratuit à 6 ouvertures", code)
	}
	if code, _ := finaliser(e, c, 5, 48); code != 400 {
		t.Fatal("gratuit à 2 jours", code)
	}
	// Création refusée après la dépense (palier invalide) : jeton rendu, resert.
	if code, _ := e.creerAvec(t, newKeys(), 3, pt(jetons[2])); code != 400 {
		t.Fatal("palier invalide accepté")
	}
	if code, _ := e.creerAvec(t, newKeys(), 1, pt(jetons[2])); code != 201 {
		t.Fatal("jeton non rendu après un refus", code)
	}
	// En-têtes faux : 400.
	for _, h := range []string{"PrivateToken token=abc", "PrivateToken " + jetons[3], "Bearer x"} {
		if code, _ := e.creerAvec(t, newKeys(), 1, map[string]string{"Authorization": h}); code != 400 {
			t.Error(h, code)
		}
	}
	// Forme entre guillemets (RFC 9577) acceptée.
	if code, _ := e.creerAvec(t, newKeys(), 1, map[string]string{"Authorization": `PrivateToken token="` + jetons[3] + `"`}); code != 201 {
		t.Error("forme entre guillemets", code)
	}
	// Pro : 7 jours, 20 ouvertures.
	pro := e.passPaye(t, 2, `{"offre":"pro","jours":30,"renouvelle":true,"moyen":"carte","pays":"FR","renonciation":true}`)
	jp := e.jetonsPour(t, pro, "pro", 1)
	_, c = e.creerAvec(t, newKeys(), 1, pt(jp[0]))
	if code, s := finaliser(e, c, 20, 168); code != 200 || s < 168*3600 {
		t.Fatal("Pro : 20 ouvertures, 7 jours", code, s)
	}
	// Tableau de bord : partages payants par offre (4 Plus, 1 Pro), les gratuits à part.
	if u := e.srv.usage.Snapshot(); u.PartagesPayants != [2]int64{4, 1} || u.PartagesCrees != 6 {
		t.Fatalf("compteurs : payants %v, créés %d", u.PartagesPayants, u.PartagesCrees)
	}
}

// TestJetonSansPaiement : un serveur sans paiement refuse un PrivateToken.
func TestJetonSansPaiement(t *testing.T) {
	e := newEnv(t, false, nil)
	k := newKeys()
	alt, shown := e.captchaFor(t, "")
	h := k.createHdr()
	h["Authorization"] = "PrivateToken token=AAAA"
	expect(t, e.do(req{method: "POST", path: "/api/shares", hdr: h, body: mustJSON(k.createBody(1, 1, alt, shown))}), 400, `{"error":"bad_request"}`)
	expect(t, e.do(req{method: "GET", path: "/api/paiement/jetons/cles"}), 404, `{"error":"not_found"}`)
}

// TestEmissionRefus : pass inconnu → 409 aucun_jeton ; lot vide ou trop grand → 400.
func TestEmissionRefus(t *testing.T) {
	e := newEnvPaiement(t)
	h := map[string]string{"X-Shh-Pass": passB64(7)}
	r := enc.EncodeToString(make([]byte, 259))
	expect(t, e.do(req{method: "POST", path: "/api/paiement/jetons", hdr: h, body: mustJSON(map[string]any{"requetes": []string{}})}), 400, `{"error":"bad_request"}`)
	expect(t, e.do(req{method: "POST", path: "/api/paiement/jetons", hdr: h, body: mustJSON(map[string]any{"requetes": []string{r, r, r, r, r, r}})}), 400, `{"error":"bad_request"}`)
	e.do(req{method: "GET", path: "/api/paiement/jetons/cles"})
	if w := e.do(req{method: "POST", path: "/api/paiement/jetons", hdr: h, body: mustJSON(map[string]any{"requetes": []string{r}})}); w.Code != 409 && w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
}

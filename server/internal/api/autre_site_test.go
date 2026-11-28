package api

import (
	"fmt"
	"testing"

	"github.com/skoow/shhdrop/server/internal/limits"
)

// Requêtes d'un autre site : un formulaire ou un fetch « no-cors » d'un site tiers peut envoyer
// un POST text/plain sans préflight CORS, depuis le navigateur d'une personne qui partage son
// adresse avec d'autres. Il consommait les quotas de cette adresse (essais de la clé de
// récupération, échecs de connexion comptés par adresse). Corps JSON exigés en
// application/json, et Sec-Fetch-Site: cross-site refusé avant le limiteur.

// Corps JSON sans le bon type : 400 avant toute lecture, rien de compté (les 10 essais de la clé
// de récupération restent entiers).
func TestCorpsJSONTypeExige(t *testing.T) {
	e := newEnvCompte(t)
	in := e.inscrire(t, "203.0.113.60:1", "lea")
	corps := mustJSON(map[string]any{"a_r": enc.EncodeToString(rnd(32)), "persistante": false, "etiquette": ""})
	for i, ct := range []string{"", "text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded",
		"multipart/form-data", "application/json; charset=utf-8", "Application/JSON"} {
		w := e.do(req{method: "POST", path: "/api/compte/recup", remote: fmt.Sprintf("203.0.113.64:%d", i+1), body: corps,
			hdr: map[string]string{"Content-Type": ct}})
		expect(t, w, 400, badRequest)
	}
	for i := 0; i < limits.RecupPer64; i++ {
		e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.64:1", body: corps,
			hdr: map[string]string{"Content-Type": "text/plain"}})
	}
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.64:1",
		body: mustJSON(e.preuve(t, "203.0.113.64:1", map[string]any{"a_r": in.aR, "persistante": false, "etiquette": ""}))}), 200, "")
	// Routes des partages (readJSONMax) : de même.
	w := e.do(req{method: "POST", path: "/api/shares/unlock", body: []byte(`{"proof":"x"}`),
		hdr: map[string]string{"Content-Type": "text/plain", "X-Shh-Access": enc.EncodeToString(rnd(32))}})
	expect(t, w, 400, badRequest)
}

// Sec-Fetch-Site: cross-site : 403 avant le limiteur (rien compté) ; same-origin, same-site,
// none ou absent (apps, curl) : servis. Les webhooks de paiement n'y sont pas soumis.
func TestAutreSiteRefuse(t *testing.T) {
	e := newEnv(t, false, nil)
	const ip = "203.0.113.70:1"
	for range limits.RequestsPerMin + 5 {
		w := e.do(req{method: "POST", path: "/api/shares/unlock", remote: ip, body: []byte(`{}`),
			hdr: map[string]string{"Sec-Fetch-Site": "cross-site"}})
		expect(t, w, 403, `{"error":"cross_site"}`)
	}
	for _, v := range []string{"same-origin", "same-site", "none", ""} {
		h := map[string]string{}
		if v != "" {
			h["Sec-Fetch-Site"] = v
		}
		if w := e.do(req{method: "GET", path: "/api/inconnue", remote: ip, hdr: h}); w.Code == 403 || w.Code == 429 {
			t.Fatalf("Sec-Fetch-Site %q : %d", v, w.Code)
		}
	}
	if w := e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", remote: ip, body: []byte(`{}`),
		hdr: map[string]string{"Sec-Fetch-Site": "cross-site"}}); w.Code == 403 {
		t.Fatal("webhook refusé comme requête d'un autre site")
	}
}

// Webhooks : leur propre plafond (AllowWebhook), plus large que les 60 requêtes par minute ; ils
// ne prennent rien aux requêtes de la même adresse.
func TestWebhooksPlafondPropre(t *testing.T) {
	e := newEnv(t, false, nil)
	const ip = "198.51.100.9:443"
	for i := range limits.RequestsPerMin + 20 {
		if w := e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", remote: ip, body: []byte(`{}`)}); w.Code == 429 {
			t.Fatalf("webhook %d : 429 (limite des requêtes ordinaires)", i+1)
		}
	}
	if w := e.do(req{method: "GET", path: "/api/inconnue", remote: ip}); w.Code == 429 {
		t.Fatal("les webhooks ont pris sur les requêtes ordinaires")
	}
	for range limits.WebhooksPerMin {
		e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", remote: ip, body: []byte(`{}`)})
	}
	if w := e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", remote: ip, body: []byte(`{}`)}); w.Code != 429 {
		t.Fatal("plafond des webhooks sans effet :", w.Code)
	}
}

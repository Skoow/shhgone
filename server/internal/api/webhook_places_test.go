package api

import (
	"net/netip"
	"testing"
)

// Les places de lecture des webhooks sont tenues
// sous la clé HMAC du jour du limiteur, jamais sous le préfixe /64 ou /48 en clair. Places de la
// connexion prises sous cette clé : le webhook suivant est refusé (503) sans lecture ; rendues,
// il passe. Avec le préfixe en clair, ces places ne compteraient pas et le premier passerait.
func TestPaiementWebhookPlacesSousCle(t *testing.T) {
	e := newEnvPaiement(t)
	corps := []byte(`{"id":"evt_1","object":"event"}`)
	k64, k48 := e.srv.lim.Key(netip.MustParseAddr("203.0.113.7")) // adresse de e.do par défaut
	var rendre []func()
	for i := 0; i < 4; i++ {
		f, err := corpsWebhook.Acquire(k64, k48)
		if err != nil {
			t.Fatal(err)
		}
		rendre = append(rendre, f)
	}
	if w := e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", body: corps}); w.Code != 503 || e.p.vuCorps != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, f := range rendre {
		f()
	}
	expect(t, e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", body: corps}), 200, `{}`)
}

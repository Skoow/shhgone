package api

import (
	"testing"

	"github.com/skoow/shhdrop/server/internal/paiement"
)

// TestPaiementRevoquer : POST /api/paiement/revoquer (suppression du compte ; conception du
// paiement §5.6) : 409 tant que le renouvellement court, 204 après « resilier » ; état
// « revoquee » ; déjà révoqué ou pass inconnu : 204 sans corps (réponse neutre) ; pass mal formé
// ou corps : 400.
func TestPaiementRevoquer(t *testing.T) {
	e := newEnvPaiement(t)
	e.p.abo = "sub_1Abc"
	hp := map[string]string{"X-Shh-Pass": passB64(1)}
	if w := e.do(req{method: "POST", path: "/api/paiement/commande", hdr: hp, body: e.preuve(t, corpsCommande, "")}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	c := e.p.vu[0].Commande
	e.p.evs = []paiement.Evenement{{Sorte: paiement.Confirme, Commande: c, AvecCommande: true, Ref: "pi_1", Montant: 700, Devise: "eur"}}
	expect(t, e.do(req{method: "POST", path: "/api/paiement/webhook/stripe", body: []byte(`{"id":"evt"}`)}), 200, `{}`)

	expect(t, e.do(req{method: "POST", path: "/api/paiement/revoquer", hdr: hp}), 409, `{"error":"renouvellement"}`)
	expect(t, e.do(req{method: "POST", path: "/api/paiement/resilier", hdr: hp}), 204, "")
	for range 2 { // révoqué, puis déjà révoqué : même réponse
		w := e.do(req{method: "POST", path: "/api/paiement/revoquer", hdr: hp})
		if w.Code != 204 || w.Body.Len() != 0 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := e.do(req{method: "POST", path: "/api/paiement/etat", hdr: hp})
	if w.Code != 200 || w.Body.String() != `{"v":1,"etat":"revoquee","offre":"plus","fin":"2026-11-04","renouvelle":false,"droits":[]}` {
		t.Fatal(w.Code, w.Body.String())
	}
	// Pass inconnu : même réponse qu'un pass révoqué.
	if w := e.do(req{method: "POST", path: "/api/paiement/revoquer", hdr: map[string]string{"X-Shh-Pass": passB64(9)}}); w.Code != 204 || w.Body.Len() != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	expect(t, e.do(req{method: "POST", path: "/api/paiement/revoquer"}), 400, badRequest)
	expect(t, e.do(req{method: "POST", path: "/api/paiement/revoquer", hdr: map[string]string{"X-Shh-Pass": passB64(1)[:42]}}), 400, badRequest)
	expect(t, e.do(req{method: "POST", path: "/api/paiement/revoquer", hdr: hp, body: []byte(`{"x":1}`)}), 400, badRequest)
}

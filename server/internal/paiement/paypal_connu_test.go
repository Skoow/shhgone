package paiement

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

// bancPayPal : service réel avec le prestataire PayPal réel, branché sur le faux serveur.
func bancPayPal(t *testing.T) (*Service, *PayPalP, *fauxPayPal) {
	t.Helper()
	db, err := OuvrirBase(filepath.Join(t.TempDir(), "paiements.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	p, f := nouveauPayPalTest(t)
	now := time.Unix(1795000000, 0)
	s, err := NewService(Config{DB: db, Now: func() time.Time { return now }, Origine: "https://shhgone.test", Regime: OSS,
		Prestataires: []Prestataire{p}})
	if err != nil {
		t.Fatal(err)
	}
	return s, p, f
}

func corpsPP(typ, ressource string) []byte {
	return []byte(`{"id":"WH-TEST","event_version":"1.0","event_type":"` + typ + `","resource":` + ressource + `}`)
}

// Un faux webhook PayPal qui ne vise aucune commande connue chez
// nous (ni commande, ni abonnement, ni référence de paiement) est refusé comme une signature
// fausse, sans aucun appel sortant, même avec un Paypal-Transmission-Id toujours nouveau.
func TestPayPalWebhookInconnuSansAppel(t *testing.T) {
	s, p, f := bancPayPal(t)
	inconnue := "0123456789abcdef0123456789abcdef"
	faux := [][]byte{
		corpsPP("CHECKOUT.ORDER.APPROVED", `{"id":"5O190127TN364715T","purchase_units":[{"custom_id":"`+inconnue+`"}]}`),
		corpsPP("PAYMENT.CAPTURE.COMPLETED", `{"id":"7NW","status":"COMPLETED","amount":{"currency_code":"EUR","value":"70.00"},"custom_id":"`+inconnue+`"}`),
		corpsPP("PAYMENT.CAPTURE.REFUNDED", `{"id":"1JU","amount":{"value":"70.00"},"links":[{"rel":"up","href":"https://api.paypal.com/v2/payments/captures/INCONNUE"}]}`),
		corpsPP("PAYMENT.CAPTURE.REVERSED", `{"id":"INCONNUE2"}`),
		corpsPP("BILLING.SUBSCRIPTION.CANCELLED", `{"id":"I-INCONNU"}`),
		corpsPP("PAYMENT.SALE.COMPLETED", `{"id":"S1","state":"completed","billing_agreement_id":"I-INCONNU","amount":{"total":"20.00","currency":"EUR"}}`),
		corpsPP("PAYMENT.SALE.REFUNDED", `{"id":"R1","sale_id":"S-INCONNUE","amount":{"total":"20.00","currency":"EUR"}}`),
		corpsPP("CUSTOMER.DISPUTE.CREATED", `{"disputed_transactions":[{"seller_transaction_id":"T-INCONNUE"}]}`),
		corpsPP("PAYMENT.AUTHORIZATION.CREATED", `{}`),
		[]byte(`{"id":"WH","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":"pas un objet"}`),
	}
	for i := 0; i < 100; i++ {
		c := faux[i%len(faux)]
		if err := s.Webhook(context.Background(), p, entetesPPId(fmt.Sprintf("tx-%d", i)), c); !errors.Is(err, ErrSignature) {
			t.Fatalf("%d %s : %v", i, c, err)
		}
	}
	f.mu.Lock()
	n := len(f.appels)
	f.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d appels sortants pour des webhooks qui ne visent rien de connu", n)
	}
}

// Un webhook qui vise une commande connue, quel que soit son état (en attente, payée, puis
// remboursée par sa seule référence de capture), est vérifié par l'API PayPal comme avant ; un
// faux qui vise une commande connue coûte toujours sa vérification et reste refusé.
func TestPayPalWebhookConnuVerifie(t *testing.T) {
	s, p, f := bancPayPal(t)
	pass := passN(7)
	if _, err := s.Commander(context.Background(), pass, Formule{Plus, JoursAn, false, PayPal}, "FR", true); err != nil {
		t.Fatal(err)
	}
	var id []byte
	if err := s.db.QueryRow(`SELECT id FROM commandes`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	var c Commande
	copy(c[:], id)
	cs := c.String()
	n := 0
	webhook := func(corps []byte) error {
		t.Helper()
		n++
		return s.Webhook(context.Background(), p, entetesPPId(fmt.Sprintf("vrai-%d", n)), corps)
	}
	// Faux webhook (PayPal répond FAILURE) visant la commande connue : vérifié, refusé.
	f.verif = `{"verification_status":"FAILURE"}`
	if err := webhook(corpsPP("PAYMENT.CAPTURE.COMPLETED", `{"id":"7NW873794T343360M","status":"COMPLETED","amount":{"currency_code":"EUR","value":"70.00"},"custom_id":"`+cs+`"}`)); !errors.Is(err, ErrSignature) || f.verifsFaites() != 1 {
		t.Fatal(err, f.verifsFaites())
	}
	f.verif = `{"verification_status":"SUCCESS"}`
	// Commande en attente : paiement confirmé.
	if err := webhook(corpsPP("PAYMENT.CAPTURE.COMPLETED", `{"id":"7NW873794T343360M","status":"COMPLETED","amount":{"currency_code":"EUR","value":"70.00"},"custom_id":"`+cs+`"}`)); err != nil || f.verifsFaites() != 2 {
		t.Fatal(err, f.verifsFaites())
	}
	if e, _ := s.EtatDe(pass); e.Etat != "payee" {
		t.Fatal(e)
	}
	// Commande payée, remboursement qui ne porte que la référence de la capture : vérifié, révoqué.
	if err := webhook(corpsPP("PAYMENT.CAPTURE.REFUNDED", `{"id":"1JU08902781691411","amount":{"value":"70.00","currency_code":"EUR"},"status":"COMPLETED","links":[{"rel":"up","href":"https://api.sandbox.paypal.com/v2/payments/captures/7NW873794T343360M","method":"GET"}]}`)); err != nil || f.verifsFaites() != 3 {
		t.Fatal(err, f.verifsFaites())
	}
	if e, _ := s.EtatDe(pass); e.Etat != "revoquee" {
		t.Fatal(e)
	}
	// Commande révoquée : un litige sur la même transaction est encore vérifié.
	if err := webhook(corpsPP("CUSTOMER.DISPUTE.CREATED", `{"disputed_transactions":[{"seller_transaction_id":"T-AUTRE"},{"seller_transaction_id":"7NW873794T343360M"}]}`)); err != nil || f.verifsFaites() != 4 {
		t.Fatal(err, f.verifsFaites())
	}
}

// Abonnement : l'identifiant connu dès la création suffit (renouvellement sans custom, arrêt).
func TestPayPalWebhookAbonnementConnu(t *testing.T) {
	s, p, f := bancPayPal(t)
	if _, err := s.Commander(context.Background(), passN(8), Formule{Plus, JoursMois, true, PayPal}, "FR", true); err != nil {
		t.Fatal(err)
	}
	if err := s.Webhook(context.Background(), p, entetesPPId("abo-1"), corpsPP("PAYMENT.SALE.COMPLETED",
		`{"id":"80021663DE681814L","state":"completed","billing_agreement_id":"I-BW452GLLEP1G","amount":{"total":"7.00","currency":"EUR"}}`)); err != nil || f.verifsFaites() != 1 {
		t.Fatal(err, f.verifsFaites())
	}
	if err := s.Webhook(context.Background(), p, entetesPPId("abo-2"), corpsPP("BILLING.SUBSCRIPTION.CANCELLED", `{"id":"I-BW452GLLEP1G"}`)); err != nil || f.verifsFaites() != 2 {
		t.Fatal(err, f.verifsFaites())
	}
}

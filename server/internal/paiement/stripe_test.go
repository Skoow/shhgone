package paiement

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const whsec = "whsec_test_0123456789abcdef"

var cmdTest = Commande{0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18, 0x29, 0x3a, 0x4b, 0x5c, 0x6d, 0x7e, 0x8f, 0x90}

// fauxServeur : faux prestataire HTTPS ; garde la dernière requête.
type fauxServeur struct {
	srv    *httptest.Server
	req    *http.Request
	corps  []byte
	statut int
	rep    string
	n      int
}

func nouveauFauxServeur(t *testing.T) *fauxServeur {
	f := &fauxServeur{statut: 200}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.n++
		f.req = r
		f.corps, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(f.statut)
		io.WriteString(w, f.rep)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func nouveauStripeTest(t *testing.T, essai bool) (*Stripe, *fauxServeur, *time.Time) {
	f := nouveauFauxServeur(t)
	now := time.Unix(1795000000, 0)
	s := NouveauStripe("sk_test_cle", whsec, essai, false, clientTest(f.srv.Client()), func() time.Time { return now })
	s.base = f.srv.URL
	return s, f, &now
}

// signeStripe : en-tête Stripe-Signature comme Stripe le calcule (t ‖ « . » ‖ corps).
func signeStripe(secret string, t int64, corps string) string {
	m := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(m, "%d.%s", t, corps)
	return fmt.Sprintf("t=%d,v1=%s", t, hex.EncodeToString(m.Sum(nil)))
}

func entete(k, v string) http.Header {
	h := http.Header{}
	h.Set(k, v)
	return h
}

func TestStripeCreerPaiementUnique(t *testing.T) {
	s, f, _ := nouveauStripeTest(t, true)
	f.rep = `{"id":"cs_test_a1","object":"checkout.session","url":"https://checkout.stripe.com/c/pay/cs_test_a1#fid"}`
	d := Demande{Commande: cmdTest, Formule: Formule{Pro, JoursAn, false, Carte}, Pays: "DE",
		Retour: "https://shhgone.test/offres/retour", RenonciationHeure: 1795000000}
	ses, err := s.Creer(context.Background(), d)
	if err != nil || ses.URL != "https://checkout.stripe.com/c/pay/cs_test_a1#fid" || ses.Abonnement != "" {
		t.Fatal(ses, err)
	}
	r := f.req
	if r.Method != "POST" || r.URL.Path != "/v1/checkout/sessions" || r.Header.Get("Authorization") != "Bearer sk_test_cle" ||
		r.Header.Get("Stripe-Version") != StripeVersion || r.Header.Get("Idempotency-Key") != "commande-"+cmdTest.String() ||
		r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" || r.Header.Get("User-Agent") != "Shhgone" {
		t.Fatalf("%s %s %v", r.Method, r.URL, r.Header)
	}
	v, _ := url.ParseQuery(string(f.corps))
	want := map[string]string{
		"mode": "payment", "client_reference_id": cmdTest.String(), "metadata[commande]": cmdTest.String(),
		"metadata[pays_declare]": "DE", "metadata[renonciation]": "oui", "metadata[renonciation_heure]": "1795000000",
		"line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "eur",
		"line_items[0][price_data][unit_amount]": "20000", "line_items[0][price_data][tax_behavior]": "inclusive",
		"line_items[0][price_data][product_data][name]": "Shhgone Pro, 365 jours", "payment_method_types[0]": "card",
		"success_url": d.Retour, "cancel_url": d.Retour, "locale": "auto",
		"payment_intent_data[metadata][commande]": cmdTest.String(), "invoice_creation[enabled]": "true",
	}
	if len(v) != len(want) {
		t.Errorf("%d paramètres, %d attendus : %v", len(v), len(want), v)
	}
	for k, w := range want {
		if v.Get(k) != w {
			t.Errorf("%s = %q, attendu %q", k, v.Get(k), w)
		}
	}
	// Aucune donnée personnelle ni pass ne part.
	if strings.Contains(string(f.corps), "email") {
		t.Error("e-mail envoyé")
	}
}

func TestStripeCreerAbonnement(t *testing.T) {
	s, f, _ := nouveauStripeTest(t, true)
	s.taxe = true
	f.rep = `{"id":"cs_test_b","url":"https://checkout.stripe.com/c/pay/cs_test_b"}`
	if _, err := s.Creer(context.Background(), Demande{Commande: cmdTest, Formule: Formule{Plus, JoursMois, true, Carte}, Pays: "FR"}); err != nil {
		t.Fatal(err)
	}
	v, _ := url.ParseQuery(string(f.corps))
	if v.Get("mode") != "subscription" || v.Get("line_items[0][price_data][recurring][interval]") != "month" ||
		v.Get("line_items[0][price_data][unit_amount]") != "700" || v.Get("subscription_data[metadata][commande]") != cmdTest.String() ||
		v.Get("automatic_tax[enabled]") != "true" || v.Has("invoice_creation[enabled]") || v.Has("payment_intent_data[metadata][commande]") {
		t.Fatal(v)
	}
	if _, err := s.Creer(context.Background(), Demande{Commande: cmdTest, Formule: Formule{Pro, JoursAn, true, Carte}, Pays: "FR"}); err != nil {
		t.Fatal(err)
	}
	v, _ = url.ParseQuery(string(f.corps))
	if v.Get("line_items[0][price_data][recurring][interval]") != "year" {
		t.Fatal(v)
	}
}

func TestStripeCreerRefus(t *testing.T) {
	s, f, _ := nouveauStripeTest(t, true)
	f.statut, f.rep = 400, `{"error":{"message":"Invalid request"}}`
	if _, err := s.Creer(context.Background(), Demande{Commande: cmdTest, Formule: plusMois}); err != ErrPrestataire {
		t.Fatal(err)
	}
	f.statut, f.rep = 200, `pas du json`
	if _, err := s.Creer(context.Background(), Demande{Commande: cmdTest, Formule: plusMois}); err != ErrPrestataire {
		t.Fatal(err)
	}
}

func TestStripeResilier(t *testing.T) {
	s, f, _ := nouveauStripeTest(t, true)
	f.rep = `{"id":"sub_1Abc","cancel_at_period_end":true}`
	if err := s.Resilier(context.Background(), "sub_1Abc"); err != nil {
		t.Fatal(err)
	}
	if f.req.URL.Path != "/v1/subscriptions/sub_1Abc" || string(f.corps) != "cancel_at_period_end=true" || f.req.Header.Get("Idempotency-Key") != "" {
		t.Fatal(f.req.URL, string(f.corps))
	}
	if err := s.Resilier(context.Background(), "../x"); err != ErrPrestataire {
		t.Fatal("identifiant non vérifié")
	}
}

func evenementStripe(typ string, livemode bool, objet string) string {
	return fmt.Sprintf(`{"id":"evt_1","object":"event","api_version":"%s","created":1795000000,"livemode":%v,"pending_webhooks":1,"type":"%s","data":{"object":%s}}`,
		StripeVersion, livemode, typ, objet)
}

func TestStripeSignature(t *testing.T) {
	s, _, now := nouveauStripeTest(t, true)
	corps := evenementStripe("customer.created", false, `{"id":"cus_1"}`)
	ts := now.Unix()
	ok := signeStripe(whsec, ts, corps)
	if _, err := s.Lire(context.Background(), entete("Stripe-Signature", ok), []byte(corps)); err != nil {
		t.Fatal("signature juste refusée", err)
	}
	mauvais := signeStripe("whsec_autre", ts, corps)
	cas := map[string]string{
		"autre secret":     mauvais,
		"trop ancienne":    signeStripe(whsec, ts-301, corps),
		"dans le futur":    signeStripe(whsec, ts+301, corps),
		"sans v1":          fmt.Sprintf("t=%d", ts),
		"sans t":           strings.SplitN(ok, ",", 2)[1],
		"v0 seulement":     strings.Replace(ok, "v1=", "v0=", 1),
		"t double":         fmt.Sprintf("t=%d,", ts) + ok,
		"t à zéro initial": strings.Replace(ok, "t=", "t=0", 1),
		"vide":             "",
		"hex court":        fmt.Sprintf("t=%d,v1=abcd", ts),
		"paire sans égal":  ok + ",x",
	}
	for nom, sig := range cas {
		if _, err := s.Lire(context.Background(), entete("Stripe-Signature", sig), []byte(corps)); err != ErrSignature {
			t.Errorf("%s : %v", nom, err)
		}
	}
	// Plusieurs v1 (changement de secret) : une seule juste suffit, à toute place.
	multi := mauvais + ",v1=" + strings.SplitN(ok, "v1=", 2)[1]
	if _, err := s.Lire(context.Background(), entete("Stripe-Signature", multi), []byte(corps)); err != nil {
		t.Error("v1 multiples", err)
	}
	// Corps modifié d'un octet.
	if _, err := s.Lire(context.Background(), entete("Stripe-Signature", ok), []byte(corps+" ")); err != ErrSignature {
		t.Error("corps modifié accepté")
	}
	// En-tête en double.
	h := http.Header{"Stripe-Signature": {ok, ok}}
	if _, err := s.Lire(context.Background(), h, []byte(corps)); err != ErrSignature {
		t.Error("en-tête double accepté")
	}
	// Bornes de la tolérance : ±300 s acceptées.
	for _, d := range []int64{-300, 300} {
		if _, err := s.Lire(context.Background(), entete("Stripe-Signature", signeStripe(whsec, ts+d, corps)), []byte(corps)); err != nil {
			t.Errorf("écart %d s refusé", d)
		}
	}
	// Mode : un événement réel (livemode) refusé par un serveur en essai, et l'inverse.
	reel := evenementStripe("customer.created", true, `{}`)
	if _, err := s.Lire(context.Background(), entete("Stripe-Signature", signeStripe(whsec, ts, reel)), []byte(reel)); err != ErrSignature {
		t.Error("livemode accepté en essai")
	}
	s.essai = false
	if _, err := s.Lire(context.Background(), entete("Stripe-Signature", ok), []byte(corps)); err != ErrSignature {
		t.Error("événement de test accepté en production")
	}
}

func lireStripe(t *testing.T, s *Stripe, now time.Time, typ, objet string) []Evenement {
	t.Helper()
	corps := evenementStripe(typ, false, objet)
	evs, err := s.Lire(context.Background(), entete("Stripe-Signature", signeStripe(whsec, now.Unix(), corps)), []byte(corps))
	if err != nil {
		t.Fatal(typ, err)
	}
	return evs
}

func TestStripeEvenements(t *testing.T) {
	s, _, now := nouveauStripeTest(t, true)
	c := cmdTest.String()
	un := func(evs []Evenement) Evenement {
		t.Helper()
		if len(evs) != 1 {
			t.Fatalf("%d événements", len(evs))
		}
		return evs[0]
	}
	// Session payée, paiement unique.
	e := un(lireStripe(t, s, *now, "checkout.session.completed", `{"id":"cs_test_1","object":"checkout.session","client_reference_id":"`+c+
		`","metadata":{"commande":"`+c+`"},"mode":"payment","payment_status":"paid","status":"complete","payment_intent":"pi_3Abc",`+
		`"invoice":"in_1Inv","subscription":null,"amount_total":7000,"currency":"eur","customer_details":{"email":"x@y.z","address":{"country":"FR"}}}`))
	if e.Sorte != Confirme || !e.AvecCommande || e.Commande != cmdTest || e.Ref != "pi_3Abc" || e.Montant != 7000 || e.Devise != "eur" || e.Abonnement != "" {
		t.Fatalf("%+v", e)
	}
	// Session payée, abonnement : la référence est la première facture.
	e = un(lireStripe(t, s, *now, "checkout.session.completed", `{"object":"checkout.session","client_reference_id":"`+c+
		`","mode":"subscription","payment_status":"paid","payment_intent":null,"invoice":"in_1First","subscription":"sub_1Sub","amount_total":700,"currency":"eur"}`))
	if e.Sorte != Confirme || e.Ref != "in_1First" || e.Abonnement != "sub_1Sub" {
		t.Fatalf("%+v", e)
	}
	// Paiement différé pas encore reçu, ou session d'une autre application : rien.
	if evs := lireStripe(t, s, *now, "checkout.session.completed", `{"client_reference_id":"`+c+`","mode":"payment","payment_status":"unpaid"}`); len(evs) != 0 {
		t.Fatal(evs)
	}
	if evs := lireStripe(t, s, *now, "checkout.session.completed", `{"client_reference_id":"autre","mode":"payment","payment_status":"paid","payment_intent":"pi_x"}`); len(evs) != 0 {
		t.Fatal(evs)
	}
	e = un(lireStripe(t, s, *now, "checkout.session.async_payment_succeeded", `{"client_reference_id":"`+c+`","mode":"payment","payment_status":"paid","payment_intent":{"id":"pi_obj"},"amount_total":700,"currency":"eur"}`))
	if e.Ref != "pi_obj" {
		t.Fatal("payment_intent développé", e)
	}
	e = un(lireStripe(t, s, *now, "checkout.session.expired", `{"client_reference_id":"`+c+`","status":"expired"}`))
	if e.Sorte != NonAbouti || e.Commande != cmdTest {
		t.Fatal(e)
	}
	// Facture d'abonnement, version « clover » (parent.subscription_details).
	e = un(lireStripe(t, s, *now, "invoice.paid", `{"id":"in_1Cyc","object":"invoice","billing_reason":"subscription_cycle","amount_paid":2000,"currency":"eur",`+
		`"parent":{"type":"subscription_details","subscription_details":{"metadata":{"commande":"`+c+`"},"subscription":"sub_1Sub"}}}`))
	if e.Sorte != Confirme || e.Commande != cmdTest || e.Abonnement != "sub_1Sub" || e.Ref != "in_1Cyc" || e.Montant != 2000 {
		t.Fatalf("%+v", e)
	}
	// Ancienne forme : invoice.subscription, sans métadonnées.
	e = un(lireStripe(t, s, *now, "invoice.paid", `{"id":"in_old","billing_reason":"subscription_cycle","amount_paid":700,"currency":"eur","subscription":"sub_old"}`))
	if e.AvecCommande || e.Abonnement != "sub_old" {
		t.Fatal(e)
	}
	if evs := lireStripe(t, s, *now, "invoice.paid", `{"id":"in_m","billing_reason":"manual","amount_paid":700,"currency":"eur","subscription":"sub_old"}`); len(evs) != 0 {
		t.Fatal("facture manuelle créditée")
	}
	e = un(lireStripe(t, s, *now, "customer.subscription.deleted", `{"id":"sub_1Sub","object":"subscription","status":"canceled","metadata":{"commande":"`+c+`"}}`))
	if e.Sorte != FinRenouvellement || e.Abonnement != "sub_1Sub" || e.Commande != cmdTest {
		t.Fatal(e)
	}
	e = un(lireStripe(t, s, *now, "charge.refunded", `{"id":"ch_1","object":"charge","amount":7000,"amount_refunded":7000,"refunded":true,"payment_intent":"pi_3Abc","metadata":{}}`))
	if e.Sorte != Revoque || e.Ref != "pi_3Abc" || e.AvecCommande {
		t.Fatal(e)
	}
	if evs := lireStripe(t, s, *now, "charge.refunded", `{"id":"ch_1","amount":7000,"amount_refunded":100,"refunded":false,"payment_intent":"pi_3Abc"}`); len(evs) != 0 {
		t.Fatal("remboursement partiel révoqué")
	}
	e = un(lireStripe(t, s, *now, "charge.dispute.created", `{"id":"dp_1","object":"dispute","charge":"ch_1","payment_intent":"pi_3Abc","reason":"fraudulent","metadata":{}}`))
	if e.Sorte != Revoque || e.Ref != "pi_3Abc" {
		t.Fatal(e)
	}
	if evs := lireStripe(t, s, *now, "payment_intent.created", `{"id":"pi_1"}`); len(evs) != 0 {
		t.Fatal("type non traité")
	}
	// Objet illisible pour un type traité : refus.
	corps := evenementStripe("invoice.paid", false, `"texte"`)
	if _, err := s.Lire(context.Background(), entete("Stripe-Signature", signeStripe(whsec, now.Unix(), corps)), []byte(corps)); err != ErrSignature {
		t.Fatal(err)
	}
}

// Risque S10 (audit du 20 novembre, S6) : un abonnement Stripe contesté ne porte, dans
// charge.dispute.created, que le PaymentIntent de la facture ; invoice_payment.paid le range
// avec la commande, et le litige révoque le pass.
func TestStripeAbonnementConteste(t *testing.T) {
	b := nouveauBanc(t)
	s, _, now := nouveauStripeTest(t, true)
	webhook := func(typ, objet string) error {
		t.Helper()
		corps := evenementStripe(typ, false, objet)
		return b.s.Webhook(context.Background(), s, entete("Stripe-Signature", signeStripe(whsec, now.Unix(), corps)), []byte(corps))
	}
	c := b.commander(t, passN(1), plusMois)
	lien := `{"id":"inpay_1","object":"invoice_payment","amount_paid":700,"currency":"eur","invoice":"in_1Sub",` +
		`"is_default":true,"payment":{"type":"payment_intent","payment_intent":"pi_1Sub"},"status":"paid"}`
	// Avant le crédit de la facture : le prestataire réessaiera.
	if err := webhook("invoice_payment.paid", lien); err != ErrPasEncore {
		t.Fatal("lien avant la facture", err)
	}
	if err := webhook("invoice.paid", `{"id":"in_1Sub","object":"invoice","billing_reason":"subscription_create","amount_paid":700,"currency":"eur",`+
		`"parent":{"type":"subscription_details","subscription_details":{"metadata":{"commande":"`+c.String()+`"},"subscription":"sub_1Sub"}}}`); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "payee" {
		t.Fatal(e)
	}
	for range 2 { // rejoué : sans effet
		if err := webhook("invoice_payment.paid", lien); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM refs WHERE commande=?`, c[:]).Scan(&n)
	if n != 2 {
		t.Fatal("références", n)
	}
	if err := webhook("charge.dispute.created", `{"id":"dp_1","object":"dispute","charge":"ch_1","payment_intent":"pi_1Sub","reason":"fraudulent","metadata":{}}`); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "revoquee" {
		t.Fatal("litige d'abonnement non révoqué", e)
	}

	// Remboursement total d'une facture d'abonnement : même chemin.
	c2 := b.commander(t, passN(2), plusMois)
	for _, ev := range [][2]string{
		{"invoice.paid", `{"id":"in_2","billing_reason":"subscription_create","amount_paid":700,"currency":"eur",` +
			`"parent":{"subscription_details":{"metadata":{"commande":"` + c2.String() + `"},"subscription":"sub_2"}}}`},
		{"invoice_payment.paid", `{"invoice":"in_2","payment":{"type":"payment_intent","payment_intent":{"id":"pi_2"}},"status":"paid"}`},
		{"charge.refunded", `{"id":"ch_2","object":"charge","refunded":true,"payment_intent":"pi_2","metadata":{}}`},
	} {
		if err := webhook(ev[0], ev[1]); err != nil {
			t.Fatal(ev[0], err)
		}
	}
	if e := b.etat(t, passN(2)); e.Etat != "revoquee" {
		t.Fatal("remboursement d'abonnement non révoqué", e)
	}

	// Paiement unique : son PaymentIntent est déjà la référence du crédit ; le lien de la facture
	// (invoice_creation) ne change rien et ne fait pas réessayer.
	c3 := b.commander(t, passN(3), Formule{Plus, JoursAn, false, Carte})
	if err := webhook("checkout.session.completed", `{"client_reference_id":"`+c3.String()+
		`","mode":"payment","payment_status":"paid","payment_intent":"pi_3","amount_total":7000,"currency":"eur"}`); err != nil {
		t.Fatal(err)
	}
	if err := webhook("invoice_payment.paid", `{"invoice":"in_3","payment":{"type":"payment_intent","payment_intent":"pi_3"},"status":"paid"}`); err != nil {
		t.Fatal(err)
	}
	// Paiement non abouti, ou d'un autre type : ignoré.
	if evs := lireStripe(t, s, *now, "invoice_payment.paid", `{"invoice":"in_4","payment":{"type":"payment_intent","payment_intent":"pi_4"},"status":"open"}`); len(evs) != 0 {
		t.Fatal(evs)
	}
	if evs := lireStripe(t, s, *now, "invoice_payment.paid", `{"invoice":"in_4","payment":{"type":"out_of_band_payment"},"status":"paid"}`); len(evs) != 0 {
		t.Fatal(evs)
	}
	if e := un(lireStripe(t, s, *now, "invoice_payment.paid", lien)); e.Sorte != LieRef || e.Ref != "in_1Sub" || e.RefLiee != "pi_1Sub" {
		t.Fatalf("%+v", e)
	}
}

func un(evs []Evenement) Evenement {
	if len(evs) != 1 {
		panic(len(evs))
	}
	return evs[0]
}

// S6-4 : invoice_payment.paid d'une facture jamais créditée (motif hors subscription_create et
// subscription_cycle, ou commande purgée) : 500 (Stripe réessaie) tant que l'événement signé a
// moins de 24 h, pour l'ordre d'arrivée ; ensuite 200 sans rien faire, au lieu de 500 sans fin.
func TestStripeLienFactureInconnueTardif(t *testing.T) {
	b := nouveauBanc(t)
	s, _, now := nouveauStripeTest(t, true)
	lien := `{"invoice":"in_inconnue","payment":{"type":"payment_intent","payment_intent":"pi_inconnu"},"status":"paid"}`
	webhook := func(cree int64) error {
		t.Helper()
		corps := strings.Replace(evenementStripe("invoice_payment.paid", false, lien), `"created":1795000000`, fmt.Sprintf(`"created":%d`, cree), 1)
		return b.s.Webhook(context.Background(), s, entete("Stripe-Signature", signeStripe(whsec, now.Unix(), corps)), []byte(corps))
	}
	for _, age := range []time.Duration{0, time.Hour, 24 * time.Hour} {
		if err := webhook(now.Add(-age).Unix()); err != ErrPasEncore {
			t.Fatal(age, err)
		}
	}
	if err := webhook(now.Add(-24*time.Hour - time.Second).Unix()); err != nil {
		t.Fatal("après 24 h", err)
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM refs`).Scan(&n)
	if n != 0 {
		t.Fatal("référence rangée sans commande", n)
	}
	// Champ created absent ou nul : jamais « tardif » (comportement d'avant, Stripe réessaie).
	if err := webhook(0); err != ErrPasEncore {
		t.Fatal(err)
	}
}

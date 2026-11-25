package paiement

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fauxPayPal : faux serveur de l'API PayPal (jeton, commandes, abonnements, vérification,
// capture). verif : réponse de verify-webhook-signature.
type fauxPayPal struct {
	mu      sync.Mutex
	srv     *httptest.Server
	appels  []string
	corps   map[string][]byte
	entetes map[string]http.Header
	verif   string
	verifSt int
	capture string
	captSt  int
	jetons  int
	bloquer chan struct{}
}

func nouveauFauxPayPal(t *testing.T) *fauxPayPal {
	f := &fauxPayPal{corps: map[string][]byte{}, entetes: map[string]http.Header{}, verif: `{"verification_status":"SUCCESS"}`, verifSt: 200, captSt: 201}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.appels = append(f.appels, r.Method+" "+r.URL.Path)
		f.corps[r.URL.Path], f.entetes[r.URL.Path] = b, r.Header.Clone()
		bloquer := f.bloquer
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/oauth2/token":
			f.mu.Lock()
			f.jetons++
			f.mu.Unlock()
			io.WriteString(w, `{"scope":"https://uri.paypal.com/services/payments/payment","access_token":"A21AAtest","token_type":"Bearer","app_id":"APP-80W284485P519543T","expires_in":32400,"nonce":"2026-11-19T15:00:00Zabc"}`)
		case r.URL.Path == "/v2/checkout/orders":
			w.WriteHeader(200)
			io.WriteString(w, `{"id":"5O190127TN364715T","status":"PAYER_ACTION_REQUIRED","payment_source":{"paypal":{}},"links":[{"href":"https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T","rel":"self","method":"GET"},{"href":"https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T","rel":"payer-action","method":"GET"}]}`)
		case r.URL.Path == "/v1/billing/subscriptions":
			w.WriteHeader(201)
			io.WriteString(w, `{"status":"APPROVAL_PENDING","id":"I-BW452GLLEP1G","create_time":"2026-11-19T15:00:00Z","links":[{"href":"https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-2M539689T3856352J","rel":"approve","method":"GET"},{"href":"https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-BW452GLLEP1G","rel":"edit","method":"PATCH"}]}`)
		case r.URL.Path == "/v1/notifications/verify-webhook-signature":
			if bloquer != nil {
				<-bloquer
			}
			w.WriteHeader(f.verifSt)
			io.WriteString(w, f.verif)
		case strings.HasSuffix(r.URL.Path, "/capture"):
			w.WriteHeader(f.captSt)
			io.WriteString(w, f.capture)
		case strings.HasSuffix(r.URL.Path, "/cancel"):
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

var plansTest = Plans{PlusMois: "P-PLUSMOIS", PlusAn: "P-PLUSAN", ProMois: "P-PROMOIS", ProAn: "P-PROAN"}

func nouveauPayPalTest(t *testing.T) (*PayPalP, *fauxPayPal) {
	f := nouveauFauxPayPal(t)
	now := time.Unix(1795000000, 0)
	p := NouveauPayPal("client-id", "secret-app", "WH-1TEST", plansTest, true, clientTest(f.srv.Client()), func() time.Time { return now })
	p.base = f.srv.URL
	return p, f
}

func TestPayPalCommandeUnique(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	v, _ := Ventiler(OSS, "FR", 7000)
	ses, err := p.Creer(context.Background(), Demande{Commande: cmdTest, Formule: Formule{Plus, JoursAn, false, PayPal}, Pays: "FR",
		Ventilation: v, Retour: "https://shhgone.test/offres/retour"})
	if err != nil || ses.URL != "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T" || ses.Abonnement != "" {
		t.Fatal(ses, err)
	}
	if !adressePermise(ses.URL, p.Origines()) {
		t.Fatal("adresse du bac à sable refusée")
	}
	h := f.entetes["/v1/oauth2/token"]
	if h.Get("Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("client-id:secret-app")) || string(f.corps["/v1/oauth2/token"]) != "grant_type=client_credentials" {
		t.Fatal("jeton", h)
	}
	h = f.entetes["/v2/checkout/orders"]
	if h.Get("Authorization") != "Bearer A21AAtest" || h.Get("PayPal-Request-Id") != "commande-"+cmdTest.String() || h.Get("Content-Type") != "application/json" {
		t.Fatal(h)
	}
	var o map[string]any
	if err := json.Unmarshal(f.corps["/v2/checkout/orders"], &o); err != nil {
		t.Fatal(err)
	}
	pu := o["purchase_units"].([]any)[0].(map[string]any)
	am := pu["amount"].(map[string]any)
	bd := am["breakdown"].(map[string]any)
	it := pu["items"].([]any)[0].(map[string]any)
	if o["intent"] != "CAPTURE" || pu["custom_id"] != cmdTest.String() || am["value"] != "70.00" || am["currency_code"] != "EUR" ||
		bd["item_total"].(map[string]any)["value"] != "58.33" || bd["tax_total"].(map[string]any)["value"] != "11.67" ||
		it["category"] != "DIGITAL_GOODS" || it["quantity"] != "1" || it["unit_amount"].(map[string]any)["value"] != "58.33" {
		t.Fatalf("%s", f.corps["/v2/checkout/orders"])
	}
	ec := o["payment_source"].(map[string]any)["paypal"].(map[string]any)["experience_context"].(map[string]any)
	if ec["return_url"] != "https://shhgone.test/offres/retour" || ec["user_action"] != "PAY_NOW" || ec["shipping_preference"] != "NO_SHIPPING" {
		t.Fatal(ec)
	}
	// Jeton gardé : un second appel ne le redemande pas.
	p.Creer(context.Background(), Demande{Commande: cmdTest, Formule: Formule{Plus, JoursAn, false, PayPal}, Ventilation: v})
	if f.jetons != 1 {
		t.Fatal("jeton redemandé", f.jetons)
	}
}

func TestPayPalAbonnement(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	ses, err := p.Creer(context.Background(), Demande{Commande: cmdTest, Formule: Formule{Pro, JoursMois, true, PayPal}, Retour: "https://shhgone.test/offres/retour"})
	if err != nil || ses.Abonnement != "I-BW452GLLEP1G" || !strings.HasPrefix(ses.URL, "https://www.sandbox.paypal.com/webapps/billing/") {
		t.Fatal(ses, err)
	}
	var o map[string]any
	json.Unmarshal(f.corps["/v1/billing/subscriptions"], &o)
	ac := o["application_context"].(map[string]any)
	if o["plan_id"] != "P-PROMOIS" || o["custom_id"] != cmdTest.String() || ac["user_action"] != "SUBSCRIBE_NOW" || ac["return_url"] != "https://shhgone.test/offres/retour" {
		t.Fatal(o)
	}
	if f.entetes["/v1/billing/subscriptions"].Get("PayPal-Request-Id") != "abonnement-"+cmdTest.String() {
		t.Fatal("idempotence")
	}
	if err := p.Resilier(context.Background(), "I-BW452GLLEP1G"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(f.appels, ","), "POST /v1/billing/subscriptions/I-BW452GLLEP1G/cancel") {
		t.Fatal(f.appels)
	}
}

func TestPayPalEurosCentimes(t *testing.T) {
	for c, s := range map[int64]string{700: "7.00", 7000: "70.00", 5833: "58.33", 5: "0.05", 117: "1.17"} {
		if euros(c) != s || centimes(s) != c {
			t.Errorf("%d ↔ %s", c, s)
		}
	}
	for s, c := range map[string]int64{"7": 700, "7.5": 750, "": -1, "7.": -1, "7.001": -1, "-7.00": -1, "07.00": -1, "7,00": -1, "a.00": -1, "7.0a": -1} {
		if centimes(s) != c {
			t.Errorf("%q → %d", s, centimes(s))
		}
	}
}

func entetesPP() http.Header {
	h := http.Header{}
	h.Set("Paypal-Auth-Algo", "SHA256withRSA")
	h.Set("Paypal-Cert-Url", "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270")
	h.Set("Paypal-Transmission-Id", "69cd13f0-d67a-11e5-baa3-778b53f4ae55")
	h.Set("Paypal-Transmission-Sig", "lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==")
	h.Set("Paypal-Transmission-Time", "2026-11-19T15:00:00Z")
	return h
}

// entetesPPId : entetesPP avec un autre Paypal-Transmission-Id.
func entetesPPId(id string) http.Header {
	h := entetesPP()
	h.Set("Paypal-Transmission-Id", id)
	return h
}

const ppCaptureComplete = `{"id":"WH-58D329510W468432D-8HN650336L201105X","create_time":"2026-11-19T15:00:00.000Z","resource_type":"capture","event_type":"PAYMENT.CAPTURE.COMPLETED","summary":"Payment completed for EUR 70.0 EUR","resource":{"amount":{"currency_code":"EUR","value":"70.00"},"seller_protection":{"status":"ELIGIBLE"},"supplementary_data":{"related_ids":{"order_id":"5O190127TN364715T"}},"final_capture":true,"custom_id":"a1b2c3d4e5f60718293a4b5c6d7e8f90","seller_receivable_breakdown":{"gross_amount":{"currency_code":"EUR","value":"70.00"},"paypal_fee":{"currency_code":"EUR","value":"2.73"},"net_amount":{"currency_code":"EUR","value":"67.27"}},"links":[{"href":"https://api.sandbox.paypal.com/v2/payments/captures/7NW873794T343360M","rel":"self","method":"GET"}],"id":"7NW873794T343360M","status":"COMPLETED"},"links":[],"event_version":"1.0","resource_version":"2.0"}`

func TestPayPalVerificationBrute(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	// Le corps reçu, avec ses espaces, part tel quel dans webhook_event.
	corps := "{ \"id\" : \"WH-1\",  \"event_type\":\"PAYMENT.CAPTURE.COMPLETED\",\n \"resource\":{\"id\":\"7NW\",\"status\":\"COMPLETED\",\"custom_id\":\"" + cmdTest.String() + "\",\"amount\":{\"currency_code\":\"EUR\",\"value\":\"7.00\"}} }"
	evs, err := p.Lire(context.Background(), entetesPP(), []byte(corps))
	if err != nil || len(evs) != 1 || evs[0].Sorte != Confirme || evs[0].Ref != "7NW" || evs[0].Montant != 700 || evs[0].Devise != "eur" || evs[0].Commande != cmdTest {
		t.Fatal(evs, err)
	}
	envoye := string(f.corps["/v1/notifications/verify-webhook-signature"])
	if !strings.HasSuffix(envoye, `"webhook_event":`+corps+`}`) {
		t.Fatalf("corps réencodé : %s", envoye)
	}
	var v struct {
		AuthAlgo, CertURL, TransmissionID, TransmissionSig, TransmissionTime, WebhookID string
	}
	dec := map[string]any{}
	if err := json.Unmarshal([]byte(envoye), &dec); err != nil {
		t.Fatal(err)
	}
	_ = v
	h := entetesPP()
	if dec["auth_algo"] != "SHA256withRSA" || dec["cert_url"] != h.Get("Paypal-Cert-Url") || dec["transmission_id"] != h.Get("Paypal-Transmission-Id") ||
		dec["transmission_sig"] != h.Get("Paypal-Transmission-Sig") || dec["transmission_time"] != h.Get("Paypal-Transmission-Time") || dec["webhook_id"] != "WH-1TEST" {
		t.Fatal(dec)
	}
}

func TestPayPalVerificationRefus(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	ok := entetesPP()
	f.verif = `{"verification_status":"FAILURE"}`
	if _, err := p.Lire(context.Background(), ok, []byte(ppCaptureComplete)); err != ErrSignature {
		t.Fatal("FAILURE accepté", err)
	}
	f.verif, f.verifSt = `{"name":"VALIDATION_ERROR"}`, 400
	if _, err := p.Lire(context.Background(), entetesPPId("tid-400"), []byte(ppCaptureComplete)); err != ErrSignature {
		t.Fatal("400 accepté", err)
	}
	f.verifSt = 503
	if _, err := p.Lire(context.Background(), entetesPPId("tid-503"), []byte(ppCaptureComplete)); err != errVerif {
		t.Fatal("panne de PayPal : réessayer", err)
	}
	f.verif, f.verifSt = `{"verification_status":"SUCCESS"}`, 200
	avant := len(f.appels)
	// Contrôles locaux : aucun appel sortant.
	for nom, mod := range map[string]func(http.Header){
		"sans algo":       func(h http.Header) { h.Del("Paypal-Auth-Algo") },
		"cert ailleurs":   func(h http.Header) { h.Set("Paypal-Cert-Url", "https://evil.example/cert") },
		"cert production": func(h http.Header) { h.Set("Paypal-Cert-Url", "https://api.paypal.com/v1/notifications/certs/X") },
		"id en double":    func(h http.Header) { h.Add("Paypal-Transmission-Id", "x") },
		"sig avec espace": func(h http.Header) { h.Set("Paypal-Transmission-Sig", "a b") },
		"heure vide":      func(h http.Header) { h.Set("Paypal-Transmission-Time", "") },
	} {
		h := entetesPP()
		mod(h)
		if _, err := p.Lire(context.Background(), h, []byte(ppCaptureComplete)); err != ErrSignature {
			t.Errorf("%s : %v", nom, err)
		}
	}
	for _, c := range []string{`{}`, `{"id":"x"}`, `[1]`, `pas du json`} {
		if _, err := p.Lire(context.Background(), ok, []byte(c)); err != ErrSignature {
			t.Errorf("%s : %v", c, err)
		}
	}
	if len(f.appels) != avant {
		t.Fatal("appel sortant pour une requête fausse", f.appels[avant:])
	}
}

func TestPayPalVerificationsBornees(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	p.jetonAcces(context.Background())
	f.mu.Lock()
	f.bloquer = make(chan struct{})
	f.mu.Unlock()
	var wg sync.WaitGroup
	for i := 0; i < verifsPayPal; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.Lire(context.Background(), entetesPPId(fmt.Sprint("tid-", i)), []byte(ppCaptureComplete))
		}()
	}
	// Attendre que les quatre places soient prises.
	for i := 0; i < 500 && len(p.verifs) < verifsPayPal; i++ {
		time.Sleep(2 * time.Millisecond)
	}
	if _, err := p.Lire(context.Background(), entetesPP(), []byte(ppCaptureComplete)); err != ErrOccupe {
		t.Error("5e vérification simultanée acceptée", err)
	}
	close(f.bloquer)
	wg.Wait()
}

// verifsFaites : appels sortants de vérification reçus par le faux PayPal.
func (f *fauxPayPal) verifsFaites() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, a := range f.appels {
		if a == "POST /v1/notifications/verify-webhook-signature" {
			n++
		}
	}
	return n
}

// Un faux webhook répété (même Paypal-Transmission-Id) ne provoque
// qu'un appel sortant ; un identifiant vérifié, ou dont la vérification a échoué chez PayPal
// (panne), n'est pas gardé : PayPal peut le renvoyer.
func TestPayPalTransmissionRefusee(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	now := time.Unix(1795000000, 0)
	p.now = func() time.Time { return now }
	f.verif = `{"verification_status":"FAILURE"}`
	for i := 0; i < 20; i++ {
		if _, err := p.Lire(context.Background(), entetesPP(), []byte(ppCaptureComplete)); err != ErrSignature {
			t.Fatal(i, err)
		}
	}
	if n := f.verifsFaites(); n != 1 {
		t.Fatal("appels sortants pour un faux webhook répété :", n)
	}
	// Même faux, signature ou corps changés : toujours le même identifiant, aucun appel.
	h := entetesPP()
	h.Set("Paypal-Transmission-Sig", "autre")
	if _, err := p.Lire(context.Background(), h, []byte(ppCaptureComplete)); err != ErrSignature || f.verifsFaites() != 1 {
		t.Fatal(err, f.verifsFaites())
	}
	// Une heure après : oublié, de nouveau vérifié.
	now = now.Add(transmissionsDuree)
	p.Lire(context.Background(), entetesPP(), []byte(ppCaptureComplete))
	if n := f.verifsFaites(); n != 2 {
		t.Fatal("identifiant jamais oublié", n)
	}
	// Panne de PayPal : rien de gardé, le prestataire réessaie le même identifiant.
	f.verifSt = 503
	p.Lire(context.Background(), entetesPPId("tid-panne"), []byte(ppCaptureComplete))
	f.verif, f.verifSt = `{"verification_status":"SUCCESS"}`, 200
	if _, err := p.Lire(context.Background(), entetesPPId("tid-panne"), []byte(ppCaptureComplete)); err != nil {
		t.Fatal("réessai après panne refusé", err)
	}
	// Vérifié : rien de gardé non plus (rejoué : vérifié de nouveau, idempotent ensuite).
	if _, err := p.Lire(context.Background(), entetesPPId("tid-panne"), []byte(ppCaptureComplete)); err != nil {
		t.Fatal(err)
	}
	if n := f.verifsFaites(); n != 5 {
		t.Fatal(n)
	}
	if len(p.refusees.vu) != 1 {
		t.Fatal("identifiants gardés", len(p.refusees.vu))
	}
}

// Même identifiant envoyé en parallèle : une seule vérification en cours, les autres refusées
// sans appel.
func TestPayPalTransmissionEnCours(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	p.jetonAcces(context.Background())
	f.mu.Lock()
	f.bloquer = make(chan struct{})
	f.mu.Unlock()
	f.verif = `{"verification_status":"FAILURE"}`
	done := make(chan error)
	go func() { _, err := p.Lire(context.Background(), entetesPP(), []byte(ppCaptureComplete)); done <- err }()
	for i := 0; i < 500 && len(p.verifs) < 1; i++ {
		time.Sleep(2 * time.Millisecond)
	}
	for i := 0; i < 10; i++ {
		if _, err := p.Lire(context.Background(), entetesPP(), []byte(ppCaptureComplete)); err != ErrSignature {
			t.Fatal(err)
		}
	}
	close(f.bloquer)
	if err := <-done; err != ErrSignature {
		t.Fatal(err)
	}
	if n := f.verifsFaites(); n != 1 {
		t.Fatal(n)
	}
}

// Table pleine : rien n'est gardé de plus, la vérification a lieu (bornée ailleurs) ; les
// identifiants échus sont oubliés d'abord.
func TestTransmissionsBornees(t *testing.T) {
	tr := transmissions{vu: map[[32]byte]time.Time{}}
	now := time.Unix(1795000000, 0)
	for i := 0; i < transmissionsMax; i++ {
		c, marque, ok := tr.prendre(fmt.Sprint("id-", i), now)
		if !marque || !ok {
			t.Fatal(i)
		}
		tr.finir(c, true, now)
	}
	if _, marque, ok := tr.prendre("encore", now); marque || !ok {
		t.Fatal("table pleine : ni gardé ni refusé")
	}
	if _, _, ok := tr.prendre("id-1", now); ok {
		t.Fatal("refusé oublié")
	}
	now = now.Add(transmissionsDuree)
	if _, marque, ok := tr.prendre("encore", now); !marque || !ok || len(tr.vu) != 1 {
		t.Fatal("échus non oubliés", len(tr.vu))
	}
}

func lirePP(t *testing.T, p *PayPalP, typ, ressource string) []Evenement {
	t.Helper()
	corps := `{"id":"WH-TEST","event_version":"1.0","create_time":"2026-11-19T15:00:00Z","resource_type":"x","event_type":"` + typ + `","resource":` + ressource + `}`
	evs, err := p.Lire(context.Background(), entetesPP(), []byte(corps))
	if err != nil {
		t.Fatal(typ, err)
	}
	return evs
}

func TestPayPalEvenements(t *testing.T) {
	p, f := nouveauPayPalTest(t)
	c := cmdTest.String()
	un := func(evs []Evenement) Evenement {
		t.Helper()
		if len(evs) != 1 {
			t.Fatalf("%d événements : %+v", len(evs), evs)
		}
		return evs[0]
	}
	e := un(lirePP(t, p, "PAYMENT.CAPTURE.COMPLETED", ppCaptureCompleteRessource()))
	if e.Sorte != Confirme || e.Ref != "7NW873794T343360M" || e.Montant != 7000 || e.Commande != cmdTest {
		t.Fatal(e)
	}
	// Commande approuvée : capture, qui confirme.
	f.capture = `{"id":"5O190127TN364715T","status":"COMPLETED","purchase_units":[{"reference_id":"default","payments":{"captures":[{"id":"3C679366HH908993F","status":"COMPLETED","amount":{"currency_code":"EUR","value":"70.00"},"final_capture":true,"custom_id":"` + c + `"}]}}]}`
	e = un(lirePP(t, p, "CHECKOUT.ORDER.APPROVED", `{"id":"5O190127TN364715T","intent":"CAPTURE","status":"APPROVED","purchase_units":[{"reference_id":"default","custom_id":"`+c+`","amount":{"currency_code":"EUR","value":"70.00"}}]}`))
	if e.Sorte != Confirme || e.Ref != "3C679366HH908993F" || e.Montant != 7000 || e.Commande != cmdTest {
		t.Fatal(e)
	}
	if h := f.entetes["/v2/checkout/orders/5O190127TN364715T/capture"]; h.Get("PayPal-Request-Id") != "capture-"+c {
		t.Fatal("capture sans idempotence", h)
	}
	f.captSt, f.capture = 422, `{"name":"UNPROCESSABLE_ENTITY","details":[{"issue":"ORDER_ALREADY_CAPTURED"}]}`
	if evs := lirePP(t, p, "CHECKOUT.ORDER.APPROVED", `{"id":"5O190127TN364715T","purchase_units":[{"custom_id":"`+c+`"}]}`); len(evs) != 0 {
		t.Fatal(evs)
	}
	if evs := lirePP(t, p, "CHECKOUT.ORDER.APPROVED", `{"id":"5O1","purchase_units":[{"custom_id":"pas-a-nous"}]}`); len(evs) != 0 {
		t.Fatal(evs)
	}
	e = un(lirePP(t, p, "PAYMENT.CAPTURE.DENIED", `{"id":"7NW","status":"DECLINED","custom_id":"`+c+`"}`))
	if e.Sorte != NonAbouti {
		t.Fatal(e)
	}
	e = un(lirePP(t, p, "PAYMENT.CAPTURE.REFUNDED", `{"id":"1JU08902781691411","amount":{"value":"70.00","currency_code":"EUR"},"status":"COMPLETED","links":[{"rel":"self","href":"https://api.sandbox.paypal.com/v2/payments/refunds/1JU08902781691411","method":"GET"},{"rel":"up","href":"https://api.sandbox.paypal.com/v2/payments/captures/7NW873794T343360M","method":"GET"}]}`))
	if e.Sorte != Revoque || e.Ref != "7NW873794T343360M" || e.Montant != 7000 || e.AvecCommande {
		t.Fatal(e)
	}
	e = un(lirePP(t, p, "BILLING.SUBSCRIPTION.ACTIVATED", `{"id":"I-BW452GLLEP1G","plan_id":"P-PROMOIS","status":"ACTIVE","custom_id":"`+c+`"}`))
	if e.Sorte != PoseAbonnement || e.Abonnement != "I-BW452GLLEP1G" || e.Commande != cmdTest {
		t.Fatal(e)
	}
	e = un(lirePP(t, p, "BILLING.SUBSCRIPTION.CANCELLED", `{"id":"I-BW452GLLEP1G","status":"CANCELLED"}`))
	if e.Sorte != FinRenouvellement || e.Abonnement != "I-BW452GLLEP1G" {
		t.Fatal(e)
	}
	e = un(lirePP(t, p, "PAYMENT.SALE.COMPLETED", `{"amount":{"total":"20.00","currency":"EUR","details":{"subtotal":"20.00"}},"id":"80021663DE681814L","state":"completed","billing_agreement_id":"I-BW452GLLEP1G","custom":"`+c+`"}`))
	if e.Sorte != Confirme || e.Ref != "80021663DE681814L" || e.Abonnement != "I-BW452GLLEP1G" || e.Montant != 2000 || e.Devise != "eur" || e.Commande != cmdTest {
		t.Fatal(e)
	}
	if evs := lirePP(t, p, "PAYMENT.SALE.COMPLETED", `{"amount":{"total":"20.00","currency":"EUR"},"id":"X","state":"completed"}`); len(evs) != 0 {
		t.Fatal("vente hors abonnement", evs)
	}
	e = un(lirePP(t, p, "PAYMENT.SALE.REFUNDED", `{"id":"4CF18861HF410323U","state":"completed","amount":{"total":"-5.00","currency":"EUR"},"sale_id":"80021663DE681814L"}`))
	if e.Sorte != Revoque || e.Ref != "80021663DE681814L" || e.Montant != 0 {
		t.Fatal(e)
	}
	e = un(lirePP(t, p, "PAYMENT.SALE.REFUNDED", `{"id":"4CF","amount":{"total":"5.00","currency":"EUR"},"sale_id":"80021663DE681814L"}`))
	if e.Montant != 500 {
		t.Fatal("remboursement partiel : montant", e)
	}
	evs := lirePP(t, p, "CUSTOMER.DISPUTE.CREATED", `{"dispute_id":"PP-D-27803","disputed_transactions":[{"seller_transaction_id":"7NW873794T343360M"},{"seller_transaction_id":"80021663DE681814L"}],"reason":"MERCHANDISE_OR_SERVICE_NOT_RECEIVED"}`)
	if len(evs) != 2 || evs[0].Ref != "7NW873794T343360M" || evs[1].Sorte != Revoque {
		t.Fatal(evs)
	}
	if evs := lirePP(t, p, "PAYMENT.AUTHORIZATION.CREATED", `{}`); len(evs) != 0 {
		t.Fatal(evs)
	}
}

func ppCaptureCompleteRessource() string {
	var e struct {
		Resource json.RawMessage `json:"resource"`
	}
	json.Unmarshal([]byte(ppCaptureComplete), &e)
	return string(e.Resource)
}

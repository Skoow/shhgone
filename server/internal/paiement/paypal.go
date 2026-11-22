package paiement

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PayPal, conception §4.2 : Orders v2 (paiement unique), Subscriptions v1 (renouvellement),
// webhooks vérifiés par l'API verify-webhook-signature (corps brut transmis tel quel).

// Plans : identifiants des quatre plans d'abonnement créés par le propriétaire chez PayPal.
type Plans struct{ PlusMois, PlusAn, ProMois, ProAn string }

func (p Plans) de(f Formule) string {
	switch {
	case f.Offre == Plus && f.Jours == JoursMois:
		return p.PlusMois
	case f.Offre == Plus && f.Jours == JoursAn:
		return p.PlusAn
	case f.Offre == Pro && f.Jours == JoursMois:
		return p.ProMois
	case f.Offre == Pro && f.Jours == JoursAn:
		return p.ProAn
	}
	return ""
}

// verifsPayPal : vérifications de signature simultanées au plus (appel sortant chacune).
const verifsPayPal = 4

// Transmissions refusées (audit du 20 novembre, S3) : un Paypal-Transmission-Id que PayPal a
// déjà déclaré faux (ou en cours de vérification) est refusé sans nouvel appel sortant, pendant
// transmissionsDuree, pour transmissionsMax identifiants au plus (mémoire seulement).
const (
	transmissionsMax   = 4096
	transmissionsDuree = time.Hour
)

// transmissions : empreintes SHA-256 des Paypal-Transmission-Id refusés par PayPal (ou en cours
// de vérification) → échéance. Un identifiant vérifié avec succès, ou dont la vérification n'a
// pas abouti (panne), n'est pas gardé : PayPal peut réessayer le même. Ni adresse, ni corps, ni
// signature : rien de personnel ; perdu au redémarrage.
type transmissions struct {
	mu sync.Mutex
	vu map[[32]byte]time.Time
}

// prendre : false si id est refusé ou en cours ; sinon il est marqué « en cours » (rendu par
// finir). Table pleine : rien n'est marqué (les échus sont d'abord oubliés), la vérification a
// lieu (bornée par verifsPayPal et la limite de la route).
func (t *transmissions) prendre(id string, now time.Time) (cle [32]byte, marque, ok bool) {
	cle = sha256.Sum256([]byte(id))
	t.mu.Lock()
	defer t.mu.Unlock()
	if fin, vu := t.vu[cle]; vu {
		if now.Before(fin) {
			return cle, false, false
		}
		delete(t.vu, cle)
	}
	if len(t.vu) >= transmissionsMax {
		for k, fin := range t.vu {
			if !now.Before(fin) {
				delete(t.vu, k)
			}
		}
	}
	if len(t.vu) >= transmissionsMax {
		return cle, false, true
	}
	t.vu[cle] = now.Add(transmissionsDuree)
	return cle, true, true
}

// finir : refuse = PayPal a dit la signature fausse : gardé jusqu'à l'échéance ; sinon oublié.
func (t *transmissions) finir(cle [32]byte, refuse bool, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if refuse {
		t.vu[cle] = now.Add(transmissionsDuree)
	} else {
		delete(t.vu, cle)
	}
}

// PayPalP : prestataire PayPal.
type PayPalP struct {
	clientID, secret, webhookID string
	plans                       Plans
	essai                       bool
	base                        string // https://api-m.paypal.com ou bac à sable (remplacée par les tests)
	http                        *Client
	now                         func() time.Time
	verifs                      chan struct{}
	refusees                    transmissions

	mu       sync.Mutex
	jeton    string
	echeance time.Time
}

// NouveauPayPal : valeurs déjà vérifiées par la configuration.
func NouveauPayPal(clientID, secret, webhookID string, plans Plans, essai bool, c *Client, now func() time.Time) *PayPalP {
	base := "https://api-m.paypal.com"
	if essai {
		base = "https://api-m.sandbox.paypal.com"
	}
	return &PayPalP{clientID: clientID, secret: secret, webhookID: webhookID, plans: plans, essai: essai, base: base,
		http: c, now: now, verifs: make(chan struct{}, verifsPayPal), refusees: transmissions{vu: map[[32]byte]time.Time{}}}
}

func (*PayPalP) Moyen() Moyen { return PayPal }
func (*PayPalP) Nom() string  { return "paypal" }
func (p *PayPalP) Origines() []string {
	if p.essai {
		return []string{"https://www.sandbox.paypal.com/"}
	}
	return []string{"https://www.paypal.com/"}
}

// jetonAcces : client_credentials, gardé en mémoire jusqu'à 60 s avant son échéance.
func (p *PayPalP) jetonAcces(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.jeton != "" && p.now().Before(p.echeance) {
		return p.jeton, nil
	}
	auth := base64.StdEncoding.EncodeToString([]byte(p.clientID + ":" + p.secret))
	r, err := p.http.faire(ctx, requete{methode: http.MethodPost, url: p.base + "/v1/oauth2/token",
		entetes: [][2]string{{"Authorization", "Basic " + auth}, {"Content-Type", "application/x-www-form-urlencoded"}},
		corps:   []byte("grant_type=client_credentials")})
	if err != nil {
		return "", err
	}
	var o struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if r.statut != http.StatusOK || json.Unmarshal(r.corps, &o) != nil || o.AccessToken == "" || o.ExpiresIn <= 0 {
		return "", ErrPrestataire
	}
	p.jeton, p.echeance = o.AccessToken, p.now().Add(time.Duration(o.ExpiresIn)*time.Second-60*time.Second)
	return p.jeton, nil
}

// json : appel authentifié, corps JSON.
func (p *PayPalP) appel(ctx context.Context, chemin string, corps []byte, idem string) (reponse, error) {
	jeton, err := p.jetonAcces(ctx)
	if err != nil {
		return reponse{}, err
	}
	h := [][2]string{{"Authorization", "Bearer " + jeton}, {"Content-Type", "application/json"}}
	if idem != "" {
		h = append(h, [2]string{"PayPal-Request-Id", idem})
	}
	return p.http.faire(ctx, requete{methode: http.MethodPost, url: p.base + chemin, entetes: h, corps: corps})
}

// euros : centimes → « 70.00 ».
func euros(c int64) string {
	return strconv.FormatInt(c/100, 10) + "." + string([]byte{byte('0' + c%100/10), byte('0' + c%10)})
}

// centimes : « 70.00 » (ou « 70 », « 70.5 ») → 7000 ; -1 si illisible.
func centimes(s string) int64 {
	ent, dec, avec := strings.Cut(s, ".")
	if !chiffres(ent) && ent != "0" || avec && (len(dec) < 1 || len(dec) > 2) {
		return -1
	}
	for i := 0; i < len(dec); i++ {
		if dec[i] < '0' || dec[i] > '9' {
			return -1
		}
	}
	n, err := strconv.ParseInt(ent, 10, 64)
	if err != nil {
		return -1
	}
	if len(dec) == 1 {
		dec += "0"
	}
	d := int64(0)
	if dec != "" {
		d, _ = strconv.ParseInt(dec, 10, 64)
	}
	return n*100 + d
}

type ppMontant struct {
	CurrencyCode string `json:"currency_code"`
	Value        string `json:"value"`
}

type ppLien struct {
	Href string `json:"href"`
	Rel  string `json:"rel"`
}

func lien(ls []ppLien, rel string) string {
	for _, l := range ls {
		if l.Rel == rel {
			return l.Href
		}
	}
	return ""
}

// Creer : commande (paiement unique) ou abonnement.
func (p *PayPalP) Creer(ctx context.Context, d Demande) (Session, error) {
	f := d.Formule
	c := d.Commande.String()
	if f.Renouvelle {
		plan := p.plans.de(f)
		if plan == "" {
			return Session{}, ErrMoyen
		}
		corps, _ := json.Marshal(map[string]any{
			"plan_id":   plan,
			"custom_id": c,
			"application_context": map[string]string{
				"brand_name": "Shhgone", "shipping_preference": "NO_SHIPPING", "user_action": "SUBSCRIBE_NOW",
				"return_url": d.Retour, "cancel_url": d.Retour,
			},
		})
		r, err := p.appel(ctx, "/v1/billing/subscriptions", corps, "abonnement-"+c)
		if err != nil {
			return Session{}, err
		}
		var o struct {
			ID    string   `json:"id"`
			Links []ppLien `json:"links"`
		}
		if (r.statut != http.StatusCreated && r.statut != http.StatusOK) || json.Unmarshal(r.corps, &o) != nil || !abonnementValide(o.ID) {
			return Session{}, ErrPrestataire
		}
		return Session{URL: lien(o.Links, "approve"), Abonnement: o.ID}, nil
	}
	eur := func(v int64) ppMontant { return ppMontant{"EUR", euros(v)} }
	v := d.Ventilation
	corps, _ := json.Marshal(map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []any{map[string]any{
			"custom_id":   c,
			"description": f.Description(),
			"amount": map[string]any{"currency_code": "EUR", "value": euros(v.HT + v.TVA),
				"breakdown": map[string]any{"item_total": eur(v.HT), "tax_total": eur(v.TVA)}},
			"items": []any{map[string]any{"name": f.Description(), "quantity": "1", "category": "DIGITAL_GOODS",
				"unit_amount": eur(v.HT), "tax": eur(v.TVA)}},
		}},
		"payment_source": map[string]any{"paypal": map[string]any{"experience_context": map[string]string{
			"brand_name": "Shhgone", "shipping_preference": "NO_SHIPPING", "user_action": "PAY_NOW",
			"return_url": d.Retour, "cancel_url": d.Retour,
		}}},
	})
	r, err := p.appel(ctx, "/v2/checkout/orders", corps, "commande-"+c)
	if err != nil {
		return Session{}, err
	}
	var o struct {
		Links []ppLien `json:"links"`
	}
	if (r.statut != http.StatusCreated && r.statut != http.StatusOK) || json.Unmarshal(r.corps, &o) != nil {
		return Session{}, ErrPrestataire
	}
	return Session{URL: lien(o.Links, "payer-action")}, nil
}

// Resilier : abonnement annulé (plus aucun prélèvement ; la période payée reste au pass).
func (p *PayPalP) Resilier(ctx context.Context, abonnement string) error {
	if !abonnementValide(abonnement) {
		return ErrPrestataire
	}
	r, err := p.appel(ctx, "/v1/billing/subscriptions/"+url.PathEscape(abonnement)+"/cancel",
		[]byte(`{"reason":"Renouvellement arrêté depuis Shhgone"}`), "")
	if err != nil {
		return err
	}
	if r.statut != http.StatusNoContent && r.statut != http.StatusOK {
		return ErrPrestataire
	}
	return nil
}

// Les en-têtes de signature de PayPal (conception §4.2).
var entetesPayPal = [...]string{"Paypal-Auth-Algo", "Paypal-Cert-Url", "Paypal-Transmission-Id", "Paypal-Transmission-Sig", "Paypal-Transmission-Time"}

func imprimable(s string) bool {
	if s == "" || len(s) > 2048 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

func (p *PayPalP) certPermis(u string) bool {
	hotes := []string{"https://api.paypal.com/", "https://api-m.paypal.com/"}
	if p.essai {
		hotes = []string{"https://api.sandbox.paypal.com/", "https://api-m.sandbox.paypal.com/"}
	}
	for _, h := range hotes {
		if strings.HasPrefix(u, h) {
			return true
		}
	}
	return false
}

// errVerif : PayPal n'a pas pu vérifier (panne, réponse inattendue) : 500, PayPal réessaiera.
var errVerif = errors.New("vérification PayPal indisponible")

// verifier : contrôles locaux, puis l'API verify-webhook-signature avec le corps brut.
func (p *PayPalP) verifier(ctx context.Context, h http.Header, corps []byte) error {
	var v [len(entetesPayPal)]string
	for i, n := range entetesPayPal {
		vals := h.Values(n)
		if len(vals) != 1 || !imprimable(vals[0]) {
			return ErrSignature
		}
		v[i] = vals[0]
	}
	if !p.certPermis(v[1]) {
		return ErrSignature
	}
	var pre struct {
		ID        string `json:"id"`
		EventType string `json:"event_type"`
	}
	if json.Unmarshal(corps, &pre) != nil || pre.ID == "" || pre.EventType == "" {
		return ErrSignature
	}
	// Identifiant de transmission déjà refusé par PayPal, ou en cours de vérification : refusé
	// sans appel sortant (un faux webhook répété ne coûte qu'un appel).
	cle, marque, ok := p.refusees.prendre(v[2], p.now())
	if !ok {
		return ErrSignature
	}
	select {
	case p.verifs <- struct{}{}:
		defer func() { <-p.verifs }()
	default:
		if marque {
			p.refusees.finir(cle, false, p.now())
		}
		return ErrOccupe
	}
	err := p.verifierAPI(ctx, v, corps)
	if marque {
		p.refusees.finir(cle, errors.Is(err, ErrSignature), p.now())
	}
	return err
}

// verifierAPI : POST /v1/notifications/verify-webhook-signature, le corps reçu tel quel.
func (p *PayPalP) verifierAPI(ctx context.Context, v [len(entetesPayPal)]string, corps []byte) error {
	// Corps écrit à la main : webhook_event est le corps reçu, octet pour octet.
	q := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	req := `{"auth_algo":` + q(v[0]) + `,"cert_url":` + q(v[1]) + `,"transmission_id":` + q(v[2]) +
		`,"transmission_sig":` + q(v[3]) + `,"transmission_time":` + q(v[4]) + `,"webhook_id":` + q(p.webhookID) +
		`,"webhook_event":` + string(corps) + `}`
	r, err := p.appel(ctx, "/v1/notifications/verify-webhook-signature", []byte(req), "")
	if err != nil {
		return errVerif
	}
	switch {
	case r.statut == http.StatusOK:
	case r.statut >= 400 && r.statut < 500:
		return ErrSignature
	default:
		return errVerif
	}
	var o struct {
		VerificationStatus string `json:"verification_status"`
	}
	if json.Unmarshal(r.corps, &o) != nil {
		return errVerif
	}
	if o.VerificationStatus != "SUCCESS" {
		return ErrSignature
	}
	return nil
}

type ppEvenement struct {
	ID        string          `json:"id"`
	EventType string          `json:"event_type"`
	Resource  json.RawMessage `json:"resource"`
}

type ppCapture struct {
	ID       string    `json:"id"`
	Status   string    `json:"status"`
	Amount   ppMontant `json:"amount"`
	CustomID string    `json:"custom_id"`
	Links    []ppLien  `json:"links"`
}

type ppVente struct {
	ID                 string `json:"id"`
	State              string `json:"state"`
	SaleID             string `json:"sale_id"`
	BillingAgreementID string `json:"billing_agreement_id"`
	Custom             string `json:"custom"`
	Amount             struct {
		Total    string `json:"total"`
		Currency string `json:"currency"`
	} `json:"amount"`
}

// idPayPal : identifiant de ressource PayPal sûr dans un chemin ([A-Za-z0-9_-], 1 à 64).
func idPayPal(s string) bool { return abonnementValide(s) }

// captureDe : identifiant de la capture d'un remboursement (lien « up »).
func captureDe(ls []ppLien) string {
	u := lien(ls, "up")
	if i := strings.LastIndex(u, "/captures/"); i >= 0 {
		return u[i+len("/captures/"):]
	}
	return ""
}

// Lire : signature vérifiée par PayPal, puis événement traduit (une commande approuvée est
// capturée).
func (p *PayPalP) Lire(ctx context.Context, h http.Header, corps []byte) ([]Evenement, error) {
	if err := p.verifier(ctx, h, corps); err != nil {
		return nil, err
	}
	evs, ordre, err := traduirePayPal(corps)
	if err != nil || ordre == "" {
		return evs, err
	}
	return p.capturer(ctx, ordre, evs[0].Commande)
}

// Cibles : ce que vise le webhook (commande, abonnement, références), lu SANS vérification
// (audit du 20 novembre, S3) ; sert seulement à écarter, avant tout appel sortant, un webhook
// qui ne vise rien de connu (Service.Webhook). Même lecture que Lire : un webhook que Lire
// ignorerait ne vise rien.
func (*PayPalP) Cibles(corps []byte) []Evenement {
	evs, _, err := traduirePayPal(corps)
	if err != nil {
		return nil
	}
	return evs
}

// traduirePayPal : événements d'un webhook PayPal, sans appel sortant. Commande approuvée :
// ordre = identifiant de l'ordre à capturer, evs = un seul événement (sa commande, sans sorte).
func traduirePayPal(corps []byte) (evs []Evenement, ordre string, err error) {
	var e ppEvenement
	if json.Unmarshal(corps, &e) != nil {
		return nil, "", ErrSignature
	}
	switch e.EventType {
	case "CHECKOUT.ORDER.APPROVED":
		var o struct {
			ID            string `json:"id"`
			PurchaseUnits []struct {
				CustomID string `json:"custom_id"`
			} `json:"purchase_units"`
		}
		if json.Unmarshal(e.Resource, &o) != nil || !idPayPal(o.ID) {
			return nil, "", ErrSignature
		}
		if len(o.PurchaseUnits) != 1 {
			return nil, "", nil
		}
		c, ok := CommandeDe(o.PurchaseUnits[0].CustomID)
		if !ok {
			return nil, "", nil // pas une commande à nous
		}
		return []Evenement{{Commande: c, AvecCommande: true}}, o.ID, nil
	case "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REVERSED":
		var o ppCapture
		if json.Unmarshal(e.Resource, &o) != nil {
			return nil, "", ErrSignature
		}
		ev := Evenement{Ref: o.ID}
		avecCommande(&ev, o.CustomID)
		switch e.EventType {
		case "PAYMENT.CAPTURE.COMPLETED":
			if !ev.AvecCommande || o.Status != "COMPLETED" || o.ID == "" {
				return nil, "", nil
			}
			ev.Sorte, ev.Montant, ev.Devise = Confirme, centimes(o.Amount.Value), strings.ToLower(o.Amount.CurrencyCode)
		case "PAYMENT.CAPTURE.DENIED":
			if !ev.AvecCommande {
				return nil, "", nil
			}
			ev.Sorte = NonAbouti
		default:
			ev.Sorte = Revoque
		}
		return []Evenement{ev}, "", nil
	case "PAYMENT.CAPTURE.REFUNDED":
		var o ppCapture
		if json.Unmarshal(e.Resource, &o) != nil {
			return nil, "", ErrSignature
		}
		ev := Evenement{Sorte: Revoque, Ref: captureDe(o.Links), Montant: centimes(o.Amount.Value)}
		if ev.Montant < 0 {
			ev.Montant = 0
		}
		avecCommande(&ev, o.CustomID)
		if !ev.AvecCommande && ev.Ref == "" {
			return nil, "", nil
		}
		return []Evenement{ev}, "", nil
	case "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.SUSPENDED":
		var o struct {
			ID       string `json:"id"`
			CustomID string `json:"custom_id"`
		}
		if json.Unmarshal(e.Resource, &o) != nil || !idPayPal(o.ID) {
			return nil, "", ErrSignature
		}
		ev := Evenement{Sorte: FinRenouvellement, Abonnement: o.ID}
		avecCommande(&ev, o.CustomID)
		if e.EventType == "BILLING.SUBSCRIPTION.ACTIVATED" {
			if !ev.AvecCommande {
				return nil, "", nil
			}
			ev.Sorte = PoseAbonnement
		}
		return []Evenement{ev}, "", nil
	case "PAYMENT.SALE.COMPLETED":
		var o ppVente
		if json.Unmarshal(e.Resource, &o) != nil || o.ID == "" {
			return nil, "", ErrSignature
		}
		if o.BillingAgreementID == "" || o.State != "completed" {
			return nil, "", nil // vente hors abonnement : pas à nous
		}
		ev := Evenement{Sorte: Confirme, Ref: o.ID, Abonnement: o.BillingAgreementID, Montant: centimes(o.Amount.Total),
			Devise: strings.ToLower(o.Amount.Currency)}
		avecCommande(&ev, o.Custom)
		return []Evenement{ev}, "", nil
	case "PAYMENT.SALE.REFUNDED", "PAYMENT.SALE.REVERSED":
		var o ppVente
		if json.Unmarshal(e.Resource, &o) != nil {
			return nil, "", ErrSignature
		}
		ev := Evenement{Sorte: Revoque, Ref: o.SaleID, Montant: max(0, centimes(o.Amount.Total))}
		if ev.Ref == "" {
			ev.Ref = o.ID
		}
		if e.EventType == "PAYMENT.SALE.REVERSED" {
			ev.Montant = 0 // reversement : toujours total
		}
		avecCommande(&ev, o.Custom)
		if !ev.AvecCommande && ev.Ref == "" {
			return nil, "", nil
		}
		return []Evenement{ev}, "", nil
	case "CUSTOMER.DISPUTE.CREATED":
		var o struct {
			DisputedTransactions []struct {
				SellerTransactionID string `json:"seller_transaction_id"`
				Custom              string `json:"custom"`
			} `json:"disputed_transactions"`
		}
		if json.Unmarshal(e.Resource, &o) != nil {
			return nil, "", ErrSignature
		}
		var evs []Evenement
		for _, d := range o.DisputedTransactions {
			ev := Evenement{Sorte: Revoque, Ref: d.SellerTransactionID}
			avecCommande(&ev, d.Custom)
			if ev.AvecCommande || ev.Ref != "" {
				evs = append(evs, ev)
			}
		}
		return evs, "", nil
	}
	return nil, "", nil
}

// capturer : capture d'une commande approuvée (DP-5) ; une capture COMPLETED confirme le
// paiement (même référence que PAYMENT.CAPTURE.COMPLETED : un seul crédit).
func (p *PayPalP) capturer(ctx context.Context, ordre string, c Commande) ([]Evenement, error) {
	r, err := p.appel(ctx, "/v2/checkout/orders/"+url.PathEscape(ordre)+"/capture", []byte(`{}`), "capture-"+c.String())
	if err != nil {
		return nil, err
	}
	if r.statut == http.StatusUnprocessableEntity {
		return nil, nil // déjà capturée (ORDER_ALREADY_CAPTURED) : le webhook de la capture suit
	}
	if r.statut != http.StatusCreated && r.statut != http.StatusOK {
		return nil, ErrPrestataire
	}
	var o struct {
		PurchaseUnits []struct {
			Payments struct {
				Captures []ppCapture `json:"captures"`
			} `json:"payments"`
		} `json:"purchase_units"`
	}
	if json.Unmarshal(r.corps, &o) != nil {
		return nil, ErrPrestataire
	}
	var evs []Evenement
	for _, u := range o.PurchaseUnits {
		for _, cp := range u.Payments.Captures {
			if cp.Status == "COMPLETED" && cp.ID != "" {
				evs = append(evs, Evenement{Sorte: Confirme, Commande: c, AvecCommande: true, Ref: cp.ID,
					Montant: centimes(cp.Amount.Value), Devise: strings.ToLower(cp.Amount.CurrencyCode)})
			}
		}
	}
	return evs, nil
}

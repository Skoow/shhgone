package paiement

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Stripe (carte bancaire), conception §4.1. Appels HTTPS simples (aucun SDK) ; format des
// événements relu dans stripe-go v84.4.0 (version d'API « clover »).

// StripeVersion : version d'API épinglée (DP-3) ; le webhook doit être déclaré dans la même.
const StripeVersion = "2026-02-25.clover"

// toleranceStripe : écart permis entre l'horodatage signé et l'horloge du serveur, dans les
// deux sens (Stripe ne borne que le passé, à 300 s).
const toleranceStripe = 300 * time.Second

// Stripe : prestataire de la carte.
type Stripe struct {
	cle    string // clé secrète ou restreinte (sk_… / rk_…)
	secret []byte // secret de signature des webhooks (whsec_…)
	essai  bool   // mode test : livemode attendu à false
	taxe   bool   // Stripe Tax (SHH_STRIPE_TAXE=1)
	base   string // https://api.stripe.com (remplacée par les tests)
	http   *Client
	now    func() time.Time
}

// NouveauStripe : clé et secret déjà vérifiés par la configuration.
func NouveauStripe(cle, secretWebhook string, essai, taxe bool, c *Client, now func() time.Time) *Stripe {
	return &Stripe{cle: cle, secret: []byte(secretWebhook), essai: essai, taxe: taxe, base: "https://api.stripe.com", http: c, now: now}
}

func (*Stripe) Moyen() Moyen       { return Carte }
func (*Stripe) Nom() string        { return "stripe" }
func (*Stripe) Origines() []string { return []string{"https://checkout.stripe.com/"} }

func (s *Stripe) appel(ctx context.Context, chemin string, v url.Values, idem string) (reponse, error) {
	h := [][2]string{{"Authorization", "Bearer " + s.cle}, {"Stripe-Version", StripeVersion},
		{"Content-Type", "application/x-www-form-urlencoded"}}
	if idem != "" {
		h = append(h, [2]string{"Idempotency-Key", idem})
	}
	return s.http.faire(ctx, requete{methode: http.MethodPost, url: s.base + chemin, entetes: h, corps: []byte(v.Encode())})
}

// Creer : session Checkout (paiement unique ou abonnement), prix TTC « en ligne » (DP-4).
func (s *Stripe) Creer(ctx context.Context, d Demande) (Session, error) {
	f := d.Formule
	c := d.Commande.String()
	v := url.Values{}
	v.Set("client_reference_id", c)
	v.Set("metadata[commande]", c)
	v.Set("metadata[pays_declare]", d.Pays)
	v.Set("metadata[renonciation]", "oui")
	v.Set("metadata[renonciation_heure]", strconv.FormatInt(d.RenonciationHeure, 10))
	v.Set("line_items[0][quantity]", "1")
	v.Set("line_items[0][price_data][currency]", "eur")
	v.Set("line_items[0][price_data][unit_amount]", strconv.FormatInt(Prix(f.Offre, f.Jours), 10))
	v.Set("line_items[0][price_data][tax_behavior]", "inclusive")
	v.Set("line_items[0][price_data][product_data][name]", f.Description())
	v.Set("payment_method_types[0]", "card")
	v.Set("success_url", d.Retour)
	v.Set("cancel_url", d.Retour)
	v.Set("locale", "auto")
	if f.Renouvelle {
		v.Set("mode", "subscription")
		iv := "month"
		if f.Jours == JoursAn {
			iv = "year"
		}
		v.Set("line_items[0][price_data][recurring][interval]", iv)
		v.Set("subscription_data[metadata][commande]", c)
	} else {
		v.Set("mode", "payment")
		v.Set("payment_intent_data[metadata][commande]", c)
		v.Set("invoice_creation[enabled]", "true")
	}
	if s.taxe {
		v.Set("automatic_tax[enabled]", "true")
	}
	r, err := s.appel(ctx, "/v1/checkout/sessions", v, "commande-"+c)
	if err != nil {
		return Session{}, err
	}
	if r.statut != http.StatusOK {
		return Session{}, ErrPrestataire
	}
	var o struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(r.corps, &o) != nil {
		return Session{}, ErrPrestataire
	}
	return Session{URL: o.URL}, nil
}

// Resilier : fin du renouvellement à la fin de la période payée.
func (s *Stripe) Resilier(ctx context.Context, abonnement string) error {
	if !abonnementValide(abonnement) {
		return ErrPrestataire
	}
	v := url.Values{}
	v.Set("cancel_at_period_end", "true")
	r, err := s.appel(ctx, "/v1/subscriptions/"+url.PathEscape(abonnement), v, "")
	if err != nil {
		return err
	}
	if r.statut != http.StatusOK {
		return ErrPrestataire
	}
	return nil
}

// verifier : en-tête Stripe-Signature (« t=…,v1=…[,v1=…] ») ; HMAC-SHA-256(secret, t ‖ « . » ‖
// corps) comparé en temps constant à chaque v1 ; t à ±300 s.
func (s *Stripe) verifier(h http.Header, corps []byte) error {
	vals := h.Values("Stripe-Signature")
	if len(vals) != 1 {
		return ErrSignature
	}
	var t string
	var sigs [][]byte
	for _, part := range strings.Split(vals[0], ",") {
		k, val, ok := strings.Cut(part, "=")
		if !ok {
			return ErrSignature
		}
		switch k {
		case "t":
			if t != "" || !chiffres(val) {
				return ErrSignature
			}
			t = val
		case "v1":
			if b, err := hex.DecodeString(val); err == nil && len(b) == sha256.Size {
				sigs = append(sigs, b)
			}
		}
	}
	if t == "" || len(sigs) == 0 || len(sigs) > 8 {
		return ErrSignature
	}
	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		return ErrSignature
	}
	if d := s.now().Sub(time.Unix(ts, 0)); d > toleranceStripe || d < -toleranceStripe {
		return ErrSignature
	}
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte(t))
	m.Write([]byte("."))
	m.Write(corps)
	attendu := m.Sum(nil)
	ok := false
	for _, sig := range sigs {
		// Toutes comparées (pas d'arrêt au premier succès) : durée indépendante de la position.
		if hmac.Equal(attendu, sig) {
			ok = true
		}
	}
	if !ok {
		return ErrSignature
	}
	return nil
}

// chiffres : entier décimal canonique (sans signe ni zéro initial), 1 à 12 chiffres.
func chiffres(s string) bool {
	if s == "" || len(s) > 12 || (len(s) > 1 && s[0] == '0') {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// meta : métadonnées posées à la création (seule la commande est lue).
type meta struct {
	Commande string `json:"commande"`
}

// idOuObjet : champ « expansible » de Stripe : un identifiant, ou un objet qui porte « id ».
type idOuObjet string

func (x *idOuObjet) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*x = ""
		return nil
	}
	var s string
	if json.Unmarshal(b, &s) == nil {
		*x = idOuObjet(s)
		return nil
	}
	var o struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		return err
	}
	*x = idOuObjet(o.ID)
	return nil
}

type stripeEvenement struct {
	ID       string `json:"id"`
	Object   string `json:"object"`
	Type     string `json:"type"`
	Livemode bool   `json:"livemode"`
	Created  int64  `json:"created"` // secondes Unix de l'événement (signé avec le corps)
	Data     struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

type stripeSession struct {
	ClientReferenceID string    `json:"client_reference_id"`
	Metadata          meta      `json:"metadata"`
	Mode              string    `json:"mode"`
	PaymentStatus     string    `json:"payment_status"`
	PaymentIntent     idOuObjet `json:"payment_intent"`
	Invoice           idOuObjet `json:"invoice"`
	Subscription      idOuObjet `json:"subscription"`
	AmountTotal       int64     `json:"amount_total"`
	Currency          string    `json:"currency"`
}

type stripeFacture struct {
	ID            string    `json:"id"`
	BillingReason string    `json:"billing_reason"`
	AmountPaid    int64     `json:"amount_paid"`
	Currency      string    `json:"currency"`
	Subscription  idOuObjet `json:"subscription"` // versions d'avant « basil »
	Parent        *struct {
		SubscriptionDetails *struct {
			Metadata     meta      `json:"metadata"`
			Subscription idOuObjet `json:"subscription"`
		} `json:"subscription_details"`
	} `json:"parent"`
}

type stripeCharge struct {
	PaymentIntent idOuObjet `json:"payment_intent"`
	Refunded      bool      `json:"refunded"`
	Metadata      meta      `json:"metadata"`
}

// delaiLienFacture : au-delà, invoice_payment.paid d'une facture inconnue répond 200 sans rien
// faire (avant : 500, pour attendre invoice.paid, les événements n'arrivant pas dans l'ordre).
const delaiLienFacture = 24 * time.Hour

// stripePaiementFacture : objet invoice_payment (versions « basil » et suivantes) : relie une
// facture au PaymentIntent qui l'a payée.
type stripePaiementFacture struct {
	Status  string    `json:"status"`
	Invoice idOuObjet `json:"invoice"`
	Payment struct {
		Type          string    `json:"type"`
		PaymentIntent idOuObjet `json:"payment_intent"`
	} `json:"payment"`
}

type stripeAbonnement struct {
	ID       string `json:"id"`
	Metadata meta   `json:"metadata"`
}

// avecCommande : commande lue dans une métadonnée (32 hexadécimaux), sinon rien.
func avecCommande(ev *Evenement, s string) {
	if c, ok := CommandeDe(s); ok {
		ev.Commande, ev.AvecCommande = c, true
	}
}

// Lire : signature vérifiée, puis événement traduit (conception §4.1). Tout type non traité :
// aucun événement (200).
func (s *Stripe) Lire(_ context.Context, h http.Header, corps []byte) ([]Evenement, error) {
	if err := s.verifier(h, corps); err != nil {
		return nil, err
	}
	var e stripeEvenement
	if json.Unmarshal(corps, &e) != nil || e.Object != "event" || e.Livemode == s.essai {
		return nil, ErrSignature
	}
	switch e.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		var o stripeSession
		if json.Unmarshal(e.Data.Object, &o) != nil {
			return nil, ErrSignature
		}
		ev := Evenement{Abonnement: string(o.Subscription)}
		avecCommande(&ev, o.ClientReferenceID)
		if !ev.AvecCommande {
			avecCommande(&ev, o.Metadata.Commande)
		}
		if !ev.AvecCommande || o.PaymentStatus != "paid" {
			return nil, nil // pas à nous, ou paiement différé pas encore reçu
		}
		ev.Ref = string(o.PaymentIntent)
		if o.Mode == "subscription" {
			ev.Ref = string(o.Invoice) // la même que son invoice.paid : un seul crédit
		}
		if ev.Ref == "" {
			ev.Sorte = PoseAbonnement
			return []Evenement{ev}, nil
		}
		ev.Sorte, ev.Montant, ev.Devise = Confirme, o.AmountTotal, o.Currency
		return []Evenement{ev}, nil
	case "checkout.session.expired", "checkout.session.async_payment_failed":
		var o stripeSession
		if json.Unmarshal(e.Data.Object, &o) != nil {
			return nil, ErrSignature
		}
		ev := Evenement{Sorte: NonAbouti}
		avecCommande(&ev, o.ClientReferenceID)
		if !ev.AvecCommande {
			return nil, nil
		}
		return []Evenement{ev}, nil
	case "invoice.paid":
		var o stripeFacture
		if json.Unmarshal(e.Data.Object, &o) != nil || o.ID == "" {
			return nil, ErrSignature
		}
		if o.BillingReason != "subscription_create" && o.BillingReason != "subscription_cycle" {
			return nil, nil
		}
		ev := Evenement{Sorte: Confirme, Ref: o.ID, Montant: o.AmountPaid, Devise: o.Currency, Abonnement: string(o.Subscription)}
		if o.Parent != nil && o.Parent.SubscriptionDetails != nil {
			avecCommande(&ev, o.Parent.SubscriptionDetails.Metadata.Commande)
			if sd := string(o.Parent.SubscriptionDetails.Subscription); sd != "" {
				ev.Abonnement = sd
			}
		}
		if !ev.AvecCommande && ev.Abonnement == "" {
			return nil, nil
		}
		return []Evenement{ev}, nil
	case "invoice_payment.paid":
		// Une facture d'abonnement est créditée par son identifiant (invoice.paid) ; son
		// PaymentIntent, seul porté par charge.refunded et charge.dispute.created, est rangé
		// avec la même commande (risque S10 de la conception du paiement).
		var o stripePaiementFacture
		if json.Unmarshal(e.Data.Object, &o) != nil {
			return nil, ErrSignature
		}
		if o.Status != "paid" || o.Payment.Type != "payment_intent" || o.Invoice == "" || o.Payment.PaymentIntent == "" {
			return nil, nil
		}
		// Plus de 24 h après l'événement (heure signée), une facture encore inconnue ne sera plus
		// créditée (motif hors création et cycle, commande purgée) : ignoré au lieu de réessayé.
		tardif := e.Created > 0 && s.now().Sub(time.Unix(e.Created, 0)) > delaiLienFacture
		return []Evenement{{Sorte: LieRef, Ref: string(o.Invoice), RefLiee: string(o.Payment.PaymentIntent), Tardif: tardif}}, nil
	case "customer.subscription.deleted":
		var o stripeAbonnement
		if json.Unmarshal(e.Data.Object, &o) != nil || o.ID == "" {
			return nil, ErrSignature
		}
		ev := Evenement{Sorte: FinRenouvellement, Abonnement: o.ID}
		avecCommande(&ev, o.Metadata.Commande)
		return []Evenement{ev}, nil
	case "charge.refunded", "charge.dispute.created":
		var o stripeCharge
		if json.Unmarshal(e.Data.Object, &o) != nil {
			return nil, ErrSignature
		}
		if e.Type == "charge.refunded" && !o.Refunded {
			return nil, nil // remboursement partiel : aucun effet automatique (DP-11)
		}
		ev := Evenement{Sorte: Revoque, Ref: string(o.PaymentIntent)}
		avecCommande(&ev, o.Metadata.Commande)
		if !ev.AvecCommande && ev.Ref == "" {
			return nil, nil
		}
		return []Evenement{ev}, nil
	}
	return nil, nil
}

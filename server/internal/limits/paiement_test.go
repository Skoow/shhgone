package limits

import (
	"fmt"
	"net/netip"
	"testing"
	"time"
)

// TestPartagesPayants : quotas à part (Plus 40 Gio par jour et par connexion, Pro 100), aucune
// création gratuite prise, vie de 24 h 15 (report à minuit compris).
func TestPartagesPayants(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	l := newLim(&now)
	a := ip("2001:db8:5:1::1")
	if _, err := l.BeginPaidUpload(a, "p1", 30<<30, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Receive("p1", 30<<30+ManifestChunk); err != nil {
		t.Fatal(err)
	}
	l.FinishUpload("p1", a)
	// 10 Gio de plus en Plus : 40 atteints ; au-delà : refus.
	if _, err := l.BeginPaidUpload(a, "p2", 10<<30, 1); err != nil {
		t.Fatal(err)
	}
	l.FinishUpload("p2", a)
	if _, err := l.BeginPaidUpload(a, "p3", 1<<20, 1); err != ErrQuota {
		t.Fatal("au-delà de 40 Gio en Plus", err)
	}
	// Pro : 100 Gio par jour (60 de plus ici).
	if _, err := l.BeginPaidUpload(a, "p4", 60<<30, 2); err != nil {
		t.Fatal(err)
	}
	l.FinishUpload("p4", a)
	if _, err := l.BeginPaidUpload(a, "p5", 1<<20, 2); err != ErrQuota {
		t.Fatal("au-delà de 100 Gio en Pro", err)
	}
	// Les quotas gratuits sont intacts : créations du jour, 6 Gio.
	if l.count64[l.mustKey64(a)] != 0 {
		t.Fatal("création gratuite prise par un partage payant")
	}
	if _, err := l.BeginUpload(a, "g1", 6<<30); err != nil {
		t.Fatal("quota gratuit pris par les partages payants", err)
	}
	l.CancelUpload("g1")
	if _, err := l.BeginPaidUpload(a, "x", 1, 3); err != ErrQuota {
		t.Fatal("formule inconnue")
	}
	// Envoi payant de 20 h, à cheval sur minuit : toujours compté le lendemain.
	b := ip("2001:db8:6:1::1")
	now = time.Date(2026, 11, 20, 23, 0, 0, 0, time.UTC)
	if _, err := l.BeginPaidUpload(b, "long", 1<<30, 1); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 11, 21, 18, 0, 0, 0, time.UTC)
	if _, err := l.Receive("long", 1<<20); err != nil {
		t.Fatal("envoi payant oublié avant 24 h", err)
	}
	now = time.Date(2026, 11, 22, 0, 30, 0, 0, time.UTC)
	if _, err := l.Receive("long", 1<<20); err != ErrQuota {
		t.Fatal("envoi payant gardé au-delà de 24 h 15", err)
	}
	if PaidUploadLife != 24*time.Hour+15*time.Minute || PaidBytesPlus64 != 40<<30 || PaidBytesPro48 != 200<<30 {
		t.Fatal("constantes")
	}
}

func (l *Limiter) mustKey64(a netip.Addr) string {
	k, _ := l.Key(a)
	return k
}

// TestAllowCommandeHeure : commandes de paiement, 10 par heure par connexion, 30 par /48
// (conception du paiement §8), fenêtre fixe UTC.
func TestAllowCommandeHeure(t *testing.T) {
	if CommandesPer64 != 10 || CommandesPer48 != 30 {
		t.Fatal(CommandesPer64, CommandesPer48)
	}
	now := time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)
	l := newLim(&now)
	for i := 0; i < 10; i++ {
		if !l.AllowCommande(ip(fmt.Sprintf("2001:db8:7:1::%x", i+1))) {
			t.Fatalf("commande %d refusée", i+1)
		}
	}
	if l.AllowCommande(ip("2001:db8:7:1::ff")) {
		t.Fatal("11e commande de l'heure acceptée")
	}
	for p := 2; p <= 3; p++ {
		for i := 0; i < 10; i++ {
			if !l.AllowCommande(ip(fmt.Sprintf("2001:db8:7:%x::1", p))) {
				t.Fatalf("/64 n° %d, commande %d refusée", p, i+1)
			}
		}
	}
	if l.AllowCommande(ip("2001:db8:7:ff::1")) {
		t.Fatal("/48 plein mais commande acceptée")
	}
	if !l.AllowJoin(ip("2001:db8:7:1::1")) {
		t.Fatal("les commandes ne doivent pas prendre les entrées de salon")
	}
	now = time.Date(2026, 11, 19, 11, 0, 0, 0, time.UTC)
	if !l.AllowCommande(ip("2001:db8:7:1::1")) {
		t.Fatal("pas remis à zéro à l'heure suivante")
	}
}

// TestAllowWebhookPayPal : 30 par minute par connexion, 60 par /48, à part des autres
// compteurs, vidés à la minute suivante.
func TestAllowWebhookPayPal(t *testing.T) {
	if WebhooksPayPalPer64 != 30 || WebhooksPayPalPer48 != 60 {
		t.Fatal(WebhooksPayPalPer64, WebhooksPayPalPer48)
	}
	now := time.Date(2026, 11, 20, 10, 0, 15, 0, time.UTC)
	l := newLim(&now)
	for i := 0; i < 30; i++ {
		if !l.AllowWebhookPayPal(ip("2001:db8:8:1::1")) {
			t.Fatalf("webhook %d refusé", i+1)
		}
	}
	if l.AllowWebhookPayPal(ip("2001:db8:8:1::2")) {
		t.Fatal("31e webhook de la minute accepté")
	}
	for i := 0; i < 30; i++ {
		l.AllowWebhookPayPal(ip("2001:db8:8:2::1"))
	}
	if l.AllowWebhookPayPal(ip("2001:db8:8:3::1")) {
		t.Fatal("/48 plein mais webhook accepté")
	}
	if !l.AllowCommande(ip("2001:db8:8:1::1")) || !l.AllowRequest(ip("2001:db8:8:1::1")) {
		t.Fatal("les webhooks ne doivent prendre aucun autre compteur")
	}
	if d := l.MinuteRetry(); d != 45*time.Second {
		t.Fatal(d)
	}
	now = now.Add(45 * time.Second)
	if len(l.ppw64) != 2 || !l.AllowWebhookPayPal(ip("2001:db8:8:1::1")) || len(l.ppw64) != 1 || len(l.ppw48) != 1 {
		t.Fatal("pas remis à zéro à la minute suivante", len(l.ppw64))
	}
}

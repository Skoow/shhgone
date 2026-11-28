package paiement

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// TestArreterInactifs : règle des 12 mois (conception du paiement §6.4). Un abonnement qui se
// renouvelle et dont le pass n'a obtenu aucun jeton depuis 365 jours voit son renouvellement
// arrêté chez le prestataire, comme « Arrêter l'abonnement » ; un pass qui a obtenu un jeton
// dans l'année, un abonnement déjà arrêté et un pass révoqué ne sont pas touchés. Prestataire
// injoignable : rien n'est noté arrêté, réessayé à la passe suivante. Journal : nombres
// seulement, jamais l'abonnement ni le pass.
func TestArreterInactifs(t *testing.T) {
	b := nouveauBanc(t)
	var journal bytes.Buffer
	b.s.journal = &journal
	debut := b.now
	// Trois abonnements mensuels payés le même jour.
	for i, abo := range []string{"sub_jamais", "sub_utilise", "sub_arrete"} {
		b.f.abo = abo
		c := b.commander(t, passN(byte(i+1)), plusMois)
		if err := b.webhook(t, confirme(c, "pi_"+abo, Prix(Plus, JoursMois))); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.s.Resilier(context.Background(), passN(3)); err != nil {
		t.Fatal(err)
	}
	b.f.resilie = nil
	// Les renouvellements mensuels prolongent les pass (webhooks de chaque période, ici en bloc).
	if _, err := b.db.Exec(`UPDATE passes SET fin_jour=?`, jourDe(debut)+800*jourS); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(`UPDATE commandes SET garde_jour=?`, jourDe(debut)+980*jourS); err != nil {
		t.Fatal(err)
	}

	// 364 jours après : rien (moins de 12 mois sans jeton).
	b.now = debut.Add(364 * 24 * time.Hour)
	if a, e, err := b.s.ArreterInactifs(context.Background()); err != nil || a != 0 || e != 0 {
		t.Fatal("arrêt avant 12 mois", a, e, err)
	}
	// Le pass 2 obtient des jetons ce jour-là.
	if n, err := b.s.prendreDuJour(passN(2), 1); err != nil || n != 1 {
		t.Fatal("jeton", n, err)
	}

	// 365 jours après le début : le pass 1, jamais utilisé, est arrêté ; le 2 non (jeton hier) ;
	// le 3 était déjà arrêté.
	b.now = debut.Add(365 * 24 * time.Hour)
	b.f.errRes = errors.New("injoignable")
	if a, e, err := b.s.ArreterInactifs(context.Background()); err != nil || a != 0 || e != 1 {
		t.Fatal("échec du prestataire", a, e, err)
	}
	if !b.etat(t, passN(1)).Renouvelle {
		t.Fatal("noté arrêté malgré l'échec du prestataire")
	}
	b.f.errRes = nil
	b.f.resilie = nil
	if _, err := b.s.Effacer(b.now); err != nil {
		t.Fatal(err)
	}
	if len(b.f.resilie) != 1 || b.f.resilie[0] != "sub_jamais" {
		t.Fatal("résiliations", b.f.resilie)
	}
	if b.etat(t, passN(1)).Renouvelle || !b.etat(t, passN(2)).Renouvelle {
		t.Fatal("états", b.etat(t, passN(1)), b.etat(t, passN(2)))
	}
	// L'accès payé reste jusqu'à sa fin (rien n'est révoqué).
	if b.etat(t, passN(1)).Etat != "payee" {
		t.Fatal("révoqué", b.etat(t, passN(1)))
	}
	// Journal : un nombre, jamais un identifiant.
	j := journal.String()
	if !strings.Contains(j, "renouvellement arrêté pour 1 abonnement(s) sans jeton depuis 12 mois") {
		t.Fatalf("journal %q", j)
	}
	for _, secret := range []string{"sub_", "pi_", "faux"} {
		if strings.Contains(j, secret) {
			t.Fatalf("journal %q contient %q", j, secret)
		}
	}
	if a, _ := b.s.Agregats(); a.ArretsInactifs != 1 {
		t.Fatal("agrégat", a.ArretsInactifs)
	}
	// Passe suivante : plus rien à arrêter.
	b.f.resilie = nil
	if a, e, err := b.s.ArreterInactifs(context.Background()); err != nil || a != 0 || e != 0 || len(b.f.resilie) != 0 {
		t.Fatal("refait", a, e, err, b.f.resilie)
	}

	// 365 jours après le dernier jeton du pass 2 : arrêté à son tour.
	b.now = debut.Add(729 * 24 * time.Hour)
	if a, _, err := b.s.ArreterInactifs(context.Background()); err != nil || a != 1 || b.f.resilie[0] != "sub_utilise" {
		t.Fatal("pass 2", a, err, b.f.resilie)
	}
}

// TestArreterInactifsRevoque : un pass révoqué n'est pas visé (son renouvellement est arrêté par
// la révocation elle-même, conception §5.6).
func TestArreterInactifsRevoque(t *testing.T) {
	b := nouveauBanc(t)
	b.f.abo = "sub_r"
	c := b.commander(t, passN(1), plusMois)
	if err := b.webhook(t, confirme(c, "pi_r", Prix(Plus, JoursMois))); err != nil {
		t.Fatal(err)
	}
	if _, err := b.db.Exec(`UPDATE passes SET revoque=1`); err != nil {
		t.Fatal(err)
	}
	b.now = b.now.Add(400 * 24 * time.Hour)
	if a, e, err := b.s.ArreterInactifs(context.Background()); err != nil || a != 0 || e != 0 {
		t.Fatal(a, e, err)
	}
}

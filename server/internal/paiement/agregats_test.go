package paiement

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

// Agrégats du tableau de bord (25 novembre) : compteurs depuis le démarrage, par prestataire,
// comptés seulement quand l'écriture est faite ; pass valables par offre lus dans la base ;
// jetons émis, dépensés, rendus ; aucun montant, aucun pass ni commande dans la réponse.
func TestAgregats(t *testing.T) {
	b, j := bancJetons(t)
	c1 := b.commander(t, passN(1), Formule{Plus, JoursMois, true, Carte})
	c2 := b.commander(t, passN(2), Formule{Pro, JoursAn, false, Carte})
	b.commander(t, passN(3), plusMois) // reste en attente
	if err := b.webhook(t, confirme(c1, "pi_1", 700)); err != nil {
		t.Fatal(err)
	}
	b.webhook(t, confirme(c1, "pi_1", 700))                       // rejoué : rien de plus
	if err := b.webhook(t, confirme(c2, "pi_2", 1)); err != nil { // montant inattendu
		t.Fatal(err)
	}
	// Webhook à la signature fausse : compté refusé.
	b.f.err = ErrSignature
	if err := b.webhook(t); !errors.Is(err, ErrSignature) {
		t.Fatal(err)
	}
	b.f.err = nil
	// Jetons : 2 émis, 1 dépensé, rendu, redépensé.
	spki := clePour(t, j, Plus, 0)
	r1, f1 := client(t, spki, "shhgone.test")
	r2, _ := client(t, spki, "shhgone.test")
	sigs, _, err := j.Emettre(b.s, passN(1), [][]byte{r1, r2})
	if err != nil {
		t.Fatal(err)
	}
	tok := f1(sigs[0])
	if _, err := j.Depenser(tok); err != nil {
		t.Fatal(err)
	}
	j.Rendre(tok)
	j.Rendre(tok) // déjà rendu : pas compté deux fois
	if _, err := j.Depenser(tok); err != nil {
		t.Fatal(err)
	}

	a, err := b.s.Agregats()
	if err != nil {
		t.Fatal(err)
	}
	st := a.Stripe
	if !st.Configure || !st.Vendable || st.Commandes != 3 || st.Credits != 1 || st.Anomalies != 1 || st.Refuses != 1 ||
		st.Revocations != 0 {
		t.Fatalf("stripe : %+v", st)
	}
	if a.PayPal.Configure || a.NOWPayments.Configure || a.PayPal.Commandes != 0 {
		t.Fatalf("autres : %+v %+v", a.PayPal, a.NOWPayments)
	}
	if a.PassPlus != 1 || a.PassPro != 0 || a.EnAttente != 1 || a.Renouvellement != 1 || a.AnomaliesBase != 1 ||
		a.Recentes != 3 || a.RecentesMax != maxEnAttente {
		t.Fatalf("base : %+v", a)
	}
	if !a.JetonsActif || a.JetonsEmis != [2]int64{2, 0} || a.JetonsDepenses != [2]int64{2, 0} || a.JetonsRendus != 1 {
		t.Fatalf("jetons : %+v", a)
	}

	// Remboursement total, puis révocation à la main d'un autre pass.
	if err := b.webhook(t, Evenement{Sorte: Revoque, Ref: "pi_1"}); err != nil {
		t.Fatal(err)
	}
	b.webhook(t, Evenement{Sorte: Revoque, Ref: "pi_1"}) // déjà révoqué : rien de plus
	c4 := b.commander(t, passN(4), Formule{Pro, JoursAn, false, Carte})
	b.webhook(t, confirme(c4, "pi_4", 20000))
	if ok, err := b.s.Revoquer(c4); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if a, err = b.s.Agregats(); err != nil {
		t.Fatal(err)
	}
	if a.Stripe.Revocations != 1 || a.RevocationsMain != 1 || a.PassPlus != 0 || a.PassPro != 0 || a.PassRevoques != 2 {
		t.Fatalf("révocations : %+v", a)
	}
	// Pass échu : plus compté valable.
	c5 := b.commander(t, passN(5), Formule{Plus, JoursMois, true, Carte})
	b.webhook(t, confirme(c5, "pi_5", 700))
	b.now = b.now.Add(31 * 24 * time.Hour)
	if a, _ = b.s.Agregats(); a.PassPlus != 0 {
		t.Fatal("pass échu compté :", a.PassPlus)
	}

	// Que des nombres et des booléens : aucune chaîne dans la réponse (ni pass, ni commande,
	// ni montant écrit, ni pays).
	raw, _ := json.Marshal(a)
	var v any
	json.Unmarshal(raw, &v)
	var fouiller func(any)
	fouiller = func(x any) {
		switch y := x.(type) {
		case map[string]any:
			for _, e := range y {
				fouiller(e)
			}
		case []any:
			for _, e := range y {
				fouiller(e)
			}
		case float64, bool:
		default:
			t.Errorf("valeur non numérique : %v (%T)", x, x)
		}
	}
	fouiller(v)
	for _, n := range []string{"Montant", "Devise", "Pays"} {
		if _, ok := reflect.TypeOf(a).FieldByName(n); ok {
			t.Error("champ interdit :", n)
		}
	}
}

// Ventes suspendues par l'exploitant : nouvelle commande refusée (ErrSuspendu, rien d'écrit) ;
// un webhook d'une commande passée avant reste crédité ; rétablies, elles reprennent.
func TestSuspendre(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(1), plusMois)
	b.s.Suspendre(true)
	if _, err := b.s.Commander(context.Background(), passN(2), plusMois, "FR", true); !errors.Is(err, ErrSuspendu) {
		t.Fatal("commande pendant la suspension :", err)
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM commandes`).Scan(&n)
	if n != 1 || len(b.f.vu) != 1 {
		t.Fatal("commande écrite ou prestataire appelé pendant la suspension :", n, len(b.f.vu))
	}
	if err := b.webhook(t, confirme(c, "pi_1", 700)); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "payee" {
		t.Fatal("paiement en cours non crédité :", e)
	}
	if a, _ := b.s.Agregats(); !a.Suspendu {
		t.Fatal("suspension non lue")
	}
	b.s.Suspendre(false)
	b.commander(t, passN(2), plusMois)
}

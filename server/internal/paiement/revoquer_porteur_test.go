package paiement

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestRevoquerPorteur : le porteur révoque son pass (suppression du compte, conception §5.6) :
// refusé tant qu'un renouvellement est en cours (résilier d'abord) ; ensuite révoqué, plus de
// jetons, renouvellement arrivé après non crédité ; déjà révoqué ou inconnu : aucune erreur
// (réponse neutre), aucune ligne créée ; un accès offert se révoque de même.
func TestRevoquerPorteur(t *testing.T) {
	b := nouveauBanc(t)
	b.f.abo = "sub_1Abc"
	c := b.commander(t, passN(1), plusMois)
	if err := b.webhook(t, confirme(c, "pi_1", Prix(Plus, JoursMois))); err != nil {
		t.Fatal(err)
	}
	if err := b.s.RevoquerPorteur(passN(1)); !errors.Is(err, ErrRenouvellement) {
		t.Fatal("révoqué malgré le renouvellement", err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "payee" || !e.Renouvelle {
		t.Fatal("touché par le refus", e)
	}
	if err := b.s.Resilier(context.Background(), passN(1)); err != nil {
		t.Fatal(err)
	}
	if err := b.s.RevoquerPorteur(passN(1)); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "revoquee" || e.Fin != jourDe(b.now) || e.Renouvelle {
		t.Fatal(e)
	}
	if n, _, _ := b.s.Prendre(passN(1), 1); n != 0 {
		t.Fatal("jeton après révocation", n)
	}
	// Déjà révoqué, puis pass inconnu : rien, sans erreur.
	if err := b.s.RevoquerPorteur(passN(1)); err != nil {
		t.Fatal(err)
	}
	if err := b.s.RevoquerPorteur(passN(9)); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := b.db.QueryRow(`SELECT count(*) FROM passes`).Scan(&n); err != nil || n != 1 {
		t.Fatal("ligne créée pour un pass inconnu", n, err)
	}
	// Une période arrivée après la révocation n'est pas créditée.
	if err := b.webhook(t, confirme(c, "pi_2", Prix(Plus, JoursMois))); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "revoquee" || e.Fin != jourDe(b.now) {
		t.Fatal("recrédité", e)
	}
	// Accès offert : révoqué par son porteur.
	p, _, err := b.s.Offrir(JoursOffertMois, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.s.RevoquerPorteur(p); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, p); e.Etat != "revoquee" {
		t.Fatal(e)
	}
}

// TestRevocationArreteLeRenouvellement : un pass révoqué ne reste jamais prélevé. Remboursement
// total ou litige (webhook) d'un abonnement en cours : son renouvellement est arrêté chez le
// prestataire ; si l'arrêt échoue, le webhook échoue (le prestataire le renvoie) et le renvoi
// l'arrête. Révocation à la main hors du serveur (sans prestataire) : refusée tant que le
// renouvellement court, rien n'est révoqué ; dans le serveur : arrêt puis révocation.
func TestRevocationArreteLeRenouvellement(t *testing.T) {
	b := nouveauBanc(t)
	b.f.abo = "sub_1Abc"
	c := b.commander(t, passN(1), plusMois)
	if err := b.webhook(t, confirme(c, "pi_1", Prix(Plus, JoursMois))); err != nil {
		t.Fatal(err)
	}
	renouvelle := func(c Commande) int {
		var r int
		if err := b.db.QueryRow(`SELECT renouvelle FROM commandes WHERE id=?`, c[:]).Scan(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}
	// Arrêt impossible chez le prestataire : erreur rendue, renouvellement toujours noté.
	b.f.errRes = errors.New("prestataire injoignable")
	rembourse := Evenement{Sorte: Revoque, Commande: c, AvecCommande: true, Ref: "pi_1"}
	if err := b.webhook(t, rembourse); err == nil {
		t.Fatal("webhook accepté sans arrêt du renouvellement")
	}
	if renouvelle(c) != 1 || len(b.f.resilie) != 1 {
		t.Fatal("renouvellement oublié sans arrêt", renouvelle(c), b.f.resilie)
	}
	if e := b.etat(t, passN(1)); e.Etat != "revoquee" {
		t.Fatal(e)
	}
	// Renvoi du webhook : arrêté.
	b.f.errRes = nil
	if err := b.webhook(t, rembourse); err != nil {
		t.Fatal(err)
	}
	if renouvelle(c) != 0 || len(b.f.resilie) != 2 || b.f.resilie[1] != "sub_1Abc" {
		t.Fatal(renouvelle(c), b.f.resilie)
	}

	// Révocation à la main (shhdrop admin, sans prestataire) : refusée, rien de révoqué.
	b.f.abo = "sub_2Def"
	c2 := b.commander(t, passN(2), plusMois)
	if err := b.webhook(t, confirme(c2, "pi_2", Prix(Plus, JoursMois))); err != nil {
		t.Fatal(err)
	}
	if ok, err := RevoquerBase(b.db, func() time.Time { return b.now }, c2); !ok || !errors.Is(err, ErrRenouvellement) {
		t.Fatal(ok, err)
	}
	if e := b.etat(t, passN(2)); e.Etat != "payee" {
		t.Fatal("révoqué malgré le renouvellement", e)
	}
	// Dans le serveur (prestataire connu) : arrêt, puis révocation.
	if ok, err := b.s.Revoquer(c2); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if e := b.etat(t, passN(2)); e.Etat != "revoquee" || renouvelle(c2) != 0 || b.f.resilie[len(b.f.resilie)-1] != "sub_2Def" {
		t.Fatal(e, renouvelle(c2), b.f.resilie)
	}
}

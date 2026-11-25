package paiement

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// faux : prestataire de test ; Lire rend les événements posés.
type faux struct {
	moyen   Moyen
	url     string
	abo     string
	err     error
	evs     []Evenement
	vu      []Demande
	resilie []string
}

func (f *faux) Moyen() Moyen { return f.moyen }
func (f *faux) Nom() string  { return "faux" }
func (f *faux) Creer(_ context.Context, d Demande) (Session, error) {
	f.vu = append(f.vu, d)
	return Session{URL: f.url, Abonnement: f.abo}, f.err
}
func (f *faux) Lire(context.Context, http.Header, []byte) ([]Evenement, error) { return f.evs, f.err }
func (f *faux) Resilier(_ context.Context, a string) error {
	f.resilie = append(f.resilie, a)
	return f.err
}
func (f *faux) Origines() []string { return []string{"https://paie.example/"} }

type banc struct {
	s   *Service
	db  *sql.DB
	f   *faux
	now time.Time
}

func nouveauBanc(t testing.TB) *banc {
	t.Helper()
	db, err := OuvrirBase(filepath.Join(t.TempDir(), "paiements.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	b := &banc{db: db, f: &faux{moyen: Carte, url: "https://paie.example/c/1"}, now: time.Date(2026, 11, 19, 15, 4, 5, 0, time.UTC)}
	b.s, err = NewService(Config{DB: db, Now: func() time.Time { return b.now }, Origine: "https://shhgone.test", Regime: OSS,
		Prestataires: []Prestataire{b.f}})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func passN(n byte) Pass {
	var p Pass
	for i := range p {
		p[i] = n
	}
	return p
}

var plusMois = Formule{Plus, JoursMois, true, Carte}

// commander : commande créée, rend son identifiant (vu par le faux prestataire).
func (b *banc) commander(t testing.TB, p Pass, f Formule) Commande {
	t.Helper()
	u, err := b.s.Commander(context.Background(), p, f, "FR", true)
	if err != nil || u != b.f.url {
		t.Fatal(u, err)
	}
	return b.f.vu[len(b.f.vu)-1].Commande
}

func (b *banc) webhook(t testing.TB, evs ...Evenement) error {
	t.Helper()
	b.f.evs = evs
	return b.s.Webhook(context.Background(), b.f, nil, nil)
}

func confirme(c Commande, ref string, montant int64) Evenement {
	return Evenement{Sorte: Confirme, Commande: c, AvecCommande: true, Ref: ref, Montant: montant, Devise: "eur"}
}

func (b *banc) etat(t *testing.T, p Pass) Etat {
	t.Helper()
	e, err := b.s.EtatDe(p)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestCommanderDemande(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(1), plusMois)
	d := b.f.vu[0]
	if d.Retour != "https://shhgone.test/offres/retour" || d.Webhook != "https://shhgone.test/api/paiement/webhook/faux" ||
		d.Pays != "FR" || d.Ventilation.HT != 583 || d.Ventilation.TVA != 117 || d.RenonciationHeure != b.now.Unix() {
		t.Fatalf("%+v", d)
	}
	if e := b.etat(t, passN(1)); e.Etat != "attente" || e.Offre != Plus || e.Fin != 0 || e.Renouvelle {
		t.Fatalf("%+v", e)
	}
	// La base ne garde que l'empreinte du pass, jamais le pass.
	q := passN(1).Empreinte()
	var n int
	b.db.QueryRow(`SELECT count(*) FROM commandes WHERE id=? AND q=?`, c[:], q[:]).Scan(&n)
	if n != 1 {
		t.Fatal("commande absente")
	}
	_ = c
}

func TestCommanderRefus(t *testing.T) {
	b := nouveauBanc(t)
	ctx := context.Background()
	if _, err := b.s.Commander(ctx, passN(1), plusMois, "FR", false); err != ErrRenonciation {
		t.Error("sans renonciation", err)
	}
	if _, err := b.s.Commander(ctx, passN(1), plusMois, "GB", true); err != ErrPays {
		t.Error("hors UE", err)
	}
	if _, err := b.s.Commander(ctx, passN(1), Formule{Plus, JoursMois, false, Carte}, "FR", true); err != ErrFormule {
		t.Error("mensuel sans renouvellement", err)
	}
	if _, err := b.s.Commander(ctx, passN(1), Formule{Plus, JoursAn, false, Crypto}, "FR", true); err != ErrMoyen {
		t.Error("moyen non configuré", err)
	}
	b.commander(t, passN(1), plusMois)
	if _, err := b.s.Commander(ctx, passN(1), plusMois, "FR", true); err != ErrConflit {
		t.Error("même pass deux fois", err)
	}
	// Adresse de redirection hors de la liste : refus, commande effacée.
	for _, u := range []string{"https://evil.example/x", "https://paie.example/", "https://paie.example/a b",
		"http://paie.example/x", "https://paie.example.evil/x", "https://paie.example/\n"} {
		b.f.url = u
		if _, err := b.s.Commander(ctx, passN(2), plusMois, "FR", true); err != ErrPrestataire {
			t.Errorf("%q : %v", u, err)
		}
	}
	if e := b.etat(t, passN(2)); e.Etat != "inconnue" {
		t.Error("commande refusée gardée", e)
	}
	// Erreur du prestataire : commande effacée.
	b.f.url, b.f.err = "https://paie.example/ok", errors.New("panne")
	if _, err := b.s.Commander(ctx, passN(3), plusMois, "FR", true); err == nil {
		t.Error("panne acceptée")
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM commandes`).Scan(&n)
	if n != 1 {
		t.Error("commandes", n)
	}
}

// Plafond des commandes en attente (§8) : seules les commandes encore en attente ET
// créées dans les dernières heures bloquent les ventes.
func TestCommanderPlafondEnAttente(t *testing.T) {
	b := nouveauBanc(t)
	passI := func(i int) Pass {
		p := passN(0xee)
		p[0], p[1], p[2] = byte(i), byte(i>>8), byte(i>>16)
		return p
	}
	// 1 000 commandes en attente d'il y a plus de 4 heures (gardées 7 jours) : ne bloquent rien.
	for i := 0; i < maxEnAttente; i++ {
		c, _ := nouvelleCommande()
		q := passI(i).Empreinte()
		if _, err := b.db.Exec(`INSERT INTO commandes VALUES(?,?,1,30,1,1,1,NULL,0,0)`, c[:], q[:]); err != nil {
			t.Fatal(err)
		}
	}
	n := 0
	commander := func() error {
		n++
		_, err := b.s.Commander(context.Background(), passI(100000+n), plusMois, "FR", true)
		return err
	}
	// 1 000 commandes récentes, en attente : la suivante est refusée.
	for i := 0; i < maxEnAttente; i++ {
		if err := commander(); err != nil {
			t.Fatal(i, err)
		}
		if i == maxEnAttente/2 {
			b.now = b.now.Add(2 * time.Hour) // réparties sur plusieurs heures
		}
	}
	if err := commander(); err != ErrOccupe {
		t.Fatal("plafond", err)
	}
	// Après 4 heures, les premières ne sont plus récentes : une vente passe de nouveau…
	b.now = b.now.Add(2 * time.Hour)
	if err := commander(); err != nil {
		t.Fatal("vieilles commandes encore comptées", err)
	}
	// … et la ligne reste gardée (paiement tardif encore crédité).
	var lignes int
	b.db.QueryRow(`SELECT count(*) FROM commandes WHERE etat=?`, etatAttente).Scan(&lignes)
	if lignes != 2*maxEnAttente+1 {
		t.Fatal("lignes", lignes)
	}
	// Récentes mais payées (ou non abouties) : plus en attente, ne bloquent pas.
	b2 := nouveauBanc(t)
	for i := 0; i < maxEnAttente; i++ {
		b2.s.compterRecente(b2.now, 1)
	}
	if _, err := b2.s.Commander(context.Background(), passN(1), plusMois, "FR", true); err != nil {
		t.Fatal("récentes mais pas en attente", err)
	}
	// Un échec chez le prestataire efface la commande et la retire du compte.
	b3 := nouveauBanc(t)
	b3.f.err = errors.New("panne")
	b3.s.Commander(context.Background(), passN(2), plusMois, "FR", true)
	if b3.s.nRecentes(b3.now) != 0 {
		t.Fatal("commande effacée encore comptée")
	}
}

func TestConfirmeCrediteUneFois(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(1), plusMois)
	auj := jourDe(b.now)
	for i := 0; i < 3; i++ { // rejeu, double livraison
		if err := b.webhook(t, confirme(c, "pi_1", 700)); err != nil {
			t.Fatal(err)
		}
	}
	e := b.etat(t, passN(1))
	if e.Etat != "payee" || e.Offre != Plus || e.Fin != auj+30*jourS || !e.Renouvelle {
		t.Fatalf("%+v", e)
	}
	// Même paiement apporté par un autre événement sans métadonnées (par l'abonnement) : rien.
	b.db.Exec(`UPDATE commandes SET abonnement=? WHERE id=?`, []byte("sub_1"), c[:])
	if err := b.webhook(t, Evenement{Sorte: Confirme, Abonnement: "sub_1", Ref: "pi_1", Montant: 700, Devise: "eur"}); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Fin != auj+30*jourS {
		t.Fatal("crédité deux fois", e)
	}
	// Renouvellement (autre référence), payé deux jours avant la fin : s'ajoute à la fin.
	b.now = b.now.Add(28 * 24 * time.Hour)
	if err := b.webhook(t, Evenement{Sorte: Confirme, Abonnement: "sub_1", Ref: "in_2", Montant: 700, Devise: "eur"}); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Fin != auj+60*jourS {
		t.Fatal("renouvellement", e)
	}
	// Renouvellement arrivé après la fin (pass échu) : repart d'aujourd'hui.
	b.now = b.now.Add(40 * 24 * time.Hour)
	b.webhook(t, Evenement{Sorte: Confirme, Abonnement: "sub_1", Ref: "in_3", Montant: 700, Devise: "eur"})
	if e := b.etat(t, passN(1)); e.Fin != jourDe(b.now)+30*jourS {
		t.Fatal("renouvellement après la fin", e)
	}
}

func TestConfirmeMontantFaux(t *testing.T) {
	for _, ev := range []Evenement{{Montant: 699, Devise: "eur"}, {Montant: 700, Devise: "usd"}, {Montant: 7000, Devise: "eur"}} {
		b := nouveauBanc(t)
		c := b.commander(t, passN(1), plusMois)
		ev.Sorte, ev.Commande, ev.AvecCommande, ev.Ref = Confirme, c, true, "pi_x"
		if err := b.webhook(t, ev); err != nil {
			t.Fatal(err)
		}
		if e := b.etat(t, passN(1)); e.Etat != "anomalie" || e.Fin != 0 {
			t.Fatalf("%+v → %+v", ev, e)
		}
	}
}

func TestConfirmeCommandeInconnue(t *testing.T) {
	b := nouveauBanc(t)
	var c Commande
	c[0] = 7
	if err := b.webhook(t, confirme(c, "pi_1", 700)); err != nil {
		t.Fatal("commande dans les métadonnées mais inconnue : ignorée", err)
	}
	// Retrouvée seulement par l'abonnement : peut-être pas encore posé → réessayer.
	if err := b.webhook(t, Evenement{Sorte: Confirme, Abonnement: "I-ABC", Ref: "s1", Montant: 700, Devise: "eur"}); err != ErrPasEncore {
		t.Fatal(err)
	}
	if err := b.webhook(t, Evenement{Sorte: Revoque, Ref: "inconnue"}); err != nil {
		t.Fatal(err)
	}
}

func TestPoseAbonnementPuisVente(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(1), Formule{Pro, JoursAn, true, Carte})
	if err := b.webhook(t, Evenement{Sorte: PoseAbonnement, Commande: c, AvecCommande: true, Abonnement: "I-ABC"}); err != nil {
		t.Fatal(err)
	}
	// Un autre identifiant ne remplace jamais le premier.
	b.webhook(t, Evenement{Sorte: PoseAbonnement, Commande: c, AvecCommande: true, Abonnement: "I-XYZ"})
	if err := b.webhook(t, Evenement{Sorte: Confirme, Abonnement: "I-ABC", Ref: "s1", Montant: 20000, Devise: "eur"}); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "payee" || e.Offre != Pro || e.Fin != jourDe(b.now)+365*jourS {
		t.Fatal(e)
	}
	if err := b.webhook(t, Evenement{Sorte: PoseAbonnement, Commande: c, AvecCommande: true, Abonnement: "pas valable!"}); err != nil {
		t.Fatal("identifiant déjà posé : ignoré", err)
	}
	// Résiliation : l'abonnement posé part au prestataire.
	if err := b.s.Resilier(context.Background(), passN(1)); err != nil || len(b.f.resilie) != 1 || b.f.resilie[0] != "I-ABC" {
		t.Fatal(err, b.f.resilie)
	}
	if e := b.etat(t, passN(1)); e.Renouvelle {
		t.Fatal("toujours renouvelé")
	}
	if err := b.s.Resilier(context.Background(), passN(1)); err != ErrAucunAbonnement {
		t.Fatal("deuxième résiliation", err)
	}
	if err := b.s.Resilier(context.Background(), passN(5)); err != ErrAucunAbonnement {
		t.Fatal("pass inconnu", err)
	}
}

func TestNonAboutiEtFinRenouvellement(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(1), plusMois)
	b.webhook(t, Evenement{Sorte: NonAbouti, Commande: c, AvecCommande: true})
	if e := b.etat(t, passN(1)); e.Etat != "non_aboutie" {
		t.Fatal(e)
	}
	c2 := b.commander(t, passN(2), plusMois)
	b.webhook(t, confirme(c2, "pi_2", 700))
	b.webhook(t, Evenement{Sorte: NonAbouti, Commande: c2, AvecCommande: true}) // jamais après un paiement
	b.webhook(t, Evenement{Sorte: FinRenouvellement, Commande: c2, AvecCommande: true})
	if e := b.etat(t, passN(2)); e.Etat != "payee" || e.Renouvelle {
		t.Fatal(e)
	}
}

func TestRevocation(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(1), Formule{Pro, JoursAn, false, Carte})
	b.webhook(t, confirme(c, "pi_1", 20000))
	if n, _, _ := b.s.Prendre(passN(1), 5); n != 5 {
		t.Fatal("jetons avant révocation", n)
	}
	b.now = b.now.Add(10 * 24 * time.Hour)
	// Remboursement partiel (montant connu, inférieur au prix) : aucun effet (DP-11).
	if err := b.webhook(t, Evenement{Sorte: Revoque, Ref: "pi_1", Montant: 1000}); err != nil {
		t.Fatal(err)
	}
	if e := b.etat(t, passN(1)); e.Etat != "payee" {
		t.Fatal("partiel révoqué", e)
	}
	// Remboursement retrouvé par la seule référence du paiement.
	if err := b.webhook(t, Evenement{Sorte: Revoque, Ref: "pi_1"}); err != nil {
		t.Fatal(err)
	}
	e := b.etat(t, passN(1))
	if e.Etat != "revoquee" || e.Fin != jourDe(b.now) {
		t.Fatal(e)
	}
	if n, _, _ := b.s.Prendre(passN(1), 5); n != 0 {
		t.Fatal("jetons après révocation", n)
	}
	// Un paiement de plus sur un pass révoqué ne le recrédite pas.
	b.webhook(t, confirme(c, "pi_9", 20000))
	if e := b.etat(t, passN(1)); e.Etat != "revoquee" || e.Fin != jourDe(b.now) {
		t.Fatal(e)
	}
	// Révocation à la main.
	c2 := b.commander(t, passN(2), plusMois)
	b.webhook(t, confirme(c2, "pi_2", 700))
	if ok, err := b.s.Revoquer(c2); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if e := b.etat(t, passN(2)); e.Etat != "revoquee" {
		t.Fatal(e)
	}
	var inconnue Commande
	if ok, err := b.s.Revoquer(inconnue); ok || err != nil {
		t.Fatal(ok, err)
	}
}

func TestPrendreRecharge(t *testing.T) {
	b := nouveauBanc(t)
	c := b.commander(t, passN(1), Formule{Plus, JoursAn, false, Carte})
	b.webhook(t, confirme(c, "pi_1", 7000))
	total := 0
	for {
		n, o, err := b.s.Prendre(passN(1), 5)
		if err != nil || o != Plus {
			t.Fatal(err, o)
		}
		if n == 0 {
			break
		}
		total += n
	}
	if total != 30 {
		t.Fatal("réserve de la première période", total)
	}
	// 29 jours plus tard : toujours vide ; 30 jours : remise à 30 (sans report).
	b.now = b.now.Add(29 * 24 * time.Hour)
	if n, _, _ := b.s.Prendre(passN(1), 5); n != 0 {
		t.Fatal("rechargé trop tôt")
	}
	b.now = b.now.Add(24 * time.Hour)
	if n, _, _ := b.s.Prendre(passN(1), 100); n != 30 {
		t.Fatal("recharge", n)
	}
	// Plusieurs périodes sans demande : une seule réserve, pas de cumul.
	b.now = b.now.Add(95 * 24 * time.Hour)
	if n, _, _ := b.s.Prendre(passN(1), 100); n != 30 {
		t.Fatal("cumul", n)
	}
	// Après la fin : rien.
	b.now = b.now.Add(300 * 24 * time.Hour)
	if n, _, _ := b.s.Prendre(passN(1), 1); n != 0 {
		t.Fatal("après la fin", n)
	}
	if n, o, _ := b.s.Prendre(passN(8), 1); n != 0 || o != 0 {
		t.Fatal("pass inconnu")
	}
}

func TestPurge(t *testing.T) {
	b := nouveauBanc(t)
	debut := b.now
	cAtt := b.commander(t, passN(1), plusMois)
	cPay := b.commander(t, passN(2), plusMois)
	b.webhook(t, confirme(cPay, "pi_2", 700))
	_ = cAtt
	compter := func(table string) int {
		var n int
		b.db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n)
		return n
	}
	b.now = debut.Add(6 * 24 * time.Hour)
	b.s.Purger()
	if compter("commandes") != 2 {
		t.Fatal("purgé trop tôt")
	}
	b.now = debut.Add(7 * 24 * time.Hour)
	b.s.Purger()
	if compter("commandes") != 1 || b.etat(t, passN(1)).Etat != "inconnue" {
		t.Fatal("commande en attente gardée")
	}
	// Pass : effacé 31 jours après sa fin (30 jours) ; commande : 180 jours après la fin.
	b.now = debut.Add(60 * 24 * time.Hour)
	b.s.Purger()
	if compter("passes") != 1 {
		t.Fatal("pass effacé trop tôt")
	}
	b.now = debut.Add(61 * 24 * time.Hour)
	b.s.Purger()
	if compter("passes") != 0 || compter("commandes") != 1 || compter("refs") != 1 {
		t.Fatal("pass", compter("passes"), compter("commandes"), compter("refs"))
	}
	b.now = debut.Add(210 * 24 * time.Hour)
	b.s.Purger()
	if compter("commandes") != 0 || compter("refs") != 0 {
		t.Fatal("commande payée gardée après sa garde")
	}
}

// TestSchemaPaiements : seulement des BLOB et des INTEGER, aucune colonne qui désigne une
// personne, un partage, un salon ou un compte (conception §3) ; base en 0600.
func TestSchemaPaiements(t *testing.T) {
	dir := t.TempDir()
	db, err := OuvrirBase(filepath.Join(dir, "paiements.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT m.name, p.name, p.type FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' ORDER BY m.name, p.cid`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var tb, col, typ string
		rows.Scan(&tb, &col, &typ)
		if typ != "BLOB" && typ != "INTEGER" {
			t.Errorf("%s.%s : %s", tb, col, typ)
		}
		got = append(got, tb+"."+col)
	}
	want := "cles_jetons.jour cles_jetons.offre cles_jetons.sk " +
		"commandes.id commandes.q commandes.offre commandes.jours commandes.renouvelle commandes.moyen commandes.etat " +
		"commandes.abonnement commandes.cree_jour commandes.garde_jour depenses.h depenses.jour passes.q passes.offre passes.debut_jour passes.fin_jour " +
		"passes.jetons passes.recharge_jour passes.revoque passes.emis_jour passes.emis_n refs.r refs.commande refs.jour"
	if strings.Join(got, " ") != want {
		t.Fatalf("schéma :\n%s\nattendu :\n%s", strings.Join(got, " "), want)
	}
	fi, err := os.Stat(filepath.Join(dir, "paiements.db"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatal(fi.Mode(), err)
	}
	// Une heure n'entre pas : seulement des jours.
	if _, err := db.Exec(`INSERT INTO passes VALUES(?,1,86401,0,0,0,0)`, make([]byte, 32)); err == nil {
		t.Error("heure acceptée")
	}
	// Version plus récente : refus.
	db.Exec(`PRAGMA user_version=9`)
	db.Close()
	if _, err := OuvrirBase(filepath.Join(dir, "paiements.db")); err != ErrBasePlusRecente {
		t.Fatal(err)
	}
}

func TestNewServiceRefus(t *testing.T) {
	db, _ := OuvrirBase(filepath.Join(t.TempDir(), "p.db"))
	defer db.Close()
	now := time.Now
	f := &faux{moyen: Carte}
	for _, c := range []Config{
		{DB: db, Now: now, Origine: "https://x", Regime: OSS},
		{DB: db, Now: now, Origine: "https://x", Prestataires: []Prestataire{f}},
		{DB: db, Now: now, Origine: "https://x", Regime: OSS, Prestataires: []Prestataire{f, f}},
		{DB: db, Now: now, Regime: OSS, Prestataires: []Prestataire{f}},
	} {
		if _, err := NewService(c); err == nil {
			t.Errorf("%+v accepté", c)
		}
	}
}

// TestMigrationV1 : une base de la version 1 (sans jetons) est migrée à l'ouverture, ses pass
// gardés.
func TestMigrationV1(t *testing.T) {
	chemin := filepath.Join(t.TempDir(), "p.db")
	db, err := sql.Open("sqlite", "file:"+chemin)
	if err != nil {
		t.Fatal(err)
	}
	v1 := strings.NewReplacer(`,
  emis_jour INTEGER NOT NULL DEFAULT 0 CHECK(typeof(emis_jour)='integer' AND emis_jour >= 0 AND emis_jour % 86400 = 0),
  emis_n INTEGER NOT NULL DEFAULT 0 CHECK(typeof(emis_n)='integer' AND emis_n >= 0)) WITHOUT ROWID;`, ") WITHOUT ROWID;").Replace(schemaPaiements)
	if strings.Contains(v1, "emis_n") {
		t.Fatal("schéma v1 mal reconstitué")
	}
	if _, err := db.Exec(v1); err != nil {
		t.Fatal(err)
	}
	db.Exec(`INSERT INTO passes VALUES(?,1,0,86400,30,0,0)`, make([]byte, 32))
	db.Exec(`PRAGMA user_version=1`)
	db.Close()
	db, err = OuvrirBase(chemin)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n, emis int
	db.QueryRow(`SELECT count(*), sum(emis_n) FROM passes`).Scan(&n, &emis)
	var v int
	db.QueryRow(`PRAGMA user_version`).Scan(&v)
	if n != 1 || emis != 0 || v != 2 {
		t.Fatal(n, emis, v)
	}
}

package compte

import (
	"errors"
	"regexp"
	"testing"
	"time"
)

// Lot 7 du plan du compte : bannissement révisé (conception §13, §21.11, §21.14.4). Durée
// choisie (30 jours, 1 an), identifiant opaque B-…, suspendre, réactiver, changer
// l'échéance (5 ans au plus), lever, annuler ; 20 bannissements par heure au plus.

// ban : bannissement réussi (échoue sinon).
func (b *banc) ban(t *testing.T, c Cible, jours int, motif uint8) Ban {
	t.Helper()
	r, err := b.s.Bannir(c, jours, motif)
	if err != nil {
		t.Fatalf("Bannir : %v", err)
	}
	return r
}

func (b *banc) aujourdhui() int64 { return jourDe(b.clk.Now()) }

// Bannir le compte créateur d'un salon (lien ou ref : le compte h) : ligne bannis (début
// aujourd'hui, échéance + durée, active, motif, salons fermés), sessions fermées, salons du
// compte fermés par le crochet du salon, création refusée ; connexion encore permise.
func TestBannirFermeLesSalonsOuverts(t *testing.T) {
	b := nouveauBanc(t)
	h, j, d := b.inscrire(t, ipA, "lea@exemple.fr", "lea")
	var fermes [][16]byte
	b.s.fermerSalons = func(x [16]byte) (int, error) { fermes = append(fermes, x); return 2, nil }
	r := b.ban(t, Cible{H: &h}, 365, 6)
	if !r.Compte || r.SalonsFermes != 2 || len(fermes) != 1 || fermes[0] != h {
		t.Fatalf("%+v %v", r, fermes)
	}
	auj := b.aujourdhui()
	if r.Vue.Debut != dateJour(auj) || r.Vue.Jusqu != dateJour(auj+365*jourS) || !r.Vue.Actif || r.Vue.Motif != 6 ||
		r.Vue.SalonsFermes != 2 {
		t.Fatalf("%+v", r.Vue)
	}
	var debut, jusqu, actif, motif, sf int64
	if err := b.db.QueryRow(`SELECT debut_jour, jusqu_jour, actif, motif, salons_fermes FROM bannis`).Scan(&debut, &jusqu,
		&actif, &motif, &sf); err != nil || debut != auj || jusqu != auj+365*jourS || actif != 1 || motif != 6 || sf != 2 {
		t.Fatal(debut, jusqu, actif, motif, sf, err)
	}
	if _, err := b.s.Session(j); !errors.Is(err, ErrSession) {
		t.Fatal("session gardée :", err)
	}
	var bn ErrBanni
	if _, err := b.s.Palier(h); !errors.As(err, &bn) || bn.Jusqu != r.Vue.Jusqu {
		t.Fatal("création permise :", err)
	}
	if _, err := b.s.Connexion(ipA, "lea@exemple.fr", d.AAuth, OptionsSession{}, false); err != nil {
		t.Fatal("connexion refusée (export, suppression) :", err)
	}
	// Compte inconnu (supprimé) : rien n'est banni.
	if _, err := b.s.Bannir(Cible{H: &[16]byte{9}}, 30, 10); !errors.Is(err, ErrEtape) {
		t.Fatal(err)
	}
}

// Par adresse : n'importe quelle variante de l'adresse du compte (conception §5.1) ; sans
// compte : l'adresse ne peut plus en créer ; déjà bannie : ErrDejaBanni avec le bannissement.
func TestBannirParAdresse(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, ipA, "leadupont@gmail.com", "lea")
	r := b.ban(t, Cible{Email: []byte(" Lea.Dupont+x@GMAIL.com ")}, 30, 8)
	if !r.Compte || r.Vue.Jusqu != dateJour(b.aujourdhui()+30*jourS) {
		t.Fatalf("%+v", r)
	}
	if _, err := b.s.Palier(h); !errors.As(err, new(ErrBanni)) {
		t.Fatal(err)
	}
	var deja ErrDejaBanni
	if _, err := b.s.Bannir(Cible{Email: []byte("leadupont@gmail.com")}, 365, 1); !errors.As(err, &deja) ||
		deja.Vue.ID != r.Vue.ID {
		t.Fatal("deux bannissements pour une adresse :", err)
	}
	r2 := b.ban(t, Cible{Email: []byte("inconnue@exemple.fr")}, 365, 10)
	if r2.Compte || r2.SalonsFermes != 0 {
		t.Fatalf("%+v", r2)
	}
	_, e, code := b.debut(t, ipN(3), "inconnue@exemple.fr")
	if _, err := b.s.InscriptionFin(e, code, donneesTest("nouveau"), OptionsSession{}); !errors.As(err, new(ErrBanni)) {
		t.Fatal("inscription d'une adresse bannie :", err)
	}
	for _, mauvaise := range []string{"", "pas une adresse", "a@b", "é@exemple.fr"} {
		if _, err := b.s.Bannir(Cible{Email: []byte(mauvaise)}, 30, 10); !errors.Is(err, ErrAdresse) {
			t.Errorf("%q : %v", mauvaise, err)
		}
	}
	if _, err := b.s.Bannir(Cible{}, 30, 10); !errors.Is(err, ErrRequete) {
		t.Fatal("cible vide :", err)
	}
}

// Durées : 30 ou 365 jours (3 ans retiré le 22 novembre) ; motif 1 à 10 ; rien d'autre.
func TestDurees(t *testing.T) {
	b := nouveauBanc(t)
	for i, j := range []int{30, 365} {
		r := b.ban(t, Cible{Email: []byte("a" + string(rune('0'+i)) + "@exemple.fr")}, j, 10)
		if r.Vue.Jusqu != dateJour(b.aujourdhui()+int64(j)*jourS) {
			t.Fatal(j, r.Vue)
		}
	}
	for _, c := range []struct {
		jours int
		motif uint8
	}{{0, 10}, {-30, 10}, {31, 10}, {364, 10}, {366, 10}, {1095, 10}, {1825, 10}, {30, 0}, {30, 11}} {
		if _, err := b.s.Bannir(Cible{Email: []byte("x@exemple.fr")}, c.jours, c.motif); !errors.Is(err, ErrRequete) {
			t.Errorf("%+v : %v", c, err)
		}
	}
}

// Suspendre : plus d'effet (réinscription et création permises), échéance inchangée ;
// réactiver : de nouveau en vigueur, sessions et salons du compte fermés. Chaque action rend
// l'état d'avant.
func TestSuspendreReactiver(t *testing.T) {
	b := nouveauBanc(t)
	h, _, d := b.inscrire(t, ipA, "lea@exemple.fr", "lea")
	n := 0
	b.s.fermerSalons = func([16]byte) (int, error) { n++; return 1, nil }
	r := b.ban(t, Cible{H: &h}, 365, 4)
	avant, apres, err := b.s.ActionBan(r.Vue.ID, "suspendre", "")
	if err != nil || !avant.Actif || apres == nil || apres.Actif || apres.Jusqu != r.Vue.Jusqu || apres.ID != r.Vue.ID {
		t.Fatal(avant, apres, err)
	}
	if _, err := b.s.Palier(h); err != nil {
		t.Fatal("suspendu : création refusée :", err)
	}
	o, err := b.s.Connexion(ipA, "lea@exemple.fr", d.AAuth, OptionsSession{}, false)
	if err != nil {
		t.Fatal(err)
	}
	if et, _ := b.s.Etat(b.session(t, o.Jeton)); et.Banni || et.BanniJusqu != "" {
		t.Fatal("suspendu montré banni :", et)
	}
	avant, apres, err = b.s.ActionBan(r.Vue.ID, "reactiver", "")
	if err != nil || avant.Actif || !apres.Actif || apres.Jusqu != r.Vue.Jusqu || apres.SalonsFermes != 2 || n != 2 {
		t.Fatal(avant, apres, err, n)
	}
	if _, err := b.s.Session(o.Jeton); !errors.Is(err, ErrSession) {
		t.Fatal("réactivé : session gardée :", err)
	}
	if _, err := b.s.Palier(h); !errors.As(err, new(ErrBanni)) {
		t.Fatal(err)
	}
	// Suspendu, l'adresse sans compte peut s'inscrire.
	r2 := b.ban(t, Cible{Email: []byte("leo@exemple.fr")}, 30, 10)
	if _, _, err := b.s.ActionBan(r2.Vue.ID, "suspendre", ""); err != nil {
		t.Fatal(err)
	}
	b.inscrire(t, ipN(4), "leo@exemple.fr", "leo")
	for _, x := range []struct{ id, action string }{{r.Vue.ID, "inconnue"}, {r.Vue.ID, ""}, {"B-0000", "lever"}, {"", "lever"}} {
		if _, _, err := b.s.ActionBan(x.id, x.action, ""); !errors.Is(err, ErrRequete) {
			t.Errorf("%+v : %v", x, err)
		}
	}
	if _, _, err := b.s.ActionBan(idBan([8]byte{1}), "lever", ""); !errors.Is(err, ErrEtape) {
		t.Fatal("identifiant inconnu :", err)
	}
}

// Changer l'échéance : toute date de demain à aujourd'hui + 5 ans, au jour, rien d'autre.
func TestEcheanceBornes(t *testing.T) {
	b := nouveauBanc(t)
	r := b.ban(t, Cible{Email: []byte("lea@exemple.fr")}, 365, 10)
	auj := time.Unix(b.aujourdhui(), 0).UTC()
	f := func(x time.Time) string { return x.Format("2006-01-02") }
	for _, ok := range []string{f(auj.AddDate(0, 0, 1)), f(auj.AddDate(5, 0, 0)), f(auj.AddDate(2, 3, 4))} {
		avant, apres, err := b.s.ActionBan(r.Vue.ID, "echeance", ok)
		if err != nil || apres.Jusqu != ok || avant.ID != r.Vue.ID {
			t.Fatalf("%s : %v %v %v", ok, avant, apres, err)
		}
	}
	for _, non := range []string{f(auj.AddDate(0, 0, -1)), f(auj), f(auj.AddDate(5, 0, 1)), "2026-1-5", "demain", "",
		"2027-02-30", "2027-01-01T00:00:00Z"} {
		if _, _, err := b.s.ActionBan(r.Vue.ID, "echeance", non); !errors.Is(err, ErrRequete) {
			t.Errorf("%q : %v", non, err)
		}
	}
	var jusqu int64
	b.db.QueryRow(`SELECT jusqu_jour FROM bannis`).Scan(&jusqu)
	if dateJour(jusqu) != f(auj.AddDate(2, 3, 4)) || jusqu%jourS != 0 {
		t.Fatal(dateJour(jusqu))
	}
}

// Lever : fin maintenant, ligne effacée ; l'ancienneté n'est pas rendue.
func TestLever(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, ipA, "lea@exemple.fr", "lea")
	b.clk.Add(20 * 24 * time.Hour)
	b.s.Signale(h)
	r := b.ban(t, Cible{H: &h}, 365, 6)
	avant, apres, err := b.s.ActionBan(r.Vue.ID, "lever", "")
	if err != nil || apres != nil || avant.ID != r.Vue.ID || !avant.Actif {
		t.Fatal(avant, apres, err)
	}
	if n := len(lignes(t, b.db, `SELECT hex(id) FROM bannis`)); n != 0 {
		t.Fatal("ligne gardée :", n)
	}
	if _, err := b.s.Palier(h); err != nil {
		t.Fatal(err)
	}
	if v, _ := b.s.VueCompte(h); v.AncienneteJours != 0 || v.Palier != "neuf" {
		t.Fatal("ancienneté rendue par Lever :", v)
	}
	if _, _, err := b.s.ActionBan(r.Vue.ID, "lever", ""); !errors.Is(err, ErrEtape) {
		t.Fatal(err)
	}
}

// Annuler (erreur de bannissement) : comme Lever, plus compte_des = cree_jour.
func TestAnnulerRendAnciennete(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, ipA, "lea@exemple.fr", "lea")
	b.clk.Add(20 * 24 * time.Hour)
	b.s.Signale(h)
	r := b.ban(t, Cible{H: &h}, 30, 10)
	if _, apres, err := b.s.ActionBan(r.Vue.ID, "annuler", ""); err != nil || apres != nil {
		t.Fatal(apres, err)
	}
	v, err := b.s.VueCompte(h)
	if err != nil || !v.Existe || v.AncienneteJours != 20 || v.Palier != "confirme" || v.Banni {
		t.Fatal(v, err)
	}
	// Rendre l'ancienneté seule (signalement abusif, §21.14.3).
	b.s.Signale(h)
	if err := b.s.RendreAnciennete(h); err != nil {
		t.Fatal(err)
	}
	if v, _ := b.s.VueCompte(h); v.AncienneteJours != 20 {
		t.Fatal(v)
	}
	if err := b.s.RendreAnciennete([16]byte{3}); !errors.Is(err, ErrEtape) {
		t.Fatal(err)
	}
}

// Garde-fou d'un jeton d'administration volé : 20 bannissements par heure au plus.
func TestVingtBannissementsParHeure(t *testing.T) {
	b := nouveauBanc(t)
	b.clk.Add(-10 * time.Minute) // 9 h 50 : la fenêtre change à 10 h
	adr := func(i int) []byte { return []byte("p" + itoa(int64(i)) + "@exemple.fr") }
	for i := range 20 {
		b.ban(t, Cible{Email: adr(i)}, 30, 10)
	}
	var lim ErrLimit
	if _, err := b.s.Bannir(Cible{Email: adr(20)}, 30, 10); !errors.As(err, &lim) || lim.Retry <= 0 {
		t.Fatal("21e accepté :", err)
	}
	if n := len(lignes(t, b.db, `SELECT hex(id) FROM bannis`)); n != 20 {
		t.Fatal(n)
	}
	b.clk.Add(11 * time.Minute)
	b.ban(t, Cible{Email: adr(20)}, 30, 10)
}

// Le motif et l'échéance sont montrés à la personne à la connexion (GET /api/compte, R16).
func TestMotifMontreALaConnexion(t *testing.T) {
	b := nouveauBanc(t)
	h, _, d := b.inscrire(t, ipA, "lea@exemple.fr", "lea")
	r := b.ban(t, Cible{H: &h}, 365, 6)
	o, err := b.s.Connexion(ipA, "lea@exemple.fr", d.AAuth, OptionsSession{}, false)
	if err != nil {
		t.Fatal(err)
	}
	et, err := b.s.Etat(b.session(t, o.Jeton))
	if err != nil || !et.Banni || et.BanniJusqu != r.Vue.Jusqu || et.BanniMotif != 6 {
		t.Fatal(et, err)
	}
}

// Recherche par adresse (recours) : le bannissement ou rien, et « un compte existe : palier,
// ancienneté » ; jamais l'adresse, l'empreinte, h ni le pseudo.
func TestChercherBan(t *testing.T) {
	b := nouveauBanc(t)
	h, _, _ := b.inscrire(t, ipA, "leadupont@gmail.com", "lea")
	b.clk.Add(3 * 24 * time.Hour)
	bv, cv, err := b.s.ChercherBan([]byte("Lea.Dupont@gmail.com"))
	if err != nil || bv != nil || cv != (CompteVue{Existe: true, Palier: "neuf", AncienneteJours: 3}) {
		t.Fatal(bv, cv, err)
	}
	r := b.ban(t, Cible{H: &h}, 30, 3)
	bv, cv, err = b.s.ChercherBan([]byte("leadupont+z@gmail.com"))
	if err != nil || bv == nil || *bv != r.Vue || !cv.Banni {
		t.Fatal(bv, cv, err)
	}
	bv, cv, err = b.s.ChercherBan([]byte("personne@exemple.fr"))
	if err != nil || bv != nil || cv != (CompteVue{}) {
		t.Fatal(bv, cv, err)
	}
	if _, _, err := b.s.ChercherBan([]byte("pas une adresse")); !errors.Is(err, ErrAdresse) {
		t.Fatal(err)
	}
}

// Liste : filtres (tous, actifs, suspendus, échéant dans 30 jours), pages de 50, échus exclus.
func TestListeBans(t *testing.T) {
	b := nouveauBanc(t)
	auj := b.aujourdhui()
	for i := range 53 {
		actif, jusqu := 1, auj+400*jourS
		switch {
		case i < 3:
			actif = 0
		case i < 7:
			jusqu = auj + 30*jourS
		case i == 7:
			jusqu = auj // échu : la passe quotidienne l'effacera
		}
		k := alea32()
		if _, err := b.db.Exec(`INSERT INTO bannis VALUES(?,?,?,?,?,10,0)`, alea8(), k[:], auj-int64(i)*jourS, jusqu, actif); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct {
		filtre       string
		page, n, tot int
	}{{"", 0, 50, 52}, {"", 1, 2, 52}, {"", 2, 0, 52}, {"actifs", 0, 49, 49}, {"suspendus", 0, 3, 3}, {"bientot", 0, 4, 4}} {
		l, tot, err := b.s.ListeBans(c.filtre, c.page)
		if err != nil || len(l) != c.n || tot != c.tot {
			t.Errorf("%+v : %d %d %v", c, len(l), tot, err)
		}
	}
	l, _, _ := b.s.ListeBans("", 0)
	if l[0].Debut != dateJour(auj) || l[1].Debut != dateJour(auj-jourS) {
		t.Fatal("ordre : du plus récent au plus ancien", l[0], l[1])
	}
	for _, x := range []struct {
		f string
		p int
	}{{"autre", 0}, {"", -1}, {"", 100001}} {
		if _, _, err := b.s.ListeBans(x.f, x.p); !errors.Is(err, ErrRequete) {
			t.Errorf("%+v : %v", x, err)
		}
	}
}

// Identifiant montré : les 8 octets en base32 de Crockford, « B-XXXX-XXXX-XXXXX » ; relu
// exactement (minuscules acceptées), rien d'autre.
func TestIDBan(t *testing.T) {
	re := regexp.MustCompile(`^B-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{5}$`)
	for range 200 {
		var k [8]byte
		copy(k[:], alea8())
		s := idBan(k)
		if !re.MatchString(s) {
			t.Fatal(s)
		}
		if got, ok := lireIDBan(s); !ok || got != k {
			t.Fatal(s, got)
		}
		if got, ok := lireIDBan("b" + s[1:]); ok && got != k {
			t.Fatal("minuscules")
		}
	}
	for _, non := range []string{"", "B-", "B-0000-0000-0000", "B-0000-0000-000000", "X-0000-0000-00000", "B-0000-0000-0000U",
		"B00000000000000", "B-0000-0000-0000Z"} {
		if _, ok := lireIDBan(non); ok {
			t.Errorf("%q accepté", non)
		}
	}
}

// Lever, annuler, suspendre ou changer l'échéance comptent dans la même limite de 20 par heure
// que bannir : un jeton volé ne lève pas tous les bannissements d'un coup.
func TestActionsBanDansLaLimite(t *testing.T) {
	b := nouveauBanc(t)
	b.clk.Add(-10 * time.Minute) // 9 h 50 : la fenêtre change à 10 h
	adr := func(i int) []byte { return []byte("q" + itoa(int64(i)) + "@exemple.fr") }
	var ids []string
	for i := range 12 {
		ids = append(ids, b.ban(t, Cible{Email: adr(i)}, 30, 10).Vue.ID)
	}
	for _, id := range ids[:8] { // 12 bannissements + 8 actions = 20
		if _, _, err := b.s.ActionBan(id, "lever", ""); err != nil {
			t.Fatal(err)
		}
	}
	var lim ErrLimit
	for _, a := range []string{"lever", "annuler", "suspendre", "reactiver"} {
		if _, _, err := b.s.ActionBan(ids[8], a, ""); !errors.As(err, &lim) {
			t.Fatalf("%s au-delà de 20 par heure : %v", a, err)
		}
	}
	if _, _, err := b.s.ActionBan(ids[8], "echeance", time.Unix(b.clk.Now().Unix(), 0).UTC().AddDate(0, 0, 3).Format("2006-01-02")); !errors.As(err, &lim) {
		t.Fatal("echeance au-delà de 20 par heure :", err)
	}
	b.clk.Add(11 * time.Minute)
	if _, _, err := b.s.ActionBan(ids[8], "lever", ""); err != nil {
		t.Fatal("heure suivante :", err)
	}
}

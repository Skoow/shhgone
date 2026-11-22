package limits

import (
	"encoding/hex"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Limites du compte (conception du compte §8.8 ; conception du compte par passkey §7.2) : bornes
// exactes, oubli à la rotation, aucune adresse ni h gardés en clair.

func hDe(s string) [16]byte {
	var h [16]byte
	copy(h[:], s)
	return h
}

// Comptes créés : 3 par jour par connexion, 10 par /48 ; compté seulement par NoterCompte (un
// refus de création ne coûte rien) ; le nombre du jour se lit (difficulté de la preuve).
func TestComptesCrees(t *testing.T) {
	now := t0
	l := newLim(&now)
	a := ip("2001:db8:1:1::1")
	for i := 0; i < InscriptionsPer64; i++ {
		if !l.PeutCreerCompte(a) || l.ComptesCreesDuJour(a) != i {
			t.Fatalf("compte %d refusé", i+1)
		}
		l.NoterCompte(a)
	}
	if l.PeutCreerCompte(ip("2001:db8:1:1::2")) || l.ComptesCreesDuJour(a) != 3 {
		t.Fatal("4e compte du jour pour la même connexion accepté")
	}
	n := InscriptionsPer64
	for i := 2; n < InscriptionsPer48; i++ {
		b := ip(fmt.Sprintf("2001:db8:1:%x::1", i))
		if !l.PeutCreerCompte(b) {
			t.Fatalf("compte %d du /48 refusé", n+1)
		}
		l.NoterCompte(b)
		n++
	}
	if l.PeutCreerCompte(ip("2001:db8:1:ff::1")) {
		t.Fatal("11e compte du /48 accepté")
	}
	if !l.PeutCreerCompte(ip("2001:db8:2::1")) || l.ComptesCreesDuJour(ip("2001:db8:2::1")) != 0 {
		t.Fatal("autre /48 refusé")
	}
	now = t0.Add(24 * time.Hour)
	if !l.PeutCreerCompte(a) || l.ComptesCreesDuJour(a) != 0 {
		t.Fatal("quota de comptes non remis à zéro à minuit")
	}
	if InscriptionsPer64 != 3 || InscriptionsPer48 != 10 {
		t.Fatal("bornes : 3 par connexion, 10 par /48")
	}
}

// allowN : f permis n fois, puis refusé.
func allowN(t *testing.T, nom string, n int, f func() bool) {
	t.Helper()
	for i := 0; i < n; i++ {
		if !f() {
			t.Fatalf("%s : %d refusé", nom, i+1)
		}
	}
	if f() {
		t.Fatalf("%s : %d accepté", nom, n+1)
	}
}

// inscription/debut 20 par heure, connexion/debut 60 par minute, passkeys/debut 10 par heure et
// par compte (conception §7.2).
func TestDebutsDeCeremonie(t *testing.T) {
	now := t0
	l := newLim(&now)
	a := ip("192.0.2.1")
	allowN(t, "inscription/debut", InscriptionsDebutParHeure, func() bool { return l.AllowInscriptionDebut(a) })
	allowN(t, "connexion/debut", ConnexionsDebutParMinute, func() bool { return l.AllowConnexionDebut(a) })
	allowN(t, "passkeys/debut", AjoutsPasskeyParHeure, func() bool { return l.AllowAjoutPasskey(hDe("a")) })
	if !l.AllowInscriptionDebut(ip("192.0.2.2")) || !l.AllowConnexionDebut(ip("192.0.2.2")) || !l.AllowAjoutPasskey(hDe("b")) {
		t.Fatal("autre connexion ou autre compte refusé")
	}
	// Les ajouts de passkey ne prennent rien aux écritures des coffres (même table, sortes séparées).
	allowN(t, "coffre", EcrituresCoffreParHeure, func() bool { return l.AllowEcritureCoffre(hDe("a")) })
	now = t0.Add(time.Minute)
	if !l.AllowConnexionDebut(a) || l.AllowInscriptionDebut(a) {
		t.Fatal("connexion/debut non oublié à la minute, ou inscription/debut oublié")
	}
	now = t0.Add(time.Hour)
	if !l.AllowInscriptionDebut(a) || !l.AllowAjoutPasskey(hDe("a")) {
		t.Fatal("limites de l'heure non oubliées")
	}
	if InscriptionsDebutParHeure != 20 || ConnexionsDebutParMinute != 60 || AjoutsPasskeyParHeure != 10 {
		t.Fatal("bornes de la conception §7.2")
	}
}

func TestEchecsConnexion(t *testing.T) {
	now := t0
	l := newLim(&now)
	for i := 0; i < EchecsConnexionPer64; i++ {
		if !l.AllowEchecConnexion(ip("192.0.2.1")) {
			t.Fatalf("connexion refusée après %d échecs", i)
		}
		l.NoterEchecConnexion(ip("192.0.2.1"))
	}
	if l.AllowEchecConnexion(ip("192.0.2.1")) {
		t.Fatal("connexion permise après 20 échecs dans l'heure")
	}
	if !l.AllowEchecConnexion(ip("192.0.2.2")) {
		t.Fatal("autre connexion refusée")
	}
	for i := 0; i < EchecsConnexionPer48; i++ {
		l.NoterEchecConnexion(ip(fmt.Sprintf("2001:db8:5:%x::1", i)))
	}
	if l.AllowEchecConnexion(ip("2001:db8:5:ffff::1")) {
		t.Fatal("connexion permise après 60 échecs du /48 dans l'heure")
	}
	now = t0.Add(time.Hour)
	if !l.AllowEchecConnexion(ip("192.0.2.1")) || !l.AllowEchecConnexion(ip("2001:db8:5:ffff::1")) {
		t.Fatal("échecs de connexion non oubliés à l'heure suivante")
	}
	if EchecsConnexionPer64 != 20 || EchecsConnexionPer48 != 60 {
		t.Fatal("bornes de la conception §7.2 : 20 par connexion, 60 par /48")
	}
}

// Clé de récupération : 10 essais par heure par connexion, 30 par /48, justes ou faux.
func TestAllowRecup(t *testing.T) {
	now := t0
	l := newLim(&now)
	allowN(t, "recup", RecupPer64, func() bool { return l.AllowRecup(ip("192.0.2.1")) })
	n := 0
	for i := 0; n < RecupPer48; i++ {
		b := ip(fmt.Sprintf("2001:db8:7:%x::1", i))
		for k := 0; k < RecupPer64 && n < RecupPer48; k++ {
			if !l.AllowRecup(b) {
				t.Fatalf("essai %d du /48 refusé", n+1)
			}
			n++
		}
	}
	if l.AllowRecup(ip("2001:db8:7:ffff::1")) {
		t.Fatal("31e essai du /48 accepté")
	}
	now = t0.Add(time.Hour)
	if !l.AllowRecup(ip("192.0.2.1")) {
		t.Fatal("essais non oubliés à l'heure suivante")
	}
	if RecupPer64 != 10 || RecupPer48 != 30 {
		t.Fatal("bornes de la conception §7.2 : 10 par connexion, 30 par /48")
	}
}

func TestAllowEcritureCoffre(t *testing.T) {
	now := t0
	l := newLim(&now)
	h := hDe("compte-a")
	for i := 0; i < EcrituresCoffreParHeure; i++ {
		if !l.AllowEcritureCoffre(h) {
			t.Fatalf("écriture %d refusée", i+1)
		}
	}
	if l.AllowEcritureCoffre(h) {
		t.Fatal("61e écriture de l'heure acceptée")
	}
	if !l.AllowEcritureCoffre(hDe("compte-b")) {
		t.Fatal("autre compte refusé")
	}
	now = t0.Add(time.Hour)
	if !l.AllowEcritureCoffre(h) {
		t.Fatal("écritures non oubliées à l'heure suivante")
	}
	if EcrituresCoffreParHeure != 60 {
		t.Fatal("borne : 60 écritures par heure (les deux coffres ensemble)")
	}
}

func TestAllowPseudoVerifier(t *testing.T) {
	now := t0
	l := newLim(&now)
	etape := make([]byte, 32)
	for i := 0; i < PseudoVerifierParHeure; i++ {
		if !l.AllowPseudoVerifier(etape) {
			t.Fatalf("vérification %d refusée", i+1)
		}
	}
	if l.AllowPseudoVerifier(etape) {
		t.Fatal("31e vérification de l'heure acceptée")
	}
	// Un h de 16 octets nuls n'est pas l'étape de 32 octets nuls.
	if !l.AllowPseudoVerifier(make([]byte, 16)) {
		t.Fatal("identifiants de longueurs différentes confondus")
	}
	now = t0.Add(time.Hour)
	if !l.AllowPseudoVerifier(etape) {
		t.Fatal("vérifications non oubliées à l'heure suivante")
	}
	if PseudoVerifierParHeure != 30 {
		t.Fatal("borne : 30 par heure")
	}
}

func TestAllowBannir(t *testing.T) {
	now := t0
	l := newLim(&now)
	for i := 0; i < BannissementsParHeure; i++ {
		if !l.AllowBannir() {
			t.Fatalf("bannissement %d refusé", i+1)
		}
	}
	if l.AllowBannir() {
		t.Fatal("21e bannissement de l'heure accepté")
	}
	now = t0.Add(time.Hour)
	if !l.AllowBannir() {
		t.Fatal("bannissements non oubliés à l'heure suivante")
	}
	if BannissementsParHeure != 20 {
		t.Fatal("borne de la conception §21.11 : 20 par heure")
	}
}

// mapsCompte : les compteurs du compte, par nom de champ ; tout champ ajouté au Limiter sans
// être listé ici fait échouer TestLimitesCompteOublieesALaRotation (-1).
var mapsCompte = []string{"insc64", "insc48", "inscD64", "echec64", "echec48", "recup64", "recup48", "coffreCpt",
	"pseudoCpt", "cnx64"}

func compteMaps(l *Limiter) map[string]int {
	v := reflect.ValueOf(l).Elem()
	out := map[string]int{}
	for _, n := range mapsCompte {
		f := v.FieldByName(n)
		if !f.IsValid() {
			out[n] = -1
			continue
		}
		out[n] = f.Len()
	}
	return out
}

// Plus aucune limite d'e-mail ni de TOTP (22 novembre).
func TestPlusDeLimitesEmail(t *testing.T) {
	ty := reflect.TypeFor[Limiter]()
	for _, n := range []string{"mail64", "mail48", "mailAdr", "mailAdr48", "echecCpt", "totpCpt"} {
		if _, ok := ty.FieldByName(n); ok {
			t.Errorf("champ %s du compte par e-mail encore là", n)
		}
	}
}

func remplir(l *Limiter) {
	a := ip("192.0.2.1")
	l.NoterCompte(a)
	l.AllowInscriptionDebut(a)
	l.NoterEchecConnexion(a)
	l.AllowRecup(a)
	l.AllowEcritureCoffre(hDe("a"))
	l.AllowPseudoVerifier([]byte("etape"))
	l.AllowConnexionDebut(a)
	l.AllowBannir()
}

func TestLimitesCompteOublieesALaRotation(t *testing.T) {
	now := t0
	l := newLim(&now)
	remplir(l)
	for n, v := range compteMaps(l) {
		if v != 1 {
			t.Fatalf("%s : %d entrées après remplissage (champ absent : -1)", n, v)
		}
	}
	// À la minute suivante : connexion/debut vidé.
	now = t0.Add(time.Minute)
	l.AllowBannir()
	if m := compteMaps(l); m["cnx64"] != 0 || m["inscD64"] != 1 {
		t.Fatal("minute :", m)
	}
	// À l'heure suivante : les compteurs de l'heure sont vides, ceux du jour restent.
	now = t0.Add(time.Hour)
	l.AllowBannir() // déclenche la rotation
	jour := map[string]bool{"insc64": true, "insc48": true}
	for n, v := range compteMaps(l) {
		if !jour[n] && v != 0 {
			t.Errorf("%s non vidé à l'heure suivante (%d)", n, v)
		}
		if jour[n] && v != 1 {
			t.Errorf("%s vidé avant minuit (%d)", n, v)
		}
	}
	if l.bannirHeure != 1 {
		t.Errorf("bannissements de l'heure : %d, attendu 1 (remis à zéro puis compté)", l.bannirHeure)
	}
	// À minuit UTC : tout est vide.
	remplir(l)
	now = time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	l.Key(ip("192.0.2.1"))
	for n, v := range compteMaps(l) {
		if v != 0 {
			t.Errorf("%s non vidé à minuit (%d)", n, v)
		}
	}
	if l.bannirHeure != 0 {
		t.Error("bannissements non remis à zéro")
	}
}

// TestAucuneAdresseGardee : aucune clé de map du compte ne contient le h, l'adresse IP ou son
// préfixe, en clair ou en hexadécimal ; les clés sont des HMAC sous le secret du jour (qui
// tourne à minuit).
func TestAucuneAdresseGardee(t *testing.T) {
	now := t0
	l := newLim(&now)
	h := hDe("h-du-compte-16oc")
	a := ip("2001:db8:1:2::1")
	l.NoterCompte(a)
	l.AllowInscriptionDebut(a)
	l.NoterEchecConnexion(a)
	l.AllowRecup(a)
	l.AllowConnexionDebut(a)
	l.AllowEcritureCoffre(h)
	l.AllowAjoutPasskey(h)
	l.AllowPseudoVerifier(h[:])
	reperes := []string{string(h[:]), hex.EncodeToString(h[:]), "2001:db8:1:2", "2001:db8:1::"}
	v := reflect.ValueOf(l).Elem()
	for _, n := range mapsCompte {
		it := v.FieldByName(n).MapRange()
		for it.Next() {
			k := it.Key().String()
			if len(k) != 64 {
				t.Errorf("%s : clé de %d caractères, attendu un HMAC-SHA-256 en hexadécimal", n, len(k))
			}
			for _, r := range reperes {
				if strings.Contains(k, r) {
					t.Errorf("%s : clé %q contient un repère", n, k)
				}
			}
		}
	}
	// Même h le lendemain : clé différente (secret du jour).
	before := map[string]bool{}
	it := v.FieldByName("coffreCpt").MapRange()
	for it.Next() {
		before[it.Key().String()] = true
	}
	now = t0.Add(24 * time.Hour)
	l.AllowEcritureCoffre(h)
	it = v.FieldByName("coffreCpt").MapRange()
	for it.Next() {
		if before[it.Key().String()] {
			t.Fatal("clé du compte identique d'un jour à l'autre")
		}
	}
}

package compte

import (
	"reflect"
	"testing"
	"time"
)

// Lot 7 : agrégats des comptes pour le tableau de bord (conception §21.14.2). Que des
// entiers : aucun champ texte, aucune liste qui désigne un compte ; lus en direct dans
// comptes.db, compteurs depuis le démarrage en mémoire.

// entiersSeulement : chaque champ (récursivement) est un entier ou un tableau d'entiers.
func entiersSeulement(t *testing.T, ty reflect.Type, chemin string) {
	t.Helper()
	switch ty.Kind() {
	case reflect.Int, reflect.Int64:
	case reflect.Array:
		entiersSeulement(t, ty.Elem(), chemin+"[]")
	case reflect.Struct:
		for i := range ty.NumField() {
			entiersSeulement(t, ty.Field(i).Type, chemin+"."+ty.Field(i).Name)
		}
	default:
		t.Errorf("%s : %s (seuls des entiers)", chemin, ty)
	}
}

func TestAgregatsQueDesEntiers(t *testing.T) {
	entiersSeulement(t, reflect.TypeFor[AgregatsComptes](), "AgregatsComptes")

	b := nouveauBanc(t)
	h1, _, _ := b.inscrire(t, "aaa")
	b.clk.Add(40 * 24 * time.Hour)
	b.inscrire(t, "bbb")
	b.clk.Add(200 * 24 * time.Hour)
	h3, _, _ := b.inscrire(t, "ccc")
	// a : 240 j, b : 200 j, c : 0 j. a : une passkey liée à l'appareil (be = 0) et sans PRF.
	b.db.Exec(`UPDATE passkeys SET be=0, env=NULL WHERE h=?`, h1[:])
	b.db.Exec(`UPDATE sessions SET persistante=1 WHERE h=?`, h3[:])
	b.ban(t, b.compte(t, 1), 30, 10)
	r := b.ban(t, b.compte(t, 2), 365, 10)
	b.s.ActionBan(r.Vue.ID, "suspendre", "")

	a, err := b.s.Agregats()
	if err != nil {
		t.Fatal(err)
	}
	want := AgregatsComptes{Comptes: 5, Max: 100, Neufs: 3, Confirmes: 2, Anciennete: [5]int{3, 0, 0, 2, 0},
		Passkeys: 5, PasskeysPRF: 4, ComptesSansSynchro: 1, Sessions: 1, SessionsPersistantes: 1,
		BannisActifs: 1, BannisSuspendus: 1, BannisBientot: 1}
	if a != want {
		t.Fatalf("\n%+v\nattendu\n%+v", a, want)
	}
	// Suppression, effacement des inactifs.
	o, err := b.connecter(h3)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.s.Supprimer(b.session(t, o.Jeton)); err != nil {
		t.Fatal(err)
	}
	b.clk.Add(15 * 31 * 24 * time.Hour)
	if n, err := b.s.Effacer(b.clk.Now()); err != nil || n != 4 {
		t.Fatal(n, err)
	}
	a, _ = b.s.Agregats()
	if a.Suppressions != 1 || a.EffacesDernierPassage != 4 || a.Comptes != 0 || a.Sessions != 0 || a.Passkeys != 0 {
		t.Fatalf("%+v", a)
	}
}

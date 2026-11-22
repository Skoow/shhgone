package compte

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// État du compte et export (conception du compte §8.6, §12.4, §21.6.2 ; conception du compte par
// passkey §3.6, §6.4 : plus de TOTP, d'attente de récupération ni d'adresse).

// État (GET /api/compte) : dates au jour, palier tiré de compte_des, limites du palier.
func TestEtatCompte(t *testing.T) {
	b := nouveauBanc(t)
	h, j, _ := b.inscrire(t, "lea")
	et, err := b.s.Etat(b.session(t, j))
	if err != nil {
		t.Fatal(err)
	}
	want := Etat{H: h, CreeLe: "2026-11-14", Palier: "neuf", ConfirmeLe: "2026-11-21",
		Limites: Limites{Salons: 1, Places: 4, Heures: 24}}
	if et != want {
		t.Fatalf("%+v", et)
	}
	b.clk.Add(7 * 24 * time.Hour)
	ov, _ := b.connecter(h)
	et, err = b.s.Etat(b.session(t, ov.Jeton))
	want.Palier, want.ConfirmeLe, want.Limites = "confirme", "", Limites{Salons: 3, Places: 10, Heures: 24}
	if err != nil || et != want {
		t.Fatalf("%+v %v", et, err)
	}
	// Banni (actif, non échu) : échéance et motif ; suspendu : rien.
	if _, err := b.db.Exec(`INSERT INTO bannis VALUES(?,?,?,?,1,6,0)`, alea8(), h[:], jourDe(b.clk.Now()),
		jourDe(b.clk.Now())+30*jourS); err != nil {
		t.Fatal(err)
	}
	et, _ = b.s.Etat(b.session(t, ov.Jeton))
	if !et.Banni || et.BanniJusqu != "2026-12-21" || et.BanniMotif != 6 {
		t.Fatalf("%+v", et)
	}
	b.db.Exec(`UPDATE bannis SET actif=0`)
	if et, _ = b.s.Etat(b.session(t, ov.Jeton)); et.Banni || et.BanniJusqu != "" || et.BanniMotif != 0 {
		t.Fatalf("suspendu : %+v", et)
	}
}

// L'état ne porte plus rien du compte par e-mail (22 novembre).
func TestEtatSansTOTPNiAttente(t *testing.T) {
	for _, ty := range []reflect.Type{reflect.TypeFor[Etat](), reflect.TypeFor[Export]()} {
		for i := range ty.NumField() {
			n := strings.ToLower(ty.Field(i).Name)
			for _, mot := range []string{"totp", "recup", "retrait", "email", "adresse", "attente", "mdp"} {
				if strings.Contains(n, mot) {
					t.Errorf("%s.%s", ty.Name(), ty.Field(i).Name)
				}
			}
		}
	}
}

// Export : données du serveur seulement (jours, mois, appareils, passkeys au mois avec BE et PRF,
// clé publique pour la portabilité), sans empreinte, h, coffre ni enveloppe.
func TestExport(t *testing.T) {
	b := nouveauBanc(t)
	h, j, _ := b.inscrire(t, "lea")
	b.db.Exec(`UPDATE sessions SET persistante=1, etiquette=?`, bytes.Repeat([]byte{7}, 64))
	b.connecter(h)
	x, err := b.s.Export(b.session(t, j))
	if err != nil {
		t.Fatal(err)
	}
	if x.CreeLe != "2026-11-14" || x.AncienneteDepuis != "2026-11-14" || x.VuMois != "2026-11" ||
		len(x.Sessions) != 2 || x.Sessions[0].Ajoutee != "2026-11" || len(x.Passkeys) != 1 ||
		x.Passkeys[0].Ajoutee != "2026-11" || !x.Passkeys[0].BE || !x.Passkeys[0].PRF {
		t.Fatalf("%+v", x)
	}
	var pub, env, vr, envr, cred, pe, bp, bv []byte
	b.db.QueryRow(`SELECT cle_pub, cred_id FROM passkeys`).Scan(&pub, &cred)
	b.db.QueryRow(`SELECT env FROM enveloppes`).Scan(&env)
	b.db.QueryRow(`SELECT v_r, env_r, p_empreinte, blob_profil, blob_prive FROM comptes`).Scan(&vr, &envr, &pe, &bp, &bv)
	if !bytes.Equal(x.Passkeys[0].ClePub, pub) {
		t.Fatal("clé publique de l'export")
	}
	js, _ := json.Marshal(x)
	for _, s := range [][]byte{[]byte("lea"), h[:], env, vr, envr, cred, pe, bp[:64], bv[:64]} {
		for _, f := range [][]byte{s, []byte(base64.StdEncoding.EncodeToString(s)), []byte(base64.RawURLEncoding.EncodeToString(s))} {
			if len(f) > 0 && bytes.Contains(js, f) {
				t.Fatalf("export : %q contient une valeur du compte", js)
			}
		}
	}
}

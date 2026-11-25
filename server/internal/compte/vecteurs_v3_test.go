package compte

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"testing"
)

// vecteursV3 : engine/vectors/compte-v3.json (compte par passkey, conception
// 2026-11-22-compte-passkey-design.md §5, §14), produit par le moteur Rust, rejoué
// ici pour ce qui concerne le serveur : v_r = SHA-256(A_r)
// (la route recup cherche le compte par cette empreinte), longueurs exactes des champs reçus
// (h, A_r, v_r, enveloppes de 60 octets, identifiant de passkey de 1 à 1 023 octets, coffres de
// palier + 45 octets), p_canon des pseudos et pseudos réservés. Le serveur ne déchiffre jamais
// une enveloppe ni un coffre : le test les ouvre seulement pour prouver que les vecteurs sont
// cohérents avec les clés dont le serveur ne dispose pas.
type vecteursV3 struct {
	Constants struct {
		EnveloppeLen int    `json:"enveloppe_len"`
		EntreePRF    string `json:"entree_prf"`
		CredIDMax    int    `json:"cred_id_max"`
		Reserves     []struct {
			PCanonHex string `json:"p_canon_hex"`
		} `json:"reserves"`
	} `json:"constants"`
	EnveloppePRF []struct {
		Label   string `json:"label"`
		H       string `json:"h"`
		CredID  string `json:"cred_id"`
		Env     string `json:"env"`
		KEK     string `json:"kek"`
		AD      string `json:"ad"`
		KCompte string `json:"k_compte"`
		Error   string `json:"error"`
	} `json:"enveloppe_prf"`
	Recup []struct {
		Label   string `json:"label"`
		H       string `json:"h"`
		AR      string `json:"a_r"`
		VR      string `json:"v_r"`
		EnvR    string `json:"env_r"`
		KEKR    string `json:"kek_r"`
		AD      string `json:"ad"`
		KCompte string `json:"k_compte"`
	} `json:"recup"`
	CoffreProfil []vecteurCoffreV3 `json:"coffre_profil"`
	CoffrePrive  []vecteurCoffreV3 `json:"coffre_prive"`
	Pseudo       []struct {
		Label     string `json:"label"`
		EntreeHex string `json:"entree_hex"`
		PCanonHex string `json:"p_canon_hex"`
		Reserve   bool   `json:"reserve"`
		Error     string `json:"error"`
	} `json:"pseudo"`
}

type vecteurCoffreV3 struct {
	Label   string `json:"label"`
	Palier  int    `json:"palier"`
	BlobLen int    `json:"blob_len"`
	Blob    string `json:"blob"`
	Gen     uint64 `json:"gen"`
}

func lireVecteursV3(t *testing.T) vecteursV3 {
	t.Helper()
	b, err := os.ReadFile("../../../engine/vectors/compte-v3.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vecteursV3
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// ouvrirEnveloppe : nonce (12) ‖ AES-256-GCM(kek, nonce, K_compte, ad), pour le test seulement.
func ouvrirEnveloppe(t *testing.T, kek, ad, env []byte) ([]byte, error) {
	t.Helper()
	a, err := aes.NewCipher(kek)
	if err != nil {
		t.Fatal(err)
	}
	g, err := cipher.NewGCM(a)
	if err != nil {
		t.Fatal(err)
	}
	return g.Open(nil, env[:12], env[12:], ad)
}

func TestVecteursV3Recup(t *testing.T) {
	v := lireVecteursV3(t)
	if len(v.Recup) < 2 {
		t.Fatalf("%d cas recup", len(v.Recup))
	}
	for _, c := range v.Recup {
		h, a, vr, env := unhex(t, c.H), unhex(t, c.AR), unhex(t, c.VR), unhex(t, c.EnvR)
		if len(h) != 16 || len(a) != 32 || len(vr) != 32 || len(env) != v.Constants.EnveloppeLen {
			t.Fatalf("%s : longueurs h %d, a_r %d, v_r %d, env_r %d", c.Label, len(h), len(a), len(vr), len(env))
		}
		// Ce que fera la route recup : v_r = SHA-256(A_r), recherche par index exact.
		if s := sha256.Sum256(a); !bytes.Equal(s[:], vr) {
			t.Errorf("%s : v_r ≠ SHA-256(a_r)", c.Label)
		}
		ad := append(append([]byte("SHH-CENV2"), h...), "recup"...)
		if !bytes.Equal(ad, unhex(t, c.AD)) {
			t.Errorf("%s : AD", c.Label)
		}
		k, err := ouvrirEnveloppe(t, unhex(t, c.KEKR), ad, env)
		if err != nil || !bytes.Equal(k, unhex(t, c.KCompte)) {
			t.Errorf("%s : env_r ne s'ouvre pas par kek_r (%v)", c.Label, err)
		}
		// A_r, seul reçu par le serveur, n'ouvre pas l'enveloppe (ni v_r, qu'il garde).
		for _, cle := range [][]byte{a, vr} {
			if _, err := ouvrirEnveloppe(t, cle, ad, env); err == nil {
				t.Errorf("%s : env_r ouverte par ce que voit le serveur", c.Label)
			}
		}
	}
}

func TestVecteursV3EnveloppesPRF(t *testing.T) {
	v := lireVecteursV3(t)
	if v.Constants.EnveloppeLen != 60 || v.Constants.CredIDMax != 1023 {
		t.Fatalf("constantes %d, %d", v.Constants.EnveloppeLen, v.Constants.CredIDMax)
	}
	n, erreurs := 0, 0
	for _, c := range v.EnveloppePRF {
		if c.Error != "" {
			erreurs++
			continue
		}
		n++
		h, cred, env := unhex(t, c.H), unhex(t, c.CredID), unhex(t, c.Env)
		if len(h) != 16 || len(cred) < 1 || len(cred) > v.Constants.CredIDMax || len(env) != 60 {
			t.Fatalf("%s : longueurs", c.Label)
		}
		s := sha256.Sum256(cred)
		ad := append(append([]byte("SHH-CENV2"), h...), s[:]...)
		if !bytes.Equal(ad, unhex(t, c.AD)) {
			t.Errorf("%s : AD", c.Label)
		}
		if k, err := ouvrirEnveloppe(t, unhex(t, c.KEK), ad, env); err != nil || !bytes.Equal(k, unhex(t, c.KCompte)) {
			t.Errorf("%s : enveloppe (%v)", c.Label, err)
		}
	}
	if n < 4 || erreurs < 2 {
		t.Fatalf("%d enveloppes, %d refus", n, erreurs)
	}
}

// Coffres : magie (9) ‖ gen (8) ‖ nonce (12) ‖ chiffré du palier ‖ tag (16) = palier + 45 octets,
// la forme que le serveur vérifie sans l'ouvrir (base.go).
func TestVecteursV3Coffres(t *testing.T) {
	v := lireVecteursV3(t)
	for nom, cases := range map[string][]vecteurCoffreV3{"SHH-PROF1": v.CoffreProfil, "SHH-ACCT1": v.CoffrePrive} {
		if len(cases) < 2 {
			t.Fatalf("%s : %d cas", nom, len(cases))
		}
		for _, c := range cases {
			if !slices.Contains([]int{4096, 16384, 65536, 262144}, c.Palier) || c.BlobLen != c.Palier+45 {
				t.Errorf("%s %s : palier %d, longueur %d", nom, c.Label, c.Palier, c.BlobLen)
			}
			if c.Blob == "" {
				continue
			}
			b := unhex(t, c.Blob)
			if len(b) != c.BlobLen || string(b[:9]) != nom || binary.BigEndian.Uint64(b[9:17]) != c.Gen {
				t.Errorf("%s %s : en-tête", nom, c.Label)
			}
		}
	}
}

// p_canon et réservés de compte-v3.json (les mêmes que le compte par e-mail) : l'empreinte du pseudo (HMAC de K_pseudo) ne
// change pas avec le compte par passkey.
func TestVecteursV3Pseudo(t *testing.T) {
	v := lireVecteursV3(t)
	c := clesTest(3)
	n := 0
	for _, p := range v.Pseudo {
		if p.Error != "" {
			continue
		}
		n++
		_, err := c.EmpreintePseudo(unhex(t, p.PCanonHex))
		if p.Reserve != errors.Is(err, ErrPseudoReserve) || (!p.Reserve && err != nil) {
			t.Errorf("%s : %v", p.Label, err)
		}
	}
	if n < 5 {
		t.Fatalf("%d pseudos acceptés", n)
	}
	var want []string
	for _, r := range v.Constants.Reserves {
		want = append(want, string(unhex(t, r.PCanonHex)))
	}
	got := slices.Clone(reserves)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("reserves.txt = %q\nattendu       %q", got, want)
	}
}

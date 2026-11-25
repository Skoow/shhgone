package compte

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/skoow/shhdrop/server/internal/compte/webauthntest"
)

// Cérémonies WebAuthn (go-webauthn épinglé, configuration figée), avec l'authentificateur
// logiciel de webauthntest.

const origineTest = "http://localhost:8080"

func ceremoniesTest(t *testing.T) *Ceremonies {
	t.Helper()
	c, err := NouvellesCeremonies(origineTest, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// creerPasskey : une inscription complète du compte h avec a ; rend ce que le serveur garde.
func creerPasskey(t *testing.T, c *Ceremonies, a *webauthntest.Authentificateur, h [16]byte) (Passkey, *webauthntest.Passkey) {
	t.Helper()
	opts, sd, err := c.debutCreation(h, nil)
	if err != nil {
		t.Fatal(err)
	}
	rep, p, err := a.Creer(opts, origineTest, "")
	if err != nil {
		t.Fatal(err)
	}
	pk, err := c.finCreation(h, sd, rep)
	if err != nil {
		t.Fatal(err)
	}
	return pk, p
}

// connexion : une connexion découvrable avec p ; cherche trouve pk (compte h).
func connexion(c *Ceremonies, a *webauthntest.Authentificateur, p *webauthntest.Passkey, h [16]byte, pk Passkey,
	modifier func([]byte) []byte) ([16]byte, []byte, error) {
	opts, sd, err := c.debutAssertion(nil, nil)
	if err != nil {
		return [16]byte{}, nil, err
	}
	rep, err := a.Obtenir(opts, origineTest, p)
	if err != nil {
		return [16]byte{}, nil, err
	}
	if modifier != nil {
		rep = modifier(rep)
	}
	return c.finAssertion(sd, rep, func(id []byte) ([16]byte, Passkey, error) {
		if !bytes.Equal(id, pk.CredID) {
			return [16]byte{}, Passkey{}, ErrIdentifiants
		}
		return h, pk, nil
	}, nil, nil)
}

// Cérémonie complète (inscription puis connexion découvrable) pour chaque algorithme : la clé
// publique gardée est celle de l'authentificateur, BE gardé, rien d'autre.
func TestCeremoniesParAlgorithme(t *testing.T) {
	c := ceremoniesTest(t)
	for _, alg := range []int{webauthntest.ES256, webauthntest.EdDSA, webauthntest.RS256} {
		a := webauthntest.Nouveau(alg)
		var h [16]byte
		rand.Read(h[:])
		pk, p := creerPasskey(t, c, a, h)
		if pk.Alg != int64(alg) || !bytes.Equal(pk.CredID, p.ID) || !bytes.Equal(pk.ClePub, p.ClePublique()) || !pk.BE ||
			pk.Env != nil || pk.Etiquette != nil {
			t.Fatalf("%d : %+v", alg, pk)
		}
		hh, id, err := connexion(c, a, p, h, pk, nil)
		if err != nil || hh != h || !bytes.Equal(id, p.ID) {
			t.Fatalf("%d : connexion %v", alg, err)
		}
		// Compteur de signatures : jamais lu ; une deuxième connexion (compteur plus grand chez
		// l'authentificateur, 0 côté serveur) passe, une passkey synchronisée qui rend 0 aussi.
		if _, _, err := connexion(c, a, p, h, pk, nil); err != nil {
			t.Fatal(err)
		}
		p.Compteur = 0
		if _, _, err := connexion(c, a, p, h, pk, nil); err != nil {
			t.Fatal("compteur à 0 refusé :", err)
		}
	}
}

// Options : celles de la conception §6.2, en JSON WebAuthn niveau 3 ; prf.eval.first = E_prf des
// vecteurs ; user.name et displayName vides (le site y met le pseudo).
func TestOptionsInscription(t *testing.T) {
	c := ceremoniesTest(t)
	h := [16]byte{1, 2, 3}
	opts, _, err := c.debutCreation(h, nil)
	if err != nil {
		t.Fatal(err)
	}
	var o struct {
		RP struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"rp"`
		User struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
		} `json:"user"`
		Challenge string `json:"challenge"`
		Params    []struct {
			Type string `json:"type"`
			Alg  int    `json:"alg"`
		} `json:"pubKeyCredParams"`
		Timeout int `json:"timeout"`
		Sel     struct {
			Attachment string `json:"authenticatorAttachment"`
			RK         string `json:"residentKey"`
			RRK        bool   `json:"requireResidentKey"`
			UV         string `json:"userVerification"`
		} `json:"authenticatorSelection"`
		Attestation string `json:"attestation"`
		Hints       []string
		Ext         struct {
			PRF struct {
				Eval struct {
					First string `json:"first"`
				} `json:"eval"`
			} `json:"prf"`
			CredProps bool `json:"credProps"`
		} `json:"extensions"`
	}
	d := json.NewDecoder(bytes.NewReader(opts))
	if err := d.Decode(&o); err != nil {
		t.Fatal(err)
	}
	v := lireVecteursV3(t)
	ch, _ := b64.DecodeString(o.Challenge)
	if o.RP.ID != "localhost" || o.RP.Name != "Shhgone" || o.User.ID != b64.EncodeToString(h[:]) || o.User.Name != "" ||
		o.User.DisplayName != "" || len(ch) != 32 || o.Timeout != 300000 || o.Sel.Attachment != "" || o.Sel.RK != "required" ||
		!o.Sel.RRK || o.Sel.UV != "required" || o.Attestation != "none" || o.Hints != nil || !o.Ext.CredProps {
		t.Fatalf("%s", opts)
	}
	e, _ := b64.DecodeString(o.Ext.PRF.Eval.First)
	if hex.EncodeToString(e) != v.Constants.EntreePRF || hex.EncodeToString(EntreePRF[:]) != v.Constants.EntreePRF {
		t.Fatal("E_prf :", hex.EncodeToString(e))
	}
	var algs []int
	for _, p := range o.Params {
		if p.Type != "public-key" {
			t.Fatal(p)
		}
		algs = append(algs, p.Alg)
	}
	if fmt.Sprint(algs) != "[-7 -8 -257]" {
		t.Fatal(algs)
	}
	// Connexion découvrable : aucune passkey nommée, UV exigé, même entrée PRF, rp.id.
	ao, _, err := c.debutAssertion(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := string(ao)
	if !strings.Contains(s, `"rpId":"localhost"`) || !strings.Contains(s, `"userVerification":"required"`) ||
		strings.Contains(s, "allowCredentials") || !strings.Contains(s, `"prf":{"eval":{"first":"`+b64.EncodeToString(EntreePRF[:])+`"}}`) {
		t.Fatal(s)
	}
}

// Refus (conception §14) : mauvaise origine, mauvais rp.id, UV absent, attestation autre que
// none, sortie PRF envoyée au serveur, passkey non découvrable ; tous sans rien garder.
func TestInscriptionRefusee(t *testing.T) {
	c := ceremoniesTest(t)
	h := [16]byte{9}
	cas := map[string]struct {
		regler  func(*webauthntest.Authentificateur)
		origine string
		rpID    string
		changer func([]byte) []byte
		err     error
	}{
		"mauvaise origine":         {origine: "http://localhost:8081", err: ErrIdentifiants},
		"origine https":            {origine: "https://localhost:8080", err: ErrIdentifiants},
		"sous-domaine":             {origine: "http://a.localhost:8080", err: ErrIdentifiants},
		"mauvais rp.id":            {rpID: "exemple.fr", err: ErrIdentifiants},
		"UV absent":                {regler: func(a *webauthntest.Authentificateur) { a.UV = false }, err: ErrIdentifiants},
		"BS sans BE":               {regler: func(a *webauthntest.Authentificateur) { a.BE, a.BS = false, true }, err: ErrIdentifiants},
		"attestation packed":       {regler: func(a *webauthntest.Authentificateur) { a.Format = "packed" }, err: ErrRequete},
		"attestation tpm":          {regler: func(a *webauthntest.Authentificateur) { a.Format = "tpm" }, err: ErrRequete},
		"sortie PRF envoyée":       {changer: avecSortiePRF, err: ErrRequete},
		"hmac-secret envoyé":       {changer: avecHMACSecret, err: ErrRequete},
		"non découvrable":          {changer: rkFaux, err: ErrRequete},
		"JSON illisible":           {changer: func([]byte) []byte { return []byte(`{"id":`) }, err: ErrRequete},
		"type autre que publickey": {changer: typeFaux, err: ErrRequete},
	}
	for nom, x := range cas {
		a := webauthntest.Nouveau(webauthntest.ES256)
		if x.regler != nil {
			x.regler(a)
		}
		o := origineTest
		if x.origine != "" {
			o = x.origine
		}
		opts, sd, err := c.debutCreation(h, nil)
		if err != nil {
			t.Fatal(err)
		}
		rep, _, err := a.Creer(opts, o, x.rpID)
		if err != nil {
			t.Fatal(nom, err)
		}
		if x.changer != nil {
			rep = x.changer(rep)
		}
		if _, err := c.finCreation(h, sd, rep); !errors.Is(err, x.err) {
			t.Errorf("%s : %v, attendu %v", nom, err, x.err)
		}
	}
	// Un autre compte (user.id du défi) : refus.
	a := webauthntest.Nouveau(webauthntest.ES256)
	opts, sd, _ := c.debutCreation(h, nil)
	rep, _, _ := a.Creer(opts, origineTest, "")
	if _, err := c.finCreation([16]byte{8}, sd, rep); !errors.Is(err, ErrIdentifiants) {
		t.Fatal("autre h :", err)
	}
}

func modifierJSON(b []byte, f func(map[string]any)) []byte {
	var m map[string]any
	json.Unmarshal(b, &m)
	f(m)
	out, _ := json.Marshal(m)
	return out
}

func avecSortiePRF(b []byte) []byte {
	return modifierJSON(b, func(m map[string]any) {
		m["clientExtensionResults"].(map[string]any)["prf"] = map[string]any{"enabled": true,
			"results": map[string]any{"first": b64.EncodeToString(make([]byte, 32))}}
	})
}

func avecHMACSecret(b []byte) []byte {
	return modifierJSON(b, func(m map[string]any) {
		m["clientExtensionResults"].(map[string]any)["hmacGetSecret"] = map[string]any{"output1": b64.EncodeToString(make([]byte, 32))}
	})
}

func rkFaux(b []byte) []byte {
	return modifierJSON(b, func(m map[string]any) {
		m["clientExtensionResults"].(map[string]any)["credProps"] = map[string]any{"rk": false}
	})
}

func typeFaux(b []byte) []byte {
	return modifierJSON(b, func(m map[string]any) { m["type"] = "password" })
}

// Connexion refusée, toujours la même erreur (identifiants) : mauvaise origine, UV absent, BE
// changé depuis l'inscription, userHandle d'un autre compte, cred_id inconnu, signature fausse,
// sortie PRF envoyée (bad_request).
func TestConnexionRefusee(t *testing.T) {
	c := ceremoniesTest(t)
	h := [16]byte{7}
	a := webauthntest.Nouveau(webauthntest.ES256)
	pk, p := creerPasskey(t, c, a, h)
	essai := func(nom string, err error, f func() ([16]byte, []byte, error)) {
		t.Helper()
		if _, _, e := f(); !errors.Is(e, err) {
			t.Errorf("%s : %v, attendu %v", nom, e, err)
		}
	}
	signer := func(origine, rpID string, uh []byte) func() ([16]byte, []byte, error) {
		return func() ([16]byte, []byte, error) {
			opts, sd, _ := c.debutAssertion(nil, nil)
			var o struct {
				Challenge string `json:"challenge"`
			}
			json.Unmarshal(opts, &o)
			rep, err := a.Signer(o.Challenge, rpID, origine, p, uh)
			if err != nil {
				return [16]byte{}, nil, err
			}
			return c.finAssertion(sd, rep, func(id []byte) ([16]byte, Passkey, error) {
				if !bytes.Equal(id, pk.CredID) {
					return [16]byte{}, Passkey{}, ErrIdentifiants
				}
				return h, pk, nil
			}, nil, nil)
		}
	}
	essai("mauvaise origine", ErrIdentifiants, signer("http://localhost:9999", "localhost", h[:]))
	essai("mauvais rp.id", ErrIdentifiants, signer(origineTest, "exemple.fr", h[:]))
	essai("userHandle d'un autre compte", ErrIdentifiants, signer(origineTest, "localhost", []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}))
	essai("userHandle absent", ErrIdentifiants, signer(origineTest, "localhost", nil))
	a.UV = false
	essai("UV absent", ErrIdentifiants, func() ([16]byte, []byte, error) { return connexion(c, a, p, h, pk, nil) })
	a.UV, a.BE, a.BS = true, false, false
	essai("BE changé", ErrIdentifiants, func() ([16]byte, []byte, error) { return connexion(c, a, p, h, pk, nil) })
	a.BE = true
	essai("sortie PRF envoyée", ErrRequete, func() ([16]byte, []byte, error) { return connexion(c, a, p, h, pk, avecSortiePRF) })
	essai("signature fausse", ErrIdentifiants, func() ([16]byte, []byte, error) {
		return connexion(c, a, p, h, pk, func(b []byte) []byte {
			return modifierJSON(b, func(m map[string]any) {
				m["response"].(map[string]any)["signature"] = b64.EncodeToString(make([]byte, 70))
			})
		})
	})
	essai("cred_id inconnu", ErrIdentifiants, func() ([16]byte, []byte, error) {
		autre := webauthntest.Nouveau(webauthntest.ES256)
		_, q := creerPasskey(t, c, autre, h)
		return connexion(c, autre, q, h, pk, nil)
	})
	// Défi d'une autre cérémonie : refus.
	essai("autre défi", ErrIdentifiants, func() ([16]byte, []byte, error) {
		opts, _, _ := c.debutAssertion(nil, nil)
		_, sd2, _ := c.debutAssertion(nil, nil)
		rep, _ := a.Obtenir(opts, origineTest, p)
		return c.finAssertion(sd2, rep, func([]byte) ([16]byte, Passkey, error) { return h, pk, nil }, nil, nil)
	})
	// Réauthentification (passkeys du compte nommées) : une passkey d'un autre compte refusée.
	autre := webauthntest.Nouveau(webauthntest.EdDSA)
	pk2, p2 := creerPasskey(t, c, autre, [16]byte{6})
	opts, sd, _ := c.debutAssertion(h[:], []Passkey{pk})
	if !strings.Contains(string(opts), `"allowCredentials":[{"type":"public-key","id":"`+b64.EncodeToString(pk.CredID)+`"`) {
		t.Fatal(string(opts))
	}
	rep, _ := autre.Signer(challengeDe(opts), "localhost", origineTest, p2, nil)
	if _, _, err := c.finAssertion(sd, rep, nil, &h, []Passkey{pk}); !errors.Is(err, ErrIdentifiants) {
		t.Fatal("passkey d'un autre compte :", err, pk2)
	}
	opts, sd, _ = c.debutAssertion(h[:], []Passkey{pk})
	rep, _ = a.Obtenir(opts, origineTest, nil)
	if hh, id, err := c.finAssertion(sd, rep, nil, &h, []Passkey{pk}); err != nil || hh != h || !bytes.Equal(id, pk.CredID) {
		t.Fatal("reauth :", err)
	}
}

func challengeDe(opts []byte) string {
	var o struct {
		Challenge string `json:"challenge"`
	}
	json.Unmarshal(opts, &o)
	return o.Challenge
}

// TestRPIDProduction : SHH_ORIGIN=https://shhgone.com → rp.id shhgone.com ; http refusé hors de
// localhost ; adresse IP refusée ; origines d'apps Android exactes seulement.
func TestRPIDProduction(t *testing.T) {
	c, err := NouvellesCeremonies("https://shhgone.com", nil)
	if err != nil || c.RPID() != "shhgone.com" {
		t.Fatal(c, err)
	}
	if c, err := NouvellesCeremonies("http://localhost:8080", nil); err != nil || c.RPID() != "localhost" {
		t.Fatal(err)
	}
	for _, o := range []string{"http://shhgone.com", "http://127.0.0.1:8080", "https://127.0.0.1", "https://[::1]:443",
		"https://shhgone.com/", "https://shhgone.com/x", "shhgone.com", "", "https://user@shhgone.com", "ftp://shhgone.com",
		"https://shhgone.com?x=1"} {
		if _, err := NouvellesCeremonies(o, nil); err == nil {
			t.Errorf("%q accepté", o)
		}
	}
	bon := "android:apk-key-hash:" + b64.EncodeToString(bytes.Repeat([]byte{7}, 32))
	if c, err := NouvellesCeremonies("https://shhgone.com", []string{bon}); err != nil || len(c.w.Config.RPOpaqueOrigins) != 1 {
		t.Fatal(err)
	}
	for _, o := range []string{"android:apk-key-hash:", bon + "A", bon[:len(bon)-1], "ios:bundle-id:com.shhgone", "https://app.shhgone.com",
		"android:apk-key-hash:" + strings.Repeat("=", 43)} {
		if _, err := NouvellesCeremonies("https://shhgone.com", []string{o}); err == nil {
			t.Errorf("origine d'app %q acceptée", o)
		}
	}
}

// Configuration figée (conception §6.1) : chaque champ vérifié ; aucune autre
// configuration possible (construite seulement par NouvellesCeremonies).
func TestConfigurationFigee(t *testing.T) {
	c := ceremoniesTest(t)
	cfg := c.w.Config
	if cfg.MDS != nil || cfg.RPID != "localhost" || cfg.RPDisplayName != "Shhgone" || len(cfg.RPOrigins) != 1 ||
		cfg.RPOrigins[0] != origineTest || len(cfg.RPTopOrigins) != 0 || cfg.RPAllowCrossOrigin || cfg.Debug ||
		cfg.AttestationPreference != "none" || cfg.AuthenticatorSelection.UserVerification != "required" ||
		cfg.AuthenticatorSelection.ResidentKey != "required" || cfg.AuthenticatorSelection.AuthenticatorAttachment != "" ||
		cfg.EncodeUserIDAsString || cfg.Timeouts.Login.Enforce || cfg.Timeouts.Registration.Enforce || cfg.Filtering != nil {
		t.Fatalf("%+v", cfg)
	}
}

// TestWebAuthnTestSeulementDansLesTests : l'authentificateur logiciel n'est importé que par des
// tests ; la bibliothèque WebAuthn seulement par webauthn.go (et ce paquet de test).
func TestWebAuthnTestSeulementDansLesTests(t *testing.T) {
	err := filepath.WalkDir("../..", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return err
		}
		f, err := parser.ParseFile(token.NewFileSet(), p, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range f.Imports {
			v, _ := strconv.Unquote(imp.Path.Value)
			base := filepath.ToSlash(p)
			switch {
			case strings.HasSuffix(v, "/compte/webauthntest"):
				t.Errorf("%s importe webauthntest hors d'un test", base)
			case strings.HasPrefix(v, "github.com/go-webauthn/") && !strings.HasSuffix(base, "internal/compte/webauthn.go") &&
				!strings.Contains(base, "internal/compte/webauthntest/"):
				t.Errorf("%s importe %s (seul internal/compte/webauthn.go)", base, v)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

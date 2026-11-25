// Package webauthntest : authentificateur logiciel pour les tests du compte par passkey. Il joue
// le navigateur et l'authentificateur : il lit les options JSON de WebAuthn niveau 3 que rend le
// serveur, et rend les réponses JSON (RegistrationResponseJSON, AuthenticationResponseJSON) que
// le site enverrait. ES256, EdDSA et RS256 ; drapeaux UV, BE, BS réglables ; attestation « none »
// (ou une autre, pour la refuser).
//
// Seulement pour les tests : aucune source du serveur ne l'importe hors des fichiers _test.go
// (TestWebAuthnTestSeulementDansLesTests). Le secret PRF n'est pas simulé côté serveur : le
// serveur ne doit jamais voir de sortie PRF ; Sortie le calcule pour les tests qui le cherchent.
package webauthntest

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math/big"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
)

var b64 = base64.RawURLEncoding

// Algorithmes COSE.
const (
	ES256 = -7
	EdDSA = -8
	RS256 = -257
)

// Passkey : une passkey de l'authentificateur.
type Passkey struct {
	ID         []byte
	UserHandle []byte
	RPID       string
	Alg        int
	signer     crypto.Signer
	cose       []byte
	prf        [32]byte // secret hmac-secret de cette passkey
	Compteur   uint32
}

// Authentificateur : réglages des drapeaux et passkeys créées (une tranche, pas de map :
// TestNoUnlistedCounter de internal/stats_test.go lit aussi ce paquet).
type Authentificateur struct {
	Alg      int
	UV       bool // utilisateur vérifié
	BE, BS   bool // sauvegardable, sauvegardée
	AAGUID   [16]byte
	Format   string // format d'attestation ("none" par défaut)
	Passkeys []*Passkey
	// SansCredProps : ne pas rendre credProps ; SansPRF : PRF absente (enabled faux).
	SansCredProps, SansPRF bool
}

// Nouveau : authentificateur « passkey synchronisée » typique (UV, BE, BS), AAGUID aléatoire.
func Nouveau(alg int) *Authentificateur {
	a := &Authentificateur{Alg: alg, UV: true, BE: true, BS: true, Format: "none"}
	rand.Read(a.AAGUID[:])
	return a
}

type entite struct {
	ID string `json:"id"`
}

type creationOptions struct {
	RP   entite `json:"rp"`
	User struct {
		ID string `json:"id"`
	} `json:"user"`
	Challenge string `json:"challenge"`
	Params    []struct {
		Alg int `json:"alg"`
	} `json:"pubKeyCredParams"`
	Exclude []struct {
		ID string `json:"id"`
	} `json:"excludeCredentials"`
}

type requestOptions struct {
	Challenge string `json:"challenge"`
	RPID      string `json:"rpId"`
	Allow     []struct {
		ID string `json:"id"`
	} `json:"allowCredentials"`
}

func nouvelleCle(alg int) (crypto.Signer, []byte, error) {
	switch alg {
	case ES256:
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, nil, err
		}
		pub, err := k.PublicKey.Bytes() // 0x04 ‖ X (32) ‖ Y (32)
		if err != nil {
			return nil, nil, err
		}
		x, y := pub[1:33], pub[33:]
		c, err := webauthncbor.Marshal(map[int]any{1: 2, 3: ES256, -1: 1, -2: x, -3: y})
		return k, c, err
	case EdDSA:
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, nil, err
		}
		c, err := webauthncbor.Marshal(map[int]any{1: 1, 3: EdDSA, -1: 6, -2: []byte(pub)})
		return priv, c, err
	case RS256:
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, nil, err
		}
		e := big.NewInt(int64(k.PublicKey.E)).Bytes()
		c, err := webauthncbor.Marshal(map[int]any{1: 3, 3: RS256, -1: k.PublicKey.N.Bytes(), -2: e})
		return k, c, err
	}
	return nil, nil, errors.New("webauthntest : algorithme inconnu")
}

func (a *Authentificateur) drapeaux(at bool) byte {
	f := byte(0x01) // UP
	if a.UV {
		f |= 0x04
	}
	if a.BE {
		f |= 0x08
	}
	if a.BS {
		f |= 0x10
	}
	if at {
		f |= 0x40
	}
	return f
}

func clientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false})
	return b
}

// Creer : navigator.credentials.create(options) depuis origin ; rend RegistrationResponseJSON
// (prf.results jamais inclus : le site les retire avant l'envoi) et la passkey créée.
// rpID : celui des options (vide : options.rp.id) — un autre force un mauvais rp.id.
func (a *Authentificateur) Creer(optionsJSON []byte, origin, rpID string) ([]byte, *Passkey, error) {
	var o creationOptions
	if err := json.Unmarshal(optionsJSON, &o); err != nil {
		return nil, nil, err
	}
	if rpID == "" {
		rpID = o.RP.ID
	}
	uh, err := b64.DecodeString(o.User.ID)
	if err != nil {
		return nil, nil, err
	}
	signer, cose, err := nouvelleCle(a.Alg)
	if err != nil {
		return nil, nil, err
	}
	p := &Passkey{ID: make([]byte, 32), UserHandle: uh, RPID: rpID, Alg: a.Alg, signer: signer, cose: cose}
	rand.Read(p.ID)
	rand.Read(p.prf[:])
	rh := sha256.Sum256([]byte(rpID))
	ad := append(rh[:], a.drapeaux(true), 0, 0, 0, 0)
	ad = append(ad, a.AAGUID[:]...)
	ad = binary.BigEndian.AppendUint16(ad, uint16(len(p.ID)))
	ad = append(ad, p.ID...)
	ad = append(ad, cose...)
	cd := clientData("webauthn.create", o.Challenge, origin)
	att := map[string]any{"fmt": a.Format, "attStmt": map[string]any{}, "authData": ad}
	if a.Format != "none" {
		h := sha256.Sum256(cd)
		sig, err := signer.Sign(rand.Reader, digest(a.Alg, append(append([]byte{}, ad...), h[:]...)), opts(a.Alg))
		if err != nil {
			return nil, nil, err
		}
		att["attStmt"] = map[string]any{"alg": a.Alg, "sig": sig}
	}
	ao, err := webauthncbor.Marshal(att)
	if err != nil {
		return nil, nil, err
	}
	ext := map[string]any{"prf": map[string]any{"enabled": !a.SansPRF}}
	if !a.SansCredProps {
		ext["credProps"] = map[string]any{"rk": true}
	}
	r := map[string]any{
		"id": b64.EncodeToString(p.ID), "rawId": b64.EncodeToString(p.ID), "type": "public-key",
		"authenticatorAttachment": "platform",
		"response": map[string]any{"clientDataJSON": b64.EncodeToString(cd), "attestationObject": b64.EncodeToString(ao),
			"transports": []string{"internal", "hybrid"}},
		"clientExtensionResults": ext,
	}
	b, err := json.Marshal(r)
	if err != nil {
		return nil, nil, err
	}
	a.Passkeys = append(a.Passkeys, p)
	return b, p, nil
}

func digest(alg int, msg []byte) []byte {
	if alg == EdDSA {
		return msg
	}
	h := sha256.Sum256(msg)
	return h[:]
}

func opts(alg int) crypto.SignerOpts {
	if alg == EdDSA {
		return crypto.Hash(0)
	}
	return crypto.SHA256
}

// Obtenir : navigator.credentials.get(options) avec la passkey p (nil : la première permise par
// allowCredentials, ou la dernière créée pour ce rp.id) ; rend AuthenticationResponseJSON.
func (a *Authentificateur) Obtenir(optionsJSON []byte, origin string, p *Passkey) ([]byte, error) {
	var o requestOptions
	if err := json.Unmarshal(optionsJSON, &o); err != nil {
		return nil, err
	}
	if p == nil {
		for i := len(a.Passkeys) - 1; i >= 0 && p == nil; i-- {
			c := a.Passkeys[i]
			if len(o.Allow) == 0 && c.RPID == o.RPID {
				p = c
			}
			for _, x := range o.Allow {
				if x.ID == b64.EncodeToString(c.ID) {
					p = c
				}
			}
		}
		if p == nil {
			return nil, errors.New("webauthntest : aucune passkey pour ces options")
		}
	}
	return a.Signer(o.Challenge, o.RPID, origin, p, p.UserHandle)
}

// Signer : une assertion de p pour ce défi, ce rp.id et cette origine, avec ce userHandle (nil :
// absent). Sert aussi à fabriquer des réponses fausses.
func (a *Authentificateur) Signer(challenge, rpID, origin string, p *Passkey, userHandle []byte) ([]byte, error) {
	p.Compteur++
	rh := sha256.Sum256([]byte(rpID))
	ad := append(rh[:], a.drapeaux(false))
	ad = binary.BigEndian.AppendUint32(ad, p.Compteur)
	cd := clientData("webauthn.get", challenge, origin)
	h := sha256.Sum256(cd)
	sig, err := p.signer.Sign(rand.Reader, digest(p.Alg, append(append([]byte{}, ad...), h[:]...)), opts(p.Alg))
	if err != nil {
		return nil, err
	}
	resp := map[string]any{"clientDataJSON": b64.EncodeToString(cd), "authenticatorData": b64.EncodeToString(ad),
		"signature": b64.EncodeToString(sig)}
	if userHandle != nil {
		resp["userHandle"] = b64.EncodeToString(userHandle)
	}
	return json.Marshal(map[string]any{"id": b64.EncodeToString(p.ID), "rawId": b64.EncodeToString(p.ID),
		"type": "public-key", "authenticatorAttachment": "platform", "response": resp, "clientExtensionResults": map[string]any{}})
}

// Sortie : sortie PRF de p pour l'entrée e (comme le navigateur : hmac-secret sur
// SHA-256(« WebAuthn PRF » ‖ 0x00 ‖ e)) ; jamais envoyée au serveur, cherchée par les tests.
func (p *Passkey) Sortie(e []byte) [32]byte {
	s := sha256.Sum256(append([]byte("WebAuthn PRF\x00"), e...))
	m := hmac.New(sha256.New, p.prf[:])
	m.Write(s[:])
	return [32]byte(m.Sum(nil))
}

// ClePublique : la clé publique COSE de p (telle que le serveur la garde).
func (p *Passkey) ClePublique() []byte { return p.cose }

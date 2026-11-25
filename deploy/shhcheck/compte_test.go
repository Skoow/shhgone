package main

// Compte de test pour deploy/test-restauration.sh : une inscription complète par passkey
// (authentificateur ES256 joué ici, bibliothèque standard seulement) puis, après sauvegarde,
// effacement et restauration de comptes.db, une connexion par la même passkey et une
// récupération par la même clé. Lancé par le script, qui démarre le
// vrai serveur (SHH_COMPTES=1, origine http://localhost:<port>) et pose les variables
// ci-dessous ; sans elles, le test est sauté.
//
//	SHH_COMPTE_URL      http://127.0.0.1:port du serveur Go (sans proxy)
//	SHH_COMPTE_ORIGINE  SHH_ORIGIN du serveur (origine WebAuthn, http://localhost:port)
//	SHH_COMPTE_ETAPE    inscrire | connecter
//	SHH_COMPTE_ETAT     fichier JSON où l'étape « inscrire » range ce qu'il faut pour se reconnecter
//
// Le serveur n'ouvre ni les enveloppes ni les coffres : ils sont aléatoires, à la forme exacte.

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"
)

// Repère cherché par test-restauration.sh dans le fichier de sauvegarde et dans la base
// restaurée (absent : seule son empreinte à clé est gardée).
const comptePseudo = "repererestauratlon" // forme canonique : « i » devient « l »

type etatCompte struct {
	H          string `json:"h"`
	HHex       string `json:"h_hex"` // les 16 octets de h, cherchés par le script dans les fichiers
	CredID     string `json:"cred_id"`
	Cle        string `json:"cle"` // clé privée ES256 de la passkey de test (PKCS #8), hors du serveur
	Env        string `json:"env"`
	AR         string `json:"a_r"`
	ProfilHash string `json:"blob_profil_sha256"`
}

func appel(t *testing.T, url, chemin string, corps, sortie any) int {
	t.Helper()
	var r io.Reader
	if corps != nil {
		j, _ := json.Marshal(corps)
		r = bytes.NewReader(j)
	}
	meth := http.MethodGet
	if corps != nil {
		meth = http.MethodPost
	}
	req, err := http.NewRequest(meth, url+chemin, r)
	if err != nil {
		t.Fatal(err)
	}
	if corps != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s : %v", chemin, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if sortie != nil && resp.StatusCode/100 == 2 {
		if err := json.Unmarshal(data, sortie); err != nil {
			t.Fatalf("%s : %v", chemin, err)
		}
	}
	if resp.StatusCode/100 != 2 {
		t.Logf("%s : %d %s", chemin, resp.StatusCode, data)
	}
	return resp.StatusCode
}

// preuveAltcha : défi de /api/captcha résolu par force brute, rendu après les 3 s d'attente
// exigées par le serveur (même méthode que salonws_test.go).
func preuveAltcha(t *testing.T, url string) (preuve, shownAt string) {
	var d struct {
		Algorithm string `json:"algorithm"`
		Challenge string `json:"challenge"`
		MaxNumber int64  `json:"maxNumber"`
		Salt      string `json:"salt"`
		Signature string `json:"signature"`
		ShownAt   string `json:"shown_at"`
	}
	if appel(t, url, "/api/captcha", nil, &d) != http.StatusOK {
		t.Fatal("défi ALTCHA")
	}
	recu := time.Now()
	n := int64(-1)
	for i := int64(0); i <= d.MaxNumber; i++ {
		h := sha256.Sum256([]byte(d.Salt + strconv.FormatInt(i, 10)))
		if hex.EncodeToString(h[:]) == d.Challenge {
			n = i
			break
		}
	}
	if n < 0 {
		t.Fatal("défi ALTCHA sans solution")
	}
	p, _ := json.Marshal(map[string]any{"algorithm": d.Algorithm, "challenge": d.Challenge, "number": n,
		"salt": d.Salt, "signature": d.Signature})
	time.Sleep(time.Until(recu.Add(3100 * time.Millisecond)))
	return base64.StdEncoding.EncodeToString(p), d.ShownAt
}

func coffre(magic string) string {
	b := make([]byte, 9+8, 4096+45)
	copy(b, magic)
	binary.BigEndian.PutUint64(b[9:17], 1)
	return b64u.EncodeToString(append(b, alea(12+4096+16)...))
}

// CBOR minimal (en-tête, entiers, octets, texte) : de quoi écrire la clé COSE et l'objet
// d'attestation « none » d'une passkey ES256 (bibliothèque standard seulement).
func cborTete(maj byte, n int) []byte {
	switch {
	case n < 24:
		return []byte{maj<<5 | byte(n)}
	case n < 256:
		return []byte{maj<<5 | 24, byte(n)}
	default:
		return []byte{maj<<5 | 25, byte(n >> 8), byte(n)}
	}
}
func cborInt(v int) []byte {
	if v >= 0 {
		return cborTete(0, v)
	}
	return cborTete(1, -1-v)
}
func cborOctets(b []byte) []byte { return append(cborTete(2, len(b)), b...) }
func cborTexte(s string) []byte  { return append(cborTete(3, len(s)), s...) }

// options : ce que le test lit des options WebAuthn rendues par le serveur.
type options struct {
	Challenge string `json:"challenge"`
	RPID      string `json:"rpId"`
	RP        struct {
		ID string `json:"id"`
	} `json:"rp"`
	User struct {
		ID string `json:"id"`
	} `json:"user"`
}

func clientData(typ, challenge, origine string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": challenge, "origin": origine, "crossOrigin": false})
	return b
}

func TestCompteRestauration(t *testing.T) {
	url, etape, fichier := os.Getenv("SHH_COMPTE_URL"), os.Getenv("SHH_COMPTE_ETAPE"), os.Getenv("SHH_COMPTE_ETAT")
	origine := os.Getenv("SHH_COMPTE_ORIGINE")
	if url == "" || etape == "" || fichier == "" || origine == "" {
		t.Skip("hors de deploy/test-restauration.sh (SHH_COMPTE_URL, SHH_COMPTE_ETAPE, SHH_COMPTE_ETAT, SHH_COMPTE_ORIGINE)")
	}
	switch etape {
	case "inscrire":
		inscrire(t, url, origine, fichier)
	case "connecter":
		connecter(t, url, origine, fichier)
	default:
		t.Fatalf("SHH_COMPTE_ETAPE %q", etape)
	}
}

func inscrire(t *testing.T, url, origine, fichier string) {
	preuve, shownAt := preuveAltcha(t, url)
	var d struct {
		Etape   string  `json:"etape"`
		Options options `json:"options"`
	}
	if st := appel(t, url, "/api/compte/inscription/debut", map[string]string{"altcha": preuve, "hp": "", "shown_at": shownAt}, &d); st != http.StatusOK {
		t.Fatalf("inscription/debut : %d", st)
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := k.PublicKey.ECDH()
	if err != nil {
		t.Fatal(err)
	}
	xy := pub.Bytes()[1:]
	cose := append([]byte{0xa5}, cborInt(1)...)
	cose = append(cose, cborInt(2)...)
	for _, kv := range [][2][]byte{{cborInt(3), cborInt(-7)}, {cborInt(-1), cborInt(1)}, {cborInt(-2), cborOctets(xy[:32])}, {cborInt(-3), cborOctets(xy[32:])}} {
		cose = append(append(cose, kv[0]...), kv[1]...)
	}
	cred := alea(32)
	rh := sha256.Sum256([]byte(d.Options.RP.ID))
	ad := append(rh[:], 0x01|0x04|0x08|0x10|0x40, 0, 0, 0, 0)
	ad = append(ad, alea(16)...) // AAGUID
	ad = append(ad, byte(len(cred)>>8), byte(len(cred)))
	ad = append(append(ad, cred...), cose...)
	att := append([]byte{0xa3}, cborTexte("fmt")...)
	att = append(att, cborTexte("none")...)
	att = append(att, cborTexte("attStmt")...)
	att = append(att, 0xa0)
	att = append(att, cborTexte("authData")...)
	att = append(att, cborOctets(ad)...)
	reponse := map[string]any{"id": b64u.EncodeToString(cred), "rawId": b64u.EncodeToString(cred), "type": "public-key",
		"response": map[string]any{"clientDataJSON": b64u.EncodeToString(clientData("webauthn.create", d.Options.Challenge, origine)),
			"attestationObject": b64u.EncodeToString(att)},
		"clientExtensionResults": map[string]any{"credProps": map[string]any{"rk": true}}}
	aR := alea(32)
	vr := sha256.Sum256(aR)
	env := b64u.EncodeToString(alea(60))
	profil := coffre("SHH-PROF1")
	var f struct {
		Session string `json:"session"`
		H       string `json:"h"`
	}
	if st := appel(t, url, "/api/compte/inscription/fin", map[string]any{"etape": d.Etape, "credential": reponse,
		"p_canon": comptePseudo, "env": env, "v_r": b64u.EncodeToString(vr[:]), "env_r": b64u.EncodeToString(alea(60)),
		"blob_profil": profil, "blob_prive": coffre("SHH-ACCT1"), "persistante": false, "etiquette": "",
		"cred_etiquette": ""}, &f); st != http.StatusCreated {
		t.Fatalf("inscription/fin : %d", st)
	}
	hb, err := b64u.DecodeString(f.H)
	if err != nil || len(hb) != 16 || f.H != d.Options.User.ID || len(f.Session) != 43 {
		t.Fatalf("h de %d octets, session de %d caractères", len(hb), len(f.Session))
	}
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	raw, _ := b64u.DecodeString(profil)
	s := sha256.Sum256(raw)
	e := etatCompte{H: f.H, HHex: hex.EncodeToString(hb), CredID: b64u.EncodeToString(cred), Cle: b64u.EncodeToString(der),
		Env: env, AR: b64u.EncodeToString(aR), ProfilHash: hex.EncodeToString(s[:])}
	j, _ := json.Marshal(e)
	if err := os.WriteFile(fichier, j, 0o600); err != nil {
		t.Fatal(err)
	}
}

// connecter : connexion par la passkey de test (signature ES256), puis récupération par A_r :
// mêmes h, enveloppe et coffre de profil qu'à l'inscription.
func connecter(t *testing.T, url, origine, fichier string) {
	j, err := os.ReadFile(fichier)
	if err != nil {
		t.Fatal(err)
	}
	var e etatCompte
	if err := json.Unmarshal(j, &e); err != nil {
		t.Fatal(err)
	}
	der, _ := b64u.DecodeString(e.Cle)
	cle, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Etape   string  `json:"etape"`
		Options options `json:"options"`
	}
	if st := appel(t, url, "/api/compte/connexion/debut", map[string]any{}, &d); st != http.StatusOK {
		t.Fatalf("connexion/debut : %d", st)
	}
	rh := sha256.Sum256([]byte(d.Options.RPID))
	ad := append(rh[:], 0x01|0x04|0x08|0x10, 0, 0, 0, 1)
	cd := clientData("webauthn.get", d.Options.Challenge, origine)
	hcd := sha256.Sum256(cd)
	dig := sha256.Sum256(append(append([]byte{}, ad...), hcd[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, cle.(*ecdsa.PrivateKey), dig[:])
	if err != nil {
		t.Fatal(err)
	}
	reponse := map[string]any{"id": e.CredID, "rawId": e.CredID, "type": "public-key",
		"response": map[string]any{"clientDataJSON": b64u.EncodeToString(cd), "authenticatorData": b64u.EncodeToString(ad),
			"signature": b64u.EncodeToString(sig), "userHandle": e.H}, "clientExtensionResults": map[string]any{}}
	var o struct {
		Session    string   `json:"session"`
		H          string   `json:"h"`
		CredID     string   `json:"cred_id"`
		Enveloppes []string `json:"enveloppes"`
		BlobProfil string   `json:"blob_profil"`
		GenProfil  uint64   `json:"gen_profil"`
	}
	if st := appel(t, url, "/api/compte/connexion/fin", map[string]any{"etape": d.Etape, "credential": reponse,
		"persistante": false, "etiquette": ""}, &o); st != http.StatusOK || len(o.Session) != 43 {
		t.Fatalf("connexion/fin : %d, session de %d caractères", st, len(o.Session))
	}
	raw, _ := b64u.DecodeString(o.BlobProfil)
	s := sha256.Sum256(raw)
	if o.H != e.H || o.CredID != e.CredID || len(o.Enveloppes) != 1 || o.Enveloppes[0] != e.Env ||
		hex.EncodeToString(s[:]) != e.ProfilHash || o.GenProfil != 1 {
		t.Fatal("compte restauré différent du compte créé (h, passkey, enveloppe ou coffre de profil)")
	}
	var r struct {
		H string `json:"h"`
	}
	if st := appel(t, url, "/api/compte/recup", map[string]any{"a_r": e.AR, "persistante": false, "etiquette": ""}, &r); st != http.StatusOK || r.H != e.H {
		t.Fatalf("recup : %d", st)
	}
}

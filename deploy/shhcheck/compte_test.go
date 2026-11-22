package main

// Compte de test pour deploy/test-restauration.sh (plan du compte, lot 8) : une inscription
// complète puis, après sauvegarde, effacement et restauration de comptes.db, une connexion du
// même compte. Lancé par le script, qui démarre le vrai serveur (SHH_COMPTES=1, SMTP en clair
// vers la boucle locale) et pose les variables ci-dessous ; sans elles, le test est sauté.
//
//	SHH_COMPTE_URL    http://127.0.0.1:port du serveur Go (sans proxy)
//	SHH_COMPTE_ETAPE  inscrire | connecter | refuser (connexion qui doit échouer : autre clé)
//	SHH_COMPTE_ETAT   fichier JSON où l'étape « inscrire » range ce qu'il faut pour se reconnecter
//	SHH_COMPTE_SMTP   adresse d'écoute du faux SMTP (étape « inscrire » : le code y arrive)
//
// Le serveur ne vérifie pas A_auth (sortie d'Argon2id sur l'appareil) : 32 octets aléatoires
// suffisent ; les coffres sont aléatoires, à la forme exacte (en-tête, gen, palier de 4 Kio).

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Repères cherchés par test-restauration.sh dans le fichier de sauvegarde (absents) et dans
// la base restaurée (adresse : jamais, ni en clair ni normalisée ; seules ses empreintes).
const (
	compteEmail  = "Restauration.Repere+essai@exemple-shhdrop.org"
	comptePseudo = "repererestauratlon" // forme canonique : « i » devient « l »
)

type etatCompte struct {
	Email      string `json:"email"`
	AAuth      string `json:"a_auth"`
	H          string `json:"h"`
	HHex       string `json:"h_hex"` // les 16 octets de h, cherchés par le script dans les fichiers
	EnvMdp     string `json:"env_mdp"`
	SProfil    string `json:"s_profil"`
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

// fauxSMTPCode : faux serveur SMTP en clair (le serveur Go ne l'accepte que vers la boucle
// locale) ; rend le code à 6 chiffres du premier message reçu.
func fauxSMTPCode(t *testing.T, ecoute string) chan string {
	ln, err := net.Listen("tcp", ecoute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	codes := make(chan string, 1)
	re := regexp.MustCompile(`code : ([0-9]{3}) ([0-9]{3})`)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(30 * time.Second))
		r := bufio.NewReader(c)
		dire := func(s string) { c.Write([]byte(s + "\r\n")) }
		dire("220 faux.test ESMTP")
		for {
			l, err := r.ReadString('\n')
			if err != nil {
				return
			}
			switch cmd := strings.ToUpper(strings.TrimSpace(l)); {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				dire("250-faux.test")
				dire("250 AUTH PLAIN")
			case strings.HasPrefix(cmd, "AUTH"):
				dire("235 ok")
			case strings.HasPrefix(cmd, "MAIL"), strings.HasPrefix(cmd, "RCPT"), strings.HasPrefix(cmd, "RSET"):
				dire("250 ok")
			case cmd == "DATA":
				dire("354 suite")
				var corps strings.Builder
				for {
					l, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if l == ".\r\n" {
						break
					}
					corps.WriteString(l)
				}
				dire("250 ok")
				if m := re.FindStringSubmatch(corps.String()); m != nil {
					codes <- m[1] + m[2]
				}
			case cmd == "QUIT":
				dire("221 fin")
				return
			default:
				dire("502 inconnu")
			}
		}
	}()
	return codes
}

func coffre(magic string) string {
	b := make([]byte, 9+8, 4096+45)
	copy(b, magic)
	binary.BigEndian.PutUint64(b[9:17], 1)
	return b64u.EncodeToString(append(b, alea(12+4096+16)...))
}

func TestCompteRestauration(t *testing.T) {
	url, etape, fichier := os.Getenv("SHH_COMPTE_URL"), os.Getenv("SHH_COMPTE_ETAPE"), os.Getenv("SHH_COMPTE_ETAT")
	if url == "" || etape == "" || fichier == "" {
		t.Skip("hors de deploy/test-restauration.sh (SHH_COMPTE_URL, SHH_COMPTE_ETAPE, SHH_COMPTE_ETAT)")
	}
	switch etape {
	case "inscrire":
		inscrire(t, url, fichier)
	case "connecter", "refuser":
		connecter(t, url, fichier, etape == "connecter")
	default:
		t.Fatalf("SHH_COMPTE_ETAPE %q", etape)
	}
}

func inscrire(t *testing.T, url, fichier string) {
	codes := fauxSMTPCode(t, os.Getenv("SHH_COMPTE_SMTP"))
	preuve, shownAt := preuveAltcha(t, url)
	var d struct {
		H     string `json:"h"`
		Etape string `json:"etape"`
	}
	if st := appel(t, url, "/api/compte/inscription/debut", map[string]string{"email": compteEmail, "langue": "fr",
		"altcha": preuve, "hp": "", "shown_at": shownAt}, &d); st != http.StatusOK {
		t.Fatalf("inscription/debut : %d", st)
	}
	var code string
	select {
	case code = <-codes:
	case <-time.After(30 * time.Second):
		t.Fatal("aucun e-mail reçu par le faux SMTP")
	}
	e := etatCompte{Email: compteEmail, AAuth: b64u.EncodeToString(alea(32)), H: d.H,
		EnvMdp: b64u.EncodeToString(alea(60)), SProfil: b64u.EncodeToString(alea(32))}
	profil := coffre("SHH-PROF1")
	var f struct {
		Session string `json:"session"`
	}
	if st := appel(t, url, "/api/compte/inscription/fin", map[string]any{"etape": d.Etape, "code": code,
		"a_auth": e.AAuth, "env_mdp": e.EnvMdp, "s_profil": e.SProfil, "p_canon": comptePseudo,
		"blob_profil": profil, "blob_prive": coffre("SHH-ACCT1"), "persistante": false, "etiquette": ""}, &f); st != http.StatusCreated {
		t.Fatalf("inscription/fin : %d", st)
	}
	if len(f.Session) != 43 {
		t.Fatalf("session de %d caractères", len(f.Session))
	}
	hb, err := b64u.DecodeString(d.H)
	if err != nil || len(hb) != 16 {
		t.Fatalf("h de %d octets", len(hb))
	}
	e.HHex = hex.EncodeToString(hb)
	raw, _ := b64u.DecodeString(profil)
	s := sha256.Sum256(raw)
	e.ProfilHash = hex.EncodeToString(s[:])
	j, _ := json.Marshal(e)
	if err := os.WriteFile(fichier, j, 0o600); err != nil {
		t.Fatal(err)
	}
}

func connecter(t *testing.T, url, fichier string, attendu bool) {
	j, err := os.ReadFile(fichier)
	if err != nil {
		t.Fatal(err)
	}
	var e etatCompte
	if err := json.Unmarshal(j, &e); err != nil {
		t.Fatal(err)
	}
	var o struct {
		Session    string `json:"session"`
		H          string `json:"h"`
		EnvMdp     string `json:"env_mdp"`
		SProfil    string `json:"s_profil"`
		BlobProfil string `json:"blob_profil"`
		GenProfil  uint64 `json:"gen_profil"`
	}
	st := appel(t, url, "/api/compte/connexion", map[string]any{"email": e.Email, "a_auth": e.AAuth,
		"persistante": false, "etiquette": ""}, &o)
	if !attendu {
		if st != http.StatusForbidden {
			t.Fatalf("connexion : %d, 403 attendu (clé du serveur différente)", st)
		}
		return
	}
	if st != http.StatusOK || len(o.Session) != 43 {
		t.Fatalf("connexion : %d, session de %d caractères", st, len(o.Session))
	}
	raw, _ := b64u.DecodeString(o.BlobProfil)
	s := sha256.Sum256(raw)
	if o.H != e.H || o.EnvMdp != e.EnvMdp || o.SProfil != e.SProfil || hex.EncodeToString(s[:]) != e.ProfilHash || o.GenProfil != 1 {
		t.Fatal("compte restauré différent du compte créé (h, enveloppe, séquestre ou coffre de profil)")
	}
}

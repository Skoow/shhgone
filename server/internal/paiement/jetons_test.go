package paiement

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

// TestJetonsVecteursCommuns : engine/vectors/privacypass.json (produit par le moteur Rust,
// blind-rsa-signatures) rejoué avec circl : même SPKI, même signature aveugle (déterministe),
// jeton accepté.
func TestJetonsVecteursCommuns(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "engine", "vectors", "privacypass.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]string
	json.Unmarshal(b, &v)
	h := func(k string) []byte {
		x, err := hex.DecodeString(v[k])
		if err != nil || len(x) == 0 {
			t.Fatal(k, err)
		}
		return x
	}
	k, err := x509.ParsePKCS8PrivateKey(h("sk_pkcs8_hex"))
	if err != nil {
		t.Fatal(err)
	}
	sk := k.(*rsa.PrivateKey)
	spki, err := SPKI(&sk.PublicKey)
	if err != nil || !bytes.Equal(spki, h("spki_hex")) {
		t.Fatalf("SPKI différente de celle du moteur : %x", spki)
	}
	if kid := sha256.Sum256(spki); !bytes.Equal(kid[:], h("token_key_id_hex")) {
		t.Fatal("token_key_id")
	}
	if !bytes.Equal(Defi(v["issuer_name"]), h("challenge_hex")) {
		t.Fatal("défi")
	}
	req := h("token_request_hex")
	sig, err := blindrsa.NewSigner(sk).BlindSign(req[3:])
	if err != nil || !bytes.Equal(sig, h("token_response_hex")) {
		t.Fatal("signature aveugle différente du moteur", err)
	}
	tok := h("token_hex")
	ver, _ := blindrsa.NewVerifier(blindrsa.SHA384PSSDeterministic, &sk.PublicKey)
	if err := ver.Verify(tok[:98], tok[98:]); err != nil {
		t.Fatal("jeton du moteur refusé :", err)
	}
	d := sha256.Sum256(h("challenge_hex"))
	if !bytes.Equal(tok[34:66], d[:]) || !bytes.Equal(tok[66:98], h("token_key_id_hex")) || binary.BigEndian.Uint16(tok) != TypeJeton {
		t.Fatal("forme du jeton")
	}
}

// client : côté appareil, avec circl (le moteur fait la même chose, vecteurs ci-dessus).
func client(t testing.TB, spki []byte, emetteur string) (req []byte, finir func(sig []byte) []byte) {
	t.Helper()
	k, err := x509.ParsePKCS1PublicKey(spki[len(spkiPrefixe):])
	if err != nil {
		t.Fatal(err)
	}
	c, _ := blindrsa.NewClient(blindrsa.SHA384PSSDeterministic, k)
	nonce := make([]byte, 32)
	rand.Read(nonce)
	kid := sha256.Sum256(spki)
	dd := sha256.Sum256(Defi(emetteur))
	msg := append(append(append([]byte{0, 2}, nonce...), dd[:]...), kid[:]...)
	blinded, st, err := c.Blind(rand.Reader, msg)
	if err != nil {
		t.Fatal(err)
	}
	req = append([]byte{0, 2, kid[31]}, blinded...)
	return req, func(sig []byte) []byte {
		s, err := c.Finalize(st, sig)
		if err != nil {
			t.Fatal(err)
		}
		return append(msg, s...)
	}
}

func bancJetons(t testing.TB) (*banc, *Jetons) {
	b := nouveauBanc(t)
	var err error
	b.s, err = NewService(Config{DB: b.db, Now: func() time.Time { return b.now }, Origine: "https://shhgone.test", Regime: OSS,
		Prestataires: []Prestataire{b.f}, Emetteur: "shhgone.test"})
	if err != nil {
		t.Fatal(err)
	}
	return b, b.s.Jetons()
}

// autreCle : une clé Pro publiée dont le dernier octet de token_key_id diffère de celui de
// spki (seul octet porté par une demande d'émission).
func autreCle(t *testing.T, j *Jetons, spki []byte) []byte {
	t.Helper()
	cles, err := j.Cles()
	if err != nil {
		t.Fatal(err)
	}
	kid := sha256.Sum256(spki)
	for _, c := range cles {
		if k := sha256.Sum256(c.SPKI); c.Offre == Pro && k[31] != kid[31] {
			return c.SPKI
		}
	}
	t.Fatal("aucune clé Pro d'un autre octet de token_key_id")
	return nil
}

func clePour(t testing.TB, j *Jetons, o Offre, decalage int64) []byte {
	cles, err := j.Cles()
	if err != nil || len(cles) != 2*(JoursAvance+1) {
		t.Fatal(err, len(cles))
	}
	auj := jourDe(j.now())
	for _, c := range cles {
		if c.Offre == o && c.Jour == auj+decalage*jourS {
			return c.SPKI
		}
	}
	t.Fatal("clé absente")
	return nil
}

// TestJetonsClesAvance : clés d'aujourd'hui à J+JoursAvance, une par formule et par jour,
// toutes différentes, servies dans l'ordre (jour, Plus, Pro) ; la clé d'un jour ne change pas
// d'un appel à l'autre, ni le lendemain (J+1 d'hier = J d'aujourd'hui), ni après redémarrage
// (base, cache vide) ; l'acceptation reste le jour de la clé et le lendemain.
func TestJetonsClesAvance(t *testing.T) {
	b, j := bancJetons(t)
	cles, err := j.Cles()
	if err != nil || len(cles) != 2*(JoursAvance+1) {
		t.Fatal(err, len(cles))
	}
	auj := jourDe(b.now)
	vues := map[string]bool{}
	parJour := map[[2]int64][]byte{}
	for i, c := range cles {
		if c.Jour != auj+int64(i/2)*jourS || c.Offre != []Offre{Plus, Pro}[i%2] {
			t.Fatal("ordre", i, c.Jour, c.Offre)
		}
		if vues[string(c.SPKI)] {
			t.Fatal("clé en double", i)
		}
		vues[string(c.SPKI)] = true
		parJour[[2]int64{c.Jour, int64(c.Offre)}] = c.SPKI
	}
	memes := func(l []CleDuJour) {
		t.Helper()
		for _, c := range l {
			if old, ok := parJour[[2]int64{c.Jour, int64(c.Offre)}]; ok && !bytes.Equal(old, c.SPKI) {
				t.Fatal("clé changée", c.Jour, c.Offre)
			}
		}
	}
	again, _ := j.Cles()
	memes(again)
	// Redémarrage : même base, nouvel objet (cache vide).
	j2 := NouveauxJetons(b.db, func() time.Time { return b.now }, "shhgone.test")
	l2, err := j2.Cles()
	if err != nil {
		t.Fatal(err)
	}
	memes(l2)
	// Lendemain : J..J+6 d'hier inchangées, une nouvelle clé J+7 par formule ; purge sans effet sur elles.
	b.now = b.now.Add(24 * time.Hour)
	if err := j.Purger(); err != nil {
		t.Fatal(err)
	}
	l3, err := j.Cles()
	if err != nil || len(l3) != 2*(JoursAvance+1) || l3[0].Jour != auj+jourS {
		t.Fatal(err, len(l3))
	}
	memes(l3)
	for _, c := range l3[len(l3)-2:] {
		if vues[string(c.SPKI)] {
			t.Fatal("J+7 nouvelle attendue")
		}
	}
}

func TestJetonsEmissionDepense(t *testing.T) {
	b, j := bancJetons(t)
	c := b.commander(t, passN(1), Formule{Plus, JoursMois, true, Carte})
	b.webhook(t, confirme(c, "pi_1", 700))
	spki := clePour(t, j, Plus, 0)
	if !bytes.Equal(spki, clePour(t, j, Plus, 0)) {
		t.Fatal("clé du jour pas stable")
	}
	if bytes.Equal(spki, clePour(t, j, Pro, 0)) || bytes.Equal(spki, clePour(t, j, Plus, 1)) {
		t.Fatal("une clé par formule et par jour")
	}
	var reqs [][]byte
	var fins []func([]byte) []byte
	for i := 0; i < 3; i++ {
		r, f := client(t, spki, "shhgone.test")
		reqs, fins = append(reqs, r), append(fins, f)
	}
	sigs, offre, err := j.Emettre(b.s, passN(1), reqs)
	if err != nil || offre != Plus || len(sigs) != 3 {
		t.Fatal(err, offre)
	}
	tok := fins[0](sigs[0])
	if o, err := j.Depenser(tok); err != nil || o != Plus {
		t.Fatal("dépense", o, err)
	}
	if _, err := j.Depenser(tok); err != ErrJeton {
		t.Fatal("jeton dépensé deux fois", err)
	}
	j.Rendre(tok)
	if _, err := j.Depenser(tok); err != nil {
		t.Fatal("jeton rendu refusé", err)
	}
	// Le lendemain : encore valable ; le surlendemain : refusé (clé effacée).
	tok2 := fins[1](sigs[1])
	b.now = b.now.Add(24 * time.Hour)
	if _, err := j.Depenser(tok2); err != nil {
		t.Fatal("jeton de la veille refusé", err)
	}
	tok3 := fins[2](sigs[2])
	b.now = b.now.Add(24 * time.Hour)
	j.Purger()
	if _, err := j.Depenser(tok3); err != ErrJeton {
		t.Fatal("jeton d'avant-hier accepté", err)
	}
	var n int
	b.db.QueryRow(`SELECT count(*) FROM cles_jetons WHERE jour < ?`, jourDe(b.now)-jourS).Scan(&n)
	if n != 0 {
		t.Fatal("anciennes clés gardées")
	}
}

func TestJetonsRefus(t *testing.T) {
	b, j := bancJetons(t)
	c := b.commander(t, passN(1), Formule{Plus, JoursMois, true, Carte})
	b.webhook(t, confirme(c, "pi_1", 700))
	spki := clePour(t, j, Plus, 0)
	r, fin := client(t, spki, "shhgone.test")
	// Lot vide ou trop grand, demande d'une autre clé, d'un autre type : refus, rien de décompté.
	// « Autre clé » : la demande ne porte que le dernier octet de token_key_id (RFC 9578 §6.1) ;
	// une clé Pro tirée au hasard partage cet octet avec la clé Plus du jour une fois sur 256, et
	// le test échouait alors (1 fois sur 512 environ). La clé Pro prise est donc une des clés
	// publiées dont cet octet diffère.
	pro, _ := client(t, autreCle(t, j, spki), "shhgone.test")
	mauvais := bytes.Clone(r)
	mauvais[1] = 3
	for _, lot := range [][][]byte{nil, {r, r, r, r, r, r}, {pro}, {mauvais}, {r[:100]}} {
		if _, _, err := j.Emettre(b.s, passN(1), lot); err != ErrJeton {
			t.Errorf("lot de %d accepté : %v", len(lot), err)
		}
	}
	if _, _, err := j.Emettre(b.s, passN(9), [][]byte{r}); err != ErrPasDeJetons {
		t.Fatal("pass inconnu", err)
	}
	// Réserve du jour : 10 pour Plus.
	total := 0
	for i := 0; i < 3; i++ {
		lot := [][]byte{r, r, r, r}
		if _, _, err := j.Emettre(b.s, passN(1), lot); err == nil {
			total += 4
		}
	}
	if total != 8 {
		t.Fatal("émissions du jour", total)
	}
	if _, _, err := j.Emettre(b.s, passN(1), [][]byte{r, r, r}); err != ErrPasDeJetons {
		t.Fatal("11e jeton du jour", err)
	}
	if _, _, err := j.Emettre(b.s, passN(1), [][]byte{r, r}); err != nil {
		t.Fatal("10e jeton du jour", err)
	}
	// Jeton forgé, autre émetteur, signature altérée : refus.
	sigs, _, err := func() ([][]byte, Offre, error) {
		b.now = b.now.Add(24 * time.Hour)
		r2, f2 := client(t, clePour(t, j, Plus, 0), "shhgone.test")
		fin = f2
		return j.Emettre(b.s, passN(1), [][]byte{r2})
	}()
	if err != nil {
		t.Fatal(err)
	}
	tok := fin(sigs[0])
	for i := range []int{0, 1, 2} {
		bad := bytes.Clone(tok)
		bad[[]int{5, 40, 300}[i]] ^= 1
		if _, err := j.Depenser(bad); err != ErrJeton {
			t.Error("jeton altéré accepté")
		}
	}
	if _, err := j.Depenser(tok[:100]); err != ErrJeton {
		t.Error("jeton court")
	}
	// Révocation : plus aucune émission.
	b.webhook(t, Evenement{Sorte: Revoque, Commande: c, AvecCommande: true})
	r3, _ := client(t, clePour(t, j, Plus, 0), "shhgone.test")
	if _, _, err := j.Emettre(b.s, passN(1), [][]byte{r3}); err != ErrPasDeJetons {
		t.Fatal("émission après révocation", err)
	}
	_ = context.Background()
}

package api

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// Compteur de signatures WebAuthn (audit du 25 novembre) : gardé à chaque connexion ; une
// assertion dont le compteur recule (ou stagne) alors que la passkey en tient un est refusée
// comme une signature fausse (clone possible). Une passkey synchronisée, dont le compteur vaut
// toujours 0, n'est jamais refusée pour cela.
func TestCompteurSignatures(t *testing.T) {
	e := newEnvCompte(t)
	in := e.inscrire(t, "203.0.113.80:1", "lea")
	gardé := func() int64 {
		t.Helper()
		var n int64
		if err := e.cdb.QueryRow(`SELECT sign_count FROM passkeys WHERE cred_id=?`, in.pk.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	e.connecter(t, "203.0.113.81:1", in)
	e.connecter(t, "203.0.113.81:1", in)
	if n := gardé(); n != int64(in.pk.Compteur) || n == 0 {
		t.Fatalf("compteur gardé %d, celui de l'authentificateur %d", n, in.pk.Compteur)
	}
	// Recul (copie de la passkey avec un ancien compteur) et compteur égal : refusés, rien changé.
	avant := gardé()
	for _, c := range []uint32{0, uint32(avant) - 1} {
		in.pk.Compteur = c // la signature suivante porte c + 1 ≤ compteur gardé
		if w := e.connexionBrute(t, "203.0.113.82:1", in); w.code != 403 || strings.TrimSpace(w.body) != `{"error":"identifiants"}` {
			t.Fatalf("compteur %d (gardé %d) : %d %s", c+1, avant, w.code, w.body)
		}
		if gardé() != avant {
			t.Fatal("compteur gardé changé par un refus")
		}
	}
	// Passkey synchronisée : compteur 0 gardé et reçu, à chaque connexion.
	if _, err := e.cdb.Exec(`UPDATE passkeys SET sign_count=0 WHERE cred_id=?`, in.pk.ID); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		in.pk.Compteur = math.MaxUint32 // la signature suivante porte 0
		e.connecter(t, "203.0.113.83:1", in)
		if gardé() != 0 {
			t.Fatal("compteur 0 d'une passkey synchronisée changé")
		}
	}
}

type reponseBrute struct {
	code int
	body string
}

// connexionBrute : connexion/debut puis connexion/fin, réponse rendue sans contrôle.
func (e envCompte) connexionBrute(t *testing.T, remote string, in inscrit) reponseBrute {
	t.Helper()
	w := e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: remote, body: []byte(`{}`)})
	expect(t, w, 200, "")
	var d struct {
		Etape   string          `json:"etape"`
		Options json.RawMessage `json:"options"`
	}
	json.Unmarshal(w.Body.Bytes(), &d)
	cred, err := in.auth.Obtenir(d.Options, origineCompte, in.pk)
	if err != nil {
		t.Fatal(err)
	}
	w = e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: remote, body: mustJSON(e.preuve(t, remote, map[string]any{
		"etape": d.Etape, "credential": json.RawMessage(cred), "persistante": false, "etiquette": ""}))})
	return reponseBrute{w.Code, w.Body.String()}
}

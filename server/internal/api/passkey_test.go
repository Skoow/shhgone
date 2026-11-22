package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/compte/webauthntest"
)

// Lot S4 : inscription et connexion par passkey, récupération par la clé (conception du compte
// par passkey §6.4, §7.2), par HTTP, avec l'authentificateur logiciel.

// Parcours : inscription, connexion par la passkey (réponse exacte), défi rejoué ou échu,
// passkey inconnue ; aucune réponse ne contient de quoi ouvrir un coffre.
func TestInscriptionConnexionHTTP(t *testing.T) {
	e := newEnvCompte(t)
	const ip = "203.0.113.80:1"
	in := e.inscrire(t, ip, "lea")
	c := e.connecter(t, ip, in)
	if cles(c) != "blob_prive,blob_profil,cred_id,enveloppes,gen_prive,gen_profil,h,session" || c["h"] != in.h ||
		c["cred_id"] != enc.EncodeToString(in.pk.ID) || c["gen_prive"] != float64(1) {
		t.Fatal(c)
	}
	if es, ok := c["enveloppes"].([]any); !ok || len(es) != 1 || len(es[0].(string)) != 80 {
		t.Fatal(c)
	}
	// Passkey sans enveloppe PRF : enveloppes [] (jamais null).
	if _, err := e.cdb.Exec(`DELETE FROM enveloppes`); err != nil {
		t.Fatal(err)
	}
	if c := e.connecter(t, ip, in); c["enveloppes"] == nil || len(c["enveloppes"].([]any)) != 0 {
		t.Fatal(c)
	}
	// Défi rejoué : la deuxième fin avec la même étape est refusée (usage unique).
	w := e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: ip, body: []byte(`{}`)})
	d := jsonOf(t, w)
	var opts json.RawMessage
	json.Unmarshal(w.Body.Bytes(), &struct {
		Options *json.RawMessage `json:"options"`
	}{&opts})
	cred, _ := in.auth.Obtenir(opts, origineCompte, in.pk)
	fin := func(etape any, cred []byte) *struct {
		code int
		body string
	} {
		w := e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: ip, body: mustJSON(map[string]any{
			"etape": etape, "credential": json.RawMessage(cred), "persistante": false, "etiquette": ""})})
		return &struct {
			code int
			body string
		}{w.Code, w.Body.String()}
	}
	if r := fin(d["etape"], cred); r.code != 200 {
		t.Fatal(r)
	}
	if r := fin(d["etape"], cred); r.code != 404 || r.body != `{"error":"not_found"}` {
		t.Fatal("défi rejoué :", r)
	}
	// Défi échu (5 min).
	w = e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: ip, body: []byte(`{}`)})
	d = jsonOf(t, w)
	json.Unmarshal(w.Body.Bytes(), &struct {
		Options *json.RawMessage `json:"options"`
	}{&opts})
	cred, _ = in.auth.Obtenir(opts, origineCompte, in.pk)
	e.clk.Add(5*time.Minute + time.Second)
	if r := fin(d["etape"], cred); r.code != 404 {
		t.Fatal("défi échu :", r)
	}
	// Passkey inconnue du serveur : identifiants (le même corps qu'une signature fausse).
	autre := webauthntest.Nouveau(webauthntest.EdDSA)
	w = e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: ip, body: []byte(`{}`)})
	d = jsonOf(t, w)
	json.Unmarshal(w.Body.Bytes(), &struct {
		Options *json.RawMessage `json:"options"`
	}{&opts})
	_, p2, _ := autre.Creer(mustJSON(map[string]any{"rp": map[string]any{"id": "localhost"}, "user": map[string]any{"id": in.h},
		"challenge": enc.EncodeToString(rnd(32))}), origineCompte, "")
	cred, _ = autre.Obtenir(opts, origineCompte, p2)
	if r := fin(d["etape"], cred); r.code != 403 || r.body != `{"error":"identifiants"}` {
		t.Fatal("passkey inconnue :", r)
	}
}

// inscription/fin refusée sans rien créer : enveloppes de mauvaise longueur, v_r en double,
// sortie PRF envoyée, credential qui n'est pas un objet, null ; pseudo réservé par une autre
// inscription (409, étape gardée : même passkey, autre pseudo).
func TestInscriptionFinRefus(t *testing.T) {
	e := newEnvCompte(t)
	const ip = "203.0.113.81:1"
	premier := e.inscrire(t, "203.0.113.90:1", "leo")
	etape, opts := e.debutInscription(t, ip)
	a := webauthntest.Nouveau(webauthntest.RS256)
	cred, _, err := a.Creer(opts, origineCompte, "")
	if err != nil {
		t.Fatal(err)
	}
	fin := func(f func(map[string]any)) (int, string) {
		b := corpsFin(etape, cred, "lea", rnd(32))
		f(b)
		w := e.do(req{method: "POST", path: "/api/compte/inscription/fin", remote: ip, body: mustJSON(b)})
		return w.Code, w.Body.String()
	}
	aR, _ := enc.DecodeString(premier.aR)
	vr := sha256.Sum256(aR)
	for nom, f := range map[string]func(map[string]any){
		"env de 59":          func(b map[string]any) { b["env"] = enc.EncodeToString(rnd(59)) },
		"env_r de 61":        func(b map[string]any) { b["env_r"] = enc.EncodeToString(rnd(61)) },
		"v_r de 31":          func(b map[string]any) { b["v_r"] = enc.EncodeToString(rnd(31)) },
		"cred_etiquette 63":  func(b map[string]any) { b["cred_etiquette"] = enc.EncodeToString(rnd(63)) },
		"credential tableau": func(b map[string]any) { b["credential"] = json.RawMessage(`[1]`) },
		"credential chaîne":  func(b map[string]any) { b["credential"] = "x" },
		"env absent":         func(b map[string]any) { delete(b, "env") },
		"clé inconnue":       func(b map[string]any) { b["x"] = 1 },
		"p_canon vide":       func(b map[string]any) { b["p_canon"] = "" },
		"p_canon hors forme": func(b map[string]any) { b["p_canon"] = "Lea" },
		"coffre hors palier": func(b map[string]any) { b["blob_prive"] = enc.EncodeToString(rnd(100)) },
		"v_r en double":      func(b map[string]any) { b["v_r"] = enc.EncodeToString(vr[:]) },
	} {
		if code, body := fin(f); code != 400 || body != badRequest {
			t.Errorf("%s : %d %s", nom, code, body)
		}
	}
	// null dans le credential (le site ne doit jamais en envoyer) : 400.
	b := corpsFin(etape, []byte(strings.Replace(string(cred), `"authenticatorAttachment":"platform"`, `"authenticatorAttachment":null`, 1)), "lea", rnd(32))
	if w := e.do(req{method: "POST", path: "/api/compte/inscription/fin", remote: ip, body: mustJSON(b)}); w.Code != 400 {
		t.Fatal("null :", w.Code)
	}
	if n := compter(t, e, "comptes"); n != 1 {
		t.Fatal("comptes :", n)
	}
	// Pseudo pris (par le premier compte) : 409, étape gardée ; même passkey, autre pseudo : 201.
	if code, body := fin(func(b map[string]any) { b["p_canon"] = "leo" }); code != 409 || body != `{"error":"pseudo_pris"}` {
		t.Fatal(code, body)
	}
	if code, body := fin(func(map[string]any) {}); code != 201 {
		t.Fatal(code, body)
	}
	if code, _ := fin(func(map[string]any) {}); code != 404 {
		t.Fatal("étape réutilisée après succès :", code)
	}
	// Sortie PRF dans le credential : refus (le serveur ne doit jamais la recevoir).
	etape, opts = e.debutInscription(t, "203.0.113.82:1")
	cred, _, _ = webauthntest.Nouveau(webauthntest.ES256).Creer(opts, origineCompte, "")
	var m map[string]any
	json.Unmarshal(cred, &m)
	m["clientExtensionResults"] = map[string]any{"prf": map[string]any{"enabled": true, "results": map[string]any{"first": enc.EncodeToString(rnd(32))}}}
	b = corpsFin(etape, mustJSON(m), "lia", rnd(32))
	if w := e.do(req{method: "POST", path: "/api/compte/inscription/fin", remote: "203.0.113.82:1", body: mustJSON(b)}); w.Code != 400 {
		t.Fatal("sortie PRF :", w.Code, w.Body.String())
	}
}

func compter(t *testing.T, e envCompte, table string) int {
	t.Helper()
	var n int
	if err := e.cdb.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// pseudo/verifier pendant une inscription : libre → réservé à l'étape ; une autre inscription
// le voit pris (même réponse qu'un pseudo d'un compte) et son inscription/fin aussi.
func TestPseudoReserveAEtape(t *testing.T) {
	e := newEnvCompte(t)
	e1, _ := e.debutInscription(t, "203.0.113.83:1")
	e2, o2 := e.debutInscription(t, "203.0.113.84:1")
	v := func(etape, p string) string {
		return e.do(req{method: "POST", path: "/api/compte/pseudo/verifier", body: mustJSON(map[string]any{"etape": etape, "p_canon": p})}).Body.String()
	}
	if v(e1, "zoe") != `{"libre":true}` || v(e2, "zoe") != `{"libre":false}` || v(e1, "zoe") != `{"libre":true}` {
		t.Fatal("réservation")
	}
	cred, _, _ := webauthntest.Nouveau(webauthntest.ES256).Creer(o2, origineCompte, "")
	w := e.do(req{method: "POST", path: "/api/compte/inscription/fin", remote: "203.0.113.84:1", body: mustJSON(corpsFin(e2, cred, "zoe", rnd(32)))})
	expect(t, w, 409, `{"error":"pseudo_pris"}`)
	// L'étape d'inscription vit 15 min (temps de noter la clé) : encore réservé à 14 min.
	e.clk.Add(14 * time.Minute)
	e4, _ := e.debutInscription(t, "203.0.113.86:1")
	if v(e4, "zoe") != `{"libre":false}` {
		t.Fatal("réservation perdue avant 15 min")
	}
	// Étape échue : la réservation tombe avec elle.
	e.clk.Add(2 * time.Minute)
	e3, _ := e.debutInscription(t, "203.0.113.85:1")
	if v(e3, "zoe") != `{"libre":true}` {
		t.Fatal("réservation d'une étape échue")
	}
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/verifier", body: mustJSON(map[string]any{"etape": e1, "p_canon": "zoe"})}), 404, "")
}

// Limites §7.2 : 3 comptes par jour et par connexion (inscription/debut refusé ensuite) ; plafond
// global SHH_COMPTES_JOUR (busy) ; connexion/debut 60 par minute ; connexion/fin 20 échecs par
// heure par connexion ; inscription/debut 20 par heure.
func TestLimitesPasskeyHTTP(t *testing.T) {
	e := newEnvCompte(t)
	const ip = "203.0.113.86:1"
	for i, p := range []string{"aaa", "bbb", "ccc"} {
		e.inscrire(t, ip, p)
		_ = i
	}
	alt, shown := e.captchaFor(t, ip)
	w := e.do(req{method: "POST", path: "/api/compte/inscription/debut", remote: ip,
		body: mustJSON(map[string]any{"altcha": alt, "hp": "", "shown_at": shown})})
	expect(t, w, 429, "")
	// connexion/debut : 60 par minute.
	for i := 0; i < 60; i++ {
		expect(t, e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: "203.0.113.87:1", body: []byte(`{}`)}), 200, "")
	}
	expect(t, e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: "203.0.113.87:1", body: []byte(`{}`)}), 429, "")
	// connexion/fin : 20 échecs par heure, puis 429 même pour une bonne passkey.
	in := e.inscrire(t, "203.0.113.88:1", "ddd")
	for i := 0; i < 20; i++ {
		w := e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: "203.0.113.89:1", body: []byte(`{}`)})
		d := jsonOf(t, w)
		autre := webauthntest.Nouveau(webauthntest.ES256)
		_, p, _ := autre.Creer(mustJSON(map[string]any{"rp": map[string]any{"id": "localhost"}, "user": map[string]any{"id": in.h},
			"challenge": enc.EncodeToString(rnd(32))}), origineCompte, "")
		var o json.RawMessage
		json.Unmarshal(w.Body.Bytes(), &struct {
			Options *json.RawMessage `json:"options"`
		}{&o})
		cred, _ := autre.Obtenir(o, origineCompte, p)
		expect(t, e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: "203.0.113.89:1", body: mustJSON(map[string]any{
			"etape": d["etape"], "credential": json.RawMessage(cred), "persistante": false, "etiquette": ""})}), 403, `{"error":"identifiants"}`)
	}
	w = e.do(req{method: "POST", path: "/api/compte/connexion/debut", remote: "203.0.113.89:1", body: []byte(`{}`)})
	d := jsonOf(t, w)
	var o json.RawMessage
	json.Unmarshal(w.Body.Bytes(), &struct {
		Options *json.RawMessage `json:"options"`
	}{&o})
	cred, _ := in.auth.Obtenir(o, origineCompte, in.pk)
	expect(t, e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: "203.0.113.89:1", body: mustJSON(map[string]any{
		"etape": d["etape"], "credential": json.RawMessage(cred), "persistante": false, "etiquette": ""})}), 429, "")
}

// Plafond global de comptes créés par jour (SHH_COMPTES_JOUR) : 503 busy, à inscription/debut et
// à inscription/fin ; le lendemain, de nouveau permis.
func TestPlafondJour(t *testing.T) {
	e := newEnvCompte(t)
	s, err := compte.NewService(compte.Config{DB: e.cdb, Cles: e.cles, Ceremonies: ceremoniesTest(t), Limites: e.srv.lim,
		Now: e.clk.Now, Max: 100, Jour: 2})
	if err != nil {
		t.Fatal(err)
	}
	e.h = newHandler(e.srv, htmlStatic(), Salons{Comptes: s})
	etape, opts := e.debutInscription(t, "203.0.113.100:1")
	e.inscrire(t, "203.0.113.101:1", "aaa")
	e.inscrire(t, "203.0.113.102:1", "bbb")
	cred, _, _ := webauthntest.Nouveau(webauthntest.ES256).Creer(opts, origineCompte, "")
	expect(t, e.do(req{method: "POST", path: "/api/compte/inscription/fin", remote: "203.0.113.100:1",
		body: mustJSON(corpsFin(etape, cred, "ccc", rnd(32)))}), 503, "")
	alt, shown := e.captchaFor(t, "203.0.113.103:1")
	expect(t, e.do(req{method: "POST", path: "/api/compte/inscription/debut", remote: "203.0.113.103:1",
		body: mustJSON(map[string]any{"altcha": alt, "hp": "", "shown_at": shown})}), 503, "")
	e.clk.Add(24 * time.Hour)
	e.inscrire(t, "203.0.113.104:1", "ccc")
}

// TestRecupVecteurs : les a_r de engine/vectors/compte-v3.json retrouvent un compte créé avec
// les v_r correspondants (v_r = SHA-256(a_r), index unique, aucune clé du serveur).
func TestRecupVecteurs(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "engine", "vectors", "compte-v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Recup []struct {
			Label string `json:"label"`
			AR    string `json:"a_r"`
			VR    string `json:"v_r"`
		} `json:"recup"`
	}
	if err := json.Unmarshal(b, &v); err != nil || len(v.Recup) == 0 {
		t.Fatal(err)
	}
	e := newEnvCompte(t)
	for i, x := range v.Recup {
		remote := "203.0.113." + string(rune('0'+i%10)) + ":1"
		etape, opts := e.debutInscription(t, "198.51.100.1"+string(rune('0'+i%10))+":1")
		cred, _, _ := webauthntest.Nouveau(webauthntest.ES256).Creer(opts, origineCompte, "")
		ar, _ := hex.DecodeString(x.AR)
		corps := corpsFin(etape, cred, "pseudo"+string(rune('a'+i)), ar)
		vr := sha256.Sum256(ar)
		if hex.EncodeToString(vr[:]) != x.VR {
			t.Fatalf("%s : v_r des vecteurs ≠ SHA-256(a_r)", x.Label)
		}
		w := e.do(req{method: "POST", path: "/api/compte/inscription/fin", remote: "198.51.100.1" + string(rune('0'+i%10)) + ":1", body: mustJSON(corps)})
		expect(t, w, 201, "")
		h := jsonOf(t, w)["h"]
		w = e.do(req{method: "POST", path: "/api/compte/recup", remote: remote,
			body: mustJSON(map[string]any{"a_r": enc.EncodeToString(ar), "persistante": false, "etiquette": ""})})
		if w.Code != 200 || jsonOf(t, w)["h"] != h {
			t.Fatalf("%s : %d %s", x.Label, w.Code, w.Body.String())
		}
	}
}

// TestAucunSequestre : aucune route ne rend de quoi ouvrir un coffre (K_compte, KEK, R, A_r, sortie
// PRF) : les réponses du parcours sont fouillées pour A_r, et rien n'a la forme d'une clé hors des
// enveloppes (60 octets) et des coffres ; A_r n'est pas dans comptes.db ni son WAL.
func TestAucunSequestre(t *testing.T) {
	e := newEnvCompte(t)
	in := e.inscrire(t, "203.0.113.110:1", "lea")
	var tout strings.Builder
	note := func(w interface{ String() string }) { tout.WriteString(w.String()) }
	c := e.connecter(t, "203.0.113.110:1", in)
	tout.WriteString(string(mustJSON(c)))
	w := e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.111:1",
		body: mustJSON(map[string]any{"a_r": in.aR, "persistante": false, "etiquette": ""})})
	note(w.Body)
	for _, p := range []string{"/api/compte", "/api/compte/export", "/api/compte/sessions", "/api/compte/coffre/profil"} {
		note(e.do(req{method: "GET", path: p, hdr: sess(in.session)}).Body)
	}
	sortie := in.pk.Sortie(compte.EntreePRF[:])
	ar, _ := enc.DecodeString(in.aR)
	for nom, x := range map[string][]byte{"A_r": ar, "sortie PRF": sortie[:]} {
		for _, f := range []string{enc.EncodeToString(x), hex.EncodeToString(x)} {
			if strings.Contains(tout.String(), f) {
				t.Errorf("une réponse contient %s", nom)
			}
		}
	}
	for _, f := range []string{filepath.Join(e.dir, "comptes.db"), filepath.Join(e.dir, "comptes.db-wal")} {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), string(ar)) || strings.Contains(string(b), string(sortie[:])) {
			t.Errorf("%s contient A_r ou la sortie PRF", filepath.Base(f))
		}
	}
	// L'AAGUID de l'authentificateur n'est jamais gardé (R9).
	for _, f := range []string{filepath.Join(e.dir, "comptes.db"), filepath.Join(e.dir, "comptes.db-wal")} {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), string(in.auth.AAGUID[:])) {
			t.Errorf("%s contient l'AAGUID", filepath.Base(f))
		}
	}
	_ = rand.Reader
}

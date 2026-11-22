package api

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"go/ast"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/compte/webauthntest"
)

// Routes du compte (conception du compte §8.6, §21.6.2 ; conception du compte par passkey §6.4).

type envCompte struct {
	*env
	cdb  *sql.DB // comptes.db
	cles compte.Cles
	svc  *compte.Service
}

// origineCompte : SHH_ORIGIN des tests du compte (rp.id localhost : les navigateurs refusent une
// adresse IP comme rp.id).
const origineCompte = "http://localhost:8080"

func ceremoniesTest(t *testing.T) *compte.Ceremonies {
	t.Helper()
	wa, err := compte.NouvellesCeremonies(origineCompte, nil)
	if err != nil {
		t.Fatal(err)
	}
	return wa
}

func newEnvCompte(t *testing.T) envCompte {
	t.Helper()
	e := newEnv(t, false, nil)
	db, err := compte.OuvrirBase(filepath.Join(e.dir, "comptes.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	var c compte.Cles
	rand.Read(c.Pseudo[:])
	s, err := compte.NewService(compte.Config{DB: db, Cles: c, Ceremonies: ceremoniesTest(t), Limites: e.srv.lim,
		Now: e.clk.Now, Max: 100})
	if err != nil {
		t.Fatal(err)
	}
	e.h = newHandler(e.srv, htmlStatic(), Salons{Comptes: s})
	return envCompte{e, db, c, s}
}

func coffre(magic string, gen uint64) []byte {
	b := make([]byte, 4096+45)
	rand.Read(b)
	copy(b, magic)
	binary.BigEndian.PutUint64(b[9:], gen)
	return b
}

func coffreB64(magic string, gen uint64) string { return enc.EncodeToString(coffre(magic, gen)) }

// inscrit : un compte de test. aR : A_r de sa clé de récupération (base64url) ; session : jeton
// d'une session récente ; auth, pk : l'authentificateur logiciel et sa passkey.
type inscrit struct {
	h, session, aR string
	auth           *webauthntest.Authentificateur
	pk             *webauthntest.Passkey
}

// debutInscription : preuve ALTCHA puis inscription/debut ; rend l'étape et les options.
func (e envCompte) debutInscription(t *testing.T, remote string) (string, json.RawMessage) {
	t.Helper()
	alt, shown := e.captchaFor(t, remote)
	w := e.do(req{method: "POST", path: "/api/compte/inscription/debut", remote: remote,
		body: mustJSON(map[string]any{"altcha": alt, "hp": "", "shown_at": shown})})
	expect(t, w, 200, "")
	var d struct {
		Etape   string          `json:"etape"`
		Options json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil || len(d.Etape) != 43 || len(d.Options) < 100 {
		t.Fatalf("inscription/debut : %q", w.Body.String())
	}
	return d.Etape, d.Options
}

// corpsFin : corps d'inscription/fin (enveloppes et coffres aléatoires : le serveur ne les
// ouvre jamais) ; aR : A_r tiré pour ce compte.
func corpsFin(etape string, cred []byte, pseudo string, aR []byte) map[string]any {
	vr := sha256.Sum256(aR)
	return map[string]any{"etape": etape, "credential": json.RawMessage(cred), "p_canon": pseudo,
		"env": enc.EncodeToString(rnd(60)), "v_r": enc.EncodeToString(vr[:]), "env_r": enc.EncodeToString(rnd(60)),
		"blob_profil": coffreB64("SHH-PROF1", 1), "blob_prive": coffreB64("SHH-ACCT1", 1), "persistante": false,
		"etiquette": "", "cred_etiquette": enc.EncodeToString(rnd(64))}
}

// inscrire : parcours complet par HTTP (ALTCHA, inscription/debut, pseudo/verifier, passkey de
// l'authentificateur logiciel, inscription/fin), comme le site.
func (e envCompte) inscrire(t *testing.T, remote, pseudo string) inscrit {
	t.Helper()
	etape, opts := e.debutInscription(t, remote)
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/verifier", remote: remote,
		body: mustJSON(map[string]any{"etape": etape, "p_canon": pseudo})}), 200, `{"libre":true}`)
	a := webauthntest.Nouveau(webauthntest.ES256)
	cred, p, err := a.Creer(opts, origineCompte, "")
	if err != nil {
		t.Fatal(err)
	}
	aR := rnd(32)
	w := e.do(req{method: "POST", path: "/api/compte/inscription/fin", remote: remote, body: mustJSON(corpsFin(etape, cred, pseudo, aR))})
	expect(t, w, 201, "")
	d := jsonOf(t, w)
	s, _ := d["session"].(string)
	h, _ := d["h"].(string)
	if len(s) != 43 || len(h) != 22 || len(d) != 2 || h != enc.EncodeToString(p.UserHandle) {
		t.Fatalf("inscription/fin : %q", w.Body.String())
	}
	return inscrit{h: h, session: s, aR: enc.EncodeToString(aR), auth: a, pk: p}
}

// connecter : connexion/debut puis connexion/fin avec la passkey de in ; rend la réponse.
func (e envCompte) connecter(t *testing.T, remote string, in inscrit) map[string]any {
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
	w = e.do(req{method: "POST", path: "/api/compte/connexion/fin", remote: remote, body: mustJSON(map[string]any{
		"etape": d.Etape, "credential": json.RawMessage(cred), "persistante": false, "etiquette": ""})})
	expect(t, w, 200, "")
	return jsonOf(t, w)
}

// recup : POST recup réussi ; rend le jeton de session.
func (e envCompte) recup(t *testing.T, remote string, in inscrit) string {
	t.Helper()
	w := e.do(req{method: "POST", path: "/api/compte/recup", remote: remote,
		body: mustJSON(map[string]any{"a_r": in.aR, "persistante": false, "etiquette": ""})})
	expect(t, w, 200, "")
	d := jsonOf(t, w)
	s, _ := d["session"].(string)
	if len(s) != 43 || d["h"] != in.h {
		t.Fatalf("recup : %q", w.Body.String())
	}
	return s
}

func sess(s string) map[string]string { return map[string]string{"X-Shh-Session": s} }

func cles(m map[string]any) string {
	var k []string
	for x := range m {
		k = append(k, x)
	}
	sort.Strings(k)
	return strings.Join(k, ",")
}

// SHH_COMPTES=0 : aucune route /api/compte/* ; la même 404 qu'une route inconnue.
func TestRoutesCompteAbsentes(t *testing.T) {
	e := newEnv(t, false, nil)
	ref := e.do(req{method: "GET", path: "/api/inconnue"})
	for _, r := range routesCompte {
		w := e.do(req{method: r[0], path: r[1], body: []byte(`{}`), hdr: sess(enc.EncodeToString(rnd(32)))})
		if w.Code != ref.Code || w.Body.String() != ref.Body.String() {
			t.Fatalf("%s %s : %d %q", r[0], r[1], w.Code, w.Body.String())
		}
	}
}

var routesCompte = [][2]string{
	{"POST", "/api/compte/inscription/debut"}, {"POST", "/api/compte/inscription/fin"},
	{"POST", "/api/compte/connexion/debut"}, {"POST", "/api/compte/connexion/fin"}, {"POST", "/api/compte/recup"},
	{"GET", "/api/compte/sessions"}, {"POST", "/api/compte/sessions/fermer"}, {"POST", "/api/compte/deconnexion"},
	{"POST", "/api/compte/sessions/etiquette"},
	{"GET", "/api/compte/coffre/profil"}, {"PUT", "/api/compte/coffre/profil"}, {"GET", "/api/compte/coffre/prive"},
	{"PUT", "/api/compte/coffre/prive"}, {"POST", "/api/compte/pseudo/verifier"}, {"POST", "/api/compte/pseudo"}, {"POST", "/api/compte/pseudo/libre"},
	{"GET", "/api/compte"}, {"GET", "/api/compte/export"}, {"POST", "/api/compte/supprimer"},
	{"GET", "/api/compte/salons"}, {"POST", "/api/compte/salons/detruire"},
}

// routesRetirees : le compte par e-mail (22 novembre) : ces routes n'existent plus, même
// SHH_COMPTES=1 (404 uniforme, comme une route inconnue).
var routesRetirees = [][2]string{
	{"POST", "/api/compte/inscription/renvoyer"}, {"POST", "/api/compte/connexion"}, {"POST", "/api/compte/reauth"},
	{"POST", "/api/compte/connexion/totp"}, {"POST", "/api/compte/oubli/debut"}, {"POST", "/api/compte/oubli/renvoyer"},
	{"POST", "/api/compte/oubli/verifier"}, {"POST", "/api/compte/oubli/fin"}, {"POST", "/api/compte/mdp"},
	{"POST", "/api/compte/email/debut"}, {"POST", "/api/compte/email/renvoyer"}, {"POST", "/api/compte/email/fin"},
	{"POST", "/api/compte/totp/debut"}, {"POST", "/api/compte/totp/fin"}, {"POST", "/api/compte/totp/retirer"},
	{"POST", "/api/compte/totp/annuler-retrait"},
}

func TestRoutesEmailRetirees(t *testing.T) {
	e := newEnvCompte(t)
	ref := e.do(req{method: "GET", path: "/api/inconnue"})
	for _, r := range routesRetirees {
		w := e.do(req{method: r[0], path: r[1], body: []byte(`{}`)})
		if w.Code != ref.Code || w.Body.String() != ref.Body.String() {
			t.Errorf("%s %s : %d %q", r[0], r[1], w.Code, w.Body.String())
		}
	}
}

// Récupération par la clé (A_r) : clé inconnue → identifiants (403), forme fausse → 400 ; juste →
// session récente marquée « par la clé » ; 10 essais par heure et par connexion.
func TestRecupHTTP(t *testing.T) {
	e := newEnvCompte(t)
	in := e.inscrire(t, "203.0.113.60:1", "lea")
	w := e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.61:1",
		body: mustJSON(map[string]any{"a_r": in.aR, "persistante": true, "etiquette": enc.EncodeToString(rnd(64))})})
	expect(t, w, 200, "")
	d := jsonOf(t, w)
	if cles(d) != "blob_prive,blob_profil,env_r,gen_prive,gen_profil,h,session" || len(d["env_r"].(string)) != 80 ||
		strings.Contains(w.Body.String(), in.aR) {
		t.Fatal(w.Body.String())
	}
	w = e.do(req{method: "GET", path: "/api/compte/sessions", hdr: sess(d["session"].(string))})
	if strings.Count(w.Body.String(), `"par_recup":true`) != 1 || strings.Count(w.Body.String(), `"par_recup":false`) != 1 {
		t.Fatal(w.Body.String())
	}
	for _, b := range []string{
		`{"a_r":"` + in.aR[:42] + `","persistante":false,"etiquette":""}`,
		`{"a_r":"` + in.aR + `","persistante":false}`,
		`{"a_r":"` + in.aR + `","persistante":null,"etiquette":""}`,
		`{"a_r":"` + in.aR + `","persistante":false,"etiquette":"","x":1}`,
	} {
		expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.62:1", body: []byte(b)}), 400, badRequest)
	}
	for i := 0; i < 10; i++ {
		expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.63:1",
			body: mustJSON(map[string]any{"a_r": enc.EncodeToString(rnd(32)), "persistante": false, "etiquette": ""})}),
			403, `{"error":"identifiants"}`)
	}
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: "203.0.113.63:1",
		body: mustJSON(map[string]any{"a_r": in.aR, "persistante": false, "etiquette": ""})}), 429, "")
}

// Parcours par HTTP : coffres, sessions, étiquette, pseudo, déconnexion.
func TestParcoursCompteHTTP(t *testing.T) {
	e := newEnvCompte(t)
	const ip = "203.0.113.20:1"
	a := e.inscrire(t, ip, "lea")
	// Sans session, session inconnue ou mal formée : 401.
	for _, h := range []map[string]string{nil, sess(enc.EncodeToString(rnd(32))), sess("court")} {
		w := e.do(req{method: "GET", path: "/api/compte/coffre/profil", hdr: h})
		expect(t, w, 401, `{"error":"session"}`)
	}
	w := e.do(req{method: "GET", path: "/api/compte/coffre/prive", hdr: sess(a.session)})
	expect(t, w, 200, "")
	if d := jsonOf(t, w); d["gen"] != float64(1) || len(d["blob"].(string)) < 5000 {
		t.Fatal(w.Body.String())
	}
	w = e.do(req{method: "PUT", path: "/api/compte/coffre/prive", hdr: sess(a.session),
		body: mustJSON(map[string]any{"if_gen": 1, "blob": coffreB64("SHH-ACCT1", 2)})})
	expect(t, w, 200, `{"gen":2}`)
	w = e.do(req{method: "PUT", path: "/api/compte/coffre/prive", hdr: sess(a.session),
		body: mustJSON(map[string]any{"if_gen": 1, "blob": coffreB64("SHH-ACCT1", 2)})})
	expect(t, w, 409, `{"error":"conflict","gen":2}`)
	s2 := e.recup(t, "203.0.113.30:1", a)
	// Nom d'appareil posé après la connexion (lot 10) : 64 octets exactement, session exigée.
	etiq := enc.EncodeToString(rnd(64))
	for _, x := range []string{"", enc.EncodeToString(rnd(63)), etiq + "A"} {
		expect(t, e.do(req{method: "POST", path: "/api/compte/sessions/etiquette", hdr: sess(s2),
			body: mustJSON(map[string]any{"etiquette": x})}), 400, badRequest)
	}
	expect(t, e.do(req{method: "POST", path: "/api/compte/sessions/etiquette",
		body: mustJSON(map[string]any{"etiquette": etiq})}), 401, `{"error":"session"}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/sessions/etiquette", hdr: sess(a.session),
		body: mustJSON(map[string]any{"etiquette": etiq})}), 200, `{}`)
	w = e.do(req{method: "GET", path: "/api/compte/sessions", hdr: sess(s2)})
	if strings.Count(w.Body.String(), `"etiquette":"`+etiq+`"`) != 1 {
		t.Fatal(w.Body.String())
	}
	expect(t, w, 200, "")
	if !strings.Contains(w.Body.String(), `"courante":true`) || strings.Count(w.Body.String(), `"sid"`) != 2 {
		t.Fatal(w.Body.String())
	}
	// Pseudo.
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/verifier", hdr: sess(s2),
		body: []byte(`{"p_canon":"lea"}`)}), 200, `{"libre":false}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/verifier", hdr: sess(s2),
		body: []byte(`{"p_canon":"connard"}`)}), 200, `{"libre":false}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/verifier", hdr: sess(s2),
		body: []byte(`{"p_canon":"leo"}`)}), 200, `{"libre":true}`)
	// Invité d'un salon (22 novembre) : sans session ; pseudo d'un compte, réservé ou interdit
	// refusés de la même façon ; 30 par heure et par connexion.
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/libre", body: []byte(`{"p_canon":"lea"}`)}), 200, `{"libre":false}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/libre", body: []byte(`{"p_canon":"adrnln"}`)}), 200, `{"libre":false}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/libre", body: []byte(`{"p_canon":"leo"}`)}), 200, `{"libre":true}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/libre", body: []byte(`{"p_canon":""}`)}), 400, "")
	for i := 3; i < 30; i++ { // la requête vide n'est pas comptée
		expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/libre", body: []byte(`{"p_canon":"leo"}`)}), 200, `{"libre":true}`)
	}
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo/libre", body: []byte(`{"p_canon":"leo"}`)}), 429, "")
	// Premier changement permis le jour de l'inscription (faute de frappe), le suivant attend.
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo", hdr: sess(s2),
		body: []byte(`{"p_canon":"leo"}`)}), 200, `{}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/pseudo", hdr: sess(s2),
		body: []byte(`{"p_canon":"lea"}`)}), 429, "")
	// Fermer les autres, puis se déconnecter.
	expect(t, e.do(req{method: "POST", path: "/api/compte/sessions/fermer", hdr: sess(s2),
		body: []byte(`{"autres":true}`)}), 200, `{}`)
	expect(t, e.do(req{method: "GET", path: "/api/compte/sessions", hdr: sess(a.session)}), 401, `{"error":"session"}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/deconnexion", hdr: sess(s2), body: []byte(`{}`)}), 200, `{}`)
	expect(t, e.do(req{method: "GET", path: "/api/compte/sessions", hdr: sess(s2)}), 401, `{"error":"session"}`)
}

// JSON strict (§8.6) : clé inconnue, doublon, casse, longueur fausse, null → 400.
func TestJSONStrictCompte(t *testing.T) {
	e := newEnvCompte(t)
	a := enc.EncodeToString(rnd(32))
	for i, b := range []string{
		`{"a_r":"` + a + `","persistante":false,"etiquette":"","x":1}`,
		`{"a_r":"` + a + `","a_r":"` + a + `","persistante":false,"etiquette":""}`,
		`{"A_r":"` + a + `","persistante":false,"etiquette":""}`,
		`{"a_r":"` + a[:42] + `","persistante":false,"etiquette":""}`,
		`{"a_r":null,"persistante":false,"etiquette":""}`,
		`{"a_r":"` + a + `","persistante":null,"etiquette":""}`,
		`{"a_r":"` + a + `","etiquette":""}`,
		`{"a_r":"` + a + `","persistante":false,"etiquette":"court"}`,
		`null`, `[]`, ``,
	} {
		w := e.do(req{method: "POST", path: "/api/compte/recup", body: []byte(b)})
		if w.Code != 400 || w.Body.String() != badRequest {
			t.Fatalf("cas %d : %d %q", i, w.Code, w.Body.String())
		}
	}
	// Corps de coffre au-delà du plafond : 400.
	big := bytes.Repeat([]byte("A"), 2<<20)
	in := e.inscrire(t, "203.0.113.70:1", "lea")
	w := e.do(req{method: "PUT", path: "/api/compte/coffre/prive", hdr: sess(in.session), body: big})
	expect(t, w, 400, badRequest)
}

// Le jeton de session n'est lu que par handlers_compte.go (minimize : liste par fichier), et
// son nom n'apparaît dans aucune autre source du serveur.
func TestEnTeteSessionSeulementIci(t *testing.T) {
	if !headerAllowed("internal/api/handlers_compte.go", "X-Shh-Session") {
		t.Fatal("X-Shh-Session refusé dans handlers_compte.go")
	}
	for _, p := range []string{"internal/api/handlers_share.go", "internal/api/handlers_salon.go", "internal/api/api.go"} {
		if headerAllowed(p, "X-Shh-Session") {
			t.Fatalf("X-Shh-Session permis dans %s", p)
		}
	}
	vu := false
	for _, sf := range serverSources(t) {
		ast.Inspect(sf.f, func(n ast.Node) bool {
			if s, ok := strLit(asExpr(n)); ok && strings.Contains(s, "X-Shh-Session") {
				if filepath.Base(sf.path) != "handlers_compte.go" {
					t.Errorf("%s : X-Shh-Session hors de handlers_compte.go", sf.fset.Position(n.Pos()))
				}
				vu = true
			}
			return true
		})
	}
	if !vu {
		t.Fatal("X-Shh-Session introuvable")
	}
}

func asExpr(n ast.Node) ast.Expr {
	if e, ok := n.(ast.Expr); ok {
		return e
	}
	return nil
}

// État, export, suppression par HTTP : plus de TOTP, d'attente ni d'adresse.
func TestEtatExportSuppressionHTTP(t *testing.T) {
	e := newEnvCompte(t)
	const ip = "203.0.113.50:1"
	a := e.inscrire(t, ip, "lea")
	S := sess(a.session)
	w := e.do(req{method: "GET", path: "/api/compte", hdr: S})
	expect(t, w, 200, "")
	et := jsonOf(t, w)
	if cles(et) != "banni,banni_jusqu,banni_motif,confirme_le,cree_le,h,limites,palier,salons_actifs" ||
		et["h"] != a.h || et["palier"] != "neuf" || et["banni_motif"] != nil ||
		fmt.Sprint(et["limites"]) != "map[heures:24 places:4 salons:1]" {
		t.Fatal(w.Body.String())
	}
	w = e.do(req{method: "GET", path: "/api/compte/export", hdr: S})
	expect(t, w, 200, "")
	x := jsonOf(t, w)
	if cles(x) != "anciennete_depuis,banni_jusqu,banni_motif,cree_le,passkeys,salons_actifs,sessions,vu_mois" ||
		strings.Contains(w.Body.String(), "lea") || !strings.Contains(w.Body.String(), `"par_recup":false`) ||
		!strings.Contains(w.Body.String(), `"be":true,"prf":true,"cle_pub":"`) {
		t.Fatal(w.Body.String())
	}
	// Suppression : session récente (5 min), sans attente.
	e.clk.Add(6 * time.Minute)
	expect(t, e.do(req{method: "POST", path: "/api/compte/supprimer", hdr: S, body: []byte(`{}`)}), 403, `{"error":"recent"}`)
	S = sess(e.recup(t, ip, a))
	expect(t, e.do(req{method: "POST", path: "/api/compte/supprimer", hdr: S, body: []byte(`{}`)}), 200, `{"salons_fermes":0}`)
	expect(t, e.do(req{method: "GET", path: "/api/compte", hdr: S}), 401, `{"error":"session"}`)
	expect(t, e.do(req{method: "POST", path: "/api/compte/recup", remote: ip,
		body: mustJSON(map[string]any{"a_r": a.aR, "persistante": false, "etiquette": ""})}), 403, `{"error":"identifiants"}`)
}

package adminui

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/compte"
)

// Comptes : tableau de bord (conception du compte §21.14) :
// signalements et salons signalés désignés par une ref éphémère, bannissements, comptes.
// Jamais une adresse, une empreinte, un h, un pseudo, une IP, un lien ni un identifiant
// interne dans une réponse.

const (
	cleSecrete   = "IDINTERNESALON01" // identifiant interne d'un salon : jamais rendu
	adresseTapee = "Lea.Dupont+x@exemple.fr"
	lienColle    = "https://shhgone.com/#cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

// bancComptes : banc avec les crochets des comptes, et ce qu'ils ont reçu.
type bancComptes struct {
	*banc
	mu        sync.Mutex
	clk       time.Time
	signales  []Signale
	actions   []string // « cle action duree motif »
	resultat  Resultat
	errAction error
	recus     [][]byte // tampons reçus (lien) : effacés après la réponse
	bannis    []string
	errBannir error
	errBan    error
	avant     compte.BanVue
	apres     *compte.BanVue
}

func nouveauBancComptes(avecComptes bool) *bancComptes {
	b := &bancComptes{banc: &banc{}, clk: time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)}
	vue := compte.BanVue{ID: "B-0000-0000-00000", Debut: "2026-11-14", Jusqu: "2029-11-13", Actif: true, Motif: 6, SalonsFermes: 2}
	c := Config{
		TokenHash: sha256.Sum256([]byte(jeton)),
		Peers:     []netip.Prefix{netip.MustParsePrefix("172.30.53.1/32")},
		State:     func() (State, error) { b.etats++; return State{}, nil },
		Freeze:    func() error { b.gels++; return nil },
		Unfreeze:  func() error { b.degels++; return nil },
		Destroy:   func([]byte) (string, error) { b.destructs++; return "partage", nil },
		Now:       func() time.Time { b.mu.Lock(); defer b.mu.Unlock(); return b.clk },
		Signales:  func() ([]Signale, error) { b.etats++; return b.signales, nil },
		ActionSalon: func(cle, action string, duree int, motif uint8) (Resultat, error) {
			b.actions = append(b.actions, cle+" "+action+" "+itoa(duree)+" "+itoa(int(motif)))
			return b.resultat, b.errAction
		},
	}
	if avecComptes {
		c.Comptes = &Comptes{
			Agregats: func() (Agregats, error) {
				b.etats++
				return Agregats{AgregatsComptes: compte.AgregatsComptes{Comptes: 3, Max: 10}}, nil
			},
			Liste: func(filtre string, page int) ([]compte.BanVue, int, error) {
				b.bannis = append(b.bannis, "liste "+filtre+" "+itoa(page))
				return []compte.BanVue{vue}, 1, b.errBan
			},
			Action: func(id, action, jusqu string) (compte.BanVue, *compte.BanVue, error) {
				b.bannis = append(b.bannis, "action "+id+" "+action+" "+jusqu)
				return b.avant, b.apres, b.errBan
			},
			Bannir: func(lien []byte, duree int, motif uint8) (Resultat, error) {
				b.recus = append(b.recus, lien)
				b.bannis = append(b.bannis, "bannir "+string(lien)+" "+itoa(duree)+" "+itoa(int(motif)))
				return Resultat{Banni: "compte", Ban: &vue, SalonsFermes: 2}, b.errBannir
			},
		}
	}
	b.h = New(c)
	return b
}

func itoa(n int) string { return strconv.Itoa(n) }

func (b *bancComptes) avancer(d time.Duration) { b.mu.Lock(); b.clk = b.clk.Add(d); b.mu.Unlock() }

func (b *bancComptes) post(path, corps string) (int, string) {
	w := b.faire(req{method: "POST", path: path, corps: corps, hdr: [][2]string{bon()}})
	return w.Code, w.Body.String()
}

func (b *bancComptes) get(path string) (int, string) {
	w := b.faire(req{method: "GET", path: path, hdr: [][2]string{bon()}})
	return w.Code, w.Body.String()
}

// Les routes des comptes suivent les règles de toutes les autres : sans jeton, avec un paramètre
// d'URL, ou comptes désactivés (SHH_COMPTES=0) : le refus uniforme, aucun crochet appelé.
func TestRefusUniformeLot7(t *testing.T) {
	routes := [][2]string{{"GET", "/api/signalements"}, {"POST", "/api/salons/action"}, {"POST", "/api/bannis"},
		{"POST", "/api/bannis/action"}, {"POST", "/api/bannir"}, {"GET", "/api/comptes"}}
	b := nouveauBancComptes(true)
	ref := b.faire(req{method: "GET", path: "/api/nimporte"})
	pareil := func(nom string, q req, bb *bancComptes) {
		w := bb.faire(q)
		if w.Code != ref.Code || !bytes.Equal(w.Body.Bytes(), ref.Body.Bytes()) {
			t.Errorf("%s : %d %s", nom, w.Code, w.Body.String())
		}
	}
	for _, r := range routes {
		pareil(r[1]+" sans jeton", req{method: r[0], path: r[1], corps: `{}`}, b)
		pareil(r[1]+" jeton faux", req{method: r[0], path: r[1], corps: `{}`,
			hdr: [][2]string{{"Authorization", "Bearer " + strings.Repeat("f", 64)}}}, b)
		pareil(r[1]+" paramètre", req{method: r[0], path: r[1] + "?filtre=actifs&email=" + adresseTapee, corps: `{}`,
			hdr: [][2]string{bon()}}, b)
		autre := "POST"
		if r[0] == "POST" {
			autre = "GET"
		}
		pareil(r[1]+" méthode", req{method: autre, path: r[1], hdr: [][2]string{bon()}}, b)
	}
	if b.etats != 0 || len(b.actions) != 0 || len(b.bannis) != 0 {
		t.Fatalf("crochet appelé : %d %v %v", b.etats, b.actions, b.bannis)
	}
	sans := nouveauBancComptes(false)
	for _, r := range routes[2:] {
		pareil(r[1]+" sans comptes", req{method: r[0], path: r[1], corps: `{}`, hdr: [][2]string{bon()}}, sans)
	}
}

// Salons signalés : une ref aléatoire par salon (la même pendant 10 min, puis une autre),
// jamais l'identifiant interne ; « moins de 6 h » ou « 6 à 24 h » ; codes 1 et 2 d'abord, puis
// par nombre. Une action désigne le salon par sa ref ; ref inconnue ou échue : « introuvable ».
func TestBannirDepuisRefSignale(t *testing.T) {
	b := nouveauBancComptes(true)
	now := b.clk
	cv := &compte.CompteVue{Existe: true, Palier: "confirme", AncienneteJours: 40}
	b.signales = []Signale{
		{Cle: "AUTRESALON000001", Categories: [10]int{9: 3}, Expire: now.Add(20 * time.Hour), Places: 4, Sieges: 2},
		{Cle: cleSecrete, Categories: [10]int{1: 1, 5: 1}, Expire: now.Add(2 * time.Hour), Places: 10, Sieges: 7,
			Createur: cv, AutresSalons: 2},
	}
	code, corps := b.get("/api/signalements")
	var r struct {
		Salons []struct {
			Ref          string            `json:"ref"`
			Categories   [10]int           `json:"categories"`
			Places       int               `json:"places"`
			Sieges       int               `json:"sieges"`
			Efface       string            `json:"efface"`
			Createur     *compte.CompteVue `json:"createur"`
			AutresSalons int               `json:"autres_salons"`
		} `json:"salons"`
	}
	if code != 200 || json.Unmarshal([]byte(corps), &r) != nil || len(r.Salons) != 2 {
		t.Fatal(code, corps)
	}
	if strings.Contains(corps, cleSecrete) || strings.Contains(corps, "AUTRESALON") {
		t.Fatal("identifiant interne rendu :", corps)
	}
	s0, s1 := r.Salons[0], r.Salons[1]
	if s0.Categories[1] != 1 || s0.Efface != "moins_6h" || s0.Places != 10 || s0.Sieges != 7 || s0.Createur == nil ||
		*s0.Createur != *cv || s0.AutresSalons != 2 || len(s0.Ref) != 22 {
		t.Fatalf("premier (code 2 d'abord) : %+v", s0)
	}
	if s1.Efface != "6_24h" || s1.Createur != nil || s0.Ref == s1.Ref {
		t.Fatalf("second : %+v", s1)
	}
	b.resultat = Resultat{Banni: "compte", SalonsFermes: 3}
	code, corps = b.post("/api/salons/action", `{"ref":"`+s0.Ref+`","action":"bannir","duree_jours":365,"motif":2}`)
	if code != 200 || corps != `{"banni":"compte","salons_fermes":3}` || b.actions[0] != cleSecrete+" bannir 365 2" {
		t.Fatal(code, corps, b.actions)
	}
	b.avancer(9 * time.Minute)
	_, corps2 := b.get("/api/signalements")
	if !strings.Contains(corps2, s0.Ref) {
		t.Fatal("ref changée avant 10 min")
	}
	for _, c := range []struct{ corps, code, body string }{
		{`{"ref":"` + s0.Ref + `","action":"detruire"}`, "200", ""},
		{`{"ref":"` + s0.Ref + `","action":"anciennete"}`, "200", ""},
		{`{"ref":"` + s0.Ref + `","action":"wipe"}`, "400", `{"error":"bad_request"}`},
		{`{"ref":"` + s0.Ref + `","action":"bannir","duree_jours":12,"motif":2}`, "400", `{"error":"bad_request"}`},
		{`{"ref":"` + s0.Ref + `","action":"bannir","duree_jours":30,"motif":0}`, "400", `{"error":"bad_request"}`},
		{`{"ref":"` + s0.Ref + `","action":"detruire","inconnu":1}`, "400", `{"error":"bad_request"}`},
		{`{"ref":"AAAAAAAAAAAAAAAAAAAAAA","action":"detruire"}`, "200", `{"introuvable":true}`},
		{`{"ref":"court","action":"detruire"}`, "400", `{"error":"bad_request"}`},
		{`{"ref":"` + strings.Repeat("A", 64) + `","action":"detruire"}`, "400", `{"error":"bad_request"}`},
		{`pas du json`, "400", `{"error":"bad_request"}`},
	} {
		b.resultat = Resultat{}
		code, corps := b.post("/api/salons/action", c.corps)
		if itoa(code) != c.code || (c.body != "" && corps != c.body) {
			t.Errorf("%s : %d %s", c.corps, code, corps)
		}
	}
	if len(b.actions) != 3 || b.actions[1] != cleSecrete+" detruire 0 0" || b.actions[2] != cleSecrete+" anciennete 0 0" {
		t.Fatal(b.actions)
	}
	b.avancer(2 * time.Minute)
	if code, corps := b.post("/api/salons/action", `{"ref":"`+s1.Ref+`","action":"detruire"}`); code != 200 ||
		corps != `{"introuvable":true}` {
		t.Fatal("ref échue acceptée :", code, corps)
	}
	b.errAction = compte.ErrLimit{Retry: time.Minute}
	_, corps = b.get("/api/signalements")
	json.Unmarshal([]byte(corps), &r)
	if code, corps := b.post("/api/salons/action", `{"ref":"`+r.Salons[0].Ref+`","action":"bannir","duree_jours":30,"motif":1}`); code != 429 ||
		corps != `{"error":"limit"}` {
		t.Fatal(code, corps)
	}
}

// Bannissements : liste (filtre et page dans le corps : aucun paramètre d'URL n'est accepté),
// actions (l'état d'avant est rendu), bannissement par lien de salon. Le lien n'est jamais
// repris, et son tampon est effacé après la réponse. Plus de recherche ni de bannissement par
// adresse (conception du compte par passkey §7.4) : ces formes sont refusées.
func TestRoutesBannissements(t *testing.T) {
	b := nouveauBancComptes(true)
	code, corps := b.post("/api/bannis", `{"filtre":"actifs","page":2}`)
	if code != 200 || corps != `{"bannis":[{"id":"B-0000-0000-00000","debut":"2026-11-14","jusqu":"2029-11-13","actif":true,"motif":6,"salons_fermes":2}],"total":1,"page":2,"par_page":50}` {
		t.Fatal(code, corps)
	}
	b.avant = compte.BanVue{ID: "B-1", Actif: true}
	b.apres = &compte.BanVue{ID: "B-1"}
	code, corps = b.post("/api/bannis/action", `{"id":"B-1","action":"suspendre"}`)
	if code != 200 || !strings.HasPrefix(corps, `{"avant":{"id":"B-1"`) || !strings.Contains(corps, `"apres":{"id":"B-1"`) {
		t.Fatal(code, corps)
	}
	b.apres = nil
	if _, corps := b.post("/api/bannis/action", `{"id":"B-1","action":"lever"}`); !strings.HasSuffix(corps, `"apres":null}`) {
		t.Fatal(corps)
	}
	code, corps = b.post("/api/bannir", `{"lien":"`+lienColle+`","duree_jours":30,"motif":4}`)
	if code != 200 || strings.Contains(corps, "AAAAAAAA") {
		t.Fatal(code, corps)
	}
	want := []string{"liste actifs 2", "action B-1 suspendre ", "action B-1 lever ", "bannir " + lienColle + " 30 4"}
	if strings.Join(b.bannis, ";") != strings.Join(want, ";") {
		t.Fatalf("%q", b.bannis)
	}
	for i, r := range b.recus {
		if !bytes.Equal(r, make([]byte, len(r))) {
			t.Errorf("tampon %d non effacé : %q", i, r)
		}
	}
	n := len(b.bannis)
	for _, c := range []struct{ path, corps, body string }{
		{"/api/bannir", `{"email":"a@b.fr","lien":"x","duree_jours":30,"motif":1}`, `{"error":"bad_request"}`},
		{"/api/bannir", `{"email":"` + adresseTapee + `","duree_jours":30,"motif":1}`, `{"error":"bad_request"}`},
		{"/api/bannir", `{"duree_jours":30,"motif":1}`, `{"error":"bad_request"}`},
		{"/api/bannir", `{"lien":"a\u0040b","duree_jours":30,"motif":1}`, `{"error":"bad_request"}`},
		{"/api/bannir", `{"lien":"x","duree_jours":30,"motif":1,"x":1}`, `{"error":"bad_request"}`},
		{"/api/bannir", `{"lien":12,"duree_jours":30,"motif":1}`, `{"error":"bad_request"}`},
		{"/api/bannis", `{"filtre":"x","page":"1"}`, `{"error":"bad_request"}`},
		{"/api/bannir", `{"lien":"` + strings.Repeat("a", 9000) + `","duree_jours":30,"motif":1}`, `{"error":"bad_request"}`},
	} {
		if code, corps := b.post(c.path, c.corps); code != 400 || corps != c.body {
			t.Errorf("%s %.60s : %d %s", c.path, c.corps, code, corps)
		}
	}
	if len(b.bannis) != n {
		t.Fatal("crochet appelé pour une demande mal formée :", b.bannis[n:])
	}
	for _, c := range []struct {
		err  error
		code int
		body string
	}{
		{compte.ErrRequete, 400, `{"error":"bad_request"}`},
		{ErrLienInvalide, 400, `{"error":"lien_invalide"}`},
		{ErrIntrouvable, 200, `{"introuvable":true}`},
		{compte.ErrEtape, 200, `{"introuvable":true}`},
		{compte.ErrLimit{Retry: time.Minute}, 429, `{"error":"limit"}`},
		{compte.ErrDejaBanni{Vue: compte.BanVue{ID: "B-2", Jusqu: "2027-01-01"}}, 409,
			`{"error":"deja_banni","ban":{"id":"B-2","debut":"","jusqu":"2027-01-01","actif":false,"motif":0,"salons_fermes":0}}`},
		{errors.New("base /data/comptes.db IDSECRET"), 500, `{"error":"internal"}`},
	} {
		b.errBannir = c.err
		if code, corps := b.post("/api/bannir", `{"lien":"x","duree_jours":30,"motif":1}`); code != c.code || corps != c.body {
			t.Errorf("%v : %d %s", c.err, code, corps)
		}
	}
	if code, corps := b.get("/api/comptes"); code != 200 || !strings.Contains(corps, `"comptes":3`) || strings.Contains(corps, `"courriel"`) ||
		!strings.Contains(corps, `"passkeys":0`) {
		t.Fatal(code, corps)
	}
}

// Toutes les réponses des comptes et la page : ni l'adresse tapée (ni sa forme normalisée), ni le
// lien collé, ni l'identifiant interne d'un salon.
func TestPageSansIdentite(t *testing.T) {
	b := nouveauBancComptes(true)
	b.signales = []Signale{{Cle: cleSecrete, Categories: [10]int{0: 1}, Expire: b.clk.Add(time.Hour), Places: 2}}
	var tout strings.Builder
	for _, q := range [][3]string{{"GET", "/api/signalements", ""}, {"GET", "/api/comptes", ""}, {"POST", "/api/bannis", `{}`},
		{"POST", "/api/bannir", `{"lien":"` + lienColle + `","duree_jours":30,"motif":1}`},
		{"GET", "/", ""}, {"GET", "/admin.js", ""}, {"GET", "/admin.css", ""}} {
		w := b.faire(req{method: q[0], path: q[1], corps: q[2], hdr: [][2]string{bon()}})
		if w.Code != http.StatusOK {
			t.Fatalf("%s : %d %s", q[1], w.Code, w.Body.String())
		}
		tout.WriteString(w.Body.String())
	}
	s := strings.ToLower(tout.String())
	for _, interdit := range []string{strings.ToLower(cleSecrete), "dupont", "exemple.fr", "aaaaaaaaaaaa", "e_canon",
		"p_empreinte", "pseudo\":", "\"h\":", "cred_id", "chercher", "recherche par adresse", "bannir par adresse",
		"adresse e-mail", "e-mails envoyés", "totp", "double auth"} {
		if strings.Contains(s, interdit) {
			t.Errorf("réponse ou page contient %q", interdit)
		}
	}
}

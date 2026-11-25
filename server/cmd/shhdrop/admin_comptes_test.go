package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/adminui"
	"github.com/skoow/shhdrop/server/internal/api"
	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/config"
	"github.com/skoow/shhdrop/server/internal/limits"
	"github.com/skoow/shhdrop/server/internal/salon"
	"github.com/skoow/shhdrop/server/internal/share"
	"github.com/skoow/shhdrop/server/internal/store"
)

// Comptes : tableau de bord et ligne de commande du bannissement,
// branchés sur les vrais services (compte, salon). Bannissement par compte seulement
// (conception du compte par passkey §7.4).

func coffreTest(magic string) []byte {
	b := make([]byte, 4096+45)
	rand.Read(b)
	copy(b, magic)
	binary.BigEndian.PutUint64(b[9:], 1)
	return b
}

// inscrireTest : un compte complet (pseudo p) écrit directement dans comptes.db (ligne du compte
// et d'une passkey, comme inscription/fin ; la cérémonie WebAuthn est testée par internal/api et
// internal/compte) ; rend h.
func inscrireTest(t *testing.T, db *sql.DB, cles compte.Cles, pseudo string) [16]byte {
	t.Helper()
	var h [16]byte
	rand.Read(h[:])
	pe, err := cles.EmpreintePseudo([]byte(strings.NewReplacer("i", "l", "1", "l", "0", "o", "m", "rn").Replace(strings.ToLower(pseudo))))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	jour := now.Unix() / 86400 * 86400
	mois := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).Unix()
	if _, err := db.Exec(`INSERT INTO comptes(h, p_empreinte, pseudo_jour, v_r, env_r, blob_profil, gen_profil, blob_prive,
		gen_prive, cree_jour, compte_des, vu_mois) VALUES(?,?,0,randomblob(32),randomblob(60),?,1,?,1,?,?,?)`,
		h[:], pe[:], coffreTest("SHH-PROF1"), coffreTest("SHH-ACCT1"), jour, jour, mois); err != nil {
		t.Fatal(err)
	}
	cred := make([]byte, 32)
	rand.Read(cred)
	if _, err := db.Exec(`INSERT INTO passkeys(cred_id, h, cle_pub, alg, be, etiquette, ajoutee_mois)
		VALUES(?,?,randomblob(77),-7,1,NULL,?)`, cred, h[:], mois); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO enveloppes(cred_id, n, env) VALUES(?,0,randomblob(60))`, cred); err != nil {
		t.Fatal(err)
	}
	return h
}

// fixtureComptes : serveur sans écoute : shares.db, comptes.db, gestionnaire du salon et
// service du compte reliés comme par serve (setupComptes, setupSalons, BrancherSalonsDuCompte).
type fixtureComptes struct {
	cfg config.Config
	d   adminDeps
	cpt *comptes
	h   http.Handler
}

func cleCompteTest(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "cle")
	k := make([]byte, 32)
	rand.Read(k)
	if err := os.WriteFile(p, k, 0o400); err != nil {
		t.Fatal(err)
	}
	return p
}

func nouvelleFixture(t *testing.T) *fixtureComptes {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Config{DataDir: dir, Salons: true, SalonsMax: 10, StorageMaxBytes: 1 << 40, Now: time.Now,
		Comptes: true, ComptesCleFile: cleCompteTest(t), ComptesMax: 10, AdminTokenHash: sha256.Sum256([]byte(jetonAdmin))}
	db, err := store.Open(filepath.Join(dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc, err := share.NewService(share.Config{DB: db, Blobs: &blob.Store{Dir: filepath.Join(dir, "blobs")}, Now: time.Now,
		StorageMax: 1 << 40, FrozenFile: filepath.Join(dir, "frozen")})
	if err != nil {
		t.Fatal(err)
	}
	cpt, err := setupComptes(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cpt.db.Close() })
	lim := limits.New(time.Now)
	gate := blob.NewGate(4)
	sm, err := setupSalons(cfg, db, svc, lim, gate, store.NewVidage(db), cpt)
	if err != nil {
		t.Fatal(err)
	}
	cc := compte.Config{DB: cpt.db, Cles: cpt.cles, Limites: lim, Now: time.Now, Max: 10}
	api.BrancherSalonsDuCompte(&cc, sm)
	if cpt.svc, err = compte.NewService(cc); err != nil {
		t.Fatal(err)
	}
	f := &fixtureComptes{cfg: cfg, cpt: cpt,
		d: adminDeps{svc: svc, sm: sm, db: db, gate: gate, lim: lim, probes: sondesVides(), start: time.Now(), cpt: cpt.svc}}
	f.h = adminui.New(adminConfig(cfg, f.d))
	return f
}

// salonDe : salon de 4 places créé par le compte h ; rend K_accès_s et le lien d'invitation.
func (f *fixtureComptes) salonDe(t *testing.T, h *[16]byte) ([]byte, []byte, string) {
	t.Helper()
	kLien := alea(32)
	lien := "https://shhgone.com/#c" + base64.RawURLEncoding.EncodeToString(kLien)
	ka, ok := salonAccessKeyOf(lien)
	if !ok {
		t.Fatal("lien")
	}
	kp := alea(32)
	r := salon.CreerReq{AccessV: hash(ka), ManageV: hash(alea(32)), ProofV: hash(kp), Salt: alea(16), TTLHours: 6,
		MaxMembers: 4, KdfOps: 3, KdfMem: 67108864, Bloc: [32]byte(alea(32)), Compte: h}
	if _, err := f.d.sm.Creer(r); err != nil {
		t.Fatal(err)
	}
	return ka, kp, lien
}

// signaler : deux invités entrent ; l'un fait « Quitter et signaler » (catégorie cat).
func (f *fixtureComptes) signaler(t *testing.T, ka, kp []byte, cat uint8) {
	t.Helper()
	for i := range 2 {
		e, err := f.d.sm.Rejoindre(ka, kp, nil)
		if err != nil {
			t.Fatal(err)
		}
		if i == 1 {
			mb, err := f.d.sm.Membre(e.Jeton[:])
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.d.sm.QuitterSignaler(mb, cat); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func (f *fixtureComptes) req(t *testing.T, method, path, corps string) (int, string) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(corps))
	r.RemoteAddr, r.Host = "127.0.0.1:40000", "localhost:9191"
	r.Header.Set("Authorization", "Bearer "+jetonAdmin)
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

// Bout en bout, vrais services : un salon signalé apparaît par sa ref avec son créateur
// (palier, ancienneté, autres salons) ; « Bannir le créateur » ferme tous ses salons et
// bannit le compte ; bannir par lien collé ; plus de bannissement ni de recherche par adresse ;
// les agrégats ; et aucune réponse ne contient un h, une empreinte de pseudo, un pseudo, un
// identifiant ou une clé de passkey, un lien ni un identifiant de salon.
func TestTableauDeBordComptes(t *testing.T) {
	f := nouvelleFixture(t)
	const pseudo = "zorglubien"
	h := inscrireTest(t, f.cpt.db, f.cpt.cles, pseudo)
	h2 := inscrireTest(t, f.cpt.db, f.cpt.cles, "bidulon")
	ka, kp, lien := f.salonDe(t, &h)
	f.signaler(t, ka, kp, 2)
	ss := f.d.sm.Signalements()
	if len(ss) != 1 {
		t.Fatal(ss)
	}
	salonID := ss[0].ID
	_, _, lien2 := f.salonDe(t, &h2)
	var toutes strings.Builder
	note := func(code int, corps string) string {
		if code != 200 {
			t.Fatalf("%d %s", code, corps)
		}
		toutes.WriteString(corps)
		return corps
	}
	var sig struct {
		Salons []struct {
			Ref          string            `json:"ref"`
			Categories   [10]int           `json:"categories"`
			Sieges       int               `json:"sieges"`
			Places       int               `json:"places"`
			Efface       string            `json:"efface"`
			Createur     *compte.CompteVue `json:"createur"`
			AutresSalons int               `json:"autres_salons"`
		} `json:"salons"`
	}
	if err := json.Unmarshal([]byte(note(f.req(t, "GET", "/api/signalements", ""))), &sig); err != nil || len(sig.Salons) != 1 {
		t.Fatal(sig, err)
	}
	s := sig.Salons[0]
	if s.Categories[1] != 1 || s.Places != 4 || s.Sieges != 1 || s.Efface != "6_24h" || s.Createur == nil ||
		*s.Createur != (compte.CompteVue{Existe: true, Palier: "neuf"}) || s.AutresSalons != 0 {
		t.Fatalf("%+v %+v", s, s.Createur)
	}
	note(f.req(t, "GET", "/api/comptes", ""))
	ref, _ := f.req(t, "GET", "/api/inconnue", "")
	if code, _ := f.req(t, "POST", "/api/bannis/chercher", `{"email":"a@b.fr"}`); code != ref {
		t.Fatal("recherche par adresse encore servie :", code)
	}
	// Rendre l'ancienneté, puis bannir le créateur depuis la liste.
	if c := note(f.req(t, "POST", "/api/salons/action", `{"ref":"`+s.Ref+`","action":"anciennete"}`)); c != `{"anciennete":"rendue"}` {
		t.Fatal(c)
	}
	c := note(f.req(t, "POST", "/api/salons/action", `{"ref":"`+s.Ref+`","action":"bannir","duree_jours":365,"motif":2}`))
	var res adminui.Resultat
	if json.Unmarshal([]byte(c), &res) != nil || res.Banni != "compte" || res.SalonsFermes != 1 || res.Ban == nil || res.Ban.Motif != 2 {
		t.Fatal(c)
	}
	if _, err := f.d.sm.Meta(ka); !errors.Is(err, salon.ErrNotFound) {
		t.Fatal("salon du banni encore vivant :", err)
	}
	if _, err := f.cpt.svc.Palier(h); !errors.As(err, new(compte.ErrBanni)) {
		t.Fatal(err)
	}
	note(f.req(t, "GET", "/api/signalements", ""))
	// Par lien collé (salon d'un autre compte), puis lien d'un salon disparu ; jamais par adresse.
	if c := note(f.req(t, "POST", "/api/bannir", `{"lien":"`+lien2+`","duree_jours":30,"motif":10}`)); !strings.HasPrefix(c, `{"banni":"compte"`) {
		t.Fatal(c)
	}
	if c := note(f.req(t, "POST", "/api/bannir", `{"lien":"`+lien+`","duree_jours":30,"motif":10}`)); c != `{"introuvable":true}` {
		t.Fatal(c)
	}
	if code, c := f.req(t, "POST", "/api/bannir", `{"lien":"https://shhgone.com/#m`+strings.Repeat("A", 43)+`","duree_jours":30,"motif":10}`); code != 400 ||
		c != `{"error":"lien_invalide"}` {
		t.Fatal(code, c)
	}
	if code, c := f.req(t, "POST", "/api/bannir", `{"email":"inconnue@exemple.fr","duree_jours":365,"motif":8}`); code != 400 {
		t.Fatal("bannissement par adresse :", code, c)
	}
	l := note(f.req(t, "POST", "/api/bannis", `{"filtre":"actifs","page":0}`))
	var liste struct {
		Bannis []compte.BanVue `json:"bannis"`
		Total  int             `json:"total"`
	}
	if json.Unmarshal([]byte(l), &liste) != nil || liste.Total != 2 {
		t.Fatal(l)
	}
	note(f.req(t, "POST", "/api/bannis/action", `{"id":"`+liste.Bannis[0].ID+`","action":"suspendre"}`))
	ag := note(f.req(t, "GET", "/api/comptes", ""))
	var a adminui.Agregats
	if json.Unmarshal([]byte(ag), &a) != nil || a.Comptes != 2 || a.BannisActifs != 1 || a.BannisSuspendus != 1 ||
		a.Passkeys != 2 || a.SalonsDeComptes != 0 {
		t.Fatal(ag)
	}
	if e := note(f.req(t, "GET", "/api/etat", "")); !strings.Contains(e, `"comptes_actif":true`) {
		t.Fatal("la page ne saura pas montrer les comptes :", e)
	}
	// Fouille : rien qui désigne une personne, un salon ou un contenu.
	tout := strings.ToLower(toutes.String())
	var vr, pe, cred, pub []byte
	f.cpt.db.QueryRow(`SELECT v_r, p_empreinte FROM comptes WHERE h=?`, h[:]).Scan(&vr, &pe)
	f.cpt.db.QueryRow(`SELECT cred_id, cle_pub FROM passkeys WHERE h=?`, h[:]).Scan(&cred, &pub)
	interdits := []string{pseudo, "bidulon", salonID, lien[strings.IndexByte(lien, '#')+2:],
		lien2[strings.IndexByte(lien2, '#')+2:]}
	for _, b := range [][]byte{h[:], h2[:], vr, pe, cred, pub, ka} {
		if len(b) == 0 {
			t.Fatal("valeur de fouille vide")
		}
		interdits = append(interdits, hex.EncodeToString(b), strings.ToLower(base64.StdEncoding.EncodeToString(b)),
			strings.ToLower(base64.RawURLEncoding.EncodeToString(b)))
	}
	for _, x := range interdits {
		if strings.Contains(tout, strings.ToLower(x)) {
			t.Errorf("une réponse contient %q", x)
		}
	}
}

// Comptes désactivés (SHH_COMPTES=0) : les routes du compte répondent comme une route
// inconnue ; les salons signalés restent (destruction).
func TestTableauDeBordSansComptes(t *testing.T) {
	f := nouvelleFixture(t)
	f.d.cpt = nil
	f.h = adminui.New(adminConfig(f.cfg, f.d))
	ref, _ := f.req(t, "GET", "/api/inconnue", "")
	for _, p := range [][2]string{{"GET", "/api/comptes"}, {"POST", "/api/bannis"}, {"POST", "/api/bannir"}} {
		if code, _ := f.req(t, p[0], p[1], `{}`); code != ref {
			t.Errorf("%s : %d", p[1], code)
		}
	}
	if _, e := f.req(t, "GET", "/api/etat", ""); !strings.Contains(e, `"comptes_actif":false`) {
		t.Fatal(e)
	}
	if code, c := f.req(t, "GET", "/api/signalements", ""); code != 200 || c != `{"salons":[]}` {
		t.Fatal(code, c)
	}
}

// Ligne de commande : « shhdrop admin bannir - » lit un lien de salon sur l'entrée standard
// (jamais en argument ; plus d'adresse), ferme les salons du compte, et n'affiche pas le lien :
// seulement l'identifiant B-… ; « bannis liste|suspendre|… <B-…> » agissent par cet identifiant
// (recours de la personne bannie, conception du compte par passkey §7.4).
func TestAdminBannirStdin(t *testing.T) {
	cfg, svc := adminSetup(t)
	cfg.Comptes, cfg.ComptesCleFile, cfg.ComptesMax = true, cleCompteTest(t), 10
	cles, err := compte.LireCles(cfg.ComptesCleFile)
	if err != nil {
		t.Fatal(err)
	}
	cdb, err := compte.OuvrirBase(filepath.Join(cfg.DataDir, "comptes.db"))
	if err != nil {
		t.Fatal(err)
	}
	h := inscrireTest(t, cdb, cles, "zorglubien")
	cdb.Close()
	s := nouveauSalonTest(t)
	insererSalon(t, cfg.DataDir, s)
	if _, err := svc.DB.Exec(`UPDATE salons SET compte=? WHERE id=?`, h[:], s.id); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := runIn(cfg, s.lien+"\n", "bannir", "-", "--duree", "365", "--motif", "6")
	if code != 0 || !strings.Contains(out, "1 salon fermé") || !strings.Contains(out, "B-") {
		t.Fatal(code, out, errOut)
	}
	if strings.Contains(out+errOut, s.lien[strings.IndexByte(s.lien, '#')+2:]) || strings.Contains(out+errOut, s.id) {
		t.Fatal("la sortie reprend le lien ou l'identifiant du salon")
	}
	if salonLignes(t, svc.DB, s.id) != 0 {
		t.Fatal("salon du banni gardé")
	}
	// Une adresse n'est plus une cible : erreur d'usage, rien n'est fait.
	code, out2, errOut := runIn(cfg, " Lea@Exemple.fr \n", "bannir", "-")
	if code != 2 || strings.Contains(strings.ToLower(out2+errOut), "lea@") {
		t.Fatal(code, out2, errOut)
	}
	// Le salon a été fermé : son lien ne désigne plus rien.
	if code, _, errOut := runIn(cfg, s.lien+"\n", "bannir", "-"); code != 1 || !strings.Contains(errOut, "introuvable") {
		t.Fatal(code, errOut)
	}
	code, out, _ = runIn(cfg, "", "bannis", "liste")
	if code != 0 || strings.Count("\n"+out, "\nB-") != 1 {
		t.Fatal(code, out)
	}
	id := out[:17]
	for _, a := range [][]string{{"suspendre", id}, {"reactiver", id}, {"echeance", id, time.Now().UTC().AddDate(1, 0, 0).Format("2006-01-02")},
		{"annuler", id}} {
		if code, out, errOut := runIn(cfg, "", append([]string{"bannis"}, a...)...); code != 0 || !strings.Contains(out, "avant :") {
			t.Fatal(a, code, out, errOut)
		}
	}
	for _, args := range [][]string{{"bannir", "lea@exemple.fr"}, {"bannir", "-", "--duree", "12"}, {"bannir", "-", "--motif", "0"},
		{"bannis"}, {"bannis", "lever"}, {"bannis", "effacer", id}, {"bannis", "echeance", id}} {
		if code, _, _ := runIn(cfg, "lea@exemple.fr\n", args...); code != 2 {
			t.Errorf("%v : %d", args, code)
		}
	}
	// Sans SHH_COMPTES : refus d'usage, rien d'ouvert.
	cfg.Comptes = false
	if code, _, errOut := runIn(cfg, s.lien+"\n", "bannir", "-"); code != 2 || !strings.Contains(errOut, "SHH_COMPTES") {
		t.Fatal(code, errOut)
	}
}

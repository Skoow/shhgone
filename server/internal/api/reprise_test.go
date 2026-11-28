package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/captcha"
	"github.com/skoow/shhdrop/server/internal/limits"
	"github.com/skoow/shhdrop/server/internal/share"
	"github.com/skoow/shhdrop/server/internal/store"
	"github.com/skoow/shhdrop/server/internal/token"
)

// restart : le serveur redémarre (D42-31) : base rouverte, service, limites, clés des jetons et
// du défi neuves, purge du démarrage ; rien de l'ancien serveur n'est rangé (plantage).
func (e *env) restart(t *testing.T) *env {
	t.Helper()
	e.db.Close()
	db, err := store.Open(filepath.Join(e.dir, "shares.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	lim := limits.New(e.clk.Now)
	svc, err := share.NewService(share.Config{DB: db, Blobs: &blob.Store{Dir: filepath.Join(e.dir, "blobs")}, Now: e.clk.Now,
		OnAbandon:  func(id string, _ int) { lim.AbandonUpload(id) },
		StorageMax: 1 << 40, FrozenFile: filepath.Join(e.dir, "frozen")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.PurgeAtStart(); err != nil {
		t.Fatal(err)
	}
	sig := token.New(rnd(32), e.clk.Now)
	srv := newServer(svc, sig, lim, captcha.New(rnd(32), e.clk.Now), false, nil)
	srv.xfer = e.srv.xfer
	return &env{h: newHandler(srv, htmlStatic(), Salons{}), srv: srv, svc: svc, sig: sig, clk: e.clk, dir: e.dir, db: db}
}

func (e *env) put(c created, tok string, n int, b []byte) *httptest.ResponseRecorder {
	return e.do(req{method: "PUT", path: fmt.Sprintf("/api/shares/segments/%d", n), body: b, hdr: auth(tok)})
}

// Envoi par HTTP interrompu par un redémarrage : l'ancien jeton d'envoi est refusé (404), le
// client reprend par S_gestion (POST /api/manage/resume), envoie le reste, finalise ; le
// destinataire lit exactement ce qui a été envoyé.
func TestRepriseEnvoiHTTP(t *testing.T) {
	e := newEnv(t, false, nil)
	k := newKeys()
	const bucket = 400 // 7 segments
	c := e.create(t, "", k, bucket, 2)
	segs := make([][]byte, c.Segments)
	for n := range segs {
		segs[n] = rnd(share.SegmentSize(bucket, n))
	}
	for n := 0; n < 3; n++ {
		expect(t, e.put(c, c.UploadToken, n, segs[n]), 204, "")
	}
	e2 := e.restart(t)
	expect(t, e2.put(c, c.UploadToken, 3, segs[3]), 404, notFound) // jeton d'un autre démarrage
	// Reprise : corps vide, S_gestion en en-tête ; un autre S_gestion ou un corps : refus.
	expect(t, e2.do(req{method: "POST", path: "/api/manage/resume", hdr: manage(newKeys())}), 404, notFound)
	expect(t, e2.do(req{method: "POST", path: "/api/manage/resume", hdr: manage(k), body: []byte(`{}`)}), 400, badRequest)
	w := e2.do(req{method: "POST", path: "/api/manage/resume", hdr: manage(k)})
	expect(t, w, 200, "")
	var r struct {
		Token    string `json:"upload_token"`
		Bucket   int    `json:"bucket"`
		Segments int    `json:"segments"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil || r.Bucket != bucket || r.Segments != 7 || r.Token == "" {
		t.Fatal(w.Body.String())
	}
	if m := jsonOf(t, w); len(m) != 3 {
		t.Fatal("réponse de reprise :", m)
	}
	if id, _, exp, err := e2.sig.SubjectExp(r.Token, token.Upload); err != nil || id != c.ID ||
		exp.After(e.clk.Now().Add(6*time.Hour+15*time.Minute)) {
		t.Fatal("jeton de reprise :", id, exp, err)
	}
	// Grow déjà fait rejoué, puis reste de l'envoi.
	expect(t, e2.do(req{method: "POST", path: "/api/shares/grow", hdr: auth(r.Token), body: mustJSON(map[string]int{"bucket": bucket})}), 204, "")
	for n := 3; n < 7; n++ {
		expect(t, e2.put(c, r.Token, n, segs[n]), 204, "")
	}
	expect(t, e2.do(req{method: "POST", path: "/api/shares/finalize", hdr: auth(r.Token),
		body: mustJSON(k.finSent(2, 1, bucket, segs))}), 200, "")
	dl, n := e2.unlock(t, c.ID, k)
	var got []byte
	for i := 0; i < n; i++ {
		w := e2.do(req{method: "GET", path: fmt.Sprintf("/api/shares/segments/%d", i), hdr: auth(dl)})
		expect(t, w, 200, "")
		b, _ := io.ReadAll(w.Body)
		got = append(got, b...)
	}
	if sha256.Sum256(got) != sha256.Sum256(bytes.Join(segs, nil)) {
		t.Fatal("contenu lu différent de l'envoi")
	}
	// Plus rien à reprendre après la finalisation.
	expect(t, e2.do(req{method: "POST", path: "/api/manage/resume", hdr: manage(k)}), 404, notFound)
}

// Lecteur qui revient après un redémarrage : son octroi rouvre la même ouverture (aucune
// consommée de plus), même pour un partage dont toutes les ouvertures sont prises.
func TestRepriseOctroiHTTP(t *testing.T) {
	e := newEnv(t, false, nil)
	k := newKeys()
	c := e.create(t, "", k, 1, 1)
	e.upload(t, c, 1)
	g := e.grant(t, k) // « draining » : plus aucune ouverture
	e2 := e.restart(t)
	h := access(k)
	h["X-Shh-Grant"] = g
	expect(t, e2.do(req{method: "GET", path: "/api/shares/meta", hdr: h}), 200, "")
	w := e2.do(req{method: "POST", path: "/api/shares/unlock", hdr: h,
		body: mustJSON(map[string]string{"proof": enc.EncodeToString(k.preuve)})})
	expect(t, w, 200, "")
	if m := jsonOf(t, w); m["grant"] != g || m["opens_left"] != 0.0 || m["last_open"] != 1.0 {
		t.Fatal(m)
	}
	var issued int
	e2.db.QueryRow(`SELECT opens_issued FROM shares WHERE id=?`, c.ID).Scan(&issued)
	if issued != 1 {
		t.Fatal("ouverture consommée par le redémarrage :", issued)
	}
}

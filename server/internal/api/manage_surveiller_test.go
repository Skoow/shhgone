package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func corpsSuivi(k keys, opens int, state string) []byte {
	return mustJSON(map[string]any{"suivis": []map[string]any{{"gestion": enc.EncodeToString(k.gestion), "opens_used": opens, "state": state}}})
}

func etatsDe(t *testing.T, w *httptest.ResponseRecorder) []suiviEtat {
	t.Helper()
	var d struct {
		Etats []suiviEtat `json:"etats"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &d) != nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	return d.Etats
}

// « Mes partages » en direct (28 novembre) : la surveillance attend tant que rien ne change, répond
// dès une ouverture (opens_used +1), tout de suite si l'état connu est déjà dépassé, « absent »
// après une suppression, l'état présent à la fin de l'attente ; corps vérifié.
func TestManageSurveiller(t *testing.T) {
	e := newEnv(t, false, nil)
	fw := newFakeWait()
	e.srv.wait = fw.wait
	k := newKeys()
	c := e.create(t, "", k, 1, 2)
	e.upload(t, c, 1)

	// Rien de changé : elle attend ; une ouverture la réveille.
	res := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		res <- e.do(req{method: "POST", path: "/api/manage/surveiller", body: corpsSuivi(k, 0, "ready")})
	}()
	select {
	case w := <-res:
		t.Fatalf("répondu sans changement : %d %s", w.Code, w.Body)
	case <-time.After(100 * time.Millisecond):
	}
	e.unlock(t, c.ID, k)
	select {
	case w := <-res:
		if et := etatsDe(t, w); et[0].OpensUsed != 1 || et[0].MaxOpens != 2 || et[0].State != "ready" {
			t.Fatalf("%+v", et)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ouverture non signalée")
	}

	// État connu dépassé : réponse immédiate.
	if et := etatsDe(t, e.do(req{method: "POST", path: "/api/manage/surveiller", body: corpsSuivi(k, 0, "ready")})); et[0].OpensUsed != 1 {
		t.Fatalf("%+v", et)
	}

	// Fin de l'attente sans changement : l'état présent, inchangé.
	go func() {
		res <- e.do(req{method: "POST", path: "/api/manage/surveiller", body: corpsSuivi(k, 1, "ready")})
	}()
	time.Sleep(100 * time.Millisecond)
	fw.ch <- time.Now()
	if et := etatsDe(t, <-res); et[0].OpensUsed != 1 || fw.last() != watchHold {
		t.Fatalf("%+v %v", et, fw.last())
	}

	// Suppression pendant l'attente : « absent ».
	go func() {
		res <- e.do(req{method: "POST", path: "/api/manage/surveiller", body: corpsSuivi(k, 1, "ready")})
	}()
	time.Sleep(100 * time.Millisecond)
	expect(t, e.do(req{method: "POST", path: "/api/manage/destroy", hdr: manage(k)}), 204, "")
	select {
	case w := <-res:
		if et := etatsDe(t, w); et[0].State != "absent" {
			t.Fatalf("%+v", et)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("suppression non signalée")
	}

	// Corps : liste vide, plus de 40, secret mal formé, champ inconnu → 400.
	trop := make([]map[string]any, 41)
	for i := range trop {
		trop[i] = map[string]any{"gestion": enc.EncodeToString(rnd(32)), "opens_used": 0, "state": "ready"}
	}
	for _, b := range [][]byte{
		mustJSON(map[string]any{"suivis": []any{}}),
		mustJSON(map[string]any{"suivis": trop}),
		[]byte(`{"suivis":[{"gestion":"court","opens_used":0,"state":"ready"}]}`),
		[]byte(`{"suivis":[],"x":1}`),
	} {
		w := e.do(req{method: "POST", path: "/api/manage/surveiller", body: b})
		if w.Code != 400 || !strings.Contains(w.Body.String(), "bad_request") {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
	}
}

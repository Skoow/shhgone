package api

import (
	"encoding/base64"
	"testing"

	"github.com/skoow/shhdrop/server/internal/paiement"
)

// TestAccesOffertCommeUnPassPro : un accès offert (créé par l'exploitant, sans commande) se lit
// par POST /api/paiement/etat comme un pass Pro payé (mêmes champs, mêmes droits : rien ne dit
// « offert »), ses jetons sont de la formule Pro et ouvrent un partage Pro (20 ouvertures,
// 7 jours) ; révoqué, il ne reçoit plus de jeton et l'état le dit.
func TestAccesOffertCommeUnPassPro(t *testing.T) {
	e0 := newEnv(t, false, nil)
	s, p := servicePaiement(t, e0)
	e0.h = newHandler(e0.srv, htmlStatic(), Salons{Paiement: s})
	e := envPaiement{e0, p}

	pass, acces, err := s.Offrir(paiement.JoursOffertAn)
	if err != nil {
		t.Fatal(err)
	}
	hp := map[string]string{"X-Shh-Pass": base64.RawURLEncoding.EncodeToString(pass[:])}
	fin := acces.Fin
	expect(t, e.do(req{method: "POST", path: "/api/paiement/etat", hdr: hp}), 200,
		`{"v":1,"etat":"payee","offre":"pro","fin":"`+fin+`","renouvelle":false,"droits":["partage_pro","appel_audio","appel_video"]}`)

	jp := e.jetonsPour(t, hp["X-Shh-Pass"], "pro", 5)
	pt := map[string]string{"Authorization": "PrivateToken token=" + jp[0]}
	_, c := e.creerAvec(t, newKeys(), 1, pt)
	if code, sec := finaliser(e, c, 20, 168); code != 200 || sec < 168*3600 {
		t.Fatal("accès offert : 20 ouvertures, 7 jours", code, sec)
	}

	if ok, err := s.RevoquerOffert(acces.ID); !ok || err != nil {
		t.Fatal(ok, err)
	}
	expect(t, e.do(req{method: "POST", path: "/api/paiement/etat", hdr: hp}), 200,
		`{"v":1,"etat":"revoquee","offre":"pro","fin":"`+e.clk.Now().UTC().Format("2006-01-02")+`","renouvelle":false,"droits":[]}`)
	w := e.do(req{method: "POST", path: "/api/paiement/jetons", hdr: hp, body: mustJSON(map[string]any{"requetes": []string{"AAAA"}})})
	if w.Code == 200 {
		t.Fatal("jetons émis après révocation :", w.Body.String())
	}
}

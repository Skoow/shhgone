package api

import (
	"strings"
	"testing"

	"github.com/skoow/shhdrop/server/internal/compte"
)

// Bout en bout (SHH_COMPTES=1, branché comme dans cmd/shhdrop) : l'exploitant retrouve un compte
// par son pseudo et lui pose des limites sur mesure ; le site les lit dans GET /api/compte ;
// POST /api/salons crée alors un salon de 30 jours et 50 places, refusé (409 palier) au même
// moment pour un compte ordinaire. Retiré : refusé de nouveau. Banni : 403, sur mesure ou non.
func TestSalonSurMesureHTTP(t *testing.T) {
	e := newEnvSalonCompte(t)
	lea := e.inscrire(t, remoteA, "lea")
	leo := e.inscrire(t, remoteB, "leo")
	creer := func(in inscrit, remote string, places, heures int) (int, string) {
		t.Helper()
		k := newKeys()
		alt, shown := e.captchaFor(t, remote)
		b := k.salonBody(places, alt, shown)
		b["ttl_hours"] = heures
		h := k.createHdr()
		h["X-Shh-Session"] = in.session
		w := e.do(req{method: "POST", path: "/api/salons", hdr: h, remote: remote, body: mustJSON(b)})
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	v, err := e.svc.CompteParPseudo(" LEA ")
	if err != nil || v == nil || enc.EncodeToString(v.H[:]) != lea.h {
		t.Fatal("recherche par pseudo :", v, err)
	}
	if v, err := e.svc.CompteParPseudo("lia"); err != nil || v != nil { // « lia » et « lea » diffèrent
		t.Fatal("pseudo voisin :", v, err)
	}
	if _, err := e.svc.PoserSurMesure(v.H, compte.SurMesure{Salons: 2, Places: 50, Jours: 30, Nom: "Léa"}); err != nil {
		t.Fatal(err)
	}
	w := e.do(req{method: "GET", path: "/api/compte", hdr: sess(lea.session)})
	expect(t, w, 200, "")
	if et := jsonOf(t, w); et["sur_mesure"] != true || et["palier"] != "neuf" ||
		strings.Contains(w.Body.String(), "Léa") || !strings.Contains(w.Body.String(), `"limites":{"salons":2,"places":50,"heures":720}`) {
		t.Fatal("état du compte :", w.Body.String())
	}
	if code, body := creer(lea, remoteA, 50, 720); code != 201 || !strings.Contains(body, `"expires_in_s":259`) {
		t.Fatal("30 jours, 50 places pour le compte sur mesure :", code, body)
	}
	if code, body := creer(leo, remoteB, 50, 720); code != 409 || body != `{"error":"palier","salons":1,"places":4,"heures":24}` {
		t.Fatal("compte ordinaire :", code, body)
	}
	if _, err := e.svc.RetirerSurMesure(v.H); err != nil {
		t.Fatal(err)
	}
	if code, body := creer(lea, remoteA, 4, 72); code != 409 {
		t.Fatal("après retrait :", code, body)
	}
	e.svc.PoserSurMesure(v.H, compte.SurMesure{Salons: 3, Places: 50, Jours: 30, Nom: "Léa"})
	if _, err := e.svc.Bannir(v.H, 30, 6); err != nil {
		t.Fatal(err)
	}
	lea.session = e.reconnecter(t, lea)
	if code, body := creer(lea, remoteA, 2, 1); code != 403 && code != 401 {
		t.Fatal("banni et sur mesure :", code, body)
	}
}

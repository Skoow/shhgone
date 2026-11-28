package api

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/skoow/shhdrop/server/internal/maintenance"
	"github.com/skoow/shhdrop/server/internal/share"
)

// annoncer : annonce d'une maintenance dans e.dir (comme deploy/maintenance.sh), début dans
// dans, durée et avance en minutes ; le suivi est celui d'un serveur démarré une heure plus tôt.
func (e *env) annoncer(t *testing.T, dans time.Duration, duree, avance int) time.Time {
	t.Helper()
	p := filepath.Join(e.dir, "maintenance")
	now := e.clk.Now()
	debut := now.Add(dans)
	if err := os.WriteFile(p, fmt.Appendf(nil, "v1 %d %d %d %d\n", now.Unix(), debut.Unix(), duree, avance), 0o600); err != nil {
		t.Fatal(err)
	}
	premier := true
	e.srv.maint = maintenance.Nouveau(p, func() time.Time {
		if premier { // heure de démarrage du processus
			premier = false
			return now.Add(-time.Hour)
		}
		return e.clk.Now()
	})
	return debut
}

// États des services d'un serveur de test sans salon, compte ni paiement (fermés : « ferme »).
const (
	partagesSeuls         = `"services":{"partages":"ok","salons":"ferme","appels":"ferme","compte":"ferme","paiement":"ferme"}`
	partagesEnMaintenance = `"services":{"partages":"maintenance","salons":"ferme","appels":"ferme","compte":"ferme","paiement":"ferme"}`
)

// GET /api/etat-service : rien sans annonce ; l'horaire annoncé seulement, puis imminente.
func TestEtatService(t *testing.T) {
	e := newEnv(t, false, nil)
	expect(t, e.do(req{method: "GET", path: "/api/etat-service"}), 200, `{"maintenance":null,`+partagesSeuls+`}`)
	e.srv.maint = maintenance.Nouveau(filepath.Join(e.dir, "maintenance"), e.clk.Now)
	expect(t, e.do(req{method: "GET", path: "/api/etat-service"}), 200, `{"maintenance":null,`+partagesSeuls+`}`)
	debut := e.annoncer(t, time.Hour, 30, 10)
	w := e.do(req{method: "GET", path: "/api/etat-service"})
	expect(t, w, 200, fmt.Sprintf(`{"maintenance":{"debut":%d,"duree_min":30,"retour":%d,"imminente":false},`+partagesSeuls+`}`,
		debut.Unix(), debut.Add(30*time.Minute).Unix()))
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("Cache-Control :", w.Header().Get("Cache-Control"))
	}
	e.clk.Add(50 * time.Minute)
	expect(t, e.do(req{method: "GET", path: "/api/etat-service"}), 200, fmt.Sprintf(`{"maintenance":{"debut":%d,"duree_min":30,"retour":%d,"imminente":true},`+partagesEnMaintenance+`}`,
		debut.Unix(), debut.Add(30*time.Minute).Unix()))
}

// Mode « redémarrage imminent » : toute NOUVELLE création est refusée (503 maintenance, heure
// de retour), ce qui est en cours continue : segments d'un envoi commencé, finalisation, lecture
// d'un partage, entrée dans un salon, segments d'une pièce commencée. Annoncée seulement (avant
// le seuil) : rien n'est refusé.
// Créations suspendues par l'administrateur (gel) : partages et salons « suspendu » ; un
// service ouvert est « ok » ; la maintenance imminente l'emporte sur le gel.
func TestEtatServiceServices(t *testing.T) {
	e, _ := salonEnv(t)
	w := e.do(req{method: "GET", path: "/api/etat-service"})
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"partages":"ok","salons":"ok"`) {
		t.Fatalf("salon ouvert : %d %s", w.Code, w.Body)
	}
	if err := os.WriteFile(e.srv.svc.FrozenFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	w = e.do(req{method: "GET", path: "/api/etat-service"})
	if !strings.Contains(w.Body.String(), `"partages":"suspendu","salons":"suspendu"`) {
		t.Fatalf("gel : %s", w.Body)
	}
	e.annoncer(t, time.Hour, 30, 10)
	e.clk.Add(55 * time.Minute)
	w = e.do(req{method: "GET", path: "/api/etat-service"})
	if !strings.Contains(w.Body.String(), `"partages":"maintenance","salons":"maintenance"`) {
		t.Fatalf("imminente : %s", w.Body)
	}
}

func TestMaintenanceImminente(t *testing.T) {
	e, _ := salonEnv(t)
	j := salonMembres(t, e, 2)
	debut := e.annoncer(t, 30*time.Minute, 20, 10)
	// Annoncée : les créations passent.
	k1 := newKeys()
	c1 := e.create(t, remoteN(1), k1, 1, 1)
	_, tokP := e.pieceCreee(t, j[0], 160, false)
	// Imminente.
	e.clk.Add(21 * time.Minute)
	retour := debut.Add(20 * time.Minute)
	alt, shown := e.captchaFor(t, remoteN(2))
	corps := fmt.Sprintf(`{"error":"maintenance","retour":%d,"retry_after_s":%d}`, retour.Unix(), int64(retour.Sub(e.clk.Now())/time.Second))
	k2 := newKeys()
	w := e.do(req{method: "POST", path: "/api/shares", hdr: k2.createHdr(), body: mustJSON(k2.createBody(1, 1, alt, shown)), remote: remoteN(2)})
	expect(t, w, 503, corps)
	if w.Header().Get("Retry-After") != strconv.FormatInt(int64(retour.Sub(e.clk.Now())/time.Second), 10) {
		t.Fatal("Retry-After :", w.Header().Get("Retry-After"))
	}
	alt, shown = e.captchaFor(t, "")
	corps = fmt.Sprintf(`{"error":"maintenance","retour":%d,"retry_after_s":%d}`, retour.Unix(), int64(retour.Sub(e.clk.Now())/time.Second))
	expect(t, e.do(req{method: "POST", path: "/api/salons", hdr: k2.createHdr(), body: mustJSON(k2.salonBody(2, alt, shown))}), 503, corps)
	expect(t, e.creerPieceHTTP(j[1], 1, true), 503, corps)
	expect(t, e.creerPieceHTTP(j[1], 160, false), 503, corps)
	// En cours : l'envoi commencé se termine et se lit ; la pièce commencée aussi ; on entre
	// encore dans un salon ouvert.
	e.upload(t, c1, 1)
	e.unlock(t, c1.ID, k1)
	for n := range 3 {
		expect(t, e.putPiece(tokP, n, rnd(share.SegmentSize(160, n))), 204, "")
	}
	expect(t, e.finaliserPiece(tokP, 0, 0), 200, `{}`)
	// Après la fin, sans redémarrage : plus rien n'est refusé (jamais de créations fermées
	// sans fin).
	e.clk.Add(30 * time.Minute)
	e.create(t, remoteN(3), newKeys(), 1, 1)
}

// Un serveur redémarré pendant la maintenance (nouveau processus) accepte tout de suite les
// créations, et l'annonce s'efface d'elle-même une fois la durée passée.
func TestMaintenanceApresRedemarrage(t *testing.T) {
	e := newEnv(t, false, nil)
	debut := e.annoncer(t, 15*time.Minute, 10, 10)
	e.clk.Add(16 * time.Minute)
	alt, shown := e.captchaFor(t, "")
	k := newKeys()
	expect(t, e.do(req{method: "POST", path: "/api/shares", hdr: k.createHdr(), body: mustJSON(k.createBody(1, 1, alt, shown))}), 503, "")
	p := filepath.Join(e.dir, "maintenance")
	e.srv.maint = maintenance.Nouveau(p, e.clk.Now) // redémarré
	e.create(t, "", newKeys(), 1, 1)
	expect(t, e.do(req{method: "GET", path: "/api/etat-service"}), 200, `{"maintenance":null,`+partagesSeuls+`}`)
	e.clk.Add(debut.Add(10*time.Minute).Sub(e.clk.Now()) + time.Minute)
	expect(t, e.do(req{method: "GET", path: "/api/etat-service"}), 200, `{"maintenance":null,`+partagesSeuls+`}`)
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("annonce non effacée après la maintenance :", err)
	}
}

// Inscription au compte et commande de paiement : refusées aussi en mode imminent ; la
// connexion (rien de créé) continue.
func TestMaintenanceCompteEtPaiement(t *testing.T) {
	ec := newEnvCompte(t)
	ec.annoncer(t, 5*time.Minute, 10, 10)
	alt, shown := ec.captchaFor(t, "")
	w := ec.do(req{method: "POST", path: "/api/compte/inscription/debut", body: mustJSON(map[string]any{"altcha": alt, "hp": "", "shown_at": shown})})
	if w.Code != 503 || jsonOf(t, w)["error"] != "maintenance" {
		t.Fatalf("inscription : %d %s", w.Code, w.Body)
	}
	expect(t, ec.do(req{method: "POST", path: "/api/compte/connexion/debut", body: []byte(`{}`)}), 200, "")
	ep := newEnvPaiement(t)
	ep.annoncer(t, 5*time.Minute, 10, 10)
	w = ep.do(req{method: "POST", path: "/api/paiement/commande", hdr: map[string]string{"X-Shh-Pass": passB64(1)}, body: ep.preuve(t, corpsCommande, "")})
	if w.Code != 503 || jsonOf(t, w)["error"] != "maintenance" {
		t.Fatalf("commande : %d %s", w.Code, w.Body)
	}
}

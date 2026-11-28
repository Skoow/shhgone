package api

import (
	"bytes"
	"io"
	"path/filepath"
	"testing"

	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/salon"
	"github.com/skoow/shhdrop/server/internal/share"
)

// cleSalonsTest : clé maîtresse des salons persistants (tests).
var cleSalonsTest = [32]byte{9, 8, 7, 6, 5, 4, 3, 2, 1}

// salonEnvReprise : salonEnv avec la clé maîtresse des salons (persistance continue).
func salonEnvReprise(t *testing.T, e *env) *salon.Manager {
	t.Helper()
	k := cleSalonsTest
	m, err := salon.NewManager(salon.Config{DB: e.db, Pieces: &blob.Store{Dir: filepath.Join(e.dir, "salon-pieces")},
		DossierConversations: filepath.Join(e.dir, "salons"), Now: e.clk.Now, Max: 200, StorageMax: 1 << 40,
		UsedPartages: e.svc.Blobs.UsedBytes, OnAbandon: e.srv.lim.AbandonUpload, CleReprise: &k})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.PurgerAuDemarrage(); err != nil {
		t.Fatal("PurgerAuDemarrage :", err)
	}
	e.h = newHandler(e.srv, htmlStatic(), Salons{Origin: "https://shhdrop.app", M: m})
	return m
}

// Pièce en envoi par HTTP, serveur planté (aucun arrêt propre) puis relancé : l'ancien jeton
// d'envoi est refusé (404), l'auteur reprend par son jeton de membre
// (POST /api/salons/pieces/reprendre), envoie le reste, finalise ; un autre membre lit
// exactement ce qui a été envoyé. Un autre membre ne peut pas reprendre la pièce (404).
func TestRepriseEnvoiPieceHTTP(t *testing.T) {
	e := newEnv(t, false, nil)
	salonEnvReprise(t, e)
	j := salonMembres(t, e, 2)
	const bucket = 160 // 3 segments
	id, tok := e.pieceCreee(t, j[0], bucket, false)
	segs := make([][]byte, share.SegmentCount(bucket))
	for n := range segs {
		segs[n] = rnd(share.SegmentSize(bucket, n))
	}
	expect(t, e.putPiece(tok, 0, segs[0]), 204, "")
	expect(t, e.putPiece(tok, 1, segs[1]), 204, "")

	e2 := e.restart(t) // plantage : base rouverte, clés des jetons neuves
	salonEnvReprise(t, e2)
	expect(t, e2.putPiece(tok, 2, segs[2]), 404, notFound)
	expect(t, e2.do(req{method: "POST", path: "/api/salons/pieces/reprendre", hdr: pieceHdr(j[1], id)}), 404, notFound)
	expect(t, e2.do(req{method: "POST", path: "/api/salons/pieces/reprendre", hdr: membreHdr(j[0])}), 400, badRequest)
	w := e2.do(req{method: "POST", path: "/api/salons/pieces/reprendre", hdr: pieceHdr(j[0], id)})
	expect(t, w, 200, "")
	r := jsonOf(t, w)
	if got := clesDe(r); len(got) != 2 || got[0] != "prete" || got[1] != "upload_token" || r["prete"] != false {
		t.Fatal("réponse de reprise :", r)
	}
	tok2 := r["upload_token"].(string)
	expect(t, e2.putPiece(tok2, 2, segs[2]), 204, "")
	expect(t, e2.finaliserPiece(tok2, 0, 0), 200, `{}`)
	// Reprise d'une pièce prête : rien à renvoyer.
	w = e2.do(req{method: "POST", path: "/api/salons/pieces/reprendre", hdr: pieceHdr(j[0], id)})
	if expect(t, w, 200, ""); jsonOf(t, w)["prete"] != true {
		t.Fatal("pièce prête :", w.Body.String())
	}
	// Lecture par l'autre membre (pièce prête, plancher de création).
	for n := range segs {
		w := e2.getPiece(j[1], id, n)
		expect(t, w, 200, "")
		got, _ := io.ReadAll(w.Body)
		if !bytes.Equal(got, segs[n]) {
			t.Fatal("segment relu différent :", n)
		}
	}
}

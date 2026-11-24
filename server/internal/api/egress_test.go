package api

import (
	"net/http/httptest"
	"testing"

	"github.com/skoow/shhdrop/server/internal/share"
)

// Plafond de sortie d'un partage (décision du 24 novembre) : 403 egress_limit, réponse fixe,
// sans Retry-After (définitif pour ce partage), différente du budget d'une ouverture (429).
func TestFailEgressLimit(t *testing.T) {
	w := httptest.NewRecorder()
	fail(w, share.ErrEgressLimit)
	if w.Code != 403 || w.Body.String() != `{"error":"egress_limit"}` || w.Header().Get("Retry-After") != "" {
		t.Fatal(w.Code, w.Body.String(), w.Header())
	}
	w = httptest.NewRecorder()
	fail(w, share.ErrBudget)
	if w.Code != 429 {
		t.Fatal("budget d'une ouverture :", w.Code)
	}
}

package captcha

// Vérification d'une preuve ALTCHA (création de partage, de salon, inscription) ; le défi est
// résolu hors mesure.
//
//	go test -run '^$' -bench Verifier -benchtime 300x -benchmem ./internal/captcha/

import (
	"testing"
	"time"
)

func BenchmarkVerifier(b *testing.B) {
	now := t0
	c := newCap(&now)
	b.ReportAllocs()
	for b.Loop() {
		b.StopTimer()
		now = t0
		ch, err := c.Challenge(ipA)
		if err != nil {
			b.Fatal(err)
		}
		p := payload(ch, solve(b, ch))
		now = t0.Add(5 * time.Second)
		b.StartTimer()
		if err := c.Verify(p, ipA, "", t0); err != nil {
			b.Fatal(err)
		}
	}
}

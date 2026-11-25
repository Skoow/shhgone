package paiement

// Émission (signature aveugle RSA 2 048, décompte du pass) et dépense (vérification, empreinte
// gardée) d'un jeton anonyme. La réserve du pass est remise à plein hors mesure.
//
//	go test -run '^$' -bench Jetons -benchmem ./internal/paiement/

import "testing"

func BenchmarkJetons(b *testing.B) {
	bc, j := bancJetons(b)
	c := bc.commander(b, passN(1), Formule{Plus, JoursMois, true, Carte})
	if err := bc.webhook(b, confirme(c, "pi_1", 700)); err != nil {
		b.Fatal(err)
	}
	spki := clePour(b, j, Plus, 0)
	remplir := func() {
		if _, err := bc.db.Exec(`UPDATE passes SET jetons=1000000, emis_n=0`); err != nil {
			b.Fatal(err)
		}
	}
	b.Run("emettre", func(b *testing.B) {
		r, _ := client(b, spki, "shhgone.test")
		b.ReportAllocs()
		i := 0
		for b.Loop() {
			if i%5 == 0 {
				b.StopTimer()
				remplir()
				b.StartTimer()
			}
			i++
			if _, _, err := j.Emettre(bc.s, passN(1), [][]byte{r}); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("depenser", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			b.StopTimer()
			remplir()
			r, fin := client(b, spki, "shhgone.test")
			sigs, _, err := j.Emettre(bc.s, passN(1), [][]byte{r})
			if err != nil {
				b.Fatal(err)
			}
			tok := fin(sigs[0])
			b.StartTimer()
			if _, err := j.Depenser(tok); err != nil {
				b.Fatal(err)
			}
		}
	})
}

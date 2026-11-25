package salon

// Relais des trames : Recevoir d'une trame volatile (relayée seulement) et non volatile
// (écrite dans la conversation, indexée), sans connexion puis diffusée à des connexions en
// direct (lienMuet : le client lit tout, sans rien garder).
//
//	go test -run '^$' -bench Relais -benchmem ./internal/salon/

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// lienMuet : WebSocket simulé qui envoie l'accueil puis n'envoie plus rien, et jette ce que
// le serveur écrit (en le comptant).
type lienMuet struct {
	accueil []byte
	once    sync.Once
	ferme   chan struct{}
	fOnce   sync.Once
	ecrits  atomic.Int64
}

func (l *lienMuet) Lire(ctx context.Context) ([]byte, error) {
	var a []byte
	l.once.Do(func() { a = l.accueil })
	if a != nil {
		return a, nil
	}
	select {
	case <-l.ferme:
		return nil, errors.New("lien muet : fermé")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (l *lienMuet) Ecrire(context.Context, []byte) error { l.ecrits.Add(1); return nil }
func (l *lienMuet) Ping(context.Context) error           { return nil }
func (l *lienMuet) Fermer(int, string) error {
	l.fOnce.Do(func() { close(l.ferme) })
	return nil
}

func BenchmarkRelais(b *testing.B) {
	for _, c := range []struct {
		nom       string
		drapeaux  byte
		connectes int
	}{
		{"volatile/0conn", dVolatile, 0},
		{"volatile/10conn", dVolatile, 10},
		{"rangee/0conn", 0, 0},
		{"rangee/10conn", 0, 10},
	} {
		b.Run(c.nom, func(b *testing.B) {
			bc := nouveauBanc(b, 200)
			var membres []Membre
			var liens []*lienMuet
			fini := make(chan error, 200)
			// monter : un salon de 10 membres, dont c.connectes en direct (accueil traité).
			monter := func() {
				cl := bc.creer(b, 10)
				membres = membres[:0]
				for i := range 10 {
					e, mb := bc.entrerMembre(b, cl, i == 0)
					membres = append(membres, mb)
					if i < c.connectes {
						l := &lienMuet{accueil: accueilWS(e.Jeton, 0), ferme: make(chan struct{})}
						liens = append(liens, l)
						go func() { fini <- bc.m.Servir(context.Background(), l, toujours) }()
						for l.ecrits.Load() == 0 {
							time.Sleep(time.Millisecond)
						}
					}
				}
			}
			monter()
			trame := trameD(c.drapeaux, 1)
			b.ReportAllocs()
			i := 0
			for b.Loop() {
				_, err := bc.m.Recevoir(membres[i%len(membres)], trame, nil)
				if errors.Is(err, ErrPlein) {
					// Plafond de trames du salon (TramesMaxDefaut) : un autre salon, hors mesure.
					b.StopTimer()
					monter()
					b.StartTimer()
					_, err = bc.m.Recevoir(membres[i%len(membres)], trame, nil)
				}
				if err != nil {
					b.Fatal(fmt.Sprint(i, err))
				}
				i++
			}
			b.StopTimer()
			for _, l := range liens {
				l.Fermer(0, "")
			}
			for range liens {
				<-fini
			}
		})
	}
}

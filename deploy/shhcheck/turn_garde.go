package main

// Gardes du relais TURN autour de la bibliothèque :
//
//   - écoute TCP bornée (ecouteBornee) : pion arrête pour toujours son écoute TCP à la première
//     erreur d'Accept (EMFILE après une inondation de connexions muettes) et n'a ni plafond de
//     connexions ni délai d'inactivité. Ici : Accept réessaie, au plus `max` connexions et
//     `parIP` par adresse, une connexion muette 60 s est fermée ;
//   - filtre des messages (garde) : une liaison de canal (ChannelBind) vers un port hors de la
//     plage relayée est jetée (pion en accepte 16 383 par allocation, environ 550 octets chacune :
//     418 Mo mesurés avec un seul identifiant) ; une demande EVEN-PORT ou RESERVATION-TOKEN
//     aussi (pion ouvre jusqu'à 128 prises avant le contrôle de quota). Le reste passe tel quel.

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/pion/stun/v3"
)

// garde : vrai si le message (STUN ou ChannelData) peut aller à la bibliothèque.
func (c *confTurn) garde(b []byte) bool {
	if len(b) < 4 || b[0]&0xC0 != 0 || !stun.IsMessage(b) {
		return true // ChannelData, ou ce que la bibliothèque refusera d'elle-même
	}
	var m stun.Message
	m.Raw = append([]byte(nil), b...)
	if err := m.Decode(); err != nil {
		return true
	}
	if m.Type.Class != stun.ClassRequest {
		return true
	}
	switch m.Type.Method {
	case stun.MethodChannelBind:
		var a stun.XORMappedAddress
		if err := a.GetFromAs(&m, stun.AttrXORPeerAddress); err != nil {
			return false
		}
		return a.Port >= c.min && a.Port <= c.max
	case stun.MethodAllocate:
		return !m.Contains(stun.AttrEvenPort) && !m.Contains(stun.AttrReservationToken)
	}
	return true
}

// priseGardee : prise UDP d'écoute ; les messages refusés par garde sont jetés à la lecture.
type priseGardee struct {
	net.PacketConn
	c *confTurn
}

func (p *priseGardee) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		n, a, err := p.PacketConn.ReadFrom(b)
		if err != nil || p.c.garde(b[:n]) {
			return n, a, err
		}
	}
}

// ecouteBornee : écoute TCP bornée (voir l'en-tête du fichier).
type ecouteBornee struct {
	net.Listener
	c          *confTurn
	max, parIP int
	inactif    time.Duration
	mu         sync.Mutex
	total      int
	par        map[string]int
}

func (e *ecouteBornee) Accept() (net.Conn, error) {
	for {
		cn, err := e.Listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil, err
			}
			time.Sleep(20 * time.Millisecond) // EMFILE ou autre erreur passagère : on continue
			continue
		}
		k := origine(cn.RemoteAddr()).String()
		e.mu.Lock()
		if e.total >= e.max || e.par[k] >= e.parIP {
			e.mu.Unlock()
			cn.Close()
			continue
		}
		e.total++
		e.par[k]++
		e.mu.Unlock()
		return &connGardee{Conn: cn, c: e.c, inactif: e.inactif, rendre: func() {
			e.mu.Lock()
			e.total--
			if e.par[k]--; e.par[k] <= 0 {
				delete(e.par, k)
			}
			e.mu.Unlock()
		}}, nil
	}
}

// connGardee : connexion TCP découpée en messages (STUN, ou ChannelData complété à 4 octets,
// RFC 5766 §11.5) ; un message refusé par garde est retiré du flux, une connexion muette
// `inactif` est fermée.
type connGardee struct {
	net.Conn
	c       *confTurn
	inactif time.Duration
	once    sync.Once
	rendre  func()
	reste   []byte
}

func (g *connGardee) Read(p []byte) (int, error) {
	for len(g.reste) == 0 {
		_ = g.Conn.SetReadDeadline(time.Now().Add(g.inactif))
		var tete [4]byte
		if _, err := io.ReadFull(g.Conn, tete[:]); err != nil {
			return 0, err
		}
		l := int(binary.BigEndian.Uint16(tete[2:4]))
		if tete[0]&0xC0 == 0 {
			l += 16 // STUN : 20 octets d'en-tête au total
		} else if l%4 != 0 {
			l += 4 - l%4 // ChannelData sur TCP : complété à 4 octets
		}
		msg := make([]byte, 4+l)
		copy(msg, tete[:])
		if _, err := io.ReadFull(g.Conn, msg[4:]); err != nil {
			return 0, err
		}
		if g.c.garde(msg) {
			g.reste = msg
		}
	}
	n := copy(p, g.reste)
	g.reste = g.reste[n:]
	return n, nil
}

func (g *connGardee) Close() error {
	g.once.Do(g.rendre)
	return g.Conn.Close()
}

// parNom : allocations vivantes par nom d'utilisateur (identifiant temporaire), RFC 5766 §6.2
// étape 7 : un identifiant obtenu par un membre ne prend pas tout le relais, même depuis
// plusieurs adresses (le nonce de la bibliothèque n'est pas lié à l'adresse).
type parNom struct {
	mu sync.Mutex
	n  map[string]int
}

func (p *parNom) nombre(nom string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.n[nom]
}

func (p *parNom) ajouter(nom string, d int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.n[nom] += d; p.n[nom] <= 0 {
		delete(p.n, nom)
	}
}

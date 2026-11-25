package main

// Relais TURN des appels audio et vidéo du salon (conception des appels,
// docs/conception/specs/2026-11-20-appels-design.md) : dans notre image, lancé par compose.yaml
// à chaque installation, sans rien à installer sur la machine ni chez les utilisateurs.
//
//	shhcheck turn
//
// Réglages (environnement) :
//
//	SHH_TURN_SECRET_FILE  secret partagé avec le serveur Go (32 à 128 caractères imprimables, fichier 0400/0600)
//	SHH_TURN_IP           adresse IPv4 publique de la machine ; vide : celle de la route par défaut
//	SHH_TURN_PORT         port d'écoute UDP et TCP (3478)
//	SHH_TURN_PORTS        plage des ports relayés, UDP (49160-49999)
//	SHH_TURN_ALLOCATIONS  allocations simultanées au plus, pour toute la machine (60)
//	SHH_TURN_PAR_IP       allocations simultanées au plus par adresse d'origine (24)
//	SHH_TURN_PAR_NOM      allocations simultanées au plus par identifiant temporaire (12)
//	SHH_TURN_KBPS         débit relayé au plus par allocation, en kbit/s (2500)
//
// Bibliothèque : github.com/pion/turn/v4 (version épinglée par go.mod et go.sum). Identifiants
// temporaires vérifiés par son LongTermTURNRESTAuthHandler : nom « <échéance>:<aléa> », mot de
// passe base64(HMAC-SHA1(secret, nom)), calculés par le serveur Go (handlers_salon_appel.go).
//
// Ce qu'il ne fait jamais : écrire quoi que ce soit (aucun journal : le journaliseur de la
// bibliothèque est coupé), ni relayer vers autre chose que ses propres allocations. Tous les
// participants d'un appel passent par ce relais (politique « relais seulement » du site) : le
// correspondant d'une allocation est toujours une autre allocation, sur l'adresse du relais et
// dans sa plage. Le relais n'est donc ni un mandataire ouvert vers Internet, ni un rebond vers
// les services de la machine ou un réseau interne.

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/pion/logging"
	"github.com/pion/stun/v3"
	"github.com/pion/turn/v4"
)

const realmTurn = "shhgone"

type confTurn struct {
	secret       string
	ip           netip.Addr
	port         int
	min, max     int
	allocations  int
	parIP        int
	parNom       int
	octetsSecond int
}

// silence : journaliseur de la bibliothèque, coupé (adresses IP et noms ne sortent jamais).
func silence() logging.LoggerFactory {
	f := logging.NewDefaultLoggerFactory()
	f.DefaultLogLevel = logging.LogLevelDisabled
	f.Writer = io.Discard
	return f
}

// lireSecretTurn : même règle que le serveur Go (config.LireSecretTurn).
func lireSecretTurn(chemin string) (string, error) {
	fi, err := os.Lstat(chemin)
	if err != nil {
		return "", fmt.Errorf("SHH_TURN_SECRET_FILE illisible : %s", chemin)
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("SHH_TURN_SECRET_FILE doit être un fichier ordinaire en 0400 ou 0600 : %s", chemin)
	}
	b, err := os.ReadFile(chemin)
	if err != nil {
		return "", fmt.Errorf("SHH_TURN_SECRET_FILE illisible : %s", chemin)
	}
	s := strings.TrimRight(string(b), "\r\n")
	if len(s) < 32 || len(s) > 128 {
		return "", errors.New("SHH_TURN_SECRET_FILE : secret de 32 à 128 caractères attendu (valeur non affichée)")
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7E {
			return "", errors.New("SHH_TURN_SECRET_FILE : caractères imprimables sans espace attendus (valeur non affichée)")
		}
	}
	return s, nil
}

// publique : adresse qu'un participant peut joindre (ni privée, ni locale, ni réservée).
// 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (documentation) sont acceptées pour les tests.
func publique(a netip.Addr) bool {
	a = a.Unmap()
	return a.Is4() && a.IsGlobalUnicast() && !a.IsPrivate() &&
		!netip.MustParsePrefix("100.64.0.0/10").Contains(a) && !netip.MustParsePrefix("198.18.0.0/15").Contains(a)
}

// ipParDefaut : adresse source de la route par défaut (aucun paquet n'est envoyé).
func ipParDefaut() (netip.Addr, error) {
	c, err := net.Dial("udp4", "1.1.1.1:53")
	if err != nil {
		return netip.Addr{}, err
	}
	defer c.Close()
	ap, err := netip.ParseAddrPort(c.LocalAddr().String())
	if err != nil {
		return netip.Addr{}, err
	}
	return ap.Addr(), nil
}

func entierEnv(nom string, defaut, min, max int) (int, error) {
	v := os.Getenv(nom)
	if v == "" {
		return defaut, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s invalide (entier de %d à %d) : %q", nom, min, max, v)
	}
	return n, nil
}

func lireConfTurn(defaut func() (netip.Addr, error)) (confTurn, error) {
	var c confTurn
	var err error
	if c.secret, err = lireSecretTurn(os.Getenv("SHH_TURN_SECRET_FILE")); err != nil {
		return c, err
	}
	if v := os.Getenv("SHH_TURN_IP"); v != "" {
		if c.ip, err = netip.ParseAddr(v); err != nil || !c.ip.Is4() {
			return c, fmt.Errorf("SHH_TURN_IP invalide (adresse IPv4) : %q", v)
		}
	} else {
		if c.ip, err = defaut(); err != nil {
			return c, fmt.Errorf("adresse publique introuvable (route par défaut) : poser SHH_TURN_IP : %w", err)
		}
		// Détectée et privée : machine derrière un routeur, les participants ne la joindraient
		// pas. Donnée explicitement (SHH_TURN_IP), elle est prise telle quelle (réseau privé
		// voulu, banc d'essai).
		if !publique(c.ip) {
			return c, fmt.Errorf("adresse %s : pas une adresse publique ; machine derrière un routeur ? poser SHH_TURN_IP (adresse publique) et rediriger les ports", c.ip)
		}
	}
	if c.port, err = entierEnv("SHH_TURN_PORT", 3478, 1, 65535); err != nil {
		return c, err
	}
	plage := os.Getenv("SHH_TURN_PORTS")
	if plage == "" {
		plage = "49160-49999"
	}
	a, b, ok := strings.Cut(plage, "-")
	c.min, _ = strconv.Atoi(a)
	c.max, _ = strconv.Atoi(b)
	if !ok || c.min < 1024 || c.max > 65535 || c.max-c.min < 15 || (c.port >= c.min && c.port <= c.max) {
		return c, fmt.Errorf("SHH_TURN_PORTS invalide (début-fin, au moins 16 ports, au-dessus de 1023, sans le port d'écoute) : %q", plage)
	}
	if c.allocations, err = entierEnv("SHH_TURN_ALLOCATIONS", 60, 2, 2000); err != nil {
		return c, err
	}
	if c.parIP, err = entierEnv("SHH_TURN_PAR_IP", 24, 1, 2000); err != nil {
		return c, err
	}
	if c.parNom, err = entierEnv("SHH_TURN_PAR_NOM", 12, 1, 2000); err != nil {
		return c, err
	}
	kbps, err := entierEnv("SHH_TURN_KBPS", 2500, 100, 100000)
	if err != nil {
		return c, err
	}
	c.octetsSecond = kbps * 1000 / 8
	return c, nil
}

// --- Relais : connexion bridée et bornée ------------------------------------------------------------

// connBridee : prise relayée d'une allocation. Paquets vers une destination interdite ou au-delà
// du débit : jetés sans bruit (UDP). Débit : seau de jetons en octets, rempli au fil du temps.
type connBridee struct {
	net.PacketConn
	c        *confTurn
	compte   *atomic.Int64
	ferme    sync.Once
	mu       sync.Mutex
	jetons   float64
	dernier  time.Time
	maintien func() time.Time
}

// permis : destination joignable par le relais : une autre allocation de ce relais seulement
// (son adresse, un port de sa plage).
func (c *confTurn) permis(a netip.AddrPort) bool {
	return a.Addr().Unmap() == c.ip && int(a.Port()) >= c.min && int(a.Port()) <= c.max
}

// parOrigine : allocations vivantes par adresse d'origine (en mémoire seulement, jamais écrites ;
// une entrée disparaît avec sa dernière allocation).
type parOrigine struct {
	mu sync.Mutex
	n  map[netip.Addr]int
}

func origine(a net.Addr) netip.Addr {
	ap, err := netip.ParseAddrPort(a.String())
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}

func (p *parOrigine) nombre(a net.Addr) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.n[origine(a)]
}

func (p *parOrigine) ajouter(a net.Addr, d int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	k := origine(a)
	if p.n[k] += d; p.n[k] <= 0 {
		delete(p.n, k)
	}
}

// Close : la prise rendue, l'allocation ne compte plus.
func (b *connBridee) Close() error {
	b.ferme.Do(func() { b.compte.Add(-1) })
	return b.PacketConn.Close()
}

func (b *connBridee) WriteTo(p []byte, addr net.Addr) (int, error) {
	ap, err := netip.ParseAddrPort(addr.String())
	if err != nil || !b.c.permis(ap) {
		return len(p), nil
	}
	b.mu.Lock()
	t := b.maintien()
	if !b.dernier.IsZero() {
		b.jetons = min(float64(b.c.octetsSecond), b.jetons+t.Sub(b.dernier).Seconds()*float64(b.c.octetsSecond))
	}
	b.dernier = t
	passe := b.jetons >= float64(len(p))
	if passe {
		b.jetons -= float64(len(p))
	}
	b.mu.Unlock()
	if !passe {
		return len(p), nil
	}
	return b.PacketConn.WriteTo(p, addr)
}

// generateur : plage de ports de la bibliothèque, chaque prise enveloppée dans connBridee.
type generateur struct {
	turn.RelayAddressGeneratorPortRange
	c      *confTurn
	compte *atomic.Int64
}

var errPlein = errors.New("relais plein")

// AllocatePacketConn : refus au-delà du plafond de la machine (compté ici, et non par la
// bibliothèque : son AllocationCount n'est pas sûr entre fils d'exécution).
func (g *generateur) AllocatePacketConn(network string, requestedPort int) (net.PacketConn, net.Addr, error) {
	if g.compte.Add(1) > int64(g.c.allocations) {
		g.compte.Add(-1)
		return nil, nil, errPlein
	}
	pc, addr, err := g.RelayAddressGeneratorPortRange.AllocatePacketConn(network, requestedPort)
	if err != nil {
		g.compte.Add(-1)
		return nil, nil, err
	}
	return &connBridee{PacketConn: pc, c: g.c, compte: g.compte, jetons: float64(g.c.octetsSecond), maintien: time.Now}, addr, nil
}

// serveurTurn : écoute UDP et TCP sur ip:port ; rend le serveur (à fermer) et les écoutes.
func serveurTurn(c confTurn, ecoute string) (*turn.Server, error) {
	udp, err := net.ListenPacket("udp4", net.JoinHostPort(ecoute, strconv.Itoa(c.port)))
	if err != nil {
		return nil, err
	}
	tcp, err := net.Listen("tcp4", net.JoinHostPort(ecoute, strconv.Itoa(c.port)))
	if err != nil {
		udp.Close()
		return nil, err
	}
	compte := &atomic.Int64{}
	gen := func() *generateur {
		return &generateur{c: &c, compte: compte, RelayAddressGeneratorPortRange: turn.RelayAddressGeneratorPortRange{
			RelayAddress: net.IP(c.ip.AsSlice()), Address: ecoute, MinPort: uint16(c.min), MaxPort: uint16(c.max),
		}}
	}
	// La bibliothèque demande aussi l'avis avant chaque permission : même règle que l'envoi.
	permission := func(_ net.Addr, peer net.IP) bool {
		a, ok := netip.AddrFromSlice(peer)
		return ok && a.Unmap() == c.ip
	}
	origines := &parOrigine{n: map[netip.Addr]int{}}
	noms := &parNom{n: map[string]int{}}
	log := silence()
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm:         realmTurn,
		LoggerFactory: log,
		AuthHandler:   turn.LongTermTURNRESTAuthHandler(c.secret, log.NewLogger("turn")),
		// Plafond de toute la machine : au-delà, 486 (quota atteint), l'appel se dégrade.
		QuotaHandler: func(nom, _ string, src net.Addr) bool {
			return compte.Load() < int64(c.allocations) && origines.nombre(src) < c.parIP && noms.nombre(nom) < c.parNom
		},
		EventHandler: turn.EventHandler{
			OnAllocationCreated: func(src, _ net.Addr, _, nom, _ string, _ net.Addr, _ int) {
				origines.ajouter(src, 1)
				noms.ajouter(nom, 1)
			},
			OnAllocationDeleted: func(src, _ net.Addr, _, nom, _ string) {
				origines.ajouter(src, -1)
				noms.ajouter(nom, -1)
			},
		},
		PacketConnConfigs: []turn.PacketConnConfig{
			{PacketConn: &priseGardee{PacketConn: udp, c: &c}, RelayAddressGenerator: gen(), PermissionHandler: permission},
		},
		ListenerConfigs: []turn.ListenerConfig{
			{
				Listener:              &ecouteBornee{Listener: tcp, c: &c, max: 2 * c.allocations, parIP: c.parIP, inactif: 60 * time.Second, par: map[string]int{}},
				RelayAddressGenerator: gen(), PermissionHandler: permission,
			},
		},
	})
	if err != nil {
		udp.Close()
		tcp.Close()
		return nil, err
	}
	return srv, nil
}

func turnMain() error {
	c, err := lireConfTurn(ipParDefaut)
	if err != nil {
		return err
	}
	// Écoute sur toutes les adresses de la machine (réseau de l'hôte) : une machine louée a
	// parfois son adresse publique sur une interface et une adresse privée sur une autre.
	srv, err := serveurTurn(c, "0.0.0.0")
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "relais TURN : %s:%d, ports %d-%d\n", c.ip, c.port, c.min, c.max)
	s := make(chan os.Signal, 1)
	signal.Notify(s, syscall.SIGINT, syscall.SIGTERM)
	<-s
	return srv.Close()
}

// stunMain : contrôle d'exploitation (deploy.sh) : une requête STUN « Binding » en UDP vers
// addr doit recevoir une réponse de succès dans les 3 s. Aucun identifiant, rien d'écrit.
func stunMain(addr string) error {
	c, err := net.Dial("udp4", addr)
	if err != nil {
		return err
	}
	defer c.Close()
	req, err := stun.Build(stun.TransactionID, stun.BindingRequest)
	if err != nil {
		return err
	}
	if _, err := c.Write(req.Raw); err != nil {
		return err
	}
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 1500)
	n, err := c.Read(buf)
	if err != nil {
		return fmt.Errorf("aucune réponse STUN de %s : %w", addr, err)
	}
	var rep stun.Message
	rep.Raw = buf[:n]
	if err := rep.Decode(); err != nil || rep.Type != stun.BindingSuccess || rep.TransactionID != req.TransactionID {
		return fmt.Errorf("réponse STUN inattendue de %s", addr)
	}
	return nil
}

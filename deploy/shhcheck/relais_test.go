package main

// Tests du relais de sortie (shhcheck relais : relais des prestataires de paiement, d'abord
// écrit pour le relais SMTP du compte par e-mail, retiré) et du contrôle shhcheck joindre.
// Boucle locale seulement ; rien n'est écrit sur disque.

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// cibleEcho : serveur TCP qui renvoie ce qu'il reçoit ; compte les connexions reçues.
func cibleEcho(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	n := new(atomic.Int32)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			n.Add(1)
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()
	return ln.Addr().String(), n
}

// lancer : relais vers cible sur un port libre de la boucle locale.
func lancer(t *testing.T, r *relais) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go r.servir(ln)
	return ln.Addr().String()
}

func nouveau(t *testing.T, cible string) *relais {
	t.Helper()
	r, err := nouveauRelais(cible)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// fermeVite : la connexion est fermée par le relais avant la limite (lecture : EOF ou erreur).
func fermeVite(t *testing.T, c net.Conn, limite time.Duration) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(limite))
	var b [1]byte
	_, err := c.Read(b[:])
	if err == nil {
		t.Fatal("octet reçu, fermeture attendue")
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("connexion encore ouverte après %v", limite)
	}
}

func TestRelaisTransmet(t *testing.T) {
	cible, n := cibleEcho(t)
	a := lancer(t, nouveau(t, cible))
	for i := 0; i < 3; i++ {
		c, err := net.Dial("tcp", a)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := c.Write([]byte("EHLO localhost\r\n")); err != nil {
			t.Fatal(err)
		}
		c.SetReadDeadline(time.Now().Add(3 * time.Second))
		l, err := bufio.NewReader(c).ReadString('\n')
		if err != nil || l != "EHLO localhost\r\n" {
			t.Fatalf("reçu %q, %v", l, err)
		}
		c.Close()
	}
	if got := n.Load(); got != 3 {
		t.Fatalf("%d connexions à la cible, 3 attendues", got)
	}
}

// Le client ne choisit rien : quoi qu'il envoie (ici l'adresse d'un autre serveur, comme un
// CONNECT), seule la cible fixée au démarrage reçoit une connexion.
func TestRelaisCibleFixe(t *testing.T) {
	cible, n := cibleEcho(t)
	leurre, nLeurre := cibleEcho(t)
	a := lancer(t, nouveau(t, cible))
	c, err := net.Dial("tcp", a)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte("CONNECT " + leurre + " HTTP/1.1\r\n\r\n"))
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if l, err := bufio.NewReader(c).ReadString('\n'); err != nil || !strings.HasPrefix(l, "CONNECT ") {
		t.Fatalf("reçu %q, %v", l, err)
	}
	if n.Load() != 1 || nLeurre.Load() != 0 {
		t.Fatalf("cible %d, leurre %d : 1 et 0 attendus", n.Load(), nLeurre.Load())
	}
}

func TestRelaisConfiguration(t *testing.T) {
	for _, c := range []string{"", ":465", "smtp.example.com:", "smtp.example.com", "smtp.example.com:0",
		"smtp.example.com:70000", "smtp.example.com:46a", "SMTP.example.com:465", "smtp example.com:465",
		"-smtp.example.com:465", "smtp..example.com:465", "smtp.example.com:465/x", "[::1%eth0]:465"} {
		if _, err := nouveauRelais(c); err == nil {
			t.Errorf("cible %q acceptée", c)
		}
	}
	for _, c := range []string{"smtp.example.com:465", "192.0.2.1:587", "[2001:db8::1]:465", "localhost:2525"} {
		if _, err := nouveauRelais(c); err != nil {
			t.Errorf("cible %q refusée : %v", c, err)
		}
	}
	for _, e := range []string{"", "0.0.0.0", "relais:465", "172.30.53.3:x"} {
		if _, err := ecouteValide(e); err == nil {
			t.Errorf("écoute %q acceptée", e)
		}
	}
	if _, err := ecouteValide("172.30.53.3:465"); err != nil {
		t.Error(err)
	}
	for v, n := range map[string]int{"": 4, "1": 1, "16": 16, "64": 64} {
		if got, err := maxDe(v); err != nil || got != n {
			t.Errorf("plafond %q : %d, %v (%d attendu)", v, got, err, n)
		}
	}
	for _, v := range []string{"0", "65", "-1", "016", "x", " 4", "4 "} {
		if _, err := maxDe(v); err == nil {
			t.Errorf("plafond %q accepté", v)
		}
	}
}

// Au-delà du plafond de connexions simultanées, la connexion est fermée tout de suite, sans
// connexion à la cible.
func TestRelaisPlafond(t *testing.T) {
	cible, n := cibleEcho(t)
	r := nouveau(t, cible)
	r.max = 2
	a := lancer(t, r)
	var tenues []net.Conn
	for i := 0; i < 2; i++ {
		c, err := net.Dial("tcp", a)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		c.Write([]byte("x\n"))
		c.SetReadDeadline(time.Now().Add(3 * time.Second))
		if _, err := bufio.NewReader(c).ReadString('\n'); err != nil {
			t.Fatal(err)
		}
		tenues = append(tenues, c)
	}
	c, err := net.Dial("tcp", a)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fermeVite(t, c, 2*time.Second)
	if got := n.Load(); got != 2 {
		t.Fatalf("%d connexions à la cible, 2 attendues", got)
	}
	// Une place libérée resert.
	tenues[0].Close()
	time.Sleep(100 * time.Millisecond)
	c2, err := net.Dial("tcp", a)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	c2.Write([]byte("y\n"))
	c2.SetReadDeadline(time.Now().Add(3 * time.Second))
	if l, err := bufio.NewReader(c2).ReadString('\n'); err != nil || l != "y\n" {
		t.Fatalf("après libération : %q, %v", l, err)
	}
}

func TestRelaisDureeMax(t *testing.T) {
	cible, _ := cibleEcho(t)
	r := nouveau(t, cible)
	r.duree = 300 * time.Millisecond
	a := lancer(t, r)
	c, err := net.Dial("tcp", a)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	debut := time.Now()
	fermeVite(t, c, 3*time.Second)
	if d := time.Since(debut); d < 250*time.Millisecond {
		t.Fatalf("fermée après %v, avant la durée maximale", d)
	}
}

func TestRelaisCibleInjoignable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ferme := ln.Addr().String()
	ln.Close()
	a := lancer(t, nouveau(t, ferme))
	c, err := net.Dial("tcp", a)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fermeVite(t, c, 3*time.Second)
}

// Fermeture par le client : la connexion vers la cible est fermée aussi.
func TestRelaisFermeLesDeuxCotes(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	fin := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			fin <- err
			return
		}
		defer c.Close()
		c.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, err = io.Copy(io.Discard, c)
		fin <- err
	}()
	a := lancer(t, nouveau(t, ln.Addr().String()))
	c, err := net.Dial("tcp", a)
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("QUIT\r\n"))
	time.Sleep(100 * time.Millisecond)
	c.Close()
	if err := <-fin; err != nil {
		t.Fatalf("côté cible : %v (fermeture attendue)", err)
	}
}

// certificat : autorité et certificat de serveur pour nom (ECDSA P-256), pour un faux serveur TLS.
func certificat(t *testing.T, nom string) (*x509.CertPool, tls.Certificate) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: nom}, DNSNames: []string{nom},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(c)
	return pool, tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}
}

// fauxSMTP : faux serveur TLS (ou en clair si cert est nil) : envoie accueil, puis lit une ligne. Rend l'adresse et un
// canal qui reçoit la ligne lue après l'accueil.
func fauxSMTP(t *testing.T, cert *tls.Certificate, accueil string) (string, chan string) {
	t.Helper()
	var ln net.Listener
	var err error
	if cert != nil {
		ln, err = tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{*cert}})
	} else {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	lu := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(3 * time.Second))
		c.Write([]byte(accueil))
		l, _ := bufio.NewReader(c).ReadString('\n')
		lu <- l
	}()
	return ln.Addr().String(), lu
}

func TestJoignable(t *testing.T) {
	pool, cert := certificat(t, "api.essai.test")
	a, _ := fauxSMTP(t, &cert, "")
	if err := joignable(a, "api.essai.test", pool); err != nil {
		t.Fatal(err)
	}
}

func TestJoignableRefus(t *testing.T) {
	pool, cert := certificat(t, "api.essai.test")
	cas := []struct {
		nom string
		tls bool
	}{
		{"autre nom", true},       // certificat pour un autre nom
		{"api.essai.test", false}, // pas de TLS
	}
	for _, c := range cas {
		var a string
		if c.tls {
			a, _ = fauxSMTP(t, &cert, "")
		} else {
			a, _ = fauxSMTP(t, nil, "HTTP/1.1 400 en clair\r\n")
		}
		if err := joignable(a, c.nom, pool); err == nil {
			t.Errorf("%s / TLS %v : accepté", c.nom, c.tls)
		}
	}
	// Autorités du système : le certificat de test n'y est pas.
	a, _ := fauxSMTP(t, &cert, "")
	if err := joignable(a, "api.essai.test", nil); err == nil {
		t.Error("certificat inconnu accepté")
	}
}

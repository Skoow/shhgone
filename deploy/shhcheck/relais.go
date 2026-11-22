package main

// Relais de sortie (conception du paiement §4, S1 ; d'abord écrit pour le relais SMTP du compte
// par e-mail, retiré le 22 novembre) : les seules sorties du serveur Go vers Internet, une par
// cible (API des trois prestataires de paiement). Le serveur reste sur le réseau Docker interne
// (aucune route vers Internet) ; son /etc/hosts fait pointer le nom de l'API vers ce relais, qui
// recopie les octets, dans les deux sens, vers une seule cible fixée au démarrage (hôte:port).
// Le client ne choisit rien : quoi qu'il envoie, la connexion part vers cette cible. TLS est de
// bout en bout entre le serveur Go et le prestataire (certificat vérifié pour ce nom par le
// serveur) : le relais ne voit que des octets chiffrés. Il n'écrit rien (ni journal, ni
// adresse), sauf un refus de démarrer.

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

type relais struct {
	cible string        // hôte:port du fournisseur, résolu à chaque connexion (adresses qui changent)
	max   int           // connexions simultanées au plus ; au-delà, fermées aussitôt
	duree time.Duration // durée de vie maximale d'une connexion (le serveur coupe à 20 s)
	dial  time.Duration // délai de connexion à la cible
}

// nouveauRelais : cible « hôte:port », hôte en minuscules ([a-z0-9-], étiquettes non vides,
// sans tiret en bord) ou adresse IP sans zone, port 1 à 65535.
func nouveauRelais(cible string) (*relais, error) {
	h, p, err := net.SplitHostPort(cible)
	if err != nil || h == "" {
		return nil, fmt.Errorf("cible du relais invalide (hôte:port) : %q", cible)
	}
	if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != p {
		return nil, fmt.Errorf("port de la cible invalide : %q", cible)
	}
	if !hoteValide(h) {
		return nil, fmt.Errorf("hôte de la cible invalide (minuscules, sans espace) : %q", cible)
	}
	return &relais{cible: cible, max: 4, duree: 60 * time.Second, dial: 10 * time.Second}, nil
}

func hoteValide(h string) bool {
	if a, err := netip.ParseAddr(h); err == nil {
		return a.Zone() == ""
	}
	if len(h) > 253 {
		return false
	}
	for _, l := range strings.Split(h, ".") {
		if l == "" || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for i := 0; i < len(l); i++ {
			if b := l[i]; (b < 'a' || b > 'z') && (b < '0' || b > '9') && b != '-' {
				return false
			}
		}
	}
	return true
}

// ecouteValide : adresse IP littérale et port (jamais toutes les interfaces : le relais n'écoute
// que sur le réseau interne).
func ecouteValide(e string) (string, error) {
	h, p, err := net.SplitHostPort(e)
	if err == nil {
		var a netip.Addr
		if a, err = netip.ParseAddr(h); err == nil && !a.IsUnspecified() {
			if n, err := strconv.Atoi(p); err == nil && n >= 1 && n <= 65535 {
				return e, nil
			}
		}
	}
	return "", fmt.Errorf("adresse d'écoute invalide (IP:port, une seule interface) : %q", e)
}

// servir : boucle d'acceptation, jusqu'à la fermeture de ln.
func (r *relais) servir(ln net.Listener) error {
	places := make(chan struct{}, r.max)
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			time.Sleep(50 * time.Millisecond) // trop de descripteurs, par exemple
			continue
		}
		select {
		case places <- struct{}{}:
			go func() {
				defer func() { <-places }()
				r.relayer(c)
			}()
		default:
			c.Close()
		}
	}
}

// relayer : une connexion, recopiée vers la cible jusqu'à la première fermeture d'un côté ou
// la durée maximale ; les deux côtés sont alors fermés.
func (r *relais) relayer(c net.Conn) {
	defer c.Close()
	fin := time.Now().Add(r.duree)
	d := net.Dialer{Timeout: r.dial, Deadline: fin}
	u, err := d.Dial("tcp", r.cible)
	if err != nil {
		return
	}
	defer u.Close()
	c.SetDeadline(fin)
	u.SetDeadline(fin)
	var une sync.Once
	fermer := func() { une.Do(func() { c.Close(); u.Close() }) }
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); io.Copy(u, c); fermer() }()
	go func() { defer wg.Done(); io.Copy(c, u); fermer() }()
	wg.Wait()
}

// maxDe : plafond de connexions simultanées donné en argument (1 à 64) ; "" : 4, celui du SMTP.
func maxDe(v string) (int, error) {
	if v == "" {
		return 4, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > 64 || strconv.Itoa(n) != v {
		return 0, fmt.Errorf("plafond de connexions invalide (1 à 64) : %q", v)
	}
	return n, nil
}

func relaisMain(ecoute, cible, max string) error {
	e, err := ecouteValide(ecoute)
	if err != nil {
		return err
	}
	r, err := nouveauRelais(cible)
	if err != nil {
		return err
	}
	if r.max, err = maxDe(max); err != nil {
		return err
	}
	ln, err := net.Listen("tcp", e)
	if err != nil {
		return err
	}
	return r.servir(ln)
}

// joignable : contrôle d'exploitation (test-sortie.sh) : TLS vers addr, certificat valide pour
// nom (autorités : roots, ou celles du système si nil) ; poignée de main seulement, rien
// d'autre n'est envoyé. Sert à prouver qu'une API n'est joignable qu'à travers son relais.
func joignable(addr, nom string, roots *x509.CertPool) error {
	d := &net.Dialer{Timeout: 5 * time.Second}
	c, err := tls.DialWithDialer(d, "tcp", addr, &tls.Config{ServerName: nom, MinVersion: tls.VersionTLS12, RootCAs: roots})
	if err != nil {
		return err
	}
	return c.Close()
}

func joindreMain(addr string) error {
	h, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if err := joignable(addr, h, nil); err != nil {
		return err
	}
	fmt.Printf("joignable en TLS vérifié : %s\n", addr)
	return nil
}

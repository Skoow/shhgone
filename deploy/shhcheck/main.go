// Commande shhcheck : contrôles pour l'exploitation, relais de sortie (bibliothèque standard
// seulement) et relais TURN des appels (turn.go, seule dépendance : pion/turn).
//
//	shhcheck health [hôte:port]
//	    Santé du serveur Go, de l'intérieur du conteneur (l'image n'a ni shell ni curl) :
//	    GET http://127.0.0.1:8080/healthz doit rendre 200 et "ok":true. /healthz ne répond
//	    qu'à la boucle locale, sans X-Shh-Client-IP (spec §8). La réponse est recopiée sur
//	    la sortie standard (elle contient aussi le booléen reports_alert, spec §15.2).
//
//	shhcheck tls <hôte:port> <nom du site>
//	    Test bloquant de la spec §30 : un client qui ne propose que X25519MLKEM768, en
//	    TLS 1.3, doit réussir la poignée de main avec un certificat valide pour ce nom.
//	    Autorités : celles du système, ou le fichier désigné par SSL_CERT_FILE.
//
//	shhcheck relais <écoute IP:port> <cible hôte:port> [connexions]
//	    Relais de sortie, seules sorties du serveur Go vers Internet (API des prestataires de
//	    paiement) : recopie chaque connexion reçue vers la seule cible fixée ici (relais.go), au
//	    plus [connexions] à la fois (1 à 64, 4 par défaut). Ne rend la main qu'en cas d'erreur.
//
//	shhcheck joindre <hôte:port>
//	    Contrôle d'exploitation : poignée de main TLS vers hôte:port, certificat valide pour hôte,
//	    rien d'autre n'est envoyé. Lancé dans le conteneur du serveur (deploy/test-sortie.sh), il
//	    prouve qu'une API n'est joignable qu'à travers son relais.
//
//	shhcheck turn
//	    Relais TURN des appels audio et vidéo du salon (turn.go) ; réglages par l'environnement.
//
//	shhcheck stun <hôte:port>
//	    Contrôle d'exploitation : le relais répond à une requête STUN « Binding » (UDP).
//
// Codes de sortie : 0 réussite, 1 échec, 2 erreur d'usage. Rien n'est écrit sur disque.
package main

import (
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	if len(os.Args) >= 2 {
		switch {
		case os.Args[1] == "health" && len(os.Args) <= 3:
			addr := "127.0.0.1:8080"
			if len(os.Args) == 3 {
				addr = os.Args[2]
			}
			exit(health(addr))
		case os.Args[1] == "tls" && len(os.Args) == 4:
			exit(tlsHybrid(os.Args[2], os.Args[3]))
		case os.Args[1] == "relais" && len(os.Args) == 4:
			exit(relaisMain(os.Args[2], os.Args[3], ""))
		case os.Args[1] == "relais" && len(os.Args) == 5:
			exit(relaisMain(os.Args[2], os.Args[3], os.Args[4]))
		case os.Args[1] == "turn" && len(os.Args) == 2:
			exit(turnMain())
		case os.Args[1] == "stun" && len(os.Args) == 3:
			exit(stunMain(os.Args[2]))
		case os.Args[1] == "joindre" && len(os.Args) == 3:
			exit(joindreMain(os.Args[2]))
		}
	}
	fmt.Fprintln(os.Stderr, "usage: shhcheck health [hôte:port] | shhcheck tls <hôte:port> <nom du site>\n"+
		"       shhcheck relais <écoute IP:port> <cible hôte:port> [connexions] | shhcheck joindre <hôte:port>\n"+
		"       shhcheck turn")
	os.Exit(2)
}

func exit(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "échec:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func health(addr string) error {
	// Proxy : nil. Jamais de variable HTTP_PROXY ici : la requête doit rester locale.
	c := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"ok":true`)) {
		return fmt.Errorf("/healthz : statut %d", resp.StatusCode)
	}
	_, err = os.Stdout.Write(append(bytes.TrimSpace(body), '\n'))
	return err
}

func tlsHybrid(addr, name string) error {
	d := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := tls.DialWithDialer(d, "tcp", addr, &tls.Config{
		ServerName:       name,
		MinVersion:       tls.VersionTLS13,
		CurvePreferences: []tls.CurveID{tls.X25519MLKEM768},
	})
	if err != nil {
		return err
	}
	defer conn.Close()
	st := conn.ConnectionState()
	if st.Version != tls.VersionTLS13 || st.CurveID != tls.X25519MLKEM768 {
		return fmt.Errorf("échange de clés inattendu : %s, %s", tls.VersionName(st.Version), st.CurveID)
	}
	fmt.Printf("%s, %s\n", tls.VersionName(st.Version), st.CurveID)
	return nil
}

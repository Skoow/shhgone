package paiement

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"time"
)

// Seul client HTTP sortant du paiement (conception §4 ; exemption écrite dans
// server/internal/stats_test.go, TestNoOutgoingHTTP). Créé seulement avec SHH_PAIEMENT=1
// (TestClientSeulementAvecPaiement) : sans lui, aucune connexion sortante. Les adresses des API
// sont fixées par chaque prestataire (production ou bac à sable), jamais lues dans
// l'environnement.
//
// Délai total de 20 s ; aucune redirection suivie ; réponse lue jusqu'à 1 Mio ; aucune donnée
// personnelle envoyée ; User-Agent fixe « Shhgone », sans version.

const (
	delaiAppel  = 20 * time.Second
	maxReponse  = 1 << 20
	agentClient = "Shhgone"
)

// Client : appels HTTPS vers les prestataires.
type Client struct{ c *http.Client }

// NouveauClient : client des prestataires (certificats racine du système, TLS vérifié).
func NouveauClient() *Client {
	return &Client{c: &http.Client{
		Timeout: delaiAppel,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			Proxy:             nil, // aucune variable HTTPS_PROXY : la sortie est fixée par le déploiement
			ForceAttemptHTTP2: true,
			// Une connexion par appel : en production, chaque connexion passe par un relais de
			// sortie qui la coupe au bout de 60 s (deploy/compose.yaml) ; une connexion gardée
			// ouverte pourrait être coupée au milieu d'un POST (création de paiement). Le
			// volume d'appels est faible : une poignée de main TLS par appel suffit.
			DisableKeepAlives:     true,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: delaiAppel,
		},
	}}
}

// requete : un appel ; corps déjà encodé.
type requete struct {
	methode string
	url     string
	entetes [][2]string
	corps   []byte
}

// reponse : statut et corps (≤ 1 Mio).
type reponse struct {
	statut int
	corps  []byte
}

var errReponseTropGrande = errors.New("réponse du prestataire trop grande")

func (c *Client) faire(ctx context.Context, r requete) (reponse, error) {
	var body io.Reader
	if r.corps != nil {
		body = bytes.NewReader(r.corps)
	}
	req, err := http.NewRequestWithContext(ctx, r.methode, r.url, body)
	if err != nil {
		return reponse{}, err
	}
	req.Header.Set("User-Agent", agentClient)
	for _, h := range r.entetes {
		req.Header.Set(h[0], h[1])
	}
	res, err := c.c.Do(req)
	if err != nil {
		return reponse{}, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxReponse+1))
	if err != nil {
		return reponse{}, err
	}
	if len(b) > maxReponse {
		return reponse{}, errReponseTropGrande
	}
	return reponse{statut: res.StatusCode, corps: b}, nil
}

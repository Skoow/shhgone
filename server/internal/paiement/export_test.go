package paiement

import "net/http"

// clientTest : client des tests (faux serveur httptest, son propre transport).
func clientTest(c *http.Client) *Client { return &Client{c: c} }

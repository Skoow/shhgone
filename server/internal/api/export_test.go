package api

import (
	"net/http"
	"net/netip"

	"github.com/skoow/shhdrop/server/internal/captcha"
	"github.com/skoow/shhdrop/server/internal/limits"
	"github.com/skoow/shhdrop/server/internal/share"
	"github.com/skoow/shhdrop/server/internal/token"
)

func defaultTransfers() transfers { return transfersFor(Capacity{}) }

func newServer(svc *share.Service, sig *token.Signer, lim *limits.Limiter, capt *captcha.Captcha,
	behindProxy bool, proxies []netip.Prefix) *server {
	return newServerCap(svc, sig, lim, capt, behindProxy, proxies, Capacity{})
}

// ClientIP : adresse du client seule (clientIP).
func ClientIP(r *http.Request, proxies []netip.Prefix) netip.Addr {
	a, _, _ := clientIP(r, proxies)
	return a
}

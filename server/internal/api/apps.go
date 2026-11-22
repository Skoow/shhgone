package api

import (
	"encoding/json"
	"net/http"
)

// Fichiers d'association des apps natives (conception du compte par passkey §6.5, §10.1) : ils
// permettent à l'app iOS (webcredentials) et à l'app Android (get_login_creds) d'utiliser les
// passkeys du site. Construits depuis la configuration, servis seulement s'ils sont configurés
// (sinon le chemin commence par « . » et le site répond 404 comme pour toute page inconnue) ;
// application/json, sans redirection. Ils ne disent rien des personnes : Apple et Google les
// lisent depuis leurs propres serveurs.

// Apps : contenu JSON des deux fichiers (nil : non servi).
type Apps struct {
	AASA       []byte
	AssetLinks []byte
}

// NouvellesApps : fichiers d'association pour ces identifiants Apple (TEAMID.id) et ce paquet
// Android avec ses empreintes SHA-256 (« AA:BB:… »), formes vérifiées par config.
func NouvellesApps(apple []string, paquet string, empreintes []string) Apps {
	var a Apps
	if len(apple) > 0 {
		a.AASA, _ = json.Marshal(map[string]any{"webcredentials": map[string]any{"apps": apple}})
	}
	if paquet != "" && len(empreintes) > 0 {
		a.AssetLinks, _ = json.Marshal([]any{map[string]any{
			"relation": []string{"delegate_permission/common.get_login_creds"},
			"target":   map[string]any{"namespace": "android_app", "package_name": paquet, "sha256_cert_fingerprints": empreintes},
		}})
	}
	return a
}

// routesApps : GET des fichiers configurés, sur le multiplexeur racine (hors de /api).
func routesApps(root *http.ServeMux, a Apps) {
	for _, f := range []struct {
		chemin string
		corps  []byte
	}{{"/.well-known/apple-app-site-association", a.AASA}, {"/.well-known/assetlinks.json", a.AssetLinks}} {
		if f.corps == nil {
			continue
		}
		corps := f.corps
		root.HandleFunc("GET "+f.chemin, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write(corps)
		})
	}
}

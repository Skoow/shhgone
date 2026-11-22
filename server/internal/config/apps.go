package config

import (
	"fmt"
	"os"
	"regexp"
	"strings"
)

// appsFromEnv : identifiants des apps natives (plus tard, conception du compte par passkey §6.5,
// §10.1), pour les fichiers d'association que le site sert (/.well-known/apple-app-site-association,
// /.well-known/assetlinks.json) : sans eux, ces chemins répondent 404 comme une page inconnue.
// Vides par défaut ; vérifiés même compte désactivé.
//
//   - SHH_APPLE_APP_IDS : « TEAMID.identifiant.de.l.app », séparés par des virgules (TEAMID : 10
//     caractères A-Z0-9) ;
//   - SHH_ANDROID_APP_PACKAGE : nom du paquet Android (com.exemple.app) ;
//   - SHH_ANDROID_APP_SHA256 : empreintes SHA-256 du certificat de signature, « AA:BB:… » (32
//     octets en hexadécimal majuscule séparés par « : »), séparées par des virgules ; exigé avec
//     le paquet, et l'inverse.
func appsFromEnv(c *Config) error {
	if v := os.Getenv("SHH_APPLE_APP_IDS"); v != "" {
		for _, id := range strings.Split(v, ",") {
			if !appleIDRe.MatchString(id) {
				return fmt.Errorf("SHH_APPLE_APP_IDS invalide (TEAMID.identifiant, séparés par des virgules): %q", id)
			}
			c.AppleAppIDs = append(c.AppleAppIDs, id)
		}
	}
	c.AndroidPaquet = os.Getenv("SHH_ANDROID_APP_PACKAGE")
	if c.AndroidPaquet != "" && !paquetRe.MatchString(c.AndroidPaquet) {
		return fmt.Errorf("SHH_ANDROID_APP_PACKAGE invalide (com.exemple.app): %q", c.AndroidPaquet)
	}
	if v := os.Getenv("SHH_ANDROID_APP_SHA256"); v != "" {
		for _, fp := range strings.Split(v, ",") {
			if !empreinteRe.MatchString(fp) {
				return fmt.Errorf("SHH_ANDROID_APP_SHA256 invalide (32 octets « AA:BB:… » en majuscules): %q", fp)
			}
			c.AndroidEmpreintes = append(c.AndroidEmpreintes, fp)
		}
	}
	if (c.AndroidPaquet == "") != (len(c.AndroidEmpreintes) == 0) {
		return fmt.Errorf("SHH_ANDROID_APP_PACKAGE et SHH_ANDROID_APP_SHA256 vont ensemble")
	}
	return nil
}

var (
	appleIDRe   = regexp.MustCompile(`^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$`)
	paquetRe    = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`)
	empreinteRe = regexp.MustCompile(`^[0-9A-F]{2}(:[0-9A-F]{2}){31}$`)
)

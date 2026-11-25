package config

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Appels audio et vidéo du salon (conception des appels) : le média passe toujours
// par le relais TURN de notre image (deploy/shhcheck/turn.go), jamais en direct entre participants. Le
// serveur ne relaie rien lui-même : il donne à un membre des identifiants temporaires, calculés
// avec le secret partagé du relais.
//
//   - SHH_TURN_URLS : adresses du relais, séparées par des virgules, 4 au plus
//     (ex. « turn:turn.shhgone.com:3478?transport=udp,turns:turn.shhgone.com:5349?transport=tcp ») ;
//   - SHH_TURN_SECRET_FILE : fichier du secret partagé avec le relais (deploy.sh le crée), 32 à
//     128 octets imprimables sur une ligne, 0400 ou 0600, hors de SHH_DATA_DIR.
//
// Les deux ou aucune ; exigent SHH_SALONS=1. Sans elles : aucun appel (aucune route).

var turnURL = regexp.MustCompile(`^turns?:[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?(\?transport=(udp|tcp))?$`)

const turnURLsMax = 4

func appelsFromEnv(c *Config) error {
	var err error
	if c.TurnSecretFile, err = secretFile("SHH_TURN_SECRET_FILE", c.DataDir); err != nil {
		return err
	}
	if v := os.Getenv("SHH_TURN_URLS"); v != "" {
		us := strings.Split(v, ",")
		if len(us) > turnURLsMax {
			return fmt.Errorf("SHH_TURN_URLS : %d adresses au plus", turnURLsMax)
		}
		for _, u := range us {
			if !turnURL.MatchString(u) {
				return fmt.Errorf("SHH_TURN_URLS invalide (turn:hôte[:port][?transport=udp|tcp] ou turns:…, en minuscules, "+
					"séparées par des virgules sans espace): %q", u)
			}
		}
		c.TurnURLs = us
	}
	if (len(c.TurnURLs) == 0) != (c.TurnSecretFile == "") {
		return errors.New("SHH_TURN_URLS et SHH_TURN_SECRET_FILE vont ensemble (les deux, ou aucune : pas d'appels)")
	}
	if len(c.TurnURLs) != 0 && !c.Salons {
		return errors.New("SHH_TURN_URLS exige SHH_SALONS=1 (les appels sont ceux du salon)")
	}
	return nil
}

// LireSecretTurn : secret partagé du relais lu dans le fichier (une ligne ; le saut de ligne
// final est retiré). Refusé : lien symbolique, fichier lisible par d'autres que son
// propriétaire, moins de 32 ou plus de 128 octets, caractère non imprimable (le relais lit ce
// secret dans un fichier texte). Le message ne cite jamais le contenu.
func LireSecretTurn(chemin string) ([]byte, error) {
	fi, err := os.Lstat(chemin)
	if err != nil {
		return nil, fmt.Errorf("SHH_TURN_SECRET_FILE illisible : %s", chemin)
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("SHH_TURN_SECRET_FILE doit être un fichier ordinaire en 0400 ou 0600 : %s", chemin)
	}
	b, err := os.ReadFile(chemin)
	if err != nil {
		return nil, fmt.Errorf("SHH_TURN_SECRET_FILE illisible : %s", chemin)
	}
	b = []byte(strings.TrimRight(string(b), "\r\n"))
	if len(b) < 32 || len(b) > 128 {
		return nil, errors.New("SHH_TURN_SECRET_FILE : secret de 32 à 128 caractères attendu (valeur non affichée)")
	}
	for _, x := range b {
		if x < 0x21 || x > 0x7E {
			return nil, errors.New("SHH_TURN_SECRET_FILE : caractères imprimables sans espace attendus (valeur non affichée)")
		}
	}
	return b, nil
}

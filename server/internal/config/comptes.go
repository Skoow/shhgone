package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// comptesFromEnv : SHH_COMPTES et ses variables (conception du compte par passkey §6.2, §7.2,
// §17). Une valeur posée est vérifiée même compte désactivé (erreur visible au démarrage, comme
// SHH_SALONS_MAX) ; les variables obligatoires ne le sont qu'avec SHH_COMPTES=1. Aucun fichier
// n'est lu ici : la clé est lue par compte.LireCles.
func comptesFromEnv(c *Config) error {
	if err := sansEmail(); err != nil {
		return err
	}
	switch v := os.Getenv("SHH_COMPTES"); v {
	case "", "0":
	case "1":
		c.Comptes = true
	default:
		return fmt.Errorf("SHH_COMPTES invalide (0 ou 1): %q", v)
	}
	if v := os.Getenv("SHH_COMPTES_MAX"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || !digits(v) || v[0] == '0' || n < 1 || n > 1000000 {
			return fmt.Errorf("SHH_COMPTES_MAX invalide (entier de 1 à 1000000): %q", v)
		}
		c.ComptesMax = n
	}
	if v := os.Getenv("SHH_COMPTES_JOUR"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || !digits(v) || v[0] == '0' || n < 1 || n > 100000 {
			return fmt.Errorf("SHH_COMPTES_JOUR invalide (entier de 1 à 100000, comptes créés par jour): %q", v)
		}
		c.ComptesJour = n
	}
	if v := os.Getenv("SHH_WEBAUTHN_ORIGINES_APPS"); v != "" {
		for _, o := range strings.Split(v, ",") {
			if !origineAndroidOK(o) {
				return fmt.Errorf("SHH_WEBAUTHN_ORIGINES_APPS invalide (android:apk-key-hash:<43 caractères base64url>, séparées par des virgules, sans espace): %q", o)
			}
			c.WebAuthnOriginesApps = append(c.WebAuthnOriginesApps, o)
		}
	}
	var err error
	if c.ComptesCleFile, err = secretFile("SHH_COMPTES_CLE_FILE", c.DataDir); err != nil {
		return err
	}
	if !c.Comptes {
		return nil
	}
	switch {
	case !c.Salons:
		return errors.New("SHH_COMPTES=1 exige SHH_SALONS=1 (le compte ne sert qu'à créer des salons)")
	case c.ComptesCleFile == "":
		return errors.New("SHH_COMPTES=1 exige SHH_COMPTES_CLE_FILE (fichier de 32 octets aléatoires, 0400 ou 0600, hors de SHH_DATA_DIR)")
	}
	// rp.id de WebAuthn = hôte de SHH_ORIGIN (exigée par SHH_SALONS=1) : les navigateurs refusent
	// une adresse IP comme rp.id (conception du compte par passkey §17) ; les tests du compte
	// tournent sur localhost.
	if h := RPID(c.Origin); h == "" {
		return fmt.Errorf("SHH_COMPTES=1 : l'hôte de SHH_ORIGIN (%q) est l'identifiant des passkeys (rp.id) ; "+
			"une adresse IP ne peut pas l'être (localhost pour les tests)", c.Origin)
	}
	return nil
}

// RPID : hôte de l'origine (sans port), ou "" si c'est une adresse IP ou une origine vide. C'est
// l'identifiant WebAuthn des passkeys : le changer les rend toutes inutilisables.
func RPID(origin string) string {
	_, hp, ok := strings.Cut(origin, "://")
	if !ok || hp == "" {
		return ""
	}
	h := hp
	if i := strings.LastIndexByte(hp, ':'); i >= 0 {
		h = hp[:i]
	}
	if _, err := netip.ParseAddr(h); err == nil || h == "" {
		return ""
	}
	return h
}

// origineAndroidOK : android:apk-key-hash: suivi de l'empreinte SHA-256 du certificat de
// signature de l'app, en base64url sans bourrage (43 caractères, forme canonique).
func origineAndroidOK(o string) bool {
	h, ok := strings.CutPrefix(o, "android:apk-key-hash:")
	if !ok || len(h) != 43 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(h)
	return err == nil && len(b) == 32 && base64.RawURLEncoding.EncodeToString(b) == h
}

// sansEmail : le compte par e-mail a été retiré (conception du compte par passkey
// §8, §17) ; une ancienne variable d'envoi d'e-mails encore posée fait refuser le démarrage
// (jamais ignorée en silence : elle désigne un secret qui traîne ou un déploiement ancien).
func sansEmail() error {
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if v != "" && (strings.HasPrefix(k, "SHH_SMTP_") || k == "SHH_MAIL_FROM") {
			return fmt.Errorf("%s : le compte par e-mail a été retiré le 22 novembre (compte par passkey) ; "+
				"ôter cette variable (et le secret qu'elle désigne)", k)
		}
	}
	return nil
}

// secretFile : chemin absolu d'un fichier secret, hors de SHH_DATA_DIR (comparaison sur les
// chemins nettoyés ; les liens symboliques ne sont pas suivis) : le dossier de données est
// sauvegardé et peut être copié, la clé doit rester à part (conception §5.2, §21.13).
func secretFile(name, dataDir string) (string, error) {
	p, err := absDir(name, os.Getenv(name))
	if err != nil || p == "" {
		return p, err
	}
	if rel, err := filepath.Rel(dataDir, p); err == nil && rel != ".." && !strings.HasPrefix(rel, "../") {
		return "", fmt.Errorf("%s doit être hors de SHH_DATA_DIR : %q", name, p)
	}
	return p, nil
}

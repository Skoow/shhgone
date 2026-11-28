package paiement

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// LireSecret : contenu d'un fichier secret (clé d'API, secret de webhook), comme la clé du
// compte : fichier ordinaire, droits 0400 ou 0600, 1 à 1 024 octets ASCII imprimables sans
// espace, saut de ligne final retiré. Messages : nom de la variable et chemin, jamais la valeur.
func LireSecret(nom, chemin string) (string, error) {
	f, err := os.Open(chemin)
	if err != nil {
		return "", fmt.Errorf("%s %s illisible", nom, chemin)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return "", fmt.Errorf("%s %s : fichier ordinaire attendu", nom, chemin)
	}
	if st.Mode().Perm()&^0o600 != 0 {
		return "", fmt.Errorf("%s %s : droits %o, attendu 0400 ou 0600 (chmod 0400)", nom, chemin, st.Mode().Perm())
	}
	b, err := io.ReadAll(io.LimitReader(f, 1026))
	if err != nil {
		return "", fmt.Errorf("%s %s illisible", nom, chemin)
	}
	s := strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
	clear(b)
	if s == "" || len(s) > 1024 {
		return "", fmt.Errorf("%s %s : secret vide ou trop long (1 024 octets au plus)", nom, chemin)
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return "", fmt.Errorf("%s %s : caractère non imprimable ou espace dans le secret", nom, chemin)
		}
	}
	return s, nil
}

// VerifierStripe : clé secrète (sk_) ou restreinte (rk_) du mode choisi, secret de webhook whsec_.
func VerifierStripe(cle, webhook string, essai bool) error {
	mode := "live_"
	if essai {
		mode = "test_"
	}
	if !strings.HasPrefix(cle, "sk_"+mode) && !strings.HasPrefix(cle, "rk_"+mode) {
		return fmt.Errorf("SHH_STRIPE_CLE_FILE : clé sk_%s… ou rk_%s… attendue (SHH_PAIEMENT_ESSAI=%d)", mode, mode, b2i(essai))
	}
	if !strings.HasPrefix(webhook, "whsec_") {
		return fmt.Errorf("SHH_STRIPE_WEBHOOK_FILE : secret whsec_… attendu")
	}
	return nil
}

// Effacer : passe quotidienne (janitor.Quotidien) : purge, puis arrêt du renouvellement des
// abonnements inactifs depuis 12 mois (ArreterInactifs). Un prestataire injoignable ne fait pas
// échouer la passe (sinon elle serait refaite à chaque tour) : l'arrêt est réessayé le
// lendemain, et la journalisation le dit, sans identifiant.
func (s *Service) Effacer(time.Time) (int, error) {
	if err := s.Purger(); err != nil {
		return 0, err
	}
	if s.jetons != nil {
		if err := s.jetons.Purger(); err != nil {
			return 0, err
		}
	}
	ctx, fin := context.WithTimeout(context.Background(), 2*time.Minute)
	defer fin()
	arretes, echecs, err := s.ArreterInactifs(ctx)
	s.journaliserInactifs(arretes, echecs)
	return 0, err
}

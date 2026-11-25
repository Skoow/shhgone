package main

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/skoow/shhdrop/server/internal/config"
	"github.com/skoow/shhdrop/server/internal/paiement"
)

// paiements : base et service du paiement (conception du paiement §10).
type paiements struct {
	db  *sql.DB
	svc *paiement.Service
}

// setupPaiement : sans SHH_PAIEMENT=1, rien (nil : aucun fichier lu ni créé, aucun client
// sortant). Sinon les secrets sont lus et vérifiés (refus de démarrer, message sans valeur),
// paiements.db ouverte (créée en 0600) dans SHH_DATA_DIR, puis le service avec les seuls
// prestataires configurés.
func setupPaiement(cfg config.Config) (*paiements, error) {
	if !cfg.Paiement {
		return nil, nil
	}
	p := cfg.Pay
	regime, ok := paiement.RegimeDe(p.TVA)
	if !ok {
		return nil, shown("SHH_TVA invalide")
	}
	var prest []paiement.Prestataire
	var cl *paiement.Client
	// Condition redondante avec le retour ci-dessus, gardée exprès : TestClientPaiementSeulementAvecPaiement
	// vérifie que le seul client sortant n'est créé que dans un « if …Paiement ».
	if cfg.Paiement {
		cl = paiement.NouveauClient()
	}
	if p.AvecStripe() {
		cle, err := paiement.LireSecret("SHH_STRIPE_CLE_FILE", p.StripeCleFile)
		if err != nil {
			return nil, shown(err.Error())
		}
		wh, err := paiement.LireSecret("SHH_STRIPE_WEBHOOK_FILE", p.StripeWebhookFile)
		if err != nil {
			return nil, shown(err.Error())
		}
		if err := paiement.VerifierStripe(cle, wh, p.Essai); err != nil {
			return nil, shown(err.Error())
		}
		prest = append(prest, paiement.NouveauStripe(cle, wh, p.Essai, p.StripeTaxe, cl, cfg.Now))
	}
	if p.AvecPayPal() {
		sec, err := paiement.LireSecret("SHH_PAYPAL_SECRET_FILE", p.PayPalSecretFile)
		if err != nil {
			return nil, shown(err.Error())
		}
		pl := paiement.Plans{PlusMois: p.PayPalPlans[0], PlusAn: p.PayPalPlans[1], ProMois: p.PayPalPlans[2], ProAn: p.PayPalPlans[3]}
		prest = append(prest, paiement.NouveauPayPal(p.PayPalClientID, sec, p.PayPalWebhookID, pl, p.Essai, cl, cfg.Now))
	}
	if p.AvecNOWPayments() {
		cle, err := paiement.LireSecret("SHH_NOWPAYMENTS_CLE_FILE", p.NOWPaymentsCleFile)
		if err != nil {
			return nil, shown(err.Error())
		}
		ipn, err := paiement.LireSecret("SHH_NOWPAYMENTS_IPN_FILE", p.NOWPaymentsIPNFile)
		if err != nil {
			return nil, shown(err.Error())
		}
		prest = append(prest, paiement.NouveauNOWPayments(cle, ipn, p.Essai, cl))
	}
	db, err := paiement.OuvrirBase(filepath.Join(cfg.DataDir, "paiements.db"))
	if errors.Is(err, paiement.ErrBasePlusRecente) {
		return nil, shown(err.Error())
	}
	if err != nil {
		return nil, err
	}
	if err := paiement.MarquerMode(db, p.Essai); err != nil {
		db.Close()
		if errors.Is(err, paiement.ErrBaseEssai) || errors.Is(err, paiement.ErrBaseReelle) {
			return nil, shown(err.Error())
		}
		return nil, err
	}
	// Émetteur des jetons anonymes : l'hôte public du site (SHH_ORIGIN sans schéma ni port).
	emetteur := strings.TrimPrefix(strings.TrimPrefix(cfg.Origin, "https://"), "http://")
	if h, _, err := net.SplitHostPort(emetteur); err == nil {
		emetteur = h
	}
	svc, err := paiement.NewService(paiement.Config{DB: db, Now: cfg.Now, Origine: cfg.Origin, Regime: regime, Prestataires: prest,
		Emetteur: emetteur})
	if err != nil {
		db.Close()
		return nil, err
	}
	return &paiements{db: db, svc: svc}, nil
}

// runPaiement : « shhdrop admin paiement revoquer <commande> » (conception du paiement §5.5) :
// remboursement partiel ou abus constaté. L'identifiant de commande n'est pas un secret (il est
// dans les métadonnées du prestataire) ; il est lu en argument. paiements.db doit exister.
func runPaiement(args []string, cfg config.Config, stdout, stderr io.Writer, usage func(string) int, fail func(error) int) int {
	if len(args) != 3 || args[1] != "revoquer" {
		return usage("paiement : shhdrop admin paiement revoquer <commande>")
	}
	c, ok := paiement.CommandeDe(args[2])
	if !ok {
		return usage("commande : 32 caractères hexadécimaux minuscules")
	}
	dir, err := adminDataDir(cfg.DataDir)
	if err != nil {
		return fail(err)
	}
	chemin := filepath.Join(dir, "paiements.db")
	if fi, err := os.Stat(chemin); err != nil || !fi.Mode().IsRegular() {
		return fail(shownf("%s ne contient pas paiements.db (paiement jamais activé ?) : rien n'a été fait", dir))
	}
	db, err := paiement.OuvrirBase(chemin)
	if err != nil {
		return fail(err)
	}
	defer db.Close()
	trouve, err := paiement.RevoquerBase(db, cfg.Now, c)
	if err != nil {
		return fail(err)
	}
	if !trouve {
		fmt.Fprintf(stderr, "commande introuvable (%s ; rien n'a été fait)\n", dir)
		return 1
	}
	fmt.Fprintf(stdout, "pass de la commande révoqué (%s)\n", dir)
	return 0
}

package paiement

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

// États d'une commande (colonne commandes.etat).
const (
	etatAttente    = 1
	etatPayee      = 2
	etatNonAboutie = 3
	etatAnomalie   = 4
	etatRevoquee   = 5
)

const jourS = 86400

// Durées de garde (conception §5.7, DP-12).
const (
	gardeAttente = 7 * jourS   // commande en attente ou non aboutie
	gardeLitiges = 180 * jourS // après la fin du pass : délai des litiges
	gardePass    = 31 * jourS  // pass après sa fin : validité des jetons émis
	maxEnAttente = 1000        // commandes en attente récentes au plus (§8)
	// heuresRecentes : une commande est « récente » pendant l'heure UTC de sa création et les
	// heuresRecentes-1 suivantes (3 à 4 h ; audit du 20 novembre, S2). Seules les récentes
	// bloquent les ventes ; la ligne reste 7 jours (gardeAttente) pour un paiement tardif.
	heuresRecentes = 4
	periodeJetons  = 30 * jourS
)

func jourDe(t time.Time) int64 { return t.Unix() / jourS * jourS }

// Erreurs rendues à l'API (traduites en réponses fixes par handlers_paiement.go).
var (
	ErrSignature       = errors.New("signature du webhook invalide")
	ErrPasEncore       = errors.New("commande pas encore connue (le prestataire réessaiera)")
	ErrPrestataire     = errors.New("réponse du prestataire refusée")
	ErrOccupe          = errors.New("serveur occupé")
	ErrConflit         = errors.New("pass déjà utilisé pour une commande")
	ErrMoyen           = errors.New("moyen de paiement non proposé")
	ErrFormule         = errors.New("formule invalide")
	ErrRenonciation    = errors.New("renonciation au droit de rétractation non cochée")
	ErrAucunAbonnement = errors.New("aucun abonnement à arrêter")
)

// Demande : ce que le prestataire reçoit pour créer sa page de paiement (rien de personnel).
type Demande struct {
	Commande    Commande
	Formule     Formule
	Pays        string
	Ventilation Ventilation
	Retour      string // <SHH_ORIGIN>/offres/retour
	Webhook     string // <SHH_ORIGIN>/api/paiement/webhook/<prestataire>
	// RenonciationHeure : secondes Unix de la commande (case cochée), preuve gardée par le
	// prestataire avec la transaction (conception §9.4).
	RenonciationHeure int64
}

// Session : page hébergée du prestataire et, pour un abonnement PayPal, son identifiant (connu
// dès la création).
type Session struct {
	URL        string
	Abonnement string
}

// Sorte d'événement tiré d'un webhook vérifié.
type Sorte uint8

const (
	Confirme          Sorte = iota + 1 // paiement confirmé : crédit d'une période
	NonAbouti                          // refusé, expiré, abandonné
	Revoque                            // remboursement total, litige, reversement
	PoseAbonnement                     // identifiant d'abonnement connu
	FinRenouvellement                  // abonnement arrêté (le pass va jusqu'à sa fin)
	// LieRef : une seconde référence du même paiement (Stripe : PaymentIntent d'une facture
	// d'abonnement, `invoice_payment.paid`) rangée avec la commande de Ref, pour qu'un
	// remboursement ou un litige qui ne porte qu'elle retrouve la commande (risque S10).
	LieRef
)

// Evenement : une conséquence d'un webhook, déjà vérifié par le prestataire.
type Evenement struct {
	Sorte Sorte
	// Commande, si le webhook la porte (métadonnées, custom_id, order_id).
	Commande     Commande
	AvecCommande bool
	// Abonnement : identifiant d'abonnement (à poser, ou pour retrouver la commande).
	Abonnement string
	// Ref : référence du paiement chez le prestataire (Confirme : enregistrée ; Revoque : pour
	// retrouver la commande sans métadonnées).
	Ref string
	// RefLiee : seconde référence du paiement de Ref (LieRef seulement).
	RefLiee string
	// Tardif (LieRef seulement) : événement de plus de 24 h ; Ref encore inconnue → ignoré
	// (200) au lieu d'un nouvel essai.
	Tardif bool
	// Montant TTC en centimes et devise en minuscules (Confirme).
	Montant int64
	Devise  string
}

// Prestataire : un moyen de paiement (Stripe, PayPal, NOWPayments), appels sortants et
// vérification des webhooks. Implémentations : stripe.go, paypal.go, nowpayments.go.
type Prestataire interface {
	Moyen() Moyen
	Nom() string // « stripe », « paypal », « nowpayments » (chemin du webhook)
	Creer(ctx context.Context, d Demande) (Session, error)
	// Lire vérifie la signature (ErrSignature sinon) puis traduit le webhook en événements.
	Lire(ctx context.Context, h http.Header, corps []byte) ([]Evenement, error)
	// Resilier arrête le renouvellement d'un abonnement à la fin de la période payée.
	Resilier(ctx context.Context, abonnement string) error
	// Origines : débuts d'adresse permis pour la redirection (conception §4.4).
	Origines() []string
}

// Config du service.
type Config struct {
	DB           *sql.DB
	Now          func() time.Time
	Origine      string // SHH_ORIGIN
	Regime       Regime
	Prestataires []Prestataire
	// Emetteur : issuer_name des jetons anonymes (hôte de SHH_ORIGIN) ; vide : pas de jetons.
	Emetteur string
}

// Service : commandes, pass et droits (conception §2, §5).
type Service struct {
	db      *sql.DB
	now     func() time.Time
	origine string
	regime  Regime
	prest   [4]Prestataire // indexé par Moyen
	jetons  *Jetons

	// recentes : commandes créées par heure UTC (heures depuis 1970), sur les heuresRecentes
	// dernières heures ; un entier par heure, aucune clé, mémoire seulement (perdu au
	// redémarrage : le plafond repart de zéro, jamais une vente bloquée de plus).
	mu       sync.Mutex
	recentes [heuresRecentes]struct{ heure, n int64 }
}

// compterRecente : d (+1 ou -1) commande créée dans l'heure de now.
func (s *Service) compterRecente(now time.Time, d int64) {
	h := now.Unix() / 3600
	s.mu.Lock()
	defer s.mu.Unlock()
	b := &s.recentes[h%heuresRecentes]
	if b.heure != h {
		b.heure, b.n = h, 0
	}
	b.n = max(0, b.n+d)
}

// nRecentes : commandes créées dans l'heure de now et les heuresRecentes-1 précédentes.
func (s *Service) nRecentes(now time.Time) int64 {
	h := now.Unix() / 3600
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int64
	for _, b := range s.recentes {
		if b.heure > h-heuresRecentes && b.heure <= h {
			n += b.n
		}
	}
	return n
}

// NewService : au moins un prestataire, chacun une seule fois.
func NewService(c Config) (*Service, error) {
	if c.DB == nil || c.Now == nil || c.Origine == "" || c.Regime == 0 || len(c.Prestataires) == 0 {
		return nil, errors.New("paiement : configuration incomplète")
	}
	s := &Service{db: c.DB, now: c.Now, origine: c.Origine, regime: c.Regime}
	if c.Emetteur != "" {
		s.jetons = NouveauxJetons(c.DB, c.Now, c.Emetteur)
	}
	for _, p := range c.Prestataires {
		m := p.Moyen()
		if m < Carte || m > Crypto || s.prest[m] != nil {
			return nil, errors.New("paiement : prestataire en double ou inconnu")
		}
		s.prest[m] = p
	}
	return s, nil
}

// Jetons : émission et dépense des jetons anonymes (nil sans Emetteur).
func (s *Service) Jetons() *Jetons { return s.jetons }

// Regime : régime de TVA choisi par l'exploitant (SHH_TVA).
func (s *Service) Regime() Regime { return s.regime }

// Moyens proposés, dans l'ordre carte, PayPal, crypto.
func (s *Service) Moyens() []Moyen {
	var out []Moyen
	for m := Carte; m <= Crypto; m++ {
		if s.prest[m] != nil {
			out = append(out, m)
		}
	}
	return out
}

// Prestataire du webhook nommé (nil : inconnu ou non configuré).
func (s *Service) PrestataireDe(nom string) Prestataire {
	for _, p := range s.prest {
		if p != nil && p.Nom() == nom {
			return p
		}
	}
	return nil
}

// Commander : crée la commande puis la page hébergée du prestataire (conception §2 point 3).
// Le pass ne doit avoir servi à aucune autre commande (l'appareil en tire un par commande).
func (s *Service) Commander(ctx context.Context, p Pass, f Formule, pays string, renonciation bool) (string, error) {
	if !f.Valide() {
		return "", ErrFormule
	}
	if !renonciation {
		return "", ErrRenonciation
	}
	pr := s.prest[f.Moyen]
	if pr == nil {
		return "", ErrMoyen
	}
	v, err := Ventiler(s.regime, pays, Prix(f.Offre, f.Jours))
	if err != nil {
		return "", err
	}
	c, err := nouvelleCommande()
	if err != nil {
		return "", err
	}
	q := p.Empreinte()
	now := s.now()
	auj := jourDe(now)
	// Plafond (§8, audit du 20 novembre, S2) : 1 000 commandes à la fois encore en attente ET
	// créées dans les dernières heures. Les commandes en attente plus anciennes (gardées 7 jours
	// pour un paiement tardif) ne bloquent plus les ventes : il faut entretenir l'attaque.
	if s.nRecentes(now) >= maxEnAttente {
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM commandes WHERE etat=?`, etatAttente).Scan(&n); err != nil {
			return "", err
		}
		if n >= maxEnAttente {
			return "", ErrOccupe
		}
	}
	_, err = s.db.Exec(`INSERT INTO commandes(id,q,offre,jours,renouvelle,moyen,etat,abonnement,cree_jour,garde_jour)
		VALUES(?,?,?,?,?,?,?,NULL,?,?)`, c[:], q[:], f.Offre, f.Jours, b2i(f.Renouvelle), f.Moyen, etatAttente, auj, auj+gardeAttente)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return "", ErrConflit
		}
		return "", err
	}
	s.compterRecente(now, 1)
	ses, err := pr.Creer(ctx, Demande{Commande: c, Formule: f, Pays: pays, Ventilation: v,
		Retour: s.origine + "/offres/retour", Webhook: s.origine + "/api/paiement/webhook/" + pr.Nom(),
		RenonciationHeure: now.Unix()})
	if err == nil && !adressePermise(ses.URL, pr.Origines()) {
		err = ErrPrestataire
	}
	if err != nil {
		// Rien n'a été payé : la commande s'efface (le pass ne sert plus, l'appareil en tirera un autre).
		s.db.Exec(`DELETE FROM commandes WHERE id=?`, c[:])
		s.compterRecente(now, -1)
		return "", err
	}
	if ses.Abonnement != "" {
		if !abonnementValide(ses.Abonnement) {
			s.db.Exec(`DELETE FROM commandes WHERE id=?`, c[:])
			s.compterRecente(now, -1)
			return "", ErrPrestataire
		}
		if _, err := s.db.Exec(`UPDATE commandes SET abonnement=? WHERE id=?`, []byte(ses.Abonnement), c[:]); err != nil {
			return "", err
		}
	}
	return ses.URL, nil
}

// adressePermise : https, commence par une origine permise, aucun caractère de contrôle ni
// espace (l'adresse est donnée telle quelle au navigateur).
func adressePermise(u string, origines []string) bool {
	if len(u) > 2048 {
		return false
	}
	for i := 0; i < len(u); i++ {
		if u[i] <= 0x20 || u[i] >= 0x7f {
			return false
		}
	}
	for _, o := range origines {
		if strings.HasPrefix(u, o) && len(u) > len(o) {
			return true
		}
	}
	return false
}

// abonnementValide : identifiant d'abonnement du prestataire (sub_…, I-…) : 1 à 64 caractères
// [A-Za-z0-9_-].
func abonnementValide(a string) bool {
	if a == "" || len(a) > 64 {
		return false
	}
	for i := 0; i < len(a); i++ {
		c := a[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Etat d'un pass (conception §5.6).
type Etat struct {
	Etat       string // attente, payee, non_aboutie, anomalie, revoquee, inconnue
	Offre      Offre  // 0 si inconnue
	Fin        int64  // jour (secondes Unix, minuit UTC) ; 0 si aucun
	Renouvelle bool
}

var nomsEtats = [...]string{"inconnue", "attente", "payee", "non_aboutie", "anomalie", "revoquee"}

// EtatDe : commande et pass du porteur de p.
func (s *Service) EtatDe(p Pass) (Etat, error) {
	q := p.Empreinte()
	var e Etat
	var etat, offre, renouv int
	err := s.db.QueryRow(`SELECT etat, offre, renouvelle FROM commandes WHERE q=?`, q[:]).Scan(&etat, &offre, &renouv)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return e, err
	default:
		e.Etat, e.Offre, e.Renouvelle = nomsEtats[etat], Offre(offre), renouv == 1 && etat == etatPayee
	}
	var fin int64
	var rev int
	err = s.db.QueryRow(`SELECT offre, fin_jour, revoque FROM passes WHERE q=?`, q[:]).Scan(&offre, &fin, &rev)
	switch {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return e, err
	default:
		e.Offre, e.Fin = Offre(offre), fin
		if e.Etat == "" {
			e.Etat = "payee"
			if rev == 1 {
				e.Etat = "revoquee"
			}
		}
	}
	if e.Etat == "" {
		e.Etat = "inconnue"
	}
	return e, nil
}

// Resilier : arrête le renouvellement de l'abonnement du porteur de p (conception §5.6).
func (s *Service) Resilier(ctx context.Context, p Pass) error {
	q := p.Empreinte()
	var id []byte
	var abo []byte
	var moyen int
	err := s.db.QueryRow(`SELECT id, abonnement, moyen FROM commandes WHERE q=? AND renouvelle=1 AND abonnement IS NOT NULL`, q[:]).
		Scan(&id, &abo, &moyen)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrAucunAbonnement
	}
	if err != nil {
		return err
	}
	pr := s.prest[moyen]
	if pr == nil {
		return ErrMoyen
	}
	if err := pr.Resilier(ctx, string(abo)); err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE commandes SET renouvelle=0 WHERE id=?`, id)
	return err
}

// Webhook : vérifie et applique un webhook du prestataire pr. Chaque événement est appliqué
// dans sa propre transaction ; un événement déjà appliqué ne change rien (idempotence).
func (s *Service) Webhook(ctx context.Context, pr Prestataire, h http.Header, corps []byte) error {
	if c, ok := pr.(cibleur); ok {
		connu, err := s.vise(pr.Nom(), c.Cibles(corps))
		if err != nil {
			return err
		}
		if !connu {
			return ErrSignature // même réponse qu'une signature fausse (400), aucun appel sortant
		}
	}
	evs, err := pr.Lire(ctx, h, corps)
	if err != nil {
		return err
	}
	for _, ev := range evs {
		if err := s.appliquer(pr, ev); err != nil {
			return err
		}
	}
	return nil
}

// cibleur : prestataire dont la vérification d'un webhook coûte un appel sortant authentifié
// (PayPal). Audit du 20 novembre, S3 : avant de vérifier, Service.Webhook lit (Cibles, sans
// vérification) ce que vise le webhook ; s'il ne vise aucune commande connue chez nous, quel que
// soit son état, il est refusé comme une signature fausse, sans appel sortant. Ces valeurs non
// vérifiées ne servent qu'à cette recherche ; Lire relit le corps après vérification.
type cibleur interface {
	Cibles(corps []byte) []Evenement
}

// vise : au moins une commande de paiements.db (tout état) est visée par evs : par son
// identifiant, son abonnement ou l'empreinte d'une de ses références. Lecture seule.
func (s *Service) vise(pr string, evs []Evenement) (bool, error) {
	existe := func(q string, arg []byte) (bool, error) {
		var un int
		err := s.db.QueryRow(q, arg).Scan(&un)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return err == nil, err
	}
	for _, ev := range evs {
		var vu bool
		var err error
		if ev.AvecCommande {
			vu, err = existe(`SELECT 1 FROM commandes WHERE id=?`, ev.Commande[:])
		}
		if !vu && err == nil && ev.Abonnement != "" {
			vu, err = existe(`SELECT 1 FROM commandes WHERE abonnement=?`, []byte(ev.Abonnement))
		}
		for _, r := range []string{ev.Ref, ev.RefLiee} {
			if !vu && err == nil && r != "" {
				vu, err = existe(`SELECT 1 FROM refs WHERE r=?`, empreinteRef(pr, r))
			}
		}
		if vu || err != nil {
			return vu, err
		}
	}
	return false, nil
}

// empreinteRef : SHA-256(« shhdrop/v2/paiement/ref » ‖ 0x00 ‖ prestataire ‖ 0x00 ‖ référence).
func empreinteRef(pr string, ref string) []byte {
	h := sha256.New()
	h.Write([]byte("shhdrop/v2/paiement/ref"))
	h.Write([]byte{0})
	h.Write([]byte(pr))
	h.Write([]byte{0})
	h.Write([]byte(ref))
	return h.Sum(nil)
}

type ligneCommande struct {
	id         []byte
	q          []byte
	offre      Offre
	jours      int
	etat       int
	abonnement []byte
}

// trouver : la commande de l'événement (métadonnées, puis abonnement, puis référence).
func trouver(tx *sql.Tx, pr string, ev Evenement) (ligneCommande, bool, error) {
	var l ligneCommande
	var q string
	var arg []byte
	switch {
	case ev.AvecCommande:
		q, arg = `id=?`, ev.Commande[:]
	case ev.Abonnement != "":
		q, arg = `abonnement=?`, []byte(ev.Abonnement)
	case ev.Ref != "":
		q, arg = `id=(SELECT commande FROM refs WHERE r=?)`, empreinteRef(pr, ev.Ref)
	default:
		return l, false, nil
	}
	err := tx.QueryRow(`SELECT id, q, offre, jours, etat, abonnement FROM commandes WHERE `+q, arg).
		Scan(&l.id, &l.q, &l.offre, &l.jours, &l.etat, &l.abonnement)
	if errors.Is(err, sql.ErrNoRows) {
		return l, false, nil
	}
	return l, err == nil, err
}

func (s *Service) appliquer(pr Prestataire, ev Evenement) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	l, ok, err := trouver(tx, pr.Nom(), ev)
	if err != nil {
		return err
	}
	if ev.Sorte == LieRef {
		return lierRef(tx, pr.Nom(), ev, l, ok, jourDe(s.now()))
	}
	if !ok {
		// Un paiement confirmé sans commande dans ses métadonnées, retrouvé seulement par son
		// abonnement : l'activation n'est peut-être pas encore arrivée ; le prestataire réessaie.
		if ev.Sorte == Confirme && !ev.AvecCommande {
			return ErrPasEncore
		}
		return nil // commande purgée, autre application, remboursement non relié : rien
	}
	auj := jourDe(s.now())
	switch ev.Sorte {
	case Confirme:
		if ev.Ref == "" {
			return errors.New("paiement : confirmation sans référence")
		}
		r := empreinteRef(pr.Nom(), ev.Ref)
		var deja int
		if err := tx.QueryRow(`SELECT count(*) FROM refs WHERE r=?`, r).Scan(&deja); err != nil {
			return err
		}
		if deja > 0 {
			return nil // déjà crédité
		}
		if _, err := tx.Exec(`INSERT INTO refs(r, commande, jour) VALUES(?,?,?)`, r, l.id, auj); err != nil {
			return err
		}
		if err := poserAbonnement(tx, l, ev.Abonnement); err != nil {
			return err
		}
		if ev.Montant != Prix(l.offre, l.jours) || ev.Devise != "eur" || l.etat == etatRevoquee {
			// Montant ou devise inattendus, ou pass révoqué : aucun crédit (conception §4.4).
			if l.etat != etatRevoquee {
				if _, err := tx.Exec(`UPDATE commandes SET etat=?, garde_jour=? WHERE id=?`, etatAnomalie, auj+gardeLitiges, l.id); err != nil {
					return err
				}
			}
			return tx.Commit()
		}
		fin, err := crediter(tx, l, auj)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE commandes SET etat=?, garde_jour=? WHERE id=?`, etatPayee, fin+gardeLitiges, l.id); err != nil {
			return err
		}
	case NonAbouti:
		if l.etat == etatAttente {
			if _, err := tx.Exec(`UPDATE commandes SET etat=? WHERE id=?`, etatNonAboutie, l.id); err != nil {
				return err
			}
		}
	case Revoque:
		// Remboursement d'un montant connu, inférieur au prix : partiel, aucun effet (DP-11).
		if ev.Montant > 0 && ev.Montant < Prix(l.offre, l.jours) {
			return nil
		}
		if _, err := tx.Exec(`UPDATE passes SET revoque=1, jetons=0, fin_jour=MIN(fin_jour, ?) WHERE q=?`, auj, l.q); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE commandes SET etat=?, renouvelle=0, garde_jour=MAX(garde_jour, ?) WHERE id=?`,
			etatRevoquee, auj+gardeLitiges, l.id); err != nil {
			return err
		}
	case PoseAbonnement:
		if err := poserAbonnement(tx, l, ev.Abonnement); err != nil {
			return err
		}
	case FinRenouvellement:
		if _, err := tx.Exec(`UPDATE commandes SET renouvelle=0 WHERE id=?`, l.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// lierRef : range l'empreinte de ev.RefLiee avec la commande de ev.Ref (déjà créditée). Déjà
// rangée (paiement unique dont le PaymentIntent est la référence du crédit, ou événement
// rejoué) : rien. Commande pas encore créditée : le prestataire réessaie (les événements
// Stripe n'arrivent pas dans l'ordre), sauf après 24 h (Tardif) : rien. Seule une empreinte est gardée, comme pour Ref (§5.1).
func lierRef(tx *sql.Tx, pr string, ev Evenement, l ligneCommande, ok bool, auj int64) error {
	if ev.Ref == "" || ev.RefLiee == "" {
		return nil
	}
	r := empreinteRef(pr, ev.RefLiee)
	var deja int
	if err := tx.QueryRow(`SELECT count(*) FROM refs WHERE r=?`, r).Scan(&deja); err != nil {
		return err
	}
	if deja > 0 {
		return nil
	}
	if !ok {
		if ev.Tardif {
			return nil // facture jamais créditée (motif hors création et cycle, commande purgée)
		}
		return ErrPasEncore
	}
	if _, err := tx.Exec(`INSERT INTO refs(r, commande, jour) VALUES(?,?,?)`, r, l.id, auj); err != nil {
		return err
	}
	return tx.Commit()
}

// poserAbonnement : identifiant d'abonnement gardé une fois (jamais remplacé par un autre).
func poserAbonnement(tx *sql.Tx, l ligneCommande, abo string) error {
	if abo == "" || l.abonnement != nil {
		return nil
	}
	if !abonnementValide(abo) {
		return ErrPrestataire
	}
	_, err := tx.Exec(`UPDATE commandes SET abonnement=? WHERE id=?`, []byte(abo), l.id)
	return err
}

// crediter : une période de plus pour le pass de la commande (conception §5.4) ; rend la
// nouvelle fin.
func crediter(tx *sql.Tx, l ligneCommande, auj int64) (int64, error) {
	var fin int64
	err := tx.QueryRow(`SELECT fin_jour FROM passes WHERE q=?`, l.q).Scan(&fin)
	jours := int64(l.jours) * jourS
	switch {
	case errors.Is(err, sql.ErrNoRows):
		fin = auj + jours
		_, err = tx.Exec(`INSERT INTO passes(q, offre, debut_jour, fin_jour, jetons, recharge_jour, revoque) VALUES(?,?,?,?,?,?,0)`,
			l.q, l.offre, auj, fin, l.offre.Detail().JetonsPeriod, auj+periodeJetons)
		return fin, err
	case err != nil:
		return 0, err
	}
	fin = max(fin, auj) + jours
	_, err = tx.Exec(`UPDATE passes SET fin_jour=? WHERE q=?`, fin, l.q)
	return fin, err
}

// Prendre : jusqu'à n jetons de la réserve du pass de p (émission des jetons anonymes, plan
// tâche 7). La réserve est remise à sa valeur à chaque période de 30 jours commencée avant la
// fin (sans report). Rend le nombre pris (0 : pass inconnu, révoqué, échu ou réserve vide).
func (s *Service) Prendre(p Pass, n int) (int, Offre, error) {
	if n <= 0 {
		return 0, 0, nil
	}
	q := p.Empreinte()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	var offre Offre
	var fin, recharge int64
	var jetons, rev int
	err = tx.QueryRow(`SELECT offre, fin_jour, jetons, recharge_jour, revoque FROM passes WHERE q=?`, q[:]).
		Scan(&offre, &fin, &jetons, &recharge, &rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	auj := jourDe(s.now())
	if rev == 1 || auj >= fin {
		return 0, offre, nil
	}
	for recharge <= auj {
		jetons, recharge = offre.Detail().JetonsPeriod, recharge+periodeJetons
	}
	pris := min(n, jetons)
	if _, err := tx.Exec(`UPDATE passes SET jetons=?, recharge_jour=? WHERE q=?`, jetons-pris, recharge, q[:]); err != nil {
		return 0, 0, err
	}
	return pris, offre, tx.Commit()
}

// RevoquerBase : Revoquer sur une base ouverte hors du serveur (shhdrop admin paiement
// revoquer), sans prestataire.
func RevoquerBase(db *sql.DB, now func() time.Time, c Commande) (bool, error) {
	return (&Service{db: db, now: now}).Revoquer(c)
}

// Revoquer : révocation à la main par l'exploitant (remboursement partiel, abus constaté ;
// conception §5.5). false : commande inconnue.
func (s *Service) Revoquer(c Commande) (bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var q []byte
	if err := tx.QueryRow(`SELECT q FROM commandes WHERE id=?`, c[:]).Scan(&q); errors.Is(err, sql.ErrNoRows) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	tx.Commit()
	return true, s.appliquer(revocateur{}, Evenement{Sorte: Revoque, Commande: c, AvecCommande: true})
}

// revocateur : prestataire fictif d'une révocation à la main (seul Nom sert).
type revocateur struct{ Prestataire }

func (revocateur) Nom() string { return "admin" }

// Purger : passe quotidienne (conception §5.7) : commandes non payées après 7 jours,
// commandes payées ou révoquées après leur garde (et leurs références), pass 31 jours après
// leur fin.
func (s *Service) Purger() error {
	auj := jourDe(s.now())
	if _, err := s.db.Exec(`DELETE FROM commandes WHERE etat IN (?,?) AND cree_jour+? <= ?`, etatAttente, etatNonAboutie, gardeAttente, auj); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM commandes WHERE etat IN (?,?,?) AND garde_jour <= ?`, etatPayee, etatAnomalie, etatRevoquee, auj); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM passes WHERE fin_jour+? <= ?`, gardePass, auj)
	return err
}

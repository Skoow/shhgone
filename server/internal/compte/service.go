package compte

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"errors"
	"net/netip"
	"sync"
	"time"

	"github.com/skoow/shhdrop/server/internal/limits"
)

// Service : compte par passkey (conception du compte par passkey §6 ; sessions, pseudo,
// coffres, ancienneté, bannissement et suppression de la conception du compte, inchangés). Le
// serveur ne reçoit jamais la sortie PRF d'une passkey, la clé de récupération R ni K_compte ;
// il garde les clés publiques des passkeys, des enveloppes chiffrées par l'appareil et
// v_r = SHA-256(A_r).
//
// Mémoire seulement : défis WebAuthn et étapes (defis.go), activité des sessions
// (sessions.go), perdus au redémarrage. Disque : comptes.db (base.go), dates au jour ou au mois.
type Service struct {
	db   *sql.DB
	cles Cles
	wa   *Ceremonies // nil : ligne de commande (bannissements), aucune cérémonie
	lim  *limits.Limiter
	now  func() time.Time
	max  int
	// jour : comptes créés au plus par jour UTC, pour tout le serveur (SHH_COMPTES_JOUR,
	// conception §7.2 : coupe-circuit) ; creesJour et jourCrees sous mu.
	jour                 int
	creesJour, jourCrees int64

	mu  sync.Mutex
	et  etapes
	act activites

	// Crochets du salon : fermer les salons créés par un compte, les compter, les
	// lister, en détruire un. nil (salon désactivé, tests) : aucun salon relié.
	fermerSalons, salonsActifs func(h [16]byte) (int, error)
	salonsVivants              func(h [16]byte) ([]SalonVivant, error)
	detruireSalon              func(h [16]byte, id string) error
	// refs : salons du compte désignés par une ref éphémère (salons.go), sous refsMu.
	refsMu sync.Mutex
	refs   map[[16]byte]refSalon

	// cpt : compteurs depuis le démarrage, pour le tableau de bord (agregats.go).
	cpt compteurs
}

// Config : base ouverte par OuvrirBase, sous-clé de K_serveur, limites (le même limiteur que
// l'API), horloge, SHH_COMPTES_MAX, SHH_COMPTES_JOUR.
type Config struct {
	DB   *sql.DB
	Cles Cles
	// Ceremonies : configuration WebAuthn figée (NouvellesCeremonies depuis SHH_ORIGIN) ; nil
	// pour la ligne de commande d'administration, qui n'inscrit ni ne connecte personne.
	Ceremonies *Ceremonies
	Limites    *limits.Limiter
	Now        func() time.Time
	Max        int
	// Jour : comptes créés au plus par jour pour tout le serveur (0 : 500, la valeur par défaut
	// de SHH_COMPTES_JOUR).
	Jour int
	// Crochets du salon (SHH_SALONS=1 ; api.BrancherSalonsDuCompte), nil sinon : fermer les
	// salons créés par un compte, les compter, les lister (SalonVivant : l'identifiant interne
	// ne sort jamais du serveur), en détruire un (salon inconnu, fini ou d'un autre compte :
	// ErrEtape).
	FermerSalons, SalonsActifs func(h [16]byte) (int, error)
	SalonsVivants              func(h [16]byte) ([]SalonVivant, error)
	DetruireSalon              func(h [16]byte, id string) error
}

// ComptesJourDefaut : plafond global de comptes créés par jour (conception §7.2).
const ComptesJourDefaut = 500

// NewService : rien n'est lu ni écrit.
func NewService(c Config) (*Service, error) {
	if c.DB == nil || c.Limites == nil || c.Max < 1 || c.Jour < 0 {
		return nil, errors.New("compte : configuration incomplète")
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Jour == 0 {
		c.Jour = ComptesJourDefaut
	}
	s := &Service{db: c.DB, cles: c.Cles, wa: c.Ceremonies, lim: c.Limites, now: c.Now, max: c.Max, jour: c.Jour,
		fermerSalons: c.FermerSalons, salonsActifs: c.SalonsActifs, salonsVivants: c.SalonsVivants,
		detruireSalon: c.DetruireSalon, refs: map[[16]byte]refSalon{}}
	s.et.m = map[[32]byte]*etape{}
	s.et.parBloc = map[string]int{}
	s.act.m, s.act.debut = map[[32]byte]activite{}, c.Now()
	return s, nil
}

// Erreurs fixes (conception du compte §8.6 ; conception du compte par passkey §6.4) ; l'API les
// traduit en codes HTTP. Aucune ne cite un pseudo ni une valeur reçue. ErrIdentifiants : même
// erreur pour une passkey inconnue, une signature fausse, un userHandle qui ne correspond pas
// et une clé de récupération inconnue.
var (
	ErrRequete      = errors.New("bad_request")
	ErrIdentifiants = errors.New("identifiants")
	ErrRecent       = errors.New("recent")
	ErrEtape        = errors.New("not_found")
	ErrSession      = errors.New("session")
	ErrBusy         = errors.New("busy")
	ErrPseudoPris   = errors.New("pseudo_pris")
	ErrDerniere     = errors.New("derniere")
)

// ErrLimit : limite atteinte, à réessayer après Retry.
type ErrLimit struct{ Retry time.Duration }

func (e ErrLimit) Error() string { return "limit" }

// ErrBanni : compte banni jusqu'au jour Jusqu (« 2029-11-14 »).
type ErrBanni struct{ Jusqu string }

func (e ErrBanni) Error() string { return "banni" }

// ErrConflit : if_gen périmé ; Gen est celui du serveur (409 conflict).
type ErrConflit struct{ Gen uint64 }

func (e ErrConflit) Error() string { return "conflict" }

// OptionsSession : « Rester connecté » et nom d'appareil chiffré par le client (64 octets ou
// rien).
type OptionsSession struct {
	Persistante bool
	Etiquette   []byte
}

func (o OptionsSession) valide() bool { return o.Etiquette == nil || len(o.Etiquette) == 64 }

// Dates de comptes.db : jour (minuit UTC) ou mois (premier du mois, minuit UTC).
const jourS = 86400

func jourDe(t time.Time) int64 { u := t.Unix(); return u - ((u%jourS)+jourS)%jourS }

func moisDe(t time.Time) int64 {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).Unix()
}

func dateJour(j int64) string { return time.Unix(j, 0).UTC().Format("2006-01-02") }

// heureSuivante : délai jusqu'à l'heure UTC suivante (fenêtres des limites à l'heure).
func heureSuivante(t time.Time) time.Duration { return t.Truncate(time.Hour).Add(time.Hour).Sub(t) }

// jourSuivant : délai jusqu'au jour UTC suivant (fenêtres des limites au jour).
func jourSuivant(t time.Time) time.Duration { return time.Unix(jourDe(t)+jourS, 0).Sub(t) }

// tirer : octets aléatoires (crypto/rand ne renvoie pas d'erreur sous Linux).
func tirer(b []byte) { rand.Read(b) }

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// octets16 : lecture d'un BLOB de 16 octets exactement.
type octets16 [16]byte

func (o *octets16) Scan(v any) error {
	b, ok := v.([]byte)
	if !ok || len(b) != 16 {
		return errors.New("compte : BLOB(16) attendu")
	}
	copy(o[:], b)
	return nil
}

// Passkey : ce que le serveur garde d'une passkey (conception §6.3) : identifiant, clé publique
// COSE, algorithme, BE, libellé chiffré (64 octets ou nil). Env : première enveloppe PRF donnée
// à la création (60 octets ou nil), rangée dans enveloppes. Jamais d'AAGUID, de transports,
// d'attestation, de compteur ni de BS.
type Passkey struct {
	CredID    []byte
	ClePub    []byte
	Alg       int64
	BE        bool
	Env       []byte
	Etiquette []byte
	// SignCount : dernier compteur de signatures reçu (0 : passkey synchronisée, qui n'en tient
	// pas, ou aucun encore).
	SignCount uint32
}

// Limites des passkeys (conception §6.3).
const (
	CredIDMax     = 1023
	ClePubMax     = 1024
	PasskeysMax   = 10
	EnveloppeLen  = 60
	EnveloppesMax = 4 // par passkey (« enveloppes multiples »)
)

func algOK(a int64) bool { return a == -7 || a == -8 || a == -257 }

// valide : forme de ce qui entre en base (les CHECK du schéma le redisent).
func (p Passkey) valide() bool {
	return len(p.CredID) >= 1 && len(p.CredID) <= CredIDMax && len(p.ClePub) >= 1 && len(p.ClePub) <= ClePubMax &&
		algOK(p.Alg) && (p.Env == nil || len(p.Env) == EnveloppeLen) && (p.Etiquette == nil || len(p.Etiquette) == 64)
}

// NouveauCompte : ce que l'appareil envoie à inscription/fin, hors passkey (conception §6.4) :
// pseudo canonique (jamais gardé : seulement son empreinte), v_r, Env_r, les deux coffres.
// Rien qui ouvre un coffre : ni sortie PRF, ni R, ni A_r, ni K_compte.
type NouveauCompte struct {
	PCanon     []byte
	VR         [32]byte
	EnvR       [60]byte
	BlobProfil []byte
	BlobPrive  []byte
}

// nulle : la passkey ou les blobs en NULL SQL.
func nulle(b []byte) any {
	if b == nil {
		return nil
	}
	return b
}

// creerCompteTx : compte h, sa première passkey et une session, dans la transaction tx. Pseudo
// pris, réservé ou interdit : ErrPseudoPris ; v_r déjà pris : ErrRequete (128 bits aléatoires :
// une erreur du client, jamais un hasard) ; cred_id déjà connu : ErrRequete ; plafond
// SHH_COMPTES_MAX : ErrBusy.
func (s *Service) creerCompteTx(tx *sql.Tx, h [16]byte, nc NouveauCompte, pk Passkey, o OptionsSession, now time.Time) ([32]byte, error) {
	if !o.valide() || !pk.valide() || !coffreValide(Profil, nc.BlobProfil, 1) || !coffreValide(Prive, nc.BlobPrive, 1) {
		return [32]byte{}, ErrRequete
	}
	pe, err := s.empreintePseudo(nc.PCanon)
	if err != nil {
		return [32]byte{}, err
	}
	if pris, err := pseudoPrisTx(tx, pe); err != nil {
		return [32]byte{}, err
	} else if pris || pe == [32]byte{} {
		return [32]byte{}, ErrPseudoPris
	}
	var x int
	for _, q := range []struct {
		sql string
		arg []byte
	}{{`SELECT 1 FROM comptes WHERE v_r=?`, nc.VR[:]}, {`SELECT 1 FROM passkeys WHERE cred_id=?`, pk.CredID},
		{`SELECT 1 FROM comptes WHERE h=?`, h[:]}} {
		switch err := tx.QueryRow(q.sql, q.arg).Scan(&x); {
		case err == nil:
			return [32]byte{}, ErrRequete
		case !errors.Is(err, sql.ErrNoRows):
			return [32]byte{}, err
		}
	}
	var n int
	if err := tx.QueryRow(`SELECT count(*) FROM comptes`).Scan(&n); err != nil {
		return [32]byte{}, err
	}
	if n >= s.max {
		return [32]byte{}, ErrBusy
	}
	j, m := jourDe(now), moisDe(now)
	if _, err := tx.Exec(`INSERT INTO comptes(h, p_empreinte, pseudo_jour, v_r, env_r, blob_profil, gen_profil,
		blob_prive, gen_prive, cree_jour, compte_des, vu_mois) VALUES(?,?,0,?,?,?,1,?,1,?,?,?)`,
		h[:], pe[:], nc.VR[:], nc.EnvR[:], nc.BlobProfil, nc.BlobPrive, j, j, m); err != nil {
		return [32]byte{}, err
	}
	if err := insererPasskeyTx(tx, h, pk, now); err != nil {
		return [32]byte{}, err
	}
	tok, err := s.creerSessionTx(tx, h, o, false, now)
	if err == nil {
		s.lierPasskey(tok, pk.CredID)
	}
	return tok, err
}

// insererPasskeyTx : une ligne passkeys pour h (mois d'ajout seulement).
func insererPasskeyTx(tx *sql.Tx, h [16]byte, pk Passkey, now time.Time) error {
	if _, err := tx.Exec(`INSERT INTO passkeys(cred_id, h, cle_pub, alg, be, etiquette, ajoutee_mois, sign_count)
		VALUES(?,?,?,?,?,?,?,?)`, pk.CredID, h[:], pk.ClePub, pk.Alg, boolInt(pk.BE), nulle(pk.Etiquette), moisDe(now),
		int64(pk.SignCount)); err != nil {
		return err
	}
	if pk.Env == nil {
		return nil
	}
	_, err := tx.Exec(`INSERT INTO enveloppes(cred_id, n, env) VALUES(?,0,?)`, pk.CredID, pk.Env)
	return err
}

// bannieTx : un bannissement actif et non échu pour le compte h (suspendu ou échu : non) ; rend
// son identifiant, son échéance et son motif.
func bannieTx(q interface {
	QueryRow(string, ...any) *sql.Row
}, h [16]byte, now time.Time) (id []byte, jusqu, motif int64, banni bool, err error) {
	err = q.QueryRow(`SELECT id, jusqu_jour, motif FROM bannis WHERE h=? AND actif=1 AND jusqu_jour>?`,
		h[:], jourDe(now)).Scan(&id, &jusqu, &motif)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, 0, false, nil
	}
	return id, jusqu, motif, err == nil && len(id) == 8, err
}

// tx : f dans une transaction (validée si f ne rend pas d'erreur).
func (s *Service) tx(f func(*sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := f(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// pseudoPrisTx : un compte a déjà cette empreinte de pseudo (empreinte nulle : jamais).
func pseudoPrisTx(tx *sql.Tx, pe [32]byte) (bool, error) {
	var x int
	err := tx.QueryRow(`SELECT 1 FROM comptes WHERE p_empreinte=?`, pe[:]).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// empreintePseudo : p_empreinte de p_canon ; forme fausse : ErrRequete ; réservé ou interdit :
// l'empreinte nulle (même réponse qu'un pseudo pris, après les mêmes contrôles).
func (s *Service) empreintePseudo(pCanon []byte) ([32]byte, error) {
	pe, err := s.cles.EmpreintePseudo(pCanon)
	switch {
	case errors.Is(err, ErrPseudoCanon):
		return [32]byte{}, ErrRequete
	case err != nil:
		return [32]byte{}, nil
	}
	return pe, nil
}

// pseudoLibre : p_canon libre ? Réservé ou interdit : pris (même réponse, même requête).
func (s *Service) pseudoLibre(pCanon []byte) (bool, error) {
	pe, err := s.empreintePseudo(pCanon)
	if err != nil {
		return false, err
	}
	var pris bool
	err = s.tx(func(tx *sql.Tx) error {
		var err error
		pris, err = pseudoPrisTx(tx, pe)
		return err
	})
	return err == nil && !pris && pe != [32]byte{}, err
}

// PseudoVerifierEtape : pseudo/verifier pendant une inscription (étape vivante), 30 par heure
// et par étape (§21.5). Libre : le pseudo est réservé à cette étape jusqu'à son échéance
// (conception du compte par passkey §6.4 : évite une passkey créée pour un pseudo pris
// entre-temps) ; réservé par une autre inscription vivante : pris (même réponse).
func (s *Service) PseudoVerifierEtape(jeton [32]byte, pCanon []byte) (bool, error) {
	if len(pCanon) == 0 {
		return false, ErrRequete
	}
	now := s.now()
	s.mu.Lock()
	e := s.et.trouverLocked(jeton, etapeInscription, now)
	s.mu.Unlock()
	if e == nil {
		return false, ErrEtape
	}
	k := cleEtape(jeton)
	if !s.lim.AllowPseudoVerifier(k[:]) {
		return false, ErrLimit{heureSuivante(now)}
	}
	libre, err := s.pseudoLibre(pCanon)
	if err != nil || !libre {
		return false, err
	}
	pe, err := s.empreintePseudo(pCanon)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.et.trouverLocked(jeton, etapeInscription, now) == nil {
		return false, ErrEtape
	}
	if s.pseudoReserveLocked(pe, k, now) {
		return false, nil
	}
	e.pe = pe
	return true, nil
}

// PseudoVerifier : pseudo/verifier avec une session, 30 par heure et par compte. Le pseudo du
// compte lui-même n'est pas « libre ».
func (s *Service) PseudoVerifier(c Courante, pCanon []byte) (bool, error) {
	if len(pCanon) == 0 {
		return false, ErrRequete
	}
	now := s.now()
	if !s.lim.AllowPseudoVerifier(c.H[:]) {
		return false, ErrLimit{heureSuivante(now)}
	}
	return s.pseudoLibre(pCanon)
}

// PseudoVerifierInvite : pseudo d'un invité du salon (unique dans sa conversation, et jamais
// le pseudo d'un compte, ni réservé, ni interdit). Sans compte ni salon : la requête ne dit
// pas de quel salon il s'agit et rien n'est gardé ; bornée par connexion
// (limits.AllowPseudoInvite) contre l'énumération des pseudos des comptes.
func (s *Service) PseudoVerifierInvite(ip netip.Addr, pCanon []byte) (bool, error) {
	if len(pCanon) == 0 {
		return false, ErrRequete
	}
	if !s.lim.AllowPseudoInvite(ip) {
		return false, ErrLimit{heureSuivante(s.now())}
	}
	return s.pseudoLibre(pCanon)
}

// PseudoEcart : temps minimal entre deux changements de pseudo (« 3 fois par an au plus ») ;
// 123 jours : 3 × 123 = 369 > 366, jamais plus de 3 changements sur 12 mois glissants, même
// une année bissextile, sans nouvelle colonne (pseudo_jour suffit).
const PseudoEcart = 123 * jourS

// ChangerPseudo : au plus un changement par PseudoEcart, l'attente ne courant qu'à partir d'un
// premier changement (pseudo_jour vaut 0 tant que le pseudo n'a jamais changé ; le premier,
// depuis le pseudo de l'inscription, est donc libre) ; l'ancien pseudo est libéré aussitôt
// (§21.5). Pris, réservé ou interdit : ErrPseudoPris (le nouveau doit toujours être libre). Le
// même pseudo que le sien : rien à faire.
func (s *Service) ChangerPseudo(c Courante, pCanon []byte) error {
	pe, err := s.empreintePseudo(pCanon)
	if err != nil {
		return err
	}
	now := s.now()
	return s.tx(func(tx *sql.Tx) error {
		var pj int64
		var actuel []byte
		if err := tx.QueryRow(`SELECT pseudo_jour, p_empreinte FROM comptes WHERE h=?`, c.H[:]).Scan(&pj, &actuel); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrSession
			}
			return err
		}
		if pj != 0 && jourDe(now) < pj+PseudoEcart {
			return ErrLimit{time.Unix(pj+PseudoEcart, 0).Sub(now)}
		}
		if pe != [32]byte{} && subtle.ConstantTimeCompare(actuel, pe[:]) == 1 {
			return nil
		}
		// « Pris » dit l'existence d'un compte : même limite que pseudo/verifier.
		if !s.lim.AllowPseudoVerifier(c.H[:]) {
			return ErrLimit{heureSuivante(now)}
		}
		if pris, err := pseudoPrisTx(tx, pe); err != nil {
			return err
		} else if pris || pe == [32]byte{} {
			return ErrPseudoPris
		}
		_, err := tx.Exec(`UPDATE comptes SET p_empreinte=?, pseudo_jour=? WHERE h=?`, pe[:], jourDe(now), c.H[:])
		return err
	})
}

// fermerSessionsTx : ferme les sessions du compte h, sauf sauf (nil : toutes) ; rend leurs t_v
// (activité à oublier après la transaction).
func fermerSessionsTx(tx *sql.Tx, h [16]byte, sauf *[32]byte) ([][32]byte, error) {
	rows, err := tx.Query(`SELECT t_v FROM sessions WHERE h=?`, h[:])
	if err != nil {
		return nil, err
	}
	var tvs [][32]byte
	for rows.Next() {
		var tv []byte
		if err := rows.Scan(&tv); err != nil || len(tv) != 32 {
			rows.Close()
			return nil, errors.Join(err, errors.New("compte : t_v"))
		}
		if sauf == nil || [32]byte(tv) != *sauf {
			tvs = append(tvs, [32]byte(tv))
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, tv := range tvs {
		if _, err := tx.Exec(`DELETE FROM sessions WHERE t_v=?`, tv[:]); err != nil {
			return nil, err
		}
	}
	return tvs, nil
}

// vider : WAL replié et ramené à zéro après un effacement (§8.2 : WAL vidé après chaque
// effacement ; secure_delete a déjà écrasé les pages libérées). Au mieux : une erreur (base
// occupée par la commande d'administration) laisse le travail au prochain point de reprise et
// à la passe quotidienne (Effacer).
func (s *Service) vider() {
	s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
}

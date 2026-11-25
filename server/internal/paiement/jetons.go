package paiement

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/binary"
	"errors"
	"math/big"
	"sync"
	"time"

	"github.com/cloudflare/circl/blindsign/blindrsa"
)

// Jetons anonymes (conception du paiement §7) : Privacy Pass, émission RFC 9578 type 0x0002,
// RSABSSA-SHA384-PSS-Deterministic (RFC 9474), RSA 2 048 bits, bibliothèque
// github.com/cloudflare/circl v1.6.5 (exception écrite dans CLAUDE.md). Le client (moteur Rust,
// blind-rsa-signatures 0.19.0) et ce serveur donnent les mêmes octets : vecteurs communs
// engine/vectors/privacypass.json.
//
// Clés (S9, révocation) : une paire par formule et par JOUR UTC, tirée par le serveur à la
// première demande et gardée dans paiements.db ; un jeton n'est accepté que le jour de sa clé et
// le lendemain, puis la clé est effacée. Un pass révoqué (remboursement, litige) ne reçoit plus
// rien ; les jetons qu'il a déjà reçus meurent au plus tard le surlendemain. Les émissions sont
// bornées par jour et par pass (EmisParJour) : après une révocation, au plus ce nombre de
// partages payants peut encore être créé. La même clé du jour sert à tous : aucune clé ne
// désigne une personne. S17 : les clés sont tirées JoursAvance jours à l'avance et servies
// d'aujourd'hui à J+JoursAvance ; l'appareil garde celles qu'il a vues et refuse une clé
// différente pour un (jour, formule) déjà vu (web/src/paiement/jetons.ts). Limite : un serveur
// qui donne à un appareil ses propres clés dès le premier contact n'est pas détecté par cet
// appareil seul (§7, §15).

// JoursAvance : jours de clés tirées et publiées à l'avance ; GET /api/paiement/jetons/cles
// sert les clés d'aujourd'hui à aujourd'hui + JoursAvance, des deux formules.
const JoursAvance = 7

const (
	// TypeJeton et NK : RFC 9578 §6 (type 0x0002, authentificateur de 256 octets).
	TypeJeton   = 0x0002
	nkJeton     = 256
	requeteLen  = 2 + 1 + nkJeton
	jetonLen    = 2 + 32 + 32 + 32 + nkJeton
	maxRequetes = 5 // jetons au plus par requête (§7)
)

// EmisParJour : jetons émis au plus par pass et par jour UTC (borne de ce qui survit à une
// révocation). Plus 10, Pro 20 ; la réserve de la période (30 ou 100) reste la limite du mois.
func EmisParJour(o Offre) int {
	if o == Pro {
		return 20
	}
	return 10
}

// spkiPrefixe : début de la clé publique SPKI d'une clé RSA de 2 048 bits (exposant 65 537)
// avec l'OID RSASSA-PSS, SHA-384, MGF1-SHA-384 et un sel de 48 octets (RFC 9578 §6.5), tel que
// l'écrit blind-rsa-signatures (vecteurs) ; suivi de RSAPublicKey (PKCS #1, 270 octets).
var spkiPrefixe = []byte{
	0x30, 0x82, 0x01, 0x52, 0x30, 0x3d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a, 0x30, 0x30,
	0xa0, 0x0d, 0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02,
	0xa1, 0x1a, 0x30, 0x18, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08,
	0x30, 0x0b, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02,
	0xa2, 0x03, 0x02, 0x01, 0x30, 0x03, 0x82, 0x01, 0x0f, 0x00,
}

// SPKI : clé publique au format du client (RFC 9578 §6.5).
func SPKI(pk *rsa.PublicKey) ([]byte, error) {
	if pk.N.BitLen() != 2048 || pk.E != 65537 {
		return nil, errJeton
	}
	der := x509.MarshalPKCS1PublicKey(pk)
	if len(der) != 270 {
		return nil, errJeton
	}
	return append(bytes.Clone(spkiPrefixe), der...), nil
}

// Defi : TokenChallenge commun (type ‖ issuer_name ‖ contexte vide ‖ origine vide).
func Defi(emetteur string) []byte {
	d := []byte{0, TypeJeton}
	d = binary.BigEndian.AppendUint16(d, uint16(len(emetteur)))
	d = append(d, emetteur...)
	return append(d, 0, 0, 0)
}

var (
	errJeton = errors.New("jeton invalide")
	// ErrJeton : jeton refusé (forme, clé inconnue ou échue, signature, déjà dépensé) ; même
	// erreur pour toutes les causes.
	ErrJeton = errJeton
	// ErrPasDeJetons : pass inconnu, révoqué, échu, ou réserve (du mois ou du jour) épuisée.
	ErrPasDeJetons = errors.New("aucun jeton disponible pour ce pass")
)

// cleJour : clé d'émission d'une formule pour un jour.
type cleJour struct {
	jour  int64
	offre Offre
	sk    *rsa.PrivateKey
	spki  []byte
	kid   [32]byte
}

// Jetons : clés du jour, émission et dépense, sur paiements.db.
type Jetons struct {
	db       *sql.DB
	now      func() time.Time
	emetteur string
	mu       sync.Mutex
	cache    []cleJour // de la veille à J+JoursAvance (au plus 2 × (JoursAvance + 2) entrées)
	// cpt : jetons émis, dépensés et rendus depuis le démarrage (tableau de bord, agregats.go).
	cpt compteursJetons
}

// NouveauxJetons : emetteur = nom public du service (hôte de SHH_ORIGIN).
func NouveauxJetons(db *sql.DB, now func() time.Time, emetteur string) *Jetons {
	return &Jetons{db: db, now: now, emetteur: emetteur}
}

// Emetteur : issuer_name du défi.
func (j *Jetons) Emetteur() string { return j.emetteur }

// cle : clé (jour, offre), lue ou tirée (creer : seulement par Cles, d'aujourd'hui à J+JoursAvance).
func (j *Jetons) cle(jour int64, o Offre, creer bool) (cleJour, bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, c := range j.cache {
		if c.jour == jour && c.offre == o {
			return c, true, nil
		}
	}
	var der []byte
	err := j.db.QueryRow(`SELECT sk FROM cles_jetons WHERE jour=? AND offre=?`, jour, o).Scan(&der)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if !creer {
			return cleJour{}, false, nil
		}
		sk, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return cleJour{}, false, err
		}
		der = x509.MarshalPKCS1PrivateKey(sk)
		if _, err := j.db.Exec(`INSERT OR IGNORE INTO cles_jetons(jour, offre, sk) VALUES(?,?,?)`, jour, o, der); err != nil {
			return cleJour{}, false, err
		}
		// Une autre requête a pu l'écrire entre-temps : la base fait foi.
		if err := j.db.QueryRow(`SELECT sk FROM cles_jetons WHERE jour=? AND offre=?`, jour, o).Scan(&der); err != nil {
			return cleJour{}, false, err
		}
	case err != nil:
		return cleJour{}, false, err
	}
	sk, err := x509.ParsePKCS1PrivateKey(der)
	if err != nil {
		return cleJour{}, false, err
	}
	spki, err := SPKI(&sk.PublicKey)
	if err != nil {
		return cleJour{}, false, err
	}
	c := cleJour{jour: jour, offre: o, sk: sk, spki: spki, kid: sha256.Sum256(spki)}
	// Cache : de la veille à J+JoursAvance (rien n'est demandé au-delà).
	auj := jourDe(j.now())
	garde := j.cache[:0]
	for _, x := range j.cache {
		if x.jour >= auj-jourS {
			garde = append(garde, x)
		}
	}
	j.cache = append(garde, c)
	return c, true, nil
}

// CleDuJour : clé publique d'un jour (aujourd'hui à J+JoursAvance) pour une formule.
type CleDuJour struct {
	Jour  int64
	Offre Offre
	SPKI  []byte
}

// Cles : clés publiques d'aujourd'hui à J+JoursAvance, des deux formules (tirées au besoin), par
// jour croissant puis Plus, Pro. Une clé tirée ne change plus jusqu'à son effacement (Purger).
func (j *Jetons) Cles() ([]CleDuJour, error) {
	auj := jourDe(j.now())
	out := make([]CleDuJour, 0, 2*(JoursAvance+1))
	for d := int64(0); d <= JoursAvance; d++ {
		jour := auj + d*jourS
		for _, o := range []Offre{Plus, Pro} {
			c, _, err := j.cle(jour, o, true)
			if err != nil {
				return nil, err
			}
			out = append(out, CleDuJour{jour, o, c.spki})
		}
	}
	return out, nil
}

// Emettre : signe en aveugle jusqu'à 5 demandes (TokenRequest) avec la clé du jour de la
// formule du pass ; la réserve du pass (Prendre) et ses émissions du jour sont décomptées dans
// la même opération. Une demande d'une autre clé (octet de token_key_id faux), d'un autre type ou
// de mauvaise taille : refus de tout le lot (rien n'est décompté).
func (j *Jetons) Emettre(s *Service, p Pass, requetes [][]byte) ([][]byte, Offre, error) {
	if len(requetes) == 0 || len(requetes) > maxRequetes {
		return nil, 0, errJeton
	}
	auj := jourDe(j.now())
	offre, err := s.offreDuPass(p)
	if err != nil {
		return nil, 0, err
	}
	c, _, err := j.cle(auj, offre, true)
	if err != nil {
		return nil, 0, err
	}
	for _, r := range requetes {
		// Message aveuglé plus grand que le module : refusé avant de rien décompter.
		if len(r) != requeteLen || binary.BigEndian.Uint16(r) != TypeJeton || r[2] != c.kid[31] ||
			new(big.Int).SetBytes(r[3:]).Cmp(c.sk.N) >= 0 {
			return nil, 0, errJeton
		}
	}
	// Signé avant de décompter : une erreur de signature ne coûte rien à la réserve du pass.
	signer := blindrsa.NewSigner(c.sk)
	out := make([][]byte, len(requetes))
	for i, r := range requetes {
		if out[i], err = signer.BlindSign(r[3:]); err != nil {
			return nil, 0, errJeton
		}
	}
	n, err := s.prendreDuJour(p, len(requetes), EmisParJour(offre))
	if err != nil {
		return nil, 0, err
	}
	if n < len(requetes) {
		// Prendre est tout ou rien ici : rien n'a été décompté, et rien n'est rendu.
		return nil, 0, ErrPasDeJetons
	}
	j.cpt.emis[offre].Add(int64(len(out)))
	return out, offre, nil
}

// Depenser : vérifie un jeton (clé du jour ou de la veille, défi, signature) puis le marque
// dépensé (empreinte SHA-256 seule, avec le jour) ; rend la formule. Rien d'autre n'est gardé :
// ni le jeton, ni le partage qu'il crée, ni l'heure.
func (j *Jetons) Depenser(jeton []byte) (Offre, error) {
	if len(jeton) != jetonLen || binary.BigEndian.Uint16(jeton) != TypeJeton {
		return 0, errJeton
	}
	dd := sha256.Sum256(Defi(j.emetteur))
	if !bytes.Equal(jeton[34:66], dd[:]) {
		return 0, errJeton
	}
	auj := jourDe(j.now())
	var trouvee *cleJour
	for _, jour := range []int64{auj, auj - jourS} {
		for _, o := range []Offre{Plus, Pro} {
			c, ok, err := j.cle(jour, o, false)
			if err != nil {
				return 0, err
			}
			if ok && bytes.Equal(c.kid[:], jeton[66:98]) {
				trouvee = &c
			}
		}
	}
	if trouvee == nil {
		return 0, errJeton
	}
	v, err := blindrsa.NewVerifier(blindrsa.SHA384PSSDeterministic, &trouvee.sk.PublicKey)
	if err != nil {
		return 0, err
	}
	if v.Verify(jeton[:98], jeton[98:]) != nil {
		return 0, errJeton
	}
	h := sha256.Sum256(jeton)
	res, err := j.db.Exec(`INSERT OR IGNORE INTO depenses(h, jour) VALUES(?,?)`, h[:], auj)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, errJeton // déjà dépensé
	}
	j.cpt.depenses[trouvee.offre].Add(1)
	return trouvee.offre, nil
}

// Rendre : un jeton dépensé pour une création refusée ensuite (quota, place) redevient
// utilisable (son empreinte est retirée) ; sans effet sinon.
func (j *Jetons) Rendre(jeton []byte) {
	h := sha256.Sum256(jeton)
	if res, err := j.db.Exec(`DELETE FROM depenses WHERE h=?`, h[:]); err == nil {
		if n, _ := res.RowsAffected(); n == 1 {
			j.cpt.rendus.Add(1)
		}
	}
}

// Purger : clés d'avant la veille, dépenses d'avant-hier (un jeton de ces clés n'est plus accepté).
func (j *Jetons) Purger() error {
	auj := jourDe(j.now())
	if _, err := j.db.Exec(`DELETE FROM cles_jetons WHERE jour < ?`, auj-jourS); err != nil {
		return err
	}
	_, err := j.db.Exec(`DELETE FROM depenses WHERE jour < ?`, auj-jourS)
	return err
}

// offreDuPass : formule d'un pass valable (payé, non révoqué, non échu).
func (s *Service) offreDuPass(p Pass) (Offre, error) {
	q := p.Empreinte()
	var o Offre
	var fin int64
	var rev int
	err := s.db.QueryRow(`SELECT offre, fin_jour, revoque FROM passes WHERE q=?`, q[:]).Scan(&o, &fin, &rev)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (rev == 1 || jourDe(s.now()) >= fin) {
		return 0, ErrPasDeJetons
	}
	return o, err
}

// prendreDuJour : Prendre, tout ou rien, borné aussi par maxJour émissions par jour.
func (s *Service) prendreDuJour(p Pass, n, maxJour int) (int, error) {
	q := p.Empreinte()
	auj := jourDe(s.now())
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var offre Offre
	var fin, recharge, emisJour int64
	var jetons, rev, emisN int
	err = tx.QueryRow(`SELECT offre, fin_jour, jetons, recharge_jour, revoque, emis_jour, emis_n FROM passes WHERE q=?`, q[:]).
		Scan(&offre, &fin, &jetons, &recharge, &rev, &emisJour, &emisN)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if rev == 1 || auj >= fin {
		return 0, nil
	}
	for recharge <= auj {
		jetons, recharge = offre.Detail().JetonsPeriod, recharge+periodeJetons
	}
	if emisJour != auj {
		emisJour, emisN = auj, 0
	}
	if jetons < n || emisN+n > maxJour {
		return 0, nil
	}
	if _, err := tx.Exec(`UPDATE passes SET jetons=?, recharge_jour=?, emis_jour=?, emis_n=? WHERE q=?`,
		jetons-n, recharge, emisJour, emisN+n, q[:]); err != nil {
		return 0, err
	}
	return n, tx.Commit()
}

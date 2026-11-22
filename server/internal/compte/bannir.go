package compte

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
	"strings"
	"time"
)

// Bannissement révisé (conception §13, §21.11, §21.14.4 ; plan lot 7). Une ligne bannis par
// adresse (e_canon), désignée devant le fondateur par un identifiant aléatoire de 8 octets
// (« B-XXXX-XXXX-XXXXX ») : jamais une adresse, une empreinte, un h ni un pseudo. Le statut
// « banni » se lit seulement là (actif et non échu), que l'adresse ait un compte ou non.

// Durées permises au moment de bannir (§21.11) : 30 jours, 1 an (défaut). 3 ans retiré
// (décision du propriétaire du 22 novembre : garder le moins de données, le moins longtemps).
var dureesBan = [...]int{30, 365}

// DureeBanDefaut : 1 an (décision du propriétaire du 22 novembre, qui remplace les 3 ans du
// 14 novembre).
const DureeBanDefaut = 365

// pageBans : lignes par page de la liste (§21.14.4) ; pagesMax borne le décalage demandé.
const (
	pageBans = 50
	pagesMax = 100000
)

// Cible : ce qui désigne le banni. Email : adresse tapée par le fondateur (tampon de
// l'appelant, effacé par lui ; la normalisation en fait une chaîne, que Go ne permet pas
// d'effacer : au mieux). H : compte trouvé par un lien de salon ou une ref de salon signalé.
// Exactement un des deux.
type Cible struct {
	Email []byte
	H     *[16]byte
}

// BanVue : un bannissement tel que le fondateur le voit. Dates au jour (« 2029-11-14 »).
type BanVue struct {
	ID           string `json:"id"`
	Debut        string `json:"debut"`
	Jusqu        string `json:"jusqu"`
	Actif        bool   `json:"actif"`
	Motif        uint8  `json:"motif"`
	SalonsFermes int    `json:"salons_fermes"`
}

// Ban : résultat d'un bannissement. Compte : l'adresse avait un compte (sessions et salons
// fermés) ; sinon seule l'adresse est retenue (inscription refusée).
type Ban struct {
	Vue          BanVue
	Compte       bool
	SalonsFermes int
}

// CompteVue : ce que le fondateur peut savoir d'un compte (recherche par adresse, créateur
// d'un salon signalé) : existe, palier, ancienneté en jours, banni. Rien qui le désigne.
type CompteVue struct {
	Existe          bool   `json:"existe"`
	Palier          string `json:"palier"`
	AncienneteJours int    `json:"anciennete_jours"`
	Banni           bool   `json:"banni"`
}

// ErrDejaBanni : l'adresse a déjà un bannissement en cours (actif ou suspendu) : agir sur lui
// (Vue) plutôt qu'en créer un second.
type ErrDejaBanni struct{ Vue BanVue }

func (e ErrDejaBanni) Error() string { return "deja_banni" }

// crockford : base32 de Crockford (sans I, L, O, U), pour lire l'identifiant à voix haute.
var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// idBan : « B-XXXX-XXXX-XXXXX » (13 caractères pour les 8 octets). Écart à la conception
// (§21.11 montre « B-7KQ2-M9XA », 8 caractères = 40 bits) : les 8 octets de la colonne id
// s'écrivent en 13 caractères ; couper à 8 rendrait l'identifiant ambigu.
func idBan(k [8]byte) string {
	e := crockford.EncodeToString(k[:])
	return "B-" + e[:4] + "-" + e[4:8] + "-" + e[8:]
}

// lireIDBan : forme exacte de idBan (minuscules acceptées) ; canonique (réencodé à l'identique).
func lireIDBan(s string) ([8]byte, bool) {
	var k [8]byte
	s = strings.ToUpper(s)
	if len(s) != 17 || s[:2] != "B-" || s[6] != '-' || s[11] != '-' {
		return k, false
	}
	b, err := crockford.DecodeString(s[2:6] + s[7:11] + s[12:])
	if err != nil || len(b) != 8 {
		return k, false
	}
	copy(k[:], b)
	return k, idBan(k) == s
}

func motifOK(m uint8) bool { return m >= 1 && m <= 10 }

func dureeOK(j int) bool {
	for _, d := range dureesBan {
		if j == d {
			return true
		}
	}
	return false
}

// ligneBan : une ligne de bannis.
type ligneBan struct {
	id                          [8]byte
	canon                       []byte
	debut, jusqu, motif, fermes int64
	actif                       bool
}

func (l ligneBan) vue() BanVue {
	return BanVue{ID: idBan(l.id), Debut: dateJour(l.debut), Jusqu: dateJour(l.jusqu), Actif: l.actif,
		Motif: uint8(l.motif), SalonsFermes: int(l.fermes)}
}

const colonnesBan = `id, e_canon, debut_jour, jusqu_jour, actif, motif, salons_fermes`

type scanner interface{ Scan(...any) error }

func scanBan(r scanner) (ligneBan, error) {
	var l ligneBan
	var id []byte
	if err := r.Scan(&id, &l.canon, &l.debut, &l.jusqu, &l.actif, &l.motif, &l.fermes); err != nil {
		return l, err
	}
	if len(id) != 8 {
		return l, errors.New("compte : identifiant de bannissement illisible")
	}
	copy(l.id[:], id)
	return l, nil
}

// canonDe : e_canon de l'adresse tapée (ErrAdresse si elle n'en est pas une).
func (s *Service) canonDe(email []byte) ([32]byte, error) {
	a, err := Normaliser(string(email))
	if err != nil {
		return [32]byte{}, ErrAdresse
	}
	c, _ := s.cles.Empreintes(a)
	return c, nil
}

// Bannir (§13, §21.11) : durée de 30, 365 ou 1 095 jours, motif 1 à 10 (catégorie de
// §21.10.1). Dans une transaction : ligne bannis (active), sessions du compte fermées ; puis
// salons du compte fermés (crochet du salon), leur nombre gardé dans la ligne. Une création
// en cours a lu le palier sous le même verrou que la fermeture (salon.Manager.FermerDuCompte) :
// elle finit avant, et son salon est fermé, ou lit le bannissement. Compte inconnu (Cible.H) :
// ErrEtape. Adresse déjà bannie (non échue) : ErrDejaBanni. Au-delà de 20 par heure : ErrLimit.
func (s *Service) Bannir(c Cible, dureeJours int, motif uint8) (Ban, error) {
	if (c.Email == nil) == (c.H == nil) || !dureeOK(dureeJours) || !motifOK(motif) {
		return Ban{}, ErrRequete
	}
	now := s.now()
	var canon [32]byte
	var h [16]byte
	compte := false
	if c.H != nil {
		h, compte = *c.H, true
		var e []byte
		if err := s.db.QueryRow(`SELECT e_canon FROM comptes WHERE h=?`, h[:]).Scan(&e); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return Ban{}, ErrEtape
			}
			return Ban{}, err
		}
		copy(canon[:], e)
	} else {
		var err error
		if canon, err = s.canonDe(c.Email); err != nil {
			return Ban{}, err
		}
		var hb []byte
		switch err := s.db.QueryRow(`SELECT h FROM comptes WHERE e_canon=?`, canon[:]).Scan(&hb); {
		case err == nil:
			copy(h[:], hb)
			compte = true
		case !errors.Is(err, sql.ErrNoRows):
			return Ban{}, err
		}
	}
	if !s.lim.AllowBannir() {
		return Ban{}, ErrLimit{heureSuivante(now)}
	}
	auj := jourDe(now)
	var l ligneBan
	var fermees [][32]byte
	err := s.tx(func(tx *sql.Tx) error {
		switch v, err := scanBan(tx.QueryRow(`SELECT `+colonnesBan+` FROM bannis WHERE e_canon=?`, canon[:])); {
		case err == nil && v.jusqu > auj:
			return ErrDejaBanni{v.vue()}
		case err == nil: // échu, pas encore effacé par la passe quotidienne
			if _, err := tx.Exec(`DELETE FROM bannis WHERE e_canon=?`, canon[:]); err != nil {
				return err
			}
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		rand.Read(l.id[:])
		l.canon, l.debut, l.jusqu, l.actif, l.motif = canon[:], auj, auj+int64(dureeJours)*jourS, true, int64(motif)
		if _, err := tx.Exec(`INSERT INTO bannis(`+colonnesBan+`) VALUES(?,?,?,?,1,?,0)`, l.id[:], canon[:], l.debut,
			l.jusqu, l.motif); err != nil {
			return err
		}
		if !compte {
			return nil
		}
		var err error
		fermees, err = fermerSessionsTx(tx, h, nil)
		return err
	})
	if err != nil {
		return Ban{}, err
	}
	for _, tv := range fermees {
		s.act.oublier(tv)
	}
	r := Ban{Compte: compte}
	if compte {
		n, err := s.fermerEtCompter(h, l.id)
		if err != nil {
			return Ban{}, err
		}
		r.SalonsFermes, l.fermes = n, int64(n)
	}
	s.vider()
	r.Vue = l.vue()
	return r, nil
}

// fermerEtCompter : salons vivants du compte fermés (crochet du salon), ajoutés au nombre de
// la ligne id. Un échec du crochet est rendu : le bannissement est en place (création refusée),
// les salons déjà ouverts échoient d'eux-mêmes (24 h au plus) ; l'action peut être refaite.
func (s *Service) fermerEtCompter(h [16]byte, id [8]byte) (int, error) {
	if s.fermerSalons == nil {
		return 0, nil
	}
	n, err := s.fermerSalons(h)
	if err != nil {
		return 0, err
	}
	if n > 0 {
		if _, err := s.db.Exec(`UPDATE bannis SET salons_fermes=salons_fermes+? WHERE id=?`, n, id[:]); err != nil {
			return n, err
		}
	}
	return n, nil
}

// ActionBan (§21.11) sur le bannissement id (« B-… ») en cours (non échu) : « suspendre »
// (sans effet, échéance gardée), « reactiver » (de nouveau en vigueur : sessions et salons du
// compte fermés, comme au bannissement), « echeance » (jusqu : « AAAA-MM-JJ », de demain à
// aujourd'hui + 5 ans), « lever » (ligne effacée), « annuler » (ligne effacée et ancienneté
// rendue : compte_des = cree_jour). Rend l'état d'avant (pour pouvoir revenir en arrière) et
// celui d'après (nil : ligne effacée). Identifiant ou action mal formés : ErrRequete ;
// inconnu ou échu : ErrEtape.
func (s *Service) ActionBan(id, action, jusqu string) (avant BanVue, apres *BanVue, err error) {
	k, ok := lireIDBan(id)
	if !ok {
		return BanVue{}, nil, ErrRequete
	}
	now := s.now()
	auj := jourDe(now)
	var j int64
	switch action {
	case "suspendre", "reactiver", "lever", "annuler":
	case "echeance":
		t, err := time.Parse("2006-01-02", jusqu)
		max := time.Unix(auj, 0).UTC().AddDate(5, 0, 0).Unix()
		if j = t.Unix(); err != nil || t.Format("2006-01-02") != jusqu || j <= auj || j > max {
			return BanVue{}, nil, ErrRequete
		}
	default:
		return BanVue{}, nil, ErrRequete
	}
	// Toute action sur un bannissement compte dans la même limite que bannir (20 par heure) :
	// sans elle, un jeton d'administration volé levait ou suspendait tous les bannissements
	// un par un, et un bannissement levé ne se rétablit qu'avec l'adresse (audit du lot 7).
	if !s.lim.AllowBannir() {
		return BanVue{}, nil, ErrLimit{heureSuivante(now)}
	}
	var l ligneBan
	var h *[16]byte
	var fermees [][32]byte
	err = s.tx(func(tx *sql.Tx) error {
		var err error
		if l, err = scanBan(tx.QueryRow(`SELECT `+colonnesBan+` FROM bannis WHERE id=? AND jusqu_jour>?`, k[:], auj)); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrEtape
			}
			return err
		}
		avant = l.vue()
		switch action {
		case "suspendre", "reactiver":
			l.actif = action == "reactiver"
			_, err = tx.Exec(`UPDATE bannis SET actif=? WHERE id=?`, boolInt(l.actif), k[:])
		case "echeance":
			l.jusqu = j
			_, err = tx.Exec(`UPDATE bannis SET jusqu_jour=? WHERE id=?`, j, k[:])
		case "lever", "annuler":
			if _, err = tx.Exec(`DELETE FROM bannis WHERE id=?`, k[:]); err == nil && action == "annuler" {
				_, err = tx.Exec(`UPDATE comptes SET compte_des=cree_jour WHERE e_canon=?`, l.canon)
			}
			return err
		}
		if err != nil || action != "reactiver" || avant.Actif {
			return err
		}
		var hb []byte
		switch err := tx.QueryRow(`SELECT h FROM comptes WHERE e_canon=?`, l.canon).Scan(&hb); {
		case errors.Is(err, sql.ErrNoRows):
			return nil
		case err != nil:
			return err
		}
		h = new([16]byte)
		copy(h[:], hb)
		fermees, err = fermerSessionsTx(tx, *h, nil)
		return err
	})
	if err != nil {
		return BanVue{}, nil, err
	}
	for _, tv := range fermees {
		s.act.oublier(tv)
	}
	if action == "lever" || action == "annuler" {
		s.vider()
		return avant, nil, nil
	}
	if h != nil {
		n, err := s.fermerEtCompter(*h, k)
		l.fermes += int64(n)
		if err != nil {
			return BanVue{}, nil, err
		}
	}
	v := l.vue()
	return avant, &v, nil
}

// lireBanCanon : bannissement en cours (non échu) de l'adresse, ou nil.
func (s *Service) lireBanCanon(canon []byte, auj int64) (*BanVue, error) {
	l, err := scanBan(s.db.QueryRow(`SELECT `+colonnesBan+` FROM bannis WHERE e_canon=? AND jusqu_jour>?`, canon, auj))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v := l.vue()
	return &v, nil
}

// vueCompte : CompteVue du compte choisi par q (Existe faux : aucun compte).
func (s *Service) vueCompte(q string, arg any, now time.Time) (CompteVue, error) {
	var des int64
	var canon []byte
	err := s.db.QueryRow(`SELECT compte_des, e_canon FROM comptes WHERE `+q, arg).Scan(&des, &canon)
	if errors.Is(err, sql.ErrNoRows) {
		return CompteVue{}, nil
	}
	if err != nil {
		return CompteVue{}, err
	}
	p, _, _ := palier(des, now)
	v := CompteVue{Existe: true, Palier: p, AncienneteJours: int((jourDe(now) - des) / jourS)}
	b, err := s.lireBanCanon(canon, jourDe(now))
	v.Banni = b != nil && b.Actif
	return v, err
}

// VueCompte : palier, ancienneté et bannissement du compte h (créateur d'un salon signalé) ;
// compte inconnu : Existe faux.
func (s *Service) VueCompte(h [16]byte) (CompteVue, error) {
	return s.vueCompte(`h=?`, h[:], s.now())
}

// ChercherBan (recours, §21.14.4) : le bannissement en cours de l'adresse (ou nil) et ce qu'on
// peut dire de son compte. L'adresse n'est gardée nulle part.
func (s *Service) ChercherBan(email []byte) (*BanVue, CompteVue, error) {
	canon, err := s.canonDe(email)
	if err != nil {
		return nil, CompteVue{}, err
	}
	now := s.now()
	b, err := s.lireBanCanon(canon[:], jourDe(now))
	if err != nil {
		return nil, CompteVue{}, err
	}
	v, err := s.vueCompte(`e_canon=?`, canon[:], now)
	return b, v, err
}

// ListeBans : bannissements en cours (non échus), du plus récent au plus ancien, 50 par page ;
// filtre "" (tous), "actifs", "suspendus", "bientot" (actifs échéant dans les 30 jours). Rend
// aussi le nombre total pour ce filtre.
func (s *Service) ListeBans(filtre string, page int) ([]BanVue, int, error) {
	if page < 0 || page > pagesMax {
		return nil, 0, ErrRequete
	}
	auj := jourDe(s.now())
	cond, args := ` WHERE jusqu_jour>?`, []any{auj}
	switch filtre {
	case "":
	case "actifs":
		cond += ` AND actif=1`
	case "suspendus":
		cond += ` AND actif=0`
	case "bientot":
		cond, args = cond+` AND actif=1 AND jusqu_jour<=?`, append(args, auj+30*jourS)
	default:
		return nil, 0, ErrRequete
	}
	var total int
	if err := s.db.QueryRow(`SELECT count(*) FROM bannis`+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(`SELECT `+colonnesBan+` FROM bannis`+cond+` ORDER BY debut_jour DESC, id LIMIT ? OFFSET ?`,
		append(args, pageBans, page*pageBans)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []BanVue{}
	for rows.Next() {
		l, err := scanBan(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, l.vue())
	}
	return out, total, rows.Err()
}

// RendreAnciennete (signalement abusif, §13, §21.14.3) : compte_des = cree_jour. Compte
// inconnu : ErrEtape.
func (s *Service) RendreAnciennete(h [16]byte) error {
	r, err := s.db.Exec(`UPDATE comptes SET compte_des=cree_jour WHERE h=?`, h[:])
	if err != nil {
		return err
	}
	if n, _ := r.RowsAffected(); n == 0 {
		return ErrEtape
	}
	return nil
}

package compte

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
	"strings"
	"time"
)

// Bannissement (conception du compte §13, §21.11, §21.14.4 ; conception du compte par passkey
// §7.4). Une ligne bannis par compte (h), désignée devant le fondateur par un identifiant
// aléatoire de 8 octets (« B-XXXX-XXXX-XXXXX ») : jamais un h, une empreinte ni un pseudo. Le
// statut « banni » se lit seulement là (actif et non échu). Supprimer le compte efface la ligne
// (cascade) : sans adresse, un nouveau compte se crée sans coût, elle ne protégeait plus
// rien.

// Durées permises au moment de bannir (§21.11) : 30 jours, 1 an, 3 ans (défaut). Le
// bannissement porte sur le compte, jamais sur une adresse IP.
var dureesBan = [...]int{30, 365, 1095}

// DureeBanDefaut : 3 ans.
const DureeBanDefaut = 1095

// pageBans : lignes par page de la liste (§21.14.4) ; pagesMax borne le décalage demandé.
const (
	pageBans = 50
	pagesMax = 100000
)

// BanVue : un bannissement tel que le fondateur le voit. Dates au jour (« 2029-11-14 »).
type BanVue struct {
	ID           string `json:"id"`
	Debut        string `json:"debut"`
	Jusqu        string `json:"jusqu"`
	Actif        bool   `json:"actif"`
	Motif        uint8  `json:"motif"`
	SalonsFermes int    `json:"salons_fermes"`
}

// Ban : résultat d'un bannissement (sessions et salons du compte fermés).
type Ban struct {
	Vue          BanVue
	SalonsFermes int
}

// CompteVue : ce que le fondateur peut savoir d'un compte (créateur d'un salon signalé) :
// existe, palier, ancienneté en jours, banni. Rien qui le désigne.
type CompteVue struct {
	Existe          bool   `json:"existe"`
	Palier          string `json:"palier"`
	AncienneteJours int    `json:"anciennete_jours"`
	Banni           bool   `json:"banni"`
}

// ErrDejaBanni : le compte a déjà un bannissement en cours (actif ou suspendu) : agir sur lui
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
	h                           [16]byte
	debut, jusqu, motif, fermes int64
	actif                       bool
}

func (l ligneBan) vue() BanVue {
	return BanVue{ID: idBan(l.id), Debut: dateJour(l.debut), Jusqu: dateJour(l.jusqu), Actif: l.actif,
		Motif: uint8(l.motif), SalonsFermes: int(l.fermes)}
}

const colonnesBan = `id, h, debut_jour, jusqu_jour, actif, motif, salons_fermes`

type scanner interface{ Scan(...any) error }

func scanBan(r scanner) (ligneBan, error) {
	var l ligneBan
	var id []byte
	if err := r.Scan(&id, (*octets16)(&l.h), &l.debut, &l.jusqu, &l.actif, &l.motif, &l.fermes); err != nil {
		return l, err
	}
	if len(id) != 8 {
		return l, errors.New("compte : identifiant de bannissement illisible")
	}
	copy(l.id[:], id)
	return l, nil
}

// Bannir (§13, §21.11) le compte h (trouvé par un lien de salon ou une ref de salon signalé) :
// durée de 30, 365 ou 1 095 jours, motif 1 à 10 (catégorie de §21.10.1). Dans une transaction :
// ligne bannis (active), sessions du compte fermées ; puis salons du compte fermés (crochet du
// salon), leur nombre gardé dans la ligne. Une création en cours a lu le palier sous le même
// verrou que la fermeture (salon.Manager.FermerDuCompte) : elle finit avant, et son salon est
// fermé, ou lit le bannissement. Compte inconnu : ErrEtape. Déjà banni (non échu) :
// ErrDejaBanni. Au-delà de 20 par heure : ErrLimit.
func (s *Service) Bannir(h [16]byte, dureeJours int, motif uint8) (Ban, error) {
	if !dureeOK(dureeJours) || !motifOK(motif) {
		return Ban{}, ErrRequete
	}
	now := s.now()
	var x int
	if err := s.db.QueryRow(`SELECT 1 FROM comptes WHERE h=?`, h[:]).Scan(&x); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Ban{}, ErrEtape
		}
		return Ban{}, err
	}
	if !s.lim.AllowBannir() {
		return Ban{}, ErrLimit{heureSuivante(now)}
	}
	auj := jourDe(now)
	var l ligneBan
	var fermees [][32]byte
	err := s.tx(func(tx *sql.Tx) error {
		switch v, err := scanBan(tx.QueryRow(`SELECT `+colonnesBan+` FROM bannis WHERE h=?`, h[:])); {
		case err == nil && v.jusqu > auj:
			return ErrDejaBanni{v.vue()}
		case err == nil: // échu, pas encore effacé par la passe quotidienne
			if _, err := tx.Exec(`DELETE FROM bannis WHERE h=?`, h[:]); err != nil {
				return err
			}
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		rand.Read(l.id[:])
		l.h, l.debut, l.jusqu, l.actif, l.motif = h, auj, auj+int64(dureeJours)*jourS, true, int64(motif)
		if _, err := tx.Exec(`INSERT INTO bannis(`+colonnesBan+`) VALUES(?,?,?,?,1,?,0)`, l.id[:], h[:], l.debut,
			l.jusqu, l.motif); err != nil {
			return err
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
	s.oublierDefisDe(h)
	var r Ban
	n, err := s.fermerEtCompter(h, l.id)
	if err != nil {
		return Ban{}, err
	}
	r.SalonsFermes, l.fermes = n, int64(n)
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
	// un par un.
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
				_, err = tx.Exec(`UPDATE comptes SET compte_des=cree_jour WHERE h=?`, l.h[:])
			}
			return err
		}
		if err != nil || action != "reactiver" || avant.Actif {
			return err
		}
		h = &l.h
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

// lireBanH : bannissement en cours (non échu) du compte h, ou nil.
func (s *Service) lireBanH(h [16]byte, auj int64) (*BanVue, error) {
	l, err := scanBan(s.db.QueryRow(`SELECT `+colonnesBan+` FROM bannis WHERE h=? AND jusqu_jour>?`, h[:], auj))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v := l.vue()
	return &v, nil
}

// VueCompte : palier, ancienneté et bannissement du compte h (créateur d'un salon signalé) ;
// compte inconnu : Existe faux.
func (s *Service) VueCompte(h [16]byte) (CompteVue, error) {
	now := s.now()
	var des int64
	err := s.db.QueryRow(`SELECT compte_des FROM comptes WHERE h=?`, h[:]).Scan(&des)
	if errors.Is(err, sql.ErrNoRows) {
		return CompteVue{}, nil
	}
	if err != nil {
		return CompteVue{}, err
	}
	p, _, _ := palier(des, now)
	v := CompteVue{Existe: true, Palier: p, AncienneteJours: int((jourDe(now) - des) / jourS)}
	b, err := s.lireBanH(h, jourDe(now))
	v.Banni = b != nil && b.Actif
	return v, err
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

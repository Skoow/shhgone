package salon

import (
	"container/heap"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"slices"
	"syscall"
	"time"

	"github.com/skoow/shhdrop/server/internal/share"
)

// Salons persistants (conception du salon v3 §5.2) : après un redémarrage, propre (25 novembre)
// ou brutal (panne, manque de mémoire, SIGKILL, coupure de courant : 26 novembre), chaque salon
// ouvert reprend avec les mêmes sièges et jetons, le même journal, le même index des trames et
// les mêmes pièces prêtes. Un client resté ouvert se reconnecte avec son jeton et son `depuis`
// et continue dans le même groupe MLS ; un membre absent rattrape l'historique.
//
// Ce fichier : clé maîtresse (LireCleMaitresse), chiffrement des lignes, lecture et reprise au
// démarrage (PurgerAuDemarrage, fin.go), format de la version 1 (lignes écrites à l'arrêt propre
// par le binaire du 25 novembre : lues une fois, à la mise à jour). L'écriture en continu, sa
// cohérence après un plantage et le format de la version 2 : persistance.go.
//
// La clé maîtresse (SHH_SALONS_CLE_FILE, 32 octets, 0400) est hors de la base, hors de
// SHH_DATA_DIR et des sauvegardes, mais sur le même volume chiffré : la clé enveloppée de chaque
// conversation ouverte est EN PERMANENCE dans shares.db (v3 §5.2, ce que voit un voleur du
// disque).
//
// Ce qui n'est PAS repris (remis à neuf, comme une connexion neuve) : connexions et présences
// (tous hors ligne jusqu'à leur retour), seaux des limites de trames, de pièces et réserve
// vocale, lectures de pièces en cours, pièces encore en envoi ou en finalisation (perdues :
// l'envoi est à refaire), places des blocs anti-abus (Manager.vivants : la clé de bloc dérive de
// l'adresse, jamais écrite). Après un arrêt brutal, en plus : la dernière seconde au plus
// (persistance.go).

const (
	// suffixeReprise : nom du fichier de conversation d'un salon rangé à l'arrêt propre par le
	// binaire du 25 novembre (lignes de version 1 ; jamais un identifiant valide : le brouillage
	// des dates l'ignore, la purge du démarrage l'efface s'il n'est pas repris).
	suffixeReprise = ".r"
	adCle          = "shhdrop/salon/reprise/cle/v1"
	adEtat         = "shhdrop/salon/reprise/etat/v1"
	versionEtat    = 1
	// tailleEnveloppe : nonce (12) ‖ clé chiffrée (32) ‖ étiquette (16) ; CHECK de la table.
	tailleEnveloppe = tailleNonce + 32 + 16
)

// ErrCleMaitresse : clé maîtresse des salons illisible, mal réglée ou impossible à créer ;
// le message dit le chemin et la cause, jamais le contenu.
type ErrCleMaitresse struct{ msg string }

func (e *ErrCleMaitresse) Error() string { return e.msg }

func errCle(chemin, format string, args ...any) error {
	return &ErrCleMaitresse{fmt.Sprintf("SHH_SALONS_CLE_FILE %s : ", chemin) + fmt.Sprintf(format, args...)}
}

// LireCleMaitresse lit la clé maîtresse des salons : exactement 32 octets, fichier ordinaire
// (jamais un lien), droits 0400 ou 0600. Absente : tirée au hasard (crypto/rand) et écrite en
// 0400 (création exclusive, fichier synchronisé), puis relue ; cree = vrai. En production le
// fichier est tiré par deploy.sh (secrets_auto) avant le démarrage : le dossier des secrets est
// monté en lecture seule, et une clé absente y est un refus clair. Le contenu n'est jamais écrit
// ailleurs ni journalisé.
func LireCleMaitresse(chemin string) (cle [32]byte, cree bool, err error) {
	if !filepath.IsAbs(chemin) {
		return cle, false, errCle(chemin, "chemin absolu attendu")
	}
	if _, err := os.Lstat(chemin); errors.Is(err, os.ErrNotExist) {
		if err := creerCleMaitresse(chemin); err != nil {
			return cle, false, err
		}
		cree = true
	}
	f, err := os.OpenFile(chemin, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return cle, false, errCle(chemin, "illisible (fichier ordinaire, sans lien symbolique)")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return cle, false, errCle(chemin, "fichier ordinaire attendu")
	}
	if st.Mode().Perm()&^0o600 != 0 {
		return cle, false, errCle(chemin, "droits %o, attendu 0400 ou 0600 (chmod 0400)", st.Mode().Perm())
	}
	b := make([]byte, 33)
	defer clear(b)
	n, err := io.ReadFull(f, b)
	if n != 32 || !errors.Is(err, io.ErrUnexpectedEOF) {
		return cle, false, errCle(chemin, "exactement 32 octets attendus (head -c 32 /dev/urandom)")
	}
	copy(cle[:], b)
	if cle == [32]byte{} {
		return cle, false, errCle(chemin, "clé nulle (32 zéros), à tirer au hasard")
	}
	return cle, cree, nil
}

// creerCleMaitresse : 32 octets aléatoires écrits en 0400, création exclusive (jamais
// d'écrasement), synchronisés ; fichier retiré si l'écriture échoue.
func creerCleMaitresse(chemin string) (err error) {
	f, err := os.OpenFile(chemin, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o400)
	if err != nil {
		return errCle(chemin, "absente, et impossible à créer (dossier en lecture seule ? en production, deploy.sh la tire)")
	}
	var k [32]byte
	defer clear(k[:])
	rand.Read(k[:]) // ne rend jamais d'erreur (Go ≥ 1.24)
	_, err = f.Write(k[:])
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(chemin)
		return errCle(chemin, "écriture impossible")
	}
	return nil
}

// gcm : AES-256-GCM de la bibliothèque standard.
func gcm(cle []byte) (cipher.AEAD, error) {
	b, err := aes.NewCipher(cle)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}

// sceller : nonce aléatoire ‖ AES-256-GCM(cle, nonce, clair, ad ‖ id).
func sceller(cle []byte, ad, id string, clair []byte) ([]byte, error) {
	a, err := gcm(cle)
	if err != nil {
		return nil, err
	}
	out := make([]byte, tailleNonce, tailleNonce+len(clair)+a.Overhead())
	rand.Read(out)
	return a.Seal(out, out, clair, []byte(ad+id)), nil
}

// ouvrir : inverse de sceller ; erreur fixe si le chiffré ne s'authentifie pas.
func ouvrir(cle []byte, ad, id string, b []byte) ([]byte, error) {
	a, err := gcm(cle)
	if err != nil {
		return nil, err
	}
	if len(b) < tailleNonce+a.Overhead() {
		return nil, errReprise
	}
	clair, err := a.Open(nil, b[:tailleNonce], b[tailleNonce:], []byte(ad+id))
	if err != nil {
		return nil, errReprise
	}
	return clair, nil
}

// errReprise : état rangé illisible (autre clé maîtresse, ligne abîmée ou déplacée) ; le salon
// n'est pas repris.
var errReprise = errors.New("salon: état rangé illisible")

// --- Effacement des lignes ------------------------------------------------------------------

// errNoRows : sql.ErrNoRows (persistance.go).
var errNoRows = sql.ErrNoRows

// effacerReprises : toutes les lignes de reprise (tête et blocs) réécrites de zéros puis
// supprimées, en une transaction (secure_delete : les pages libérées sont aussi mises à zéro) ;
// le vidage du WAL suit (appelant). Table absente (base d'un binaire plus ancien, commandes hors
// du serveur) : rien à faire.
func effacerReprises(db *sql.DB) error {
	return effacerReprisesOu(db, "", nil)
}

// effacerReprise : effacerReprises pour le seul salon id (destruction hors ligne).
func effacerReprise(db *sql.DB, id string) error {
	return effacerReprisesOu(db, ` WHERE salon_id=?`, []any{id})
}

func effacerReprisesOu(db *sql.DB, cond string, args []any) error {
	var un int
	switch err := db.QueryRow(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='salons_reprise_blocs'`).Scan(&un); {
	case errors.Is(err, sql.ErrNoRows):
		return nil
	case err != nil:
		return base(err)
	}
	tx, err := db.Begin()
	if err != nil {
		return base(err)
	}
	defer tx.Rollback()
	if err := effacerReprisesTx(tx, cond, args); err != nil {
		return err
	}
	return base(tx.Commit())
}

// effacerRepriseTx : ligne du salon id effacée dans la transaction tx.
func effacerRepriseTx(tx *sql.Tx, id string) error {
	return effacerReprisesTx(tx, ` WHERE salon_id=?`, []any{id})
}

func effacerReprisesTx(tx *sql.Tx, cond string, args []any) error {
	for _, q := range []string{
		`UPDATE salons_reprise_blocs SET donnees=zeroblob(length(donnees))` + cond,
		`UPDATE salons_reprise SET cle=zeroblob(length(cle)), etat=zeroblob(length(etat))` + cond,
		`DELETE FROM salons_reprise_blocs` + cond,
		`DELETE FROM salons_reprise` + cond,
	} {
		if _, err := tx.Exec(q, args...); err != nil {
			return base(err)
		}
	}
	return nil
}

// --- Démarrage -------------------------------------------------------------------------------

// aReprendre : ligne de reprise d'un salon vivant, ouverte (clé de conversation et état en clair).
// version 1 : ligne d'un arrêt propre d'avant la persistance continue (fichier {id}.r) ;
// versions 2 et 3 : tête et blocs (journal, index) de la persistance continue (fichier {id} ;
// 3 : pièces en envoi comprises, D42-32).
type aReprendre struct {
	id              string
	exp             int64
	places          int
	rotation        uint32
	cle             [32]byte
	clair           []byte
	journal, index  []byte
	version         uint8
	nJ, nI          int
	reserve         uint64
	n, rotationTete uint32
}

func (r *aReprendre) oublier() {
	clear(r.cle[:])
	clear(r.clair)
	clear(r.journal)
	clear(r.index)
}

// lireReprises : lignes de reprise des salons encore vivants à now (ni échus, ni à 10 essais),
// ouvertes par la clé maîtresse, blocs compris. Une ligne illisible ou incomplète est ignorée
// (salon non repris).
func (m *Manager) lireReprises(now int64) ([]aReprendre, error) {
	if m.cfg.CleReprise == nil {
		return nil, nil
	}
	rows, err := m.cfg.DB.Query(`SELECT r.salon_id, r.cle, r.etat, s.expires_at, s.max_members, s.rotation_r
		FROM salons_reprise r JOIN salons s ON s.id=r.salon_id WHERE s.expires_at>? AND s.failed_attempts<?`, now, maxEssais)
	if err != nil {
		return nil, base(err)
	}
	var out []aReprendre
	for rows.Next() {
		var r aReprendre
		var env, etat []byte
		var rot int64
		if err := rows.Scan(&r.id, &env, &etat, &r.exp, &r.places, &rot); err != nil {
			rows.Close()
			return nil, base(err)
		}
		r.rotation = uint32(rot)
		if !idValide(r.id) || len(env) != tailleEnveloppe {
			continue
		}
		k, err := ouvrir(m.cfg.CleReprise[:], adCle, r.id, env)
		if err != nil || len(k) != 32 {
			continue
		}
		copy(r.cle[:], k)
		clear(k)
		if r.clair, err = ouvrir(r.cle[:], adEtat, r.id, etat); err != nil || len(r.clair) < 5 {
			clear(r.cle[:])
			continue
		}
		r.version = r.clair[0]
		out = append(out, r)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, base(err)
	}
	// Blocs (version 2) lus après la première requête : une seule connexion à la base.
	garde := out[:0]
	for i := range out {
		r := &out[i]
		if estTete(r.version) && m.lireBlocs(r) != nil {
			r.oublier()
			continue
		}
		if !estTete(r.version) && r.version != versionEtat {
			r.oublier()
			continue
		}
		garde = append(garde, *r)
	}
	return garde, nil
}

// lireBlocs : tête de version 2 lue (champs fixes) et blocs du salon ouverts, dans l'ordre et
// au complet (ni trou, ni bloc en trop).
func (m *Manager) lireBlocs(r *aReprendre) error {
	if len(r.clair) < 1+4+8+4+4+4 {
		return errReprise
	}
	l := &lecteurEtat{b: r.clair[1:]}
	r.n, r.reserve, r.rotationTete = l.u32(), l.u64(), l.u32()
	r.nJ, r.nI = int(l.u32()), int(l.u32())
	if r.nJ > nbBlocs(journalMax+nbSieges, blocJournal) || r.nI > nbBlocs(indexMax, blocIndex) {
		return errReprise
	}
	rows, err := m.cfg.DB.Query(`SELECT genre, n, donnees FROM salons_reprise_blocs WHERE salon_id=? ORDER BY genre, n`, r.id)
	if err != nil {
		return base(err)
	}
	defer rows.Close()
	attendu := [2]int{}
	for rows.Next() {
		var genre, n int
		var d []byte
		if err := rows.Scan(&genre, &n, &d); err != nil {
			return base(err)
		}
		if genre < 0 || genre > 1 || n != attendu[genre] || n >= [2]int{r.nJ, r.nI}[genre] {
			return errReprise
		}
		attendu[genre]++
		c, err := ouvrir(r.cle[:], adBloc, adBlocID(r.id, genre, n), d)
		if err != nil {
			return errReprise
		}
		if genre == genreJournal {
			r.journal = append(r.journal, c...)
		} else {
			r.index = append(r.index, c...)
		}
		clear(c)
	}
	if err := rows.Err(); err != nil {
		return base(err)
	}
	if attendu != [2]int{r.nJ, r.nI} {
		return errReprise
	}
	return nil
}

// garde : ce que la purge du démarrage garde (salons repris) : fichiers de conversation, pièces
// et octets de pièces (hors vocaux) de chaque salon repris.
type garde struct {
	conv   map[string]bool
	pieces map[string]bool
	octets map[string]int64
	salons []*salon
}

// reprendre : salons rangés remis en mémoire. Un salon dont le fichier manque ou ne correspond
// pas, dont l'état ne se décode pas, ou dont la rotation n'est pas celle de la base (exclusion
// faite après la dernière ligne validée), n'est pas repris (repli : « rejoindre » et
// refondation côté client). Une pièce dont le fichier ou la ligne « ready » manque est oubliée
// (sa trame reste : « pièce indisponible » chez le client). Rend ce que la purge doit garder.
func (m *Manager) reprendre(l []aReprendre) garde {
	g := garde{conv: map[string]bool{}, pieces: map[string]bool{}, octets: map[string]int64{}}
	for i := range l {
		r := &l[i]
		s := m.reprendre1(r)
		r.oublier()
		if s == nil {
			continue
		}
		g.conv[s.id] = true
		g.salons = append(g.salons, s)
		for id, p := range s.lesPieces {
			g.pieces[id] = true
			if !p.vocal {
				g.octets[s.id] += share.TotalSize(p.bucket)
			}
		}
	}
	return g
}

func (m *Manager) reprendre1(r *aReprendre) *salon {
	d := m.cfg.DossierConversations
	var n uint32
	switch r.version {
	case versionEtat:
		n = binary.BigEndian.Uint32(r.clair[1:5])
		// Arrêt propre d'un binaire d'avant la persistance continue : fichier mis de côté sous
		// {id}.r (ou déjà rendu à son nom par un démarrage interrompu).
		if err := os.Rename(filepath.Join(d, r.id+suffixeReprise), filepath.Join(d, r.id)); err != nil &&
			!errors.Is(err, os.ErrNotExist) {
			return nil
		}
	case versionTete, versionTete2:
		if r.rotationTete != r.rotation {
			return nil // exclusion écrite en base après la dernière ligne validée
		}
		n = r.n
	default:
		return nil
	}
	conv, err := reouvrirConversation(d, r.id, r.cle, n)
	if err != nil {
		return nil
	}
	s := nouveauSalon(r.id, time.Unix(r.exp, 0), r.places, conv, m.now)
	var pieces []*piece
	if r.version == versionEtat {
		pieces, err = s.decoderV1(r.clair[5:], n)
	} else {
		pieces, err = s.decoderV2(r, n)
	}
	if err == nil && !s.derniereLisible(conv) {
		err = errReprise
	}
	if err != nil {
		conv.fermer()
		return nil
	}
	s.flux = &m.flux
	s.glob = &m.tramesGlob
	if m.cfg.SalonFramesTotal > 0 {
		s.pot = &m.tramesPot
		s.part, s.potMax = m.partTrames()
	}
	m.reprendrePieces(s, pieces)
	conv.lec = m.lec
	conv.compterDans(&m.octetsConv)
	if s.glob != nil {
		s.glob.Add(int64(len(s.index)))
	}
	if s.pot != nil && len(s.index) > s.part {
		s.pot.Add(int64(len(s.index) - s.part))
	}
	// Persistance : la ligne lue est validée ; aucun rang au-delà de sa réserve tant qu'une
	// nouvelle ligne n'est pas écrite (PurgerAuDemarrage l'écrit avant l'écoute).
	s.p.actif = true
	s.poserConvLocked(conv, r.cle)
	s.p.peutExister = true
	s.p.borne, s.p.borneEcrite = s.seq, s.seq
	s.p.aEcraserSurs = uint64(len(s.aEcraser))
	if estTete(r.version) {
		s.p.ligne, s.p.journalEcrit, s.p.indexEcrit = true, len(s.journal), len(s.index)
	}
	m.mu.Lock()
	m.salons[s.id] = s
	m.mu.Unlock()
	m.indexer(func(index map[[32]byte]*salon) {
		for h := range s.jetons {
			index[h] = s
		}
		for h := range s.revoques {
			index[h] = s
		}
		for id := range s.lesPieces {
			m.pieceIdx[id] = s
		}
	})
	return s
}

// derniereLisible : la dernière trame encore servie de l'index se lit sous la clé de la
// conversation (sinon le fichier n'est pas le sien : recréé par un autre binaire, ou abîmé).
func (s *salon) derniereLisible(conv *Conversation) bool {
	for i := len(s.index) - 1; i >= 0; i-- {
		if e := s.index[i]; !e.efface() {
			_, err := conv.lire(e.emplacement)
			return err == nil
		}
	}
	return true
}

// reprendrePieces : pièces rangées gardées si leur fichier (taille exacte du palier) et leur
// ligne de ce salon sont là : « ready » pour une pièce prête ; pour une pièce en envoi (D42-32),
// « uploading » (segments reçus : ceux de la ligne, notés avant chaque accusé ; le délai
// PieceSansSegment repart de la reprise) ou « ready » (finalisée après la dernière passe : prête).
func (m *Manager) reprendrePieces(s *salon, l []*piece) {
	type ligne struct {
		prete  bool
		masque []byte
	}
	lignes := map[string]ligne{}
	if rows, err := m.cfg.DB.Query(`SELECT id, state, segments_mask FROM salon_pieces WHERE salon_id=?`, s.id); err == nil {
		for rows.Next() {
			var id, st string
			var masque []byte
			if rows.Scan(&id, &st, &masque) == nil && (st == "ready" || st == "uploading") {
				lignes[id] = ligne{st == "ready", masque}
			}
		}
		if rows.Err() != nil {
			clear(lignes)
		}
		rows.Close()
	}
	now := m.cfg.Now()
	for _, p := range l {
		lg, ok := lignes[p.id]
		fi, err := os.Lstat(filepath.Join(m.cfg.Pieces.Dir, p.id))
		if !ok || err != nil || !fi.Mode().IsRegular() || fi.Size() != share.TotalSize(p.bucket) {
			continue
		}
		switch {
		case p.etat == prete && !lg.prete:
			continue // jamais une pièce prête dont la ligne ne l'est pas
		case p.etat == envoi && lg.prete:
			p.etat, p.activite = prete, now
		case p.etat == envoi:
			segs := share.SegmentCount(p.bucket)
			if len(lg.masque) != (segs+7)/8 {
				continue
			}
			p.recus, p.activite = make([]bool, segs), now
			for n := range segs {
				if lg.masque[n/8]&(1<<(n%8)) != 0 {
					p.recus[n] = true
					p.ecrit += int64(share.SegmentSize(p.bucket, n))
				}
			}
		}
		if s.lesPieces == nil {
			s.lesPieces, s.libres = map[string]*piece{}, map[string]*piece{}
		}
		s.lesPieces[p.id] = p
		if p.lien == 0 {
			s.libres[p.id] = p
			continue
		}
		if s.pieces == nil {
			s.pieces = map[uint64]*piece{}
		}
		s.pieces[p.lien] = p
	}
}

// --- Décodage (en clair seulement sous la clé de la conversation) --------------------------
//
// Version 1 (arrêt propre du 25 novembre, lue pour la mise à jour seulement) : version (1) ‖ n
// emplacements (4) ‖ corps : seq, arrivées, signalé, signalements, départ, gen, réglé, appels
// jusqu'à ; sièges ; révoqués ; journal ; index (attendus sur 64 bits) ; échéances ;
// emplacements à écraser ; pièces prêtes. Version 2 : persistance.go.

func cmpStr(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func bit(v bool) uint8 {
	if v {
		return 1
	}
	return 0
}

// ms : heure en ms Unix, 0 pour l'heure nulle.
func ms(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// heure : inverse de ms.
func heure(v uint64) time.Time {
	if v == 0 || v > math.MaxInt64 {
		return time.Time{}
	}
	return time.UnixMilli(int64(v))
}

// lecteurEtat : lecture bornée du corps ; toute lecture hors du tampon pose err.
type lecteurEtat struct {
	b   []byte
	err bool
}

func (l *lecteurEtat) octets(n int) []byte {
	if l.err || n < 0 || len(l.b) < n {
		l.err = true
		return make([]byte, max(n, 0))
	}
	v := l.b[:n]
	l.b = l.b[n:]
	return v
}
func (l *lecteurEtat) u8() uint8   { return l.octets(1)[0] }
func (l *lecteurEtat) u16() uint16 { return binary.BigEndian.Uint16(l.octets(2)) }
func (l *lecteurEtat) u32() uint32 { return binary.BigEndian.Uint32(l.octets(4)) }
func (l *lecteurEtat) u64() uint64 { return binary.BigEndian.Uint64(l.octets(8)) }
func (l *lecteurEtat) b1() bool {
	v := l.u8()
	if v > 1 {
		l.err = true
	}
	return v == 1
}

// nombre : compte suivi d'éléments d'au moins taille octets chacun, au plus max.
func (l *lecteurEtat) nombre(max, taille int) int {
	k := int(l.u32())
	if k > max || k*taille > len(l.b) {
		l.err = true
		return 0
	}
	return k
}

// estTete : version d'une ligne de la persistance continue (tête et blocs).
func estTete(v uint8) bool { return v == versionTete || v == versionTete2 }

// longueurEnr : longueur exacte d'une annonce du journal de type ty (0 : type inconnu).
func longueurEnr(ty byte) int {
	switch ty {
	case 0x02, 0x0A:
		return 26
	case 0x03:
		return 10
	case 0x09:
		return 30
	}
	return 0
}

// indexMax : entrées de l'index au plus dans un état rangé (au-delà de tout plafond réglable).
const indexMax = 1 << 24

// decoderV1 : corps d'une ligne de version 1 remis dans s, n emplacements écrits.
func (s *salon) decoderV1(corps []byte, n uint32) ([]*piece, error) {
	l := &lecteurEtat{b: corps}
	s.seq = l.u64()
	s.decoderChamps(l)
	s.decoderSieges(l)
	s.decoderRevoques(l)
	s.decoderJournal(l, l.nombre(journalMax+nbSieges, 9))
	s.decoderIndex(l, l.nombre(indexMax, 30), n, true)
	for range l.nombre(len(s.index), 16) {
		e := echeance{ms: int64(l.u64()), seq: l.u64()}
		if s.chercherLocked(e.seq) < 0 {
			l.err = true
		}
		s.echeances = append(s.echeances, e)
	}
	s.decoderAEcraser(l, n)
	pieces := s.decoderPieces(l, false)
	if l.err || len(l.b) != 0 {
		return nil, errReprise
	}
	heap.Init(&s.echeances)
	return pieces, nil
}

// decoderV2 : tête (après ses champs fixes, lus par lireBlocs) et blocs remis dans s.
func (s *salon) decoderV2(r *aReprendre, n uint32) ([]*piece, error) {
	s.seq = r.reserve
	s.rotation = r.rotationTete
	lj := &lecteurEtat{b: r.journal}
	s.decoderJournal(lj, len(r.journal)/9)
	li := &lecteurEtat{b: r.index}
	if len(r.index)%tailleEntreeV2 != 0 || len(r.index)/tailleEntreeV2 > r.nI*blocIndex {
		return nil, errReprise
	}
	s.decoderIndex(li, len(r.index)/tailleEntreeV2, n, false)
	l := &lecteurEtat{b: r.clair[1+4+8+4+4+4:]}
	s.decoderChamps(l)
	s.decoderSieges(l)
	s.decoderRevoques(l)
	s.decoderAEcraser(l, n)
	pieces := s.decoderPieces(l, r.version == versionTete)
	if l.err || li.err || len(l.b) != 0 || len(li.b) != 0 || lj.err || nbBlocs(len(s.journal), blocJournal) != r.nJ ||
		nbBlocs(len(s.index), blocIndex) != r.nI {
		return nil, errReprise
	}
	heap.Init(&s.echeances)
	return pieces, nil
}

func (s *salon) decoderChamps(l *lecteurEtat) {
	s.arrivees = int(l.u32())
	s.signale = l.b1()
	for i := range s.signalements {
		s.signalements[i] = int(l.u32())
	}
	s.depart = l.u64()
	s.gen.Store(l.u64())
	s.regle = l.b1()
	if t := heure(l.u64()); !t.IsZero() {
		s.appelsJusqua = t
		s.appelsFin.Store(t.Unix())
	}
	if s.depart > s.seq || s.arrivees > math.MaxInt32 {
		l.err = true
	}
}

func (s *salon) decoderSieges(l *lecteurEtat) {
	occ := int(l.u8())
	if occ > nbSieges {
		l.err = true
		return
	}
	for range occ {
		k := l.u8()
		if l.err || k >= nbSieges || s.sieges[k] != nil {
			l.err = true
			return
		}
		x := &siege{}
		copy(x.nonce[:], l.octets(16))
		copy(x.jetonV[:], l.octets(32))
		x.emis, x.plancher, x.arrivee, x.repris, x.derniere = l.u64(), l.u64(), l.u64(), l.u64(), l.u64()
		x.jamaisConnecte = l.b1()
		x.entre = heure(l.u64())
		nr := int(l.u8())
		if nr > repriseMax {
			l.err = true
			return
		}
		for range nr {
			x.reprises = append(x.reprises, heure(l.u64()))
		}
		if x.emis > s.seq || x.plancher > s.seq || x.arrivee > x.emis || x.repris > s.seq {
			l.err = true
			return
		}
		if _, deja := s.jetons[x.jetonV]; deja {
			l.err = true
			return
		}
		s.sieges[k] = x
		s.jetons[x.jetonV] = k
		s.occ.Add(1)
	}
}

func (s *salon) decoderRevoques(l *lecteurEtat) {
	for range l.nombre(math.MaxUint16, 32) {
		var h [32]byte
		copy(h[:], l.octets(32))
		if _, ok := s.jetons[h]; ok {
			l.err = true
		}
		s.revoques[h] = struct{}{}
	}
}

// decoderJournal : k annonces au plus (version 2 : tant qu'il reste des octets).
func (s *salon) decoderJournal(l *lecteurEtat, k int) {
	var prec uint64
	for i := 0; i < k && !l.err && len(l.b) > 0; i++ {
		seq := l.u64()
		enr := slices.Clone(l.octets(int(l.u8())))
		if l.err || seq <= prec || seq > s.seq || len(enr) < 10 || longueurEnr(enr[0]) != len(enr) ||
			binary.BigEndian.Uint64(enr[1:9]) != seq {
			l.err = true
			return
		}
		prec = seq
		s.journal = append(s.journal, evenement{seq: seq, enr: enr})
	}
	if len(s.journal) > journalMax+nbSieges {
		l.err = true
	}
}

// decoderIndex : k entrées (v1 : attendus sur 64 bits, sans échéance ; v2 : 16 bits et échéance).
func (s *salon) decoderIndex(l *lecteurEtat, k int, n uint32, v1 bool) {
	if k > 0 {
		s.index = make([]entree, 0, k)
	}
	var prec uint64
	for range k {
		seq, recu := l.u64(), int64(l.u64())
		var att uint64
		if v1 {
			att = l.u64()
		} else {
			att = uint64(l.u16())
		}
		e := entree{seq: seq, recuMs: recu, attendus: uint16(att), emplacement: l.u32(), siege: l.u8(), drapeaux: l.u8()}
		var ech int64
		if !v1 {
			ech = int64(l.u64())
		}
		if l.err || e.seq <= prec || e.seq > s.seq || e.siege >= nbSieges || (!e.efface() && e.emplacement >= n) ||
			att>>nbSieges != 0 || ech < 0 {
			l.err = true
			return
		}
		prec = e.seq
		s.index = append(s.index, e)
		if ech != 0 {
			s.echeances = append(s.echeances, echeance{ms: ech, seq: e.seq})
		}
	}
}

func (s *salon) decoderAEcraser(l *lecteurEtat, n uint32) {
	for range l.nombre(len(s.index)+int(n), 4) {
		if e := l.u32(); e < n {
			s.aEcraser = append(s.aEcraser, e)
		} else {
			l.err = true
		}
	}
}

// decoderPieces : pièces de la tête ; avecEtat (version 3) : un octet d'état par pièce (prête ou
// en envoi ; segments reçus relus en base par reprendrePieces).
func (s *salon) decoderPieces(l *lecteurEtat, avecEtat bool) []*piece {
	var pieces []*piece
	vues := map[string]bool{}
	liens := map[uint64]bool{}
	for range l.nombre(math.MaxUint16, 1) {
		p := &piece{etat: prete, lus: map[[32]byte]int64{}}
		p.id = string(l.octets(int(l.u8())))
		if avecEtat {
			switch l.u8() {
			case rangeePrete:
			case rangeeEnvoi:
				p.etat = envoi
			default:
				l.err = true
			}
		}
		p.bucket = int(l.u32())
		p.vocal = l.b1()
		p.siege = l.u8()
		copy(p.auteur[:], l.octets(32))
		var places, activite, servis uint64
		p.rang, p.lien, p.gen, places, activite, servis = l.u64(), l.u64(), l.u64(), l.u64(), l.u64(), l.u64()
		p.places, p.activite, p.servis = int(min(places, nbSieges)), heure(activite), int64(min(servis, math.MaxInt64))
		for range l.nombre(math.MaxUint16, 40) {
			var jv [32]byte
			copy(jv[:], l.octets(32))
			p.lus[jv] = int64(min(l.u64(), math.MaxInt64))
		}
		if l.err || !idValide(p.id) || !PalierValide(p.bucket, p.vocal) || p.siege >= nbSieges || vues[p.id] ||
			p.rang > s.seq || p.gen != s.gen.Load() || (p.lien != 0 && (liens[p.lien] || s.chercherLocked(p.lien) < 0)) ||
			(p.etat == envoi && (p.lien != 0 || len(p.lus) != 0 || p.servis != 0)) {
			l.err = true
			return nil
		}
		vues[p.id] = true
		if p.lien != 0 {
			liens[p.lien] = true
		}
		pieces = append(pieces, p)
	}
	return pieces
}

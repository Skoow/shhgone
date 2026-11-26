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

// Salons persistants (conception du salon v3 §5.2, décision du propriétaire du 25 novembre :
// « oui, salons persistants, à garder l'historique »). Un redémarrage du serveur (donc chaque
// mise à jour) faisait perdre aux salons ouverts leur conversation (clé en mémoire), leurs
// sièges et leurs pièces : chaque client refaisait « rejoindre » puis le créateur refondait le
// groupe MLS. Désormais, à un ARRÊT PROPRE, chaque salon ouvert est rangé (Sauvegarder) puis
// repris au démarrage suivant (PurgerAuDemarrage) : mêmes sièges et jetons, même journal, même
// index des trames, mêmes pièces prêtes, même compteur seq. Un client resté ouvert se reconnecte
// avec son jeton et son `depuis` (1001, comme après toute coupure) et continue dans le même
// groupe MLS, sans refondation ; un membre absent rattrape l'historique.
//
// Ce qui est rangé, et où :
//   - shares.db, table salons_reprise, une ligne par salon : clé du fichier de conversation
//     enveloppée par la clé maîtresse des salons (AES-256-GCM, bibliothèque standard ; données
//     authentifiées adCle ‖ identifiant) et état du salon chiffré sous la clé de sa conversation
//     (adEtat ‖ identifiant) ; aucune colonne en clair hormis l'identifiant interne ;
//   - le fichier de conversation, renommé {id}.r (suffixeReprise) le temps de l'arrêt ;
//   - les fichiers et lignes des pièces prêtes, laissés en place.
//
// La clé maîtresse (SHH_SALONS_CLE_FILE, 32 octets, 0400 : LireCleMaitresse) est hors de la base,
// hors de SHH_DATA_DIR et des sauvegardes. En marche, la table est VIDE : les lignes sont relues
// puis effacées (réécrites de zéros, puis supprimées ; secure_delete, vidage du WAL) au démarrage,
// avant toute écoute. La clé d'une conversation n'est donc sur le disque, enveloppée, que pendant
// le redémarrage (ou tant que le serveur reste arrêté).
//
// Ce qui n'est PAS repris (remis à neuf, comme une connexion neuve) : connexions et présences
// (tous hors ligne jusqu'à leur retour), seaux des limites de trames, de pièces et réserve
// vocale, lectures de pièces en cours, pièces encore en envoi ou en finalisation (perdues :
// l'envoi est à refaire), places des blocs anti-abus (Manager.vivants : la clé de bloc dérive de
// l'adresse, jamais écrite). Un arrêt BRUTAL (panne, mémoire, coupure de courant, SIGKILL) ne
// range rien : le démarrage purge alors les conversations et pièces comme avant, et les clients
// refont « rejoindre » puis refondent le groupe (repli gardé, client.ts).

const (
	// suffixeReprise : nom du fichier de conversation d'un salon rangé (jamais un identifiant
	// valide : le brouillage des dates l'ignore, la purge du démarrage l'efface s'il n'est pas
	// repris, un ancien binaire aussi).
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

// --- Arrêt -----------------------------------------------------------------------------------

// Sauvegarder range chaque salon ouvert (ni fini, ni échu) pour le démarrage suivant : à appeler
// une seule fois, à l'arrêt, APRÈS FermerTout, AttendreConnexions et l'arrêt de l'entretien (Run),
// et avant la fermeture de la base. Chaque salon est d'abord figé sous son verrou (plus rien n'y
// entre ni n'y change : il est fini pour ce processus, sans partie disque), son état copié, puis
// sa conversation mise de côté sous le nom {id}.r (plus aucune écriture), et sa ligne de reprise
// écrite, un salon après l'autre (un arrêt forcé en cours de route garde les salons déjà rangés ;
// un salon à moitié rangé n'a pas de ligne, son fichier est purgé au démarrage). Sans clé
// maîtresse (Config.CleReprise nil) : rien n'est rangé, comme avant. Rend le nombre de salons
// rangés et les erreurs (sans identifiant).
func (m *Manager) Sauvegarder() (int, error) {
	if m.cfg.CleReprise == nil {
		return 0, nil
	}
	if err := effacerReprises(m.cfg.DB); err != nil { // vide en marche ; reste d'un arrêt raté
		return 0, err
	}
	now := m.cfg.Now()
	var errs []error
	nb := 0
	for _, s := range m.copieSalons(nil) {
		corps, conv := s.figer(now)
		if conv == nil {
			continue
		}
		if err := m.ranger1(s.id, corps, conv); err != nil {
			errs = append(errs, err)
			continue
		}
		nb++
	}
	return nb, errors.Join(errs...)
}

// figer : sous le verrou du salon, état copié (encoderLocked) et salon fini pour ce processus
// (fini posé sans partie disque : plus aucune entrée, trame, lecture ni pièce n'y change rien).
// conv nil : salon à ne pas ranger (déjà fini, échu, sans conversation, renouvellement pas
// terminé).
func (s *salon) figer(now time.Time) ([]byte, *Conversation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fini {
		return nil, nil
	}
	var corps []byte
	conv := s.conv
	if !now.Before(s.expires) || conv == nil || s.ancienne != nil {
		conv = nil
	} else {
		corps = s.encoderLocked()
	}
	s.fini = true
	s.finiA.Store(true)
	return corps, conv
}

// ranger1 : conversation mise de côté, clé enveloppée, état scellé sous la clé de la
// conversation, ligne écrite.
func (m *Manager) ranger1(id string, corps []byte, conv *Conversation) error {
	cle, n, err := conv.mettreDeCote(filepath.Join(m.cfg.DossierConversations, id+suffixeReprise))
	defer clear(cle[:])
	if err != nil {
		return err
	}
	clair := binary.BigEndian.AppendUint32([]byte{versionEtat}, n)
	clair = append(clair, corps...)
	etat, err := sceller(cle[:], adEtat, id, clair)
	clear(clair)
	if err != nil {
		return err
	}
	env, err := sceller(m.cfg.CleReprise[:], adCle, id, cle[:])
	if err != nil {
		return err
	}
	_, err = m.cfg.DB.Exec(`INSERT INTO salons_reprise(salon_id,cle,etat) VALUES(?,?,?)`, id, env, etat)
	return base(err)
}

// --- Démarrage -------------------------------------------------------------------------------

// aReprendre : ligne de reprise d'un salon vivant, ouverte (clé de conversation et état en clair).
type aReprendre struct {
	id     string
	exp    int64
	places int
	cle    [32]byte
	clair  []byte
}

// lireReprises : lignes de reprise des salons encore vivants à now (ni échus, ni à 10 essais),
// ouvertes par la clé maîtresse. Une ligne illisible est ignorée (salon non repris).
func (m *Manager) lireReprises(now int64) ([]aReprendre, error) {
	if m.cfg.CleReprise == nil {
		return nil, nil
	}
	rows, err := m.cfg.DB.Query(`SELECT r.salon_id, r.cle, r.etat, s.expires_at, s.max_members FROM salons_reprise r
		JOIN salons s ON s.id=r.salon_id WHERE s.expires_at>? AND s.failed_attempts<?`, now, maxEssais)
	if err != nil {
		return nil, base(err)
	}
	defer rows.Close()
	var out []aReprendre
	for rows.Next() {
		var r aReprendre
		var env, etat []byte
		if err := rows.Scan(&r.id, &env, &etat, &r.exp, &r.places); err != nil {
			return nil, base(err)
		}
		if !idValide(r.id) || len(env) != tailleEnveloppe {
			continue
		}
		k, err := ouvrir(m.cfg.CleReprise[:], adCle, r.id, env)
		if err != nil || len(k) != 32 {
			continue
		}
		copy(r.cle[:], k)
		clear(k)
		if r.clair, err = ouvrir(r.cle[:], adEtat, r.id, etat); err != nil {
			clear(r.cle[:])
			continue
		}
		out = append(out, r)
	}
	return out, base(rows.Err())
}

// effacerReprises : toutes les lignes de reprise réécrites de zéros puis supprimées, en une
// transaction (secure_delete : les pages libérées sont aussi mises à zéro) ; le vidage du WAL
// suit (appelant). Table absente (base d'un binaire plus ancien, commandes hors du serveur) :
// rien à faire.
func effacerReprises(db *sql.DB) error {
	return effacerReprisesOu(db, "", nil)
}

// effacerReprisesOu : effacerReprises, limité au salon id s'il est donné.
func effacerReprisesOu(db *sql.DB, cond string, args []any) error {
	var un int
	switch err := db.QueryRow(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='salons_reprise'`).Scan(&un); {
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
	if _, err := tx.Exec(`UPDATE salons_reprise SET cle=zeroblob(length(cle)), etat=zeroblob(length(etat))`+cond, args...); err != nil {
		return base(err)
	}
	if _, err := tx.Exec(`DELETE FROM salons_reprise`+cond, args...); err != nil {
		return base(err)
	}
	return base(tx.Commit())
}

// effacerReprise : effacerReprises pour le seul salon id (destruction hors ligne).
func effacerReprise(db *sql.DB, id string) error {
	return effacerReprisesOu(db, ` WHERE salon_id=?`, []any{id})
}

// garde : ce que la purge du démarrage garde (salons repris) : fichiers de conversation, pièces
// et octets de pièces (hors vocaux) de chaque salon repris.
type garde struct {
	conv   map[string]bool
	pieces map[string]bool
	octets map[string]int64
}

// reprendre : salons rangés remis en mémoire (après l'effacement des lignes de reprise :
// une ligne ne survit jamais à sa reprise). Un salon dont le fichier manque ou ne correspond
// pas, ou dont l'état ne se décode pas, n'est pas repris (repli : « rejoindre » et refondation
// côté client). Une pièce dont le fichier ou la ligne « ready » manque est oubliée (sa trame
// reste : « pièce indisponible » chez le client). Rend ce que la purge doit garder.
func (m *Manager) reprendre(l []aReprendre) garde {
	g := garde{conv: map[string]bool{}, pieces: map[string]bool{}, octets: map[string]int64{}}
	for i := range l {
		r := &l[i]
		s := m.reprendre1(r)
		clear(r.cle[:])
		clear(r.clair)
		if s == nil {
			continue
		}
		g.conv[s.id] = true
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
	if len(r.clair) < 5 || r.clair[0] != versionEtat {
		return nil
	}
	n := binary.BigEndian.Uint32(r.clair[1:5])
	if err := os.Rename(filepath.Join(d, r.id+suffixeReprise), filepath.Join(d, r.id)); err != nil {
		return nil
	}
	conv, err := reouvrirConversation(d, r.id, r.cle, n)
	if err != nil {
		return nil
	}
	s := nouveauSalon(r.id, time.Unix(r.exp, 0), r.places, conv, m.now)
	pieces, err := s.decoder(r.clair[5:], n)
	if err != nil {
		conv.Detruire()
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

// reprendrePieces : pièces rangées gardées si leur fichier (taille exacte du palier) et leur
// ligne « ready » de ce salon sont là.
func (m *Manager) reprendrePieces(s *salon, l []*piece) {
	pretes := map[string]bool{}
	if rows, err := m.cfg.DB.Query(`SELECT id FROM salon_pieces WHERE salon_id=? AND state='ready'`, s.id); err == nil {
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				pretes[id] = true
			}
		}
		if rows.Err() != nil {
			clear(pretes)
		}
		rows.Close()
	}
	for _, p := range l {
		fi, err := os.Lstat(filepath.Join(m.cfg.Pieces.Dir, p.id))
		if !pretes[p.id] || err != nil || !fi.Mode().IsRegular() || fi.Size() != share.TotalSize(p.bucket) {
			continue
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

// --- Format de l'état (en clair seulement sous la clé de la conversation) ------------------
//
// version (1) ‖ n emplacements (4) ‖ corps : entiers gros-boutistes ; heures en ms Unix (0 :
// aucune). Le corps : seq, arrivées, signalé, signalements, départ, gen, réglé, appels jusqu'à ;
// sièges ; révoqués ; journal ; index ; échéances ; emplacements à écraser ; pièces prêtes.

// encoderLocked : corps de l'état du salon. Appelé sous s.mu.
func (s *salon) encoderLocked() []byte {
	b := binary.BigEndian.AppendUint64(nil, s.seq)
	b = binary.BigEndian.AppendUint32(b, uint32(s.arrivees))
	b = append(b, bit(s.signale))
	for _, k := range s.signalements {
		b = binary.BigEndian.AppendUint32(b, uint32(k))
	}
	b = binary.BigEndian.AppendUint64(b, s.depart)
	b = binary.BigEndian.AppendUint64(b, s.gen.Load())
	b = append(b, bit(s.regle))
	b = binary.BigEndian.AppendUint64(b, uint64(ms(s.appelsJusqua)))
	b = append(b, uint8(s.occupesLocked()))
	for n, x := range s.sieges {
		if x == nil {
			continue
		}
		b = append(b, uint8(n))
		b = append(b, x.nonce[:]...)
		b = append(b, x.jetonV[:]...)
		for _, v := range []uint64{x.emis, x.plancher, x.arrivee, x.repris, x.derniere} {
			b = binary.BigEndian.AppendUint64(b, v)
		}
		b = append(b, bit(x.jamaisConnecte))
		b = binary.BigEndian.AppendUint64(b, uint64(ms(x.entre)))
		b = append(b, uint8(len(x.reprises)))
		for _, t := range x.reprises {
			b = binary.BigEndian.AppendUint64(b, uint64(ms(t)))
		}
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.revoques)))
	for h := range s.revoques {
		b = append(b, h[:]...)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.journal)))
	for _, ev := range s.journal {
		b = binary.BigEndian.AppendUint64(b, ev.seq)
		b = append(b, uint8(len(ev.enr)))
		b = append(b, ev.enr...)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.index)))
	for _, e := range s.index {
		b = binary.BigEndian.AppendUint64(b, e.seq)
		b = binary.BigEndian.AppendUint64(b, uint64(e.recuMs))
		b = binary.BigEndian.AppendUint64(b, uint64(e.attendus))
		b = binary.BigEndian.AppendUint32(b, e.emplacement)
		b = append(b, e.siege, e.drapeaux)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.echeances)))
	for _, e := range s.echeances {
		b = binary.BigEndian.AppendUint64(b, uint64(e.ms))
		b = binary.BigEndian.AppendUint64(b, e.seq)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.aEcraser)))
	for _, e := range s.aEcraser {
		b = binary.BigEndian.AppendUint32(b, e)
	}
	var pretes []*piece
	for _, p := range s.lesPieces {
		if p.etat == prete && !p.efface && p.ecritures == 0 {
			pretes = append(pretes, p)
		}
	}
	slices.SortFunc(pretes, func(a, c *piece) int { return cmpStr(a.id, c.id) })
	b = binary.BigEndian.AppendUint32(b, uint32(len(pretes)))
	for _, p := range pretes {
		b = append(b, uint8(len(p.id)))
		b = append(b, p.id...)
		b = binary.BigEndian.AppendUint32(b, uint32(p.bucket))
		b = append(b, bit(p.vocal), p.siege)
		b = append(b, p.auteur[:]...)
		for _, v := range []uint64{p.rang, p.lien, p.gen, uint64(p.places), uint64(ms(p.activite)), uint64(p.servis)} {
			b = binary.BigEndian.AppendUint64(b, v)
		}
		b = binary.BigEndian.AppendUint32(b, uint32(len(p.lus)))
		for jv, k := range p.lus {
			b = append(b, jv[:]...)
			b = binary.BigEndian.AppendUint64(b, uint64(k))
		}
	}
	return b
}

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

// decoder : corps de l'état (encoderLocked) remis dans s, n emplacements écrits ; rend les
// pièces rangées (gardées ensuite si leurs fichiers sont là). Chaque valeur est bornée et
// cohérente (rangs croissants, sièges, emplacements) : un état incohérent n'est pas repris.
// L'état est authentifié (AES-GCM sous la clé de la conversation) : ces contrôles sont une
// défense de plus, contre une erreur de ce code.
func (s *salon) decoder(corps []byte, n uint32) ([]*piece, error) {
	l := &lecteurEtat{b: corps}
	s.seq = l.u64()
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
	occ := int(l.u8())
	if occ > nbSieges || s.depart > s.seq || s.arrivees > math.MaxInt32 {
		return nil, errReprise
	}
	for range occ {
		k := l.u8()
		if k >= nbSieges || s.sieges[k] != nil {
			return nil, errReprise
		}
		x := &siege{}
		copy(x.nonce[:], l.octets(16))
		copy(x.jetonV[:], l.octets(32))
		x.emis, x.plancher, x.arrivee, x.repris, x.derniere = l.u64(), l.u64(), l.u64(), l.u64(), l.u64()
		x.jamaisConnecte = l.b1()
		x.entre = heure(l.u64())
		nr := int(l.u8())
		if nr > repriseMax {
			return nil, errReprise
		}
		for range nr {
			x.reprises = append(x.reprises, heure(l.u64()))
		}
		if x.emis > s.seq || x.plancher > s.seq || x.arrivee > x.emis || x.repris > s.seq {
			return nil, errReprise
		}
		if _, deja := s.jetons[x.jetonV]; deja {
			return nil, errReprise
		}
		s.sieges[k] = x
		s.jetons[x.jetonV] = k
		s.occ.Add(1)
	}
	for range l.nombre(math.MaxUint16, 32) {
		var h [32]byte
		copy(h[:], l.octets(32))
		if _, ok := s.jetons[h]; ok {
			return nil, errReprise
		}
		s.revoques[h] = struct{}{}
	}
	var prec uint64
	for range l.nombre(journalMax+nbSieges, 9) {
		seq := l.u64()
		enr := slices.Clone(l.octets(int(l.u8())))
		if l.err || seq <= prec || seq > s.seq || len(enr) < 10 || longueurEnr(enr[0]) != len(enr) ||
			binary.BigEndian.Uint64(enr[1:9]) != seq {
			return nil, errReprise
		}
		prec = seq
		s.journal = append(s.journal, evenement{seq: seq, enr: enr})
	}
	prec = 0
	k := l.nombre(indexMax, 30)
	if k > 0 {
		s.index = make([]entree, 0, k)
	}
	for range k {
		seq, recu, att := l.u64(), int64(l.u64()), l.u64()
		e := entree{seq: seq, recuMs: recu, attendus: uint16(att), emplacement: l.u32(), siege: l.u8(), drapeaux: l.u8()}
		if e.seq <= prec || e.seq > s.seq || e.siege >= nbSieges || (!e.efface() && e.emplacement >= n) ||
			att>>nbSieges != 0 {
			return nil, errReprise
		}
		prec = e.seq
		s.index = append(s.index, e)
	}
	for range l.nombre(len(s.index), 16) {
		e := echeance{ms: int64(l.u64()), seq: l.u64()}
		if s.chercherLocked(e.seq) < 0 {
			return nil, errReprise
		}
		s.echeances = append(s.echeances, e) // ordre du tas gardé tel quel
	}
	for range l.nombre(len(s.index)+int(n), 4) {
		e := l.u32()
		if e >= n {
			return nil, errReprise
		}
		s.aEcraser = append(s.aEcraser, e)
	}
	var pieces []*piece
	vues := map[string]bool{}
	liens := map[uint64]bool{}
	for range l.nombre(math.MaxUint16, 1) {
		p := &piece{etat: prete, lus: map[[32]byte]int64{}}
		p.id = string(l.octets(int(l.u8())))
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
			p.rang > s.seq || p.gen != s.gen.Load() || (p.lien != 0 && (liens[p.lien] || s.chercherLocked(p.lien) < 0)) {
			return nil, errReprise
		}
		vues[p.id] = true
		if p.lien != 0 {
			liens[p.lien] = true
		}
		pieces = append(pieces, p)
	}
	if l.err || len(l.b) != 0 {
		return nil, errReprise
	}
	s.echeancesEnTas()
	return pieces, nil
}

// echeancesEnTas : le tas d'échéances rétabli (l'ordre rangé est déjà celui d'un tas ;
// heap.Init le garantit quoi qu'il arrive).
func (s *salon) echeancesEnTas() { heap.Init(&s.echeances) }

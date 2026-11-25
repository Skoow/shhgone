package salon

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/skoow/shhdrop/server/internal/blob"
)

// Fichier de conversation (v3 §5.1) : un emplacement de
// TailleEmplacement octets par trame non volatile, dans l'ordre d'arrivée :
// nonce (12, aléatoire) ‖ AES-256-GCM(clé, nonce, trame, adConv ‖ numéro d'emplacement (8)).
// La clé est tirée à l'ouverture et ne vit qu'en mémoire tant que le serveur tourne : un disque
// saisi ou copié pendant la marche ne donne que des emplacements illisibles. Aucun seq, siège,
// heure ni drapeau en clair. Seul un arrêt propre (reprise.go, décision du 25 novembre) range la
// clé sur le disque, enveloppée par la clé maîtresse des salons, le temps du redémarrage ; elle
// est relue puis effacée de la base au démarrage suivant. Aucun fsync par trame : un arrêt
// brutal ne range rien, et le fichier est alors purgé au démarrage (clé perdue).
//
// Ce que le fichier ne dit pas à qui lit le disque :
//   - trame effacée = emplacement écrasé d'octets ALÉATOIRES (et non de zéros) : il ne
//     s'authentifie plus (ErrEfface) et ne se distingue pas d'un emplacement vivant ;
//   - le fichier grandit par PALIERS de emplacementsParPalier emplacements, remplis d'aléa à
//     leur création : sa taille ne donne que l'ordre de grandeur du nombre de trames.
//
// Borne des appels disque : aucune
// méthode n'attend une place sous un verrou. Les ÉCRITURES (Ajouter,
// EffacerPlusieurs) ne prennent aucune borne ici : l'appelant (Manager) tient une place de la
// borne des écritures, prise hors de tout verrou de salon. Les LECTURES (Lire) prennent une
// place de la borne des lectures (lec) AVANT le verrou de la conversation.

// TailleEmplacement : nonce (12) ‖ trame chiffrée (4 140) ‖ étiquette GCM (16).
const TailleEmplacement = tailleNonce + TailleTrame + 16

// emplacementsParPalier : le fichier grandit de ce nombre d'emplacements à la fois (≈ 267 Ko).
const emplacementsParPalier = 64

// TaillePalier : octets ajoutés au fichier à chaque palier.
const TaillePalier = emplacementsParPalier * TailleEmplacement

const tailleNonce = 12

// adConv : début des données authentifiées ; le numéro d'emplacement qui suit empêche de
// déplacer ou d'échanger des emplacements dans le fichier.
const adConv = "shhdrop/salon/disque/v1"

var (
	// ErrEfface : emplacement écrasé (aléa), ou qui ne s'authentifie pas (autre clé,
	// emplacement déplacé ou modifié).
	ErrEfface = errors.New("salon: trame effacée")
	// ErrEmplacement : emplacement jamais écrit.
	ErrEmplacement = errors.New("salon: emplacement inconnu")
	// ErrDetruite : conversation détruite (clé oubliée, fichier supprimé).
	ErrDetruite = errors.New("salon: conversation détruite")
	// ErrPleine : plus aucun numéro d'emplacement (2^32 − 1 écrits).
	ErrPleine = errors.New("salon: conversation pleine")

	// ErrES : erreur d'entrée-sortie du fichier de conversation. Message fixe, sans chemin ;
	// errors.Is reconnaît aussi le code système d'origine (ENOSPC, os.ErrExist…).
	ErrES = errors.New("salon: erreur d'entrée-sortie de la conversation")
	// ErrInutilisable : une écriture n'a pas pu être annulée (taille du fichier incertaine) ;
	// seule Detruire reste possible.
	ErrInutilisable = errors.New("salon: conversation inutilisable")

	errIDConv = errors.New("salon: identifiant de conversation invalide")
)

// erreurES : ErrES, avec le seul code système d'origine (jamais le chemin d'une PathError).
type erreurES struct{ code error }

func (e erreurES) Error() string       { return ErrES.Error() }
func (e erreurES) Is(cible error) bool { return cible == ErrES }
func (e erreurES) Unwrap() error       { return e.code }

// es encapsule err dans ErrES ; nil reste nil.
func es(err error) error {
	if err == nil {
		return nil
	}
	var code syscall.Errno
	if errors.As(err, &code) {
		return erreurES{code}
	}
	return erreurES{}
}

// fichierEcriture : ce que Conversation utilise du fichier d'écriture (*os.File ; remplacé
// par les tests pour injecter des pannes).
type fichierEcriture interface {
	WriteAt([]byte, int64) (int, error)
	Truncate(int64) error
	Close() error
}

// Conversation : fichier de conversation d'un salon. Sûr pour un usage concurrent.
type Conversation struct {
	mu      sync.RWMutex
	chemin  string
	f       fichierEcriture // écritures
	lecteur *os.File        // lectures, ouvert avec O_NOATIME quand le système le permet
	// lec : borne des lectures de conversation (Manager.lec), posée par le Manager après
	// l'ouverture (etat, renouvellement) ; nil : sans borne (tests). Prise avant mu, jamais
	// dessous (les lectures du rattrapage tenaient un fil du système par connexion).
	lec *blob.Gate
	// aead : chiffrement de la clé (tirée dans OuvrirConversation) ; lâché par Detruire. La
	// bibliothèque standard ne permet pas d'effacer le calendrier de clés d'un chiffrement
	// AES : la clé est oubliée, pas effacée de la mémoire. cle : la clé elle-même, gardée pour
	// être enveloppée à un arrêt propre (mettreDeCote, reprise.go) ; mise à zéro par Detruire et
	// mettreDeCote. Jamais écrite ailleurs qu'enveloppée.
	aead cipher.AEAD
	cle  [32]byte
	n    uint32 // emplacements écrits
	// inutilisable : Truncate a échoué après une écriture ratée ; tailleMax borne alors le
	// fichier réel (Taille ne le sous-compte jamais).
	inutilisable bool
	tailleMax    int64
	detruite     bool
	supprime     bool // fichier supprimé (Detruire réessaie sinon)
	// taille : valeur de Taille, tenue à jour sous mu (poserTaille) et lue sans verrou ;
	// total (nil : aucun) reçoit chaque écart (Manager.octetsConv, compterDans).
	taille atomic.Int64
	total  *atomic.Int64
}

// poserTaille : nouvelle valeur de Taille, écart reporté au total. Appelé sous c.mu.
func (c *Conversation) poserTaille(t int64) {
	if d := t - c.taille.Swap(t); c.total != nil {
		c.total.Add(d)
	}
}

// compterDans : la taille de la conversation (et chacun de ses changements) est ajoutée à
// total, dès maintenant.
func (c *Conversation) compterDans(total *atomic.Int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total = total
	total.Add(c.taille.Load())
}

// idValide : 22 caractères base64url canoniques (16 octets), anti traversée de chemin.
func idValide(id string) bool {
	if len(id) != 22 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	b, err := b64.DecodeString(id)
	return err == nil && len(b) == 16
}

// sansDate met les dates du fichier à l'epoch (comme blob.wipeTimes).
func sansDate(p string) error { return es(os.Chtimes(p, time.Unix(0, 0), time.Unix(0, 0))) }

// dossierSansDate : dates du dossier de p remises à l'epoch après la création ou la
// suppression de p, au mieux : un échec n'annule pas l'opération faite ; la date de
// changement d'inode (ctime) ne peut pas être remise.
func dossierSansDate(p string) { _ = sansDate(filepath.Dir(p)) }

// etat : erreur fixe si la conversation ne sert plus (appelant sous c.mu).
func (c *Conversation) etat() error {
	switch {
	case c.detruite:
		return ErrDetruite
	case c.inutilisable:
		return ErrInutilisable
	}
	return nil
}

// ecrire écrit p en off ; les dates sont remises à l'epoch même en cas d'erreur (écriture
// partielle), comme blob.WriteAt.
func (c *Conversation) ecrire(p []byte, off int64) (err error) {
	defer func() {
		if derr := sansDate(c.chemin); err == nil {
			err = derr
		}
	}()
	_, err = c.f.WriteAt(p, off)
	return es(err)
}

// annuler ramène le fichier à taille octets après une écriture ratée ; si Truncate échoue,
// la conversation devient inutilisable (sa taille réelle n'est plus connue exactement).
func (c *Conversation) annuler(taille, max int64) {
	defer sansDate(c.chemin)
	if c.f.Truncate(taille) != nil {
		c.inutilisable, c.tailleMax = true, max
		c.poserTaille(max)
	}
}

// OuvrirConversation crée dossier/id (qui ne doit pas exister, mode 0600) et tire sa clé.
func OuvrirConversation(dossier, id string) (*Conversation, error) {
	return ouvrirConversation(dossier, id, filepath.Join(dossier, id))
}

// suffixeProvisoire : fin du nom provisoire de la conversation neuve d'un renouvellement, le
// temps que l'ancienne soit détruite (reglages.go). Jamais un identifiant valide : le
// brouillage des dates l'ignore, la purge du démarrage l'efface comme tout le dossier.
const suffixeProvisoire = ".n"

func cheminProvisoire(dossier, id string) string { return filepath.Join(dossier, id+suffixeProvisoire) }

// ouvrirConversation : OuvrirConversation, fichier créé à chemin (dans dossier).
func ouvrirConversation(dossier, id, chemin string) (*Conversation, error) {
	if !idValide(id) {
		return nil, errIDConv
	}
	if err := os.MkdirAll(dossier, 0o700); err != nil {
		return nil, es(err)
	}
	c := &Conversation{chemin: chemin}
	f, err := os.OpenFile(c.chemin, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, es(err)
	}
	dossierSansDate(c.chemin)
	c.f = f
	ok := false
	defer func() {
		if !ok {
			c.Detruire()
		}
	}()
	if c.lecteur, err = blob.OpenRead(c.chemin); err != nil {
		return nil, es(err)
	}
	rand.Read(c.cle[:]) // ne rend jamais d'erreur (Go ≥ 1.24)
	if err := c.poserCle(); err != nil {
		return nil, err
	}
	if err := sansDate(c.chemin); err != nil {
		return nil, err
	}
	ok = true
	return c, nil
}

// poserCle : chiffrement AES-256-GCM de c.cle.
func (c *Conversation) poserCle() error {
	bloc, err := aes.NewCipher(c.cle[:])
	if err != nil {
		return err
	}
	c.aead, err = cipher.NewGCM(bloc)
	return err
}

// reouvrirConversation : conversation d'un salon repris après un arrêt propre (reprise.go) :
// fichier existant dossier/id, clé cle, n emplacements écrits. La taille du fichier doit être
// exactement celle de n emplacements arrondie au palier (Ajouter : un palier entier écrit d'un
// coup, ramené à sa taille d'avant en cas d'échec) ; sinon ErrInutilisable, rien n'est gardé
// ouvert. La clé est copiée : l'appelant met la sienne à zéro.
func reouvrirConversation(dossier, id string, cle [32]byte, n uint32) (*Conversation, error) {
	if !idValide(id) || n == math.MaxUint32 {
		return nil, errIDConv
	}
	c := &Conversation{chemin: filepath.Join(dossier, id), cle: cle, n: n}
	f, err := os.OpenFile(c.chemin, os.O_RDWR|syscall.O_NOFOLLOW, 0)
	if err != nil {
		clear(c.cle[:])
		return nil, es(err)
	}
	c.f = f
	ok := false
	defer func() {
		if !ok {
			clear(c.cle[:])
			c.aead = nil
			c.f.Close()
			if c.lecteur != nil {
				c.lecteur.Close()
			}
		}
	}()
	fi, err := f.Stat()
	if err != nil {
		return nil, es(err)
	}
	attendue := (int64(n) + emplacementsParPalier - 1) / emplacementsParPalier * TaillePalier
	if !fi.Mode().IsRegular() || fi.Size() != attendue {
		return nil, ErrInutilisable
	}
	if c.lecteur, err = blob.OpenRead(c.chemin); err != nil {
		return nil, es(err)
	}
	if err := c.poserCle(); err != nil {
		return nil, err
	}
	c.taille.Store(attendue)
	if err := sansDate(c.chemin); err != nil {
		return nil, err
	}
	ok = true
	return c, nil
}

// mettreDeCote : arrêt propre (reprise.go) : plus rien ne s'écrit ni ne se lit dans la
// conversation (ErrDetruite), son fichier prend le nom chemin (même dossier) et ses descripteurs
// sont fermés ; rend une copie de la clé et le nombre d'emplacements écrits, puis met la clé à
// zéro. Le fichier n'est jamais supprimé ensuite par cette conversation (Detruire ne le touche
// plus). Conversation détruite ou inutilisable : son erreur, rien n'est changé. Le renommage
// d'abord : le nom de reprise ne désigne jamais un fichier encore écrit par ce processus, et un
// ancien serveur qui purge le dossier au démarrage l'efface (aucune reprise sur un fichier qu'il
// aurait recréé sous le nom du salon).
func (c *Conversation) mettreDeCote(chemin string) (cle [32]byte, n uint32, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.etat(); err != nil {
		return cle, 0, err
	}
	if err := os.Rename(c.chemin, chemin); err != nil {
		return cle, 0, es(err)
	}
	c.chemin = chemin
	dossierSansDate(chemin)
	_ = sansDate(chemin)
	cle, n = c.cle, c.n
	clear(c.cle[:])
	c.aead = nil
	c.detruite, c.supprime = true, true // plus à elle : ni écrite, ni lue, ni supprimée
	if c.lecteur != nil {
		c.lecteur.Close()
	}
	c.f.Close()
	return cle, n, nil
}

// ad : données authentifiées de l'emplacement e.
func ad(e uint32) []byte {
	return binary.BigEndian.AppendUint64([]byte(adConv), uint64(e))
}

func decalage(e uint32) int64 { return int64(e) * TailleEmplacement }

// Ajouter écrit la trame (TailleTrame octets) dans un nouvel emplacement et rend son numéro.
// Premier emplacement d'un palier : le palier entier est écrit d'un coup (la trame, puis de
// l'aléa) ; en cas d'échec, le fichier est ramené à sa taille d'avant. Dans un palier déjà
// écrit, la taille ne change pas : un échec laisse un emplacement jamais compté, récrit par
// l'ajout suivant. L'appelant tient une place de la borne des écritures (voir l'en-tête).
func (c *Conversation) Ajouter(trame []byte) (uint32, error) {
	if len(trame) != TailleTrame {
		return 0, ErrEnTete
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.etat(); err != nil {
		return 0, err
	}
	if c.n == math.MaxUint32 {
		return 0, ErrPleine
	}
	e := c.n
	buf := make([]byte, tailleNonce, TailleEmplacement)
	rand.Read(buf)
	buf = c.aead.Seal(buf, buf, trame, ad(e))
	if e%emplacementsParPalier != 0 {
		if err := c.ecrire(buf, decalage(e)); err != nil {
			return 0, err
		}
		c.n++
		return e, nil
	}
	palier := make([]byte, TaillePalier)
	copy(palier, buf)
	rand.Read(palier[TailleEmplacement:])
	if err := c.ecrire(palier, decalage(e)); err != nil {
		c.annuler(decalage(e), decalage(e)+TaillePalier)
		return 0, err
	}
	c.n++
	c.poserTaille(decalage(e) + TaillePalier)
	return e, nil
}

// Lire rend la trame de l'emplacement e ; ErrEfface s'il ne s'authentifie pas (effacé). Sous
// la borne des lectures, prise avant le verrou : une lecture qui attend sa place ne tient
// rien, et ne retarde donc ni une écriture ni une destruction.
func (c *Conversation) Lire(e uint32) (trame []byte, err error) {
	_ = c.lec.Do(func() error { trame, err = c.lire(e); return nil })
	return trame, err
}

func (c *Conversation) lire(e uint32) ([]byte, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if err := c.etat(); err != nil {
		return nil, err
	}
	if e >= c.n {
		return nil, ErrEmplacement
	}
	buf := make([]byte, TailleEmplacement)
	if _, err := c.lecteur.ReadAt(buf, decalage(e)); err != nil {
		return nil, es(err)
	}
	trame, err := c.aead.Open(nil, buf[:tailleNonce], buf[tailleNonce:], ad(e))
	if err != nil {
		return nil, ErrEfface
	}
	return trame, nil
}

// alea : un emplacement d'octets aléatoires (effacement).
func alea() []byte {
	b := make([]byte, TailleEmplacement)
	rand.Read(b)
	return b
}

// Detruire oublie la clé (mise à zéro), ferme le fichier puis le supprime. Idempotent : un
// nouvel appel ne refait que la suppression si elle avait échoué. La taille ne retombe à 0
// qu'une fois le fichier supprimé : tant qu'il existe, sa place reste comptée.
func (c *Conversation) Detruire() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var errFermeture error
	if !c.detruite {
		c.detruite = true
		c.aead = nil // clé oubliée (voir le champ)
		clear(c.cle[:])
		if c.lecteur != nil {
			errFermeture = c.lecteur.Close()
		}
		if err := c.f.Close(); errFermeture == nil {
			errFermeture = err
		}
	}
	if c.supprime {
		return nil
	}
	if err := os.Remove(c.chemin); err != nil && !errors.Is(err, os.ErrNotExist) {
		return es(err)
	}
	dossierSansDate(c.chemin)
	c.supprime = true
	c.poserTaille(0)
	// Fichier supprimé et clé oubliée : une erreur de fermeture est seulement signalée.
	return es(errFermeture)
}

// renommer donne au fichier le nom chemin (même dossier ; renouvellement : la conversation
// neuve, ouverte sous un nom provisoire, prend le nom du salon une fois l'ancienne détruite).
// Sous le verrou de la conversation : les écritures, qui remettent les dates par le chemin,
// voient toujours le nom courant. Conversation détruite entre-temps (fin du salon) : rien à
// faire, sans erreur.
func (c *Conversation) renommer(chemin string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.detruite {
		return nil
	}
	if err := os.Rename(c.chemin, chemin); err != nil {
		return es(err)
	}
	c.chemin = chemin
	dossierSansDate(chemin)
	return sansDate(chemin)
}

// EffacerPlusieurs écrase d'octets aléatoires chaque emplacement de l (effacements en chaîne :
// départ, libération, échéances, retrait), dates remises à l'epoch une seule fois. L'appelant
// tient une place de la borne des écritures. Un numéro hors du fichier :
// ErrEmplacement, rien n'est écrit. Une écriture en échec n'arrête pas les suivantes ; la
// première erreur est rendue (ErrES).
func (c *Conversation) EffacerPlusieurs(l []uint32) error {
	if len(l) == 0 {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.etat(); err != nil {
		return err
	}
	for _, e := range l {
		if e >= c.n {
			return ErrEmplacement
		}
	}
	var premiere error
	for _, e := range l {
		_, err := c.f.WriteAt(alea(), decalage(e))
		if err != nil && premiere == nil {
			premiere = es(err)
		}
	}
	if err := sansDate(c.chemin); premiere == nil {
		premiere = err
	}
	return premiere
}

// Package share applique les règles de vie d'un partage (spec §4, §7.4–7.7, §9).
//
// Chaque vérification suivie d'une action est une seule requête SQL conditionnelle
// (UPDATE … WHERE … RETURNING) ou une comparaison-échange : le code reste juste
// même avec plusieurs connexions à la base.
package share

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"hash/fnv"
	"io"
	"io/fs"
	"math/bits"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/store"
)

var (
	ErrNotFound   = errors.New("partage introuvable")
	ErrBadSegment = errors.New("segment invalide")
	ErrIncomplete = errors.New("envoi incomplet")
	ErrFull       = errors.New("stockage plein")
	ErrFrozen     = errors.New("créations suspendues")
	ErrBadRequest = errors.New("requête invalide")
	// ErrConflict : V_accès ou V_gestion déjà pris (seul qui connaît K_accès ou S_gestion
	// peut le provoquer, spec §29.8), ou id tiré par le serveur déjà pris (128 bits : jamais).
	ErrConflict = errors.New("partage déjà présent")
	// ErrBusy : un autre Finalize du même envoi est en cours (revue K1, I1).
	ErrBusy = errors.New("finalisation déjà en cours")
	// ErrBudget : l'ouverture a déjà lu son budget d'octets (ReadBudget).
	ErrBudget = errors.New("budget de lecture épuisé")
	// ErrEgressLimit : le partage a servi son plafond d'octets, toutes ouvertures confondues
	// (DefaultEgressMax) ; définitif pour ce partage (403 egress_limit).
	ErrEgressLimit = errors.New("plafond de téléchargement du partage atteint")
)

// BadPassword : mot de passe faux, avec les essais restants (0 = partage détruit).
type BadPassword struct{ AttemptsLeft int }

func (e *BadPassword) Error() string { return "mot de passe incorrect" }

const (
	maxAttempts  = 5
	uploadWindow = 6 * 3600 // secondes (spec §24, §41.2 : 6 h, comme le jeton d'envoi)
	purgeWindow  = 6 * 3600 // durée d'un jeton de téléchargement (spec §24, §41.2 : 6 h)
	// emptyAfter : un envoi sans segment est effacé 5 min après sa création (sweepCond).
	emptyAfter = 300
	// stallSweep : un envoi commencé sans nouveau segment depuis 15 min est effacé.
	stallSweep = 900
)

// CreateReq : création v2 (spec §29.8). ID : identifiant interne tiré par le serveur
// (NewID), sans lien avec l'id du client (qui ne sort jamais du navigateur, spec §32) ;
// AccessV, ManageV : SHA-256 de K_accès et de S_gestion, calculés par le serveur depuis les
// secrets reçus. Ni durée, ni ouvertures, ni sel, ni V_preuve à ce stade.
type CreateReq struct {
	ID               string
	Bucket           int
	AccessV, ManageV []byte
	// Returning : l'auteur a déjà créé ou envoyé aujourd'hui (limits.Limiter.Newcomer faux) :
	// la réserve de stockage des nouveaux venus lui est fermée (StorageLimit). Posé par la
	// couche HTTP, jamais lu du client.
	Returning bool
	// Tier : formule fixée par un jeton anonyme dépensé (couche HTTP) ; 0 sans jeton. Gardé en
	// mémoire avec l'envoi (tier.go), jamais en base.
	Tier Tier
}

// StorageReserve : 1/StorageReserve de StorageMax n'est ouvert qu'aux nouveaux venus (audit
// du 13 novembre, D2 : environ 34 adresses IPv4 remplissaient les 200 Gio et fermaient le
// service à tous). Avec 200 Gio : 25 Gio, au moins 12 nouvelles adresses pour les prendre.
const StorageReserve = 8

// StorageLimit : place utilisable par une création (Returning faux : toute, sinon sans la
// réserve) ; un agrandissement (Grow) et une pièce du salon n'entrent pas dans la réserve.
func StorageLimit(storageMax int64, newcomer bool) int64 {
	if newcomer {
		return storageMax
	}
	return storageMax - storageMax/StorageReserve
}

// FinalizeReq : tout ce qui dépend du mot de passe, la durée, les ouvertures, et le palier
// final d'un brouillon (spec §29.8, §41.14) : Bucket (≤ la réservation) ; Header (48 octets)
// et Tail (morceau chiffré du manifeste) sont écrits par le serveur, et tous les morceaux
// manquants du palier final sont remplis d'aléa. Seule finalisation depuis le 24 novembre
// (spec H-5 : l'ancienne, sans brouillon, avec bourrage [fill_from, fill_to), est retirée).
type FinalizeReq struct {
	TTLHours, MaxOpens, KdfOps, KdfMem int
	Salt, ProofV, Envelope             []byte
	Bucket                             int
	Header, Tail                       []byte
	// Void : plages [début, fin) de morceaux (numéros dans le paquet) de petits éléments
	// retirés, remplies d'aléa comme les morceaux jamais reçus (audit H-2, brouillon seulement).
	Void [][2]int
}

// maxVoid : plages de morceaux retirés au plus dans une finalisation (le corps JSON, manifeste
// chiffré compris, tient sous maxFinalizeJSON).
const maxVoid = 512

// EnvelopeLen : taille de E (nonce 12 ‖ R chiffrée 32 ‖ tag 16).
const EnvelopeLen = 60

type Meta struct {
	ID                               string // identifiant interne (jetons, fichier)
	ExpiresIn                        time.Duration
	Salt                             []byte
	KdfOps, KdfMem, Bucket, Segments int
	// Ouvertures restantes : déjà connues de qui a K_accès (il peut les compter en ouvrant),
	// rendues pour annoncer « encore N fois » avant le geste (ruling 5).
	OpensLeft int
}

type Status struct {
	OpensUsed, MaxOpens int
	ExpiresIn           time.Duration
	State               string
}

// Config : dépendances et réglages d'un Service, validés par NewService.
type Config struct {
	DB         *sql.DB
	Blobs      *blob.Store
	Now        func() time.Time
	StorageMax int64  // octets réservables au total ; > 0
	FrozenFile string // chemin absolu du fichier de gel ; obligatoire
	// OnAbandon (facultatif) : appelé quand un envoi est effacé sans avoir été finalisé
	// (quotas d'octets abandonnés, spec §29.5), avec bucket = 0 si la ligne a disparu hors
	// de ce processus (sweepOrphanUploads). Ne doit pas bloquer ; un même id peut être
	// signalé deux fois (effacement et balayage simultanés) : l'appelé l'ignore alors.
	OnAbandon func(id string, bucket int)
	// KillWait (commande d'administration seulement) : attente de la coupure, par le serveur
	// en marche, d'un partage déjà détaché (DestroyAdmin, kill.go) ; 0 : aucune demande.
	KillWait time.Duration
	// ExtraUsed (facultatif, nil : 0) : octets pris hors des partages sous le même
	// StorageMax (salons : pièces et conversations, salon.Manager.UsedBytes), ajoutés à
	// l'usage à la création et à l'agrandissement (plan C-2, point 10). Ne doit pas bloquer ni
	// prendre de verrou du Service ; une erreur de lecture doit rendre une valeur haute (échec
	// fermé).
	ExtraUsed func() int64
	// Vidage (facultatif) : vidages regroupés du WAL (store.Vidage), demandés après chaque
	// effacement ou réécriture sensible ; le serveur en fait tourner la boucle (Run). Absent :
	// un Vidage propre au service, sans boucle (commandes d'administration, tests : seuls les
	// vidages faits dans l'appelant, Maintenant, ont lieu).
	Vidage *store.Vidage
	// EgressMax (SHH_SHARE_EGRESS_MAX) : octets servis au plus par un partage, toutes
	// ouvertures confondues ; 0 : DefaultEgressMax ; négatif : refusé.
	EgressMax int64
}

// NewService valide la configuration : une valeur zéro ne doit jamais désactiver le gel
// en silence ni refuser toutes les créations (audit F10).
func NewService(c Config) (*Service, error) {
	switch {
	case c.DB == nil:
		return nil, errors.New("share : base absente")
	case c.Blobs == nil || c.Blobs.Dir == "":
		return nil, errors.New("share : dossier des fichiers absent")
	case c.Now == nil:
		return nil, errors.New("share : horloge absente")
	case c.StorageMax <= 0:
		return nil, errors.New("share : StorageMax doit être > 0")
	case c.FrozenFile == "" || !filepath.IsAbs(c.FrozenFile):
		return nil, errors.New("share : FrozenFile doit être un chemin absolu")
	case c.EgressMax < 0:
		return nil, errors.New("share : EgressMax doit être ≥ 0")
	}
	s := &Service{DB: c.DB, Blobs: c.Blobs, Now: c.Now, StorageMax: c.StorageMax, FrozenFile: c.FrozenFile,
		OnAbandon: c.OnAbandon, KillWait: c.KillWait, ExtraUsed: c.ExtraUsed, Vidage: c.Vidage, egressMax: c.EgressMax}
	if s.egressMax == 0 {
		s.egressMax = DefaultEgressMax
	}
	if s.Vidage == nil {
		s.Vidage = store.NewVidage(c.DB)
	}
	rand.Read(s.grantKey[:]) // clé des octrois d'ouverture, propre à ce processus (spec §41.4)
	return s, nil
}

// Service : à construire avec NewService.
type Service struct {
	// Effaces : partages effacés par Sweep depuis le démarrage (échéance, envoi abandonné,
	// essais épuisés), confondus : un entier pour le tableau de bord d'administration.
	Effaces atomic.Int64

	DB         *sql.DB
	Blobs      *blob.Store
	Now        func() time.Time
	StorageMax int64
	FrozenFile string
	OnAbandon  func(id string, bucket int)
	KillWait   time.Duration
	ExtraUsed  func() int64
	Vidage     *store.Vidage // jamais nil après NewService

	createMu sync.Mutex // rend atomiques « place libre ? » et la réservation
	// attemptMu : rend atomiques, par partage, la lecture du compteur, la vérification de
	// K_preuve et son décompte (audit F1) : jamais plus de 5 essais évalués, même en parallèle.
	// Verrous rayés (id haché) : mémoire bornée, aucune donnée retenue.
	attemptMu [64]sync.Mutex
	// uploadMus : verrous des envois, rayés par id comme attemptMu (revue du 10 novembre :
	// un seul verrou pour tous retenait les segments de chacun pendant l'effacement ou
	// l'agrandissement d'un seul). Par envoi : les écritures de segments le prennent en
	// lecture ; Erase, Grow, la fin de Finalize et sweepOne en écriture, pour attendre la
	// fin des écritures en vol de cet envoi. Jamais deux à la fois : aucun ordre à tenir.
	uploadMus [256]sync.RWMutex
	budget    readBudget // octets lus par ouverture et par partage, en mémoire seulement
	egressMax int64      // plafond de sortie par partage (Config.EgressMax)
	// mem : échéances d'envoi, minute du dernier segment reçu et purge des « draining », en
	// mémoire seulement (spec §36 S5, S12) : un redémarrage efface de toute façon ces partages
	// (PurgeAtStart), aucun jeton n'y survivant.
	mem struct {
		mu    sync.Mutex
		up    map[string]upload
		purge map[string]int64
		// part : segments d'un brouillon reçus en partie (audit H-2), un bit par morceau.
		part map[string]map[int]uint64
	}
	streams Streams        // flux de segments annulables (spec §41.8)
	bgSync  sync.WaitGroup // synchronisations de fond en cours (syncInBackground)
	gone    goneState      // ouvertures actives, descripteurs détachés, surveillances, octrois (spec §41.4, §41.8)
	kill    killKey        // clé des noms de demandes de coupure (kill.go)
	// grantKey : clé HMAC des octrois d'ouverture, tirée au démarrage, jamais écrite.
	grantKey [32]byte
	// reports : voix de signalement par partage, en mémoire seulement (report.go).
	reports reportBox
	// finalizing : envois dont un Finalize est en cours ; un seul à la fois par id, pour
	// qu'aucun appel concurrent ne réécrive le bourrage (revue K1, I1).
	finalizing struct {
		mu  sync.Mutex
		ids map[string]struct{}
		// sealing : envois dont un Finalize écrit le bourrage (hors du verrou de l'envoi) ;
		// leurs segments sont refusés (ErrBusy) jusqu'à la fin du Finalize (audit F6).
		sealing map[string]struct{}
	}
}

func (s *Service) now() int64 { return s.Now().Unix() }

// attemptLock : verrou des essais de mot de passe du partage id (audit F1).
func (s *Service) attemptLock(id string) *sync.Mutex {
	h := fnv.New32a()
	h.Write([]byte(id))
	return &s.attemptMu[h.Sum32()%uint32(len(s.attemptMu))]
}

// uploadLock : verrou de l'envoi id (deux id peuvent partager un verrou : simple attente).
func (s *Service) uploadLock(id string) *sync.RWMutex {
	h := fnv.New32a()
	h.Write([]byte(id))
	return &s.uploadMus[h.Sum32()%uint32(len(s.uploadMus))]
}

// upload : échéance d'un envoi (ceil15(création + 6 h)) et minute du dernier segment reçu
// (0 : aucun), en mémoire seulement. recv : morceaux reçus depuis la création, renvois et
// morceaux effacés ensuite compris (jamais décompté) ; top : 1 + plus haut segment dont un
// morceau a été reçu (0 : aucun). Ils bornent Grow et l'aléa écrit à finalize (D42-6).
type upload struct {
	deadline, progress int64
	recv               int64
	top                int
	// tier et window : formule de l'envoi et sa fenêtre d'envoi (secondes), en mémoire seulement.
	tier   Tier
	window int64
	// dirty : octets écrits depuis la dernière synchronisation de fond ; syncing : une
	// synchronisation de fond est en cours (rapport de performance A12).
	dirty   int64
	syncing bool
}

// syncEvery : octets écrits dans un envoi après lesquels son fichier est synchronisé en
// arrière-plan (fdatasync), pour qu'à Finalize il ne reste que la fin et le bourrage à écrire
// sur le disque (rapport de performance A12 : 702 ms au clic pour 200 Mo). 32 Mio : 8
// segments. La durabilité reste celle de Finalize, qui synchronise tout le fichier avant
// « ready » : ces synchronisations ne font qu'avancer le travail.
const syncEvery = 32 << 20

// bgSyncBlob : synchronisation de fond (variable pour les tests).
var bgSyncBlob = func(b *blob.Store, id string) error { return b.Sync(id) }

// UploadOpen : l'envoi id est encore ouvert (connu de ce processus, non finalisé, échéance
// non passée), en mémoire seulement, sans SQL. Vérifié avant de prendre une place de transfert
// et de lire le corps d'un segment (audit du 13 novembre, D1 : un jeton d'envoi reste signé
// 6 h après finalize).
func (s *Service) UploadOpen(id string) bool { return s.uploadOpen(id, s.now()) }

// uploadOpen : l'envoi id est connu de ce processus et son échéance n'est pas passée.
func (s *Service) uploadOpen(id string, now int64) bool {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	u, ok := s.mem.up[id]
	return ok && u.deadline > now
}

// syncInBackground synchronise le fichier de l'envoi id (hors de tout verrou), puis permet la
// suivante. Une erreur (fichier effacé, disque) est ignorée : Finalize resynchronise tout.
func (s *Service) syncInBackground(id string) {
	defer s.bgSync.Done()
	_ = bgSyncBlob(s.Blobs, id)
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	if u, ok := s.mem.up[id]; ok {
		u.syncing = false
		s.mem.up[id] = u
	}
}

func (s *Service) setUpload(id string, u upload) {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	if s.mem.up == nil {
		s.mem.up = map[string]upload{}
	}
	s.mem.up[id] = u
}

// tierOf : formule de l'envoi id (Gratuit s'il est inconnu de la mémoire).
func (s *Service) tierOf(id string) Tier {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	return s.mem.up[id].tier
}

// TierOf : formule d'un envoi en cours (couche HTTP : durée du jeton d'envoi).
func (s *Service) TierOf(id string) Tier { return s.tierOf(id) }

func (s *Service) touchUpload(id string, now int64) {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	if u, ok := s.mem.up[id]; ok {
		u.progress = minute(now)
		s.mem.up[id] = u
	}
}

// noteReceived compte k morceaux reçus au segment n de l'envoi id (après leur écriture).
func (s *Service) noteReceived(id string, n, k int) {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	if u, ok := s.mem.up[id]; ok {
		u.recv += int64(k)
		u.top = max(u.top, n+1)
		if u.dirty += int64(k) * ChunkCT; u.dirty >= syncEvery && !u.syncing {
			u.dirty, u.syncing = 0, true
			s.bgSync.Add(1)
			go s.syncInBackground(id)
		}
		s.mem.up[id] = u
	}
}

// received : morceaux reçus et 1 + plus haut segment reçu de l'envoi id (voir upload).
func (s *Service) received(id string) (recv int64, top int) {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	u := s.mem.up[id]
	return u.recv, u.top
}

// padFactor, padMargin : l'aléa écrit à finalize (en morceaux) ne dépasse jamais
// padFactor × morceaux reçus + padMargin (D42-6). Un vrai client reste dessous
// (amplify_test.go) : sous la fin de ses données, les trous (fin non envoyée du dernier
// segment d'un grand élément, plus courte que ses 64 premiers morceaux ; vides des segments
// partagés, le premier ajustement ne laissant qu'un segment au plus à moitié vide ; éléments
// retirés, dont les morceaux reçus comptent) ne dépassent pas ses données plus un segment ; et
// le palier final vaut au plus 2,5 fois le précédent, que la fin des données dépasse :
// aléa ≤ 2,5 × (2 × reçus + 64) − reçus = 4 × reçus + 160. La marge couvre ce reste, les
// petits paliers (160 morceaux au plus) et un segment d'élément retiré pendant son envoi.
const (
	padFactor = 4
	padMargin = 8 * SegChunks
)

// padAllowed : aléa permis (en morceaux) pour recv morceaux reçus.
func padAllowed(recv int64) int64 { return padFactor*recv + padMargin }

func (s *Service) setPurge(id string, at int64) {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	if s.mem.purge == nil {
		s.mem.purge = map[string]int64{}
	}
	s.mem.purge[id] = at
}

func (s *Service) forget(id string) {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	delete(s.mem.up, id)
	delete(s.mem.purge, id)
	delete(s.mem.part, id)
}

// uploadDue : l'envoi est échu (6 h), vide depuis 5 à 20 min, bloqué depuis 15 min, ou
// inconnu de la mémoire (créé avant un redémarrage).
func (s *Service) uploadDue(id string, now int64) bool {
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	u, ok := s.mem.up[id]
	return !ok || u.deadline <= now ||
		(u.progress == 0 && u.deadline-u.window+emptyAfter <= now) ||
		(u.progress != 0 && u.progress+stallSweep <= now)
}

// dueAt : un partage prêt ou « draining » doit disparaître (échéance, 5 essais faux, purge
// d'un « draining ») ; event : heure de l'événement, point de départ de la grâce (§41.8).
func (s *Service) dueAt(id, state string, exp sql.NullInt64, failed int, now int64) (bool, int64) {
	switch {
	case state == "uploading":
		return s.uploadDue(id, now), now
	case exp.Valid && exp.Int64 <= now:
		return true, exp.Int64
	case failed >= maxAttempts:
		return true, now
	case state == "draining":
		s.mem.mu.Lock()
		p, ok := s.mem.purge[id]
		s.mem.mu.Unlock()
		if !ok || p <= now {
			return true, now
		}
	}
	return false, 0
}

// match compare sha256(x) au vérificateur stocké, en temps constant. Un secret fait
// toujours 32 octets : toute autre longueur (nil compris) est refusée (audit F4).
func match(x, stored []byte) bool {
	if len(x) != 32 {
		return false
	}
	h := sha256.Sum256(x)
	return subtle.ConstantTimeCompare(h[:], stored) == 1
}

// Match : match pour les autres paquets (vérification de K_preuve_s et S_gestion du salon).
func Match(x, stored []byte) bool { return match(x, stored) }

// emptyHash : SHA-256 de la chaîne vide, refusé comme vérificateur (audit F4).
var emptyHash = sha256.Sum256(nil)

var b64 = base64.RawURLEncoding.Strict()

// DecodeB64 décode une valeur base64url sans bourrage de n octets, sous forme canonique :
// longueur exacte en caractères et alphabet base64url seulement. Le décodeur de Go
// ignore \r et \n même en mode Strict (audit F3) : ils sont refusés ici avant décodage.
func DecodeB64(s string, n int) ([]byte, error) {
	if len(s) != b64.EncodedLen(n) {
		return nil, ErrBadRequest
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return nil, ErrBadRequest
		}
	}
	b, err := b64.DecodeString(s)
	if err != nil || len(b) != n {
		return nil, ErrBadRequest
	}
	return b, nil
}

// NewID tire un identifiant interne de 128 bits (crypto/rand) : clé de la ligne, nom du
// fichier et sujet des jetons. Il n'est jamais montré dans un chemin ni dérivé d'un secret.
func NewID() string {
	b := make([]byte, 16)
	rand.Read(b) // ne renvoie jamais d'erreur (Go ≥ 1.24 : échec fatal du système)
	return b64.EncodeToString(b)
}

// Verifier : SHA-256 d'un secret de 32 octets (K_accès, S_gestion), clé de recherche de la
// ligne (index uniques, spec §29.8) ; nil pour toute autre longueur (jamais de recherche).
func Verifier(secret []byte) []byte {
	if len(secret) != 32 {
		return nil
	}
	h := sha256.Sum256(secret)
	return h[:]
}

// validID : 22 caractères base64url canoniques (16 octets).
func validID(id string) bool {
	_, err := DecodeB64(id, 16)
	return err == nil
}

// ceil15 arrondit au quart d'heure supérieur : toutes les dates stockées le sont,
// pour ne pas révéler la minute de création ou d'ouverture (spec §9.2).
func ceil15(t int64) int64 { return (t + 899) / 900 * 900 }

// Ceil15 : ceil15 pour les autres paquets (échéance des salons, plan C-2 Task 6).
func Ceil15(t int64) int64 { return ceil15(t) }

// minute : précision de progress_at, qui n'existe que pendant l'envoi (spec §9.1).
func minute(t int64) int64 { return t - t%60 }

func secs(n int64) time.Duration { return time.Duration(n) * time.Second }

func validTTL(h int) bool { return h == 1 || h == 6 || h == 12 || h == 24 }

// Frozen : créations suspendues. Échec fermé : tout autre résultat que « absent » gèle,
// et un FrozenFile vide (Service construit sans NewService) aussi.
func (s *Service) Frozen() bool {
	if s.FrozenFile == "" {
		return true
	}
	_, err := os.Stat(s.FrozenFile)
	return !errors.Is(err, fs.ErrNotExist)
}

// NotEmptyHash : notEmptyHash pour les autres paquets (création d'un salon).
func NotEmptyHash(vs ...[]byte) bool { return notEmptyHash(vs...) }

// notEmptyHash : un vérificateur égal à SHA-256("") serait satisfait par un secret vide (audit F4).
func notEmptyHash(vs ...[]byte) bool {
	for _, v := range vs {
		if subtle.ConstantTimeCompare(v, emptyHash[:]) == 1 {
			return false
		}
	}
	return true
}

// CreateMaxBucket : plus grand palier accepté à la création (D42-6) : 6 segments pleins
// (24 Mio de données) et le morceau du manifeste, ce que le client réserve au plus d'emblée
// (web/src/transfer/draft.ts, CREATE_SEGMENTS). Au-delà, la réservation ne grandit que par
// Grow, au fil des segments reçus. L'aléa écrit à finalize est borné à part (padAllowed) :
// créé au plafond et finalisé vide, un brouillon ne dépasse pas growLimit(0) = 160.
const CreateMaxBucket = 400

// Validate vérifie les champs d'une création (aussi revérifiés par Create).
func Validate(r CreateReq) error {
	if err := validCreate(r); err != nil {
		return err
	}
	if r.Bucket > CreateMaxBucket {
		return ErrBadRequest
	}
	return nil
}

// validCreate : Validate sans le plafond du palier (tests de grands paliers, create).
func validCreate(r CreateReq) error {
	if !validID(r.ID) || !r.Tier.Valid() || !bucketAllowed(r.Bucket, r.Tier) || len(r.AccessV) != 32 || len(r.ManageV) != 32 ||
		!notEmptyHash(r.AccessV, r.ManageV) {
		return ErrBadRequest
	}
	return nil
}

// kdfOps, kdfMem : seuls paramètres Argon2id acceptés (spec §29.2, audit F4) ; le navigateur
// refuse d'ouvrir tout autre réglage, l'accepter ici créerait un partage que personne n'ouvre.
const kdfOps, kdfMem = 3, 64 << 20

// MaxOpens : ouvertures au plus d'un partage gratuit (spec §4) ; 5 depuis le 17 novembre
// (décision du propriétaire, 10 avant ; web/src/limits.ts, MAX_OPENS, même valeur).
const MaxOpens = 5

// ValidateFinalize vérifie les champs d'une finalisation qui ne dépendent pas du palier
// (le bourrage est vérifié par Finalize, contre le palier du partage).
func ValidateFinalize(r FinalizeReq) error { return ValidateFinalizeTier(r, Gratuit) }

// ValidateFinalizeTier : ValidateFinalize pour la formule t (durées, ouvertures et palier
// permis par t).
func ValidateFinalizeTier(r FinalizeReq, t Tier) error {
	if !t.TTLAllowed(r.TTLHours) || r.MaxOpens < 1 || r.MaxOpens > t.MaxOpensOf() ||
		r.KdfOps != kdfOps || r.KdfMem != kdfMem ||
		len(r.Salt) != 16 || len(r.ProofV) != 32 || len(r.Envelope) != EnvelopeLen || !notEmptyHash(r.ProofV) {
		return ErrBadRequest
	}
	if !bucketAllowed(r.Bucket, t) || len(r.Header) != Header || len(r.Tail) != ChunkCT || !validVoid(r.Void, r.Bucket) {
		return ErrBadRequest
	}
	return nil
}

// UsedShares : octets des partages seuls (fichiers et descripteurs détachés), jamais
// ExtraUsed : c'est la valeur que le salon ajoute à son propre usage (salon.Config.UsedPartages),
// sans double compte (plan C-2 Task 15).
func (s *Service) UsedShares() (int64, error) {
	used, err := s.Blobs.UsedBytes()
	if err != nil {
		return 0, err
	}
	return used + s.detachedBytes(), nil
}

// extraUsed : Config.ExtraUsed, 0 sans elle.
func (s *Service) extraUsed() int64 {
	if s.ExtraUsed == nil {
		return 0
	}
	return s.ExtraUsed()
}

// Create réserve la place du palier et enregistre l'envoi sous r.ID (tiré par NewID, rendu
// tel quel). Un V_accès ou un V_gestion déjà présent (ou un id déjà pris, en base ou sur
// disque) donne ErrConflict, sans toucher au partage existant : sans K_accès ni S_gestion,
// personne ne peut provoquer ce refus (aucun oracle d'existence, revue K1, I2).
func (s *Service) Create(r CreateReq) (string, int, error) { return s.create(r, Validate) }

// create : Create avec la validation valid (validCreate dans les tests de grands paliers).
func (s *Service) create(r CreateReq, valid func(CreateReq) error) (string, int, error) {
	if s.Frozen() {
		return "", 0, ErrFrozen
	}
	if err := valid(r); err != nil {
		return "", 0, err
	}
	id := r.ID
	size := totalSize(r.Bucket)
	segs := SegmentCount(r.Bucket)

	s.createMu.Lock()
	defer s.createMu.Unlock()
	var one int
	switch err := s.DB.QueryRow(`SELECT 1 FROM shares WHERE id=? OR access_v=? OR manage_v=?`,
		id, r.AccessV, r.ManageV).Scan(&one); {
	case err == nil:
		return "", 0, ErrConflict
	case !errors.Is(err, sql.ErrNoRows):
		return "", 0, err
	}
	used, err := s.Blobs.UsedBytes()
	if err != nil {
		return "", 0, err
	}
	// Les descripteurs détachés (§41.8) tiennent encore leur place jusqu'à leur fermeture.
	if used+s.detachedBytes()+s.extraUsed()+size > StorageLimit(s.StorageMax, !r.Returning) {
		return "", 0, ErrFull
	}
	if err := reserveBlob(s.Blobs, id, size); err != nil {
		switch {
		case errors.Is(err, blob.ErrNoAllocate):
			return "", 0, ErrFull // place impossible à garantir : refus, comme un disque plein
		case errors.Is(err, fs.ErrExist):
			return "", 0, ErrConflict // fichier orphelin du même nom : jamais écrasé
		}
		return "", 0, err
	}
	// proof_v, salt, kdf_*, max_opens et envelope restent NULL jusqu'à Finalize ; aucune date
	// en base (l'échéance de l'envoi vit en mémoire, spec §36 S12).
	s.setUpload(id, upload{deadline: ceil15(s.now() + r.Tier.UploadWindow()), tier: r.Tier, window: r.Tier.UploadWindow()})
	_, err = s.DB.Exec(`INSERT INTO shares(id,state,bucket,opens_left,segments_mask,access_v,manage_v)
		VALUES(?,'uploading',?,0,?,?,?)`,
		id, r.Bucket, make([]byte, (segs+7)/8), r.AccessV, r.ManageV)
	if err != nil {
		s.forget(id)
		return "", 0, errors.Join(err, s.Blobs.Delete(id))
	}
	return id, segs, nil
}

// reserveBlob : réservation de la place (variable pour tester la conversion ErrNoAllocate).
var reserveBlob = func(b *blob.Store, id string, size int64) error { return b.Reserve(id, size) }

func (s *Service) PutSegment(id string, n int, body []byte) error {
	if !validID(id) {
		return ErrNotFound
	}
	mu := s.uploadLock(id)
	mu.RLock()
	defer mu.RUnlock()
	if s.sealed(id) {
		return ErrBusy // finalisation en cours (audit F6)
	}
	if !s.uploadOpen(id, s.now()) {
		return ErrNotFound
	}
	var bucket int
	err := s.DB.QueryRow(`SELECT bucket FROM shares WHERE id=? AND state='uploading'`, id).Scan(&bucket)
	if err != nil {
		return notFound(err)
	}
	if n < 0 || n >= SegmentCount(bucket) || len(body) != SegmentSize(bucket, n) {
		return ErrBadSegment
	}
	if err := s.Blobs.WriteAt(id, segOffset(bucket, n), body); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound // détruit pendant l'envoi
		}
		return err
	}
	s.noteReceived(id, n, chunksIn(bucket, n))
	s.clearPart(id, n, n+1)
	return s.markReceived(id, n)
}

// markReceived pose le bit du segment n (reçu en entier).
func (s *Service) markReceived(id string, n int) error {
	// Comparaison-échange : deux segments envoyés en parallèle ne s'écrasent pas.
	for {
		var mask []byte
		err := s.DB.QueryRow(`SELECT segments_mask FROM shares WHERE id=? AND state='uploading'`, id).Scan(&mask)
		if err != nil {
			return notFound(err)
		}
		if mask[n/8]&(1<<(n%8)) != 0 {
			// Segment remplacé (reprise) : c'est aussi un progrès (minute, en mémoire).
			s.touchUpload(id, s.now())
			return nil
		}
		next := append([]byte(nil), mask...)
		next[n/8] |= 1 << (n % 8)
		res, err := s.DB.Exec(`UPDATE shares SET segments_mask=? WHERE id=? AND state='uploading' AND segments_mask=?`,
			next, id, mask)
		if err != nil {
			return err
		}
		if k, _ := res.RowsAffected(); k == 1 {
			s.touchUpload(id, s.now())
			return nil
		}
	}
}

// Finalize termine un brouillon (spec §29.4, point 4, §41.14) : palier final, morceaux
// manquants remplis d'octets aléatoires (crypto/rand, indiscernables d'un chiffré pour qui lit
// le disque), en-tête et manifeste écrits, puis passage en « ready » avec le sel, Argon2id,
// V_preuve, E, la durée et les ouvertures (finalizeDraft). Rejoué après succès : 404.
func (s *Service) Finalize(id string, r FinalizeReq) (time.Duration, error) {
	if !validID(id) {
		return 0, ErrNotFound
	}
	if err := ValidateFinalizeTier(r, s.tierOf(id)); err != nil {
		return 0, err
	}
	if !s.claimFinalize(id) {
		return 0, ErrBusy // aucune lecture ni écriture : réponse immédiate
	}
	defer s.releaseFinalize(id)
	s.seal(id)
	if !s.uploadOpen(id, s.now()) {
		return 0, ErrNotFound
	}
	var bucket int
	err := s.DB.QueryRow(`SELECT bucket FROM shares WHERE id=? AND state='uploading'`, id).Scan(&bucket)
	if err != nil {
		return 0, notFound(err)
	}
	return s.finalizeDraft(id, bucket, r)
}

// claimFinalize réserve l'id pour un seul Finalize à la fois ; faux s'il est déjà pris.
func (s *Service) claimFinalize(id string) bool {
	s.finalizing.mu.Lock()
	defer s.finalizing.mu.Unlock()
	if s.finalizing.ids == nil {
		s.finalizing.ids = map[string]struct{}{}
	}
	if _, busy := s.finalizing.ids[id]; busy {
		return false
	}
	s.finalizing.ids[id] = struct{}{}
	return true
}

func (s *Service) releaseFinalize(id string) {
	s.finalizing.mu.Lock()
	delete(s.finalizing.ids, id)
	delete(s.finalizing.sealing, id)
	s.finalizing.mu.Unlock()
}

// seal (Finalize, claimFinalize déjà pris) : plus aucun segment de l'envoi id n'est accepté
// jusqu'à releaseFinalize (audit F6), puis attente des écritures déjà en vol (verrou exclusif
// de l'envoi pris et rendu) : le bourrage, écrit ensuite hors de ce verrou, ne croise plus
// aucune écriture de segment.
func (s *Service) seal(id string) {
	s.finalizing.mu.Lock()
	if s.finalizing.sealing == nil {
		s.finalizing.sealing = map[string]struct{}{}
	}
	s.finalizing.sealing[id] = struct{}{}
	s.finalizing.mu.Unlock()
	mu := s.uploadLock(id)
	mu.Lock()
	mu.Unlock() // barrière : les écritures en vol (RLock) sont finies
}

// sealed : un Finalize de l'envoi id est en cours (à lire sous le verrou de l'envoi en lecture).
func (s *Service) sealed(id string) bool {
	s.finalizing.mu.Lock()
	defer s.finalizing.mu.Unlock()
	_, ok := s.finalizing.sealing[id]
	return ok
}

// fullMask : tous les segments marqués reçus.
func fullMask(segs int) []byte {
	m := make([]byte, (segs+7)/8)
	for i := 0; i < segs; i++ {
		m[i/8] |= 1 << (i % 8)
	}
	return m
}

// deleteBlob, eraseBlob, resizeBlob, closeDetached : suppression, effacement et changement de
// taille d'un fichier, fermeture d'un descripteur détaché (variables pour tester les verrous
// tenus pendant ce temps et les erreurs).
var (
	deleteBlob    = func(b *blob.Store, id string) error { return b.Delete(id) }
	resizeBlob    = func(b *blob.Store, id string, size int64) error { return b.Resize(id, size) }
	eraseBlob     = func(b *blob.Store, id string, off, n int64) error { return b.Erase(id, off, n) }
	closeDetached = func(f *os.File) error { return f.Close() }
)

// syncBlob : contenu du fichier forcé sur le disque (variable pour tester l'ordre et l'échec).
var syncBlob = func(b *blob.Store, id string) error { return b.Sync(id) }

// syncFile force le fichier de l'envoi id sur le disque avant « ready » (revue B4) : après une
// panne de courant, un partage « ready » dont le contenu n'aurait pas atteint le disque
// serait servi vide ou tronqué. Fichier effacé entre-temps : ErrNotFound.
func (s *Service) syncFile(id string) error {
	if err := syncBlob(s.Blobs, id); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// fillWrite : écriture d'une tranche du bourrage dans le fichier ouvert une seule fois
// (rapport de performance A12 ; variable pour compter les écritures en test).
var fillWrite = func(w io.WriterAt, off int64, b []byte) error { _, err := w.WriteAt(b, off); return err }

// fillChunk : taille maximale des écritures du bourrage (un seul tampon par plage, réutilisé).
const fillChunk = 4 << 20

// fillRange écrit des octets de crypto/rand dans [start, end) du fichier id.
func (s *Service) fillRange(id string, start, end int64) error {
	if start >= end {
		return nil
	}
	w, err := s.Blobs.OpenWriter(id)
	if err != nil {
		return err
	}
	buf := make([]byte, min(fillChunk, end-start)) // jamais 4 Mio pour un seul morceau (revue B8)
	for off := start; off < end; {
		n := min(int64(len(buf)), end-off)
		b := buf[:n]
		if _, err := rand.Read(b); err != nil {
			return errors.Join(err, w.Close())
		}
		if err := fillWrite(w, off, b); err != nil {
			return errors.Join(err, w.Close())
		}
		off += n
	}
	return w.Close()
}

// Meta trouve le partage par V_accès = SHA-256(K_accès) (index unique) : sans K_accès,
// aucune requête ne désigne un partage (spec §29.8).
func (s *Service) Meta(kAcces []byte) (Meta, error) {
	v := Verifier(kAcces)
	if v == nil {
		return Meta{}, ErrNotFound
	}
	now := s.now()
	var m Meta
	var exp int64
	err := s.DB.QueryRow(`SELECT id, expires_at, salt, kdf_ops, kdf_mem, bucket, opens_left FROM shares
		WHERE access_v=? AND state='ready' AND expires_at>? AND failed_attempts<?`, v, now, maxAttempts).
		Scan(&m.ID, &exp, &m.Salt, &m.KdfOps, &m.KdfMem, &m.Bucket, &m.OpensLeft)
	if err != nil {
		return Meta{}, notFound(err)
	}
	m.ExpiresIn = secs(exp - now)
	m.Segments = SegmentCount(m.Bucket)
	return m, nil
}

// Unlock : UnlockGrant sans octroi, qui ne rend que le numéro et l'enveloppe.
func (s *Service) Unlock(id string, kAcces, kPreuve []byte) (int, []byte, error) {
	o, err := s.UnlockGrant(id, kAcces, kPreuve, "")
	return o.N, o.Envelope, err
}

// UnlockGrant (id rendu par Meta) vérifie K_accès puis K_preuve. Sans octroi : consomme une
// ouverture (seulement en « ready » : proof_v et envelope ne sont posés que par Finalize) et
// rend son numéro, l'enveloppe E (spec §29.8) et l'octroi d'ouverture (spec §41.4). Avec un
// octroi : rouvre la même ouverture sans en consommer (reopen).
func (s *Service) UnlockGrant(id string, kAcces, kPreuve []byte, grant string) (Opened, error) {
	if !validID(id) {
		return Opened{}, ErrNotFound
	}
	mu := s.attemptLock(id)
	mu.Lock()
	defer mu.Unlock()
	if grant != "" {
		return s.reopen(id, kAcces, kPreuve, grant)
	}
	now := s.now()
	var accessV, proofV, envelope []byte
	var bucket int
	err := s.DB.QueryRow(`SELECT access_v, proof_v, envelope, bucket FROM shares WHERE id=? AND state='ready' AND expires_at>?
		AND failed_attempts<? AND proof_v IS NOT NULL AND envelope IS NOT NULL`, id, now, maxAttempts).
		Scan(&accessV, &proofV, &envelope, &bucket)
	if err != nil {
		return Opened{}, notFound(err)
	}
	if !match(kAcces, accessV) {
		return Opened{}, ErrNotFound // ne compte pas comme essai
	}
	if match(kPreuve, proofV) {
		// Plafond de sortie (décision du 24 novembre) : une nouvelle ouverture n'est consommée
		// que si un téléchargement complet tient encore sous le plafond du partage ; sinon
		// ErrEgressLimit, sans ouverture ni essai consommé. Dit seulement à qui a le mot de passe.
		if s.budget.shareUsed(id, now) > s.egressMax-totalSize(bucket) {
			return Opened{}, ErrEgressLimit
		}
		var openN, left int
		var state string
		var exp int64
		err := s.DB.QueryRow(`UPDATE shares SET opens_left=opens_left-1, opens_issued=opens_issued+1,
			state=CASE WHEN opens_left-1=0 THEN 'draining' ELSE state END
			WHERE id=? AND state='ready' AND opens_left>0 AND expires_at>? AND failed_attempts<?
			RETURNING opens_issued, opens_left, state, expires_at`, id, now, maxAttempts).Scan(&openN, &left, &state, &exp)
		if err != nil {
			return Opened{}, notFound(err)
		}
		s.Vidage.Demander() // ligne récrite : vidage du WAL regroupé (audit adverse 3, stockage, Z3)
		if state == "draining" {
			// D42-22 : toutes les ouvertures sont prises ; le partage reste jusqu'à son échéance
			// pour que leurs détentrices y reviennent (purge en mémoire : un redémarrage, qui
			// invalide les octrois, l'efface, PurgeAtStart).
			s.setPurge(id, exp)
		}
		g, err := s.grantIfLive(id, openN, exp)
		if err != nil {
			return Opened{}, err
		}
		return Opened{N: openN, Envelope: envelope, Grant: g, OpensLeft: left, LastOpen: left == 0}, nil
	}
	left, err := s.countFailure(id)
	if err != nil {
		return Opened{}, err
	}
	return Opened{}, &BadPassword{AttemptsLeft: left}
}

// grantIfLive inscrit l'octroi de l'ouverture openN (grantLocked) si le partage existe encore
// (audit des partages du 12 novembre, D1) : une destruction passée entre l'UPDATE qui consomme
// l'ouverture et ce point a déjà oublié octrois et budgets (retire), qui ne doivent pas être
// recréés pour un partage effacé. Sous gone.mu : partage mort ou en retrait → ErrNotFound ;
// sinon la ligne est relue (retire prend gone.mu pour son oubli final : une ligne encore là
// sera oubliée après nous) ; absente → ErrNotFound.
// La ligne est relue hors de gone.mu, époque revérifiée sous le verrou (liveRead, audit du
// 13 novembre, D7).
func (s *Service) grantIfLive(id string, openN int, exp int64) (string, error) {
	var one int
	gone, err := s.liveRead(id, func() error { return s.DB.QueryRow(`SELECT 1 FROM shares WHERE id=?`, id).Scan(&one) })
	defer s.gone.unlock()
	if gone {
		return "", ErrNotFound
	}
	if err != nil {
		return "", notFound(err)
	}
	return s.grantLocked(openKey{id, openN}, exp), nil
}

// countFailure compte un mauvais K_preuve (Unlock et Destroy partagent le compteur)
// et détruit au 5ᵉ. Renvoie les essais restants.
func (s *Service) countFailure(id string) (int, error) {
	var failed int
	err := s.DB.QueryRow(`UPDATE shares SET failed_attempts=failed_attempts+1
		WHERE id=? AND failed_attempts<? RETURNING failed_attempts`, id, maxAttempts).Scan(&failed)
	if err != nil {
		return 0, notFound(err)
	}
	s.Vidage.Demander() // ligne récrite : vidage du WAL regroupé (audit adverse 3, stockage, Z3)
	if failed >= maxAttempts {
		// En cas d'échec, Sweep réessaie (failed_attempts>=5) ; le partage est déjà inaccessible.
		// 5 mots de passe faux : comme une suppression (spec §41.8 cas 2), les ouvertures
		// actives finissent.
		if _, err := s.retire(id, true, s.now()); err != nil {
			return 0, err
		}
	}
	return maxAttempts - failed, nil
}

// Done marque l'ouverture openN terminée. Partage disparu : ErrGone, sauf pour une
// ouverture qui finissait sur le descripteur détaché (qu'elle rend).
func (s *Service) Done(id string, openN int) error {
	if !validID(id) || openN < 1 || openN > maxOpenN {
		return ErrNotFound
	}
	s.gone.mu.Lock()
	s.gone.init()
	delete(s.gone.grants, openKey{id, openN}) // l'ouverture finit : son octroi ne rouvre plus rien
	s.gone.unlock()
	if handled, err := s.doneDetached(id, openN); handled {
		return err
	}
	// Partage échu non encore balayé : retiré d'abord (grâce des ouvertures actives).
	var st string
	var failed int
	var exp sql.NullInt64
	if s.DB.QueryRow(`SELECT state, failed_attempts, expires_at FROM shares WHERE id=?`, id).Scan(&st, &failed, &exp) == nil {
		if due, event := s.dueAt(id, st, exp, failed, s.now()); due && st != "uploading" {
			if _, err := s.retire(id, true, event); err != nil {
				return err
			}
			if handled, err := s.doneDetached(id, openN); handled {
				return err
			}
			return ErrGone
		}
	}
	var state string
	var mask int64
	var issued int
	err := s.DB.QueryRow(`UPDATE shares SET done_mask = done_mask | ?
		WHERE id=? AND ? <= opens_issued RETURNING state, done_mask, opens_issued`,
		int64(1)<<(openN-1), id, openN).Scan(&state, &mask, &issued)
	if errors.Is(err, sql.ErrNoRows) {
		// Ouverture jamais émise (impossible avec un jeton signé) : introuvable ; sinon le
		// partage a disparu.
		var one int
		if s.DB.QueryRow(`SELECT 1 FROM shares WHERE id=?`, id).Scan(&one) == nil {
			return ErrNotFound
		}
		return ErrGone
	}
	if err != nil {
		return err
	}
	s.Vidage.Demander() // ligne récrite : vidage du WAL regroupé (audit adverse 3, stockage, Z3)
	// En « draining », opens_issued est figé et done_mask ne fait que croître : sûr. Toutes
	// les ouvertures sont terminées : aucune n'a besoin de grâce.
	if state == "draining" && bits.OnesCount64(uint64(mask)) == issued {
		_, err := s.retire(id, true, s.now())
		return err
	}
	return nil
}

// doneDetached : done d'une ouverture d'un partage disparu ; handled si le partage est détaché.
func (s *Service) doneDetached(id string, openN int) (handled bool, err error) {
	s.gone.mu.Lock()
	defer s.gone.unlock()
	s.gone.init()
	d := s.gone.dead[id]
	if d == nil {
		return false, nil
	}
	had := d.opens[openN]
	delete(d.opens, openN)
	s.reapLocked(id, d, s.now())
	if had {
		return true, nil
	}
	return true, ErrGone
}

// alive : condition de vie commune à la destruction et au statut, complétée pour un envoi
// par son échéance en mémoire (aliveUpload). Un partage expiré (ou un envoi échu) est
// introuvable, et aucun essai n'y est compté ; Sweep l'effacera.
const alive = `(state='uploading' OR expires_at>?1)`

// aliveUpload : un envoi n'est vivant que si ce processus en connaît l'échéance, non passée.
func (s *Service) aliveUpload(id, state string, now int64) bool {
	return state != "uploading" || s.uploadOpen(id, now)
}

// DestroyWithProof : destruction par le destinataire (K_accès, K_preuve et l'octroi de son
// ouverture). Partage trouvé par V_accès ; K_preuve faux = un essai de mot de passe (compteur
// commun avec Unlock). Seulement par le DERNIER destinataire (audit du 20 novembre, M1) : plus
// aucune ouverture possible (« draining ») et l'octroi est celui de la dernière ouverture
// (n = opens_issued) ; sinon ErrStillOpen. Octroi faux : ErrGrantInvalid. Un destinataire ne
// peut donc pas effacer un partage que d'autres doivent encore ouvrir ou rouvrir (D42-22). Les
// ouvertures actives finissent (cas 2).
func (s *Service) DestroyWithProof(kAcces, kPreuve []byte, grant string) error {
	v := Verifier(kAcces)
	if v == nil {
		return ErrNotFound
	}
	now := s.now()
	var id, state string
	var proofV []byte
	err := s.DB.QueryRow(`SELECT id, proof_v, state FROM shares WHERE access_v=?2 AND `+alive, now, v).Scan(&id, &proofV, &state)
	if err != nil {
		return notFound(err)
	}
	if !s.aliveUpload(id, state, now) {
		return ErrNotFound
	}
	mu := s.attemptLock(id)
	mu.Lock()
	defer mu.Unlock()
	// Relu sous le verrou : un essai concurrent a pu épuiser le compteur (audit F1).
	var failed, issued int
	if err := s.DB.QueryRow(`SELECT failed_attempts, state, opens_issued FROM shares WHERE id=?`, id).Scan(&failed, &state, &issued); err != nil {
		return notFound(err)
	}
	if failed >= maxAttempts {
		return ErrNotFound
	}
	if !match(kPreuve, proofV) { // proof_v NULL (envoi en cours) : jamais juste
		if _, err := s.countFailure(id); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		return ErrNotFound
	}
	idb, ok := idBytes(id)
	if !ok {
		return ErrNotFound
	}
	n, ok := VerifyGrant(s.grantKey, idb, grant, s.Now())
	if !ok {
		return ErrGrantInvalid
	}
	if state != "draining" || int(n) != issued {
		return ErrStillOpen
	}
	s.reports.forget(id)
	return s.retireOrNotFound(id, true)
}

// DestroyManaged : destruction par l'expéditeur (S_gestion), partage trouvé par V_gestion.
func (s *Service) DestroyManaged(sGestion []byte) error {
	id, err := s.managed(sGestion)
	if err != nil {
		return err
	}
	return s.retireOrNotFound(id, true)
}

// managed : id du partage vivant dont V_gestion = SHA-256(sGestion).
func (s *Service) managed(sGestion []byte) (string, error) {
	v := Verifier(sGestion)
	if v == nil {
		return "", ErrNotFound
	}
	now := s.now()
	var id, state string
	err := s.DB.QueryRow(`SELECT id, state FROM shares WHERE manage_v=?2 AND `+alive, now, v).Scan(&id, &state)
	if err != nil {
		return "", notFound(err)
	}
	if !s.aliveUpload(id, state, now) {
		return "", ErrNotFound
	}
	return id, nil
}

// Status : compteurs, échéance et état, partage trouvé par V_gestion (spec §32).
func (s *Service) Status(sGestion []byte) (Status, error) {
	v := Verifier(sGestion)
	if v == nil {
		return Status{}, ErrNotFound
	}
	now := s.now()
	var st Status
	var left int
	var exp, maxOpens sql.NullInt64
	var id string
	err := s.DB.QueryRow(`SELECT id, max_opens, opens_left, expires_at, state FROM shares WHERE manage_v=?2 AND `+alive,
		now, v).Scan(&id, &maxOpens, &left, &exp, &st.State)
	if err != nil {
		return Status{}, notFound(err)
	}
	if !s.aliveUpload(id, st.State, now) {
		return Status{}, ErrNotFound
	}
	if maxOpens.Valid { // NULL pendant l'envoi : 0 / 0
		st.MaxOpens = int(maxOpens.Int64)
		st.OpensUsed = st.MaxOpens - left
	}
	if exp.Valid {
		st.ExpiresIn = secs(exp.Int64 - now)
	}
	return st, nil
}

// DestroyAdmin : destruction par l'administrateur, à partir de K_accès (dérivée du lien
// signalé par la commande d'administration), quel que soit l'état du partage. Aucune grâce :
// un contenu signalé n'est plus servi (spec §41.8, Q-GONE3). Un partage déjà retiré dont des
// ouvertures finissent sur un descripteur détaché est coupé aussi : ici s'il l'est dans ce
// processus, sinon par le serveur en marche (requestKill, PollRemoved).
func (s *Service) DestroyAdmin(kAcces []byte) error {
	v := Verifier(kAcces)
	if v == nil {
		return ErrNotFound
	}
	var id string
	if err := s.DB.QueryRow(`SELECT id FROM shares WHERE access_v=?`, v).Scan(&id); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if s.cutDetached(v) {
			return nil
		}
		return s.requestKill(v)
	}
	return s.retireOrNotFound(id, false)
}

// Sweep efface les partages expirés (grâce des ouvertures actives, §41.8), les « draining »
// échus, les destructions au 5ᵉ essai restées inachevées et les envois abandonnés : échus
// (6 h), vides (5 à 20 min après la création, selon l'arrondi de l'échéance au quart
// d'heure : une réservation vide ne bloque pas l'espace six heures) ou bloqués (aucun
// segment depuis 15 min). Les échéances des envois et des purges sont en mémoire. Ferme
// aussi les descripteurs détachés qui ne servent plus. Continue malgré les erreurs.
func (s *Service) Sweep() (int, error) {
	now := s.now()
	s.sweepGone(now)
	s.reports.purge(now)
	rows, err := s.DB.Query(`SELECT id FROM shares WHERE state<>'ready' OR expires_at<=? OR failed_attempts>=?`, now, maxAttempts)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	removed := 0
	errs := []error{s.sweepOrphanUploads()}
	for _, id := range ids {
		ok, err := s.sweepOne(id, now)
		if err != nil {
			errs = append(errs, err)
		} else if ok {
			removed++
		}
	}
	s.Effaces.Add(int64(removed))
	return removed, errors.Join(errs...)
}

// sweepOrphanUploads oublie les envois en cours connus de la mémoire dont la ligne a disparu
// hors de ce processus (« shhdrop admin destroy » ou « wipe », audit F9) et les signale à
// OnAbandon : sans cela, leur échéance restait en mémoire et leur place d'envoi en cours
// restait prise dans les quotas jusqu'à minuit. Sous createMu : Create pose l'échéance et
// écrit la ligne sous ce verrou, un envoi en cours de création n'est donc jamais pris pour
// disparu. Un envoi finalisé garde sa ligne ; un envoi effacé ici est déjà oublié.
func (s *Service) sweepOrphanUploads() error {
	s.createMu.Lock()
	s.mem.mu.Lock()
	ids := make([]any, 0, len(s.mem.up))
	for id := range s.mem.up {
		ids = append(ids, id)
	}
	s.mem.mu.Unlock()
	present := map[string]bool{}
	for i := 0; i < len(ids); i += 500 {
		part := ids[i:min(i+500, len(ids))]
		rs, err := s.DB.Query(`SELECT id FROM shares WHERE id IN (?`+strings.Repeat(",?", len(part)-1)+`)`, part...)
		if err != nil {
			s.createMu.Unlock()
			return err
		}
		for rs.Next() {
			var id string
			if err := rs.Scan(&id); err != nil {
				rs.Close()
				s.createMu.Unlock()
				return err
			}
			present[id] = true
		}
		rs.Close()
		if err := rs.Err(); err != nil {
			s.createMu.Unlock()
			return err
		}
	}
	var gone []string
	for _, x := range ids {
		if id := x.(string); !present[id] {
			s.forget(id)
			gone = append(gone, id)
		}
	}
	s.createMu.Unlock()
	if s.OnAbandon != nil {
		for _, id := range gone {
			s.OnAbandon(id, 0) // palier inconnu : la ligne a disparu
		}
	}
	return nil
}

// sweepOne revérifie l'échéance sous le verrou de l'envoi : aucun Finalize ni PutSegment du
// même envoi ne peut s'intercaler entre la vérification et l'effacement (fichier, puis ligne).
func (s *Service) sweepOne(id string, now int64) (bool, error) {
	mu := s.uploadLock(id)
	mu.Lock()
	defer mu.Unlock()
	var state string
	var failed int
	var exp sql.NullInt64
	err := s.DB.QueryRow(`SELECT state, failed_attempts, expires_at FROM shares WHERE id=?`, id).Scan(&state, &failed, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	due, event := s.dueAt(id, state, exp, failed, now)
	if !due {
		return false, nil
	}
	return s.retire(id, true, event)
}

// PurgeAtStart, à appeler au démarrage du serveur (jamais par une commande
// d'administration, qui partage la base d'un serveur en marche) : efface tout envoi en cours
// et tout partage « draining » (leurs échéances étaient en mémoire, et aucun jeton ne survit
// à un redémarrage : ni envoi ni lecture n'y sont plus possibles), expiré ou détruit au 5ᵉ
// essai (spec §36 S12, §41.8). Rend le nombre de partages effacés.
func (s *Service) PurgeAtStart() (int, error) {
	rows, err := s.DB.Query(`SELECT id FROM shares WHERE state<>'ready' OR expires_at<=? OR failed_attempts>=?`, s.now(), maxAttempts)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	n := 0
	var errs []error
	for _, id := range ids {
		ok, err := s.destroy(id)
		if err != nil {
			errs = append(errs, err)
		} else if ok {
			n++
		}
	}
	return n, errors.Join(errs...)
}

// destroy efface le fichier d'abord, puis la ligne ; renvoie si une ligne existait. Un
// envoi effacé avant Finalize est signalé à OnAbandon (octets abandonnés, spec §29.5).
// Jamais sous gone.mu (retire) : la suppression d'un fichier de 2 Gio est lente.
func (s *Service) destroy(id string) (bool, error) {
	if err := deleteBlob(s.Blobs, id); err != nil {
		return false, err
	}
	var state string
	var bucket int
	err := s.DB.QueryRow(`DELETE FROM shares WHERE id=? RETURNING state, bucket`, id).Scan(&state, &bucket)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// Ligne effacée : vidage du WAL demandé (regroupé, hors de cette requête), pour TOUT
	// effacement (fin de téléchargement, essais, échéance, destruction : audit adverse du
	// 13 novembre, stockage, F1). En WAL, la ligne supprimée reste lisible dans shares.db-wal
	// et dans shares.db tant que le WAL n'est pas replié.
	s.Vidage.Demander()
	s.forget(id)
	s.reports.forget(id)
	if state == "uploading" && s.OnAbandon != nil {
		s.OnAbandon(id, bucket)
	}
	return true, nil
}

// retireOrNotFound : destruction EXPLICITE (créateur par S_gestion, destinataire par K_preuve,
// administrateur). Au succès, le WAL est vidé tout de suite, dans cette requête (Vidage.
// Maintenant) : les métadonnées du partage supprimé (V_accès, V_gestion, sel, palier, échéance)
// ne restent ni dans shares.db-wal ni dans shares.db, lisibles à une saisie du serveur en
// marche (audit adverse du 13 novembre, St1). Tous les autres effacements (fin de
// téléchargement, 5 essais, échéance : destroy) demandent un vidage regroupé, fait dans la
// seconde hors de la requête (2e passage, stockage, F1). Un vidage incomplet (base occupée par
// un autre processus : attente courte, F3) n'est pas une erreur : il est compté et refait par
// la boucle des vidages (le partage est de toute façon déjà supprimé).
func (s *Service) retireOrNotFound(id string, grace bool) error {
	ok, err := s.retire(id, grace, s.now())
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	_ = s.Vidage.Maintenant()
	return nil
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

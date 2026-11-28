package share

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"hash/fnv"
	"slices"
	"sync"
	"time"
)

// Reprise après un redémarrage (D42-31, 28 novembre : « il ne faut rien perdre après un
// redémarrage », mise à jour, coupure ou plantage). Ce qu'un envoi en cours et une ouverture ne
// doivent pas perdre est rangé dans shares.db EN MARCHE, avant chaque réponse qui en dépend, et
// relu au démarrage (PurgeAtStart) :
//
//   - envoi : segments et plages écrits avec fdatasync avant d'être acquittés (le client ne
//     peut pas rechiffrer une plage déjà produite : il ne la renvoie jamais), masque des
//     segments complets (shares.segments_mask), échéance, morceaux reçus, segments incomplets
//     et formule chiffrée (shares_envoi). Les jetons d'envoi, eux, ne survivent pas (clé tirée
//     au démarrage) : l'expéditeur en reprend un avec S_gestion (Resume), qu'il est seul à
//     détenir ; le serveur n'en garde que l'empreinte V_gestion, comme avant ;
//   - ouverture : empreinte de l'octroi, retours, octets lus, voix de signalement
//     (shares_ouvertures) ; les « draining » sont gardés jusqu'à leur échéance.
//
// Rien de nouveau n'est écrit qui ne soit déjà connu du serveur en mémoire ; la formule,
// qu'aucune colonne ne gardait (tier.go), est chiffrée sous une clé que seul l'expéditeur peut
// redonner. Les seaux des limites de débit et les défis anti-robot ne sont pas repris (une clé
// neuve à chaque démarrage, sans perte pour personne).

// etiquetteFormule : information HKDF et préfixe des données authentifiées de la formule.
const etiquetteFormule = "shhdrop/envoi/formule/v1"

// formuleLen : nonce (12) ‖ formule chiffrée (1) ‖ étiquette (16).
const formuleLen = 12 + 1 + 16

// aeadFormule : AES-256-GCM sous HKDF-SHA-256(S_gestion, info = etiquetteFormule) (bibliothèque
// standard de Go). S_gestion fait 32 octets aléatoires : aucun sel n'est utile.
func aeadFormule(sGestion []byte) cipher.AEAD {
	k, err := hkdf.Key(sha256.New, sGestion, nil, etiquetteFormule, 32)
	if err != nil {
		panic("share : HKDF de la formule") // jamais pour 32 octets
	}
	b, err := aes.NewCipher(k)
	if err != nil {
		panic("share : AES de la formule")
	}
	a, err := cipher.NewGCM(b)
	if err != nil {
		panic("share : GCM de la formule")
	}
	return a
}

// scellerFormule chiffre la formule t de l'envoi id sous S_gestion (nonce aléatoire).
func scellerFormule(sGestion []byte, id string, t Tier) []byte {
	nonce := make([]byte, 12, formuleLen)
	rand.Read(nonce) // ne renvoie jamais d'erreur (Go ≥ 1.24)
	return aeadFormule(sGestion).Seal(nonce, nonce, []byte{byte(t)}, []byte(etiquetteFormule+id))
}

// ouvrirFormule déchiffre la formule de l'envoi id ; faux si b n'a pas été scellé sous ce
// S_gestion pour cet envoi.
func ouvrirFormule(sGestion []byte, id string, b []byte) (Tier, bool) {
	if len(sGestion) != 32 || len(b) != formuleLen {
		return 0, false
	}
	pt, err := aeadFormule(sGestion).Open(nil, b[:12], b[12:], []byte(etiquetteFormule+id))
	if err != nil || len(pt) != 1 || !Tier(pt[0]).Valid() {
		return 0, false
	}
	return Tier(pt[0]), true
}

// insertUpload écrit la ligne de l'envoi et, s'il est repris après un redémarrage (scelle
// non nil), sa ligne shares_envoi, dans une transaction.
func (s *Service) insertUpload(id string, r CreateReq, segs int, deadline int64, scelle []byte) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO shares(id,state,bucket,opens_left,segments_mask,access_v,manage_v)
		VALUES(?,'uploading',?,0,?,?,?)`,
		id, r.Bucket, make([]byte, (segs+7)/8), r.AccessV, r.ManageV); err != nil {
		return err
	}
	if scelle != nil {
		if _, err := tx.Exec(`INSERT INTO shares_envoi(share_id,echeance,formule) VALUES(?,?,?)`, id, deadline, scelle); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// encodeParts : segments incomplets, triés par numéro (4 octets) puis morceaux reçus (8 octets).
func encodeParts(p map[int]uint64) []byte {
	ns := make([]int, 0, len(p))
	for n, b := range p {
		if b != 0 {
			ns = append(ns, n)
		}
	}
	slices.Sort(ns)
	out := make([]byte, 0, 12*len(ns))
	for _, n := range ns {
		out = binary.BigEndian.AppendUint32(out, uint32(n))
		out = binary.BigEndian.AppendUint64(out, p[n])
	}
	return out
}

// decodeParts relit encodeParts pour un envoi de palier bucket : numéros croissants, dans le
// palier, bits dans les morceaux du segment ; faux sinon.
func decodeParts(b []byte, bucket int) (map[int]uint64, bool) {
	if len(b)%12 != 0 {
		return nil, false
	}
	p := map[int]uint64{}
	last := -1
	for i := 0; i < len(b); i += 12 {
		n := int(binary.BigEndian.Uint32(b[i:]))
		bits := binary.BigEndian.Uint64(b[i+4:])
		if n <= last || n >= SegmentCount(bucket) || bits == 0 || bits&^(^uint64(0)>>(SegChunks-chunksIn(bucket, n))) != 0 {
			return nil, false
		}
		p[n], last = bits, n
	}
	return p, true
}

// envoiLock : verrou de rangement de l'envoi id (rayé).
func (s *Service) envoiLock(id string) *sync.Mutex {
	h := fnv.New32a()
	h.Write([]byte(id))
	return &s.envoiMu[h.Sum32()%uint32(len(s.envoiMu))]
}

// rangerEnvoi range l'état en mémoire de l'envoi id (morceaux reçus, plus haut segment,
// segments incomplets) dans shares_envoi, avant la réponse qui l'acquitte. Envoi sans ligne de
// reprise : rien.
func (s *Service) rangerEnvoi(id string) error {
	mu := s.envoiLock(id)
	mu.Lock()
	defer mu.Unlock()
	s.mem.mu.Lock()
	u, ok := s.mem.up[id]
	var part []byte
	if ok && u.range_ {
		part = encodeParts(s.mem.part[id])
	}
	s.mem.mu.Unlock()
	if !ok || !u.range_ {
		return nil
	}
	_, err := s.DB.Exec(`UPDATE shares_envoi SET recus=?, haut=?, partiels=? WHERE share_id=?`, u.recv, u.top, part, id)
	return err
}

// Reprise : un envoi repris par son expéditeur (Resume) : identifiant interne (sujet du jeton
// d'envoi neuf), palier réservé, échéance de l'envoi, formule, masque des segments complets.
type Reprise struct {
	ID       string
	Bucket   int
	Deadline time.Time
	Tier     Tier
	Mask     []byte
}

// Resume : l'expéditeur (S_gestion) reprend son envoi en cours, après un redémarrage du serveur
// ou toute perte de son jeton d'envoi. Envoi relu au démarrage : sa formule est déchiffrée ici
// (clé tirée de S_gestion) et il accepte de nouveau segments, grow, erase, keep et finalize.
// Tout segment acquitté avant est sur le disque et compté : le client reprend là où il en était.
// Envoi inconnu, fini, échu ou formule illisible : ErrNotFound (le client recommence).
func (s *Service) Resume(sGestion []byte) (Reprise, error) {
	v := Verifier(sGestion)
	if v == nil {
		return Reprise{}, ErrNotFound
	}
	var id string
	if err := s.DB.QueryRow(`SELECT id FROM shares WHERE manage_v=? AND state='uploading'`, v).Scan(&id); err != nil {
		return Reprise{}, notFound(err)
	}
	// Sous le verrou exclusif de l'envoi : aucune écriture de segment en vol, masque exact.
	mu := s.uploadLock(id)
	mu.Lock()
	defer mu.Unlock()
	var bucket int
	var mask []byte
	if err := s.DB.QueryRow(`SELECT bucket, segments_mask FROM shares WHERE id=? AND state='uploading'`, id).Scan(&bucket, &mask); err != nil {
		return Reprise{}, notFound(err)
	}
	now := s.now()
	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	u, ok := s.mem.up[id]
	if !ok || u.deadline <= now {
		return Reprise{}, ErrNotFound
	}
	if u.scelle != nil {
		t, ok := ouvrirFormule(sGestion, id, u.scelle)
		if !ok {
			return Reprise{}, ErrNotFound
		}
		u.tier, u.window, u.scelle = t, t.UploadWindow(), nil
	}
	u.progress = minute(now)
	s.mem.up[id] = u
	return Reprise{ID: id, Bucket: bucket, Deadline: time.Unix(u.deadline, 0), Tier: u.tier, Mask: mask}, nil
}

// PurgeAtStart, à appeler au démarrage du serveur (jamais par une commande
// d'administration, qui partage la base d'un serveur en marche). Depuis D42-31, rien de ce qui
// vit encore n'est perdu :
//   - un envoi en cours est REPRIS s'il a sa ligne shares_envoi, que son échéance n'est pas
//     passée et que son fichier a la taille de son palier ; il attend son expéditeur (Resume)
//     au plus 15 min (stallSweep) ; sinon il est effacé, comme avant ;
//   - un partage « draining » vivant est gardé jusqu'à son échéance ;
//   - les ouvertures des partages vivants sont reprises (octrois, retours, octets lus, voix).
//
// Sont effacés : envois sans ligne de reprise ou échus pendant l'arrêt, partages échus ou
// détruits au 5ᵉ essai (spec §36 S12, §41.8). Rend le nombre de partages effacés.
func (s *Service) PurgeAtStart() (int, error) {
	now := s.now()
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
	n := 0
	var errs []error
	for _, id := range ids {
		keep, err := s.keepAtStart(id, now)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if keep {
			continue
		}
		ok, err := s.destroy(id)
		if err != nil {
			errs = append(errs, err)
		} else if ok {
			n++
		}
	}
	// Ligne de reprise d'un envoi déjà finalisé (jamais : finalize l'efface dans sa transaction).
	if _, err := s.DB.Exec(`DELETE FROM shares_envoi WHERE share_id IN (SELECT id FROM shares WHERE state<>'uploading')`); err != nil {
		errs = append(errs, err)
	}
	errs = append(errs, s.reprendreOuvertures(now))
	return n, errors.Join(errs...)
}

// keepAtStart : le partage id (non prêt, échu ou aux essais épuisés) est à garder au
// démarrage ; un envoi gardé est inscrit en mémoire, en attente de son expéditeur.
func (s *Service) keepAtStart(id string, now int64) (bool, error) {
	var state string
	var bucket, failed int
	var exp sql.NullInt64
	var mask []byte
	err := s.DB.QueryRow(`SELECT state, bucket, failed_attempts, expires_at, segments_mask FROM shares WHERE id=?`, id).
		Scan(&state, &bucket, &failed, &exp, &mask)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	switch state {
	case "draining":
		// Gardé seulement si une de ses ouvertures peut y revenir (octroi rangé) : un « draining »
		// d'avant D42-31 (octrois HMAC d'une clé perdue) n'est plus lisible par personne.
		var one int
		err := s.DB.QueryRow(`SELECT 1 FROM shares_ouvertures WHERE share_id=? LIMIT 1`, id).Scan(&one)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
		if err == nil && exp.Valid && exp.Int64 > now && failed < maxAttempts {
			s.setPurge(id, exp.Int64) // purge à l'échéance, comme en marche (D42-22)
			return true, nil
		}
	case "uploading":
		var ech, recus int64
		var haut int
		var formule, partiels []byte
		err := s.DB.QueryRow(`SELECT echeance, formule, recus, haut, partiels FROM shares_envoi WHERE share_id=?`, id).
			Scan(&ech, &formule, &recus, &haut, &partiels)
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil // envoi sans ligne de reprise : effacé
		}
		if err != nil {
			return false, err
		}
		segs := SegmentCount(bucket)
		part, ok := decodeParts(partiels, bucket)
		if ech <= now || !bucketAllowed(bucket, Pro) || len(mask) != (segs+7)/8 || haut > segs || recus < 0 ||
			len(formule) != formuleLen || !ok || !s.blobSized(id, totalSize(bucket)) {
			return false, nil // échu pendant l'arrêt, ou état incohérent : effacé (le client recommence)
		}
		s.setUpload(id, upload{deadline: ech, progress: minute(now), recv: recus, top: haut, range_: true, scelle: formule})
		if len(part) > 0 {
			s.mem.mu.Lock()
			if s.mem.part == nil {
				s.mem.part = map[string]map[int]uint64{}
			}
			s.mem.part[id] = part
			s.mem.mu.Unlock()
		}
		return true, nil
	}
	return false, nil
}

// blobSized : le fichier de id existe et fait exactement size octets.
func (s *Service) blobSized(id string, size int64) bool {
	f, err := s.Blobs.OpenFile(id)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	return err == nil && fi.Size() == size
}

// reprendreOuvertures relit les ouvertures des partages vivants (prêts ou « draining ») :
// octrois (empreintes), retours, octets lus et voix de signalement.
func (s *Service) reprendreOuvertures(now int64) error {
	rows, err := s.DB.Query(`SELECT o.share_id, o.n, o.octroi, o.retours, o.lus, o.voix, s.expires_at, s.done_mask, s.opens_issued
		FROM shares_ouvertures o JOIN shares s ON s.id=o.share_id
		WHERE s.state IN ('ready','draining') AND s.expires_at>? AND s.failed_attempts<?`, now, maxAttempts)
	if err != nil {
		return err
	}
	type ligne struct {
		id                 string
		n, retours, issued int
		h                  []byte
		lus, exp, done     int64
		voix               bool
	}
	var ls []ligne
	for rows.Next() {
		var l ligne
		if err := rows.Scan(&l.id, &l.n, &l.h, &l.retours, &l.lus, &l.voix, &l.exp, &l.done, &l.issued); err != nil {
			rows.Close()
			return err
		}
		ls = append(ls, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, l := range ls {
		if l.n < 1 || l.n > maxOpenN || l.n > l.issued || len(l.h) != 32 || l.lus < 0 {
			continue // jamais : bornes de la table et des ouvertures émises
		}
		k := openKey{l.id, l.n}
		e := &grantEntry{reopens: min(max(l.retours, 0), MaxReopens), exp: l.exp, done: l.done&(int64(1)<<(l.n-1)) != 0}
		copy(e.h[:], l.h)
		s.gone.mu.Lock()
		s.gone.init()
		s.gone.grants[k] = e
		s.gone.unlock()
		s.budget.load(k, l.lus, max(l.exp+graceWindow, now+purgeWindow))
		if l.voix {
			s.reports.vote(l.id, l.n, l.exp)
		}
	}
	return nil
}

// rangerRetours : retours acceptés de l'ouverture k, rangés (jamais en arrière).
func (s *Service) rangerRetours(k openKey, reopens int) error {
	_, err := s.DB.Exec(`UPDATE shares_ouvertures SET retours=max(retours,?) WHERE share_id=? AND n=?`, reopens, k.id, k.openN)
	return err
}

// rangerVoix : voix de signalement de l'ouverture n du partage id, rangée.
func (s *Service) rangerVoix(id string, n int) error {
	_, err := s.DB.Exec(`UPDATE shares_ouvertures SET voix=1 WHERE share_id=? AND n=?`, id, n)
	return err
}

// RangerLectures range les octets lus par les ouvertures depuis le dernier rangement, en une
// transaction (appelée chaque seconde par janitor.Watch, et une dernière fois à l'arrêt). Après
// un plantage, au plus la dernière seconde de lecture est oubliée (en faveur du lecteur).
func (s *Service) RangerLectures() error {
	s.lecturesMu.Lock()
	defer s.lecturesMu.Unlock()
	p := s.budget.pending()
	if len(p) == 0 {
		return nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, x := range p {
		if _, err := tx.Exec(`UPDATE shares_ouvertures SET lus=? WHERE share_id=? AND n=?`, x.used, x.k.id, x.k.openN); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, x := range p {
		s.budget.markStored(x.k, x.used)
	}
	return nil
}

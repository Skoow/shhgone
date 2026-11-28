package salon

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"slices"
	"time"
)

// Persistance continue des salons (conception du salon v3 §5.2 ; demande du propriétaire du
// 26 novembre : les salons survivent aussi à une coupure de courant, une panne, un manque de
// mémoire ou un SIGKILL, plus seulement à un arrêt propre).
//
// Avec une clé maîtresse (Config.CleReprise), chaque salon en mémoire a EN PERMANENCE une ligne
// dans shares.db : salons_reprise (clé de la conversation enveloppée par la clé maîtresse, tête
// de l'état chiffrée sous la clé de la conversation) et salons_reprise_blocs (journal des
// annonces et index des trames, par blocs de 256 entrées, chacun chiffré sous la clé de la
// conversation). Une passe d'écriture (persister) :
//
//  1. sous le verrou de chaque salon : état copié (tête, blocs changés depuis la passe
//     précédente), rien d'écrit ;
//  2. hors de tout verrou de salon : fichier de conversation synchronisé (fsync), pour que
//     chaque trame que l'index écrit désigne soit sur le disque avant lui (sinon, après une
//     coupure de courant, une trame illisible arrêterait tout rattrapage) ;
//  3. une transaction SQLite pour tous les salons de la passe (synchronous=FULL) : chaque
//     ligne est remplacée d'un coup, jamais à moitié ; un salon dont la ligne de salons n'est
//     plus vivante (détruit, échu, 10 essais) voit la sienne effacée au lieu d'être écrite.
//
// Quand : à la fin de chaque requête qui change ce qu'un membre ne doit pas perdre (entrée,
// départ, exclusion, retrait, renouvellement, réglages, ouverture des appels : avant la réponse),
// et chaque seconde pour tout le reste (trames, lectures, échéances, pièces). Une passe ne
// récrit que les blocs changés : un salon actif écrit sa tête et son dernier bloc d'index
// (environ 10 Ko) au plus une fois par seconde ; un salon calme n'écrit rien.
//
// Cohérence après un plantage (la ligne est un instantané pris sous le verrou du salon, donc un
// état qui a vraiment existé) :
//   - aucun rang redonné : la tête porte une réserve de rangs (au-delà du dernier rang donné,
//     margeRangs au moins) ; la reprise repart de la réserve, et le salon ne donne jamais un
//     rang au-delà de la réserve de la dernière ligne validée (rangLibreLocked) ;
//   - aucun jeton révoqué qui revient : l'exclusion écrit d'abord la rotation en base
//     (rotation_r, exclusion.go) ; une ligne dont la rotation n'est pas celle de la base n'est
//     pas reprise (repli : « rejoindre ») ; l'exclusion appliquée est écrite avant la réponse ;
//   - aucune conversation effacée qui revient : un renouvellement efface la ligne AVANT de
//     changer quoi que ce soit (suspendre), et un emplacement effacé (retrait, échéance) n'est
//     écrasé sur le disque qu'une fois son effacement écrit dans une ligne validée (aEcraserSurs) ;
//   - ce qui est perdu : au plus la dernière seconde de trames, de lectures et d'échéances
//     (les clients qui les ont vues en direct les gardent ; un Commit MLS perdu met en retard
//     les membres qui l'ont reçu : epoque_perdue, reprise par le client, exigence 5 du §3.6.1).

const (
	// blocJournal, blocIndex : entrées par bloc chiffré (journal : 39 octets au plus l'annonce,
	// index : 32 octets l'entrée ; environ 10 Ko le bloc).
	blocJournal = 256
	blocIndex   = 256
	// margeRangs : rangs réservés d'avance par la tête écrite ; arrondie à ce pas pour que des
	// trames volatiles (sans écriture) ne changent pas la tête à chaque passe. Bien au-delà de
	// ce qu'un salon peut donner en une seconde.
	margeRangs = 1 << 16
	// sansBorne : aucune ligne n'a encore été préparée : aucune borne des rangs.
	sansBorne = math.MaxUint64
	// adBloc : début des données authentifiées d'un bloc (suivies de l'identifiant, du genre et
	// du numéro : un bloc ne se déplace ni d'un salon à l'autre, ni d'une place à l'autre).
	adBloc       = "shhdrop/salon/reprise/bloc/v1"
	genreJournal = 0
	genreIndex   = 1
	// tailleEntreeV2 : entrée de l'index dans un bloc (relais.go, entree ; plus l'échéance).
	tailleEntreeV2 = 8 + 8 + 2 + 4 + 1 + 1 + 8
)

// persistance : état de la ligne de reprise d'un salon, sous salon.mu.
type persistance struct {
	// actif : clé maîtresse posée, le salon est rangé en continu.
	actif bool
	// cle, conv : conversation courante et copie de sa clé (scelle tête et blocs) ; cle mise à
	// zéro à la fin du salon.
	cle  [32]byte
	conv *Conversation
	// ligne : une ligne complète de conv (tête et tous les blocs) a été validée ; peutExister :
	// une ligne existe peut-être en base (écriture tentée, pas encore effacée).
	ligne, peutExister bool
	// suspendue : ligne à effacer et à ne plus écrire (renouvellement en cours) ; fige : arrêt
	// propre (le salon, fini pour ce processus, est écrit une dernière fois au lieu d'être
	// effacé).
	suspendue, fige bool
	// empreinte : SHA-256 de la dernière tête validée ; journalEcrit, indexEcrit : entrées
	// couvertes par les blocs validés ; sales, enVol : blocs de l'index changés depuis (ou pris
	// par la passe en cours).
	empreinte                [32]byte
	journalEcrit, indexEcrit int
	sales, enVol             map[int]struct{}
	// borne : aucun rang au-delà (réserve de la dernière ligne validée, ou de la première
	// préparée) ; borneEcrite : réserve de la dernière ligne validée.
	borne, borneEcrite uint64
	// aEcraserBase : emplacements déjà sortis de salon.aEcraser depuis la création ;
	// aEcraserSurs : position (même compte) jusqu'où leur effacement est écrit dans une ligne
	// validée : seuls ceux-là peuvent être écrasés sur le disque (prendreAEcraser).
	aEcraserBase, aEcraserSurs uint64
}

// poserConvLocked : conv (clé cle) devient la conversation rangée du salon ; ligne entière à
// récrire. Appelé sous s.mu.
func (s *salon) poserConvLocked(conv *Conversation, cle [32]byte) {
	s.p.conv, s.p.cle, s.p.ligne = conv, cle, false
}

// salirIndexLocked : l'entrée i de l'index a changé (effacement, lecture) : son bloc est à
// récrire. Les ajouts en fin d'index n'ont pas besoin d'être marqués. Appelé sous s.mu.
func (s *salon) salirIndexLocked(i int) {
	if !s.p.actif {
		return
	}
	if s.p.sales == nil {
		s.p.sales = map[int]struct{}{}
	}
	s.p.sales[i/blocIndex] = struct{}{}
}

// margeDeparts : rangs gardés sous la borne pour ce qui ne peut pas être refusé : un départ par
// siège occupé (0x03, 0x09) et le 0x09 d'une exclusion déjà vérifiée (une à la fois, essaiLock).
const margeDeparts = nbSieges + 1

// rangLibreLocked : un rang de plus peut être donné à une trame ou une annonce qui n'est pas un
// départ. Au-delà, seuls les départs passent : ils ne sont jamais plus de margeDeparts (aucun
// siège ne s'occupe sans annonce vérifiée ici), si bien qu'aucun rang ne dépasse la borne.
// Appelé sous s.mu.
func (s *salon) rangLibreLocked() bool {
	return s.p.borne == sansBorne || s.seq+1+margeDeparts <= s.p.borne
}

// viderAEcraserLocked : emplacements à écraser oubliés (conversation remplacée ou détruite).
func (s *salon) viderAEcraserLocked() {
	s.p.aEcraserBase += uint64(len(s.aEcraser))
	s.aEcraser = nil
}

// ecriture : ce qu'une passe range pour un salon, préparé sous son verrou.
type ecriture struct {
	s         *salon
	id        string
	supprimer bool
	conv      *Conversation
	cle       [32]byte
	tete      []byte
	empreinte [32]byte
	blocs     []blocClair
	nJ, nI    int
	reserve   uint64
	posEcr    uint64
	journal   int
	index     int
	enVol     map[int]struct{}
	err       error
	mort      bool // ligne du salon plus vivante : ligne de reprise effacée
}

type blocClair struct {
	genre, n int
	clair    []byte
}

func nbBlocs(n, taille int) int { return (n + taille - 1) / taille }

// preparerLocked : ce que la passe doit écrire pour ce salon (nil : rien). Appelé sous s.mu.
func (s *salon) preparerLocked(now time.Time) *ecriture {
	p := &s.p
	if !p.actif {
		return nil
	}
	if p.suspendue || (s.fini && !p.fige) || !now.Before(s.expires) || s.conv == nil || s.conv != p.conv ||
		s.ancienne != nil {
		if !p.peutExister {
			return nil
		}
		return &ecriture{s: s, id: s.id, supprimer: true}
	}
	e := &ecriture{s: s, id: s.id, conv: s.conv, cle: p.cle}
	if p.fige {
		e.reserve = s.seq // arrêt propre : plus aucun rang ne sera donné, aucun trou à la reprise
	} else {
		e.reserve = (s.seq/margeRangs + 2) * margeRangs
	}
	complete := !p.ligne
	e.nJ, e.nI = nbBlocs(len(s.journal), blocJournal), nbBlocs(len(s.index), blocIndex)
	e.tete = s.encoderTeteLocked(e.reserve, s.conv.nA.Load(), e.nJ, e.nI)
	e.empreinte = sha256.Sum256(e.tete)
	debutJ, debutI := p.journalEcrit/blocJournal, p.indexEcrit/blocIndex
	if complete {
		debutJ, debutI = 0, 0
	}
	for b := debutJ; b < e.nJ; b++ {
		e.blocs = append(e.blocs, blocClair{genreJournal, b, s.encoderJournalLocked(b)})
	}
	idx := map[int]bool{}
	for b := debutI; b < e.nI; b++ {
		idx[b] = true
	}
	for b := range p.sales {
		if b < e.nI {
			idx[b] = true
		}
	}
	if len(idx) > 0 {
		ech := make(map[uint64]int64, len(s.echeances))
		for _, x := range s.echeances {
			ech[x.seq] = x.ms
		}
		for b := range idx {
			e.blocs = append(e.blocs, blocClair{genreIndex, b, s.encoderIndexLocked(b, ech)})
		}
	}
	if !complete && len(e.blocs) == 0 && e.empreinte == p.empreinte {
		return nil
	}
	e.enVol, p.sales = p.sales, nil
	e.journal, e.index = len(s.journal), len(s.index)
	e.posEcr = p.aEcraserBase + uint64(len(s.aEcraser))
	p.borne = min(p.borne, e.reserve) // première ligne : borne dès maintenant (prudence)
	p.peutExister = true
	return e
}

// apresLocked : résultat de la passe pour ce salon. Appelé sous s.mu.
func (s *salon) apresLocked(e *ecriture, ok bool) {
	p := &s.p
	if !ok {
		for b := range e.enVol {
			if p.sales == nil {
				p.sales = map[int]struct{}{}
			}
			p.sales[b] = struct{}{}
		}
		return
	}
	if e.supprimer || e.mort {
		p.ligne, p.peutExister, p.empreinte, p.journalEcrit, p.indexEcrit = false, false, [32]byte{}, 0, 0
		return
	}
	if e.conv != p.conv {
		return // conversation remplacée entre-temps : ligne entière à récrire
	}
	p.ligne, p.empreinte, p.journalEcrit, p.indexEcrit = true, e.empreinte, e.journal, e.index
	p.borneEcrite, p.borne = e.reserve, e.reserve
	p.aEcraserSurs = max(p.aEcraserSurs, e.posEcr)
}

// errPersistance : une passe n'a pas pu écrire (base, fsync) ; message fixe.
var errPersistance = errors.New("salon: état non rangé")

// persister : une passe d'écriture pour ces salons (voir l'en-tête), une à la fois. Sans clé
// maîtresse : rien. Rend errPersistance si un salon n'a pas été écrit (ou effacé) comme prévu.
// À appeler hors de tout verrou de salon (essaiLock permis).
func (m *Manager) persister(salons ...*salon) error {
	if m.cfg.CleReprise == nil {
		return nil
	}
	m.persMu.Lock()
	defer m.persMu.Unlock()
	now := m.cfg.Now()
	var l []*ecriture
	for _, s := range salons {
		s.mu.Lock()
		e := s.preparerLocked(now)
		s.mu.Unlock()
		if e != nil {
			l = append(l, e)
		}
	}
	if len(l) == 0 {
		return nil
	}
	err := m.ecrire(l, now.Unix())
	for _, e := range l {
		e.s.mu.Lock()
		e.s.apresLocked(e, err == nil && e.err == nil)
		e.s.mu.Unlock()
		clear(e.cle[:])
		if e.err != nil && err == nil {
			err = e.err
		}
	}
	if err != nil {
		m.persistRatees.Add(1)
		return errPersistance
	}
	return nil
}

// persisterTout : passe de l'entretien (chaque seconde) sur tous les salons en mémoire.
func (m *Manager) persisterTout() { _ = m.persister(m.copieSalons(nil)...) }

// ecrire : fichiers synchronisés, puis une transaction pour toute la passe.
func (m *Manager) ecrire(l []*ecriture, now int64) error {
	syncs := map[*Conversation]error{}
	type scelle struct {
		env, etat []byte
		blocs     [][]byte
	}
	sc := make([]scelle, len(l))
	for i, e := range l {
		if e.supprimer {
			continue
		}
		err, vu := syncs[e.conv]
		if !vu {
			err = e.conv.synchroniser()
			syncs[e.conv] = err
		}
		if err != nil {
			e.err = errPersistance // trames peut-être pas sur le disque : rien n'est validé
			continue
		}
		var errS error
		if sc[i].env, errS = sceller(m.cfg.CleReprise[:], adCle, e.id, e.cle[:]); errS == nil {
			sc[i].etat, errS = sceller(e.cle[:], adEtat, e.id, e.tete)
		}
		for _, b := range e.blocs {
			if errS != nil {
				break
			}
			var c []byte
			c, errS = sceller(e.cle[:], adBloc, adBlocID(e.id, b.genre, b.n), b.clair)
			sc[i].blocs = append(sc[i].blocs, c)
		}
		if errS != nil {
			e.err = errPersistance
		}
	}
	tx, err := m.cfg.DB.Begin()
	if err != nil {
		return base(err)
	}
	defer tx.Rollback()
	for i, e := range l {
		if e.err != nil {
			continue
		}
		var un int
		vivant := true
		if !e.supprimer {
			switch err := tx.QueryRow(`SELECT 1 FROM salons WHERE id=? AND expires_at>? AND failed_attempts<?`,
				e.id, now, maxEssais).Scan(&un); {
			case err == nil:
			case errors.Is(err, errNoRows):
				vivant = false
			default:
				return base(err)
			}
		}
		if e.supprimer || !vivant {
			e.mort = !vivant
			if err := effacerRepriseTx(tx, e.id); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.Exec(`INSERT INTO salons_reprise(salon_id,cle,etat) VALUES(?,?,?) ON CONFLICT(salon_id)
			DO UPDATE SET cle=excluded.cle, etat=excluded.etat`, e.id, sc[i].env, sc[i].etat); err != nil {
			return base(err)
		}
		for k, b := range e.blocs {
			if _, err := tx.Exec(`INSERT INTO salons_reprise_blocs(salon_id,genre,n,donnees) VALUES(?,?,?,?)
				ON CONFLICT(salon_id,genre,n) DO UPDATE SET donnees=excluded.donnees`, e.id, b.genre, b.n, sc[i].blocs[k]); err != nil {
				return base(err)
			}
		}
		if _, err := tx.Exec(`DELETE FROM salons_reprise_blocs WHERE salon_id=? AND ((genre=0 AND n>=?) OR (genre=1 AND n>=?))`,
			e.id, e.nJ, e.nI); err != nil {
			return base(err)
		}
	}
	return base(tx.Commit())
}

// adBlocID : identifiant et place d'un bloc, ajoutés à adBloc.
func adBlocID(id string, genre, n int) string {
	return id + string(binary.BigEndian.AppendUint32([]byte{byte(genre)}, uint32(n)))
}

// suspendre : renouvellement : la ligne de reprise du salon est effacée (validé avant le
// retour) et plus écrite jusqu'à reprendreEcriture. Un plantage entre les deux ne reprend pas
// ce salon (repli : « rejoindre ») : jamais l'ancienne conversation.
func (m *Manager) suspendre(s *salon) error {
	if m.cfg.CleReprise == nil {
		return nil
	}
	s.mu.Lock()
	s.p.suspendue, s.p.peutExister = true, true
	s.mu.Unlock()
	return m.persister(s)
}

// reprendreEcriture : fin d'une suspension ; conv (clé cle) est la conversation à ranger.
func (m *Manager) reprendreEcriture(s *salon, conv *Conversation, cle [32]byte) {
	s.mu.Lock()
	s.p.suspendue = false
	s.poserConvLocked(conv, cle)
	s.mu.Unlock()
	_ = m.persister(s)
}

// Sauvegarder : arrêt propre, à appeler une seule fois, APRÈS FermerTout, AttendreConnexions et
// l'arrêt de l'entretien (Run), et avant la fermeture de la base. Chaque salon est figé sous son
// verrou (plus rien n'y entre ni n'y change : fini pour ce processus, sans partie disque) puis
// écrit une dernière fois, avec une réserve égale à son dernier rang (aucun trou à la reprise).
// Rend le nombre de salons figés et écrits. Sans clé maîtresse : rien.
func (m *Manager) Sauvegarder() (int, error) {
	if m.cfg.CleReprise == nil {
		return 0, nil
	}
	now := m.cfg.Now()
	var l []*salon
	for _, s := range m.copieSalons(nil) {
		s.mu.Lock()
		if !s.fini && now.Before(s.expires) && s.conv != nil && s.ancienne == nil && !s.p.suspendue {
			s.p.fige = true
			l = append(l, s)
		}
		s.fini = true
		s.finiA.Store(true)
		s.mu.Unlock()
	}
	err := m.persister(l...)
	nb := 0
	for _, s := range l {
		s.mu.Lock()
		if s.p.ligne && s.p.borneEcrite == s.seq {
			nb++
		}
		s.mu.Unlock()
	}
	return nb, err
}

// --- Format (en clair seulement sous la clé de la conversation) ------------------------------
//
// Tête, version 3 : version (1) ‖ n emplacements (4) ‖ réserve des rangs (8) ‖ rotation (4) ‖
// blocs du journal (4) ‖ blocs de l'index (4) ‖ arrivées ‖ signalé ‖ signalements ‖ départ ‖ gen
// ‖ réglé ‖ appels jusqu'à ‖ sièges ‖ révoqués ‖ emplacements à écraser ‖ pièces (prêtes, et en
// envoi depuis D42-32 : un octet d'état de plus par pièce ; les segments reçus d'une pièce en
// envoi sont dans salon_pieces.segments_mask, noté avant chaque accusé). Version 2 (pièces
// prêtes seules, sans octet d'état) : relue à la mise à jour.
// Bloc du journal : annonces (rang 8, longueur 1, enregistrement). Bloc de l'index : entrées
// (rang 8, reçu 8, attendus 2, emplacement 4, siège 1, drapeaux 1, échéance 8 ; 0 : aucune).

const (
	versionTete  = 3
	versionTete2 = 2
)

// etatPieceRangee : octet d'état d'une pièce dans une tête de version 3.
const (
	rangeeEnvoi = 0
	rangeePrete = 1
)

func (s *salon) encoderTeteLocked(reserve uint64, n uint32, nJ, nI int) []byte {
	b := binary.BigEndian.AppendUint32([]byte{versionTete}, n)
	b = binary.BigEndian.AppendUint64(b, reserve)
	b = binary.BigEndian.AppendUint32(b, s.rotation)
	b = binary.BigEndian.AppendUint32(b, uint32(nJ))
	b = binary.BigEndian.AppendUint32(b, uint32(nI))
	b = s.encoderChampsLocked(b)
	b = s.encoderSiegesLocked(b)
	b = s.encoderRevoquesLocked(b)
	b = s.encoderAEcraserLocked(b)
	return s.encoderPiecesLocked(b)
}

func (s *salon) encoderJournalLocked(bloc int) []byte {
	var b []byte
	for _, ev := range s.journal[bloc*blocJournal : min(len(s.journal), (bloc+1)*blocJournal)] {
		b = binary.BigEndian.AppendUint64(b, ev.seq)
		b = append(b, uint8(len(ev.enr)))
		b = append(b, ev.enr...)
	}
	return b
}

func (s *salon) encoderIndexLocked(bloc int, ech map[uint64]int64) []byte {
	l := s.index[bloc*blocIndex : min(len(s.index), (bloc+1)*blocIndex)]
	b := make([]byte, 0, len(l)*tailleEntreeV2)
	for _, e := range l {
		b = binary.BigEndian.AppendUint64(b, e.seq)
		b = binary.BigEndian.AppendUint64(b, uint64(e.recuMs))
		b = binary.BigEndian.AppendUint16(b, e.attendus)
		b = binary.BigEndian.AppendUint32(b, e.emplacement)
		b = append(b, e.siege, e.drapeaux)
		b = binary.BigEndian.AppendUint64(b, uint64(ech[e.seq]))
	}
	return b
}

func (s *salon) encoderChampsLocked(b []byte) []byte {
	b = binary.BigEndian.AppendUint32(b, uint32(s.arrivees))
	b = append(b, bit(s.signale))
	for _, k := range s.signalements {
		b = binary.BigEndian.AppendUint32(b, uint32(k))
	}
	b = binary.BigEndian.AppendUint64(b, s.depart)
	b = binary.BigEndian.AppendUint64(b, s.gen.Load())
	b = append(b, bit(s.regle))
	return binary.BigEndian.AppendUint64(b, uint64(ms(s.appelsJusqua)))
}

func (s *salon) encoderSiegesLocked(b []byte) []byte {
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
	return b
}

func (s *salon) encoderRevoquesLocked(b []byte) []byte {
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.revoques)))
	l := make([][32]byte, 0, len(s.revoques))
	for h := range s.revoques {
		l = append(l, h)
	}
	slices.SortFunc(l, func(a, c [32]byte) int { return cmpStr(string(a[:]), string(c[:])) }) // tête stable
	for _, h := range l {
		b = append(b, h[:]...)
	}
	return b
}

func (s *salon) encoderAEcraserLocked(b []byte) []byte {
	b = binary.BigEndian.AppendUint32(b, uint32(len(s.aEcraser)))
	for _, e := range s.aEcraser {
		b = binary.BigEndian.AppendUint32(b, e)
	}
	return b
}

func (s *salon) encoderPiecesLocked(b []byte) []byte {
	// Pièces prêtes (sans écriture en cours) et pièces en envoi ou en finalisation (rangées
	// « en envoi » : une finalisation interrompue est refaite par le client, ou reprise
	// « prête » si sa ligne l'est déjà, reprendrePieces).
	var pretes []*piece
	for _, p := range s.lesPieces {
		if !p.efface && (p.etat != prete || p.ecritures == 0) {
			pretes = append(pretes, p)
		}
	}
	slices.SortFunc(pretes, func(a, c *piece) int { return cmpStr(a.id, c.id) })
	b = binary.BigEndian.AppendUint32(b, uint32(len(pretes)))
	for _, p := range pretes {
		b = append(b, uint8(len(p.id)))
		b = append(b, p.id...)
		if p.etat == prete {
			b = append(b, rangeePrete)
		} else {
			b = append(b, rangeeEnvoi)
		}
		b = binary.BigEndian.AppendUint32(b, uint32(p.bucket))
		b = append(b, bit(p.vocal), p.siege)
		b = append(b, p.auteur[:]...)
		for _, v := range []uint64{p.rang, p.lien, p.gen, uint64(p.places), uint64(ms(p.activite)), uint64(p.servis)} {
			b = binary.BigEndian.AppendUint64(b, v)
		}
		b = binary.BigEndian.AppendUint32(b, uint32(len(p.lus)))
		lus := make([][32]byte, 0, len(p.lus))
		for jv := range p.lus {
			lus = append(lus, jv)
		}
		slices.SortFunc(lus, func(a, c [32]byte) int { return cmpStr(string(a[:]), string(c[:])) })
		for _, jv := range lus {
			b = append(b, jv[:]...)
			b = binary.BigEndian.AppendUint64(b, uint64(p.lus[jv]))
		}
	}
	return b
}

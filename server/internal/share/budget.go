package share

import "sync"

// DefaultEgressMax : octets servis au plus par un partage, toutes ouvertures confondues
// (SHH_SHARE_EGRESS_MAX ; décision du propriétaire du 24 novembre, décision 12). 250 Gio : le
// plafond « taille × ouvertures ≤ 250 Go » du Pro retenu par l'analyse de la spec (§38.6,
// §38.8.1, Q-P11). Un partage gratuit (2 Gio, 5 ouvertures) ne l'atteint jamais ; un Plus
// (10 Gio, 10 ouvertures) seulement en relisant plus de deux fois et demie ; un Pro de 30 Gio
// sert environ 8 téléchargements complets.
const DefaultEgressMax int64 = 250 << 30

// MinEgressMax : plus petit plafond accepté : un téléchargement complet du plus grand palier
// payant (30 Gio de données, ≈ 30,01 Gio chiffrés) doit toujours tenir.
const MinEgressMax int64 = 32 << 30

// ReadBudget : octets qu'une ouverture (un jeton de téléchargement) peut lire au total.
// Paquet v2 (spec §29.3) : une ouverture complète lit le segment 0 (en-tête, avant
// l'enveloppe), le dernier segment (manifeste), puis les segments des éléments, dont à
// nouveau le segment 0 ; le bourrage n'est jamais lu. Budget = une ouverture complète
// (fichier + segment 0 + dernier segment) plus un nouvel essai de chaque segment
// (fichier), soit 2 × fichier chiffré + segment 0 + dernier segment.
// Audit de sécurité M1 : sans borne, un jeton relit le partage pendant 6 h.
func ReadBudget(bucket int) int64 {
	return 2*totalSize(bucket) + int64(SegmentSize(bucket, 0)) + int64(SegmentSize(bucket, SegmentCount(bucket)-1))
}

type openKey struct {
	id    string
	openN int
}

type budgetEntry struct {
	used  int64
	until int64 // secondes Unix : au-delà, le jeton est expiré et l'entrée oubliée
}

// readBudget compte les octets lus par ouverture, et par partage toutes ouvertures confondues
// (plafond de sortie, DefaultEgressMax), en mémoire seulement (perdu au redémarrage, comme la
// clé des jetons : aucun ancien jeton n'est alors valable, et chaque lecteur doit consommer
// une nouvelle ouverture). Aucune adresse n'y figure : la clé est (identifiant, n° d'ouverture)
// ou l'identifiant du partage ; rien n'est écrit sur le disque.
type readBudget struct {
	mu        sync.Mutex
	m         map[openKey]budgetEntry
	shares    map[string]budgetEntry
	lastSweep int64
}

// init et balayage des entrées échues (au plus une fois par minute). Sous b.mu.
func (b *readBudget) initLocked(now int64) {
	if b.m == nil {
		b.m = map[openKey]budgetEntry{}
		b.shares = map[string]budgetEntry{}
	}
	if now-b.lastSweep >= 60 {
		b.lastSweep = now
		for key, e := range b.m {
			if e.until <= now {
				delete(b.m, key)
			}
		}
		for id, e := range b.shares {
			if e.until <= now {
				delete(b.shares, id)
			}
		}
	}
}

// charge : chargeAll sans plafond de partage (tests).
func (b *readBudget) charge(k openKey, n, limit, now int64) bool {
	return b.chargeAll(k, n, limit, 0, now) == nil
}

// chargeAll ajoute n octets au compteur de l'ouverture k et à celui de son partage si les
// deux totaux restent sous leur limite (limit, shareLimit ; shareLimit ≤ 0 : sans plafond de
// partage) ; sinon ne compte rien et rend ErrEgressLimit (partage) ou ErrBudget (ouverture),
// le plafond du partage d'abord, puisqu'il ne se recharge jamais. Une entrée vit purgeWindow
// (durée maximale d'un jeton de téléchargement) après sa première lecture, prolongée par keep.
func (b *readBudget) chargeAll(k openKey, n, limit, shareLimit, now int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.initLocked(now)
	e, ok := b.m[k]
	if !ok || e.until <= now {
		e = budgetEntry{until: now + purgeWindow}
	}
	se, ok := b.shares[k.id]
	if !ok || se.until <= now {
		se = budgetEntry{until: now + purgeWindow}
	}
	if shareLimit > 0 && n > shareLimit-se.used {
		return ErrEgressLimit
	}
	if n > limit-e.used {
		return ErrBudget
	}
	e.used += n
	b.m[k] = e
	se.used += n
	se.until = max(se.until, e.until)
	b.shares[k.id] = se
	return nil
}

// shareUsed : octets déjà servis par le partage id (0 sans entrée vivante).
func (b *readBudget) shareUsed(id string, now int64) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.initLocked(now)
	if se, ok := b.shares[id]; ok && se.until > now {
		return se.used
	}
	return 0
}

// keep : l'entrée de k (créée au besoin, à zéro) vit au moins jusqu'à until, l'échéance du
// partage : un retour (nouveau jeton, D42-22), même plus de 6 h après, ne remet jamais le
// compteur à zéro (spec §41.4). Le compteur du partage vit au moins autant.
func (b *readBudget) keep(k openKey, until int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.m == nil {
		b.m = map[openKey]budgetEntry{}
		b.shares = map[string]budgetEntry{}
	}
	e := b.m[k]
	e.until = max(e.until, until)
	b.m[k] = e
	se := b.shares[k.id]
	se.until = max(se.until, until)
	b.shares[k.id] = se
}

// forget oublie le compteur de k (ouverture finie avec son partage).
func (b *readBudget) forget(k openKey) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.m, k)
}

// count : entrées en mémoire (tests).
func (b *readBudget) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.m)
}

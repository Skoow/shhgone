package share

// Formules payantes (spec §38.8.1 ; conception du paiement §11) :
// le niveau (`tier`) d'un partage est fixé à sa création par un jeton anonyme dépensé (couche
// HTTP) et gardé EN MÉMOIRE avec l'envoi, jusqu'à la finalisation : il ne change que le plus
// grand palier, les durées et les ouvertures permises, et la fenêtre d'envoi. Aucune colonne ne
// le garde : la ligne d'un partage payant n'a rien de plus qu'un partage gratuit, sinon un palier
// plus grand, une durée ou des ouvertures que seule une formule permet (déjà visibles, §36 S30).
// Aucune sécurité de plus ni de moins (§38.9.0).

// Tier : 0 gratuit, 1 Plus, 2 Pro.
type Tier int

const (
	Gratuit Tier = 0
	Plus    Tier = 1
	Pro     Tier = 2
)

// PaidBuckets : paliers payants (5, 10, 20 et 30 Gio de données, plus le morceau du manifeste),
// mêmes valeurs que le moteur (format::PAID_BUCKETS ; engine/vectors/v5-paliers.json).
var PaidBuckets = []int{81921, 163841, 327681, 491521}

// Valid : niveau connu.
func (t Tier) Valid() bool { return t == Gratuit || t == Plus || t == Pro }

// MaxBucket : plus grand palier de la formule (2, 10 ou 30 Gio de données).
func (t Tier) MaxBucket() int {
	switch t {
	case Plus:
		return PaidBuckets[1]
	case Pro:
		return PaidBuckets[3]
	}
	return Buckets[len(Buckets)-1]
}

// MaxOpensOf : ouvertures au plus (gratuit 5, Plus 10, Pro 20 ; PAID de web/src/limits.ts).
func (t Tier) MaxOpensOf() int {
	switch t {
	case Plus:
		return 10
	case Pro:
		return 20
	}
	return MaxOpens
}

// TTLAllowed : durées permises en heures (gratuit 1, 6, 12, 24 ; Plus aussi 2 et 3 jours ; Pro
// aussi 7 jours, PAID.ttlDays).
func (t Tier) TTLAllowed(h int) bool {
	switch {
	case validTTL(h):
		return true
	case t == Plus:
		return h == 48 || h == 72
	case t == Pro:
		return h == 48 || h == 72 || h == 168
	}
	return false
}

// UploadWindow : fenêtre d'envoi en secondes (6 h ; 24 h pour un partage payant, spec §41.2).
func (t Tier) UploadWindow() int64 {
	if t == Plus || t == Pro {
		return paidUploadWindow
	}
	return uploadWindow
}

const paidUploadWindow = 24 * 3600

// bucketFor : palier connu (gratuit ou payant) permis par la formule.
func bucketAllowed(b int, t Tier) bool {
	if b > t.MaxBucket() {
		return false
	}
	if validBucket(b) {
		return true
	}
	for _, p := range PaidBuckets {
		if p == b {
			return true
		}
	}
	return false
}

// allBuckets : paliers gratuits puis payants, croissants.
func allBuckets() []int { return append(append([]int(nil), Buckets...), PaidBuckets...) }

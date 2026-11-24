package share

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestPaliersCommeLeMoteur : engine/vectors/v5-paliers.json (paliers payants, plus grand palier
// de chaque formule, réservation par formule) rejoué côté serveur.
func TestPaliersCommeLeMoteur(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "engine", "vectors", "v5-paliers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Paid    []int `json:"paid_buckets"`
		Paliers map[string]struct {
			Tier      int   `json:"tier"`
			MaxBucket int   `json:"max_bucket"`
			Content   int64 `json:"content_max"`
		} `json:"paliers"`
		Reservation []struct {
			Used   int    `json:"used"`
			Palier string `json:"palier"`
			Bucket int    `json:"bucket"`
		} `json:"reservation_for"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Paid) != len(PaidBuckets) {
		t.Fatal(v.Paid)
	}
	for i := range v.Paid {
		if v.Paid[i] != PaidBuckets[i] {
			t.Fatal(v.Paid)
		}
	}
	for nom, p := range v.Paliers {
		tr := Tier(p.Tier)
		if tr.MaxBucket() != p.MaxBucket || ContentBytes(tr.MaxBucket())-int64(65536)*0 != int64(p.MaxBucket-1)*65536 || !tr.Valid() {
			t.Errorf("%s : %d", nom, tr.MaxBucket())
		}
		_ = p.Content
	}
	// growLimit sans marge (top grand) : jamais au-delà du plus grand palier de la formule.
	for _, c := range v.Reservation {
		tr := map[string]Tier{"gratuit": Gratuit, "plus": Plus, "pro": Pro}[c.Palier]
		if c.Bucket != 0 && !bucketAllowed(c.Bucket, tr) {
			t.Errorf("%+v : palier refusé", c)
		}
	}
}

func TestFormules(t *testing.T) {
	if growLimit(1<<20, Gratuit) != 32769 || growLimit(1<<20, Plus) != 163841 || growLimit(1<<20, Pro) != 491521 {
		t.Fatal("growLimit plafonné par la formule")
	}
	if growLimit(511, Plus) != 81921 || growLimit(0, Pro) != 160 {
		t.Fatal(growLimit(511, Plus), growLimit(0, Pro))
	}
	for _, c := range []struct {
		b  int
		t  Tier
		ok bool
	}{{32769, Gratuit, true}, {81921, Gratuit, false}, {81921, Plus, true}, {163841, Plus, true}, {327681, Plus, false},
		{491521, Pro, true}, {491522, Pro, false}, {3, Pro, false}} {
		if bucketAllowed(c.b, c.t) != c.ok {
			t.Errorf("%+v", c)
		}
	}
	ok := FinalizeReq{TTLHours: 1, MaxOpens: 1, KdfOps: 3, KdfMem: 64 << 20, Salt: make([]byte, 16), ProofV: append([]byte{1}, make([]byte, 31)...),
		Envelope: make([]byte, EnvelopeLen), Bucket: 1, Header: make([]byte, Header), Tail: make([]byte, ChunkCT)}
	for _, c := range []struct {
		ttl, opens int
		t          Tier
		ok         bool
	}{{24, 5, Gratuit, true}, {48, 5, Gratuit, false}, {24, 6, Gratuit, false}, {72, 10, Plus, true}, {168, 10, Plus, false},
		{48, 11, Plus, false}, {168, 20, Pro, true}, {168, 21, Pro, false}, {96, 1, Pro, false}} {
		r := ok
		r.TTLHours, r.MaxOpens = c.ttl, c.opens
		if (ValidateFinalizeTier(r, c.t) == nil) != c.ok {
			t.Errorf("%+v", c)
		}
	}
	if ValidateFinalize(ok) != nil {
		t.Fatal("ValidateFinalize inchangé pour le gratuit")
	}
	if Gratuit.UploadWindow() != 6*3600 || Plus.UploadWindow() != 24*3600 || Tier(3).Valid() {
		t.Fatal("fenêtres")
	}
	if Validate(CreateReq{ID: NewID(), Bucket: 1, AccessV: make([]byte, 32), ManageV: make([]byte, 32), Tier: 3}) == nil {
		t.Fatal("formule inconnue acceptée")
	}
}

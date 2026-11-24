package config

import (
	"testing"

	"github.com/skoow/shhdrop/server/internal/share"
)

// SHH_SHARE_EGRESS_MAX : octets servis au plus par un partage (décision du 24 novembre). Absent :
// 0 (le service prend share.DefaultEgressMax) ; au moins share.MinEgressMax, entier décimal.
func TestFromEnvShareEgressMax(t *testing.T) {
	t.Setenv("SHH_DATA_DIR", "/d")
	t.Setenv("SHH_SHARE_EGRESS_MAX", "")
	c, err := FromEnv()
	if err != nil || c.ShareEgressMax != 0 {
		t.Fatal(c.ShareEgressMax, err)
	}
	if minShareEgress != share.MinEgressMax {
		t.Fatal("borne différente de celle du service")
	}
	t.Setenv("SHH_SHARE_EGRESS_MAX", "536870912000")
	if c, err := FromEnv(); err != nil || c.ShareEgressMax != 500<<30 {
		t.Fatal(c.ShareEgressMax, err)
	}
	for _, v := range []string{"abc", "-1", "0", "034359738368", "34359738367", "1e12", " 34359738368"} {
		t.Setenv("SHH_SHARE_EGRESS_MAX", v)
		if _, err := FromEnv(); err == nil {
			t.Error("accepté :", v)
		}
	}
	t.Setenv("SHH_SHARE_EGRESS_MAX", "34359738368")
	if _, err := FromEnv(); err != nil {
		t.Fatal("borne basse refusée :", err)
	}
}

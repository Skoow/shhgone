package config

import (
	"maps"
	"testing"
)

// Clé maîtresse des salons persistants (SHH_SALONS_CLE_FILE) : facultative, chemin absolu hors de
// SHH_DATA_DIR, avec le salon seulement.
func TestSalonsCleFile(t *testing.T) {
	base := map[string]string{"SHH_DATA_DIR": "/d", "SHH_SALONS": "1", "SHH_ORIGIN": "https://shhdrop.app"}
	avec := func(kv map[string]string) map[string]string {
		m := maps.Clone(base)
		maps.Copy(m, kv)
		return m
	}
	env(t, base)
	if c, err := FromEnv(); err != nil || c.SalonsCleFile != "" {
		t.Fatalf("défaut : %q %v", c.SalonsCleFile, err)
	}
	env(t, avec(map[string]string{"SHH_SALONS_CLE_FILE": "/run/secrets/shh_salons_cle"}))
	if c, err := FromEnv(); err != nil || c.SalonsCleFile != "/run/secrets/shh_salons_cle" {
		t.Fatalf("posée : %q %v", c.SalonsCleFile, err)
	}
	for nom, kv := range map[string]map[string]string{
		"relatif":          {"SHH_SALONS_CLE_FILE": "secrets/cle"},
		"dans les données": {"SHH_SALONS_CLE_FILE": "/d/cle"},
		"sans salon":       {"SHH_SALONS": "0", "SHH_SALONS_CLE_FILE": "/run/secrets/shh_salons_cle"},
	} {
		env(t, avec(kv))
		if _, err := FromEnv(); err == nil {
			t.Errorf("%s : accepté", nom)
		}
	}
}

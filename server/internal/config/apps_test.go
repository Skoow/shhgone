package config

import (
	"strings"
	"testing"
)

// Identifiants des apps natives (conception du compte par passkey §6.5) : vides par défaut ;
// formes exactes ; le paquet Android et ses empreintes vont ensemble.
func TestAppsConfig(t *testing.T) {
	env(t, map[string]string{"SHH_DATA_DIR": "/d"})
	c, err := FromEnv()
	if err != nil || c.AppleAppIDs != nil || c.AndroidPaquet != "" || c.AndroidEmpreintes != nil {
		t.Fatal(c.AppleAppIDs, c.AndroidPaquet, err)
	}
	fp := strings.TrimSuffix(strings.Repeat("AB:", 32), ":")
	env(t, map[string]string{"SHH_DATA_DIR": "/d", "SHH_APPLE_APP_IDS": "ABCDE12345.com.shhgone.app,ZZZZZ99999.com.shhgone.beta",
		"SHH_ANDROID_APP_PACKAGE": "com.shhgone.app", "SHH_ANDROID_APP_SHA256": fp + "," + strings.Replace(fp, "AB", "01", 1)})
	c, err = FromEnv()
	if err != nil || len(c.AppleAppIDs) != 2 || c.AndroidPaquet != "com.shhgone.app" || len(c.AndroidEmpreintes) != 2 {
		t.Fatal(c, err)
	}
	for nom, kv := range map[string]map[string]string{
		"TEAMID court":             {"SHH_APPLE_APP_IDS": "ABCDE1234.com.x.app"},
		"TEAMID minuscules":        {"SHH_APPLE_APP_IDS": "abcde12345.com.x.app"},
		"sans identifiant":         {"SHH_APPLE_APP_IDS": "ABCDE12345"},
		"virgule finale":           {"SHH_APPLE_APP_IDS": "ABCDE12345.com.x.app,"},
		"paquet sans empreinte":    {"SHH_ANDROID_APP_PACKAGE": "com.x.app"},
		"empreinte sans paquet":    {"SHH_ANDROID_APP_SHA256": fp},
		"paquet en majuscules":     {"SHH_ANDROID_APP_PACKAGE": "Com.x", "SHH_ANDROID_APP_SHA256": fp},
		"empreinte minuscules":     {"SHH_ANDROID_APP_PACKAGE": "com.x", "SHH_ANDROID_APP_SHA256": strings.ToLower(fp)},
		"empreinte de 31 octets":   {"SHH_ANDROID_APP_PACKAGE": "com.x", "SHH_ANDROID_APP_SHA256": fp[3:]},
		"empreinte sans les « : »": {"SHH_ANDROID_APP_PACKAGE": "com.x", "SHH_ANDROID_APP_SHA256": strings.ReplaceAll(fp, ":", "")},
	} {
		kv["SHH_DATA_DIR"] = "/d"
		env(t, kv)
		if _, err := FromEnv(); err == nil {
			t.Errorf("%s accepté", nom)
		}
	}
}

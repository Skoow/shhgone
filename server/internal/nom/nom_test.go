package nom

import (
	"errors"
	"strings"
	"testing"
)

func TestPropre(t *testing.T) {
	for entree, voulu := range map[string]string{
		"Alice":                       "Alice",
		"  Léa (cousine)  ":           "Léa (cousine)",
		"":                            "",
		"   ":                         "",
		"Zoë – 🎉":                     "Zoë – 🎉",
		"日本語":                         "日本語",
		strings.Repeat("é", Max):      strings.Repeat("é", Max),
		" " + strings.Repeat("a", 40): strings.Repeat("a", 40),
	} {
		got, err := Propre(entree)
		if err != nil || got != voulu {
			t.Errorf("Propre(%q) = %q, %v ; attendu %q", entree, got, err, voulu)
		}
	}
	for _, faux := range []string{
		strings.Repeat("a", Max+1),
		strings.Repeat("😀", Max+1),
		"a\nb", "a\tb", "a\x00b", "a\x7fb", "a\u0085b", // contrôles C0, DEL, C1
		"abc\u202edcba", "a\u200bb", "a\u2066b", "\ufeffa", // mise en forme (direction, sans chasse)
		"a\u2028b", "a\u2029b", // séparateurs de ligne et de paragraphe
		"a\ue000b", // usage privé
		"a\xffb",   // UTF-8 invalide
		"a\u0378b", // non attribué
		strings.Repeat(" ", 10*OctetsMax),
	} {
		if got, err := Propre(faux); !errors.Is(err, ErrNom) {
			t.Errorf("Propre(%q) = %q, %v ; refus attendu", faux, got, err)
		}
	}
}

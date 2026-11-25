// Package nom : nom ou note que l'exploitant donne, depuis le tableau de bord, à un accès offert
// (paiement) ou à un compte sur mesure (compte), pour des personnes qu'il connaît (décision du
// propriétaire, 25 novembre). Gardé en clair sur le serveur : c'est le seul texte libre des
// bases, écrit par l'exploitant seul, jamais par un visiteur.
package nom

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Max : caractères (points de code) au plus ; OctetsMax : sa taille UTF-8 au plus (4 octets
// par point de code), borne des CHECK des bases.
const (
	Max       = 40
	OctetsMax = 4 * Max
)

// ErrNom : nom invalide (trop long, UTF-8 invalide, caractère de contrôle ou de mise en forme).
var ErrNom = errors.New("nom invalide")

// Propre : s sans espaces au début ni à la fin. "" (vide ou espaces seulement) : aucun nom.
// Seuls les lettres, marques, chiffres, ponctuations, symboles et espaces (catégories Unicode
// L, M, N, P, S, Zs) sont acceptés. Refus (ErrNom) : UTF-8 invalide, plus de Max points de
// code, caractère de contrôle (C0, C1, DEL, tabulation, saut de ligne), de mise en forme (Cf :
// marques de direction comme U+202E, qui retourneraient le texte affiché, caractères sans
// chasse), séparateur de ligne ou de paragraphe, point de code privé ou non attribué.
func Propre(s string) (string, error) {
	if len(s) > 2*OctetsMax || !utf8.ValidString(s) {
		return "", ErrNom
	}
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > Max {
		return "", ErrNom
	}
	for _, r := range s {
		if !unicode.In(r, unicode.L, unicode.M, unicode.N, unicode.P, unicode.S, unicode.Zs) {
			return "", ErrNom
		}
	}
	return s, nil
}

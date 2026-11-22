// Package compte : compte par passkey et clé de récupération, sans e-mail, pour créer un salon
// (conception docs/superpowers/specs/2026-11-22-compte-passkey-design.md, plan
// 2026-11-22-compte-passkey.md). Le serveur ne reçoit jamais la sortie PRF d'une passkey, la
// clé de récupération ni la clé du compte : seulement les clés publiques des passkeys, des
// enveloppes chiffrées par l'appareil et l'empreinte v_r.
package compte

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
)

// Cles : sous-clé de K_serveur, HKDF-SHA-256 à sel vide (conception du compte §5.2, §21.2.2).
// Depuis le 22 novembre, une seule : K_pseudo (« shhdrop/v2/serveur/compte/pseudo », inchangée) ;
// les sous-clés email, mdp, totp et sequestre ont disparu avec l'e-mail (conception du compte par
// passkey §7.4) : perdre K_serveur perd l'unicité des pseudos, plus les comptes.
type Cles struct {
	Pseudo [32]byte // p_empreinte
}

// LireCles lit K_serveur (exactement 32 octets, fichier ordinaire, droits 0400 ou 0600) et en
// tire la sous-clé ; le tampon de K_serveur est effacé. Messages pour l'exploitant : le chemin
// seulement, jamais le contenu.
func LireCles(chemin string) (Cles, error) {
	f, err := os.Open(chemin)
	if err != nil {
		return Cles{}, fmt.Errorf("SHH_COMPTES_CLE_FILE %s illisible", chemin)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return Cles{}, fmt.Errorf("SHH_COMPTES_CLE_FILE %s : fichier ordinaire attendu", chemin)
	}
	if st.Mode().Perm()&^0o600 != 0 {
		return Cles{}, fmt.Errorf("SHH_COMPTES_CLE_FILE %s : droits %o, attendu 0400 ou 0600 (chmod 0400)", chemin, st.Mode().Perm())
	}
	k := make([]byte, 33)
	defer clear(k)
	n, err := io.ReadFull(f, k)
	if n != 32 || !errors.Is(err, io.ErrUnexpectedEOF) {
		return Cles{}, fmt.Errorf("SHH_COMPTES_CLE_FILE %s : exactement 32 octets attendus "+
			"(head -c 32 /dev/urandom > fichier)", chemin)
	}
	k = k[:32]
	if [32]byte(k) == [32]byte{} {
		return Cles{}, fmt.Errorf("SHH_COMPTES_CLE_FILE %s : clé nulle (32 zéros), à tirer au hasard", chemin)
	}
	var c Cles
	d, err := hkdf.Key(sha256.New, k, nil, "shhdrop/v2/serveur/compte/pseudo", 32)
	if err != nil {
		return Cles{}, err
	}
	copy(c.Pseudo[:], d)
	clear(d)
	return c, nil
}

// empreinte : HMAC-SHA-256(cle, etiquette ‖ 0x00 ‖ v).
func empreinte(cle []byte, etiquette string, v []byte) [32]byte {
	m := hmac.New(sha256.New, cle)
	m.Write([]byte(etiquette))
	m.Write([]byte{0})
	m.Write(v)
	return [32]byte(m.Sum(nil))
}

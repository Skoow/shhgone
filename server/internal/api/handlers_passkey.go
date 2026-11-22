package api

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/skoow/shhdrop/server/internal/compte"
)

// Routes du compte par passkey (conception du compte par passkey §6.4). Les objets WebAuthn
// suivent les formats JSON de WebAuthn niveau 3 : `options` est un
// PublicKeyCredentialCreationOptionsJSON (ou RequestOptionsJSON), `credential` un
// RegistrationResponseJSON (ou AuthenticationResponseJSON) sans aucun `null` et sans sortie PRF
// (prf.results retiré par le site ; présent : 400). user.name et user.displayName des options
// sont vides : le site y met le pseudo avant l'appel au navigateur.

// objetJSON : un objet JSON (credential), sinon errBadRequest.
func objetJSON(m json.RawMessage) ([]byte, error) {
	m = bytes.TrimSpace(m)
	if len(m) < 2 || m[0] != '{' {
		return nil, errBadRequest
	}
	return m, nil
}

// enveloppe : "" (aucune) ou 60 octets en base64url.
func enveloppe(s *string) ([]byte, error) {
	if s == nil {
		return nil, errBadRequest
	}
	if *s == "" {
		return nil, nil
	}
	return secret(*s, compte.EnveloppeLen)
}

// etiquetteOpt : "" (aucune) ou 64 octets en base64url.
func etiquetteOpt(s *string) ([]byte, error) {
	if s == nil {
		return nil, errBadRequest
	}
	if *s == "" {
		return nil, nil
	}
	return secret(*s, 64)
}

func ecrireEtapeOptions(w http.ResponseWriter, e [32]byte, opts json.RawMessage) {
	writeJSON(w, http.StatusOK, struct {
		Etape   string          `json:"etape"`
		Options json.RawMessage `json:"options"`
	}{b64.EncodeToString(e[:]), opts})
}

// inscriptionDebut : { altcha, hp, shown_at } → { etape, options } (user.id = h, 16 octets).
func (a compteAPI) inscriptionDebut(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Altcha  string `json:"altcha"`
		HP      string `json:"hp"`
		ShownAt string `json:"shown_at"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	ip := ipOf(r)
	if err := a.antiRobot(b.Altcha, b.ShownAt, b.HP, ip); err != nil {
		failCompte(w, err)
		return
	}
	e, opts, err := a.c.InscriptionDebut(ip)
	if err != nil {
		failCompte(w, err)
		return
	}
	ecrireEtapeOptions(w, e, opts)
}

// inscriptionFin : { etape, credential, p_canon, env, v_r, env_r, blob_profil, blob_prive,
// persistante, etiquette, cred_etiquette } → 201 { session, h }. env, etiquette, cred_etiquette :
// "" pour « aucune ». Réussie, la difficulté de la preuve anti-robot de cette connexion double
// pour l'heure qui suit (captcha.RecordCreate, comme une création de partage ou de salon).
func (a compteAPI) inscriptionFin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Etape         string          `json:"etape"`
		Credential    json.RawMessage `json:"credential"`
		PCanon        string          `json:"p_canon"`
		Env           *string         `json:"env"`
		VR            string          `json:"v_r"`
		EnvR          string          `json:"env_r"`
		BlobProfil    string          `json:"blob_profil"`
		BlobPrive     string          `json:"blob_prive"`
		Persistante   *bool           `json:"persistante"`
		Etiquette     *string         `json:"etiquette"`
		CredEtiquette *string         `json:"cred_etiquette"`
	}
	if err := a.lireGros(w, r, &b, maxInscriptionJSON); err != nil {
		failCompte(w, err)
		return
	}
	var errs [9]error
	var e, vr [32]byte
	var nc compte.NouveauCompte
	var f compte.FinInscription
	var envR []byte
	e, errs[0] = b32(b.Etape)
	f.Credential, errs[1] = objetJSON(b.Credential)
	f.Env, errs[2] = enveloppe(b.Env)
	vr, errs[3] = b32(b.VR)
	envR, errs[4] = secret(b.EnvR, compte.EnveloppeLen)
	nc.BlobProfil, errs[5] = b64.DecodeString(b.BlobProfil)
	nc.BlobPrive, errs[6] = b64.DecodeString(b.BlobPrive)
	o, err := options(b.Persistante, b.Etiquette)
	errs[7] = err
	f.CredEtiquette, errs[8] = etiquetteOpt(b.CredEtiquette)
	if errs != [9]error{} || b.PCanon == "" {
		failCompte(w, errBadRequest)
		return
	}
	nc.PCanon, nc.VR, nc.EnvR = []byte(b.PCanon), vr, [60]byte(envR)
	ip := ipOf(r)
	tok, h, err := a.c.InscriptionFin(ip, e, nc, f, o)
	if err != nil {
		failCompte(w, err)
		return
	}
	a.cap.RecordCreate(ip)
	writeJSON(w, http.StatusCreated, struct {
		Session string `json:"session"`
		H       string `json:"h"`
	}{b64.EncodeToString(tok[:]), b64.EncodeToString(h[:])})
}

// connexionDebut : {} → { etape, options } (connexion découvrable).
func (a compteAPI) connexionDebut(w http.ResponseWriter, r *http.Request) {
	var b struct{}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	e, opts, err := a.c.ConnexionDebut(ipOf(r))
	if err != nil {
		failCompte(w, err)
		return
	}
	ecrireEtapeOptions(w, e, opts)
}

// connexionFin : { etape, credential, persistante, etiquette } → { session, h, cred_id, env,
// blob_profil, gen_profil, blob_prive, gen_prive } ; env : null si la passkey n'a pas
// d'enveloppe PRF (l'appareil ouvre alors K_compte autrement, conception §5.5).
func (a compteAPI) connexionFin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Etape       string          `json:"etape"`
		Credential  json.RawMessage `json:"credential"`
		Persistante *bool           `json:"persistante"`
		Etiquette   *string         `json:"etiquette"`
	}
	if err := lire(w, r, &b, maxJSON); err != nil {
		failCompte(w, err)
		return
	}
	e, err1 := b32(b.Etape)
	cr, err2 := objetJSON(b.Credential)
	o, err3 := options(b.Persistante, b.Etiquette)
	if err1 != nil || err2 != nil || err3 != nil {
		failCompte(w, errBadRequest)
		return
	}
	ov, err := a.c.ConnexionFin(ipOf(r), e, cr, o)
	if err != nil {
		failCompte(w, err)
		return
	}
	var env *string
	if ov.Env != nil {
		s := b64.EncodeToString(ov.Env)
		env = &s
	}
	writeJSON(w, http.StatusOK, struct {
		Session    string  `json:"session"`
		H          string  `json:"h"`
		CredID     string  `json:"cred_id"`
		Env        *string `json:"env"`
		BlobProfil string  `json:"blob_profil"`
		GenProfil  uint64  `json:"gen_profil"`
		BlobPrive  string  `json:"blob_prive"`
		GenPrive   uint64  `json:"gen_prive"`
	}{b64.EncodeToString(ov.Jeton[:]), b64.EncodeToString(ov.H[:]), b64.EncodeToString(ov.CredID), env,
		b64.EncodeToString(ov.BlobProfil), ov.GenProfil, b64.EncodeToString(ov.BlobPrive), ov.GenPrive})
}

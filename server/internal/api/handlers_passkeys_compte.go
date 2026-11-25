package api

import (
	"encoding/json"
	"net/http"

	"github.com/skoow/shhdrop/server/internal/compte"
)

// Passkeys du compte, réauthentification, nouvelle clé de récupération (conception du compte par
// passkey §6.4). Toutes par une session (X-Shh-Session, lue par compteAPI.session).

func (a compteAPI) sessionEtCorps(w http.ResponseWriter, r *http.Request, v any) (compte.Courante, bool) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return c, false
	}
	if err := lire(w, r, v, maxJSON); err != nil {
		failCompte(w, err)
		return c, false
	}
	return c, true
}

// reauthDebut : {} → { etape, options } (passkeys du compte nommées).
func (a compteAPI) reauthDebut(w http.ResponseWriter, r *http.Request) {
	var b struct{}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	e, opts, err := a.c.ReauthDebut(ipOf(r), c)
	if err != nil {
		failCompte(w, err)
		return
	}
	ecrireEtapeOptions(w, e, opts)
}

// reauthFin : { etape, credential } → { enveloppes } (session récente 5 min, liée à la passkey
// qui a signé ; enveloppes : les siennes, comme connexion/fin).
func (a compteAPI) reauthFin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Etape      string          `json:"etape"`
		Credential json.RawMessage `json:"credential"`
	}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	e, err1 := b32(b.Etape)
	cr, err2 := objetJSON(b.Credential)
	if err1 != nil || err2 != nil {
		failCompte(w, errBadRequest)
		return
	}
	es, err := a.c.ReauthFin(ipOf(r), c, e, cr)
	if err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Enveloppes []string `json:"enveloppes"`
	}{enveloppesJSON(es)})
}

// passkeys : GET → { passkeys: [{ cred_id, ajoutee, etiquette, be, prf }] } (etiquette : "" si
// aucune ; ordre d'ajout).
func (a compteAPI) passkeys(w http.ResponseWriter, r *http.Request) {
	c, err := a.session(r)
	if err != nil {
		failCompte(w, err)
		return
	}
	vs, err := a.c.Passkeys(c)
	if err != nil {
		failCompte(w, err)
		return
	}
	type ligne struct {
		CredID    string `json:"cred_id"`
		Ajoutee   string `json:"ajoutee"`
		Etiquette string `json:"etiquette"`
		BE        bool   `json:"be"`
		PRF       bool   `json:"prf"`
	}
	out := make([]ligne, 0, len(vs))
	for _, v := range vs {
		out = append(out, ligne{b64.EncodeToString(v.CredID), v.Ajoutee, b64.EncodeToString(v.Etiquette), v.BE, v.PRF})
	}
	writeJSON(w, http.StatusOK, struct {
		Passkeys []ligne `json:"passkeys"`
	}{out})
}

// passkeysDebut : {} → { etape, options } (session récente).
func (a compteAPI) passkeysDebut(w http.ResponseWriter, r *http.Request) {
	var b struct{}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	e, opts, err := a.c.PasskeysDebut(c)
	if err != nil {
		failCompte(w, err)
		return
	}
	ecrireEtapeOptions(w, e, opts)
}

// passkeysFin : { etape, credential, env, etiquette } → {} (env, etiquette : "" pour aucune).
func (a compteAPI) passkeysFin(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Etape      string          `json:"etape"`
		Credential json.RawMessage `json:"credential"`
		Env        *string         `json:"env"`
		Etiquette  *string         `json:"etiquette"`
	}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	e, err1 := b32(b.Etape)
	cr, err2 := objetJSON(b.Credential)
	env, err3 := enveloppe(b.Env)
	et, err4 := etiquetteOpt(b.Etiquette)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		failCompte(w, errBadRequest)
		return
	}
	if err := a.c.PasskeysFin(c, e, cr, env, et); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

// credID : identifiant de passkey (1 à 1 023 octets, base64url sans bourrage, forme canonique).
func credID(s string) ([]byte, error) {
	b, err := b64.Strict().DecodeString(s)
	if err != nil || len(b) < 1 || len(b) > compte.CredIDMax || b64.EncodeToString(b) != s {
		return nil, errBadRequest
	}
	return b, nil
}

// passkeysEnveloppe : { env } → {} : une enveloppe de plus pour la passkey liée à la session
// (celle de la dernière assertion : connexion/fin ou reauth/fin ; jamais un cred_id du corps) ;
// 409 enveloppes_max à la cinquième ; 403 sans_passkey pour une session ouverte par la clé de
// récupération (reauth d'abord) ; la même enveloppe deux fois : 200.
func (a compteAPI) passkeysEnveloppe(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Env string `json:"env"`
	}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	env, err := secret(b.Env, compte.EnveloppeLen)
	if err != nil {
		failCompte(w, errBadRequest)
		return
	}
	if err := a.c.PasskeysEnveloppe(c, env); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

// passkeysNommer : { cred_id, etiquette } → {} (etiquette : 64 octets chiffrés par l'appareil).
func (a compteAPI) passkeysNommer(w http.ResponseWriter, r *http.Request) {
	var b struct {
		CredID    string `json:"cred_id"`
		Etiquette string `json:"etiquette"`
	}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	id, err1 := credID(b.CredID)
	et, err2 := secret(b.Etiquette, 64)
	if err1 != nil || err2 != nil {
		failCompte(w, errBadRequest)
		return
	}
	if err := a.c.PasskeysNommer(c, id, et); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

// passkeysRetirer : { cred_id } → {} ; la dernière : 409 derniere (session récente).
func (a compteAPI) passkeysRetirer(w http.ResponseWriter, r *http.Request) {
	var b struct {
		CredID string `json:"cred_id"`
	}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	id, err := credID(b.CredID)
	if err == nil {
		err = a.c.PasskeysRetirer(c, id)
	}
	if err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

// recupRenouveler : { v_r, env_r } → {} (session récente ; l'ancienne clé ne sert plus).
func (a compteAPI) recupRenouveler(w http.ResponseWriter, r *http.Request) {
	var b struct {
		VR   string `json:"v_r"`
		EnvR string `json:"env_r"`
	}
	c, ok := a.sessionEtCorps(w, r, &b)
	if !ok {
		return
	}
	vr, err1 := b32(b.VR)
	envR, err2 := secret(b.EnvR, compte.EnveloppeLen)
	if err1 != nil || err2 != nil {
		failCompte(w, errBadRequest)
		return
	}
	if err := a.c.RecupRenouveler(c, vr, [60]byte(envR)); err != nil {
		failCompte(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct{}{})
}

package compte

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	"github.com/go-webauthn/webauthn/protocol/webauthncose"
	"github.com/go-webauthn/webauthn/webauthn"
)

// Cérémonies WebAuthn (conception du compte par passkey §6.1, §6.2 ; dépendances épinglées :
// docs/conception/revues/2026-11-22-revue-go-webauthn.md §5). Configuration
// figée, construite une fois depuis SHH_ORIGIN : rp.id = hôte de l'origine, origines acceptées =
// SHH_ORIGIN et les origines Android exactes de SHH_WEBAUTHN_ORIGINES_APPS, rien d'autre ;
// attestation « none » exigée (le code d'attestation de la bibliothèque ne voit jamais une donnée
// reçue) ; algorithmes −7, −8, −257 ; aucun fournisseur de métadonnées (aucune sortie réseau) ;
// UV exigé ; compteur de signatures ni lu ni gardé (remis à 0 avant chaque vérification) ; BE
// gardé, BS ignoré. Le serveur ne reçoit jamais de sortie PRF : une réponse qui en contient est
// refusée (le site doit retirer prf.results de clientExtensionResults avant l'envoi).

// EntreePRF : E_prf = SHA-256(« shhdrop/v3/compte/prf/1 »), envoyée dans prf.eval.first
// (constants.entree_prf de engine/vectors/compte-v3.json).
var EntreePRF = sha256.Sum256([]byte("shhdrop/v3/compte/prf/1"))

var b64 = base64.RawURLEncoding

// RPNom : rp.name des cérémonies (conception §6.2).
const RPNom = "Shhgone"

// algorithmes : ES256, EdDSA, RS256 (dans cet ordre de préférence).
var algorithmes = []protocol.CredentialParameter{
	{Type: protocol.PublicKeyCredentialType, Algorithm: webauthncose.AlgES256},
	{Type: protocol.PublicKeyCredentialType, Algorithm: webauthncose.AlgEdDSA},
	{Type: protocol.PublicKeyCredentialType, Algorithm: webauthncose.AlgRS256},
}

// Ceremonies : la configuration WebAuthn figée du serveur.
type Ceremonies struct {
	w    *webauthn.WebAuthn
	rpID string
}

// prefixeAndroid : forme exacte d'une origine d'app Android (empreinte SHA-256 du certificat de
// signature en base64url sans bourrage : 43 caractères).
const prefixeAndroid = "android:apk-key-hash:"

func origineAndroidOK(o string) bool {
	h, ok := strings.CutPrefix(o, prefixeAndroid)
	if !ok || len(h) != 43 {
		return false
	}
	b, err := b64.DecodeString(h)
	return err == nil && len(b) == 32 && b64.EncodeToString(b) == h
}

// rpIDDe : hôte de l'origine (déjà vérifiée par config : schéma, hôte en minuscules, port par
// défaut omis) ; une adresse IP, un http hors de localhost ou un chemin sont refusés.
func rpIDDe(origine string) (string, error) {
	u, err := url.Parse(origine)
	if err != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil ||
		u.String() != origine {
		return "", fmt.Errorf("compte : origine %q invalide pour WebAuthn", origine)
	}
	h := u.Hostname()
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && h == "localhost":
	default:
		return "", fmt.Errorf("compte : origine %q : https exigé (http seulement pour localhost)", origine)
	}
	if err := protocol.ValidateRPID(h); err != nil || strings.Trim(h, "0123456789.") == "" || strings.Contains(h, ":") {
		return "", fmt.Errorf("compte : hôte %q invalide comme rp.id (une adresse IP ne peut pas l'être)", h)
	}
	return h, nil
}

// NouvellesCeremonies : configuration figée depuis SHH_ORIGIN et les origines d'apps Android
// (chacune exactement android:apk-key-hash:<43 caractères base64url>). Toute autre forme fait
// échouer le démarrage.
func NouvellesCeremonies(origine string, originesApps []string) (*Ceremonies, error) {
	rpID, err := rpIDDe(origine)
	if err != nil {
		return nil, err
	}
	for _, o := range originesApps {
		if !origineAndroidOK(o) {
			return nil, fmt.Errorf("compte : origine d'app %q invalide (android:apk-key-hash:<43 caractères base64url>)", o)
		}
	}
	vrai := true
	cfg := &webauthn.Config{
		RPID:                  rpID,
		RPDisplayName:         RPNom,
		RPOrigins:             []string{origine},
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			RequireResidentKey: &vrai,
			ResidentKey:        protocol.ResidentKeyRequirementRequired,
			UserVerification:   protocol.VerificationRequired,
		},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Timeout: dureeEtape, TimeoutUVD: dureeEtape},
			Registration: webauthn.TimeoutConfig{Timeout: dureeEtape, TimeoutUVD: dureeEtape},
		},
	}
	if len(originesApps) > 0 {
		cfg.RPOpaqueOrigins = append([]string(nil), originesApps...)
	}
	w, err := webauthn.New(cfg)
	if err != nil {
		return nil, fmt.Errorf("compte : configuration WebAuthn : %w", err)
	}
	if w.Config.MDS != nil {
		return nil, errors.New("compte : aucun fournisseur de métadonnées FIDO permis (aucune sortie réseau)")
	}
	return &Ceremonies{w: w, rpID: rpID}, nil
}

// RPID : l'identifiant des passkeys (hôte de SHH_ORIGIN).
func (c *Ceremonies) RPID() string { return c.rpID }

// defi : ce que la bibliothèque doit retrouver à la fin d'une cérémonie (défi, rp.id,
// vérification exigée, passkeys permises, algorithmes, extensions demandées). Jamais écrit.
type defi = webauthn.SessionData

// utilisateur : le compte vu par la bibliothèque. Name et DisplayName vides : le site y met le
// pseudo avant l'appel au navigateur (conception §6.2) ; le serveur ne le voit jamais.
type utilisateur struct {
	h  []byte
	pk []webauthn.Credential
}

func (u utilisateur) WebAuthnID() []byte                         { return u.h }
func (u utilisateur) WebAuthnName() string                       { return "" }
func (u utilisateur) WebAuthnDisplayName() string                { return "" }
func (u utilisateur) WebAuthnCredentials() []webauthn.Credential { return u.pk }

// credentialDe : la passkey stockée telle que la bibliothèque la lit (compteur à 0 : ni lu ni
// gardé ; attestation « none »).
func credentialDe(p Passkey) webauthn.Credential {
	return webauthn.Credential{ID: p.CredID, PublicKey: p.ClePub, AttestationType: "none", AttestationFormat: "none",
		Flags:         webauthn.CredentialFlags{UserPresent: true, UserVerified: true, BackupEligible: p.BE},
		Authenticator: webauthn.Authenticator{SignCount: p.SignCount}}
}

func descripteurs(ps []Passkey) []protocol.CredentialDescriptor {
	out := make([]protocol.CredentialDescriptor, 0, len(ps))
	for _, p := range ps {
		out = append(out, protocol.CredentialDescriptor{Type: protocol.PublicKeyCredentialType, CredentialID: p.CredID})
	}
	return out
}

func extensionPRF() webauthn.ExtensionOption {
	return webauthn.WithExtensionPRF(protocol.PRFValues{First: EntreePRF[:]})
}

// debutCreation : options de navigator.credentials.create (PublicKeyCredentialCreationOptionsJSON)
// pour le compte h ; exclure : passkeys déjà enregistrées (ajout).
func (c *Ceremonies) debutCreation(h [16]byte, exclure []Passkey) (json.RawMessage, *defi, error) {
	opts := []webauthn.RegistrationOption{
		webauthn.WithCredentialParameters(algorithmes),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
		webauthn.WithExtensions(extensionPRF(), webauthn.WithExtensionCredProps()),
	}
	if len(exclure) > 0 {
		opts = append(opts, webauthn.WithExclusions(descripteurs(exclure)))
	}
	cr, sd, err := c.w.BeginRegistration(utilisateur{h: h[:]}, opts...)
	if err != nil {
		return nil, nil, err
	}
	b, err := json.Marshal(cr.Response)
	return b, sd, err
}

// debutAssertion : options de navigator.credentials.get (PublicKeyCredentialRequestOptionsJSON) ;
// permises vide : connexion découvrable (aucune passkey nommée).
func (c *Ceremonies) debutAssertion(h []byte, permises []Passkey) (json.RawMessage, *defi, error) {
	opts := []webauthn.LoginOption{
		webauthn.WithUserVerification(protocol.VerificationRequired),
		webauthn.WithAssertionExtensions(extensionPRF()),
	}
	var (
		as  *protocol.CredentialAssertion
		sd  *webauthn.SessionData
		err error
	)
	if len(permises) == 0 {
		as, sd, err = c.w.BeginDiscoverableLogin(opts...)
	} else {
		u := utilisateur{h: h}
		for _, p := range permises {
			u.pk = append(u.pk, credentialDe(p))
		}
		as, sd, err = c.w.BeginLogin(u, opts...)
	}
	if err != nil {
		return nil, nil, err
	}
	b, err := json.Marshal(as.Response)
	return b, sd, err
}

// sansSecret : une réponse qui porte une sortie PRF (ou hmac-secret) est refusée : le serveur ne
// doit jamais la recevoir (conception §1, anti-objectif) ; le site la retire avant l'envoi.
func sansSecret(o protocol.AuthenticationExtensionsClientOutputs) error {
	if (o.PRF != nil && o.PRF.Results != nil) || o.HMACGetSecret != nil {
		return ErrRequete
	}
	return nil
}

// finCreation : réponse de navigator.credentials.create vérifiée pour le compte h ; rend ce que
// le serveur garde (cred_id, clé publique COSE, algorithme, BE). Attestation autre que « none »,
// algorithme hors de −7, −8, −257, passkey non découvrable (credProps.rk faux) : refus.
func (c *Ceremonies) finCreation(h [16]byte, sd *defi, reponse []byte) (Passkey, error) {
	p, err := protocol.ParseCredentialCreationResponseBytes(reponse)
	if err != nil {
		return Passkey{}, ErrRequete
	}
	if err := sansSecret(p.ClientExtensionResults); err != nil {
		return Passkey{}, err
	}
	if p.Response.AttestationObject.Format != string(protocol.AttestationFormatNone) {
		return Passkey{}, ErrRequete
	}
	if cp := p.ClientExtensionResults.CredProps; cp != nil && cp.RK != nil && !*cp.RK {
		return Passkey{}, ErrRequete
	}
	cr, err := c.w.CreateCredential(utilisateur{h: h[:]}, *sd, p)
	if err != nil {
		return Passkey{}, ErrIdentifiants
	}
	var pk webauthncose.PublicKeyData
	if err := webauthncbor.Unmarshal(cr.PublicKey, &pk); err != nil || !algOK(pk.Algorithm) {
		return Passkey{}, ErrRequete
	}
	out := Passkey{CredID: bytes.Clone(cr.ID), ClePub: bytes.Clone(cr.PublicKey), Alg: pk.Algorithm, BE: cr.Flags.BackupEligible,
		SignCount: cr.Authenticator.SignCount}
	if len(out.CredID) < 1 || len(out.CredID) > CredIDMax || len(out.ClePub) > ClePubMax {
		return Passkey{}, ErrRequete
	}
	return out, nil
}

// chercheur : la passkey cred_id et son compte, ou ErrIdentifiants.
type chercheur func(credID []byte) ([16]byte, Passkey, error)

// verifierAssertion : réponse de navigator.credentials.get vérifiée. h nul : connexion découvrable
// (le userHandle doit être le h de la passkey) ; sinon le compte h (reauth : passkey de ce
// compte). Rend le compte, le cred_id et le compteur de signatures reçu, à garder
// (Service.noterCompteur). Compteur qui ne progresse pas alors que la passkey en tient un (gardé
// ou reçu non nul : clone possible, WebAuthn §6.1.1) : refus. Passkey synchronisée (compteur
// toujours 0) : jamais refusée pour cela. Toute erreur de vérification : ErrIdentifiants (même
// réponse, conception §6.4).
func (c *Ceremonies) verifierAssertion(sd *defi, reponse []byte, cherche chercheur, h *[16]byte, permises []Passkey) ([16]byte, []byte, uint32, error) {
	p, err := protocol.ParseCredentialRequestResponseBytes(reponse)
	if err != nil {
		return [16]byte{}, nil, 0, ErrRequete
	}
	if err := sansSecret(p.ClientExtensionResults); err != nil {
		return [16]byte{}, nil, 0, err
	}
	var trouve [16]byte
	var cr *webauthn.Credential
	if h == nil {
		cr, err = c.w.ValidateDiscoverableLogin(func(rawID, userHandle []byte) (webauthn.User, error) {
			hh, pk, err := cherche(rawID)
			if err != nil || !bytes.Equal(userHandle, hh[:]) {
				return nil, ErrIdentifiants
			}
			trouve = hh
			return utilisateur{h: hh[:], pk: []webauthn.Credential{credentialDe(pk)}}, nil
		}, *sd, p)
	} else {
		u := utilisateur{h: h[:]}
		for _, pk := range permises {
			u.pk = append(u.pk, credentialDe(pk))
		}
		trouve = *h
		cr, err = c.w.ValidateLogin(u, *sd, p)
	}
	// UpdateCounter (go-webauthn) : CloneWarning si le compteur reçu n'est pas supérieur au
	// compteur gardé, sauf s'ils valent 0 tous les deux.
	if err != nil || cr == nil || cr.Authenticator.CloneWarning {
		return [16]byte{}, nil, 0, ErrIdentifiants
	}
	return trouve, bytes.Clone(p.RawID), cr.Authenticator.SignCount, nil
}

package limits

import (
	"net/netip"
	"strconv"
)

// Limites du compte (conception du compte §8.8, §21.5, §21.11 ; conception du compte par passkey
// §7.2). Mêmes règles que les quotas des partages : mémoire seulement, clés HMAC-SHA-256 sous le
// secret du jour (une adresse IP ou un h n'y est jamais en clair, et la même valeur change de clé
// chaque jour), compteurs du jour vidés à minuit UTC, de l'heure à l'heure UTC, de la minute à la
// minute (fenêtres fixes). Un refus n'est compté nulle part. Plus aucune limite d'e-mail ni de
// TOTP.
const (
	// Comptes créés (inscription/fin) par jour.
	InscriptionsPer64 = 3
	InscriptionsPer48 = 10
	// InscriptionsDebutParHeure : inscription/debut par heure et par connexion (§7.2).
	InscriptionsDebutParHeure = 20
	// ConnexionsDebutParMinute : connexion/debut (défi sans preuve) par minute et par connexion.
	ConnexionsDebutParMinute = 60
	// Échecs de connexion par passkey par heure, par connexion et par /48 (puis 429).
	EchecsConnexionPer64 = 20
	EchecsConnexionPer48 = 60
	// Essais de la clé de récupération par heure, par connexion et par /48 (128 bits : la limite
	// protège la machine, pas la clé).
	RecupPer64 = 10
	RecupPer48 = 30
	// AjoutsPasskeyParHeure : passkeys/debut par heure et par compte.
	AjoutsPasskeyParHeure = 10
	// EcrituresCoffreParHeure : écritures des deux coffres ensemble, par heure et par compte.
	EcrituresCoffreParHeure = 60
	// PseudoVerifierParHeure : vérifications de pseudo par heure, par étape ou par compte.
	PseudoVerifierParHeure = 30
	// AppelsParHeure : demandes d'identifiants du relais des appels, par heure et par membre.
	AppelsParHeure = 20
	// BannissementsParHeure : garde-fou global contre un jeton d'administration volé (§21.11).
	BannissementsParHeure = 20
)

// cleLocked : clé pseudonymisée du jour d'un identifiant de compte (h ou étape), séparée par
// sorte et par longueur.
func (l *Limiter) cleLocked(sorte string, id []byte) string {
	return mac(l.secret, sorte+"|"+strconv.Itoa(len(id))+"|"+string(id))
}

// allowUnLocked : un de plus sous k si m[k] < max.
func allowUnLocked(m map[string]int, k string, max int) bool {
	if m[k] >= max {
		return false
	}
	m[k]++
	return true
}

// AllowInscriptionDebut : inscription/debut, 20 par heure par connexion, comptée à l'appel.
func (l *Limiter) AllowInscriptionDebut(ip netip.Addr) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	k64, _ := l.keyLocked(ip)
	return allowUnLocked(l.inscD64, k64, InscriptionsDebutParHeure)
}

// ComptesCreesDuJour : comptes créés aujourd'hui par la connexion ip (difficulté de la preuve de
// travail de l'inscription, doublée par compte, conception §7.2). Ne compte rien.
func (l *Limiter) ComptesCreesDuJour(ip netip.Addr) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	k64, _ := l.keyLocked(ip)
	return l.insc64[k64]
}

// PeutCreerCompte : la connexion ip (et son /48) a encore droit à un compte aujourd'hui (3 par
// connexion, 10 par /48). Ne compte rien : NoterCompte compte un compte créé.
func (l *Limiter) PeutCreerCompte(ip netip.Addr) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	k64, k48 := l.keyLocked(ip)
	return l.insc64[k64] < InscriptionsPer64 && l.insc48[k48] < InscriptionsPer48
}

// NoterCompte : un compte créé depuis ip.
func (l *Limiter) NoterCompte(ip netip.Addr) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	k64, k48 := l.keyLocked(ip)
	l.insc64[k64]++
	l.insc48[k48]++
}

// AllowConnexionDebut : connexion/debut, 60 par minute par connexion, comptée à l'appel.
func (l *Limiter) AllowConnexionDebut(ip netip.Addr) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	k64, _ := l.keyLocked(ip)
	return allowUnLocked(l.cnx64, k64, ConnexionsDebutParMinute)
}

// AllowEchecConnexion : la connexion ip (et son /48) n'a pas encore 20 (60) échecs de
// connexion dans l'heure. Ne compte rien : NoterEchecConnexion compte les échecs.
func (l *Limiter) AllowEchecConnexion(ip netip.Addr) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	k64, k48 := l.keyLocked(ip)
	return l.echec64[k64] < EchecsConnexionPer64 && l.echec48[k48] < EchecsConnexionPer48
}

// NoterEchecConnexion : un échec de connexion (ou de réauthentification) par passkey depuis ip.
func (l *Limiter) NoterEchecConnexion(ip netip.Addr) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	k64, k48 := l.keyLocked(ip)
	l.echec64[k64]++
	l.echec48[k48]++
}

// AllowRecup : un essai de clé de récupération depuis ip (10 par heure par connexion, 30 par
// /48), compté à l'appel, juste ou faux.
func (l *Limiter) AllowRecup(ip netip.Addr) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	return l.allowPairLocked(ip, l.recup64, l.recup48, RecupPer64, RecupPer48)
}

// AllowAjoutPasskey : passkeys/debut pour le compte h, 10 par heure, compté à l'appel. Même
// table que les écritures des coffres : les clés sont séparées par sorte (cleLocked).
func (l *Limiter) AllowAjoutPasskey(h [16]byte) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	return allowUnLocked(l.coffreCpt, l.cleLocked("passkey", h[:]), AjoutsPasskeyParHeure)
}

// AllowEcritureCoffre : une écriture d'un des deux coffres du compte h (60 par heure pour les
// deux ensemble), comptée à l'appel.
func (l *Limiter) AllowEcritureCoffre(h [16]byte) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	return allowUnLocked(l.coffreCpt, l.cleLocked("coffre", h[:]), EcrituresCoffreParHeure)
}

// AllowPseudoVerifier : une vérification de pseudo pour id (h du compte, 16 octets, ou
// empreinte de l'étape d'inscription, 32 octets), 30 par heure, comptée à l'appel.
func (l *Limiter) AllowPseudoVerifier(id []byte) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	return allowUnLocked(l.pseudoCpt, l.cleLocked("pseudo", id), PseudoVerifierParHeure)
}

// AllowAppel : une demande d'identifiants du relais des appels pour le membre id (empreinte de
// son jeton), 20 par heure, comptée à l'appel. Même table que les vérifications de pseudo : les
// clés sont séparées par sorte (cleLocked).
func (l *Limiter) AllowAppel(id []byte) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	return allowUnLocked(l.pseudoCpt, l.cleLocked("appel", id), AppelsParHeure)
}

// AllowBannir : un bannissement, 20 par heure au plus pour tout le serveur, compté à l'appel.
func (l *Limiter) AllowBannir() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotateLocked(l.now())
	if l.bannirHeure >= BannissementsParHeure {
		return false
	}
	l.bannirHeure++
	return true
}

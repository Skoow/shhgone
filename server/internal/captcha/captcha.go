// Package captcha fournit l'anti-robot ALTCHA adaptatif (spec §22).
//
// Format compatible avec le widget ALTCHA : défi = hex(SHA-256(sel ‖ nombre)),
// signature = hex(HMAC-SHA-256(clé, défi)). Le sel a un format fixe :
//
//	<24 hex aléatoires>.<16 hex liés à la connexion>.<niveau 0–6>?expires=<10 chiffres>
//
// Le format fixe empêche de déplacer des chiffres entre le nombre et le sel (la chaîne
// hachée étant la même). Le niveau est la difficulté au moment de l'émission : un défi
// dont le niveau est inférieur au niveau actuel de la connexion est refusé, pour que la
// difficulté ne puisse pas être contournée en stockant des défis faciles à l'avance.
// Tout est en mémoire ; rien n'est lié à une adresse IP en clair. La clé de liaison est tirée
// au hasard et remplacée à minuit UTC, comme les clés du limiteur ; celle de la veille sert
// encore une heure (défis en vol, difficulté de la dernière heure), puis elle est effacée.
package captcha

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"regexp"
	"strconv"
	"sync"
	"time"

	altcha "github.com/altcha-org/altcha-lib-go"

	"github.com/skoow/shhdrop/server/internal/limits"
)

// Difficulté (décision du 26 novembre, §22 D4) : toujours exigée, niveau 0 « invisible »
// (20 000 au plus, 10 000 condensés en moyenne : environ 0,4 s sur un téléphone moyen, mesuré
// au navigateur ralenti 4 fois), puis doublée à chaque création de la connexion dans l'heure,
// jusqu'au niveau 6 (1 280 000 au plus : le plafond d'avant, environ 30 s en moyenne).
const (
	baseMax    = 20000
	maxLevel   = 6
	ttl        = 2 * time.Minute
	minFill    = 3 * time.Second
	window     = time.Hour
	maxPayload = 2048
	sweepEvery = time.Minute
)

// ErrInvalid : refus unique, quelle que soit la vérification qui a échoué.
var ErrInvalid = errors.New("anti-robot invalide")

// Le « & » final est le délimiteur ajouté par altcha-lib-go ≥ 1.0.0 contre le
// raboutage du sel et du nombre (GO-2025-4239) ; le format strict ci-dessous le bloquait déjà.
var saltRe = regexp.MustCompile(`^[0-9a-f]{24}\.([0-9a-f]{16})\.([0-6])\?expires=([0-9]{10})&$`)

type Captcha struct {
	sigKey []byte
	now    func() time.Time

	mu sync.Mutex
	// bindKey : clé de liaison du jour UTC bindDay (crypto/rand, jamais écrite) ; bindPrev :
	// celle de la veille jusqu'à prevUntil (minuit + window), nil ensuite.
	bindKey, bindPrev []byte
	bindDay           int64
	prevUntil         time.Time

	used      map[string]int64       // sel consommé → expiration (unix)
	creates   map[string][]time.Time // lien de connexion → créations de la dernière heure
	lastSweep time.Time
}

// New prend une clé aléatoire d'au moins 32 octets, générée au démarrage.
func New(hmacKey []byte, now func() time.Time) *Captcha {
	if len(hmacKey) < 32 {
		panic("captcha: clé trop courte")
	}
	return &Captcha{
		sigKey:  derive(hmacKey, "shhdrop altcha signature"),
		now:     now,
		bindKey: randomKey(),
		bindDay: utcDay(now()),
		used:    map[string]int64{},
		creates: map[string][]time.Time{},
	}
}

func randomKey() []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		panic(err) // crypto/rand ne renvoie pas d'erreur sous Linux
	}
	return k
}

// utcDay : jours UTC depuis 1970 (arrondi vers le bas, dates d'avant 1970 comprises).
func utcDay(t time.Time) int64 {
	u := t.Unix()
	d := u / 86400
	if u%86400 < 0 {
		d--
	}
	return d
}

// rotateLocked remplace la clé de liaison à minuit UTC et efface celle de la veille une heure
// plus tard (même règle que le limiteur : nouvelle clé aléatoire, l'ancienne effacée).
func (c *Captcha) rotateLocked(now time.Time) {
	if c.bindPrev != nil && !now.Before(c.prevUntil) {
		clear(c.bindPrev)
		c.bindPrev = nil
	}
	d := utcDay(now)
	if d == c.bindDay {
		return
	}
	clear(c.bindPrev)
	c.bindPrev = nil
	if d == c.bindDay+1 {
		c.bindPrev = c.bindKey
		c.prevUntil = time.Unix(d*86400, 0).Add(window)
	} else {
		clear(c.bindKey)
	}
	c.bindKey = randomKey()
	c.bindDay = d
}

func derive(key []byte, label string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(label))
	return h.Sum(nil)
}

// bindsLocked rend 16 hex liés à la connexion (/64 ou IPv4), sans révéler l'adresse, sous la
// clé du jour (cur) et sous celle de la veille tant qu'elle est gardée (prev, sinon "").
func (c *Captcha) bindsLocked(ip netip.Addr, now time.Time) (cur, prev string) {
	c.rotateLocked(now)
	p64, _ := limits.Prefixes(ip)
	cur = bindWith(c.bindKey, p64)
	if c.bindPrev != nil {
		prev = bindWith(c.bindPrev, p64)
	}
	return cur, prev
}

func bindWith(key []byte, p64 string) string {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(p64))
	return hex.EncodeToString(h.Sum(nil)[:8])
}

// levelLocked : niveau de la connexion, créations de la dernière heure sous les deux clés.
func (c *Captcha) levelLocked(cur, prev string, now time.Time) int {
	l := c.recentLocked(cur, now)
	if prev != "" {
		l = min(l+c.recentLocked(prev, now), maxLevel)
	}
	return l
}

// sweepLocked oublie les sels expirés et les créations de plus d'une heure (au plus une fois par minute).
func (c *Captcha) sweepLocked(now time.Time) {
	if now.Sub(c.lastSweep) < sweepEvery && !now.Before(c.lastSweep) {
		return
	}
	c.lastSweep = now
	for s, exp := range c.used {
		if now.Unix() >= exp {
			delete(c.used, s)
		}
	}
	for b := range c.creates {
		c.recentLocked(b, now)
	}
}

// recentLocked rend le niveau de difficulté (créations de la dernière heure, plafonné).
func (c *Captcha) recentLocked(b string, now time.Time) int {
	ts := c.creates[b]
	i := 0
	for i < len(ts) && now.Sub(ts[i]) >= window {
		i++
	}
	ts = ts[i:]
	if len(ts) == 0 {
		delete(c.creates, b)
	} else {
		c.creates[b] = ts
	}
	return min(len(ts), maxLevel)
}

// Challenge émet un défi lié à la connexion, valable 2 minutes.
func (c *Captcha) Challenge(ip netip.Addr) (altcha.Challenge, error) {
	now := c.now()
	c.mu.Lock()
	b, bp := c.bindsLocked(ip, now)
	c.sweepLocked(now)
	level := c.levelLocked(b, bp, now)
	c.mu.Unlock()

	rnd := make([]byte, 12)
	if _, err := rand.Read(rnd); err != nil {
		return altcha.Challenge{}, err
	}
	exp := now.Add(ttl)
	return altcha.CreateChallenge(altcha.ChallengeOptions{
		Algorithm: altcha.SHA256,
		MaxNumber: int64(baseMax) << level,
		HMACKey:   string(c.sigKey),
		Salt:      hex.EncodeToString(rnd) + "." + b + "." + strconv.Itoa(level),
		Expires:   &exp,
	})
}

// RecordCreate compte une création réussie : la difficulté double pour l'heure qui suit.
func (c *Captcha) RecordCreate(ip netip.Addr) {
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	b, _ := c.bindsLocked(ip, now)
	c.sweepLocked(now)
	// Heure arrondie à la minute supérieure (spec §36 S15) : rien de plus précis n'est gardé,
	// et une création compte toujours au moins une heure.
	at := now.Truncate(time.Minute)
	if at.Before(now) {
		at = at.Add(time.Minute)
	}
	c.creates[b] = append(c.creates[b], at)
}

// Verify accepte une solution une seule fois. shownAt est l'heure d'affichage de la page
// (venue d'un jeton signé). Toute erreur est ErrInvalid.
func (c *Captcha) Verify(payload string, ip netip.Addr, honeypot string, shownAt time.Time) error {
	now := c.now()
	if honeypot != "" || now.Sub(shownAt) < minFill || len(payload) > maxPayload {
		return ErrInvalid
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return ErrInvalid
	}
	var p altcha.Payload
	if json.Unmarshal(raw, &p) != nil || p.Algorithm != string(altcha.SHA256) {
		return ErrInvalid
	}
	m := saltRe.FindStringSubmatch(p.Salt)
	if m == nil {
		return ErrInvalid
	}
	level, _ := strconv.Atoi(m[2])
	exp, _ := strconv.ParseInt(m[3], 10, 64)
	if now.Unix() >= exp || exp > now.Add(ttl).Unix() {
		return ErrInvalid
	}
	c.mu.Lock()
	b, bp := c.bindsLocked(ip, now)
	c.mu.Unlock()
	// Clé du jour, ou de la veille pour un défi émis avant minuit (2 minutes au plus).
	okCur := hmac.Equal([]byte(m[1]), []byte(b))
	okPrev := bp != "" && hmac.Equal([]byte(m[1]), []byte(bp))
	if !okCur && !okPrev {
		return ErrInvalid
	}
	want, err := altcha.CreateChallenge(altcha.ChallengeOptions{
		Algorithm: altcha.SHA256,
		HMACKey:   string(c.sigKey),
		Salt:      p.Salt,
		Number:    &p.Number,
	})
	if err != nil || !hmac.Equal([]byte(want.Challenge), []byte(p.Challenge)) ||
		!hmac.Equal([]byte(want.Signature), []byte(p.Signature)) {
		return ErrInvalid
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	b, bp = c.bindsLocked(ip, now)
	c.sweepLocked(now)
	if level < c.levelLocked(b, bp, now) {
		return ErrInvalid
	}
	if _, dup := c.used[p.Salt]; dup {
		return ErrInvalid
	}
	c.used[p.Salt] = exp
	return nil
}

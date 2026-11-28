// Package maintenance lit l'annonce d'une maintenance programmée (deploy/maintenance.sh,
// décision D42-32 de la spécification) et dit, à chaque instant, ce que le serveur en fait :
// bandeau sur le site (GET /api/etat-service), puis mode « redémarrage imminent » où les
// nouvelles créations sont refusées (503 maintenance), sans toucher à ce qui est en cours.
//
// Fichier : SHH_DATA_DIR/maintenance, écrit par le script (root, compte 65532, 0600, une
// écriture atomique), une seule ligne :
//
//	v1 <annonce> <début> <durée en min> <avance en min>
//
// annonce et début en secondes Unix (UTC). Aucune donnée d'utilisateur : rien que l'horaire
// annoncé publiquement. Absent, illisible ou mal formé : aucune maintenance (échec ouvert,
// voulu : une annonce abîmée ne doit jamais fermer les créations).
//
// États (« seuil » = début − avance, « fin » = début + durée ; le serveur a « redémarré »
// quand ce processus a démarré après le seuil et après l'annonce) :
//   - avant le seuil : annoncée (bandeau) ;
//   - du seuil à la fin, sans redémarrage : imminente (bandeau, créations refusées) ;
//   - redémarré : plus rien (la maintenance a eu lieu) ; le fichier est effacé une fois la
//     fin passée ;
//   - fin passée sans redémarrage : plus rien non plus (jamais de créations fermées sans
//     fin) ; le fichier reste, et deploy/etat.sh le signale (maintenance non faite).
package maintenance

import (
	"bytes"
	"errors"
	"io"
	"os"
	"strconv"
	"sync"
	"time"
)

// Bornes acceptées (les mêmes que deploy/maintenance.sh).
const (
	DureeMax  = 24 * 60 // minutes
	AvanceMax = 120     // minutes
	// relecture : le fichier est relu au plus une fois par période (une requête de création
	// ne lit pas le disque à chaque fois).
	relecture = 15 * time.Second
	tailleMax = 128
)

// Annonce : maintenance annoncée.
type Annonce struct {
	Annonce, Debut time.Time
	Duree, Avance  time.Duration
}

// Fin : heure de retour estimée.
func (a Annonce) Fin() time.Time { return a.Debut.Add(a.Duree) }

// Seuil : début du mode « redémarrage imminent ».
func (a Annonce) Seuil() time.Time { return a.Debut.Add(-a.Avance) }

// Etat : ce que le serveur fait de l'annonce à un instant donné. Annonce nil : rien.
type Etat struct {
	Annonce   *Annonce
	Imminente bool
}

// Suivi : lecture du fichier d'annonce par un processus du serveur.
type Suivi struct {
	chemin    string
	demarrage time.Time
	now       func() time.Time

	mu   sync.Mutex
	lu   time.Time // dernière lecture du fichier (horloge du suivi)
	vue  bool      // lu au moins une fois
	ann  *Annonce
	ecrt []byte // contenu lu (une nouvelle annonce remplace l'ancienne)
}

// Nouveau : suivi du fichier chemin pour un processus démarré maintenant (now : horloge ; nil :
// time.Now). Le fichier est lu tout de suite (fin passée après un redémarrage : effacé).
func Nouveau(chemin string, now func() time.Time) *Suivi {
	if now == nil {
		now = time.Now
	}
	s := &Suivi{chemin: chemin, demarrage: now(), now: now}
	s.Etat()
	return s
}

// Etat : état présent (relu au plus toutes les 15 s). Sans suivi (nil) : rien.
func (s *Suivi) Etat() Etat {
	if s == nil {
		return Etat{}
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.vue || now.Sub(s.lu) >= relecture || now.Before(s.lu) {
		s.lu, s.vue = now, true
		s.ann, s.ecrt = lire(s.chemin)
	}
	a := s.ann
	if a == nil {
		return Etat{}
	}
	redemarre := !s.demarrage.Before(a.Seuil()) && !s.demarrage.Before(a.Annonce)
	fin := a.Fin()
	switch {
	case redemarre && !now.Before(fin):
		// Maintenance faite et durée passée : l'annonce s'efface d'elle-même (seulement si le
		// fichier n'a pas changé depuis la lecture : jamais une annonce plus récente).
		if b, err := lireBorne(s.chemin); err == nil && bytes.Equal(b, s.ecrt) {
			_ = os.Remove(s.chemin)
		}
		s.ann, s.ecrt = nil, nil
		return Etat{}
	case redemarre, !now.Before(fin):
		return Etat{}
	}
	c := *a
	return Etat{Annonce: &c, Imminente: !now.Before(a.Seuil())}
}

// lire : annonce du fichier (nil : absente ou refusée) et son contenu.
func lire(chemin string) (*Annonce, []byte) {
	b, err := lireBorne(chemin)
	if err != nil {
		return nil, nil
	}
	a, ok := Analyser(b)
	if !ok {
		return nil, nil
	}
	return &a, b
}

var errFichier = errors.New("maintenance : fichier refusé")

// lireBorne : contenu d'un fichier ordinaire (pas un lien) d'au plus tailleMax octets.
func lireBorne(chemin string) ([]byte, error) {
	fi, err := os.Lstat(chemin)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > tailleMax {
		return nil, errFichier
	}
	f, err := os.Open(chemin)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, tailleMax+1))
	if err != nil {
		return nil, err
	}
	if len(b) > tailleMax {
		return nil, errFichier
	}
	return b, nil
}

// Analyser : ligne « v1 <annonce> <début> <durée> <avance>\n », entiers décimaux sans signe
// ni zéro de tête ; durée de 1 à DureeMax min, avance de 1 à AvanceMax min, annonce ≤ début.
func Analyser(b []byte) (Annonce, bool) {
	if len(b) == 0 || b[len(b)-1] != '\n' {
		return Annonce{}, false
	}
	champs := bytes.Split(b[:len(b)-1], []byte{' '})
	if len(champs) != 5 || string(champs[0]) != "v1" {
		return Annonce{}, false
	}
	var v [4]int64
	for i, c := range champs[1:] {
		n, ok := entier(c)
		if !ok {
			return Annonce{}, false
		}
		v[i] = n
	}
	if v[0] <= 0 || v[1] < v[0] || v[2] < 1 || v[2] > DureeMax || v[3] < 1 || v[3] > AvanceMax {
		return Annonce{}, false
	}
	return Annonce{Annonce: time.Unix(v[0], 0), Debut: time.Unix(v[1], 0),
		Duree: time.Duration(v[2]) * time.Minute, Avance: time.Duration(v[3]) * time.Minute}, true
}

func entier(c []byte) (int64, bool) {
	if len(c) == 0 || len(c) > 12 || (len(c) > 1 && c[0] == '0') {
		return 0, false
	}
	for _, x := range c {
		if x < '0' || x > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseInt(string(c), 10, 64)
	return n, err == nil
}

package main

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/skoow/shhdrop/server/internal/adminui"
	"github.com/skoow/shhdrop/server/internal/api"
	"github.com/skoow/shhdrop/server/internal/blob"
	"github.com/skoow/shhdrop/server/internal/compte"
	"github.com/skoow/shhdrop/server/internal/config"
	"github.com/skoow/shhdrop/server/internal/limits"
	"github.com/skoow/shhdrop/server/internal/paiement"
	"github.com/skoow/shhdrop/server/internal/salon"
	"github.com/skoow/shhdrop/server/internal/share"
	"github.com/skoow/shhdrop/server/internal/store"
)

// adminDeps : ce que le tableau de bord d'administration lit et commande dans le serveur
// en marche.
type adminDeps struct {
	svc    *share.Service
	sm     *salon.Manager // nil : salon désactivé
	db     *sql.DB
	gate   *blob.Gate
	lim    *limits.Limiter
	probes api.Probes // alerte des signalements, compteurs d'usage, transferts en cours
	start  time.Time  // démarrage du processus, en mémoire seulement
	// Service du compte (SHH_COMPTES=1 ; nil sinon).
	cpt *compte.Service
	// pai : service du paiement (SHH_PAIEMENT=1 ; nil sinon).
	pai *paiement.Service
}

// buildID : empreinte du commit compilé, posée à la compilation (-ldflags "-X main.buildID=…",
// deploy/Dockerfile) : l'image de production est construite sans dossier .git ni empreinte
// vcs (-buildvcs=false), et la page ne pouvait pas dire quel code tourne. Vide : repli sur
// l'empreinte vcs du binaire.
var buildID string

// adminListen : ouverture de l'écouteur d'administration (variable pour les tests).
var adminListen = func(addr string) (net.Listener, error) { return net.Listen("tcp", addr) }

// startAdmin : écouteur d'administration (SHH_ADMIN_LISTEN), distinct de l'écouteur public.
// Désactivé sans SHH_ADMIN_LISTEN. Le tableau de bord est un plus, jamais une dépendance :
// si son écouteur ne s'ouvre pas, une ligne fixe le dit (« SHH_ADMIN_INDISPONIBLE », sans
// détail système) et le serveur public continue. Rend l'arrêt de l'écouteur.
func startAdmin(cfg config.Config, out io.Writer, d adminDeps) (stop func()) {
	if cfg.AdminListen == "" {
		return func() {}
	}
	ln, err := adminListen(cfg.AdminListen)
	if err != nil {
		fmt.Fprintln(out, "SHH_ADMIN_INDISPONIBLE")
		return func() {}
	}
	srv := adminui.Server(adminui.New(adminConfig(cfg, d)))
	fmt.Fprintf(out, "SHH_ADMIN_LISTENING %s\n", ln.Addr())
	done := make(chan struct{})
	go func() { srv.Serve(ln); close(done) }()
	return func() { srv.Close(); <-done }
}

// adminConfig : ce que la page lit et commande. Salons signalés : avec SHH_SALONS=1 ;
// bannissements et comptes : avec SHH_COMPTES=1 (sinon ces routes répondent comme une route
// inconnue).
func adminConfig(cfg config.Config, d adminDeps) adminui.Config {
	hote, _, _ := net.SplitHostPort(cfg.AdminListen) // forme vérifiée par config
	c := adminui.Config{
		TokenHash: cfg.AdminTokenHash, Peers: cfg.TrustedProxies, Host: hote, Now: cfg.Now,
		State:    func() (adminui.State, error) { return adminState(cfg, d) },
		Freeze:   func() error { return freeze(d.svc.FrozenFile) },
		Unfreeze: func() error { return unfreeze(d.svc.FrozenFile) },
		Destroy:  func(link []byte) (string, error) { return adminDestroy(cfg, d, link) },
	}
	if d.sm != nil {
		c.Signales = func() ([]adminui.Signale, error) { return adminSignales(d) }
		c.ActionSalon = func(cle, action string, duree int, motif uint8) (adminui.Resultat, error) {
			return adminActionSalon(d, cle, action, duree, motif)
		}
	}
	if d.cpt != nil {
		c.Comptes = &adminui.Comptes{
			Agregats: func() (adminui.Agregats, error) { return adminAgregats(d) },
			Liste:    d.cpt.ListeBans,
			Action:   d.cpt.ActionBan,
			Bannir: func(lien []byte, duree int, motif uint8) (adminui.Resultat, error) {
				return adminBannir(d, lien, duree, motif)
			},
			SurMesure: &adminui.SurMesure{Chercher: d.cpt.CompteParPseudo, Liste: d.cpt.ListeSurMesure,
				Poser: d.cpt.PoserSurMesure, Retirer: d.cpt.RetirerSurMesure},
		}
	}
	if d.pai != nil {
		// Accès offerts : pass Pro créés ici, lien vers SHH_ORIGIN (obligatoire avec SHH_PAIEMENT=1).
		c.Paiement = &adminui.Paiement{Agregats: d.pai.Agregats, Suspendre: d.pai.Suspendre,
			Offrir: d.pai.Offrir, Offerts: d.pai.AccesOfferts, RevoquerOffert: d.pai.RevoquerOffert, NommerOffert: d.pai.NommerOffert,
			Origine: cfg.Origin}
	}
	return c
}

// adminSignales : salons vivants signalés (mémoire du gestionnaire), avec leur créateur :
// palier, ancienneté, bannissement, nombre de ses autres salons vivants ; jamais son identité.
func adminSignales(d adminDeps) ([]adminui.Signale, error) {
	out := []adminui.Signale{}
	for _, s := range d.sm.Signalements() {
		v := adminui.Signale{Cle: s.ID, Categories: s.Categories, Expire: s.Expire, Places: s.Places, Sieges: s.Sieges}
		h, err := d.sm.CompteDuSalonID(s.ID)
		if errors.Is(err, salon.ErrNotFound) {
			continue // fini entre-temps
		}
		if err != nil {
			return nil, err
		}
		if h != nil && d.cpt != nil {
			cv, err := d.cpt.VueCompte(*h)
			if err != nil {
				return nil, err
			}
			if cv.Existe {
				v.Createur = &cv
				n, err := d.sm.SalonsDuCompte(*h)
				if err != nil {
					return nil, err
				}
				v.AutresSalons = max(0, n-1)
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// adminActionSalon : action sur un salon signalé désigné par sa ref (identifiant interne
// retrouvé par la page) : « detruire » (comme par un lien), « bannir » (le compte créateur ;
// salon sans compte, ou comptes désactivés : « aucun »), « anciennete » (rendue au créateur).
func adminActionSalon(d adminDeps, id, action string, duree int, motif uint8) (adminui.Resultat, error) {
	if action == "detruire" {
		complet, err := d.sm.DetruireAdminID(id)
		if errors.Is(err, salon.ErrNotFound) {
			return adminui.Resultat{}, adminui.ErrIntrouvable
		}
		if err != nil {
			return adminui.Resultat{}, err
		}
		return adminui.Resultat{Detruit: "salon", Reste: !complet}, nil
	}
	h, err := d.sm.CompteDuSalonID(id)
	if errors.Is(err, salon.ErrNotFound) {
		return adminui.Resultat{}, adminui.ErrIntrouvable
	}
	if err != nil {
		return adminui.Resultat{}, err
	}
	switch action {
	case "bannir":
		return bannirCompte(d, h, duree, motif)
	case "anciennete":
		if h == nil || d.cpt == nil {
			return adminui.Resultat{Anciennete: "aucun"}, nil
		}
		switch err := d.cpt.RendreAnciennete(*h); {
		case errors.Is(err, compte.ErrEtape):
			return adminui.Resultat{Anciennete: "aucun"}, nil
		case err != nil:
			return adminui.Resultat{}, err
		}
		return adminui.Resultat{Anciennete: "rendue"}, nil
	}
	return adminui.Resultat{}, compte.ErrRequete
}

// bannirCompte : bannissement du compte h (nil : salon sans compte → « aucun »).
func bannirCompte(d adminDeps, h *[16]byte, duree int, motif uint8) (adminui.Resultat, error) {
	if h == nil || d.cpt == nil {
		return adminui.Resultat{Banni: "aucun"}, nil
	}
	b, err := d.cpt.Bannir(*h, duree, motif)
	if errors.Is(err, compte.ErrEtape) {
		return adminui.Resultat{Banni: "aucun"}, nil // compte supprimé entre-temps
	}
	if err != nil {
		return adminui.Resultat{}, err
	}
	return adminui.Resultat{Banni: "compte", Ban: &b.Vue, SalonsFermes: b.SalonsFermes}, nil
}

// adminBannir : par lien d'invitation d'un salon (traité en octets : seule K_accès_s en est
// tirée, effacée au retour) ; plus de bannissement par adresse (compte sans e-mail).
func adminBannir(d adminDeps, lien []byte, duree int, motif uint8) (adminui.Resultat, error) {
	k, estSalon, err := cleAccesDuLien(lien)
	if err != nil || !estSalon {
		clear(k)
		return adminui.Resultat{}, adminui.ErrLienInvalide
	}
	defer clear(k)
	if d.sm == nil {
		return adminui.Resultat{}, adminui.ErrIntrouvable
	}
	h, err := d.sm.CompteDuSalon(k)
	if errors.Is(err, salon.ErrNotFound) {
		return adminui.Resultat{}, adminui.ErrIntrouvable
	}
	if err != nil {
		return adminui.Resultat{}, err
	}
	return bannirCompte(d, h, duree, motif)
}

// adminAgregats : agrégats des comptes, salons vivants créés par un compte.
func adminAgregats(d adminDeps) (adminui.Agregats, error) {
	a, err := d.cpt.Agregats()
	if err != nil {
		return adminui.Agregats{}, err
	}
	r := adminui.Agregats{AgregatsComptes: a}
	if d.sm != nil {
		if r.SalonsDeComptes, err = d.sm.SalonsAvecCompte(); err != nil {
			return adminui.Agregats{}, err
		}
	}
	return r, nil
}

// unfreeze retire le fichier de gel ; idempotent.
func unfreeze(frozen string) error {
	if err := os.Remove(frozen); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	sansDate(filepath.Dir(frozen)) // l'heure du dégel ne reste pas sur le dossier (freeze)
	return nil
}

// adminState : état agrégé, lu à l'instant (inventaire A à G de la conception, phase 1).
// Rien n'est gardé d'une lecture à l'autre.
func adminState(cfg config.Config, d adminDeps) (adminui.State, error) {
	var st adminui.State
	goVersion, rev := adminui.Build(buildID)
	st.Sante = adminui.Sante{DepuisS: int64(time.Since(d.start) / time.Second), Go: goVersion, Revision: rev,
		Gele: d.svc.Frozen(), SalonActif: d.sm != nil, ComptesActif: d.cpt != nil, Origine: cfg.Origin, AlerteSignalements: d.probes.Alert(),
		VidagesRates: d.svc.Vidage.Rates(), PaiementActif: d.pai != nil, RelaisTurn: len(cfg.TurnURLs) != 0}
	// Appels offerts : relais ET jetons anonymes, comme salonAPI.appels (handlers_salon_appel.go).
	st.Sante.AppelsOfferts = st.Sante.RelaisTurn && d.sm != nil && d.pai != nil && d.pai.Jetons() != nil

	partages, err := d.svc.UsedShares()
	if err != nil {
		return adminui.State{}, err
	}
	var salonOctets int64
	if d.sm != nil {
		salonOctets = d.sm.UsedBytes()
		s := d.sm.Stats()
		st.Salon = &s
	}
	// Disque illisible (système non pris en charge) : 0, la page le montre tel quel.
	libre, _ := diskFree(cfg.DataDir)
	total, _ := statfsTotal(cfg.DataDir)
	utilise := partages + salonOctets
	st.Stockage = adminui.Stockage{DisqueLibre: libre, DisqueTotal: total, Plafond: cfg.StorageMaxBytes,
		Partages: partages, Salon: salonOctets, Utilise: utilise, Restant: max(0, cfg.StorageMaxBytes-utilise),
		Reserve: cfg.StorageMaxBytes / share.StorageReserve}

	st.Memoire = adminui.Runtime()

	c := capacityOf(cfg).WithDefaults()
	st.Capacite = adminui.Capacite{EnvoisMax: c.Uploads, LecturesMax: c.Downloads, SurveillancesMax: c.Watches,
		WebSocketMax: c.WebSockets, AppelsDisqueMax: d.gate.Cap(), Surveillances: d.svc.WatchCount(),
		Octrois: d.svc.GrantCount(), Budgets: d.svc.BudgetCount(), AppelsDisque: d.gate.InUse(), PlafondSortie: d.svc.EgressMax()}

	ul, ulPic := d.probes.Uploads()
	dl, dlPic := d.probes.Downloads()
	st.Usage = adminui.Usage{Snapshot: d.probes.Usage(), EffacesEntretien: d.svc.Effaces.Load(),
		ExpediteursDuJour: d.lim.DistinctCreators(), RefusSortie: d.svc.RefusSortie.Load(), EnvoisEnCours: ul, EnvoisPic: ulPic, LecturesEnCours: dl, LecturesPic: dlPic}

	if st.Partages, err = d.svc.CountByState(); err != nil {
		return adminui.State{}, err
	}
	return st, nil
}

// errSalonMort : le salon est détruit pour tous (ligne morte), mais sa ligne n'a pas pu être
// supprimée par la destruction sans gestionnaire ; jamais annoncé « détruit ».
var errSalonMort = errors.New("salon : ligne morte, effacement à finir")

// adminDestroy : destruction d'un lien signalé depuis la page, comme « shhdrop admin
// destroy - » mais dans le serveur en marche : seule K_accès est tirée du lien (traité en
// octets, effacés au retour : cleAccesDuLien). Partage : flux coupés tout de suite
// (DestroyAdmin). Salon : fini par le gestionnaire du serveur (salon.Manager.DetruireAdmin :
// connexions fermées tout de suite, conversation, pièces et ligne effacées) ; salon désactivé :
// lignes d'une configuration antérieure, sans gestionnaire (salon.DetruireHorsLigne). Dans les
// deux cas le vidage du WAL est demandé au vidage regroupé, sans l'attendre (un vidage direct
// tenait la seule connexion à la base 5 s et faisait répondre « erreur » pour un salon
// détruit).
//
// Rend « salon » seulement si la ligne et les pièces sont parties ; « salon-reste » si le
// salon est détruit pour tous (état oublié, ligne morte) mais qu'un effacement de fichier reste
// à finir par l'entretien (jamais « détruit » pour un salon qui survit).
func adminDestroy(cfg config.Config, d adminDeps, body []byte) (string, error) {
	k, estSalon, err := cleAccesDuLien(body)
	if err != nil {
		return "", adminui.ErrLienInvalide
	}
	defer clear(k)
	if !estSalon {
		if err := d.svc.DestroyAdmin(k); err != nil {
			if errors.Is(err, share.ErrNotFound) {
				return "", adminui.ErrIntrouvable
			}
			return "", err
		}
		return "partage", nil
	}
	if err := store.RequireCurrent(d.db); err != nil {
		return "", err
	}
	var complet bool
	if d.sm != nil {
		complet, err = d.sm.DetruireAdmin(k)
	} else {
		complet, err = salon.DetruireHorsLigne(d.db, &blob.Store{Dir: filepath.Join(cfg.DataDir, dirSalonPieces), Gate: d.gate},
			filepath.Join(cfg.DataDir, dirSalons), k)
		d.svc.Vidage.Demander() // lignes effacées ou récrites : vidage regroupé, sans attendre
		if err == nil && !complet {
			err = errSalonMort // sans gestionnaire, personne ne finirait l'effacement
		}
	}
	switch {
	case errors.Is(err, salon.ErrNotFound):
		return "", adminui.ErrIntrouvable
	case err != nil:
		return "", err
	case !complet:
		return "salon-reste", nil
	}
	return "salon", nil
}

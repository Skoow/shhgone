// Test « aucune statistique » côté serveur (spec §35.1, §9.5), bloquant. Exception : des
// compteurs d'usage globaux, un entier chacun, en mémoire, existent pour le
// tableau de bord d'administration (internal/usage) ; ce test garde le reste : aucune
// télémétrie, aucune table (map) non justifiée, donc rien par personne, par adresse ni par
// partage.
package internal_test

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// forbidden : imports de mesure, de télémétrie ou de rapports d'erreurs (spec §35.1).
var forbidden = []string{"expvar", "net/http/pprof", "runtime/pprof", "github.com/prometheus/", "go.opentelemetry.io/",
	"github.com/getsentry/", "gopkg.in/DataDog/", "github.com/newrelic/", "github.com/DataDog/", "statsd"}

// allowedMaps : chaque map déclarée (champ de structure ou variable de paquet) de
// server/internal, avec la ligne de spec §9.5 qui la justifie. Toute autre fait échouer.
var allowedMaps = map[string]string{
	"limits/limits.go:count64":          "§9.5 créations et octets du jour",
	"limits/limits.go:count48":          "§9.5 créations et octets du jour",
	"limits/limits.go:bytes64":          "§9.5 créations et octets du jour",
	"limits/limits.go:bytes48":          "§9.5 créations et octets du jour",
	"limits/limits.go:req":              "§9.5 requêtes et segments de la minute",
	"limits/limits.go:req48":            "§9.5 requêtes et segments de la minute",
	"limits/limits.go:seg":              "§9.5 requêtes et segments de la minute",
	"limits/limits.go:seg48":            "§9.5 requêtes et segments de la minute",
	"limits/limits.go:uploads":          "§9.5 envois anticipés en cours",
	"limits/limits.go:pend64":           "§9.5 envois anticipés en cours",
	"limits/limits.go:pend48":           "§9.5 envois anticipés en cours",
	"limits/limits.go:aband64":          "§9.5 octets abandonnés",
	"limits/limits.go:aband48":          "§9.5 octets abandonnés",
	"limits/limits.go:salon64":          "§9.5 salons créés du jour (§39.3.6)",
	"limits/limits.go:salon48":          "§9.5 salons créés du jour (§39.3.6)",
	"limits/limits.go:join64":           "§9.5 entrées de l'heure (§39.3.6)",
	"limits/limits.go:join48":           "§9.5 entrées de l'heure (§39.3.6)",
	"limits/limits.go:inv64":            "§9.5 vérifications du pseudo d'un invité de l'heure",
	"limits/limits.go:inv48":            "§9.5 vérifications du pseudo d'un invité de l'heure",
	"limits/limits.go:frame64":          "§9.5 trames de la minute (§39.3.6)",
	"limits/limits.go:frame48":          "§9.5 trames de la minute (§39.3.6)",
	"limits/limits.go:paid64":           "§9.5 octets utiles du jour des partages payants par connexion (spec §38.6, conception du paiement §11)",
	"limits/limits.go:paid48":           "§9.5 octets utiles du jour des partages payants par /48 (spec §38.6)",
	"limits/limits.go:paie64":           "§9.5 commandes de paiement de l'heure par connexion (conception du paiement §8)",
	"limits/limits.go:paie48":           "§9.5 commandes de paiement de l'heure par /48 (conception du paiement §8)",
	"limits/limits.go:ppw64":            "§9.5 webhooks PayPal de la minute par connexion (audit du 20 novembre, S3)",
	"limits/limits.go:ppw48":            "§9.5 webhooks PayPal de la minute par /48 (audit du 20 novembre, S3)",
	"paiement/paypal.go:vu":             "§9.5 identifiants de transmission PayPal refusés (SHA-256 → échéance), 1 h, 4 096 au plus (audit du 20 novembre, S3)",
	"limits/slots.go:c64":               "§9.5 transferts simultanés",
	"limits/slots.go:c48":               "§9.5 transferts simultanés",
	"limits/slots.go:n":                 "§9.5 transferts simultanés, par envoi et par ouverture (audit I3, M4 ; id interne, durée du transfert)",
	"captcha/captcha.go:used":           "§9.5 défis anti-robot consommés",
	"captcha/captcha.go:creates":        "§9.5 créations de l'heure par connexion",
	"share/budget.go:m":                 "§9.5 budget de lecture par ouverture",
	"share/budget.go:shares":            "§9.5 octets servis par partage (plafond de sortie, 24 novembre)",
	"share/report.go:m":                 "§9.5 voix de signalement d'un partage (20 novembre)",
	"share/report.go:votes":             "§9.5 voix de signalement d'un partage (20 novembre)",
	"share/service.go:up":               "§9.5 colonnes d'un partage vivant (échéance d'envoi, dernier segment), en mémoire (§36 S5, S12)",
	"share/service.go:purge":            "§9.5 colonnes d'un partage vivant (purge d'un « draining »), en mémoire (§36 S12)",
	"share/service.go:part":             "§9.5 colonnes d'un partage vivant (morceaux reçus d'un segment partagé, audit H-2), en mémoire",
	"share/service.go:ids":              "verrou de finalisation (aucun compte : présence seulement, le temps d'un finalize)",
	"share/service.go:sealing":          "verrou de finalisation : segments refusés (présence seulement, le temps d'un finalize, audit F6)",
	"share/detached.go:active":          "§9.5 ouvertures actives (§41.8)",
	"share/detached.go:dead":            "§9.5 ouvertures actives : descripteurs détachés (§41.8)",
	"share/detached.go:opens":           "§9.5 ouvertures actives : ouvertures d'un descripteur détaché (§41.8)",
	"share/detached.go:watch":           "§9.5 requêtes watch tenues (§41.8)",
	"share/detached.go:grants":          "§9.5 octrois d'ouverture (§41.4)",
	"share/streams.go:live":             "§9.5 flux de segments annulables (§41.8)",
	"api/static_paths.go:pdfFrameFiles": "constante (liste de fichiers), aucun compteur",
	"salon/manager.go:salons":           "§39.3.6 état d'un salon vivant (pas une statistique au sens de §9.5), effacé avec le salon",
	"salon/manager.go:index":            "§39.3.6 empreintes des jetons de membre → salon vivant, effacées avec le salon",
	"salon/salon.go:jetons":             "§39.3.6 empreintes des jetons de membre → siège, effacées avec le salon",
	"salon/salon.go:revoques":           "§39.3.6 empreintes des jetons révoqués (exclusion, §39.13), effacées avec le salon",
	"salon/salon.go:pieces":             "§39.3.4 auteur d'une pièce en mémoire : rang de la trame → pièce liée (plan, point 2), effacé avec le salon",
	"salon/salon.go:lesPieces":          "§9.5 état d'un salon vivant : pièces vivantes par id, effacées avec elles ou le salon",
	"salon/salon.go:libres":             "§9.5 état d'un salon vivant : pièces pas encore liées (échéances de 15 min), effacées avec elles ou le salon",
	"salon/manager.go:pieceIdx":         "§9.5 état d'un salon vivant : id de pièce → salon (routes à jeton d'envoi), effacé avec la pièce",
	"salon/pieces.go:lus":               "§9.5 budget de lecture par (jeton de membre, pièce) (§24, M1), effacé avec la pièce",
	"salon/manager.go:vivants":          "§9.5 salons vivants par bloc (§39.3.6, 12 novembre) : id interne → clé de bloc, jusqu'à la fin du salon",
	"salon/manager.go:parBloc":          "§9.5 salons vivants par bloc (§39.3.6, 12 novembre) : clé de bloc → nombre, jusqu'à la fin du salon",
	// Limites du compte (conception du compte §8.8 ; conception du compte par passkey §7.2) : clés
	// HMAC du jour, aucune adresse IP ni h en clair, vidées à la minute, à l'heure ou à minuit UTC.
	"limits/limits.go:insc64":    "conception du compte par passkey §7.2 comptes créés du jour par connexion (3), minuit UTC",
	"limits/limits.go:insc48":    "conception du compte par passkey §7.2 comptes créés du jour par /48 (10), minuit UTC",
	"limits/limits.go:inscD64":   "conception du compte par passkey §7.2 inscription/debut de l'heure par connexion (20)",
	"limits/limits.go:cnx48":     "connexion/debut de la minute par /48 (180)",
	"limits/limits.go:wh64":      "webhooks de paiement de la minute par connexion (600)",
	"limits/limits.go:wh48":      "webhooks de paiement de la minute par /48 (6 000)",
	"limits/limits.go:cnx64":     "conception du compte par passkey §7.2 connexion/debut de la minute par connexion (60)",
	"limits/limits.go:echec64":   "conception du compte par passkey §7.2 échecs de connexion par passkey de l'heure par connexion (20)",
	"limits/limits.go:echec48":   "conception du compte par passkey §7.2 échecs de connexion par passkey de l'heure par /48 (60)",
	"limits/limits.go:recup64":   "conception du compte par passkey §7.2 essais de la clé de récupération de l'heure par connexion (10)",
	"limits/limits.go:recup48":   "conception du compte par passkey §7.2 essais de la clé de récupération de l'heure par /48 (30)",
	"limits/limits.go:coffreCpt": "conception du compte §8.8, §21.6.2 écritures des coffres de l'heure par compte (60) et ajouts de passkey (10, conception du compte par passkey §7.2), HMAC du jour de h",
	"limits/limits.go:pseudoCpt": "conception du compte §21.5 vérifications de pseudo de l'heure (30), HMAC du jour de h ou de l'étape",
	// Compte (conception du compte par passkey §6.2) : mémoire seulement, perdue au redémarrage.
	"compte/defis.go:parBloc": "part équitable des étapes WebAuthn : un entier par bloc, clé HMAC du jour du /48 (jamais le préfixe en clair) ou compte d'un ajout de passkey, retiré avec la dernière étape du bloc",
	"compte/defis.go:m":       "conception du compte par passkey §6.2 cérémonies WebAuthn en cours (défi, rp.id, passkeys permises, h tiré, empreinte du pseudo réservé), clé SHA-256 du jeton d'étape, usage unique, 5 min, 20 000 au plus ; aucune sortie PRF ni clé",
	"compte/sessions.go:m":    "conception du compte §8.3 dernier usage et « session récente » d'une session, clé t_v (SHA-256 du jeton), oublié 2 h sans usage",
	"compte/service.go:refs":  "conception du compte §21.6.2 salons du compte (GET salons) : ref aléatoire de 16 octets → h et identifiant interne du salon, 10 min, oubliée à la liste suivante une fois échue ; au plus les salons vivants (et finis depuis moins de 10 min) de chaque compte ; perdue au redémarrage",
	// Tableau de bord des comptes.
	"adminui/comptes.go:m": "conception du compte §21.14.3 salons signalés en cours (tableau de bord) : ref aléatoire de 16 octets → identifiant interne du salon, 10 min, oubliée à la liste suivante une fois échue ; au plus les salons vivants signalés ; perdue au redémarrage",
}

type goFile struct {
	rel string
	f   *ast.File
}

func sources(t *testing.T, root string) []goFile {
	t.Helper()
	var out []goFile
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(token.NewFileSet(), p, nil, 0)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		out = append(out, goFile{filepath.ToSlash(rel), f})
		return nil
	})
	if err != nil || len(out) < 10 {
		t.Fatal("sources", len(out), err)
	}
	return out
}

func TestNoTelemetryImports(t *testing.T) {
	for _, g := range sources(t, "..") {
		for _, imp := range g.f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			for _, f := range forbidden {
				if p == f || strings.Contains(p, f) {
					t.Errorf("%s : import interdit %s (spec §35.1)", g.rel, p)
				}
			}
		}
	}
	sum, err := os.ReadFile(filepath.Join("..", "go.sum"))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range forbidden[3:] {
		if strings.Contains(string(sum), f) {
			t.Errorf("go.sum : %s (spec §35.1)", f)
		}
	}
}

// mapDecls : champs de structure et variables de paquet de type map (déclarations qui
// survivent à une requête ; les variables locales, transitoires, ne comptent pas).
func mapDecls(f *ast.File) []string {
	var names []string
	isMap := func(e ast.Expr) bool { _, ok := e.(*ast.MapType); return ok }
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.FuncDecl:
			return false // corps de fonctions : locaux
		case *ast.StructType:
			for _, fl := range x.Fields.List {
				if isMap(fl.Type) {
					for _, nm := range fl.Names {
						names = append(names, nm.Name)
					}
				}
			}
		case *ast.ValueSpec:
			for i, nm := range x.Names {
				if (x.Type != nil && isMap(x.Type)) || (i < len(x.Values) && isCompositeMap(x.Values[i])) {
					names = append(names, nm.Name)
				}
			}
		}
		return true
	})
	return names
}

func isCompositeMap(e ast.Expr) bool {
	c, ok := e.(*ast.CompositeLit)
	if !ok {
		return false
	}
	_, ok = c.Type.(*ast.MapType)
	return ok
}

func TestNoUnlistedCounter(t *testing.T) {
	seen := map[string]bool{}
	for _, g := range sources(t, ".") {
		for _, nm := range mapDecls(g.f) {
			k := g.rel + ":" + nm
			seen[k] = true
			if _, ok := allowedMaps[k]; !ok {
				t.Errorf("%s : nouveau compteur : ajouter une ligne justifiée à spec §9.5 (puis à allowedMaps)", k)
			}
		}
	}
	for k := range allowedMaps {
		if !seen[k] {
			t.Errorf("liste blanche périmée : %s n'existe plus", k)
		}
	}
}

// sortants : appels qui ouvrent une connexion sortante (spec §35.1) ; interdits partout, sauf
// internal/paiement/http.go (prestataires de paiement). Le repli reCAPTCHA (spec §26) est retiré
// et n'a jamais été codé : aucune exception pour lui.
// Plus aucune sortie SMTP (compte par passkey) : net/smtp est interdit
// partout.
var sortants = map[string]bool{
	"http.Client": true, "http.Get": true, "http.Post": true, "http.PostForm": true, "http.Head": true,
	"http.DefaultClient": true, "http.NewRequest": true, "http.NewRequestWithContext": true,
	"http.Transport": true, "http.DefaultTransport": true,
	"net.Dial": true, "net.DialTCP": true, "net.DialUDP": true, "net.DialIP": true, "net.DialUnix": true,
	"net.DialTimeout": true, "net.Dialer": true,
	"smtp.Dial": true, "smtp.SendMail": true, "smtp.NewClient": true,
	"tls.Dial": true, "tls.DialWithDialer": true, "tls.Dialer": true, "tls.Client": true,
}

// paquetsReseau : imports qui ne doivent jamais être renommés (un alias tromperait la recherche
// par nom de paquet ci-dessous).
var paquetsReseau = map[string]bool{"net": true, "net/http": true, "net/smtp": true, "crypto/tls": true}

// paiementPermis : ce que internal/paiement/http.go, et lui seul, peut appeler parmi sortants
// (conception du paiement §4) : le client HTTPS des prestataires (Stripe, PayPal, NOWPayments),
// créé seulement avec SHH_PAIEMENT=1 (TestClientPaiementSeulementAvecPaiement). Rien d'autre :
// ni net.Dial, ni tls.Dial, ni http.Get ou http.DefaultClient.
var paiementPermis = map[string]bool{"http.Client": true, "http.Transport": true, "http.NewRequestWithContext": true}

// TestNoOutgoingHTTP : aucun client sortant hors de internal/paiement/http.go (prestataires de
// paiement seulement) ; aucun client SMTP nulle part (plus d'exception SMTP, conception du compte
// par passkey §8). Aucun saut : le repli reCAPTCHA (spec §26) a été retiré.
func TestNoOutgoingHTTP(t *testing.T) {
	paiementVu := false
	for _, g := range sources(t, "..") {
		paiementGo := g.rel == "internal/paiement/http.go"
		for _, imp := range g.f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if paquetsReseau[p] && imp.Name != nil {
				t.Errorf("%s : import renommé de %s (interdit : la recherche des clients sortants se fait par nom)", g.rel, p)
			}
			if p == "net/smtp" {
				t.Errorf("%s : net/smtp (plus aucune sortie SMTP depuis le 22 novembre)", g.rel)
			}
		}
		ast.Inspect(g.f, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok {
				k := id.Name + "." + sel.Sel.Name
				switch {
				case paiementGo && paiementPermis[k]:
					paiementVu = paiementVu || k == "http.Client"
				case sortants[k]:
					t.Errorf("%s : %s (client sortant interdit, spec §35.1)", g.rel, k)
				}
			}
			return true
		})
	}
	if !paiementVu {
		t.Error("internal/paiement/http.go ne crée plus de http.Client : exemption périmée, à retirer")
	}
}

// TestClientPaiementSeulementAvecPaiement : avec SHH_PAIEMENT=0, aucune connexion sortante vers
// un prestataire. Le seul client (paiement.NouveauClient) n'est créé qu'à l'intérieur d'un
// « if » qui lit Paiement (cfg.Paiement), dans son corps « alors », hors du paquet paiement.
func TestClientPaiementSeulementAvecPaiement(t *testing.T) {
	vu := false
	for _, g := range sources(t, "..") {
		if strings.HasPrefix(g.rel, "internal/paiement/") {
			continue
		}
		var pile []ast.Node
		ast.Inspect(g.f, func(n ast.Node) bool {
			if n == nil {
				pile = pile[:len(pile)-1]
				return true
			}
			pile = append(pile, n)
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); !ok || id.Name != "paiement" || sel.Sel.Name != "NouveauClient" {
				return true
			}
			vu = true
			for i := len(pile) - 2; i >= 0; i-- {
				if st, ok := pile[i].(*ast.IfStmt); ok && litChamp(st.Cond, "Paiement") && pile[i+1] == st.Body {
					return true
				}
			}
			t.Errorf("%s : paiement.NouveauClient hors d'un « if …Paiement » (avec SHH_PAIEMENT=0, aucune sortie)", g.rel)
			return true
		})
	}
	if !vu {
		t.Error("paiement.NouveauClient n'est plus appelé : test périmé")
	}
}

func litChamp(e ast.Expr, nom string) bool {
	vu := false
	ast.Inspect(e, func(n ast.Node) bool {
		if s, ok := n.(*ast.SelectorExpr); ok && s.Sel.Name == nom {
			vu = true
		}
		return !vu
	})
	return vu
}

// TestPlusDeCourriel : le paquet internal/courriel n'existe plus, et aucune source du serveur
// n'importe un paquet d'envoi d'e-mails (conception du compte par passkey §8).
func TestPlusDeCourriel(t *testing.T) {
	if _, err := os.Stat("courriel"); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("internal/courriel existe encore :", err)
	}
	for _, g := range sources(t, "..") {
		for _, imp := range g.f.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if strings.HasSuffix(p, "/courriel") || p == "net/smtp" || p == "net/mail" {
				t.Errorf("%s : import %s (plus d'e-mail)", g.rel, p)
			}
		}
	}
}

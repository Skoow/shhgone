package paiement

import (
	"context"
	"errors"
	"fmt"
)

// Renouvellement arrêté sans usage (décision du propriétaire, 28 novembre ; conception du
// paiement §6.4) : le serveur ne sait pas à quel compte appartient un pass, mais il sait quand
// ce pass a obtenu ses derniers jetons (passes.emis_jour, jour UTC, posé par prendreDuJour ;
// debut_jour s'il n'en a jamais obtenu). Un abonnement qui se renouvelle et dont le pass n'a
// obtenu aucun jeton depuis inactiviteRenouvellement voit son renouvellement arrêté chez le
// prestataire, comme « Arrêter l'abonnement » (Resilier : Stripe en fin de période, PayPal tout
// de suite, l'accès payé restant jusqu'à sa fin chez nous). Aucune nouvelle donnée gardée : la
// règle ne lit que des colonnes existantes, au jour près.

// inactiviteRenouvellement : 12 mois, comptés en 365 jours.
const inactiviteRenouvellement = 365 * jourS

// ArreterInactifs : arrête le renouvellement de chaque abonnement payé qui se renouvelle et dont
// le pass n'a obtenu aucun jeton depuis 365 jours. Rend le nombre d'arrêts faits et d'échecs
// (prestataire injoignable ou absent : la commande reste « renouvelle », réessayée à la passe
// suivante) ; l'erreur rendue ne vient que de la base.
func (s *Service) ArreterInactifs(ctx context.Context) (arretes, echecs int, err error) {
	auj := jourDe(s.now())
	rows, err := s.db.Query(`SELECT c.id FROM commandes c JOIN passes p ON p.q=c.q
		WHERE c.etat=? AND c.renouvelle=1 AND c.abonnement IS NOT NULL AND p.revoque=0
		AND MAX(p.emis_jour, p.debut_jour) + ? <= ?`, etatPayee, inactiviteRenouvellement, auj)
	if err != nil {
		return 0, 0, err
	}
	var ids [][]byte
	for rows.Next() {
		var id []byte
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return 0, 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	for _, id := range ids {
		switch e := s.arreterRenouvellement(ctx, id); {
		case e == nil:
			arretes++
		case errBase(e):
			return arretes, echecs, e
		default:
			echecs++
		}
	}
	return arretes, echecs, nil
}

// erreurBase : erreur de paiements.db (par opposition à un prestataire qui refuse ou ne répond pas).
type erreurBase struct{ error }

func (e erreurBase) Unwrap() error { return e.error }

func errBase(err error) bool {
	var b erreurBase
	return errors.As(err, &b)
}

// arreterRenouvellement : Resilier du prestataire de la commande id (abonnement connu, renouvelle
// encore), puis renouvelle = 0. Déjà arrêté chez le prestataire (ErrAucunAbonnement) : noté arrêté
// aussi. Prestataire non configuré : ErrMoyen.
func (s *Service) arreterRenouvellement(ctx context.Context, id []byte) error {
	var abo []byte
	var moyen int
	if err := s.db.QueryRow(`SELECT abonnement, moyen FROM commandes WHERE id=? AND renouvelle=1 AND abonnement IS NOT NULL`, id).
		Scan(&abo, &moyen); err != nil {
		return erreurBase{err}
	}
	if moyen < 0 || moyen >= len(s.prest) || s.prest[moyen] == nil {
		return ErrMoyen
	}
	if err := s.prest[moyen].Resilier(ctx, string(abo)); err != nil && !errors.Is(err, ErrAucunAbonnement) {
		return err
	}
	if _, err := s.db.Exec(`UPDATE commandes SET renouvelle=0 WHERE id=?`, id); err != nil {
		return erreurBase{err}
	}
	s.cpt.inactifs.Add(1)
	return nil
}

// journaliserInactifs : une ligne fixe par passe qui a quelque chose à dire, avec des nombres
// seulement (ni pass, ni commande, ni abonnement, ni prestataire).
func (s *Service) journaliserInactifs(arretes, echecs int) {
	w := s.journal
	if w == nil {
		return
	}
	if arretes > 0 {
		fmt.Fprintf(w, "paiement : renouvellement arrêté pour %d abonnement(s) sans jeton depuis 12 mois\n", arretes)
	}
	if echecs > 0 {
		fmt.Fprintf(w, "paiement : %d abonnement(s) sans jeton depuis 12 mois non arrêté(s) (prestataire injoignable), réessai demain\n", echecs)
	}
}

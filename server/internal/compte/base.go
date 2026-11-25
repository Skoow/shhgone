package compte

import (
	"database/sql"
	"errors"
	"fmt"
	"os"

	"github.com/skoow/shhdrop/server/internal/store"
)

// Schéma de comptes.db, version 3 (conception du compte par passkey §6.3 ; règles de la
// conception du compte §8.2 : mêmes PRAGMA que shares.db, WITHOUT ROWID, 0600). Seulement des
// BLOB et des INTEGER ; longueurs exactes ; dates au jour (minuit UTC, multiple de 86 400) ou
// au mois (premier du mois, minuit UTC), jamais d'heure. Cette base survit aux redémarrages et
// est sauvegardée (§21.13), contrairement à shares.db.
//
// comptes : h (16, tiré par le serveur, user.id de WebAuthn) ; p_empreinte (empreinte à clé du
// pseudo) ; pseudo_jour (jour du dernier changement de pseudo, 0 tant qu'il n'a jamais changé) ;
// v_r (SHA-256 de A_r, index unique : la clé de récupération seule retrouve le compte) ; env_r
// (K_compte enveloppée par la clé de récupération, 60) ; coffres de profil et privé au palier
// exact (4, 16, 64 ou 256 Kio + 45 octets) avec leur gen ; ancienneté. Aucune adresse, aucun
// mot de passe, aucun TOTP, aucun séquestre.
// passkeys : cred_id (1 à 1 023) ; h ; clé publique COSE (≤ 1 024) ; algorithme (−7, −8,
// −257) ; be (passkey synchronisable) ; etiquette (libellé chiffré par l'appareil, 64, ou
// rien) ; mois d'ajout. Jamais d'AAGUID, de transports, d'attestation, de compteur, de BS ni de
// date d'usage.
// enveloppes : K_compte enveloppée par une sortie PRF de la passkey cred_id (60), au plus 4 par
// passkey (n de 0 à 3) : une même passkey peut rendre des sorties différentes selon le chemin
// (local, QR) ou la version (iCloud, 1Password) ; chaque sortie observée a son enveloppe
// (« enveloppes multiples »). Ni date, ni ordre d'usage ; effacées
// avec la passkey, jamais une à une.
// sessions : t_v (SHA-256 du jeton) ; sid (identifiant montré) ; h (effacées avec le compte) ;
// etiquette (nom d'appareil chiffré par le client, 64) ; mois d'ajout ; jour d'échéance ;
// par_recup (session ouverte par la clé de récupération).
// bannis : id (8, montré au fondateur) ; h (effacé avec le compte : un nouveau compte se crée
// sans coût) ; début et échéance ; actif ; motif (catégorie 1 à 10, §21.10.1) ; salons
// fermés.
var schemaComptes = `
CREATE TABLE IF NOT EXISTS comptes(
  h BLOB PRIMARY KEY CHECK(` + blobN("h", 16) + `),
  p_empreinte BLOB NOT NULL CHECK(` + blobN("p_empreinte", 32) + `),
  pseudo_jour INTEGER NOT NULL CHECK(` + jourCheck("pseudo_jour") + `),
  v_r BLOB NOT NULL CHECK(` + blobN("v_r", 32) + `),
  env_r BLOB NOT NULL CHECK(` + blobN("env_r", 60) + `),
  blob_profil BLOB NOT NULL CHECK(` + coffreCheck("blob_profil") + `),
  gen_profil INTEGER NOT NULL CHECK(gen_profil >= 0),
  blob_prive BLOB NOT NULL CHECK(` + coffreCheck("blob_prive") + `),
  gen_prive INTEGER NOT NULL CHECK(gen_prive >= 0),
  cree_jour INTEGER NOT NULL CHECK(` + jourCheck("cree_jour") + `),
  compte_des INTEGER NOT NULL CHECK(` + jourCheck("compte_des") + `),
  vu_mois INTEGER NOT NULL CHECK(` + moisCheck("vu_mois") + `)) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS comptes_p_empreinte ON comptes(p_empreinte);
CREATE UNIQUE INDEX IF NOT EXISTS comptes_v_r ON comptes(v_r);
CREATE TABLE IF NOT EXISTS passkeys(
  cred_id BLOB PRIMARY KEY CHECK(typeof(cred_id)='blob' AND length(cred_id) BETWEEN 1 AND 1023),
  h BLOB NOT NULL REFERENCES comptes(h) ON DELETE CASCADE,
  cle_pub BLOB NOT NULL CHECK(typeof(cle_pub)='blob' AND length(cle_pub) BETWEEN 1 AND 1024),
  alg INTEGER NOT NULL CHECK(alg IN (-7,-8,-257)),
  be INTEGER NOT NULL CHECK(be IN (0,1)),
  etiquette BLOB CHECK(etiquette IS NULL OR (` + blobN("etiquette", 64) + `)),
  ajoutee_mois INTEGER NOT NULL CHECK(` + moisCheck("ajoutee_mois") + `)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS passkeys_h ON passkeys(h);
CREATE TABLE IF NOT EXISTS enveloppes(
  cred_id BLOB NOT NULL REFERENCES passkeys(cred_id) ON DELETE CASCADE,
  n INTEGER NOT NULL CHECK(typeof(n)='integer' AND n BETWEEN 0 AND 3),
  env BLOB NOT NULL CHECK(` + blobN("env", 60) + `),
  PRIMARY KEY(cred_id, n)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sessions(
  t_v BLOB PRIMARY KEY CHECK(` + blobN("t_v", 32) + `),
  sid BLOB NOT NULL CHECK(` + blobN("sid", 16) + `),
  h BLOB NOT NULL REFERENCES comptes(h) ON DELETE CASCADE,
  etiquette BLOB CHECK(etiquette IS NULL OR (` + blobN("etiquette", 64) + `)),
  cree_mois INTEGER NOT NULL CHECK(` + moisCheck("cree_mois") + `),
  expire_jour INTEGER NOT NULL CHECK(` + jourCheck("expire_jour") + `),
  persistante INTEGER NOT NULL CHECK(persistante IN (0,1)),
  par_recup INTEGER NOT NULL CHECK(par_recup IN (0,1))) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_sid ON sessions(sid);
CREATE INDEX IF NOT EXISTS sessions_h ON sessions(h);
CREATE TABLE IF NOT EXISTS bannis(
  id BLOB PRIMARY KEY CHECK(` + blobN("id", 8) + `),
  h BLOB NOT NULL REFERENCES comptes(h) ON DELETE CASCADE,
  debut_jour INTEGER NOT NULL CHECK(` + jourCheck("debut_jour") + `),
  jusqu_jour INTEGER NOT NULL CHECK(` + jourCheck("jusqu_jour") + `),
  actif INTEGER NOT NULL CHECK(actif IN (0,1)),
  motif INTEGER NOT NULL CHECK(motif BETWEEN 1 AND 10),
  salons_fermes INTEGER NOT NULL CHECK(salons_fermes >= 0)) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS bannis_h ON bannis(h)`

func blobN(col string, n int) string {
	return fmt.Sprintf("typeof(%s)='blob' AND length(%s)=%d", col, col, n)
}

func jourCheck(col string) string {
	return fmt.Sprintf("typeof(%s)='integer' AND %s >= 0 AND %s %% 86400 = 0", col, col, col)
}

// moisCheck : premier du mois, minuit UTC (fonctions de date sans « now » : déterministes).
func moisCheck(col string) string {
	return fmt.Sprintf("typeof(%s)='integer' AND %s >= 0 AND strftime('%%d %%H:%%M:%%S', %s, 'unixepoch') = '01 00:00:00'",
		col, col, col)
}

// coffreCheck : « SHH-ACCT1 » ou « SHH-PROF1 » (9) ‖ gen (8) ‖ nonce (12) ‖ chiffré du clair
// bourré au palier ‖ étiquette (16) : palier + 45 octets (engine/vectors/compte-v3.json).
func coffreCheck(col string) string {
	return fmt.Sprintf("typeof(%s)='blob' AND length(%s) IN (%d,%d,%d,%d)", col, col,
		4096+45, 16384+45, 65536+45, 262144+45)
}

// VersionBase : version du schéma de comptes.db (PRAGMA user_version). 3 : compte par
// passkey. Les versions 1 et 2 (compte par e-mail) ne sont jamais migrées : le service
// n'a jamais été ouvert (conception du compte par passkey §15).
const VersionBase = 3

// ErrBasePlusRecente : comptes.db écrite par une version plus récente ; message fixe, sans chemin.
var ErrBasePlusRecente = errors.New("comptes.db créée par une version plus récente de Shhgone : refus d'ouvrir " +
	"(retour arrière : réinstaller la version récente ; ne jamais effacer cette base, elle garde les comptes)")

// ErrBaseEmail : comptes.db de schéma 1 ou 2 (compte par e-mail) qui contient des comptes ;
// jamais effacée en silence (conception du compte par passkey §15). Message fixe, sans chemin.
var ErrBaseEmail = errors.New("comptes.db contient des comptes par e-mail (schéma 1 ou 2, retiré le 22 novembre) : " +
	"refus d'ouvrir ; la sauvegarder, puis la retirer à la main si ces comptes ne servent plus")

// OuvrirBase ouvre (ou crée) comptes.db : fichier créé en 0600 avant SQLite, droits resserrés
// (base, -wal, -shm), mêmes PRAGMA que shares.db, une seule connexion, schéma exact. Une base
// d'une version plus récente n'est pas touchée ; une base de schéma 1 ou 2 sans compte est
// recréée, avec des comptes refusée (ErrBaseEmail). chemin : absolu, sans « ? », « # » ni « % »
// (SHH_DATA_DIR, vérifié par config).
func OuvrirBase(chemin string) (*sql.DB, error) {
	f, err := os.OpenFile(chemin, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	if err := serrer(chemin); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+chemin+"?"+store.Pragmas)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		db.Close()
		return nil, fmt.Errorf("lecture de la version de comptes.db : %w", err)
	}
	if v > VersionBase {
		db.Close()
		return nil, ErrBasePlusRecente
	}
	if v == 1 || v == 2 {
		if err := retirerSchemaEmail(db); err != nil {
			db.Close()
			if errors.Is(err, ErrBaseEmail) {
				return nil, err
			}
			return nil, fmt.Errorf("retrait du schéma 2 de comptes.db : %w", err)
		}
	}
	if _, err := db.Exec(schemaComptes); err != nil {
		db.Close()
		return nil, fmt.Errorf("création du schéma de comptes.db : %w", err)
	}
	if _, err := db.Exec(fmt.Sprintf(`PRAGMA user_version=%d`, VersionBase)); err != nil {
		db.Close()
		return nil, err
	}
	if err := serrer(chemin); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// retirerSchemaEmail : base de schéma 1 ou 2. Un compte au moins : ErrBaseEmail, rien n'est
// touché. Aucun compte : les tables de l'ancien schéma (et leurs index) sont effacées dans une
// transaction (pages écrasées : secure_delete) ; sessions et bannissements d'une base sans
// compte ne désignent plus personne qui puisse se connecter.
func retirerSchemaEmail(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='comptes'`).Scan(&n); err != nil {
		return err
	}
	if n == 1 {
		if err := db.QueryRow(`SELECT count(*) FROM comptes`).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return ErrBaseEmail
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	for _, t := range []string{"sessions", "bannis", "comptes"} {
		if _, err := tx.Exec(`DROP TABLE IF EXISTS ` + t); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// serrer : base et annexes en 0600 (SQLite crée -wal et -shm avec les droits de la base).
func serrer(chemin string) error {
	for _, f := range []string{chemin, chemin + "-wal", chemin + "-shm"} {
		if err := os.Chmod(f, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

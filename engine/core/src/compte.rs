//! Compte sur l'appareil. Compte par passkey et clé de récupération (conception
//! `2026-11-22-compte-passkey-design.md` §5) : clé maîtresse `K_compte` (32 octets aléatoires
//! tirés par l'appareil), enveloppée une fois par passkey qui offre PRF (`KEK_i` tirée de la
//! sortie PRF) et une fois par la clé de récupération `R` (`KEK_r`) ; `A_r` et son empreinte
//! `v_r` (seule donnée de récupération gardée par le serveur) ; clés des deux coffres et des
//! libellés, toutes tirées de `K_compte` (plus de séquestre) ; texte de la clé de récupération
//! (base32 de Crockford et caractère de contrôle) ; pseudo (`texte`).
//!
//! Aucune construction nouvelle : HKDF-SHA-256 à sel vide et SHA-256 de `kdf` (RustCrypto). Les
//! enveloppes et les coffres (AES-256-GCM) sont faits par le site avec WebCrypto et par les apps
//! avec RustCrypto (`native`, `platform::Key`), à partir des clés et des données authentifiées
//! rendues ici ; leur format est prouvé par `engine/vectors/compte-v3.json`. Rien ici ne dépend
//! du navigateur : l'aléa (`K_compte`, `R`, nonces) vient de la plateforme.
//!
//! `v2` : compte par e-mail, gelé, retiré au lot W1 du plan (voir son en-tête).
use crate::error::{Error, Result};
use crate::kdf::{hkdf, sha256};
use zeroize::Zeroizing;

pub mod v2;

pub use crate::texte::{PSEUDO_MAX, PSEUDO_MIN, pseudo_canon, pseudo_valide};

/// Clé de 32 octets, effacée à la destruction.
pub type Cle = Zeroizing<[u8; 32]>;

/// Pseudos réservés, comparés sur leur forme canonique (`pseudo_canon`) : liste de la conception
/// §21.5, plus les formes accentuées des mots français (« Modérateur » n'a pas la forme
/// canonique de « moderateur » : les marques restent).
pub const PSEUDOS_RESERVES: [&str; 18] = [
    "shhgone",
    "shhdrop",
    "admin",
    "administrateur",
    "moderateur",
    "moderation",
    "support",
    "aide",
    "equipe",
    "officiel",
    "systeme",
    "securite",
    "contact",
    "modérateur",
    "modération",
    "équipe",
    "système",
    "sécurité",
];

/// `K_prive` = HKDF(`K_compte`, « shhdrop/v2/compte/blob ») : clé du coffre privé « SHH-ACCT1 ».
pub fn cle_prive(k_compte: &[u8; 32]) -> Cle {
    hkdf::<32>(k_compte, "shhdrop/v2/compte/blob")
}

/// `K_etiquette` = HKDF(`K_compte`, « shhdrop/v2/compte/appareil ») : nom d'appareil d'une
/// session, et libellé d'une passkey (même format, conception compte par passkey §5.1).
pub fn cle_appareil(k_compte: &[u8; 32]) -> Cle {
    hkdf::<32>(k_compte, "shhdrop/v2/compte/appareil")
}

/// Vrai si la forme canonique `canon` est celle d'un pseudo réservé.
pub fn pseudo_reserve(canon: &str) -> bool {
    PSEUDOS_RESERVES.iter().any(|w| pseudo_canon(w) == canon)
}

// ---------------------------------------------------------------------------------------------
// Compte par passkey (conception 2026-11-22-compte-passkey-design.md §5.1)
// ---------------------------------------------------------------------------------------------

/// Enveloppe de `K_compte` : nonce (12) ‖ AES-256-GCM(KEK, nonce, `K_compte`, AD) (32 + 16).
pub const ENVELOPPE_LEN: usize = 60;
/// Identifiant de passkey le plus long (WebAuthn niveau 3 : 1 023 octets).
pub const CRED_ID_MAX: usize = 1023;
/// Clé de récupération `R` : 16 octets (128 bits).
pub const RECUP_LEN: usize = 16;
/// Texte de `R` : 26 caractères de base32 de Crockford et 1 caractère de contrôle.
pub const RECUP_TEXTE_LEN: usize = 27;

/// Magie des données authentifiées des enveloppes de `K_compte` (v3).
const MAGIE_ENVELOPPE: &[u8; 9] = b"SHH-CENV2";
/// Base32 de Crockford (valeurs 0 à 31), puis ses symboles de contrôle propres (32 à 36).
const CROCKFORD: &[u8; 37] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U";
/// Taille des groupes affichés (6 groupes de 4, puis 3).
const GROUPE: usize = 4;
/// Au-delà (en octets), une saisie est refusée sans être lue (aucun travail sur un collage géant).
const SAISIE_MAX: usize = 1024;

/// `E_prf` = SHA-256(« shhdrop/v3/compte/prf/1 ») : entrée PRF publique et fixe, envoyée dans
/// `prf.eval.first` (le « /1 » permet une rotation).
pub fn entree_prf() -> [u8; 32] {
    sha256(b"shhdrop/v3/compte/prf/1")
}

/// `sel_prf` = SHA-256(« WebAuthn PRF » ‖ 0x00 ‖ `E_prf`) : ce que l'authentificateur reçoit en
/// `hmac-secret` (WebAuthn niveau 3, calcul fait par le navigateur). Pour les API natives qui
/// attendraient le sel brut (conception §10.1, R5).
pub fn sel_prf() -> [u8; 32] {
    let mut m = [0u8; 13 + 32];
    m[..13].copy_from_slice(b"WebAuthn PRF\0");
    m[13..].copy_from_slice(&entree_prf());
    sha256(&m)
}

/// `KEK_i` = HKDF(`P_i`, « shhdrop/v3/compte/enveloppe/prf ») : clé AES-256-GCM de l'enveloppe
/// de la passkey `i`, tirée de sa sortie PRF `P_i` (32 octets).
pub fn kek_prf(sortie_prf: &[u8; 32]) -> Cle {
    hkdf::<32>(sortie_prf, "shhdrop/v3/compte/enveloppe/prf")
}

/// AD de l'enveloppe PRF : « SHH-CENV2 » ‖ `h` ‖ SHA-256(`cred_id`) (57 octets) ; lie
/// l'enveloppe à son compte et à sa passkey. `cred_id_invalide` : vide ou plus de 1 023 octets.
pub fn ad_enveloppe_prf(h: &[u8; 16], cred_id: &[u8]) -> Result<Vec<u8>> {
    if cred_id.is_empty() || cred_id.len() > CRED_ID_MAX {
        return Err(Error::CredIdInvalide);
    }
    Ok([MAGIE_ENVELOPPE.as_slice(), h, &sha256(cred_id)].concat())
}

/// AD de l'enveloppe de récupération : « SHH-CENV2 » ‖ `h` ‖ « recup » (30 octets).
pub fn ad_enveloppe_recup(h: &[u8; 16]) -> Vec<u8> {
    [MAGIE_ENVELOPPE.as_slice(), h, b"recup"].concat()
}

/// `K_profil` = HKDF(`K_compte`, « shhdrop/v3/compte/profil ») : clé du coffre de profil
/// « SHH-PROF1 » (format inchangé). Remplace la clé tirée de `s_profil` (`v2::cle_profil`,
/// séquestre retiré, conception §8, Q3) : le serveur ne peut plus lire le profil.
pub fn cle_profil(k_compte: &[u8; 32]) -> Cle {
    hkdf::<32>(k_compte, "shhdrop/v3/compte/profil")
}

/// Clé de récupération `R` (16 octets aléatoires tirés par l'appareil), effacée à la destruction.
/// Texte : 26 caractères de base32 de Crockford (128 bits, les 2 bits de bourrage de fin à zéro)
/// puis le symbole de contrôle de Crockford de la valeur de `R` (entier gros-boutiste) mod 37.
pub struct CleRecup(Zeroizing<[u8; RECUP_LEN]>);

impl CleRecup {
    /// Prend `R`, tirée par l'aléa de la plateforme (`crypto.getRandomValues`, système).
    pub fn new(r: Zeroizing<[u8; RECUP_LEN]>) -> Self {
        Self(r)
    }

    /// Les 16 octets de `R`.
    pub fn octets(&self) -> &[u8; RECUP_LEN] {
        &self.0
    }

    /// Texte sans séparateur, 27 caractères.
    pub fn texte(&self) -> Zeroizing<String> {
        let r = &*self.0;
        let mut t = Zeroizing::new(String::with_capacity(RECUP_TEXTE_LEN));
        let (mut acc, mut nb) = (0u16, 0u32);
        for &b in r {
            acc = (acc << 8) | u16::from(b);
            nb += 8;
            while nb >= 5 {
                nb -= 5;
                t.push(char::from(CROCKFORD[usize::from((acc >> nb) & 31)]));
            }
            acc &= (1 << nb) - 1;
        }
        // 128 = 25 × 5 + 3 : restent 3 bits, suivis de 2 bits de bourrage nuls.
        debug_assert_eq!(nb, 3);
        t.push(char::from(CROCKFORD[usize::from((acc << 2) & 31)]));
        t.push(char::from(CROCKFORD[usize::from(controle(r))]));
        t
    }

    /// Texte affiché : groupes de 4 séparés par « - » (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX`).
    pub fn affichage(&self) -> Zeroizing<String> {
        let t = self.texte();
        let mut a = Zeroizing::new(String::with_capacity(RECUP_TEXTE_LEN + 6));
        for (i, c) in t.chars().enumerate() {
            if i > 0 && i % GROUPE == 0 {
                a.push('-');
            }
            a.push(c);
        }
        a
    }

    /// Lit une saisie : blancs (Unicode) et tirets (« - », U+2010 à U+2014, U+2212) retirés,
    /// minuscules acceptées, `I`/`L` lus `1`, `O` lu `0`. Erreurs, dans cet ordre :
    /// `cle_recup_longueur` (pas 27 caractères), `cle_recup_caractere` (hors alphabet ; `U` et
    /// `*~$=` seulement en dernière position), `cle_recup_controle` (bourrage non nul ou contrôle
    /// faux). Contrôle local, avant tout appel au serveur.
    pub fn lire(saisie: &str) -> Result<Self> {
        if saisie.len() > SAISIE_MAX {
            return Err(Error::CleRecupLongueur);
        }
        // Deux passages sans copie de la saisie : longueur d'abord (ordre des erreurs), puis valeurs.
        let net = || {
            saisie
                .chars()
                .filter(|c| !c.is_whitespace() && !est_tiret(*c))
        };
        if net().count() != RECUP_TEXTE_LEN {
            return Err(Error::CleRecupLongueur);
        }
        let mut v = Zeroizing::new([0u8; RECUP_TEXTE_LEN]);
        for (i, c) in net().enumerate() {
            let x = valeur(c).ok_or(Error::CleRecupCaractere)?;
            if i < RECUP_TEXTE_LEN - 1 && x >= 32 {
                return Err(Error::CleRecupCaractere);
            }
            v[i] = x;
        }
        let mut r = Zeroizing::new([0u8; RECUP_LEN]);
        let (mut acc, mut nb, mut o) = (0u16, 0u32, 0usize);
        for &x in &v[..RECUP_TEXTE_LEN - 1] {
            acc = (acc << 5) | u16::from(x);
            nb += 5;
            if nb >= 8 {
                nb -= 8;
                r[o] = (acc >> nb) as u8;
                o += 1;
                acc &= (1 << nb) - 1;
            }
        }
        // Restent les 2 bits de bourrage : nuls, sinon le texte n'est celui d'aucune clé.
        debug_assert!(o == RECUP_LEN && nb == 2);
        if acc != 0 || controle(&r) != v[RECUP_TEXTE_LEN - 1] {
            return Err(Error::CleRecupControle);
        }
        Ok(Self(r))
    }

    /// `A_r` = HKDF(`R`, « shhdrop/v3/compte/recup/acces ») : envoyé à `recup`, jamais gardé.
    pub fn acces(&self) -> Cle {
        hkdf::<32>(&*self.0, "shhdrop/v3/compte/recup/acces")
    }

    /// `v_r` = SHA-256(`A_r`) : seule empreinte gardée par le serveur (index unique).
    pub fn verificateur(&self) -> [u8; 32] {
        sha256(&*self.acces())
    }

    /// `KEK_r` = HKDF(`R`, « shhdrop/v3/compte/recup/enveloppe ») : clé de l'enveloppe `Env_r`.
    pub fn kek(&self) -> Cle {
        hkdf::<32>(&*self.0, "shhdrop/v3/compte/recup/enveloppe")
    }
}

/// Tirets acceptés comme séparateurs (collage depuis un traitement de texte ou un PDF).
fn est_tiret(c: char) -> bool {
    matches!(c, '-' | '\u{2010}'..='\u{2014}' | '\u{2212}')
}

/// Valeur d'un caractère saisi (0 à 36), ou `None` hors alphabet.
fn valeur(c: char) -> Option<u8> {
    let c = match c.to_ascii_uppercase() {
        'I' | 'L' => '1',
        'O' => '0',
        x => x,
    };
    if !c.is_ascii() {
        return None;
    }
    CROCKFORD
        .iter()
        .position(|&x| char::from(x) == c)
        .and_then(|p| u8::try_from(p).ok())
}

/// Valeur de `R` (entier gros-boutiste) mod 37.
fn controle(r: &[u8; RECUP_LEN]) -> u8 {
    // a < 37 : (a × 256 + 255) < 2^16, jamais de débordement.
    r.iter().fold(0u16, |a, &b| ((a << 8) | u16::from(b)) % 37) as u8
}

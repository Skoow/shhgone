//! Dérivations (spec §29.2 du site) : HKDF-SHA-256 à sel vide, SHA-256, K_accès et V_accès,
//! K_mdp = Argon2id (v0x13, 3 passes, 64 Mio, 1 fil, 32 octets) sur le mot de passe NFC, sans
//! ses blancs ASCII de bord.
//! Remplace `web/src/crypto/kdf.ts`, avec les mêmes messages d'erreur.
use crate::error::{Error, Result};
use crate::keys::{KAcces, KLien, KMdp};
use crate::password::is_generated;
use zeroize::Zeroizing;

/// Paramètres Argon2id : `ops` passes, `mem` octets de mémoire (comme libsodium).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub ops: u32,
    pub mem: u32,
}

/// Minimum accepté, même proposé par le serveur.
pub const KDF_MIN: KdfParams = KdfParams {
    ops: 3,
    mem: 67_108_864,
};
/// Plafond accepté du serveur : un serveur compromis ne fait pas allouer 256 Mio.
pub const KDF_MAX: KdfParams = KDF_MIN;
/// Paramètres des nouveaux partages, imposés par `password_key_for_create`.
pub const KDF_CREATE: KdfParams = KDF_MIN;

/// K_accès et son empreinte V_accès = SHA-256(K_accès), donnée au serveur.
pub struct AccessKeys {
    pub k_acces: KAcces,
    pub v_acces: [u8; 32],
}

/// SHA-256 (empreintes : V_accès, V_preuve).
pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(data).into()
}

/// SHA-256 par morceaux (empreinte d'un fichier affichée à l'envoi) : un fichier de
/// 2 Go est lu tranche par tranche, jamais entier en mémoire. Même résultat que [`sha256`] sur
/// la concaténation des tranches. Fonction « empreinte » : seul le moteur des partages l'active
/// (le module du salon reste sous son plafond de poids).
#[cfg(feature = "empreinte")]
#[derive(Default)]
pub struct Sha256Stream(sha2::Sha256);

#[cfg(feature = "empreinte")]
impl Sha256Stream {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn update(&mut self, chunk: &[u8]) {
        use sha2::Digest;
        self.0.update(chunk);
    }
    pub fn finish(self) -> [u8; 32] {
        use sha2::Digest;
        self.0.finalize().into()
    }
}

/// HKDF-SHA-256 à sel vide (RFC 5869 : équivaut à un sel de 32 zéros), `N` octets.
///
/// La longueur est un paramètre de type : `N` au-delà de 255 × 32 = 8 160 octets (où HKDF
/// n'est pas défini) est refusé à la compilation, donc l'appel ne peut pas échouer :
///
/// ```compile_fail
/// let _ = shhdrop_core::kdf::hkdf::<8161>(b"", "");
/// ```
pub fn hkdf<const N: usize>(ikm: &[u8], info: &str) -> Zeroizing<[u8; N]> {
    const { assert!(N > 0 && N <= 255 * 32, "HKDF-SHA-256 : 1 à 8 160 octets") };
    let mut okm = Zeroizing::new([0u8; N]);
    // `expand` n'échoue que pour une longueur hors de 1..=8 160, exclue ci-dessus.
    let _ = hkdf::Hkdf::<sha2::Sha256>::new(None, ikm).expand(info.as_bytes(), &mut *okm);
    okm
}

/// Bornes des paramètres Argon2id lus sur le serveur : au-dessus du plafond, « invalides » ;
/// en dessous du minimum, « trop faibles » (même ordre que `checkKdfParams`).
pub fn check_kdf_params(ops: u32, mem: u32) -> Result<()> {
    if ops > KDF_MAX.ops || mem > KDF_MAX.mem {
        return Err(Error::KdfInvalides);
    }
    if ops < KDF_MIN.ops || mem < KDF_MIN.mem {
        return Err(Error::KdfTropFaibles);
    }
    Ok(())
}

/// K_accès = HKDF(K_lien, « shhdrop/v2/acces »), V_accès = SHA-256(K_accès).
pub fn derive_access(k_lien: &KLien) -> AccessKeys {
    let bytes = hkdf::<32>(k_lien.as_bytes(), "shhdrop/v2/acces");
    let v_acces = sha256(&*bytes);
    AccessKeys {
        k_acces: KAcces::from_bytes(*bytes),
        v_acces,
    }
}

/// Argon2id v0x13, 1 fil, sortie de 32 octets, sur des octets déjà prêts (mot de passe NFC en
/// UTF-8). Vérifie le sel (16 octets) et les paramètres (`check_kdf_params`). Les 64 Mio de
/// travail sont mis à zéro avant d'être rendus (la crate `argon2` ne le fait pas elle-même).
pub fn argon2id(pw: &[u8], salt: &[u8], ops: u32, mem: u32) -> Result<Zeroizing<[u8; 32]>> {
    use argon2::{Algorithm, Argon2, Block, Params, Version};
    if salt.len() != 16 {
        return Err(Error::TailleInvalide);
    }
    check_kdf_params(ops, mem)?;
    // Paramètres bornés ci-dessus : 3 passes, 65 536 Kio, toujours acceptés par la crate.
    let params = Params::new(mem / 1024, ops, 1, Some(32)).map_err(|_| Error::KdfInvalides)?;
    let blocks = params.block_count();
    let mut memory = Zeroizing::new(Vec::<Block>::new());
    // Mémoire refusée : une erreur, pas un arrêt brutal.
    memory
        .try_reserve_exact(blocks)
        .map_err(|_| Error::Argon2Echec)?;
    memory.resize(blocks, Block::new());
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into_with_memory(pw, salt, &mut *out, &mut memory[..])
        .map_err(|_| Error::Argon2Echec)?;
    Ok(out)
}

/// Blancs ASCII retirés en début et en fin du mot de passe saisi (D42-21) : espace, tabulation, retour chariot, saut de ligne. Un mot de passe
/// collé avec un blanc en bord n'est pas un essai raté. Les blancs intérieurs et les blancs non
/// ASCII (espace insécable…) sont gardés ; un mot de passe généré n'en a aucun.
pub fn trim_password(pw: &str) -> &str {
    pw.trim_matches([' ', '\t', '\r', '\n'])
}

/// K_mdp = Argon2id(mot de passe NFC, sel) pour OUVRIR un partage (paramètres lus sur le
/// serveur, bornés par `check_kdf_params`). Blancs ASCII en bord retirés d'abord
/// ([`trim_password`]), puis tout mot de passe non vide est accepté : il a été choisi à la
/// création.
pub fn password_key(pw: &str, salt: &[u8], ops: u32, mem: u32) -> Result<KMdp> {
    use unicode_normalization::UnicodeNormalization;
    let pw = trim_password(pw);
    if pw.is_empty() {
        return Err(Error::MotDePasseVide);
    }
    if salt.len() != 16 {
        return Err(Error::TailleInvalide);
    }
    check_kdf_params(ops, mem)?;
    // NFC : un même mot de passe saisi sur des claviers différents donne la même clé. Capacité
    // réservée d'avance (NFC grossit au plus ×3 en UTF-8) : aucune réallocation ne laisse de
    // copie non effacée.
    let mut nfc = Zeroizing::new(String::with_capacity(pw.len().saturating_mul(3)));
    nfc.extend(pw.nfc());
    let k = argon2id(nfc.as_bytes(), salt, ops, mem)?;
    Ok(KMdp::from_bytes(*k))
}

/// Étiquette HKDF de la clé qui tient la place de K_mdp dans un partage sans mot de passe (D42-28).
pub const NO_PASSWORD_INFO: &str = "shhdrop/v2/sans-mdp";

/// Partage **sans mot de passe** (D42-28, spec §29.2) : K_sans = HKDF(K_lien,
/// « shhdrop/v2/sans-mdp »), 32 octets, tient la place de K_mdp. Le reste de la chaîne est
/// inchangé (K_maître = HKDF(K_lien ‖ K_sans, « shhdrop/v2/maitre »), K_env, K_preuve, E) :
/// le serveur reçoit les mêmes champs, de mêmes tailles, qu'avec un mot de passe, et ne peut pas
/// distinguer les deux sortes de partage. Aucun Argon2id : il n'y a rien à ralentir, le secret
/// est K_lien (256 bits, aléatoire). L'information « sans mot de passe » ne vit que dans le
/// fragment du lien (`#l…`, §32), jamais envoyé.
pub fn no_password_key(k_lien: &KLien) -> KMdp {
    KMdp::from_bytes(*hkdf::<32>(k_lien.as_bytes(), NO_PASSWORD_INFO))
}

/// K_mdp pour CRÉER un partage : seulement un mot de passe de la forme de `generate`
/// (D41-15), paramètres imposés à KDF_CREATE.
pub fn password_key_for_create(pw: &str, salt: &[u8]) -> Result<KMdp> {
    if !is_generated(pw) {
        return Err(Error::MotDePasseNonGenere);
    }
    password_key(pw, salt, KDF_CREATE.ops, KDF_CREATE.mem)
}

/// Cas de `web/src/crypto/kdf.test.ts`, portés un par un. Sans objet en Rust : `randomBytes`
/// (aléa fourni par la plateforme), paramètres non entiers, NaN ou infinis (`u32`),
/// K_lien de 31 ou 33 octets (le type `KLien` a 32 octets).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::password::generate;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// Par morceaux = d'un bloc, quelle que soit la découpe ; vecteurs FIPS 180-2 (vide, « abc »,
    /// un million de « a »).
    #[cfg(feature = "empreinte")]
    #[test]
    fn sha256_par_morceaux() {
        let cas: [(&[u8], &str); 2] = [
            (
                b"",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                b"abc",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
        ];
        for (data, want) in cas {
            let mut h = Sha256Stream::new();
            for b in data.chunks(1) {
                h.update(b);
            }
            assert_eq!(hex(&h.finish()), want);
            assert_eq!(hex(&sha256(data)), want);
        }
        let million = vec![b'a'; 1_000_000];
        for taille in [1usize, 7, 4096, 65_536, 1_000_000] {
            let mut h = Sha256Stream::new();
            for b in million.chunks(taille) {
                h.update(b);
            }
            assert_eq!(
                hex(&h.finish()),
                "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
                "tranches de {taille}"
            );
        }
    }

    const SALT: [u8; 16] = [7; 16];
    const M: u32 = KDF_MIN.mem;

    fn pk(pw: &str, salt: &[u8], p: KdfParams) -> Result<String> {
        password_key(pw, salt, p.ops, p.mem).map(|k| hex(k.as_bytes()))
    }

    fn err(r: Result<impl core::fmt::Debug>) -> String {
        r.expect_err("erreur attendue").to_string()
    }

    #[test]
    fn hkdf_rfc5869_cas_3() {
        let okm = hkdf::<42>(&[0x0b; 22], "");
        assert_eq!(
            hex(&*okm),
            "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
        );
    }

    #[test]
    fn hkdf_32_octets() {
        assert_eq!(hkdf::<32>(&[1; 32], "x").len(), 32);
    }

    #[test]
    fn sha256_abc() {
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn derive_access_ne_depend_que_de_k_lien() {
        let a = derive_access(&KLien::from_bytes([1; 32]));
        assert_eq!(a.v_acces, sha256(a.k_acces.as_bytes()));
        let b = derive_access(&KLien::from_bytes([1; 32]));
        assert_eq!(b.k_acces.as_bytes(), a.k_acces.as_bytes());
        let c = derive_access(&KLien::from_bytes([2; 32]));
        assert_ne!(c.k_acces.as_bytes(), a.k_acces.as_bytes());
    }

    /// K_sans ne dépend que de K_lien, diffère de K_accès (autre étiquette) et vaut le HKDF écrit
    /// à la main (étiquette exacte, sel vide).
    #[test]
    fn no_password_key_separee_par_etiquette() {
        let kl = KLien::from_bytes([1; 32]);
        let a = no_password_key(&kl);
        assert_eq!(a.as_bytes(), &*hkdf::<32>(&[1; 32], "shhdrop/v2/sans-mdp"));
        assert_eq!(
            no_password_key(&KLien::from_bytes([1; 32])).as_bytes(),
            a.as_bytes()
        );
        assert_ne!(
            no_password_key(&KLien::from_bytes([2; 32])).as_bytes(),
            a.as_bytes()
        );
        assert_ne!(derive_access(&kl).k_acces.as_bytes(), a.as_bytes());
    }

    #[test]
    fn password_key_refuse_parametres_trop_faibles() {
        let weak = "paramètres KDF trop faibles";
        assert_eq!(err(pk("pw", &SALT, KdfParams { ops: 2, mem: M })), weak);
        let half = KdfParams {
            ops: 3,
            mem: 33_554_432,
        };
        assert_eq!(err(pk("pw", &SALT, half)), weak);
    }

    #[test]
    fn password_key_deterministe_et_sensible() {
        let a = pk("motdepasse", &SALT, KDF_MIN).unwrap();
        let b = pk("motdepasse", &SALT, KDF_MIN).unwrap();
        let c = pk("motdepassf", &SALT, KDF_MIN).unwrap();
        let d = pk("motdepasse", &[8; 16], KDF_MIN).unwrap();
        assert_eq!(a.len(), 64);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }

    #[test]
    fn password_key_nfc() {
        let composed = "Caf\u{e9}-\u{c9}t\u{e9}";
        let decomposed = "Cafe\u{301}-E\u{301}te\u{301}";
        assert_ne!(composed, decomposed);
        assert_eq!(
            pk(composed, &SALT, KDF_MIN).unwrap(),
            pk(decomposed, &SALT, KDF_MIN).unwrap()
        );
    }

    #[test]
    fn check_kdf_params_bornes_exactes() {
        let ok = |ops, mem| check_kdf_params(ops, mem).map_err(|e| e.to_string());
        assert_eq!(ok(KDF_MIN.ops, KDF_MIN.mem), Ok(()));
        assert_eq!(ok(KDF_MAX.ops, KDF_MAX.mem), Ok(()));
        let weak = Err("paramètres KDF trop faibles".to_owned());
        assert_eq!(ok(2, M), weak);
        assert_eq!(ok(3, M - 1), weak);
        assert_eq!(ok(0, 0), weak);
        // plafond = paramètres de création.
        assert_eq!(KDF_MAX, KDF_CREATE);
        let bad = Err("paramètres KDF invalides".to_owned());
        assert_eq!(ok(4, M), bad);
        assert_eq!(ok(3, M + 1), bad);
        assert_eq!(ok(10, 268_435_456), bad);
        assert_eq!(ok(u32::MAX, u32::MAX), bad);
        // Au-dessus d'un côté, en dessous de l'autre : « invalides » d'abord, comme en TS.
        assert_eq!(ok(2, M + 1), bad);
        assert_eq!(ok(4, M - 1), bad);
    }

    #[test]
    fn password_key_hors_bornes() {
        for p in [
            KdfParams { ops: 11, mem: M },
            KdfParams {
                ops: 3,
                mem: 268_435_457,
            },
        ] {
            assert_eq!(err(pk("pw", &SALT, p)), "paramètres KDF invalides");
        }
    }

    #[test]
    fn taille_du_sel() {
        let msg = "clé ou sel de taille invalide";
        assert_eq!(err(pk("pw", &[0; 15], KDF_MIN)), msg);
        assert_eq!(err(pk("pw", &[0; 17], KDF_MIN)), msg);
        assert_eq!(err(pk("pw", &[], KDF_MIN)), msg);
        assert_eq!(err(argon2id(b"pw", &[0; 15], 3, M)), msg);
    }

    #[test]
    fn argon2id_borne_ses_parametres() {
        assert_eq!(
            err(argon2id(b"pw", &SALT, 2, M)),
            "paramètres KDF trop faibles"
        );
        assert_eq!(
            err(argon2id(b"pw", &SALT, 3, M + 1)),
            "paramètres KDF invalides"
        );
    }

    #[test]
    fn password_key_refuse_le_vide() {
        assert_eq!(err(pk("", &SALT, KDF_MIN)), "mot_de_passe_vide");
        // Le vide passe avant la taille du sel et les paramètres, comme en TS.
        assert_eq!(
            err(pk("", &[0; 3], KdfParams { ops: 0, mem: 0 })),
            "mot_de_passe_vide"
        );
    }

    /// Un mot de passe collé avec un blanc ASCII en
    /// bord (espace, tabulation, retour chariot, saut de ligne) donne la même clé que sans.
    #[test]
    fn password_key_ignore_les_blancs_ascii_en_bord() {
        let k = pk("aC3!cD5?#Fg", &SALT, KDF_MIN).unwrap();
        for pw in [" aC3!cD5?#Fg", "aC3!cD5?#Fg\n", "\t aC3!cD5?#Fg \r\n"] {
            assert_eq!(pk(pw, &SALT, KDF_MIN).unwrap(), k, "{pw:?}");
        }
        // Blancs intérieurs, blancs non ASCII (espace insécable, espace fine) : gardés.
        for pw in ["aC3! cD5?#Fg", "\u{a0}aC3!cD5?#Fg", "aC3!cD5?#Fg\u{202f}"] {
            assert_ne!(pk(pw, &SALT, KDF_MIN).unwrap(), k, "{pw:?}");
        }
        // Rien que des blancs : même refus que le vide, avant le sel et les paramètres.
        for pw in [" ", "\n", " \t\r\n "] {
            assert_eq!(
                err(pk(pw, &[0; 3], KdfParams { ops: 0, mem: 0 })),
                "mot_de_passe_vide",
                "{pw:?}"
            );
        }
        // Création : la forme exacte reste exigée (un mot de passe généré n'a aucun blanc).
        assert_eq!(
            err(password_key_for_create(" aC3!cD5?#Fg", &SALT)),
            "mot_de_passe_non_genere"
        );
    }

    #[test]
    fn password_key_for_create_seulement_genere() {
        for pw in [
            "",
            "court-crt",
            "aB3!aB3!",
            "unbelievable",
            "cheval-agrafe-pile-correct",
            "Tigre-Velours-92-Brume",
        ] {
            assert_eq!(
                err(password_key_for_create(pw, &SALT)),
                "mot_de_passe_non_genere",
                "{pw}"
            );
        }
        let mut n = 0u8;
        let g = generate(&mut |buf: &mut [u8]| {
            for b in buf {
                n = n.wrapping_add(37);
                *b = n;
            }
            Ok(())
        })
        .unwrap();
        assert!(is_generated(&g));
        let a = password_key_for_create(&g, &SALT).unwrap();
        assert_eq!(hex(a.as_bytes()), pk(&g, &SALT, KDF_CREATE).unwrap());
        assert_eq!(KDF_CREATE, KDF_MIN);
    }

    #[test]
    fn anciens_alphabets_acceptes_a_l_ouverture() {
        for old in ["ij:K7m;X2p", "ta-Gq3k6zp", "K7m4 · Xq2p · 9r"] {
            assert_eq!(pk(old, &SALT, KDF_MIN).unwrap().len(), 64, "{old}");
        }
    }
}

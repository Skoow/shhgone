//! Format du paquet v2, comme `crypto/container.ts` (spec §29.3, §7.3) : en-tête en clair
//! « SHH2 » puis morceaux AES-256-GCM façon STREAM. Clair de B morceaux : données des éléments
//! (à partir de l'octet 0) ‖ zéros ‖ manifeste ‖ longueur du manifeste (4 octets, gros-boutiste)
//! en toute fin. Paliers, tailles de segment, en-tête et nonces ; le manifeste est dans
//! `manifest`.
use crate::error::{Error, Result};
use crate::platform::{NONCE_LEN, TAG_LEN};
use subtle::ConstantTimeEq;

/// Octets de clair d'un morceau.
pub const CHUNK: usize = 65_536;
pub const TAG: usize = TAG_LEN;
/// Octets d'un morceau chiffré (clair + tag).
pub const CHUNK_CT: usize = CHUNK + TAG;
/// En-tête en clair du segment 0.
pub const HEADER: usize = 48;
/// Morceaux par segment.
pub const SEG_CHUNKS: u32 = 64;
/// Paliers gratuits en morceaux (spec §24, §29.3, §41.2) : chacun garde son dernier morceau pour
/// le manifeste ; le plus grand contient exactement 2 Gio de données plus ce morceau.
pub const BUCKETS: [u32; 11] = [1, 16, 80, 160, 400, 800, 1600, 4000, 8000, 16385, 32769];
/// Au-delà, pas d'aperçu sur le site : téléchargement en flux seulement (spec §24).
pub const PREVIEW_MAX: u64 = 200 * 1_048_576;
/// Taille maximale du manifeste : avec sa longueur (4 octets), il tient dans un morceau.
pub const MANIFEST_MAX: usize = 65_532;
const TAIL: u64 = 4 + MANIFEST_MAX as u64;
/// Octets de données au plus : exactement 2 Gio.
pub const CONTENT_MAX: u64 = BUCKETS[BUCKETS.len() - 1] as u64 * CHUNK as u64 - TAIL;
/// Éléments par partage au plus (D41-17).
pub const MAX_ITEMS: usize = 200;
/// Points de code d'une note au plus (D41-36).
pub const TEXT_MAX: usize = 100_000;
/// Octets UTF-8 d'une note au plus.
pub const TEXT_BYTES_MAX: u64 = 4 * TEXT_MAX as u64;
/// `Number.MAX_SAFE_INTEGER` (2^53 − 1) : plus grande taille ou position que l'ancien moteur
/// représentait exactement ; au-delà, refus comme avant.
pub const MAX_SAFE: u64 = (1 << 53) - 1;
const MAGIC: &[u8; 4] = b"SHH2";
const VERSION: u8 = 2;

/// Paliers payants en morceaux (spec §38.8.1 ; conception du paiement
/// §11) : 5 et 10 Gio (Plus et Pro), 20 et 30 Gio (Pro), chacun plus le morceau du manifeste.
/// Un partage payant a la même forme qu'un partage gratuit : seul le palier change.
pub const PAID_BUCKETS: [u32; 4] = [81_921, 163_841, 327_681, 491_521];

/// Formule d'un partage (le `tier` du serveur : 0 gratuit, 1 Plus, 2 Pro). Elle ne change que le
/// plus grand palier permis ; aucune sécurité de plus ni de moins (spec §38.9.0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Palier {
    Gratuit,
    Plus,
    Pro,
}

impl Palier {
    /// 0 gratuit, 1 Plus, 2 Pro ; sinon `None`.
    pub const fn de(n: u8) -> Option<Self> {
        match n {
            0 => Some(Self::Gratuit),
            1 => Some(Self::Plus),
            2 => Some(Self::Pro),
            _ => None,
        }
    }
    /// Plus grand palier permis.
    pub const fn max_bucket(self) -> u32 {
        match self {
            Self::Gratuit => BUCKETS[BUCKETS.len() - 1],
            Self::Plus => PAID_BUCKETS[1],
            Self::Pro => PAID_BUCKETS[3],
        }
    }
    /// Octets de données au plus : 2, 10 ou 30 Gio exactement.
    pub const fn content_max(self) -> u64 {
        self.max_bucket() as u64 * CHUNK as u64 - TAIL
    }
}

/// Tout palier connu (gratuit ou payant), dans l'ordre croissant.
pub fn all_buckets() -> impl Iterator<Item = u32> {
    BUCKETS.into_iter().chain(PAID_BUCKETS)
}

/// Palier connu (gratuit ou payant) : un lecteur accepte les deux.
pub fn is_bucket(b: u32) -> bool {
    all_buckets().any(|x| x == b)
}

/// Palier canonique : le plus petit palier de capacité ≥ fin des données + 4 + MANIFEST_MAX,
/// parmi les paliers gratuits (inchangé depuis la v2 : vecteurs figés).
pub fn bucket_for(data_end: u64) -> Result<u32> {
    bucket_for_palier(data_end, Palier::Gratuit)
}

/// Palier canonique d'une formule : le plus petit palier connu qui contient les données, au plus
/// `p.max_bucket()`. Le même pour toutes les formules qui le permettent : le lecteur le vérifie
/// sans connaître la formule (`bucket_for_palier(…, Pro)`).
pub fn bucket_for_palier(data_end: u64, p: Palier) -> Result<u32> {
    if data_end > MAX_SAFE {
        return Err(Error::TailleNonSure);
    }
    all_buckets()
        .filter(|&b| b <= p.max_bucket())
        .find(|&b| data_end + TAIL <= u64::from(b) * CHUNK as u64)
        .ok_or(Error::TropGros)
}

/// Segments d'un palier.
pub const fn segment_count(bucket: u32) -> u32 {
    bucket.div_ceil(SEG_CHUNKS)
}

/// Octets chiffrés du segment `n` (en-tête compris pour le segment 0) ; `None` hors palier
/// (`n ≥ segment_count(bucket)`), jamais une taille qu'un segment vide pourrait égaler.
pub fn segment_size(bucket: u32, n: u32) -> Option<usize> {
    if n >= segment_count(bucket) {
        return None;
    }
    let chunks = (bucket - n * SEG_CHUNKS).min(SEG_CHUNKS) as usize;
    Some((if n == 0 { HEADER } else { 0 }) + chunks * CHUNK_CT)
}

/// En-tête : « SHH2 », version 2, 11 octets nuls, engagement.
pub fn header(engagement: &[u8; 32]) -> [u8; HEADER] {
    let mut h = [0; HEADER];
    h[..4].copy_from_slice(MAGIC);
    h[4] = VERSION;
    h[16..].copy_from_slice(engagement);
    h
}

/// Lit l'en-tête en clair du segment 0 et son engagement. Rien n'est authentifié ici :
/// l'enveloppe (qui couvre l'en-tête) et l'engagement le sont ensuite.
pub fn read_header(seg0: &[u8]) -> Result<([u8; HEADER], [u8; 32])> {
    let h: [u8; HEADER] = seg0
        .get(..HEADER)
        .and_then(|s| s.try_into().ok())
        .ok_or(Error::PaquetCorrompu)?;
    let mut engagement = [0; 32];
    engagement.copy_from_slice(&h[16..]);
    let want = header(&engagement);
    if !bool::from(h[..16].ct_eq(&want[..16])) {
        return Err(Error::PaquetCorrompu);
    }
    Ok((h, engagement))
}

/// Nonce du morceau `index` : indice gros-boutiste sur 11 octets ‖ drapeau « dernier morceau ».
pub fn nonce(index: u64, last: bool) -> [u8; NONCE_LEN] {
    let mut iv = [0; NONCE_LEN];
    iv[3..11].copy_from_slice(&index.to_be_bytes());
    iv[11] = u8::from(last);
    iv
}

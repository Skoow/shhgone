//! Jetons anonymes des offres payantes (conception du paiement §7) : Privacy Pass, émission
//! RFC 9578 type 0x0002 (RSA aveugle publiquement vérifiable), RSABSSA-SHA384-PSS-Deterministic
//! (RFC 9474), module de 2 048 bits. Bibliothèque reconnue, version épinglée :
//! `blind-rsa-signatures` 0.19.0 (exception écrite dans les règles du projet).
//! Le serveur (Go) signe et vérifie avec `cloudflare/circl` ; vecteurs communs :
//! engine/vectors/privacypass.json.
//!
//! Formats (RFC 9578 §6) :
//! - défi `TokenChallenge` = type (2) ‖ longueur (2) ‖ issuer_name ‖ 0 (redemption_context vide,
//!   1) ‖ 0 (origin_info vide, 2) ; un même défi pour tous : les jetons se prennent d'avance ;
//! - `token_key_id` = SHA-256 de la clé publique SPKI (OID RSASSA-PSS) ;
//! - `TokenRequest` = type (2) ‖ dernier octet de `token_key_id` (1) ‖ message aveuglé (256) ;
//! - `TokenResponse` = signature aveugle (256) ;
//! - `Token` = type (2) ‖ nonce (32) ‖ SHA-256(défi) (32) ‖ `token_key_id` (32) ‖
//!   authentificateur (256), l'authentificateur signant les 98 premiers octets.
use crate::error::{Error, Result};
use blind_rsa_signatures::{
    BlindSignature, BlindingResult, DefaultRng, PublicKeySha384PSSDeterministic as Pk, Secret,
    Signature,
};
use rsa_rng::fill;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Type de jeton (RFC 9578 §6) et taille de l'authentificateur (Nk, 2 048 bits).
pub const TOKEN_TYPE: u16 = 0x0002;
pub const NK: usize = 256;
/// Longueurs exactes.
pub const REQUETE_LEN: usize = 2 + 1 + NK;
pub const JETON_LEN: usize = 2 + 32 + 32 + 32 + NK;
/// État gardé par l'appareil entre la demande et la réponse : nonce (32) ‖ facteur secret (256).
pub const ETAT_LEN: usize = 32 + NK;

mod rsa_rng {
    use blind_rsa_signatures::DefaultRng;
    /// Octets aléatoires du générateur de la bibliothèque (getrandom : `crypto.getRandomValues`
    /// dans le navigateur, le système ailleurs).
    pub fn fill(out: &mut [u8]) {
        use rand_core::TryRng as _;
        let Ok(()) = DefaultRng.try_fill_bytes(out);
    }
}

fn cle(spki: &[u8]) -> Result<Pk> {
    let pk = Pk::from_spki(spki).map_err(|_| Error::JetonInvalide)?;
    if pk.to_spki().map_err(|_| Error::JetonInvalide)? != spki {
        return Err(Error::JetonInvalide); // forme non canonique : un seul encodage par clé
    }
    if pk.components().n().len() != NK {
        return Err(Error::JetonInvalide);
    }
    Ok(pk)
}

/// `token_key_id` = SHA-256 de la clé publique SPKI.
pub fn cle_id(spki: &[u8]) -> [u8; 32] {
    Sha256::digest(spki).into()
}

/// Défi commun `TokenChallenge` (issuer_name : nom public du service, 1 à 255 octets ASCII).
pub fn defi(emetteur: &str) -> Result<Vec<u8>> {
    let e = emetteur.as_bytes();
    if e.is_empty() || e.len() > 255 || !e.iter().all(|b| b.is_ascii_graphic()) {
        return Err(Error::JetonInvalide);
    }
    let mut d = Vec::with_capacity(7 + e.len());
    d.extend_from_slice(&TOKEN_TYPE.to_be_bytes());
    d.extend_from_slice(&(e.len() as u16).to_be_bytes());
    d.extend_from_slice(e);
    d.push(0);
    d.extend_from_slice(&[0, 0]);
    Ok(d)
}

/// Entrée signée : type ‖ nonce ‖ SHA-256(défi) ‖ token_key_id.
fn entree(nonce: &[u8; 32], emetteur: &str, kid: &[u8; 32]) -> Result<Vec<u8>> {
    let mut m = Vec::with_capacity(98);
    m.extend_from_slice(&TOKEN_TYPE.to_be_bytes());
    m.extend_from_slice(nonce);
    m.extend_from_slice(&Sha256::digest(defi(emetteur)?));
    m.extend_from_slice(kid);
    Ok(m)
}

/// Demande d'un jeton : `TokenRequest` à envoyer, état à garder (secret) jusqu'à la réponse.
pub struct Demande {
    pub requete: Vec<u8>,
    pub etat: Zeroizing<Vec<u8>>,
}

/// Prépare une demande pour la clé `spki` (nonce et facteur d'aveuglement tirés ici).
pub fn preparer(spki: &[u8], emetteur: &str) -> Result<Demande> {
    let pk = cle(spki)?;
    let kid = cle_id(spki);
    let mut nonce = [0u8; 32];
    fill(&mut nonce);
    let msg = entree(&nonce, emetteur, &kid)?;
    let br = pk
        .blind(&mut DefaultRng, &msg)
        .map_err(|_| Error::JetonInvalide)?;
    let mut requete = Vec::with_capacity(REQUETE_LEN);
    requete.extend_from_slice(&TOKEN_TYPE.to_be_bytes());
    requete.push(kid[31]);
    requete.extend_from_slice(&br.blind_message);
    if requete.len() != REQUETE_LEN || br.secret.len() != NK {
        return Err(Error::JetonInvalide);
    }
    let mut etat = Zeroizing::new(Vec::with_capacity(ETAT_LEN));
    etat.extend_from_slice(&nonce);
    etat.extend_from_slice(&br.secret);
    Ok(Demande { requete, etat })
}

/// Jeton final à partir de la réponse du serveur ; la signature est vérifiée (une réponse
/// fausse ou d'une autre clé est refusée, `jeton_invalide`).
pub fn finaliser(spki: &[u8], emetteur: &str, etat: &[u8], reponse: &[u8]) -> Result<Vec<u8>> {
    if etat.len() != ETAT_LEN || reponse.len() != NK {
        return Err(Error::JetonInvalide);
    }
    let pk = cle(spki)?;
    let kid = cle_id(spki);
    let nonce: [u8; 32] = etat[..32].try_into().map_err(|_| Error::JetonInvalide)?;
    let msg = entree(&nonce, emetteur, &kid)?;
    let br = BlindingResult {
        blind_message: blind_rsa_signatures::BlindMessage(Vec::new()),
        secret: Secret(etat[32..].to_vec()),
        msg_randomizer: None,
    };
    let sig = pk
        .finalize(&BlindSignature(reponse.to_vec()), &br, &msg)
        .map_err(|_| Error::JetonInvalide)?;
    let mut jeton = msg;
    jeton.extend_from_slice(&sig);
    debug_assert_eq!(jeton.len(), JETON_LEN);
    Ok(jeton)
}

/// Vérifie un jeton pour la clé `spki` (le serveur le fait aussi, avec circl).
pub fn verifier(spki: &[u8], emetteur: &str, jeton: &[u8]) -> Result<()> {
    if jeton.len() != JETON_LEN {
        return Err(Error::JetonInvalide);
    }
    let pk = cle(spki)?;
    let nonce: [u8; 32] = jeton[2..34].try_into().map_err(|_| Error::JetonInvalide)?;
    let msg = entree(&nonce, emetteur, &cle_id(spki))?;
    if jeton[..98] != msg[..] {
        return Err(Error::JetonInvalide);
    }
    pk.verify(&Signature(jeton[98..].to_vec()), None, &msg)
        .map_err(|_| Error::JetonInvalide)
}

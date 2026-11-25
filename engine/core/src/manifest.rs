//! Manifeste chiffré du paquet (spec §29.3, §34, §41.14), comme `crypto/container.ts` :
//! lecture stricte (`parse`, même refus que `parseManifest`, tous en `paquet_corrompu`) et
//! écriture octet pour octet identique à `JSON.stringify` (`to_json`), champs dans l'ordre
//! `v, rights, keep_ttl_h?, title?, items[{kind, name, mime, size, offset, text?, k?, clean?, sha256?}]`.
//! `sha256` : empreinte SHA-256 du fichier tel qu'envoyé,
//! en hexadécimal minuscule (64 caractères), calculée sur l'appareil de l'expéditeur ; fichiers
//! seulement. Facultative et ignorée si mal formée (comme `clean`) : un ancien lecteur l'ignore,
//! un ancien manifeste n'en a pas.
//! `title` : nom du partage choisi par l'expéditeur, vu
//! par le destinataire et gardé dans l'historique de l'expéditeur. Facultatif ; nettoyé par
//! [`clean_title`] à l'écriture comme à la lecture ; refusé au scellement au-delà de
//! [`TITLE_MAX`] points de code (`titre_trop_long`, [`title_for_seal`]). À la lecture, absent,
//! mal typé, vide après nettoyage ou trop long : aucun titre, jamais une erreur. Un ancien
//! lecteur l'ignore (champ inconnu).
//!
//! Lecture comme `JSON.parse` : clé répétée → la dernière valeur compte ; BOM initial retiré
//! (TextDecoder) ; nombres lus en IEEE 754 (`3.0`, `3e0` et `-0` sont des entiers sûrs).
//! Écarts (entrées qu'aucun moteur Shhdrop n'écrit, toutes refusées ici) : imbrication de plus
//! de 128 niveaux, nombre hors des f64 finis (`1e400`, `Infinity` pour JavaScript), même dans
//! un champ inconnu. Demi-paire UTF-16 isolée échappée (`\ud800`, écrite par `JSON.stringify`
//! d'un nom mal formé) : lue comme U+FFFD, ce que JavaScript affichait déjà à sa place.
use crate::encoding::{b64u, unb64u};
use crate::error::{Error, Result};
use crate::format::{MANIFEST_MAX, MAX_ITEMS, MAX_SAFE, TEXT_BYTES_MAX, TEXT_MAX};
use crate::texte::est_ignorable;
use core::fmt;
use serde_json::Value;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

/// Durée de conservation d'un partage « coffre », en heures : 1, 6, 12 ou 24.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeepTtl {
    H1,
    H6,
    H12,
    H24,
}

impl KeepTtl {
    pub const fn hours(self) -> u8 {
        match self {
            KeepTtl::H1 => 1,
            KeepTtl::H6 => 6,
            KeepTtl::H12 => 12,
            KeepTtl::H24 => 24,
        }
    }

    pub const fn from_hours(h: u64) -> Option<Self> {
        match h {
            1 => Some(KeepTtl::H1),
            6 => Some(KeepTtl::H6),
            12 => Some(KeepTtl::H12),
            24 => Some(KeepTtl::H24),
            _ => None,
        }
    }

    /// Nombre JSON (`KEEP_TTLS.includes` : 12.0 vaut 12, 12.5 ne vaut rien).
    fn from_f64(x: f64) -> Option<Self> {
        [KeepTtl::H1, KeepTtl::H6, KeepTtl::H12, KeepTtl::H24]
            .into_iter()
            .find(|t| f64::from(t.hours()) == x)
    }
}

/// Droits du destinataire (spec §34) ; la durée n'existe qu'avec « coffre ».
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rights {
    Voir,
    Enregistrer,
    Coffre(KeepTtl),
}

impl Rights {
    /// Droits demandés à la création (`checkRights`, `sealFinal`) : « voir » et « enregistrer »
    /// sans durée, « coffre » avec 1, 6, 12 ou 24 h ; tout le reste : `droits_invalides`.
    pub fn new(name: &str, keep_ttl_h: Option<u64>) -> Result<Rights> {
        match (name, keep_ttl_h) {
            ("voir", None) => Ok(Rights::Voir),
            ("enregistrer", None) => Ok(Rights::Enregistrer),
            ("coffre", Some(h)) => KeepTtl::from_hours(h)
                .map(Rights::Coffre)
                .ok_or(Error::DroitsInvalides),
            _ => Err(Error::DroitsInvalides),
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Rights::Voir => "voir",
            Rights::Enregistrer => "enregistrer",
            Rights::Coffre(_) => "coffre",
        }
    }

    pub const fn keep_ttl_h(self) -> Option<u8> {
        match self {
            Rights::Coffre(t) => Some(t.hours()),
            _ => None,
        }
    }

    /// `parseRights` : absent, inconnu ou mal typé → « voir » (le plus restrictif) ; « coffre »
    /// sans durée valide → « voir ».
    fn read(o: &serde_json::Map<String, Value>) -> Rights {
        match o.get("rights").and_then(Value::as_str) {
            Some("enregistrer") => Rights::Enregistrer,
            Some("coffre") => o
                .get("keep_ttl_h")
                .and_then(Value::as_f64)
                .and_then(KeepTtl::from_f64)
                .map_or(Rights::Voir, Rights::Coffre),
            _ => Rights::Voir,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    File,
}

impl Kind {
    pub const fn name(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::File => "file",
        }
    }
}

/// Nettoyage d'un fichier avant l'envoi (D41-35), dit au destinataire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Clean {
    Image,
    Video,
    Audio,
    Pdf,
    Bureautique,
    Vocal,
    Echec,
    Protege,
    TelQuel,
}

const CLEANS: [Clean; 9] = [
    Clean::Image,
    Clean::Video,
    Clean::Audio,
    Clean::Pdf,
    Clean::Bureautique,
    Clean::Vocal,
    Clean::Echec,
    Clean::Protege,
    Clean::TelQuel,
];

impl Clean {
    pub const fn name(self) -> &'static str {
        match self {
            Clean::Image => "image",
            Clean::Video => "video",
            Clean::Audio => "audio",
            Clean::Pdf => "pdf",
            Clean::Bureautique => "bureautique",
            Clean::Vocal => "vocal",
            Clean::Echec => "echec",
            Clean::Protege => "protege",
            Clean::TelQuel => "tel_quel",
        }
    }

    /// Valeur inconnue (version plus récente) : `None`, jamais une erreur.
    pub fn from_name(s: &str) -> Option<Clean> {
        CLEANS.into_iter().find(|c| c.name() == s)
    }
}

/// Entrée du manifeste. `k` : graine de la clé de l'élément (spec §41.14) ; absente, ancien
/// format (sous K_contenu). `text` : texte d'une note de l'ancien format (dans le manifeste) ;
/// une note élément (avec `k`) n'en a pas à la lecture. Les chaînes et la graine sont mises à
/// zéro à la destruction ; `Debug` n'affiche ni nom, ni type, ni texte, ni graine.
#[derive(Clone)]
pub struct Entry {
    pub kind: Kind,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub offset: u64,
    pub text: Option<String>,
    pub k: Option<Zeroizing<[u8; 32]>>,
    /// Fichier seulement ; ignoré pour une note.
    pub clean: Option<Clean>,
    /// Empreinte SHA-256 du fichier envoyé (fichier seulement ; absente des anciens manifestes).
    pub sha256: Option<[u8; 32]>,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.name.zeroize();
        self.mime.zeroize();
        self.text.zeroize();
    }
}

impl PartialEq for Entry {
    fn eq(&self, o: &Self) -> bool {
        let k = match (&self.k, &o.k) {
            (Some(a), Some(b)) => bool::from(a.ct_eq(&**b)),
            (None, None) => true,
            _ => false,
        };
        k && self.kind == o.kind
            && self.name == o.name
            && self.mime == o.mime
            && self.size == o.size
            && self.offset == o.offset
            && self.text == o.text
            && self.clean == o.clean
            && self.sha256 == o.sha256
    }
}

impl Eq for Entry {}

impl fmt::Debug for Entry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Entry")
            .field("kind", &self.kind)
            .field("size", &self.size)
            .field("offset", &self.offset)
            .field("text", &self.text.as_ref().map(|_| "…"))
            .field("k", &self.k.as_ref().map(|_| "…"))
            .field("clean", &self.clean)
            .field("sha256", &self.sha256.as_ref().map(|_| "…"))
            .finish_non_exhaustive()
    }
}

/// Nom du partage, déjà nettoyé par [`clean_title`] : 1 à [`TITLE_MAX`] points
/// de code. Mis à zéro à la destruction ; `Debug` ne le montre pas.
#[derive(Clone, PartialEq, Eq)]
pub struct Title(String);

impl Title {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for Title {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for Title {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Title(…)")
    }
}

/// Longueur maximale du nom du partage, en points de code, après nettoyage.
pub const TITLE_MAX: usize = 80;

/// Nettoyage du nom du partage, le même à l'écriture et à la lecture :
/// 1. toute espace Unicode (`White_Space` : tabulation, saut de ligne, U+00A0, U+2028…) devient
///    U+0020 ;
/// 2. retrait des autres caractères de commande (C0, DEL, C1) et de tout
///    `Default_Ignorable_Code_Point` ([`est_ignorable`] : inversions et isolats de sens
///    U+202A–U+202E et U+2066–U+2069, LRM, RLM, ALM, largeur nulle, BOM, étiquettes…), sauf
///    U+200D et U+FE0F, gardés pour les séquences emoji ;
/// 3. NFC ;
/// 4. espaces regroupées, rognées en bord.
///
/// `None` si rien ne reste ou si le résultat dépasse [`TITLE_MAX`] points de code (lecture
/// tolérante : un titre hostile ou d'une version future vaut « aucun titre »).
pub fn clean_title(raw: &str) -> Option<Title> {
    title_for_seal(raw).ok().flatten()
}

/// Nom du partage demandé au scellement : nettoyé comme [`clean_title`] ; vide après nettoyage :
/// aucun titre ; plus de [`TITLE_MAX`] points de code : `titre_trop_long`.
pub fn title_for_seal(raw: &str) -> Result<Option<Title>> {
    let mut t = cleaned(raw);
    match t.chars().count() {
        0 => Ok(None),
        n if n <= TITLE_MAX => Ok(Some(Title(t))),
        _ => {
            t.zeroize();
            Err(Error::TitreTropLong)
        }
    }
}

fn cleaned(raw: &str) -> String {
    let mut kept = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_whitespace() {
            kept.push(' ');
        } else if !c.is_control() && (c == '\u{200D}' || c == '\u{FE0F}' || !est_ignorable(c)) {
            kept.push(c);
        }
    }
    let mut out = String::with_capacity(kept.len());
    let mut space = false;
    for c in kept.nfc() {
        if c == ' ' {
            space = !out.is_empty();
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    kept.zeroize();
    out
}

/// Manifeste v2 (la version `v: 2` est implicite).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub rights: Rights,
    /// Nom du partage ; absent des anciens manifestes.
    pub title: Option<Title>,
    pub items: Vec<Entry>,
}

fn corrupt<T>(_: T) -> Error {
    Error::PaquetCorrompu
}

/// Lit le manifeste déchiffré `raw`. `data_len` : octets de données qui le précèdent dans le
/// clair (début du manifeste) ; chaque élément doit y tenir. Tout défaut : `paquet_corrompu`.
pub fn parse(raw: &[u8], data_len: u64) -> Result<Manifest> {
    if raw.len() > MANIFEST_MAX {
        return Err(Error::PaquetCorrompu);
    }
    // TextDecoder("utf-8", { fatal: true }) : BOM initial retiré, UTF-8 strict.
    let body = raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(raw);
    let mut buf = Zeroizing::new(body.to_vec());
    core::str::from_utf8(&buf).map_err(corrupt)?;
    replace_lone_surrogates(&mut buf);
    let v: Value = serde_json::from_slice(&buf).map_err(corrupt)?;
    let out = read(&v, data_len);
    wipe(v);
    out
}

fn read(v: &Value, data_len: u64) -> Result<Manifest> {
    let o = v.as_object().ok_or(Error::PaquetCorrompu)?;
    let items = o.get("items").and_then(Value::as_array);
    let (Some(2.0), Some(items)) = (o.get("v").and_then(Value::as_f64), items) else {
        return Err(Error::PaquetCorrompu);
    };
    if items.is_empty() || items.len() > MAX_ITEMS {
        return Err(Error::PaquetCorrompu);
    }
    let items = items
        .iter()
        .map(|e| entry(e, data_len))
        .collect::<Result<Vec<_>>>()?;
    Ok(Manifest {
        rights: Rights::read(o),
        title: o.get("title").and_then(Value::as_str).and_then(clean_title),
        items,
    })
}

fn entry(e: &Value, data_len: u64) -> Result<Entry> {
    let e = e.as_object().ok_or(Error::PaquetCorrompu)?;
    let string = |f: &str| {
        e.get(f)
            .and_then(Value::as_str)
            .ok_or(Error::PaquetCorrompu)
    };
    let (name, mime) = (string("name")?, string("mime")?);
    let (size, offset) = (nat(e.get("size"))?, nat(e.get("offset"))?);
    let (text, k) = (e.get("text"), e.get("k"));
    // Élément dans les données : ni après leur fin, ni à cheval sur le manifeste.
    let inside = offset <= data_len && size <= data_len - offset;
    let mut out = Entry {
        kind: Kind::File,
        name: name.to_owned(),
        mime: mime.to_owned(),
        size,
        offset,
        text: None,
        k: None,
        clean: None,
        sha256: None,
    };
    match e.get("kind").and_then(Value::as_str) {
        // Ancien format : texte dans le manifeste.
        Some("text") if k.is_none() => {
            let t = text.and_then(Value::as_str).ok_or(Error::PaquetCorrompu)?;
            if size != 0 || offset != 0 || t.chars().count() > TEXT_MAX {
                return Err(Error::PaquetCorrompu);
            }
            out.kind = Kind::Text;
            out.text = Some(t.to_owned());
        }
        // Note élément (D41-36) : texte lu dans ses morceaux à l'ouverture.
        Some("text") => {
            if text.is_some() || size > TEXT_BYTES_MAX || !inside {
                return Err(Error::PaquetCorrompu);
            }
            out.kind = Kind::Text;
            out.k = k.map(seed).transpose()?;
        }
        Some("file") => {
            if text.is_some() || !inside {
                return Err(Error::PaquetCorrompu);
            }
            out.clean = e
                .get("clean")
                .and_then(Value::as_str)
                .and_then(Clean::from_name);
            out.sha256 = e.get("sha256").and_then(Value::as_str).and_then(sha256_hex);
            out.k = k.map(seed).transpose()?;
        }
        _ => return Err(Error::PaquetCorrompu),
    }
    Ok(out)
}

/// `Number.isSafeInteger(x) && x >= 0` sur un nombre JSON lu en IEEE 754.
fn nat(v: Option<&Value>) -> Result<u64> {
    let n = v.and_then(Value::as_number).ok_or(Error::PaquetCorrompu)?;
    if let Some(u) = n.as_u64() {
        return if u <= MAX_SAFE {
            Ok(u)
        } else {
            Err(Error::PaquetCorrompu)
        };
    }
    match n.as_f64() {
        // -0 et 0e5 valent 0 ; 3.0 vaut 3. f64 entier dans [0, 2^53 − 1] : conversion exacte.
        Some(x) if x >= 0.0 && x <= MAX_SAFE as f64 && x.fract() == 0.0 => Ok(x as u64),
        _ => Err(Error::PaquetCorrompu),
    }
}

/// Graine `k` : 43 caractères base64url canoniques, soit 32 octets.
/// Empreinte écrite par `write` : exactement 64 chiffres hexadécimaux minuscules ; sinon rien.
pub fn sha256_hex(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (digit(b[2 * i])? << 4) | digit(b[2 * i + 1])?;
    }
    Some(out)
}

fn seed(v: &Value) -> Result<Zeroizing<[u8; 32]>> {
    let s = v
        .as_str()
        .filter(|s| s.len() == 43)
        .ok_or(Error::PaquetCorrompu)?;
    let mut raw = unb64u(s).map_err(corrupt)?;
    let out = <[u8; 32]>::try_from(raw.as_slice())
        .map(Zeroizing::new)
        .map_err(corrupt);
    raw.zeroize();
    out
}

/// Remplace sur place chaque échappement `\uD800`–`\uDFFF` qui ne forme pas une paire valide
/// (haute `\uD800`–`\uDBFF` suivie de basse `\uDC00`–`\uDFFF`) par l'échappement de U+FFFD (même longueur).
/// Un `\\` (barre oblique inverse échappée) est sauté : le `u` qui suit n'est pas un échappement.
fn replace_lone_surrogates(buf: &mut [u8]) {
    let mut i = 0;
    while i < buf.len() {
        if buf[i] != b'\\' {
            i += 1;
            continue;
        }
        let Some(u) = escape_at(buf, i) else {
            i += 2;
            continue;
        };
        match u {
            0xD800..=0xDBFF if matches!(escape_at(buf, i + 6), Some(0xDC00..=0xDFFF)) => i += 12,
            0xD800..=0xDFFF => {
                buf[i + 2..i + 6].copy_from_slice(b"fffd");
                i += 6;
            }
            _ => i += 6,
        }
    }
}

/// Unité UTF-16 de l'échappement `\uXXXX` qui commence en `i`, s'il y en a un.
fn escape_at(buf: &[u8], i: usize) -> Option<u16> {
    let e = buf.get(i..i + 6)?;
    if e[0] != b'\\' || e[1] != b'u' {
        return None;
    }
    e[2..].iter().try_fold(0u16, |acc, &c| {
        let d = (c as char).to_digit(16)?;
        Some(acc << 4 | d as u16)
    })
}

/// Met à zéro toutes les chaînes (clés comprises) de l'arbre lu.
fn wipe(v: Value) {
    match v {
        Value::String(mut s) => s.zeroize(),
        Value::Array(a) => a.into_iter().for_each(wipe),
        Value::Object(o) => {
            for (mut k, v) in o {
                k.zeroize();
                wipe(v);
            }
        }
        _ => {}
    }
}

/// JSON du manifeste, octet pour octet celui de `JSON.stringify` dans l'ancien moteur. Aucune
/// vérification ici (taille, droits, places) : `seal_final` les fait. Tampon alloué une fois à
/// la bonne taille, mis à zéro à la destruction.
pub fn to_json(m: &Manifest) -> Zeroizing<Vec<u8>> {
    let mut n = 0;
    write(m, &mut |b| n += b.len());
    let mut out = Zeroizing::new(Vec::with_capacity(n));
    write(m, &mut |b| out.extend_from_slice(b));
    out
}

fn write(m: &Manifest, out: &mut dyn FnMut(&[u8])) {
    out(b"{\"v\":2,\"rights\":");
    string(m.rights.name(), out);
    if let Some(h) = m.rights.keep_ttl_h() {
        out(b",\"keep_ttl_h\":");
        number(u64::from(h), out);
    }
    if let Some(t) = &m.title {
        out(b",\"title\":");
        string(t.as_str(), out);
    }
    out(b",\"items\":[");
    for (i, e) in m.items.iter().enumerate() {
        out(if i == 0 {
            b"{\"kind\":"
        } else {
            b",{\"kind\":"
        });
        string(e.kind.name(), out);
        out(b",\"name\":");
        string(&e.name, out);
        out(b",\"mime\":");
        string(&e.mime, out);
        out(b",\"size\":");
        number(e.size, out);
        out(b",\"offset\":");
        number(e.offset, out);
        if let Some(t) = &e.text {
            out(b",\"text\":");
            string(t, out);
        }
        if let Some(k) = &e.k {
            out(b",\"k\":\"");
            let mut s = b64u(&**k);
            out(s.as_bytes());
            s.zeroize();
            out(b"\"");
        }
        if let Some(c) = e.clean {
            out(b",\"clean\":");
            string(c.name(), out);
        }
        if let (Kind::File, Some(h)) = (e.kind, &e.sha256) {
            const HEX: &[u8; 16] = b"0123456789abcdef";
            out(b",\"sha256\":\"");
            let mut x = [0u8; 64];
            for (i, b) in h.iter().enumerate() {
                x[2 * i] = HEX[usize::from(b >> 4)];
                x[2 * i + 1] = HEX[usize::from(b & 15)];
            }
            out(&x);
            out(b"\"");
        }
        out(b"}");
    }
    out(b"]}");
}

/// Chaîne JSON comme `JSON.stringify` : `"` et `\` échappés, \b \t \n \f \r, autres
/// commandes U+0000–U+001F en `\u00xx` minuscule ; tout le reste tel quel (UTF-8), dont `/`,
/// U+007F, U+2028 et U+2029.
fn string(s: &str, out: &mut dyn FnMut(&[u8])) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out(b"\"");
    let b = s.as_bytes();
    let mut start = 0;
    for (i, &c) in b.iter().enumerate() {
        let esc: &[u8] = match c {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            0x08 => b"\\b",
            b'\t' => b"\\t",
            b'\n' => b"\\n",
            0x0c => b"\\f",
            b'\r' => b"\\r",
            0x00..=0x1f => &[
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[usize::from(c >> 4)],
                HEX[usize::from(c & 15)],
            ],
            _ => continue,
        };
        out(&b[start..i]);
        out(esc);
        start = i + 1;
    }
    out(&b[start..]);
    out(b"\"");
}

/// Entier en décimal, sans allocation.
fn number(mut x: u64, out: &mut dyn FnMut(&[u8])) {
    let mut d = [0u8; 20];
    let mut i = d.len();
    loop {
        i -= 1;
        d[i] = b'0' + (x % 10) as u8;
        x /= 10;
        if x == 0 {
            break;
        }
    }
    out(&d[i..]);
}

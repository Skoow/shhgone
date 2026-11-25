//! Cas du pseudo (règle de `shhdrop_core::texte`) des vecteurs du compte par passkey
//! (`compte-v3.json`). Les sorties attendues sont écrites à la main (relues).
use super::hex;
use serde_json::{Value, json};
use shhdrop_core::compte::{PSEUDOS_RESERVES, pseudo_canon, pseudo_reserve, pseudo_valide};

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("texte attendu : {v}"))
}

/// Texte UTF-8 d'un champ hex.
pub fn utf8_hex(v: &Value) -> String {
    String::from_utf8(super::unhex(s(v))).expect("UTF-8")
}

// ------------------------------------------------------------------------- pseudo

/// Attendu d'un cas de pseudo.
enum P {
    /// Affichage, `p_canon`, réservé.
    Ok(&'static str, &'static str, bool),
    /// Même affichage que l'entrée, non réservé.
    Id(&'static str),
    /// Accepté et réservé.
    Reserve,
    Err(&'static str),
}

fn cas_pseudo() -> Vec<(&'static str, String, P)> {
    let long = "a\u{301}\u{302}\u{303}\u{304}\u{305}\u{306}\u{307}";
    let mut v: Vec<(&'static str, String, P)> = vec![
        (
            "simple",
            "Léa".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "majuscules",
            "LÉA".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "decompose",
            "Le\u{301}a".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "espace_interieure",
            "lé a".into(),
            P::Err("pseudo_caracteres"), // lettres et chiffres seulement
        ),
        (
            "espaces_regroupees",
            "  Léa \u{a0}\u{3000} Dupont\t".into(),
            P::Err("pseudo_caracteres"), // lettres et chiffres seulement
        ),
        (
            "ponctuation",
            "Jean-Luc O'Neil_x.y".into(),
            P::Err("pseudo_caracteres"), // lettres et chiffres seulement
        ),
        (
            "apostrophe_typographique",
            "O\u{2019}Neil".into(),
            P::Err("pseudo_caracteres"), // lettres et chiffres seulement
        ),
        (
            "sans_accent_distinct",
            "Lea".into(),
            P::Ok("Lea", "lea", false),
        ),
        (
            "nfkc_pleine_chasse",
            "ＬＥＡ".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "nfkc_mathematique",
            "𝓛éa".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        ("sosie_m_rn", "Emma".into(), P::Ok("Emma", "ernrna", false)),
        (
            "sosie_chiffres",
            "B0b1".into(),
            P::Ok("B0b1", "bobl", false),
        ),
        (
            "cyrillique_seul",
            "Лея".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "sosie_cyrillique_seul",
            "\u{410}\u{4CF}\u{456}\u{441}\u{435}".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "grec",
            "Ελένη".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "han_et_kana",
            "田中ひろし".into(),
            P::Err("pseudo_caracteres"),
        ),
        ("hangul", "김민수".into(), P::Err("pseudo_caracteres")),
        ("arabe", "علي".into(), P::Err("pseudo_caracteres")),
        ("devanagari", "हिन्दी".into(), P::Err("pseudo_caracteres")),
        ("chiffres_seuls", "42".into(), P::Id("42")),
        (
            "invisibles_retires",
            "L\u{200B}éa\u{202E}".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        ("deux_graphemes", "ab".into(), P::Id("ab")),
        (
            "vingt_quatre_graphemes",
            "a".repeat(24),
            P::Ok(
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                false,
            ),
        ),
        // Le plus long p_canon possible en octets pour un graphème de base latine : 24 graphèmes de
        // 8 points de code (lettre + 7 marques), 360 octets UTF-8 (conception : borne côté serveur).
        ("p_canon_long", long.repeat(24), P::Err("pseudo_caracteres")),
        ("un_grapheme", "A".into(), P::Err("pseudo_longueur")),
        ("vide", "".into(), P::Err("pseudo_longueur")),
        ("blancs_seuls", "   ".into(), P::Err("pseudo_longueur")),
        (
            "vingt_cinq_graphemes",
            "a".repeat(25),
            P::Err("pseudo_longueur"),
        ),
        (
            "entree_au_dela_de_4096_octets",
            "a".repeat(4097),
            P::Err("pseudo_longueur"),
        ),
        (
            "ecritures_melees",
            "\u{410}lice".into(),
            P::Err("pseudo_caracteres"),
        ),
        (
            "latin_et_han",
            "Taro太郎".into(),
            P::Err("pseudo_caracteres"),
        ),
        ("emoji", "Léa😀".into(), P::Err("pseudo_caracteres")),
        (
            "teinte_seule",
            "Léa\u{1F3FD}".into(),
            P::Err("pseudo_caracteres"),
        ),
        (
            "lettre_encerclee",
            "Ⓜax".into(),
            P::Err("pseudo_caracteres"),
        ),
        (
            "ponctuation_seule",
            "..".into(),
            P::Err("pseudo_caracteres"),
        ),
        (
            "point_d_exclamation",
            "Léa!".into(),
            P::Err("pseudo_caracteres"),
        ),
        ("arobase", "Léa@x".into(), P::Err("pseudo_caracteres")),
        (
            "marque_sur_espace",
            "a \u{301}b".into(),
            P::Err("pseudo_caracteres"),
        ),
        (
            "neuf_points_par_grapheme",
            format!("ab{}", "\u{301}".repeat(8)),
            P::Err("pseudo_caracteres"),
        ),
        // Réservés (conception §21.5), écrits comme on les tape.
        (
            "reserve_admin",
            "Admin".into(),
            P::Ok("Admin", "adrnln", true),
        ),
        (
            "reserve_admin_majuscules",
            "ADMIN".into(),
            P::Ok("ADMIN", "adrnln", true),
        ),
        (
            "reserve_admin_sosie_rn",
            "adrnin".into(),
            P::Ok("adrnin", "adrnln", true),
        ),
        (
            "reserve_shhgone",
            "ShhGone".into(),
            P::Ok("ShhGone", "shhgone", true),
        ),
        (
            "reserve_espace_et_tiret",
            "Shh-Drop".into(),
            P::Err("pseudo_caracteres"), // lettres et chiffres seulement
        ),
        (
            "reserve_moderateur_accent",
            "Modérateur".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "reserve_equipe_accent",
            "Équipe".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "reserve_securite_accent",
            "Sécurité".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "reserve_systeme_accent",
            "Système".into(),
            P::Err("pseudo_caracteres"), /* A-Z, a-z, 0-9 seulement */
        ),
        (
            "non_reserve_suffixe",
            "Admin2".into(),
            P::Ok("Admin2", "adrnln2", false),
        ),
    ];
    // Chaque mot de la liste, tel quel.
    for (i, w) in PSEUDOS_RESERVES.iter().enumerate() {
        let label: &'static str = Box::leak(format!("liste_{i:02}").into_boxed_str());
        // Mots accentués : refusés avant même la liste (A-Z, a-z, 0-9 seulement).
        let want = if w.is_ascii() {
            P::Reserve
        } else {
            P::Err("pseudo_caracteres")
        };
        v.push((label, (*w).to_string(), want));
    }
    v
}

pub fn pseudo_json(entree: &str) -> Value {
    match pseudo_valide(entree) {
        Ok(a) => {
            let c = pseudo_canon(&a);
            json!({
                "affiche_hex": hex(a.as_bytes()),
                "p_canon_hex": hex(c.as_bytes()),
                "reserve": pseudo_reserve(&c),
            })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

pub fn section_pseudo() -> Value {
    let mut out = Vec::new();
    for (label, entree, want) in cas_pseudo() {
        let mut v = pseudo_json(&entree);
        let affiche = v.get("affiche_hex").map(utf8_hex);
        let canon = v.get("p_canon_hex").map(utf8_hex);
        match want {
            P::Ok(a, c, r) => {
                assert_eq!(affiche.as_deref(), Some(a), "{label}");
                assert_eq!(canon.as_deref(), Some(c), "{label}");
                assert_eq!(v["reserve"], r, "{label}");
            }
            P::Id(a) => {
                assert_eq!(affiche.as_deref(), Some(a), "{label}");
                assert_eq!(v["reserve"], false, "{label}");
            }
            P::Reserve => assert_eq!(v["reserve"], true, "{label}"),
            P::Err(e) => assert_eq!(v["error"], e, "{label}"),
        }
        v["label"] = label.into();
        v["entree_hex"] = hex(entree.as_bytes()).into();
        out.push(v);
    }
    Value::Array(out)
}

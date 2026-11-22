// Compte v2 (conception 2026-11-14-compte-email-design.md §5.1, §6, §21.2.2, §21.5) :
// normalisation de l'adresse, sel, Argon2id et dérivations, clés des deux coffres et de
// l'appareil, pseudo, mot de passe. Vecteurs communs : engine/vectors/compte.json.
//
// Le fichier a deux auteurs :
//   - ce test écrit les sections du moteur (`constants`, `normaliser`, `sel`, `deriver`, `cles`,
//     `pseudo`, `mot_de_passe`) : SHH_GEN_COMPTE=1 cargo test -p shhdrop-core --test compte ;
//   - web/scripts/gen-compte-vectors.mjs écrit, avec WebCrypto et des nonces fixés, les sections
//     `enveloppes`, `coffre_prive` et `coffre_profil` (ce que le site chiffre lui-même).
// Sans la variable, le test échoue si les sections du moteur ne sont plus exactement celles qu'il
// produit, rejoue chaque cas à partir de ses seules entrées, et refait les sections de WebCrypto
// avec l'AES-256-GCM natif (RustCrypto, celui des apps) : même chiffré, même clair.
//
// Les sorties attendues des tables ci-dessous sont écrites à la main (relues), pas recopiées du
// moteur : la génération échoue si le moteur s'en écarte.
mod support;

use serde_json::{Map, Value, json};
use shhdrop_core::compte::v2::{
    Adresse, cle_profil, deriver, mot_de_passe_valide, normaliser, sel,
};
use shhdrop_core::compte::{
    PSEUDOS_RESERVES, cle_appareil, cle_prive, pseudo_canon, pseudo_reserve, pseudo_valide,
};
use shhdrop_core::kdf::{KDF_CREATE, argon2id, hkdf, sha256};
use shhdrop_core::platform::Key;
use support::pseudo::{pseudo_json, section_pseudo};
use support::{block_on, hex, platform, unhex};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/compte.json");
/// Sections écrites par web/scripts/gen-compte-vectors.mjs (WebCrypto).
const SECTIONS_WEBCRYPTO: [&str; 3] = ["coffre_prive", "coffre_profil", "enveloppes"];

/// 32 octets déterministes : SHA-256(UTF-8(« shhdrop/vecteurs/compte/ » + étiquette)).
fn derive(label: &str) -> [u8; 32] {
    sha256(format!("shhdrop/vecteurs/compte/{label}").as_bytes())
}

fn key32(s: &str) -> [u8; 32] {
    unhex(s).try_into().expect("32 octets")
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("texte attendu : {v}"))
}

fn utf8_hex(v: &Value) -> String {
    String::from_utf8(unhex(s(v))).expect("UTF-8")
}

// ------------------------------------------------------------------------- normaliser

/// (étiquette, entrée, attendu : Ok((canon, exacte)) ou Err(code)).
type CasAdresse = (
    &'static str,
    String,
    Result<(&'static str, String), &'static str>,
);

fn cas_normaliser() -> Vec<CasAdresse> {
    let l64 = "a".repeat(64);
    let l65 = "a".repeat(65);
    let e63 = "e".repeat(63);
    let e64 = "e".repeat(64);
    // 254 caractères : 64 + 1 + 189 (63 + 1 + 63 + 1 + 58 + 1 + 2).
    let dom189 = format!("{e63}.{e63}.{}.fr", "e".repeat(58));
    let t254 = format!("{l64}@{dom189}");
    let t255 = format!("{l64}@e{dom189}");
    assert_eq!((t254.len(), t255.len()), (254, 255));
    let ok = |c: &'static str, e: &str| Ok((c, e.to_string()));
    let id = |a: &'static str| Ok((a, a.to_string()));
    let inv = || Err("adresse_invalide");
    let na = || Err("adresse_non_ascii");
    vec![
        ("simple", "lea@exemple.fr".into(), id("lea@exemple.fr")),
        ("majuscules", "Lea@Exemple.FR".into(), id("lea@exemple.fr")),
        (
            "blancs_de_bord",
            " \t lea@exemple.fr\r\n ".into(),
            id("lea@exemple.fr"),
        ),
        ("saut_de_page_en_bord", "\u{c}lea@exemple.fr".into(), inv()),
        (
            "plus",
            "lea+x@exemple.fr".into(),
            ok("lea@exemple.fr", "lea+x@exemple.fr"),
        ),
        (
            "plus_deux_fois",
            "lea+x+y@exemple.fr".into(),
            ok("lea@exemple.fr", "lea+x+y@exemple.fr"),
        ),
        (
            "plus_final",
            "lea+@exemple.fr".into(),
            ok("lea@exemple.fr", "lea+@exemple.fr"),
        ),
        ("plus_en_tete", "+x@exemple.fr".into(), inv()),
        ("plus_seul", "+@exemple.fr".into(), inv()),
        (
            "points_hors_gmail_gardes",
            "Lea.Dupont@exemple.fr".into(),
            id("lea.dupont@exemple.fr"),
        ),
        (
            "variante_gmail",
            "Lea.Dupont+x@GMAIL.com".into(),
            ok("leadupont@gmail.com", "lea.dupont+x@gmail.com"),
        ),
        (
            "points_gmail",
            "l.e.a@gmail.com".into(),
            ok("lea@gmail.com", "l.e.a@gmail.com"),
        ),
        (
            "googlemail",
            "lea.dupont@googlemail.com".into(),
            ok("leadupont@gmail.com", "lea.dupont@googlemail.com"),
        ),
        (
            "googlemail_majuscules_plus",
            "L.E.A+Shh@GoogleMail.COM".into(),
            ok("lea@gmail.com", "l.e.a+shh@googlemail.com"),
        ),
        ("plus_en_tete_gmail", "+x@gmail.com".into(), inv()),
        (
            "sous_domaine_gmail",
            "l.ea@mail.gmail.com".into(),
            id("l.ea@mail.gmail.com"),
        ),
        (
            "gmail_ailleurs",
            "l.ea@gmail.com.fr".into(),
            id("l.ea@gmail.com.fr"),
        ),
        ("double_arobase", "lea@@exemple.fr".into(), inv()),
        ("deux_arobases", "lea@exemple@fr".into(), inv()),
        ("sans_arobase", "leaexemple.fr".into(), inv()),
        ("local_vide", "@exemple.fr".into(), inv()),
        ("domaine_vide", "lea@".into(), inv()),
        ("vide", "".into(), inv()),
        ("blancs_seuls", " \t\r\n".into(), inv()),
        (
            "local_64",
            format!("{l64}@exemple.fr"),
            Ok(("", format!("{l64}@exemple.fr"))),
        ),
        ("local_65", format!("{l65}@exemple.fr"), inv()),
        ("total_254", t254.clone(), Ok(("", t254))),
        ("total_255", t255, inv()),
        (
            "etiquette_63",
            format!("lea@{e63}.fr"),
            Ok(("", format!("lea@{e63}.fr"))),
        ),
        ("etiquette_64", format!("lea@{e64}.fr"), inv()),
        ("accent_local", "léa@exemple.fr".into(), na()),
        ("accent_domaine", "lea@exémple.fr".into(), na()),
        (
            "espace_insecable_en_bord",
            "lea@exemple.fr\u{a0}".into(),
            na(),
        ),
        ("accent_et_espace", "lé a@exemple.fr".into(), na()),
        (
            "punycode",
            "lea@xn--exmple-cva.fr".into(),
            id("lea@xn--exmple-cva.fr"),
        ),
        (
            "tiret_interieur",
            "lea@ex-emple.fr".into(),
            id("lea@ex-emple.fr"),
        ),
        ("tiret_en_tete_etiquette", "lea@-exemple.fr".into(), inv()),
        ("tiret_en_fin_etiquette", "lea@exemple-.fr".into(), inv()),
        ("tiret_tld", "lea@exemple.f-r".into(), inv()),
        ("tld_numerique", "lea@exemple.123".into(), inv()),
        ("tld_une_lettre", "lea@exemple.f".into(), inv()),
        ("tld_alphanumerique", "lea@exemple.f1".into(), inv()),
        ("chiffres_domaine", "lea@123.fr".into(), id("lea@123.fr")),
        ("une_seule_etiquette", "lea@exemple".into(), inv()),
        ("etiquette_vide", "lea@exemple..fr".into(), inv()),
        ("point_en_tete_domaine", "lea@.exemple.fr".into(), inv()),
        ("point_final_domaine", "lea@exemple.fr.".into(), inv()),
        ("souligne_domaine", "lea@ex_emple.fr".into(), inv()),
        ("espace_interieure", "lea dupont@exemple.fr".into(), inv()),
        ("saut_de_ligne_interieur", "lea\n@exemple.fr".into(), inv()),
        ("nul", "lea\u{0}@exemple.fr".into(), inv()),
        ("del", "lea\u{7f}@exemple.fr".into(), inv()),
        ("point_en_tete_local", ".lea@exemple.fr".into(), inv()),
        ("point_final_local", "lea.@exemple.fr".into(), inv()),
        ("deux_points_local", "le..a@exemple.fr".into(), inv()),
        ("guillemets", "\"lea\"@exemple.fr".into(), inv()),
        ("virgule", "a,b@exemple.fr".into(), inv()),
        ("chevrons", "lea<x>@exemple.fr".into(), inv()),
        ("point_virgule", "lea;x@exemple.fr".into(), inv()),
        ("parentheses", "lea(x)@exemple.fr".into(), inv()),
        ("crochets_domaine", "lea@[127.0.0.1]".into(), inv()),
        (
            "apostrophe",
            "O'Neil@exemple.fr".into(),
            id("o'neil@exemple.fr"),
        ),
        (
            "tous_les_atext",
            "a!#$%&'*/=?^_`{|}~-z@exemple.fr".into(),
            id("a!#$%&'*/=?^_`{|}~-z@exemple.fr"),
        ),
        ("points_gmail_seuls", "...@gmail.com".into(), inv()),
    ]
}

/// Attendu d'un cas : canon vide = identique à `exacte`.
fn attendu_adresse(c: &CasAdresse) -> Result<Adresse, &'static str> {
    c.2.clone().map(|(canon, exacte)| Adresse {
        canon: if canon.is_empty() {
            exacte.clone()
        } else {
            canon.into()
        },
        exacte,
    })
}

fn normaliser_json(r: Result<Adresse, shhdrop_core::Error>) -> Value {
    match r {
        Ok(a) => json!({ "canon": a.canon, "exacte": a.exacte }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn section_normaliser() -> Value {
    let mut out = Vec::new();
    for c in cas_normaliser() {
        let got = normaliser(&c.1);
        let want = attendu_adresse(&c);
        match (&got, &want) {
            (Ok(g), Ok(w)) => assert_eq!(g, w, "{}", c.0),
            (Err(g), Err(w)) => assert_eq!(g.to_string(), *w, "{}", c.0),
            _ => panic!("{} : obtenu {got:?}, attendu {want:?}", c.0),
        }
        let mut v = normaliser_json(got);
        v["label"] = c.0.into();
        v["entree_hex"] = hex(c.1.as_bytes()).into();
        out.push(v);
    }
    Value::Array(out)
}

// ------------------------------------------------------------------------- sel

const CANONS: [&str; 4] = [
    "lea@exemple.fr",
    "leadupont@gmail.com",
    "o'neil@exemple.fr",
    "a@b.cd",
];

fn section_sel() -> Value {
    CANONS
        .iter()
        .map(|c| json!({ "canon": c, "sel": hex(&sel(c)) }))
        .collect()
}

// ------------------------------------------------------------------------- deriver

/// (étiquette, mot de passe, canon, même clé que l'étiquette…).
fn cas_deriver() -> Vec<(
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
)> {
    vec![
        ("simple", "correct horse battery", "lea@exemple.fr", None),
        (
            "autre_adresse",
            "correct horse battery",
            "leadupont@gmail.com",
            None,
        ),
        (
            "blancs_de_bord",
            " \t correct horse battery\r\n",
            "lea@exemple.fr",
            Some("simple"),
        ),
        ("nfc_compose", "Mot de passe d'été", "lea@exemple.fr", None),
        (
            "nfc_decompose",
            "Mot de passe d'e\u{301}te\u{301}",
            "lea@exemple.fr",
            Some("nfc_compose"),
        ),
        (
            "espace_insecable_en_bord_gardee",
            "\u{a0}correct horse battery",
            "lea@exemple.fr",
            None,
        ),
        ("emoji", "🔐 clé 🗝️ secrète", "lea@exemple.fr", None),
        ("vide", "", "lea@exemple.fr", None),
        ("blancs_seuls", " \t\r\n", "lea@exemple.fr", None),
    ]
}

fn deriver_json(mdp: &str, canon: &str) -> Value {
    match deriver(mdp, canon) {
        Ok((a, k)) => json!({ "a_auth": hex(&*a), "kek_mdp": hex(&*k) }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn section_deriver() -> Value {
    let mut out: Vec<Value> = Vec::new();
    for (label, mdp, canon, same) in cas_deriver() {
        let mut v = deriver_json(mdp, canon);
        if let Some(o) = same {
            let other = out
                .iter()
                .find(|x| x["label"] == o)
                .expect("cas de référence");
            assert_eq!(v["a_auth"], other["a_auth"], "{label}");
            assert_eq!(v["kek_mdp"], other["kek_mdp"], "{label}");
            v["same_key_as"] = o.into();
        } else if v.get("a_auth").is_some() {
            assert!(
                out.iter().all(|x| x["a_auth"] != v["a_auth"]),
                "{label} : même clé qu'un autre cas"
            );
        }
        v["label"] = label.into();
        v["mdp_hex"] = hex(mdp.as_bytes()).into();
        v["canon"] = canon.into();
        out.push(v);
    }
    assert_eq!(out[7]["error"], "mot_de_passe_vide");
    assert_eq!(out[8]["error"], "mot_de_passe_vide");
    Value::Array(out)
}

// ------------------------------------------------------------------------- cles

fn section_cles() -> Value {
    ["a", "b"]
        .iter()
        .map(|l| {
            let k = derive(&format!("k_compte/{l}"));
            let s = derive(&format!("s_profil/{l}"));
            json!({
                "label": l,
                "k_compte": hex(&k),
                "s_profil": hex(&s),
                "k_prive": hex(&*cle_prive(&k)),
                "k_appareil": hex(&*cle_appareil(&k)),
                "k_profil": hex(&*cle_profil(&s)),
            })
        })
        .collect()
}

// ------------------------------------------------------------------------- mot de passe

fn cas_mdp() -> Vec<(&'static str, String, &'static str, Option<&'static str>)> {
    let e = "Lea.Dupont+x@GMAIL.com";
    let e2 = "lea.dupont.x@gmail.com";
    vec![
        ("dix", "abcdefghij".into(), e, None),
        ("neuf", "abcdefghi".into(), e, Some("mdp_court")),
        ("vide", "".into(), e, Some("mdp_court")),
        (
            "neuf_et_blancs_de_bord",
            "  abcdefghi\t".into(),
            e,
            Some("mdp_court"),
        ),
        ("dix_accents_decomposes", "e\u{301}".repeat(10), e, None),
        (
            "neuf_accents_decomposes",
            "e\u{301}".repeat(9),
            e,
            Some("mdp_court"),
        ),
        ("deux_cent_cinquante_six", "a".repeat(256), e, None),
        (
            "deux_cent_cinquante_sept",
            "a".repeat(257),
            e,
            Some("mdp_long"),
        ),
        ("emoji_points_de_code", "😀".repeat(10), e, None),
        (
            "adresse_exacte",
            "lea.dupont+x@gmail.com".into(),
            e,
            Some("mdp_adresse"),
        ),
        (
            "adresse_majuscules",
            "LEA.DUPONT+X@GMAIL.COM".into(),
            e,
            Some("mdp_adresse"),
        ),
        (
            "adresse_blancs_de_bord",
            " lea.dupont+x@gmail.com\n".into(),
            e,
            Some("mdp_adresse"),
        ),
        (
            "partie_locale_exacte",
            "Lea.Dupont+x".into(),
            e,
            Some("mdp_adresse"),
        ),
        (
            "adresse_canonique",
            "leadupont@gmail.com".into(),
            e,
            Some("mdp_adresse"),
        ),
        (
            "partie_locale_canonique",
            "leadupontx".into(),
            e2,
            Some("mdp_adresse"),
        ),
        (
            "adresse_dans_le_mot_de_passe",
            "lea.dupont+x@gmail.com!".into(),
            e,
            None,
        ),
    ]
}

fn mdp_json(mdp: &str, email: &str) -> Value {
    let a = normaliser(email).expect("adresse du cas");
    match mot_de_passe_valide(mdp, &a) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn section_mdp() -> Value {
    cas_mdp()
        .into_iter()
        .map(|(label, mdp, email, want)| {
            let mut v = mdp_json(&mdp, email);
            match want {
                None => assert_eq!(v["ok"], true, "{label}"),
                Some(e) => assert_eq!(v["error"], e, "{label}"),
            }
            v["label"] = label.into();
            v["mdp_hex"] = hex(mdp.as_bytes()).into();
            v["email"] = email.into();
            v
        })
        .collect()
}

// ------------------------------------------------------------------------- fichier

fn constants() -> Value {
    json!({
        "argon2id": { "fils": 1, "mem": KDF_CREATE.mem, "ops": KDF_CREATE.ops, "sortie": 32 },
        "etiquettes": {
            "a_auth": "shhdrop/v2/compte/auth",
            "kek_mdp": "shhdrop/v2/compte/enveloppe-mdp",
            "k_prive": "shhdrop/v2/compte/blob",
            "k_profil": "shhdrop/v2/compte/profil",
            "k_appareil": "shhdrop/v2/compte/appareil",
            "sel": "shhdrop/v2/compte/sel",
        },
        "mdp": { "min": 10, "max": 256 },
        "pseudo": { "min": 2, "max": 24 },
        "paliers": [4096, 16384, 65536, 262144],
        "reserves": PSEUDOS_RESERVES
            .iter()
            .map(|w| json!({ "mot": w, "p_canon_hex": hex(pseudo_canon(w).as_bytes()) }))
            .collect::<Vec<_>>(),
        "unicode": {
            "unicode_normalization": [
                unicode_normalization::UNICODE_VERSION.0,
                unicode_normalization::UNICODE_VERSION.1,
                unicode_normalization::UNICODE_VERSION.2,
            ],
            "unicode_segmentation": [
                unicode_segmentation::UNICODE_VERSION.0,
                unicode_segmentation::UNICODE_VERSION.1,
                unicode_segmentation::UNICODE_VERSION.2,
            ],
            "unicode_script": [
                unicode_script::UNICODE_VERSION.0,
                unicode_script::UNICODE_VERSION.1,
                unicode_script::UNICODE_VERSION.2,
            ],
            "unicode_security": [
                unicode_security::UNICODE_VERSION.0,
                unicode_security::UNICODE_VERSION.1,
                unicode_security::UNICODE_VERSION.2,
            ],
            "char": [char::UNICODE_VERSION.0, char::UNICODE_VERSION.1, char::UNICODE_VERSION.2],
        },
    })
}

/// Sections du moteur.
fn build() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "about".into(),
        "Compte v2, produit par le moteur Rust (engine/core/tests/compte.rs) et, pour les enveloppes et les coffres, par WebCrypto (web/scripts/gen-compte-vectors.mjs) ; voir engine/vectors/README.md.".into(),
    );
    m.insert("constants".into(), constants());
    m.insert("normaliser".into(), section_normaliser());
    m.insert("sel".into(), section_sel());
    m.insert("deriver".into(), section_deriver());
    m.insert("cles".into(), section_cles());
    m.insert("pseudo".into(), section_pseudo());
    m.insert("mot_de_passe".into(), section_mdp());
    m
}

fn text(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap();
    s.push('\n');
    s
}

fn lire() -> (String, Value) {
    let raw = std::fs::read_to_string(FILE).expect("engine/vectors/compte.json");
    let v = serde_json::from_str(&raw).expect("JSON de compte.json");
    (raw, v)
}

#[test]
fn fichier_a_jour() {
    let built = build();
    if std::env::var_os("SHH_GEN_COMPTE").is_some() {
        // Les sections de WebCrypto (gen-compte-vectors.mjs) sont gardées telles quelles.
        let mut all = built.clone();
        if let Ok(raw) = std::fs::read_to_string(FILE) {
            let old: Value = serde_json::from_str(&raw).unwrap();
            for k in SECTIONS_WEBCRYPTO {
                if let Some(x) = old.get(k) {
                    all.insert(k.into(), x.clone());
                }
            }
        }
        std::fs::write(FILE, text(&Value::Object(all))).unwrap();
    }
    let (raw, file) = lire();
    // Forme canonique (clés triées, 2 espaces, LF final), quel que soit l'auteur de la section.
    assert_eq!(
        raw,
        text(&file),
        "compte.json n'est pas sous forme canonique"
    );
    let obj = file.as_object().unwrap();
    for (k, v) in &built {
        assert_eq!(
            obj.get(k),
            Some(v),
            "section {k} : n'est plus celle du moteur"
        );
    }
    let mut attendues: Vec<&str> = built.keys().map(String::as_str).collect();
    attendues.extend(SECTIONS_WEBCRYPTO);
    attendues.sort_unstable();
    let presentes: Vec<&str> = obj.keys().map(String::as_str).collect();
    assert_eq!(presentes, attendues, "sections du fichier");
}

// ------------------------------------------------------------------------- rejeu, entrées seules

#[test]
fn vecteurs_normaliser() {
    let (_, v) = lire();
    let cases = v["normaliser"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for c in cases {
        let got = normaliser_json(normaliser(&utf8_hex(&c["entree_hex"])));
        for k in ["canon", "exacte", "error"] {
            assert_eq!(got.get(k), c.get(k), "{} : {k}", c["label"]);
        }
    }
}

#[test]
fn vecteurs_sel() {
    let (_, v) = lire();
    let cases = v["sel"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let canon = s(&c["canon"]);
        assert_eq!(hex(&sel(canon)), s(&c["sel"]), "{canon}");
        // Formule écrite à part : SHA-256(« shhdrop/v2/compte/sel » ‖ 0x00 ‖ canon)[0..16].
        let mut m = b"shhdrop/v2/compte/sel\0".to_vec();
        m.extend_from_slice(canon.as_bytes());
        assert_eq!(hex(&sha256(&m)[..16]), s(&c["sel"]), "{canon}");
    }
}

#[test]
fn vecteurs_deriver() {
    let (_, v) = lire();
    let cases = v["deriver"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let mdp = utf8_hex(&c["mdp_hex"]);
        let canon = s(&c["canon"]);
        let got = deriver_json(&mdp, canon);
        for k in ["a_auth", "kek_mdp", "error"] {
            assert_eq!(got.get(k), c.get(k), "{} : {k}", c["label"]);
        }
        // Composition écrite à part : Argon2id(mot de passe rogné puis NFC, sel, 64 Mio, 3, 1),
        // puis HKDF-SHA-256 à sel vide sous chaque étiquette.
        if let Some(a) = c.get("a_auth") {
            let nfc: String = mdp.trim_matches([' ', '\t', '\r', '\n']).nfc().collect();
            let m = argon2id(nfc.as_bytes(), &sel(canon), 3, 64 << 20).unwrap();
            assert_eq!(hex(&*hkdf::<32>(&*m, "shhdrop/v2/compte/auth")), s(a));
            assert_eq!(
                hex(&*hkdf::<32>(&*m, "shhdrop/v2/compte/enveloppe-mdp")),
                s(&c["kek_mdp"])
            );
        }
    }
}

#[test]
fn vecteurs_cles() {
    let (_, v) = lire();
    for c in v["cles"].as_array().unwrap() {
        let k = key32(s(&c["k_compte"]));
        let p = key32(s(&c["s_profil"]));
        assert_eq!(hex(&*cle_prive(&k)), s(&c["k_prive"]));
        assert_eq!(hex(&*cle_appareil(&k)), s(&c["k_appareil"]));
        assert_eq!(hex(&*cle_profil(&p)), s(&c["k_profil"]));
        assert_eq!(
            hex(&*hkdf::<32>(&k, "shhdrop/v2/compte/blob")),
            s(&c["k_prive"])
        );
        assert_eq!(
            hex(&*hkdf::<32>(&k, "shhdrop/v2/compte/appareil")),
            s(&c["k_appareil"])
        );
        assert_eq!(
            hex(&*hkdf::<32>(&p, "shhdrop/v2/compte/profil")),
            s(&c["k_profil"])
        );
    }
}

#[test]
fn vecteurs_pseudo() {
    let (_, v) = lire();
    let cases = v["pseudo"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for c in cases {
        let got = pseudo_json(&utf8_hex(&c["entree_hex"]));
        for k in ["affiche_hex", "p_canon_hex", "reserve", "error"] {
            assert_eq!(got.get(k), c.get(k), "{} : {k}", c["label"]);
        }
    }
    // p_canon le plus long : 24 octets depuis le 20 novembre (A-Z, a-z, 0-9) ; l'entrée de
    // 24 graphèmes chargés de marques (336 octets de canon avant) est refusée.
    let long = cases.iter().find(|c| c["label"] == "p_canon_long").unwrap();
    assert_eq!(long["error"], "pseudo_caracteres");
    // Chaque mot réservé de la liste, et sa forme canonique, sont refusés.
    for r in v["constants"]["reserves"].as_array().unwrap() {
        let canon = utf8_hex(&r["p_canon_hex"]);
        assert_eq!(pseudo_canon(s(&r["mot"])), canon);
        assert!(pseudo_reserve(&canon), "{canon}");
    }
}

#[test]
fn vecteurs_mot_de_passe() {
    let (_, v) = lire();
    let cases = v["mot_de_passe"].as_array().unwrap();
    assert!(cases.len() >= 10);
    for c in cases {
        let got = mdp_json(&utf8_hex(&c["mdp_hex"]), s(&c["email"]));
        for k in ["ok", "error"] {
            assert_eq!(got.get(k), c.get(k), "{} : {k}", c["label"]);
        }
    }
}

/// AES-256-GCM natif (RustCrypto, fournisseur des apps) à nonce donné : nonce ‖ chiffré ‖ tag.
fn aes_natif(cle: &[u8; 32], nonce: &[u8], ad: &[u8], clair: &[u8]) -> Vec<u8> {
    let p = platform(1);
    let k = block_on(Key::import(&p, Zeroizing::new(*cle))).unwrap();
    let n: [u8; 12] = nonce.try_into().expect("nonce de 12 octets");
    let ct = block_on(k.seal_batch(ad, &[n], clair, clair.len())).unwrap();
    [nonce, &ct[..]].concat()
}

#[test]
fn vecteurs_webcrypto_refaits_en_natif() {
    let (_, v) = lire();
    let cles = v["cles"].as_array().unwrap();
    let deriv = v["deriver"].as_array().unwrap();
    // Enveloppe du mot de passe : nonce (12) ‖ AES-256-GCM(KEK_mdp, nonce, K_compte,
    // AD = « SHH-CENV1 » ‖ h ‖ « mdp ») = 60 octets.
    let env = v["enveloppes"].as_array().unwrap();
    assert!(!env.is_empty());
    for c in env {
        let kek = key32(s(&c["kek_mdp"]));
        assert!(
            deriv.iter().any(|d| d["kek_mdp"] == c["kek_mdp"]),
            "KEK de deriver"
        );
        let h = unhex(s(&c["h"]));
        assert_eq!(h.len(), 16);
        let ad = [b"SHH-CENV1".as_slice(), &h, b"mdp"].concat();
        assert_eq!(hex(&ad), s(&c["ad"]));
        let k_compte = unhex(s(&c["k_compte"]));
        let out = aes_natif(&kek, &unhex(s(&c["nonce"])), &ad, &k_compte);
        assert_eq!(out.len(), 60);
        assert_eq!(hex(&out), s(&c["env_mdp"]), "{}", c["label"]);
    }
    // Coffres : magie (9) ‖ gen (8, gros-boutiste) ‖ nonce (12) ‖ AES-256-GCM(clé, nonce, clair,
    // AD = magie ‖ h ‖ gen) ; clair = longueur du JSON (4, gros-boutiste) ‖ JSON ‖ zéros, de la
    // taille exacte du palier.
    for (section, magie, champ, cle) in [
        (
            "coffre_prive",
            b"SHH-ACCT1",
            "k_compte",
            cle_prive as fn(&[u8; 32]) -> _,
        ),
        ("coffre_profil", b"SHH-PROF1", "s_profil", cle_profil),
    ] {
        let cases = v[section].as_array().unwrap();
        assert!(cases.len() >= 2, "{section}");
        for c in cases {
            let src = key32(s(&c[champ]));
            assert!(
                cles.iter().any(|k| k[champ] == c[champ]),
                "{section} : clé de `cles`"
            );
            let k = cle(&src);
            assert_eq!(hex(&*k), s(&c["cle"]), "{section}");
            let h = unhex(s(&c["h"]));
            let g = c["gen"].as_u64().unwrap().to_be_bytes();
            let ad = [magie.as_slice(), &h, &g].concat();
            assert_eq!(hex(&ad), s(&c["ad"]), "{section}");
            let json = utf8_hex(&c["json_hex"]);
            let palier = c["palier"].as_u64().unwrap() as usize;
            assert!([4096, 16384, 65536, 262144].contains(&palier));
            let mut clair = (json.len() as u32).to_be_bytes().to_vec();
            clair.extend_from_slice(json.as_bytes());
            assert!(
                clair.len() <= palier,
                "{section} : JSON trop long pour le palier"
            );
            clair.resize(palier, 0);
            let blob = [
                magie.as_slice(),
                &g,
                &aes_natif(&k, &unhex(s(&c["nonce"])), &ad, &clair),
            ]
            .concat();
            assert_eq!(blob.len(), 9 + 8 + 12 + palier + 16);
            assert_eq!(c["blob_len"].as_u64(), Some(blob.len() as u64));
            assert_eq!(hex(&sha256(&blob)), s(&c["blob_sha256"]), "{}", c["label"]);
            if let Some(b) = c.get("blob") {
                assert_eq!(hex(&blob), s(b), "{}", c["label"]);
            }
        }
    }
}

// ------------------------------------------------------------------------- propriétés

#[test]
fn canon_ne_depend_pas_de_la_variante() {
    let a = normaliser("Lea.Dupont+x@GMAIL.com").unwrap();
    let b = normaliser("leadupont@gmail.com").unwrap();
    let c = normaliser("  l.e.a.d.u.p.o.n.t+autre@googlemail.com ").unwrap();
    assert_eq!(a.canon, "leadupont@gmail.com");
    assert_eq!((&a.canon, &a.canon), (&b.canon, &c.canon));
    assert_ne!(a.exacte, b.exacte);
    assert_ne!(a.exacte, c.exacte);
    assert_eq!(sel(&a.canon), sel(&c.canon));
}

#[test]
fn pseudo_canon_identique_pour_variantes() {
    let c = pseudo_canon("Lea");
    for v in ["LEA", "lEa"] {
        assert_eq!(pseudo_canon(v), c, "{v}");
        assert_eq!(pseudo_canon(&pseudo_valide(v).unwrap()), c, "{v}");
    }
    // Accents, espaces, ponctuation, pleine chasse : refusés à l'affichage (20 novembre).
    for v in ["Léa", "lé a", "L-e.a", "ＬＥＡ"] {
        assert!(pseudo_valide(v).is_err(), "{v}");
    }
    assert_ne!(pseudo_canon("Léa"), c);
}

// P2 (audit du 21 novembre) : les lettres qui se ressemblent dans l'alphabet permis (A-Z, a-z,
// 0-9) ont la même clé, quelle que soit la casse : I, i, l et 1 ; O et 0 ; « rn » et « m ».
#[test]
fn pseudo_canon_homoglyphes() {
    for (a, b) in [
        ("Alice", "AIice"),
        ("Alice", "A1ice"),
        ("Alice", "ALICE"),
        ("Bob", "B0b"),
        ("Leo", "LE0"),
        ("Marin", "rnarin"),
        ("Paul", "PAUI"),
        ("admin", "ADMIN"),
    ] {
        assert_eq!(pseudo_canon(a), pseudo_canon(b), "{a} / {b}");
    }
    // Des pseudos vraiment différents restent différents.
    for (a, b) in [("Alice", "Alicia"), ("Leo", "Lea"), ("Max", "Mix")] {
        assert_ne!(pseudo_canon(a), pseudo_canon(b), "{a} / {b}");
    }
}

// Tests croisés de la casse (demande du propriétaire, 22 novembre) : le pseudo garde ses
// majuscules à l'affichage, mais toutes les casses d'un même pseudo ont une seule clé.
fn casses(m: &str) -> Vec<String> {
    let c: Vec<char> = m.chars().collect();
    (0u32..1 << c.len())
        .map(|bits| {
            c.iter()
                .enumerate()
                .map(|(i, x)| {
                    if bits >> i & 1 == 1 {
                        x.to_ascii_uppercase()
                    } else {
                        x.to_ascii_lowercase()
                    }
                })
                .collect()
        })
        .collect()
}

#[test]
fn pseudo_toutes_les_casses() {
    for m in [
        "lea", "Alice", "maxime", "Zorglub", "jean2", "x9y8z7", "MM", "rnrn", "ilo10",
    ] {
        let k = pseudo_canon(m);
        for v in casses(m) {
            assert_eq!(pseudo_canon(&v), k, "{v} / {m}");
            // L'affichage garde la casse telle quelle.
            assert_eq!(pseudo_valide(&v).unwrap(), v);
        }
    }
}

#[test]
fn pseudo_classes_ascii() {
    // Lettre par lettre (exploration exhaustive des 62 caractères permis et des 3 844 paires) :
    // les seules fusions sont I/i/L/l/1, O/o/0, M/m = « rn », et chaque lettre avec sa majuscule.
    let al: Vec<char> = ('A'..='Z').chain('a'..='z').chain('0'..='9').collect();
    let attendu = |c: char| -> String {
        match c.to_ascii_lowercase() {
            'i' | 'l' | '1' => "l".into(),
            'o' | '0' => "o".into(),
            'm' => "rn".into(),
            x => x.to_string(),
        }
    };
    for &a in &al {
        assert_eq!(pseudo_canon(&a.to_string()), attendu(a), "{a}");
        for &b in &al {
            let s = format!("{a}{b}");
            assert_eq!(pseudo_canon(&s), attendu(a) + &attendu(b), "{s}");
        }
    }
    // Limites connues, non fusionnées (signalées) : vv / w, cl / d, 5 / S, 8 / B, 2 / Z.
    for (a, b) in [
        ("vvalter", "walter"),
        ("clara", "dara"),
        ("5am", "Sam"),
        ("8ob", "Bob"),
        ("2oe", "Zoe"),
    ] {
        assert_ne!(pseudo_canon(a), pseudo_canon(b), "{a} / {b}");
    }
}

/// Forme que le serveur exige (compte/pseudo.go, FormeCanonique) : 2 à 48 octets a-z sans i ni m, 2-9.
fn forme_serveur(k: &str) -> bool {
    (2..=48).contains(&k.len())
        && k.bytes().all(|b| {
            (b.is_ascii_lowercase() && b != b'i' && b != b'm') || (b'2'..=b'9').contains(&b)
        })
}

#[test]
fn pseudo_cle_toujours_acceptee_par_le_serveur() {
    // Pseudos valables tirés de façon reproductible (2 à 24 caractères), plus les bornes.
    let al: Vec<char> = ('A'..='Z').chain('a'..='z').chain('0'..='9').collect();
    let mut x: u64 = 0x5eed;
    let mut suivant = || {
        x = x
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (x >> 33) as usize
    };
    let mut essais: Vec<String> = vec![
        "ab".into(),
        "MMMMMMMMMMMMMMMMMMMMMMMM".into(),
        "IIIIIIIIIIIIIIIIIIIIIIII".into(),
        "00".into(),
        "1l".into(),
    ];
    for _ in 0..5000 {
        let n = 2 + suivant() % 23;
        essais.push((0..n).map(|_| al[suivant() % al.len()]).collect());
    }
    for p in essais {
        let net = pseudo_valide(&p).unwrap_or_else(|e| panic!("{p} : {e:?}"));
        let k = pseudo_canon(&net);
        assert!(forme_serveur(&k), "{p} → {k}");
    }
}

#[test]
fn pseudo_bornes_et_refus() {
    assert!(pseudo_valide("A").is_err());
    assert!(pseudo_valide("Ab").is_ok());
    assert!(pseudo_valide(&"Ab".repeat(12)).is_ok());
    assert!(pseudo_valide(&format!("{}c", "Ab".repeat(12))).is_err());
    // Espaces autour : retirées ; au milieu, accents, autres écritures, pleine chasse, i turc,
    // ß, signes : refusés (A-Z, a-z, 0-9 seulement).
    assert_eq!(pseudo_valide("  Lea  ").unwrap(), "Lea");
    // Caractère invisible (espace sans chasse) : retiré, jamais gardé dans le pseudo.
    assert_eq!(pseudo_valide("Lea\u{200b}x").unwrap(), "Leax");
    for p in [
        "Le a",
        "Léa",
        "Lea!",
        "Le-a",
        "Le_a",
        "Ｌｅａ",
        "\u{130}lyas",
        "\u{131}lyas",
        "Stra\u{df}e",
        "Лea",
        "Le\u{301}a",
    ] {
        assert!(pseudo_valide(p).is_err(), "{p} accepté");
    }
}

#[test]
fn pseudo_reserve_toutes_les_casses_et_sosies() {
    for w in PSEUDOS_RESERVES.iter().filter(|w| w.is_ascii()) {
        for v in casses(w) {
            assert!(pseudo_reserve(&pseudo_canon(&v)), "{v}");
            let sosie: String = v
                .chars()
                .map(|c| match c {
                    'i' => '1',
                    'I' => 'l',
                    'o' => '0',
                    'O' => '0',
                    'm' => 'M',
                    x => x,
                })
                .collect();
            assert!(pseudo_reserve(&pseudo_canon(&sosie)), "{sosie}");
        }
    }
    let rn: String = "admin".replace('m', "rn");
    assert!(pseudo_reserve(&pseudo_canon(&rn)));
    assert!(!pseudo_reserve(&pseudo_canon("adminx")));
}

#[test]
fn cles_de_coffre_distinctes() {
    let k = derive("k_compte/a");
    let (p, f, d) = (cle_prive(&k), cle_profil(&k), cle_appareil(&k));
    assert_ne!(*p, *f);
    assert_ne!(*p, *d);
    assert_ne!(*f, *d);
    assert_ne!(*p, k);
    let (a, kek) = deriver("correct horse battery", "lea@exemple.fr").unwrap();
    assert_ne!(*a, *kek);
}

#[test]
fn reserves_de_la_conception() {
    // Conception §21.5, plus les formes accentuées qu'un francophone tape (signalé au propriétaire).
    let liste = [
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
    ];
    for w in liste {
        assert!(PSEUDOS_RESERVES.contains(&w), "{w}");
        assert!(pseudo_reserve(&pseudo_canon(w)), "{w}");
    }
    for w in ["modérateur", "modération", "équipe", "système", "sécurité"] {
        assert!(PSEUDOS_RESERVES.contains(&w), "{w}");
    }
    assert!(!pseudo_reserve(&pseudo_canon("Léa")));
    assert!(!pseudo_reserve(""));
}

#[test]
fn deriver_refuse_un_mot_de_passe_vide_sans_calcul() {
    assert_eq!(
        deriver("", "lea@exemple.fr").unwrap_err().to_string(),
        "mot_de_passe_vide"
    );
}

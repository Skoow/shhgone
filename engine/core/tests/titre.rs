// Nom du partage dans le manifeste v2 :
// engine/vectors/v2-titre.json, produit ici puis relu.
//
//   SHH_GEN_TITRE=1 cargo test -p shhdrop-core --test titre
//
// Les sorties attendues sont écrites à la main dans les tables ci-dessous : la génération échoue
// si le moteur s'en écarte. Sans la variable, le test échoue si le fichier n'est plus exactement
// celui que le moteur produit, et rejoue chaque cas à partir de ses seules entrées.
mod support;

use serde_json::{Value, json};
use shhdrop_core::elements::{FinalEntry, FinalKind, seal_final, seal_final_titled};
use shhdrop_core::envelope::content_keys;
use shhdrop_core::kdf::sha256;
use shhdrop_core::manifest::{
    Entry, Kind, Manifest, Rights, TITLE_MAX, clean_title, parse, title_for_seal, to_json,
};
use shhdrop_core::{Error, Seed};
use support::{block_on, hex, platform, unhex};
use zeroize::Zeroizing;

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/v2-titre.json");
const DATA: u64 = 65_536;

/// SHA-256(UTF-8(« shhdrop/vecteurs/v2-titre/ » + étiquette)).
fn derived(label: &str) -> [u8; 32] {
    sha256(format!("shhdrop/vecteurs/v2-titre/{label}").as_bytes())
}

fn opt_hex(s: Option<&str>) -> Value {
    s.map_or(Value::Null, |t| hex(t.as_bytes()).into())
}

// ---------------------------------------------------------------------------------- nettoyage

/// (étiquette, entrée, titre attendu à la lecture, refus attendu au scellement).
fn clean_table() -> Vec<(&'static str, String, Option<String>, bool)> {
    let a = |n: usize| "a".repeat(n);
    let emoji = |n: usize| "😀".repeat(n);
    vec![
        (
            "simple",
            "Photos de vacances".into(),
            Some("Photos de vacances".into()),
            false,
        ),
        ("vide", String::new(), None, false),
        (
            "blancs seulement (espace, tabulation, U+00A0, U+2028, U+3000)",
            " \t\u{a0}\u{2028}\u{3000} ".into(),
            None,
            false,
        ),
        (
            "blancs regroupés et rognés",
            "  Photos \t de\n\nvacances \r\n".into(),
            Some("Photos de vacances".into()),
            false,
        ),
        (
            "U+0085 (NEL) est une espace",
            "a\u{85}b".into(),
            Some("a b".into()),
            false,
        ),
        (
            "commandes C0, DEL et C1 retirées",
            "a\u{0}b\u{7f}c\u{9f}d\u{1b}e".into(),
            Some("abcde".into()),
            false,
        ),
        (
            "inversion de sens U+202E retirée",
            "\u{202e}gpj.exe".into(),
            Some("gpj.exe".into()),
            false,
        ),
        (
            "U+202A à U+202D retirés",
            "\u{202a}a\u{202b}b\u{202c}c\u{202d}".into(),
            Some("abc".into()),
            false,
        ),
        (
            "isolats U+2066 à U+2069 retirés",
            "a\u{2066}b\u{2067}c\u{2068}d\u{2069}".into(),
            Some("abcd".into()),
            false,
        ),
        (
            "LRM, RLM, ALM retirés",
            "a\u{200e}b\u{200f}c\u{61c}d".into(),
            Some("abcd".into()),
            false,
        ),
        (
            "largeur nulle, BOM, trait d'union conditionnel retirés",
            "a\u{200b}b\u{feff}c\u{ad}d\u{2060}e".into(),
            Some("abcde".into()),
            false,
        ),
        (
            "étiquettes et sélecteur U+FE0E retirés",
            "a\u{e0041}b\u{fe0e}c".into(),
            Some("abc".into()),
            false,
        ),
        (
            "retrait avant NFC : e + largeur nulle + accent",
            "e\u{200b}\u{301}".into(),
            Some("é".into()),
            false,
        ),
        (
            "NFC",
            "Cafe\u{301} Ångström".into(),
            Some("Café Ångström".into()),
            false,
        ),
        (
            "séquence emoji gardée (U+200D, U+FE0F)",
            "👨\u{200d}👩\u{200d}👧 ❤\u{fe0f}".into(),
            Some("👨\u{200d}👩\u{200d}👧 ❤\u{fe0f}".into()),
            false,
        ),
        (
            "texte brut gardé tel quel (balises, guillemets)",
            "<b>gras</b> & \"x\" \\ / '".into(),
            Some("<b>gras</b> & \"x\" \\ / '".into()),
            false,
        ),
        (
            "arabe et hébreu gardés",
            "تقرير שלום".into(),
            Some("تقرير שלום".into()),
            false,
        ),
        ("80 points de code", a(80), Some(a(80)), false),
        ("81 points de code", a(81), None, true),
        ("80 emoji (320 octets)", emoji(80), Some(emoji(80)), false),
        ("81 emoji", emoji(81), None, true),
        (
            "81 avant nettoyage, 80 après (largeur nulle)",
            format!("{}\u{200b}", a(80)),
            Some(a(80)),
            false,
        ),
        (
            "blancs intérieurs regroupés avant le compte",
            format!("{} {}", a(40), "b".repeat(39)).replace(' ', "     "),
            Some(format!("{} {}", a(40), "b".repeat(39))),
            false,
        ),
        (
            "compte après NFC : U+0344 devient deux points de code",
            format!("{}\u{344}", "-".repeat(79)),
            None,
            true,
        ),
    ]
}

fn clean_cases() -> Vec<Value> {
    clean_table()
        .into_iter()
        .map(|(label, input, want, too_long)| {
            let got = clean_title(&input);
            assert_eq!(got.as_ref().map(|t| t.as_str()), want.as_deref(), "{label}");
            if let Some(t) = &got {
                assert!(t.as_str().chars().count() <= TITLE_MAX, "{label}");
            }
            let seal = title_for_seal(&input);
            let seal = match (seal, too_long) {
                (Err(e), true) => {
                    assert_eq!(e, Error::TitreTropLong, "{label}");
                    json!({ "error": e.to_string() })
                }
                (Ok(t), false) => {
                    assert_eq!(t.as_ref().map(|t| t.as_str()), want.as_deref(), "{label}");
                    json!({ "title_hex": opt_hex(t.as_ref().map(|t| t.as_str())) })
                }
                (r, _) => panic!(
                    "{label} : {:?}",
                    r.map(|t| t.map(|t| t.as_str().to_owned()))
                ),
            };
            json!({
                "label": label,
                "in_hex": hex(input.as_bytes()),
                "title_hex": opt_hex(want.as_deref()),
                "seal": seal,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------- lecture

const ITEM: &str = r#"{"kind":"file","name":"a.bin","mime":"x/y","size":3,"offset":0}"#;

/// (étiquette, manifeste, titre attendu).
fn read_table() -> Vec<(&'static str, String, Option<&'static str>)> {
    let m = |extra: &str| format!(r#"{{"v":2,"rights":"enregistrer"{extra},"items":[{ITEM}]}}"#);
    vec![
        ("absent (ancien manifeste)", m(""), None),
        ("présent", m(r#","title":"Rapport T4""#), Some("Rapport T4")),
        ("nombre : ignoré", m(r#","title":5"#), None),
        ("null : ignoré", m(r#","title":null"#), None),
        ("tableau : ignoré", m(r#","title":["a"]"#), None),
        ("objet : ignoré", m(r#","title":{"a":"b"}"#), None),
        ("vide : ignoré", m(r#","title":"""#), None),
        ("blancs seulement : ignoré", m(r#","title":" \t\n ""#), None),
        (
            "nettoyé à la lecture (inversion de sens, blancs)",
            m(r#","title":"  \u202eabc  d\u0000 ""#),
            Some("abc d"),
        ),
        (
            "81 points de code : ignoré",
            m(&format!(r#","title":"{}""#, "a".repeat(81))),
            None,
        ),
        (
            "demi-paire isolée : U+FFFD",
            m(r#","title":"a\ud800""#),
            Some("a\u{fffd}"),
        ),
        (
            "clé répétée : la dernière compte",
            m(r#","title":"un","title":"deux""#),
            Some("deux"),
        ),
        (
            "après items, avec coffre",
            format!(r#"{{"v":2,"rights":"coffre","keep_ttl_h":6,"items":[{ITEM}],"title":"x"}}"#),
            Some("x"),
        ),
    ]
}

fn read_cases() -> Vec<Value> {
    read_table()
        .into_iter()
        .map(|(label, raw, want)| {
            let got = parse(raw.as_bytes(), DATA).expect(label);
            assert_eq!(got.title.as_ref().map(|t| t.as_str()), want, "{label}");
            // Le reste du manifeste ne dépend pas du titre.
            assert_eq!(got.items.len(), 1, "{label}");
            json!({ "label": label, "manifest_json": raw, "title_hex": opt_hex(want) })
        })
        .collect()
}

// ---------------------------------------------------------------------------------- écriture

fn entry() -> Entry {
    Entry {
        kind: Kind::File,
        name: "a.bin".into(),
        mime: "x/y".into(),
        size: 3,
        offset: 0,
        text: None,
        k: Some(Zeroizing::new(derived("k"))),
        clean: None,
        sha256: None,
    }
}

/// Étiquette, droits, durée, titre demandé, manifeste attendu (ITEM : l'entrée, graine comprise).
type WriteCase = (
    &'static str,
    &'static str,
    Option<u64>,
    Option<&'static str>,
    &'static str,
);

fn write_table() -> Vec<WriteCase> {
    vec![
        (
            "sans titre : inchangé",
            "enregistrer",
            None,
            None,
            r#"{"v":2,"rights":"enregistrer","items":[ITEM]}"#,
        ),
        (
            "titre après rights",
            "enregistrer",
            None,
            Some("Rapport T4"),
            r#"{"v":2,"rights":"enregistrer","title":"Rapport T4","items":[ITEM]}"#,
        ),
        (
            "titre après keep_ttl_h",
            "coffre",
            Some(12),
            Some("Rapport"),
            r#"{"v":2,"rights":"coffre","keep_ttl_h":12,"title":"Rapport","items":[ITEM]}"#,
        ),
        (
            "voir",
            "voir",
            None,
            Some("x"),
            r#"{"v":2,"rights":"voir","title":"x","items":[ITEM]}"#,
        ),
        (
            "échappements de JSON.stringify",
            "enregistrer",
            None,
            Some("a\"b\\c/é"),
            r#"{"v":2,"rights":"enregistrer","title":"a\"b\\c/é","items":[ITEM]}"#,
        ),
        (
            "écrit nettoyé",
            "enregistrer",
            None,
            Some(" \u{202e}a\tb "),
            r#"{"v":2,"rights":"enregistrer","title":"a b","items":[ITEM]}"#,
        ),
        (
            "vide après nettoyage : non écrit",
            "enregistrer",
            None,
            Some(" \u{200b} "),
            r#"{"v":2,"rights":"enregistrer","items":[ITEM]}"#,
        ),
    ]
}

fn item_json() -> String {
    let k = shhdrop_core::encoding::b64u(&derived("k"));
    format!(r#"{{"kind":"file","name":"a.bin","mime":"x/y","size":3,"offset":0,"k":"{k}"}}"#)
}

fn write_cases() -> Vec<Value> {
    write_table()
        .into_iter()
        .map(|(label, rights, ttl, title, want)| {
            let m = Manifest {
                rights: Rights::new(rights, ttl).unwrap(),
                title: title.and_then(|t| title_for_seal(t).unwrap()),
                items: vec![entry()],
            };
            let json = to_json(&m);
            let want = want.replace("ITEM", &item_json());
            assert_eq!(std::str::from_utf8(&json).unwrap(), want, "{label}");
            // Relu : le même manifeste.
            assert_eq!(parse(&json, DATA).unwrap(), m, "{label}");
            json!({
                "label": label,
                "rights": rights,
                "keep_ttl_h": ttl,
                "title_in_hex": opt_hex(title),
                "manifest_json": want,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------- scellement

/// (étiquette, titre demandé, refus attendu).
fn seal_table() -> Vec<(&'static str, Option<String>, Option<Error>)> {
    vec![
        ("sans titre", None, None),
        ("avec titre", Some("Rapport T4 — équipe".into()), None),
        ("titre nettoyé", Some("  Rapport\u{202e}  T4 ".into()), None),
        (
            "titre vide après nettoyage",
            Some("\u{200b} \u{2066}".into()),
            None,
        ),
        ("80 points de code", Some("é".repeat(80)), None),
        (
            "81 points de code",
            Some("é".repeat(81)),
            Some(Error::TitreTropLong),
        ),
    ]
}

fn final_entries() -> Vec<FinalEntry> {
    vec![FinalEntry {
        kind: FinalKind::File(None),
        name: "a.bin".into(),
        mime: "x/y".into(),
        size: 3,
        first: 0,
        k: Zeroizing::new(derived("k")),
        sha256: None,
    }]
}

fn seal_case(r: &[u8], title: Option<&str>) -> Value {
    let p = platform(1);
    let keys = block_on(content_keys(&p, &Seed::from_slice(r).unwrap())).unwrap();
    match block_on(seal_final_titled(
        &final_entries(),
        &keys,
        Some("enregistrer"),
        None,
        title,
    )) {
        Err(e) => json!({ "error": e.to_string() }),
        Ok(fin) => json!({
            "bucket": fin.bucket,
            "header": hex(&fin.header),
            "tail_sha256": hex(&sha256(&fin.tail)),
        }),
    }
}

fn seal_cases() -> Vec<Value> {
    seal_table()
        .into_iter()
        .enumerate()
        .map(|(i, (label, title, err))| {
            let r = derived(&format!("r/{i}"));
            let out = seal_case(&r, title.as_deref());
            let mut c = json!({
                "label": label,
                "r": hex(&r),
                "entries": [{ "kind": "file", "name": "a.bin", "mime": "x/y", "size": 3, "first": 0, "k": hex(&derived("k")) }],
                "rights": "enregistrer",
                "title_in_hex": opt_hex(title.as_deref()),
            });
            match err {
                Some(e) => {
                    assert_eq!(out["error"], e.to_string(), "{label}");
                    c["error"] = out["error"].clone();
                }
                None => {
                    // Morceau du manifeste : celui du JSON écrit par `to_json` (cas d'écriture).
                    let m = Manifest {
                        rights: Rights::Enregistrer,
                        title: title.as_deref().and_then(|t| title_for_seal(t).unwrap()),
                        items: vec![entry()],
                    };
                    for k in ["bucket", "header", "tail_sha256"] {
                        c[k] = out[k].clone();
                    }
                    c["manifest_json"] = String::from_utf8(to_json(&m).to_vec()).unwrap().into();
                }
            }
            c
        })
        .collect()
}

fn build() -> Value {
    json!({
        "about": "Nom du partage (champ facultatif `title` du manifeste v2, 19 novembre), produit par le moteur Rust (engine/core/tests/titre.rs) ; voir engine/vectors/README.md.",
        "constants": { "TITLE_MAX": TITLE_MAX },
        "clean": clean_cases(),
        "read": read_cases(),
        "write": write_cases(),
        "seal": seal_cases(),
    })
}

fn text(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap();
    s.push('\n');
    s
}

fn str_of_hex(v: &Value) -> Option<String> {
    v.as_str().map(|h| String::from_utf8(unhex(h)).unwrap())
}

/// Rejoue chaque cas à partir de ses seules entrées.
fn replay_file(v: &Value) {
    assert_eq!(v["constants"]["TITLE_MAX"], TITLE_MAX);
    for c in v["clean"].as_array().unwrap() {
        let input = str_of_hex(&c["in_hex"]).unwrap();
        let got = clean_title(&input).map(|t| t.as_str().to_owned());
        assert_eq!(got, str_of_hex(&c["title_hex"]), "{}", c["label"]);
        let seal = match title_for_seal(&input) {
            Ok(t) => json!({ "title_hex": opt_hex(t.as_ref().map(|t| t.as_str())) }),
            Err(e) => json!({ "error": e.to_string() }),
        };
        assert_eq!(seal, c["seal"], "{}", c["label"]);
    }
    for c in v["read"].as_array().unwrap() {
        let m = parse(c["manifest_json"].as_str().unwrap().as_bytes(), DATA).unwrap();
        let got = m.title.as_ref().map(|t| t.as_str().to_owned());
        assert_eq!(got, str_of_hex(&c["title_hex"]), "{}", c["label"]);
    }
    for c in v["write"].as_array().unwrap() {
        let m = Manifest {
            rights: Rights::new(c["rights"].as_str().unwrap(), c["keep_ttl_h"].as_u64()).unwrap(),
            title: str_of_hex(&c["title_in_hex"]).and_then(|t| title_for_seal(&t).unwrap()),
            items: vec![entry()],
        };
        assert_eq!(
            std::str::from_utf8(&to_json(&m)).unwrap(),
            c["manifest_json"].as_str().unwrap(),
            "{}",
            c["label"]
        );
    }
    for c in v["seal"].as_array().unwrap() {
        let title = str_of_hex(&c["title_in_hex"]);
        let out = seal_case(&unhex(c["r"].as_str().unwrap()), title.as_deref());
        for k in ["bucket", "header", "tail_sha256", "error"] {
            assert_eq!(out.get(k), c.get(k), "{} : {k}", c["label"]);
        }
    }
}

#[test]
fn v2_titre() {
    let built = build();
    if std::env::var_os("SHH_GEN_TITRE").is_some() {
        std::fs::write(FILE, text(&built)).unwrap();
    }
    let raw = std::fs::read_to_string(FILE).expect("engine/vectors/v2-titre.json");
    assert_eq!(
        raw,
        text(&built),
        "v2-titre.json n'est plus celui du moteur"
    );
    replay_file(&serde_json::from_str(&raw).unwrap());
}

#[test]
fn sans_titre_seal_final_inchange() {
    // `seal_final` (sans titre) et `seal_final_titled(…, None)` : même morceau chiffré.
    let r = derived("r/0");
    let p = platform(1);
    let keys = block_on(content_keys(&p, &Seed::from_slice(&r).unwrap())).unwrap();
    let a = block_on(seal_final(&final_entries(), &keys, None, None)).unwrap();
    assert_eq!(seal_case(&r, None)["tail_sha256"], hex(&sha256(&a.tail)));
}

#[test]
fn ordre_des_refus() {
    let p = platform(1);
    let keys = block_on(content_keys(
        &p,
        &Seed::from_slice(&derived("r/0")).unwrap(),
    ))
    .unwrap();
    let long = "a".repeat(TITLE_MAX + 1);
    // Aucun élément, puis droits invalides : avant le titre.
    let e = block_on(seal_final_titled(&[], &keys, None, None, Some(&long)));
    assert_eq!(e.err(), Some(Error::Vide));
    let e = block_on(seal_final_titled(
        &final_entries(),
        &keys,
        Some("coffre"),
        None,
        Some(&long),
    ));
    assert_eq!(e.err(), Some(Error::DroitsInvalides));
    // Refus du titre : la clé n'est pas usée.
    let e = block_on(seal_final_titled(
        &final_entries(),
        &keys,
        None,
        None,
        Some(&long),
    ));
    assert_eq!(e.err(), Some(Error::TitreTropLong));
    assert!(
        block_on(seal_final_titled(
            &final_entries(),
            &keys,
            None,
            None,
            Some("ok")
        ))
        .is_ok()
    );
}

#[test]
fn debug_sans_titre() {
    let m = parse(
        format!(r#"{{"v":2,"title":"Secret projet","items":[{ITEM}]}}"#).as_bytes(),
        DATA,
    )
    .unwrap();
    let dbg = format!("{m:?}");
    assert!(m.title.is_some());
    assert!(!dbg.contains("Secret"), "{dbg}");
}

#[test]
fn entree_enorme_sans_panique() {
    // Nom démesuré passé au scellement (hôte hostile) : refus, linéaire.
    let big = "é".repeat(1_000_000);
    assert_eq!(title_for_seal(&big).err(), Some(Error::TitreTropLong));
    let blanks = " ".repeat(1_000_000);
    assert!(title_for_seal(&blanks).unwrap().is_none());
}

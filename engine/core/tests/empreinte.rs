// Empreinte SHA-256 facultative des fichiers dans le manifeste : engine/vectors/v2-empreinte.json, lu ici (lecture et écriture octet pour octet).
use serde_json::Value;
use shhdrop_core::manifest::{Clean, Entry, Kind, Manifest, Rights, parse, to_json};
use zeroize::Zeroizing;

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/v2-empreinte.json");

fn vectors() -> Value {
    serde_json::from_str(&std::fs::read_to_string(FILE).expect("v2-empreinte.json")).unwrap()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> [u8; 32] {
    let v: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect();
    v.try_into().unwrap()
}

#[test]
fn lecture() {
    let v = vectors();
    let cases = v["read"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    for c in cases {
        let m = parse(c["manifest_json"].as_str().unwrap().as_bytes(), 65_536).expect("lisible");
        let got = m.items[0].sha256.map(|h| hex(&h));
        assert_eq!(got.as_deref(), c["sha256"].as_str(), "{}", c["name"]);
    }
}

#[test]
fn ecriture() {
    let v = vectors();
    let cases = v["write"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for c in cases {
        let e = &c["entry"];
        let kind = if e["kind"] == "text" {
            Kind::Text
        } else {
            Kind::File
        };
        let m = Manifest {
            rights: Rights::new("enregistrer", None).unwrap(),
            title: None,
            items: vec![Entry {
                kind,
                name: "a.bin".into(),
                mime: "x/y".into(),
                size: 3,
                offset: 0,
                text: None,
                k: Some(Zeroizing::new([0; 32])),
                clean: e["clean"].as_str().map(|s| Clean::from_name(s).unwrap()),
                sha256: e["sha256"].as_str().map(unhex),
            }],
        };
        let json = to_json(&m);
        let want = c["manifest_json"].as_str().unwrap();
        assert_eq!(std::str::from_utf8(&json).unwrap(), want, "{}", c["name"]);
        // Relu tel quel : l'empreinte d'un fichier revient, celle d'une note n'est jamais écrite.
        let back = parse(&json, 65_536).unwrap();
        let expect = if kind == Kind::File {
            m.items[0].sha256
        } else {
            None
        };
        assert_eq!(back.items[0].sha256, expect, "{}", c["name"]);
    }
}

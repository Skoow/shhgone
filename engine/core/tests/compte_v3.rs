// Compte par passkey et clé de récupération (conception 2026-11-22-compte-passkey-design.md §5,
// §14) : entrée PRF, enveloppes de K_compte (par passkey PRF et par clé de récupération), clé de
// récupération (base32 de Crockford, caractère de contrôle, saisie tolérante), A_r et v_r, clés
// des coffres et des libellés tirées de K_compte, coffres, pseudo. Vecteurs communs :
// engine/vectors/compte-v3.json, rejoués par le site (web/src/engine/compte-v3.test.ts : WebAssembly
// et WebCrypto) et par le serveur (server/internal/compte/vecteurs_v3_test.go).
//
// Un seul auteur : ce test écrit tout le fichier (SHH_GEN_COMPTE_V3=1 cargo test -p shhdrop-core
// --test compte_v3), enveloppes et coffres compris, avec l'AES-256-GCM natif (RustCrypto, celui des
// apps) à nonces fixés ; le site refait chaque chiffré avec WebCrypto (celui du site) et doit
// obtenir les mêmes octets. Sans la variable, le test échoue si le fichier n'est plus exactement
// celui que produit le moteur, puis rejoue chaque cas à partir de ses seules entrées, avec des
// formules écrites à part.
//
// Les sorties attendues des tables (saisies de la clé, textes de référence, empreintes PRF) sont
// écrites à la main ou calculées par un programme indépendant (Python, hashlib et entiers), pas
// recopiées du moteur : la génération échoue si le moteur s'en écarte.
mod support;

use serde_json::{Map, Value, json};
use shhdrop_core::Error;
use shhdrop_core::compte::{
    CRED_ID_MAX, CleRecup, ENVELOPPE_LEN, PSEUDOS_RESERVES, RECUP_LEN, RECUP_TEXTE_LEN,
    ad_enveloppe_prf, ad_enveloppe_recup, cle_appareil, cle_prive, cle_profil, entree_prf, kek_prf,
    pseudo_canon, pseudo_reserve, sel_prf,
};
use shhdrop_core::kdf::{hkdf, sha256};
use shhdrop_core::platform::Key;
use support::pseudo::{pseudo_json, section_pseudo, utf8_hex};
use support::{block_on, hex, platform, splitmix, unhex};
use zeroize::Zeroizing;

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/compte-v3.json");

/// SHA-256(UTF-8(« shhdrop/vecteurs/compte-v3/ » + étiquette)), tronqué à `N` octets.
fn derive<const N: usize>(label: &str) -> [u8; N] {
    sha256(format!("shhdrop/vecteurs/compte-v3/{label}").as_bytes())[..N]
        .try_into()
        .unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("texte attendu : {v}"))
}

fn arr<const N: usize>(v: &Value) -> [u8; N] {
    unhex(s(v)).try_into().expect("taille")
}

fn recup(r: [u8; 16]) -> CleRecup {
    CleRecup::new(Zeroizing::new(r))
}

/// AES-256-GCM natif (RustCrypto, fournisseur des apps) à nonce donné : nonce ‖ chiffré ‖ tag.
fn aes_natif(cle: &[u8; 32], nonce: &[u8; 12], ad: &[u8], clair: &[u8]) -> Vec<u8> {
    let p = platform(1);
    let k = block_on(Key::import(&p, Zeroizing::new(*cle))).unwrap();
    let ct = block_on(k.seal_batch(ad, &[*nonce], clair, clair.len())).unwrap();
    [nonce.as_slice(), &ct[..]].concat()
}

/// Ouverture native : clair, ou `None` si l'étiquette est fausse.
fn aes_ouvrir(cle: &[u8; 32], ad: &[u8], scelle: &[u8]) -> Option<Vec<u8>> {
    let p = platform(1);
    let k = block_on(Key::import(&p, Zeroizing::new(*cle))).unwrap();
    let n: [u8; 12] = scelle[..12].try_into().unwrap();
    let o = block_on(k.open_batch(ad, &[n], &scelle[12..], scelle.len() - 12)).ok()?;
    let mut out = vec![0u8; shhdrop_core::platform::Opened::len(&o)];
    assert!(shhdrop_core::platform::Opened::copy_out(&o, 0, &mut out));
    Some(out)
}

// ------------------------------------------------------------------------- constantes

/// Entrée PRF et sel « hmac-secret » calculés par un programme indépendant (Python, hashlib) :
/// SHA-256(« shhdrop/v3/compte/prf/1 ») et SHA-256(« WebAuthn PRF » ‖ 0x00 ‖ entrée).
const ENTREE_PRF: &str = "df9d48c2f8764d6d30b74058358e6fee382b26ce2edc2c44f70428204fae11ca";
const SEL_PRF: &str = "3c8071bac598486f886f3025b8f9a350948aead4343b967083e3d9eed8edc9b0";

fn constants() -> Value {
    assert_eq!(hex(&entree_prf()), ENTREE_PRF);
    assert_eq!(hex(&sel_prf()), SEL_PRF);
    json!({
        "ad": { "magie": "SHH-CENV2", "recup": "recup" },
        "cred_id_max": CRED_ID_MAX,
        "enveloppe_len": ENVELOPPE_LEN,
        "entree_prf": hex(&entree_prf()),
        "sel_prf": hex(&sel_prf()),
        "etiquettes": {
            "entree_prf": "shhdrop/v3/compte/prf/1",
            "kek_prf": "shhdrop/v3/compte/enveloppe/prf",
            "a_r": "shhdrop/v3/compte/recup/acces",
            "kek_r": "shhdrop/v3/compte/recup/enveloppe",
            "k_prive": "shhdrop/v2/compte/blob",
            "k_profil": "shhdrop/v3/compte/profil",
            "k_etiquette": "shhdrop/v2/compte/appareil",
        },
        "recup": {
            "octets": RECUP_LEN,
            "texte": RECUP_TEXTE_LEN,
            "alphabet": "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
            "controle": "0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U",
            "groupes": [4, 4, 4, 4, 4, 4, 3],
        },
        "paliers": [4096, 16384, 65536, 262144],
        "pseudo": { "min": 2, "max": 24 },
        "reserves": PSEUDOS_RESERVES
            .iter()
            .map(|w| json!({ "mot": w, "p_canon_hex": hex(pseudo_canon(w).as_bytes()) }))
            .collect::<Vec<_>>(),
    })
}

// ------------------------------------------------------------------------- enveloppe_prf

fn section_enveloppe_prf() -> Value {
    let mut out = Vec::new();
    for (label, cred_len) in [
        ("a", 16usize),
        ("b", 64),
        ("court", 1),
        ("long", CRED_ID_MAX),
    ] {
        let p: [u8; 32] = derive(&format!("prf/{label}"));
        let h: [u8; 16] = derive(&format!("h/{label}"));
        let k: [u8; 32] = derive(&format!("k_compte/{label}"));
        let nonce: [u8; 12] = derive(&format!("nonce/prf/{label}"));
        let cred: Vec<u8> = (0..cred_len).map(|i| (i * 7 + cred_len) as u8).collect();
        let kek = kek_prf(&p);
        let ad = ad_enveloppe_prf(&h, &cred).unwrap();
        let env = aes_natif(&kek, &nonce, &ad, &k);
        assert_eq!(env.len(), ENVELOPPE_LEN);
        out.push(json!({
            "label": label, "p": hex(&p), "h": hex(&h), "cred_id": hex(&cred),
            "k_compte": hex(&k), "nonce": hex(&nonce),
            "kek": hex(&*kek), "ad": hex(&ad), "env": hex(&env),
        }));
    }
    for (label, n) in [
        ("cred_id_vide", 0usize),
        ("cred_id_trop_long", CRED_ID_MAX + 1),
    ] {
        let h: [u8; 16] = derive("h/a");
        let e = ad_enveloppe_prf(&h, &vec![1u8; n]).unwrap_err();
        out.push(json!({ "label": label, "h": hex(&h), "cred_id_len": n, "error": e.to_string() }));
    }
    Value::Array(out)
}

// ------------------------------------------------------------------------- cle_recup

/// Textes de référence calculés par un programme indépendant (Python : entier gros-boutiste
/// décalé de 2 bits, 26 chiffres de base 32, puis valeur mod 37) : (étiquette, R, texte).
fn textes_de_reference() -> Vec<(&'static str, [u8; 16], &'static str)> {
    let v = |n: u128| n.to_be_bytes();
    vec![
        ("zeros", [0; 16], "000000000000000000000000000"),
        ("uns", [0xff; 16], "ZZZZZZZZZZZZZZZZZZZZZZZZZW*"),
        (
            "suite",
            core::array::from_fn(|i| i as u8),
            "000G40R40M30E209185GR38E1W6",
        ),
        ("controle_32", v(32), "00000000000000000000000040*"),
        ("controle_36", v(36), "0000000000000000000000004GU"),
        ("e", derive("recup/e"), "ESW6BDM8Q170680XT8PFF47JVWP"),
        ("h", derive("recup/h"), "F8YV5G0B67HXAFD1VQRQYVME9C~"),
    ]
}

/// Clés de la section `texte` : références, puis une valeur pour chaque symbole de contrôle
/// propre (32 à 36), puis des clés tirées.
fn cles_texte() -> Vec<(String, [u8; 16])> {
    let mut v: Vec<(String, [u8; 16])> = textes_de_reference()
        .into_iter()
        .map(|(l, r, _)| (l.to_string(), r))
        .collect();
    for n in 33u128..=35 {
        v.push((format!("controle_{n}"), n.to_be_bytes()));
    }
    for l in ["a", "b", "c", "d", "f", "g"] {
        v.push((l.to_string(), derive(&format!("recup/{l}"))));
    }
    v
}

fn section_texte() -> Value {
    let refs = textes_de_reference();
    cles_texte()
        .into_iter()
        .map(|(label, r)| {
            let k = recup(r);
            let t = k.texte();
            if let Some((_, _, want)) = refs.iter().find(|x| x.0 == label) {
                assert_eq!(t.as_str(), *want, "{label}");
            }
            let controle = r.iter().fold(0u32, |a, &b| (a * 256 + b as u32) % 37);
            json!({
                "label": label, "r": hex(&r), "texte": t.as_str(),
                "affichage": k.affichage().as_str(), "controle": controle,
            })
        })
        .collect()
}

/// Attendu d'une saisie : la clé d'une étiquette de `cles_texte`, ou un code d'erreur.
enum Sa {
    Cle(&'static str),
    Err(&'static str),
}

fn cas_saisie() -> Vec<(&'static str, String, Sa)> {
    use Sa::{Cle, Err};
    let t = "ESW6BDM8Q170680XT8PFF47JVWP";
    let g = "ESW6-BDM8-Q170-680X-T8PF-F47J-VWP";
    let groupes: Vec<&str> = g.split('-').collect();
    let joint = |sep: &str| groupes.join(sep);
    let rempl = |i: usize, c: &str| {
        let mut x: Vec<String> = t.chars().map(String::from).collect();
        x[i] = c.into();
        x.concat()
    };
    let (lon, car, ctl) = (
        "cle_recup_longueur",
        "cle_recup_caractere",
        "cle_recup_controle",
    );
    vec![
        ("exacte", t.into(), Cle("e")),
        ("groupee", g.into(), Cle("e")),
        ("minuscules", g.to_lowercase(), Cle("e")),
        ("espaces", joint(" "), Cle("e")),
        ("blancs_de_bord", format!("  \t{g}\r\n"), Cle("e")),
        (
            "separateurs_meles",
            "ESW6 - BDM8-Q170 680X\tT8PF\nF47J  VWP".into(),
            Cle("e"),
        ),
        ("sans_separateur_minuscules", t.to_lowercase(), Cle("e")),
        ("i_pour_1", t.replace('1', "I"), Cle("e")),
        ("i_minuscule_pour_1", t.replace('1', "i"), Cle("e")),
        ("l_pour_1", t.replace('1', "L"), Cle("e")),
        ("l_minuscule_pour_1", t.replace('1', "l"), Cle("e")),
        ("o_pour_0", t.replace('0', "O"), Cle("e")),
        ("o_minuscule_pour_0", t.replace('0', "o"), Cle("e")),
        ("espace_insecable", joint("\u{a0}"), Cle("e")),
        ("espace_ideographique", joint("\u{3000}"), Cle("e")),
        ("trait_d_union", joint("\u{2010}"), Cle("e")),
        ("tiret_insecable", joint("\u{2011}"), Cle("e")),
        ("tiret_demi_cadratin", joint("\u{2013}"), Cle("e")),
        ("tiret_cadratin", joint("\u{2014}"), Cle("e")),
        ("signe_moins", joint("\u{2212}"), Cle("e")),
        ("zeros", "0".repeat(27), Cle("zeros")),
        ("zeros_en_o", "O".repeat(27), Cle("zeros")),
        (
            "controle_etoile",
            "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZW*".into(),
            Cle("uns"),
        ),
        (
            "controle_u_minuscule",
            "0000000000000000000000004gu".into(),
            Cle("controle_36"),
        ),
        (
            "controle_tilde",
            "f8yv5g0b67hxafd1vqrqyvme9c~".into(),
            Cle("h"),
        ),
        ("vide", "".into(), Err(lon)),
        ("separateurs_seuls", " - - \t".into(), Err(lon)),
        ("vingt_six", t[..26].into(), Err(lon)),
        ("vingt_huit", format!("{t}0"), Err(lon)),
        ("groupe_manquant", groupes[..6].join("-"), Err(lon)),
        ("tres_long", "0".repeat(5000), Err(lon)),
        (
            "espace_de_largeur_nulle",
            format!("{}\u{200b}{}", &t[..4], &t[4..]),
            Err(lon),
        ),
        ("u_en_donnee", rempl(0, "U"), Err(car)),
        ("etoile_en_donnee", rempl(0, "*"), Err(car)),
        ("dollar_en_donnee", rempl(26 - 1, "$"), Err(car)),
        ("lettre_accentuee", rempl(0, "É"), Err(car)),
        ("point", rempl(3, "."), Err(car)),
        ("souligne", rempl(5, "_"), Err(car)),
        ("chiffre_pleine_chasse", rempl(0, "\u{ff11}"), Err(car)),
        ("controle_hors_alphabet", rempl(26, "#"), Err(car)),
        ("controle_faux", rempl(26, "Q"), Err(ctl)),
        ("substitution", rempl(10, "8"), Err(ctl)),
        (
            "transposition",
            "ESW6DBM8Q170680XT8PFF47JVWP".into(),
            Err(ctl),
        ),
        ("bourrage_non_nul", rempl(25, "X"), Err(ctl)),
        (
            "controle_u_remplace_par_v",
            "0000000000000000000000004GV".into(),
            Err(ctl),
        ),
        (
            "controle_tilde_pour_etoile",
            "ZZZZZZZZZZZZZZZZZZZZZZZZZW~".into(),
            Err(ctl),
        ),
    ]
}

fn saisie_json(entree: &str) -> Value {
    match CleRecup::lire(entree) {
        Ok(k) => json!({ "r": hex(k.octets()) }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

fn section_saisie() -> Value {
    let cles = cles_texte();
    cas_saisie()
        .into_iter()
        .map(|(label, entree, want)| {
            let mut v = saisie_json(&entree);
            match want {
                Sa::Cle(l) => {
                    let r = cles.iter().find(|x| x.0 == l).expect("clé de référence").1;
                    assert_eq!(v["r"], hex(&r), "{label}");
                }
                Sa::Err(e) => assert_eq!(v["error"], e, "{label}"),
            }
            v["label"] = label.into();
            v["entree_hex"] = hex(entree.as_bytes()).into();
            v
        })
        .collect()
}

// ------------------------------------------------------------------------- recup

fn section_recup() -> Value {
    ["a", "b", "e"]
        .iter()
        .map(|l| {
            let r: [u8; 16] = derive(&format!("recup/{l}"));
            let h: [u8; 16] = derive(&format!("h/{l}"));
            let k: [u8; 32] = derive(&format!("k_compte/{l}"));
            let nonce: [u8; 12] = derive(&format!("nonce/recup/{l}"));
            let c = recup(r);
            let kek = c.kek();
            let ad = ad_enveloppe_recup(&h);
            let env = aes_natif(&kek, &nonce, &ad, &k);
            assert_eq!(env.len(), ENVELOPPE_LEN);
            json!({
                "label": l, "r": hex(&r), "texte": c.texte().as_str(), "h": hex(&h),
                "k_compte": hex(&k), "nonce": hex(&nonce),
                "a_r": hex(&*c.acces()), "v_r": hex(&c.verificateur()), "kek_r": hex(&*kek),
                "ad": hex(&ad), "env_r": hex(&env),
            })
        })
        .collect()
}

// ------------------------------------------------------------------------- cles, coffres

fn section_cles() -> Value {
    ["a", "b"]
        .iter()
        .map(|l| {
            let k: [u8; 32] = derive(&format!("k_compte/{l}"));
            json!({
                "label": l,
                "k_compte": hex(&k),
                "k_prive": hex(&*cle_prive(&k)),
                "k_profil": hex(&*cle_profil(&k)),
                "k_etiquette": hex(&*cle_appareil(&k)),
            })
        })
        .collect()
}

/// JSON de `n` octets exactement (remplissage dans un champ `x`), comme gen-compte-vectors.mjs.
fn remplir(base: &str, n: usize) -> String {
    let vide = format!("{base},\"x\":\"\"}}");
    assert!(vide.len() <= n);
    format!("{base},\"x\":\"{}\"}}", "a".repeat(n - vide.len()))
}

fn coffre(
    magie: &[u8; 9],
    cle: &[u8; 32],
    label: &str,
    cles: &str,
    numero: u64,
    json: &str,
) -> Value {
    let h: [u8; 16] = derive(&format!("h/{cles}"));
    let nonce: [u8; 12] = derive(&format!(
        "nonce/{}/{label}",
        core::str::from_utf8(magie).unwrap()
    ));
    let g = numero.to_be_bytes();
    let ad = [magie.as_slice(), &h, &g].concat();
    let palier = [4096usize, 16384, 65536, 262144]
        .into_iter()
        .find(|p| 4 + json.len() <= *p)
        .expect("palier");
    let mut clair = (json.len() as u32).to_be_bytes().to_vec();
    clair.extend_from_slice(json.as_bytes());
    clair.resize(palier, 0);
    let blob = [magie.as_slice(), &g, &aes_natif(cle, &nonce, &ad, &clair)].concat();
    assert_eq!(blob.len(), palier + 45);
    let mut v = json!({
        "label": label, "cles": cles, "cle": hex(cle), "h": hex(&h), "gen": numero,
        "nonce": hex(&nonce), "ad": hex(&ad), "json_hex": hex(json.as_bytes()), "palier": palier,
        "blob_len": blob.len(), "blob_sha256": hex(&sha256(&blob)),
    });
    if palier == 4096 {
        v["blob"] = hex(&blob).into();
    }
    v
}

fn section_coffre_profil() -> Value {
    let ka: [u8; 32] = derive("k_compte/a");
    let kb: [u8; 32] = derive("k_compte/b");
    json!([
        coffre(
            b"SHH-PROF1",
            &cle_profil(&ka),
            "petit",
            "a",
            1,
            r#"{"v":1,"pseudo":"Lea","langue":"fr"}"#
        ),
        coffre(
            b"SHH-PROF1",
            &cle_profil(&kb),
            "palier_16_kio",
            "b",
            1 << 40,
            &remplir(r#"{"v":1,"pseudo":"Alice""#, 4093)
        ),
    ])
}

fn section_coffre_prive() -> Value {
    let ka: [u8; 32] = derive("k_compte/a");
    json!([
        coffre(
            b"SHH-ACCT1",
            &cle_prive(&ka),
            "petit",
            "a",
            1,
            r#"{"v":1,"salons":[],"recus":[],"rejoints":[],"envois":[]}"#
        ),
        coffre(
            b"SHH-ACCT1",
            &cle_prive(&ka),
            "plein_4_kio",
            "a",
            2,
            &remplir(r#"{"v":1"#, 4092)
        ),
    ])
}

// ------------------------------------------------------------------------- fichier

fn build() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "about".into(),
        "Compte par passkey et clé de récupération (conception 2026-11-22-compte-passkey-design.md §5), produit en entier par le moteur Rust (engine/core/tests/compte_v3.rs, AES-256-GCM natif à nonces fixés) ; voir engine/vectors/README.md.".into(),
    );
    m.insert("constants".into(), constants());
    m.insert("enveloppe_prf".into(), section_enveloppe_prf());
    m.insert(
        "cle_recup".into(),
        json!({ "texte": section_texte(), "saisie": section_saisie() }),
    );
    m.insert("recup".into(), section_recup());
    m.insert("cles".into(), section_cles());
    m.insert("coffre_profil".into(), section_coffre_profil());
    m.insert("coffre_prive".into(), section_coffre_prive());
    m.insert("pseudo".into(), section_pseudo());
    m
}

fn text(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap();
    s.push('\n');
    s
}

fn lire() -> (String, Value) {
    let raw = std::fs::read_to_string(FILE).expect("engine/vectors/compte-v3.json");
    let v = serde_json::from_str(&raw).expect("JSON de compte-v3.json");
    (raw, v)
}

#[test]
fn fichier_a_jour() {
    let built = Value::Object(build());
    if std::env::var_os("SHH_GEN_COMPTE_V3").is_some() {
        std::fs::write(FILE, text(&built)).unwrap();
    }
    let (raw, file) = lire();
    assert_eq!(
        raw,
        text(&file),
        "compte-v3.json n'est pas sous forme canonique"
    );
    assert_eq!(file, built, "compte-v3.json n'est plus celui du moteur");
}

// ------------------------------------------------------------------------- rejeu, entrées seules

#[test]
fn vecteurs_constantes() {
    let (_, v) = lire();
    let c = &v["constants"];
    // Formules écrites à part.
    let e = sha256(s(&c["etiquettes"]["entree_prf"]).as_bytes());
    assert_eq!(hex(&e), s(&c["entree_prf"]));
    let sel = sha256(&[b"WebAuthn PRF\0".as_slice(), &e].concat());
    assert_eq!(hex(&sel), s(&c["sel_prf"]));
    assert_eq!(c["enveloppe_len"], 12 + 32 + 16);
    assert_eq!(c["recup"]["texte"], 27);
    assert_eq!(
        c["recup"]["groupes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap())
            .sum::<u64>(),
        27
    );
    for r in c["reserves"].as_array().unwrap() {
        assert!(pseudo_reserve(&utf8_hex(&r["p_canon_hex"])), "{}", r["mot"]);
    }
}

#[test]
fn vecteurs_enveloppe_prf() {
    let (_, v) = lire();
    let cases = v["enveloppe_prf"].as_array().unwrap();
    assert!(cases.len() >= 6);
    for c in cases {
        let h: [u8; 16] = arr(&c["h"]);
        if let Some(e) = c.get("error") {
            let n = c["cred_id_len"].as_u64().unwrap() as usize;
            assert_eq!(
                ad_enveloppe_prf(&h, &vec![1u8; n]).unwrap_err().to_string(),
                s(e)
            );
            continue;
        }
        let p: [u8; 32] = arr(&c["p"]);
        let cred = unhex(s(&c["cred_id"]));
        let k: [u8; 32] = arr(&c["k_compte"]);
        let kek = kek_prf(&p);
        assert_eq!(hex(&*kek), s(&c["kek"]), "{}", c["label"]);
        assert_eq!(
            hex(&*hkdf::<32>(&p, "shhdrop/v3/compte/enveloppe/prf")),
            s(&c["kek"])
        );
        let ad = [b"SHH-CENV2".as_slice(), &h, &sha256(&cred)].concat();
        assert_eq!(hex(&ad), s(&c["ad"]));
        assert_eq!(ad_enveloppe_prf(&h, &cred).unwrap(), ad);
        let env = unhex(s(&c["env"]));
        assert_eq!(
            aes_natif(&kek, &arr(&c["nonce"]), &ad, &k),
            env,
            "{}",
            c["label"]
        );
        assert_eq!(aes_ouvrir(&kek, &ad, &env).as_deref(), Some(&k[..]));
        // Liée à sa passkey et à son compte : un autre cred_id, un autre h ou une autre sortie
        // PRF ne l'ouvrent pas.
        let mut autre = cred.clone();
        autre[0] ^= 1;
        assert!(aes_ouvrir(&kek, &ad_enveloppe_prf(&h, &autre).unwrap(), &env).is_none());
        let mut h2 = h;
        h2[15] ^= 1;
        assert!(aes_ouvrir(&kek, &ad_enveloppe_prf(&h2, &cred).unwrap(), &env).is_none());
        let mut p2 = p;
        p2[0] ^= 1;
        assert!(aes_ouvrir(&kek_prf(&p2), &ad, &env).is_none());
    }
}

#[test]
fn vecteurs_cle_recup_texte() {
    let (_, v) = lire();
    let cases = v["cle_recup"]["texte"].as_array().unwrap();
    let mut symboles = std::collections::BTreeSet::new();
    for c in cases {
        let r: [u8; 16] = arr(&c["r"]);
        let k = recup(r);
        let t = s(&c["texte"]);
        assert_eq!(k.texte().as_str(), t, "{}", c["label"]);
        assert_eq!(k.affichage().as_str(), s(&c["affichage"]), "{}", c["label"]);
        // Formule écrite à part : entier gros-boutiste décalé de 2 bits, 26 chiffres de base 32,
        // puis le symbole de contrôle de la valeur mod 37.
        const A: &[u8; 37] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U";
        let n = u128::from_be_bytes(r);
        let x = n << 2;
        let mut want: String = (0..26)
            .map(|i| A[((x >> (5 * (25 - i))) & 31) as usize] as char)
            .collect();
        // Le décalage de 2 bits perd les 2 bits de tête d'un u128 : le premier chiffre est refait
        // à partir des 5 bits de tête (3 + 2 bits de la suite).
        want.replace_range(0..1, &(A[(n >> 123) as usize] as char).to_string());
        want.push(A[(n % 37) as usize] as char);
        assert_eq!(t, want, "{}", c["label"]);
        assert_eq!(c["controle"].as_u64(), Some((n % 37) as u64));
        let groupes: Vec<&str> = s(&c["affichage"]).split('-').collect();
        assert_eq!(
            groupes.iter().map(|g| g.len()).collect::<Vec<_>>(),
            [4, 4, 4, 4, 4, 4, 3]
        );
        assert_eq!(groupes.concat(), t);
        symboles.insert(t.chars().last().unwrap());
    }
    // Chaque symbole de contrôle propre (32 à 36) apparaît au moins une fois.
    for x in ['*', '~', '$', '=', 'U'] {
        assert!(symboles.contains(&x), "{x}");
    }
}

#[test]
fn vecteurs_cle_recup_saisie() {
    let (_, v) = lire();
    let cases = v["cle_recup"]["saisie"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for c in cases {
        let got = saisie_json(&utf8_hex(&c["entree_hex"]));
        for k in ["r", "error"] {
            assert_eq!(got.get(k), c.get(k), "{} : {k}", c["label"]);
        }
    }
}

#[test]
fn vecteurs_recup() {
    let (_, v) = lire();
    for c in v["recup"].as_array().unwrap() {
        let r: [u8; 16] = arr(&c["r"]);
        let h: [u8; 16] = arr(&c["h"]);
        let k = recup(r);
        assert_eq!(CleRecup::lire(s(&c["texte"])).unwrap().octets(), &r);
        // Formules écrites à part.
        let a = hkdf::<32>(&r, "shhdrop/v3/compte/recup/acces");
        assert_eq!(hex(&*k.acces()), s(&c["a_r"]));
        assert_eq!(hex(&*a), s(&c["a_r"]));
        assert_eq!(hex(&sha256(&*a)), s(&c["v_r"]));
        assert_eq!(hex(&k.verificateur()), s(&c["v_r"]));
        let kek = hkdf::<32>(&r, "shhdrop/v3/compte/recup/enveloppe");
        assert_eq!(hex(&*k.kek()), s(&c["kek_r"]));
        assert_eq!(hex(&*kek), s(&c["kek_r"]));
        let ad = [b"SHH-CENV2".as_slice(), &h, b"recup"].concat();
        assert_eq!(ad_enveloppe_recup(&h), ad);
        assert_eq!(hex(&ad), s(&c["ad"]));
        let env = unhex(s(&c["env_r"]));
        let kc: [u8; 32] = arr(&c["k_compte"]);
        assert_eq!(aes_natif(&kek, &arr(&c["nonce"]), &ad, &kc), env);
        assert_eq!(aes_ouvrir(&kek, &ad, &env).as_deref(), Some(&kc[..]));
        // A_r (envoyé au serveur) n'ouvre pas l'enveloppe ; v_r ne la donne pas non plus.
        assert!(aes_ouvrir(&a, &ad, &env).is_none());
        assert_ne!(*a, *kek);
    }
}

#[test]
fn vecteurs_cles() {
    let (_, v) = lire();
    for c in v["cles"].as_array().unwrap() {
        let k: [u8; 32] = arr(&c["k_compte"]);
        assert_eq!(hex(&*cle_prive(&k)), s(&c["k_prive"]));
        assert_eq!(hex(&*cle_profil(&k)), s(&c["k_profil"]));
        assert_eq!(hex(&*cle_appareil(&k)), s(&c["k_etiquette"]));
        assert_eq!(
            hex(&*hkdf::<32>(&k, "shhdrop/v2/compte/blob")),
            s(&c["k_prive"])
        );
        assert_eq!(
            hex(&*hkdf::<32>(&k, "shhdrop/v3/compte/profil")),
            s(&c["k_profil"])
        );
        assert_eq!(
            hex(&*hkdf::<32>(&k, "shhdrop/v2/compte/appareil")),
            s(&c["k_etiquette"])
        );
    }
}

#[test]
fn vecteurs_coffres() {
    let (_, v) = lire();
    let cles = v["cles"].as_array().unwrap();
    for (section, magie, champ) in [
        ("coffre_profil", b"SHH-PROF1", "k_profil"),
        ("coffre_prive", b"SHH-ACCT1", "k_prive"),
    ] {
        let cases = v[section].as_array().unwrap();
        assert!(cases.len() >= 2, "{section}");
        for c in cases {
            let src = cles.iter().find(|k| k["label"] == c["cles"]).expect("cles");
            assert_eq!(c["cle"], src[champ], "{section}");
            let cle: [u8; 32] = arr(&c["cle"]);
            let h = unhex(s(&c["h"]));
            let g = c["gen"].as_u64().unwrap().to_be_bytes();
            let ad = [magie.as_slice(), &h, &g].concat();
            assert_eq!(hex(&ad), s(&c["ad"]));
            let json = utf8_hex(&c["json_hex"]);
            let palier = c["palier"].as_u64().unwrap() as usize;
            let mut clair = (json.len() as u32).to_be_bytes().to_vec();
            clair.extend_from_slice(json.as_bytes());
            clair.resize(palier, 0);
            let blob = [
                magie.as_slice(),
                &g,
                &aes_natif(&cle, &arr(&c["nonce"]), &ad, &clair),
            ]
            .concat();
            assert_eq!(c["blob_len"].as_u64(), Some(blob.len() as u64));
            assert_eq!(hex(&sha256(&blob)), s(&c["blob_sha256"]));
            if let Some(b) = c.get("blob") {
                assert_eq!(hex(&blob), s(b));
            }
        }
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
}

// ------------------------------------------------------------------------- propriétés

#[test]
fn cle_recup_aller_retour() {
    let mut rng = splitmix(0xC1E);
    for _ in 0..2000 {
        let mut r = [0u8; 16];
        rng(&mut r).unwrap();
        let k = recup(r);
        assert_eq!(CleRecup::lire(&k.texte()).unwrap().octets(), &r);
        assert_eq!(CleRecup::lire(&k.affichage()).unwrap().octets(), &r);
        assert_eq!(
            CleRecup::lire(&k.affichage().to_lowercase())
                .unwrap()
                .octets(),
            &r
        );
        assert_eq!(k.texte().len(), RECUP_TEXTE_LEN);
        assert!(
            k.texte()[..26]
                .bytes()
                .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
        );
    }
}

/// Toute substitution d'un seul caractère et toute transposition de deux caractères voisins
/// différents sont refusées (contrôle mod 37, premier, ou bits de bourrage) : jamais une autre
/// clé valable.
#[test]
fn cle_recup_fautes_de_frappe_detectees() {
    const A: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U";
    let mut rng = splitmix(0xFA07E);
    for _ in 0..40 {
        let mut r = [0u8; 16];
        rng(&mut r).unwrap();
        let t: Vec<u8> = recup(r).texte().as_bytes().to_vec();
        for i in 0..27 {
            for &c in A {
                if c == t[i] {
                    continue;
                }
                let mut x = t.clone();
                x[i] = c;
                let e = CleRecup::lire(core::str::from_utf8(&x).unwrap())
                    .map(|_| ())
                    .unwrap_err();
                let attendu = if i < 26 && !A[..32].contains(&c) {
                    Error::CleRecupCaractere
                } else {
                    Error::CleRecupControle
                };
                assert_eq!(e, attendu, "position {i}, {}", c as char);
            }
        }
        for i in 0..26 {
            if t[i] == t[i + 1] {
                continue;
            }
            let mut x = t.clone();
            x.swap(i, i + 1);
            let e = CleRecup::lire(core::str::from_utf8(&x).unwrap())
                .map(|_| ())
                .unwrap_err();
            // Le symbole de contrôle propre (32 à 36) passé en position 26 → caractère refusé.
            assert!(
                matches!(e, Error::CleRecupControle | Error::CleRecupCaractere),
                "transposition {i}"
            );
        }
    }
}

#[test]
fn entrees_prf_et_cles_distinctes() {
    let k: [u8; 32] = derive("k_compte/a");
    let cles = [
        *cle_prive(&k),
        *cle_profil(&k),
        *cle_appareil(&k),
        *kek_prf(&k),
    ];
    for i in 0..cles.len() {
        for j in 0..i {
            assert_ne!(cles[i], cles[j]);
        }
    }
    let r: [u8; 16] = derive("recup/a");
    let c = recup(r);
    assert_ne!(*c.acces(), *c.kek());
    assert_ne!(entree_prf(), sel_prf());
}

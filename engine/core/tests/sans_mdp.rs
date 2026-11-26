// Vecteurs du partage SANS MOT DE PASSE (D42-28) : engine/vectors/v6-sans-mdp.json, PRODUIT
// PAR CE MOTEUR. Chaque cas donne ses entrées et ses sorties ; le test les recalcule à partir des
// seules entrées du fichier et compare (Rust natif ici, WebAssembly et TypeScript dans
// web/src/engine/sans-mdp.test.ts ; les apps devront le rejouer de même).
//
// Ce que fixe le fichier :
// - le lien `{origine}{base}s#l<K_lien>` (marque « l » dans le fragment, jamais envoyée) et sa
//   lecture, à côté de l'ancienne forme `#<K_lien>` (toujours lue, avec mot de passe) ;
// - K_sans = HKDF-SHA-256(K_lien, sel vide, « shhdrop/v2/sans-mdp ») à la place de K_mdp, puis la
//   chaîne inchangée : K_maître = HKDF(K_lien ‖ K_sans, « shhdrop/v2/maitre »), K_env, K_preuve,
//   V_preuve, E (60 octets) — mêmes champs et mêmes tailles qu'avec un mot de passe.
//
// Régénérer (après un changement voulu, relu) :
//   SHH_GEN_SANS_MDP=1 cargo test -p shhdrop-core --test sans_mdp
// Le fichier est déterministe : aléa tiré d'un flux SHA-256 à étiquette fixe.
mod support;

use serde_json::{Value, json};
use shhdrop_core::envelope::{self, access_keys, content_keys, share_id};
use shhdrop_core::format;
use shhdrop_core::kdf::{NO_PASSWORD_INFO, derive_access, hkdf, no_password_key, sha256};
use shhdrop_core::link::{
    NO_PASSWORD_MARK, ParsedLink, parse_link, share_link, share_link_no_password,
    share_link_with_password, split_password,
};
use shhdrop_core::{Error, KLien, Seed};
use support::{block_on, hex, platform, replay, unhex};

const FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/v6-sans-mdp.json");
const ORIGIN: &str = "https://shhdrop.example";

/// Flux d'aléa : bloc i = SHA-256(UTF-8(« shhdrop/vecteurs/v6-sans-mdp/ » + étiquette) ‖ i sur 4
/// octets gros-boutistes).
fn stream(label: &str, n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n + 32);
    let mut i = 0u32;
    while out.len() < n {
        let mut m = format!("shhdrop/vecteurs/v6-sans-mdp/{label}").into_bytes();
        m.extend_from_slice(&i.to_be_bytes());
        out.extend_from_slice(&sha256(&m));
        i += 1;
    }
    out.truncate(n);
    out
}

fn key32(s: &str) -> [u8; 32] {
    unhex(s).try_into().unwrap()
}

fn merge(c: &mut Value, extra: Value) {
    let Value::Object(m) = extra else {
        panic!("objet attendu")
    };
    for (k, v) in m {
        c[k] = v;
    }
}

// --------------------------------------------------------------------------------- liens

fn parsed(r: Result<ParsedLink, Error>) -> Value {
    match r {
        Ok(ParsedLink::Share {
            origin,
            k_lien,
            no_password,
        }) => json!({ "kind": "s", "origin": origin, "key": hex(k_lien.as_bytes()),
                      "no_password": no_password }),
        Ok(ParsedLink::Manage { origin, s_gestion }) => {
            json!({ "kind": "m", "origin": origin, "key": hex(s_gestion.as_bytes()) })
        }
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// `{fn: "shareLinkNoPassword" | "shareLink", key, base}` → lien et sa relecture.
fn written_case(c: &Value) -> Value {
    let k = KLien::from_bytes(key32(c["key"].as_str().unwrap()));
    let base = c["base"].as_str().unwrap();
    let link = match c["fn"].as_str().unwrap() {
        "shareLinkNoPassword" => share_link_no_password(ORIGIN, &k, base),
        _ => share_link(ORIGIN, &k, base),
    }
    .unwrap();
    json!({ "link": link, "parsed": parsed(parse_link(&link, base)) })
}

fn parse_case(c: &Value) -> Value {
    parsed(parse_link(
        c["url"].as_str().unwrap(),
        c["base"].as_str().unwrap(),
    ))
}

/// QR code : `shareLinkWithPassword(link, password)` (refusé pour un lien sans mot de passe) et
/// `splitPassword(link)` (lien rendu tel quel, aucun mot de passe).
fn qr_case(c: &Value) -> Value {
    let link = c["link"].as_str().unwrap();
    let with = match share_link_with_password(link, c["password"].as_str().unwrap()) {
        Ok(q) => json!(q),
        Err(e) => json!({ "error": e.to_string() }),
    };
    let (href, pw) = split_password(link);
    json!({ "link_with_password": with, "split": { "href": href, "password": pw } })
}

fn links() -> Value {
    let mut written = Vec::new();
    // Clés dont le base64url commence par « l » (valeur 37 : premier octet 0x94 à 0x97) ou par
    // « m » (38 : 0x98 à 0x9b) : la marque n'est jamais confondue avec la clé.
    let key = |first: Option<u8>, label: &str| {
        let mut k = stream(label, 32);
        if let Some(f) = first {
            k[0] = f;
        }
        hex(&k)
    };
    for (label, f, k, base) in [
        (
            "sans_mdp",
            "shareLinkNoPassword",
            key(None, "sans-mdp"),
            "/",
        ),
        (
            "sans_mdp_base_demo",
            "shareLinkNoPassword",
            key(None, "demo"),
            "/shhgone/",
        ),
        (
            "sans_mdp_cle_en_l",
            "shareLinkNoPassword",
            key(Some(0x94), "cle-l"),
            "/",
        ),
        (
            "avec_mdp_cle_en_l",
            "shareLink",
            key(Some(0x94), "cle-l"),
            "/",
        ),
        (
            "sans_mdp_cle_en_m",
            "shareLinkNoPassword",
            key(Some(0x98), "cle-m"),
            "/",
        ),
        (
            "sans_mdp_cle_ff",
            "shareLinkNoPassword",
            "ff".repeat(32),
            "/",
        ),
        ("avec_mdp_cle_ff", "shareLink", "ff".repeat(32), "/"),
    ] {
        let mut c = json!({ "label": label, "fn": f, "key": k, "base": base });
        let x = written_case(&c);
        merge(&mut c, x);
        written.push(c);
    }
    let k = "Q".repeat(43);
    let mut urls: Vec<(&str, String, &str)> = vec![
        ("sans_mdp", format!("{ORIGIN}/s#l{k}"), "/"),
        ("ancien_lien_avec_mdp", format!("{ORIGIN}/s#{k}"), "/"),
        (
            "ancien_lien_cle_en_l",
            format!("{ORIGIN}/s#l{}", &k[1..]),
            "/",
        ),
        ("gestion", format!("{ORIGIN}/s#m{k}"), "/"),
        ("sans_mdp_requete", format!("{ORIGIN}/s?fbclid=x#l{k}"), "/"),
        (
            "sans_mdp_demo",
            format!("https://skoow.github.io/shhgone/s#l{k}"),
            "/shhgone/",
        ),
        ("sans_mdp_majuscule", format!("{ORIGIN}/s#L{k}"), "/"),
        ("sans_mdp_double_marque", format!("{ORIGIN}/s#ll{k}"), "/"),
        (
            "sans_mdp_trop_court",
            format!("{ORIGIN}/s#l{}", &k[2..]),
            "/",
        ),
        ("sans_mdp_trop_long", format!("{ORIGIN}/s#l{k}A"), "/"),
        (
            "sans_mdp_non_canonique",
            format!("{ORIGIN}/s#l{}R", &k[1..]),
            "/",
        ),
        (
            "sans_mdp_avec_mot_de_passe",
            format!("{ORIGIN}/s#l{k}.YUMzIWNENT8jRmc"),
            "/",
        ),
        ("sans_mdp_a_la_racine", format!("{ORIGIN}/#l{k}"), "/"),
        ("sans_mdp_autre_chemin", format!("{ORIGIN}/x#l{k}"), "/"),
    ];
    urls.sort_by_key(|u| u.0);
    let parse: Vec<Value> = urls
        .into_iter()
        .map(|(label, url, base)| {
            let mut c = json!({ "label": label, "url": url, "base": base });
            let x = json!({ "result": parse_case(&c) });
            merge(&mut c, x);
            c
        })
        .collect();
    let qr: Vec<Value> = [
        ("qr_sans_mdp", written[0]["link"].clone()),
        ("qr_sans_mdp_cle_en_l", written[2]["link"].clone()),
    ]
    .into_iter()
    .map(|(label, link)| {
        let mut c = json!({ "label": label, "link": link, "password": "aC3!cD5?#Fg" });
        let x = qr_case(&c);
        merge(&mut c, x);
        c
    })
    .collect();
    json!({ "origin": ORIGIN, "written": written, "parse": parse, "qr": qr })
}

// ------------------------------------------------------------------------------ dérivations

/// Partage sans mot de passe, de bout en bout : K_lien → K_sans → K_env, K_preuve, V_preuve ;
/// R → engagement → en-tête ; E = seal(K_env, R, id, en-tête) avec le nonce donné ; puis
/// relecture de E par le lien seul (R rendue). `k_maitre` et `k_env` : la chaîne HKDF écrite
/// à la main (K_env n'existe que comme poignée du fournisseur ; vérifiée par E).
fn key_case(c: &Value) -> Value {
    let k_lien = KLien::from_bytes(key32(c["k_lien"].as_str().unwrap()));
    let r_bytes = unhex(c["r"].as_str().unwrap());
    let nonce = unhex(c["envelope_nonce"].as_str().unwrap());
    let k_sans = no_password_key(&k_lien);
    let a = derive_access(&k_lien);
    let id = share_id(&k_lien);
    let mut ikm = k_lien.as_bytes().to_vec();
    ikm.extend_from_slice(k_sans.as_bytes());
    let k_maitre = hkdf::<32>(&ikm, "shhdrop/v2/maitre");
    let k_env = hkdf::<32>(&*k_maitre, "shhdrop/v2/enveloppe");
    // Aléa du fournisseur : seulement le nonce de E.
    let p = replay(vec![nonce]);
    let ak = block_on(access_keys(&p, &k_lien, &k_sans)).unwrap();
    let r = Seed::from_slice(&r_bytes).unwrap();
    let ck = block_on(content_keys(&platform(1), &r)).unwrap();
    let header = format::header(&ck.engagement);
    let e = block_on(envelope::seal(&ak.k_env, &r, &id, &header)).unwrap();
    // Ouverture : le lien seul suffit (K_sans recalculée).
    let p2 = platform(2);
    let ak2 = block_on(access_keys(&p2, &k_lien, &no_password_key(&k_lien))).unwrap();
    let r2 = block_on(envelope::open(&ak2.k_env, &e, &id, &header)).unwrap();
    assert_eq!(r2.as_bytes().as_slice(), r_bytes.as_slice());
    assert_eq!(ak2.v_preuve, ak.v_preuve);
    json!({
        "k_sans": hex(k_sans.as_bytes()),
        "k_acces": hex(a.k_acces.as_bytes()),
        "v_acces": hex(&a.v_acces),
        "id": hex(&id),
        "k_maitre": hex(&*k_maitre),
        "k_env": hex(&*k_env),
        "k_preuve": hex(ak.k_preuve.as_bytes()),
        "v_preuve": hex(&ak.v_preuve),
        "engagement": hex(&ck.engagement),
        "header": hex(&header),
        "envelope": hex(&e),
    })
}

fn keys() -> Value {
    ["a", "b", "zero"]
        .iter()
        .map(|label| {
            let k_lien = if *label == "zero" {
                "00".repeat(32)
            } else {
                hex(&stream(&format!("{label}/k_lien"), 32))
            };
            let mut c = json!({
                "label": label,
                "k_lien": k_lien,
                "r": hex(&stream(&format!("{label}/r"), 32)),
                "envelope_nonce": hex(&stream(&format!("{label}/nonce"), 12)),
            });
            let x = key_case(&c);
            merge(&mut c, x);
            c
        })
        .collect::<Vec<_>>()
        .into()
}

// ---------------------------------------------------------------------------------- fichier

fn build() -> Value {
    json!({
        "about": "Partage sans mot de passe (D42-28), produit par le moteur Rust (engine/core/tests/sans_mdp.rs) ; voir engine/vectors/README.md.",
        "constants": {
            "NO_PASSWORD_INFO": NO_PASSWORD_INFO,
            "NO_PASSWORD_MARK": NO_PASSWORD_MARK.to_string(),
            "ENVELOPE_LEN": envelope::ENVELOPE_LEN,
        },
        "links": links(),
        "keys": keys(),
    })
}

fn text(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).unwrap();
    s.push('\n');
    s
}

fn pick(c: &Value, keys: &[&str]) -> Value {
    let mut m = serde_json::Map::new();
    for k in keys {
        if let Some(x) = c.get(*k) {
            m.insert((*k).into(), x.clone());
        }
    }
    Value::Object(m)
}

/// Rejoue chaque cas du fichier à partir de ses seules entrées.
fn replay_file(v: &Value) {
    let l = &v["links"];
    assert_eq!(l["origin"], ORIGIN);
    for c in l["written"].as_array().unwrap() {
        assert_eq!(
            written_case(c),
            pick(c, &["link", "parsed"]),
            "{}",
            c["label"]
        );
    }
    for c in l["parse"].as_array().unwrap() {
        assert_eq!(parse_case(c), c["result"], "{}", c["label"]);
    }
    for c in l["qr"].as_array().unwrap() {
        assert_eq!(
            qr_case(c),
            pick(c, &["link_with_password", "split"]),
            "{}",
            c["label"]
        );
    }
    let outs = [
        "k_sans",
        "k_acces",
        "v_acces",
        "id",
        "k_maitre",
        "k_env",
        "k_preuve",
        "v_preuve",
        "engagement",
        "header",
        "envelope",
    ];
    for c in v["keys"].as_array().unwrap() {
        assert_eq!(key_case(c), pick(c, &outs), "{}", c["label"]);
    }
}

#[test]
fn v6_sans_mdp() {
    let built = build();
    if std::env::var_os("SHH_GEN_SANS_MDP").is_some() {
        std::fs::write(FILE, text(&built)).unwrap();
    }
    let raw = std::fs::read_to_string(FILE).expect("engine/vectors/v6-sans-mdp.json");
    let file: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        raw,
        text(&built),
        "v6-sans-mdp.json n'est plus celui du moteur"
    );
    replay_file(&file);
    // Couverture : formes attendues.
    let by = |label: &str| {
        file["links"]["parse"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["label"] == label)
            .unwrap()["result"]
            .clone()
    };
    assert_eq!(by("sans_mdp")["no_password"], true);
    assert_eq!(by("ancien_lien_avec_mdp")["no_password"], false);
    assert_eq!(by("ancien_lien_cle_en_l")["no_password"], false);
    assert_eq!(by("gestion")["kind"], "m");
    for bad in [
        "sans_mdp_majuscule",
        "sans_mdp_double_marque",
        "sans_mdp_trop_court",
        "sans_mdp_trop_long",
        "sans_mdp_non_canonique",
        "sans_mdp_avec_mot_de_passe",
        "sans_mdp_a_la_racine",
        "sans_mdp_autre_chemin",
    ] {
        assert_eq!(by(bad)["error"], "lien_invalide", "{bad}");
    }
    for c in file["keys"].as_array().unwrap() {
        assert_eq!(
            c["envelope"].as_str().unwrap().len(),
            2 * envelope::ENVELOPE_LEN
        );
        // K_sans n'est ni K_lien, ni K_accès (étiquettes séparées).
        assert_ne!(c["k_sans"], c["k_lien"]);
        assert_ne!(c["k_sans"], c["k_acces"]);
    }
}

/// Un partage protégé et un partage sans mot de passe de même K_lien n'ont pas la même
/// K_preuve : la forme du lien décide de la clé, jamais le serveur.
#[test]
fn sans_mdp_et_avec_mdp_different() {
    let k_lien = KLien::from_bytes([7; 32]);
    let p = platform(3);
    let sans = block_on(access_keys(&p, &k_lien, &no_password_key(&k_lien))).unwrap();
    let autre = shhdrop_core::KMdp::from_bytes([7; 32]);
    let avec = block_on(access_keys(&p, &k_lien, &autre)).unwrap();
    assert_ne!(sans.v_preuve, avec.v_preuve);
}

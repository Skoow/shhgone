// Le compte sur l'appareil (conception 2026-11-22-compte-passkey-design.md §3, §5, §17) contre
// un faux serveur en mémoire et un faux authentificateur (passkey.test-helper.ts) : inscription
// (PRF à la création, deuxième geste, sans PRF), connexion (enveloppes essayées une à une),
// repli par la clé locale ou la clé de récupération, réparation des enveloppes, passkeys,
// nouvelle clé, coffres, « Rester connecté », déconnexion qui efface tout (clé locale comprise).
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIndexedDB, type FakeIdb } from "../storage/fake-idb.test-helper";
import { b64u, unb64u } from "../engine/pure";
import { cleRecupDerivees, cleRecupLire, entreePrf } from "../engine/index";
import { clesDuCompte, ouvrirEnveloppesPrf, ouvrirRecup } from "./keys";
import { ouvrir, priveDeJson, priveEnJson, priveVide, profilDeJson, REGLAGES_DEFAUT, sceller } from "./vaults";
import { accountFlag } from "../app/account-flag.svelte";
import { ouvrirEtiquette } from "./device";
import { configurerNavigateur } from "./webauthn";
import { FauxAuthentificateur, fauxServeur } from "./passkey.test-helper";
import * as C from "./session.svelte";
import { garder, lirePasses, nouvelId, tirerPass, type PassGarde } from "../paiement/pass";
import { passEnEntree } from "./pass";
import { formulesDisponibles } from "../paiement/jetons";
import { memoryBackend } from "../storage/idb";
import { configurerPartages, garderPartage, retirerPartage, tousLesPartages } from "../storage/partages.svelte";

const PREUVE = { altcha: "preuve", hp: "", shown_at: "t" };
/** Preuve anti-robot de connexion/fin et de recup : comptée, pour savoir QUAND elle est demandée. */
let preuvesDemandees = 0;
const P = async () => {
  preuvesDemandees++;
  return { altcha: `preuve-${preuvesDemandees}`, hp: "", shown_at: "t" };
};
const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
type Bytes = Uint8Array<ArrayBuffer>;

let srv: ReturnType<typeof fauxServeur>;
let idb: FakeIdb;
let auth: FauxAuthentificateur;
let signalees: { rpId: string; credentialId: string }[];
/** Tableaux de 32 octets tirés par crypto.getRandomValues côté appareil (K_compte). */
let tires: Uint8Array[];

function brancher(a: FauxAuthentificateur) {
  auth = a;
  configurerNavigateur(() => a.navigateur(signalees));
}

beforeEach(() => {
  srv = fauxServeur();
  idb = fakeIndexedDB();
  tires = [];
  signalees = [];
  const real = crypto.getRandomValues.bind(crypto);
  vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
    const out = real(a as never) as T;
    if (a instanceof Uint8Array && a.length === 32) tires.push(a);
    return out;
  });
  C.configurerCompte({
    net: { origin: "https://shh.test", fetch: srv.fetch },
    idb: () => idb,
    agent: () => UA,
    rpId: () => "shh.test",
  });
  brancher(new FauxAuthentificateur({ prf: "creation" }));
});
afterEach(async () => {
  await C.seDeconnecter();
  configurerNavigateur(null);
  vi.restoreAllMocks();
});

/** Inscription complète ; rend la clé de récupération affichée. */
async function inscription(pseudo = "Lea", persistante = false): Promise<string> {
  await C.preparerInscription(PREUVE);
  const r = await C.creerPasskey(pseudo, "fr");
  if (r === "second") await C.deuxiemeGeste();
  const cle = C.cleAffichee();
  await C.terminerInscription(persistante);
  return cle;
}
const compte = () => [...srv.comptes.values()][0]!;
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest()) as Bytes;
/** Ce qu'aucune requête ne doit porter : sorties PRF, PRF annoncée en résultat, hmac-secret. */
function rienDePrf() {
  const tout = srv.requetes.map((r) => r.brut).join("\n");
  expect(tout).not.toMatch(/"results"|hmacGetSecret/);
  for (const s of auth.sorties) {
    expect(tout).not.toContain(b64u(s));
    expect(tout).not.toContain(Buffer.from(s).toString("base64"));
    expect(tout).not.toContain(Buffer.from(s).toString("hex"));
  }
}
/** Déconnexion de la page sans toucher au serveur ni à l'appareil (un rechargement). */
const recharger = () => C._oublierMemoire();

describe("inscription par passkey", () => {
  it("PRF à la création : enveloppe, Env_r et v_r justes ; le profil s'ouvre par K_compte ; rien de PRF ni de la clé ne part", async () => {
    const texte = await inscription();
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.profil?.pseudo).toBe("Lea");
    expect(C.account.cleLocale).toBe(false);
    expect(texte).toMatch(/^([0-9A-Z*~$=]{4}-){6}[0-9A-Z*~$=]{3}$/);
    // Le pseudo est dans la feuille du système (Q6), jamais dans une requête (seul p_canon part).
    expect(auth.creations[0]!.user.name).toBe("Lea");
    const fin = srv.requetes.find((r) => r.path.endsWith("inscription/fin"))!;
    expect(fin.body.p_canon).toBe("lea");
    const lisibles = JSON.stringify(srv.requetes.map((r) => r.body), (_k, v) => (typeof v === "string" && /^[A-Za-z0-9_-]{40,}$/.test(v) ? "" : v));
    expect(lisibles).not.toContain("Lea");
    // Entrée PRF : E_prf du moteur, pas celle (fausse) des options du serveur.
    expect(b64u(auth.entrees[0]!)).toBe(b64u(await entreePrf()));
    expect(b64u(auth.entrees[0]!)).not.toBe(srv.FAUSSE_ENTREE);
    rienDePrf();
    // La clé de récupération et K_compte ne partent pas : seuls v_r et Env_r.
    const r = await cleRecupLire(texte);
    const d = await cleRecupDerivees(r);
    const c = compte();
    expect(c.vR).toBe(b64u(sha(d.aR)));
    const tout = srv.requetes.map((x) => x.brut).join("\n");
    for (const x of [texte, texte.replaceAll("-", ""), b64u(r), b64u(d.aR), b64u(d.kekR)]) expect(tout).not.toContain(x);
    const k = await ouvrirRecup(d.kekR, c.h, unb64u(c.envR));
    expect(tout).not.toContain(b64u(k));
    // L'enveloppe PRF s'ouvre avec la sortie de la passkey.
    const p = auth.passkeys[0]!;
    const kPrf = await ouvrirEnveloppesPrf(auth.sortie(p, await entreePrf())!, c.h, p.id, c.passkeys[0]!.envs.map(unb64u));
    expect(kPrf).toEqual(k);
    const cles = await clesDuCompte(k);
    expect(profilDeJson(await ouvrir("profil", cles.profil, c.h, c.coffres.profil.blob, 1)).pseudo).toBe("Lea");
    expect(priveDeJson(await ouvrir("prive", cles.prive, c.h, c.coffres.prive.blob, 1)).salons).toEqual([]);
    expect(await ouvrirEtiquette(cles.etiquette, c.h, unb64u(c.passkeys[0]!.etiquette))).toBe("Firefox · ordinateur");
    // Rien d'écrit sur l'appareil sans « Rester connecté » (la passkey ouvre les données).
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("PRF seulement annoncé : deuxième geste, l'enveloppe est faite", async () => {
    brancher(new FauxAuthentificateur({ prf: "annonce" }));
    await C.preparerInscription(PREUVE);
    expect(await C.creerPasskey("Lea", "fr")).toBe("second");
    auth.o.prf = "creation";
    expect(await C.deuxiemeGeste()).toBe(true);
    await C.terminerInscription(false);
    expect(compte().passkeys[0]!.envs).toHaveLength(1);
    expect(C.account.cleLocale).toBe(false);
    rienDePrf();
  });

  it("passkey sans PRF : aucune enveloppe ; K_compte gardée sur l'appareil, dit à l'écran ; effacée à la déconnexion", async () => {
    brancher(new FauxAuthentificateur({ prf: "absent" }));
    await inscription();
    expect(compte().passkeys[0]!.envs).toEqual([]);
    expect((srv.requetes.find((r) => r.path.endsWith("inscription/fin"))!.body as { env: string }).env).toBe("");
    expect(C.account.cleLocale).toBe(true);
    expect([...idb.raw().keys()]).toEqual(["shhdrop-compte"]);
    // Rechargement : la passkey connecte, la clé locale ouvre les données, sans clé de récupération.
    recharger();
    await C.preparerConnexion();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    expect(C.account.cleLocale).toBe(true);
    // Déconnexion : clé locale effacée ; la connexion suivante demande la clé de récupération.
    await C.seDeconnecter();
    expect([...idb.raw().keys()]).toEqual([]);
    expect(await C.seConnecter(false, "defaut", P)).toBe("cle_requise");
    expect(C.cleRequise()).toBe(true);
  });

  it("annulation de la feuille : « annule », rien n'est créé ni envoyé", async () => {
    await C.preparerInscription(PREUVE);
    auth.o.annuler = true;
    await expect(C.creerPasskey("Lea", "fr")).rejects.toThrow("annule");
    expect(srv.requetes.some((r) => r.path.endsWith("inscription/fin"))).toBe(false);
  });

  it("aucune requête entre le geste et navigator.credentials.create (cérémonie chargée d'avance)", async () => {
    await C.preparerInscription(PREUVE);
    const n = srv.requetes.length;
    await C.creerPasskey("Lea", "fr");
    expect(srv.requetes.length).toBe(n);
    expect(C.inscriptionPrete()).toBe(true);
  });

  it("pseudo invalide ou réservé : refus avant le navigateur", async () => {
    await C.preparerInscription(PREUVE);
    for (const [p, e] of [["a", "pseudo_longueur"], ["Admin", "pseudo_reserve"]] as const) await expect(C.creerPasskey(p, "fr"), p).rejects.toThrow(e);
    expect(auth.creations).toEqual([]);
  });

  it("abandon après la création : le gestionnaire est prié d'oublier la passkey", async () => {
    await C.preparerInscription(PREUVE);
    await C.creerPasskey("Lea", "fr");
    expect(await C.abandonnerInscription()).toBe(true);
    expect(signalees).toEqual([{ rpId: "shh.test", credentialId: b64u(auth.passkeys[0]!.id) }]);
    await expect(C.terminerInscription(false)).rejects.toThrow("aucune_etape");
  });

  it("pseudoLibre : pendant l'inscription par l'étape, ensuite par la session ; réservé : jamais libre, sans requête", async () => {
    await C.preparerInscription(PREUVE);
    expect(await C.pseudoLibre("Lea")).toBe(true);
    const n = srv.requetes.length;
    expect(await C.pseudoLibre("Support")).toBe(false);
    expect(srv.requetes.length).toBe(n);
    await C.creerPasskey("Lea", "fr");
    await C.terminerInscription(false);
    expect(await C.pseudoLibre("LEA")).toBe(false);
    const last = srv.requetes.at(-1)!;
    expect(last.headers["X-Shh-Session"]).toBeTruthy();
    expect(last.body).toEqual({ p_canon: "lea" });
  });
});

describe("1Password et sorties PRF non conformes", () => {
  for (const forme of ["uint8array", "dataview", "base64url"] as const)
    it(`sortie PRF en ${forme} : lue comme 32 octets, l'enveloppe est faite et rouverte`, async () => {
      brancher(new FauxAuthentificateur({ prf: "creation", forme }));
      await inscription();
      expect(compte().passkeys[0]!.envs).toHaveLength(1);
      recharger();
      expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
      expect(C.account.cleLocale).toBe(false);
      rienDePrf();
    });

  for (const forme of ["nombre", "court"] as const)
    it(`sortie PRF « ${forme} » : traitée comme absente (repli, jamais une enveloppe fausse)`, async () => {
      brancher(new FauxAuthentificateur({ prf: "creation", forme }));
      await inscription();
      expect(compte().passkeys[0]!.envs).toEqual([]);
      expect(C.account.cleLocale).toBe(true);
    });
});

describe("connexion et réparation des enveloppes", () => {
  it("connexion : la passkey ouvre les données ; toutes les enveloppes sont essayées", async () => {
    await inscription();
    const c = compte();
    c.passkeys[0]!.envs.unshift(b64u(new Uint8Array(60).fill(7))); // une enveloppe d'un autre appareil, d'abord
    recharger();
    await C.preparerConnexion();
    const n = srv.requetes.length;
    expect(await C.seConnecter(true, "defaut", P)).toBe("ouvert");
    expect(srv.requetes[n]!.path).toBe("/api/compte/connexion/fin"); // aucune requête avant le geste
    expect(C.account.profil?.pseudo).toBe("Lea");
    expect(C.account.persistante).toBe(true);
    expect(srv.requetes.some((r) => r.path.endsWith("passkeys/enveloppe"))).toBe(false);
    rienDePrf();
  });

  it("sortie PRF changée, clé locale sur l'appareil : données ouvertes par la clé locale, enveloppe ajoutée (vérifiée), connexion suivante par l'enveloppe", async () => {
    brancher(new FauxAuthentificateur({ prf: "absent" }));
    await inscription(); // clé locale gardée
    // La même passkey rend maintenant une sortie PRF (gestionnaire changé).
    auth.o.prf = "creation";
    auth.passkeys[0]!.secret = new Uint8Array(32).fill(3) as Bytes;
    recharger();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    const p = compte().passkeys[0]!;
    expect(p.envs).toHaveLength(1);
    const kc = await ouvrirEnveloppesPrf(auth.sortie(auth.passkeys[0]!, await entreePrf())!, compte().h, auth.passkeys[0]!.id, p.envs.map(unb64u));
    expect(kc).not.toBeNull();
    expect(C.account.cleLocale).toBe(false);
    // Sans la clé locale, la connexion suivante s'ouvre par l'enveloppe.
    await C.seDeconnecter();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    expect(C.cleRequise()).toBe(false);
    rienDePrf();
  });

  it("sortie PRF changée sans clé locale : clé de récupération une fois ; enveloppe posée par la session de la passkey ; plus jamais redemandée", async () => {
    const texte = await inscription();
    await C.seDeconnecter();
    auth.changerSortie(auth.passkeys[0]!); // iCloud en QR, autre version d'iOS
    expect(await C.seConnecter(false, "defaut", P)).toBe("cle_requise");
    expect(C.account.etat).toBe("absent");
    const avant = compte().passkeys[0]!.envs.length;
    expect(await C.ouvrirAvecCle(texte.toLowerCase(), P)).toBe("posee");
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.recupere).toBe(true);
    expect(C.account.cleLocale).toBe(false);
    expect(compte().passkeys[0]!.envs).toHaveLength(avant + 1);
    // L'enveloppe est partie avec la session de la passkey (liée), qui a été fermée ensuite.
    const pose = srv.requetes.find((r) => r.path.endsWith("passkeys/enveloppe"))!;
    const connexion = srv.requetes.findIndex((r) => r.path.endsWith("connexion/fin"));
    expect(pose.headers["X-Shh-Session"]).not.toBe(srv.requetes.find((r) => r.path.endsWith("/recup"))!.headers["X-Shh-Session"]);
    expect(connexion).toBeGreaterThan(-1);
    expect([...srv.sessions.values()].filter((s) => s.cred !== null)).toEqual([]);
    expect([...srv.sessions.values()].filter((s) => s.parRecup)).toHaveLength(1);
    // La connexion suivante s'ouvre sans la clé.
    await C.seDeconnecter();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    rienDePrf();
  });

  it("4 enveloppes déjà : enveloppes_max ignoré sans bruit, la clé locale prend le relais", async () => {
    const texte = await inscription();
    await C.seDeconnecter();
    srv.reglages.enveloppesMax = 1; // plein
    auth.changerSortie(auth.passkeys[0]!);
    expect(await C.seConnecter(false, "defaut", P)).toBe("cle_requise");
    expect(await C.ouvrirAvecCle(texte, P)).toBe("plein");
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.cleLocale).toBe(true);
    expect([...idb.raw().keys()]).toEqual(["shhdrop-compte"]);
  });

  it("clé d'un autre compte après une connexion par passkey : refus cle_autre_compte, rien d'ouvert", async () => {
    await inscription("Lea");
    await C.seDeconnecter();
    const authLea = auth;
    brancher(new FauxAuthentificateur({ prf: "creation" }));
    const cleBob = await inscription("Bob");
    await C.seDeconnecter();
    brancher(authLea);
    authLea.changerSortie(authLea.passkeys[0]!);
    expect(await C.seConnecter(false, "defaut", P)).toBe("cle_requise");
    await expect(C.ouvrirAvecCle(cleBob, P)).rejects.toThrow("cle_autre_compte");
    expect(C.account.etat).toBe("absent");
  });

  it("clé mal recopiée : erreur locale, aucune requête ; clé inconnue : identifiants", async () => {
    const n = srv.requetes.length;
    await expect(C.ouvrirAvecCle("ABCD", P)).rejects.toThrow("cle_recup_longueur");
    expect(srv.requetes.length).toBe(n);
    await expect(C.ouvrirAvecCle("0000-0000-0000-0000-0000-0000-000", P)).rejects.toMatchObject({ code: "identifiants" });
  });

  it("annuler la clé après une connexion par passkey : la session ouverte au serveur est fermée", async () => {
    await inscription();
    await C.seDeconnecter();
    auth.changerSortie(auth.passkeys[0]!);
    expect(await C.seConnecter(false, "defaut", P)).toBe("cle_requise");
    expect(srv.sessions.size).toBe(1);
    await C.annulerCle();
    expect(srv.sessions.size).toBe(0);
    expect(C.cleRequise()).toBe(false);
  });
});

describe("récupération et nouvelle clé", () => {
  it("par la clé seule : session marquée, coffres ouverts ; nouvelle clé enregistrée, l'ancienne ne sert plus", async () => {
    const texte = await inscription();
    await C.seDeconnecter();
    expect(await C.ouvrirAvecCle(texte, P, true)).toBe("recup");
    expect(C.account.recupere).toBe(true);
    expect(C.account.persistante).toBe(true);
    expect((await C.appareils()).filter((a) => a.parRecup)).toHaveLength(1);
    const nouvelle = await C.preparerNouvelleCle();
    expect(nouvelle).not.toBe(texte);
    await C.enregistrerNouvelleCle();
    expect(C.account.recupere).toBe(false);
    await C.seDeconnecter();
    await expect(C.ouvrirAvecCle(texte, P)).rejects.toMatchObject({ code: "identifiants" });
    expect(await C.ouvrirAvecCle(nouvelle, P)).toBe("recup");
  });

  it("nouvelle clé sans session récente : recent, puis confirmerParPasskey et c'est fait", async () => {
    await inscription();
    await C.preparerNouvelleCle();
    srv.vieillir();
    await expect(C.enregistrerNouvelleCle()).rejects.toMatchObject({ code: "recent" });
    await C.preparerReauth();
    const n = srv.requetes.length;
    await C.confirmerParPasskey();
    expect(srv.requetes[n]!.path).toBe("/api/compte/reauth/fin"); // cérémonie chargée d'avance
    await C.enregistrerNouvelleCle();
  });
});

describe("passkeys du compte", () => {
  it("ajout (session récente), libellé chiffré, « cette passkey » ; retrait (jamais la dernière) signalé au gestionnaire", async () => {
    await inscription();
    brancher(new FauxAuthentificateur({ prf: "creation" })); // un autre appareil (le premier refuserait : excludeCredentials)
    expect(await C.preparerAjout()).toBe("pret");
    const n = srv.requetes.length;
    expect(await C.ajouterPasskey("YubiKey bleue")).toBe("ajoutee");
    expect(srv.requetes[n]!.path).toBe("/api/compte/passkeys/fin");
    expect(compte().passkeys).toHaveLength(2);
    expect(compte().passkeys[1]!.envs).toHaveLength(1);
    expect(JSON.stringify(srv.requetes)).not.toContain("YubiKey");
    const l = await C.listePasskeys();
    expect(l.map((p) => p.nom)).toEqual(["Firefox · ordinateur", "YubiKey bleue"]);
    expect(l.map((p) => p.courante)).toEqual([true, false]);
    expect(l.every((p) => p.ouvre && p.synchronisable)).toBe(true);
    await C.nommerPasskey(l[1]!.id, "Clé du bureau");
    expect((await C.listePasskeys())[1]!.nom).toBe("Clé du bureau");
    expect(await C.retirerPasskey(l[1]!.id)).toBe(true);
    expect(signalees).toEqual([{ rpId: "shh.test", credentialId: l[1]!.id }]);
    await expect(C.retirerPasskey(l[0]!.id)).rejects.toMatchObject({ code: "derniere" });
    rienDePrf();
  });

  it("session plus récente : preparerAjout rend « recent » ; après confirmerParPasskey, prêt", async () => {
    await inscription();
    srv.vieillir();
    expect(await C.preparerAjout()).toBe("recent");
    await C.confirmerParPasskey();
    expect(await C.preparerAjout()).toBe("pret");
  });

  it("ajout avec PRF seulement annoncé : deuxième geste ; refusé, la passkey est ajoutée sans enveloppe", async () => {
    await inscription();
    brancher(new FauxAuthentificateur({ prf: "annonce" }));
    await C.preparerAjout();
    expect(await C.ajouterPasskey("")).toBe("second");
    auth.o.annuler = true;
    expect(await C.deuxiemeGesteAjout()).toBe(false);
    expect(compte().passkeys).toHaveLength(2);
    expect(compte().passkeys[1]!.envs).toEqual([]);
  });

  it("confirmerParPasskey répare aussi l'enveloppe de la passkey qui signe", async () => {
    brancher(new FauxAuthentificateur({ prf: "absent" }));
    await inscription();
    auth.o.prf = "creation";
    auth.passkeys[0]!.secret = new Uint8Array(32).fill(9) as Bytes;
    await C.confirmerParPasskey();
    expect(compte().passkeys[0]!.envs).toHaveLength(1);
    expect(C.account.cleLocale).toBe(false);
  });
});

// Décision du 25 novembre (conception §18) : sur ordinateur, la passkey est demandée au téléphone
// (QR du navigateur, indice « hybrid ») ; « Ajouter mon téléphone » est l'ajout de passkey standard.
describe("parcours téléphone (QR) sur ordinateur", () => {
  const indices = (o: { hints?: string[] } | undefined) => o?.hints;

  it("création « hybride » : indice hybrid et cross-platform ; la passkey est dite sur le téléphone ; rien du parcours ni de la sortie PRF au serveur", async () => {
    brancher(new FauxAuthentificateur({ prf: "creation", attachement: "cross-platform" }));
    await C.preparerInscription(PREUVE);
    expect(await C.creerPasskey("Lea", "fr", "hybride")).toBe("cle");
    const o = auth.creations[0]!;
    expect(indices(o as never)).toEqual(["hybrid"]);
    expect(o.authenticatorSelection?.authenticatorAttachment).toBe("cross-platform");
    expect(C.passkeyCreee()).toBe("telephone");
    await C.terminerInscription(false);
    expect(compte().passkeys[0]!.envs).toHaveLength(1);
    const tout = srv.requetes.map((r) => r.brut).join("\n");
    expect(tout).not.toMatch(/hybrid|cross-platform|authenticatorAttachment|hints/);
    rienDePrf();
  });

  it("création par défaut (téléphone ou tablette) : options inchangées, sans indice ni attachement", async () => {
    await C.preparerInscription(PREUVE);
    await C.creerPasskey("Lea", "fr");
    expect(indices(auth.creations[0] as never)).toBeUndefined();
    expect(auth.creations[0]!.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
    expect(C.passkeyCreee()).toBe("ici");
  });

  it("« Garder le compte sur cet ordinateur » : indice client-device, aucun attachement imposé ; passkey dite ici même si le navigateur ne dit rien", async () => {
    await C.preparerInscription(PREUVE);
    await C.creerPasskey("Lea", "fr", "local");
    expect(indices(auth.creations[0] as never)).toEqual(["client-device"]);
    expect(auth.creations[0]!.authenticatorSelection?.authenticatorAttachment).toBeUndefined();
    expect(C.passkeyCreee()).toBe("ici");
  });

  it("le navigateur prime sur le parcours demandé (choix fait dans sa feuille)", async () => {
    brancher(new FauxAuthentificateur({ prf: "creation", attachement: "platform" }));
    await C.preparerInscription(PREUVE);
    await C.creerPasskey("Lea", "fr", "hybride");
    expect(C.passkeyCreee()).toBe("ici");
  });

  it("PRF absent par le QR : compte utilisable (clé gardée sur l'ordinateur, aucune enveloppe), clé de récupération demandée une fois ailleurs", async () => {
    brancher(new FauxAuthentificateur({ prf: "absent", attachement: "cross-platform" }));
    const cle = await inscription();
    expect(C.account.cleLocale).toBe(true);
    expect(compte().passkeys[0]!.envs).toEqual([]);
    // Le téléphone (autre appareil, sans clé locale) : la passkey connecte, la clé de récupération ouvre.
    C._oublierMemoire();
    idb = fakeIndexedDB();
    expect(await C.seConnecter(false, "defaut", P)).toBe("cle_requise");
    expect(await C.ouvrirAvecCle(cle, P)).toBe("sans_prf");
    expect(C.account.etat).toBe("ouvert");
    rienDePrf();
  });

  it("PRF annoncé seulement : le deuxième geste garde l'indice hybrid", async () => {
    brancher(new FauxAuthentificateur({ prf: "annonce", attachement: "cross-platform" }));
    await C.preparerInscription(PREUVE);
    expect(await C.creerPasskey("Lea", "fr", "hybride")).toBe("second");
    await C.deuxiemeGeste();
    expect(indices(auth.assertions.at(-1) as never)).toEqual(["hybrid"]);
  });

  it("connexion : « hybride » sur ordinateur, « local » pour cet ordinateur, rien par défaut", async () => {
    await inscription();
    for (const [p, h] of [["hybride", ["hybrid"]], ["local", ["client-device"]], ["defaut", undefined]] as const) {
      await C.seDeconnecter();
      expect(await C.seConnecter(false, p, P)).toBe("ouvert");
      expect(indices(auth.assertions.at(-1) as never)).toEqual(h);
    }
  });

  it("« Ajouter mon téléphone » : ajout standard par le QR ; enveloppe posée si la sortie PRF revient, sinon « sans_prf » (la passkey est ajoutée et connecte)", async () => {
    await inscription();
    brancher(new FauxAuthentificateur({ prf: "creation", attachement: "cross-platform" })); // le téléphone : un autre authentificateur
    expect(await C.preparerAjout()).toBe("pret");
    expect(await C.ajouterPasskey("Téléphone", "hybride")).toBe("ajoutee");
    expect(indices(auth.creations[0] as never)).toEqual(["hybrid"]);
    expect(auth.creations[0]!.authenticatorSelection?.authenticatorAttachment).toBe("cross-platform");
    expect(compte().passkeys).toHaveLength(2);
    expect(compte().passkeys[1]!.envs).toHaveLength(1);
    expect((await C.listePasskeys()).map((p) => p.nom)).toEqual(["Firefox · ordinateur", "Téléphone"]);
    // Le téléphone ouvre ensuite les données avec sa propre sortie PRF.
    await C.seDeconnecter();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    expect(C.account.cleLocale).toBe(false);
    rienDePrf();
  });

  it("ajout par le QR sans sortie PRF : « sans_prf », passkey ajoutée sans enveloppe", async () => {
    await inscription();
    brancher(new FauxAuthentificateur({ prf: "absent", attachement: "cross-platform" }));
    await C.preparerAjout();
    expect(await C.ajouterPasskey("Téléphone", "hybride")).toBe("sans_prf");
    expect(compte().passkeys).toHaveLength(2);
    expect(compte().passkeys[1]!.envs).toEqual([]);
  });
});

describe("pseudo d'un invité du salon", () => {
  it("sans session ni salon : pris par un compte → non ; réservé → non sans requête ; libre → oui ; le sien → oui", async () => {
    await inscription();
    await C.seDeconnecter();
    expect(await C.pseudoLibreSalon("LEA")).toBe(false);
    const r = srv.requetes.at(-1)!;
    expect(r.path).toBe("/api/compte/pseudo/libre");
    expect(r.headers["X-Shh-Session"]).toBeUndefined();
    expect(r.body).toEqual({ p_canon: "lea" });
    for (const p of ["Lea", "lEA", "LeA", "1ea", "Iea"]) expect(await C.pseudoLibreSalon(p), p).toBe(false);
    const n = srv.requetes.length;
    expect(await C.pseudoLibreSalon("Admin")).toBe(false);
    expect(srv.requetes.length).toBe(n);
    expect(await C.pseudoLibreSalon("Leo")).toBe(true);
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    const m = srv.requetes.length;
    expect(await C.pseudoLibreSalon("LEA")).toBe(true);
    expect(srv.requetes.length).toBe(m);
  });

  it("serveur sans comptes (404) : libre ; limite (429) et réseau : erreur", async () => {
    const net = (f: typeof fetch) => C.configurerCompte({ net: { origin: "https://shh.test", fetch: f } });
    net((async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as unknown as typeof fetch);
    expect(await C.pseudoLibreSalon("Leo")).toBe(true);
    net((async () => new Response(JSON.stringify({ error: "limit" }), { status: 429 })) as unknown as typeof fetch);
    await expect(C.pseudoLibreSalon("Leo")).rejects.toMatchObject({ status: 429 });
    net((async () => {
      throw new TypeError("hors ligne");
    }) as unknown as typeof fetch);
    await expect(C.pseudoLibreSalon("Leo")).rejects.toThrow("reseau");
  });

  it("pseudo pris comme invité : retenu en mémoire seulement (aucun stockage du navigateur)", () => {
    // Stockage factice (indépendant de --experimental-webstorage de Node) : rien n'y est écrit.
    const ecrits: string[] = [];
    const stockage = { setItem: (k: string, v: string) => void ecrits.push(k, v), getItem: () => null, removeItem: () => undefined, clear: () => undefined, key: () => null, length: 0 };
    vi.stubGlobal("localStorage", stockage);
    vi.stubGlobal("sessionStorage", stockage);
    try {
      C.retenirPseudoInvite("Lucas");
      expect(C.pseudoInviteRetenu()).toBe("Lucas");
      expect(ecrits).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("saisie et état", () => {
  it("verifierSaisie : erreur du pseudo, sans requête", async () => {
    expect(await C.verifierSaisie({ pseudo: "Lea" })).toEqual({});
    expect(await C.verifierSaisie({ pseudo: "a" })).toEqual({ pseudo: "pseudo_longueur" });
    expect(await C.verifierSaisie({ pseudo: "Admin" })).toEqual({ pseudo: "pseudo_reserve" });
    expect(srv.requetes).toEqual([]);
  });

  it("etatCompte : GET /api/compte avec la session ; sans session, erreur", async () => {
    await expect(C.etatCompte()).rejects.toThrow("aucune_session");
    await inscription();
    expect(await C.etatCompte()).toMatchObject({ palier: "neuf", banniId: null, banniJusqu: null });
    expect(srv.requetes.at(-1)!.headers["X-Shh-Session"]).toBeTruthy();
  });
});

describe("coffres", () => {
  it("ecrireProfil : écrit tout de suite ; retour en arrière du serveur refusé", async () => {
    await inscription();
    const c = compte();
    const old = c.coffres.profil.blob;
    await C.ecrireProfil({ langue: "en" });
    expect(c.coffres.profil.gen).toBe(2);
    c.coffres.profil = { blob: old, gen: 1 };
    await expect(C.ecrireProfil({ pseudo: "Zoe" })).rejects.toThrow("coffre_recule");
    expect(C.account.erreur).toBe("coffre_illisible");
  });

  // Mes partages (spec §33, D42-30) : fusion de l'appareil et du coffre privé à l'ouverture ;
  // `recus` et `rejoints` (plus gardés) vidés ; ajout ou retrait ici : écriture différée ;
  // déconnexion : les entrées venues du compte quittent l'appareil, celles créées ici restent.
  it("Mes partages : fusion à l'ouverture, recus et rejoints vidés, pass gardé ; écriture différée ; déconnexion", async () => {
    configurerPartages(memoryBackend());
    let planifie: (() => void) | null = null;
    C.configurerCompte({ planifier: (_ms, f) => ((planifie = f), () => (planifie = null)) });
    try {
      const texte = await inscription("Lea", true);
      const c = compte();
      const k = await ouvrirRecup((await cleRecupDerivees(await cleRecupLire(texte))).kekR, c.h, unb64u(c.envR));
      const cles = await clesDuCompte(k);
      const ici = "https://shh.test/s#m" + "L".repeat(43);
      const ailleurs = "https://shh.test/s#m" + "G".repeat(43);
      const tard = Date.now() + 86_400_000;
      await garderPartage({ sorte: "envoi", gestion: ici, creeLe: Date.now(), echeance: tard, ouverturesMax: 1, taille: 5, elements: 1 });
      const ancien = { ...priveVide(), envois: [{ id: "E".repeat(22), cree: Date.now(), expire: tard, gestion: ailleurs, taille: 9, elements: 2, ouvertures_max: 3, libelle: "Devis" }], recus: [{ id: "r1" }], rejoints: [{ id: "j1" }], pass: [{ id: "p1", x: 1 }] };
      c.coffres.prive = { blob: await sceller("prive", cles.prive, c.h, 2, priveEnJson(ancien)), gen: 2 };
      recharger();
      await C.restaurer();
      expect(C.account.etat).toBe("ouvert");
      expect(accountFlag.connected).toBe(true);
      expect(c.coffres.prive.gen).toBe(3);
      const relu = priveDeJson(await ouvrir("prive", cles.prive, c.h, c.coffres.prive.blob, 3));
      expect(relu.recus).toEqual([]);
      expect(relu.rejoints).toEqual([]);
      expect(relu.envois.map((v) => v.gestion).sort()).toEqual([ailleurs, ici].sort());
      expect(JSON.stringify(relu)).not.toMatch(/#[A-Za-z0-9_-]{43}"/); // aucun lien de partage
      expect(relu.pass).toEqual([{ id: "p1", x: 1 }]);
      const surAppareil = await tousLesPartages();
      expect(surAppareil.map((p) => [p.gestion, p.origine]).sort()).toEqual([[ailleurs, "compte"], [ici, "local"]].sort());
      expect(surAppareil.find((p) => p.origine === "compte")).toMatchObject({ nom: "Devis", taille: 9, elements: 2, ouverturesMax: 3 });
      // Ouverture suivante, rien de changé : aucune écriture.
      recharger();
      await C.restaurer();
      expect(c.coffres.prive.gen).toBe(3);
      // Retrait ici : différé (2 à 12 min), puis écrit.
      await retirerPartage(surAppareil.find((p) => p.gestion === ailleurs)!.id);
      expect(c.coffres.prive.gen).toBe(3);
      expect(planifie).not.toBeNull();
      planifie!();
      await vi.waitFor(() => expect(c.coffres.prive.gen).toBe(4));
      expect(priveDeJson(await ouvrir("prive", cles.prive, c.h, c.coffres.prive.blob, 4)).envois.map((v) => v.gestion)).toEqual([ici]);
      // Déconnexion : l'entrée locale reste.
      await C.seDeconnecter();
      expect(accountFlag.connected).toBe(false);
      expect((await tousLesPartages()).map((p) => p.gestion)).toEqual([ici]);
    } finally {
      configurerPartages(undefined);
      C.configurerCompte({ planifier: (ms, f) => {
        const t = setTimeout(f, ms);
        return () => clearTimeout(t);
      } });
    }
  });

  it("changerPseudo : p_canon envoyé, puis le profil chiffré porte le nouveau pseudo", async () => {
    await inscription();
    await C.changerPseudo("Zoe");
    expect(srv.requetes.find((r) => r.path.endsWith("/pseudo"))!.body).toEqual({ p_canon: "zoe" });
    expect(C.account.profil?.pseudo).toBe("Zoe");
    expect(compte().coffres.profil.gen).toBe(2);
  });
});

describe("session et déconnexion", () => {
  it("« Rester connecté » : restaurer après un rechargement rouvre le compte sans geste", async () => {
    await inscription("Lea", true);
    expect([...idb.raw().keys()]).toEqual(["shhdrop-compte"]);
    recharger();
    expect(C.account.etat).toBe("absent");
    const n = srv.requetes.length;
    await C.restaurer();
    expect(C.account.etat).toBe("ouvert");
    expect(C.account.profil?.pseudo).toBe("Lea");
    expect(srv.requetes.slice(n).some((r) => r.path.includes("connexion"))).toBe(false);
    expect((await C.listePasskeys())[0]!.courante).toBe(true);
  });

  it("restaurer avec une session échue : base effacée, état absent", async () => {
    await inscription("Lea", true);
    srv.sessions.clear();
    recharger();
    await C.restaurer();
    expect(C.account.etat).toBe("absent");
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("déconnexion : le serveur oublie la session, shhdrop-compte effacée, K_compte mise à zéro", async () => {
    await inscription("Lea", true);
    expect(tires.length).toBeGreaterThanOrEqual(1);
    await C.seDeconnecter();
    expect(srv.sessions.size).toBe(0);
    expect([...idb.raw().keys()]).toEqual([]);
    expect(C.account.etat).toBe("absent");
    expect(C.account.profil).toBeUndefined();
    expect(tires.some((t) => t.every((x) => x === 0))).toBe(true);
  });

  it("« Rester connecté » coupé : la session gardée est effacée, la clé locale reste", async () => {
    brancher(new FauxAuthentificateur({ prf: "absent" }));
    await inscription("Lea", true);
    await C.arreterResterConnecte();
    expect(C.account.persistante).toBe(false);
    recharger();
    await C.restaurer();
    expect(C.account.etat).toBe("absent");
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert"); // clé locale toujours là
  });

  it("aucune requête hors de /api/compte/* ; jeton seulement en X-Shh-Session", async () => {
    await inscription("Lea", true);
    await C.ecrireProfil({ langue: "en" });
    await C.seDeconnecter();
    for (const r of srv.requetes) {
      expect(r.path).toMatch(/^\/api\/compte(\/|$)/);
      for (const t of srv.sessions.keys()) expect(r.brut).not.toContain(t);
    }
  });

  it("appareils : noms déchiffrés sur l'appareil, « cet appareil » ; déconnecter un appareil ou tous les autres", async () => {
    await inscription();
    recharger();
    await C.seConnecter(false, "defaut", P);
    const l = await C.appareils();
    expect(l).toHaveLength(2);
    expect(l.map((a) => a.nom)).toEqual(["Firefox · ordinateur", "Firefox · ordinateur"]);
    const autre = l.find((a) => !a.courante)!;
    await C.deconnecterAppareil(autre.sid);
    expect(srv.requetes.at(-1)!.body).toEqual({ sid: autre.sid });
    expect(await C.appareils()).toHaveLength(1);
  });

  it("suppression : après un geste de passkey, le serveur efface le compte ; passkeys signalées ; l'écran de fin reste", async () => {
    const effacerAppareil = vi.fn(async () => undefined);
    C.configurerCompte({ effacerAppareil });
    await inscription("Lea", true);
    srv.vieillir();
    await C.confirmerParPasskey();
    const etapes: string[] = [];
    for await (const p of C.supprimerTout()) etapes.push(p.etape);
    expect(etapes).toEqual(["compte", "fini"]);
    expect(effacerAppareil).toHaveBeenCalledOnce();
    expect(srv.comptes.size).toBe(0);
    expect(C.account.supprime).toBe(true);
    expect([...idb.raw().keys()]).toEqual([]);
    expect(signalees.map((s) => s.credentialId)).toEqual([b64u(auth.passkeys[0]!.id)]);
  });

  it("autre onglet : un signal de déconnexion efface la mémoire du compte ici ; aucun secret sur le canal", async () => {
    await inscription();
    const arret = C.ecouterAutresOnglets();
    const vus: unknown[] = [];
    const espion = new BroadcastChannel("shh-compte-onglets");
    espion.onmessage = (e) => vus.push(e.data);
    try {
      const autre = new BroadcastChannel("shh-compte-onglets");
      autre.postMessage("deconnexion");
      autre.close();
      await vi.waitFor(() => expect(C.account.etat).toBe("absent"));
      expect(vus).toEqual(["deconnexion"]);
    } finally {
      arret();
      espion.close();
    }
  });

  it("déconnexion : part avec keepalive ; sans réseau, réessayée ; l'appareil efface quand même tout", async () => {
    await inscription("Lea", true);
    const f = srv.fetch;
    let tentatives = 0;
    const vues: RequestInit[] = [];
    C.configurerCompte({
      net: {
        origin: "https://shh.test",
        fetch: (async (u: string, i: RequestInit) => {
          if (u.endsWith("/deconnexion")) {
            vues.push(i);
            if (++tentatives < 3) throw new TypeError("réseau");
          }
          return f(u, i);
        }) as never,
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await C.seDeconnecter();
      expect(C.account.etat).toBe("absent");
      expect([...idb.raw().keys()]).toEqual([]);
      await vi.advanceTimersByTimeAsync(20_000);
    } finally {
      vi.useRealTimers();
    }
    expect(tentatives).toBe(3);
    expect(vues.every((i) => i.keepalive === true)).toBe(true);
  });
});

// Accès offert (conception du paiement, « Accès offerts ») : le compte doit détenir le pass, pour
// qu'aucun appareil n'ait à repasser par le lien.
describe("pass d'un accès offert et compte", () => {
  const offert = () => ({ id: nouvelId(), pass: tirerPass(), offre: "pro" as const, jours: 365 as const, renouvelle: false, moyen: "offert" as const, enAttente: false, cree: 7 });
  const memes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  const dansCoffre = (p: Uint8Array) => (C.account.prive?.pass ?? []).some((e) => typeof e.p === "string" && memes(unb64u(e.p), p));

  it("session ouverte : rangerPassDansCompte écrit tout de suite le pass de l'appareil dans le coffre privé (chiffré au serveur)", async () => {
    await inscription();
    const g = offert();
    await garder(idb, g);
    const gen = compte().coffres.prive.gen;
    expect(dansCoffre(g.pass)).toBe(false);
    expect(await C.rangerPassDansCompte()).toBe(true);
    expect(dansCoffre(g.pass)).toBe(true);
    expect(compte().coffres.prive.gen).toBe(gen + 1);
    // Le serveur ne reçoit qu'un coffre chiffré : ni le pass, ni son encodage.
    const tout = srv.requetes.map((r) => r.brut).join("\n");
    expect(tout).not.toContain(b64u(g.pass));
    // Déjà rangé : rien de plus à écrire.
    expect(await C.rangerPassDansCompte()).toBe(true);
    expect(compte().coffres.prive.gen).toBe(gen + 1);
  });

  it("sans session : rien ; à la création du compte, puis à une connexion, le pass de l'appareil part tout seul dans le coffre", async () => {
    const g = offert();
    await garder(idb, g);
    expect(await C.rangerPassDansCompte()).toBe(false);
    await inscription();
    expect(dansCoffre(g.pass)).toBe(true);
    // Un second pass rangé sans session (déconnecté), puis connexion : ajouté lui aussi.
    recharger();
    const g2 = offert();
    await garder(idb, g2);
    await C.preparerConnexion();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    expect(dansCoffre(g.pass) && dansCoffre(g2.pass)).toBe(true);
  });

  it("appareil neuf : la connexion range le pass du coffre sur l'appareil, et Pro est disponible sans autre geste", async () => {
    const g = offert();
    await garder(idb, g);
    await inscription();
    expect(dansCoffre(g.pass)).toBe(true);
    // Autre appareil : stockage vide, même passkey (synchronisée).
    recharger();
    idb = fakeIndexedDB();
    expect(await lirePasses(idb)).toHaveLength(0);
    await C.preparerConnexion();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    const l = await lirePasses(idb);
    expect(l).toHaveLength(1);
    expect(memes(l[0]!.pass, g.pass)).toBe(true);
    expect(l[0]).toMatchObject({ offre: "pro", moyen: "offert", enAttente: false });
    // Le serveur du paiement dit ce pass Pro valable : la formule est proposée.
    const fin = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const vus: string[] = [];
    const net = {
      origin: "https://shh.test",
      fetch: (async (u: string, init: RequestInit) => {
        vus.push(u);
        expect((init.headers as Record<string, string>)["X-Shh-Pass"]).toBe(b64u(g.pass));
        return new Response(JSON.stringify({ v: 1, etat: "payee", offre: "pro", fin, renouvelle: false, droits: ["partage_pro"] }), { status: 200 });
      }) as unknown as typeof fetch,
    };
    expect(await formulesDisponibles(idb, net)).toEqual(["pro"]);
    expect(vus).toEqual(["https://shh.test/api/paiement/etat"]);
  });
});

describe("REGLAGES_DEFAUT", () => {
  it("le profil de l'inscription porte les réglages par défaut", async () => {
    await inscription();
    expect(C.account.profil?.reglages).toEqual(REGLAGES_DEFAUT);
  });
});

// Décision du 26 novembre (conception du compte §19) : sur ordinateur, le chemin de passkey qui a
// marché est retenu sur l'appareil (base shhdrop-compte, chiffré, jamais envoyé), effacé par « Se
// déconnecter » ; rien sur téléphone (parcours « defaut »).
describe("chemin de passkey retenu sur ordinateur", () => {
  it("création « local » retenue ; passkey de plateforme demandée par le téléphone : « local » ; connexion par QR : « hybride » ; déconnexion : oublié", async () => {
    expect(await C.parcoursRetenu()).toBeNull();
    await C.preparerInscription(PREUVE);
    await C.creerPasskey("Lea", "fr", "local");
    await C.terminerInscription(false);
    expect(await C.parcoursRetenu()).toBe("local");
    expect([...idb.raw().keys()]).toEqual(["shhdrop-compte"]);
    // Rien de ce choix ne part au serveur.
    expect(srv.requetes.map((r) => r.brut).join("\n")).not.toMatch(/parcours|hybride|"local"/);
    // Connexion par le téléphone (le navigateur ne dit pas où était la passkey) : « hybride ».
    recharger();
    expect(await C.seConnecter(false, "hybride", P)).toBe("ouvert");
    expect(await C.parcoursRetenu()).toBe("hybride");
    await C.seDeconnecter();
    expect(await C.parcoursRetenu()).toBeNull();
    expect([...idb.raw().keys()]).toEqual([]);
    // Passkey créée « par le téléphone » mais rendue par la plateforme (synchronisée ici) : « local ».
    brancher(new FauxAuthentificateur({ prf: "creation", attachement: "platform" }));
    await C.preparerInscription(PREUVE);
    await C.creerPasskey("Zoe", "fr", "hybride");
    await C.terminerInscription(false);
    expect(await C.parcoursRetenu()).toBe("local");
  });

  it("parcours « defaut » (téléphone) : rien n'est écrit", async () => {
    await inscription();
    recharger();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    expect([...idb.raw().keys()]).toEqual([]);
  });
});

// Anti-robot du compte (décision du 26 novembre) : la preuve de la connexion n'est demandée
// qu'APRÈS navigator.credentials.get et part avec connexion/fin ; celle de recup après le
// contrôle local de la clé. Rien entre le geste et la cérémonie.
describe("preuve anti-robot de la connexion et de la récupération", () => {
  /** Branche un navigateur qui note, au moment de la cérémonie, les requêtes et preuves déjà faites. */
  function noterAuGeste(a: FauxAuthentificateur) {
    const vu: { requetes: number; preuves: number }[] = [];
    auth = a;
    configurerNavigateur(() => {
      const n = a.navigateur(signalees);
      return {
        ...n,
        credentials: {
          create: (o) => n.credentials!.create(o),
          get: (o) => {
            vu.push({ requetes: srv.requetes.length, preuves: preuvesDemandees });
            return n.credentials!.get(o);
          },
        },
      };
    });
    return vu;
  }

  it("connexion : aucune requête ni preuve entre le geste et la cérémonie ; la preuve part avec connexion/fin", async () => {
    await inscription();
    recharger();
    const vu = noterAuGeste(auth);
    await C.preparerConnexion();
    const n = srv.requetes.length;
    const p0 = preuvesDemandees;
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    expect(vu).toEqual([{ requetes: n, preuves: p0 }]); // rien avant navigator.credentials.get
    expect(preuvesDemandees).toBe(p0 + 1); // une seule, après
    const fin = srv.requetes[n]!;
    expect(fin.path).toBe("/api/compte/connexion/fin");
    expect(fin.body).toMatchObject({ altcha: `preuve-${p0 + 1}`, hp: "", shown_at: "t" });
    // connexion/debut, chargée avant le geste, ne porte aucune preuve.
    expect(srv.requetes.filter((r) => r.path.endsWith("connexion/debut")).every((r) => !("altcha" in r.body))).toBe(true);
  });

  it("connexion : preuve impossible après la cérémonie → erreur, connexion/fin jamais envoyée", async () => {
    await inscription();
    recharger();
    await C.preparerConnexion();
    const n = srv.requetes.length;
    await expect(C.seConnecter(false, "defaut", () => Promise.reject(new Error("pow_indisponible")))).rejects.toThrow("pow_indisponible");
    expect(srv.requetes.length).toBe(n);
    expect(C.account.etat).toBe("absent");
  });

  it("connexion : sans preuve, le serveur refuse (bad_request) et rien n'est ouvert", async () => {
    await inscription();
    recharger();
    await C.preparerConnexion();
    await expect(C.seConnecter(false, "defaut", async () => ({ altcha: "", hp: "", shown_at: "" }))).rejects.toMatchObject({ code: "bad_request" });
    expect(C.account.etat).toBe("absent");
  });

  it("récupération : preuve jointe à recup ; clé mal recopiée : aucune preuve demandée", async () => {
    const cle = await inscription();
    await C.seDeconnecter();
    const p0 = preuvesDemandees;
    await expect(C.ouvrirAvecCle("ABCD", P)).rejects.toThrow("cle_recup_longueur");
    expect(preuvesDemandees).toBe(p0);
    expect(await C.ouvrirAvecCle(cle, P)).toBe("recup");
    expect(preuvesDemandees).toBe(p0 + 1);
    const r = srv.requetes.filter((x) => x.path === "/api/compte/recup").at(-1)!;
    expect(r.body).toMatchObject({ altcha: `preuve-${p0 + 1}`, hp: "", shown_at: "t" });
  });
});

// « Pass et compte » (conception du paiement §6.4, décision du propriétaire du 28 novembre) : le
// serveur ne relie jamais pass et compte, mais sur l'appareil ils se comportent comme liés. Un test
// par parcours du tableau de §6.4 qui touche l'appareil ; garantie : ni abonnement perdu ou
// orphelin, ni prélèvement sans accès.
describe("pass et compte : jamais divergents (conception du paiement §6.4)", () => {
  const paye = (o: Partial<PassGarde> = {}): PassGarde => ({ id: nouvelId(), pass: tirerPass(), offre: "plus", jours: 30, renouvelle: true, moyen: "carte", enAttente: false, cree: 5, ...o });
  const memes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  const dansCoffre = (p: Uint8Array) => (C.account.prive?.pass ?? []).some((e) => typeof e.p === "string" && memes(unb64u(e.p), p));
  const ici = async () => (await lirePasses(idb)).map((g) => ({ b: b64u(g.pass), compte: g.compte === true, attente: g.enAttente }));
  let veille: (() => void) | null;
  let log: string[];
  let paiement: { resilier: ReturnType<typeof vi.fn>; revoquer: ReturnType<typeof vi.fn>; etat: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    veille = null;
    log = [];
    paiement = {
      resilier: vi.fn(async (p: Uint8Array<ArrayBuffer>) => (log.push(`resilier ${b64u(p)}`), "ok")),
      revoquer: vi.fn(async (p: Uint8Array<ArrayBuffer>) => (log.push(`revoquer ${b64u(p)}`), "ok")),
      etat: vi.fn(async () => ({ etat: "payee", offre: "plus", fin: "2026-12-29", renouvelle: false, droits: ["partage_plus"] })),
    };
    C.configurerCompte({ paiement: paiement as never, planifierPass: (_ms, f) => ((veille = f), () => (veille = null)) });
  });
  const tourDeVeille = async () => {
    const f = veille;
    expect(f).not.toBeNull();
    f!();
    await vi.waitFor(() => expect(veille).not.toBe(f));
  };

  it("achat sans compte, puis compte créé : rangé dans le coffre et marqué ; déconnexion : il quitte l'appareil ; reconnexion : il revient", async () => {
    const g = paye();
    await garder(idb, g);
    await inscription();
    expect(dansCoffre(g.pass)).toBe(true);
    expect(await ici()).toEqual([{ b: b64u(g.pass), compte: true, attente: false }]);
    await C.seDeconnecter();
    expect(await ici()).toEqual([]);
    await C.preparerConnexion();
    expect(await C.seConnecter(false, "defaut", P)).toBe("ouvert");
    expect(await ici()).toEqual([{ b: b64u(g.pass), compte: true, attente: false }]);
  });

  it("démarrage sans session gardée : les pass du compte quittent l'appareil ; une commande en attente et un pass pas encore rangé restent", async () => {
    const g = paye();
    await garder(idb, g);
    await inscription(); // sans « Rester connecté »
    recharger(); // onglet fermé
    const attente = paye({ enAttente: true });
    const horsCompte = paye({ renouvelle: false });
    await garder(idb, attente);
    await garder(idb, horsCompte);
    await C.restaurer();
    expect((await ici()).map((x) => x.b).sort()).toEqual([b64u(attente.pass), b64u(horsCompte.pass)].sort());
  });

  it("écriture du coffre en échec à l'ouverture : le pass reste sur l'appareil, non marqué, et la veille le range dès que possible", async () => {
    let panne = true;
    C.configurerCompte({
      net: {
        origin: "https://shh.test",
        fetch: (async (u: string, init?: RequestInit) => (panne && init?.method === "PUT" && String(u).includes("/coffre/prive") ? Promise.reject(new TypeError("réseau")) : srv.fetch(u as never, init as never))) as typeof fetch,
      },
    });
    const g = paye();
    await garder(idb, g);
    await inscription();
    expect(dansCoffre(g.pass)).toBe(false);
    expect(await ici()).toEqual([{ b: b64u(g.pass), compte: false, attente: false }]);
    // Déconnexion à ce moment : le pass pas encore rangé reste (rien n'est perdu).
    // Réseau revenu : la veille le range, puis le marque.
    await tourDeVeille(); // encore en panne
    expect(dansCoffre(g.pass)).toBe(false);
    panne = false;
    await tourDeVeille();
    expect(dansCoffre(g.pass)).toBe(true);
    expect(await ici()).toEqual([{ b: b64u(g.pass), compte: true, attente: false }]);
    C.configurerCompte({ net: { origin: "https://shh.test", fetch: srv.fetch } });
  });

  it("achat pendant la session (commande confirmée plus tard) : la veille le range sans attendre une nouvelle connexion", async () => {
    await inscription();
    const g = paye({ enAttente: true });
    await garder(idb, g);
    await tourDeVeille();
    expect(dansCoffre(g.pass)).toBe(false); // un paiement non confirmé n'a rien à retrouver
    await garder(idb, { ...g, enAttente: false }); // confirmé (jetons.ts, OffersReturn)
    await tourDeVeille();
    expect(dansCoffre(g.pass)).toBe(true);
    expect((await ici())[0]!.compte).toBe(true);
  });

  it("deux appareils : un pass rangé par l'autre appareil pendant la session est révoqué aussi à la suppression (coffre relu)", async () => {
    const texte = await inscription();
    const c = compte();
    const k = await ouvrirRecup((await cleRecupDerivees(await cleRecupLire(texte))).kekR, c.h, unb64u(c.envR));
    const cles = await clesDuCompte(k);
    // L'autre appareil range un pass Pro offert dans le coffre (gen + 1) ; cet appareil ne l'a pas lu.
    const ailleurs = paye({ offre: "pro", moyen: "offert", renouvelle: false, jours: 365 });
    const v = priveDeJson(await ouvrir("prive", cles.prive, c.h, c.coffres.prive.blob, c.coffres.prive.gen));
    const gen = c.coffres.prive.gen + 1;
    c.coffres.prive = { blob: await sceller("prive", cles.prive, c.h, gen, priveEnJson({ ...v, pass: [passEnEntree(ailleurs)] })), gen };
    expect(dansCoffre(ailleurs.pass)).toBe(false);
    srv.vieillir();
    await C.confirmerParPasskey();
    for await (const _ of C.supprimerTout()) void _;
    expect(log).toEqual([`revoquer ${b64u(ailleurs.pass)}`]); // accès offert : rien à résilier
    expect(srv.comptes.size).toBe(0);
  });

  it("suppression : renouvellement arrêté puis pass révoqués, AVANT le compte ; échec réseau : rien supprimé ; réessai : tout part, appareil à zéro", async () => {
    const g = paye();
    const offert = paye({ offre: "pro", moyen: "offert", renouvelle: false });
    await garder(idb, g);
    await garder(idb, offert);
    await inscription();
    srv.vieillir();
    await C.confirmerParPasskey();
    paiement.revoquer.mockImplementationOnce(async () => "erreur");
    await expect((async () => {
      for await (const _ of C.supprimerTout()) void _;
    })()).rejects.toBeInstanceOf(C.ErreurAbonnement);
    expect(srv.comptes.size).toBe(1);
    expect(C.account.etat).toBe("ouvert");
    expect(await ici()).toHaveLength(2);
    log.length = 0;
    for await (const _ of C.supprimerTout()) void _;
    expect(log.slice(0, 2)).toEqual([`resilier ${b64u(g.pass)}`, `revoquer ${b64u(g.pass)}`]);
    expect(log).toContain(`revoquer ${b64u(offert.pass)}`);
    expect(log).not.toContain(`resilier ${b64u(offert.pass)}`);
    expect(srv.comptes.size).toBe(0);
    expect(await ici()).toEqual([]);
  });

  it("arrêter l'abonnement : résiliation par le pass (sans session), état relu gardé ici, coffre « non renouvelé » ; la carte dit « ne sera pas renouvelé »", async () => {
    const g = paye();
    await garder(idb, g);
    await inscription();
    const [a] = await C.abonnements();
    expect(a).toMatchObject({ offre: "plus", renouvelle: true, arrete: false });
    expect(await C.arreterAbonnement(a!.id)).toBe("ok");
    expect(paiement.resilier).toHaveBeenCalledWith(g.pass);
    const [b] = await C.abonnements();
    expect(b).toMatchObject({ renouvelle: false, arrete: true, fin: "2026-12-29" });
    expect((C.account.prive?.pass ?? []).find((e) => typeof e.p === "string" && memes(unb64u(e.p), g.pass))).toMatchObject({ renouvelle: false });
    // La résiliation part sans en-tête de session (requêtes du paiement à part).
    expect(srv.requetes.some((r) => r.path.includes("paiement"))).toBe(false);
    // Échec réseau : « erreur », rien de changé.
    paiement.resilier.mockImplementationOnce(async () => "erreur");
    expect(await C.arreterAbonnement(a!.id)).toBe("erreur");
  });
});

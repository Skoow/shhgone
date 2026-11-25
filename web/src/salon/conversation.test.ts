import { describe, expect, it } from "vitest";
import { Conversation, morceaux, type Bulle } from "./conversation";
import type { EnveloppeRecue } from "./client";
import type { Message } from "./engine";

// Clé d'unicité simplifiée pour le test (le site passe cleUnicite du moteur).
const cle = (p: string) => p.toLowerCase().replace(/0/g, "o");
const id = (n: number) => new Uint8Array(16).fill(n);
const hex = (n: number) => Array.from(id(n), (x) => x.toString(16).padStart(2, "0")).join("");
const env = (n: number, message: Message): EnveloppeRecue => ({ id: id(n), heureMs: 1000, regle: 2, message });

function conv(moi = 0, t = { v: 0 }) {
  const c = new Conversation(moi, cle, () => t.v);
  c.liste([0, 1, 2], 0);
  c.groupe({ ajoutes: [], retires: [], createurRevenu: false, membres: [0, 1, 2] });
  c.elements.length = 0;
  return c;
}
const bulles = (c: Conversation) => c.elements.filter((x): x is Bulle => x.k === "bulle");

describe("conversation", () => {
  it("texte reçu : affiché, accusé « reçu » demandé ; doublon d'identifiant ignoré", () => {
    const c = conv();
    expect(c.message(5, 1, 3, env(1, { k: "texte", x: "salut" }))).toEqual({ recu: id(1) });
    expect(c.message(9, 1, 3, env(1, { k: "texte", x: "autre" }))).toBeNull();
    expect(bulles(c).map((b) => [b.texte, b.seq, b.attendus])).toEqual([["salut", 5, [0, 2]]]);
  });
  it("alerte de fin : ligne du salon, pas une bulle de membre", () => {
    const c = conv();
    c.fermeture(15);
    expect(c.elements).toEqual([expect.objectContaining({ k: "sys", quoi: "fermeture", minutes: 15 })]);
    expect(bulles(c)).toEqual([]);
  });
  it("modif et retrait : de l'auteur seulement", () => {
    const c = conv();
    c.message(5, 1, 3, env(1, { k: "texte", x: "a" }));
    c.message(6, 2, 3, env(2, { k: "modif", cible: id(1), x: "pirate" }));
    c.message(7, 2, 3, env(3, { k: "retrait", cible: id(1) }));
    expect(bulles(c)[0]).toMatchObject({ texte: "a", modifie: false, retire: false });
    c.message(8, 1, 3, env(4, { k: "modif", cible: id(1), x: "b" }));
    expect(bulles(c)[0]).toMatchObject({ texte: "b", modifie: true });
    c.message(9, 1, 3, env(5, { k: "retrait", cible: id(1) }));
    expect(bulles(c)[0]).toMatchObject({ texte: "", retire: true });
    c.message(10, 1, 3, env(6, { k: "modif", cible: id(1), x: "revenu" }));
    expect(bulles(c)[0]!.texte).toBe("");
  });
  it("réactions : une par siège, la même la retire", () => {
    const c = conv();
    c.message(5, 1, 3, env(1, { k: "texte", x: "a" }));
    c.message(6, 2, 3, env(2, { k: "reaction", cible: id(1), emoji: "👍" }));
    c.message(7, 0, 3, env(3, { k: "reaction", cible: id(1), emoji: "👍" }));
    expect(bulles(c)[0]!.reactions).toEqual([{ emoji: "👍", sieges: [2, 0] }]);
    c.message(8, 2, 3, env(4, { k: "reaction", cible: id(1), emoji: "😂" }));
    expect(bulles(c)[0]!.reactions).toEqual([{ emoji: "👍", sieges: [0] }, { emoji: "😂", sieges: [2] }]);
    c.message(9, 2, 3, env(5, { k: "reaction", cible: id(1), emoji: "😂" }));
    expect(bulles(c)[0]!.reactions).toEqual([{ emoji: "👍", sieges: [0] }]);
  });
  it("nos messages : en attente, chiffré, accepté, puis reçu et vu une fois par siège attendu", () => {
    const c = conv();
    c.envoye(1, { sorte: "texte", texte: "moi" }, 2);
    const b = bulles(c)[0]!;
    expect(c.coche(b)).toBe("attente");
    c.chiffre(1, id(7));
    c.accepte(1, 12);
    expect(c.coche(b)).toBe("envoye");
    c.message(13, 1, 3, env(8, { k: "recu", ids: [id(7)] }));
    c.message(14, 1, 3, env(9, { k: "recu", ids: [id(7)] }));
    c.message(15, 3, 3, env(10, { k: "vu", ids: [id(7)] })); // siège non attendu : ignoré
    expect(b.recus).toEqual([1]);
    expect(c.coche(b)).toBe("envoye");
    c.message(16, 2, 3, env(11, { k: "vu", ids: [id(7)] }));
    expect(c.coche(b)).toBe("recu");
    c.message(17, 1, 3, env(12, { k: "vu", ids: [id(7)] }));
    expect(c.coche(b)).toBe("vu");
    expect(b.vus).toEqual([2, 1]);
  });
  it("accusés de pièce (v3 §14.2) : ouvert et téléchargé, de nos pièces, d'un lecteur attendu ; valent « vu »", () => {
    const c = conv(0);
    c.pieceEnvoi(-1, { nom: "a.pdf", mime: "application/pdf", taille: 9, sorte: "fichier", dureeMs: null });
    c.rattacher(-1, 1);
    c.chiffre(1, id(7));
    const b = bulles(c)[0]!;
    c.message(20, 1, 3, env(30, { k: "piece_ouverte", ids: [id(7)] }));
    c.message(21, 2, 3, env(31, { k: "piece_telechargee", ids: [id(7)] }));
    c.message(22, 5, 3, env(32, { k: "piece_telechargee", ids: [id(7)] })); // siège non attendu : ignoré
    expect([b.ouverts, b.telecharges, b.vus]).toEqual([[1], [2], [1, 2]]);
    // Un texte (pas une pièce) : ignoré.
    c.message(23, 1, 3, env(2, { k: "texte", x: "x" }));
    c.message(24, 0, 3, env(33, { k: "piece_ouverte", ids: [id(2)] }));
    expect(bulles(c)[1]!.ouverts).toEqual([]);
  });
  it("fiche « Infos » (v3 §14.2) : heure de l'envoi, puis de chaque accusé, par lecteur ; le premier compte", () => {
    const t = { v: 5_000 };
    const c = conv(0, t);
    c.pieceEnvoi(-1, { nom: "a.pdf", mime: "application/pdf", taille: 9, sorte: "fichier", dureeMs: null });
    c.rattacher(-1, 1);
    c.chiffre(1, id(7));
    const b = bulles(c)[0]!;
    expect(c.infos(b)).toEqual({ envoyeMs: null, lecteurs: [{ siege: 1, recu: null, vu: null, ouvert: null, telecharge: null }, { siege: 2, recu: null, vu: null, ouvert: null, telecharge: null }] });
    t.v = 6_000;
    c.accepte(1, 12);
    const a = (n: number, heureMs: number, message: Message): EnveloppeRecue => ({ id: id(n), heureMs, regle: 0, message });
    c.message(13, 1, 3, a(40, 7_000, { k: "recu", ids: [id(7)] }));
    c.message(14, 1, 3, a(41, 8_000, { k: "vu", ids: [id(7)] }));
    c.message(15, 1, 3, a(42, 9_000, { k: "vu", ids: [id(7)] })); // second « vu » : l'heure du premier reste
    c.message(16, 2, 3, a(43, 10_000, { k: "piece_telechargee", ids: [id(7)] })); // vaut aussi reçu et vu
    c.message(17, 1, 3, a(44, 11_000, { k: "piece_ouverte", ids: [id(7)] }));
    c.message(18, 4, 3, a(45, 12_000, { k: "vu", ids: [id(7)] })); // siège non attendu : ignoré
    expect(c.infos(b)).toEqual({
      envoyeMs: 6_000,
      lecteurs: [
        { siege: 1, recu: 7_000, vu: 8_000, ouvert: 11_000, telecharge: null },
        { siege: 2, recu: 10_000, vu: 10_000, ouvert: null, telecharge: 10_000 },
      ],
    });
    // Message d'un autre : pas de fiche.
    c.message(19, 1, 3, env(3, { k: "texte", x: "x" }));
    expect(c.infos(bulles(c)[1]!)).toBeNull();
  });
  it("changerDeSiege (32) : notre pseudonyme suit au siège 0 sans être « pris » par notre ancien siège ; l'ancien occupant garde son nom", () => {
    const c = conv(2);
    c.message(5, 0, 3, env(1, { k: "profil", pseudo: "Lea", couleur: 0, avatar: null }));
    c.message(6, 0, 3, env(2, { k: "texte", x: "de l'ancienne page" }));
    c.monProfil("Leax", 2, 7);
    c.changerDeSiege(0);
    expect(c.moi).toBe(0);
    expect(c.presents.has(2)).toBe(false);
    c.monProfil("Leax", 2);
    expect(c.pseudoRefuse).toBe(false);
    expect(c.nom(0).pseudo).toBe("Leax");
    expect(c.nomDe(bulles(c)[0]!).pseudo).toBe("Lea");
    // Aucune ligne « a changé de pseudonyme » ni « a quitté » ; le départ annoncé ensuite n'en ajoute pas.
    c.depart(2);
    expect(c.elements.filter((e) => e.k === "sys")).toEqual([]);
  });
  it("réponse : citation par identifiant ; efface (0x0E) retire la bulle", () => {
    const c = conv();
    c.message(5, 1, 3, env(1, { k: "texte", x: "a" }));
    c.message(6, 2, 3, env(2, { k: "reponse", cible: id(1), x: "b" }));
    expect(bulles(c)[1]!.cite).toBe(hex(1));
    c.efface(5);
    expect(bulles(c).map((b) => b.texte)).toEqual(["b"]);
    expect(c.bulle(hex(1))).toBeUndefined();
  });
  it("pseudonymes : unicité, le premier en ordre seq garde le nom ; changement annoncé", () => {
    const c = conv(2);
    c.message(5, 1, 3, env(1, { k: "profil", pseudo: "Leo", couleur: 1, avatar: null }));
    c.message(6, 2, 3, env(2, { k: "profil", pseudo: "LE0", couleur: 2, avatar: null }));
    expect(c.nom(1).pseudo).toBe("Leo");
    expect(c.nom(2)).toEqual({ pseudo: null, numero: 3 });
    expect(c.pseudoRefuse).toBe(true);
    expect(c.pseudoPris("leo")).toBe(true);
    c.message(7, 2, 3, env(3, { k: "profil", pseudo: "Lou", couleur: 2, avatar: null }));
    expect(c.pseudoRefuse).toBe(false);
    c.message(8, 1, 3, env(4, { k: "profil", pseudo: "Léa", couleur: 1, avatar: null }));
    expect(c.elements.at(-1)).toMatchObject({ k: "sys", quoi: "pseudo", siege: 1, avant: "Leo", apres: "Léa" });
    expect(c.couleurLibre()).toBe(0);
  });
  it("P1 : deux membres déjà là à notre arrivée se disputent un pseudonyme → aucun ne le garde, une seule ligne", () => {
    const c = conv(0); // arrivée : 1 et 2 déjà là
    c.message(5, 2, 3, env(1, { k: "profil", pseudo: "Hugo", couleur: 2, avatar: null })); // tricheur, plus rapide
    expect(c.nom(2).pseudo).toBe("Hugo");
    c.message(6, 1, 3, env(2, { k: "profil", pseudo: "hugo", couleur: 1, avatar: null })); // vrai titulaire
    expect([c.nom(1).pseudo, c.nom(2).pseudo]).toEqual([null, null]);
    expect(c.elements.filter((e) => e.k === "sys" && e.quoi === "double")).toHaveLength(1);
    // Redit plus tard : toujours refusé, sans nouvelle ligne.
    c.message(7, 2, 3, env(3, { k: "profil", pseudo: "HUGO", couleur: 2, avatar: null }));
    expect(c.nom(2).pseudo).toBeNull();
    expect(c.elements.filter((e) => e.k === "sys" && e.quoi === "double")).toHaveLength(1);
    expect(c.pseudoPris("Hugo")).toBe(true); // ni pour nous non plus
    // Un autre pseudonyme reste libre pour chacun.
    c.message(8, 1, 3, env(4, { k: "profil", pseudo: "Inès", couleur: 1, avatar: null }));
    expect(c.nom(1).pseudo).toBe("Inès");
  });
  it("P1 : un membre arrivé après nous garde la règle du premier (nous avons vu l'ordre)", () => {
    const t = { v: 0 };
    const c = new Conversation(0, cle, () => t.v);
    c.liste([0], 0); // seul à l'arrivée
    c.arrivee(1);
    c.arrivee(2);
    c.groupe({ ajoutes: [1, 2], retires: [], createurRevenu: false, membres: [0, 1, 2] });
    c.message(5, 1, 3, env(1, { k: "profil", pseudo: "Hugo", couleur: 1, avatar: null }));
    c.message(6, 2, 3, env(2, { k: "profil", pseudo: "hugo", couleur: 2, avatar: null }));
    expect([c.nom(1).pseudo, c.nom(2).pseudo]).toEqual(["Hugo", null]);
  });
  it("notre profil : appliqué chez nous, puis au rang de notre trame ; perdu contre un rang antérieur", () => {
    const c = conv(0);
    c.monProfil("Ana", 3);
    expect(c.nom(0).pseudo).toBe("Ana");
    expect(c.couleur(0)).toBe(3);
    c.message(4, 1, 3, env(1, { k: "profil", pseudo: "ANA", couleur: 1, avatar: null }));
    expect(c.nom(1).pseudo).toBe("ANA");
    // Notre trame a pris le rang 9 : celle du siège 1 (rang 4) garde le pseudonyme.
    c.monProfil("Ana", 3, 9);
    expect(c.nom(0).pseudo).toBeNull();
    expect(c.pseudoRefuse).toBe(true);
  });
  it("groupe : arrivée, retour (code changé), créateur revenu sans « code changé »", () => {
    const c = conv(1);
    c.groupe({ ajoutes: [2], retires: [], createurRevenu: false, membres: [0, 1, 2] });
    c.groupe({ ajoutes: [2], retires: [2], createurRevenu: false, membres: [0, 1, 2] });
    c.groupe({ ajoutes: [0], retires: [0], createurRevenu: true, membres: [0, 1, 2] });
    expect(c.elements.map((e) => (e.k === "sys" ? `${e.quoi}:${e.siege}` : "b"))).toEqual(["arrivee:2", "retour:2", "code:2", "createur:0", "retour:0"]);
  });
  it("siège libéré puis redonné : l'ancien occupant garde son nom et sa couleur dans le fil", () => {
    const c = conv(0);
    c.message(5, 1, 3, env(1, { k: "profil", pseudo: "Hugo", couleur: 4, avatar: null }));
    c.message(6, 1, 3, env(2, { k: "texte", x: "de Hugo" }));
    c.depart(1, true);
    c.arrivee(1);
    c.groupe({ ajoutes: [1], retires: [], createurRevenu: false, membres: [0, 1, 2] });
    // Avant le profil du nouveau : « Participant 2 », jamais « Hugo ».
    expect(c.nom(1)).toEqual({ pseudo: null, numero: 2 });
    c.message(9, 1, 3, env(3, { k: "profil", pseudo: "Inès", couleur: 6, avatar: null }));
    c.message(10, 1, 3, env(4, { k: "texte", x: "de Inès" }));
    const [hugo, ines] = bulles(c);
    expect([c.nomDe(hugo!).pseudo, c.couleurDe(hugo!)]).toEqual(["Hugo", 4]);
    expect([c.nomDe(ines!).pseudo, c.couleurDe(ines!)]).toEqual(["Inès", 6]);
    const sys = c.elements.filter((e) => e.k === "sys");
    expect(sys.map((e) => `${e.quoi}:${c.nomDe(e).pseudo}`)).toEqual(["exclusion:Hugo", "arrivee:Inès"]);
    // Aucun « Hugo s'appelle maintenant Inès ».
    expect(sys.some((e) => e.quoi === "pseudo")).toBe(false);
  });
  it("écart groupe / serveur : signalé après quelques secondes, avec le nom de l'ancien occupant", () => {
    const t = { v: 1000 };
    const c = conv(0, t);
    c.message(5, 2, 3, env(1, { k: "profil", pseudo: "Zoé", couleur: 2, avatar: null }));
    c.depart(2);
    // Le serveur dit le siège 2 parti, le groupe le contient encore.
    expect(c.encoreDansLeGroupe()).toEqual([]);
    t.v += 8001;
    expect(c.encoreDansLeGroupe()).toEqual([{ siege: 2, pseudo: "Zoé", numero: 3 }]);
    // Le Commit de retrait arrive : plus d'alerte.
    c.groupe({ ajoutes: [], retires: [2], createurRevenu: false, membres: [0, 1] });
    expect(c.encoreDansLeGroupe()).toEqual([]);
  });
  it("règle d'effacement (C-5) : défaut 5 min, la plus récente en ordre seq gagne, ligne affichée", () => {
    const c = conv(0);
    expect(c.regle).toBe(2);
    c.message(5, 1, 3, env(1, { k: "texte", x: "a" }));
    c.message(6, 1, 3, { ...env(2, { k: "texte", x: "b" }), regle: 3 });
    expect(c.regle).toBe(3); // sans message « regle » : celle du dernier message reçu
    c.message(9, 2, 3, env(3, { k: "regle", regle: 1 }));
    c.message(8, 1, 3, env(4, { k: "regle", regle: 3 })); // plus ancien : ignoré
    expect(c.regle).toBe(1);
    expect(c.elements.filter((e) => e.k === "sys" && e.quoi === "regle")).toHaveLength(1);
    c.message(10, 1, 3, { ...env(5, { k: "texte", x: "c" }), regle: 3 });
    expect(c.regle).toBe(1);
  });
  it("codes vérifiés : annulés quand le code change (reprise) et au renouvellement", () => {
    const c = conv(0);
    c.verifies.set(1, "11111-22222-33333-44444-55555");
    c.verifies.set(2, "x");
    c.groupe({ ajoutes: [1], retires: [1], createurRevenu: false, membres: [0, 1, 2] });
    expect([...c.verifies.keys()]).toEqual([2]);
    c.message(5, 1, 3, env(1, { k: "texte", x: "a" }));
    const partis = c.renouveler(7);
    expect(partis).toEqual([hex(1)]);
    expect(c.verifies.size).toBe(0);
    expect(c.elements.filter((e) => e.k === "bulle")).toEqual([]);
  });
  it("« écrit » : 6 s, effacé par le message", () => {
    const t = { v: 0 };
    const c = conv(0, t);
    c.message(5, 1, 3, env(1, { k: "ecrit" }));
    expect(c.ecrivent()).toEqual([1]);
    t.v = 7000;
    expect(c.ecrivent()).toEqual([]);
    t.v = 0;
    c.message(6, 1, 3, env(2, { k: "ecrit" }));
    c.message(7, 1, 3, env(3, { k: "texte", x: "x" }));
    expect(c.ecrivent()).toEqual([]);
  });
});

describe("morceaux", () => {
  it("liens https et http seulement, ponctuation finale laissée au texte", () => {
    expect(morceaux("voir https://exemple.fr/a?b=1. puis")).toEqual([
      { lien: false, t: "voir " },
      { lien: true, t: "https://exemple.fr/a?b=1" },
      { lien: false, t: ". puis" },
    ]);
    expect(morceaux("javascript:alert(1) ftp://x data:text/html,x")).toEqual([{ lien: false, t: "javascript:alert(1) ftp://x data:text/html,x" }]);
    expect(morceaux("http://")).toEqual([{ lien: false, t: "http://" }]);
  });
});

describe("morceaux : messages piégés", () => {
  it("longue ponctuation après un lien : coût linéaire, même découpe", () => {
    const t = "https://a" + ".".repeat(1990) + "x";
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) morceaux(t + i);
    expect((performance.now() - t0) / 20).toBeLessThan(2);
    expect(morceaux("voir https://x.fr. puis")).toEqual([
      { lien: false, t: "voir " },
      { lien: true, t: "https://x.fr" },
      { lien: false, t: ". puis" },
    ]);
  });
  it("même texte : même résultat, sans recalcul", () => {
    expect(morceaux("lien https://y.fr")).toBe(morceaux("lien https://y.fr"));
  });
});

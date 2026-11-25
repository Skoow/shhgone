// @vitest-environment happy-dom
// Page Compte (/compte ; Profil et Paramètres réunis le 25 novembre ; conception du compte par
// passkey §3.4 à §3.6, conception compte §21.5, §21.15.3) : profil (photo ré-encodée sur
// l'appareil, pseudo unique, carte « Votre compte » qui dit aussi ses erreurs), sections (plus d'adresse, de mot de passe ni de double authentification), « Passkeys » (libellé,
// mois, « liée à cet appareil », « ouvre vos données », « cette passkey », ajout, renommage,
// retrait jamais de la dernière, confirmation par passkey si la session n'est plus récente),
// « Clé de récupération » (nouvelle clé), suppression par un geste de passkey. Le module de compte
// est remplacé par un double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { attendre, bouton, demonter, erreurDe, monter, presser, saisir } from "./pages.test-helper";

const texte = () => document.body.textContent!.replace(/\s+/g, " ");
const CLE = "AB12-CD34-EF56-GH78-JK90-MN12-PQ3";
const PK = (o: object = {}) => ({ id: "AQID", ajoutee: "2026-11", nom: "iPhone", synchronisable: true, ouvre: true, courante: true, ...o });
const C = vi.hoisted(() => ({
  etatCompte: vi.fn(),
  listePasskeys: vi.fn(),
  preparerReauth: vi.fn(),
  confirmerParPasskey: vi.fn(),
  preparerAjout: vi.fn(),
  ajouterPasskey: vi.fn(),
  deuxiemeGesteAjout: vi.fn(),
  nommerPasskey: vi.fn(),
  retirerPasskey: vi.fn(),
  preparerNouvelleCle: vi.fn(),
  enregistrerNouvelleCle: vi.fn(),
  groupeAVerifier: vi.fn(),
  appareils: vi.fn(),
  supprimerTout: vi.fn(),
  seDeconnecter: vi.fn(),
  ecrireProfil: vi.fn(),
  pseudoLibre: vi.fn(),
  changerPseudo: vi.fn(),
  verifierSaisie: vi.fn(),
}));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
// L'illustration de fin ne s'anime pas ici (happy-dom rejette les animations annulées au démontage).
vi.mock("../../ui/motion", async (orig) => ({ ...(await orig<object>()), reducedMotion: () => true }));
const AV = vi.hoisted(() => ({ reencoder: vi.fn() }));
vi.mock("../../ui/avatar", async (orig) => ({ ...(await orig<object>()), ...AV }));
const { CompteError, account, REGLAGES_DEFAUT } = await import("../../account/session.svelte");
const { default: Compte } = await import("./Compte.svelte");
const ETAT = { creeLe: "2026-11-14", palier: "neuf", confirmeLe: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, surMesure: false, salonsActifs: 1, banniId: null, banniJusqu: null, banniMotif: null };

beforeEach(() => {
  setLang("fr");
  for (const f of [...Object.values(C), ...Object.values(AV)]) f.mockReset();
  C.etatCompte.mockResolvedValue(ETAT);
  C.listePasskeys.mockResolvedValue([PK(), PK({ id: "BAUG", nom: null, synchronisable: false, ouvre: false, courante: false })]);
  C.preparerReauth.mockResolvedValue(undefined);
  C.confirmerParPasskey.mockResolvedValue(undefined);
  C.preparerAjout.mockResolvedValue("pret");
  C.ajouterPasskey.mockResolvedValue("ajoutee");
  C.retirerPasskey.mockResolvedValue(true);
  C.preparerNouvelleCle.mockResolvedValue(CLE);
  C.enregistrerNouvelleCle.mockResolvedValue(undefined);
  C.groupeAVerifier.mockReturnValue(1);
  C.appareils.mockResolvedValue([]);
  C.ecrireProfil.mockImplementation(async (p: object) => void (account.profil = { ...account.profil!, ...p }));
  C.pseudoLibre.mockResolvedValue(true);
  C.verifierSaisie.mockResolvedValue({});
  account.etat = "ouvert";
  account.profil = { pseudo: "Lea", photo: null, langue: "fr", reglages: { ...REGLAGES_DEFAUT }, pass: null };
});
afterEach(() => {
  demonter();
  account.etat = "absent";
  account.profil = undefined;
  account.cleLocale = account.recupere = false;
});

describe("page Compte : une seule page, sans doublon", () => {
  it("titre « Compte » ; sections dans l'ordre, sans Abonnement à part ; « Se déconnecter » une seule fois ; ni export, ni « Garder les liens »", async () => {
    await monter(Compte);
    expect(document.querySelector("h1")!.textContent).toBe("Compte");
    const titres = [...document.querySelectorAll("h2")].map((h) => h.textContent);
    expect(titres).toEqual(["Profil", "Passkeys", "Clé de récupération", "Appareils", "Confidentialité", "Vos données"]);
    expect([...document.querySelectorAll("button")].filter((b) => b.textContent!.trim() === "Se déconnecter")).toHaveLength(1);
    expect(texte()).not.toMatch(/Exporter|Garder les liens|historique des liens|Paramètres/);
    // Abonnement dit une fois (carte « Votre compte »).
    expect(texte().match(/Voir les offres/g)).toHaveLength(1);
  });

  it("« Se déconnecter » : session fermée, puis la page de connexion", async () => {
    C.seDeconnecter.mockResolvedValue(undefined);
    await monter(Compte);
    await presser("Se déconnecter");
    expect(C.seDeconnecter).toHaveBeenCalledOnce();
    expect(location.pathname).toBe("/compte/connexion");
  });
});

// Bug du 25 novembre : « le rectangle n'affiche rien, comme s'il restait en chargement ». La carte
// « Votre compte » restait en squelette (aria-busy) quand GET /api/compte échouait ou ne répondait
// pas : l'erreur partait dans un bandeau en haut de page. Elle est dite dans la carte, avec
// « Réessayer » ; une requête sans réponse échoue au bout de 15 s.
describe("carte « Votre compte »", () => {
  it("réponse : date, palier, abonnement ; plus de squelette", async () => {
    await monter(Compte);
    const carte = document.querySelector("[data-carte-compte]")!;
    expect(carte.getAttribute("aria-busy")).toBeNull();
    expect(carte.textContent!.replace(/\s+/g, " ")).toContain("Membre depuis le 14 novembre 2026");
    expect(carte.textContent).toContain("Gratuit");
  });

  it("échec de GET /api/compte : l'erreur est dans la carte (plus de squelette), « Réessayer » recharge", async () => {
    C.etatCompte.mockRejectedValueOnce(new CompteError(0, "reseau"));
    await monter(Compte);
    const carte = () => document.querySelector("[data-carte-compte]")!;
    expect(carte().getAttribute("aria-busy")).toBeNull();
    expect(carte().querySelector(".sq")).toBeNull();
    expect(carte().querySelector("[data-carte-erreur]")!.textContent!.length).toBeGreaterThan(0);
    await presser("Réessayer");
    expect(C.etatCompte).toHaveBeenCalledTimes(2);
    expect(carte().textContent!.replace(/\s+/g, " ")).toContain("Membre depuis le 14 novembre 2026");
  });

  it("aucune réponse : au bout de 15 s, l'erreur réseau au lieu d'un chargement sans fin", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      C.etatCompte.mockReturnValueOnce(new Promise(() => undefined));
      await monter(Compte);
      expect(document.querySelector("[data-carte-compte]")!.getAttribute("aria-busy")).toBe("true");
      await vi.advanceTimersByTimeAsync(15_000);
      await attendre();
      expect(document.querySelector("[data-carte-compte]")!.getAttribute("aria-busy")).toBeNull();
      expect(document.querySelector("[data-carte-erreur]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("palier confirmé ; compte banni : bandeau avec la date et le motif", async () => {
    C.etatCompte.mockResolvedValue({ ...ETAT, palier: "confirme", confirmeLe: null, limites: { salons: 3, places: 10, heures: 24 }, banniJusqu: "2029-11-14", banniMotif: 6 });
    await monter(Compte);
    expect(texte()).toContain("Confirmé : 3 salons à la fois, 10 places.");
    expect(texte()).toContain("Ce compte ne peut plus créer de salon jusqu'au 14 novembre 2029. Motif : Harcèlement.");
  });
});

describe("profil", () => {
  async function apres400() {
    await new Promise((r) => setTimeout(r, 450));
    await attendre();
  }

  it("avatar (initiale), pseudo actuel, note de confidentialité et son lien", async () => {
    await monter(Compte);
    expect((document.querySelector('input[autocomplete="nickname"]') as HTMLInputElement).value).toBe("Lea");
    expect(texte()).toContain("Votre pseudo, votre photo et votre abonnement sont chiffrés sur vos appareils : le service ne peut pas les lire.");
    const liens = [...document.querySelectorAll("a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")]);
    expect(liens).toContainEqual(["En savoir plus", "/securite"]);
    expect(liens).toContainEqual(["Voir les offres", "/offres"]);
  });

  it("photo : changée (ré-encodée sur l'appareil) puis retirée, écrite dans le coffre de profil", async () => {
    const octets = new Uint8Array(40_000).fill(7);
    AV.reencoder.mockResolvedValue(octets);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x/p");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await monter(Compte);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "moi.jpg", { type: "image/jpeg" })], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await attendre();
    expect(C.ecrireProfil).toHaveBeenCalledWith({ photo: octets });
    expect(texte()).not.toContain("moi.jpg"); // le nom du fichier n'est jamais gardé ni montré
    const retirer = [...document.querySelectorAll("button")].filter((b) => b.textContent!.trim() === "Retirer")[0]!;
    retirer.click();
    await attendre();
    expect(C.ecrireProfil).toHaveBeenLastCalledWith({ photo: null });
  });

  it("pseudo libre : « Disponible » puis enregistré ; pris : « Déjà pris » ; limite : date du prochain changement", async () => {
    await monter(Compte);
    saisir("Pseudo", "LeaB");
    await apres400();
    expect(C.pseudoLibre).toHaveBeenCalledWith("LeaB");
    expect(texte()).toContain("Disponible");
    await presser("Enregistrer");
    expect(C.changerPseudo).toHaveBeenCalledWith("LeaB");
    expect(texte()).toContain("Pseudo enregistré.");
    C.changerPseudo.mockRejectedValueOnce(new CompteError(409, "pseudo_pris"));
    saisir("Pseudo", "Max");
    await apres400();
    await presser("Enregistrer");
    expect(erreurDe("Pseudo")).toBe("Déjà pris");
  });

  it("pseudo inchangé : aucune vérification ni enregistrement", async () => {
    await monter(Compte);
    await apres400();
    expect(C.pseudoLibre).not.toHaveBeenCalled();
    await presser("Enregistrer");
    expect(C.changerPseudo).not.toHaveBeenCalled();
  });
});

// Passkeys, clé de récupération et suppression : Compte.passkeys.test.ts.

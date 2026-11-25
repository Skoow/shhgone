// @vitest-environment happy-dom
// Connexion par passkey et récupération par la clé (/compte/connexion, /compte/recuperation ;
// conception du compte par passkey §3.2 à §3.4, §5.5) : un clic et un geste ; repli par la clé de
// récupération, jamais silencieux (raison dite) ; erreurs de la clé sur le champ ; écran
// « Créez une passkey sur cet appareil » après la clé. Le module de compte est remplacé par un double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { appareil, bouton, cocher, demonter, erreurDe, monter, presser, saisir } from "./pages.test-helper";

const texte = () => document.body.textContent!.replace(/\s+/g, " ");
const C = vi.hoisted(() => ({
  preparerConnexion: vi.fn(),
  seConnecter: vi.fn(),
  ouvrirAvecCle: vi.fn(),
  annulerCle: vi.fn(),
  cleRequise: vi.fn(),
  etatCompte: vi.fn(),
  seDeconnecter: vi.fn(),
  passkeysDisponibles: vi.fn(),
  preparerAjout: vi.fn(),
  ajouterPasskey: vi.fn(),
  deuxiemeGesteAjout: vi.fn(),
}));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
const { CompteError, account } = await import("../../account/session.svelte");
const { default: Connexion } = await import("./Connexion.svelte");
const { default: Recuperation } = await import("./Recuperation.svelte");
const ETAT = { creeLe: "2026-11-14", palier: "neuf", confirmeLe: null, limites: { salons: 1, places: 4, heures: 24 }, salonsActifs: 0, banniId: null, banniJusqu: null, banniMotif: null };

beforeEach(() => {
  setLang("fr");
  appareil("telephone"); // téléphone : parcours inchangé ; ordinateur : tests « sur ordinateur » plus bas
  for (const f of Object.values(C)) f.mockReset();
  C.preparerConnexion.mockResolvedValue(undefined);
  C.passkeysDisponibles.mockReturnValue(true);
  C.etatCompte.mockResolvedValue(ETAT);
  C.seConnecter.mockImplementation(async () => {
    account.etat = "ouvert";
    return "ouvert";
  });
  C.ouvrirAvecCle.mockImplementation(async () => {
    account.etat = "ouvert";
    return "recup";
  });
  C.preparerAjout.mockResolvedValue("pret");
  C.ajouterPasskey.mockResolvedValue("ajoutee");
});
afterEach(() => {
  demonter();
  account.etat = "absent";
  account.recupere = account.cleLocale = false;
});

describe("connexion par passkey", () => {
  it("écran : bouton, « Rester connecté » décochée, liens ; cérémonie chargée à l'ouverture ; un clic ouvre", async () => {
    await monter(Connexion);
    expect(C.preparerConnexion).toHaveBeenCalledTimes(1);
    expect(texte()).toContain("J'ai ma clé de récupération");
    expect(texte()).toContain("Créer un compte");
    expect(texte()).not.toMatch(/Mot de passe|Adresse e-mail/);
    cocher("Rester connecté sur cet appareil");
    await presser("Se connecter avec une passkey");
    expect(C.seConnecter).toHaveBeenCalledWith(true, "defaut");
    expect(texte()).toContain("Vous êtes connecté sur cet appareil.");
  });

  it("feuille annulée : aucun message ; passkey inconnue : message", async () => {
    C.seConnecter.mockRejectedValue(new Error("annule"));
    await monter(Connexion);
    await presser("Se connecter avec une passkey");
    expect(document.querySelector(".banner, [role=alert]")).toBeNull();
    C.seConnecter.mockRejectedValue(new CompteError(403, "identifiants"));
    await presser("Se connecter avec une passkey");
    expect(texte()).toContain("Cette passkey n'est liée à aucun compte.");
  });

  it("données pas ouvertes ici : la raison est dite, la clé est demandée une fois ; erreurs sur le champ ; annuler ferme la session", async () => {
    C.seConnecter.mockResolvedValue("cle_requise");
    await monter(Connexion);
    await presser("Se connecter avec une passkey");
    expect(texte()).toContain("Cet appareil ne permet pas d'ouvrir vos données avec cette passkey. Entrez votre clé de récupération une fois");
    C.ouvrirAvecCle.mockRejectedValueOnce(new Error("cle_recup_controle"));
    saisir("Clé de récupération", "abcd");
    await presser("Ouvrir");
    expect(erreurDe("Clé de récupération")).toBe("Clé mal recopiée\u202f: vérifiez chaque groupe.");
    C.ouvrirAvecCle.mockRejectedValueOnce(new CompteError(403, "identifiants"));
    await presser("Ouvrir");
    expect(erreurDe("Clé de récupération")).toBe("Cette clé de récupération n'ouvre aucun compte.");
    C.ouvrirAvecCle.mockRejectedValueOnce(new Error("cle_autre_compte"));
    await presser("Ouvrir");
    expect(erreurDe("Clé de récupération")).toBe("Cette clé ouvre un autre compte que celui de la passkey.");
    await presser("Ouvrir");
    expect(C.ouvrirAvecCle).toHaveBeenLastCalledWith("abcd");
    expect(texte()).toContain("Vous êtes connecté sur cet appareil.");
  });

  it("page quittée pendant que la clé est demandée : la session de la passkey est fermée ; sinon rien", async () => {
    await monter(Connexion);
    C.cleRequise.mockReturnValue(false);
    demonter();
    expect(C.annulerCle).not.toHaveBeenCalled();
    C.seConnecter.mockResolvedValue("cle_requise");
    await monter(Connexion);
    await presser("Se connecter avec une passkey");
    C.cleRequise.mockReturnValue(true);
    demonter();
    expect(C.annulerCle).toHaveBeenCalledTimes(1);
  });

  it("annuler la clé : la session de la passkey est fermée, retour au bouton", async () => {
    C.seConnecter.mockResolvedValue("cle_requise");
    await monter(Connexion);
    await presser("Se connecter avec une passkey");
    await presser("Annuler");
    expect(C.annulerCle).toHaveBeenCalled();
    expect(bouton("Se connecter avec une passkey")).toBeTruthy();
  });

  it("clé locale : dit à l'écran ; compte banni : date, motif et identifiant de recours", async () => {
    C.seConnecter.mockImplementation(async () => {
      account.etat = "ouvert";
      account.cleLocale = true;
      return "ouvert";
    });
    C.etatCompte.mockResolvedValue({ ...ETAT, banniId: "B-ABCD-EFGH-JKMNP", banniJusqu: "2027-01-01", banniMotif: 6 });
    await monter(Connexion);
    await presser("Se connecter avec une passkey");
    expect(texte()).toContain("vos données s'ouvrent grâce à une clé gardée ici");
    expect(texte()).toContain("B-ABCD-EFGH-JKMNP");
  });

  it("navigateur sans passkeys : message, et le lien de la clé de récupération reste", async () => {
    C.passkeysDisponibles.mockReturnValue(false);
    await monter(Connexion);
    expect(texte()).toContain("Ce navigateur ne gère pas les passkeys.");
    expect(texte()).toContain("J'ai ma clé de récupération");
    expect(C.preparerConnexion).not.toHaveBeenCalled();
  });
});

describe("récupération par la clé", () => {
  it("clé, puis « Créez une passkey sur cet appareil » (cérémonie chargée d'avance), puis le bandeau de nouvelle clé", async () => {
    await monter(Recuperation);
    expect(texte()).toContain("Clé de récupération");
    expect(texte()).toContain("Elle n'est jamais envoyée");
    saisir("Clé de récupération", "AB12-…");
    cocher("Rester connecté sur cet appareil");
    account.recupere = true;
    await presser("Ouvrir");
    expect(C.ouvrirAvecCle).toHaveBeenCalledWith("AB12-…", true);
    expect(texte()).toContain("Créez une passkey sur cet appareil");
    expect(C.preparerAjout).toHaveBeenCalled();
    await presser("Créer la passkey");
    expect(C.ajouterPasskey).toHaveBeenCalledWith("");
    expect(texte()).toContain("Passkey ajoutée.");
    expect(texte()).toContain("Votre clé de récupération a servi.");
  });

  it("« Plus tard » : aucune passkey créée ; clé mal recopiée : erreur sur le champ", async () => {
    C.ouvrirAvecCle.mockRejectedValueOnce(new Error("cle_recup_longueur"));
    await monter(Recuperation);
    saisir("Clé de récupération", "x");
    await presser("Ouvrir");
    expect(erreurDe("Clé de récupération")).toBe("Clé mal recopiée\u202f: vérifiez chaque groupe.");
    await presser("Ouvrir");
    await presser("Plus tard");
    expect(C.ajouterPasskey).not.toHaveBeenCalled();
    expect(bouton("Continuer")).toBeTruthy();
  });
});

// Décision du 25 novembre (conception §18) : sur ordinateur, le téléphone d'abord (QR), puis cet ordinateur.
describe("connexion sur ordinateur", () => {
  beforeEach(() => appareil("ordinateur"));

  it("« Se connecter avec mon téléphone » (hybride), le QR expliqué ; « Utiliser une passkey de cet ordinateur » (local)", async () => {
    await monter(Connexion);
    expect(texte()).toContain("Scannez-le avec l'appareil photo du téléphone qui garde votre passkey");
    expect(() => bouton("Se connecter avec une passkey")).toThrow();
    await presser("Se connecter avec mon téléphone");
    expect(C.seConnecter).toHaveBeenLastCalledWith(false, "hybride");
    expect(C.preparerConnexion).toHaveBeenCalledTimes(1);
    account.etat = "absent";
    demonter();
    await monter(Connexion);
    await presser("Utiliser une passkey de cet ordinateur");
    expect(C.seConnecter).toHaveBeenLastCalledWith(false, "local");
  });
});


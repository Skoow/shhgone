// @vitest-environment happy-dom
// Inscription par passkey (/compte/inscription ; conception du compte par passkey §3.1) : pseudo
// vérifié pendant la saisie, « Créer avec une passkey » (cérémonie chargée d'avance : le clic
// n'attend aucune requête), deuxième confirmation si besoin, clé de récupération (« Copier »,
// « Télécharger (.txt) », « Je l'ai notée »), un groupe à retaper, « Terminer ». Annuler la feuille
// n'affiche rien. Le module de compte est remplacé par un double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { attendre, bouton, champ, demonter, erreurDe, monter, presser, saisir, PREUVE } from "./pages.test-helper";
/** Texte de la page, espaces insécables comprises ramenées à une espace (les textes FR en ont). */
const texte = () => document.body.textContent!.replace(/\s+/g, " ");
const LG = "Tapez le groupe n°\u00a02 de la clé";

const CLE = "AB12-CD34-EF56-GH78-JK90-MN12-PQ3";
const C = vi.hoisted(() => ({
  preparerInscription: vi.fn(),
  inscriptionPrete: vi.fn(),
  creerPasskey: vi.fn(),
  cleAffichee: vi.fn(),
  deuxiemeGeste: vi.fn(),
  terminerInscription: vi.fn(),
  abandonnerInscription: vi.fn(),
  pseudoLibre: vi.fn(),
  verifierSaisie: vi.fn(),
  passkeysDisponibles: vi.fn(),
  groupeAVerifier: vi.fn(),
}));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
vi.mock("./preuve", () => ({ obtenirPreuve: async () => PREUVE, preparerPreuve: () => undefined }));
const { CompteError, account } = await import("../../account/session.svelte");
const { default: Inscription } = await import("./Inscription.svelte");

beforeEach(() => {
  setLang("fr");
  for (const f of Object.values(C)) f.mockReset();
  C.preparerInscription.mockResolvedValue(undefined);
  C.inscriptionPrete.mockReturnValue(true);
  C.creerPasskey.mockResolvedValue("cle");
  C.cleAffichee.mockReturnValue(CLE);
  C.terminerInscription.mockResolvedValue(undefined);
  C.abandonnerInscription.mockResolvedValue(true);
  C.pseudoLibre.mockResolvedValue(true);
  C.verifierSaisie.mockResolvedValue({});
  C.passkeysDisponibles.mockReturnValue(true);
  C.groupeAVerifier.mockReturnValue(2);
});
afterEach(() => {
  demonter();
  account.cleLocale = false;
});

async function jusquALaCle() {
  await monter(Inscription);
  saisir("Pseudo", "Lea");
  await presser("Créer avec une passkey");
}

describe("inscription par passkey", () => {
  it("écran 1 : textes de la conception ; cérémonie chargée à l'ouverture avec la preuve anti-robot", async () => {
    await monter(Inscription);
    expect(texte()).toContain("Créer un compte");
    expect(texte()).toContain("Sans e-mail ni mot de passe. Votre téléphone ou votre ordinateur vous reconnaît.");
    expect(texte()).toContain("En créant un compte, vous confirmez avoir au moins 15");
    expect(texte()).toContain("J'ai déjà un compte");
    expect(C.preparerInscription).toHaveBeenCalledWith(PREUVE);
    expect(champ("Pseudo")).toBeTruthy();
    expect(bouton("Créer avec une passkey").disabled).toBe(false);
    expect(texte()).not.toMatch(/e-mail\b.*Adresse|Mot de passe/);
  });

  it("pseudo vérifié pendant la saisie : « Disponible » / « Déjà pris » ; pris : refus avant la feuille", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await monter(Inscription);
      saisir("Pseudo", "Lea");
      await vi.advanceTimersByTimeAsync(600);
      await attendre();
      expect(texte()).toContain("Disponible");
      C.pseudoLibre.mockResolvedValue(false);
      saisir("Pseudo", "Zoe");
      await vi.advanceTimersByTimeAsync(600);
      await attendre();
      expect(texte()).toContain("Déjà pris");
      await presser("Créer avec une passkey");
      expect(C.creerPasskey).not.toHaveBeenCalled();
      expect(erreurDe("Pseudo")).toBe("Déjà pris");
    } finally {
      vi.useRealTimers();
    }
  });

  it("le clic appelle creerPasskey sans autre requête ; clé, vérification d'un groupe, « Terminer »", async () => {
    await jusquALaCle();
    expect(C.creerPasskey).toHaveBeenCalledWith("Lea", "fr");
    expect(C.preparerInscription).toHaveBeenCalledTimes(1);
    expect(texte()).toContain("Votre clé de récupération");
    expect(texte()).toContain("Nous ne pouvons pas la retrouver");
    expect(texte()).toContain("Le compte n'existe qu'après « Terminer ».");
    expect([...document.querySelectorAll("[data-cle] .g")].map((g) => g.textContent)).toEqual(CLE.split("-"));
    expect(bouton("Copier")).toBeTruthy();
    expect(bouton("Télécharger (.txt)")).toBeTruthy();
    await presser("Je l'ai notée");
    expect(texte()).toContain("Vérification");
    saisir(LG, "cd35");
    await presser("Terminer");
    expect(erreurDe(LG)).toBe("Ce groupe ne correspond pas. Revoyez la clé.");
    expect(C.terminerInscription).not.toHaveBeenCalled();
    await presser("Revoir la clé");
    expect(texte()).toContain("Votre clé de récupération");
    await presser("Je l'ai notée");
    saisir(LG, "cd34");
    await presser("Terminer");
    expect(C.terminerInscription).toHaveBeenCalledWith(false);
    expect(texte()).toContain("Compte créé.");
    expect(texte()).toContain("redemandera votre passkey");
  });

  it("deuxième confirmation quand le gestionnaire annonce PRF sans le rendre", async () => {
    C.creerPasskey.mockResolvedValue("second");
    C.deuxiemeGeste.mockResolvedValue(true);
    await jusquALaCle();
    expect(texte()).toContain("Une deuxième confirmation est nécessaire pour chiffrer vos données.");
    await presser("Confirmer");
    expect(C.deuxiemeGeste).toHaveBeenCalled();
    expect(texte()).toContain("Votre clé de récupération");
  });

  it("feuille de passkey annulée : aucun message, on reste sur l'écran 1", async () => {
    C.creerPasskey.mockRejectedValue(new Error("annule"));
    await jusquALaCle();
    expect(document.querySelector("[role=alert], .banner")).toBeNull();
    expect(bouton("Créer avec une passkey")).toBeTruthy();
  });

  it("étape échue à « Terminer » : la passkey est signalée ; sans l'API, l'écran dit de la supprimer", async () => {
    C.terminerInscription.mockRejectedValue(new CompteError(404, "not_found"));
    C.abandonnerInscription.mockResolvedValue(false);
    await jusquALaCle();
    await presser("Je l'ai notée");
    saisir(LG, "CD34");
    await presser("Terminer");
    expect(C.abandonnerInscription).toHaveBeenCalled();
    expect(texte()).toContain("La vérification a expiré. Recommencez.");
    expect(texte()).toContain("Vous pouvez supprimer la passkey « Lea » de votre gestionnaire.");
    await presser("Recommencer");
    expect(C.preparerInscription).toHaveBeenCalledTimes(2);
  });

  it("page quittée après la création de la passkey : le gestionnaire est prié de l'oublier", async () => {
    await jusquALaCle();
    demonter();
    await attendre();
    expect(C.abandonnerInscription).toHaveBeenCalled();
  });

  it("navigateur sans passkeys : message de la conception §9, aucune cérémonie", async () => {
    C.passkeysDisponibles.mockReturnValue(false);
    await monter(Inscription);
    expect(texte()).toContain("Ce navigateur ne gère pas les passkeys. Tout Shhgone marche sans compte");
    expect(C.preparerInscription).not.toHaveBeenCalled();
  });
});

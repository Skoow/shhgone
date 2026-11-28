// @vitest-environment happy-dom
// Inscription par passkey (/compte/inscription ; conception du compte par passkey §3.1) : pseudo
// vérifié pendant la saisie, « Créer avec une passkey » (cérémonie chargée d'avance : le clic
// n'attend aucune requête), deuxième confirmation si besoin, clé de récupération (« Copier »,
// « Télécharger (.txt) », « Je l'ai notée »), un groupe à retaper, « Terminer ». Annuler la feuille
// n'affiche rien. Le module de compte est remplacé par un double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { appareil, noterCle, attendre, bouton, champ, demonter, erreurDe, monter, presser, saisir, PREUVE } from "./pages.test-helper";
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
  passkeyCreee: vi.fn(),
  preparerAjout: vi.fn(),
  ajouterPasskey: vi.fn(),
  deuxiemeGesteAjout: vi.fn(),
  parcoursRetenu: vi.fn(),
}));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
vi.mock("./preuve", () => ({ obtenirPreuve: async () => PREUVE }));
const { CompteError, account } = await import("../../account/session.svelte");
const { default: Inscription } = await import("./Inscription.svelte");
const { onAnnounce } = await import("../../ui/announce");

beforeEach(() => {
  setLang("fr");
  appareil("telephone"); // téléphone : parcours inchangé ; ordinateur : tests « sur ordinateur » plus bas
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
  C.passkeyCreee.mockReturnValue("ici");
  C.preparerAjout.mockResolvedValue("pret");
  C.ajouterPasskey.mockResolvedValue("ajoutee");
  C.parcoursRetenu.mockResolvedValue(null);
});
afterEach(() => {
  demonter();
  account.cleLocale = false;
});

async function jusquALaCle(nom = "Créer avec une passkey") {
  await monter(Inscription);
  saisir("Pseudo", "Lea");
  await presser(nom);
}

describe("inscription par passkey", () => {
  it("écran 1 : textes de la conception ; cérémonie chargée à l'ouverture avec la preuve anti-robot", async () => {
    await monter(Inscription);
    expect(texte()).toContain("Créer un compte");
    expect(texte()).toContain("Sans e-mail ni mot de passe. Votre téléphone ou votre ordinateur vous reconnaît.");
    expect(texte()).toContain("En créant un compte, vous confirmez avoir au moins 15");
    expect(texte()).toContain("J'ai déjà un compte");
    // Même forme que les autres chemins de « Se connecter » : séparateur « ou », bouton secondaire avec icône.
    const deja = document.querySelector<HTMLAnchorElement>("a.autre[data-have]")!;
    expect(deja.textContent!.trim()).toBe("J'ai déjà un compte");
    expect(deja.getAttribute("href")).toMatch(/\/compte\/connexion$/);
    expect(deja.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(document.querySelector(".ou")).toBeTruthy();
    expect(C.preparerInscription).toHaveBeenCalledWith(PREUVE);
    expect(champ("Pseudo")).toBeTruthy();
    expect(bouton("Créer avec une passkey").disabled).toBe(false);
    expect(texte()).not.toMatch(/e-mail\b.*Adresse|Mot de passe/);
  });

  it("pseudo vérifié pendant la saisie : « Disponible » / « Déjà pris » ; pris : refus avant la feuille", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const etat = () => document.querySelector("[data-field-status]")?.getAttribute("data-field-status") ?? null;
    try {
      await monter(Inscription);
      expect(etat()).toBeNull();
      saisir("Pseudo", "Lea");
      // Anti-rebond : rond qui tourne, aucune requête avant 500 ms.
      expect(etat()).toBe("verif");
      expect(C.pseudoLibre).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      await attendre();
      expect(C.pseudoLibre).toHaveBeenCalledTimes(1);
      // Disponible : coche dans le champ, texte pour les lecteurs d'écran seulement.
      expect(etat()).toBe("ok");
      expect(document.querySelector("[data-dispo]")!.textContent).toBe("Disponible");
      expect(document.querySelector("[data-dispo]")!.classList.contains("sr-only")).toBe(true);
      expect(document.querySelector("[data-dispo]")!.getAttribute("role")).toBe("status");
      expect(champ("Pseudo").getAttribute("aria-invalid")).toBeNull();
      C.pseudoLibre.mockResolvedValue(false);
      saisir("Pseudo", "Zoe");
      await vi.advanceTimersByTimeAsync(600);
      await attendre();
      // Pris : croix dans le champ, raison visible et reliée au champ.
      expect(etat()).toBe("ko");
      expect(document.querySelector("[data-dispo]")!.textContent).toBe("");
      expect(erreurDe("Pseudo")).toBe("Déjà pris");
      await presser("Créer avec une passkey");
      expect(C.creerPasskey).not.toHaveBeenCalled();
      expect(erreurDe("Pseudo")).toBe("Déjà pris");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pseudo invalide : croix dans le champ, raison visible, aucune requête de disponibilité", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      C.verifierSaisie.mockResolvedValue({ pseudo: "pseudo_caracteres" });
      await monter(Inscription);
      saisir("Pseudo", "Léa !");
      await vi.advanceTimersByTimeAsync(600);
      await attendre();
      expect(document.querySelector("[data-field-status]")!.getAttribute("data-field-status")).toBe("ko");
      expect(erreurDe("Pseudo")).not.toBe("");
      expect(C.pseudoLibre).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("le clic appelle creerPasskey sans autre requête ; clé, vérification d'un groupe, « Terminer »", async () => {
    await jusquALaCle();
    expect(C.creerPasskey).toHaveBeenCalledWith("Lea", "fr", "defaut");
    expect(C.preparerInscription).toHaveBeenCalledTimes(1);
    expect(texte()).toContain("Votre clé de récupération");
    expect(texte()).toContain("Nous ne pouvons pas la retrouver");
    expect(texte()).toContain("Le compte n'existe qu'après « Terminer ».");
    expect([...document.querySelectorAll("[data-cle] .g")].map((g) => g.textContent)).toEqual(CLE.split("-"));
    expect(bouton("Copier")).toBeTruthy();
    expect(bouton("Télécharger (.txt)")).toBeTruthy();
    // Demande du 25 novembre : « Je l'ai notée » grisé (aria-disabled, focalisable) tant que la clé
    // n'a été ni copiée ni téléchargée ; cliqué quand même : la raison (role=status), focus sur « Copier ».
    const note = bouton("Je l'ai notée");
    expect(note.getAttribute("aria-disabled")).toBe("true");
    expect(note.disabled).toBe(false);
    expect(document.querySelector("[data-rappel]")!.getAttribute("role")).toBe("status");
    await presser("Je l'ai notée");
    expect(document.querySelector("#compte-titre")!.textContent).toBe("Votre clé de récupération"); // on reste sur la clé
    expect(document.querySelector("[data-rappel]")!.textContent).toBe("Copiez ou téléchargez d'abord votre clé : sans elle, le compte peut être perdu.");
    expect(document.activeElement).toBe(bouton("Copier"));
    await presser("Télécharger (.txt)");
    expect(bouton("Je l'ai notée").getAttribute("aria-disabled")).toBeNull();
    expect(document.querySelector("[data-rappel]")!.textContent).toBe("");
    await presser("Je l'ai notée");
    expect(texte()).toContain("Vérification");
    saisir(LG, "cd35");
    await presser("Terminer");
    expect(erreurDe(LG)).toBe("Ce groupe ne correspond pas. Revoyez la clé.");
    expect(C.terminerInscription).not.toHaveBeenCalled();
    await presser("Revoir la clé");
    expect(texte()).toContain("Votre clé de récupération");
    expect(bouton("Je l'ai notée").getAttribute("aria-disabled")).toBeNull(); // déjà téléchargée : reste active
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
    await noterCle();
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

// Décision du 25 novembre (conception §18) : sur ordinateur, la passkey est demandée au téléphone
// (QR du navigateur) ; « Garder le compte sur cet ordinateur » en repli discret ; si la passkey est
// restée sur l'ordinateur, « Ajouter mon téléphone » est proposé à la fin.
describe("inscription sur ordinateur", () => {
  beforeEach(() => appareil("ordinateur"));

  async function terminer() {
    await noterCle();
    saisir(LG, "CD34");
    await presser("Terminer");
  }

  it("écran : « Créer avec mon téléphone » (parcours hybride), le QR expliqué, repli « Garder le compte sur cet ordinateur » (local)", async () => {
    await monter(Inscription);
    expect(texte()).toContain("Scannez-le avec l'appareil photo de votre téléphone. La passkey reste sur le téléphone et marche ensuite sur le téléphone et sur cet ordinateur (par QR).");
    expect(() => bouton("Créer avec une passkey")).toThrow();
    saisir("Pseudo", "Lea");
    await presser("Créer avec mon téléphone");
    expect(C.creerPasskey).toHaveBeenLastCalledWith("Lea", "fr", "hybride");
    expect(C.preparerInscription).toHaveBeenCalledTimes(1); // aucune requête de plus avant la cérémonie
  });

  it("« Garder le compte sur cet ordinateur » : parcours local ; à la fin, « Ajouter mon téléphone » (ajout standard par le QR)", async () => {
    await monter(Inscription);
    saisir("Pseudo", "Lea");
    await presser("Garder le compte sur cet ordinateur");
    expect(C.creerPasskey).toHaveBeenLastCalledWith("Lea", "fr", "local");
    await terminer();
    expect(texte()).toContain("Compte créé.");
    expect(C.preparerAjout).toHaveBeenCalledTimes(1);
    expect(texte()).toContain("Votre passkey est gardée sur cet ordinateur.");
    expect(bouton("Plus tard")).toBeTruthy();
    await presser("Ajouter mon téléphone");
    expect(C.ajouterPasskey).toHaveBeenCalledWith("Téléphone", "hybride");
    expect(texte()).toContain("Téléphone ajouté.");
    expect(bouton("Continuer")).toBeTruthy();
  });

  it("téléphone ajouté sans sortie PRF : message honnête (clé de récupération une fois sur le téléphone)", async () => {
    C.ajouterPasskey.mockResolvedValue("sans_prf");
    await jusquALaCle("Garder le compte sur cet ordinateur");
    await terminer();
    await presser("Ajouter mon téléphone");
    expect(texte()).toContain("Votre téléphone n'a pas transmis de quoi ouvrir vos données. Sur le téléphone, votre clé de récupération sera demandée une fois");
  });

  it("passkey créée sur le téléphone : aucune offre ; sans PRF, le message dit où la clé sert", async () => {
    C.passkeyCreee.mockReturnValue("telephone");
    C.terminerInscription.mockImplementation(async () => void (account.cleLocale = true));
    await jusquALaCle("Créer avec mon téléphone");
    await terminer();
    expect(C.preparerAjout).not.toHaveBeenCalled();
    expect(() => bouton("Ajouter mon téléphone")).toThrow();
    expect(texte()).toContain("Sur cet ordinateur, elles s'ouvrent grâce à une clé gardée ici. Sur le téléphone, votre clé de récupération sera demandée une fois.");
  });

  it("session plus récente à la fin : pas d'offre (elle reste dans Paramètres → Passkeys)", async () => {
    C.preparerAjout.mockResolvedValue("recent");
    await jusquALaCle("Garder le compte sur cet ordinateur");
    await terminer();
    expect(() => bouton("Ajouter mon téléphone")).toThrow();
    expect(bouton("Continuer")).toBeTruthy();
  });
});

// Décision du 26 novembre : anti-robot invisible ; un clic avant la fin de la préparation ne lance
// aucune cérémonie (Safari refuserait une feuille ouverte après une attente) et le dit.
describe("anti-robot de l'inscription", () => {
  it("clic avant la fin : « Vérification en cours… », aucune feuille ; prête : annoncé, le clic suivant crée", async () => {
    const annonces: string[] = [];
    const stop = onAnnounce((x) => annonces.push(x));
    let finir!: () => void;
    C.preparerInscription.mockReturnValue(new Promise<void>((r) => (finir = r)));
    C.inscriptionPrete.mockReturnValue(false);
    await monter(Inscription);
    // Rien de visible avant le clic : le bouton garde son texte.
    expect(bouton("Créer avec une passkey").disabled).toBe(false);
    expect(texte()).not.toContain("Vérification en cours");
    saisir("Pseudo", "Lea");
    await presser("Créer avec une passkey");
    expect(C.creerPasskey).not.toHaveBeenCalled();
    expect(bouton("Vérification en cours…").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector("[data-attente-preuve]")!.getAttribute("role")).toBe("status");
    C.inscriptionPrete.mockReturnValue(true);
    finir();
    await attendre();
    expect(texte()).not.toContain("Vérification en cours");
    await vi.waitFor(() => expect(annonces).toContain("Vérification terminée. Appuyez de nouveau sur le bouton."), { timeout: 5000 });
    stop();
    await presser("Créer avec une passkey");
    expect(C.creerPasskey).toHaveBeenCalledWith("Lea", "fr", "defaut");
  });
});

describe("inscription sur ordinateur : chemin retenu", () => {
  beforeEach(() => appareil("ordinateur"));

  it("« cet ordinateur » retenu : « Garder le compte sur cet ordinateur » d'abord, sans le QR ; le téléphone en second", async () => {
    C.parcoursRetenu.mockResolvedValue("local");
    await monter(Inscription);
    expect(texte()).not.toContain("Scannez-le avec l'appareil photo");
    expect(bouton("Garder le compte sur cet ordinateur").getAttribute("type")).toBe("submit");
    saisir("Pseudo", "Lea");
    await presser("Garder le compte sur cet ordinateur");
    expect(C.creerPasskey).toHaveBeenLastCalledWith("Lea", "fr", "local");
    demonter();
    C.parcoursRetenu.mockResolvedValue("local");
    await monter(Inscription);
    saisir("Pseudo", "Lea");
    await presser("Créer avec mon téléphone");
    expect(C.creerPasskey).toHaveBeenLastCalledWith("Lea", "fr", "hybride");
  });
});

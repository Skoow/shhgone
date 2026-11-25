// @vitest-environment happy-dom
// Paramètres du compte par passkey (/compte ; conception du compte par passkey §3.4 à §3.6) :
// sections (plus d'adresse, de mot de passe ni de double authentification), « Passkeys » (libellé,
// mois, « liée à cet appareil », « ouvre vos données », « cette passkey », ajout, renommage,
// retrait jamais de la dernière, confirmation par passkey si la session n'est plus récente),
// « Clé de récupération » (nouvelle clé), suppression par un geste de passkey. Le module de compte
// est remplacé par un double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { appareil, noterCle, bouton, demonter, monter, presser, saisir } from "./pages.test-helper";

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
  exporterDonnees: vi.fn(),
  partagesASupprimer: vi.fn(),
  supprimerTout: vi.fn(),
  seDeconnecter: vi.fn(),
}));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
// L'illustration de fin ne s'anime pas ici (happy-dom rejette les animations annulées au démontage).
vi.mock("../../ui/motion", async (orig) => ({ ...(await orig<object>()), reducedMotion: () => true }));
const { CompteError, account, REGLAGES_DEFAUT } = await import("../../account/session.svelte");
const { default: Parametres } = await import("./Parametres.svelte");
const ETAT = { creeLe: "2026-11-14", palier: "neuf", confirmeLe: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, salonsActifs: 1, banniId: null, banniJusqu: null, banniMotif: null };

beforeEach(() => {
  setLang("fr");
  appareil("telephone"); // téléphone : parcours inchangé ; ordinateur : tests « sur ordinateur » plus bas
  for (const f of Object.values(C)) f.mockReset();
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
  C.partagesASupprimer.mockResolvedValue(0);
  account.etat = "ouvert";
  account.profil = { pseudo: "Lea", photo: null, langue: "fr", reglages: { ...REGLAGES_DEFAUT }, pass: null };
});
afterEach(() => {
  demonter();
  account.etat = "absent";
  account.profil = undefined;
  account.cleLocale = account.recupere = false;
});

describe("paramètres", () => {
  it("sections : Passkeys et Clé de récupération ; plus d'adresse, de mot de passe ni de double authentification", async () => {
    await monter(Parametres);
    const titres = [...document.querySelectorAll("h2")].map((h) => h.textContent);
    expect(titres).toContain("Passkeys");
    expect(titres).toContain("Clé de récupération");
    expect(texte()).not.toMatch(/Adresse e-mail|Mot de passe|Double authentification/);
    expect(C.preparerReauth).toHaveBeenCalled(); // geste de confirmation sans requête avant
  });

  it("pas de choix de langue : la langue suit le navigateur (detectLang)", async () => {
    await monter(Parametres);
    const titres = [...document.querySelectorAll("h2")].map((h) => h.textContent);
    expect(titres).not.toContain("Langue");
    expect(document.querySelector("#sec-lang")).toBeNull();
    expect(texte()).not.toMatch(/Langue du site|English/);
  });

  it("passkeys : libellé, mois, « liée à cet appareil », « ouvre vos données », « cette passkey »", async () => {
    await monter(Parametres);
    expect(texte()).toContain("iPhoneCette passkey");
    expect(texte()).toContain("Ajoutée en novembre 2026 · ouvre vos données");
    expect(texte()).toContain("Passkey sans nom");
    expect(texte()).toContain("Ajoutée en novembre 2026 · liée à cet appareil");
  });

  it("une seule passkey : pas de « Retirer » ; toutes liées à un appareil : bandeau", async () => {
    C.listePasskeys.mockResolvedValue([PK({ synchronisable: false })]);
    await monter(Parametres);
    expect(() => bouton("Retirer iPhone")).toThrow();
    expect(texte()).toContain("Ajoutez d'abord une autre passkey");
    expect(texte()).toContain("Toutes vos passkeys sont liées à un seul appareil.");
  });

  it("ajouter : « Ajouter une passkey », nom, « Créer la passkey » ; session plus récente : confirmation par passkey d'abord", async () => {
    C.preparerAjout.mockResolvedValueOnce("recent");
    await monter(Parametres);
    await presser("Ajouter une passkey");
    expect(texte()).toContain("Pour continuer, confirmez avec une passkey.");
    await presser("Confirmer avec une passkey");
    expect(C.confirmerParPasskey).toHaveBeenCalled();
    saisir("Nom de la passkey", "YubiKey");
    await presser("Créer la passkey");
    expect(C.ajouterPasskey).toHaveBeenCalledWith("YubiKey", "defaut");
    expect(texte()).toContain("Passkey ajoutée.");
  });

  it("retirer : confirmation sur place ; session plus récente : geste de passkey puis retrait ; gestionnaire sans l'API : le dire", async () => {
    C.retirerPasskey.mockRejectedValueOnce(new CompteError(403, "recent")).mockResolvedValueOnce(false);
    await monter(Parametres);
    await presser("Retirer Passkey sans nom");
    expect(texte()).toContain("Retirer cette passkey ? Elle ne pourra plus ouvrir ce compte.");
    const oui = [...document.querySelectorAll("button")].filter((b) => b.textContent!.trim() === "Retirer").at(-1)!;
    oui.click();
    await new Promise((r) => setTimeout(r, 50));
    await presser("Confirmer avec une passkey");
    expect(C.retirerPasskey).toHaveBeenLastCalledWith("BAUG");
    expect(texte()).toContain("Passkey retirée. Supprimez-la aussi de votre gestionnaire.");
  });

  it("clé de récupération : nouvelle clé montrée, un groupe retapé, enregistrée ; bandeau après usage de la clé", async () => {
    account.recupere = true;
    await monter(Parametres);
    expect(texte()).toContain("Votre clé de récupération a servi.");
    await presser("Créer une nouvelle clé");
    expect([...document.querySelectorAll("[data-cle] .g")].map((g) => g.textContent)).toEqual(CLE.split("-"));
    expect(texte()).toContain("L'ancienne clé sert encore");
    await noterCle();
    saisir("Tapez le groupe n° 1 de la clé", "ab12");
    await presser("Enregistrer la nouvelle clé");
    expect(C.enregistrerNouvelleCle).toHaveBeenCalled();
    expect(texte()).toContain("Nouvelle clé enregistrée. L'ancienne ne sert plus.");
  });

  it("clé locale : dit dans « Passkeys » et sous « Se déconnecter »", async () => {
    account.cleLocale = true;
    await monter(Parametres);
    expect(texte()).toContain("vos données s'ouvrent grâce à une clé gardée ici");
    expect(texte()).toContain("Se déconnecter efface cette clé");
  });
});

describe("suppression du compte", () => {
  async function* fin() {
    yield { etape: "partages" as const, fait: 0, total: 0, echecs: 0 };
    yield { etape: "fini" as const, salonsFermes: 1, partagesDetruits: 0, partagesEchoues: 0 };
  }

  it("geste de passkey (session récente), puis suppression ; fin : supprimer la passkey du gestionnaire", async () => {
    C.supprimerTout.mockImplementation(() => fin());
    await monter(Parametres);
    await presser("Supprimer le compte");
    expect(texte()).toContain("Une confirmation par passkey vous sera demandée.");
    expect(texte()).not.toMatch(/Mot de passe|adresse bannie|service d'envoi des codes/);
    await presser("Supprimer définitivement");
    await presser("Supprimer");
    expect(C.confirmerParPasskey).toHaveBeenCalled();
    expect(C.supprimerTout).toHaveBeenCalledWith({ effacerAppareil: true });
    expect(texte()).toContain("Compte supprimé.");
    expect(texte()).toContain("Supprimez aussi la passkey « Lea » de votre gestionnaire");
  });

  it("geste annulé : rien n'est supprimé, aucun message", async () => {
    C.confirmerParPasskey.mockRejectedValue(new Error("annule"));
    await monter(Parametres);
    await presser("Supprimer le compte");
    await presser("Supprimer définitivement");
    await presser("Supprimer");
    expect(C.supprimerTout).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alert]")).toBeNull();
  });
});

// Décision du 25 novembre (conception §18) : « Ajouter mon téléphone » = l'ajout de passkey
// standard, demandé au téléphone par le QR du navigateur.
describe("passkeys sur ordinateur", () => {
  beforeEach(() => appareil("ordinateur"));

  it("« Ajouter mon téléphone » : nom proposé « Téléphone », QR expliqué, parcours hybride ; sans PRF : message honnête", async () => {
    C.ajouterPasskey.mockResolvedValue("sans_prf");
    await monter(Parametres);
    await presser("Ajouter mon téléphone");
    expect(texte()).toContain("Scannez-le avec l'appareil photo de votre téléphone, puis confirmez sur le téléphone.");
    await presser("Créer la passkey");
    expect(C.ajouterPasskey).toHaveBeenCalledWith("Téléphone", "hybride");
    expect(texte()).toContain("Téléphone ajouté.");
    expect(texte()).toContain("Votre téléphone n'a pas transmis de quoi ouvrir vos données.");
  });

  it("« Ajouter une passkey sur cet ordinateur » : parcours local, nom vide (nom d'appareil par défaut)", async () => {
    await monter(Parametres);
    await presser("Ajouter une passkey sur cet ordinateur");
    expect(texte()).not.toContain("Scannez-le");
    await presser("Créer la passkey");
    expect(C.ajouterPasskey).toHaveBeenCalledWith("", "local");
    expect(texte()).toContain("Passkey ajoutée.");
  });
});


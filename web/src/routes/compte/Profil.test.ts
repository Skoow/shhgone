// @vitest-environment happy-dom
// Profil (/compte/profil ; conception compte §21.5, §21.15.3) : photo (changer,
// retirer, ré-encodée sur l'appareil, 64 Ko au plus), pseudo unique (« Disponible », « Déjà pris »,
// une fois par 24 h), carte « Votre compte » (date, palier, « »), note de
// confidentialité exacte. Le module de compte est remplacé par un double.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { attendre, bouton, demonter, erreurDe, monter, presser, saisir } from "./pages.test-helper";
/** Texte de la page, espaces insécables comprises ramenées à une espace (les textes FR en ont). */
const texte = () => document.body.textContent!.replace(/\s+/g, " ");

const C = vi.hoisted(() => ({ etatCompte: vi.fn(), ecrireProfil: vi.fn(), pseudoLibre: vi.fn(), changerPseudo: vi.fn(), verifierSaisie: vi.fn() }));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
const AV = vi.hoisted(() => ({ reencoder: vi.fn() }));
vi.mock("../../ui/avatar", async (orig) => ({ ...(await orig<object>()), ...AV }));
const S = await import("../../account/session.svelte");
const { CompteError, account, REGLAGES_DEFAUT } = S;
const { default: Profil } = await import("./Profil.svelte");

const ETAT = { creeLe: "2026-11-14", palier: "neuf", confirmeLe: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, salonsActifs: 0, banniId: null, banniJusqu: null, banniMotif: null };
const PROFIL = { pseudo: "Lea", photo: null, langue: "fr", reglages: { ...REGLAGES_DEFAUT }, pass: null };

beforeEach(() => {
  setLang("fr");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
  for (const f of [...Object.values(C), ...Object.values(AV)]) f.mockReset();
  C.etatCompte.mockResolvedValue(ETAT);
  C.ecrireProfil.mockImplementation(async (p: object) => void (account.profil = { ...account.profil!, ...p }));
  C.pseudoLibre.mockResolvedValue(true);
  C.verifierSaisie.mockResolvedValue({});
  account.etat = "ouvert";
  account.profil = { ...PROFIL };
});
afterEach(() => {
  demonter();
  vi.useRealTimers();
  account.etat = "absent";
  account.profil = undefined;
});

async function apres400() {
  await vi.advanceTimersByTimeAsync(450);
  await attendre();
}

describe("Profil", () => {
  it("titre, avatar (initiale), pseudo actuel, carte « Votre compte » du palier neuf, note de confidentialité exacte, bouton Paramètres", async () => {
    await monter(Profil);
    expect(document.querySelector("h1")!.textContent).toBe("Profil");
    expect((document.querySelector('input[autocomplete="nickname"]') as HTMLInputElement).value).toBe("Lea");
    const t = texte();
    expect(t).toContain("Votre compte");
    expect(t).toContain("Membre depuis le 14 novembre 2026");
    expect(t).toContain("Récent : 1 salon à la fois, 4 places, 24 h. Dès le 21 novembre : 3 salons, 10 places.");
    expect(t).toContain("Gratuit");
    expect(t).toContain(
      "Votre pseudo, votre photo et votre abonnement sont chiffrés sur vos appareils : le service ne peut pas les lire.",
    );
    const liens = [...document.querySelectorAll("a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")]);
    expect(liens).toContainEqual(["En savoir plus", "/securite"]);
    expect(liens).toContainEqual(["Voir les offres", "/offres"]);
    expect(bouton("Paramètres")).toBeTruthy();
    // Indice du pseudo gardé.
    expect(t).toContain("Vu par les membres de vos salons, unique parmi les comptes Shhgone. 3 changements par an au plus.");
  });

  it("palier confirmé ; compte banni : bandeau avec la date et le motif", async () => {
    C.etatCompte.mockResolvedValue({ ...ETAT, palier: "confirme", confirmeLe: null, limites: { salons: 3, places: 10, heures: 24 }, banniJusqu: "2029-11-14", banniMotif: 6 });
    await monter(Profil);
    expect(texte()).toContain("Confirmé : 3 salons à la fois, 10 places.");
    expect(texte()).toContain("Ce compte ne peut plus créer de salon jusqu'au 14 novembre 2029. Motif : Harcèlement.");
  });

  it("photo : changée (ré-encodée sur l'appareil) puis retirée, écrite dans le coffre de profil", async () => {
    const octets = new Uint8Array(40_000).fill(7);
    AV.reencoder.mockResolvedValue(octets);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x/p");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await monter(Profil);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "moi.jpg", { type: "image/jpeg" })], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await attendre();
    expect(C.ecrireProfil).toHaveBeenCalledWith({ photo: octets });
    expect(texte()).not.toContain("moi.jpg"); // le nom du fichier n'est jamais gardé ni montré
    await presser("Retirer");
    expect(C.ecrireProfil).toHaveBeenLastCalledWith({ photo: null });
  });

  it("photo illisible ou trop lourde : message, rien d'écrit", async () => {
    AV.reencoder.mockRejectedValue(new Error("photo_illisible"));
    await monter(Profil);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "x.png")], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await attendre();
    expect(texte()).toContain("Cette image ne s'ouvre pas. Essayez une autre photo.");
    expect(C.ecrireProfil).not.toHaveBeenCalled();
  });

  it("pseudo libre : « Disponible » puis enregistré", async () => {
    await monter(Profil);
    saisir("Pseudo", "LeaB");
    await apres400();
    expect(C.pseudoLibre).toHaveBeenCalledWith("LeaB");
    expect(texte()).toContain("Disponible");
    await presser("Enregistrer");
    expect(C.changerPseudo).toHaveBeenCalledWith("LeaB");
    expect(texte()).toContain("Pseudo enregistré.");
  });

  it("pseudo pris : « Déjà pris »", async () => {
    C.pseudoLibre.mockResolvedValue(false);
    await monter(Profil);
    saisir("Pseudo", "Max");
    await apres400();
    expect(erreurDe("Pseudo")).toBe("Déjà pris");
  });

  it("3 fois par an : « Vous pourrez changer de pseudo le … » ; pris entre-temps : « Déjà pris », saisie gardée", async () => {
    await monter(Profil);
    const champ = () => document.querySelector('input[autocomplete="nickname"]') as HTMLInputElement;
    saisir("Pseudo", "Maxime");
    await apres400();
    C.changerPseudo.mockRejectedValueOnce(new CompteError(429, "limit", { retryAfterS: 122 * 86400 }));
    await presser("Enregistrer");
    // + 122 jours = 16 mars 2027.
    expect(erreurDe("Pseudo")).toBe("Vous pourrez changer de pseudo le 16 mars 2027 (3\u202ffois par an au plus).");
    C.changerPseudo.mockRejectedValueOnce(new CompteError(409, "pseudo_pris"));
    await presser("Enregistrer");
    expect(erreurDe("Pseudo")).toBe("Déjà pris");
    expect(champ().value).toBe("Maxime");
  });

  it("pseudo inchangé : aucune vérification ni enregistrement", async () => {
    await monter(Profil);
    await apres400();
    expect(C.pseudoLibre).not.toHaveBeenCalled();
    await presser("Enregistrer");
    expect(C.changerPseudo).not.toHaveBeenCalled();
  });
});

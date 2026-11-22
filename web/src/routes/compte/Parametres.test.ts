// @vitest-environment happy-dom
// Paramètres (/compte ; conception compte §21.15.4, demandes du propriétaire du 14 novembre ; plan,
// lot 13) : sections dans l'ordre ; pendant l'attente d'après une récupération, adresse et
// suppression désactivées avec la raison ; demande de retrait de la double authentification :
// bandeau et « Annuler la demande » ; réglages de confidentialité écrits dans le coffre de profil ;
// changer le mot de passe déconnecte toujours les autres appareils (aucune case) ; export.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n/i18n.svelte";
import { attendre, bouton, champ, demonter, erreurDe, monter, presser, saisir } from "./pages.test-helper";
/** Texte de la page, espaces insécables comprises ramenées à une espace (les textes FR en ont). */
const texte = () => document.body.textContent!.replace(/\s+/g, " ");

const C = vi.hoisted(() => ({
  etatCompte: vi.fn(),
  ecrireProfil: vi.fn(),
  adresseConnue: vi.fn(),
  confirmerIdentite: vi.fn(),
  changerMotDePasse: vi.fn(),
  changementAdresse: { debut: vi.fn(), fin: vi.fn() },
  renvoyerCode: vi.fn(),
  totpCommencer: vi.fn(),
  totpActiver: vi.fn(),
  totpRetirer: vi.fn(),
  totpAnnulerRetrait: vi.fn(),
  appareils: vi.fn(),
  deconnecterAppareil: vi.fn(),
  deconnecterAutres: vi.fn(),
  exporterDonnees: vi.fn(),
  arreterResterConnecte: vi.fn(),
  seDeconnecter: vi.fn(),
  verifierSaisie: vi.fn(),
  partagesASupprimer: vi.fn(),
  supprimerTout: vi.fn(),
}));
vi.mock("../../account/session.svelte", async (orig) => ({ ...(await orig<object>()), ...C }));
const H = vi.hoisted(() => ({ clearHistory: vi.fn() }));
vi.mock("../../history/live.svelte", async (orig) => ({ ...(await orig<object>()), ...H }));
const D = vi.hoisted(() => ({ clearDownloads: vi.fn(), setDownloadsEnabled: vi.fn(), loadDownloads: vi.fn() }));
vi.mock("../../downloads/live.svelte", async (orig) => ({ ...(await orig<object>()), ...D }));
const S = await import("../../account/session.svelte");
const { CompteError, account, REGLAGES_DEFAUT } = S;
const { default: Parametres } = await import("./Parametres.svelte");

const ETAT = { creeLe: "2026-11-14", palier: "neuf", confirmeLe: "2026-11-21", limites: { salons: 1, places: 4, heures: 24 }, salonsActifs: 1, totp: false, recupJusqu: null, retraitTotpLe: null, banniJusqu: null, banniMotif: null };
const PROFIL = { pseudo: "Léa", photo: null, langue: "fr", reglages: { ...REGLAGES_DEFAUT }, pass: null };
const MDP = "correct horse battery";

beforeEach(() => {
  setLang("fr");
  for (const f of [...Object.values(C), ...Object.values(H), ...Object.values(D)]) if (typeof f === "function") f.mockReset();
  C.changementAdresse.debut.mockReset();
  C.changementAdresse.fin.mockReset();
  C.etatCompte.mockResolvedValue(ETAT);
  C.adresseConnue.mockReturnValue(true);
  C.appareils.mockResolvedValue([
    { sid: "s1", ajoutee: "2026-11", nom: "Firefox · ordinateur", courante: true, persistante: false },
    { sid: "s2", ajoutee: "2026-10", nom: "Safari · téléphone", courante: false, persistante: true },
  ]);
  C.verifierSaisie.mockResolvedValue({});
  C.ecrireProfil.mockImplementation(async (p: object) => void (account.profil = { ...account.profil!, ...p }));
  C.exporterDonnees.mockResolvedValue('{"v":1}');
  C.partagesASupprimer.mockResolvedValue(2);
  H.clearHistory.mockResolvedValue(undefined);
  D.clearDownloads.mockResolvedValue(undefined);
  D.loadDownloads.mockResolvedValue(undefined);
  D.setDownloadsEnabled.mockResolvedValue(undefined);
  account.etat = "ouvert";
  account.profil = { ...PROFIL, reglages: { ...REGLAGES_DEFAUT } };
  account.persistante = false;
});
afterEach(() => {
  demonter();
  account.etat = "absent";
  account.profil = undefined;
});

const titres = () => [...document.querySelectorAll("h2")].map((h) => h.textContent!.trim());
const sw = (nom: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((b) => b.textContent!.includes(nom))!;

describe("Paramètres", () => {
  it("sections dans l'ordre de §21.15.4, puis « Se déconnecter » et « Supprimer le compte »", async () => {
    await monter(Parametres);
    expect(document.querySelector("h1")!.textContent).toBe("Paramètres");
    expect(titres()).toEqual(["Profil", "Adresse e-mail", "Mot de passe", "Double authentification", "Appareils", "Confidentialité", "Abonnement", "Langue", "Récupération", "Vos données"]);
    const noms = [...document.querySelectorAll("button")].map((b) => b.textContent!.trim());
    expect(noms.indexOf("Se déconnecter")).toBeGreaterThan(noms.indexOf("Exporter mes données"));
    expect(noms.indexOf("Supprimer le compte")).toBeGreaterThan(noms.indexOf("Se déconnecter"));
    // Ancienneté et limites (demande du propriétaire), lien vers le profil.
    expect(texte()).toContain("Récent : 1 salon à la fois, 4 places, 24 h. Dès le 21 novembre : 3 salons, 10 places.");
    expect(document.querySelector('a[href="/compte/profil"]')).not.toBeNull();
    expect(texte()).toContain("Sans connexion pendant 13 mois, ce compte est effacé. Nous ne pouvons pas vous prévenir : nous n'avons pas votre adresse.");
  });

  it("après une récupération par e-mail : « Changer » l'adresse et « Supprimer le compte » désactivés, avec la raison", async () => {
    C.etatCompte.mockResolvedValue({ ...ETAT, recupJusqu: "2026-11-21" });
    await monter(Parametres);
    const raison = "Par sécurité, après une récupération par e-mail, l'adresse ne peut pas être changée ni le compte supprimé avant le 21 novembre.";
    expect(texte()).toContain(raison);
    const changer = document.querySelector<HTMLButtonElement>('section[aria-labelledby="sec-email"] button')!;
    expect(changer.disabled).toBe(true);
    const id = changer.getAttribute("aria-describedby")!;
    expect(document.getElementById(id)!.textContent).toContain(raison);
    expect(bouton("Supprimer le compte").disabled).toBe(true);
    await presser("Supprimer le compte");
    expect(texte()).not.toContain("Ce qui sera supprimé");
  });

  it("demande de retrait de la double authentification : bandeau et « Annuler la demande »", async () => {
    C.etatCompte.mockResolvedValue({ ...ETAT, totp: true, retraitTotpLe: "2026-11-21" });
    await monter(Parametres);
    expect(texte()).toContain("Une demande de retrait de la double authentification est en cours. Ce n'est pas vous ?");
    C.etatCompte.mockResolvedValue({ ...ETAT, totp: true });
    await presser("Annuler la demande");
    expect(C.totpAnnulerRetrait).toHaveBeenCalledTimes(1);
    expect(texte()).not.toContain("Une demande de retrait de la double authentification est en cours.");
  });

  it("double authentification : texte des 7 jours ; activation après confirmation du mot de passe si la session n'est plus récente", async () => {
    await monter(Parametres);
    expect(texte()).toContain("Si vous perdez ce téléphone, la récupération par e-mail prendra 7 jours.");
    C.totpCommencer.mockRejectedValueOnce(new CompteError(403, "recent"));
    C.totpCommencer.mockResolvedValueOnce({ secret: "JBSWY3DPEHPK3PXP", lien: "otpauth://totp/Shhgone?secret=JBSWY3DPEHPK3PXP&issuer=Shhgone&algorithm=SHA1&digits=6&period=30" });
    sw("Double authentification").click();
    await attendre();
    expect(texte()).toContain("Pour continuer, confirmez votre mot de passe.");
    saisir("Mot de passe actuel", MDP);
    await presser("Continuer");
    expect(C.confirmerIdentite).toHaveBeenCalledWith(MDP, "", undefined);
    expect(texte()).toContain("JBSW Y3DP EHPK 3PXP");
    saisir("Premier code de l'application", "654321");
    C.etatCompte.mockResolvedValue({ ...ETAT, totp: true });
    await presser("Activer");
    expect(C.totpActiver).toHaveBeenCalledWith("654321");
    expect(texte()).toContain("Double authentification activée.");
  });

  it("mot de passe : une phrase dit que les autres appareils seront déconnectés ; aucune case pour l'éviter ; identité confirmée puis changement", async () => {
    await monter(Parametres);
    await presser("Changer le mot de passe");
    expect(texte()).toContain("Vos autres appareils seront déconnectés.");
    expect([...document.querySelectorAll("label")].map((l) => l.textContent!.trim())).not.toContain("Déconnecter mes autres appareils");
    expect(document.querySelectorAll('section[aria-labelledby="sec-mdp"] input[type="checkbox"]')).toHaveLength(0);
    expect(champ("Mot de passe actuel").getAttribute("autocomplete")).toBe("current-password");
    expect(champ("Nouveau mot de passe").getAttribute("autocomplete")).toBe("new-password");
    saisir("Mot de passe actuel", MDP);
    saisir("Nouveau mot de passe", "Nouveau-mot-de-passe-7");
    await presser("Enregistrer le mot de passe");
    expect(C.confirmerIdentite).toHaveBeenCalledWith(MDP, "", undefined);
    expect(C.changerMotDePasse).toHaveBeenCalledWith("Nouveau-mot-de-passe-7");
    expect(texte()).toContain("Mot de passe changé. Vos autres appareils ont été déconnectés.");
    expect(document.querySelectorAll('section[aria-labelledby="sec-mdp"] input')).toHaveLength(0); // rien ne reste dans la page
  });

  it("mot de passe actuel faux : « Adresse ou mot de passe incorrect. » ; adresse inconnue de la page (rechargement) : demandée", async () => {
    C.adresseConnue.mockReturnValue(false);
    C.confirmerIdentite.mockRejectedValueOnce(new CompteError(403, "identifiants"));
    await monter(Parametres);
    await presser("Changer le mot de passe");
    saisir("Adresse e-mail", "lea@exemple.fr");
    saisir("Mot de passe actuel", "faux");
    saisir("Nouveau mot de passe", "Nouveau-mot-de-passe-7");
    await presser("Enregistrer le mot de passe");
    expect(C.confirmerIdentite).toHaveBeenCalledWith("faux", "", "lea@exemple.fr");
    expect(texte()).toContain("Adresse ou mot de passe incorrect.");
    expect(C.changerMotDePasse).not.toHaveBeenCalled();
  });

  it("adresse e-mail : actuelle, nouvelle, mot de passe ; code reçu à la nouvelle ; « Nous n'écrivons jamais à l'ancienne adresse. »", async () => {
    await monter(Parametres);
    await presser("Changer l'adresse e-mail");
    expect(texte()).toContain("C'est votre seul moyen de récupérer le compte. Nous n'écrivons jamais à l'ancienne adresse.");
    saisir("Adresse e-mail actuelle", "lea@exemple.fr");
    saisir("Nouvelle adresse e-mail", "lea@autre.fr");
    saisir("Mot de passe", MDP);
    await presser("Recevoir un code");
    expect(C.confirmerIdentite).toHaveBeenCalledWith(MDP, "", "lea@exemple.fr");
    expect(C.changementAdresse.debut).toHaveBeenCalledWith("lea@autre.fr", "fr");
    saisir("Code reçu par e-mail", "123456");
    await presser("Changer l'adresse");
    expect(C.changementAdresse.fin).toHaveBeenCalledWith("123456", MDP, "");
    expect(texte()).toContain("Adresse changée.");
  });

  it("appareils : nom, mois d'ajout, « Cet appareil », « Reste connecté » ; déconnecter un appareil ou tous les autres", async () => {
    await monter(Parametres);
    const t = texte();
    expect(t).toContain("Firefox · ordinateur");
    expect(t).toContain("Cet appareil");
    expect(t).toContain("Safari · téléphone");
    expect(t).toContain("Ajouté en octobre 2026");
    expect(t).toContain("Reste connecté");
    await presser("Déconnecter Safari · téléphone");
    expect(C.deconnecterAppareil).toHaveBeenCalledWith("s2");
    await presser("Déconnecter tous les autres appareils");
    expect(C.deconnecterAutres).toHaveBeenCalled();
  });

  it("confidentialité : chaque réglage du compte est écrit dans le coffre de profil ; téléchargements sur l'appareil", async () => {
    await monter(Parametres);
    sw("Garder les liens que j'ouvre dans mon accueil").click();
    await attendre();
    expect(C.ecrireProfil).toHaveBeenLastCalledWith({ reglages: { ...REGLAGES_DEFAUT, garderRecus: false } });
    sw("Garder les salons que je rejoins").click();
    await attendre();
    expect(C.ecrireProfil).toHaveBeenLastCalledWith({ reglages: { ...REGLAGES_DEFAUT, garderRecus: false, garderSalons: false } });
    sw("Proposer mon pseudo et ma photo dans les salons").click();
    await attendre();
    expect(C.ecrireProfil).toHaveBeenLastCalledWith({ reglages: { proposerProfil: false, garderRecus: false, garderSalons: false } });
    sw("Historique des téléchargements sur cet appareil").click();
    await attendre();
    expect(D.setDownloadsEnabled).toHaveBeenCalledWith(true); // désactivé par défaut (22 novembre) : le geste l'active
    // « Rester connecté » : seulement coupé d'ici (le serveur fixe la durée de la session à la connexion).
    expect(sw("Rester connecté sur cet appareil").getAttribute("aria-disabled")).toBe("true");
  });

  it("vos données : export fait sur l'appareil (fichier JSON), effacement de l'appareil confirmé sur place", async () => {
    const urls: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => (urls.push(b as Blob), "blob:x/e"));
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await monter(Parametres);
    expect(texte()).toContain("Votre adresse n'y figure pas : nous ne la gardons pas en clair.");
    await presser("Exporter mes données");
    expect(C.exporterDonnees).toHaveBeenCalled();
    expect(urls[0]!.type).toBe("application/json");
    expect(await urls[0]!.text()).toBe('{"v":1}');
    await presser("Effacer les données de cet appareil");
    await presser("Effacer");
    expect(H.clearHistory).toHaveBeenCalled();
    expect(D.clearDownloads).toHaveBeenCalled();
  });

  it("langue : choisie ici et gardée dans le coffre de profil", async () => {
    await monter(Parametres);
    const en = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.labels?.[0]?.textContent?.includes("English"))!;
    en.click();
    await attendre();
    expect(C.ecrireProfil).toHaveBeenCalledWith({ langue: "en" });
    expect(document.querySelector("h1")!.textContent).toBe("Settings");
    setLang("fr");
  });

  it("se déconnecter : retour à la connexion", async () => {
    await monter(Parametres);
    await presser("Se déconnecter");
    expect(C.seDeconnecter).toHaveBeenCalled();
    expect(erreurDe).toBeTruthy();
  });
});

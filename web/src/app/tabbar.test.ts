import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { currentTab, tabBarVisible, tabBarUseful, tabPath, tabsFor } from "./tabbar";

const base = { supported: true, sending: false, composing: false };

describe("barre d'onglets (téléphone)", () => {
  it("règle : visible dès deux onglets utiles", () => {
    expect(tabBarUseful([{ id: "send", soon: false }, { id: "chat", soon: true }])).toBe(false);
    expect(tabBarUseful([{ id: "send", soon: false }, { id: "downloads", soon: false }])).toBe(true);
    expect(tabBarUseful(tabsFor(true))).toBe(true);
  });
  it("sans compte : aucun onglet, donc aucune barre, sur aucun écran", () => {
    expect(tabsFor(false)).toEqual([]);
    for (const route of ["home", "envoyer", "telechargements", "securite", "confidentialite", "notfound"] as const) expect(tabBarVisible({ ...base, route })).toBe(false);
  });
  it("connecté : visible sur l'accueil, la page d'envoi, Téléchargements, Compte, Sécurité, Confidentialité et la 404", () => {
    for (const route of ["home", "envoyer", "telechargements", "compte", "securite", "confidentialite", "notfound"] as const) expect(tabBarVisible({ ...base, route, connected: true })).toBe(true);
  });
  it("masquée chez le destinataire (ouverture, contenu) et sur la gestion", () => {
    expect(tabBarVisible({ ...base, route: "open", connected: true })).toBe(false);
    expect(tabBarVisible({ ...base, route: "manage", connected: true })).toBe(false);
  });
  it("masquée pendant un envoi, sur « Lien prêt », pendant la composition, sans prise en charge", () => {
    expect(tabBarVisible({ ...base, route: "home", connected: true, sending: true })).toBe(false);
    expect(tabBarVisible({ ...base, route: "home", connected: true, composing: true })).toBe(false);
    expect(tabBarVisible({ ...base, route: "home", connected: true, supported: false })).toBe(false);
  });

  // 25 novembre : historique des liens retiré, Profil et Paramètres réunis (page Compte).
  it("connecté : trois onglets (Nouveau, Téléchargements, Compte), chemins et onglet courant", () => {
    expect(tabsFor(true).map((t) => `${t.id}${t.soon ? "*" : ""}`)).toEqual(["send", "downloads", "profile"]);
    expect(tabsFor(true).map((t) => tabPath(t.id))).toEqual(["/envoyer", "/telechargements", "/compte"]);
    expect(currentTab("home")).toBe("send");
    expect(currentTab("envoyer")).toBe("send");
    expect(currentTab("telechargements")).toBe("downloads");
    expect(currentTab("compte")).toBe("profile");
    expect(currentTab("securite")).toBeNull();
    expect(currentTab("notfound")).toBeNull();
  });

  // Audit du 25 novembre : libellés jamais tronqués sur 320 px (10 caractères au plus).
  it("libellés courts, jamais tronqués (10 caractères au plus)", () => {
    for (const d of [fr, en] as Record<string, string>[]) for (const t of tabsFor(true)) expect(d[`tabs.${t.id}`]!.length).toBeLessThanOrEqual(10);
    expect(fr["tabs.send"]).toBe("Nouveau");
    expect(fr["tabs.downloads"]).toBe("Fichiers");
    expect(fr["tabs.profile"]).toBe("Compte");
  });
});

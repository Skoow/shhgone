import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { currentTab, tabBarVisible, tabBarUseful, tabPath, tabsFor, TABS } from "./tabbar";

const base = { supported: true, sending: false, composing: false };

describe("barre d'onglets (téléphone)", () => {
  it("règle : visible dès deux onglets utiles ; Mes partages actif, donc visible", () => {
    expect(tabBarUseful([{ id: "send", soon: false }, { id: "shares", soon: true }, { id: "chat", soon: true }])).toBe(false);
    expect(tabBarUseful([{ id: "send", soon: false }, { id: "shares", soon: false }, { id: "chat", soon: true }])).toBe(true);
    expect(tabBarUseful(tabsFor(true))).toBe(true);
  });
  // Sans compte, plus de barre d'onglets (menu ☰).
  it("sans compte : un seul onglet (Mes partages), donc aucune barre, sur aucun écran", () => {
    expect(TABS.map((t) => t.id)).toEqual(["shares"]);
    expect(tabBarUseful(TABS)).toBe(false);
    for (const route of ["home", "envois", "telechargements", "securite", "confidentialite", "notfound"] as const) expect(tabBarVisible({ ...base, route })).toBe(false);
  });
  it("connecté : visible sur l'accueil, Mes partages, Téléchargements, Sécurité, Confidentialité et la 404", () => {
    for (const route of ["home", "envois", "telechargements", "securite", "confidentialite", "notfound"] as const) expect(tabBarVisible({ ...base, route, connected: true })).toBe(true);
  });
  it("masquée chez le destinataire (ouverture, contenu) et sur la gestion", () => {
    expect(tabBarVisible({ ...base, route: "open" })).toBe(false);
    expect(tabBarVisible({ ...base, route: "manage" })).toBe(false);
  });
  it("masquée pendant un envoi, sur « Lien prêt », pendant la composition, sans prise en charge", () => {
    expect(tabBarVisible({ ...base, route: "home", sending: true })).toBe(false);
    expect(tabBarVisible({ ...base, route: "home", composing: true })).toBe(false);
    expect(tabBarVisible({ ...base, route: "home", supported: false })).toBe(false);
  });
  it("onglet courant (sans compte, sert encore au menu et aux tests)", () => {
    expect(currentTab("telechargements")).toBe("downloads");
    expect(currentTab("home")).toBe("send");
    expect(currentTab("envois")).toBe("shares");
    expect(currentTab("securite")).toBeNull();
    expect(currentTab("confidentialite")).toBeNull();
    expect(currentTab("notfound")).toBeNull();
  });

  // Conception compte §21.15.1 : connecté, quatre onglets Accueil, Envoyer,
  // Téléchargements, Profil ; sans compte, un seul onglet (aucune barre).
  it("connecté : quatre onglets (Accueil, Envoyer, Téléchargements, Profil), chemins et onglet courant ; sans compte inchangé", () => {
    expect(tabsFor(true).map((t) => `${t.id}${t.soon ? "*" : ""}`)).toEqual(["home", "send", "downloads", "profile"]);
    expect(tabsFor(false)).toBe(TABS);
    expect(["home", "send", "downloads", "profile"].map((id) => tabPath(id as never, true))).toEqual(["/", "/envoyer", "/telechargements", "/compte/profil"]);
    expect(["send", "shares", "downloads"].map((id) => tabPath(id as never, false))).toEqual(["/", "/envois", "/telechargements"]);
    expect(currentTab("home", true)).toBe("home");
    expect(currentTab("envoyer", true)).toBe("send");
    expect(currentTab("profil", true)).toBe("profile");
    expect(currentTab("compte", true)).toBe("profile");
    expect(currentTab("envois", true)).toBeNull();
    expect(currentTab("home")).toBe("send");
    expect(tabBarVisible({ ...base, route: "profil", connected: true })).toBe(true);
    expect(tabBarVisible({ ...base, route: "profil" })).toBe(false);
  });

  // Audit du 25 novembre : « Téléchargem… » tronqué sur téléphone. Quatre onglets sur 320 px :
  // 10 caractères au plus par libellé, en français comme en anglais.
  it("libellés courts, jamais tronqués (10 caractères au plus)", () => {
    for (const d of [fr, en] as Record<string, string>[]) for (const t of tabsFor(true)) expect(d[`tabs.${t.id}`]!.length).toBeLessThanOrEqual(10);
    expect(fr["tabs.downloads"]).toBe("Fichiers");
  });
});

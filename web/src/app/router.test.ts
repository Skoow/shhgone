// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { href, match, moveToLinkPage, navigate, otherEntry, router, setEntry, shownPath, suite } from "./router.svelte";

const KEY = "A".repeat(42) + "Q"; // 43 caractères base64url (forme seulement)

describe("match", () => {
  it("accueil et pages fixes", () => {
    expect(match("/")).toEqual({ name: "home" });
    expect(match("/securite")).toEqual({ name: "securite" });
    expect(match("/confidentialite")).toEqual({ name: "confidentialite" });
    // « Vérifier cette version » (spec §28.4) : page d'information bilingue, servie par son fichier.
    expect(match("/verifier")).toEqual({ name: "verifier" });
    expect(match("/verifier.html")).toEqual({ name: "verifier" });
    expect(match("/en/verifier", "", "/", false, false, false, true)).toEqual({ name: "verifier" });
    expect(otherEntry("/verifier")).toBe(true);
    expect(href("/verifier", "en", true)).toBe("/en/verifier");
    // Page d'envoi vide (retours DROP) : « Commencer » y mène ; un « # » n'y ouvre rien.
    expect(match("/envoyer")).toEqual({ name: "envoyer" });
    expect(match("/envoyer", `#${KEY}`)).toEqual({ name: "envoyer" });
    // Task H : tableau de bord « Mes partages » (spec §33).
    expect(match("/envois")).toEqual({ name: "envois" });
    expect(match("/telechargements")).toEqual({ name: "telechargements" });
    expect(match("/envois", `#m${KEY}`)).toEqual({ name: "envois" });
  });

  it("spec §41.4 : rechargement d'une ouverture déverrouillée (marque + octroi gardé) → ouverture ; sinon accueil", () => {
    expect(match("/", "", "/", true)).toEqual({ name: "open" });
    expect(match("/", "", "/", false)).toEqual({ name: "home" });
    expect(match("/securite", "", "/", true)).toEqual({ name: "securite" });
  });

  it("ancienne forme à la racine (refusée, 18 novembre) : « / » + fragment, quel qu'il soit → accueil (App retire le « # ») ; la clé n'est pas gardée", () => {
    for (const h of [`#${KEY}`, `#m${KEY}`, `#${KEY}.YUMzIWNENT8jRmc`, `#${KEY}.`, `#${KEY.slice(0, 20)}`, `#x${KEY}`, "", "#", "#contenu"])
      expect(match("/", h), h).toEqual({ name: "home" });
    expect(JSON.stringify(match("/", `#${KEY}`))).not.toContain(KEY);
  });

  it("fragment de bonne forme ailleurs qu'à la racine : pas d'ouverture", () => {
    expect(match("/securite", `#${KEY}`)).toEqual({ name: "securite" });
    expect(match("/x", `#${KEY}`)).toEqual({ name: "notfound" });
  });

  it("liens sous /s (16 novembre) : partage, mot de passe du QR et lien coupé → ouverture ; gestion → gestion ; sans fragment → ouverture (lien incomplet)", () => {
    expect(match("/s", `#${KEY}`)).toEqual({ name: "open" });
    expect(match("/s", `#m${KEY}`)).toEqual({ name: "manage" });
    expect(match("/s", `#${KEY}.YWJj`)).toEqual({ name: "open" });
    expect(match("/s", `#${KEY.slice(0, 30)}`)).toEqual({ name: "open" });
    expect(match("/s", "")).toEqual({ name: "open" });
    expect(match("/shhdrop/s", `#m${KEY}`, "/shhdrop/")).toEqual({ name: "manage" });
  });

  it("anciens liens /s/{id}, /m/{id} (aucune compatibilité) et adresses inconnues → 404", () => {
    for (const p of ["/s/AbC_-1", "/m/xyz", "/s/", "/S", "/ss", "/s/a/b", "/inconnu", "/securite/x", "//", "/s/é"]) {
      expect(match(p), p).toEqual({ name: "notfound" });
      expect(match(p, `#${KEY}`), p).toEqual({ name: "notfound" });
    }
  });

  it("avec une base de dépôt (démo)", () => {
    const base = "/shhdrop/";
    expect(match("/shhdrop/", `#${KEY}`, base)).toEqual({ name: "home" }); // ancienne forme refusée
    expect(match("/shhdrop/s", `#${KEY}`, base)).toEqual({ name: "open" });
    expect(match("/shhdrop/", "", base)).toEqual({ name: "home" });
    expect(match("/shhdrop", "", base)).toEqual({ name: "home" });
    expect(match("/shhdrop/securite", "", base)).toEqual({ name: "securite" });
    expect(match("/shhdrop/envoyer", "", base)).toEqual({ name: "envoyer" });
    expect(match("/shhdrop/envois", "", base)).toEqual({ name: "envois" });
    expect(match("/shhdrop/telechargements", "", base)).toEqual({ name: "telechargements" });
    expect(match("/", `#${KEY}`, base)).toEqual({ name: "notfound" });
    expect(match("/shhdropx/", `#${KEY}`, base)).toEqual({ name: "notfound" });
  });
});

// Plan du compte, lot 10 : pages du compte seulement si __COMPTES__ (sinon la même 404 qu'une
// adresse inconnue) ; « ?suite=salon » seul paramètre, et aucune donnée dans l'adresse.
describe("pages du compte", () => {
  const C = (p: string, base = "/") => match(p, "", base, false, true);
  it("avec __COMPTES__ : /compte, inscription, connexion, recuperation, profil", () => {
    expect(C("/compte")).toEqual({ name: "compte" });
    expect(C("/compte/inscription")).toEqual({ name: "inscription" });
    expect(C("/compte/connexion")).toEqual({ name: "connexion" });
    expect(C("/compte/recuperation")).toEqual({ name: "recuperation" });
    expect(C("/compte/profil")).toEqual({ name: "profil" });
    expect(C("/shhdrop/compte/connexion", "/shhdrop/")).toEqual({ name: "connexion" });
    // Un « # » n'ouvre rien ici (App le retire).
    expect(match("/compte/connexion", `#${KEY}`, "/", false, true)).toEqual({ name: "connexion" });
  });
  it("adresses voisines → 404", () => {
    for (const p of ["/compte/", "/compte/x", "/compte/connexion/", "/compte/connexion/x", "/Compte", "/compte/Connexion", "/comptes", "/compte/parametres"])
      expect(C(p), p).toEqual({ name: "notfound" });
  });
  it("sans __COMPTES__ (défaut, démo) : toutes → 404", () => {
    for (const p of ["/compte", "/compte/inscription", "/compte/connexion", "/compte/recuperation", "/compte/profil"]) {
      expect(match(p), p).toEqual({ name: "notfound" });
      expect(match(p, "", "/", false, false), p).toEqual({ name: "notfound" });
    }
  });
  it("suite : « ?suite=salon » exactement, sinon rien", () => {
    expect(suite("?suite=salon")).toBe("salon");
    for (const q of ["", "?", "?suite=", "?suite=Salon", "?suite=salon&x=1", "?x=1&suite=salon", "?suite=salon#k", "?email=lea@exemple.fr"]) expect(suite(q), q).toBeNull();
  });
  it("navigate : « ?suite=salon » admis sur la connexion et l'inscription seulement", () => {
    navigate("/compte/connexion?suite=salon");
    expect(location.pathname + location.search).toBe("/compte/connexion?suite=salon");
    navigate("/compte/inscription?suite=salon");
    expect(location.search).toBe("?suite=salon");
    for (const p of ["/compte/connexion?suite=x", "/compte/connexion?email=a@b.fr", "/securite?suite=salon", "/compte/recuperation?suite=salon", "/compte/connexion?suite=salon#k"])
      expect(() => navigate(p), p).toThrow();
    navigate("/");
  });
});

describe("navigate", () => {
  it("met à jour l'adresse et la route, sans rechargement", () => {
    navigate("/envois");
    expect(location.pathname).toBe("/envois");
    expect(router.current).toEqual({ name: "envois" });
    navigate("/");
    expect(router.current).toEqual({ name: "home" });
  });

  // Pages séparées (16 novembre) : une page d'information a son propre fichier HTML ; depuis
  // l'application, y aller charge cette page (et inversement), sans toucher au routeur.
  it("vers l'autre fichier HTML (application ↔ page d'information) : chargement complet", () => {
    const assign = vi.spyOn(location, "assign").mockImplementation(() => undefined);
    try {
      navigate("/securite");
      expect(assign).toHaveBeenCalledWith("/securite");
      expect(router.current).toEqual({ name: "home" });
      expect(otherEntry("/offres")).toBe(true);
      expect(otherEntry("/envois")).toBe(false);
      setEntry("pages");
      expect(otherEntry("/offres")).toBe(false);
      expect(otherEntry("/")).toBe(true);
      expect(match("/securite.html", "")).toEqual({ name: "securite" });
      expect(match("/offres.html", "")).toEqual({ name: "offres" });
    } finally {
      setEntry("app");
      assign.mockRestore();
    }
  });

  // Page « /s » (16 novembre) : ouverture et gestion dans leur propre fichier HTML.
  it("page /s : autre fichier HTML que l'application et les pages d'information", () => {
    expect(otherEntry("/s")).toBe(true);
    setEntry("s");
    try {
      expect(otherEntry("/s")).toBe(false);
      expect(otherEntry("/")).toBe(true);
      expect(otherEntry("/envoyer")).toBe(true);
      expect(otherEntry("/securite")).toBe(true);
    } finally {
      setEntry("app");
    }
  });

  it("ancienne forme à la racine (refusée, 18 novembre) : l'accueil, jamais l'ouverture ni la page /s", () => {
    const calls: string[] = [];
    const loc = (pathname: string, hash: string) => ({ pathname, hash, replace: (u: string) => void calls.push(u) });
    for (const h of [`#${KEY}`, `#m${KEY}`, `#${KEY}.YWJj`, `#${KEY.slice(0, 30)}`]) {
      expect(match("/", h).name, h).toBe("home");
      expect(moveToLinkPage(loc("/", h), false), h).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  // « /s » montré seulement quand il sert (17 novembre).
  it("adresse montrée : /s et /s.html deviennent / ; tout le reste tel quel", () => {
    expect(shownPath("/s")).toBe("/");
    expect(shownPath("/s.html")).toBe("/");
    for (const p of ["/", "/envoyer", "/s/", "/ss", "/securite"]) expect(shownPath(p), p).toBe(p);
  });

  it("entrée « / » marquée d'une ouverture déverrouillée : repart vers /s (sans fragment) ; sans marque : rien", () => {
    const calls: string[] = [];
    const loc = (pathname: string, hash: string) => ({ pathname, hash, replace: (u: string) => void calls.push(u) });
    expect(moveToLinkPage(loc("/", ""), true)).toBe(true);
    expect(moveToLinkPage(loc("/", ""), false)).toBe(false);
    expect(moveToLinkPage(loc("/envoyer", ""), true)).toBe(false);
    expect(moveToLinkPage(loc("/s", ""), true)).toBe(false); // déjà sur /s : jamais de boucle
    expect(calls).toEqual(["/s"]);
  });

  it("refuse tout ce qui n'est pas un chemin interne", () => {
    for (const p of ["//evil.example/x", "https://evil.example/", "securite", "/\\evil", "/a#k", "/s/x?y=1", `/#${KEY}`])
      expect(() => navigate(p), p).toThrow();
    expect(location.pathname).toBe("/");
  });

  it("popstate resynchronise la route, fragment compris (lien collé dans la barre)", () => {
    navigate("/envois");
    history.replaceState(null, "", `/s#m${KEY}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(router.current).toEqual({ name: "manage" });
    history.replaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(router.current).toEqual({ name: "home" });
  });

  it("popstate sans changement de route : router.current n'est pas réaffecté (ni focus volé)", () => {
    navigate("/envois");
    const before = router.current;
    history.replaceState(null, "", "/envois#ancre");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(router.current).toBe(before);
    navigate("/telechargements");
    expect(router.current).not.toBe(before);
    navigate("/");
  });

  it("href préfixe la base", () => {
    expect(href("/securite")).toBe("/securite");
  });
});

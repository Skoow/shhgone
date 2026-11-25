// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { chrome, takeGestureFromUrl } from "./chrome.svelte";

// Pages séparées : un geste choisi sur une page d'information passe par
// « /envoyer?ajout=<geste> », liste fermée, retiré de l'adresse aussitôt lu.
describe("geste transmis par l'adresse", () => {
  it("« /envoyer?ajout=texte » : geste en attente, adresse nettoyée", () => {
    history.replaceState(null, "", "/envoyer?ajout=texte");
    chrome.pending = null;
    takeGestureFromUrl();
    expect(chrome.pending).toBe("texte");
    expect(location.pathname + location.search).toBe("/envoyer");
  });
  // Un lien venu d'ailleurs ne doit jamais allumer le micro ni la caméra.
  it("« ?ajout=vocal » et « ?ajout=media » : aucun geste joué d'office, les actions ressortent seulement", () => {
    for (const g of ["vocal", "media"]) {
      history.replaceState(null, "", "/envoyer?ajout=" + g);
      chrome.pending = null;
      chrome.spot = null;
      takeGestureFromUrl();
      expect(chrome.pending, g).toBeNull();
      expect(chrome.spot, g).toBe("make");
      expect(location.pathname + location.search).toBe("/envoyer");
    }
    chrome.spot = null;
  });
  it("geste inconnu, autre page ou autre paramètre : ignoré, adresse nettoyée si « ?ajout= »", () => {
    for (const url of ["/envoyer?ajout=script", "/?ajout=texte", "/envoyer?ajout=texte&x=1", "/envoyer?x=texte"]) {
      history.replaceState(null, "", url);
      chrome.pending = null;
      takeGestureFromUrl();
      expect(chrome.pending, url).toBeNull();
    }
    history.replaceState(null, "", "/");
  });
});

// @vitest-environment happy-dom
// Accès offert (/offres/offert#<pass>, conception du paiement, « Accès offerts ») : le pass est
// lu puis effacé de l'adresse avant tout effet, vérifié par POST /api/paiement/etat (X-Shh-Pass,
// jamais dans l'adresse), rangé sur l'appareil comme un pass payé (origine « offert »), puis dans
// le compte s'il est ouvert ; erreurs : lien invalide, révoqué, terminé, serveur muet.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64u } from "../engine/pure";
import { fakeIndexedDB, type FakeIdb } from "../storage/fake-idb.test-helper";
import { setLang } from "../i18n/i18n.svelte";
import { garder, lirePasses, nouvelId } from "../paiement/pass";
import OffersGift from "./OffersGift.svelte";

let app: Record<string, unknown> | null = null;
let idb: FakeIdb;
const pass = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255);
const P = b64u(pass);
const DEMAIN_AN = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

type Appel = { url: string; headers: Record<string, string>; body: unknown };
function serveur(etat: Record<string, unknown> | null) {
  const appels: Appel[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    appels.push({ url, headers: init.headers as Record<string, string>, body: init.body });
    if (etat === null) throw new TypeError("réseau");
    return new Response(JSON.stringify({ v: 1, renouvelle: false, droits: [], ...etat }), { status: 200 });
  });
  return { appels, net: { origin: "https://shh.test", fetch: fetch as unknown as typeof globalThis.fetch } };
}

function ouvrir(hash: string, props: Record<string, unknown>) {
  history.replaceState(null, "", "/offres/offert" + hash);
  app = mount(OffersGift as never, { target: document.body, props }) as Record<string, unknown>;
}
const vue = () => document.querySelector("[data-gift]")?.getAttribute("data-gift");
const texte = () => (document.body.textContent ?? "").replace(/\s+/g, " ");

beforeEach(() => {
  setLang("fr");
  idb = fakeIndexedDB();
  vi.stubGlobal("indexedDB", idb);
});
afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("accès offert", () => {
  it("fragment effacé dès l'initialisation ; pass envoyé seulement en X-Shh-Pass ; rangé sur l'appareil (origine offert) ; une seule fois", async () => {
    const s = serveur({ etat: "payee", offre: "pro", fin: DEMAIN_AN, droits: ["partage_pro"] });
    const avant = history.length;
    ouvrir("#" + P, { net: s.net });
    // Avant tout effet ni requête : plus rien après « # », pas d'entrée d'historique en plus.
    expect(location.hash).toBe("");
    expect(location.href).not.toContain(P);
    expect(history.length).toBe(avant);
    flushSync();
    await vi.waitFor(() => expect(vue()).toBe("ok"));
    expect(s.appels).toHaveLength(1);
    expect(s.appels[0]!.url).toBe("https://shh.test/api/paiement/etat");
    expect(s.appels[0]!.headers["X-Shh-Pass"]).toBe(P);
    expect(s.appels[0]!.url).not.toContain(P);
    expect(String(s.appels[0]!.body ?? "")).not.toContain(P);
    const l = await lirePasses(idb);
    expect(l).toHaveLength(1);
    expect(Buffer.from(l[0]!.pass).equals(Buffer.from(pass))).toBe(true);
    expect(l[0]).toMatchObject({ offre: "pro", moyen: "offert", enAttente: false, renouvelle: false });
    expect(texte()).toMatch(/Accès Pro offert, jusqu'au/u);
    // Sans compte (site sans comptes) : dit que l'accès reste sur l'appareil.
    expect(texte()).toContain("Sans compte, il reste sur cet appareil seulement");
    // Rouvert : rien en double.
    void unmount(app!);
    ouvrir("#" + P, { net: s.net });
    flushSync();
    await vi.waitFor(() => expect(vue()).toBe("ok"));
    expect(await lirePasses(idb)).toHaveLength(1);
  });

  it("compte ouvert : le pass est rangé dans le compte, et c'est dit", async () => {
    const s = serveur({ etat: "payee", offre: "pro", fin: DEMAIN_AN });
    const ranger = vi.fn(async () => {
      // Le pass est déjà sur l'appareil quand le compte est appelé.
      expect(await lirePasses(idb)).toHaveLength(1);
      return true;
    });
    ouvrir("#" + P, { net: s.net, compte: { connecte: () => true, ranger } });
    flushSync();
    await vi.waitFor(() => expect(document.querySelector('[data-account="ajoute"]')).not.toBeNull());
    expect(ranger).toHaveBeenCalledTimes(1);
    expect(texte()).toContain("Ajouté à votre compte : retrouvé sur tous vos appareils.");
    expect(document.querySelector("[data-signin]")).toBeNull();
  });

  it("aucun compte ouvert : « Se connecter » et « Créer un compte » ; rien n'est rangé dans un compte", async () => {
    const s = serveur({ etat: "payee", offre: "pro", fin: DEMAIN_AN });
    const ranger = vi.fn(async () => true);
    ouvrir("#" + P, { net: s.net, compte: { connecte: () => false, ranger } });
    flushSync();
    await vi.waitFor(() => expect(vue()).toBe("ok"));
    expect(document.querySelector('[data-account="aucun"]')).not.toBeNull();
    expect(document.querySelector<HTMLAnchorElement>("[data-signin]")!.getAttribute("href")).toBe("/compte/connexion");
    expect(document.querySelector<HTMLAnchorElement>("[data-signup]")!.getAttribute("href")).toBe("/compte/inscription");
    expect(ranger).not.toHaveBeenCalled();
    expect(await lirePasses(idb)).toHaveLength(1);
  });

  it("coffre refusé : dit qu'il sera ajouté à la prochaine connexion ; le pass reste sur l'appareil", async () => {
    const s = serveur({ etat: "payee", offre: "pro", fin: DEMAIN_AN });
    ouvrir("#" + P, { net: s.net, compte: { connecte: () => true, ranger: async () => Promise.reject(new Error("conflict")) } });
    flushSync();
    await vi.waitFor(() => expect(document.querySelector('[data-account="erreur"]')).not.toBeNull());
    expect(await lirePasses(idb)).toHaveLength(1);
  });

  it("lien invalide (absent, trop court, non canonique, autre caractère) : aucune requête, rien rangé, fragment effacé", async () => {
    // 43 caractères dont le dernier porte des bits en trop (B, C : jamais un dernier caractère
    // canonique de 32 octets) : forme non canonique, refusée.
    const nonCanonique = P.slice(0, 42) + (P[42] === "B" ? "C" : "B");
    for (const h of ["", "#", "#" + P.slice(0, 42), "#" + P + "A", "#" + P.slice(0, 42) + "+", "#" + nonCanonique]) {
      const s = serveur({ etat: "payee", offre: "pro", fin: DEMAIN_AN });
      ouvrir(h, { net: s.net });
      flushSync();
      expect(location.hash, h).toBe("");
      await vi.waitFor(() => expect(vue(), h).toBe("invalide"));
      expect(s.appels, h).toHaveLength(0);
      void unmount(app!);
      app = null;
    }
    expect(await lirePasses(idb)).toHaveLength(0);
  });

  it("pass inconnu du serveur : lien invalide ; révoqué : accès arrêté ; terminé : accès terminé ; rien n'est rangé", async () => {
    for (const [etat, attendu] of [
      [{ etat: "inconnue", offre: null, fin: null }, "invalide"],
      [{ etat: "revoquee", offre: "pro", fin: "2026-11-01" }, "revoque"],
      [{ etat: "payee", offre: "pro", fin: "2020-01-01" }, "echu"],
    ] as const) {
      ouvrir("#" + P, { net: serveur(etat).net });
      flushSync();
      await vi.waitFor(() => expect(vue()).toBe(attendu));
      void unmount(app!);
      app = null;
    }
    expect(await lirePasses(idb)).toHaveLength(0);
    expect(texte()).toBe("");
  });

  it("serveur muet : « Réessayer » rejoue la vérification avec le pass gardé en mémoire (le fragment est déjà effacé)", async () => {
    const etat: { v: Record<string, unknown> | null } = { v: null };
    const appels: string[] = [];
    const net = {
      origin: "https://shh.test",
      fetch: (async (_u: string, init: RequestInit) => {
        appels.push((init.headers as Record<string, string>)["X-Shh-Pass"]!);
        if (etat.v === null) throw new TypeError("réseau");
        return new Response(JSON.stringify({ v: 1, renouvelle: false, droits: [], ...etat.v }), { status: 200 });
      }) as unknown as typeof fetch,
    };
    ouvrir("#" + P, { net });
    flushSync();
    await vi.waitFor(() => expect(vue()).toBe("reseau"));
    etat.v = { etat: "payee", offre: "pro", fin: DEMAIN_AN };
    document.querySelector<HTMLButtonElement>("[data-retry]")!.click();
    await vi.waitFor(() => expect(vue()).toBe("ok"));
    expect(appels).toEqual([P, P]);
  });

  it("pass déjà rangé (payé ou offert) : pas de doublon", async () => {
    await garder(idb, { id: nouvelId(), pass, offre: "pro", jours: 365, renouvelle: false, moyen: "offert", enAttente: false, cree: 1 });
    ouvrir("#" + P, { net: serveur({ etat: "payee", offre: "pro", fin: DEMAIN_AN }).net });
    flushSync();
    await vi.waitFor(() => expect(vue()).toBe("ok"));
    expect(await lirePasses(idb)).toHaveLength(1);
  });
});

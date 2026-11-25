// Paiement côté site (conception du paiement §2, §4.4, §5.6, §6.1) : couche HTTP (pass dans
// X-Shh-Pass seulement, adresses de redirection vérifiées) et pass gardés chiffrés sur l'appareil.
import { describe, expect, it } from "vitest";
import { b64u } from "../engine/pure";
import { fakeIndexedDB } from "../storage/fake-idb.test-helper";
import * as A from "./api";
import { garder, lirePasses, nouvelId, oublier, PASS_DB, tirerPass, type PassGarde } from "./pass";

type Seen = { method: string; url: string; headers: Record<string, string>; body: string | undefined; init: RequestInit };

function net(reply: (s: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const s: Seen = { method: init.method ?? "GET", url, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined, init };
    seen.push(s);
    return reply(s);
  }) as unknown as typeof globalThis.fetch;
  return { n: { origin: "https://shh.test", fetch } as A.Net, seen };
}
const rep = (v: unknown, status = 200) => new Response(v === null ? null : JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const P = new Uint8Array(32).fill(7);
const demande: A.Demande = { offre: "pro", jours: 365, renouvelle: false, moyen: "carte", pays: "DE", renonciation: true };
const preuve: A.Preuve = { altcha: "eyJzYWx0IjoieCJ9", hp: "", shown_at: "v1.jeton" };

describe("adresses de redirection", () => {
  it("seulement les pages hébergées des prestataires", () => {
    for (const u of ["https://checkout.stripe.com/c/pay/cs_test_a1#fid", "https://www.sandbox.paypal.com/checkoutnow?token=5O1", "https://www.paypal.com/webapps/billing/subscriptions?ba_token=BA-1", "https://nowpayments.io/payment/?iid=45"])
      expect(A.adresseSure(u), u).toBe(true);
    for (const u of [
      "https://checkout.stripe.com/",
      "http://checkout.stripe.com/c/pay/x",
      "https://checkout.stripe.com.evil.example/c",
      "https://evil.example/https://checkout.stripe.com/",
      "https://user@checkout.stripe.com/c",
      "javascript:alert(1)",
      "https://checkout.stripe.com/c pay",
      "https://checkout.stripe.com/c\n",
      "https://chéckout.stripe.com/c",
      "/offres",
      "",
    ])
      expect(A.adresseSure(u), u).toBe(false);
  });
});

describe("couche HTTP du paiement", () => {
  it("offre : moyens et pays du serveur ; 404 ou réponse invalide : null", async () => {
    const { n, seen } = net(() => rep({ v: 1, moyens: ["carte", "crypto", "inconnu"], pays: ["DE", "FR", "fr"], bientot: ["appel_audio"] }));
    expect(await A.lireOffre(n)).toEqual({ moyens: ["carte", "crypto"], pays: ["DE", "FR"], bientot: ["appel_audio"], tva: null });
    const avec = { v: 1, moyens: ["carte"], pays: ["DE"], bientot: [], tva: { regime: "oss", taux: { DE: 1900, FR: 2000 } } };
    expect((await A.lireOffre(net(() => rep(avec)).n))?.tva).toEqual({ regime: "oss", taux: { DE: 1900, FR: 2000 } });
    for (const tva of [{ regime: "autre", taux: {} }, { regime: "oss", taux: { DE: 19.5 } }, { regime: "oss", taux: { de: 1900 } }, { regime: "oss", taux: { DE: 20000 } }, "oss"])
      expect((await A.lireOffre(net(() => rep({ ...avec, tva })).n))?.tva).toBeNull();
    expect(seen[0]!.url).toBe("https://shh.test/api/paiement");
    expect(seen[0]!.init.credentials).toBe("same-origin");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(await A.lireOffre(net(() => rep({ error: "not_found" }, 404)).n)).toBeNull();
    expect(await A.lireOffre(net(() => rep({ v: 2, moyens: [], pays: [], bientot: [] })).n)).toBeNull();
    expect(await A.lireOffre(net(() => Promise.reject(new Error("csp"))).n)).toBeNull();
  });

  it("commande : pass dans X-Shh-Pass seulement, corps exact, adresse vérifiée", async () => {
    const { n, seen } = net(() => rep({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    expect(await A.commander(P, demande, preuve, n)).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    const s = seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("https://shh.test/api/paiement/commande");
    expect(s.headers["X-Shh-Pass"]).toBe(b64u(P));
    expect(JSON.parse(s.body!)).toEqual({ offre: "pro", jours: 365, renouvelle: false, moyen: "carte", pays: "DE", renonciation: true, ...preuve });
    expect(s.url + s.body).not.toContain(b64u(P));
    // Le serveur rend une adresse hors liste : jamais suivie.
    expect(await A.commander(P, demande, preuve, net(() => rep({ url: "https://evil.example/pay" })).n)).toEqual({ erreur: "prestataire" });
    for (const [st, e] of [[400, "refus"], [409, "conflit"], [429, "limite"], [503, "occupe"], [502, "prestataire"], [500, "prestataire"]] as const)
      expect(await A.commander(P, demande, preuve, net(() => rep({ error: "x" }, st)).n)).toEqual({ erreur: e });
    expect(await A.commander(P, demande, preuve, net(() => Promise.reject(new Error("x"))).n)).toEqual({ erreur: "reseau" });
    await expect(A.commander(new Uint8Array(31), demande, preuve, n)).rejects.toThrow("pass_invalide");
  });

  it("état et résiliation", async () => {
    const e = { v: 1, etat: "payee", offre: "plus", fin: "2026-12-19", renouvelle: true, droits: ["partage_plus"] };
    const { n, seen } = net(() => rep(e));
    expect(await A.lireEtat(P, n)).toEqual({ etat: "payee", offre: "plus", fin: "2026-12-19", renouvelle: true, droits: ["partage_plus"] });
    expect(seen[0]!.url).toBe("https://shh.test/api/paiement/etat");
    expect(seen[0]!.headers["X-Shh-Pass"]).toBe(b64u(P));
    expect(seen[0]!.body).toBeUndefined();
    for (const bad of [{ ...e, etat: "gratuit" }, { ...e, fin: "19/12/2026" }, { ...e, v: 2 }, { ...e, droits: [1] }])
      expect(await A.lireEtat(P, net(() => rep(bad)).n)).toBeNull();
    expect(await A.resilier(P, net(() => rep(null, 204)).n)).toBe("ok");
    expect(await A.resilier(P, net(() => rep({ error: "aucun_abonnement" }, 409)).n)).toBe("aucun");
    expect(await A.resilier(P, net(() => rep({ error: "prestataire" }, 502)).n)).toBe("erreur");
  });
});

describe("pass gardés sur l'appareil", () => {
  const g = (over: Partial<PassGarde> = {}): PassGarde => ({ id: nouvelId(), pass: tirerPass(), offre: "plus", jours: 30, renouvelle: true, moyen: "paypal", enAttente: true, cree: 1000, ...over });

  it("lire sans base : [] et rien n'est créé", async () => {
    const idb = fakeIndexedDB();
    expect(await lirePasses(idb)).toEqual([]);
    expect([...idb.raw().keys()]).toEqual([]);
  });

  it("garder, lire (récent d'abord), oublier ; base shhdrop-pass ; aucun pass en clair", async () => {
    const idb = fakeIndexedDB();
    const a = g({ cree: 1000 });
    const b = g({ cree: 2000, offre: "pro", jours: 365, renouvelle: false, moyen: "crypto", enAttente: false, pays: "DE" });
    await garder(idb, a);
    await garder(idb, b);
    expect([...idb.raw().keys()]).toEqual([PASS_DB]);
    const lus = await lirePasses(idb);
    expect(lus.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(lus[0]).toEqual(b);
    expect(lus[1]!.pays).toBeUndefined();
    // Rien du pass sur « disque » : ni ses octets, ni son base64url.
    let tout = "";
    const octets: Uint8Array[] = [];
    const walk = (v: unknown) => {
      if (v instanceof Uint8Array) octets.push(v);
      else if (typeof v === "string") tout += v;
      else if (v && typeof v === "object" && !(v instanceof CryptoKey)) for (const x of Object.values(v)) walk(x);
    };
    for (const [, stores] of idb.raw()) for (const [, m] of stores) for (const [k, v] of m) (walk(k), walk(v));
    for (const x of [a, b]) {
      expect(tout).not.toContain(b64u(x.pass));
      expect(tout).not.toContain('"DE"'); // pays chiffré avec le pass
      expect(octets.some((o) => Buffer.from(o).includes(Buffer.from(x.pass)))).toBe(false);
    }
    await oublier(idb, a.id);
    expect((await lirePasses(idb)).map((x) => x.id)).toEqual([b.id]);
  });

  it("enregistrement déplacé sous un autre identifiant : refusé (donnée authentifiée)", async () => {
    const idb = fakeIndexedDB();
    const a = g();
    await garder(idb, a);
    for (const [, stores] of idb.raw())
      for (const [, m] of stores) {
        const rec = m.get(a.id);
        if (rec !== undefined) {
          m.delete(a.id);
          m.set("autre", rec);
        }
      }
    expect(await lirePasses(idb)).toEqual([]);
  });

  it("tirerPass : 32 octets, différents", () => {
    const x = tirerPass();
    expect(x.length).toBe(32);
    expect(b64u(x)).not.toBe(b64u(tirerPass()));
  });
});

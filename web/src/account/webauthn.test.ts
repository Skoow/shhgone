// Passkeys dans le navigateur (conception du compte par passkey §5, §9) : options converties ici avec E_prf du moteur (jamais l'entrée du serveur), sortie
// PRF lue de façon tolérante (1Password : ArrayBuffer, vues, base64url ; 32 octets exactement sinon
// absente), et JAMAIS envoyée : clientExtensionResults en liste blanche.
import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { b64u } from "../engine/pure";
import { configurerNavigateur, creer, extensionsPourServeur, obtenir, octetsDe, optionsAssertion, optionsCreation, passkeysDisponibles, prfAnnonce, prfApresCreation, sansSortiePrf, signalerInconnue, sortiePrf } from "./webauthn";

const P = new Uint8Array(32).map((_, i) => i + 1);
const E = new Uint8Array(32).fill(0xe1);

describe("sortie PRF tolérante (1Password)", () => {
  it("ArrayBuffer, TypedArray, DataView, ArrayBuffer d'un autre contexte, base64url (avec ou sans bourrage) : 32 octets copiés", () => {
    const grand = new Uint8Array(48);
    grand.set(P, 8);
    const autre = runInNewContext("new Uint8Array(32).map((_, i) => i + 1).buffer");
    for (const v of [P.slice().buffer, P.slice(), new Uint16Array(P.slice().buffer), new DataView(grand.buffer, 8, 32), grand.subarray(8, 40), autre, b64u(P), b64u(P) + "="]) {
      const s = sortiePrf({ prf: { results: { first: v } } });
      expect(s, String(v)).toEqual(P);
      expect(s!.buffer).not.toBe((v as { buffer?: unknown }).buffer); // copie : effaçable sans toucher l'original
    }
  });

  it("autre taille, autre type, absente : null (PRF traité comme absent, repli §5.5)", () => {
    for (const v of [P.slice(0, 31), new Uint8Array(33), "", "pas du base64url !", 42, null, undefined, {}, [1, 2, 3], true])
      expect(sortiePrf({ prf: { results: { first: v } } }), String(v)).toBeNull();
    for (const r of [undefined, null, {}, { prf: null }, { prf: { results: null } }, { prf: { enabled: true } }]) expect(sortiePrf(r)).toBeNull();
  });

  it("prf.enabled : vrai seulement s'il vaut exactement true", () => {
    expect(prfAnnonce({ prf: { enabled: true } })).toBe(true);
    for (const v of ["true", 1, "1", {}, null, undefined, false]) expect(prfAnnonce({ prf: { enabled: v } }), String(v)).toBe(false);
  });

  it("octetsDe : rien d'autre que des octets", () => {
    expect(octetsDe(new ArrayBuffer(3))).toEqual(new Uint8Array(3));
    expect(octetsDe(Symbol("x"))).toBeNull();
    expect(octetsDe(5)).toBeNull();
  });
});

describe("rien de la sortie PRF vers le serveur", () => {
  it("extensionsPourServeur : credProps.rk et prf.enabled seulement (booléens)", () => {
    const brut = { credProps: { rk: true, autre: 1 }, prf: { enabled: true, results: { first: P, second: P } }, hmacGetSecret: { output1: P }, largeBlob: { blob: P } };
    expect(extensionsPourServeur(brut)).toEqual({ credProps: { rk: true }, prf: { enabled: true } });
    expect(extensionsPourServeur({ prf: { enabled: "true" }, credProps: { rk: "oui" } })).toEqual({});
    expect(extensionsPourServeur(null)).toEqual({});
  });

  it("sansSortiePrf : même credential, sans prf.results ni hmacGetSecret", () => {
    const c = { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "a" }, clientExtensionResults: { prf: { enabled: true, results: { first: b64u(P) } }, hmacGetSecret: { output1: b64u(P) } } };
    const n = sansSortiePrf(c);
    expect(n).toEqual({ id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "a" }, clientExtensionResults: { prf: { enabled: true } } });
    expect(JSON.stringify(n)).not.toContain(b64u(P));
  });
});

describe("options", () => {
  const creation = {
    rp: { id: "shh.test", name: "Shhgone" },
    user: { id: b64u(new Uint8Array(16).fill(2)), name: "", displayName: "" },
    challenge: b64u(new Uint8Array(32).fill(3)),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    timeout: 300000,
    excludeCredentials: [{ type: "public-key", id: b64u(new Uint8Array(5).fill(4)), transports: ["hybrid"] }],
    authenticatorSelection: { residentKey: "discouraged", userVerification: "discouraged" },
    attestation: "direct",
    extensions: { credProps: true, prf: { eval: { first: b64u(new Uint8Array(32).fill(9)) } } },
  };

  it("création : octets, pseudo dans user.name, E_prf du moteur, passkey découvrable et vérifiée, attestation « none » quoi que dise le serveur", () => {
    const o = optionsCreation(creation, "Lea", E);
    expect(o.user).toEqual({ id: new Uint8Array(16).fill(2), name: "Lea", displayName: "Lea" });
    expect(o.challenge).toEqual(new Uint8Array(32).fill(3));
    expect(o.excludeCredentials).toEqual([{ type: "public-key", id: new Uint8Array(5).fill(4) }]);
    expect(o.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "required" });
    expect(o.attestation).toBe("none");
    expect((o.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first).toEqual(E);
    expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
  });

  it("assertion : E_prf du moteur ; allowCredentials seulement s'il y en a", () => {
    const o = optionsAssertion({ challenge: b64u(new Uint8Array(32)), rpId: "shh.test", extensions: { prf: { eval: { first: "AAAA" } } } }, E);
    expect(o.allowCredentials).toBeUndefined();
    expect((o.extensions as { prf: { eval: { first: Uint8Array } } }).prf.eval.first).toEqual(E);
    expect(o.userVerification).toBe("required");
    expect(optionsAssertion({ challenge: "AAAA", allowCredentials: [{ type: "public-key", id: "AQID" }] }, E).allowCredentials).toEqual([{ type: "public-key", id: new Uint8Array([1, 2, 3]) }]);
  });

  it("options mal formées : options_invalides", () => {
    expect(() => optionsCreation({ ...creation, challenge: 5 }, "Lea", E)).toThrow("options_invalides");
    expect(() => optionsCreation({ ...creation, user: null }, "Lea", E)).toThrow("options_invalides");
    expect(() => optionsAssertion({ challenge: "!!" }, E)).toThrow("options_invalides");
  });
});

describe("cérémonies (navigateur remplacé)", () => {
  const reponse = (ext: unknown, extra: Record<string, unknown> = {}) =>
    ({ rawId: new Uint8Array([1, 2, 3]).buffer, response: { clientDataJSON: new Uint8Array([4]).buffer, attestationObject: new Uint8Array([5]).buffer, authenticatorData: new Uint8Array([6]).buffer, signature: new Uint8Array([7]).buffer, userHandle: new Uint8Array([8]).buffer, ...extra }, getClientExtensionResults: () => ext }) as unknown as Credential;
  const brancher = (create: () => Promise<Credential | null>, get = create) => configurerNavigateur(() => ({ credentials: { create, get } }));

  it("create : JSON pour le serveur sans sortie PRF, sortie rendue à part ; transports ni attachement envoyés", async () => {
    brancher(async () => reponse({ credProps: { rk: true }, prf: { enabled: true, results: { first: P.slice().buffer } } }, { getTransports: () => ["hybrid"] }));
    const c = await creer(optionsCreation({ rp: { id: "shh.test", name: "S" }, user: { id: "AAAA" }, challenge: "AAAA", pubKeyCredParams: [] }, "Lea", E));
    expect(c.credential).toEqual({ id: "AQID", rawId: "AQID", type: "public-key", response: { clientDataJSON: "BA", attestationObject: "BQ" }, clientExtensionResults: { credProps: { rk: true }, prf: { enabled: true } } });
    expect(c.prf).toEqual(P);
    expect(c.prfAnnonce).toBe(true);
    expect(JSON.stringify(c.credential)).not.toContain(b64u(P));
    configurerNavigateur(null);
  });

  it("get : userHandle gardé, sortie à part ; extensions qui jettent : aucune", async () => {
    brancher(async () => reponse({ prf: { results: { first: b64u(P) } } }));
    const a = await obtenir(optionsAssertion({ challenge: "AAAA" }, E));
    expect(a.credential).toEqual({ id: "AQID", rawId: "AQID", type: "public-key", response: { clientDataJSON: "BA", authenticatorData: "Bg", signature: "Bw", userHandle: "CA" }, clientExtensionResults: {} });
    expect(a.prf).toEqual(P);
    const jette = reponse(undefined);
    (jette as unknown as { getClientExtensionResults: () => never }).getClientExtensionResults = () => {
      throw new Error("x");
    };
    brancher(async () => jette);
    expect((await obtenir(optionsAssertion({ challenge: "AAAA" }, E))).prf).toBeNull();
    configurerNavigateur(null);
  });

  it("erreurs : annulation → annule ; déjà enregistrée → deja_enregistree ; autre → webauthn_echec ; pas d'API → webauthn_absent", async () => {
    const o = optionsAssertion({ challenge: "AAAA" }, E);
    for (const [name, code] of [["NotAllowedError", "annule"], ["AbortError", "annule"], ["InvalidStateError", "deja_enregistree"], ["SecurityError", "webauthn_echec"]]) {
      brancher(async () => {
        throw Object.assign(new Error(name), { name });
      });
      await expect(obtenir(o)).rejects.toThrow(code);
    }
    brancher(async () => null);
    await expect(obtenir(o)).rejects.toThrow("webauthn_echec");
    configurerNavigateur(() => ({ credentials: null }));
    expect(passkeysDisponibles()).toBe(false);
    await expect(obtenir(o)).rejects.toThrow("webauthn_absent");
    configurerNavigateur(null);
  });

  it("deuxième geste : assertion locale sur cette seule passkey, défi tiré ici, E_prf", async () => {
    let vu: PublicKeyCredentialRequestOptions | undefined;
    configurerNavigateur(() => ({
      credentials: {
        create: async () => null,
        get: async (x) => {
          vu = x.publicKey;
          return reponse({ prf: { results: { first: P.slice() } } });
        },
      },
    }));
    expect(await prfApresCreation("shh.test", new Uint8Array([1, 2, 3]), E)).toEqual(P);
    expect(vu!.rpId).toBe("shh.test");
    expect(vu!.allowCredentials).toEqual([{ type: "public-key", id: new Uint8Array([1, 2, 3]) }]);
    expect((vu!.challenge as Uint8Array).length).toBe(32);
    configurerNavigateur(null);
  });

  it("signalUnknownCredential là où il existe ; sinon faux (l'écran dit de supprimer la passkey)", async () => {
    const vus: unknown[] = [];
    configurerNavigateur(() => ({ credentials: null, signalInconnue: async (o) => void vus.push(o) }));
    expect(await signalerInconnue("shh.test", new Uint8Array([1, 2, 3]))).toBe(true);
    expect(vus).toEqual([{ rpId: "shh.test", credentialId: "AQID" }]);
    configurerNavigateur(() => ({ credentials: null }));
    expect(await signalerInconnue("shh.test", new Uint8Array([1]))).toBe(false);
    configurerNavigateur(null);
  });
});

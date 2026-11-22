// Faux serveur du compte de la démo (demo/fake-compte.ts) et passkey simulée (demo/passkeys.ts) :
// mêmes réponses que les routes du compte par passkey pour le client account/api.ts ; credential
// avec sortie PRF refusé ; enveloppes (4 au plus, pour la passkey de la session) ; clé de
// récupération (v_r = SHA-256(A_r)) ; session récente ; état de l'onglet rechargé tel quel.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as A from "../account/api";
import { b64u } from "../engine/pure";
import { createFauxCompte, type InstantaneCompte } from "./fake-compte";
import { passkeysSimulees } from "./passkeys";
import { optionsAssertion, optionsCreation } from "../account/webauthn";

type Bytes = Uint8Array<ArrayBuffer>;
const PREUVE = { altcha: "demo", hp: "", shown_at: "demo" };
const octets = (n: number, v = 7) => new Uint8Array(n).fill(v) as Bytes;
const AR = octets(32, 9);
const VR = new Uint8Array(createHash("sha256").update(AR).digest()) as Bytes;

function monter(now = () => 1_700_000_000_000, restore: InstantaneCompte | null = null) {
  let dernier: InstantaneCompte | null = null;
  const f = createFauxCompte({ now, restore, onChange: (s) => (dernier = s) });
  const net: A.Net = { origin: "https://demo.test", fetch: ((u: RequestInfo | URL, i?: RequestInit) => f.handle(new Request(u, i))) as typeof fetch };
  return { f, net, sauve: () => dernier };
}

/** Credential JSON tel que webauthn.ts l'enverrait, pour une passkey simulée. */
async function cred(c: Credential): Promise<Record<string, unknown>> {
  const r = c as unknown as { rawId: ArrayBuffer; response: Record<string, ArrayBuffer> };
  const b = (x: ArrayBuffer) => b64u(new Uint8Array(x) as Bytes);
  const response: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.response)) response[k] = b(v);
  return { id: b(r.rawId), rawId: b(r.rawId), type: "public-key", response, clientExtensionResults: {} };
}
const E = new Uint8Array(32).fill(0xe1);
const creation = (o: Record<string, unknown>) => optionsCreation(o, "Lea", E);
const assertion = (o: Record<string, unknown>) => optionsAssertion(o, E);

async function inscrire(net: A.Net, pk = passkeysSimulees(), pCanon = "lea") {
  const { etape, options } = await A.inscriptionDebut(net, PREUVE);
  expect(await A.pseudoVerifier(net, { etape }, pCanon)).toBe(true);
  const c = await pk.credentials.create({ publicKey: creation(options) });
  const r = await A.inscriptionFin(net, { etape, credential: await cred(c), pCanon, env: octets(60, 1), vR: VR, envR: octets(60, 2), blobProfil: octets(50), blobPrive: octets(40), persistante: false, etiquette: null, credEtiquette: octets(64) });
  return { ...r, pk };
}

describe("faux serveur du compte (démo)", () => {
  it("inscription, connexion par la passkey simulée (enveloppes rendues), récupération par v_r", async () => {
    const { net } = monter();
    const { session, h, pk } = await inscrire(net);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await A.deconnexion(net, session);
    const d = await A.connexionDebut(net);
    const g = await pk.credentials.get({ publicKey: assertion(d.options) });
    const o = await A.connexionFin(net, { etape: d.etape, credential: await cred(g), persistante: false, etiquette: null });
    expect(o.h).toEqual(h);
    expect(o.enveloppes).toEqual([octets(60, 1)]);
    const r = await A.recup(net, { aR: AR, persistante: false, etiquette: null });
    expect(r.envR).toEqual(octets(60, 2));
    await expect(A.recup(net, { aR: octets(32, 1), persistante: false, etiquette: null })).rejects.toMatchObject({ code: "identifiants" });
    expect((await A.sessions(net, r.session)).filter((s) => s.parRecup)).toHaveLength(1);
  });

  it("credential avec sortie PRF : refusé (comme le vrai serveur) ; étape à usage unique", async () => {
    const { net } = monter();
    const { etape, options } = await A.inscriptionDebut(net, PREUVE);
    const c = await cred(await passkeysSimulees().credentials.create({ publicKey: creation(options) }));
    const f = await net.fetch("https://demo.test/api/compte/inscription/fin", { method: "POST", body: JSON.stringify({ etape, credential: { ...c, clientExtensionResults: { prf: { results: { first: "x" } } } } }) });
    expect(f.status).toBe(400);
    expect((await net.fetch("https://demo.test/api/compte/inscription/fin", { method: "POST", body: JSON.stringify({ etape, credential: null }) })).status).toBe(400);
  });

  it("enveloppes : passkey de la session, sans doublon, 4 au plus ; sans passkey liée : sans_passkey ; plus récente : recent", async () => {
    let t = 1_700_000_000_000;
    const { net } = monter(() => t);
    const { session, pk } = await inscrire(net);
    await A.passkeysEnveloppe(net, session, octets(60, 1)); // doublon : sans effet
    for (const v of [3, 4, 5]) await A.passkeysEnveloppe(net, session, octets(60, v));
    await expect(A.passkeysEnveloppe(net, session, octets(60, 6))).rejects.toMatchObject({ code: "enveloppes_max" });
    const r = await A.recup(net, { aR: AR, persistante: false, etiquette: null });
    await expect(A.passkeysEnveloppe(net, r.session, octets(60, 8))).rejects.toMatchObject({ code: "sans_passkey" });
    t += 6 * 60_000;
    await expect(A.passkeysEnveloppe(net, session, octets(60, 9))).rejects.toMatchObject({ code: "recent" });
    const d = await A.reauthDebut(net, session);
    expect(await A.reauthFin(net, session, d.etape, await cred(await pk.credentials.get({ publicKey: assertion(d.options) })))).toHaveLength(4);
  });

  it("passkeys : ajout (session récente, exclusion), renommage, retrait jamais de la dernière ; nouvelle clé", async () => {
    const { net } = monter();
    const { session, pk } = await inscrire(net);
    const d = await A.passkeysDebut(net, session);
    await expect(pk.credentials.create({ publicKey: creation(d.options) })).rejects.toMatchObject({ name: "InvalidStateError" });
    const autre = passkeysSimulees();
    await A.passkeysFin(net, session, { etape: d.etape, credential: await cred(await autre.credentials.create({ publicKey: creation(d.options) })), env: null, etiquette: null });
    const l = await A.passkeys(net, session);
    expect(l.map((p) => p.prf)).toEqual([true, false]);
    await A.passkeysNommer(net, session, l[1]!.credId, octets(64, 3));
    await A.passkeysRetirer(net, session, l[1]!.credId);
    await expect(A.passkeysRetirer(net, session, l[0]!.credId)).rejects.toMatchObject({ code: "derniere" });
    await A.recupRenouveler(net, session, octets(32, 4), octets(60, 4));
    await expect(A.recup(net, { aR: AR, persistante: false, etiquette: null })).rejects.toMatchObject({ code: "identifiants" });
  });

  it("pseudo réservé à l'étape ; état de l'onglet rechargé tel quel ; suppression libère le pseudo", async () => {
    const m = monter();
    const { session } = await inscrire(m.net);
    const s = m.sauve()!;
    expect(s.v).toBe(2);
    expect(JSON.stringify(s)).not.toMatch(/"results"|K_compte/);
    const r = monter(undefined, JSON.parse(JSON.stringify(s)));
    expect(await A.etat(r.net, session)).toMatchObject({ palier: "neuf", banniId: null });
    const { etape } = await A.inscriptionDebut(r.net, PREUVE);
    expect(await A.pseudoVerifier(r.net, { etape }, "lea")).toBe(false);
    await A.supprimer(r.net, session);
    expect(await A.pseudoVerifier(r.net, { etape }, "lea")).toBe(true);
  });
});

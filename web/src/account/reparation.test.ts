// Réparation des enveloppes PRF (conception du compte par
// passkey §17, R6, R10) : enveloppe posée seulement si elle s'ouvre avec la sortie PRF actuelle,
// rien si une enveloppe s'ouvre déjà, réauthentification sur recent ou sans_passkey (avec la passkey
// qui a signé), enveloppes_max ignoré, jamais d'erreur remontée.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompteError } from "./api";
import * as keys from "./keys";
import { reparer, type Lien } from "./reparation";

// Enveloppe fausse sur demande (« jamais une enveloppe qui ne s'ouvre pas avec P »).
const FAUX = vi.hoisted(() => ({ actif: false }));
vi.mock("./keys", async (orig) => {
  const k = await orig<typeof import("./keys")>();
  return { ...k, enveloppePrf: (...a: Parameters<typeof k.enveloppePrf>) => (FAUX.actif ? Promise.resolve(crypto.getRandomValues(new Uint8Array(60))) : k.enveloppePrf(...a)) };
});

type Bytes = Uint8Array<ArrayBuffer>;
const alea = (n: number) => crypto.getRandomValues(new Uint8Array(n)) as Bytes;
const H = alea(16);
const K = alea(32);

afterEach(() => {
  FAUX.actif = false;
  vi.restoreAllMocks();
});

async function lien(prf: Bytes | null, avecEnveloppe = false): Promise<Lien> {
  const credId = alea(32);
  return { credId, prf, enveloppes: avecEnveloppe && prf ? [await keys.enveloppePrf(prf, H, credId, K)] : [] };
}

describe("reparer", () => {
  it("aucune enveloppe ne s'ouvre : une enveloppe pour P est posée, et elle s'ouvre avec P", async () => {
    const l = await lien(alea(32));
    l.enveloppes = [alea(60)]; // celle d'un autre appareil
    const posees: Bytes[] = [];
    expect(await reparer({ h: H, kCompte: K, lien: l, poser: async (e) => void posees.push(e) })).toBe("posee");
    expect(posees).toHaveLength(1);
    expect(await keys.ouvrirEnveloppesPrf(l.prf!, H, l.credId, posees)).toEqual(K);
  });

  it("une enveloppe s'ouvre déjà : rien n'est posé ; elle ouvre une autre clé : rien non plus (échec)", async () => {
    const poser = vi.fn(async () => undefined);
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32), true), poser })).toBe("deja");
    const p = alea(32);
    const l = await lien(p);
    l.enveloppes = [await keys.enveloppePrf(p, H, l.credId, alea(32))];
    expect(await reparer({ h: H, kCompte: K, lien: l, poser })).toBe("echec");
    expect(poser).not.toHaveBeenCalled();
  });

  it("pas de sortie PRF : rien", async () => {
    const poser = vi.fn(async () => undefined);
    expect(await reparer({ h: H, kCompte: K, lien: await lien(null), poser })).toBe("sans_prf");
    expect(poser).not.toHaveBeenCalled();
  });

  it("jamais une enveloppe qui ne s'ouvre pas avec P : vérifiée sur l'appareil avant l'envoi", async () => {
    FAUX.actif = true;
    const poser = vi.fn(async () => undefined);
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser })).toBe("echec");
    expect(poser).not.toHaveBeenCalled();
  });

  it("enveloppes_max (409) : ignoré sans bruit", async () => {
    const poser = vi.fn(async () => Promise.reject(new CompteError(409, "enveloppes_max")));
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser })).toBe("plein");
  });

  for (const code of ["recent", "sans_passkey"])
    it(`${code} (403) : réauthentification, puis enveloppe pour la passkey qui a signé`, async () => {
      const autre = await lien(alea(32));
      const posees: Bytes[] = [];
      let n = 0;
      const poser = async (e: Bytes) => {
        if (n++ === 0) throw new CompteError(403, code);
        posees.push(e);
      };
      const reauth = vi.fn(async () => autre);
      expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser, reauth })).toBe("posee");
      expect(reauth).toHaveBeenCalledTimes(1);
      expect(await keys.ouvrirEnveloppesPrf(autre.prf!, H, autre.credId, posees)).toEqual(K);
    });

  it("réauthentification refusée, impossible, ou passkey déjà réparée par elle", async () => {
    const refus = async () => Promise.reject(new CompteError(403, "recent"));
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser: refus })).toBe("echec");
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser: refus, reauth: async () => null })).toBe("echec");
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser: refus, reauth: async () => Promise.reject(new Error("annule")) })).toBe("echec");
    // Une seule réauthentification : un second refus ne boucle pas.
    const reauth = vi.fn(async () => lien(alea(32)));
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser: refus, reauth })).toBe("echec");
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser: refus, reauth: async () => lien(alea(32), true) })).toBe("deja");
  });

  it("réseau ou autre refus : échec, jamais d'exception", async () => {
    for (const e of [new Error("reseau"), new CompteError(401, "session"), new CompteError(400, "bad_request")])
      expect(await reparer({ h: H, kCompte: K, lien: await lien(alea(32)), poser: async () => Promise.reject(e) })).toBe("echec");
  });
});

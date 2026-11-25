// Appels réservés aux offres Plus et Pro :
// jeton anonyme demandé seulement sur 402, jamais quand les appels du salon sont déjà ouverts.
import { describe, expect, it } from "vitest";
import { OFFRE_REQUISE, relaisReserve } from "./appel-offre";
import { SalonError, type Relais } from "./api";

const RELAIS: Relais = { urls: ["turn:turn.example:3478?transport=udp"], username: "1:00", credential: "x", ttlS: 60 };

describe("relaisReserve : jeton seulement sur 402", () => {
  it("appels déjà ouverts : aucun jeton demandé", async () => {
    const vus: (string | undefined)[] = [];
    let jetons = 0;
    const r = await relaisReserve(
      async (j) => (vus.push(j), RELAIS),
      async () => (jetons++, "J"),
    );
    expect(r).toBe(RELAIS);
    expect(vus).toEqual([undefined]);
    expect(jetons).toBe(0);
  });

  it("402 : un jeton, puis la même demande avec lui", async () => {
    const vus: (string | undefined)[] = [];
    const r = await relaisReserve(
      async (j) => {
        vus.push(j);
        if (j === undefined) throw new SalonError(402, "offre_requise");
        return RELAIS;
      },
      async () => "J",
    );
    expect(r).toBe(RELAIS);
    expect(vus).toEqual([undefined, "J"]);
  });

  it("402 sans jeton disponible, ou 402 encore avec le jeton : OFFRE_REQUISE", async () => {
    const ferme = async () => {
      throw new SalonError(402, "offre_requise");
    };
    await expect(relaisReserve(ferme, async () => null)).rejects.toThrow(OFFRE_REQUISE);
    await expect(relaisReserve(ferme, async () => "J")).rejects.toThrow(OFFRE_REQUISE);
  });

  it("autre erreur (404, 429, réseau, jeton refusé) : rendue telle quelle, sans jeton de plus", async () => {
    let jetons = 0;
    const err = new SalonError(429, "limit");
    await expect(
      relaisReserve(
        async () => {
          throw err;
        },
        async () => (jetons++, "J"),
      ),
    ).rejects.toBe(err);
    expect(jetons).toBe(0);
    const refuse = new SalonError(400, "bad_request");
    await expect(
      relaisReserve(
        async (j) => {
          if (j === undefined) throw new SalonError(402, "offre_requise");
          throw refuse;
        },
        async () => "J",
      ),
    ).rejects.toBe(refuse);
  });
});

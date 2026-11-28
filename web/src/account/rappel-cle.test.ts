// Rappel des 6 mois de la clé de récupération (28 novembre) : calcul au mois près, en UTC.
import { describe, expect, it } from "vitest";
import { moisDe, rappelCleDu, RAPPEL_CLE_MOIS } from "./session.svelte";

const t = (iso: string) => Date.parse(iso);

describe("rappel de la clé de récupération", () => {
  it("mois « AAAA-MM » en UTC", () => {
    expect(moisDe(t("2026-11-28T12:00:00Z"))).toBe("2026-11");
    expect(moisDe(t("2027-01-01T00:00:00Z"))).toBe("2027-01");
    expect(moisDe(t("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });

  it("dû à partir de 6 mois pleins (changement d'année compris) ; aucun mois noté : jamais", () => {
    expect(RAPPEL_CLE_MOIS).toBe(6);
    expect(rappelCleDu("2026-11", t("2027-04-30T23:00:00Z"))).toBe(false);
    expect(rappelCleDu("2026-11", t("2027-05-01T00:00:00Z"))).toBe(true);
    expect(rappelCleDu("2026-06", t("2026-11-28T00:00:00Z"))).toBe(false);
    expect(rappelCleDu("2026-05", t("2026-11-28T00:00:00Z"))).toBe(true);
    expect(rappelCleDu(undefined, t("2030-01-01T00:00:00Z"))).toBe(false);
    expect(rappelCleDu("abc", t("2030-01-01T00:00:00Z"))).toBe(false);
    // Horloge de l'appareil en retard : jamais de rappel « négatif ».
    expect(rappelCleDu("2026-11", t("2026-01-01T00:00:00Z"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { paysProbable } from "./pays";

const UE = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];

describe("paysProbable (pays de résidence proposé d'avance, sur l'appareil)", () => {
  it("d'après le fuseau horaire", () => {
    expect(paysProbable(UE, "Europe/Paris", [])).toBe("FR");
    expect(paysProbable(UE, "Europe/Brussels", ["fr-FR"])).toBe("BE"); // le fuseau passe avant la langue
    expect(paysProbable(UE, "Asia/Nicosia", [])).toBe("CY");
  });
  it("sinon d'après la région de la langue", () => {
    expect(paysProbable(UE, "America/New_York", ["en-US", "de-AT"])).toBe("AT");
    expect(paysProbable(UE, "", ["fr-BE"])).toBe("BE");
  });
  it("rien hors des pays permis, ni pour une langue sans région, ni outre-mer", () => {
    expect(paysProbable(UE, "Europe/London", ["en-GB"])).toBe("");
    expect(paysProbable(UE, "America/New_York", ["fr", "en"])).toBe("");
    expect(paysProbable(UE, "Indian/Reunion", [])).toBe("");
    expect(paysProbable(["DE"], "Europe/Paris", ["fr-FR"])).toBe(""); // serveur qui ne vend pas en France
    expect(paysProbable(UE, "Europe/Paris", ["pas une langue !"])).toBe("FR");
    expect(paysProbable(UE, "x", ["pas une langue !"])).toBe("");
  });
  it("chaque fuseau proposé mène à un pays de l'UE", () => {
    for (const p of UE) expect(UE).toContain(p);
  });
});

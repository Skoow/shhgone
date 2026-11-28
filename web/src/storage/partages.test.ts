// « Mes partages » (spec §33, D42-30) : entrées chiffrées sur l'appareil (AES-256-GCM, clé non
// extractible), liste fermée des champs (jamais le lien de partage ni le mot de passe), tri,
// échéance vue sans requête, retrait 7 jours après la fin, stockage refusé → null.
import { describe, expect, it, vi } from "vitest";
import { fakeIndexedDB } from "./fake-idb.test-helper";
import { idbBackend, memoryBackend } from "./idb";
import { GARDE_APRES_FIN_MS, PARTAGES_DB, cleDe, estActif, etatVu, nettoyer, ouvrirPartages, trier, type NouveauPartage, type Partage } from "./partages";

const T0 = Date.UTC(2026, 10, 26, 9, 0);
const S = (c: string) => c.repeat(43);
const GESTION = "https://shhgone.test/s#m" + S("m");
const GESTION2 = "https://shhgone.test/s#m" + S("n");
const SALON_G = "https://shhgone.test/salon#s" + S("s");
const SALON_I = "https://shhgone.test/salon#c" + S("c");
const PARTAGE_LIEN = "https://shhgone.test/s#" + S("k");
const envoi = (o: Partial<NouveauPartage> = {}): NouveauPartage => ({ sorte: "envoi", gestion: GESTION, creeLe: T0, echeance: T0 + 3600_000, ouverturesMax: 3, taille: 1234, elements: 2, nom: "Contrat Dupont", ...o });

function dump(m: Map<string, Map<string, Map<IDBValidKey, unknown>>>): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (x instanceof Uint8Array) out.push(new TextDecoder("latin1").decode(x));
    else if (x instanceof Map) for (const [k, y] of x) (out.push(String(k)), walk(y));
    else if (x && typeof x === "object" && !(x instanceof CryptoKey)) for (const [k, y] of Object.entries(x)) (out.push(k), walk(y));
    else out.push(String(x));
  };
  walk(m);
  return out.join("\n");
}

describe("Mes partages : stockage chiffré", () => {
  it("ajout puis lecture ; rien en clair sur disque (ni lien de gestion, ni nom, ni taille)", async () => {
    const idb = fakeIndexedDB();
    const persist = vi.fn(async () => true);
    const s = (await ouvrirPartages({ backend: idbBackend(idb, PARTAGES_DB), now: () => T0, persist }))!;
    const p = await s.ajouter(envoi());
    expect(p).toMatchObject({ sorte: "envoi", origine: "local", gestion: GESTION, invitation: "", nom: "Contrat Dupont", taille: 1234, elements: 2, ouvertures: 0, ouverturesMax: 3, etat: "actif", finLe: 0, detruitIci: false });
    expect(p.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await s.liste()).toEqual([p]);
    const raw = dump(idb.raw());
    for (const clair of [GESTION, S("m"), "Contrat Dupont", "1234", "gestion", "nom"]) expect(raw).not.toContain(clair);
    expect([...idb.raw().keys()]).toEqual([PARTAGES_DB]);
    expect(persist).toHaveBeenCalledTimes(1);
    await s.ajouter(envoi({ gestion: GESTION2 }));
    expect(persist).toHaveBeenCalledTimes(1); // demandé une fois
  });

  it("même lien de gestion : une seule entrée", async () => {
    const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => T0 }))!;
    const a = await s.ajouter(envoi());
    const b = await s.ajouter(envoi({ nom: "autre" }));
    expect(b.id).toBe(a.id);
    expect(await s.liste()).toHaveLength(1);
  });

  it("salon : lien de gestion « #s » et invitation « #c » ; jamais de nom ni de taille", async () => {
    const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => T0 }))!;
    const p = await s.ajouter({ sorte: "salon", gestion: SALON_G, invitation: SALON_I, creeLe: T0, echeance: T0 + 86_400_000 });
    expect(p).toMatchObject({ sorte: "salon", gestion: SALON_G, invitation: SALON_I, nom: "", taille: 0, ouverturesMax: 0 });
    await expect(s.ajouter({ sorte: "salon", gestion: SALON_G, invitation: "", creeLe: T0, echeance: T0 })).rejects.toThrow();
  });

  it("un lien de partage (K_lien) ou un mot de passe ne sont jamais gardés", async () => {
    const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => T0 }))!;
    // Lien de partage à la place du lien de gestion : refusé.
    await expect(s.ajouter(envoi({ gestion: PARTAGE_LIEN }))).rejects.toThrow();
    // Envoi avec une invitation : refusé (un envoi ne garde aucun autre lien).
    await expect(s.ajouter(envoi({ invitation: SALON_I }))).rejects.toThrow();
    // Champ inconnu (mot de passe) : ignoré.
    const p = nettoyer({ ...(await s.ajouter(envoi())), password: "Abcdef-1234", link: PARTAGE_LIEN });
    expect(Object.keys(p!)).not.toContain("password");
    expect(Object.keys(p!)).not.toContain("link");
  });

  it("nom : 80 points de code au plus, sans caractère de commande", async () => {
    const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => T0 }))!;
    await expect(s.ajouter(envoi({ nom: "é".repeat(81) }))).rejects.toThrow();
    await expect(s.ajouter(envoi({ nom: "a\u0007b" }))).rejects.toThrow();
    expect((await s.ajouter(envoi({ nom: "😀".repeat(80) }))).nom).toHaveLength(160);
  });

  it("échéance passée : vu expiré sans requête ; retiré 7 jours après la fin", async () => {
    let now = T0;
    const b = memoryBackend();
    const s = (await ouvrirPartages({ backend: b, now: () => now }))!;
    const p = await s.ajouter(envoi());
    now = T0 + 3600_000;
    expect(etatVu(p, now)).toBe("expire");
    expect(estActif(p, now)).toBe(false);
    now = T0 + 3600_000 + GARDE_APRES_FIN_MS - 1;
    expect(await s.liste()).toHaveLength(1);
    now = T0 + 3600_000 + GARDE_APRES_FIN_MS;
    expect(await s.liste()).toEqual([]);
    expect(b.raw().size).toBe(0);
  });

  it("modifier : seuls les champs d'état changent (lien, nom, sorte figés)", async () => {
    const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => T0 }))!;
    const p = await s.ajouter(envoi());
    const q = await s.modifier(p.id, { ouvertures: 2, etat: "epuise", gestion: GESTION2, nom: "x" } as never);
    expect(q).toMatchObject({ ouvertures: 2, etat: "epuise", gestion: GESTION, nom: "Contrat Dupont" });
  });

  it("garder (entrée du compte) : refusée si le même lien est déjà là", async () => {
    const s = (await ouvrirPartages({ backend: memoryBackend(), now: () => T0 }))!;
    const p = await s.ajouter(envoi());
    expect(await s.garder({ ...p, id: "A".repeat(22), origine: "compte" })).toBe(false);
    expect(await s.garder({ ...p, id: "A".repeat(22), origine: "compte", gestion: GESTION2 })).toBe(true);
    expect((await s.liste()).map((x) => x.origine).sort()).toEqual(["compte", "local"]);
  });

  it("enregistrement abîmé : ignoré et retiré", async () => {
    const b = memoryBackend();
    const s = (await ouvrirPartages({ backend: b, now: () => T0 }))!;
    await s.ajouter(envoi());
    const [[id, rec]] = [...b.raw()];
    rec!.ct[0] ^= 1;
    expect(await s.liste()).toEqual([]);
    expect(b.raw().has(id!)).toBe(false);
  });

  it("stockage absent ou refusé : null", async () => {
    expect(await ouvrirPartages({ backend: null })).toBeNull();
    const idb = fakeIndexedDB();
    idb.failOpen = true;
    expect(await ouvrirPartages({ backend: idbBackend(idb, PARTAGES_DB) })).toBeNull();
  });

  it("tri : actifs par échéance croissante, puis terminés (fin la plus récente d'abord)", () => {
    const base = nettoyer({ id: "A".repeat(22), sorte: "envoi", origine: "local", gestion: GESTION, invitation: "", nom: "", taille: 0, elements: 1, creeLe: T0, echeance: T0 + 10, ouvertures: 0, ouverturesMax: 1, etat: "actif", vuLe: T0, finLe: 0, detruitIci: false })!;
    const mk = (id: string, o: Partial<Partage>): Partage => ({ ...base, id: id.repeat(22), gestion: "https://shhgone.test/s#m" + id.repeat(43), ...o });
    const tard = mk("b", { echeance: T0 + 50 });
    const tot = mk("c", { echeance: T0 + 20 });
    const detruit = mk("d", { etat: "detruit", finLe: T0 - 5 });
    const echu = mk("e", { echeance: T0 - 1 });
    expect(trier([detruit, tard, echu, tot], T0).map((p) => p.id[0])).toEqual(["c", "b", "e", "d"]);
    expect(cleDe(tard)).toBe("#m" + "b".repeat(43));
  });
});
